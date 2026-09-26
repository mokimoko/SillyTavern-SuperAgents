/** Pure normalization, retention, branch projection, and unread helpers. */

import { normalizeTimeExpression, timeExpressionOrder } from './timeExpressions.js';
import {
    branchPathLength,
    cloneBranchPath,
    compactBranchPath,
    isBranchPathVisible,
} from '../core/branchPath.js';

export const COMMITMENT_STATE_VERSION = 3;
export const MAX_COMMITMENTS = 120;
export const MAX_RECONCILIATION_GRANTS = 40;
export const MAX_STORY_CREATION_GRANTS = 16;
export const RECONCILIATION_MESSAGE_WINDOW = 16;

export const COMMITMENT_TYPES = Object.freeze([
    'appointment',
    'promise',
    'deadline',
    'reminder',
    'availability',
    'obligation',
]);

export const COMMITMENT_STATUSES = Object.freeze([
    'scheduled',
    'postponed',
    'completed',
    'missed',
    'cancelled',
]);

function cleanText(value, maxLength = 1000) {
    return String(value ?? '').trim().slice(0, maxLength);
}

function cleanList(value, maxItems = 16) {
    const source = Array.isArray(value) ? value : String(value ?? '').split(',');
    return source.map(item => cleanText(item, 120)).filter(Boolean).slice(0, maxItems);
}

function activeSwipeId(message) {
    const value = Number(message?.swipe_id ?? 0);
    return Number.isInteger(value) && value >= 0 ? value : 0;
}

