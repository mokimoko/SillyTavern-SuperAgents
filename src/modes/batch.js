/**
 * modes/batch.js — JSON-envelope batching for sidecar agents.
 *
 * When multiple sidecar agents share a connection profile, we combine their
 * prompts into one LLM call that returns a single JSON object keyed by each
 * agent's responseKey, then distribute the results. This is the headline
 * cost optimization: five trackers on one profile = one round-trip, not five.
 *
 * Two envelopes:
 *   - post-gen: tasks analyze <scene> (the just-received message), each key's
 *     value is structured data stored via the agent's mergeVariable config.
 *   - pre-gen: tasks analyze <chat_history>, each key's value is a text string
 *     injected into the upcoming main generation.
 *
 * Ported from VM's runner.js, rewired onto callAgentLLM(), with two fixes
 * from the gameplan folded in (problem #6):
 *   - maxTokens cap: the naive per-agent sum is clamped to a ceiling so a
 *     big batch doesn't request an envelope the backend will truncate.
 *   - partial-parse salvage: if JSON.parse fails, attempt per-key recovery
 *     so one malformed key doesn't drop every tracker's data that turn.
 */

import { substituteParams, setExtensionPrompt } from '../../../../../../script.js';
import { chat } from '../../../../../../script.js';
import { debug } from '../../index.js';
import { callAgentLLM, isAbortError } from '../core/llm.js';
import { recordAgentRun } from '../core/idempotency.js';
import {
    formatMergeVariableData,
    storeBatchedSidecarResult,
} from './mergeVariable.js';
import {
    executeSidecarAgent,
    executePreGenSidecarAgent,
    buildSidecarDisplayData,
    buildAgentRichContext,
    buildHistoryContext,
    groupSidecarsByProfile,
} from './sidecar.js';
import { getGlobalSettings, getGroupById } from '../data/store.js';
import { recordAgents } from '../core/callStats.js';

const LOG_PREFIX = '[SuperAgents/batch]';
const PROMPT_KEY_PREFIX = 'sa_agent_';

// Fallback envelope output ceiling. The per-agent maxTokens sum is clamped to
// this so a large batch doesn't ask for an envelope the backend silently
// truncates (a truncated envelope fails JSON.parse and drops every agent's data
// that turn). Used only when globalSettings.batchMaxTokens isn't a sane number.
const BATCH_MAXTOKENS_CEILING = 8192;

// Fraction of the ceiling reserved for JSON envelope scaffolding (the keys,
// braces, quotes, commas) so the agents' actual content budget doesn't get
// crowded out by structure on a big batch. 8% empirically clears the overhead
// for typical key counts without meaningfully shrinking content room.
const ENVELOPE_OVERHEAD_FRACTION = 0.08;

/**
 * Per-call timeout for batch / pre-gen LLM calls. There's no cancel controller
 * for the pre-gen phase (it runs before the post-gen run is set up), but a
 * configured wall-clock ceiling still prevents a stalled stream from hanging
 * the main generation indefinitely. Returns {} when timeout is disabled (0),
 * letting callAgentLLM apply its own default.
 * @returns {{timeoutMs?: number}}
 */
function timeoutOpts() {
    const t = getGlobalSettings().agentCallTimeoutMs;
    return (typeof t === 'number' && t >= 0) ? { timeoutMs: t } : {};
}

// ============================================================================
// MAXTOKENS + ENVELOPE PARSING (gameplan fix #6)
// ============================================================================

