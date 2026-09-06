/**
 * phone/phoneAgent.js — diegetic text-messaging logic for SuperAgents.
 *
 * Characters text {{user}}'s persona through an in-story phone, and {{user}}
 * can text back. A parallel communication channel inside the narrative world.
 *
 * Ported from VerseManager's phoneAgent.js. Two things change in the port:
 *
 *   1. LLM path. VM called generateQuietPrompt directly behind a bespoke
 *      withProfile() swap helper (utils.js). Here both LLM calls — the
 *      character-initiated evaluation and the user-initiated reply — route
 *      through core/llm.js callAgentLLM(), which already owns profile
 *      resolution / swap / restore and the reasoning strip. VM's utils.js
 *      dependency is gone.
 *
 *   2. Context injection. VM used its own promptManager slot registry. Here
 *      the phone registers its own GENERATION_AFTER_COMMANDS listener and
 *      injects the current character's recent thread with ST's
 *      setExtensionPrompt under a `sa_agent_phone_ctx` key (the same
 *      extension_prompts channel the lifecycle uses for agent prompts). The
 *      lifecycle clears `sa_agent_`-prefixed keys on GENERATION_STARTED, so
 *      the key is deliberately prefixed to be swept with the rest.
 *
 * Lifecycle ownership matches VM: this module does NOT bind its own
 * post-gen evaluation trigger. core/lifecycle.js calls executePhoneEvaluation()
 * for any enabled agent carrying a phoneConfig, both in the automatic post-gen
 * pipeline (executeSingleAgent) and the manual run path (runAgentOnMessage).
 * The one self-owned LLM call is generateAndStoreReply(), driven by the panel
 * UI when the user sends a text.
 */

import {
    chat,
    chat_metadata,
    substituteParams,
    saveChatDebounced,
    setExtensionPrompt,
    extension_prompts,
} from '../../../../../../script.js';
import { getContext } from '../../../../../extensions.js';
import { eventSource, event_types } from '../../../../../events.js';
import { debug } from '../../index.js';
import {
    getEnabledAgents,
    isAgentsPaused,
    onAgentsPauseChange,
    onAgentPauseChange,
} from '../data/store.js';
import { callAgentLLM } from '../core/llm.js';
import { getActiveSurfacePresentation } from '../presentation/presentationState.js';
import { buildModelBehaviorContract, fillPresentationTemplate } from '../presentation/promptSemantics.js';
import { buildPhoneStateContext } from './phoneContext.js';
import { createPhoneQueue } from './phoneQueue.js';
import {
    clearVisiblePhoneMessages,
    markVisiblePhoneMessagesRead,
    normalizePhoneThread,
    projectPhoneThread,
    resolvePhoneBranch,
    stampPhoneMessage,
} from './phoneThreads.js';

// ============================================================================
// CONSTANTS
// ============================================================================

const LOG_PREFIX = '[SuperAgents/phone]';
const THREAD_VAR = 'sa_phone_threads';
// Prefixed `sa_agent_` so the lifecycle's GENERATION_STARTED sweep clears it
// alongside the per-agent prompt keys; the `_ctx` suffix mirrors the
// sidecar-context convention in lifecycle.js.
const PROMPT_KEY = 'sa_agent_phone_ctx';
const TEXT_TAG_REGEX = /\[TEXT\|([^|]+)\|([^\]]+)\]/g;
const NO_TEXT_REGEX = /\[NO_TEXT\]/;

/**
 * Per-character auto-evaluation cooldown. Keyed by character name so one
 * character texting doesn't lock out the others in a group chat (audit fix #2).
 * @type {Map<string, number>}
 */
const lastEvalTime = new Map();
const EVAL_COOLDOWN_MS = 5000;

/** Reply generation in flight? (evaluation is serialized by the lifecycle.) */
let isReplyBusy = false;
let phoneQueue = null;
// Incremented on every chat switch. Queue.clear() only removes work that has
// not started yet; this epoch also prevents an already-running request from
// committing its result into the newly opened chat.
let phoneChatEpoch = 0;

/** Listeners notified when new text(s) land (panel UI subscribes). */
const textListeners = [];
/** Optional artifact consumers subscribe without becoming a Phone dependency. */
const activityListeners = [];

// ============================================================================
// PHONE AGENT DETECTION
// ============================================================================

/** Tracks whether we've already warned about >1 enabled phone agent (warn-once). */
let warnedMultiplePhoneAgents = false;

/**
 * The single enabled phone agent (the phone "system"), or null.
 *
 * SuperAgents models the phone as ONE agent whose threads are keyed by
 * character name — NOT one agent per character. Per-character behavior comes
 * from each card's talkativeness value, not from separate agents. If a second
 * phone agent is enabled, that's almost certainly a misconfiguration: we still
 * deterministically pick the first (sorted by injection order via
 * getEnabledAgents) but warn once so it fails loud instead of silently routing
 * replies/injection through whichever happened to sort first (audit fix #1).
 *
 * @returns {object|null}
 */
