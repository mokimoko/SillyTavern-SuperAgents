/**
 * modes/sidecar.js — sidecar agent execution.
 *
 * Sidecar agents make a separate LLM call with the message as read-only
 * context, extract structured data from the response, and store it to
 * chat variables. message.mes is NEVER touched.
 *
 * This is the first mode to land on callAgentLLM(). Compare with VM's
 * runner.js where executeSidecarAgent was ~80 lines of inline CMRS/
 * quiet-prompt/extract ladder — now it's a thin wrapper.
 *
 * Also includes:
 *   - buildSidecarDisplayData — HUD data builder
 *   - buildHistoryContext — chat history for context-aware agents
 *   - groupSidecarsByProfile — batching helper
 */

import {
    chat,
    substituteParams,
} from '../../../../../../script.js';
import { getContext } from '../../../../../extensions.js';
import { debug } from '../core/runtime.js';
import { callAgentLLM, isAbortError } from '../core/llm.js';
import { recordAgentRun } from '../core/idempotency.js';
import { buildRichContext, buildHistoryLines } from '../core/richContext.js';
import {
    readMergeArray,
    formatMergeVariableData,
    storeBatchedSidecarResult,
    storeSidecarResult,
    collectRecentStates,
    getStateTransaction,
} from './mergeVariable.js';
import { getEffectiveConnectionProfile, getGlobalSettings } from '../data/store.js';
import { buildRetentionPrompt } from '../data/stateRetention.js';
import { getConfiguredParticipantExclusion } from '../core/participants.js';
import { markActivationPolicyComplete } from '../core/activationPolicy.js';
import { buildAfterDarkAnalysisContext } from '../afterDark/afterDarkContext.js';
import { parseAfterDarkPlanResponse } from '../afterDark/afterDarkResponse.js';
import { buildDramaQueenAnalysisContext, buildDramaQueenPlanOutputContract } from '../dramaQueen/dramaQueenContext.js';
import { parseDramaQueenPlanResponse } from '../dramaQueen/dramaQueenResponse.js';

const LOG_PREFIX = '[SuperAgents/sidecar]';

// ============================================================================
// HISTORY CONTEXT
// ============================================================================

/**
 * Build a text representation of recent chat messages for agent context.
 *
 * Delegates to richContext.buildHistoryLines (audit fix #10) so block-stripping
 * and capping live in one place. Uses bracket speaker style ([Name]: text) to
 * preserve the historical <chat_history> shape. `beforeIndex` is exclusive (we
 * look back from it but don't include it), matching the prior contract, so we
 * pass mesNum = beforeIndex - 1.
 *
 * @param {number} beforeIndex — message index to look back from (exclusive)
 * @param {number} [messageCount=20] — how many recent messages to include
 * @returns {string}
 */
export function buildHistoryContext(beforeIndex, messageCount = 20) {
    return buildHistoryLines(getContext(), Number(beforeIndex) - 1, messageCount, { speakerStyle: 'bracket' });
}

/**
 * Build context from the end of chat (for pre-gen agents that don't
 * have a specific "before" index).
 * @param {number} [messageCount=15]
 * @returns {string}
 */
export function buildPreGenContext(messageCount = 15) {
    return buildHistoryContext(chat.length, messageCount);
}

// ============================================================================
// RICH CONTEXT
// ============================================================================

/**
 * If an agent opted into rich context, build the labelled-section block
 * (card / persona / World Info / Summary / Author's Note / pending message /
 * history) and return it ready to append to the agent's system prompt. Returns
 * '' when the agent hasn't enabled it. Read-only; never throws.
 *
 * Self-memory (### Your recent direction): when the agent opts in
 * (flags.selfMemory + selfMemoryCount), this collects the agent's OWN last N
 * outputs via collectRecentStates — the swipe-aware backward walk — for the
 * agent's own mergeVariable, and hands them to buildRichContext to format. The
 * collection lives HERE (not in richContext.js) because it needs the agent's
 * varName and a chat walk; keeping it here means richContext.js gains no import
 * toward chat-walk/lifecycle code (no circular-import risk).
 *
 * `opts.suppressSelfMemory` is the Reroll blindfold: a one-run flag that forces
 * the self-memory count to 0 for this call only, so a retry ignores the
 * remembered history without mutating any stored data.
 *
 * @param {object} agent
 * @param {number} mesNum         context point (highest message index to read)
 * @param {string} pendingUserText  the not-yet-committed user message ('' post-gen)
 * @param {number} maxContext
 * @param {object} [opts]
 * @param {boolean} [opts.suppressSelfMemory=false]  blindfold self-memory this run.
 * @param {object} [opts.contextCache] generation-local cache shared by a batch.
 * @returns {Promise<string>}
 */
