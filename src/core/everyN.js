/**
 * core/everyN.js — shared "run every N messages" throttle primitive.
 *
 * ONE counter store, ONE canonical everyN field, TWO consumers that interpret
 * them differently:
 *
 *   • General throttle (activation.js): a GATE. An agent with everyN > 1 only
 *     fires on every Nth eligible reply. Its cadence setting decides whether
 *     swipes reuse the reply's decision or advance the counter again.
 *
 *   • Continuity Guard (continuityGuardRunner.js): a FLOOR. The guard runs its
 *     deterministic detector on EVERY message; everyN only governs the
 *     open-pass sweep fallback when nothing is detected, and a real hit resets
 *     the counter. The guard drives the counter itself and is exempt from the
 *     general gate.
 *
 * Counters live per-agent in chat_metadata (per-chat, persisted with the chat),
 * keyed by agent id, so switching chats gives each its own cadence.
 *
 * Canonical field resolution (first hit wins):
 *   1. agent.everyN                  (top-level — the general setting)
 *   2. agent.continuityGuard.everyN  (legacy Guard location, back-compat)
 *   3. DEFAULT_EVERY_N (1 = every message; i.e. throttle off)
 */

import { chat_metadata } from '../../../../../../script.js';
import { debug } from './runtime.js';

const LOG_PREFIX = '[SuperAgents/everyN]';
const STORE_KEY = 'saEveryNCounters';   // chat_metadata[STORE_KEY] = { [agentId]: int }
const DECISION_STORE_KEY = 'saEveryNGateDecisions';
const DEFAULT_EVERY_N = 1;               // 1 → fire every message (no throttling)

// ============================================================================
// FIELD RESOLUTION
// ============================================================================

/**
 * Resolve an agent's configured N. Reads the canonical top-level field first,
 * then the legacy Guard block, then the default. Values < 1 or non-numeric
 * collapse to the default (which is 1 = no throttle).
 * @param {object} agent
 * @returns {number} integer >= 1
 */
export function getEveryN(agent) {
    const raw = (typeof agent?.everyN === 'number')
        ? agent.everyN
        : agent?.continuityGuard?.everyN;
    return (typeof raw === 'number' && raw > 0) ? Math.floor(raw) : DEFAULT_EVERY_N;
}

/** True when the agent has a meaningful throttle configured (N > 1). */
export function hasThrottle(agent) {
    return getEveryN(agent) > 1;
}

/** How rerolls interact with the throttle. */
export function getEveryNCadence(agent) {
    return agent?.everyNCadence === 'all-attempts' ? 'all-attempts' : 'new-replies';
}

// ============================================================================
// COUNTER STORE (per-agent, per-chat)
// ============================================================================

function store() {
    if (!chat_metadata || typeof chat_metadata !== 'object') return null;
    if (!chat_metadata[STORE_KEY] || typeof chat_metadata[STORE_KEY] !== 'object') {
        chat_metadata[STORE_KEY] = {};
    }
    return chat_metadata[STORE_KEY];
}

function decisionStore() {
    if (!chat_metadata || typeof chat_metadata !== 'object') return null;
    if (!chat_metadata[DECISION_STORE_KEY] || typeof chat_metadata[DECISION_STORE_KEY] !== 'object') {
        chat_metadata[DECISION_STORE_KEY] = {};
    }
    return chat_metadata[DECISION_STORE_KEY];
}

function rememberGateDecision(agentId, allowed) {
    const decisions = decisionStore();
    if (decisions) decisions[agentId] = Boolean(allowed);
}

function previousGateDecision(agentId) {
    const decisions = decisionStore();
    return typeof decisions?.[agentId] === 'boolean' ? decisions[agentId] : null;
}

/** Current counter value for an agent (0 if unset). */
export function getAgentCounter(agentId) {
    const s = store();
    return s ? Number(s[agentId] ?? 0) : 0;
}

/** Increment and return the agent's counter. No-op-safe if metadata missing. */
export function bumpAgentCounter(agentId) {
    const s = store();
    if (!s) return 0;
    const next = Number(s[agentId] ?? 0) + 1;
    s[agentId] = next;
    return next;
}

/** Reset an agent's counter to 0. */
export function resetAgentCounter(agentId) {
    const s = store();
    if (s) s[agentId] = 0;
}

// ============================================================================
// GENERAL GATE (consumer: activation.js snapshot builder)
// ============================================================================

/**
 * Advance an agent's throttle counter by one eligible message and report
 * whether it should fire THIS turn. Fires on every Nth message: the turn the
 * counter reaches N (then resets to 0).
 *
 * MUST be called exactly ONCE per agent per eligible turn — from the snapshot
 * builder, which runs once per generation. Never call from pure predicates.
 *
 * N <= 1 → always fires (and keeps the counter at 0, so toggling N later starts
 * clean).
 *
 * Continuity Guard agents are exempt: they manage their own counter via the
 * counter store directly and must not be gated here. Callers detect that with
 * isGuardAgent() and skip this call.
 *
 * @param {object} agent
 * @returns {boolean} true = fire this turn, false = throttled (skip)
 */
export function advanceGeneralGate(agent) {
    const n = getEveryN(agent);
    if (n <= 1) {
        resetAgentCounter(agent.id);
        return true;
    }
    const count = bumpAgentCounter(agent.id);
    if (count >= n) {
        resetAgentCounter(agent.id);
        debug(`${LOG_PREFIX} ${agent.name || agent.id}: every-${n} gate OPEN`);
        return true;
    }
    debug(`${LOG_PREFIX} ${agent.name || agent.id}: throttled (${count}/${n})`);
    return false;
}

/**
 * Apply the general gate for one generation. Ordinary replies advance the
 * counter. With the default cadence, a swipe/regenerate reuses the most recent
 * reply's run/skip decision; the opt-in cadence treats each reroll as a fresh
 * counter step. Other generation types remain ungated.
 */
export function evaluateGeneralGate(agent, rawGenerationType) {
    const n = getEveryN(agent);
    if (n <= 1) {
        resetAgentCounter(agent.id);
        rememberGateDecision(agent.id, true);
        return true;
    }

    const rawType = String(rawGenerationType ?? '').trim().toLowerCase();
    const isReroll = rawType === 'swipe' || rawType === 'regenerate';
    if (isReroll && getEveryNCadence(agent) === 'new-replies') {
        const prior = previousGateDecision(agent.id);
        const allowed = prior ?? false;
        debug(`${LOG_PREFIX} ${agent.name || agent.id}: reroll reuses ${allowed ? 'OPEN' : 'SKIP'} decision`);
        return allowed;
    }

    const counts = rawType === '' || rawType === 'normal' || rawType === 'continue'
        || (isReroll && getEveryNCadence(agent) === 'all-attempts');
    if (!counts) return true;

    const allowed = advanceGeneralGate(agent);
    rememberGateDecision(agent.id, allowed);
    return allowed;
}

/**
 * Is this agent one the general gate must SKIP (because it owns its counter)?
 * Currently: the Continuity Guard, identified structurally.
 * @param {object} agent
 * @returns {boolean}
 */
export function ownsCounterItself(agent) {
    return agent?.sourceTemplateId === 'tpl-continuity-guard'
        || agent?.continuityGuard?.enabled === true;
}
