/**
 * core/activation.js — which agents fire this turn.
 *
 * Pure decision logic, no LLM calls and no side effects. Split out of VM's
 * runner.js so the lifecycle engine can ask a single question: "given this
 * generation type, which enabled agents activate?" and get back a snapshot.
 *
 * The snapshot is built once at GENERATION_AFTER_COMMANDS and reused at
 * MESSAGE_RECEIVED, so probability gates roll exactly once per turn (a
 * coin-flip agent doesn't re-roll between pre-gen and post-gen).
 *
 * Ported from VerseManager's runner.js (shouldActivate / buildActivationSnapshot
 * / getSnapshotAgents / normalizeGenType), then extended for SuperAgents.
 */

import { chat } from '../../../../../../script.js';
import { getEnabledAgents, getAgentById, getGlobalSettings } from '../data/store.js';
import { readPendingUserMessage } from './richContext.js';
import { evaluateGeneralGate, ownsCounterItself } from './everyN.js';
import { agentMatchesCurrentScope } from './activationScope.js';
import { activationPolicyAllows } from './activationPolicy.js';
import {
    clearDeferredSwipeAgentIds,
    getDeferredSwipeAgentIds,
    isDeferrablePostAgent,
    pruneDeferredSwipeAgentIds,
} from './swipeDeferral.js';

// ============================================================================
// GENERATION TYPE
// ============================================================================

/**
 * Collapse ST's many generation-type spellings into the buckets agents filter
 * on. Swipe and regenerate share one user-facing bucket. Anything else that
 * isn't continue/impersonate/quiet is treated as 'normal'.
 * @param {string} generationType
 * @returns {'normal'|'continue'|'impersonate'|'quiet'|'swipe'}
 */
export function normalizeGenType(generationType) {
    switch (String(generationType ?? '').trim().toLowerCase()) {
        case 'swipe':
        case 'regenerate':
            return 'swipe';
        case 'continue':
        case 'impersonate':
        case 'quiet':
            return String(generationType).trim().toLowerCase();
        default:
            return 'normal';
    }
}

// ============================================================================
// PER-AGENT ACTIVATION
// ============================================================================

/**
 * Decide whether a single agent should fire this turn.
 *
 * Order of gates:
 *   1. generationType filter (if the agent restricts types)
 *   2. character/tag/group scope
 *   3. initialization / one-shot lifecycle policy
 *   4. phone agents bypass the remaining content gates — their two-tier trigger (keyword +
 *      talkativeness) lives inside the phone module, not here
 *   5. probability gate (rolled once per turn via the snapshot)
 *   6. keyword / pattern match against the last message (+ the pending user
 *      message, see below)
 *
 * Keyword/pattern matching scans the last committed message AND the user's
 * pending (not-yet-committed) message when one is supplied. At
 * GENERATION_AFTER_COMMANDS, ST hasn't pushed the user's input into `chat`
 * yet, so without this a pre-gen agent keyed on a user keyword ("when the user
 * mentions X, plan Y") would NEVER match — it'd only ever see the previous
 * assistant turn (audit fix #8). pendingUserText is '' for post-gen and for
 * automatic/non-user triggers, so post-gen behavior is unchanged.
 *
 * @param {object} agent
 * @param {string} generationType — already normalized
 * @param {string} [pendingUserText=''] — the user's not-yet-committed message
 * @returns {boolean}
 */
export function shouldActivate(agent, generationType, pendingUserText = '') {
    const cond = agent.conditions ?? {};

    // Generation type filter
    if (cond.generationTypes?.length > 0 && !cond.generationTypes.includes(generationType)) {
        return false;
    }

    if (!agentMatchesCurrentScope(agent)) return false;

    // Sleeping initialization agents must not consume probability rolls or
    // every-N counters while their lifecycle policy is closed.
    if (!activationPolicyAllows(agent)) return false;

    // Phone agents always pass — their own trigger logic (keyword +
    // talkativeness probability) lives inside the phone evaluation, not here.
    if (agent.phoneConfig != null || agent.feedConfig != null) {
        return true;
    }

    // Probability gate
    if (cond.triggerProbability < 100 && Math.random() * 100 > cond.triggerProbability) {
        return false;
    }

    // Keyword + pattern filter
    const hasKeywords = cond.triggerKeywords?.length > 0;
    const hasPatterns = cond.triggerPatterns?.length > 0;

    if (hasKeywords || hasPatterns) {
        // Scan the last committed message plus the pending user message (the
        // latter is only populated for pre-gen / user-driven turns). Joined so a
        // keyword in EITHER counts as a match.
        const lastMsg = chat[chat.length - 1]?.mes ?? '';
        const pending = String(pendingUserText ?? '');
        const haystack = pending ? `${lastMsg}\n${pending}` : lastMsg;
        let matched = false;

        // Plain string keywords (case-insensitive substring)
        if (hasKeywords) {
            const lower = haystack.toLowerCase();
            if (cond.triggerKeywords.some(kw => lower.includes(kw.toLowerCase()))) {
                matched = true;
            }
        }

        // Regex patterns (support /pattern/flags or bare string)
        if (!matched && hasPatterns) {
            for (const pattern of cond.triggerPatterns) {
                try {
                    const slashMatch = pattern.match(/^\/(.+)\/([gimsuy]*)$/);
                    const regex = slashMatch
                        ? new RegExp(slashMatch[1], slashMatch[2])
                        : new RegExp(pattern, 'i');
                    if (regex.test(haystack)) {
                        matched = true;
                        break;
                    }
                } catch {
                    // Invalid pattern — skip silently
                }
            }
        }

        if (!matched) return false;
    }

    return true;
}