/**
 * Compute the output-token budget for a batch envelope.
 *
 * The naive approach (return min(sum, ceiling)) silently STARVES big batches:
 * five trackers wanting 2048 each (10240) get clamped to 8192, so each key
 * effectively has LESS room than it asked for — making truncation, and the
 * salvage path, MORE likely on exactly the batches that need protection
 * (audit fix #12).
 *
 * This version:
 *   - reserves a slice of the ceiling for JSON scaffolding (keys/braces/commas)
 *     so structure doesn't eat content budget,
 *   - when the requested sum exceeds the usable ceiling, WARNS so the clamp is
 *     visible in logs (and tells you the per-key shortfall), rather than failing
 *     opaquely a turn later in JSON.parse,
 *   - returns the value actually requested from the backend.
 *
 * The single-number request cap can't give each key its own budget, but the
 * warning is the actionable signal: it means "split this batch or raise
 * batchMaxTokens." A future enhancement could downscale each agent's per-key
 * target proportionally inside buildBatchedPrompt; for now we keep the call
 * shape and surface the pressure.
 *
 * @param {object[]} agents
 * @returns {number}
 */
function batchMaxTokens(agents) {
    const configured = Number(getGlobalSettings().batchMaxTokens);
    const ceiling = Number.isFinite(configured) && configured > 0
        ? configured
        : BATCH_MAXTOKENS_CEILING;

    // Usable content budget after reserving envelope scaffolding overhead.
    const usable = Math.max(1, Math.floor(ceiling * (1 - ENVELOPE_OVERHEAD_FRACTION)));

    const sum = agents.reduce(
        (n, a) => n + (a.sidecarCall?.maxTokens || a.maxTokens || 2048), 0,
    );

    if (sum > usable) {
        const perKeyWanted = Math.round(sum / agents.length);
        const perKeyActual = Math.floor(usable / agents.length);
        console.warn(
            `${LOG_PREFIX} batch of ${agents.length} agent(s) wants ${sum} tokens but the ` +
            `envelope is capped at ${usable} (ceiling ${ceiling} − overhead). Each key now ` +
            `gets ~${perKeyActual} vs ~${perKeyWanted} requested — truncation/salvage is more ` +
            `likely. Split this group across profiles or raise globalSettings.batchMaxTokens.`,
        );
        return usable;
    }

    return sum;
}

/**
 * Strip markdown code fences from a model response, if present.
 * @param {string} response
 * @returns {string}
 */
function stripFences(response) {
    return response
        .replace(/^```(?:json)?\s*\n?/i, '')
        .replace(/\n?```\s*$/i, '')
        .trim();
}

/**
 * Parse a JSON envelope, with a per-key salvage fallback.
 *
 * Primary path: JSON.parse the whole (fence-stripped) response.
 * Salvage path: if that throws (most often a truncated final key), walk the
 * expected keys and pull each one's value out individually with a tolerant
 * regex. A single broken key then costs only that key, not the whole batch.
 *
 * @param {string} response — raw model output
 * @param {string[]} keys — expected envelope keys
 * @returns {{ envelope: object, salvaged: boolean }}
 */
function parseEnvelope(response, keys) {
    const cleaned = stripFences(response);

    try {
        return { envelope: JSON.parse(cleaned), salvaged: false };
    } catch {
        // fall through to salvage
    }

    const envelope = {};
    let recovered = 0;

    for (const key of keys) {
        const value = salvageKey(cleaned, key);
        if (value !== undefined) {
            envelope[key] = value;
            recovered++;
        }
    }

    if (recovered > 0) {
        debug(`${LOG_PREFIX} envelope salvage recovered ${recovered}/${keys.length} key(s)`);
    }
    return { envelope, salvaged: true };
}

/**
 * Pull a single key's value out of a malformed JSON-ish envelope.
 * Handles string, object, and array values by brace/bracket matching;
 * falls back to a bare scalar grab. Returns undefined if nothing parses.
 *
 * @param {string} text
 * @param {string} key
 * @returns {*|undefined}
 */
