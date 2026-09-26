/**
 * core/lifecycle.js — the generation event engine.
 *
 * This is the heart of SuperAgents: it binds to SillyTavern's generation
 * lifecycle and orchestrates every agent run.
 *
 *   GENERATION_STARTED         → reset state, clear stale agent prompts
 *   GENERATION_AFTER_COMMANDS  → build activation snapshot, run pre-gen
 *                                sidecars, inject pre-gen + sidecar-context
 *                                prompts into the main generation
 *   MESSAGE_RECEIVED           → wait for streaming to finish (with a
 *                                deadline), then run post-gen agents
 *   GENERATION_ENDED / STOPPED → clear flags
 *   MESSAGE_EDITED / UPDATED   → re-run regex + rebuild sidecar display
 *   MESSAGE_SWIPED             → restore per-swipe state + rebuild display
 *
 * This module REPLACES the Step-4 checkpoint stopgap that lived in index.js
 * (runPostGenSidecars + bindLifecycleEvents + _checkpoint). It absorbs VM's
 * runner.js orchestration, rewired onto the SuperAgents module split:
 *   - activation logic           → core/activation.js
 *   - sidecar execution          → modes/sidecar.js
 *   - batching                   → modes/batch.js
 *   - rewrite / extract / append → modes/rewrite.js, modes/postProcess.js
 *   - merge variable             → modes/mergeVariable.js
 *   - regex extraction + display → render/regexProcessor.js, modes/sidecar.js
 *
 * Gameplan fix folded in here (problem #4): the streaming-wait poll has a
 * deadline (max attempts + interval ceiling) so it can never spin forever.
 *
 * Phone agents (Step 9) route through phone/phoneAgent.js: executeSingleAgent
 * and runAgentOnMessage call executePhoneEvaluation() for any enabled agent
 * carrying a phoneConfig (auto-gated post-gen, or forced from the play button).
 */

import {
    chat,
    chat_metadata,
    extension_prompts,
    setExtensionPrompt,
    substituteParams,
    saveChatDebounced,
    streamingProcessor,
} from '../../../../../../script.js';
import { getContext } from '../../../../../extensions.js';
import { eventSource, event_types } from '../../../../../events.js';
import { debug } from './runtime.js';
import { isAbortError } from './llm.js';

import {
    getEnabledAgents,
    getAgentById,
    getGroupById,
    getGlobalSettings,
    isAgentsPaused,
    onAgentsPauseChange,
    onAgentPauseChange,
    onStoreChange,
} from '../data/store.js';
import {
    normalizeGenType,
    buildActivationSnapshot,
    getSnapshotAgents,
} from './activation.js';
import { recordAgentRun } from './idempotency.js';
import { beginSelfGeneration, endSelfGeneration, isExternalGenerationActive } from './compatibility.js';
import { resetTurn, recordAgents, formatTurnHint } from './callStats.js';

import { formatMergeVariableData, executeMergeVariable, writeMergeArray, readMergeArray, bindVariableToSwipe, bindVariableToMessage, captureTurnBaseline, restoreTurnBaseline, resolveStateTrace, storeBatchedSidecarResult } from '../modes/mergeVariable.js';
import {
    executeSidecarAgent,
    buildSidecarDisplayData,
    buildPreGenContext,
    groupSidecarsByProfile,
} from '../modes/sidecar.js';
import { executeSidecarBatch, processPreGenAgents, rerollPreGenAgent } from '../modes/batch.js';
import { executeRewriteAgent } from '../modes/rewrite.js';
import { executeExtractAgent, executeAppendAgent } from '../modes/postProcess.js';
import { processAgentRegex, clearAgentData } from '../render/regexProcessor.js';
import { refreshMessage } from '../render/renderer.js';
import { getOwnSwipeDisplayItems, requiresOwnSwipeDisplay } from '../render/sidecarDisplayPolicy.js';
import { executePhoneEvaluation, queuePhoneEvaluation } from '../phone/phoneAgent.js';
import { executeFeedEvaluation, queueFeedEvaluation } from '../feed/feedAgent.js';
import { ownsCounterItself } from './everyN.js';
import { runGuardManually } from '../modes/continuityGuardRunner.js';
import { markActivationPolicyComplete } from './activationPolicy.js';
import { restoreRetainedSnapshots } from './snapshotReuse.js';
import { restoreStateAfterMessageDeletion } from './branchStateRestore.js';
import { AFTER_DARK_AUTO_CHECKPOINT_KEY, AFTER_DARK_NUDGE_VARIABLE, applyAfterDarkDropGuard, buildAfterDarkInjection, moveAfterDarkStage, readAfterDarkAutoAdvance, readAfterDarkAutoCheckpoint, readAfterDarkInjectionEnabled, readAfterDarkState, shouldAutoAdvanceAfterDark } from '../afterDark/afterDarkState.js';
import { DRAMA_QUEEN_AUTO_CHECKPOINT_KEY, DRAMA_QUEEN_NUDGE_VARIABLE, applyDramaQueenDropGuard, buildDramaQueenInjection, moveDramaQueenBeat, readDramaQueenAutoCheckpoint, readDramaQueenInjectionEnabled, readDramaQueenProgressionMode, readDramaQueenState, shouldAutoAdvanceDramaQueen } from '../dramaQueen/dramaQueenState.js';
import { buildPostGenUtilityTasks, getUtilityAnalysisVariables } from './utilityAnalysis.js';
import {
    clearDeferredSwipeAgentIds,
    isDeferrablePostAgent,
    rememberDeferredSwipeAgentIds,
} from './swipeDeferral.js';

const LOG_PREFIX = '[SuperAgents/lifecycle]';
const PROMPT_KEY_PREFIX = 'sa_agent_';

// Streaming-wait deadline (gameplan fix #4). The post-gen poll waits for the
// stream to finish but bails after this many attempts so it can't spin forever
// on a machine/back-end where the finish flag never trips.
const STREAM_POLL_INTERVAL_MS = 200;
const STREAM_POLL_MAX_ATTEMPTS = 150; // 150 × 200ms = 30s ceiling

// ============================================================================
// STATE
// ============================================================================

let isGenerationInProgress = false;
let isAgentRunInProgress = false;
let generationStopRequested = false;

// A MESSAGE_RECEIVED event is only eligible for automatic post-processing
// when it belongs to the generation currently armed by
// GENERATION_AFTER_COMMANDS. Chat hydration (including a brand-new card's
// greeting) can emit MESSAGE_RECEIVED without a generation; treating that as a
// normal turn makes every post agent run merely because a chat was opened.
// The revision also invalidates async work when the user changes/deletes chats.
let lifecycleRevision = 0;
let pendingPostGenClaimed = false;

/**
 * AbortController for the agent run currently in flight (post-gen batch or a
 * manual single run). cancelAgentRun() fires it; every callAgentLLM in the run
 * receives its signal and rejects with an AgentCallAbortedError. Null when no
 * run is active.
 * @type {AbortController|null}
 */
let activeRunController = null;

// MESSAGE_RECEIVED can be emitted again while the first handler is still
// waiting for streaming to settle. Coalesce by message identity so one visible
// response can never start duplicate post-agent batches.
const postGenJobs = new WeakMap();

/** Listeners notified when a run starts/stops, so the UI can show/hide stop. */
const runStateListeners = [];

/**
 * Register a callback fired whenever an agent run becomes active or inactive.
 * Receives the new boolean state. Used by the UI to toggle a stop button.
 * @param {function(boolean): void} fn
 */
export function onRunStateChange(fn) {
    if (typeof fn === 'function') runStateListeners.push(fn);
}

function setRunActive(active) {
    isAgentRunInProgress = active;
    for (const fn of runStateListeners) {
        try { fn(active); } catch (err) { console.warn(`${LOG_PREFIX} run-state listener error:`, err); }
    }
}

/**
 * Cancel the in-flight agent run, if any. Aborts every pending LLM call in the
 * run; each rejects with an abort error its caller treats as "stopped" (not a
 * failure, not an empty result). Safe to call when nothing is running.
 * @returns {boolean} true if a run was actually aborted.
 */
export function cancelAgentRun() {
    if (!activeRunController) return false;
    generationStopRequested = true;
    try { activeRunController.abort(); } catch { /* already aborted */ }
    debug(`${LOG_PREFIX} agent run cancel requested`);
    return true;
}

/** @returns {AbortSignal|null} signal for the active run (or null). */
export function getActiveRunSignal() {
    return activeRunController?.signal ?? null;
}

/**
 * Per-call options passed into every callAgentLLM in the active run: the
 * cancel signal plus the configured timeout. Read fresh at each call site so
 * a mid-run settings change or a fresh controller is always reflected.
 * @returns {{signal: AbortSignal|null, timeoutMs: number}}
 */
function runOpts() {
    const t = getGlobalSettings().agentCallTimeoutMs;
    return {
        signal: activeRunController?.signal ?? null,
        // Coerce to a sane number; undefined falls back to callAgentLLM's own
        // default, 0 explicitly disables the timeout.
        timeoutMs: (typeof t === 'number' && t >= 0) ? t : undefined,
    };
}

/** Snapshot of which agents activated for the current generation. */
let pendingSnapshot = null;

