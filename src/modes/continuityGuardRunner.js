/**
 * modes/continuityGuardRunner.js — post-gen driver for the Continuity Guard.
 *
 * Runs after every post-gen batch (via onPostProcessComplete). It:
 *   1. RUNTIME STATE-DEPENDENCY GUARD — no-ops unless a Continuity Guard agent
 *      is enabled AND a State Card agent is enabled AND sa_state_card holds
 *      real tracked state. This is the guard the gameplan wants enforced in
 *      activation logic, not just docs: the agent cannot act without State.
 *   2. Runs Stage-1 deterministic detection (continuityDetect) against the new
 *      message's prose.
 *   3. Maintains an every-N per-chat counter; on the Nth turn it drops the SAME
 *      flag even when regex didn't trip (open-pass repair on click). A regex
 *      hit resets the counter so the two triggers don't stack noise.
 *   4. Stashes the finding on the message (swipe-scoped, top-level sibling) and
 *      injects a hidden marker into saAgentData so the render hook draws the
 *      quiet clickable flag.
 *
 * No LLM call happens here — detection is free; the expensive confirm+repair
 * runs only when the user clicks the flag (see render/hooks/continuityGuard.js).
 */

import { chat, chat_metadata, saveChatDebounced } from '../../../../../../script.js';
import { getContext } from '../../../../../extensions.js';
import { getEveryN, bumpAgentCounter, resetAgentCounter } from '../core/everyN.js';
import { getEnabledAgents } from '../data/store.js';
import { readMergeArray } from './mergeVariable.js';
import { detectContinuityBreak, parseStateBlob } from './continuityDetect.js';
import { refreshMessage } from '../render/renderer.js';
import { debug } from '../../index.js';

const LOG_PREFIX = '[SuperAgents/continuityGuard]';

const STATE_VAR = 'sa_state_card';
const GUARD_DEFAULT_N = 5;   // guard's sweep floor when no everyN is configured
const GUARD_HOOK_CLASS = 'continuity-guard-data';

// ============================================================================
// AGENT RESOLUTION + RUNTIME GUARD
// ============================================================================

/**
 * Find the enabled Continuity Guard agent, if any. Identified by its source
 * template id (survives rename) with a defensive name fallback.
 * @returns {object|null}
 */
function getGuardAgent() {
    const agents = getEnabledAgents();
    return agents.find(a =>
        !a.paused && (
            a.sourceTemplateId === 'tpl-continuity-guard'
            || a.continuityGuard?.enabled === true
            || a.name === 'Continuity Guard'
        )) || null;
}

/**
 * Find the enabled State Card agent (the guard's hard dependency). Mirrors
 * ui/stateCard.getStateCardAgent so "State is present" means the same thing
 * everywhere.
 * @returns {object|null}
 */
function getStateCardAgent() {
    return getEnabledAgents().find(a => a.stateCard && a.stateCard.schema) || null;
}

/**
 * The runtime state-dependency guard. Returns the parsed state blob ONLY when
 * every precondition holds; otherwise null (the runner then no-ops).
 * @returns {object|null}
 */
function resolveGuardState() {
    // 1. A Continuity Guard agent must be enabled.
    if (!getGuardAgent()) return null;
    // 2. A State Card agent must be enabled (the discrete data source).
    if (!getStateCardAgent()) return null;
    // 3. sa_state_card must hold real, parseable, non-empty state.
    const raw = chat_metadata?.variables?.[STATE_VAR];
    const state = parseStateBlob(raw);
    if (!state) return null;
    const hasChars = state.characters && typeof state.characters === 'object'
        && Object.keys(state.characters).length > 0;
    if (!hasChars) return null; // roster empty → nothing deterministic to check
    return state;
}

// ============================================================================
// EVERY-N COUNTER (per chat, in chat_metadata)
// ============================================================================

/**
 * The guard's sweep interval. Uses the shared everyN field resolution (top-level
 * agent.everyN, then legacy continuityGuard.everyN), but falls back to the
 * guard's own default of 5 rather than the general "1 = every message" default —
 * a guard sweeping every single message would be pointless noise.
 * @param {object} agent
 * @returns {number}
 */
