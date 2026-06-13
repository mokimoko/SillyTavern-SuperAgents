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
import { debug } from '../../index.js';
import { callAgentLLM, isAbortError } from '../core/llm.js';
import { recordAgentRun } from '../core/idempotency.js';
import { buildRichContext } from '../core/richContext.js';
import {
    readMergeArray,
    formatMergeVariableData,
    storeSidecarResult,
} from './mergeVariable.js';
import { getGlobalSettings } from '../data/store.js';

const LOG_PREFIX = '[SuperAgents/sidecar]';

// ============================================================================
// HISTORY CONTEXT
// ============================================================================

/**
 * Build a text representation of recent chat messages for agent context.
 * @param {number} beforeIndex — message index to look back from
 * @param {number} [messageCount=20] — how many recent messages to include
 * @returns {string}
 */
export function buildHistoryContext(beforeIndex, messageCount = 20) {
    const lines = [];
    const end = Math.min(beforeIndex, chat.length);
    const start = Math.max(0, end - messageCount);
    for (let i = start; i < end; i++) {
        const msg = chat[i];
        if (!msg) continue;
        const speaker = msg.is_user ? '{{user}}' : (msg.name || 'Assistant');
        lines.push(`[${speaker}]: ${msg.mes}`);
    }
    return substituteParams(lines.join('\n\n'));
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
 * @param {object} agent
 * @param {number} mesNum         context point (highest message index to read)
 * @param {string} pendingUserText  the not-yet-committed user message ('' post-gen)
 * @param {number} maxContext
 * @returns {Promise<string>}
 */
export async function buildAgentRichContext(agent, mesNum, pendingUserText = '', maxContext = 8192) {
    const flags = agent?.sidecarCall?.richContext;
    if (!flags?.enabled) return '';
    try {
        return await buildRichContext({ mesNum, flags, pendingUserText, maxContext });
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
    const attrs = [];
    for (const [field, attrName] of Object.entries(display.dataMap || {})) {
        const val = item[field] ?? '';
        if (val) {
            const escaped = String(val).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
            attrs.push(`${attrName}="${escaped}"`);
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
 * Agents sharing a profile get combined into one LLM call.
 * Agents with NO profile get solo execution (no batching).
 * @param {object[]} agents
 * @returns {Map<string, object[]>} profileKey → agents
 */
export function groupSidecarsByProfile(agents) {
    const groups = new Map();
    for (const agent of agents) {
        const key = agent.connectionProfile || `__solo_${agent.id}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(agent);
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

    const maxTokens = agent.sidecarCall?.maxTokens || agent.maxTokens || 8192;
    const globalSettings = getGlobalSettings();
    const showNotifications = globalSettings.showNotifications;

    // Rich context (opt-in): card / persona / World Info / Summary / Author's
    // Note. Post-gen, so no pending message. Appended to the system prompt.
    const richContext = await buildAgentRichContext(agent, messageIndex, '', maxTokens);
    if (richContext) {
        expandedPrompt += '\n\n' + richContext;
    }

    // Build optional history context
    let historyBlock = '';
    if (agent.sidecarCall?.includeHistory) {
        const historyCount = agent.sidecarCall.historyMessageCount || 20;
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
        const extractedItems = storeSidecarResult(agent, response, message, messageIndex);
        const dataStored = !!extractedItems;

        // Build display data if configured
        if (extractedItems) {
            buildSidecarDisplayData(agent, message, messageIndex, extractedItems);
        }

        recordAgentRun(messageIndex, {
            agentId: agent.id,
            agentName: agent.name,
            phase: 'post',
            originalText: null,
            result: dataStored ? 'Sidecar: data stored' : 'Sidecar: no data extracted',
            mode: 'sidecar',
        });

        if (showNotifications) {
            toastr.clear();
            if (dataStored) {
                toastr.success('', agent.name, { timeOut: 3000 });
            } else {
                toastr.warning('No data extracted', agent.name, { timeOut: 5000 });
            }
        }

        return { changed: false, dataStored };

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

    // Rich context (opt-in): the same inputs the main chat sees. Appended to
    // the system prompt so the planner directs from the real scene state, not
    // just the last N lines. mesNum = end of chat (pre-gen reads everything).
    const richContext = await buildAgentRichContext(agent, chat.length - 1, pendingUserText);
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