export function resolveCommitmentBranch(chat, options = {}) {
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

export function stampCommitment(entry, branch) {
    return {
        ...entry,
        messageIndex: branch?.messageIndex ?? null,
        swipeId: branch?.swipeId ?? null,
        branchPath: cloneBranchPath(branch?.branchPath),
    };
}

export function isCommitmentVisible(entry, chat, options = {}, currentPath = null) {
    const storedPath = compactBranchPath(entry?.branchPath);
    if (storedPath) {
        const resolvedPath = currentPath || resolveCommitmentBranch(chat, options).branchPath;
        return isBranchPathVisible(storedPath, resolvedPath);
    }
    if (entry?.messageIndex == null || !Number.isInteger(Number(entry.messageIndex))) return true;
    const index = Number(entry.messageIndex);
    if (!Array.isArray(chat) || index < 0 || index >= chat.length) return false;
    return activeSwipeId(chat[index]) === Number(entry.swipeId ?? 0);
}

export function isReconciliationGrantUsed(grant, chat, options = {}) {
    const currentPath = compactBranchPath(resolveCommitmentBranch(chat, options).branchPath);
    return Array.isArray(grant?.uses)
        && grant.uses.some(use => isCommitmentVisible(use, chat, options, currentPath));
}

export function isReconciliationGrantExpired(grant, chat, options = {}) {
    if (grant?.messageIndex == null || !Number.isInteger(Number(grant.messageIndex))) return false;
    const currentIndex = resolveCommitmentBranch(chat, options).messageIndex;
    return currentIndex != null
        && currentIndex - Number(grant.messageIndex) > RECONCILIATION_MESSAGE_WINDOW;
}

export function normalizeCommitment(input = {}) {
    const createdAt = Number(input.createdAt || Date.now());
    const updatedAt = Number(input.updatedAt || createdAt);
    const type = COMMITMENT_TYPES.includes(input.type) ? input.type : 'appointment';
    const status = COMMITMENT_STATUSES.includes(input.status) ? input.status : 'scheduled';
    const visibility = ['persona', 'shared', 'public'].includes(input.visibility)
        ? input.visibility
        : 'persona';
    const source = ['user', 'external', 'generated'].includes(input.source) ? input.source : 'user';
    const branchPath = compactBranchPath(input.branchPath);
    const rawLineage = input.lineage && typeof input.lineage === 'object' ? input.lineage : {};
    const lineage = cleanText(rawLineage.relation, 80) === 'rescheduled-from'
        ? {
            relation: 'rescheduled-from',
            commitmentId: cleanText(rawLineage.commitmentId, 160),
            title: cleanText(rawLineage.title, 240),
        }
        : null;
    return {
        id: cleanText(input.id, 160) || `commitment_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        title: cleanText(input.title, 240) || 'Untitled commitment',
        type,
        status,
        participants: cleanList(input.participants),
        location: cleanText(input.location, 240),
        notes: cleanText(input.notes, 2000),
        visibility,
        time: normalizeTimeExpression(input.time ?? input.schedule),
        source,
        unread: input.unread === true,
        notification: input.notification === true,
        createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
        updatedAt: Number.isFinite(updatedAt) ? updatedAt : Date.now(),
        messageIndex: input.messageIndex != null && Number.isInteger(Number(input.messageIndex))
            ? Math.max(0, Number(input.messageIndex))
            : null,
        swipeId: input.swipeId != null && Number.isInteger(Number(input.swipeId))
            ? Math.max(0, Number(input.swipeId))
            : null,
        branchPath,
        lineage,
    };
}

export function normalizeCommitmentState(state = {}) {
    const commitments = Array.isArray(state.commitments)
        ? state.commitments.map(normalizeCommitment).slice(-MAX_COMMITMENTS)
        : [];
    return {
        version: COMMITMENT_STATE_VERSION,
        profileId: cleanText(state.profileId, 80) || 'modern',
        commitments,
        reconciliationGrants: Array.isArray(state.reconciliationGrants)
            ? state.reconciliationGrants.map(grant => ({
                token: cleanText(grant?.token, 200),
                commitmentId: cleanText(grant?.commitmentId, 160),
                source: cleanText(grant?.source, 240),
                createdAt: Number(grant?.createdAt || 0),
                messageIndex: grant?.messageIndex != null && Number.isInteger(Number(grant.messageIndex))
                    ? Math.max(0, Number(grant.messageIndex))
                    : null,
                swipeId: grant?.swipeId != null && Number.isInteger(Number(grant.swipeId))
                    ? Math.max(0, Number(grant.swipeId))
                    : null,
                branchPath: compactBranchPath(grant?.branchPath),
                uses: Array.isArray(grant?.uses)
                    ? grant.uses.map(use => ({
                        usedAt: Number(use?.usedAt || 0),
                        messageIndex: use?.messageIndex != null && Number.isInteger(Number(use.messageIndex))
                            ? Math.max(0, Number(use.messageIndex))
                            : null,
                        swipeId: use?.swipeId != null && Number.isInteger(Number(use.swipeId))
                            ? Math.max(0, Number(use.swipeId))
                            : null,
                        branchPath: compactBranchPath(use?.branchPath),
                    })).filter(use => use.messageIndex != null || branchPathLength(use.branchPath) > 0).slice(-8)
                    : [],
            })).filter(grant => grant.token && grant.commitmentId).slice(-MAX_RECONCILIATION_GRANTS)
            : [],
        storyCreationGrants: Array.isArray(state.storyCreationGrants)
            ? state.storyCreationGrants.map(grant => ({
                token: cleanText(grant?.token, 200),
                createdAt: Number(grant?.createdAt || 0),
                messageIndex: grant?.messageIndex != null && Number.isInteger(Number(grant.messageIndex))
                    ? Math.max(0, Number(grant.messageIndex))
                    : null,
                swipeId: grant?.swipeId != null && Number.isInteger(Number(grant.swipeId))
                    ? Math.max(0, Number(grant.swipeId))
                    : null,
                branchPath: compactBranchPath(grant?.branchPath),
                uses: Array.isArray(grant?.uses)
                    ? grant.uses.map(use => ({
                        usedAt: Number(use?.usedAt || 0),
                        messageIndex: use?.messageIndex != null && Number.isInteger(Number(use.messageIndex))
                            ? Math.max(0, Number(use.messageIndex))
                            : null,
                        swipeId: use?.swipeId != null && Number.isInteger(Number(use.swipeId))
                            ? Math.max(0, Number(use.swipeId))
                            : null,
                        branchPath: compactBranchPath(use?.branchPath),
                    })).filter(use => use.messageIndex != null || branchPathLength(use.branchPath) > 0).slice(-MAX_COMMITMENTS)
                    : [],
            })).filter(grant => grant.token).slice(-MAX_STORY_CREATION_GRANTS)
            : [],
        lastActivity: Number(state.lastActivity || 0),
    };
}

export function projectCommitmentState(state, chat, options = {}) {
    const normalized = normalizeCommitmentState(state);
    const currentPath = compactBranchPath(resolveCommitmentBranch(chat, options).branchPath);
    const commitments = normalized.commitments.filter(item => (
        isCommitmentVisible(item, chat, options, currentPath)
    ));
    return {
        ...normalized,
        commitments,
        reconciliationGrants: normalized.reconciliationGrants
            .filter(grant => isCommitmentVisible(grant, chat, options, currentPath)),
        storyCreationGrants: normalized.storyCreationGrants
            .filter(grant => isCommitmentVisible(grant, chat, options, currentPath)),
        unread: commitments.filter(item => item.notification && item.unread).length,
    };
}

export function upsertCommitment(state, input) {
    const normalized = normalizeCommitmentState(state);
    const commitment = normalizeCommitment(input);
    const index = normalized.commitments.findIndex(item => item.id === commitment.id);
    const created = index < 0;
    if (created) normalized.commitments.push(commitment);
    else normalized.commitments[index] = commitment;
    normalized.commitments = normalized.commitments.slice(-MAX_COMMITMENTS);
    normalized.lastActivity = Math.max(normalized.lastActivity, commitment.updatedAt, Date.now());
    return { state: normalized, commitment, created };
}

export function removeCommitment(state, id) {
    const normalized = normalizeCommitmentState(state);
    normalized.commitments = normalized.commitments.filter(item => item.id !== id);
    normalized.lastActivity = Date.now();
    return normalized;
}

export function markCommitmentsRead(state, ids = []) {
    const normalized = normalizeCommitmentState(state);
    const selected = new Set(cleanList(ids, MAX_COMMITMENTS));
    for (const commitment of normalized.commitments) {
        if (!selected.size || selected.has(commitment.id)) commitment.unread = false;
    }
    return normalized;
}

export function markVisibleCommitmentsRead(state, chat, options = {}) {
    const normalized = normalizeCommitmentState(state);
    const currentPath = compactBranchPath(resolveCommitmentBranch(chat, options).branchPath);
    for (const commitment of normalized.commitments) {
        if (isCommitmentVisible(commitment, chat, options, currentPath)) commitment.unread = false;
    }
    return normalized;
}

export function compareCommitments(left, right) {
    const leftActive = ['scheduled', 'postponed'].includes(left.status);
    const rightActive = ['scheduled', 'postponed'].includes(right.status);
    if (leftActive !== rightActive) return leftActive ? -1 : 1;
    const leftOrder = timeExpressionOrder(left.time);
    const rightOrder = timeExpressionOrder(right.time);
    if (leftOrder !== rightOrder) {
        if (Number.isFinite(leftOrder) && !Number.isFinite(rightOrder)) return -1;
        if (!Number.isFinite(leftOrder) && Number.isFinite(rightOrder)) return 1;
        if (Number.isFinite(leftOrder - rightOrder)) return leftOrder - rightOrder;
    }
    return Number(right.updatedAt || 0) - Number(left.updatedAt || 0);
}
