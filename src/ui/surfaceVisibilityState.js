/** Chat-scoped open/closed state for Story App surfaces. */

import { chat_metadata, saveChatDebounced } from '../../../../../../script.js';

export const STORY_APP_VISIBILITY_VAR = 'sa_story_app_visibility';

function readVisibilityStore() {
    try {
        const raw = chat_metadata?.variables?.[STORY_APP_VISIBILITY_VAR];
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
        return Object.fromEntries(
            Object.entries(parsed).filter(([, value]) => typeof value === 'boolean'),
        );
    } catch {
        return {};
    }
}

/** Return a chat override, or null when this chat should use the global default. */
export function getSurfaceVisibility(surfaceId) {
    const id = String(surfaceId || '').trim();
    if (!id) return null;
    const value = readVisibilityStore()[id];
    return typeof value === 'boolean' ? value : null;
}

export function resolveSurfaceVisibility(surfaceId, defaultVisible) {
    return getSurfaceVisibility(surfaceId) ?? !!defaultVisible;
}

/** Remember the surface's actual state in the current chat. */
export function setSurfaceVisibility(surfaceId, visible) {
    const id = String(surfaceId || '').trim();
    if (!id || !chat_metadata || typeof chat_metadata !== 'object') return false;
    if (!chat_metadata.variables || typeof chat_metadata.variables !== 'object') {
        chat_metadata.variables = {};
    }

    const store = readVisibilityStore();
    const next = !!visible;
    if (store[id] === next) return false;
    store[id] = next;
    chat_metadata.variables[STORY_APP_VISIBILITY_VAR] = JSON.stringify(store);
    saveChatDebounced();
    return true;
}