export async function buildAgentRichContext(agent, mesNum, pendingUserText = '', maxContext = 8192, opts = {}) {
    const flags = agent?.sidecarCall?.richContext;
    if (!flags?.enabled) return '';

    // Self-memory collection (opt-in). Blindfolded to 0 when reroll suppresses it.
    let selfMemoryItems = [];
    let selfMemoryFormatItem;
    let selfMemoryFieldNames;
    const mv = agent?.mergeVariable;
    const wantCount = opts.suppressSelfMemory ? 0 : Math.max(0, Number(flags.selfMemoryCount) || 0);
    if (flags.selfMemory && wantCount > 0 && mv?.variableName) {
        try {
            // Anchor at mesNum; collectRecentStates reads that message's active
            // swipe (startSwipeId=null → derive from chat[mesNum].swipe_id) and
            // walks back, reading each message's active swipe. Swipe-aware by
            // construction — the same rule as the State Card trace.
            selfMemoryItems = collectRecentStates(chat, mesNum, null, mv.variableName, wantCount);
            selfMemoryFormatItem = mv.formatItem;
            selfMemoryFieldNames = mv.fieldNames;
        } catch (err) {
            debug(`${LOG_PREFIX} self-memory collect failed for "${agent.name}":`, err?.message);
            selfMemoryItems = [];
        }
    }

    try {
        return await buildRichContext({
            mesNum, flags, pendingUserText, maxContext,
            selfMemoryItems, selfMemoryFormatItem, selfMemoryFieldNames,
            contextCache: opts.contextCache,
        });
    } catch (err) {
        debug(`${LOG_PREFIX} rich context failed for "${agent.name}":`, err?.message);
        return '';
    }
}

// ============================================================================
// DISPLAY DATA
// ============================================================================

/**
 * Build display data for a sidecar agent and write it to message.extra.saAgentData.
 *
 * After sidecar data is stored in a chat variable, this function reads it back
 * and builds the same HTML container format that regexScripts produce — so the
 * existing renderer.js + render hooks pick it up seamlessly.
 *
 * @param {object} agent
 * @param {object} message - chat[n]
 * @param {number} messageIndex
 * @param {object[]} [extractedItems] — pass directly to avoid re-reading
 */
export function buildSidecarDisplayData(agent, message, messageIndex, extractedItems) {
    const display = agent.sidecarCall?.display;
    if (!display?.enabled || !display.hookClass) return;

    const mv = agent.mergeVariable;
    if (!mv?.enabled || !mv.variableName) return;

    const arr = extractedItems || readMergeArray(mv.variableName);
    if (arr.length === 0) return;

    const item = arr[0]; // snapshot mode = single item

    // Build data attribute string from the dataMap config
    const escapeAttr = value => String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;');
    const attrs = [
        `data-agent-name="${escapeAttr(agent.name || 'Agent output')}"`,
        `data-agent-icon="${escapeAttr(agent.icon || 'fa-solid fa-robot')}"`,
    ];
    for (const [field, attrName] of Object.entries(display.dataMap || {})) {
        const val = item[field] ?? '';
        if (val) {
            attrs.push(`${attrName}="${escapeAttr(val)}"`);
        }
    }

    // Content field goes into textContent (for Parallel Off-Screen style)
    const contentVal = display.contentField ? (item[display.contentField] ?? '') : '';
    const contentEscaped = contentVal
        ? String(contentVal).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        : '';

    const html = `<div class="${display.hookClass}" ${attrs.join(' ')} style="display:none">${contentEscaped}</div>`;

    // Write into message.extra.saAgentData in the format renderer.js expects
    const currentSwipeId = message.swipe_id ?? 0;
    if (!message.extra) message.extra = {};
    if (!message.extra.saAgentData) message.extra.saAgentData = {};

    message.extra.saAgentData[agent.id] = {
        _swipeId: currentSwipeId,
        _revision: item._addedAt,
        scripts: [{
            extractions: [{
                rendered: html,
                placement: display.position === 'bottom' ? 'bottom' : 'top',
            }],
        }],
    };

    debug(`${LOG_PREFIX} Display data built for "${agent.name}" (.${display.hookClass})`);
}

