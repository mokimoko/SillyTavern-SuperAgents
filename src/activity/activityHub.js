/** Chat-scoped Activity spine and optional producer/source integration. */

import {
    chat,
    chat_metadata,
    saveChatDebounced,
} from '../../../../../../script.js';
import { eventSource, event_types } from '../../../../../events.js';
import { debug } from '../../index.js';
import { SUPERAGENTS_EVENTS } from '../integration/events.js';
import {
    markActivityRead,
    markSourceArtifactsRead,
    markVisibleActivityRead,
    normalizeActivityState,
    projectActivityState,
    removeSourceArtifacts,
    resolveActivityBranch,
    upsertActivityArtifact,
} from './activityStore.js';

const LOG_PREFIX = '[SuperAgents/activity]';
const ACTIVITY_VAR = 'sa_activity_log';
export const ACTIVITY_API_VERSION = 1;

const listeners = [];
const sourceHandlers = new Map();
let initialized = false;
let producers = {};

function clone(value) {
    if (value === undefined) return undefined;
    try {
        return structuredClone(value);
    } catch {
        return JSON.parse(JSON.stringify(value));
    }
}

function readState() {
    try {
        const raw = chat_metadata?.variables?.[ACTIVITY_VAR];
        return normalizeActivityState(raw ? JSON.parse(raw) : {});
    } catch {
        return normalizeActivityState({});
    }
}

function writeState(state) {
    if (!chat_metadata.variables) chat_metadata.variables = {};
    chat_metadata.variables[ACTIVITY_VAR] = JSON.stringify(normalizeActivityState(state));
}

function notifyListeners(detail = {}) {
    const state = getActivityState();
    for (const listener of listeners) {
        try { listener(state, detail); } catch { /* Activity consumers are non-fatal. */ }
    }
    if (typeof globalThis.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
        globalThis.dispatchEvent(new CustomEvent(SUPERAGENTS_EVENTS.ACTIVITY_CHANGED, {
            detail: clone({ ...detail, unread: state.unread }),
        }));
    }
}

function persist(state, detail) {
    writeState(state);
    saveChatDebounced();
    notifyListeners(detail);
}

export function getActivityState(options = {}) {
    return projectActivityState(readState(), chat, options);
}

export function listActivity(options = {}) {
    return getActivityState(options).artifacts;
}

export function getActivity(artifactId, options = {}) {
    return listActivity(options).find(artifact => artifact.id === artifactId) ?? null;
}

export function getNotificationState(options = {}) {
    const state = getActivityState(options);
    const artifacts = state.artifacts.filter(artifact => artifact.notification);
    return {
        artifacts,
        unread: artifacts.filter(artifact => artifact.unread).length,
    };
}

export function publishActivity(input = {}) {
    const branch = resolveActivityBranch(chat, input);
    const result = upsertActivityArtifact(readState(), {
        ...input,
        messageIndex: input.messageIndex ?? branch.messageIndex,
        swipeId: input.swipeId ?? branch.swipeId,
        branchPath: input.branchPath ?? branch.branchPath,
    });
    if (!result.artifact) return null;
    persist(result.state, {
        kind: result.created ? 'recorded' : 'updated',
        artifactId: result.artifact.id,
        sourceApp: result.artifact.sourceApp,
    });
    return clone(result.artifact);
}

export function markNotificationRead(artifactId) {
    const artifact = getActivity(artifactId);
    if (!artifact) return false;
    persist(markActivityRead(readState(), artifactId), {
        kind: 'read', artifactId, sourceApp: artifact.sourceApp,
    });
    return true;
}

export function markAllNotificationsRead(options = {}) {
    persist(markVisibleActivityRead(readState(), chat, options), { kind: 'read-all' });
}

function phoneArtifact(message, character) {
    return {
        id: `phone.message:${message.id}`,
        type: 'phone.message',
        sourceApp: 'phone',
        sourceId: message.id,
        actor: message.name || character,
        title: message.from === 'char'
            ? `Message from ${message.name || character}`
            : `Message to ${character}`,
        summary: message.content,
        timestamp: message.timestamp,
        unread: message.from === 'char' && message.unread !== false,
        notification: message.from === 'char',
        visibility: 'persona',
        participants: [character],
        context: { character },
        messageIndex: message.messageIndex,
        swipeId: message.swipeId,
        branchPath: message.branchPath,
    };
}

