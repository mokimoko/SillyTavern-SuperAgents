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
 * / getSnapshotAgents / normalizeGenType) — unchanged behavior.
 */

import { chat } from '../../../../../../script.js';
import { getEnabledAgents, getAgentById } from '../data/store.js';

// ============================================================================
// GENERATION TYPE
// ============================================================================

/**
 * Collapse ST's many generation-type spellings into the buckets agents filter
 * on. Anything that isn't continue/impersonate/quiet is treated as 'normal'.
 * @param {string} generationType
 * @returns {'normal'|'continue'|'impersonate'|'quiet'}
 */
export function normalizeGenType(generationType) {
    switch (String(generationType ?? '').trim().toLowerCase()) {
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
 *   2. phone agents bypass the rest — their two-tier trigger (keyword +
 *      talkativeness) lives inside the phone module, not here
 *   3. probability gate (rolled once per turn via the snapshot)
 *   4. keyword / pattern match against the last message
 *
 * @param {object} agent
 * @param {string} generationType — already normalized
 * @returns {boolean}
 */
export function shouldActivate(agent, generationType) {
    const cond = agent.conditions ?? {};

    // Generation type filter
    if (cond.generationTypes?.length > 0 && !cond.generationTypes.includes(generationType)) {
        return false;
    }

    // Phone agents always pass — their own trigger logic (keyword +
    // talkativeness probability) lives inside the phone evaluation, not here.
    if (agent.phoneConfig != null) {
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
        const lastMsg = chat[chat.length - 1]?.mes ?? '';
        let matched = false;

        // Plain string keywords (case-insensitive substring)
        if (hasKeywords) {
            const lower = lastMsg.toLowerCase();
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
                    if (regex.test(lastMsg)) {
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
 * @param {string} generationType — raw or normalized; normalized internally
 * @returns {{ generationType: string, activeAgentIds: string[] }}
 */
export function buildActivationSnapshot(generationType) {
    const genType = normalizeGenType(generationType);
    const activeAgents = getEnabledAgents().filter(a => shouldActivate(a, genType));
    return {
        generationType: genType,
        activeAgentIds: activeAgents.map(a => a.id),
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
    return snapshot.activeAgentIds.map(id => getAgentById(id)).filter(Boolean);
}
