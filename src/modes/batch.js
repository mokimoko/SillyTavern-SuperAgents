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
    groupSidecarsByProfile,
} from './sidecar.js';
import { getGlobalSettings } from '../data/store.js';
import { recordAgents } from '../core/callStats.js';

const LOG_PREFIX = '[SuperAgents/batch]';
const PROMPT_KEY_PREFIX = 'sa_agent_';

// Envelope output ceiling. The per-agent maxTokens sum is clamped to this so a
// large batch doesn't ask for an envelope the backend silently truncates (a
// truncated envelope fails JSON.parse and drops every agent's data that turn).
const BATCH_MAXTOKENS_CEILING = 8192;

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
 * Sum the batch's per-agent maxTokens, clamped to a ceiling.
 * @param {object[]} agents
 * @returns {number}
 */
function batchMaxTokens(agents) {
    const sum = agents.reduce(
        (n, a) => n + (a.sidecarCall?.maxTokens || a.maxTokens || 2048), 0,
    );
    return Math.min(sum, BATCH_MAXTOKENS_CEILING);
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
 * @returns {string}
 */
function buildBatchedPrompt(agents, sceneText, message, generationType) {
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

    return `You are running ${agents.length} analysis tasks on the scene below.
Return a single JSON object with exactly these keys: ${keys.map(k => `"${k}"`).join(', ')}.
Each key contains the structured output for that task (as described in each task's instructions).
Output ONLY valid JSON — no commentary, no markdown fences, no explanation.

${taskBlocks}

Character name: ${message.name || 'Assistant'}
Generation type: ${generationType}

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

    const systemPrompt = buildBatchedPrompt(batch, sceneText, message, generationType);

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
 * @param {object[]} agents
 * @param {string} contextText — formatted recent chat history
 * @param {string} generationType
 * @returns {string}
 */
function buildBatchedPreGenPrompt(agents, contextText, generationType) {
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

    return `You are running ${agents.length} analysis tasks on the recent conversation below.
Return a single JSON object with exactly these keys: ${keys.map(k => `"${k}"`).join(', ')}.
Each key's value is a string containing the complete output text for that task.
Output ONLY valid JSON — no commentary, no markdown fences, no explanation.

${taskBlocks}

Generation type: ${generationType}

<chat_history>
${contextText}
</chat_history>`;
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
 * @returns {Promise<Array<{agent: object, response: string}>>}
 */
export async function executePreGenSidecarBatch(batch, contextText, generationType) {
    if (batch.length === 0) return [];
    if (batch.length === 1) {
        const result = await executePreGenSidecarAgent(batch[0], contextText, generationType);
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

    const systemPrompt = buildBatchedPreGenPrompt(batch, contextText, generationType);

    let response;
    try {
        response = await callAgentLLM({
            systemPrompt,
            userContent: 'Analyze the conversation and return the combined JSON object.',
            profileRef: profileId,
            maxTokens,
            callerName: `pre-gen-batch:${batchNames}`,
            ...timeoutOpts(),
        });
    } catch (err) {
        if (isAbortError(err)) {
            if (showNotifications) {
                toastr.clear();
                toastr.info('Timed out', 'Pre-Gen Batch', { timeOut: 4000 });
            }
            return batch.map(a => ({ agent: a, response: '' }));
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
 * Run all pre-gen sidecar agents before the main generation and inject each
 * result into the upcoming prompt via setExtensionPrompt.
 *
 * Groups by connection profile for batching (mirrors the post-gen pattern).
 * Batches run in parallel; a failed batch never blocks the main generation.
 *
 * @param {object[]} activeAgents — all active agents for this turn
 * @param {string} generationType — normalized
 * @param {string} contextText — formatted recent chat history (built by caller)
 */
export async function processPreGenAgents(activeAgents, generationType, contextText) {
    const preGenSidecars = activeAgents.filter(a =>
        (a.phase === 'pre' || a.phase === 'both') && a.sidecarCall?.enabled,
    );
    if (preGenSidecars.length === 0) return;

    recordAgents(preGenSidecars.length); // cost-hint accounting (pre-gen agents)
    debug(`${LOG_PREFIX} running ${preGenSidecars.length} pre-gen sidecar(s)`);

    const batches = groupSidecarsByProfile(preGenSidecars);
    const batchPromises = [...batches.values()].map(batch =>
        executePreGenSidecarBatch(batch, contextText, generationType)
            .catch(err => {
                console.error(`${LOG_PREFIX} pre-gen batch failed:`, err);
                return batch.map(a => ({ agent: a, response: '' }));
            }),
    );

    const batchResults = await Promise.allSettled(batchPromises);

    for (const settled of batchResults) {
        if (settled.status !== 'fulfilled') continue;
        for (const { agent, response } of settled.value) {
            if (!response?.trim()) continue;
            const key = PROMPT_KEY_PREFIX + agent.id;
            setExtensionPrompt(
                key,
                response,
                agent.injection.position,
                agent.injection.depth,
                agent.injection.scan,
                agent.injection.role,
            );
            debug(`${LOG_PREFIX} injected pre-gen result for "${agent.name}" at depth ${agent.injection.depth}`);
        }
    }
}
