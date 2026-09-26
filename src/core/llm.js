/**
 * core/llm.js — the single LLM call path for SuperAgents.
 *
 * Replaces the four duplicated CMRS-try / quiet-fallback / extract ladders
 * that bloated VM's runner.js. Every mode (sidecar, batch, pre-gen,
 * rewrite) routes through callAgentLLM() so a bug fix lives in exactly
 * one place.
 *
 * Cascade:
 *   1. CMRS sendRequest with target profile          (preferred — no swap)
 *   2. On auth error (400/401/403): retry with current profile
 *   3. On stream error: retry without streaming
 *   4. If CMRS unreachable or all CMRS attempts fail: legacy profile swap
 *      + generateQuietPrompt + restore in finally
 *   5. Extract via ONE shared extractResponseText()
 *   6. Strip reasoning via the profile's reasoning template (qvink pattern
 *      borrowed from Recast — without this, reasoning leaks into structured
 *      extraction and breaks tracker JSON)
 *
 * Returns a string for ordinary failures; stop and timeout raise AgentCallAbortedError.
 */

import { getContext } from '../../../../../extensions.js';
import { generateQuietPrompt } from '../../../../../../script.js';

import {
    isCMRSAvailable,
    resolveTargetProfile,
    resolveProfileId,
    getConnectionProfiles,
    getCurrentProfileId,
    swapProfileLegacy,
    restoreProfileLegacy,
} from './profiles.js';
import { recordCall } from './callStats.js';
import { debug } from './runtime.js';
import { getEffectiveConnectionProfile } from '../data/store.js';

const LOG_PREFIX = '[SuperAgents/llm]';

// Default wall-clock ceiling for a single agent LLM call. A hung stream (the
// back-end opens the connection then stalls with no chunks, no end, no error)
// would otherwise leave the awaiting caller — and its sticky toast, and the
// isAgentRunInProgress flag — wedged forever. Callers can override per-call.
const DEFAULT_CALL_TIMEOUT_MS = 90000;

/** Error thrown when a call is aborted (timeout or user cancel). */
export class AgentCallAbortedError extends Error {
    constructor(reason = 'aborted') {
        super(reason === 'timeout' ? 'Agent call timed out' : 'Agent call cancelled');
        this.name = 'AgentCallAbortedError';
        this.reason = reason; // 'timeout' | 'cancel'
        this.aborted = true;
    }
}

/**
 * Race a promise against the call-wide AbortSignal.
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {AbortSignal|null} signal
 * @returns {Promise<T>}
 */
function withAbort(promise, signal) {
    if (!signal) return promise;

    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (fn) => (val) => {
            if (settled) return;
            settled = true;
            if (signal) signal.removeEventListener('abort', onAbort);
            fn(val);
        };
        const ok = finish(resolve);
        const fail = finish(reject);

        const onAbort = () => fail(new AgentCallAbortedError(signal.reason === 'timeout' ? 'timeout' : 'cancel'));

        promise.then(ok, fail);
        if (signal) {
            if (signal.aborted) { onAbort(); return; }
            signal.addEventListener('abort', onAbort, { once: true });
        }
    });
}

/** True if an error came from our own abort/timeout (vs a back-end error). */
export function isAbortError(err) {
    return err?.aborted === true || err?.name === 'AgentCallAbortedError';
}

// ----------------------------------------------------------------------
// Error inspection
// ----------------------------------------------------------------------

function getErrorStatusCode(err) {
    return err?.response?.status
        ?? err?.status
        ?? err?.error?.status
        ?? err?.cause?.status
        ?? err?.cause?.response?.status
        ?? null;
}

function isAuthError(err) {
    const code = getErrorStatusCode(err);
    return code === 400 || code === 401 || code === 403;
}

// ----------------------------------------------------------------------
// Response normalization
// ----------------------------------------------------------------------

/**
 * The shape returned by CMRS varies by backend + ST version. Try every
 * known field, return a string (never null/undefined). This is the ONE
 * place this ladder is allowed to exist.
 */
