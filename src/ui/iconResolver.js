/**
 * ui/iconResolver.js — single source of truth for "which icon does this
 * agent/group show?". Used by the modal cards AND UIBedazzler's hover flyout
 * so the two never disagree.
 *
 * Resolution order for an agent:
 *   1. agent.icon  — an explicit per-agent FontAwesome class (e.g. "fa-mask"),
 *                    set via the editor's icon picker. This is the unique one.
 *   2. category icon — the shared fallback (only 4 of these), from
 *                    AGENT_CATEGORIES in normalize.js.
 *   3. a final generic fallback, defensively.
 *
 * Groups get their own optional icon field with a layer-group fallback.
 *
 * Returns BARE classes ("fa-mask"); callers prepend the "fa-solid" style
 * class themselves, matching how the rest of the UI is written.
 */

import { AGENT_CATEGORIES } from '../data/normalize.js';

const GENERIC_AGENT_ICON = 'fa-puzzle-piece';
const GENERIC_GROUP_ICON = 'fa-layer-group';

/** Normalize whatever's stored into a single bare "fa-xxx" token, or ''. */
function cleanIconClass(raw) {
    if (typeof raw !== 'string') return '';
    const v = raw.trim();
    if (!v) return '';
    // Tolerate the user pasting a full "fa-solid fa-mask" — keep the last
    // fa-* token that isn't a style prefix.
    const styleTokens = new Set(['fa-solid', 'fa-regular', 'fa-light', 'fa-thin', 'fa-brands', 'fa', 'fas', 'far', 'fal', 'fab']);
    const tokens = v.split(/\s+/).filter(t => t.startsWith('fa-') && !styleTokens.has(t));
    if (tokens.length) return tokens[tokens.length - 1];
    // Bare name without the fa- prefix? Add it.
    if (/^[a-z0-9-]+$/i.test(v) && !v.startsWith('fa-')) return `fa-${v}`;
    return '';
}

/**
 * @param {object} agent
 * @returns {string} a bare FontAwesome class, e.g. "fa-mask"
 */
export function resolveAgentIcon(agent) {
    if (!agent || typeof agent !== 'object') return GENERIC_AGENT_ICON;
    const explicit = cleanIconClass(agent.icon);
    if (explicit) return explicit;
    const cat = AGENT_CATEGORIES[agent.category];
    if (cat && cat.icon) return cat.icon;
    return GENERIC_AGENT_ICON;
}

/**
 * @param {object} group
 * @returns {string} a bare FontAwesome class
 */
export function resolveGroupIcon(group) {
    if (!group || typeof group !== 'object') return GENERIC_GROUP_ICON;
    const explicit = cleanIconClass(group.icon);
    if (explicit) return explicit;
    return GENERIC_GROUP_ICON;
}

export { cleanIconClass };