/**
 * Last activation set captured when pause begins. It is reused for reference
 * injection only; the `paused` marker prevents that turn from executing later
 * even if the user resumes before the main model finishes replying.
 */
let frozenSnapshot = null;
let enabledAgentIds = new Set();

/** Callbacks fired after post-gen processing completes (messageIndex). */
const postProcessListeners = [];

// ============================================================================
// HELPERS
// ============================================================================

/**
 * True while the given message index is still actively streaming.
 * @param {number} messageIndex
 * @returns {boolean}
 */
function isStreamingStillActive(messageIndex) {
    const sp = streamingProcessor;
    if (!sp || Number(sp.messageId) !== Number(messageIndex)) return false;
    return !sp.isFinished || isGenerationInProgress;
}

function isReceivedMessageCurrent(revision, snapshot, messageIndex, message) {
    return revision === lifecycleRevision
        && snapshot === pendingSnapshot
        && chat[messageIndex] === message;
}

/** Drop registered prompt fragments as soon as their source agent turns off. */
function clearDisabledAgentPrompts() {
    const enabledKeys = new Set();
    for (const agent of getEnabledAgents()) {
        enabledKeys.add(PROMPT_KEY_PREFIX + agent.id);
        enabledKeys.add(PROMPT_KEY_PREFIX + agent.id + '_ctx');
        enabledKeys.add(PROMPT_KEY_PREFIX + agent.id + '_after_dark');
        enabledKeys.add(PROMPT_KEY_PREFIX + agent.id + '_drama_queen');
    }
    for (const key of Object.keys(extension_prompts)) {
        if (key.startsWith(PROMPT_KEY_PREFIX) && !enabledKeys.has(key)) {
            delete extension_prompts[key];
        }
    }
}

function onLifecycleStoreChanged() {
    const nextEnabledIds = new Set(getEnabledAgents().map(agent => agent.id));
    clearDisabledAgentPrompts();

    // While globally paused, enablement changes redefine the frozen reference
    // set immediately. This covers restoring the active set while Pause Agents
    // is still on: every currently enabled agent contributes stored context,
    // but the empty runnable list guarantees none can execute.
    if (isAgentsPaused()) {
        const freezeEnabled = (snapshot) => {
            if (!snapshot) return;
            snapshot.activeAgentIds = [...nextEnabledIds];
            snapshot.runnableAgentIds = [];
            snapshot.retainedSnapshotAgentIds = [];
            snapshot.deferredCatchUpAgentIds = [];
            snapshot.paused = true;
        };
        freezeEnabled(pendingSnapshot);
        if (frozenSnapshot !== pendingSnapshot) freezeEnabled(frozenSnapshot);
    }

    const removedIds = [...enabledAgentIds].filter(id => !nextEnabledIds.has(id));
    enabledAgentIds = nextEnabledIds;
    if (!removedIds.length) return;

    const keepEnabled = (snapshot) => {
        if (!snapshot) return;
        for (const key of ['activeAgentIds', 'runnableAgentIds', 'retainedSnapshotAgentIds']) {
            if (Array.isArray(snapshot[key])) {
                snapshot[key] = snapshot[key].filter(id => nextEnabledIds.has(id));
            }
        }
    };
    keepEnabled(pendingSnapshot);
    if (frozenSnapshot !== pendingSnapshot) keepEnabled(frozenSnapshot);
    cancelAgentRun();
}

// ============================================================================
// PRE-GEN EVENT HANDLERS
// ============================================================================

/**
 * GENERATION_STARTED — reset per-turn state and clear any stale agent prompts
 * left in the extension_prompts registry from a previous turn.
 */
function onGenerationStarted() {
    if (isAgentRunInProgress) return;

    lifecycleRevision += 1;
    isGenerationInProgress = true;
    generationStopRequested = false;
    pendingSnapshot = null;
    pendingPostGenClaimed = false;
    resetTurn(); // zero the per-turn call/agent counters for the cost hint

    for (const key of Object.keys(extension_prompts)) {
        if (key.startsWith(PROMPT_KEY_PREFIX)) {
            delete extension_prompts[key];
        }
    }
}

/**
 * GENERATION_AFTER_COMMANDS — build the activation snapshot for this turn,
 * run pre-gen sidecars (their results are injected into the upcoming prompt),
 * then inject static pre-gen prompts and sidecar-context blocks.
 *
 * @param {string} generationType
 * @param {object} _options
 * @param {boolean} dryRun
 */
