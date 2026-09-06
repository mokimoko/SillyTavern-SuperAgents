/** Chat-scoped State Card styling, independent from its tracker data and visibility. */

import { chat_metadata, saveChatDebounced } from '../../../../../../script.js';
import { eventSource, event_types } from '../../../../../events.js';
import { SUPERAGENTS_EVENTS } from '../integration/events.js';
import { getActivePresentationProfile, onPresentationChanged } from './presentationState.js';

const STATE_CARD_STYLE_VAR = 'sa_state_card_style';
const DEFAULT_STYLE_ID = 'st-theme';
const VALID_STYLE_IDS = new Set(['st-theme', 'match-presentation', 'modern', 'cute-retro', 'retro-pc', 'game-ui', 'grounded-historical', 'mythic-fantasy', 'xianxia', 'post-apocalyptic', 'near-future']);

export const STATE_CARD_STYLE_OPTIONS = Object.freeze([
    Object.freeze({ id: 'st-theme', label: 'SillyTavern Theme' }),
    Object.freeze({ id: 'match-presentation', label: 'Match Story Presentation' }),
    Object.freeze({ id: 'modern', label: 'Modern' }),
    Object.freeze({ id: 'cute-retro', label: 'Cute Retro' }),
    Object.freeze({ id: 'retro-pc', label: 'Retro Analog' }),
    Object.freeze({ id: 'game-ui', label: 'Gamer Modern' }),
    Object.freeze({ id: 'grounded-historical', label: 'Grounded Historical' }),
    Object.freeze({ id: 'mythic-fantasy', label: 'Historical Fantasy' }),
    Object.freeze({ id: 'xianxia', label: 'Xianxia' }),
    Object.freeze({ id: 'post-apocalyptic', label: 'Post-Apocalyptic' }),
    Object.freeze({ id: 'near-future', label: 'Near Future' }),
]);

const listeners = [];
let initialized = false;

function normalizeStyleId(styleId) {
    const value = String(styleId || '').trim();
    return VALID_STYLE_IDS.has(value) ? value : DEFAULT_STYLE_ID;
}

function clone(value) {
    if (value === undefined) return undefined;
    try { return structuredClone(value); } catch { return JSON.parse(JSON.stringify(value)); }
}

export function getStateCardStyleId() {
    return normalizeStyleId(chat_metadata?.variables?.[STATE_CARD_STYLE_VAR]);
}

export function getResolvedStateCardStyleId() {
    const selected = getStateCardStyleId();
    if (selected !== 'match-presentation') return selected;
    const profile = getActivePresentationProfile();
    return normalizeStyleId(profile?.stateCardStyleId || 'modern');
}

function applyDocumentStyle() {
    const root = globalThis.document?.documentElement;
    const selectedStyleId = getStateCardStyleId();
    const resolvedStyleId = getResolvedStateCardStyleId();
    if (root) {
        root.dataset.saStateCardStyle = resolvedStyleId;
        root.dataset.saStateCardStyleSelection = selectedStyleId;
    }
    return { selectedStyleId, resolvedStyleId };
}

function notify(detail = {}) {
    const styles = applyDocumentStyle();
    const payload = clone({ ...detail, ...styles });
    for (const listener of listeners) {
        try { listener(styles.resolvedStyleId, payload); } catch { /* Appearance consumers are optional. */ }
    }
    if (typeof globalThis.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
        globalThis.dispatchEvent(new CustomEvent(SUPERAGENTS_EVENTS.STATE_CARD_STYLE_CHANGED, { detail: payload }));
    }
}

export function setStateCardStyle(styleId) {
    const selectedStyleId = normalizeStyleId(styleId);
    if (!chat_metadata || typeof chat_metadata !== 'object') return selectedStyleId;
    if (!chat_metadata.variables) chat_metadata.variables = {};
    chat_metadata.variables[STATE_CARD_STYLE_VAR] = selectedStyleId;
    saveChatDebounced();
    notify({ kind: 'selection' });
    return selectedStyleId;
}

export function onStateCardStyleChanged(listener) {
    if (typeof listener !== 'function') return () => {};
    listeners.push(listener);
    return () => {
        const index = listeners.indexOf(listener);
        if (index >= 0) listeners.splice(index, 1);
    };
}

export function initStateCardAppearance() {
    if (initialized) return;
    initialized = true;
    applyDocumentStyle();
    eventSource.on(event_types.CHAT_CHANGED, () => notify({ kind: 'chat' }));
    onPresentationChanged((_profile, detail) => {
        if (getStateCardStyleId() === 'match-presentation') {
            notify({ kind: 'presentation', presentationKind: detail?.kind || '' });
        }
    });
}
