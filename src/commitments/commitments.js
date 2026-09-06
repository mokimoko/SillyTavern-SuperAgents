/** Chat-scoped Commitments source, compact prompt context, and public commands. */

import {
    chat,
    chat_metadata,
    extension_prompts,
    saveChatDebounced,
    setExtensionPrompt,
    substituteParams,
} from '../../../../../../script.js';
import { eventSource, event_types } from '../../../../../events.js';
import { debug } from '../../index.js';
import { getEnabledAgents, getGlobalSettings } from '../data/store.js';
import { SUPERAGENTS_EVENTS } from '../integration/events.js';
import {
    getActiveSurfacePresentation,
    setPresentationProfile,
} from '../presentation/presentationState.js';
import {
    compareCommitments,
    isCommitmentVisible,
    isReconciliationGrantExpired,
    isReconciliationGrantUsed,
    markCommitmentsRead,
    markVisibleCommitmentsRead,
    normalizeCommitmentState,
    projectCommitmentState,
    removeCommitment as removeStoredCommitment,
    resolveCommitmentBranch,
    stampCommitment,
    upsertCommitment,
} from './commitmentStore.js';
import {
    formatTimeExpression,
    getCommitmentProfile,
    listCommitmentProfiles,
} from './timeExpressions.js';
import {
    buildCalendarStoryCreationCue,
    buildCalendarReconciliationCue,
    buildDormantCalendarReconciliationCue,
    parseCalendarDirectives,
} from './calendarReconciliation.js';

const LOG_PREFIX = '[SuperAgents/commitments]';
const COMMITMENTS_VAR = 'sa_commitments';
const PROMPT_KEY = 'sa_commitments_ctx';
export const COMMITMENTS_API_VERSION = 2;
const RECONCILIATION_MIGRATION_RECENCY_MS = 7 * 24 * 60 * 60 * 1000;

const changeListeners = [];
const activityListeners = [];
let initialized = false;

function clone(value) {
    if (value === undefined) return undefined;
    try { return structuredClone(value); } catch { return JSON.parse(JSON.stringify(value)); }
}