async function onGenerationAfterCommands(generationType, _options, dryRun) {
    if (dryRun || isAgentRunInProgress) return;

    pendingPostGenClaimed = false;
    const paused = isAgentsPaused();
    pendingSnapshot = paused
        ? {
            ...(frozenSnapshot || {
                generationType: normalizeGenType(generationType),
                activeAgentIds: getEnabledAgents().map(agent => agent.id),
                runnableAgentIds: [],
                pendingUserText: '',
            }),
            generationType: normalizeGenType(generationType),
            runnableAgentIds: [],
            paused: true,
        }
        : buildActivationSnapshot(generationType, _options);
    const activeAgents = getSnapshotAgents(pendingSnapshot);
    const runnableIds = new Set(pendingSnapshot.runnableAgentIds ?? pendingSnapshot.activeAgentIds ?? []);
    const retainedSnapshotIds = new Set(pendingSnapshot.retainedSnapshotAgentIds ?? []);
    const runnableAgents = activeAgents.filter(agent => agent.enabled && runnableIds.has(agent.id) && !agent.paused);
    const retainedSnapshotAgents = activeAgents.filter(agent => retainedSnapshotIds.has(agent.id));
    const genType = normalizeGenType(generationType);

    if (!paused && retainedSnapshotAgents.length) {
        restoreRetainedSnapshots(retainedSnapshotAgents);
    }

    // Per-turn memory baseline. Freeze the value a memory agent feeds back into
    // itself so a swipe/regenerate re-rolls against the PREVIOUS turn's value
    // (as the first attempt did), not the discarded attempt's output. A fresh
    // turn captures the current live value; a re-roll restores it before pre-gen
    // reads. Uses the RAW generation type so both of ST's reroll spellings are
    // recognized here. continue/impersonate/quiet are untouched — they don't
    // re-roll the last turn.
    const rawGenType = String(generationType ?? '').trim().toLowerCase();
    const isReroll = rawGenType === 'swipe' || rawGenType === 'regenerate';
    if (!paused && (isReroll || rawGenType === 'normal' || rawGenType === '')) {
        const memVars = new Set(
            runnableAgents
                .filter(a => (a.phase === 'pre' || a.phase === 'both')
                    && a.mergeVariable?.enabled
                    && a.mergeVariable.injectFormatted
                    && a.mergeVariable.variableName)
                .map(a => a.mergeVariable.variableName),
        );
        for (const varName of memVars) {
            if (isReroll) restoreTurnBaseline(varName);
            else captureTurnBaseline(varName);
        }
    }

    // Are there any pre-gen sidecar (LLM) agents this turn? If so, set up a
    // cancellable run around them so the user can abort a slow planner (e.g. a
    // Director on a heavy model) the same way they'd stop a generation. Static
    // pre-gen prompts and sidecar-context injection below make no LLM calls and
    // don't need the run scaffolding.
    const hasPreGenLLM = runnableAgents.some(a =>
        (a.phase === 'pre' || a.phase === 'both') && a.sidecarCall?.enabled,
    );

    // --- Pre-gen sidecar agents (LLM calls before main generation) ---
    // Run first so their output is injected ahead of static prompts. Errors
    // are caught inside processPreGenAgents and never block main generation.
    // The pending user message (captured on the snapshot) is threaded through
    // so rich-context planners see what the user just typed.
    const contextText = buildPreGenContext();

    if (!paused) {
        if (hasPreGenLLM) {
            activeRunController = new AbortController();
            generationStopRequested = false;
            setRunActive(true);
            beginSelfGeneration();
            try {
                await processPreGenAgents(runnableAgents, genType, contextText, pendingSnapshot.pendingUserText, runOpts());
            } catch (err) {
                if (!isAbortError(err)) console.error(`${LOG_PREFIX} pre-gen pass failed:`, err);
            } finally {
                endSelfGeneration();
                activeRunController = null;
                setRunActive(false);
            }
        } else {
            await processPreGenAgents(runnableAgents, genType, contextText, pendingSnapshot.pendingUserText);
        }
    }

    // --- Static pre-gen prompts (no LLM; skip sidecars, they already ran) ---
    const preAgents = activeAgents.filter(a =>
        a.enabled
        && !retainedSnapshotIds.has(a.id)
        && (a.phase === 'pre' || a.phase === 'both')
        && !a.sidecarCall?.enabled,
    );
    for (const agent of preAgents) {
        // Pause keeps stored reference state in the main prompt, but static
        // behavioral instructions must not continue steering the story.
        let expanded = paused ? '' : substituteParams(agent.prompt).trim();

        if (agent.mergeVariable?.enabled
            && agent.mergeVariable.injectFormatted
            && agent.mergeVariable.variableName
            && (!paused || agent.mergeVariable.autoInject !== false)) {
            const formatted = formatMergeVariableData(agent.mergeVariable, { projectPersona: true });
            if (formatted) expanded += expanded ? '\n\n' + formatted : formatted;
        }

        if (!expanded) continue;

        const key = PROMPT_KEY_PREFIX + agent.id;
        setExtensionPrompt(
            key,
            expanded,
            agent.injection.position,
            agent.injection.depth,
            agent.injection.scan,
            agent.injection.role,
        );
        if (!paused && runnableIds.has(agent.id)) markActivationPolicyComplete(agent);
        debug(`${LOG_PREFIX} injected pre-gen prompt for "${agent.name}" at depth ${agent.injection.depth}`);
    }

    // After Dark's planner call is manual-only, but a selected plan remains a
    // cheap authorial instruction until the user advances or drops it.
    {
        const planAgents = getEnabledAgents().filter(agent =>
            agent.afterDarkConfig?.enabled || agent.sourceTemplateId === 'tpl-after-dark',
        );
        for (const agent of planAgents) {
            const key = PROMPT_KEY_PREFIX + agent.id + '_after_dark';
            if (!readAfterDarkInjectionEnabled(chat_metadata)) {
                delete extension_prompts[key];
                continue;
            }
            const autoAdvance = readAfterDarkAutoAdvance(chat_metadata, agent.afterDarkConfig);
            const varName = agent.mergeVariable?.variableName || 'sa_after_dark';
            let items = readMergeArray(varName);
            let state = applyAfterDarkDropGuard(readAfterDarkState(items), chat_metadata);
            const lastAssistantIndex = findLastAssistantIndex();
            const rawStateMessageIndex = Number(items[items.length - 1]?._messageIndex);
            const fallbackMessageIndex = Number.isFinite(rawStateMessageIndex)
                ? rawStateMessageIndex
                : Number(state.active?.activatedAtMessage ?? -1);
            const stateMessageIndex = readAfterDarkAutoCheckpoint(chat_metadata, fallbackMessageIndex);
            if (!agent.paused && shouldAutoAdvanceAfterDark(state, {
                enabled: autoAdvance,
                generationType: genType,
                lastAssistantIndex,
                stateMessageIndex,
            })) {
                const message = chat[lastAssistantIndex];
                const stored = storeBatchedSidecarResult(
                    agent,
                    moveAfterDarkStage(state, 1),
                    message,
                    lastAssistantIndex,
                    'after_dark_auto',
                );
                if (stored) {
                    writeMergeArray(AFTER_DARK_NUDGE_VARIABLE, []);
                    bindVariableToMessage(message, AFTER_DARK_NUDGE_VARIABLE);
                    chat_metadata[AFTER_DARK_AUTO_CHECKPOINT_KEY] = lastAssistantIndex;
                    bindVariableToMessage(message, varName);
                    saveChatDebounced();
                    items = stored;
                    state = applyAfterDarkDropGuard(readAfterDarkState(items), chat_metadata);
                    debug(`${LOG_PREFIX} auto-advanced After Dark to beat ${state.active.stageIndex + 1}`);
                }
            }
            const prompt = buildAfterDarkInjection(state, {
                autoAdvance,
            });
            if (!prompt) {
                delete extension_prompts[key];
                continue;
            }
            setExtensionPrompt(
                key,
                prompt,
                agent.injection.position,
                agent.injection.depth,
                agent.injection.scan,
                agent.injection.role,
            );
            debug(`${LOG_PREFIX} injected active After Dark beat for "${agent.name}"`);
        }
    }

    // Drama Queen planning is manual. A selected engine contributes only its
    // current beat; proposals and future beats remain private author material.
    {
        const dramaAgents = getEnabledAgents().filter(agent =>
            agent.dramaQueenConfig?.enabled || agent.sourceTemplateId === 'tpl-drama-queen');
        for (const agent of dramaAgents) {
            const key = `${PROMPT_KEY_PREFIX}${agent.id}_drama_queen`;
            if (!readDramaQueenInjectionEnabled(chat_metadata)) {
                delete extension_prompts[key];
                continue;
            }
            const progressionMode = readDramaQueenProgressionMode(chat_metadata, agent.dramaQueenConfig);
            const varName = agent.mergeVariable?.variableName || 'sa_drama_queen';
            let items = readMergeArray(varName);
            let state = applyDramaQueenDropGuard(readDramaQueenState(items), chat_metadata);
            const lastAssistantIndex = findLastAssistantIndex();
            const rawStateMessageIndex = Number(items[items.length - 1]?._messageIndex);
            const fallbackMessageIndex = Number.isFinite(rawStateMessageIndex)
                ? rawStateMessageIndex
                : Number(state.active?.activatedAtMessage ?? -1);
            const stateMessageIndex = readDramaQueenAutoCheckpoint(chat_metadata, fallbackMessageIndex);
            if (!agent.paused && shouldAutoAdvanceDramaQueen(state, {
                enabled: progressionMode === 'auto',
                generationType: genType,
                lastAssistantIndex,
                stateMessageIndex,
            })) {
                const message = chat[lastAssistantIndex];
                const stored = storeBatchedSidecarResult(
                    agent,
                    moveDramaQueenBeat(state, 1),
                    message,
                    lastAssistantIndex,
                    'drama_queen_auto',
                );
                if (stored) {
                    writeMergeArray(DRAMA_QUEEN_NUDGE_VARIABLE, []);
                    bindVariableToMessage(message, DRAMA_QUEEN_NUDGE_VARIABLE);
                    chat_metadata[DRAMA_QUEEN_AUTO_CHECKPOINT_KEY] = lastAssistantIndex;
                    bindVariableToMessage(message, varName);
                    saveChatDebounced();
                    items = stored;
                    state = applyDramaQueenDropGuard(readDramaQueenState(items), chat_metadata);
                    debug(`${LOG_PREFIX} auto-advanced Drama Queen to beat ${state.active.beatIndex + 1}`);
                }
            }
            const prompt = buildDramaQueenInjection(state);
            if (!prompt) {
                delete extension_prompts[key];
                continue;
            }
            setExtensionPrompt(
                key,
                prompt,
                agent.injection.position,
                agent.injection.depth,
                agent.injection.scan,
                agent.injection.role,
            );
            debug(`${LOG_PREFIX} injected active Drama Queen beat for "${agent.name}"`);
        }
    }

    // --- Stored-state context injection ---
    // Sidecar agents don't inject their full prompt (the narrative model
    // shouldn't emit structured tags), but their tracked state SHOULD be
    // available for contextual awareness (e.g. current time/location). While
    // globally paused, the same snapshot rule also covers custom state-bearing
    // post agents that are not sidecars. Static pre agents were handled above.
    //
    // Gated by mergeVariable.autoInject (default on): turn it off to keep the
    // state out of the automatic chat context and instead place it yourself via
    // the {{sa_<name>}} / {{agent_<var>}} macro at an exact spot in your preset.
    const stateContextAgents = activeAgents.filter(a =>
        a.enabled &&
        (a.sidecarCall?.enabled || paused) &&
        !(!a.sidecarCall?.enabled && (a.phase === 'pre' || a.phase === 'both')) &&
        a.mergeVariable?.enabled &&
        a.mergeVariable.injectFormatted &&
        a.mergeVariable.autoInject !== false &&
        a.mergeVariable.variableName,
    );
    for (const agent of stateContextAgents) {
        const formatted = formatMergeVariableData(agent.mergeVariable, { projectPersona: true });
        if (!formatted?.trim()) continue;

        const key = PROMPT_KEY_PREFIX + agent.id + '_ctx';
        setExtensionPrompt(
            key,
            formatted,
            agent.injection.position,
            agent.injection.depth,
            agent.injection.scan,
            agent.injection.role,
        );
        debug(`${LOG_PREFIX} injected stored-state context for "${agent.name}" at depth ${agent.injection.depth}`);
    }
}

// ============================================================================
// POST-GEN ENTRY (MESSAGE_RECEIVED) — with streaming-wait deadline
// ============================================================================

/**
 * MESSAGE_RECEIVED — the post-gen entry point.
 *
 * If the message is still streaming, poll until the stream finishes, then run
 * post-gen agents. The poll is bounded (gameplan fix #4): it gives up after
 * STREAM_POLL_MAX_ATTEMPTS so a stuck finish-flag can't spin a timer forever.
 * On deadline we proceed anyway — a slightly-early run beats a hung one, and
 * CHARACTER_MESSAGE_RENDERED / MESSAGE_EDITED act as safety-net re-renders.
 *
 * @param {number} messageIndex
 */
async function onMessageReceived(messageIndex) {
    const idx = Number(messageIndex);
    const message = chat[idx];
    if (!message || message.is_user || message.is_system) return;
    const existingJob = postGenJobs.get(message);
    if (existingJob) {
        debug(`${LOG_PREFIX} coalesced duplicate post-gen entry for message ${idx}`);
        return existingJob;
    }
    if (!pendingSnapshot) {
        debug(`${LOG_PREFIX} ignored message ${idx}: no generation snapshot (chat load/greeting)`);
        return;
    }
    if (pendingPostGenClaimed) {
        debug(`${LOG_PREFIX} ignored duplicate post-gen entry for message ${idx}`);
        return;
    }
    if (isAgentRunInProgress) return;

    const revision = lifecycleRevision;
    const snapshot = pendingSnapshot;
    pendingPostGenClaimed = true;

    const job = processReceivedMessage(idx, message, revision, snapshot).finally(() => {
        if (postGenJobs.get(message) === job) postGenJobs.delete(message);
    });
    postGenJobs.set(message, job);
    return job;
}

