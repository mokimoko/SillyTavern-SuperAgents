/** Provider orchestration, knowledge lifecycle, and auto mode for Group Chat. */

import { eventSource, event_types } from '../../../../../../script.js';
import { debug } from '../core/runtime.js';
import { callAgentLLM, isAbortError } from '../core/llm.js';
import { beginSelfGeneration, endSelfGeneration } from '../core/compatibility.js';
import { extractJsonObjectCandidates } from '../data/structuredOutput.js';
import { getEffectiveConnectionProfile, getGlobalSettings } from '../data/store.js';
import {
    appendGroupChatMessages,
    commitGroupChatArchive,
    GROUP_CHAT_LIMITS,
    markGroupChatRead,
    readGroupChatRoom,
    setGroupChatSettings,
    updateGroupChatRoom,
    wipeGroupChatMemory,
} from './groupChatStore.js';
import {
    buildBasicKnowledgeInput,
    buildRecentStoryContext,
    buildRoomMemory,
    getBasicKnowledgeFingerprint,
    getLiveWriters,
    getUserParticipant,
    latestStoryMessageIndex,
    mergeKnowledgeWriters,
    normalizeBasicKnowledge,
} from './groupChatContext.js';

const LOG_PREFIX = '[SuperAgents/groupChat]';
const listeners = new Set();

let initialized = false;
let visible = false;
let busy = false;
let chatEpoch = 0;
let activeController = null;
let knowledgePromise = null;
let turnPromise = null;
let archivePromise = null;
let activityPhase = 'idle';

function notify(kind, detail = {}) {
    const snapshot = readGroupChatRoom();
    for (const listener of listeners) {
        try { listener({ kind, room: snapshot, ...detail }); } catch { /* UI listeners are optional. */ }
    }
}

function setActivity(phase, detail = {}) {
    activityPhase = phase;
    notify('activity', { phase, ...detail });
}