function salvageKey(text, key) {
    const keyToken = `"${key}"`;
    const at = text.indexOf(keyToken);
    if (at < 0) return undefined;

    // Position just after the colon following the key
    let i = text.indexOf(':', at + keyToken.length);
    if (i < 0) return undefined;
    i++;
    while (i < text.length && /\s/.test(text[i])) i++;
    if (i >= text.length) return undefined;

    const open = text[i];

    // Balanced object / array capture
    if (open === '{' || open === '[') {
        const close = open === '{' ? '}' : ']';
        let depth = 0;
        let inStr = false;
        let esc = false;
        for (let j = i; j < text.length; j++) {
            const ch = text[j];
            if (inStr) {
                if (esc) esc = false;
                else if (ch === '\\') esc = true;
                else if (ch === '"') inStr = false;
                continue;
            }
            if (ch === '"') inStr = true;
            else if (ch === open) depth++;
            else if (ch === close) {
                depth--;
                if (depth === 0) {
                    const frag = text.slice(i, j + 1);
                    try { return JSON.parse(frag); } catch { return undefined; }
                }
            }
        }
        return undefined; // never closed (truncated) — give up on this key
    }

    // String value
    if (open === '"') {
        let esc = false;
        for (let j = i + 1; j < text.length; j++) {
            const ch = text[j];
            if (esc) { esc = false; continue; }
            if (ch === '\\') { esc = true; continue; }
            if (ch === '"') {
                const frag = text.slice(i, j + 1);
                try { return JSON.parse(frag); } catch { return text.slice(i + 1, j); }
            }
        }
        return undefined;
    }

    // Bare scalar (number / bool / null) up to the next comma or closer
    const rest = text.slice(i);
    const scalar = rest.match(/^[^,}\]]+/);
    if (scalar) {
        const raw = scalar[0].trim();
        try { return JSON.parse(raw); } catch { return raw; }
    }
    return undefined;
}

// ============================================================================
// POST-GEN BATCH (analyze <scene>, store structured data)
// ============================================================================

/**
 * Build the post-gen JSON-envelope prompt. Each task's output is structured
 * data stored via that agent's mergeVariable config.
 *
 * @param {object[]} agents
 * @param {string} sceneText
 * @param {object} message
 * @param {string} generationType
 * @param {number} [messageIndex] — context point for the optional history block
 * @returns {string}
 */
function buildBatchedPrompt(agents, sceneText, message, generationType, messageIndex = chat.length) {
    const keys = agents.map(a => a.sidecarCall?.responseKey || a.id);

    const taskBlocks = agents.map(agent => {
        const key = agent.sidecarCall?.responseKey || agent.id;
        let prompt = substituteParams(agent.prompt).trim();

        if (agent.mergeVariable?.enabled && agent.mergeVariable.injectFormatted && agent.mergeVariable.variableName) {
            const formatted = formatMergeVariableData(agent.mergeVariable);
            if (formatted) prompt += '\n\n' + formatted;
        }

        return `=== Task: ${key} ===\n${prompt}`;
    }).join('\n\n');

    // Shared history block: if ANY batched agent opted into history, include one
    // <chat_history> block sized to the largest requested window. Mirrors the
    // solo path (sidecar.js), which the batch path previously skipped — so a
    // batched tracker now gets the same recent-scene context a solo one does.
    let historyBlock = '';
    const histCount = agents
        .filter(a => a.sidecarCall?.includeHistory)
        .reduce((max, a) => Math.max(max, a.sidecarCall.historyMessageCount || 20), 0);
    if (histCount > 0) {
        const historyText = buildHistoryContext(messageIndex, histCount);
        if (historyText) {
            historyBlock = `\nRecent conversation history (check the latest scene against these established facts):\n<chat_history>\n${historyText}\n</chat_history>\n`;
        }
    }

    return `You are running ${agents.length} analysis tasks on the scene below.
Return a single JSON object with exactly these keys: ${keys.map(k => `"${k}"`).join(', ')}.
Each key contains the structured output for that task (as described in each task's instructions).
Output ONLY valid JSON — no commentary, no markdown fences, no explanation.

${taskBlocks}

Character name: ${message.name || 'Assistant'}
Generation type: ${generationType}
${historyBlock}
<scene>
${sceneText}
</scene>`;
}

