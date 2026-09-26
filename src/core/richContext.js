/**
 * core/richContext.js — the "what the main chat sees" context builder.
 *
 * Agents (sidecar trackers, pre-gen planners like a Director) usually only get
 * a flat dump of the last N messages (see modes/sidecar.js buildHistoryContext).
 * That's fine for a tracker, but a planner that's supposed to "consider the
 * state of the world" is blind to the things that actually shape the scene:
 * the character card, the persona, active World Info / lorebook entries, the
 * running Summary, the Author's Note, and — critically at pre-gen time — the
 * message the user just typed but that ST hasn't committed to chat yet.
 *
 * This module assembles those inputs into labelled `### Section` blocks, the
 * same way the main prompt is composed. It's adapted from the Director
 * extension's generation.js (buildDirectorSystemPrompt / getActiveWorldInfo /
 * getRunningSummary / getAuthorsNote), rewired onto SuperAgents' getContext()
 * and per-agent flag config.
 *
 * Everything here is READ-ONLY: it inspects chat / context and returns a
 * string. No injection, no LLM call, no mutation.
 */

import { chat, extension_prompt_types } from '../../../../../../script.js';
import { getContext } from '../../../../../extensions.js';
import { debug } from './runtime.js';

const LOG_PREFIX = '[SuperAgents/richContext]';

// Strip tracker/engine/director-style blocks out of message text before the
// planner reads history, so it doesn't try to "continue" another agent's tags.
const BLOCK_RE = /<(?:tracker|director|engine)>[\s\S]*?<\/(?:tracker|director|engine)>|\[(?:ENGINE|TRACKER)\][\s\S]*?\[\/(?:ENGINE|TRACKER)\]/gi;

// Cap on how many recent messages are scanned for World Info activation (perf).
const WORLD_INFO_SCAN_CAP = 100;

// Core Author's Note module key in extensionPrompts (authors-note.js MODULE_NAME).
const AUTHORS_NOTE_KEY = '2_floating_prompt';

function cacheMap(cache, key) {
    if (!cache) return null;
    if (!(cache[key] instanceof Map)) cache[key] = new Map();
    return cache[key];
}

/** Collect only the requested recent non-system messages without filtering the whole chat. */
function recentChatMessages(mesNum, count) {
    const out = [];
    const end = Math.min(Number(mesNum), chat.length - 1);
    for (let index = end; index >= 0 && out.length < count; index--) {
        const message = chat[index];
        if (message && !message.is_system) out.push(message);
    }
    return out.reverse();
}

/**
 * The default rich-context flag set. Every flag defaults OFF so an agent only
 * pays for the context it opts into. normalizeRichContext (normalize.js) mirrors
 * this shape.
 * @typedef {object} RichContextFlags
 * @property {boolean} enabled       Master switch. If false, this module is skipped entirely.
 * @property {boolean} character     Include the character card (### Persona description).
 * @property {boolean} persona       Include the {{user}} persona (### Player character).
 * @property {boolean} worldInfo     Include active lorebook entries (### World Info).
 * @property {boolean} summary       Include the running Summarize state (### Summary).
 * @property {boolean} simpleSummarizer Include eligible Simple Summarizer batches and context archives when installed.
 * @property {boolean} authorsNote   Include the active Author's Note (### Author's Note).
 * @property {boolean} pendingUser   Include the user's not-yet-committed message (### Pending user message).
 * @property {number}  historyCount  How many recent messages to include (0 = none; history is rendered by the caller).
 * @property {boolean} selfMemory    Include the agent's OWN recent outputs (### Your recent direction) so a planner can advance rather than restate. Opt-in; requires the caller to supply the collected memory (see buildRichContext's selfMemoryItems), since collecting it needs the agent's varName + chat walk which live outside this module.
 * @property {number}  selfMemoryCount  How many recent self-outputs to include (0 = none). The caller reads this to size its collection; this module only formats what it's handed.
 */

/** substituteParams wrapper that strips stray carriage returns and never throws. */
function sub(ctx, value) {
    const s = String(value ?? '').replace(/\r/g, '');
    try {
        return typeof ctx.substituteParams === 'function' ? String(ctx.substituteParams(s)) : s;
    } catch {
        return s;
    }
}

// ============================================================================
// PENDING USER MESSAGE
// ============================================================================