async function processReceivedMessage(idx, message, revision, snapshot) {
    if (!isReceivedMessageCurrent(revision, snapshot, idx, message)) return;

    // Cooperative coexistence note (Step 8): if another generation-driving
    // extension is mid-pass on this turn, log it. We don't hard-block — ST's
    // generation mutex and our isAgentRunInProgress guard already serialize the
    // actual LLM calls — but surfacing the overlap helps diagnose ordering
    // issues with Stepped Thinking / Qvink / Recast.
    if (isExternalGenerationActive()) {
        debug(`${LOG_PREFIX} external generation active while post-gen begins for message ${idx}; relying on run-in-progress guard + ST mutex to serialize`);
    }

    if (!isStreamingStillActive(idx)) {
        if (generationStopRequested
            || !isReceivedMessageCurrent(revision, snapshot, idx, message)) return;
        await processPostGenAgents(idx, message, revision, snapshot);
        return;
    }

    // --- Bounded streaming wait ---
    debug(`${LOG_PREFIX} message ${idx} still streaming, deferring post-processing`);
    let attempts = 0;

    await new Promise((resolve) => {
        const checkInterval = setInterval(() => {
            attempts++;

            if (!isReceivedMessageCurrent(revision, snapshot, idx, message)) {
                clearInterval(checkInterval);
                resolve();
                return;
            }

            const stillStreaming = isStreamingStillActive(idx);
            const deadlineHit = attempts >= STREAM_POLL_MAX_ATTEMPTS;

            if (stillStreaming && !deadlineHit) return; // keep waiting

            clearInterval(checkInterval);

            if (deadlineHit && stillStreaming) {
                console.warn(`${LOG_PREFIX} streaming-wait deadline hit for message ${idx} after ${attempts} attempts; proceeding anyway`);
            }
            resolve();
        }, STREAM_POLL_INTERVAL_MS);
    });

    if (generationStopRequested
        || !isReceivedMessageCurrent(revision, snapshot, idx, message)) return;
    await processPostGenAgents(idx, message, revision, snapshot);
}

// ============================================================================
// GROUP-AWARE EXECUTION
// ============================================================================

/**
 * Organize post-gen agents into an ordered execution plan.
 *
 * Grouped agents inherit their group's executionMode + order. Ungrouped
 * agents fall into a virtual group that runs last in parallel mode —
 * preserving flat behavior for setups that don't use groups. Disabled or
 * missing groups demote their members to ungrouped.
 *
 * @param {object[]} agents — post-phase agents
 * @returns {Array<{id:string, order:number, executionMode:string, agents:object[]}>}
 */
function buildExecutionPlan(agents) {
    const grouped = new Map();
    const ungrouped = [];

    for (const agent of agents) {
        if (agent.groupId) {
            if (!grouped.has(agent.groupId)) grouped.set(agent.groupId, []);
            grouped.get(agent.groupId).push(agent);
        } else {
            ungrouped.push(agent);
        }
    }

    const plan = [];

    for (const [groupId, groupAgents] of grouped) {
        const groupConfig = getGroupById(groupId);
        if (!groupConfig || !groupConfig.enabled) {
            ungrouped.push(...groupAgents);
            continue;
        }
        plan.push({
            id: groupId,
            order: groupConfig.order ?? 100,
            executionMode: groupConfig.executionMode || 'parallel',
            batchMaxTokens: groupConfig.batchMaxTokens ?? null,
            agents: groupAgents,
        });
    }

    if (ungrouped.length > 0) {
        plan.push({
            id: '__ungrouped__',
            order: 9999,
            executionMode: 'parallel',
            batchMaxTokens: null,
            agents: ungrouped,
        });
    }

    plan.sort((a, b) => a.order - b.order);
    return plan;
}

/**
 * Evaluate an optional sidecar-only trigger against the response that was just
 * generated. Ordinary conditions are resolved before generation and therefore
 * cannot reliably see assistant-emitted protocol tags.
 *
 * Invalid patterns fail open: a typo must not silently disable an agent.
 */
function matchesCurrentResponse(agent, message) {
    const pattern = String(agent.sidecarCall?.currentMessagePattern || '').trim();
    if (!agent.sidecarCall?.enabled || !pattern) return true;

    try {
        const slashMatch = pattern.match(/^\/(.+)\/([gimsuy]*)$/);
        const regex = slashMatch
            ? new RegExp(slashMatch[1], slashMatch[2])
            : new RegExp(pattern, 'i');
        return regex.test(String(message?.mes || ''));
    } catch (err) {
        console.warn(`${LOG_PREFIX} invalid current-response pattern for "${agent.name}"; running without the gate`, err);
        return true;
    }
}

/**
 * Execute all agents within one group.
 *
 * Sequential groups: every agent runs one at a time in injection order, so a
 * later agent can read an earlier one's results.
 *
 * Parallel groups: sidecar agents batch by connection profile and run in
 * parallel; non-sidecar agents (which mutate message.mes) still run
 * sequentially so they can't clobber each other.
 *
 * @param {{executionMode:string, agents:object[]}} group
 * @param {object} message
 * @param {number} messageIndex
 * @param {string} generationType
 * @returns {Promise<{chatChanged:boolean, metadataChanged:boolean}>}
 */
async function executeGroup(group, message, messageIndex, generationType) {
    let chatChanged = false;
    let metadataChanged = false;

    if (group.executionMode === 'sequential') {
        const sorted = [...group.agents].sort((a, b) => a.injection.order - b.injection.order);
        for (const agent of sorted) {
            if (generationStopRequested) break;
            const result = await executeSingleAgent(agent, message, messageIndex, generationType);
            if (result.chatChanged) chatChanged = true;
            if (result.metadataChanged) metadataChanged = true;
        }
        return { chatChanged, metadataChanged };
    }

    // Parallel mode
    const sidecarAgents = group.agents.filter(a => a.sidecarCall?.enabled);
    const nonSidecarAgents = group.agents.filter(a => !a.sidecarCall?.enabled);

    // Sidecar batch — parallel across connection profiles
    if (sidecarAgents.length > 0 && !generationStopRequested) {
        const batches = groupSidecarsByProfile(sidecarAgents);
        const batchPromises = [...batches.values()].map(batch =>
            executeSidecarBatch(batch, message, messageIndex, generationType, {
                ...runOpts(),
                batchMaxTokens: group.batchMaxTokens,
            }),
        );
        const results = await Promise.allSettled(batchPromises);
        for (const result of results) {
            if (result.status === 'fulfilled' && result.value?.dataStored) {
                metadataChanged = true;
            } else if (result.status === 'rejected') {
                if (isAbortError(result.reason)) {
                    debug(`${LOG_PREFIX} sidecar batch cancelled`);
                } else {
                    console.error(`${LOG_PREFIX} sidecar batch failed:`, result.reason);
                }
            }
        }
    }

    // Non-sidecar agents — sequential (they modify message.mes)
    for (const agent of nonSidecarAgents) {
        if (generationStopRequested) break;
        const result = await executeSingleAgent(agent, message, messageIndex, generationType);
        if (result.chatChanged) chatChanged = true;
        if (result.metadataChanged) metadataChanged = true;
    }

    return { chatChanged, metadataChanged };
}

/**
 * Execute one agent's post-processing pipeline, routing to the right mode.
 *
 * Phone agents route to their diegetic text evaluator and do not alter chat prose.
 *
 * @param {object} agent
 * @param {object} message
 * @param {number} messageIndex
 * @param {string} generationType
 * @returns {Promise<{chatChanged:boolean, metadataChanged:boolean}>}
 */
async function executeSingleAgent(agent, message, messageIndex, generationType) {
    let chatChanged = false;
    let metadataChanged = false;
    let routeCompleted = true;

    // Phone agents — diegetic texting. The evaluation decides whether the
    // character texts {{user}} this turn and stores any texts to the thread;
    // the chat message itself is never modified, so neither flag flips.
    if (agent.phoneConfig != null) {
        try {
            await queuePhoneEvaluation({ agent, message, messageIndex, behavior: 'ambient', source: 'ambient' });
            markActivationPolicyComplete(agent);
        } catch (err) {
            console.error(`${LOG_PREFIX} phone evaluation failed for "${agent.name}":`, err);
        }
        return { chatChanged, metadataChanged };
    }

    // Feed posts are an off-scene surface: evaluation may publish to its own
    // branch-aware store, but it never modifies the assistant chat message.
    if (agent.feedConfig != null) {
        try {
            await queueFeedEvaluation({ agent, message, messageIndex, behavior: 'ambient', source: 'ambient' });
            markActivationPolicyComplete(agent);
        } catch (err) {
            console.error(`${LOG_PREFIX} feed evaluation failed for "${agent.name}":`, err);
        }
        return { chatChanged, metadataChanged };
    }

    // Sidecar-mode agents (solo path; batching handled in executeGroup)
    if (agent.sidecarCall?.enabled) {
        const result = await executeSidecarAgent(agent, message, messageIndex, generationType, runOpts());
        if (result.dataStored) metadataChanged = true;
        return { chatChanged, metadataChanged };
    }

    // Rewrite-mode agents (LLM call). Falls through to mergeVariable below —
    // a rewrite may append structured tags that still need extraction.
    if (agent.postProcess.rewriteEnabled) {
        const result = await executeRewriteAgent(agent, message, messageIndex, generationType, runOpts());
        routeCompleted = result.completed === true;
        if (result.changed) chatChanged = true;
    }

    // Non-LLM post-processing — only if NOT a rewrite agent
    if (!agent.postProcess.rewriteEnabled && agent.postProcess.enabled) {
        let result;
        switch (agent.postProcess.type) {
            case 'extract':
                result = executeExtractAgent(agent, message, messageIndex);
                break;
            case 'append':
                result = executeAppendAgent(agent, message, messageIndex);
                break;
        }
        if (result?.changed) chatChanged = true;
    }

    // Merge variable processing (runs independently of postProcess)
    if (agent.mergeVariable?.enabled) {
        const mergeResult = executeMergeVariable(agent, message, messageIndex);
        if (mergeResult.changed) chatChanged = true;
    }

    if (routeCompleted && (!agent.mergeVariable?.enabled || !agent.mergeVariable?.variableName)) {
        markActivationPolicyComplete(agent);
    }

    return { chatChanged, metadataChanged };
}

