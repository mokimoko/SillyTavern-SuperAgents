/** Pure branch, normalization, unread, and projection helpers for the social Feed. */

import { cloneBranchPath, compactBranchPath, isBranchPathVisible, resolveChatBranch } from '../core/branchPath.js';

function activeSwipeId(message) {
    const value = Number(message?.swipe_id ?? 0);
    return Number.isInteger(value) && value >= 0 ? value : 0;
}

export function resolveFeedBranch(chat, options = {}) {
    return resolveChatBranch(chat, options);
}

export function stampFeedEntry(entry, branch) {
    return {
        ...entry,
        messageIndex: branch?.messageIndex ?? null,
        swipeId: branch?.swipeId ?? null,
        branchPath: cloneBranchPath(branch?.branchPath),
    };
}

export function isFeedEntryVisible(entry, chat, options = {}, currentPath = null) {
    const storedPath = compactBranchPath(entry?.branchPath);
    if (storedPath) {
        const resolvedPath = currentPath || resolveFeedBranch(chat, options).branchPath;
        return isBranchPathVisible(storedPath, resolvedPath);
    }

    // Legacy/unanchored entries remain universal after upgrading.
    if (entry?.messageIndex == null || !Number.isInteger(Number(entry.messageIndex))) return true;
    const index = Number(entry.messageIndex);
    if (!Array.isArray(chat) || index < 0 || index >= chat.length) return false;
    return activeSwipeId(chat[index]) === Number(entry.swipeId ?? 0);
}

function cleanText(value, maxLength = 2000) {
    return String(value ?? '').trim().slice(0, maxLength);
}

function normalizeComment(comment = {}) {
    return {
        ...comment,
        id: cleanText(comment.id, 120) || `comment_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        author: cleanText(comment.author, 120) || 'Unknown',
        content: cleanText(comment.content ?? comment.text, 1000),
        timestamp: Number(comment.timestamp || Date.now()),
        source: comment.source === 'user' ? 'user' : 'generated',
        branchPath: compactBranchPath(comment.branchPath),
    };
}

function normalizeReaction(reaction = {}) {
    return {
        ...reaction,
        id: cleanText(reaction.id, 120) || `reaction_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        author: cleanText(reaction.author, 120) || 'Unknown',
        kind: cleanText(reaction.kind, 40) || 'heart',
        timestamp: Number(reaction.timestamp || Date.now()),
        branchPath: compactBranchPath(reaction.branchPath),
    };
}

export function normalizeFeedPost(post = {}) {
    return {
        ...post,
        id: cleanText(post.id, 120) || `post_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        author: cleanText(post.author, 120) || 'Unknown',
        content: cleanText(post.content ?? post.text, 4000),
        audience: ['public', 'shared', 'selected'].includes(post.audience) ? post.audience : 'shared',
        timestamp: Number(post.timestamp || Date.now()),
        unread: post.unread === true,
        source: post.source === 'user' ? 'user' : 'generated',
        continuity: cleanText(post.continuity, 1000),
        comments: Array.isArray(post.comments) ? post.comments.map(normalizeComment) : [],
        reactions: Array.isArray(post.reactions) ? post.reactions.map(normalizeReaction) : [],
        branchPath: compactBranchPath(post.branchPath),
    };
}

export function normalizeFeedState(state = {}) {
    const posts = Array.isArray(state.posts) ? state.posts.map(normalizeFeedPost) : [];
    return {
        ...state,
        version: 1,
        posts,
        lastActivity: Number(state.lastActivity || 0),
    };
}

export function projectFeedState(state, chat, options = {}) {
    const normalized = normalizeFeedState(state);
    const currentPath = compactBranchPath(resolveFeedBranch(chat, options).branchPath);
    const posts = normalized.posts
        .filter(post => isFeedEntryVisible(post, chat, options, currentPath))
        .map(post => ({
            ...post,
            comments: post.comments.filter(comment => isFeedEntryVisible(comment, chat, options, currentPath)),
            reactions: post.reactions.filter(reaction => isFeedEntryVisible(reaction, chat, options, currentPath)),
        }));
    return {
        ...normalized,
        posts,
        unread: posts.filter(post => post.unread).length,
    };
}

export function markVisibleFeedRead(state, chat, options = {}) {
    const normalized = normalizeFeedState(state);
    const currentPath = compactBranchPath(resolveFeedBranch(chat, options).branchPath);
    for (const post of normalized.posts) {
        if (isFeedEntryVisible(post, chat, options, currentPath)) post.unread = false;
    }
    return normalized;
}

export function clearVisibleFeed(state, chat, options = {}) {
    const normalized = normalizeFeedState(state);
    const currentPath = compactBranchPath(resolveFeedBranch(chat, options).branchPath);
    normalized.posts = normalized.posts.filter(post => (
        !isFeedEntryVisible(post, chat, options, currentPath)
    ));
    normalized.lastActivity = Date.now();
    return normalized;
}
