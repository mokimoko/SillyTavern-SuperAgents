/**
 * render/regexProcessor.js — structured tag extraction → saAgentData.
 *
 * For agents that emit structured tags inline in message.mes (e.g. [WORLD|...],
 * [SCENE|...]), this module:
 *   1. Matches the agent's regexScripts against message.mes
 *   2. Stores extracted data + rendered HTML in message.extra.saAgentData
 *   3. Strips matched tags from message.mes (clean prompt context) unless the
 *      script sets stripFromMes: false (blocks the LLM references across turns)
 *
 * Display is handled by renderer.js, which reads saAgentData and injects the
 * styled HTML into the message DOM. Sidecar agents bypass this module — they
 * build saAgentData directly in modes/sidecar.js — but share the same data
 * shape, so the renderer treats both identically.
 *
 * Ported from VM's regexProcessor.js. Namespace updated vm→sa; logic verbatim.
 */

import { debug } from '../core/runtime.js';

const LOG_PREFIX = '[SuperAgents/regex]';

// --- Regex safety caps (gameplan problem #5) --------------------------------
// User/LLM-authored patterns are untrusted once agent packs become shareable.
// Match in a worker so a stalled exec() can be terminated. If workers are
// unavailable, only a conservative pattern subset runs on the main thread.
const MAX_PATTERN_LENGTH = 2000;    // chars; reject longer patterns outright
const MAX_INPUT_LENGTH = 200000;    // chars of message text scanned per script
const MAX_FALLBACK_INPUT_LENGTH = 4096;
const MAX_MATCHES = 5000;           // hard ceiling on matches per script
const MATCH_TIME_BUDGET_MS = 250;   // wall-clock budget across the match loop
const MATCH_WORKER_DEADLINE_MS = 600;

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

// ============================================================================
// REGEX SCRIPT NORMALIZATION
// ============================================================================

/**
 * Normalize a raw regex script object, filling defaults.
 * Compatible with SillyBunny's RegexScriptData shape, plus our extensions.
 * @param {object} raw
 * @returns {object}
 */
export function normalizeRegexScript(raw = {}) {
    const placement = Array.isArray(raw.placement)
        ? raw.placement.map(Number).filter(v => [0, 1, 2, 3, 5, 6].includes(v))
        : [2]; // default: AI_OUTPUT

    return {
        id: typeof raw.id === 'string' && raw.id.trim()
            ? raw.id
            : (crypto.randomUUID?.() ?? `rs-${Date.now()}`),
        scriptName: typeof raw.scriptName === 'string' ? raw.scriptName.trim() : '',
        findRegex: typeof raw.findRegex === 'string' ? raw.findRegex : '',
        replaceString: typeof raw.replaceString === 'string' ? raw.replaceString : '',
        trimStrings: Array.isArray(raw.trimStrings)
            ? raw.trimStrings.map(s => String(s ?? '')).filter(Boolean)
            : [],
        placement: placement.length > 0 ? [...new Set(placement)] : [2],
        disabled: Boolean(raw.disabled),
        markdownOnly: raw.markdownOnly !== undefined ? Boolean(raw.markdownOnly) : true,
        promptOnly: Boolean(raw.promptOnly),
        runOnEdit: raw.runOnEdit !== undefined ? Boolean(raw.runOnEdit) : true,
        substituteRegex: Number.isFinite(Number(raw.substituteRegex))
            ? Number(raw.substituteRegex)
            : 0,
        minDepth: normalizeDepth(raw.minDepth),
        maxDepth: normalizeDepth(raw.maxDepth),
        // VM extension: when false, extracted data is stored and rendered
        // but the raw tags remain in message.mes for LLM context across turns.
        stripFromMes: raw.stripFromMes !== undefined ? Boolean(raw.stripFromMes) : true,
        // VM extension: where to inject rendered HTML in the message DOM.
        // 'top' = before narrative (default), 'bottom' = after narrative.
        renderPlacement: raw.renderPlacement === 'bottom' ? 'bottom' : 'top',
    };
}

function normalizeDepth(value) {
    if (value === '' || value === null || value === undefined) return null;
    const depth = Number(value);
    return Number.isFinite(depth) && depth >= -1 ? depth : null;
}

// ============================================================================
// CORE PROCESSING
// ============================================================================