// ============================================================================
// BATCHING HELPER
// ============================================================================

/**
 * Group sidecar agents by connection profile for batching.
 * Agents sharing a profile get combined into one LLM call. Duplicate response
 * keys are placed in separate envelopes so one task can never overwrite another
 * task's top-level JSON slot. The global batchByProfile switch is honored.
 * Agents with NO profile get solo execution (no batching).
 * @param {object[]} agents
 * @returns {Map<string, object[]>} profileKey → agents
 */
export function groupSidecarsByProfile(agents) {
    const groups = new Map();
    if (getGlobalSettings().batchByProfile === false) {
        for (const agent of agents) groups.set(`__solo_${agent.id}`, [agent]);
        return groups;
    }

    const profileBuckets = new Map();
    for (const agent of agents) {
        const profile = getEffectiveConnectionProfile(agent.connectionProfile);
        if (!profile) {
            groups.set(`__solo_${agent.id}`, [agent]);
            continue;
        }

        const responseKey = agent.sidecarCall?.responseKey || agent.id;
        const buckets = profileBuckets.get(profile) || [];
        let bucket = buckets.find(candidate => !candidate.responseKeys.has(responseKey));
        if (!bucket) {
            bucket = { agents: [], responseKeys: new Set() };
            buckets.push(bucket);
            profileBuckets.set(profile, buckets);
        }
        bucket.agents.push(agent);
        bucket.responseKeys.add(responseKey);
    }

    for (const [profile, buckets] of profileBuckets) {
        buckets.forEach((bucket, index) => {
            const key = index === 0 ? profile : `${profile}__collision_${index}`;
            groups.set(key, bucket.agents);
        });
    }
    return groups;
}

// ============================================================================
// SOLO SIDECAR EXECUTION — THE PAYOFF
// ============================================================================

/**
 * Run a sidecar-mode agent on a message.
 *
 * Makes a separate LLM call with the message as read-only context,
 * extracts structured data from the response, and stores it directly
 * to chat variables. message.mes is NEVER touched.
 *
 * THIS IS THE ARCHITECTURAL WIN: VM's version was ~80 lines with an
 * inline CMRS-try/quiet-fallback/extract ladder. Now it's a thin
 * wrapper around callAgentLLM().
 *
 * @param {object} agent
 * @param {object} message - chat[n]
 * @param {number} messageIndex
 * @param {string} generationType
 * @param {object} [opts]
 * @param {AbortSignal|null} [opts.signal]   Cancel hook from the run controller.
 * @param {number} [opts.timeoutMs]          Per-call wall-clock ceiling.
 * @returns {Promise<{changed: boolean, dataStored: boolean, error?: string}>}
 */
