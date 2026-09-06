/** Pure normalization, branch projection, and read-state helpers for Activity. */

export const ACTIVITY_STATE_VERSION = 1;
export const MAX_ACTIVITY_ARTIFACTS = 200;

function cleanText(value, maxLength) {
    return String(value ?? '').trim().slice(0, maxLength);
}

function cleanList(value, maxItems = 16, maxLength = 120) {
    if (!Array.isArray(value)) return [];
    return value
        .map(item => cleanText(item, maxLength))
        .filter(Boolean)
        .slice(0, maxItems);
}

function cleanContext(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value)
        .slice(0, 12)
        .map(([key, item]) => [cleanText(key, 80), cleanText(item, 240)])
        .filter(([key]) => Boolean(key)));
}

function activeSwipeId(message) {
    const value = Number(message?.swipe_id ?? 0);
    return Number.isInteger(value) && value >= 0 ? value : 0;
}

export function resolveActivityBranch(chat, options = {}) {
    if (!Array.isArray(chat) || chat.length === 0) {
        return { messageIndex: null, swipeId: null, branchPath: null };
    }

    const requestedIndex = options.messageIndex == null ? NaN : Number(options.messageIndex);
    const messageIndex = Number.isInteger(requestedIndex)
        ? Math.max(0, Math.min(requestedIndex, chat.length - 1))
        : chat.length - 1;
    const requestedSwipe = options.swipeId == null ? NaN : Number(options.swipeId);
    const swipeId = Number.isInteger(requestedSwipe) && requestedSwipe >= 0
        ? requestedSwipe
        : activeSwipeId(chat[messageIndex]);
    const branchPath = chat.slice(0, messageIndex + 1).map((message, index) => (
        index === messageIndex ? swipeId : activeSwipeId(message)
    ));

    return { messageIndex, swipeId, branchPath };
}

export function normalizeActivityArtifact(artifact = {}) {
    const sourceApp = cleanText(artifact.sourceApp, 80) || 'external';
    const sourceId = cleanText(artifact.sourceId, 160);
    const id = cleanText(artifact.id, 240) || `${sourceApp}:${sourceId}`;
    if (!sourceId || !id) return null;

    const visibility = ['persona', 'shared', 'public'].includes(artifact.visibility)
        ? artifact.visibility
        : 'persona';
    const branchPath = Array.isArray(artifact.branchPath)
        ? artifact.branchPath.map(value => Math.max(0, Number(value) || 0)).slice(0, 500)
        : null;

    const timestamp = Number(artifact.timestamp || Date.now());
    return {
        id,
        type: cleanText(artifact.type, 100) || `${sourceApp}.artifact`,
        sourceApp,
        sourceId,
        actor: cleanText(artifact.actor, 120) || 'Unknown',
        title: cleanText(artifact.title, 200) || 'New activity',
        summary: cleanText(artifact.summary, 1000),
        timestamp: Number.isFinite(timestamp) ? timestamp : Date.now(),
        unread: artifact.unread === true,
        notification: artifact.notification !== false,
        visibility,
        participants: cleanList(artifact.participants),
        audience: cleanList(artifact.audience),
        causeIds: cleanList(artifact.causeIds),
        relatedIds: cleanList(artifact.relatedIds),
        context: cleanContext(artifact.context),
        messageIndex: artifact.messageIndex != null && Number.isInteger(Number(artifact.messageIndex))
            ? Math.max(0, Number(artifact.messageIndex))
            : null,
        swipeId: artifact.swipeId != null && Number.isInteger(Number(artifact.swipeId))
            ? Math.max(0, Number(artifact.swipeId))
            : null,
        branchPath,
    };
}

export function normalizeActivityState(state = {}) {
    const artifacts = Array.isArray(state.artifacts)
        ? state.artifacts.map(normalizeActivityArtifact).filter(Boolean)
        : [];
    return {
        version: ACTIVITY_STATE_VERSION,
        artifacts: artifacts.slice(-MAX_ACTIVITY_ARTIFACTS),
        lastActivity: Number(state.lastActivity || 0),
    };
}

export function isActivityArtifactVisible(artifact, chat, options = {}, currentPath = null) {
    const storedPath = Array.isArray(artifact?.branchPath) ? artifact.branchPath : null;
    if (storedPath?.length) {
        const resolvedPath = currentPath || resolveActivityBranch(chat, options).branchPath;
        if (!resolvedPath || resolvedPath.length < storedPath.length) return false;
        return storedPath.every((swipeId, index) => resolvedPath[index] === swipeId);
    }

    if (artifact?.messageIndex == null || !Number.isInteger(Number(artifact.messageIndex))) return true;
    const index = Number(artifact.messageIndex);
    if (!Array.isArray(chat) || index < 0 || index >= chat.length) return false;
    return activeSwipeId(chat[index]) === Number(artifact.swipeId ?? 0);
}

export function projectActivityState(state, chat, options = {}) {
    const normalized = normalizeActivityState(state);
    const currentPath = resolveActivityBranch(chat, options).branchPath;
    const artifacts = normalized.artifacts.filter(artifact => (
        isActivityArtifactVisible(artifact, chat, options, currentPath)
    ));
    return {
        ...normalized,
        artifacts,
        unread: artifacts.filter(artifact => artifact.notification && artifact.unread).length,
    };
}

export function upsertActivityArtifact(state, artifact) {
    const normalized = normalizeActivityState(state);
    const next = normalizeActivityArtifact(artifact);
    if (!next) return { state: normalized, artifact: null, created: false };
    const index = normalized.artifacts.findIndex(candidate => candidate.id === next.id);
    const created = index < 0;
    if (created) normalized.artifacts.push(next);
    else normalized.artifacts[index] = { ...normalized.artifacts[index], ...next };
    normalized.artifacts = normalized.artifacts.slice(-MAX_ACTIVITY_ARTIFACTS);
    normalized.lastActivity = Math.max(normalized.lastActivity, next.timestamp, Date.now());
    return { state: normalized, artifact: next, created };
}

export function markActivityRead(state, artifactId) {
    const normalized = normalizeActivityState(state);
    const artifact = normalized.artifacts.find(candidate => candidate.id === artifactId);
    if (artifact) artifact.unread = false;
    return normalized;
}

export function markSourceArtifactsRead(state, sourceApp, sourceIds = []) {
    const normalized = normalizeActivityState(state);
    const ids = new Set(cleanList(sourceIds, MAX_ACTIVITY_ARTIFACTS, 160));
    for (const artifact of normalized.artifacts) {
        if (artifact.sourceApp === sourceApp && (!ids.size || ids.has(artifact.sourceId))) {
            artifact.unread = false;
        }
    }
    return normalized;
}

export function removeSourceArtifacts(state, sourceApp, sourceIds = []) {
    const normalized = normalizeActivityState(state);
    const ids = new Set(cleanList(sourceIds, MAX_ACTIVITY_ARTIFACTS, 160));
    normalized.artifacts = normalized.artifacts.filter(artifact => (
        artifact.sourceApp !== sourceApp || (ids.size && !ids.has(artifact.sourceId))
    ));
    return normalized;
}

export function markVisibleActivityRead(state, chat, options = {}) {
    const normalized = normalizeActivityState(state);
    const currentPath = resolveActivityBranch(chat, options).branchPath;
    for (const artifact of normalized.artifacts) {
        if (isActivityArtifactVisible(artifact, chat, options, currentPath)) artifact.unread = false;
    }
    return normalized;
}