/**
 * Process an agent's regexScripts against a message. Extracts matched data,
 * stores in message.extra.saAgentData, and optionally strips tags from mes
 * (controlled by stripFromMes flag).
 *
 * @param {object} agent - Agent definition with regexScripts[]
 * @param {object} message - The chat message object (chat[n])
 * @param {number} messageIndex - Index in chat array
 * @returns {Promise<{ changed: boolean, extractionCount: number }>}
 */
export async function processAgentRegex(agent, message, messageIndex) {
    const scripts = agent.regexScripts;
    if (!Array.isArray(scripts) || scripts.length === 0) {
        return { changed: false, extractionCount: 0 };
    }

    let mesChanged = false;
    let totalExtractions = 0;
    const scriptResults = [];

    for (const rawScript of scripts) {
        const script = normalizeRegexScript(rawScript);

        // Skip disabled or empty scripts
        if (script.disabled || !script.findRegex) continue;

        // Only process AI_OUTPUT (2) placement scripts during post-gen
        if (!script.placement.includes(2)) continue;

        // Display extraction only — skip prompt-only scripts
        if (script.promptOnly) continue;

        try {
            const regex = buildRegex(script.findRegex);
            if (!regex) continue;

            const textAtStart = message.mes;
            const matches = await collectMatchesBounded(regex, textAtStart);
            if (message.mes !== textAtStart) continue;
            if (matches.length === 0) continue;

            const extractions = matches.map(m => ({
                raw: m.fullMatch,
                groups: m.groups,
                rendered: script.replaceString
                    ? applyReplacement(script.replaceString, m.allGroups)
                    : '',
                placement: script.renderPlacement || 'top',
            }));

            // Strip matched tags from message.mes unless stripFromMes is false.
            if (script.stripFromMes !== false) {
                let mes = message.mes;
                for (let i = matches.length - 1; i >= 0; i--) {
                    const m = matches[i];
                    mes = mes.substring(0, m.index) + mes.substring(m.index + m.fullMatch.length);
                }
                mes = mes.replace(/\n{3,}/g, '\n\n').trim();
                if (mes !== message.mes) {
                    message.mes = mes;
                    mesChanged = true;
                }
            }

            scriptResults.push({
                scriptId: script.id,
                scriptName: script.scriptName,
                extractions,
            });
            totalExtractions += extractions.length;

            debug(`${LOG_PREFIX} "${agent.name}" script "${script.scriptName}": ${extractions.length} extraction(s)${script.stripFromMes === false ? ' (kept in mes)' : ''}`);
        } catch (err) {
            debug(`${LOG_PREFIX} Error in script "${script.scriptName}" for agent "${agent.name}":`, err);
        }
    }

    if (scriptResults.length > 0) {
        message.extra ??= {};
        message.extra.saAgentData ??= {};
        message.extra.saAgentData[agent.id] = {
            agentId: agent.id,
            agentName: agent.name,
            scripts: scriptResults,
            timestamp: new Date().toISOString(),
            _swipeId: message.swipe_id ?? 0,
        };
        mesChanged = true;
    }

    return { changed: mesChanged, extractionCount: totalExtractions };
}

const matchQueue = [];
let matchWorker = null;
let activeMatch = null;
let workerUnavailable = false;

function finishActiveMatch(matches) {
    const job = activeMatch;
    if (!job) return;
    clearTimeout(job.timer);
    activeMatch = null;
    job.resolve(matches);
    pumpMatchQueue();
}

function resetMatchWorker() {
    matchWorker?.terminate();
    matchWorker = null;
}

function pumpMatchQueue() {
    if (activeMatch || matchQueue.length === 0) return;
    if (workerUnavailable) {
        for (const job of matchQueue.splice(0)) {
            job.resolve(isSafeRegexPattern(job.regex.source)
                ? collectMatches(job.regex, job.text.slice(0, MAX_FALLBACK_INPUT_LENGTH))
                : []);
        }
        return;
    }
    if (!matchWorker) {
        try {
            matchWorker = new Worker(new URL('./regexMatchWorker.js', import.meta.url), { type: 'module' });
            const currentWorker = matchWorker;
            currentWorker.onmessage = event => {
                if (matchWorker === currentWorker) finishActiveMatch(event.data?.matches || []);
            };
            currentWorker.onerror = () => {
                if (matchWorker !== currentWorker) return;
                workerUnavailable = true;
                resetMatchWorker();
                finishActiveMatch([]);
            };
        } catch (error) {
            workerUnavailable = true;
            console.warn(`${LOG_PREFIX} regex worker unavailable; using restricted main-thread matcher`, error);
            pumpMatchQueue();
            return;
        }
    }
    const job = matchQueue.shift();
    activeMatch = job;
    job.timer = setTimeout(() => {
        console.warn(`${LOG_PREFIX} regex match exceeded ${MATCH_WORKER_DEADLINE_MS}ms; skipping script`);
        resetMatchWorker();
        finishActiveMatch([]);
    }, MATCH_WORKER_DEADLINE_MS);
    try {
        matchWorker.postMessage({ source: job.regex.source, flags: job.regex.flags, text: job.text });
    } catch (error) {
        console.warn(`${LOG_PREFIX} regex worker request failed:`, error);
        resetMatchWorker();
        finishActiveMatch([]);
    }
}