export async function executeSidecarAgent(agent, message, messageIndex, generationType, opts = {}) {
    const currentText = message.mes;
    if (!currentText?.trim()) {
        return { changed: false, dataStored: false };
    }

    let expandedPrompt = substituteParams(agent.prompt).trim();
    if (!expandedPrompt) {
        return { changed: false, dataStored: false };
    }

    // Inject merge variable state into the prompt (continuity from previous turns)
    if (agent.mergeVariable?.enabled && agent.mergeVariable.injectFormatted && agent.mergeVariable.variableName) {
        const formatted = formatMergeVariableData(agent.mergeVariable);
        if (formatted) {
            expandedPrompt += '\n\n' + formatted;
        }
    }
    const retentionPrompt = buildRetentionPrompt(agent.mergeVariable?.retention);
    if (retentionPrompt) expandedPrompt += '\n\n' + retentionPrompt;

    // Participant-excluding trackers (e.g. Active Roster): name the player's
    // personas and excluded participants so the model doesn't spend tokens
    // tracking them. Commit-time filtering is the hard guarantee (see
    // commitMergeItems); this is the cheap, cooperative nudge.
    if (agent.mergeVariable?.retention?.excludeParticipants
        || agent.mergeVariable?.retention?.excludePlayerPersonas) {
        const { names, playersOnly } = getConfiguredParticipantExclusion(agent.mergeVariable.retention);
        if (names.length) {
            const reason = playersOnly
                ? 'they are current or previously used player personas, whose relationships belong exclusively to Relationship Ledger'
                : 'they are player personas or explicitly excluded, never autonomous tracked characters';
            expandedPrompt += `\n\nDO NOT TRACK these participants — ${reason}: ${names.join(', ')}. Track only other established characters.`;
        }
    }

    const maxTokens = agent.sidecarCall?.maxTokens || agent.maxTokens || 8192;
    const globalSettings = getGlobalSettings();
    const showNotifications = globalSettings.showNotifications && !agent.utilityAnalysis?.silent;

    // Rich context (opt-in): card / persona / World Info / Summary / Author's
    // Note. Post-gen, so no pending message. Appended to the system prompt.
    const richContext = await buildAgentRichContext(agent, messageIndex, '', maxTokens);
    if (richContext) {
        expandedPrompt += '\n\n' + richContext;
    }
    if (agent.afterDarkConfig?.enabled) {
        const afterDarkContext = await buildAfterDarkAnalysisContext(agent);
        if (afterDarkContext) expandedPrompt += '\n\n' + afterDarkContext;
    }
    if (agent.dramaQueenConfig?.enabled) {
        const dramaQueenContext = await buildDramaQueenAnalysisContext(agent);
        if (dramaQueenContext) expandedPrompt += '\n\n' + dramaQueenContext;
        expandedPrompt += '\n\n' + buildDramaQueenPlanOutputContract(agent.dramaQueenConfig?.proposalCount);
    }

    // Build optional history context
    let historyBlock = '';
    if (agent.sidecarCall?.includeHistory) {
        // Genesis (first-run) widening: when this agent has no tracked state yet,
        // its mergeVariable is empty and formatMergeVariableData injects the
        // formatEmpty seed instruction. That first call is establishing a baseline
        // from scratch (which may be a scene enabled many turns deep), so it needs
        // a wider history window than the normal per-turn delta update. Same empty
        // check formatMergeVariableData uses, so the two branches stay in lockstep.
        const mvName = agent.mergeVariable?.enabled ? agent.mergeVariable.variableName : '';
        const isGenesis = !!mvName && readMergeArray(mvName).length === 0;
        const genesisCount = agent.sidecarCall.genesisHistoryCount;
        const historyCount = (isGenesis && Number(genesisCount) > 0)
            ? Number(genesisCount)
            : (agent.sidecarCall.historyMessageCount || 20);
        const historyText = buildHistoryContext(messageIndex, historyCount);
        if (historyText) {
            historyBlock = `\nRecent conversation history (check the latest response against these established facts):\n<chat_history>\n${historyText}\n</chat_history>\n`;
        }
    }

    if (showNotifications) {
        toastr.info('Analyzing...', agent.name, { timeOut: 0, extendedTimeOut: 0 });
    }

    // ---- THE CALL: one line replaces ~40 lines of inline CMRS/quiet-prompt ----
    try {
        const userContent = `Character name: ${message.name || 'Assistant'}\nGeneration type: ${generationType}\n${historyBlock}\nThe following is the latest scene to analyze:\n<scene>\n${currentText}\n</scene>`;

        const response = await callAgentLLM({
            systemPrompt: expandedPrompt,
            userContent,
            profileRef: agent.connectionProfile || '',
            maxTokens,
            callerName: `sidecar:${agent.name}`,
            signal: opts.signal ?? null,
            timeoutMs: opts.timeoutMs,
        });

        if (!response) {
            if (showNotifications) {
                toastr.clear();
                toastr.warning('Empty response', agent.name, { timeOut: 5000 });
            }
            return { changed: false, dataStored: false };
        }

        // Extract and store data directly from the LLM response
        const isAfterDark = agent.afterDarkConfig?.enabled === true;
        const isDramaQueen = agent.dramaQueenConfig?.enabled === true;
        const recoveredAfterDark = isAfterDark
            ? parseAfterDarkPlanResponse(response)
            : null;
        const recoveredDramaQueen = isDramaQueen
            ? parseDramaQueenPlanResponse(response, {
                // A private idea picker needs an actual choice. Still salvage two
                // or three complete engines if a longer response is truncated.
                minimumProposals: Math.min(2, Number(agent.dramaQueenConfig?.proposalCount) || 4),
            })
            : null;
        const recoveredPlan = recoveredAfterDark || recoveredDramaQueen;
        let extractedItems = isAfterDark || isDramaQueen
            ? (recoveredPlan ? storeBatchedSidecarResult(
                agent,
                recoveredPlan,
                message,
                messageIndex,
                isAfterDark ? 'sidecar_after_dark' : 'sidecar_drama_queen',
            ) : null)
            : storeSidecarResult(agent, response, message, messageIndex);
        let dataStored = !!extractedItems;
        let stateRejected = (!(isAfterDark || isDramaQueen) || recoveredPlan)
            && getStateTransaction(message, agent.id)?.status === 'rejected';

        // Bounded single repair when a validated update was rejected (opt-out via
        // globalSettings.repairRejectedState = false). A successful repair commits
        // the corrected state in place, so everything below treats it as a store.
        if (stateRejected && !isAfterDark && !isDramaQueen && getGlobalSettings().repairRejectedState !== false) {
            const repair = await repairRejectedState(agent, message, messageIndex, {
                signal: opts.signal ?? null,
                timeoutMs: opts.timeoutMs,
            });
            if (repair.repaired) {
                extractedItems = repair.items;
                dataStored = true;
                stateRejected = false;
            }
        }

        // Build display data if configured
        if (extractedItems) {
            buildSidecarDisplayData(agent, message, messageIndex, extractedItems);
        }

        recordAgentRun(messageIndex, {
            agentId: agent.id,
            agentName: agent.name,
            phase: 'post',
            originalText: null,
            result: dataStored
                ? 'Sidecar: data stored'
                : (stateRejected ? 'Sidecar: invalid state rejected' : 'Sidecar: no data extracted'),
            mode: 'sidecar',
        });

        // Memory-backed agents are marked by the successful validated commit.
        // A sidecar with no Memory still completed once it returned a non-empty
        // response, so record one-shot completion here before the orchestrator's
        // sidecar early return.
        if (!agent.mergeVariable?.enabled || !agent.mergeVariable?.variableName) {
            markActivationPolicyComplete(agent);
        }

        if (showNotifications) {
            toastr.clear();
            if (dataStored) {
                toastr.success('', agent.name, { timeOut: 3000 });
            } else if (isAfterDark && !recoveredAfterDark) {
                toastr.warning('The model returned no complete pitch. Try again, or use a model with a larger reliable JSON output.', agent.name, { timeOut: 7000 });
            } else if (isDramaQueen && !recoveredDramaQueen) {
                toastr.warning('The response ended before two complete drama options could be recovered. Your previous options were preserved.', agent.name, { timeOut: 7000 });
            } else if (stateRejected) {
                toastr.warning('Invalid tracker update rejected; previous state preserved.', agent.name, { timeOut: 7000 });
            } else {
                toastr.warning('No data extracted', agent.name, { timeOut: 5000 });
            }
        }

        return { changed: false, dataStored, stateRejected };

    } catch (err) {
        if (isAbortError(err)) {
            if (showNotifications) {
                toastr.clear();
                const msg = err.reason === 'timeout' ? 'Timed out' : 'Stopped';
                toastr.info(msg, agent.name, { timeOut: 4000 });
            }
            return { changed: false, dataStored: false, cancelled: true };
        }
        console.error(`${LOG_PREFIX} Sidecar agent "${agent.name}" failed:`, err);
        if (showNotifications) {
            toastr.clear();
            toastr.error(`Failed: ${err.message}`, agent.name, { timeOut: 8000 });
        }
        return { changed: false, dataStored: false, error: err.message };
    }
}