function feedArtifact(post) {
    return {
        id: `feed.post:${post.id}`,
        type: 'feed.post',
        sourceApp: 'feed',
        sourceId: post.id,
        actor: post.author,
        title: `${post.author} posted`,
        summary: post.content,
        timestamp: post.timestamp,
        unread: post.unread === true,
        notification: post.source !== 'user',
        visibility: post.audience === 'public' ? 'public' : 'shared',
        audience: [post.audience],
        context: { audience: post.audience },
        messageIndex: post.messageIndex,
        swipeId: post.swipeId,
        branchPath: post.branchPath,
    };
}

function commitmentArtifact(commitment) {
    const status = String(commitment.status || 'scheduled');
    const statusLabel = `${status[0].toUpperCase()}${status.slice(1)}`;
    return {
        id: `calendar.commitment:${commitment.id}`,
        type: 'calendar.commitment',
        sourceApp: 'calendar',
        sourceId: commitment.id,
        actor: commitment.participants?.[0] || 'Calendar',
        title: commitment.title,
        summary: `${statusLabel} ${commitment.type || 'commitment'}${commitment.location ? ` · ${commitment.location}` : ''}`,
        timestamp: commitment.updatedAt || commitment.createdAt,
        unread: commitment.unread === true,
        notification: commitment.notification === true,
        visibility: commitment.visibility || 'persona',
        participants: commitment.participants || [],
        context: { status, type: commitment.type || 'commitment' },
        messageIndex: commitment.messageIndex,
        swipeId: commitment.swipeId,
        branchPath: commitment.branchPath,
    };
}

function hydrateVisibleSources() {
    let state = readState();
    const known = new Set(state.artifacts.map(artifact => artifact.id));
    let added = 0;
    const threads = producers.phone?.listThreads?.() || {};
    for (const [character, thread] of Object.entries(threads)) {
        for (const message of thread?.messages || []) {
            const artifact = phoneArtifact(message, character);
            if (known.has(artifact.id)) continue;
            state = upsertActivityArtifact(state, artifact).state;
            known.add(artifact.id);
            added += 1;
        }
    }
    for (const post of producers.feed?.listPosts?.() || []) {
        const artifact = feedArtifact(post);
        if (known.has(artifact.id)) continue;
        state = upsertActivityArtifact(state, artifact).state;
        known.add(artifact.id);
        added += 1;
    }
    for (const commitment of producers.calendar?.listCommitments?.() || []) {
        const artifact = commitmentArtifact(commitment);
        if (known.has(artifact.id)) continue;
        state = upsertActivityArtifact(state, artifact).state;
        known.add(artifact.id);
        added += 1;
    }
    if (added) persist(state, { kind: 'hydrated', count: added });
    return added;
}

function handlePhoneActivity(event = {}) {
    const messages = Array.isArray(event.messages) ? event.messages : [];
    if (event.kind === 'message') {
        for (const message of messages) {
            publishActivity(phoneArtifact(message, event.character));
        }
        return;
    }

    const sourceIds = Array.isArray(event.sourceIds) ? event.sourceIds : [];
    if (event.kind === 'read') {
        persist(markSourceArtifactsRead(readState(), 'phone', sourceIds), {
            kind: 'source-read', sourceApp: 'phone', sourceIds,
        });
    } else if (event.kind === 'clear') {
        persist(removeSourceArtifacts(readState(), 'phone', sourceIds), {
            kind: 'source-clear', sourceApp: 'phone', sourceIds,
        });
    }
}