/**
 * Read the user's pending message — still sitting in the textarea at
 * GENERATION_AFTER_COMMANDS time, because ST only adds it to chat afterwards.
 * Read-only; we never clear it. Returns '' for automatic/non-user triggers.
 *
 * @param {object} [options] generation options from the event (automatic_trigger).
 * @returns {string}
 */
export function readPendingUserMessage(options) {
    if (options?.automatic_trigger) return '';
    try {
        const ta = document.getElementById('send_textarea');
        return ta ? String(ta.value || '').trim() : '';
    } catch {
        return '';
    }
}

// ============================================================================
// CHARACTER CARD / PERSONA
// ============================================================================

/** The active character card, flattened (description + personality + scenario). */
function getCharacterCard(ctx) {
    try {
        const char = ctx.characters && ctx.characterId != null ? ctx.characters[ctx.characterId] : null;
        if (!char) return '';
        return sub(ctx, [char.description, char.personality, char.scenario]
            .map(p => String(p ?? '').trim())
            .filter(Boolean)
            .join('\n')).trim();
    } catch (e) {
        debug(`${LOG_PREFIX} character card read failed:`, e?.message);
        return '';
    }
}

/** The {{user}} persona name + description, via getCharacterCardFields(). */
function getPersona(ctx) {
    try {
        const userName = sub(ctx, '{{user}}').trim() || 'User';
        const fields = ctx.getCharacterCardFields?.();
        const persona = sub(ctx, fields?.persona ?? '').trim();
        return { userName, persona };
    } catch (e) {
        debug(`${LOG_PREFIX} persona read failed:`, e?.message);
        return { userName: 'User', persona: '' };
    }
}

// ============================================================================
// AUTHOR'S NOTE
// ============================================================================

/**
 * Read the live Author's Note from core's extension-prompt entry, or null.
 * Core's setFloatingPrompt() keeps this current and already resolves the
 * character-note merge + insertion-interval gating (value is "" on off-interval
 * turns), so we just read and substitute macros.
 *
 * @param {object} ctx
 * @returns {{text:string, position:number, depth:number, role:string}|null}
 */
function getAuthorsNote(ctx) {
    try {
        const entry = ctx.extensionPrompts?.[AUTHORS_NOTE_KEY];
        const raw = String(entry?.value ?? '').trim();
        if (!raw) return null;
        const text = sub(ctx, raw).trim();
        if (!text) return null;
        const roleNames = { 0: 'system', 1: 'user', 2: 'assistant' };
        return {
            text,
            position: Number(entry.position ?? extension_prompt_types.IN_CHAT),
            depth: Math.max(0, Number(entry.depth) || 0),
            role: roleNames[Number(entry.role)] || 'system',
        };
    } catch (e) {
        debug(`${LOG_PREFIX} author's note read failed:`, e?.message);
        return null;
    }
}

// ============================================================================
// RUNNING SUMMARY
// ============================================================================

/**
 * The running story summary at the given context point, or '' if none.
 * Supports the built-in Summarize plain-string format and Tech-Summarize's
 * {characters, body, lore} object. Scans backward through chat first (tied to
 * the exact context point), then falls back to the live extension-prompt value.
 *
 * @param {object} ctx
 * @param {number} mesNum
 * @returns {string}
 */
function getRunningSummary(ctx, mesNum, cache = null) {
    const extract = (mem) => {
        if (!mem) return '';
        if (typeof mem === 'string') return mem.trim();
        if (typeof mem === 'object') {
            return ['characters', 'body', 'lore']
                .map(k => String(mem[k] ?? '').trim())
                .filter(Boolean)
                .join('\n\n');
        }
        return '';
    };
    const summaries = cacheMap(cache, 'summaries');
    const key = Math.min(Number(mesNum), chat.length - 1);
    if (summaries?.has(key)) return summaries.get(key);
    try {
        const end = Math.min(Number(mesNum), chat.length - 1);
        for (let i = end; i >= 0; i--) {
            const text = extract(chat[i]?.extra?.memory);
            if (text) {
                summaries?.set(key, text);
                return text;
            }
        }
        for (const key of ['tech_summarize', '1_memory']) {
            const live = ctx.extensionPrompts?.[key]?.value;
            if (live && String(live).trim()) {
                const text = String(live).trim();
                summaries?.set(Math.min(Number(mesNum), chat.length - 1), text);
                return text;
            }
        }
    } catch (e) {
        debug(`${LOG_PREFIX} summary read failed:`, e?.message);
    }
    summaries?.set(key, '');
    return '';
}

