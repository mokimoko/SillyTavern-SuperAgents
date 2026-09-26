/** Context shaping for the OOC Group Chat writers' room. */

import { chat } from '../../../../../../script.js';
import { getContext } from '../../../../../extensions.js';
import { user_avatar } from '../../../../../personas.js';
import { buildRichContext } from '../core/richContext.js';

const COLORS = ['#df725f', '#7299b8', '#aa8cb3', '#7cab8d', '#caa66a', '#c27793', '#83a8a2', '#a58b69'];
const KNOWLEDGE_SCHEMA_VERSION = 6;
const CARD_CONTAINER_WORDS = new Set(['and', 'brother', 'brothers', 'cast', 'characters', 'family', 'group', 'sisters', 'the']);

function clean(value, max = 8000) {
    return String(value ?? '').replace(/\r/g, '').trim().slice(0, max);
}

function displayName(character) {
    return clean(character?.name ?? character?.data?.name, 160);
}

function characterDetails(character) {
    return [
        character?.description ?? character?.data?.description,
        character?.personality ?? character?.data?.personality,
        character?.scenario ?? character?.data?.scenario,
        character?.mes_example ?? character?.data?.mes_example,
    ].map(value => clean(value, 5000)).filter(Boolean).join('\n\n');
}

function hashText(value) {
    let hash = 2166136261;
    const text = String(value ?? '');
    for (let index = 0; index < text.length; index++) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
}