export function getPhoneAgent() {
    const phoneAgents = getEnabledAgents().filter(a => a.phoneConfig != null);
    if (phoneAgents.length > 1 && !warnedMultiplePhoneAgents) {
        warnedMultiplePhoneAgents = true;
        const names = phoneAgents.map(a => a.name).join(', ');
        console.warn(
            `${LOG_PREFIX} ${phoneAgents.length} phone agents are enabled (${names}). ` +
            `The phone is a single shared system keyed by character; only "${phoneAgents[0].name}" ` +
            `will drive replies and context injection. Disable the others, or fold per-character ` +
            `behavior into talkativeness on each card.`,
        );
        toastr.warning(
            `Multiple phone agents enabled — only "${phoneAgents[0].name}" is active. See console.`,
            'SuperAgents Phone',
            { timeOut: 8000 },
        );
    } else if (phoneAgents.length <= 1) {
        // Reset so a later genuine reconfiguration can warn again.
        warnedMultiplePhoneAgents = false;
    }
    return phoneAgents[0] ?? null;
}

/** @returns {boolean} whether a phone agent is installed + enabled. */
export function isPhoneEnabled() {
    return getPhoneAgent() != null;
}

/** @returns {object|null} the active phone agent's phoneConfig, or null. */
export function getPhoneConfig() {
    return getPhoneAgent()?.phoneConfig ?? null;
}

// ============================================================================
// THREAD STORAGE  (chat_metadata.variables[THREAD_VAR])
// ============================================================================

/** @returns {Object<string, object>} all threads keyed by character name. */
function readThreads() {
    try {
        const raw = chat_metadata?.variables?.[THREAD_VAR];
        if (!raw) return {};
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
        return Object.fromEntries(Object.entries(parsed).map(([key, thread]) => [
            key,
            normalizePhoneThread(thread),
        ]));
    } catch {
        return {};
    }
}

/** @param {Object<string, object>} threads */
function writeThreads(threads) {
    if (!chat_metadata.variables) chat_metadata.variables = {};
    chat_metadata.variables[THREAD_VAR] = JSON.stringify(threads);
}

/**
 * Get a single character's thread, or null.
 * @param {string} charKey
 * @returns {object|null}
 */
export function getThread(charKey, options = {}) {
    const thread = readThreads()[charKey];
    return thread ? projectPhoneThread(thread, chat, options) : null;
}

/** @returns {Object<string, object>} all threads (for the conversation list). */
export function getAllThreads(options = {}) {
    const entries = [];
    for (const [key, thread] of Object.entries(readThreads())) {
        const projected = projectPhoneThread(thread, chat, options);
        if (projected.messages.length > 0 || thread.messages.length === 0) {
            entries.push([key, projected]);
        }
    }
    return Object.fromEntries(entries);
}

/**
 * Append text message(s) to a character's thread, pruning to the stored cap.
 * @param {string} charKey
 * @param {Array<{from:string,name:string,content:string}>} texts
 * @param {number|null} messageIndex
 * @param {number|null} swipeId
 * @returns {object} the updated thread
 */