/** Optional prompt-safe memory exposed by Simple Summarizer's public API/macros. */
async function getSimpleSummarizerMemory(ctx, cache = null) {
    if (cache?.simpleSummarizerPromise) return cache.simpleSummarizerPromise;
    const build = async () => {
        try {
            const api = globalThis.Summarizer;
            if (!api?.isInstalled || api.isEnabled?.() === false) return '';

            const batchText = sub(ctx, '{{batch_summaries}}').trim();
            const batches = batchText === '{{batch_summaries}}' ? '' : batchText;
            let archives = '';
            if (api.contextArchives?.isEnabled?.() !== false
                && typeof api.contextArchives?.buildContent === 'function') {
                archives = String(await api.contextArchives.buildContent() || '').trim();
            }
            return [batches, archives].filter(Boolean).join('\n\n');
        } catch (e) {
            debug(`${LOG_PREFIX} Simple Summarizer memory read failed:`, e?.message);
            return '';
        }
    };
    const promise = build();
    if (cache) cache.simpleSummarizerPromise = promise;
    return promise;
}

// ============================================================================
// WORLD INFO / LOREBOOK
// ============================================================================

/**
 * Scan recent chat for active World Info entries (dry run — emits no events)
 * so the agent sees the same lore the roleplay does. Returns '' if unavailable.
 *
 * @param {object} ctx
 * @param {number} mesNum
 * @param {number} maxContext  token budget hint for WI activation
 * @returns {Promise<string>}
 */
async function getActiveWorldInfo(ctx, mesNum, maxContext, scanText = '', cache = null) {
    try {
        if (typeof ctx.getWorldInfoPrompt !== 'function') return '';
        const messageCache = cacheMap(cache, 'worldInfoMessages');
        const key = Math.min(Number(mesNum), chat.length - 1);
        let baseMessages = messageCache?.get(key);
        if (!baseMessages) {
            baseMessages = recentChatMessages(mesNum, WORLD_INFO_SCAN_CAP)
                .map(c => `${c.name}: ${String(c.mes || '').replace(BLOCK_RE, '').trim()}`);
            messageCache?.set(key, baseMessages);
        }
        const messages = [...baseMessages];
        const probe = String(scanText || '').replace(/\s+/g, ' ').trim();
        if (probe) messages.push(`Private author utility probe: ${probe}`);
        if (messages.length === 0) return '';
        const chatForWI = messages.slice().reverse(); // getWorldInfoPrompt expects most-recent-first
        const budget = Number(maxContext) || Number(ctx.maxContext) || 8192;
        const { worldInfoString } = await ctx.getWorldInfoPrompt(chatForWI, budget, true);
        return String(worldInfoString || '').trim();
    } catch (e) {
        debug(`${LOG_PREFIX} world info read failed:`, e?.message);
        return '';
    }
}

// ============================================================================
// HISTORY
// ============================================================================

/**
 * Recent chat history as labelled lines, newest-last, with agent/tracker
 * blocks stripped and a context cap applied. This is the ONE history builder
 * in SuperAgents — modes/sidecar.js buildHistoryContext delegates here so the
 * stripping + capping logic lives in a single place (audit fix #10).
 *
 * @param {object} ctx
 * @param {number} mesNum    highest message index to include (inclusive)
 * @param {number} count     how many recent messages
 * @param {object} [opts]
 * @param {'bracket'|'plain'} [opts.speakerStyle='plain']
 *        'plain'   → `Name: text`        (rich-context section style)
 *        'bracket' → `[Name]: text`      (sidecar/<chat_history> style)
 * @returns {string}
 */