function id() {
    return `commitment_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function readState() {
    try {
        const raw = chat_metadata?.variables?.[COMMITMENTS_VAR];
        return normalizeCommitmentState(raw ? JSON.parse(raw) : {});
    } catch {
        return normalizeCommitmentState({});
    }
}

function writeState(state) {
    if (!chat_metadata.variables) chat_metadata.variables = {};
    chat_metadata.variables[COMMITMENTS_VAR] = JSON.stringify(normalizeCommitmentState(state));
}

function notifyActivity(event) {
    for (const listener of activityListeners) {
        try { listener(clone(event)); } catch { /* Optional consumers are non-fatal. */ }
    }
}

function notifyChanged(detail = {}) {
    const state = getCommitmentState();
    for (const listener of changeListeners) {
        try { listener(clone(state), clone(detail)); } catch { /* UI consumers are non-fatal. */ }
    }
    if (typeof globalThis.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
        globalThis.dispatchEvent(new CustomEvent(SUPERAGENTS_EVENTS.COMMITMENTS_CHANGED, {
            detail: clone({ ...detail, unread: state.unread }),
        }));
    }
}

function persist(state, detail = {}) {
    writeState(state);
    saveChatDebounced();
    syncCommitmentInjection();
    notifyChanged(detail);
}

export function getCommitmentState(options = {}) {
    const projected = projectCommitmentState(readState(), chat, options);
    projected.profileId = getActiveSurfacePresentation('calendar')?.timeProfileId || projected.profileId;
    projected.commitments.sort(compareCommitments);
    return projected;
}

export function listCommitments(options = {}) {
    return getCommitmentState(options).commitments;
}

export function getCommitment(commitmentId, options = {}) {
    return listCommitments(options).find(item => item.id === commitmentId) ?? null;
}

export function getCommitmentProfileId() {
    return getCommitmentState().profileId;
}

export function setCommitmentProfile(profileId) {
    const profile = getCommitmentProfile(profileId);
    const state = readState();
    state.profileId = profile.id;
    setPresentationProfile(profile.id);
    persist(state, { kind: 'profile', profileId: profile.id });
    return profile.id;
}

export function createCommitment(input = {}, options = {}) {
    const title = String(input.title || '').trim();
    if (!title) return null;
    const source = ['external', 'generated'].includes(input.source) ? input.source : 'user';
    const notify = options.notify === true || input.notify === true;
    const now = Date.now();
    const branch = resolveCommitmentBranch(chat, options);
    const stored = stampCommitment({
        ...input,
        id: String(input.id || '').trim() || id(),
        title,
        source,
        notification: notify,
        unread: notify,
        createdAt: now,
        updatedAt: now,
    }, branch);
    const result = upsertCommitment(readState(), stored);
    persist(result.state, { kind: 'created', commitmentId: result.commitment.id });
    notifyActivity({ kind: 'commitment', action: 'created', commitment: result.commitment });
    return clone(result.commitment);
}

export function updateCommitment(commitmentId, patch = {}, options = {}) {
    const current = getCommitment(commitmentId, options);
    if (!current) return null;
    const notify = options.notify === true || patch.notify === true;
    const result = upsertCommitment(readState(), {
        ...current,
        ...patch,
        id: current.id,
        time: patch.time ?? patch.schedule ?? current.time,
        source: current.source,
        notification: notify ? true : current.notification,
        unread: notify ? true : current.unread,
        createdAt: current.createdAt,
        updatedAt: Date.now(),
        messageIndex: current.messageIndex,
        swipeId: current.swipeId,
        branchPath: current.branchPath,
    });
    persist(result.state, { kind: 'updated', commitmentId: current.id });
    notifyActivity({ kind: 'commitment', action: 'updated', commitment: result.commitment });
    if (current.status !== result.commitment.status
        && ['missed', 'cancelled'].includes(result.commitment.status)) {
        authorizeCalendarReconciliation(result.commitment.id, {
            ...options,
            source: String(options.source || 'calendar-status'),
        });
    }
    return clone(result.commitment);
}

export function setCommitmentStatus(commitmentId, status, options = {}) {
    return updateCommitment(commitmentId, { status }, options);
}

function currentAssistantLocation() {
    const messageIndex = chat.length - 1;
    const message = chat[messageIndex];
    if (!message || message.is_user || message.is_system || typeof message.mes !== 'string') return null;
    const swipeId = Number.isInteger(Number(message.swipe_id)) ? Math.max(0, Number(message.swipe_id)) : 0;
    return { message, messageIndex, swipeId };
}

function successorId(commitmentId, messageIndex, swipeId) {
    const source = `${commitmentId}:${messageIndex}:${swipeId}`;
    let hash = 2166136261;
    for (let index = 0; index < source.length; index++) {
        hash ^= source.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return `commitment_rescheduled_${(hash >>> 0).toString(36)}`;
}

function reconciliationToken() {
    const random = globalThis.crypto?.getRandomValues
        ? [...globalThis.crypto.getRandomValues(new Uint32Array(4))].map(value => value.toString(36)).join('')
        : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
    return `calendar_grant_${random}`;
}

function storyCreationToken() {
    const random = globalThis.crypto?.getRandomValues
        ? [...globalThis.crypto.getRandomValues(new Uint32Array(4))].map(value => value.toString(36)).join('')
        : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
    return `calendar_create_${random}`;
}

/** Upgrade v1 chats and re-arm at most one recent terminal record that lacked a grant. */
function migrateReconciliationWindows() {
    let raw = {};
    try {
        const stored = chat_metadata?.variables?.[COMMITMENTS_VAR];
        raw = stored ? JSON.parse(stored) : {};
    } catch { /* Normalization below repairs malformed legacy state. */ }
    if (Number(raw?.version || 0) >= 2) return false;

    const state = normalizeCommitmentState(raw);
    const visible = projectCommitmentState(state, chat);
    const recentTerminal = visible.commitments
        .filter(commitment => ['missed', 'cancelled'].includes(commitment.status))
        .filter(commitment => Date.now() - Number(commitment.updatedAt || 0) <= RECONCILIATION_MIGRATION_RECENCY_MS)
        .filter(commitment => !visible.reconciliationGrants.some(grant => grant.commitmentId === commitment.id))
        .filter(commitment => !visible.commitments.some(candidate => (
            candidate.lineage?.relation === 'rescheduled-from'
            && candidate.lineage.commitmentId === commitment.id
        )))
        .sort((left, right) => Number(right.updatedAt || 0) - Number(left.updatedAt || 0))[0];

    writeState(state);
    saveChatDebounced();
    if (recentTerminal) {
        authorizeCalendarReconciliation(recentTerminal.id, { source: 'calendar-migration:v2' });
    }
    return true;
}

/** Restore an authorized terminal record when deletion or a swipe hides its branch grant. */
function restoreCurrentBranchReconciliationWindows(source = 'calendar-branch-restore') {
    if (getGlobalSettings().calendarStorySync === false) return 0;
    const state = readState();
    const visible = projectCommitmentState(state, chat);
    const authorizedIds = new Set(state.reconciliationGrants.map(grant => grant.commitmentId));
    const successorIds = new Set(visible.commitments
        .filter(commitment => commitment.lineage?.relation === 'rescheduled-from')
        .map(commitment => commitment.lineage.commitmentId));
    const pendingIds = new Set(visible.reconciliationGrants
        .filter(grant => !isReconciliationGrantUsed(grant, chat))
        .map(grant => grant.commitmentId));
    const recoverable = visible.commitments
        .filter(commitment => ['missed', 'cancelled'].includes(commitment.status))
        .filter(commitment => authorizedIds.has(commitment.id))
        .filter(commitment => !successorIds.has(commitment.id) && !pendingIds.has(commitment.id))
        .sort((left, right) => Number(right.updatedAt || 0) - Number(left.updatedAt || 0))
        .slice(0, 4);
    if (!recoverable.length) return 0;

    const branch = resolveCommitmentBranch(chat);
    for (const commitment of recoverable) {
        state.reconciliationGrants.push(stampCommitment({
            token: reconciliationToken(),
            commitmentId: commitment.id,
            source: String(source).slice(0, 240),
            createdAt: Date.now(),
            uses: [],
        }, branch));
    }
    writeState(state);
    saveChatDebounced();
    debug(`${LOG_PREFIX} restored ${recoverable.length} reconciliation window(s) on the visible branch`);
    return recoverable.length;
}

/** Keep one passive story-creation capability available on the visible branch. */
function ensureStoryCreationGrant() {
    if (getGlobalSettings().calendarStorySync === false) return 0;
    const visible = getCommitmentState();
    if (visible.storyCreationGrants.length) return 0;
    const state = readState();
    state.storyCreationGrants.push(stampCommitment({
        token: storyCreationToken(),
        createdAt: Date.now(),
        uses: [],
    }, resolveCommitmentBranch(chat)));
    writeState(state);
    saveChatDebounced();
    return 1;
}

export function authorizeCalendarReconciliation(commitmentId, options = {}) {
    const commitment = getCommitment(commitmentId, options);
    if (!commitment || !['missed', 'cancelled'].includes(commitment.status)
        || getGlobalSettings().calendarStorySync === false) return null;
    const branch = resolveCommitmentBranch(chat, options);
    const existing = getCommitmentState(branch).reconciliationGrants.find(grant => (
        grant.commitmentId === commitment.id
        && !isReconciliationGrantUsed(grant, chat, branch)
        && !isReconciliationGrantExpired(grant, chat, branch)
    ));
    if (existing) return clone(existing);
    const state = readState();
    const grant = stampCommitment({
        token: reconciliationToken(),
        commitmentId: commitment.id,
        source: String(options.source || '').slice(0, 240),
        createdAt: Date.now(),
        uses: [],
    }, branch);
    state.reconciliationGrants.push(grant);
    persist(state, { kind: 'reconciliation-authorized', commitmentId: commitment.id });
    return clone(grant);
}

function validReconciliationGrant(token, commitmentId, options = {}) {
    return getCommitmentState(options).reconciliationGrants.some(grant => (
        grant.token === token
        && grant.commitmentId === commitmentId
        && !isReconciliationGrantUsed(grant, chat, options)
    ));
}

function storyCreationGrantUsedAt(grant, options = {}) {
    const branch = resolveCommitmentBranch(chat, options);
    return Array.isArray(grant?.uses) && grant.uses.some(use => (
        Number(use.messageIndex) === Number(branch.messageIndex)
        && Number(use.swipeId ?? 0) === Number(branch.swipeId ?? 0)
        && isCommitmentVisible(use, chat, branch)
    ));
}

function validStoryCreationGrant(token, options = {}) {
    return getCommitmentState(options).storyCreationGrants.some(grant => (
        grant.token === token && !storyCreationGrantUsedAt(grant, options)
    ));
}

function consumeReconciliationGrant(token, location) {
    const state = readState();
    const grant = state.reconciliationGrants.find(item => item.token === token);
    if (!grant) return;
    const branch = resolveCommitmentBranch(chat, location);
    if (isReconciliationGrantUsed(grant, chat, branch)) return;
    grant.uses.push(stampCommitment({ usedAt: Date.now() }, branch));
    persist(state, { kind: 'reconciliation-consumed', commitmentId: grant.commitmentId });
}

function consumeStoryCreationGrant(token, location) {
    const state = readState();
    const grant = state.storyCreationGrants.find(item => item.token === token);
    if (!grant || storyCreationGrantUsedAt(grant, location)) return;
    grant.uses.push(stampCommitment({ usedAt: Date.now() }, resolveCommitmentBranch(chat, location)));
    persist(state, { kind: 'story-creation-consumed' });
}

function applyCalendarDirective(directive, location) {
    if (directive.action === 'create') {
        const branch = { messageIndex: location.messageIndex, swipeId: location.swipeId };
        if (!validStoryCreationGrant(directive.grant, branch)) return null;
        const duplicate = listCommitments(branch).find(commitment => (
            commitment.title.toLocaleLowerCase() === directive.title.toLocaleLowerCase()
            && commitment.type === directive.type
            && JSON.stringify(commitment.time) === JSON.stringify(directive.time)
        ));
        if (duplicate) {
            consumeStoryCreationGrant(directive.grant, branch);
            return null;
        }
        const id = successorId('story-created', location.messageIndex, location.swipeId)
            .replace('commitment_rescheduled_', 'commitment_story_');
        const created = getCommitment(id, branch) || createCommitment({
            id,
            title: directive.title,
            type: directive.type,
            time: directive.time,
            participants: directive.participants,
            location: directive.location,
            visibility: ['persona', 'shared', 'public'].includes(directive.visibility)
                ? directive.visibility
                : 'persona',
            notes: directive.notes,
            source: 'generated',
        }, { ...branch, notify: true });
        if (created) consumeStoryCreationGrant(directive.grant, branch);
        return created;
    }
    const branch = { messageIndex: location.messageIndex, swipeId: location.swipeId };
    if (!validReconciliationGrant(directive.grant, directive.commitmentId, branch)) return null;
    const original = getCommitment(directive.commitmentId, branch);
    if (!original) return null;
    const id = successorId(original.id, location.messageIndex, location.swipeId);
    const existing = getCommitment(id, branch);
    const successor = existing || createCommitment({
        id,
        title: directive.title || original.title,
        type: directive.type || original.type,
        time: directive.time,
        participants: directive.participants.length ? directive.participants : original.participants,
        location: directive.location || original.location,
        visibility: ['persona', 'shared', 'public'].includes(directive.visibility)
            ? directive.visibility
            : original.visibility,
        notes: directive.notes,
        source: 'generated',
        lineage: {
            relation: 'rescheduled-from',
            commitmentId: original.id,
            title: original.title,
        },
    }, { ...branch, notify: true });
    if (successor) consumeReconciliationGrant(directive.grant, branch);
    return successor;
}

/** Apply story-established Calendar changes from the latest assistant response. */
export function processCalendarReconciliation() {
    if (getGlobalSettings().calendarStorySync === false) return [];
    const location = currentAssistantLocation();
    if (!location) return [];
    const parsed = parseCalendarDirectives(location.message.mes);
    if (parsed.cleanText !== location.message.mes) {
        location.message.mes = parsed.cleanText;
        if (Array.isArray(location.message.swipes) && typeof location.message.swipes[location.swipeId] === 'string') {
            location.message.swipes[location.swipeId] = parsed.cleanText;
        }
        saveChatDebounced();
    }
    let creationHandled = false;
    const applied = [];
    for (const directive of parsed.directives) {
        if (directive.action === 'create') {
            if (creationHandled) continue;
            creationHandled = true;
        }
        const result = applyCalendarDirective(directive, location);
        if (result) applied.push(result);
    }
    if (applied.length) debug(`${LOG_PREFIX} applied ${applied.length} story-established commitment change(s)`);
    return applied;
}

export function removeCommitment(commitmentId, options = {}) {
    const current = getCommitment(commitmentId, options);
    if (!current) return false;
    persist(removeStoredCommitment(readState(), current.id), {
        kind: 'removed', commitmentId: current.id,
    });
    notifyActivity({ kind: 'clear', sourceIds: [current.id] });
    return true;
}

export function markCommitmentRead(commitmentId) {
    const current = getCommitment(commitmentId);
    if (!current || !current.unread) return Boolean(current);
    persist(markCommitmentsRead(readState(), [current.id]), {
        kind: 'read', commitmentId: current.id,
    });
    notifyActivity({ kind: 'read', sourceIds: [current.id] });
    return true;
}

export function markVisibleCommitmentsAsRead(options = {}) {
    const visibleIds = listCommitments(options).filter(item => item.unread).map(item => item.id);
    if (!visibleIds.length) return;
    persist(markVisibleCommitmentsRead(readState(), chat, options), { kind: 'read-all' });
    notifyActivity({ kind: 'read', sourceIds: visibleIds });
}

function buildInjection() {
    const state = getCommitmentState();
    const surface = getActiveSurfacePresentation('calendar') || {};
    const surfaceLabel = surface.title || 'Calendar';
    const storySyncEnabled = getGlobalSettings().calendarStorySync !== false;
    const active = state.commitments.filter(item => ['scheduled', 'postponed'].includes(item.status)).slice(0, 8);
    const lines = active.map(item => {
        const people = item.participants.length ? `; participants: ${item.participants.join(', ')}` : '';
        const place = item.location ? `; location: ${item.location}` : '';
        const notes = item.notes ? `; note: ${item.notes.slice(0, 240)}` : '';
        return `- [${item.type}; ${item.status}] ${item.title} — ${formatTimeExpression(item.time, state.profileId)}${people}${place}${notes}`;
    });
    const newestGrantByCommitment = new Map();
    for (const grant of [...state.reconciliationGrants].reverse()) {
        if (!storySyncEnabled) break;
        if (!isReconciliationGrantUsed(grant, chat) && !newestGrantByCommitment.has(grant.commitmentId)) {
            newestGrantByCommitment.set(grant.commitmentId, grant);
        }
    }
    const reconciliationCues = [...newestGrantByCommitment.values()]
        .map(grant => {
            const commitment = state.commitments.find(item => item.id === grant.commitmentId);
            if (!commitment || !['missed', 'cancelled'].includes(commitment.status)) return '';
            const hasSuccessor = state.commitments.some(item => (
                item.lineage?.relation === 'rescheduled-from'
                && item.lineage.commitmentId === commitment.id
            ));
            if (hasSuccessor) return null;
            const dormant = isReconciliationGrantExpired(grant, chat);
            return {
                dormant,
                text: dormant
                    ? buildDormantCalendarReconciliationCue(commitment, grant)
                    : buildCalendarReconciliationCue(
                        commitment,
                        grant,
                        formatTimeExpression(commitment.time, state.profileId),
                        surfaceLabel,
                    ),
            };
        })
        .filter(Boolean);
    const pendingCues = [
        ...reconciliationCues.filter(item => !item.dormant).slice(0, 4),
        ...reconciliationCues.filter(item => item.dormant).slice(0, 4),
    ].map(item => item.text).filter(Boolean);
    const storyCreationCue = storySyncEnabled
        ? buildCalendarStoryCreationCue(state.storyCreationGrants.at(-1), surfaceLabel)
        : '';
    const sections = [];
    if (active.length) {
        sections.push([
            `[Planned ${surface.entryPluralLabel || 'commitments'} visible to the active persona in ${surfaceLabel}. These are intentions and obligations, not proof that an outcome occurred. Do not mark them completed, missed, cancelled, or fulfilled unless the story establishes it.]`,
            ...lines,
        ].join('\n'));
    }
    const contextBoundary = String(
        surface.prompt?.contextBoundary
        || surface.modelBehavior?.rules?.[0]
        || '',
    ).trim();
    const behaviorContract = contextBoundary
        ? `[${surface.title || surface.label || 'Calendar'} context boundary]\n${contextBoundary}`
        : '';
    if (behaviorContract && (active.length || pendingCues.length)) {
        sections.unshift(behaviorContract);
    }
    if (pendingCues.length) sections.push(pendingCues.join('\n'));
    if (storyCreationCue) sections.push(storyCreationCue);
    return sections.join('\n\n');
}

function clearInjection() {
    if (extension_prompts[PROMPT_KEY]) delete extension_prompts[PROMPT_KEY];
}

export function syncCommitmentInjection() {
    // Calendar context belongs to the SuperAgents execution set. When every
    // agent is genuinely disabled, remove this independently-owned prompt too;
    // Pause All intentionally leaves enabled flags intact and keeps the frozen
    // context snapshot available.
    if (getEnabledAgents().length === 0) { clearInjection(); return; }
    const text = buildInjection();
    if (!text) { clearInjection(); return; }
    setExtensionPrompt(PROMPT_KEY, substituteParams(text), 1, 0, false, 0);
}

export function onCommitmentsChanged(listener) {
    if (typeof listener !== 'function') return () => {};
    changeListeners.push(listener);
    return () => {
        const index = changeListeners.indexOf(listener);
        if (index >= 0) changeListeners.splice(index, 1);
    };
}

export function onCommitmentActivity(listener) {
    if (typeof listener !== 'function') return () => {};
    activityListeners.push(listener);
    return () => {
        const index = activityListeners.indexOf(listener);
        if (index >= 0) activityListeners.splice(index, 1);
    };
}

export function createCommitmentsIntegrationApi() {
    return Object.freeze({
        apiVersion: COMMITMENTS_API_VERSION,
        canReconcileStory: () => getGlobalSettings().calendarStorySync !== false,
        authorizeReconciliation: (commitmentId, options = {}) => clone(
            authorizeCalendarReconciliation(commitmentId, options),
        ),
        listProfiles: () => clone(listCommitmentProfiles()),
        getProfile: () => clone(getCommitmentProfile(getCommitmentProfileId())),
        setProfile: profileId => setCommitmentProfile(profileId),
        list: (options = {}) => clone(listCommitments(options)),
        get: (commitmentId, options = {}) => clone(getCommitment(commitmentId, options)),
        create: (input = {}, options = {}) => clone(createCommitment({ ...input, source: 'external' }, options)),
        update: (commitmentId, patch = {}, options = {}) => clone(updateCommitment(commitmentId, patch, options)),
        setStatus: (commitmentId, status, options = {}) => clone(setCommitmentStatus(commitmentId, status, options)),
        remove: (commitmentId, options = {}) => removeCommitment(commitmentId, options),
    });
}

export function initCommitments() {
    if (initialized) return;
    initialized = true;
    eventSource.on(event_types.GENERATION_AFTER_COMMANDS, () => {
        ensureStoryCreationGrant();
        syncCommitmentInjection();
    });
    eventSource.on(event_types.MESSAGE_RECEIVED, processCalendarReconciliation);
    eventSource.on(event_types.CHAT_CHANGED, () => {
        clearInjection();
        migrateReconciliationWindows();
        const restored = restoreCurrentBranchReconciliationWindows('calendar-chat-restore');
        const creationGrantCreated = ensureStoryCreationGrant();
        syncCommitmentInjection();
        notifyChanged({ kind: 'chat-changed', reconciliationRestored: restored, creationGrantCreated });
    });
    if (event_types.MESSAGE_SWIPED) {
        eventSource.on(event_types.MESSAGE_SWIPED, () => {
            const restored = restoreCurrentBranchReconciliationWindows('calendar-swipe-restore');
            const creationGrantCreated = ensureStoryCreationGrant();
            syncCommitmentInjection();
            notifyChanged({ kind: 'branch-changed', reconciliationRestored: restored, creationGrantCreated });
        });
    }
    if (event_types.MESSAGE_DELETED) {
        eventSource.on(event_types.MESSAGE_DELETED, () => {
            const restored = restoreCurrentBranchReconciliationWindows('calendar-deletion-restore');
            const creationGrantCreated = ensureStoryCreationGrant();
            syncCommitmentInjection();
            notifyChanged({
                kind: 'branch-changed',
                cause: 'message-deleted',
                reconciliationRestored: restored,
                creationGrantCreated,
            });
        });
    }
    migrateReconciliationWindows();
    restoreCurrentBranchReconciliationWindows('calendar-startup-restore');
    ensureStoryCreationGrant();
    syncCommitmentInjection();
    debug(`${LOG_PREFIX} branch-aware commitments initialized`);
}