function guardEveryN(agent) {
    const resolved = getEveryN(agent);      // shared: >=1, or 1 if unset
    // Distinguish "explicitly set to 1" from "unset → shared default of 1".
    const explicit = (typeof agent?.everyN === 'number' && agent.everyN > 0)
        || (typeof agent?.continuityGuard?.everyN === 'number' && agent.continuityGuard.everyN > 0);
    return explicit ? resolved : GUARD_DEFAULT_N;
}

// Guard counter = the shared per-agent counter, keyed by the guard agent id.
function bumpCounter(agent) { return bumpAgentCounter(agent.id); }
function resetCounter(agent) { resetAgentCounter(agent.id); }

// ============================================================================
// KNOWN NAMES (never flag the user's / active character's persona)
// ============================================================================

/**
 * Names the absent-voice check must never flag: the active character (they're
 * the speaker) and the user's persona. Pulled from ST context.
 * @returns {string[]}
 */
function knownPersonaNames() {
    const names = [];
    try {
        const ctx = getContext();
        if (ctx?.name1) names.push(ctx.name1); // user persona
        if (ctx?.name2) names.push(ctx.name2); // active character
        // Group chat: every member is a legitimate speaker.
        const groupId = ctx?.groupId;
        if (groupId && Array.isArray(ctx?.groups)) {
            const group = ctx.groups.find(g => g.id === groupId);
            if (group && Array.isArray(group.members) && Array.isArray(ctx.characters)) {
                for (const avatar of group.members) {
                    const c = ctx.characters.find(ch => ch.avatar === avatar);
                    if (c?.name) names.push(c.name);
                }
            }
        }
    } catch { /* best-effort */ }
    return names;
}

// ============================================================================
// MARKER INJECTION (drives the render hook)
// ============================================================================

/**
 * Stash the finding on the message (swipe-scoped, top-level sibling key) and
 * write the hidden marker into saAgentData so the renderer draws the flag.
 * A null finding still injects a marker (every-N open pass) — the flag is the
 * same; the click just runs without a specific suspicion.
 * @param {object} agent
 * @param {object} message — chat[n]
 * @param {number} mesId
 * @param {object|null} finding
 */
function stashAndInject(agent, message, mesId, finding) {
    const swipeId = message.swipe_id ?? 0;

    // Finding storage: top-level sibling (survives ST's per-swipe extra clone).
    if (finding) {
        if (!message.saContinuityGuard) message.saContinuityGuard = {};
        message.saContinuityGuard[swipeId] = finding;
    }

    // Marker HTML — hidden data div the render hook turns into the flag.
    const reason = finding?.reason ? esc(finding.reason) : '';
    const html = `<div class="${GUARD_HOOK_CLASS}" style="display:none"`
        + ` data-mesid="${mesId}"`
        + ` data-agent-id="${esc(agent.id)}"`
        + ` data-agent-name="${esc(agent.name || 'Continuity Guard')}"`
        + ` data-profile="${esc(agent.connectionProfile || '')}"`
        + ` data-reason="${reason}"></div>`;

    if (!message.extra) message.extra = {};
    if (!message.extra.saAgentData) message.extra.saAgentData = {};
    message.extra.saAgentData[agent.id] = {
        _swipeId: swipeId,
        scripts: [{
            extractions: [{ rendered: html, placement: 'bottom' }],
        }],
    };
}

/** Remove any prior guard marker + finding for this swipe (clean re-eval). */
function clearGuardData(agent, message) {
    const swipeId = message.swipe_id ?? 0;
    if (message.extra?.saAgentData?.[agent.id]) {
        delete message.extra.saAgentData[agent.id];
    }
    if (message.saContinuityGuard) {
        delete message.saContinuityGuard[swipeId];
        if (Object.keys(message.saContinuityGuard).length === 0) {
            delete message.saContinuityGuard;
        }
    }
}