export function buildHistoryLines(ctx, mesNum, count, opts = {}) {
    if (!count || count <= 0) return '';
    const bracket = opts.speakerStyle === 'bracket';
    const historyCache = cacheMap(opts.cache, 'history');
    const cacheKey = `${Math.min(Number(mesNum), chat.length - 1)}|${count}|${bracket ? 'b' : 'p'}`;
    if (historyCache?.has(cacheKey)) return historyCache.get(cacheKey);
    const label = (c) => {
        // Use the message's real author name for user turns too, not a flattened
        // {{user}}: a chat may alternate player personas, and trackers (esp. the
        // persona-scoped Relationship Ledger) must see WHICH persona spoke to
        // attribute updates correctly. Single-persona chats are unaffected (the
        // name equals {{user}}). Falls back to the {{user}} macro if unnamed.
        const name = c.is_user ? (c.name || '{{user}}') : (c.name || 'Assistant');
        return bracket ? `[${name}]` : name;
    };
    const slice = recentChatMessages(mesNum, count)
        .map(c => `${label(c)}: ${String(c.mes || '').replace(BLOCK_RE, '').trim()}`)
        .filter(line => line.split(': ').slice(1).join(': ').trim());
    const result = sub(ctx, slice.join('\n\n')).trim();
    historyCache?.set(cacheKey, result);
    return result;
}

/**
 * Internal rich-context history (plain `Name: text` section style).
 * @param {object} ctx
 * @param {number} mesNum
 * @param {number} count
 * @returns {string}
 */
function getHistory(ctx, mesNum, count, cache = null) {
    return buildHistoryLines(ctx, mesNum, count, { speakerStyle: 'plain', cache });
}

// ============================================================================
// SELF-MEMORY (agent's own recent outputs)
// ============================================================================

/**
 * Format the agent's own recent outputs into a labelled "### Your recent
 * output" block that reads to the LLM as "here's what you already produced —
 * stay consistent with it." Wording is role-neutral so it suits planners and
 * continuity trackers alike. The items come from the caller (buildAgentRichContext
 * in sidecar.js), which collects them via mergeVariable.collectRecentStates for
 * the agent's own variable; this module only shapes what it's handed so it needs
 * no chat-walk imports (and thus no new edge toward lifecycle.js).
 *
 * IMPORTANT: these plans come from the saAgentSwipes snapshot store, NOT from
 * raw message text, so BLOCK_RE (which only strips history message text) never
 * touches them.
 *
 * @param {object} ctx
 * @param {object[][]} memoryItems  newest-first list of stored item-arrays, each
 *        a snapshot from one message's active swipe (collectRecentStates output).
 * @param {string} [formatItem='{{plan}}']  the agent's mergeVariable.formatItem.
 * @param {string[]} [fieldNames=['plan']]  the agent's mergeVariable.fieldNames.
 * @returns {string}  the formatted section, or '' if nothing to show.
 */
function buildSelfMemorySection(ctx, memoryItems, formatItem = '{{plan}}', fieldNames = ['plan']) {
    if (!Array.isArray(memoryItems) || memoryItems.length === 0) return '';

    // Each stored entry is an array of items (snapshot mode = usually one item
    // per turn). Render each entry's items with the agent's own formatItem, the
    // same substitution formatMergeVariableData uses, so the memory reads in the
    // agent's native shape.
    const renderEntry = (items) => {
        if (!Array.isArray(items)) return '';
        return items.map(item => {
            let line = formatItem;
            for (const field of fieldNames) {
                const val = item?.[field] ?? '';
                const display = Array.isArray(val) ? val.join(', ') : String(val);
                line = line.replaceAll(`{{${field}}}`, display);
            }
            return line.trim();
        }).filter(Boolean).join(' ');
    };

    const lines = memoryItems.map(renderEntry).filter(Boolean).map(l => `- ${l}`);
    if (lines.length === 0) return '';

    // Role-neutral framing: this block suits both planners (which should build
    // forward off prior direction) and trackers (which should stay consistent
    // with prior state). Deliberately avoids commanding "advance / do not
    // repeat" — that only fits planners and works against continuity agents.
    const header = 'Your own output from recent turns (most recent first), '
        + 'for continuity. Take it into account and stay consistent with it.';
    return sub(ctx, `### Your recent output\n${header}\n${lines.join('\n')}`).trim();
}

// ============================================================================
// PUBLIC: buildRichContext
// ============================================================================