/**
 * Execute a batch of post-gen sidecar agents sharing a connection profile.
 *
 * Single agent → delegates to executeSidecarAgent (no envelope overhead).
 * Multiple → one enveloped call, parse (with salvage), distribute + display.
 *
 * @param {object[]} batch
 * @param {object} message
 * @param {number} messageIndex
 * @param {string} generationType
 * @returns {Promise<{changed: boolean, dataStored: boolean}>}
 */
export async function executeSidecarBatch(batch, message, messageIndex, generationType, opts = {}) {
    if (batch.length === 0) return { changed: false, dataStored: false };
    if (batch.length === 1) {
        return await executeSidecarAgent(batch[0], message, messageIndex, generationType, opts);
    }

    const sceneText = message.mes;
    if (!sceneText?.trim()) return { changed: false, dataStored: false };

    const keys = batch.map(a => a.sidecarCall?.responseKey || a.id);
    const maxTokens = batchMaxTokens(batch);
    const profileId = batch[0].connectionProfile || '';
    const showNotifications = getGlobalSettings().showNotifications;
    const batchNames = batch.map(a => a.name).join(', ');

    if (showNotifications) {
        toastr.info('Analyzing (batched)...', batchNames, { timeOut: 0, extendedTimeOut: 0 });
    }

    const systemPrompt = buildBatchedPrompt(batch, sceneText, message, generationType, messageIndex);

    let response;
    try {
        response = await callAgentLLM({
            systemPrompt,
            userContent: 'Analyze the scene and return the combined JSON object.',
            profileRef: profileId,
            maxTokens,
            callerName: `batch:${batchNames}`,
            signal: opts.signal ?? null,
            timeoutMs: opts.timeoutMs,
        });
    } catch (err) {
        // A cancel/timeout must stop the whole run, not be downgraded to an
        // "empty response". Clear our sticky toast and re-throw so the
        // orchestrator's abort handling takes over.
        if (isAbortError(err)) {
            if (showNotifications) {
                toastr.clear();
                const msg = err.reason === 'timeout' ? 'Timed out' : 'Stopped';
                toastr.info(msg, 'Agent Batch', { timeOut: 4000 });
            }
            throw err;
        }
        console.error(`${LOG_PREFIX} batch call failed:`, err);
        response = '';
    }

    if (!response) {
        if (showNotifications) {
            toastr.clear();
            toastr.warning('Empty response', 'Agent Batch', { timeOut: 5000 });
        }
        return { changed: false, dataStored: false };
    }

    const { envelope } = parseEnvelope(response, keys);

    let storedCount = 0;
    for (const agent of batch) {
        const key = agent.sidecarCall?.responseKey || agent.id;
        const value = envelope[key];

        if (value === undefined || value === null) {
            debug(`${LOG_PREFIX} no data for key "${key}" (${agent.name})`);
            continue;
        }

        const storedItems = storeBatchedSidecarResult(agent, value, message, messageIndex);
        if (storedItems) {
            storedCount++;
            buildSidecarDisplayData(agent, message, messageIndex, storedItems);
        }

        recordAgentRun(messageIndex, {
            agentId: agent.id,
            agentName: agent.name,
            phase: 'post',
            originalText: null,
            result: storedItems ? 'Batched sidecar: data stored' : 'Batched sidecar: storage failed',
            mode: 'sidecar_batch',
        });
    }

    if (showNotifications) {
        toastr.clear();
        if (storedCount > 0) {
            toastr.success(`${storedCount}/${batch.length} agents stored`, 'Agent Batch', { timeOut: 3000 });
        } else {
            toastr.warning('No data extracted from batch', 'Agent Batch', { timeOut: 5000 });
        }
    }

    return { changed: false, dataStored: storedCount > 0 };
}