export function extractResponseText(resp) {
    if (resp == null) return '';
    if (typeof resp === 'string') return resp;

    const text = resp.content
        ?? resp.choices?.[0]?.message?.content
        ?? resp.choices?.[0]?.text
        ?? resp.message?.content
        ?? resp.text
        ?? resp.output
        ?? resp.completion
        ?? '';

    return typeof text === 'string' ? text : String(text ?? '');
}

/**
 * Strip reasoning-model CoT from a response using the profile's reasoning
 * template. If anything is missing (template not configured, parser not
 * available, no reasoning detected), pass the text through unchanged.
 *
 * Credit: this is the qvink approach mirrored by Recast — without it,
 * reasoning models pollute structured tracker JSON with their CoT prefix.
 */
function parseReasoning(text, profileId, ctx) {
    if (!text) return text;
    if (typeof ctx.parseReasoningFromString !== 'function') return text;
    if (typeof ctx.getReasoningTemplateByName !== 'function') return text;
    if (!profileId) return text;

    const profile = getConnectionProfiles(ctx).find(p => p.id === profileId);
    if (!profile) return text;

    const templateName = profile['reasoning-template'];
    if (!templateName) return text;

    const template = ctx.getReasoningTemplateByName(templateName);
    if (!template) return text;

    try {
        const parsed = ctx.parseReasoningFromString(text, {}, template);
        if (!parsed?.reasoning) return text; // nothing to strip
        return parsed.content || text;
    } catch (err) {
        debug(`${LOG_PREFIX} parseReasoning failed:`, err);
        return text;
    }
}

// ----------------------------------------------------------------------
// CMRS request (one attempt — used by the cascade)
// ----------------------------------------------------------------------

async function cmrsSendOnce(ctx, profileId, messages, maxTokens, stream, onChunk, signal = null) {
    const CMRS = ctx.ConnectionManagerRequestService;
    // Count the round-trip (cost accounting — gameplan §6). Each call here is
    // one real request, so retries/fallbacks count too: they spend tokens.
    recordCall();
    // includePreset:false is deliberate. Agent calls (sidecar/tracker/rewrite)
    // each send a self-contained system prompt; we do NOT want the profile's
    // bound main preset (jailbreak, card dump, its samplers) stacked on top.
    // It also decouples us from the preset's name — a renamed/bumped main
    // preset no longer triggers CMRS's "Preset '<name>' not found" warning,
    // because we never ask CMRS to load it. Model still comes from the profile.
    const result = await CMRS.sendRequest(profileId, messages, maxTokens, {
        extractData: true,
        includePreset: false,
        includeInstruct: false,
        stream,
        signal,
    });

    // Streaming path: result is a generator factory. Drain it, return final text.
    if (stream && typeof result === 'function') {
        let last = '';
        const gen = result();
        for await (const chunk of gen) {
            // Bail promptly if we've been aborted/timed out mid-stream, instead
            // of awaiting the next chunk that may never come.
            if (signal?.aborted) throw new AgentCallAbortedError(signal.reason === 'timeout' ? 'timeout' : 'cancel');
            if (chunk?.text !== undefined) {
                last = chunk.text;
                if (typeof onChunk === 'function') {
                    try { onChunk(last); } catch (err) { debug(`${LOG_PREFIX} onChunk threw:`, err); }
                }
            }
        }
        return last;
    }

    return result;
}

// ----------------------------------------------------------------------
// Public: callAgentLLM
// ----------------------------------------------------------------------

let legacyTail = Promise.resolve();

async function runLegacyExclusive(work) {
    const previous = legacyTail;
    let release;
    legacyTail = new Promise(resolve => { release = resolve; });
    await previous;
    try {
        return await work();
    } finally {
        release();
    }
}