// ============================================================================
// SNAPSHOT
// ============================================================================

/**
 * Build the activation snapshot for a generation. Rolls probability gates
 * once, here, so the same set of agents is used for both pre-gen and post-gen.
 *
 * Also captures the pending user message (still in the textarea at
 * GENERATION_AFTER_COMMANDS time — ST hasn't committed it to chat yet) so
 * rich-context agents can see what the user just typed. Stored on the snapshot
 * because the textarea is cleared by the time post-gen runs.
 *
 * @param {string} generationType — raw or normalized; normalized internally
 * @param {object} [options] — generation options from the event (automatic_trigger)
 * @returns {{ generationType: string, activeAgentIds: string[], runnableAgentIds: string[], retainedSnapshotAgentIds: string[], pendingUserText: string }}
 */
export function buildActivationSnapshot(generationType, options) {
    const genType = normalizeGenType(generationType);
    // Read the pending user message once, up front, so keyword/pattern gates can
    // see what the user just typed (it isn't in `chat` yet at pre-gen time —
    // audit fix #8). '' for automatic triggers and post-gen.
    const pendingUserText = readPendingUserMessage(options);

    const enabledAgents = getEnabledAgents();
    pruneDeferredSwipeAgentIds(enabledAgents.map(agent => agent.id));
    const deferPostAgentsOnSwipe = getGlobalSettings().deferPostAgentsOnSwipe;
    if (!deferPostAgentsOnSwipe) clearDeferredSwipeAgentIds();
    const deferredCatchUpIds = genType === 'normal' && deferPostAgentsOnSwipe
        ? new Set(getDeferredSwipeAgentIds())
        : new Set();
    const pausedAgents = enabledAgents.filter(agent => agent.paused);

    // Stage 1: activation gates only advance runnable agents. Individually
    // paused agents remain in activeAgentIds as frozen reference context, but
    // never roll probability/policy/cadence while paused.
    const cadenceEligibleAgents = enabledAgents
        .filter(agent => !agent.paused)
        .filter(a => shouldActivate(a, genType, pendingUserText));

    // Stage 2: the general every-N throttle. It receives the raw generation
    // type so swipe/regenerate can either reuse the last reply's decision or
    // count as a new attempt, according to the agent's cadence setting. Agents
    // that own their own counter (Continuity Guard) are exempt — they run every
    // turn and manage cadence internally.
    const activeAgents = [];
    const retainedSnapshotAgents = [];
    for (const agent of cadenceEligibleAgents) {
        // A due reroll was deliberately postponed. Run it only in the post-pass
        // below; do not advance its every-N counter or accidentally run a
        // phase="both" agent before the main reply as part of catching up.
        if (deferredCatchUpIds.has(agent.id) && isDeferrablePostAgent(agent)) {
            retainedSnapshotAgents.push(agent);
            continue;
        }
        const runs = ownsCounterItself(agent) || evaluateGeneralGate(agent, generationType);
        if (runs) {
            activeAgents.push(agent);
        } else if (agent.reuseSnapshotBetweenRuns
            && agent.mergeVariable?.enabled
            && agent.mergeVariable.variableName) {
            retainedSnapshotAgents.push(agent);
        }
    }

    const runnableIds = new Set(activeAgents.map(agent => agent.id));
    const retainedIds = new Set(retainedSnapshotAgents.map(agent => agent.id));
    const catchUpAgents = enabledAgents.filter(agent => deferredCatchUpIds.has(agent.id)
        && !agent.paused && isDeferrablePostAgent(agent));
    const catchUpIds = new Set(catchUpAgents.map(agent => agent.id));
    const referenceIds = new Set([
        ...runnableIds,
        ...pausedAgents.map(agent => agent.id),
        ...retainedIds,
        ...catchUpIds,
    ]);
    return {
        generationType: genType,
        activeAgentIds: enabledAgents.filter(agent => referenceIds.has(agent.id)).map(agent => agent.id),
        runnableAgentIds: enabledAgents.filter(agent => runnableIds.has(agent.id)).map(agent => agent.id),
        retainedSnapshotAgentIds: enabledAgents.filter(agent => retainedIds.has(agent.id)).map(agent => agent.id),
        deferredCatchUpAgentIds: enabledAgents.filter(agent => catchUpIds.has(agent.id)).map(agent => agent.id),
        pendingUserText,
    };
}

/**
 * Resolve a snapshot back to live agent objects (filtering any that were
 * deleted/disabled between snapshot and use).
 * @param {{ activeAgentIds?: string[] }} snapshot
 * @returns {object[]}
 */
export function getSnapshotAgents(snapshot) {
    if (!snapshot?.activeAgentIds) return [];
    return snapshot.activeAgentIds
        .map(id => getAgentById(id))
        .filter(agent => agent?.enabled);
}
