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
    extension_prompts,
    setExtensionPrompt,
    substituteParams,
    saveChatDebounced,
    streamingProcessor,
} from '../../../../../../script.js';
import { getContext } from '../../../../../extensions.js';
import { eventSource, event_types } from '../../../../../events.js';
import { debug } from '../../index.js';
import { isAbortError } from './llm.js';

import {
    getEnabledAgents,
    getAgentById,
    getGroupById,
    getGlobalSettings,
} from '../data/store.js';
import {
    normalizeGenType,
    buildActivationSnapshot,
    getSnapshotAgents,
} from './activation.js';
import { recordAgentRun } from './idempotency.js';
import { beginSelfGeneration, endSelfGeneration, isExternalGenerationActive } from './compatibility.js';
import { resetTurn, recordAgents, formatTurnHint } from './callStats.js';

import { formatMergeVariableData, executeMergeVariable, writeMergeArray } from '../modes/mergeVariable.js';
import {
    executeSidecarAgent,
    buildSidecarDisplayData,
    buildPreGenContext,
    groupSidecarsByProfile,
} from '../modes/sidecar.js';
import { executeSidecarBatch, processPreGenAgents } from '../modes/batch.js';
import { executeRewriteAgent } from '../modes/rewrite.js';
import { executeExtractAgent, executeAppendAgent } from '../modes/postProcess.js';
import { processAgentRegex, clearAgentData } from '../render/regexProcessor.js';
import { refreshMessage } from '../render/renderer.js';
import { executePhoneEvaluation } from '../phone/phoneAgent.js';

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

/**
 * AbortController for the agent run currently in flight (post-gen batch or a
 * manual single run). cancelAgentRun() fires it; every callAgentLLM in the run
 * receives its signal and rejects with an AgentCallAbortedError. Null when no
 * run is active.
 * @type {AbortController|null}
 */
let activeRunController = null;

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

// ============================================================================
// PRE-GEN EVENT HANDLERS
// ============================================================================

/**
 * GENERATION_STARTED — reset per-turn state and clear any stale agent prompts
 * left in the extension_prompts registry from a previous turn.
 */