function collectMatchesBounded(regex, text) {
    const canUseWorker = typeof Worker === 'function' && !workerUnavailable;
    const input = String(text ?? '').slice(0,
        canUseWorker ? MAX_INPUT_LENGTH : MAX_FALLBACK_INPUT_LENGTH);
    if (!canUseWorker) {
        if (!isSafeRegexPattern(regex.source)) {
            console.warn(`${LOG_PREFIX} skipped expensive regex without worker support: ${regex.source}`);
            return Promise.resolve([]);
        }
        return Promise.resolve(collectMatches(regex, input));
    }
    return new Promise(resolve => {
        matchQueue.push({ regex, text: input, resolve, timer: null });
        pumpMatchQueue();
    });
}

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Build a RegExp from a regex string. Supports /pattern/flags and plain
 * string (auto-global).
 * @param {string} regexStr
 * @returns {RegExp|null}
 */
function buildRegex(regexStr) {
    if (typeof regexStr !== 'string' || !regexStr) return null;

    // Length cap (gameplan problem #5): reject absurdly long patterns before
    // they ever reach the engine. Shareable agent packs are untrusted input.
    if (regexStr.length > MAX_PATTERN_LENGTH) {
        debug(`${LOG_PREFIX} regex rejected: pattern length ${regexStr.length} exceeds ${MAX_PATTERN_LENGTH}`);
        return null;
    }

    try {
        const slashMatch = regexStr.match(/^\/(.+)\/([gimsuy]*)$/s);
        const pattern = slashMatch ? slashMatch[1] : regexStr;
        const flags = slashMatch ? slashMatch[2] : 'g';

        return new RegExp(pattern, flags);
    } catch (err) {
        debug(`${LOG_PREFIX} Invalid regex: "${regexStr}"`, err);
        return null;
    }
}

export function isSafeRegexPattern(pattern) {
    let repetitions = 0;
    let inClass = false;
    let lastGroupHadAlternation = false;
    const groups = [];
    for (let i = 0; i < pattern.length; i++) {
        const char = pattern[i];
        if (char === '\\') {
            if (/[1-9]/.test(pattern[i + 1] || '')) return false;
            i++;
            lastGroupHadAlternation = false;
            continue;
        }
        if (inClass) {
            if (char === ']') inClass = false;
            continue;
        }
        if (char === '[') {
            inClass = true;
            lastGroupHadAlternation = false;
            continue;
        }
        if (char === '(') {
            if (pattern.startsWith('(?=', i) || pattern.startsWith('(?!', i)
                || pattern.startsWith('(?<=', i) || pattern.startsWith('(?<!', i)) return false;
            groups.push({ alternation: false });
            if (pattern.startsWith('(?:', i)) i += 2;
            lastGroupHadAlternation = false;
            continue;
        }
        if (char === ')') {
            lastGroupHadAlternation = groups.pop()?.alternation ?? false;
            continue;
        }
        if (char === '|') {
            if (groups.length) groups.at(-1).alternation = true;
            lastGroupHadAlternation = false;
            continue;
        }
        const bounded = char === '{' ? /^\{(\d+)(?:,(\d*))?\}/.exec(pattern.slice(i)) : null;
        const lazySuffix = char === '?' && /[+*}]/.test(pattern[i - 1] || '');
        if (char === '*' || char === '+' || (char === '?' && !lazySuffix) || bounded) {
            if (++repetitions > 1 || lastGroupHadAlternation) return false;
            if (bounded) {
                const upper = Number(bounded[2] || bounded[1]);
                if (upper > 1000) return false;
                i += bounded[0].length - 1;
            }
            lastGroupHadAlternation = false;
            continue;
        }
        lastGroupHadAlternation = false;
    }
    return true;
}