// ============================================================================
// POST-GEN ORCHESTRATOR
// ============================================================================

/**
 * Process all post-generation agents on a received message.
 *
 * Pipeline:
 *   1. Group-aware execution (sidecar batches, rewrites, merge vars, etc.)
 *   2. Regex extraction pass over ALL active agents with regexScripts —
 *      runs after rewrites/mergeVar so it targets the final message text.
 *   3. Rebuild sidecar display data (the regex pass clears saAgentData,
 *      including sidecar HUD data; rebuild it from the merge variables,
 *      which the regex clear doesn't touch).
 *   4. Save (if anything changed) + refresh the rendered message.
 *   5. Notify post-process listeners.
 *
 * The 300ms render timer from VM is gone (gameplan fix #3): the renderer is
 * event-driven (CHARACTER_MESSAGE_RENDERED is the safety net), so we refresh
 * the instant data lands.
 *
 * @param {number} messageIndex
 */
async function processPostGenAgents(messageIndex, expectedMessage, revision, snapshot) {
    if (!isReceivedMessageCurrent(revision, snapshot, messageIndex, expectedMessage)) return;
    const activeAgents = getSnapshotAgents(snapshot);
    const runnableIds = new Set(snapshot.runnableAgentIds ?? snapshot.activeAgentIds ?? []);
    const runnableAgents = snapshot?.paused || isAgentsPaused() ? []
        : activeAgents.filter(agent => agent.enabled && runnableIds.has(agent.id) && !agent.paused);
    const catchUpIds = new Set(snapshot.deferredCatchUpAgentIds ?? []);
    const catchUpAgents = activeAgents.filter(agent => catchUpIds.has(agent.id)
        && !agent.paused && isDeferrablePostAgent(agent));
    const candidatePostAgents = [...new Map([
        ...runnableAgents.filter(a => a.phase === 'post' || a.phase === 'both'),
        ...catchUpAgents,
    ].map(agent => [agent.id, agent])).values()];
    const postAgents = [];
    for (const agent of candidatePostAgents) {
        if (catchUpIds.has(agent.id) || matchesCurrentResponse(agent, expectedMessage)) postAgents.push(agent);
    }

    const deferSwipePostAgents = snapshot.generationType === 'swipe'
        && getGlobalSettings().deferPostAgentsOnSwipe;
    const deferredNow = deferSwipePostAgents
        ? postAgents.filter(isDeferrablePostAgent)
        : [];
    if (deferredNow.length) {
        rememberDeferredSwipeAgentIds(deferredNow.map(agent => agent.id));
        debug(`${LOG_PREFIX} deferred ${deferredNow.length} post-agent(s) until the next regular reply`);
    }
    const immediatePostAgents = deferredNow.length
        ? postAgents.filter(agent => !isDeferrablePostAgent(agent))
        : postAgents;

    const utilityTasks = deferSwipePostAgents ? [] : buildPostGenUtilityTasks({
        // Manual UtilityApps are intentionally absent from the ordinary
        // activation snapshot. Conditional runtime tasks consult the enabled
        // store while inheriting this turn's pause/current-message guards.
        agents: getEnabledAgents(),
        message: expectedMessage,
        messageIndex,
        generationType: snapshot.generationType,
    });
    const postTasks = [...immediatePostAgents, ...utilityTasks];

    if (postTasks.length === 0) {
        for (const listener of postProcessListeners) {
            try { listener(messageIndex); } catch (err) {
                console.warn(`${LOG_PREFIX} post-process listener error:`, err);
            }
        }
        return;
    }

    recordAgents(postTasks.length); // cost-hint accounting includes conditional utility work
    activeRunController = new AbortController();
    generationStopRequested = false;
    setRunActive(true);
    // Tell the compatibility guard the generations we're about to drive
    // (sidecar / rewrite LLM calls) are OURS, so it won't count their
    // GENERATION_STARTED/ENDED events as a foreign extension's work and make
    // us defer against ourselves.
    beginSelfGeneration();
    let chatChanged = false;
    let metadataChanged = false;
    const startedAt = globalThis.performance?.now?.() ?? Date.now();
    let finalizationStartedAt = startedAt;

    try {
        const message = expectedMessage;
        if (!isReceivedMessageCurrent(revision, snapshot, messageIndex, message)) return;

        // 1. Group-aware execution
        const executionPlan = buildExecutionPlan(postTasks);
        for (const group of executionPlan) {
            if (generationStopRequested) break;
            const result = await executeGroup(group, message, messageIndex, snapshot.generationType);
            if (result.chatChanged) chatChanged = true;
            if (result.metadataChanged) metadataChanged = true;
            if (!isReceivedMessageCurrent(revision, snapshot, messageIndex, message)) {
                generationStopRequested = true;
                break;
            }
        }
        finalizationStartedAt = globalThis.performance?.now?.() ?? Date.now();

        if (generationStopRequested
            || !isReceivedMessageCurrent(revision, snapshot, messageIndex, message)) return;

        // 2. Regex extraction pass (all active agents with regexScripts)
        const regexAgents = runnableAgents.filter(a =>
            Array.isArray(a.regexScripts) && a.regexScripts.length > 0,
        );
        for (const agent of regexAgents) {
            if (generationStopRequested) break;

            // Clear previous extraction data for idempotency (e.g. regenerate)
            if (clearAgentData(message, agent.id)) chatChanged = true;

            const result = await processAgentRegex(agent, message, messageIndex);
            if (!isReceivedMessageCurrent(revision, snapshot, messageIndex, message)) return;
            if (result.changed) chatChanged = true;

            if (result.extractionCount > 0) {
                recordAgentRun(messageIndex, {
                    agentId: agent.id,
                    agentName: agent.name,
                    phase: 'post',
                    originalText: null,
                    result: `${result.extractionCount} extraction(s)`,
                    mode: 'tagExtract',
                });
            }
        }

        // 3. Rebuild sidecar display data (regex pass above wiped saAgentData)
        const sidecarDisplayAgents = activeAgents.filter(a =>
            a.sidecarCall?.enabled && a.sidecarCall?.display?.enabled,
        );
        for (const agent of sidecarDisplayAgents) {
            const existing = message.extra?.saAgentData?.[agent.id];
            const ownItems = requiresOwnSwipeDisplay(agent)
                ? getOwnSwipeDisplayItems(agent, message)
                : null;
            if (requiresOwnSwipeDisplay(agent) && !ownItems?.length) {
                if (existing) {
                    delete message.extra.saAgentData[agent.id];
                    chatChanged = true;
                }
                continue;
            }
            const hasCurrentDisplay = existing?._swipeId === (message.swipe_id ?? 0)
                && Array.isArray(existing.scripts) && existing.scripts.length > 0;
            const regexMayHaveReplacedIt = Array.isArray(agent.regexScripts)
                && agent.regexScripts.length > 0;
            if (hasCurrentDisplay && !regexMayHaveReplacedIt) continue;
            buildSidecarDisplayData(agent, message, messageIndex, ownItems || undefined);
        }

        // 4. Save + refresh
        if (chatChanged || metadataChanged) {
            saveChatDebounced();
        }
        if (chatChanged) {
            const context = getContext();
            if (typeof context?.updateMessageBlock === 'function') {
                context.updateMessageBlock(messageIndex, message);
            }
            refreshMessage(messageIndex);
        } else if (metadataChanged) {
            refreshMessage(messageIndex);
        }

        // 5. Notify listeners
        for (const listener of postProcessListeners) {
            try {
                listener(messageIndex);
            } catch (err) {
                console.warn(`${LOG_PREFIX} post-process listener error:`, err);
            }
        }
    } catch (err) {
        if (isAbortError(err)
            || !isReceivedMessageCurrent(revision, snapshot, messageIndex, expectedMessage)) {
            debug(`${LOG_PREFIX} post-gen message ${messageIndex} cancelled`);
        } else {
            console.error(`${LOG_PREFIX} post-gen processing failed:`, err);
        }
    } finally {
        if (catchUpIds.size && !generationStopRequested) clearDeferredSwipeAgentIds(catchUpIds);
        const finishedAt = globalThis.performance?.now?.() ?? Date.now();
        debug(`${LOG_PREFIX} post-gen message ${messageIndex}: ${Math.round(finishedAt - startedAt)}ms total, `
            + `${Math.round(finishedAt - finalizationStartedAt)}ms synchronous finalization`);
        endSelfGeneration();
        activeRunController = null;
        setRunActive(false);

        // Cost hint (gameplan §6): one concise, non-blocking line per turn
        // showing agents-run vs actual calls, so batching savings are visible.
        if (!generationStopRequested
            && isReceivedMessageCurrent(revision, snapshot, messageIndex, expectedMessage)
            && immediatePostAgents.length > 0
            && getGlobalSettings().showCostHint) {
            const hint = formatTurnHint();
            if (hint) toastr.info(hint, 'SuperAgents', { timeOut: 4000 });
        }
    }
}