/**
 * Assemble the requested context blocks into a single string, in main-prompt
 * order: Author's Note (before) → character → persona → Author's Note (after)
 * → World Info → Summary → History → Pending user message.
 *
 * Pass only the flags you want; everything defaults off. `pendingUserText` is
 * supplied by the caller (read at GENERATION_AFTER_COMMANDS via
 * readPendingUserMessage) since it isn't in `chat` yet.
 *
 * @param {object} opts
 * @param {number} opts.mesNum                 context point (highest msg index to read).
 * @param {RichContextFlags} opts.flags        which sections to include.
 * @param {string} [opts.pendingUserText='']   the not-yet-committed user message.
 * @param {number} [opts.maxContext=8192]      token budget hint for WI activation.
 * @param {string} [opts.worldInfoScanText=''] private extra terms used only for the dry-run lore scan.
 * @param {object[][]} [opts.selfMemoryItems]  the agent's own recent outputs
 *        (collectRecentStates output), supplied by the caller when flags.selfMemory
 *        is on. Kept as a caller-supplied input so this module needs no chat-walk
 *        imports. Ignored unless flags.selfMemory is true.
 * @param {string} [opts.selfMemoryFormatItem]  agent mergeVariable.formatItem.
 * @param {string[]} [opts.selfMemoryFieldNames]  agent mergeVariable.fieldNames.
 * @param {object} [opts.contextCache]         generation-local shared read cache.
 * @returns {Promise<string>}                  the composed context (may be '').
 */
export async function buildRichContext({ mesNum, flags, pendingUserText = '', maxContext = 8192, worldInfoScanText = '', selfMemoryItems = [], selfMemoryFormatItem, selfMemoryFieldNames, contextCache = null }) {
    if (!flags?.enabled) return '';
    const ctx = getContext();
    const sections = [];

    const authorsNote = flags.authorsNote ? getAuthorsNote(ctx) : null;

    // Author's Note — "before scenario" placement goes first.
    if (authorsNote && authorsNote.position === extension_prompt_types.BEFORE_PROMPT) {
        sections.push(`### Author's Note\n${authorsNote.text}`);
    }

    if (flags.character) {
        const card = getCharacterCard(ctx);
        if (card) sections.push(`### Persona description\n${card}`);
    }

    if (flags.persona) {
        const { userName, persona } = getPersona(ctx);
        sections.push(`### Player character: ${userName}${persona ? `\n${persona}` : ''}`);
    }

    // Author's Note — "after scenario" / in-prompt placement.
    if (authorsNote && authorsNote.position === extension_prompt_types.IN_PROMPT) {
        sections.push(`### Author's Note\n${authorsNote.text}`);
    }

    if (flags.worldInfo) {
        const wi = await getActiveWorldInfo(ctx, mesNum, maxContext, worldInfoScanText, contextCache);
        if (wi) sections.push(`### World Info\n${wi}`);
    }

    if (flags.summary) {
        const summary = getRunningSummary(ctx, mesNum, contextCache);
        if (summary) sections.push(`### Summary\n${summary}`);
    }

    if (flags.simpleSummarizer) {
        const memory = await getSimpleSummarizerMemory(ctx, contextCache);
        if (memory) sections.push(`### Simple Summarizer memory\n${memory}`);
    }

    // In-chat Author's Note has no clean "depth" home in a flat string; fold it
    // in right before history so the planner still sees it.
    if (authorsNote && authorsNote.position === extension_prompt_types.IN_CHAT) {
        sections.push(`### Author's Note\n${authorsNote.text}`);
    }

    if (flags.historyCount > 0) {
        const history = getHistory(ctx, mesNum, flags.historyCount, contextCache);
        if (history) sections.push(`### Recent history\n${history}`);
    }

    // Self-memory — the agent's own recent outputs, so it stays consistent with
    // what it produced before (planners build forward, trackers hold continuity).
    // Its own section, placed after history. The items are collected by the
    // caller (needs the agent's varName + chat walk); this module only formats them.
    if (flags.selfMemory) {
        const memBlock = buildSelfMemorySection(ctx, selfMemoryItems, selfMemoryFormatItem, selfMemoryFieldNames);
        if (memBlock) sections.push(memBlock);
    }

    if (flags.pendingUser && pendingUserText.trim()) {
        sections.push(`### Pending user message\n${sub(ctx, pendingUserText).trim()}`);
    }

    const out = sections.join('\n\n').trim();
    debug(`${LOG_PREFIX} built rich context: ${sections.length} section(s), ${out.length} chars`);
    return out;
}