function nameKey(value) {
    return clean(value, 240)
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/["'‘’“”]/g, '')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim();
}

function nameTokens(value) {
    return nameKey(value).split(/\s+/).filter(token => token && !CARD_CONTAINER_WORDS.has(token));
}

function cleanAliases(values, name = '') {
    const output = [];
    const seen = new Set([nameKey(name)]);
    for (const value of Array.isArray(values) ? values : []) {
        const alias = clean(value, 160);
        const key = nameKey(alias);
        if (!alias || !key || seen.has(key)) continue;
        seen.add(key);
        output.push(alias);
    }
    return output.slice(0, 8);
}

function cleanUsername(value) {
    return clean(value, 40)
        .replace(/^@+/, '')
        .replace(/[^\p{L}\p{N}_.-]+/gu, '')
        .slice(0, 28);
}

function writerLabel(username, name) {
    const handle = cleanUsername(username);
    return handle ? `@${handle}` : `${name}’s Writer`;
}

function resolveSourceCard(character, cards) {
    const requestedCard = nameKey(character?.sourceCard ?? character?.cardName);
    if (requestedCard) {
        const exact = cards.find(card => nameKey(card.cardName || card.name) === requestedCard);
        if (exact) return exact;
    }

    const characterTokens = new Set([
        ...nameTokens(character?.name),
        ...cleanAliases(character?.aliases).flatMap(nameTokens),
    ]);
    let best = null;
    let bestScore = 0;
    for (const card of cards) {
        const cardKey = nameKey(card.cardName || card.name);
        const characterKey = nameKey(character?.name);
        if (cardKey && cardKey === characterKey) return card;
        const tokens = nameTokens(card.cardName || card.name);
        const overlap = tokens.filter(token => characterTokens.has(token)).length;
        const score = overlap * 10 + (cardKey && characterKey.includes(cardKey) ? 3 : 0);
        if (score > bestScore) {
            best = card;
            bestScore = score;
        }
    }
    if (bestScore > 0) return best;
    return cards.length === 1 ? cards[0] : null;
}

function avatarUrl(avatar, type = 'avatar') {
    const value = clean(avatar, 500);
    if (!value) return '';
    if (/^(?:data:|blob:|https?:\/\/|\/)/i.test(value)) return value;
    return `/thumbnail?type=${type}&file=${encodeURIComponent(value)}`;
}

/** Characters with real cards in the current solo/group chat. */
export function getLiveWriters() {
    const ctx = getContext();
    const characters = Array.isArray(ctx?.characters) ? ctx.characters : [];
    let selected = [];

    if (ctx?.groupId) {
        const group = ctx.groups?.find(candidate => String(candidate.id) === String(ctx.groupId));
        selected = (group?.members || [])
            .map(avatar => characters.find(character => character?.avatar === avatar))
            .filter(Boolean);
    } else if (ctx?.characterId != null && characters[ctx.characterId]) {
        selected = [characters[ctx.characterId]];
    }

    const seen = new Set();
    return selected.map((character, index) => {
        const name = displayName(character);
        const key = name.toLowerCase();
        if (!name || seen.has(key)) return null;
        seen.add(key);
        return {
            id: `writer_${hashText(name)}`,
            name,
            cardName: name,
            writerName: `${name}’s Writer`,
            avatar: avatarUrl(character?.avatar),
            color: COLORS[index % COLORS.length],
            sourceText: characterDetails(character),
            aliases: [],
            writerProfile: '',
            hasCard: true,
        };
    }).filter(Boolean);
}

export function getUserParticipant() {
    const ctx = getContext();
    const fields = ctx?.getCharacterCardFields?.() || {};
    const name = clean(ctx?.name1 || ctx?.substituteParams?.('{{user}}') || 'You', 160) || 'You';
    const rawAvatar = ctx?.user_avatar || user_avatar || '';
    return {
        id: 'user',
        name,
        writerName: 'You',
        avatar: avatarUrl(rawAvatar, 'persona'),
        color: '#72a4a7',
        persona: clean(fields.persona, 6000),
    };
}

export function mergeKnowledgeWriters(liveWriters, knowledge) {
    const cards = Array.isArray(liveWriters) ? liveWriters : [];
    const inferred = Array.isArray(knowledge?.characters) ? knowledge.characters : [];
    const resolved = [];
    const known = new Set();
    for (const character of inferred) {
        const name = clean(character?.name, 160);
        const key = nameKey(name);
        const card = resolveSourceCard(character, cards);
        if (!name || !key || !card || known.has(key)) continue;
        known.add(key);
        resolved.push({
            id: `writer_${hashText(`${card.cardName || card.name}:${name}`)}`,
            name,
            cardName: card.cardName || card.name,
            writerName: writerLabel(character?.username, name),
            avatar: card.avatar,
            color: '',
            sourceText: clean(character?.selfProfile || character?.publicProfile, 3200),
            aliases: cleanAliases(character?.aliases, name),
            writerProfile: clean(character?.writerProfile, 1200),
            hasCard: true,
        });
    }

    if (!resolved.length) return cards.slice(0, 24);

    // A generated character with the exact card title is only a placeholder
    // when that same card was successfully decomposed into more specific people.
    const perCard = new Map();
    for (const writer of resolved) {
        const key = nameKey(writer.cardName);
        perCard.set(key, (perCard.get(key) || 0) + 1);
    }
    const output = resolved.filter(writer => (
        nameKey(writer.name) !== nameKey(writer.cardName) || perCard.get(nameKey(writer.cardName)) === 1
    ));
    const finalPerCard = new Map();
    for (const writer of output) {
        const key = nameKey(writer.cardName);
        finalPerCard.set(key, (finalPerCard.get(key) || 0) + 1);
    }
    const usedLabels = new Set();
    return output.slice(0, 24).map((writer, index) => {
        const aliases = [...writer.aliases];
        if (finalPerCard.get(nameKey(writer.cardName)) === 1 && nameKey(writer.cardName) !== nameKey(writer.name)) {
            aliases.push(writer.cardName);
        }
        let writerName = writer.writerName;
        const labelKey = nameKey(writerName);
        if (usedLabels.has(labelKey)) writerName = `${writerName}_${index + 1}`;
        usedLabels.add(nameKey(writerName));
        return {
            ...writer,
            writerName,
            aliases: cleanAliases(aliases, writer.name),
            color: COLORS[index % COLORS.length],
        };
    });
}

export function getBasicKnowledgeFingerprint() {
    const ctx = getContext();
    const writers = getLiveWriters();
    const user = getUserParticipant();
    return hashText(JSON.stringify({
        knowledgeSchema: KNOWLEDGE_SCHEMA_VERSION,
        groupId: ctx?.groupId || '',
        persona: user.persona,
        writers: writers.map(writer => [writer.name, writer.sourceText]),
    }));
}

export async function buildBasicKnowledgeInput({ worldInfoScanText = '' } = {}) {
    const ctx = getContext();
    const writers = getLiveWriters();
    const user = getUserParticipant();
    const messageIndex = Math.max(0, chat.length - 1);
    const richContext = await buildRichContext({
        mesNum: messageIndex,
        maxContext: Number(ctx?.maxContext) || 8192,
        worldInfoScanText,
        flags: {
            enabled: true,
            character: false,
            persona: true,
            worldInfo: true,
            summary: true,
            simpleSummarizer: true,
            authorsNote: false,
            pendingUser: false,
            historyCount: 20,
            selfMemory: false,
        },
    });
    const dossiers = writers.map(writer => (
        `## Active card container: ${writer.cardName || writer.name}\n${writer.sourceText || '(No descriptive card text available.)'}`
    )).join('\n\n');
    const fingerprint = getBasicKnowledgeFingerprint();

    return {
        fingerprint,
        writers,
        user,
        source: [dossiers, richContext].filter(Boolean).join('\n\n'),
        fallback: {
            world: 'Use the recent story context and live character cards as the temporary setting reference.',
            user: { name: user.name, profile: user.persona.slice(0, 1800) },
            characters: writers.map(writer => ({
                name: writer.name,
                sourceCard: writer.cardName || writer.name,
                username: `${nameKey(writer.name).replaceAll(' ', '') || 'story'}Writes`,
                aliases: [],
                publicProfile: writer.sourceText.slice(0, 1400),
                selfProfile: writer.sourceText.slice(0, 2200),
                writerProfile: `An out-of-character co-writer responsible for ${writer.name}.`,
            })),
        },
    };
}

export function normalizeBasicKnowledge(payload, fallback) {
    const root = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
    const fallbackCharacters = Array.isArray(fallback?.characters) ? fallback.characters : [];
    const characters = (Array.isArray(root.characters) ? root.characters : fallbackCharacters)
        .map(character => ({
            name: clean(character?.name, 160),
            sourceCard: clean(character?.sourceCard ?? character?.cardName, 160),
            username: cleanUsername(character?.username ?? character?.handle),
            aliases: cleanAliases(character?.aliases, character?.name),
            publicProfile: clean(character?.publicProfile ?? character?.public, 2200),
            selfProfile: clean(character?.selfProfile ?? character?.privateProfile ?? character?.self, 3200),
            writerProfile: clean(character?.writerProfile ?? character?.writerVoice, 1200),
        }))
        .filter(character => character.name)
        .slice(0, 24);
    const userData = root.user && typeof root.user === 'object' ? root.user : fallback?.user;
    return {
        world: clean(root.world ?? root.setting ?? fallback?.world, 5000),
        user: {
            name: clean(userData?.name, 160) || clean(fallback?.user?.name, 160) || 'User',
            profile: clean(userData?.profile ?? userData?.information, 3000),
        },
        characters: characters.length ? characters : fallbackCharacters,
    };
}

export function buildRoomMemory(room) {
    const sections = [];
    if (room.historicalSummary) sections.push(`Historical room memory:\n${room.historicalSummary}`);
    if (room.summaries.length) {
        sections.push(`Recent compact room summaries:\n${room.summaries.map((summary, index) => `${index + 1}. ${summary}`).join('\n')}`);
    }
    if (room.messages.length) {
        const lines = room.messages.map(message => {
            const text = clean(message.text, 1800);
            if (message.role === 'user') return `${message.speaker || 'User'}: ${text}`;
            if (message.role === 'writer') return `${message.speaker || `${message.character}’s Writer`}: ${text}`;
            return `[Room note] ${text}`;
        });
        sections.push(`Recent room messages:\n${lines.join('\n').slice(-32000)}`);
    }
    return sections.join('\n\n') || '(No previous room conversation.)';
}

export async function buildRecentStoryContext(count) {
    const ctx = getContext();
    return buildRichContext({
        mesNum: Math.max(0, chat.length - 1),
        maxContext: Number(ctx?.maxContext) || 8192,
        flags: {
            enabled: true,
            character: false,
            persona: false,
            worldInfo: false,
            summary: false,
            simpleSummarizer: true,
            authorsNote: false,
            pendingUser: false,
            historyCount: Math.max(1, Number(count) || 5),
            selfMemory: false,
        },
    });
}

export function latestStoryMessageIndex() {
    for (let index = chat.length - 1; index >= 0; index--) {
        if (!chat[index]?.is_system) return index;
    }
    return null;
}