function onGenerationStarted() {
    if (isAgentRunInProgress) return;

    isGenerationInProgress = true;
    generationStopRequested = false;
    pendingSnapshot = null;
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

    pendingSnapshot = buildActivationSnapshot(generationType);
    const activeAgents = getSnapshotAgents(pendingSnapshot);
    const genType = normalizeGenType(generationType);

    // --- Pre-gen sidecar agents (LLM calls before main generation) ---
    // Run first so their output is injected ahead of static prompts. Errors
    // are caught inside processPreGenAgents and never block main generation.
    const contextText = buildPreGenContext();
    await processPreGenAgents(activeAgents, genType, contextText);

    // --- Static pre-gen prompts (no LLM; skip sidecars, they already ran) ---
    const preAgents = activeAgents.filter(a =>
        (a.phase === 'pre' || a.phase === 'both') && !a.sidecarCall?.enabled,
    );
    for (const agent of preAgents) {
        let expanded = substituteParams(agent.prompt).trim();
        if (!expanded) continue;

        if (agent.mergeVariable?.enabled && agent.mergeVariable.injectFormatted && agent.mergeVariable.variableName) {
            const formatted = formatMergeVariableData(agent.mergeVariable);
            if (formatted) expanded += '\n\n' + formatted;
        }

        const key = PROMPT_KEY_PREFIX + agent.id;
        setExtensionPrompt(
            key,
            expanded,
            agent.injection.position,
            agent.injection.depth,
            agent.injection.scan,
            agent.injection.role,
        );
        debug(`${LOG_PREFIX} injected pre-gen prompt for "${agent.name}" at depth ${agent.injection.depth}`);
    }

    // --- Sidecar context injection ---
    // Sidecar agents don't inject their full prompt (the narrative model
    // shouldn't emit structured tags), but their tracked state SHOULD be
    // available for contextual awareness (e.g. current time/location).
    const sidecarContextAgents = activeAgents.filter(a =>
        a.sidecarCall?.enabled &&
        a.mergeVariable?.enabled &&
        a.mergeVariable.injectFormatted &&
        a.mergeVariable.variableName,
    );
    for (const agent of sidecarContextAgents) {
        const formatted = formatMergeVariableData(agent.mergeVariable);
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
        debug(`${LOG_PREFIX} injected sidecar context for "${agent.name}" at depth ${agent.injection.depth}`);
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
    if (isAgentRunInProgress) return;

    const idx = Number(messageIndex);
    const message = chat[idx];
    if (!message || message.is_user || message.is_system) return;

    // Cooperative coexistence note (Step 8): if another generation-driving
    // extension is mid-pass on this turn, log it. We don't hard-block — ST's
    // generation mutex and our isAgentRunInProgress guard already serialize the
    // actual LLM calls — but surfacing the overlap helps diagnose ordering
    // issues with Stepped Thinking / Qvink / Recast.
    if (isExternalGenerationActive()) {
        debug(`${LOG_PREFIX} external generation active while post-gen begins for message ${idx}; relying on run-in-progress guard + ST mutex to serialize`);
    }

    if (!isStreamingStillActive(idx)) {
        if (generationStopRequested) return;
        await processPostGenAgents(idx);
        return;
    }

    // --- Bounded streaming wait ---
    debug(`${LOG_PREFIX} message ${idx} still streaming, deferring post-processing`);
    let attempts = 0;

    await new Promise((resolve) => {
        const checkInterval = setInterval(() => {
            attempts++;

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

    if (generationStopRequested) return;
    await processPostGenAgents(idx);
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
            agents: groupAgents,
        });
    }

    if (ungrouped.length > 0) {
        plan.push({
            id: '__ungrouped__',
            order: 9999,
            executionMode: 'parallel',
            agents: ungrouped,
        });
    }

    plan.sort((a, b) => a.order - b.order);
    return plan;
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
            executeSidecarBatch(batch, message, messageIndex, generationType, runOpts()),
        );
        const results = await Promise.allSettled(batchPromises);
        for (const result of results) {
            if (result.status === 'fulfilled' && result.value?.dataStored) {
                metadataChanged = true;
            } else if (result.status === 'rejected') {
                console.error(`${LOG_PREFIX} sidecar batch failed:`, result.reason);
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
 * Phone agents (Step 9) are not ported yet — guarded and skipped with a note.
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

    // Phone agents — diegetic texting. The evaluation decides whether the
    // character texts {{user}} this turn and stores any texts to the thread;
    // the chat message itself is never modified, so neither flag flips.
    if (agent.phoneConfig != null) {
        try {
            await executePhoneEvaluation(agent, message, messageIndex, false);
        } catch (err) {
            console.error(`${LOG_PREFIX} phone evaluation failed for "${agent.name}":`, err);
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
async function processPostGenAgents(messageIndex) {
    const snapshot = pendingSnapshot ?? buildActivationSnapshot('normal');
    const activeAgents = getSnapshotAgents(snapshot);
    const postAgents = activeAgents.filter(a => a.phase === 'post' || a.phase === 'both');

    if (postAgents.length === 0) return;

    recordAgents(postAgents.length); // cost-hint accounting (agents this turn)
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

    try {
        const message = chat[messageIndex];
        if (!message) return;

        // 1. Group-aware execution
        const executionPlan = buildExecutionPlan(postAgents);
        for (const group of executionPlan) {
            if (generationStopRequested) break;
            const result = await executeGroup(group, message, messageIndex, snapshot.generationType);
            if (result.chatChanged) chatChanged = true;
            if (result.metadataChanged) metadataChanged = true;
        }

        // 2. Regex extraction pass (all active agents with regexScripts)
        const regexAgents = activeAgents.filter(a =>
            Array.isArray(a.regexScripts) && a.regexScripts.length > 0,
        );
        for (const agent of regexAgents) {
            if (generationStopRequested) break;

            // Clear previous extraction data for idempotency (e.g. regenerate)
            clearAgentData(message, agent.id);

            const result = processAgentRegex(agent, message, messageIndex);
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
            buildSidecarDisplayData(agent, message, messageIndex);
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
        console.error(`${LOG_PREFIX} post-gen processing failed:`, err);
    } finally {
        endSelfGeneration();
        activeRunController = null;
        setRunActive(false);

        // Cost hint (gameplan §6): one concise, non-blocking line per turn
        // showing agents-run vs actual calls, so batching savings are visible.
        if (getGlobalSettings().showCostHint) {
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
        Array.isArray(a.regexScripts) && a.regexScripts.length > 0,
    );
    for (const agent of regexAgents) {
        clearAgentData(message, agent.id);
        const result = processAgentRegex(agent, message, idx);
        if (result.changed) changed = true;
    }

    const sidecarAgents = allEnabled.filter(a =>
        a.sidecarCall?.enabled && a.sidecarCall?.display?.enabled,
    );
    for (const agent of sidecarAgents) {
        buildSidecarDisplayData(agent, message, idx);
    }

    if (changed) saveChatDebounced();

    // Always refresh (even with no extractions) to clear stale renders.
    refreshMessage(idx);
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

    // Restore merge variable data from per-swipe storage. Writing []
    // (when this swipe has no stored items) clears the variable so the LLM
    // gets formatEmpty next turn instead of stale data from another swipe.
    const swipes = message.extra?.saAgentSwipes;
    if (swipes) {
        for (const [varName, swipeData] of Object.entries(swipes)) {
            writeMergeArray(varName, swipeData[currentSwipeId] ?? []);
        }
    }

    // Rebuild sidecar display from restored merge variable data
    const sidecarAgents = getEnabledAgents().filter(a =>
        a.sidecarCall?.enabled && a.sidecarCall?.display?.enabled,
    );
    for (const agent of sidecarAgents) {
        if (message.extra?.saAgentData?.[agent.id]) {
            delete message.extra.saAgentData[agent.id];
        }
        buildSidecarDisplayData(agent, message, idx);
    }

    debug(`${LOG_PREFIX} swipe ${currentSwipeId}: restored merge vars + rebuilt display`);
}

// ============================================================================
// PUBLIC API
// ============================================================================

/**
 * Manually run a single agent on a message (slash command / button).
 *
 * @param {string} agentId
 * @param {number} messageIndex
 * @returns {Promise<{changed:boolean, error?:string, textsGenerated?:number}>}
 */
export async function runAgentOnMessage(agentId, messageIndex) {
    if (isAgentRunInProgress) {
        toastr.warning('Another agent is currently running.');
        return { changed: false };
    }

    const agent = getAgentById(agentId);
    if (!agent) {
        toastr.error('Agent not found.');
        return { changed: false };
    }

    const message = chat[messageIndex];
    if (!message || message.is_user || message.is_system) {
        toastr.warning('No valid assistant message at that index.');
        return { changed: false };
    }

    isAgentRunInProgress = true;   // set immediately so re-entrancy guard holds
    activeRunController = new AbortController();
    generationStopRequested = false;
    setRunActive(true);            // notify UI (and re-affirm the flag via setter)
    beginSelfGeneration();   // manual run drives its own LLM call — mark it ours
    try {
        // Phone agents — force an evaluation (skips trigger/probability gates)
        // so the play button always asks the character whether they'd text now.
        if (agent.phoneConfig != null) {
            const result = await executePhoneEvaluation(agent, message, messageIndex, true);
            return { changed: false, textsGenerated: result?.textsGenerated ?? 0 };
        }

        // Sidecar — LLM call, data stored, message untouched
        if (agent.sidecarCall?.enabled) {
            const result = await executeSidecarAgent(agent, message, messageIndex, 'normal', runOpts());
            if (result.dataStored) {
                saveChatDebounced();
                refreshMessage(messageIndex);
            }
            return result;
        }

        let result;

        // Rewrite — explicit, or implicit for a post-phase agent with a prompt
        // (makes /agent-run intuitive with prompt-only rewrite templates).
        if (agent.postProcess.rewriteEnabled || (agent.phase === 'post' && agent.prompt.trim())) {
            const effectiveAgent = agent.postProcess.rewriteEnabled ? agent : {
                ...agent,
                postProcess: { ...agent.postProcess, rewriteEnabled: true },
            };
            result = await executeRewriteAgent(effectiveAgent, message, messageIndex, 'normal', runOpts());
        } else if (agent.postProcess.enabled) {
            switch (agent.postProcess.type) {
                case 'extract':
                    result = executeExtractAgent(agent, message, messageIndex);
                    break;
                case 'append':
                    result = executeAppendAgent(agent, message, messageIndex);
                    break;
                default:
                    result = { changed: false };
            }
        } else {
            toastr.info('This agent has no post-processing configured.', agent.name);
            result = { changed: false };
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
    } catch (err) {
        // An abort here is a deliberate stop, not a failure. The mode that was
        // running already cleared its own toast; just report it as unchanged.
        if (isAbortError(err)) {
            debug(`${LOG_PREFIX} manual run of "${agent.name}" cancelled`);
            return { changed: false, cancelled: true };
        }
        console.error(`${LOG_PREFIX} manual run of "${agent.name}" failed:`, err);
        return { changed: false, error: err?.message };
    } finally {
        endSelfGeneration();
        activeRunController = null;
        setRunActive(false);
    }
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
    eventSource.on(event_types.GENERATION_STARTED, onGenerationStarted);
    eventSource.on(event_types.GENERATION_AFTER_COMMANDS, onGenerationAfterCommands);
    eventSource.on(event_types.GENERATION_ENDED, onGenerationEnded);
    eventSource.on(event_types.GENERATION_STOPPED, onGenerationStopped);
    eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);

    if (event_types.MESSAGE_EDITED) {
        eventSource.on(event_types.MESSAGE_EDITED, onMessageEdited);
    }
    if (event_types.MESSAGE_UPDATED && event_types.MESSAGE_UPDATED !== event_types.MESSAGE_EDITED) {
        eventSource.on(event_types.MESSAGE_UPDATED, onMessageEdited);
    }
    if (event_types.MESSAGE_SWIPED) {
        eventSource.on(event_types.MESSAGE_SWIPED, onSwipeNavigation);
    }

    debug(`${LOG_PREFIX} lifecycle initialized`);
}
