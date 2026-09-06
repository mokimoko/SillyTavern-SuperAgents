/** Social Feed logic: chat-scoped storage, generation, public commands, and prompt context. */

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
import { callAgentLLM } from '../core/llm.js';
import {
    getAgents,
    getEnabledAgents,
    isAgentsPaused,
    onAgentsPauseChange,
    onAgentPauseChange,
} from '../data/store.js';
import { buildPhoneStateContext } from '../phone/phoneContext.js';
import { getActiveSurfacePresentation } from '../presentation/presentationState.js';
import { buildModelBehaviorContract, fillPresentationTemplate } from '../presentation/promptSemantics.js';
import { enforceGeneratedIdentity, isUserIdentity, parseFeedDecision } from './feedProtocol.js';
import { createFeedQueue } from './feedQueue.js';
import {
    clearVisibleFeed,
    markVisibleFeedRead,
    normalizeFeedState,
    projectFeedState,
    resolveFeedBranch,
    stampFeedEntry,
} from './feedStore.js';

const LOG_PREFIX = '[SuperAgents/feed]';
const FEED_VAR = 'sa_social_feed';
const PROMPT_KEY = 'sa_agent_feed_ctx';
const postListeners = [];
const activityListeners = [];
let warnedMultiple = false;
let feedQueue = null;
let initialized = false;
// Queue.clear() cannot stop work that is already awaiting an LLM response.
// This epoch makes those stale results harmless after the user changes chats.
let feedChatEpoch = 0;