function addTextsToThread(charKey, texts, messageIndex = null, swipeId = null) {
    const threads = readThreads();

    if (!threads[charKey]) {
        threads[charKey] = { characterId: null, messages: [], unread: 0, lastActivity: Date.now() };
    }

    const thread = threads[charKey];
    const maxStored = getPhoneConfig()?.maxStoredTexts ?? 50;

    const branch = resolvePhoneBranch(chat, { messageIndex, swipeId });
    const added = [];
    for (const text of texts) {
        const stored = stampPhoneMessage({
            id: `txt_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            from: text.from,
            name: text.name,
            content: text.content,
            timestamp: Date.now(),
            unread: text.from === 'char',
        }, branch);
        thread.messages.push(stored);
        added.push(stored);
    }

    // Unread counts character-initiated texts only.
    thread.unread += texts.filter(t => t.from === 'char').length;
    thread.lastActivity = Date.now();

    if (thread.messages.length > maxStored) {
        thread.messages = thread.messages.slice(-maxStored);
    }

    writeThreads(threads);
    return { thread, added };
}

/**
 * Clear a thread's messages and wipe the prompt injection.
 * @param {string} charKey
 */
export function clearThread(charKey) {
    const threads = readThreads();
    if (threads[charKey]) {
        const sourceIds = projectPhoneThread(threads[charKey], chat).messages.map(message => message.id);
        threads[charKey] = clearVisiblePhoneMessages(threads[charKey], chat);
        writeThreads(threads);
        notifyPhoneActivity({ kind: 'clear', character: charKey, sourceIds });
    }
    saveChatDebounced();
    clearInjection();
    debug(`${LOG_PREFIX} cleared thread for ${charKey}`);
}

/**
 * Mark a thread read (zero its unread count).
 * @param {string} charKey
 */
export function markThreadRead(charKey) {
    const threads = readThreads();
    if (threads[charKey]) {
        const sourceIds = projectPhoneThread(threads[charKey], chat).messages.map(message => message.id);
        threads[charKey] = markVisiblePhoneMessagesRead(threads[charKey], chat);
        writeThreads(threads);
        notifyPhoneActivity({ kind: 'read', character: charKey, sourceIds });
    }
}

/** @returns {number} total unread across all threads. */
export function getTotalUnread() {
    const threads = getAllThreads();
    return Object.values(threads).reduce((sum, t) => sum + (t.unread ?? 0), 0);
}

// ============================================================================
// TALKATIVENESS
// ============================================================================

/**
 * Read a character's talkativeness (0..1) from ST character data.
 * @param {string} [charName] defaults to the current character
 * @returns {number} 0..1, default 0.5
 */
function getCharacterTalkativeness(charName) {
    try {
        const ctx = getContext();
        if (!ctx) return 0.5;

        const pick = (char) => {
            const val = char?.data?.extensions?.talkativeness
                ?? char?.talkativeness
                ?? char?.data?.talkativeness;
            return typeof val === 'number' ? Math.max(0, Math.min(1, val)) : 0.5;
        };

        if (charName && ctx.characters) {
            const char = ctx.characters.find(c => c.name === charName || c.data?.name === charName);
            if (char) return pick(char);
        }
        return pick(ctx.characters?.[ctx.characterId]);
    } catch (err) {
        debug(`${LOG_PREFIX} talkativeness read failed:`, err);
        return 0.5;
    }
}

/**
 * Human-readable talkativeness label for prompt injection.
 * @param {number} value 0..1
 * @param {object} [config] phoneConfig
 * @returns {string}
 */
function getTalkativenessDescription(value, config) {
    const presentationTiers = getActiveSurfacePresentation('phone')?.modelBehavior?.talkativeness;
    if (Array.isArray(presentationTiers) && presentationTiers.length >= 4) {
        if (value <= 0.2) return presentationTiers[0];
        if (value <= 0.5) return presentationTiers[1];
        if (value <= 0.8) return presentationTiers[2];
        return presentationTiers[3];
    }
    const thresholds = config?.talkativenessThresholds;
    if (!thresholds) {
        if (value <= 0.2) return 'Only texts when something critical happens';
        if (value <= 0.5) return 'Texts sometimes — important updates, reactions to big events';
        if (value <= 0.8) return 'Texts fairly often — check-ins, reactions, casual messages';
        return 'Texts frequently, sometimes unprompted — shares thoughts, reacts to everything';
    }
    for (const tier of Object.values(thresholds)) {
        const [min, max] = tier.range;
        if (value >= min && value < max) return tier.label;
    }
    return thresholds.constant?.label ?? 'Texts frequently';
}

/**
 * Ambient firing probability (0..100) for a talkativeness value.
 * @param {number} value 0..1
 * @param {object} [config] phoneConfig
 * @returns {number}
 */
function getTalkativenessProbability(value, config) {
    const thresholds = config?.talkativenessThresholds;
    if (!thresholds) {
        if (value <= 0.2) return 2;
        if (value <= 0.5) return 8;
        if (value <= 0.8) return 20;
        return 40;
    }
    for (const tier of Object.values(thresholds)) {
        const [min, max] = tier.range;
        if (value >= min && value < max) return tier.probability;
    }
    return thresholds.constant?.probability ?? 40;
}

// ============================================================================
// TRIGGER CHECKING
// ============================================================================

/**
 * Does the message match a phone trigger? Keywords come from the agent's
 * conditions (user-editable); regex patterns from phoneConfig (template).
 * @param {object} agent
 * @param {string} messageText
 * @returns {boolean}
 */
function checkTriggers(agent, messageText) {
    if (!messageText?.trim()) return false;

    const cond = agent.conditions;
    const config = agent.phoneConfig;

    if (cond?.triggerKeywords?.length > 0) {
        const lower = messageText.toLowerCase();
        if (cond.triggerKeywords.some(kw => lower.includes(kw.toLowerCase()))) return true;
    }

    const patterns = config?.triggerPatterns ?? [];
    for (const pattern of patterns) {
        try {
            const slashMatch = pattern.match(/^\/(.+)\/([gimsuy]*)$/);
            const regex = slashMatch ? new RegExp(slashMatch[1], slashMatch[2]) : new RegExp(pattern, 'i');
            if (regex.test(messageText)) return true;
        } catch {
            // Invalid pattern — skip.
        }
    }
    return false;
}

// ============================================================================
// PARSING
// ============================================================================

/**
 * Parse [TEXT|name|content] tags out of an LLM response.
 * @param {string} response
 * @returns {Array<{from:string,name:string,content:string}>}
 */
function parseTextTags(response) {
    const results = [];
    let match;
    TEXT_TAG_REGEX.lastIndex = 0;
    while ((match = TEXT_TAG_REGEX.exec(response)) !== null) {
        const name = match[1].trim();
        const content = match[2].trim();
        if (content) results.push({ from: 'char', name, content });
    }
    return results;
}

// ============================================================================
// EVALUATION — called by core/lifecycle.js
// ============================================================================

/**
 * Decide whether the character should text {{user}} this turn, and store any
 * generated texts. Called by the lifecycle from both the automatic post-gen
 * pipeline and the manual run path (forceEvaluate=true).
 *
 * Two-tier gating when not forced:
 *   Tier 1 — keyword/pattern match in the message → always evaluate
 *   Tier 2 — no match → talkativeness probability gate
 * A cooldown additionally throttles back-to-back automatic evaluations.
 *
 * @param {object} agent
 * @param {object} message chat[messageIndex]
 * @param {number} messageIndex
 * @param {boolean} [forceEvaluate=false] skip gating (manual run/integration request)
 * @param {boolean} [showFeedback=forceEvaluate] show manual-run toasts
 * @param {boolean} [requireText=false] retry once instead of accepting [NO_TEXT]
 * @param {string} [externalCue=''] integration-supplied reason kept outside scene canon
 * @returns {Promise<{textsGenerated:number, charName?:string}>}
 */
export async function executePhoneEvaluation(
    agent,
    message,
    messageIndex,
    forceEvaluate = false,
    showFeedback = forceEvaluate,
    requireText = false,
    externalCue = '',
) {
    if (isAgentsPaused() || agent?.paused) {
        if (showFeedback) toastr.info('SuperAgents are paused. Phone state is frozen.');
        return { textsGenerated: 0, error: 'agents paused' };
    }
    const startedInChatEpoch = phoneChatEpoch;
    const charName = message.name || 'Character';
    const config = agent.phoneConfig;

    // ── Trigger gating (skipped when forced) ──
    if (!forceEvaluate) {
        // Per-character cooldown FIRST (audit fix #3): checking it before the
        // probability roll means we don't "burn" a successful ambient roll on a
        // turn we were going to skip anyway, which previously made the effective
        // text rate lower than the configured probability. Keyed by character so
        // one chatty NPC doesn't throttle the others in a group (audit fix #2).
        const now = Date.now();
        const last = lastEvalTime.get(charName) ?? 0;
        if (now - last < EVAL_COOLDOWN_MS) return { textsGenerated: 0 };

        const triggered = checkTriggers(agent, message.mes ?? '');
        if (!triggered) {
            const talkativeness = getCharacterTalkativeness(charName);
            const probability = getTalkativenessProbability(talkativeness, config);
            if (Math.random() * 100 > probability) return { textsGenerated: 0 };
            debug(`${LOG_PREFIX} ambient trigger passed for ${charName} (${probability}% chance)`);
        } else {
            debug(`${LOG_PREFIX} keyword/pattern trigger matched for ${charName}`);
        }

        // Passed the gate — stamp the cooldown for this character.
        lastEvalTime.set(charName, now);
    }

    // ── Build evaluation prompt ──
    const talkativeness = getCharacterTalkativeness(charName);
    const surface = getActiveSurfacePresentation('phone') || {};
    const presentationPrompt = surface.prompt || {};
    const behaviorContract = buildModelBehaviorContract(surface);
    let systemPrompt = substituteParams(agent.prompt)
        .replace('{{talkativeness_description}}', getTalkativenessDescription(talkativeness, config));

    // Append recent thread for continuity.
    const thread = getThread(charName);
    if (thread?.messages?.length > 0) {
        const recent = thread.messages.slice(-6).map(t => `${t.name}: ${t.content}`).join('\n');
        systemPrompt += `\n\n${presentationPrompt.historyLabel || 'Recent text history with {{user}}'}:\n${recent}`;
    }

    const stateContext = buildPhoneStateContext(charName, {
        messageIndex,
        swipeId: message.swipe_id ?? 0,
        config: config?.stateContext,
    });
    if (stateContext) systemPrompt += `\n\n${stateContext}`;
    if (externalCue) {
        systemPrompt += `\n\n${presentationPrompt.externalCueLabel || 'External Phone cue'} (guidance, not quoted scene canon):\n${substituteParams(externalCue)}`;
    }
    if (requireText) {
        systemPrompt += `\n\n${presentationPrompt.required || 'This development is canonically delivered through a text message. You MUST send 1–3 brief in-character texts. [NO_TEXT] is not allowed.'}`;
    }
    if (behaviorContract) {
        systemPrompt += `\n\n${behaviorContract}\nThe active presentation contract takes precedence over modern wording in the base template or external cue.`;
    }

    const userContent = [
        fillPresentationTemplate(
            presentationPrompt.evaluate || 'Evaluate whether {name} would use this communication surface now.',
            { name: charName },
        ),
        `The following is the latest scene to analyze:`,
        `<scene>\n${message.mes}\n</scene>`,
    ].join('\n');

    const maxTokens = config?.replyMaxTokens ?? 256;

    if (showFeedback) toastr.info('Evaluating...', agent.name, { timeOut: 0, extendedTimeOut: 0 });

    try {
        const runCall = (prompt, content, callerName) => callAgentLLM({
            systemPrompt: prompt,
            userContent: content,
            profileRef: agent.connectionProfile,
            maxTokens,
            callerName,
        });
        let response = await runCall(
            systemPrompt,
            userContent,
            `${surface.title || 'Phone'}: ${charName}`,
        );
        if (startedInChatEpoch !== phoneChatEpoch) {
            if (showFeedback) toastr.clear();
            debug(`${LOG_PREFIX} discarded ${charName} evaluation after chat changed`);
            return { textsGenerated: 0, charName };
        }
        response = String(response ?? '').trim();

        if (showFeedback) toastr.clear();

        let texts = (!response || NO_TEXT_REGEX.test(response)) ? [] : parseTextTags(response);
        if (requireText && texts.length === 0) {
            const repairPrompt = `${systemPrompt}\n\nYour previous answer did not contain a deliverable message. Return only [TEXT|${charName}|content] tags now; interpret them according to the behavior contract.`;
            response = String(await runCall(
                repairPrompt,
                fillPresentationTemplate(presentationPrompt.required || `Send the required message to {{user}} now as ${charName}.`, { name: charName }),
                `${surface.title || 'Phone'} Required Message: ${charName}`,
            ) ?? '').trim();
            if (startedInChatEpoch !== phoneChatEpoch) {
                if (showFeedback) toastr.clear();
                debug(`${LOG_PREFIX} discarded ${charName} repair result after chat changed`);
                return { textsGenerated: 0, charName };
            }
            texts = (!response || NO_TEXT_REGEX.test(response)) ? [] : parseTextTags(response);
            if (texts.length === 0 && response && !NO_TEXT_REGEX.test(response)) {
                const cleaned = response
                    .replace(/^```[^\n]*\n?/, '')
                    .replace(/\n?```$/, '')
                    .trim();
                if (cleaned) texts = [{ from: 'char', name: charName, content: cleaned }];
            }
        }

        if (texts.length === 0) {
            debug(`${LOG_PREFIX} ${charName}: no text this turn`);
            if (showFeedback) toastr.info(surface.copy?.noDelivery || 'No text this turn.', agent.name, { timeOut: 3000 });
            return { textsGenerated: 0, charName };
        }

        const swipeId = message.swipe_id ?? 0;
        if (startedInChatEpoch !== phoneChatEpoch) return { textsGenerated: 0, charName };
        const stored = addTextsToThread(charName, texts, messageIndex, swipeId);
        saveChatDebounced();
        syncInjection();

        debug(`${LOG_PREFIX} ${charName} sent ${texts.length} text(s)`);
        if (showFeedback) {
            toastr.success(
                fillPresentationTemplate(surface.copy?.deliveryGenerated || '{count} text(s) generated', { count: texts.length }),
                agent.name,
                { timeOut: 3000 },
            );
        }

        notifyPhoneActivity({ kind: 'message', character: charName, messages: stored.added });
        notifyTextListeners(charName, texts, stored.added);
        return { textsGenerated: texts.length, charName };
    } catch (err) {
        if (showFeedback) {
            toastr.clear();
            toastr.error(`Failed: ${err.message}`, agent.name, { timeOut: 8000 });
        }
        console.error(`${LOG_PREFIX} evaluation failed for ${charName}:`, err);
        return { textsGenerated: 0 };
    }
}

function getPhoneQueue() {
    phoneQueue ||= createPhoneQueue({ execute: executeQueuedPhoneRequest });
    return phoneQueue;
}

function phoneQueueKey(character, branch) {
    const path = Array.isArray(branch.branchPath)
        ? branch.branchPath.join('.')
        : `${branch.messageIndex ?? 'none'}:${branch.swipeId ?? 0}`;
    return `${String(character || '').trim().toLowerCase()}|${path}`;
}

async function executeQueuedPhoneRequest(request) {
    const agent = request.agent || getPhoneAgent();
    if (!agent) return { accepted: false, textsGenerated: 0, error: 'phone is not enabled' };
    const reason = String(request.reason || '').trim();
    const message = { ...(request.message || {}) };
    const behavior = ['consider', 'send'].includes(request.behavior) ? request.behavior : 'ambient';
    const result = await executePhoneEvaluation(
        agent,
        message,
        request.messageIndex,
        behavior !== 'ambient',
        false,
        behavior === 'send',
        reason,
    );
    const accepted = behavior !== 'send' || result.textsGenerated > 0;
    const surface = getActiveSurfacePresentation('phone') || {};
    return {
        accepted,
        behavior,
        sources: request.sources || [],
        ...result,
        ...(!accepted ? { error: surface.copy?.requiredFailure || 'required Phone text was not produced after retry' } : {}),
    };
}

/** Queue one automatic or integration-driven evaluation for same-turn merging. */
export function queuePhoneEvaluation({
    agent = null,
    message = null,
    messageIndex = null,
    behavior = 'ambient',
    reason = '',
    source = 'ambient',
} = {}) {
    if (isAgentsPaused() || agent?.paused) {
        return Promise.resolve({ accepted: false, textsGenerated: 0, error: 'agents paused' });
    }
    const character = String(message?.name || '').trim();
    if (!character) return Promise.resolve({ accepted: false, textsGenerated: 0, error: 'character is required' });
    const branch = resolvePhoneBranch(chat, {
        messageIndex,
        swipeId: message?.swipe_id,
    });
    return getPhoneQueue().enqueue({
        key: phoneQueueKey(character, branch),
        agent,
        message: { ...(message || {}), name: character, swipe_id: branch.swipeId ?? 0 },
        messageIndex: branch.messageIndex ?? Math.max(0, chat.length - 1),
        behavior,
        reason,
        source,
    });
}

// ============================================================================
// USER-INITIATED TEXT — called from the phone panel
// ============================================================================

/**
 * Store a user-initiated text. Does NOT generate a reply — the panel calls
 * generateAndStoreReply() for that.
 * @param {string} charKey
 * @param {string} userMessage
 * @returns {{from:string,name:string,content:string}}
 */
export function addUserText(charKey, userMessage) {
    const text = { from: 'user', name: substituteParams('{{user}}'), content: userMessage.trim() };
    const stored = addTextsToThread(charKey, [text], null, null);
    saveChatDebounced();
    syncInjection();
    notifyPhoneActivity({ kind: 'message', character: charKey, messages: stored.added });
    return text;
}

/**
 * Generate a character reply to a user text, store it, notify listeners.
 * The ONE self-owned LLM call (outside the lifecycle). User-initiated replies
 * always produce output — there's no trigger gate or [NO_TEXT] escape, and a
 * tagless response is wrapped as a single text rather than dropped.
 *
 * @param {string} charKey
 * @param {string} userMessage
 * @returns {Promise<Array<{from:string,name:string,content:string}>>}
 */
export async function generateAndStoreReply(charKey, userMessage) {
    if (isAgentsPaused()) {
        toastr.info('SuperAgents are paused. Phone state is frozen.');
        return [];
    }
    const startedInChatEpoch = phoneChatEpoch;
    const agent = getPhoneAgent();
    if (!agent) {
        debug(`${LOG_PREFIX} generateAndStoreReply: no enabled phone agent found — nothing to reply with`);
        return [];
    }
    if (agent.paused) {
        toastr.info('This Phone agent is paused. Its state is frozen.');
        return [];
    }

    const config = agent.phoneConfig;
    const surface = getActiveSurfacePresentation('phone') || {};
    const presentationPrompt = surface.prompt || {};
    const replyTemplate = config?.replyPrompt ?? agent.prompt;
    const maxTokens = config?.replyMaxTokens ?? 256;

    // Recent chat context (last 10 messages).
    const recentChat = [];
    const start = Math.max(0, chat.length - 10);
    for (let i = start; i < chat.length; i++) {
        const msg = chat[i];
        if (!msg) continue;
        const speaker = msg.is_user ? '{{user}}' : (msg.name || 'Character');
        recentChat.push(`[${speaker}]: ${msg.mes?.slice(0, 300)}`);
    }
    const recentChatContext = substituteParams(recentChat.join('\n\n'));

    // Text thread context (last 12).
    const thread = getThread(charKey);
    const threadText = (thread?.messages?.slice(-12) ?? [])
        .map(t => `${t.name}: ${t.content}`).join('\n');
    const branch = resolvePhoneBranch(chat);
    const stateContext = buildPhoneStateContext(charKey, {
        messageIndex: branch.messageIndex,
        swipeId: branch.swipeId,
        config: config?.stateContext,
    });

    // Function replacements (not string) so any '$' in the user's message or
    // chat context isn't interpreted as a replace-pattern token ($&, $1, ...).
    const behaviorContract = buildModelBehaviorContract(surface);
    const systemPrompt = substituteParams(replyTemplate)
        .replace('{{recent_chat_context}}', () => recentChatContext)
        .replace('{{text_thread}}', () => threadText || '(no previous texts)')
        .replace('{{user_message}}', () => userMessage)
        + (stateContext ? `\n\n${stateContext}` : '')
        + (behaviorContract ? `\n\n${behaviorContract}` : '');

    const userContent = fillPresentationTemplate(
        presentationPrompt.reply || 'Reply to this message in character as {name}. You MUST use [TEXT|{name}|content] for storage.',
        { name: charKey },
    );

    isReplyBusy = true;
    try {
        let response = await callAgentLLM({
            systemPrompt,
            userContent,
            profileRef: agent.connectionProfile,
            maxTokens,
            callerName: `${surface.title || 'Phone'} Reply: ${charKey}`,
        });
        if (startedInChatEpoch !== phoneChatEpoch) {
            debug(`${LOG_PREFIX} discarded ${charKey} reply after chat changed`);
            return [];
        }
        response = String(response ?? '').trim();
        debug(`${LOG_PREFIX} reply raw for ${charKey}: "${response.slice(0, 200)}"`);

        if (!response) return [];

        // [NO_TEXT] is authoritative: if the model declined, honor it before
        // any tag parsing or fallback-wrap (audit fix #11). Matches the order
        // executePhoneEvaluation uses, so a stray [TEXT|...] alongside a
        // [NO_TEXT] can't sneak a message through on the reply path.
        if (NO_TEXT_REGEX.test(response)) {
            debug(`${LOG_PREFIX} ${charKey}: reply declined ([NO_TEXT])`);
            return [];
        }

        let texts = parseTextTags(response);

        // Fallback: no tags but real content → wrap the whole thing as one text.
        if (texts.length === 0) {
            const cleaned = response.replace(/^```[\s\S]*?```$/gm, '').trim();
            if (cleaned) texts = [{ from: 'char', name: charKey, content: cleaned }];
        }
        if (texts.length === 0) return [];

        if (startedInChatEpoch !== phoneChatEpoch) return [];
        const stored = addTextsToThread(charKey, texts, null, null);
        saveChatDebounced();
        syncInjection();

        debug(`${LOG_PREFIX} ${charKey} replied with ${texts.length} text(s)`);
        notifyPhoneActivity({ kind: 'message', character: charKey, messages: stored.added });
        notifyTextListeners(charKey, texts, stored.added);
        return texts;
    } catch (err) {
        console.error(`${LOG_PREFIX} reply generation failed for ${charKey}:`, err);
        return [];
    } finally {
        isReplyBusy = false;
    }
}

/**
 * Stable integration command: ask the configured Phone agent to evaluate a
 * phone-worthy development for one character without showing manual-run UI.
 */
export async function requestCharacterText(options = {}) {
    if (isAgentsPaused()) {
        return { accepted: false, textsGenerated: 0, error: 'agents paused' };
    }
    const character = String(options.character || '').trim();
    if (!character) return { accepted: false, textsGenerated: 0, error: 'character is required' };

    const agent = getPhoneAgent();
    if (!agent) return { accepted: false, textsGenerated: 0, error: 'phone is not enabled' };
    if (agent.paused) return { accepted: false, textsGenerated: 0, error: 'agent paused' };

    const branch = resolvePhoneBranch(chat, options);
    const sourceMessage = branch.messageIndex == null ? null : chat[branch.messageIndex];
    const scene = String(options.scene || sourceMessage?.mes || '').trim();
    const message = {
        ...(sourceMessage || {}),
        name: character,
        swipe_id: branch.swipeId ?? 0,
        mes: scene,
    };

    return queuePhoneEvaluation({
        agent,
        message,
        messageIndex: branch.messageIndex ?? Math.max(0, chat.length - 1),
        behavior: options.behavior === 'send' ? 'send' : 'consider',
        reason: String(options.reason || '').trim(),
        source: String(options.source || 'integration'),
    });
}

// ============================================================================
// CONTEXT INJECTION  (ST extension_prompts, swept by the lifecycle)
// ============================================================================

/**
 * Build the formatted thread block injected into the narrative prompt.
 * @param {string} charKey
 * @param {number} [maxTexts]
 * @returns {string}
 */
function buildContextInjection(charKey, maxTexts = 8) {
    const thread = getThread(charKey);
    if (!thread?.messages?.length) return '';

    const limit = getPhoneConfig()?.maxInjectedTexts ?? maxTexts;
    const lines = thread.messages.slice(-limit).map(t => `${t.name}: ${t.content}`);
    const presentationPrompt = getActiveSurfacePresentation('phone')?.prompt || {};
    const header = fillPresentationTemplate(
        presentationPrompt.injectionHeader || 'Recent text messages between {{user}} and {name}',
        { name: charKey },
    );
    return [
        `[${header}]`,
        'These communications are private to their participants unless canon establishes that they were shared, intercepted, or observed.',
        ...lines,
    ].join('\n');
}

/**
 * Last group member ST drafted to speak (GROUP_MEMBER_DRAFTED), or null.
 * In a group, ST sets characterId to the speaker right before each member's
 * generation — but it's cleared to undefined between members and at the end of
 * the loop. This gives syncInjection a reliable fallback for "who is about to
 * speak" so we inject the correct character's thread per turn (audit fix #1).
 * Cleared on CHAT_CHANGED.
 * @type {string|null}
 */
let lastDraftedCharName = null;

/**
 * Resolve the character whose thread should be injected this turn: the live
 * speaker (ctx.characters[ctx.characterId]) when available, else the most
 * recently drafted group member. Returns null if neither resolves.
 * @returns {string|null}
 */
function resolveCurrentCharName() {
    const ctx = getContext();
    const charObj = ctx.characters?.[ctx.characterId];
    const live = charObj?.name ?? charObj?.data?.name ?? null;
    return live ?? lastDraftedCharName;
}

/**
 * Remove the phone context prompt from the injection registry.
 *
 * Just delete the key — no redundant setExtensionPrompt('') first (audit fix
 * #4). Writing an empty entry and immediately deleting it created a real
 * registry row for one tick that anything reading between the two calls could
 * trip over; the delete alone is sufficient and atomic.
 */
function clearInjection() {
    if (extension_prompts[PROMPT_KEY]) delete extension_prompts[PROMPT_KEY];
}

/**
 * Sync the injected thread block with the current character's thread. Called
 * after texts change and on GENERATION_AFTER_COMMANDS (before each generation).
 */
function syncInjection() {
    const agent = getPhoneAgent();
    if (!agent) { clearInjection(); return; }

    const charName = resolveCurrentCharName();
    if (!charName) { clearInjection(); debug(`${LOG_PREFIX} syncInjection: no character resolved`); return; }

    const injection = buildContextInjection(charName);
    if (!injection) { clearInjection(); return; }

    const depth = agent.phoneConfig?.injectionDepth ?? 1;
    // position 1 = in-chat at depth; role 0 = system. Matches the template's
    // injection intent and the sidecar-context convention in lifecycle.js.
    setExtensionPrompt(PROMPT_KEY, substituteParams(injection), 1, depth, false, 0);
    debug(`${LOG_PREFIX} syncInjection: injected ${injection.split('\n').length - 1} text(s) for ${charName}`);
}

// ============================================================================
// LISTENERS
// ============================================================================

/**
 * Subscribe to new-text events (panel UI). Receives (charKey, texts).
 * @param {function(string, Array): void} fn
 */
export function onNewText(fn) {
    textListeners.push(fn);
}

function notifyTextListeners(charKey, texts, storedMessages = []) {
    for (const fn of textListeners) {
        try { fn(charKey, texts, storedMessages); } catch { /* non-fatal */ }
    }
}

export function onPhoneActivity(fn) {
    if (typeof fn !== 'function') return () => {};
    activityListeners.push(fn);
    return () => {
        const index = activityListeners.indexOf(fn);
        if (index >= 0) activityListeners.splice(index, 1);
    };
}

function notifyPhoneActivity(event) {
    for (const listener of activityListeners) {
        try { listener(event); } catch { /* optional consumers are non-fatal */ }
    }
}

/** @returns {boolean} reply generation currently in flight. */
export function isPhoneBusy() {
    return isReplyBusy || getPhoneQueue().isBusy();
}

// ============================================================================
// INIT / CLEANUP
// ============================================================================

let initialized = false;

/**
 * Initialize phone logic. Called from index.js during init.
 *
 * No MESSAGE_RECEIVED listener — the lifecycle calls executePhoneEvaluation()
 * in its post-gen flow. This binds only the context-injection refresh
 * (GENERATION_AFTER_COMMANDS) and a CHAT_CHANGED clear.
 */
export function initPhoneAgent() {
    if (initialized) return;
    initialized = true;

    eventSource.on(event_types.GENERATION_AFTER_COMMANDS, () => syncInjection());
    onAgentsPauseChange((paused) => {
        if (!paused) return;
        phoneChatEpoch += 1;
        getPhoneQueue().clear('agents paused');
    });
    onAgentPauseChange((agent, paused) => {
        if (!paused || !agent?.phoneConfig) return;
        phoneChatEpoch += 1;
        getPhoneQueue().clear('phone agent paused');
    });
    if (event_types.MESSAGE_SWIPED) {
        eventSource.on(event_types.MESSAGE_SWIPED, () => syncInjection());
    }
    eventSource.on(event_types.CHAT_CHANGED, () => {
        phoneChatEpoch += 1;
        lastDraftedCharName = null;
        lastEvalTime.clear();
        getPhoneQueue().clear('chat changed');
        clearInjection();
    });

    // Group chats: ST drafts each member (sets characterId + emits this) right
    // before that member generates. Capture the drafted name so syncInjection
    // injects the correct character's thread even across the moments ST clears
    // characterId between members (audit fix #1).
    if (event_types.GROUP_MEMBER_DRAFTED) {
        eventSource.on(event_types.GROUP_MEMBER_DRAFTED, (chId) => {
            try {
                const ctx = getContext();
                const charObj = ctx.characters?.[chId];
                lastDraftedCharName = charObj?.name ?? charObj?.data?.name ?? null;
            } catch {
                lastDraftedCharName = null;
            }
        });
    }

    debug(`${LOG_PREFIX} phone agent initialized (lifecycle-managed evaluation)`);
}