function id(prefix) {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function nextAutoThreshold(settings) {
    const jitter = settings.jitterMax > 0 ? 1 + Math.floor(Math.random() * settings.jitterMax) : 0;
    return settings.baseInterval + jitter;
}

async function providerCall(options, epoch) {
    if (epoch !== chatEpoch) throw new Error('chat changed');
    const controller = new AbortController();
    activeController = controller;
    beginSelfGeneration();
    try {
        const roomOverride = readGroupChatRoom().settings.connectionProfile || '';
        const profileRef = getEffectiveConnectionProfile(roomOverride);
        return await callAgentLLM({ ...options, profileRef, signal: controller.signal });
    } finally {
        endSelfGeneration();
        if (activeController === controller) activeController = null;
    }
}

function findPayload(response, predicate) {
    const candidates = extractJsonObjectCandidates(response);
    for (let index = candidates.length - 1; index >= 0; index--) {
        if (predicate(candidates[index])) return candidates[index];
    }
    return null;
}

export function getGroupChatWriters() {
    const room = readGroupChatRoom();
    return mergeKnowledgeWriters(getLiveWriters(), room.knowledge.data);
}

export function getGroupChatUnread() {
    return readGroupChatRoom().unread;
}

export function isGroupChatBusy() {
    return busy || !!knowledgePromise || !!archivePromise;
}

export function getGroupChatActivity() {
    return activityPhase;
}

export function isGroupChatAvailable() {
    return getGlobalSettings().groupChatEnabled !== false;
}

export function setGroupChatVisible(nextVisible) {
    visible = Boolean(nextVisible);
    if (visible) {
        markGroupChatRead();
        notify('read');
    }
}

export function onGroupChatChange(listener) {
    if (typeof listener !== 'function') return () => {};
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export async function ensureBasicKnowledge({ force = false } = {}) {
    if (knowledgePromise) return knowledgePromise;
    const room = readGroupChatRoom();
    const fingerprint = getBasicKnowledgeFingerprint();
    if (!force && room.knowledge.data && room.knowledge.fingerprint === fingerprint) return room.knowledge;

    const epoch = chatEpoch;
    knowledgePromise = (async () => {
        updateGroupChatRoom(current => {
            current.knowledge.status = 'building';
            current.knowledge.error = '';
            return current;
        });
        setActivity('preparing-knowledge');

        const input = await buildBasicKnowledgeInput();
        setActivity('building-roster');
        const systemPrompt = `You prepare a compact roster and reference sheet for an out-of-character writers' room attached to an ongoing fictional story. Active character cards are ownership containers, not necessarily individual people: one card may describe several actual characters, and a short card title may describe a character whose full name appears in the story. Identify the actual non-user characters participating in or directly relevant to the current scene. Exclude the user's persona, people who are merely mentioned/background, and card/group titles that are not themselves characters. Assign every character to the exact active card container responsible for them; multiple characters may use the same sourceCard. Do not output a card title as a second character when it is only an alias or container for a more specific character. Distinguish public observations from information that character's writer knows.

Invent a stable OOC co-writer identity for each character. Each writer is a present-day person outside the fiction, not an echo of their character. Contrast the writer with one or two of the character's strongest traits in an interesting way—for example, a solemn character might have an unserious writer, or a reckless character a nervous planner. Do not mechanically reverse every trait.

Make each writerProfile a short, usable texting instinct rather than a biography or checklist. Capture how this friend sounds when relaxed, what reliably amuses or annoys them, how they tend to react to the other writers, and any natural habits such as lowercase, fragments, emoji, slang, memes, blunt questions, deadpan replies, teasing, or melodrama. Give different writers different rhythms. These are tendencies, not catchphrases or requirements to perform every turn. Do not make everyone snarky, chaotic, hyper-online, or equally invested in craft analysis. Never copy the character's age, body, occupation, relationships, trauma, speech patterns, or circumstances onto the writer. Give every writer a unique, playful modern chat username that fits their OOC personality. It should be funny without being random noise, use 2–28 letters/numbers/underscores/dots/hyphens, contain no spaces, and omit the @ prefix. Preserve story uncertainty and canon without inventing facts. Be concise. Return one JSON object only with this exact shape: {"world":"concise setting and current situation","user":{"name":"name","profile":"narrator-level information about the user's persona"},"characters":[{"name":"exact current character name","sourceCard":"exact active card container title","username":"unique funny chat handle without @","aliases":["short name or nickname"],"publicProfile":"what observers can reasonably know","selfProfile":"concise private self-reference for this character's writer","writerProfile":"short distinct OOC texting identity with a character contrast, natural chat rhythm, likes or annoyances, and social habits"}]}.`;
        let data = input.fallback;
        let status = 'degraded';
        let error = '';

        try {
            const response = await providerCall({
                systemPrompt,
                userContent: `Build the reference sheet from the following canonical source material.\n\n${input.source}`,
                maxTokens: 2400,
                callerName: 'SuperAgents Group Chat knowledge',
            }, epoch);
            const payload = findPayload(response, candidate => Array.isArray(candidate.characters));
            if (!payload) throw new Error('The provider did not return a valid knowledge sheet.');
            data = normalizeBasicKnowledge(payload, input.fallback);
            status = 'current';
        } catch (err) {
            if (isAbortError(err) || epoch !== chatEpoch) throw err;
            error = String(err?.message || err);
            data = normalizeBasicKnowledge(input.fallback, input.fallback);
            console.warn(`${LOG_PREFIX} using a temporary local reference:`, err);
        }

        if (epoch !== chatEpoch) throw new Error('chat changed');
        const updated = updateGroupChatRoom(current => {
            current.knowledge = {
                status,
                fingerprint: input.fingerprint,
                builtAt: Date.now(),
                data,
                error,
            };
            return current;
        });
        notify(status === 'current' ? 'knowledge-ready' : 'knowledge-degraded');
        return updated.knowledge;
    })().catch(err => {
        if (!isAbortError(err) && epoch === chatEpoch) {
            updateGroupChatRoom(current => {
                current.knowledge.status = current.knowledge.data ? 'degraded' : 'missing';
                current.knowledge.error = String(err?.message || err);
                return current;
            });
            notify('knowledge-error', { error: err });
        }
        throw err;
    }).finally(() => {
        knowledgePromise = null;
        if (!busy && !archivePromise) setActivity('idle');
    });

    return knowledgePromise;
}

function compactKnowledgeForPrompt(knowledge) {
    return {
        world: String(knowledge?.world || '').slice(0, 4500),
        user: {
            name: String(knowledge?.user?.name || '').slice(0, 160),
            profile: String(knowledge?.user?.profile || '').slice(0, 2400),
        },
        characters: (knowledge?.characters || []).slice(0, 16).map(character => ({
            name: String(character.name || '').slice(0, 160),
            sourceCard: String(character.sourceCard || '').slice(0, 160),
            aliases: (character.aliases || []).slice(0, 8).map(alias => String(alias || '').slice(0, 160)),
            publicProfile: String(character.publicProfile || '').slice(0, 1400),
            selfProfile: String(character.selfProfile || '').slice(0, 2000),
            writerProfile: String(character.writerProfile || '').slice(0, 1000),
        })),
    };
}

function normalizeGeneratedMessages(payload, writers, settings) {
    const raw = Array.isArray(payload?.messages) ? payload.messages : [];
    const byName = new Map();
    for (const writer of writers) {
        for (const name of [writer.name, writer.writerName, ...(writer.aliases || [])]) {
            byName.set(String(name).toLowerCase(), writer);
        }
    }
    const speakerCounts = new Map();
    const selected = new Set();
    const output = [];

    for (const item of raw) {
        const requested = String(item?.character || item?.speaker || '').trim().replace(/[’']s Writer$/i, '');
        const writer = byName.get(requested.toLowerCase());
        const rawText = String(item?.text || item?.message || '').replace(/\r/g, '').trim();
        const text = rawText.length > 500 ? `${rawText.slice(0, 499).trimEnd()}…` : rawText;
        if (!writer || !text) continue;
        if (!selected.has(writer.name) && selected.size >= settings.maxWriters) continue;
        const count = speakerCounts.get(writer.name) || 0;
        if (count >= settings.maxMessagesPerWriter) continue;
        selected.add(writer.name);
        speakerCounts.set(writer.name, count + 1);
        output.push({
            id: id('gcw'),
            role: 'writer',
            speaker: writer.writerName,
            character: writer.name,
            text,
            replyTo: String(item?.replyTo || '').trim().slice(0, 160),
            timestamp: Date.now(),
            storyMessageIndex: latestStoryMessageIndex(),
        });
    }
    return output;
}

async function revealMessages(messages, epoch) {
    for (const message of messages) {
        if (epoch !== chatEpoch) return;
        activityPhase = 'typing';
        notify('typing', { character: message.character });
        await wait(520);
        if (epoch !== chatEpoch) return;
        appendGroupChatMessages(message, { unread: !visible });
        notify('message', { message });
        await wait(160);
    }
    notify('typing-end');
}

async function runRoomTurn({ userText = '', autonomous = false } = {}) {
    if (!isGroupChatAvailable()) throw new Error('Group Chat is disabled in SuperAgents Settings.');
    const epoch = chatEpoch;
    const opening = autonomous && !readGroupChatRoom().started;
    busy = true;
    setActivity('preparing-turn', { autonomous });
    try {
        await ensureBasicKnowledge();
        if (epoch !== chatEpoch) return [];
        const room = readGroupChatRoom();
        const writers = getGroupChatWriters();
        if (!writers.length) throw new Error('No character writers are available in this chat.');
        setActivity('preparing-turn', { autonomous });
        const recentStory = await buildRecentStoryContext(room.settings.recentStoryMessages);
        const available = writers.map(writer => {
            const aliases = writer.aliases?.length ? `; aliases: ${writer.aliases.join(', ')}` : '';
            return `- ${writer.name} (chat label: ${writer.writerName}; source card: ${writer.cardName || 'unknown'}${aliases})`;
        }).join('\n');
        const writerIdentities = writers.map(writer => (
            `- ${writer.writerName}: ${writer.writerProfile || `A distinct OOC co-writer responsible for ${writer.name}; never ${writer.name} themself.`}`
        )).join('\n');
        const directInstruction = userText
            ? `The user has just posted this room message:\n${userText}`
            : 'Start a natural autonomous writers’ room conversation about the newest story development. Do not wait for the user to ask a question.';
        const systemPrompt = `You are writing a messy, casual OOC group text among the human user and the fictional co-writers responsible for the story's characters. It should feel like Discord or a private friend chat, not a writing workshop, critique circle, assistant response, or polished scene analysis.

WRITER/CHARACTER SEPARATION IS NON-NEGOTIABLE:
- Every available speaker is the real-world-style WRITER behind the named character, never the character speaking in-world.
- A writer speaks as themself in first person but always refers to their character in third person by name or he/she/they. They may say "I wrote him to panic"; they must never say "I panicked" when describing the character.
- Never produce in-character dialogue, roleplay actions, stage directions, or physical/emotional reactions as though the writer has the character's body, history, relationships, or circumstances.
- The human user is likewise a fellow writer/player, not automatically the same person as the user persona described in story knowledge.

HOW THE ROOM SHOULD FEEL:
- React to the latest room message before reaching for story context. Do not paraphrase what someone just said or recap the scene for people who were already there.
- Most messages are quick and low-stakes: a fragment, blunt question, tiny correction, bad joke, emoji, "wait", "no", gossip, teasing, disbelief, or a reply to somebody else. A message does not need to be insightful, helpful, complete, or funny.
- Let the chat wander. Writers can latch onto a weird detail, misunderstand each other, pile onto a joke, change the subject, defend their blorbo, or briefly contribute nothing but a reaction. Do not force every turn back into narrative analysis.
- Use the supplied writerProfile as instinct, not a costume. Do not cram every listed trait into every response, repeat a signature gimmick, or give everyone the same snarky internet voice.
- Vary openings, punctuation, energy, and length from recent room messages. Do not repeat the same observation, joke structure, agreement, or advice already present in room memory.
- Emoji, slang, memes, pop-culture references, roasting, mock arguments, and dramatic rage-quits are welcome only when that particular writer would naturally use them. Do not force a punchline or conflict.
- Writers know their characters and may gossip about their choices, motives, secrets, and scenes, but they sound like friends texting—not critics presenting conclusions.
- One message is usually enough. A second bubble from the same writer should feel like an afterthought or comic follow-up, not paragraph two of an answer. Keep every bubble to one or two short sentences, never more than three, and under 320 characters.

RHYTHM EXAMPLES — imitate the looseness, never these exact lines:
- oh no he's about to make this everybody else's problem 💀
- wait. you gave HER the keys??
- don't look at me, i tried to stop her
- honestly let him cook
- 👀

AVOID:
- "I believe Rowan's recent behavior reveals an interesting conflict..." (formal analysis)
- "That was certainly an intense scene!" (generic recap)
- Three writers giving slightly different versions of the same reaction.

Never write a message as the user. Treat an @Name or @alias mention as a required responder when that writer exists. Choose only writers who have something different to add; silence is normal. Use at most ${room.settings.maxWriters} writers and at most ${room.settings.maxMessagesPerWriter} messages per writer. Return JSON only: {"messages":[{"character":"exact character name from AVAILABLE WRITERS","text":"OOC writer message","replyTo":"optional writer name"}]}.`;
        const userContent = [
            'BASIC STORY KNOWLEDGE',
            JSON.stringify(compactKnowledgeForPrompt(room.knowledge.data)),
            'AVAILABLE WRITERS',
            available,
            'OOC WRITER IDENTITIES',
            writerIdentities,
            'CURRENTLY RELEVANT STORY CONTEXT',
            recentStory || '(No recent story text available.)',
            'WRITERS’ ROOM MEMORY',
            buildRoomMemory(room),
            'CURRENT TURN',
            directInstruction,
            autonomous ? 'This is an autonomous comment. Prefer a specific observation that feels worth interrupting for.' : '',
        ].filter(Boolean).join('\n\n');

        setActivity(opening ? 'composing-opening' : autonomous ? 'composing-commentary' : 'composing-reply');
        const response = await providerCall({
            systemPrompt,
            userContent,
            maxTokens: 700,
            callerName: autonomous ? 'SuperAgents Group Chat auto' : 'SuperAgents Group Chat',
        }, epoch);
        const payload = findPayload(response, candidate => Array.isArray(candidate.messages));
        if (!payload) throw new Error('The writers did not return a valid response.');
        const messages = normalizeGeneratedMessages(payload, writers, room.settings);
        if (!messages.length) throw new Error('No valid writer messages were returned.');
        await revealMessages(messages, epoch);
        void maybeArchiveRoom();
        return messages;
    } finally {
        busy = false;
        setActivity(archivePromise ? 'archiving' : 'idle');
    }
}

export function sendGroupChatMessage(text) {
    const content = String(text || '').trim();
    if (!content || turnPromise) return turnPromise || Promise.resolve([]);
    if (!isGroupChatAvailable()) return Promise.reject(new Error('Group Chat is disabled in SuperAgents Settings.'));
    const user = getUserParticipant();
    appendGroupChatMessages({
        id: id('gcu'),
        role: 'user',
        speaker: user.name,
        text: content,
        timestamp: Date.now(),
        storyMessageIndex: latestStoryMessageIndex(),
    });
    notify('message');
    turnPromise = runRoomTurn({ userText: content }).finally(() => { turnPromise = null; });
    return turnPromise;
}

export function startGroupChatConversation({ autonomous = false } = {}) {
    if (turnPromise) return turnPromise;
    turnPromise = runRoomTurn({ autonomous }).finally(() => { turnPromise = null; });
    return turnPromise;
}

export function setGroupChatAutoEnabled(enabled) {
    const room = readGroupChatRoom();
    const settings = {
        autoEnabled: Boolean(enabled),
        storyRepliesSinceAuto: 0,
        nextAutoAt: enabled ? nextAutoThreshold(room.settings) : 0,
    };
    const updated = setGroupChatSettings(settings);
    notify('settings');
    return updated;
}

export function updateGroupChatSettings(partial) {
    const updated = setGroupChatSettings(partial);
    if (updated.settings.autoEnabled && !updated.settings.nextAutoAt) {
        return setGroupChatAutoEnabled(true);
    }
    notify('settings');
    return updated;
}

export function clearGroupChatMemory() {
    const room = wipeGroupChatMemory();
    notify('wipe');
    return room;
}

export function deleteGroupChatMessage(messageId) {
    const targetId = String(messageId || '');
    if (!targetId) return false;
    let removed = false;
    updateGroupChatRoom(room => {
        const messages = room.messages.filter(message => message.id !== targetId);
        removed = messages.length !== room.messages.length;
        if (removed) {
            room.messages = messages;
            room.lastActivity = messages.at(-1)?.timestamp || 0;
        }
        return room;
    });
    if (removed) notify('message');
    return removed;
}

export async function maybeArchiveRoom() {
    if (archivePromise) return archivePromise;
    const room = readGroupChatRoom();
    if (room.messages.length < GROUP_CHAT_LIMITS.activeMessages) return null;
    const epoch = chatEpoch;
    archivePromise = (async () => {
        if (!busy) setActivity('archiving');
        // A single provider turn can add several messages and cross 30 in one
        // step; archive every message before the newest ten so none disappear.
        const oldest = room.messages.slice(0, -GROUP_CHAT_LIMITS.retainedMessages);
        const transcript = oldest.map(message => `${message.speaker || 'Room'}: ${message.text}`).join('\n');
        const consolidate = room.summaries.length >= GROUP_CHAT_LIMITS.roomSummaries - 1;
        const prompt = consolidate
            ? `Existing historical memory:\n${room.historicalSummary || '(none)'}\n\nExisting room summaries:\n${room.summaries.join('\n')}\n\nConversation to archive:\n${transcript}\n\nReturn JSON only: {"summary":"very brief summary of the newest archived conversation","historicalSummary":"compact merged history preserving notable opinions, running jokes, disagreements, promises, and story interpretations"}.`
            : `Condense this writers’ room transcript into a very brief continuity summary. Preserve notable opinions, disagreements, running jokes, and unanswered questions. Return JSON only: {"summary":"..."}.\n\n${transcript}`;
        let summary = transcript.slice(0, 1200);
        let historicalSummary = null;
        try {
            const response = await providerCall({
                systemPrompt: 'You compact an OOC writers’ room conversation without adding facts. Be terse and return only the requested JSON.',
                userContent: prompt,
                maxTokens: consolidate ? 800 : 450,
                callerName: 'SuperAgents Group Chat archive',
            }, epoch);
            const payload = findPayload(response, candidate => typeof candidate.summary === 'string');
            if (payload?.summary) summary = payload.summary;
            if (consolidate && payload?.historicalSummary) historicalSummary = payload.historicalSummary;
        } catch (err) {
            if (isAbortError(err) || epoch !== chatEpoch) return null;
            console.warn(`${LOG_PREFIX} archive call failed; using local excerpt`, err);
        }
        if (epoch !== chatEpoch) return null;
        const updated = commitGroupChatArchive({ summary, historicalSummary });
        notify('archived', { room: updated });
        return updated;
    })().finally(() => {
        archivePromise = null;
        if (!busy && !knowledgePromise) setActivity('idle');
    });
    return archivePromise;
}

function onStoryReply() {
    if (!isGroupChatAvailable()) return;
    const room = readGroupChatRoom();
    if (!room.settings.autoEnabled) return;
    const count = room.settings.storyRepliesSinceAuto + 1;
    const threshold = room.settings.nextAutoAt || nextAutoThreshold(room.settings);
    if (count < threshold) {
        setGroupChatSettings({ storyRepliesSinceAuto: count, nextAutoAt: threshold });
        notify('auto-progress');
        return;
    }
    setGroupChatSettings({
        storyRepliesSinceAuto: 0,
        nextAutoAt: nextAutoThreshold(room.settings),
    });
    notify('auto-progress');
    setTimeout(() => {
        if (!turnPromise && !isGroupChatBusy() && readGroupChatRoom().settings.autoEnabled) {
            startGroupChatConversation({ autonomous: true }).catch(err => {
                if (!isAbortError(err)) debug(`${LOG_PREFIX} auto turn skipped: ${err?.message || err}`);
            });
        }
    }, 250);
}

export function initGroupChatAgent({ onPostProcessComplete } = {}) {
    if (initialized) return;
    initialized = true;
    if (typeof onPostProcessComplete === 'function') onPostProcessComplete(onStoryReply);
    eventSource.on(event_types.CHAT_CHANGED, () => {
        chatEpoch += 1;
        activeController?.abort();
        activeController = null;
        busy = false;
        visible = false;
        activityPhase = 'idle';
        notify('chat-changed');
    });
    document.addEventListener('superagents:group-chat-enabled-changed', event => {
        if (event.detail?.enabled !== false) return;
        chatEpoch += 1;
        activeController?.abort();
        activeController = null;
        busy = false;
        visible = false;
        activityPhase = 'idle';
        notify('disabled');
    });
    debug(`${LOG_PREFIX} initialized`);
}
