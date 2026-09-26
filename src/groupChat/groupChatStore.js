/** Chat-scoped, bounded persistence for the Group Chat utility. */

import { chat_metadata, saveChatDebounced } from '../../../../../../script.js';

const ROOM_VAR = 'sa_group_chat_room_v1';

export const GROUP_CHAT_LIMITS = Object.freeze({
    activeMessages: 30,
    archiveCount: 20,
    retainedMessages: 10,
    roomSummaries: 5,
});

const DEFAULT_SETTINGS = Object.freeze({
    autoEnabled: false,
    connectionProfile: '',
    baseInterval: 5,
    jitterMax: 5,
    recentStoryMessages: 5,
    maxWriters: 2,
    maxMessagesPerWriter: 2,
    storyRepliesSinceAuto: 0,
    nextAutoAt: 0,
});

function cleanText(value, max = 12000) {
    return String(value ?? '').replace(/\r/g, '').trim().slice(0, max);
}

function numberInRange(value, fallback, min, max) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.round(parsed))) : fallback;
}

function normalizeMessage(message = {}) {
    const role = ['user', 'writer', 'system', 'warning'].includes(message.role) ? message.role : 'system';
    return {
        id: cleanText(message.id, 140) || `gc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        role,
        speaker: cleanText(message.speaker, 160),
        character: cleanText(message.character, 160),
        text: cleanText(message.text, 6000),
        replyTo: cleanText(message.replyTo, 160),
        timestamp: Number(message.timestamp) || Date.now(),
        storyMessageIndex: Number.isInteger(Number(message.storyMessageIndex))
            ? Number(message.storyMessageIndex)
            : null,
    };
}

function normalizeKnowledge(knowledge = {}) {
    const data = knowledge.data && typeof knowledge.data === 'object' && !Array.isArray(knowledge.data)
        ? knowledge.data
        : null;
    return {
        status: ['missing', 'building', 'current', 'degraded'].includes(knowledge.status)
            ? knowledge.status
            : (data ? 'current' : 'missing'),
        fingerprint: cleanText(knowledge.fingerprint, 240),
        builtAt: Number(knowledge.builtAt) || 0,
        data,
        error: cleanText(knowledge.error, 1000),
    };
}

function normalizeSettings(settings = {}) {
    return {
        autoEnabled: Boolean(settings.autoEnabled),
        connectionProfile: cleanText(settings.connectionProfile, 240),
        baseInterval: numberInRange(settings.baseInterval, DEFAULT_SETTINGS.baseInterval, 1, 50),
        jitterMax: numberInRange(settings.jitterMax, DEFAULT_SETTINGS.jitterMax, 0, 10),
        recentStoryMessages: numberInRange(settings.recentStoryMessages, DEFAULT_SETTINGS.recentStoryMessages, 1, 20),
        maxWriters: numberInRange(settings.maxWriters, DEFAULT_SETTINGS.maxWriters, 1, 2),
        maxMessagesPerWriter: numberInRange(settings.maxMessagesPerWriter, DEFAULT_SETTINGS.maxMessagesPerWriter, 1, 2),
        storyRepliesSinceAuto: Math.max(0, Number(settings.storyRepliesSinceAuto) || 0),
        nextAutoAt: Math.max(0, Number(settings.nextAutoAt) || 0),
    };
}

export function createEmptyRoom() {
    return {
        version: 1,
        knowledge: normalizeKnowledge(),
        messages: [],
        summaries: [],
        historicalSummary: '',
        settings: { ...DEFAULT_SETTINGS },
        unread: 0,
        started: false,
        lastActivity: 0,
    };
}

export function normalizeRoom(room = {}) {
    return {
        version: 1,
        knowledge: normalizeKnowledge(room.knowledge),
        messages: Array.isArray(room.messages)
            ? room.messages.map(normalizeMessage).filter(message => message.text).slice(-60)
            : [],
        summaries: Array.isArray(room.summaries)
            ? room.summaries.map(value => cleanText(value, 5000)).filter(Boolean).slice(-GROUP_CHAT_LIMITS.roomSummaries)
            : [],
        historicalSummary: cleanText(room.historicalSummary, 7000),
        settings: normalizeSettings(room.settings),
        unread: Math.max(0, Number(room.unread) || 0),
        started: Boolean(room.started),
        lastActivity: Number(room.lastActivity) || 0,
    };
}

export function readGroupChatRoom() {
    try {
        const raw = chat_metadata?.variables?.[ROOM_VAR];
        return normalizeRoom(raw ? JSON.parse(raw) : createEmptyRoom());
    } catch {
        return createEmptyRoom();
    }
}

export function writeGroupChatRoom(room, { save = true } = {}) {
    const normalized = normalizeRoom(room);
    if (!chat_metadata.variables || typeof chat_metadata.variables !== 'object') chat_metadata.variables = {};
    chat_metadata.variables[ROOM_VAR] = JSON.stringify(normalized);
    if (save) saveChatDebounced();
    return normalized;
}

export function updateGroupChatRoom(mutator, options) {
    const room = readGroupChatRoom();
    const result = mutator(room) || room;
    return writeGroupChatRoom(result, options);
}

export function appendGroupChatMessages(messages, { unread = false } = {}) {
    const incoming = (Array.isArray(messages) ? messages : [messages])
        .map(normalizeMessage)
        .filter(message => message.text);
    if (!incoming.length) return readGroupChatRoom();
    return updateGroupChatRoom(room => {
        room.messages.push(...incoming);
        room.lastActivity = Date.now();
        room.started = true;
        if (unread) room.unread += incoming.filter(message => message.role === 'writer').length;
        return room;
    });
}

export function markGroupChatRead() {
    return updateGroupChatRoom(room => {
        room.unread = 0;
        return room;
    });
}

export function setGroupChatSettings(partial = {}) {
    return updateGroupChatRoom(room => {
        room.settings = normalizeSettings({ ...room.settings, ...partial });
        return room;
    });
}

export function commitGroupChatArchive({ summary, historicalSummary = null }) {
    return updateGroupChatRoom(room => {
        room.messages = room.messages.slice(-GROUP_CHAT_LIMITS.retainedMessages);
        if (historicalSummary != null) {
            room.historicalSummary = cleanText(historicalSummary, 7000);
            room.summaries = [];
        } else if (summary) {
            room.summaries.push(cleanText(summary, 5000));
        }
        room.summaries = room.summaries.slice(-GROUP_CHAT_LIMITS.roomSummaries);
        return room;
    });
}

export function wipeGroupChatMemory() {
    return updateGroupChatRoom(room => {
        room.messages = [];
        room.summaries = [];
        room.historicalSummary = '';
        room.unread = 0;
        room.started = false;
        room.lastActivity = 0;
        room.settings.storyRepliesSinceAuto = 0;
        room.settings.nextAutoAt = 0;
        return room;
    });
}