// ============================================================================
// GENERATION END HANDLERS
// ============================================================================

function onGenerationEnded() {
    if (isAgentRunInProgress) return;
    isGenerationInProgress = false;
    generationStopRequested = false;
}

function onGenerationStopped() {
    if (isAgentRunInProgress) return;
    generationStopRequested = true;
    isGenerationInProgress = false;
}

function onChatChanged() {
    // Invalidate first so a streaming-wait callback or a just-resolved model
    // promise cannot continue against the newly selected chat. cancelAgentRun
    // alone is insufficient before the post-gen AbortController exists.
    lifecycleRevision += 1;
    generationStopRequested = true;
    isGenerationInProgress = false;
    pendingSnapshot = null;
    pendingPostGenClaimed = false;
    frozenSnapshot = null;
    cancelAgentRun();
}

function onMessageDeleted() {
    onChatChanged();
    restoreStateAfterMessageDeletion();
    let checkpointCleared = false;
    for (const key of [AFTER_DARK_AUTO_CHECKPOINT_KEY, DRAMA_QUEEN_AUTO_CHECKPOINT_KEY]) {
        if (Number(chat_metadata?.[key]) < chat.length) continue;
        if (!(key in chat_metadata)) continue;
        delete chat_metadata[key];
        checkpointCleared = true;
    }
    if (checkpointCleared) saveChatDebounced();
}

// ============================================================================
// MESSAGE EDIT HANDLER
// ============================================================================

/**
 * MESSAGE_EDITED / MESSAGE_UPDATED — re-run regex scripts and rebuild sidecar
 * display when a message is hand-edited, so extractions + HUD track the new text.
 *
 * @param {number} messageIndex
 */
async function onMessageEdited(messageIndex) {
    const idx = Number(messageIndex);
    const message = chat[idx];
    if (!message || message.is_user || message.is_system) return;

    const allEnabled = getEnabledAgents();
    let changed = false;

    const regexAgents = allEnabled.filter(a =>
        !a.paused && Array.isArray(a.regexScripts) && a.regexScripts.length > 0,
    );
    for (const agent of regexAgents) {
        if (clearAgentData(message, agent.id)) changed = true;
        const result = await processAgentRegex(agent, message, idx);
        if (chat[idx] !== message) return;
        if (result.changed) changed = true;
    }

    const sidecarAgents = allEnabled.filter(a =>
        a.sidecarCall?.enabled && a.sidecarCall?.display?.enabled,
    );
    for (const agent of sidecarAgents) {
        if (requiresOwnSwipeDisplay(agent)) {
            const items = getOwnSwipeDisplayItems(agent, message);
            if (!items?.length) {
                if (message.extra?.saAgentData?.[agent.id]) {
                    delete message.extra.saAgentData[agent.id];
                    changed = true;
                }
                continue;
            }
            buildSidecarDisplayData(agent, message, idx, items);
            continue;
        }
        buildSidecarDisplayData(agent, message, idx);
    }

    if (changed) saveChatDebounced();

    // Always refresh (even with no extractions) to clear stale renders.
    refreshMessage(idx);
}

// ============================================================================
// PRE-GEN DISPLAY ATTACH (CHARACTER_MESSAGE_RENDERED)
// ============================================================================

/**
 * CHARACTER_MESSAGE_RENDERED — attach pre-gen agent display data to the bot
 * message that just rendered.
 *
 * Pre-gen agents (e.g. a Director) produce their output BEFORE the bot message
 * exists, so they store it to a chat variable but can't build per-message
 * display data the way post-gen sidecars do. Now that the message is here, for
 * each active pre-gen agent that has display enabled and a stored plan, build
 * the display data (reads the merge variable → writes message.extra.saAgentData)
 * and refresh so the HUD block appears under the reply.
 *
 * This is the SuperAgents analogue of Director's attachPendingOutline().
 *
 * @param {number} messageIndex
 */
async function onCharacterMessageRendered(messageIndex) {
    const idx = Number(messageIndex);
    const message = chat[idx];
    if (!message || message.is_user || message.is_system) return;

    // Use the turn's snapshot if present (the agents that actually fired this
    // turn), else fall back to all enabled agents.
    const agents = pendingSnapshot
        ? getSnapshotAgents(pendingSnapshot)
        : getEnabledAgents();

    const preGenDisplayAgents = agents.filter(a =>
        (a.phase === 'pre' || a.phase === 'both') &&
        a.sidecarCall?.enabled &&
        a.sidecarCall?.display?.enabled &&
        a.mergeVariable?.enabled &&
        a.mergeVariable.variableName,
    );
    if (preGenDisplayAgents.length === 0) return;

    const currentSwipeId = message.swipe_id ?? 0;
    let built = false;
    for (const agent of preGenDisplayAgents) {
        // Pin the agent's stored output to this message's active swipe so it
        // survives swipe navigation (pre-gen couldn't — the message didn't
        // exist yet). This MUST run on every render, even when post-gen already
        // built the display block: it is the ONLY place a pre-gen agent's plan
        // gets recorded per-swipe. Skipping it (the old presence guard did)
        // leaves swipe history empty, so swiping back later rebuilds from the
        // global var and shows the most-recent swipe's plan on an older swipe.
        bindVariableToSwipe(message, agent.mergeVariable.variableName);

        // Build the block only if it's missing or belongs to a different swipe.
        // Post-gen may have already built a correct one for the current swipe;
        // a leftover entry from another swipe is rebuilt against the pinned plan.
        const existing = message.extra?.saAgentData?.[agent.id];
        if (!existing || existing._swipeId !== currentSwipeId) {
            buildSidecarDisplayData(agent, message, idx);
            if (message.extra?.saAgentData?.[agent.id]) built = true;
        }
    }

    // Always persist: bindVariableToSwipe mutated per-swipe storage even when
    // no block was (re)built. Only refresh the DOM when a block actually changed.
    saveChatDebounced();
    if (built) {
        refreshMessage(idx);
        debug(`${LOG_PREFIX} attached pre-gen display to message ${idx}`);
    }
}

// ============================================================================
// SWIPE NAVIGATION HANDLER
// ============================================================================

/**
 * MESSAGE_SWIPED — restore per-swipe merge variable data and rebuild sidecar
 * display so the HUD matches the active swipe.
 *
 * Must fire BEFORE the renderer's own MESSAGE_SWIPED handler (which clears and
 * re-renders the DOM). Registration order guarantees this: initLifecycle runs
 * before initRenderer.
 *
 * @param {number} messageIndex
 */
function onSwipeNavigation(messageIndex) {
    const idx = Number(messageIndex);
    const message = chat[idx];
    if (!message) return;

    const currentSwipeId = message.swipe_id ?? 0;

    // Restore merge variable data for THIS swipe via the BACKWARD TRACE.
    //
    // Old behavior only restored vars that had an own-record on this exact
    // swipe, and left everything else holding the newest swipe's value — so
    // navigating back to a swipe that never tracked state showed the wrong
    // branch's data. The resolver instead walks backward to the most recent
    // tracked snapshot (following the branch being viewed up-thread), so an
    // untracked swipe inherits the last real state before it, and a genuinely
    // stateless start-of-chat resolves to null → cleared to empty.
    //
    // We drive the walk from the set of merge vars owned by enabled agents (the
    // current message may have NO saAgentSwipes at all — that's the bug case —
    // so we can't derive the var list from this message's records alone).
    const trackedVars = new Set(
        getEnabledAgents()
            .map(a => a.mergeVariable?.variableName)
            .filter(Boolean),
    );
    for (const varName of getUtilityAnalysisVariables()) trackedVars.add(varName);
    // Back-compat: also cover any var that only exists in stored per-swipe
    // history (e.g. an agent later disabled) so its display doesn't go stale.
    const legacySwipes = message.saAgentSwipes ?? message.extra?.saAgentSwipes;
    if (legacySwipes) {
        for (const varName of Object.keys(legacySwipes)) trackedVars.add(varName);
    }

    const resolved = new Map();
    for (const varName of trackedVars) {
        const items = resolveStateTrace(chat, idx, currentSwipeId, varName);
        // null → nothing anywhere down the trace: clear to empty so next turn's
        // LLM sees formatEmpty instead of another swipe's leftovers.
        writeMergeArray(varName, items ?? []);
        resolved.set(varName, items ?? []);
    }

    // Rebuild sidecar display for every state-bearing agent from the freshly
    // resolved var. Safe now: the value written above is correct for THIS swipe
    // (the resolver already followed the trace), so rebuilding can't stamp a
    // newer swipe's data onto an older one the way the old global-var read could.
    const sidecarAgents = getEnabledAgents().filter(a =>
        a.sidecarCall?.enabled && a.sidecarCall?.display?.enabled,
    );
    for (const agent of sidecarAgents) {
        const varName = agent.mergeVariable?.variableName;
        if (!varName || !resolved.has(varName)) continue;
        if (message.extra?.saAgentData?.[agent.id]) {
            delete message.extra.saAgentData[agent.id];
        }
        const items = requiresOwnSwipeDisplay(agent)
            ? getOwnSwipeDisplayItems(agent, message, currentSwipeId)
            : resolved.get(varName);
        if (items?.length) buildSidecarDisplayData(agent, message, idx, items);
    }

    debug(`${LOG_PREFIX} swipe ${currentSwipeId}: trace-resolved ${resolved.size} var(s) + rebuilt display`);
}

