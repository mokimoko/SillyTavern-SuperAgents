/** Chat-scoped presentation selection and public read-only descriptors. */

import { chat_metadata, saveChatDebounced } from '../../../../../../script.js';
import { eventSource, event_types } from '../../../../../events.js';
import { SUPERAGENTS_EVENTS } from '../integration/events.js';
import {
    getActionPresentation,
    getPresentationProfile,
    getSurfacePresentation,
    listPresentationProfiles,
} from './profileCatalog.js';

const PRESENTATION_VAR = 'sa_presentation_profile';
const LEGACY_COMMITMENTS_VAR = 'sa_commitments';
export const PRESENTATION_API_VERSION = 1;

const listeners = [];
let initialized = false;

function clone(value) {
    if (value === undefined) return undefined;
    try { return structuredClone(value); } catch { return JSON.parse(JSON.stringify(value)); }
}

function legacyProfileId() {
    try {
        const raw = chat_metadata?.variables?.[LEGACY_COMMITMENTS_VAR];
        return raw ? JSON.parse(raw)?.profileId : '';
    } catch {
        return '';
    }
}

export function getPresentationProfileId() {
    const stored = String(chat_metadata?.variables?.[PRESENTATION_VAR] || '').trim();
    return getPresentationProfile(stored || legacyProfileId()).id;
}

export function getActivePresentationProfile() {
    return getPresentationProfile(getPresentationProfileId());
}

export function getActiveSurfacePresentation(surfaceId) {
    return getSurfacePresentation(surfaceId, getPresentationProfileId());
}

export function getActiveActionPresentation(actionId) {
    return getActionPresentation(actionId, getPresentationProfileId());
}

function applyDocumentProfile() {
    const profile = getActivePresentationProfile();
    const root = globalThis.document?.documentElement;
    if (root) {
        root.dataset.saPresentationProfile = profile.id;
        root.dataset.saPresentationTheme = profile.themeId || profile.id;
    }
    return profile;
}

function notify(detail = {}) {
    const profile = applyDocumentProfile();
    for (const listener of listeners) {
        try { listener(profile, clone(detail)); } catch { /* Presentation consumers are optional. */ }
    }
    if (typeof globalThis.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
        globalThis.dispatchEvent(new CustomEvent(SUPERAGENTS_EVENTS.PRESENTATION_CHANGED, {
            detail: clone({ ...detail, profileId: profile.id }),
        }));
    }
}

export function setPresentationProfile(profileId) {
    const profile = getPresentationProfile(profileId);
    if (!chat_metadata || typeof chat_metadata !== 'object') return profile.id;
    if (!chat_metadata.variables) chat_metadata.variables = {};
    chat_metadata.variables[PRESENTATION_VAR] = profile.id;
    saveChatDebounced();
    notify({ kind: 'profile' });
    return profile.id;
}

export function onPresentationChanged(listener) {
    if (typeof listener !== 'function') return () => {};
    listeners.push(listener);
    return () => {
        const index = listeners.indexOf(listener);
        if (index >= 0) listeners.splice(index, 1);
    };
}

export function initPresentationProfiles() {
    if (initialized) return;
    initialized = true;
    applyDocumentProfile();
    eventSource.on(event_types.CHAT_CHANGED, () => notify({ kind: 'chat' }));
}

function publicProfile(profile) {
    return clone(profile);
}

export function createPresentationIntegrationApi() {
    return Object.freeze({
        apiVersion: PRESENTATION_API_VERSION,
        listProfiles: () => listPresentationProfiles().map(publicProfile),
        getProfile: () => publicProfile(getActivePresentationProfile()),
        getProfileId: getPresentationProfileId,
        setProfile: profileId => setPresentationProfile(profileId),
        getSurface: surfaceId => publicProfile(getActiveSurfacePresentation(surfaceId)),
        getAction: actionId => publicProfile(getActiveActionPresentation(actionId)),
    });
}