/**
 * Collect all regex matches with their indices and capture groups.
 * @param {RegExp} regex
 * @param {string} text
 * @returns {Array<{ fullMatch: string, groups: string[], allGroups: string[], index: number }>}
 */
function collectMatches(regex, text) {
    const matches = [];
    let match;

    // Bound the input fed to the engine — a multi-MB message shouldn't be
    // scanned by an untrusted pattern (gameplan problem #5).
    let haystack = text;
    if (text.length > MAX_INPUT_LENGTH) {
        debug(`${LOG_PREFIX} input truncated to ${MAX_INPUT_LENGTH} chars for matching (was ${text.length})`);
        haystack = text.slice(0, MAX_INPUT_LENGTH);
    }

    if (regex.global || regex.sticky) regex.lastIndex = 0;

    const deadline = now() + MATCH_TIME_BUDGET_MS;

    while ((match = regex.exec(haystack)) !== null) {
        matches.push({
            fullMatch: match[0],
            groups: Array.from(match).slice(1),
            allGroups: Array.from(match),
            index: match.index,
        });

        // Hard ceiling on match count (pathological global match explosion).
        if (matches.length >= MAX_MATCHES) {
            debug(`${LOG_PREFIX} match cap (${MAX_MATCHES}) hit; stopping`);
            break;
        }

        // Wall-clock budget across the loop. Catches a global pattern that
        // keeps finding matches slowly. Cannot interrupt a single catastrophic
        // exec() (JS regex is synchronous); the fallback accepts restricted patterns.
        if (now() > deadline) {
            debug(`${LOG_PREFIX} match time budget (${MATCH_TIME_BUDGET_MS}ms) exceeded; stopping after ${matches.length} match(es)`);
            break;
        }

        if (match[0].length === 0) regex.lastIndex++;
        if (!regex.global) break;
    }

    return matches;
}

/**
 * HTML-escape a string for safe interpolation into innerHTML. Applied to
 * capture-group values (untrusted LLM output) before they're substituted into
 * a replaceString template — the template itself is author-controlled markup
 * (e.g. `<div class="...">$1</div>`) and is intentionally NOT escaped, but the
 * captured `$1` text is, so a `<`/`>`/`"`/`&` in the model's output can't break
 * the container or inject markup once renderer.js drops it into the DOM.
 * @param {string} s
 * @returns {string}
 */
function escapeHtml(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * Apply capture group substitution to a replacement template.
 * Supports $0..$N and {{match}} syntax. Capture-group values are HTML-escaped
 * (the rendered result is injected via innerHTML downstream); the template
 * markup around them is left intact.
 * @param {string} replaceString
 * @param {string[]} allGroups - Index 0 = full match, 1+ = capture groups
 * @returns {string}
 */
function applyReplacement(replaceString, allGroups) {
    let result = replaceString.replace(/\{\{match\}\}/gi, '$0');
    result = result.replace(/\$(\d+)/g, (_, num) => {
        const idx = parseInt(num, 10);
        return idx < allGroups.length ? escapeHtml(allGroups[idx] ?? '') : '';
    });
    return result;
}

// ============================================================================
// DATA ACCESS HELPERS
// ============================================================================

/** @param {object} message @returns {boolean} */
export function hasAgentData(message) {
    return !!(message?.extra?.saAgentData && Object.keys(message.extra.saAgentData).length > 0);
}

/** @param {object} message @returns {object} Map of agentId → extraction data */
export function getAgentData(message) {
    return message?.extra?.saAgentData ?? {};
}

/** @param {object} message @param {string} agentId @returns {object|null} */
export function getAgentDataById(message, agentId) {
    return message?.extra?.saAgentData?.[agentId] ?? null;
}

/**
 * Clear agent data for a specific agent from a message.
 * Used during re-runs (idempotency) to reset before re-extracting.
 * @param {object} message @param {string} agentId
 */
export function clearAgentData(message, agentId) {
    if (message?.extra?.saAgentData?.[agentId]) {
        delete message.extra.saAgentData[agentId];
        if (Object.keys(message.extra.saAgentData).length === 0) {
            delete message.extra.saAgentData;
        }
        return true;
    }
    return false;
}