/**
 * Run one LLM call for an agent. See top-of-file for the resolution cascade.
 *
 * @param {object} opts
 * @param {string} opts.systemPrompt    Required.
 * @param {string} opts.userContent     Required.
 * @param {string} [opts.profileRef]    Connection profile name or ID. Empty inherits
 *                                      the enabled SuperAgents default, then current.
 * @param {number} [opts.maxTokens]     Defaults to 8192.
 * @param {boolean} [opts.includeHistory] If true, prepend `<scene_context>` block.
 * @param {string} [opts.history]       Text to wrap in `<scene_context>` if included.
 * @param {boolean} [opts.stream]       Streaming on/off (CMRS only). Default false.
 * @param {Function|null} [opts.onChunk] Streaming progress callback.
 * @param {string} [opts.callerName]    Used in log lines for traceability.
 * @param {AbortSignal|null} [opts.signal]   External cancel (user stop button).
 * @param {number} [opts.timeoutMs]     Per-call wall-clock ceiling. Defaults to
 *                                      DEFAULT_CALL_TIMEOUT_MS. 0 disables it.
 * @returns {Promise<string>}           A string on success/soft-failure ('').
 * @throws {AgentCallAbortedError}       On timeout or external cancel — callers
 *                                      should catch via isAbortError() and treat
 *                                      it as "stopped", not "empty".
 */
export async function callAgentLLM(options = {}) {
    const controller = new AbortController();
    const externalSignal = options.signal ?? null;
    const timeoutMs = options.timeoutMs === undefined ? DEFAULT_CALL_TIMEOUT_MS : options.timeoutMs;
    const onExternalAbort = () => controller.abort('cancel');
    if (externalSignal?.aborted) throw new AgentCallAbortedError('cancel');
    externalSignal?.addEventListener('abort', onExternalAbort, { once: true });
    const timer = Number.isFinite(timeoutMs) && timeoutMs > 0
        ? setTimeout(() => controller.abort('timeout'), timeoutMs)
        : null;
    try {
        return await callAgentLLMCore({ ...options, signal: controller.signal });
    } finally {
        if (timer) clearTimeout(timer);
        externalSignal?.removeEventListener('abort', onExternalAbort);
    }
}

