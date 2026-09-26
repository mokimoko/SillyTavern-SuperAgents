/**
 * core/callStats.js — per-turn + per-session LLM call accounting.
 *
 * The retention hint (gameplan §6): agents cost money, and batching is the
 * headline optimization. Surfacing "3 agents ran in 1 call this turn" makes the
 * saving visible. Two axes are tracked:
 *
 *   calls  — actual LLM round-trips (the cost). Counted in core/llm.js, so
 *            retries/fallbacks count too — they really do spend tokens.
 *   agents — agent-runs dispatched this turn (pre-gen + post-gen). Counted by
 *            the lifecycle/batch layer where the agent count is known.
 *
 * Turn counters reset at GENERATION_STARTED. Session counters accumulate until
 * the page reloads. State is plain module-level — no persistence (a cost hint
 * is a live signal, not saved data).
 */

import { debug } from './runtime.js';

const LOG_PREFIX = '[SuperAgents/stats]';

let turnCalls = 0;
let turnAgents = 0;
let sessionCalls = 0;
let sessionAgents = 0;

/** Count one actual LLM round-trip. Called from core/llm.js per request. */
export function recordCall() {
    turnCalls++;
    sessionCalls++;
}

/**
 * Count agent-runs dispatched this turn.
 * @param {number} n — number of agents (batched or solo). Defaults to 1.
 */
export function recordAgents(n = 1) {
    const count = Number(n);
    if (!Number.isFinite(count) || count <= 0) return;
    turnAgents += count;
    sessionAgents += count;
}

/** Reset the per-turn counters. Called at GENERATION_STARTED. */
export function resetTurn() {
    turnCalls = 0;
    turnAgents = 0;
}

/** @returns {{turnCalls:number, turnAgents:number, sessionCalls:number, sessionAgents:number}} */
export function getStats() {
    return { turnCalls, turnAgents, sessionCalls, sessionAgents };
}

/** Reset both turn and session counters (e.g. on CHAT_CHANGED, if desired). */
export function resetAll() {
    turnCalls = turnAgents = sessionCalls = sessionAgents = 0;
}

/**
 * Build the human-readable cost hint for the turn just completed.
 * Returns '' when nothing ran (no hint worth showing).
 * @returns {string}
 */
export function formatTurnHint() {
    if (turnCalls === 0 && turnAgents === 0) return '';

    const agentWord = turnAgents === 1 ? 'agent' : 'agents';
    const callWord = turnCalls === 1 ? 'call' : 'calls';

    let hint = `${turnAgents} ${agentWord} · ${turnCalls} ${callWord} this turn`;

    // Only surface the saving when batching actually collapsed calls.
    if (turnAgents > turnCalls && turnCalls > 0) {
        const saved = turnAgents - turnCalls;
        hint += ` (batched ${saved} away)`;
    }

    hint += ` · ${sessionCalls} this session`;
    debug(`${LOG_PREFIX} ${hint}`);
    return hint;
}