// ============================================================================
// BOUNDED REPAIR — one corrective call when a validated update is rejected
// ============================================================================

/**
 * Attempt a SINGLE corrective LLM call for a tracker whose latest proposed state
 * failed schema validation. Reads the rejected proposal + validation errors off
 * the stored transaction, asks the model to return a corrected state block (in
 * the same tagged format the agent's extractor expects), then re-stores it —
 * which re-validates and commits on success, or leaves the prior good state in
 * place on a second failure. Strictly bounded: one attempt, no recursion.
 *
 * Gated by the caller (globalSettings.repairRejectedState !== false). Reuses the
 * agent's own connection profile + token budget. Safe on any agent: no-ops
 * unless there is a rejected transaction carrying a proposal to fix and the
 * agent uses a tagged extract pattern.
 *
 * @param {object} agent
 * @param {object} message - chat[n]
 * @param {number} messageIndex
 * @param {object} [opts] - { signal, timeoutMs }
 * @returns {Promise<{repaired: boolean, items?: object[]|null, cancelled?: boolean, error?: string}>}
 */
export async function repairRejectedState(agent, message, messageIndex, opts = {}) {
    const mv = agent.mergeVariable;
    if (!mv?.enabled || !mv.validation?.enabled || !mv.extractPattern) {
        return { repaired: false };
    }

    const tx = getStateTransaction(message, agent.id);
    if (!tx || tx.status !== 'rejected') return { repaired: false };

    const errors = Array.isArray(tx.errors) ? tx.errors : [];
    const proposed = Array.isArray(tx.proposedItems) ? tx.proposedItems : null;
    if (!proposed || proposed.length === 0) return { repaired: false };

    // The invalid logical JSON the model needs to correct.
    const jsonField = mv.validation.jsonField || mv.fieldNames?.[0] || 'json';
    const invalidBlob = proposed
        .map(item => item?.[jsonField])
        .filter(value => typeof value === 'string' && value.trim())
        .join('\n');
    if (!invalidBlob) return { repaired: false };

    const schemaStr = mv.validation.schema ? JSON.stringify(mv.validation.schema) : '{}';
    const errorLines = errors.length ? errors.map(e => `- ${e}`).join('\n') : '- (unspecified)';

    const systemPrompt = [
        'You are a strict JSON repair function. A structured state update FAILED schema validation.',
        'Return a corrected version that satisfies EVERY listed constraint. Preserve the original meaning; change ONLY what the errors require. Do not add, drop, or invent characters or fields beyond what the schema needs.',
        '',
        'JSON SCHEMA (the corrected payload must validate against this):',
        schemaStr,
        '',
        'VALIDATION ERRORS TO FIX:',
        errorLines,
        '',
        `Wrap the corrected JSON in the SAME tags the task uses, matching this extractor: ${mv.extractPattern}`,
        'Output ONLY the corrected state block — no prose, no explanation, no code fences.',
    ].join('\n');

    const userContent = `INVALID OUTPUT TO REPAIR:\n${invalidBlob}`;
    const maxTokens = agent.sidecarCall?.maxTokens || agent.maxTokens || 8192;

    let response;
    try {
        response = await callAgentLLM({
            systemPrompt,
            userContent,
            profileRef: agent.connectionProfile || '',
            maxTokens,
            callerName: `repair:${agent.name}`,
            signal: opts.signal ?? null,
            timeoutMs: opts.timeoutMs,
        });
    } catch (err) {
        if (isAbortError(err)) return { repaired: false, cancelled: true };
        debug(`${LOG_PREFIX} repair call failed for "${agent.name}":`, err?.message);
        return { repaired: false, error: err?.message };
    }
    if (!response) return { repaired: false };

    // Re-store: re-extracts, re-validates, and commits on success (or rejects
    // again, leaving the prior good state). No recursion — one attempt only.
    const items = storeSidecarResult(agent, response, message, messageIndex);
    const nowRejected = getStateTransaction(message, agent.id)?.status === 'rejected';
    if (items && !nowRejected) {
        debug(`${LOG_PREFIX} repaired invalid state for "${agent.name}"`);
        return { repaired: true, items };
    }
    return { repaired: false };
}