// ============================================================================
// PUBLIC API
// ============================================================================

/**
 * Find the index of the most recent assistant (non-user, non-system) message.
 * @returns {number} the chat index, or -1 if there is no such message.
 */
export function findLastAssistantIndex() {
    for (let i = chat.length - 1; i >= 0; i--) {
        if (chat[i] && !chat[i].is_user && !chat[i].is_system) return i;
    }
    return -1;
}

/**
 * Manually run a single agent on the most recent assistant message. Shared by
 * the management modal's per-agent run button and UIBedazzler's flyout play
 * badge, so the "which message counts as last" rule lives in exactly one place.
 *
 * Surfaces its own toasts (no assistant message / failure) so callers don't
 * have to. Returns the same result shape as runAgentOnMessage, plus a
 * { skipped: true } marker when there was no assistant message to target.
 *
 * @param {string} agentId
 * @param {{promptSuffix?:string, allowWhilePaused?:boolean, timeoutMs?:number}} [options]
 * @returns {Promise<{changed:boolean, error?:string, skipped?:boolean}>}
 */
export async function runAgentOnLastMessage(agentId, options = {}) {
    const targetIdx = findLastAssistantIndex();
    if (targetIdx < 0) {
        toastr.warning('No assistant message to run the agent on.');
        return { changed: false, skipped: true };
    }
    const result = await runAgentOnMessage(agentId, targetIdx, options);
    if (result?.error) toastr.error(`Agent failed: ${result.error}`);
    return result;
}

/**
 * Manually run every member of a group on the most recent assistant message.
 * Like the per-agent play button, this is an explicit run: saved enabled state
 * and automatic activation rules are not consulted. The global pause and each
 * member's individual pause still apply.
 *
 * @param {string} groupId
 * @returns {Promise<{changed:boolean, errors?:Array<{agentId:string,error:string}>, skipped?:boolean}>}
 */
export async function runGroupOnLastMessage(groupId) {
    const targetIdx = findLastAssistantIndex();
    if (targetIdx < 0) {
        toastr.warning('No assistant message to run the group on.');
        return { changed: false, skipped: true };
    }
    const result = await runGroupOnMessage(groupId, targetIdx);
    if (result?.errors?.length) {
        const noun = result.errors.length === 1 ? 'agent failed' : 'agents failed';
        toastr.error(`${result.errors.length} group ${noun}.`);
    }
    return result;
}

/**
 * Reroll a pre-gen agent (e.g. the Director): re-run its pre-gen planner for
 * the upcoming turn with self-memory BLINDFOLDED this once, so a plan the user
 * disliked doesn't anchor the retry. Distinct from runAgentOnLastMessage —
 * that's target selection (run on an existing reply, post-gen); this is memory
 * suppression on the pre-gen planner. The blindfold changes only what this run
 * reads; stored history is untouched.
 *
 * Shares the re-entrancy guard + run-active UI signalling with the manual run
 * path so a reroll can't overlap another agent run. Surfaces its own toasts.
 *
 * @param {string} agentId
 * @returns {Promise<{changed:boolean, error?:string, skipped?:boolean}>}
 */
export async function rerollAgentPreGen(agentId) {
    if (isAgentRunInProgress) {
        toastr.warning('Another agent is currently running.');
        return { changed: false, skipped: true };
    }

    const agent = getAgentById(agentId);
    if (!agent) {
        toastr.error('Agent not found.');
        return { changed: false };
    }
    if (!agent.enabled) {
        toastr.info('This agent is off. Enable it before rerolling.');
        return { changed: false, skipped: true };
    }
    if (agent.paused) {
        toastr.info('This agent is paused. Resume it before rerolling.');
        return { changed: false, skipped: true };
    }
    if (!agent.sidecarCall?.enabled || (agent.phase !== 'pre' && agent.phase !== 'both')) {
        toastr.info('Reroll applies to pre-gen planners only.', agent.name);
        return { changed: false, skipped: true };
    }

    isAgentRunInProgress = true;
    activeRunController = new AbortController();
    generationStopRequested = false;
    setRunActive(true);
    beginSelfGeneration();
    try {
        const result = await rerollPreGenAgent(agent, runOpts());
        if (result?.error) {
            toastr.error(`Reroll failed: ${result.error}`);
            return { changed: false, error: result.error };
        }
        // Refresh the display block for the last assistant message so the new
        // plan shows immediately (the plan HUD reads the persisted variable).
        const lastIdx = findLastAssistantIndex();
        if (lastIdx >= 0) {
            saveChatDebounced();
            refreshMessage(lastIdx);
        }
        if (getGlobalSettings().showNotifications) {
            toastr.info('Rerolled — memory suppressed for this pass.', agent.name, { timeOut: 3000 });
        }
        return { changed: true };
    } catch (err) {
        if (isAbortError(err)) return { changed: false, skipped: true };
        console.error(`${LOG_PREFIX} reroll failed:`, err);
        toastr.error(`Reroll failed: ${err?.message || err}`);
        return { changed: false, error: String(err?.message || err) };
    } finally {
        isAgentRunInProgress = false;
        activeRunController = null;
        setRunActive(false);
        endSelfGeneration();
    }
}

/**
 * Manually run a single agent on a message (slash command / button).
 *
 * @param {string} agentId
 * @param {number} messageIndex
 * @param {{promptSuffix?:string, allowWhilePaused?:boolean, timeoutMs?:number}} [options]
 * @returns {Promise<{changed:boolean, error?:string, textsGenerated?:number}>}
 */
export async function runAgentOnMessage(agentId, messageIndex, options = {}) {
    if (isAgentRunInProgress) {
        toastr.warning('Another agent is currently running.');
        return { changed: false };
    }

    const agent = getAgentById(agentId);
    if (!agent) {
        toastr.error('Agent not found.');
        return { changed: false };
    }
    if (!agent.enabled) {
        toastr.info('This agent is off. Enable it before running.');
        return { changed: false, skipped: true };
    }
    if (agent.paused && options.allowWhilePaused !== true) {
        toastr.info('This agent is paused. Resume it before running.');
        return { changed: false, skipped: true };
    }

    const message = chat[messageIndex];
    if (!message || message.is_user || message.is_system) {
        toastr.warning('No valid assistant message at that index.');
        return { changed: false };
    }

    beginManualRun();
    try {
        return await executeManualAgent(agent, message, messageIndex, options);
    } catch (err) {
        return manualRunError(agent, err);
    } finally {
        endManualRun();
    }
}

/**
 * Manually run a configured group on one assistant message. Sequential groups
 * honor member injection order. Parallel groups run sidecars concurrently,
 * then run message-mutating and external-surface agents one at a time, matching
 * the safety boundary used by automatic group execution.
 *
 * Off agents never run. Paused agents remain enabled but are skipped so their
 * frozen state and presentation stay intact.
 *
 * @param {string} groupId
 * @param {number} messageIndex
 * @returns {Promise<{changed:boolean, errors:Array<{agentId:string,error:string}>, skippedCount:number}>}
 */