function esc(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

// ============================================================================
// POST-GEN ENTRY
// ============================================================================

/**
 * Run the guard for one just-completed message. Wired to onPostProcessComplete.
 * Fail-open: any error is swallowed (a continuity flag must never break a turn).
 *
 * @param {number} messageIndex
 * @param {object} [opts]
 * @param {boolean} [opts.force] — manual run (play button). Always drops the
 *        flag regardless of detector/sweep, since the user explicitly asked for
 *        a review on this message. A real Stage-1 hit still wins (keeps its
 *        specific suspicion); otherwise an open-pass flag is forced. Returns a
 *        boolean so the caller (lifecycle manual-run) can report changed state.
 * @returns {{flagged:boolean, hadFinding:boolean, ready:boolean}}
 *   flagged     — a flag was drawn this call.
 *   hadFinding  — a real Stage-1 suspicion was found (vs a forced/sweep open pass).
 *   ready       — the runtime preconditions were met (guard + State Card + roster);
 *                 false means the run no-op'd before detection could happen.
 */
function onPostGenTurn(messageIndex, opts = {}) {
    const force = opts.force === true;
    const NOT_READY = { flagged: false, hadFinding: false, ready: false };
    try {
        const mesId = Number(messageIndex);
        const message = chat[mesId];
        if (!message || message.is_user || message.is_system) return NOT_READY;
        if (typeof message.mes !== 'string' || !message.mes.trim()) return NOT_READY;

        // Runtime state-dependency guard. Null → agent inactive / no State → no-op.
        const state = resolveGuardState();
        if (!state) return NOT_READY;

        const agent = getGuardAgent();
        if (!agent) return NOT_READY;

        // Clear any stale marker/finding for this swipe before re-evaluating.
        clearGuardData(agent, message);

        // Stage 1: deterministic detection.
        const finding = detectContinuityBreak(message.mes, state, {
            knownNames: knownPersonaNames(),
        });

        // Every-N bookkeeping.
        const everyN = guardEveryN(agent);
        let showFlag = false;
        let flagFinding = null;

        if (finding) {
            // Regex/roster hit → flag with the specific suspicion, reset counter
            // so the two triggers don't stack. (Wins even on a forced run.)
            showFlag = true;
            flagFinding = finding;
            resetCounter(agent);
            debug(`${LOG_PREFIX} Stage-1 hit (${finding.check}) on message ${mesId}: ${finding.reason}`);
        } else if (force) {
            // Manual run with no deterministic hit → force an open-pass flag.
            // Reset the counter so a fresh manual sweep restarts the cadence.
            showFlag = true;
            flagFinding = null;
            resetCounter(agent);
            debug(`${LOG_PREFIX} forced open-pass flag (manual run) on message ${mesId}`);
        } else {
            // No deterministic hit → advance the sweep counter.
            const count = bumpCounter(agent);
            if (count >= everyN) {
                showFlag = true;      // open-pass flag (no specific suspicion)
                flagFinding = null;
                resetCounter(agent);
                debug(`${LOG_PREFIX} every-${everyN} sweep flag on message ${mesId}`);
            }
        }

        if (showFlag) {
            stashAndInject(agent, message, mesId, flagFinding);
            saveChatDebounced();
            refreshMessage(mesId);
        }
        // ready:true — detection ran to completion (preconditions were met),
        // regardless of whether a flag was ultimately drawn.
        return { flagged: showFlag, hadFinding: flagFinding != null, ready: true };
    } catch (err) {
        debug(`${LOG_PREFIX} post-gen guard error (ignored):`, err);
        return { flagged: false, hadFinding: false, ready: false };
    }
}

/**
 * Manual-run entry for the management modal / flyout play button. The generic
 * lifecycle dispatcher (runAgentOnMessage) has no knowledge of the guard's
 * post-gen work, so it routes here via ownsCounterItself(agent). Forces a flag
 * so the user's explicit click always surfaces a review affordance.
 * @param {number} messageIndex
 * @returns {{flagged:boolean, hadFinding:boolean, ready:boolean}} — lets the
 *   caller distinguish "flagged a real suspicion" from "clean sweep, all clear"
 *   from "preconditions unmet", so it can surface the right toast.
 */
export function runGuardManually(messageIndex) {
    return onPostGenTurn(messageIndex, { force: true });
}

// ============================================================================
// INIT
// ============================================================================

/**
 * Wire the guard into the post-gen lifecycle. Call once from index.js AFTER
 * initLifecycle (so onPostProcessComplete exists) and after the render hook is
 * registered (so the injected marker has a hook to transform it).
 * @param {(fn:(messageIndex:number)=>void)=>void} onPostProcessComplete
 */
export function initContinuityGuardRunner(onPostProcessComplete) {
    if (typeof onPostProcessComplete !== 'function') {
        console.warn(`${LOG_PREFIX} init: onPostProcessComplete unavailable`);
        return;
    }
    onPostProcessComplete(onPostGenTurn);
    debug(`${LOG_PREFIX} runner initialized (sweep default ${GUARD_DEFAULT_N})`);
}