// ============================================================================
// PRE-GEN SIDECAR EXECUTION
// ============================================================================

/**
 * Run a single pre-gen sidecar agent.
 *
 * Makes an LLM call with recent chat history as context (plus rich context —
 * card / persona / World Info / Summary / Author's Note / pending message — if
 * the agent opted in). Returns the LLM response text for injection into the
 * main generation.
 *
 * @param {object} agent
 * @param {string} contextText — formatted recent chat history
 * @param {string} generationType
 * @param {string} [pendingUserText] — the user's not-yet-committed message
 * @param {object} [opts] — { signal, timeoutMs } for cancel/timeout
 * @returns {Promise<{response: string, error?: string}>}
 */
export async function executePreGenSidecarAgent(agent, contextText, generationType, pendingUserText = '', opts = {}) {
    let expandedPrompt = substituteParams(agent.prompt).trim();
    if (!expandedPrompt) {
        return { response: '' };
    }

    // Inject merge variable state (continuity from previous turns)
    if (agent.mergeVariable?.enabled && agent.mergeVariable.injectFormatted && agent.mergeVariable.variableName) {
        const formatted = formatMergeVariableData(agent.mergeVariable);
        if (formatted) {
            expandedPrompt += '\n\n' + formatted;
        }
    }
    const retentionPrompt = buildRetentionPrompt(agent.mergeVariable?.retention);
    if (retentionPrompt) expandedPrompt += '\n\n' + retentionPrompt;

    // Rich context (opt-in): the same inputs the main chat sees. Appended to
    // the system prompt so the planner directs from the real scene state, not
    // just the last N lines. mesNum = end of chat (pre-gen reads everything).
    // suppressSelfMemory (reroll blindfold) threads through from the caller.
    const richContext = await buildAgentRichContext(
        agent, chat.length - 1, pendingUserText, 8192,
        { suppressSelfMemory: !!opts.suppressSelfMemory },
    );
    if (richContext) {
        expandedPrompt += '\n\n' + richContext;
    }

    const maxTokens = agent.sidecarCall?.maxTokens || agent.maxTokens || 8192;
    const globalSettings = getGlobalSettings();
    const showNotifications = globalSettings.showNotifications;
    // Cancel/timeout: the pre-gen run controller passes a signal (+timeout) so
    // the user can stop a slow planner. With no caller opts, fall back to the
    // configured wall-clock timeout alone so a stalled stream can't hang main gen.
    const tmo = globalSettings.agentCallTimeoutMs;
    const fallbackTimeout = (typeof tmo === 'number' && tmo >= 0) ? tmo : undefined;
    const signal = opts.signal ?? null;
    const timeoutMs = opts.timeoutMs !== undefined ? opts.timeoutMs : fallbackTimeout;

    if (showNotifications) {
        toastr.info('Analyzing context...', agent.name, { timeOut: 0, extendedTimeOut: 0 });
    }

    try {
        const userContent = `Generation type: ${generationType}\n\nRecent conversation context:\n<chat_history>\n${contextText}\n</chat_history>`;

        const response = await callAgentLLM({
            systemPrompt: expandedPrompt,
            userContent,
            profileRef: agent.connectionProfile || '',
            maxTokens,
            signal,
            timeoutMs,
            callerName: `pre-gen:${agent.name}`,
        });

        if (showNotifications) {
            toastr.clear();
            if (response) {
                toastr.success('', agent.name, { timeOut: 3000 });
            } else {
                toastr.warning('Empty response', agent.name, { timeOut: 5000 });
            }
        }

        return { response };

    } catch (err) {
        if (isAbortError(err)) {
            if (showNotifications) {
                toastr.clear();
                const msg = err.reason === 'timeout' ? 'Timed out' : 'Stopped';
                toastr.info(msg, agent.name, { timeOut: 4000 });
            }
            // Propagate so the caller's run scaffolding unwinds on user stop /
            // timeout (the batch wrapper and processPreGenAgents re-throw aborts).
            throw err;
        }
        console.error(`${LOG_PREFIX} Pre-gen sidecar "${agent.name}" failed:`, err);
        if (showNotifications) {
            toastr.clear();
            toastr.error(`Failed: ${err.message}`, agent.name, { timeOut: 8000 });
        }
        return { response: '', error: err.message };
    }
}