function id(prefix) {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function getFeedAgent() {
    const agents = getEnabledAgents().filter(agent => agent.feedConfig != null);
    if (agents.length > 1 && !warnedMultiple) {
        warnedMultiple = true;
        console.warn(`${LOG_PREFIX} multiple Feed agents enabled; using "${agents[0].name}".`);
        toastr.warning(`Multiple Feed agents enabled — only "${agents[0].name}" is active.`, 'SuperAgents Feed');
    } else if (agents.length <= 1) {
        warnedMultiple = false;
    }
    return agents[0] ?? null;
}

export function isFeedEnabled() {
    return getFeedAgent() != null;
}

export function getFeedConfig() {
    return getFeedAgent()?.feedConfig
        ?? getAgents().find(agent => agent.feedConfig != null)?.feedConfig
        ?? null;
}

function readState() {
    try {
        const raw = chat_metadata?.variables?.[FEED_VAR];
        const state = normalizeFeedState(raw ? JSON.parse(raw) : {});
        const userName = substituteParams('{{user}}');
        state.posts = state.posts
            .filter(post => post.source !== 'generated' || !isUserIdentity(post.author, userName))
            .map(post => ({
                ...post,
                comments: post.comments.filter(comment => (
                    comment.source !== 'generated' || !isUserIdentity(comment.author, userName)
                )),
                reactions: post.reactions.filter(reaction => (
                    reaction.source === 'user' || !isUserIdentity(reaction.author, userName)
                )),
            }));
        return state;
    } catch {
        return normalizeFeedState({});
    }
}

function writeState(state) {
    if (!chat_metadata.variables) chat_metadata.variables = {};
    chat_metadata.variables[FEED_VAR] = JSON.stringify(normalizeFeedState(state));
}

export function getFeedState(options = {}) {
    return projectFeedState(readState(), chat, options);
}

export function listFeedPosts(options = {}) {
    return getFeedState(options).posts;
}

export function getFeedPost(postId, options = {}) {
    return listFeedPosts(options).find(post => post.id === postId) ?? null;
}

function storePost(post, branch = resolveFeedBranch(chat)) {
    const state = readState();
    const comments = (post.comments || []).map(comment => stampFeedEntry({
        id: id('comment'),
        author: comment.author,
        content: comment.content,
        source: comment.source || 'generated',
        timestamp: Date.now(),
    }, branch));
    const stored = stampFeedEntry({
        id: id('post'),
        author: post.author,
        content: post.content,
        audience: post.audience || 'shared',
        continuity: post.continuity || '',
        source: post.source || 'generated',
        unread: post.source !== 'user',
        timestamp: Date.now(),
        comments,
        reactions: [],
    }, branch);
    state.posts.push(stored);
    const maxStored = Number(getFeedConfig()?.maxStoredPosts || 80);
    if (state.posts.length > maxStored) state.posts = state.posts.slice(-maxStored);
    state.lastActivity = Date.now();
    writeState(state);
    saveChatDebounced();
    syncInjection();
    notifyFeedActivity({ kind: 'post', post: stored });
    notifyPostListeners(stored);
    return stored;
}

export function addManualPost({ content, audience = 'shared', author = '' } = {}) {
    const text = String(content || '').trim();
    if (!text) return null;
    return storePost({
        author: String(author || substituteParams('{{user}}')).trim() || 'User',
        content: text,
        audience,
        source: 'user',
    });
}

export function addUserComment(postId, content, author = '') {
    const text = String(content || '').trim();
    if (!text) return null;
    const state = readState();
    const post = state.posts.find(candidate => candidate.id === postId);
    if (!post || !getFeedPost(postId)) return null;
    const comment = stampFeedEntry({
        id: id('comment'),
        author: String(author || substituteParams('{{user}}')).trim() || 'User',
        content: text,
        source: 'user',
        timestamp: Date.now(),
    }, resolveFeedBranch(chat));
    post.comments.push(comment);
    state.lastActivity = Date.now();
    writeState(state);
    saveChatDebounced();
    syncInjection();
    notifyPostListeners(post);
    return comment;
}

export function toggleUserReaction(postId, kind = 'heart', author = '') {
    const state = readState();
    const post = state.posts.find(candidate => candidate.id === postId);
    if (!post || !getFeedPost(postId)) return false;
    const name = String(author || substituteParams('{{user}}')).trim() || 'User';
    const visible = projectFeedState({ posts: [post] }, chat).posts[0];
    const existing = visible?.reactions.find(reaction => reaction.author === name && reaction.kind === kind);
    if (existing) {
        post.reactions = post.reactions.filter(reaction => reaction.id !== existing.id);
    } else {
        post.reactions.push(stampFeedEntry({
            id: id('reaction'), author: name, kind, source: 'user', timestamp: Date.now(),
        }, resolveFeedBranch(chat)));
    }
    writeState(state);
    saveChatDebounced();
    syncInjection();
    notifyPostListeners(post);
    return !existing;
}

export function markFeedRead() {
    const sourceIds = getFeedState().posts.map(post => post.id);
    writeState(markVisibleFeedRead(readState(), chat));
    saveChatDebounced();
    notifyFeedActivity({ kind: 'read', sourceIds });
}

export function clearFeed() {
    const sourceIds = getFeedState().posts.map(post => post.id);
    writeState(clearVisibleFeed(readState(), chat));
    saveChatDebounced();
    syncInjection();
    notifyFeedActivity({ kind: 'clear', sourceIds });
    notifyPostListeners(null);
}

function recentScene(messageIndex, count = 10) {
    const end = Number.isInteger(messageIndex) ? messageIndex + 1 : chat.length;
    return chat.slice(Math.max(0, end - count), end).map(message => {
        const speaker = message.is_user ? '{{user}}' : (message.name || 'Character');
        return `${speaker}: ${String(message.mes || '').slice(0, 600)}`;
    }).join('\n\n');
}

function recentFeedContext(maxPosts = 8) {
    const posts = listFeedPosts().slice(-maxPosts);
    if (!posts.length) return '(the feed is empty)';
    return posts.map(post => {
        const comments = post.comments.slice(-3).map(comment => `  ↳ ${comment.author}: ${comment.content}`).join('\n');
        return `${post.author} [${post.audience}]: ${post.content}${comments ? `\n${comments}` : ''}`;
    }).join('\n\n');
}

function ambientCooldownActive(messageIndex, minimumReplies) {
    const required = Math.max(0, Number(minimumReplies || 0));
    if (!required || !Number.isInteger(messageIndex)) return false;
    const latest = [...listFeedPosts()].reverse().find(post => post.source === 'generated');
    if (!Number.isInteger(Number(latest?.messageIndex))) return false;
    const assistantReplies = chat
        .slice(Number(latest.messageIndex) + 1, messageIndex + 1)
        .filter(message => message && !message.is_user)
        .length;
    return assistantReplies < required;
}

export async function executeFeedEvaluation(
    agent,
    message,
    messageIndex,
    behavior = 'ambient',
    author = '',
    externalCue = '',
    showFeedback = false,
) {
    if (isAgentsPaused() || agent?.paused) {
        if (showFeedback) toastr.info('SuperAgents are paused. Feed state is frozen.');
        return { accepted: false, postsGenerated: 0, error: 'agents paused' };
    }
    const startedInChatEpoch = feedChatEpoch;
    const config = agent?.feedConfig || {};
    const resolvedAuthor = String(author || message?.name || 'Character').trim();
    if (behavior === 'ambient') {
        if (ambientCooldownActive(messageIndex, config.minRepliesBetweenPosts ?? 3)) {
            debug(`${LOG_PREFIX} ambient evaluation skipped during reply-gap cooldown`);
            return { accepted: true, postsGenerated: 0, result: 'withhold' };
        }
        const probability = Math.max(0, Math.min(100, Number(config.ambientProbability ?? 30)));
        const roll = Math.random() * 100;
        if (roll > probability) {
            debug(`${LOG_PREFIX} ambient evaluation skipped (${roll.toFixed(1)} > ${probability})`);
            return { accepted: true, postsGenerated: 0, result: 'withhold' };
        }
        debug(`${LOG_PREFIX} ambient evaluation passed (${roll.toFixed(1)} <= ${probability})`);
    }

    const branch = resolveFeedBranch(chat, { messageIndex, swipeId: message?.swipe_id });
    const surface = getActiveSurfacePresentation('feed') || {};
    const presentationPrompt = surface.prompt || {};
    const configuredName = String(config.appName || '').trim();
    const appName = configuredName && configuredName !== 'Twatter'
        ? configuredName
        : (surface.title || configuredName || 'Twatter');
    const stateContext = buildPhoneStateContext(resolvedAuthor, {
        messageIndex: branch.messageIndex,
        swipeId: branch.swipeId,
        config: config.stateContext,
    });
    const required = behavior === 'publish';
    let systemPrompt = substituteParams(String(agent.prompt || '')
        .replace(/\{\{app_name\}\}/g, () => appName)
        .replace(/\{\{author\}\}/g, () => resolvedAuthor))
        .replace('{{feed_history}}', () => recentFeedContext(config.contextPosts || 8))
        .replace('{{recent_scene}}', () => substituteParams(recentScene(branch.messageIndex)));
    const behaviorContract = buildModelBehaviorContract(surface);
    if (stateContext) systemPrompt += `\n\n${stateContext}`;
    if (externalCue) systemPrompt += `\n\n${presentationPrompt.externalCueLabel || 'External social cue'} (guidance, not quoted canon):\n${substituteParams(externalCue)}`;
    if (required) systemPrompt += `\n\n${presentationPrompt.required || 'A post is required. You MUST return result "publish" with a non-empty post.'}`;
    if (behaviorContract) {
        systemPrompt += `\n\n${behaviorContract}\nThe active presentation contract takes precedence over modern wording in the base template or external cue.`;
    }

    const userContent = [
        fillPresentationTemplate(
            presentationPrompt.evaluate || 'Evaluate whether {name} would share something on this social surface now.',
            { name: resolvedAuthor },
        ),
        `Latest scene:\n<scene>\n${String(message?.mes || '').slice(0, 4000)}\n</scene>`,
        'Return one JSON object only.',
    ].join('\n\n');
    if (showFeedback) toastr.info(`Considering ${surface.title || 'the Feed'}…`, agent.name, { timeOut: 0, extendedTimeOut: 0 });

    const run = prompt => callAgentLLM({
        systemPrompt: prompt,
        userContent,
        profileRef: agent.connectionProfile,
        maxTokens: Number(config.maxTokens || 512),
        callerName: `${surface.title || 'Feed'}: ${resolvedAuthor}`,
    });

    try {
        let decision;
        let repaired = false;
        try {
            const response = await run(systemPrompt);
            if (startedInChatEpoch !== feedChatEpoch) {
                if (showFeedback) toastr.clear();
                debug(`${LOG_PREFIX} discarded evaluation after chat changed`);
                return { accepted: false, postsGenerated: 0, error: 'chat changed' };
            }
            decision = parseFeedDecision(response, {
                fallbackAuthor: resolvedAuthor,
                maxComments: Number(config.maxComments || 3),
            });
        } catch (error) {
            if (!required) {
                debug(`${LOG_PREFIX} treating malformed optional decision as withhold: ${error.message}`);
                decision = { result: 'withhold' };
            } else {
                repaired = true;
                const repair = `${systemPrompt}\n\nYour previous response was invalid. Return valid JSON only, using {"result":"publish","post":{"author":"${resolvedAuthor}","content":"...","audience":"shared"},"comments":[],"continuity":"..."}.`;
                const response = await run(repair);
                if (startedInChatEpoch !== feedChatEpoch) {
                    if (showFeedback) toastr.clear();
                    debug(`${LOG_PREFIX} discarded repair result after chat changed`);
                    return { accepted: false, postsGenerated: 0, error: 'chat changed' };
                }
                decision = parseFeedDecision(response, {
                    fallbackAuthor: resolvedAuthor,
                    maxComments: Number(config.maxComments || 3),
                });
            }
        }

        if (required && decision.result !== 'publish') {
            if (repaired) throw new Error('required Feed post was withheld after retry');
            repaired = true;
            const repair = `${systemPrompt}\n\nYou withheld a required publication. Return valid JSON only, using {"result":"publish","post":{"author":"${resolvedAuthor}","content":"...","audience":"shared"},"comments":[],"continuity":"..."}.`;
            const response = await run(repair);
            if (startedInChatEpoch !== feedChatEpoch) {
                if (showFeedback) toastr.clear();
                debug(`${LOG_PREFIX} discarded required-post result after chat changed`);
                return { accepted: false, postsGenerated: 0, error: 'chat changed' };
            }
            decision = parseFeedDecision(response, {
                fallbackAuthor: resolvedAuthor,
                maxComments: Number(config.maxComments || 3),
            });
            if (decision.result !== 'publish') {
                throw new Error('required Feed post was withheld after retry');
            }
        }

        decision = enforceGeneratedIdentity(decision, {
            author: resolvedAuthor,
            userName: substituteParams('{{user}}'),
        });
        if (surface.capabilities?.comments === false) decision.comments = [];
        if (surface.capabilities?.reactions === false) decision.reactions = [];

        if (showFeedback) toastr.clear();
        if (decision.result !== 'publish') {
            if (showFeedback) toastr.info('Nothing shared this time.', agent.name, { timeOut: 3000 });
            return { accepted: true, postsGenerated: 0, result: 'withhold', continuity: decision.continuity || '' };
        }

        if (startedInChatEpoch !== feedChatEpoch) {
            return { accepted: false, postsGenerated: 0, error: 'chat changed' };
        }
        const stored = storePost({
            ...decision.post,
            comments: decision.comments,
            continuity: decision.continuity,
            source: 'generated',
        }, branch);
        if (showFeedback) toastr.success(`${stored.author} added something to ${surface.title || 'the Feed'}.`, agent.name, { timeOut: 3000 });
        return { accepted: true, postsGenerated: 1, result: 'publish', postId: stored.id };
    } catch (error) {
        if (showFeedback) { toastr.clear(); toastr.error(error.message, agent.name, { timeOut: 8000 }); }
        console.error(`${LOG_PREFIX} evaluation failed:`, error);
        return { accepted: false, postsGenerated: 0, error: error.message };
    }
}

function getQueue() {
    feedQueue ||= createFeedQueue({ execute: executeQueuedRequest });
    return feedQueue;
}

async function executeQueuedRequest(request) {
    const agent = request.agent || getFeedAgent();
    if (!agent) return { accepted: false, postsGenerated: 0, error: 'feed is not enabled' };
    return executeFeedEvaluation(
        agent,
        request.message || {},
        request.messageIndex,
        ['consider', 'publish'].includes(request.behavior) ? request.behavior : 'ambient',
        request.author,
        request.reason,
        false,
    );
}

export function queueFeedEvaluation({
    agent = null,
    message = null,
    messageIndex = null,
    behavior = 'ambient',
    author = '',
    reason = '',
    source = 'ambient',
} = {}) {
    if (isAgentsPaused() || agent?.paused) {
        return Promise.resolve({ accepted: false, postsGenerated: 0, error: 'agents paused' });
    }
    const branch = resolveFeedBranch(chat, { messageIndex, swipeId: message?.swipe_id });
    const path = branch.branchPath?.join('.') || `${branch.messageIndex ?? 'none'}:${branch.swipeId ?? 0}`;
    const resolvedAuthor = String(author || message?.name || '').trim();
    return getQueue().enqueue({
        key: `feed|${resolvedAuthor.toLowerCase()}|${path}`,
        agent,
        message: { ...(message || {}), swipe_id: branch.swipeId ?? 0 },
        messageIndex: branch.messageIndex,
        behavior,
        author: resolvedAuthor,
        reason,
        source,
    });
}

export function requestCharacterPost(options = {}) {
    if (isAgentsPaused()) {
        return Promise.resolve({ accepted: false, postsGenerated: 0, error: 'agents paused' });
    }
    const author = String(options.author || options.character || '').trim();
    if (!author) return Promise.resolve({ accepted: false, postsGenerated: 0, error: 'author is required' });
    const agent = getFeedAgent();
    if (!agent) return Promise.resolve({ accepted: false, postsGenerated: 0, error: 'feed is not enabled' });
    if (agent.paused) return Promise.resolve({ accepted: false, postsGenerated: 0, error: 'agent paused' });
    const branch = resolveFeedBranch(chat, options);
    const sourceMessage = branch.messageIndex == null ? null : chat[branch.messageIndex];
    return queueFeedEvaluation({
        agent,
        message: {
            ...(sourceMessage || {}),
            mes: String(options.scene || sourceMessage?.mes || ''),
            name: author,
            swipe_id: branch.swipeId ?? 0,
        },
        messageIndex: branch.messageIndex,
        behavior: options.behavior === 'publish' ? 'publish' : 'consider',
        author,
        reason: String(options.reason || '').trim(),
        source: String(options.source || 'integration'),
    });
}

function buildInjection() {
    const limit = Number(getFeedConfig()?.maxInjectedPosts || 6);
    const posts = listFeedPosts().slice(-limit);
    if (!posts.length) return '';
    const surface = getActiveSurfacePresentation('feed') || {};
    const commentLabel = surface.copy?.commentContextLabel || 'comments';
    const lines = posts.map(post => {
        const comments = surface.capabilities?.comments === false
            ? ''
            : post.comments.slice(-2).map(comment => `${comment.author}: ${comment.content}`).join(' | ');
        return `- ${post.author} (${post.audience}): ${post.content}${comments ? ` [${commentLabel}: ${comments}]` : ''}`;
    });
    const configuredName = String(getFeedConfig()?.appName || '').trim();
    const appName = configuredName && configuredName !== 'Twatter'
        ? configuredName
        : (surface.title || configuredName || 'Twatter');
    const header = surface.prompt?.injectionHeader
        || `Recent ${appName} activity. Treat as off-screen shared context, not dialogue in the current scene.`;
    return [
        `[${header}]`,
        'Audience labels are access boundaries: do not give a character a post or reply they could not plausibly access.',
        ...lines,
    ].join('\n');
}

function clearInjection() {
    if (extension_prompts[PROMPT_KEY]) delete extension_prompts[PROMPT_KEY];
}

function syncInjection() {
    const agent = getFeedAgent();
    if (!agent) { clearInjection(); return; }
    const text = buildInjection();
    if (!text) { clearInjection(); return; }
    setExtensionPrompt(PROMPT_KEY, substituteParams(text), 1, Number(agent?.feedConfig?.injectionDepth || 1), false, 0);
}

export function onNewPost(listener) {
    if (typeof listener === 'function') postListeners.push(listener);
}

export function onFeedActivity(listener) {
    if (typeof listener !== 'function') return () => {};
    activityListeners.push(listener);
    return () => {
        const index = activityListeners.indexOf(listener);
        if (index >= 0) activityListeners.splice(index, 1);
    };
}

function notifyFeedActivity(event) {
    for (const listener of activityListeners) {
        try { listener(event); } catch { /* optional consumers are non-fatal */ }
    }
}

function notifyPostListeners(post) {
    for (const listener of postListeners) {
        try { listener(post); } catch { /* UI listeners are non-fatal. */ }
    }
}

export function initFeedAgent() {
    if (initialized) return;
    initialized = true;
    eventSource.on(event_types.GENERATION_AFTER_COMMANDS, syncInjection);
    onAgentsPauseChange((paused) => {
        if (!paused) return;
        feedChatEpoch += 1;
        getQueue().clear('agents paused');
    });
    onAgentPauseChange((agent, paused) => {
        if (!paused || !agent?.feedConfig) return;
        feedChatEpoch += 1;
        getQueue().clear('feed agent paused');
    });
    if (event_types.MESSAGE_SWIPED) eventSource.on(event_types.MESSAGE_SWIPED, syncInjection);
    eventSource.on(event_types.CHAT_CHANGED, () => {
        feedChatEpoch += 1;
        getQueue().clear('chat changed');
        clearInjection();
        notifyPostListeners(null);
    });
    debug(`${LOG_PREFIX} feed agent initialized (branch-aware shared context)`);
}
