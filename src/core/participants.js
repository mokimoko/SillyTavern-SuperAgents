/**
 * core/participants.js — who is a "player" vs a trackable character.
 *
 * SillyTavern's {{user}} macro resolves to the CURRENTLY selected persona, but a
 * single chat may cycle through several player personas (multi-persona play).
 * Any name that has ever authored an is_user message is, by definition, one of
 * the player's own personas — never an autonomous NPC. This module derives that
 * set from the chat so trackers (e.g. Active Roster) can exclude every player
 * persona regardless of which one is active on the current turn.
 *
 * It also exposes a manual, chat-scoped EXCLUDE list
 * (chat_metadata.saRosterExclude) for deliberately untracked names — a persona
 * who hasn't spoken yet, or any character the user simply doesn't want tracked,
 * for any reason. Auto-detect and the manual list are independent and unioned.
 *
 * READ-ONLY: inspects chat / context and returns name sets. No mutation, no LLM.
 */

import { chat, chat_metadata } from '../../../../../../script.js';
import { getContext } from '../../../../../extensions.js';

/** Lowercase + trim for case-insensitive name matching. '' for junk. */
function norm(name) {
    return String(name ?? '').trim().toLowerCase();
}

/**
 * Distinct player-persona names used anywhere in the current chat: every name
 * that has authored an is_user message, plus the active persona (name1) in case
 * they have not spoken yet this session. Auto-derived, zero upkeep.
 * @returns {string[]} display-case names, deduped (active persona first)
 */
export function getPlayerPersonaNames() {
    const names = new Map(); // norm -> display
    try {
        const active = String(getContext()?.name1 ?? '').trim();
        if (active) names.set(norm(active), active);
    } catch { /* getContext unavailable outside ST (e.g. unit tests) */ }
    for (const msg of Array.isArray(chat) ? chat : []) {
        if (msg?.is_user) {
            const display = String(msg.name ?? '').trim();
            const key = norm(display);
            if (key && !names.has(key)) names.set(key, display);
        }
    }
    return [...names.values()];
}

/**
 * The currently-active persona's display name — the {{user}} of this turn.
 * Used to PROJECT per-persona state (e.g. Scene State shows only the active
 * persona's stats) rather than every persona used in the chat.
 * @returns {string} display-case name, or '' if unavailable
 */
export function getActivePersonaName() {
    try {
        return String(getContext()?.name1 ?? '').trim();
    } catch {
        return '';
    }
}

/**
 * Project a persona-scoped state blob down to the ACTIVE persona's slice.
 *
 * Persona-scoped trackers (the Relationship Ledger) store
 * `{ personas: { "Joel": { characters: {...} }, "Polaris": {...} } }` so each
 * player persona keeps an isolated record. Consumers that expect the classic
 * character-keyed shape — DE bindings and the State Card panel — get back only
 * the active persona's inner object (`{ characters: {...} }`), so the persona
 * dimension stays invisible to them and nothing downstream needs to change.
 *
 * Legacy single-persona blobs (no `personas` key) and any non-persona data pass
 * through UNCHANGED, so this is safe to call on anything and on data written
 * before the ledger became persona-scoped. When the active persona has no slice
 * yet (e.g. just switched to an untracked persona while others exist), returns
 * an empty `{ characters: {} }` rather than another persona's data.
 * @param {object|null} value  parsed state blob
 * @returns {object|null} the active persona's slice, or the input unchanged
 */
export function projectActivePersona(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const personas = value.personas;
    if (!personas || typeof personas !== 'object' || Array.isArray(personas)) return value;
    const keys = Object.keys(personas).filter(k => personas[k] && typeof personas[k] === 'object');
    if (keys.length === 0) return { characters: {} };
    const active = getActivePersonaName().toLowerCase();
    let key = keys.find(k => k.toLowerCase() === active);
    if (!key && keys.length === 1) key = keys[0];
    return key ? personas[key] : { characters: {} };
}

/**
 * Manual, chat-scoped exclude list: names the user has explicitly marked as
 * "never track," for any reason. Stored on chat_metadata.saRosterExclude as an
 * array of strings. Empty until a settings surface writes it.
 * @returns {string[]} display-case names
 */
export function getManualExcludeNames() {
    const raw = chat_metadata?.saRosterExclude;
    return Array.isArray(raw)
        ? raw.map(n => String(n ?? '').trim()).filter(Boolean)
        : [];
}

/**
 * The full "do not track" set for participant-excluding trackers: player
 * personas ∪ manual excludes. Returned both as display names (for a prompt hint)
 * and a normalized Set (for case-insensitive key matching at commit time). The
 * literal `{{user}}` token is always matched too, in case a tracker echoes the
 * raw macro as a collection key.
 * @returns {{ names: string[], normSet: Set<string> }}
 */
export function getExcludedRosterNames() {
    const names = [...new Set([...getPlayerPersonaNames(), ...getManualExcludeNames()])];
    const normSet = new Set(names.map(norm));
    normSet.add('{{user}}');
    return { names, normSet };
}

/** Player personas only, without the Active Roster's manual NPC exclusions. */
export function getPlayerPersonaExclusion() {
    const names = getPlayerPersonaNames();
    const normSet = new Set(names.map(norm));
    normSet.add('{{user}}');
    normSet.add('user');
    return { names, normSet };
}

/** Resolve a tracker's configured hard participant-ownership boundary. */
export function getConfiguredParticipantExclusion(rawRetention) {
    if (rawRetention?.excludePlayerPersonas) {
        return { ...getPlayerPersonaExclusion(), playersOnly: true };
    }
    if (rawRetention?.excludeParticipants) {
        return { ...getExcludedRosterNames(), playersOnly: false };
    }
    return { names: [], normSet: new Set(), playersOnly: false };
}