// ============================================================================
// PRE-GEN BATCH (analyze <chat_history>, inject text into main generation)
// ============================================================================

/**
 * Build the pre-gen JSON-envelope prompt. Unlike post-gen, each key's value
 * is a text string (the agent's output), injected into the upcoming main
 * generation rather than stored as structured data.
 *
 * Async because rich-context agents pull World Info (a dry-run WI scan).
 * Per-agent rich context is folded into that agent's task block so each task
 * carries only the context it asked for. The pending user message is appended
 * once at the end (it's the same for every task in the batch).
 *
 * @param {object[]} agents
 * @param {string} contextText — formatted recent chat history
 * @param {string} generationType
 * @param {string} [pendingUserText] — the user's not-yet-committed message
 * @returns {Promise<string>}
 */
async function buildBatchedPreGenPrompt(agents, contextText, generationType, pendingUserText = '') {
    const keys = agents.map(a => a.sidecarCall?.responseKey || a.id);

    const taskBlocks = await Promise.all(agents.map(async (agent) => {
        const key = agent.sidecarCall?.responseKey || agent.id;
        let prompt = substituteParams(agent.prompt).trim();

        if (agent.mergeVariable?.enabled && agent.mergeVariable.injectFormatted && agent.mergeVariable.variableName) {
            const formatted = formatMergeVariableData(agent.mergeVariable);
            if (formatted) prompt += '\n\n' + formatted;
        }

        // Per-agent rich context — only the sections this agent enabled. The
        // pending message is handled batch-wide below, so suppress it here to
        // avoid duplicating it in every task block.
        const richContext = await buildAgentRichContext(agent, chat.length - 1, '');
        if (richContext) prompt += '\n\n' + richContext;

        return `=== Task: ${key} ===\n${prompt}`;
    }));

    // Does any agent in the batch want the pending message? If so, append it
    // once at envelope scope.
    const wantsPending = agents.some(a => a.sidecarCall?.richContext?.enabled && a.sidecarCall.richContext.pendingUser);
    const pendingBlock = (wantsPending && pendingUserText.trim())
        ? `\n\n### Pending user message\n${substituteParams(pendingUserText).trim()}`
        : '';

    return `You are running ${agents.length} analysis tasks on the recent conversation below.
Return a single JSON object with exactly these keys: ${keys.map(k => `"${k}"`).join(', ')}.
Each key's value is a string containing the complete output text for that task.
Output ONLY valid JSON — no commentary, no markdown fences, no explanation.

${taskBlocks.join('\n\n')}

Generation type: ${generationType}

<chat_history>
${contextText}
</chat_history>${pendingBlock}`;
}

/**
 * Execute a batch of pre-gen sidecar agents sharing a connection profile.
 *
 * Single agent → delegates to executePreGenSidecarAgent.
 * Multiple → one enveloped call, parse (with salvage), return each result.
 *
 * @param {object[]} batch
 * @param {string} contextText — formatted recent chat history
 * @param {string} generationType
 * @param {string} [pendingUserText] — the user's not-yet-committed message
 * @param {object} [opts] — { signal, timeoutMs } for cancel/timeout
 * @returns {Promise<Array<{agent: object, response: string}>>}
 */
