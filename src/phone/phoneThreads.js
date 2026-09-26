/** Pure branch and unread helpers for chat-scoped Phone threads. */

import { cloneBranchPath, compactBranchPath, isBranchPathVisible, resolveChatBranch } from '../core/branchPath.js';

function activeSwipeId(message) {
    const value = Number(message?.swipe_id ?? 0);
    return Number.isInteger(value) && value >= 0 ? value : 0;
}

export function resolvePhoneBranch(chat, options = {}) {
    return resolveChatBranch(chat, options);
}

export function stampPhoneMessage(message, branch) {
    return {
        ...message,
        messageIndex: branch?.messageIndex ?? null,
        swipeId: branch?.swipeId ?? null,
        branchPath: cloneBranchPath(branch?.branchPath),
    };
}

export function isPhoneMessageVisible(message, chat, options = {}, currentPath = null) {
    const storedPath = compactBranchPath(message?.branchPath);
    if (storedPath) {
        const resolvedPath = currentPath || resolvePhoneBranch(chat, options).branchPath;
        return isBranchPathVisible(storedPath, resolvedPath);
    }

    // Pre-v4 user/reply texts were unanchored. Keep them universal so an
    // upgrade never makes an existing conversation disappear.
    if (message?.messageIndex == null || !Number.isInteger(Number(message.messageIndex))) return true;
    const index = Number(message.messageIndex);
    if (!Array.isArray(chat) || index < 0 || index >= chat.length) return false;
    return activeSwipeId(chat[index]) === Number(message.swipeId ?? 0);
}

export function normalizePhoneThread(thread = {}) {
    const messages = Array.isArray(thread.messages)
        ? thread.messages.map(message => ({
            ...message,
            branchPath: compactBranchPath(message.branchPath),
        }))
        : [];
    const explicitUnread = messages.filter(message => message.unread === true).length;
    let legacyUnread = Math.max(0, Number(thread.unread || 0) - explicitUnread);

    for (let index = messages.length - 1; index >= 0; index--) {
        const message = messages[index];
        if (typeof message.unread === 'boolean') continue;
        const shouldBeUnread = message.from === 'char' && legacyUnread > 0;
        message.unread = shouldBeUnread;
        if (shouldBeUnread) legacyUnread--;
    }

    return {
        ...thread,
        characterId: thread.characterId ?? null,
        messages,
        unread: messages.filter(message => message.unread === true).length,
        lastActivity: Number(thread.lastActivity || 0),
    };
}

export function projectPhoneThread(thread, chat, options = {}) {
    const normalized = normalizePhoneThread(thread);
    const currentPath = compactBranchPath(resolvePhoneBranch(chat, options).branchPath);
    const messages = normalized.messages.filter(message => (
        isPhoneMessageVisible(message, chat, options, currentPath)
    ));
    return {
        ...normalized,
        messages,
        unread: messages.filter(message => message.unread === true).length,
    };
}

export function markVisiblePhoneMessagesRead(thread, chat, options = {}) {
    const normalized = normalizePhoneThread(thread);
    const currentPath = compactBranchPath(resolvePhoneBranch(chat, options).branchPath);
    for (const message of normalized.messages) {
        if (isPhoneMessageVisible(message, chat, options, currentPath)) message.unread = false;
    }
    normalized.unread = normalized.messages.filter(message => message.unread === true).length;
    return normalized;
}

export function clearVisiblePhoneMessages(thread, chat, options = {}) {
    const normalized = normalizePhoneThread(thread);
    const currentPath = compactBranchPath(resolvePhoneBranch(chat, options).branchPath);
    normalized.messages = normalized.messages.filter(
        message => !isPhoneMessageVisible(message, chat, options, currentPath),
    );
    normalized.unread = normalized.messages.filter(message => message.unread === true).length;
    normalized.lastActivity = Date.now();
    return normalized;
}