async function callAgentLLMCore({
    systemPrompt,
    userContent,
    profileRef = '',
    maxTokens = 8192,
    includeHistory = false,
    history = '',
    stream = false,
    onChunk = null,
    callerName = 'agent',
    signal = null,
} = {}) {
    const ctx = getContext();
    profileRef = getEffectiveConnectionProfile(profileRef);

    if (typeof systemPrompt !== 'string' || typeof userContent !== 'string') {
        console.error(`${LOG_PREFIX} ${callerName}: systemPrompt and userContent must be strings`);
        return '';
    }

    // Already cancelled before we even start? Honor it immediately.
    if (signal?.aborted) throw new AgentCallAbortedError(signal.reason === 'timeout' ? 'timeout' : 'cancel');

    // Inject scene context if asked — keeps the wrapping convention in one place.
    let finalUser = userContent;
    if (includeHistory && history) {
        finalUser = `<scene_context>\n${history}\n</scene_context>\n\n${userContent}`;
    }

    const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: finalUser },
    ];

    // One attempt, wrapped in the call-wide abort race. Abort errors thrown here
    // propagate (see the rethrow guards below) so they are NEVER swallowed into
    // the quiet-prompt fallback — a cancelled/timed-out call must stop, not
    // silently kick off another generation.
    const attempt = (pid, useStream, chunkCb) =>
        withAbort(cmrsSendOnce(ctx, pid, messages, maxTokens, useStream, chunkCb, signal), signal);

    // -------- Path A: CMRS cascade --------
    // Skip CMRS entirely if there's no resolvable target (CMRS off,
    // no profiles, or nothing selected). Path B can still work via
    // generateQuietPrompt using whatever ST has active.
    if (isCMRSAvailable(ctx)) {
        const targetId = resolveTargetProfile(ctx, profileRef);
        const currentId = getCurrentProfileId(ctx);

        if (targetId) {
            // Attempt 1: target profile, streaming as requested
            try {
                const r = await attempt(targetId, stream, onChunk);
                const text = extractResponseText(r);
                return parseReasoning(text, targetId, ctx);
            } catch (err1) {
                if (isAbortError(err1)) throw err1; // cancel/timeout — do not fall through
                // Auth-class error on a targeted profile → retry with current
                // profile (only if it's actually different from the target)
                const canRetryProfile = isAuthError(err1) && currentId && currentId !== targetId;
                if (canRetryProfile) {
                    debug(`${LOG_PREFIX} ${callerName}: CMRS auth error on "${targetId}", retrying with current profile`);
                    try {
                        const r = await attempt(currentId, stream, onChunk);
                        return parseReasoning(extractResponseText(r), currentId, ctx);
                    } catch (err2) {
                        if (isAbortError(err2)) throw err2;
                        if (stream) {
                            try {
                                debug(`${LOG_PREFIX} ${callerName}: CMRS retry failed, trying without streaming`);
                                const r = await attempt(currentId, false, null);
                                return parseReasoning(extractResponseText(r), currentId, ctx);
                            } catch (err3) {
                                if (isAbortError(err3)) throw err3;
                                debug(`${LOG_PREFIX} ${callerName}: CMRS exhausted; falling back to quiet prompt`, err3);
                            }
                        } else {
                            debug(`${LOG_PREFIX} ${callerName}: CMRS exhausted; falling back to quiet prompt`, err2);
                        }
                    }
                } else if (stream) {
                    // Streaming-only failure → retry same profile without streaming
                    try {
                        debug(`${LOG_PREFIX} ${callerName}: CMRS stream failed, retrying without streaming`);
                        const r = await attempt(targetId, false, null);
                        return parseReasoning(extractResponseText(r), targetId, ctx);
                    } catch (err2) {
                        if (isAbortError(err2)) throw err2;
                        debug(`${LOG_PREFIX} ${callerName}: CMRS exhausted; falling back to quiet prompt`, err2);
                    }
                } else {
                    debug(`${LOG_PREFIX} ${callerName}: CMRS request failed; falling back to quiet prompt`, err1);
                }
            }
        } else {
            debug(`${LOG_PREFIX} ${callerName}: no resolvable CMRS profile; using quiet prompt`);
        }
        // intentional fall-through to Path B
    }

    // -------- Path B: legacy profile swap + generateQuietPrompt --------
    // generateQuietPrompt has no AbortSignal. Release the caller on stop, but
    // retain the lock until the underlying request and profile restore finish.
    const legacyTask = runLegacyExclusive(async () => {
        let originalName = null;
        let didSwap = false;
        try {
            if (signal?.aborted) throw new AgentCallAbortedError(signal.reason === 'timeout' ? 'timeout' : 'cancel');
            if (profileRef && resolveProfileId(ctx, profileRef)) {
                const swap = await swapProfileLegacy(ctx, profileRef);
                if (swap.success) {
                    originalName = swap.originalProfileName;
                    didSwap = swap.swapped;
                }
            }
            if (signal?.aborted) throw new AgentCallAbortedError(signal.reason === 'timeout' ? 'timeout' : 'cancel');
            const quietPrompt = `SYSTEM:\n${systemPrompt}\n\nUSER:\n${finalUser}`;
            recordCall();
            const text = await generateQuietPrompt({
                quietPrompt,
                quietName: callerName,
                skipWIAN: true,
                responseLength: maxTokens,
            });
            if (signal?.aborted) throw new AgentCallAbortedError(signal.reason === 'timeout' ? 'timeout' : 'cancel');
            return String(text ?? '');
        } catch (err) {
            if (isAbortError(err)) throw err;
            console.error(`${LOG_PREFIX} ${callerName}: quiet-prompt fallback failed`, err);
            return '';
        } finally {
            if (didSwap && originalName) await restoreProfileLegacy(ctx, originalName);
        }
    });
    return withAbort(legacyTask, signal);
}