export async function executePreGenSidecarBatch(batch, contextText, generationType, pendingUserText = '', opts = {}) {
    if (batch.length === 0) return [];
    if (batch.length === 1) {
        const result = await executePreGenSidecarAgent(batch[0], contextText, generationType, pendingUserText, opts);
        return [{ agent: batch[0], response: result.response }];
    }

    const keys = batch.map(a => a.sidecarCall?.responseKey || a.id);
    const maxTokens = batchMaxTokens(batch);
    const profileId = batch[0].connectionProfile || '';
    const showNotifications = getGlobalSettings().showNotifications;
    const batchNames = batch.map(a => a.name).join(', ');

    if (showNotifications) {
        toastr.info('Analyzing context (batched)...', batchNames, { timeOut: 0, extendedTimeOut: 0 });
    }

    const systemPrompt = await buildBatchedPreGenPrompt(batch, contextText, generationType, pendingUserText);

    // Cancel/timeout: prefer the caller's signal+timeout (the pre-gen run
    // controller), falling back to the configured wall-clock timeout alone.
    const callOpts = (opts && (opts.signal || opts.timeoutMs !== undefined)) ? opts : timeoutOpts();

    let response;
    try {
        response = await callAgentLLM({
            systemPrompt,
            userContent: 'Analyze the conversation and return the combined JSON object.',
            profileRef: profileId,
            maxTokens,
            callerName: `pre-gen-batch:${batchNames}`,
            ...callOpts,
        });
    } catch (err) {
        if (isAbortError(err)) {
            if (showNotifications) {
                toastr.clear();
                const msg = err.reason === 'timeout' ? 'Timed out' : 'Stopped';
                toastr.info(msg, 'Pre-Gen Batch', { timeOut: 4000 });
            }
            // Propagate so the run scaffolding unwinds (user pressed stop).
            throw err;
        }
        console.error(`${LOG_PREFIX} pre-gen batch call failed:`, err);
        response = '';
    }

    if (!response) {
        if (showNotifications) {
            toastr.clear();
            toastr.warning('Empty response', 'Pre-Gen Batch', { timeOut: 5000 });
        }
        return batch.map(a => ({ agent: a, response: '' }));
    }

    const { envelope } = parseEnvelope(response, keys);

    const results = batch.map(agent => {
        const key = agent.sidecarCall?.responseKey || agent.id;
        const value = envelope[key];
        const text = value == null
            ? ''
            : typeof value === 'string'
                ? value
                : JSON.stringify(value);
        return { agent, response: text };
    });

    if (showNotifications) {
        toastr.clear();
        const successCount = results.filter(r => r.response).length;
        toastr.success(`${successCount}/${batch.length} agents`, 'Pre-Gen Batch', { timeOut: 3000 });
    }

    return results;
}

// ============================================================================
// PRE-GEN ORCHESTRATION
// ============================================================================

/**
 * Apply an agent's injection wrapper template to its output. {{output}} is
 * replaced with the text; if the template has no placeholder the text is
 * appended. Empty template = raw output (current behavior).
 *
 * @param {object} agent
 * @param {string} output
 * @returns {string}
 */
function wrapInjection(agent, output) {
    const tpl = String(agent?.injection?.template ?? '').trim();
    if (!tpl) return output;
    return tpl.includes('{{output}}')
        ? tpl.replaceAll('{{output}}', output)
        : `${tpl}\n${output}`;
}

/**
 * Persist a pre-gen agent's output to its merge variable (snapshot mode) so it
 * shows up as a HUD block under the upcoming message and survives swipes —
 * the Director-plan display path. Only runs when the agent has a mergeVariable
 * configured; the raw output string is stored as the (first) field's value.
 * No-op otherwise.
 *
 * Pre-gen runs before the bot message exists, so we only write the chat
 * variable here (the part injection and the display rebuild both read). The
 * per-swipe binding to the actual message happens later, at
 * CHARACTER_MESSAGE_RENDERED (lifecycle.onCharacterMessageRendered →
 * bindVariableToSwipe), once a real message is available.
 *
 * @param {object} agent
 * @param {string} output
 */
function persistPreGenOutput(agent, output) {
    const mv = agent.mergeVariable;
    if (!mv?.enabled || !mv.variableName) return;
    try {
        // Throwaway holder: storeBatchedSidecarResult also sets per-swipe data,
        // but at pre-gen there's no real message yet, so that write is discarded
        // here and redone against the rendered message later. The chat-variable
        // write (what injection + display read) is what matters now.
        const holder = { extra: {} };
        storeBatchedSidecarResult(agent, output, holder, chat.length);
        debug(`${LOG_PREFIX} persisted pre-gen output for "${agent.name}" → "${mv.variableName}"`);
    } catch (err) {
        debug(`${LOG_PREFIX} persist pre-gen output failed for "${agent.name}":`, err?.message);
    }
}