function handleFeedActivity(event = {}) {
    const post = event.post;
    if (event.kind === 'post' && post?.id) {
        publishActivity(feedArtifact(post));
        return;
    }

    const sourceIds = Array.isArray(event.sourceIds) ? event.sourceIds : [];
    if (event.kind === 'read') {
        persist(markSourceArtifactsRead(readState(), 'feed', sourceIds), {
            kind: 'source-read', sourceApp: 'feed', sourceIds,
        });
    } else if (event.kind === 'clear') {
        persist(removeSourceArtifacts(readState(), 'feed', sourceIds), {
            kind: 'source-clear', sourceApp: 'feed', sourceIds,
        });
    }
}

function handleCommitmentActivity(event = {}) {
    const commitment = event.commitment;
    if (event.kind === 'commitment' && commitment?.id) {
        publishActivity(commitmentArtifact(commitment));
        return;
    }
    const sourceIds = Array.isArray(event.sourceIds) ? event.sourceIds : [];
    if (event.kind === 'read') {
        persist(markSourceArtifactsRead(readState(), 'calendar', sourceIds), {
            kind: 'source-read', sourceApp: 'calendar', sourceIds,
        });
    } else if (event.kind === 'clear') {
        persist(removeSourceArtifacts(readState(), 'calendar', sourceIds), {
            kind: 'source-clear', sourceApp: 'calendar', sourceIds,
        });
    }
}

export function registerActivitySource(sourceApp, handlers = {}) {
    const key = String(sourceApp || '').trim();
    if (!key) return () => {};
    sourceHandlers.set(key, {
        isAvailable: typeof handlers.isAvailable === 'function' ? handlers.isAvailable : () => true,
        open: typeof handlers.open === 'function' ? handlers.open : null,
    });
    return () => sourceHandlers.delete(key);
}

export async function openActivitySource(artifactId) {
    const artifact = getActivity(artifactId);
    if (!artifact) return { opened: false, error: 'activity artifact is unavailable' };
    markNotificationRead(artifactId);
    const handler = sourceHandlers.get(artifact.sourceApp);
    if (!handler?.open || !handler.isAvailable()) {
        return { opened: false, error: `${artifact.sourceApp} source is unavailable`, artifact };
    }
    try {
        const opened = await handler.open(clone(artifact));
        return { opened: opened !== false, artifact };
    } catch (error) {
        return { opened: false, error: error?.message || 'source failed to open', artifact };
    }
}

export function onActivityChanged(listener) {
    if (typeof listener !== 'function') return () => {};
    listeners.push(listener);
    return () => {
        const index = listeners.indexOf(listener);
        if (index >= 0) listeners.splice(index, 1);
    };
}

export function createActivityIntegrationApi() {
    return Object.freeze({
        apiVersion: ACTIVITY_API_VERSION,
        list: (options = {}) => clone(listActivity(options)),
        get: (artifactId, options = {}) => clone(getActivity(artifactId, options)),
        publish: (artifact = {}) => clone(publishActivity(artifact)),
        registerSource: (sourceApp, handlers = {}) => registerActivitySource(sourceApp, handlers),
        openSource: artifactId => openActivitySource(artifactId),
        notifications: Object.freeze({
            list: (options = {}) => clone(getNotificationState(options).artifacts),
            getUnreadCount: (options = {}) => getNotificationState(options).unread,
            markRead: artifactId => markNotificationRead(artifactId),
            markAllRead: (options = {}) => markAllNotificationsRead(options),
        }),
    });
}

export function initActivityHub({ phone = {}, feed = {}, calendar = {} } = {}) {
    if (initialized) return;
    initialized = true;
    producers = { phone, feed, calendar };
    phone.onActivity?.(handlePhoneActivity);
    feed.onActivity?.(handleFeedActivity);
    calendar.onActivity?.(handleCommitmentActivity);
    eventSource.on(event_types.CHAT_CHANGED, () => {
        if (!hydrateVisibleSources()) notifyListeners({ kind: 'chat-changed' });
    });
    if (event_types.MESSAGE_SWIPED) {
        eventSource.on(event_types.MESSAGE_SWIPED, () => {
            if (!hydrateVisibleSources()) notifyListeners({ kind: 'branch-changed' });
        });
    }
    hydrateVisibleSources();
    debug(`${LOG_PREFIX} shared artifact spine initialized`);
}
