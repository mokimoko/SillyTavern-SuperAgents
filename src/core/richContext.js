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
import { debug } from '../../index.js';

const LOG_PREFIX = '[SuperAgents/richContext]';

// Strip tracker/engine/director-style blocks out of message text before the
// planner reads history, so it doesn't try to "continue" another agent's tags.
const BLOCK_RE = /<(?:tracker|director|engine)>[\s\S]*?<\/(?:tracker|director|engine)>|\[(?:ENGINE|TRACKER)\][\s\S]*?\[\/(?:ENGINE|TRACKER)\]/gi;

// Cap on how many recent messages are scanned for World Info activation (perf).
const WORLD_INFO_SCAN_CAP = 100;

// Core Author's Note module key in extensionPrompts (authors-note.js MODULE_NAME).
const AUTHORS_NOTE_KEY = '2_floating_prompt';

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
 * @property {boolean} authorsNote   Include the active Author's Note (### Author's Note).
 * @property {boolean} pendingUser   Include the user's not-yet-committed message (### Pending user message).
 * @property {number}  historyCount  How many recent messages to include (0 = none; history is rendered by the caller).
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
function getRunningSummary(ctx, mesNum) {
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
    try {
        const end = Math.min(Number(mesNum), chat.length - 1);
        for (let i = end; i >= 0; i--) {
            const text = extract(chat[i]?.extra?.memory);
            if (text) return text;
        }
        for (const key of ['tech_summarize', '1_memory']) {
            const live = ctx.extensionPrompts?.[key]?.value;
            if (live && String(live).trim()) return String(live).trim();
        }
    } catch (e) {
        debug(`${LOG_PREFIX} summary read failed:`, e?.message);
    }
    return '';
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
async function getActiveWorldInfo(ctx, mesNum, maxContext) {
    try {
        if (typeof ctx.getWorldInfoPrompt !== 'function') return '';
        const messages = chat
            .filter((c, index) => !c.is_system && index <= mesNum)
            .slice(-WORLD_INFO_SCAN_CAP)
            .map(c => `${c.name}: ${String(c.mes || '').replace(BLOCK_RE, '').trim()}`);
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
    const end = Math.min(Number(mesNum) + 1, chat.length);
    const label = (c) => {
        const name = c.is_user ? '{{user}}' : (c.name || 'Assistant');
        return bracket ? `[${name}]` : name;
    };
    const slice = chat
        .filter((c, index) => !c.is_system && index < end)
        .slice(-count)
        .map(c => `${label(c)}: ${String(c.mes || '').replace(BLOCK_RE, '').trim()}`)
        .filter(line => line.split(': ').slice(1).join(': ').trim());
    return sub(ctx, slice.join('\n\n')).trim();
}

/**
 * Internal rich-context history (plain `Name: text` section style).
 * @param {object} ctx
 * @param {number} mesNum
 * @param {number} count
 * @returns {string}
 */
function getHistory(ctx, mesNum, count) {
    return buildHistoryLines(ctx, mesNum, count, { speakerStyle: 'plain' });
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
 * @returns {Promise<string>}                  the composed context (may be '').
 */
export async function buildRichContext({ mesNum, flags, pendingUserText = '', maxContext = 8192 }) {
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
        const wi = await getActiveWorldInfo(ctx, mesNum, maxContext);
        if (wi) sections.push(`### World Info\n${wi}`);
    }

    if (flags.summary) {
        const summary = getRunningSummary(ctx, mesNum);
        if (summary) sections.push(`### Summary\n${summary}`);
    }

    // In-chat Author's Note has no clean "depth" home in a flat string; fold it
    // in right before history so the planner still sees it.
    if (authorsNote && authorsNote.position === extension_prompt_types.IN_CHAT) {
        sections.push(`### Author's Note\n${authorsNote.text}`);
    }

    if (flags.historyCount > 0) {
        const history = getHistory(ctx, mesNum, flags.historyCount);
        if (history) sections.push(`### Recent history\n${history}`);
    }

    if (flags.pendingUser && pendingUserText.trim()) {
        sections.push(`### Pending user message\n${sub(ctx, pendingUserText).trim()}`);
    }

    const out = sections.join('\n\n').trim();
    debug(`${LOG_PREFIX} built rich context: ${sections.length} section(s), ${out.length} chars`);
    return out;
}