/**
 * Inject one pre-gen agent's output into the upcoming main generation: persist
 * it for the HUD/display path, apply the injection wrapper, and register the
 * extension prompt. Shared by the parallel and sequential group paths so the
 * inject semantics live in one place.
 *
 * @param {object} agent
 * @param {string} response — the agent's raw output text
 */
function injectPreGenResult(agent, response) {
    const text = String(response ?? '').trim();
    if (!text) return;

    // Persist for display (Director plan HUD) before stripping/wrapping —
    // the displayed plan should match the raw model output.
    persistPreGenOutput(agent, text);

    const wrapped = wrapInjection(agent, text);
    const key = PROMPT_KEY_PREFIX + agent.id;
    setExtensionPrompt(
        key,
        wrapped,
        agent.injection.position,
        agent.injection.depth,
        agent.injection.scan,
        agent.injection.role,
    );
    debug(`${LOG_PREFIX} injected pre-gen result for "${agent.name}" at depth ${agent.injection.depth}`);
}

/**
 * Organize pre-gen agents into an ordered execution plan, mirroring the
 * post-gen buildExecutionPlan in lifecycle.js (audit fix #7).
 *
 * Grouped agents inherit their group's executionMode + order; ungrouped agents
 * fall into a virtual group that runs last in parallel. Disabled/missing groups
 * demote their members to ungrouped. This is what lets a user put a
 * "world-state" planner and a "director" planner in a sequential group and have
 * the director actually run AFTER — and therefore see — the world-state plan.
 *
 * @param {object[]} agents — pre-phase sidecar agents
 * @returns {Array<{id:string, order:number, executionMode:string, agents:object[]}>}
 */
function buildPreGenExecutionPlan(agents) {
    const grouped = new Map();
    const ungrouped = [];

    for (const agent of agents) {
        if (agent.groupId) {
            if (!grouped.has(agent.groupId)) grouped.set(agent.groupId, []);
            grouped.get(agent.groupId).push(agent);
        } else {
            ungrouped.push(agent);
        }
    }

    const plan = [];
    for (const [groupId, groupAgents] of grouped) {
        const groupConfig = getGroupById(groupId);
        if (!groupConfig || !groupConfig.enabled) {
            ungrouped.push(...groupAgents);
            continue;
        }
        plan.push({
            id: groupId,
            order: groupConfig.order ?? 100,
            executionMode: groupConfig.executionMode || 'parallel',
            agents: groupAgents,
        });
    }

    if (ungrouped.length > 0) {
        plan.push({
            id: '__ungrouped__',
            order: 9999,
            executionMode: 'parallel',
            agents: ungrouped,
        });
    }

    plan.sort((a, b) => a.order - b.order);
    return plan;
}

/**
 * Run a parallel group of pre-gen agents: batch by connection profile, run the
 * batches concurrently, inject every result. A failed batch never blocks the
 * main generation.
 *
 * @param {object[]} groupAgents
 * @param {string} generationType
 * @param {string} contextText
 * @param {string} pendingUserText
 * @param {object} opts
 */
async function runPreGenParallelGroup(groupAgents, generationType, contextText, pendingUserText, opts) {
    const batches = groupSidecarsByProfile(groupAgents);
    const batchPromises = [...batches.values()].map(batch =>
        executePreGenSidecarBatch(batch, contextText, generationType, pendingUserText, opts)
            .catch(err => {
                if (isAbortError(err)) throw err; // propagate stop/timeout
                console.error(`${LOG_PREFIX} pre-gen batch failed:`, err);
                return batch.map(a => ({ agent: a, response: '' }));
            }),
    );

    const batchResults = await Promise.allSettled(batchPromises);
    for (const settled of batchResults) {
        if (settled.status === 'rejected') {
            if (isAbortError(settled.reason)) throw settled.reason;
            continue;
        }
        for (const { agent, response } of settled.value) {
            injectPreGenResult(agent, response);
        }
    }
}