export async function runGroupOnMessage(groupId, messageIndex) {
    if (isAgentRunInProgress) {
        toastr.warning('Another agent is currently running.');
        return { changed: false, errors: [], skippedCount: 0 };
    }

    const group = getGroupById(groupId);
    if (!group) {
        toastr.error('Group not found.');
        return { changed: false, errors: [], skippedCount: 0 };
    }

    const message = chat[messageIndex];
    if (!message || message.is_user || message.is_system) {
        toastr.warning('No valid assistant message at that index.');
        return { changed: false, errors: [], skippedCount: 0 };
    }

    const members = (group.agentIds || []).map(getAgentById).filter(Boolean);
    const runnable = members.filter(agent => agent.enabled && !agent.paused);
    const skippedCount = members.length - runnable.length;
    if (!runnable.length) {
        const reason = !members.length
            ? 'This group has no agents.'
            : members.some(agent => agent.enabled)
                ? 'Every enabled agent in this group is paused.'
                : 'Every agent in this group is off.';
        toastr.info(reason, group.name || 'Group');
        return { changed: false, errors: [], skippedCount, skipped: true };
    }
    if (skippedCount > 0) {
        toastr.info(`Skipped ${skippedCount} off or paused group agent${skippedCount === 1 ? '' : 's'}.`, group.name || 'Group');
    }

    beginManualRun();
    try {
        const results = [];
        const errors = [];
        const runMember = async (agent) => {
            if (generationStopRequested) return;
            try {
                const result = await executeManualAgent(agent, message, messageIndex);
                results.push(result);
            } catch (err) {
                const result = manualRunError(agent, err);
                results.push(result);
                if (result.error) errors.push({ agentId: agent.id, error: result.error });
            }
        };

        if (group.executionMode === 'sequential') {
            const ordered = [...runnable].sort((a, b) => (a.injection?.order ?? 100) - (b.injection?.order ?? 100));
            for (const agent of ordered) await runMember(agent);
        } else {
            const sidecars = runnable.filter(agent => agent.sidecarCall?.enabled);
            const remaining = runnable.filter(agent => !agent.sidecarCall?.enabled);
            const batches = [...groupSidecarsByProfile(sidecars).values()];
            await Promise.all(batches.map(async (batch) => {
                try {
                    const result = await executeSidecarBatch(batch, message, messageIndex, 'normal', {
                        ...runOpts(),
                        batchMaxTokens: group.batchMaxTokens,
                    });
                    results.push(result);
                    if (result.dataStored) {
                        saveChatDebounced();
                        refreshMessage(messageIndex);
                    }
                } catch (err) {
                    if (isAbortError(err)) {
                        debug(`${LOG_PREFIX} manual group batch cancelled`);
                        results.push({ changed: false, cancelled: true });
                        return;
                    }
                    console.error(`${LOG_PREFIX} manual group batch failed:`, err);
                    const error = err?.message || String(err);
                    for (const agent of batch) errors.push({ agentId: agent.id, error });
                    results.push({ changed: false, error });
                }
            }));
            for (const agent of remaining) await runMember(agent);
        }

        return {
            changed: results.some(result => result?.changed || result?.dataStored),
            errors,
            skippedCount,
        };
    } finally {
        endManualRun();
    }
}

function beginManualRun() {
    isAgentRunInProgress = true;
    activeRunController = new AbortController();
    generationStopRequested = false;
    setRunActive(true);
    beginSelfGeneration();
}

function endManualRun() {
    endSelfGeneration();
    activeRunController = null;
    setRunActive(false);
}

function manualRunError(agent, err) {
    if (isAbortError(err)) {
        debug(`${LOG_PREFIX} manual run of "${agent.name}" cancelled`);
        return { changed: false, cancelled: true };
    }
    console.error(`${LOG_PREFIX} manual run of "${agent.name}" failed:`, err);
    return { changed: false, error: err?.message || String(err) };
}

/** Execute one agent using the exact route behind its individual play button. */
async function executeManualAgent(agent, message, messageIndex, options = {}) {
    // Continuity Guard has its own deterministic manual sweep.
    if (ownsCounterItself(agent)) {
        const res = runGuardManually(messageIndex);
        const notify = getGlobalSettings().showNotifications;
        if (!res.ready) {
            toastr.info('Guard needs an enabled State Card with tracked state.', agent.name);
        } else if (!res.hadFinding && notify) {
            toastr.info('Checked — no continuity issues found.', agent.name, { timeOut: 3000 });
        }
        return { changed: res.flagged };
    }

    // Manual phone/feed runs deliberately bypass their ambient trigger gates.
    if (agent.phoneConfig != null) {
        const result = await executePhoneEvaluation(agent, message, messageIndex, true);
        return { changed: false, textsGenerated: result?.textsGenerated ?? 0 };
    }
    if (agent.feedConfig != null) {
        const result = await executeFeedEvaluation(
            agent, message, messageIndex, 'publish', message.name, '', true,
        );
        return { changed: false, postsGenerated: result?.postsGenerated ?? 0 };
    }

    if (agent.sidecarCall?.enabled) {
        const promptSuffix = String(options.promptSuffix || '').trim();
        const runAgent = promptSuffix
            ? { ...agent, prompt: `${agent.prompt}\n\n${promptSuffix}` }
            : agent;
        const opts = runOpts();
        if (typeof options.timeoutMs === 'number' && options.timeoutMs >= 0) {
            opts.timeoutMs = options.timeoutMs;
        }
        const result = await executeSidecarAgent(runAgent, message, messageIndex, 'normal', opts);
        if (result.dataStored) {
            saveChatDebounced();
            refreshMessage(messageIndex);
        }
        return result;
    }

    let result;
    if (agent.postProcess.rewriteEnabled) {
        result = await executeRewriteAgent(agent, message, messageIndex, 'normal', runOpts());
    } else if (agent.postProcess.enabled) {
        switch (agent.postProcess.type) {
            case 'extract': result = executeExtractAgent(agent, message, messageIndex); break;
            case 'append': result = executeAppendAgent(agent, message, messageIndex); break;
            default: result = { changed: false };
        }
    } else {
        if (!agent.mergeVariable?.enabled) {
            toastr.info('This agent has no post-processing configured.', agent.name);
        }
        result = { changed: false };
    }

    if (agent.mergeVariable?.enabled) {
        const mergeResult = executeMergeVariable(agent, message, messageIndex);
        result = { ...result, changed: Boolean(result.changed || mergeResult.changed) };
    }

    if (result.changed) {
        saveChatDebounced();
        const context = getContext();
        if (typeof context?.updateMessageBlock === 'function') {
            context.updateMessageBlock(messageIndex, message);
        }
        refreshMessage(messageIndex);
    }
    return result;
}

/** @returns {boolean} whether an agent run is currently in progress. */
export function isAgentRunActive() {
    return isAgentRunInProgress;
}

/**
 * Register a callback fired after post-gen processing completes.
 * @param {function(number): void} fn — receives the messageIndex
 */
export function onPostProcessComplete(fn) {
    postProcessListeners.push(fn);
}

// ============================================================================
// INIT
// ============================================================================

/**
 * Bind all generation lifecycle listeners. Called once from index.js.
 * Registers BEFORE initRenderer so the swipe handler rebuilds state ahead of
 * the renderer's DOM re-render.
 */
export function initLifecycle() {
    if (initLifecycle.initialized) return;
    initLifecycle.initialized = true;
    // A response that began in one chat must never be allowed to finish against
    // another chat's metadata. Every lifecycle-owned LLM call receives this
    // controller's signal, so changing chats cancels the whole active pass.
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
    eventSource.on(event_types.GENERATION_STARTED, onGenerationStarted);
    eventSource.on(event_types.GENERATION_AFTER_COMMANDS, onGenerationAfterCommands);
    eventSource.on(event_types.GENERATION_ENDED, onGenerationEnded);
    eventSource.on(event_types.GENERATION_STOPPED, onGenerationStopped);
    eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);
    enabledAgentIds = new Set(getEnabledAgents().map(agent => agent.id));
    onStoreChange(onLifecycleStoreChanged);
    onAgentsPauseChange((paused) => {
        if (!paused) {
            frozenSnapshot = null;
            return;
        }
        const frozenAgentIds = getEnabledAgents().map(agent => agent.id);
        frozenSnapshot = {
            ...(pendingSnapshot || {
                generationType: 'normal',
                runnableAgentIds: [],
                pendingUserText: '',
            }),
            activeAgentIds: frozenAgentIds,
            runnableAgentIds: [],
            retainedSnapshotAgentIds: [],
            deferredCatchUpAgentIds: [],
            paused: true,
        };
        pendingSnapshot = { ...frozenSnapshot };
        generationStopRequested = true;
        cancelAgentRun();
    });
    onAgentPauseChange((agent, paused) => {
        if (!paused) return;
        const freezeInSnapshot = (snapshot) => {
            if (!snapshot) return;
            const activeIds = new Set(snapshot.activeAgentIds || []);
            activeIds.add(agent.id);
            snapshot.activeAgentIds = [...activeIds];
            snapshot.runnableAgentIds = (snapshot.runnableAgentIds
                ?? snapshot.activeAgentIds)
                .filter(id => id !== agent.id);
        };
        freezeInSnapshot(pendingSnapshot);
        if (frozenSnapshot !== pendingSnapshot) freezeInSnapshot(frozenSnapshot);
        // If this agent is currently inside a lifecycle-owned call, abort the
        // pass so it cannot commit a late result after becoming frozen.
        cancelAgentRun();
    });

    if (event_types.MESSAGE_EDITED) {
        eventSource.on(event_types.MESSAGE_EDITED, onMessageEdited);
    }
    if (event_types.MESSAGE_UPDATED && event_types.MESSAGE_UPDATED !== event_types.MESSAGE_EDITED) {
        eventSource.on(event_types.MESSAGE_UPDATED, onMessageEdited);
    }
    if (event_types.MESSAGE_SWIPED) {
        eventSource.on(event_types.MESSAGE_SWIPED, onSwipeNavigation);
    }
    if (event_types.MESSAGE_DELETED) {
        eventSource.on(event_types.MESSAGE_DELETED, onMessageDeleted);
    }

    // Attach pre-gen agent display (e.g. Director plan) to the bot message once
    // it renders. Registered before initRenderer so saAgentData is written
    // before the renderer's own CHARACTER_MESSAGE_RENDERED safety-net reads it.
    if (event_types.CHARACTER_MESSAGE_RENDERED) {
        eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, onCharacterMessageRendered);
    }

    debug(`${LOG_PREFIX} lifecycle initialized`);
}