/**
 * Run a sequential group of pre-gen agents: one at a time, in injection order,
 * INJECTING each result before the next agent runs.
 *
 * The composition channel between agents is the MERGE VARIABLE, not the
 * injected extension-prompt: injectPreGenResult → persistPreGenOutput writes
 * the agent's output to its merge variable immediately, so a later agent in the
 * group that reads that same variable (mergeVariable.injectFormatted, or a
 * shared variableName) sees the earlier plan when it builds its own prompt. The
 * setExtensionPrompt side only reaches the MAIN generation, not sibling
 * sidecars — so cross-agent hand-off must go through the variable. That's why
 * "world-state then director" composes: point the director at the world-state
 * variable.
 *
 * Sequential groups don't profile-batch (batching is a parallel-only
 * optimization); each agent is a solo pre-gen call.
 *
 * @param {object[]} groupAgents
 * @param {string} generationType
 * @param {string} contextText
 * @param {string} pendingUserText
 * @param {object} opts
 */
async function runPreGenSequentialGroup(groupAgents, generationType, contextText, pendingUserText, opts) {
    const sorted = [...groupAgents].sort((a, b) => (a.injection?.order ?? 0) - (b.injection?.order ?? 0));
    for (const agent of sorted) {
        const result = await executePreGenSidecarAgent(agent, contextText, generationType, pendingUserText, opts);
        injectPreGenResult(agent, result.response);
    }
}

/**
 * Run all pre-gen sidecar agents before the main generation and inject each
 * result into the upcoming prompt via setExtensionPrompt.
 *
 * Group-aware (audit fix #7): agents are organized into an execution plan that
 * honors group executionMode + order. Sequential groups run their members one
 * at a time, injecting between each so a later planner can read an earlier
 * one's plan; parallel groups (and ungrouped agents) batch by profile and run
 * concurrently. Groups run in `order`; ungrouped agents run last. A failed
 * batch/agent never blocks the main generation; a user stop/timeout aborts the
 * remaining plan.
 *
 * @param {object[]} activeAgents — all active agents for this turn
 * @param {string} generationType — normalized
 * @param {string} contextText — formatted recent chat history (built by caller)
 * @param {string} [pendingUserText] — the user's not-yet-committed message
 * @param {object} [opts] — { signal, timeoutMs } for cancel/timeout of the LLM calls
 */
export async function processPreGenAgents(activeAgents, generationType, contextText, pendingUserText = '', opts = {}) {
    const preGenSidecars = activeAgents.filter(a =>
        (a.phase === 'pre' || a.phase === 'both') && a.sidecarCall?.enabled,
    );
    if (preGenSidecars.length === 0) return;

    recordAgents(preGenSidecars.length); // cost-hint accounting (pre-gen agents)

    const plan = buildPreGenExecutionPlan(preGenSidecars);
    debug(`${LOG_PREFIX} running ${preGenSidecars.length} pre-gen sidecar(s) across ${plan.length} group(s)`);

    for (const group of plan) {
        try {
            if (group.executionMode === 'sequential') {
                await runPreGenSequentialGroup(group.agents, generationType, contextText, pendingUserText, opts);
            } else {
                await runPreGenParallelGroup(group.agents, generationType, contextText, pendingUserText, opts);
            }
        } catch (err) {
            // A user stop / timeout aborts the whole remaining plan (the run
            // scaffolding in the lifecycle catches it). Ordinary failures are
            // contained per-group so one bad group can't block main generation.
            if (isAbortError(err)) throw err;
            console.error(`${LOG_PREFIX} pre-gen group "${group.id}" failed:`, err);
        }
    }
}
