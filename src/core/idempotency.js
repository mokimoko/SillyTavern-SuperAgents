/**
 * core/idempotency.js — per-message run tracking.
 *
 * Each agent run is tracked in chat[n].extra.agentRuns[agentId].
 * This enables:
 * - Detecting re-runs (don't double-append/extract)
 * - Storing the original text for revert on re-run
 * - Knowing which agents have already processed a message
 *
 * Ported from VerseManager; namespace key is the same ('agentRuns')
 * since it lives on the message object, not extension_settings.
 */

import { chat, saveChatDebounced } from '../../../../../../script.js';
import { debug } from '../../index.js';

const EXTRA_KEY = 'agentRuns';
const LOG_PREFIX = '[SuperAgents/idempotency]';

// ============================================================================
// CORE API
// ============================================================================

/**
 * Get the run records for a message.
 * @param {number} messageIndex
 * @returns {Object.<string, AgentRunRecord>}
 */
export function getRunRecords(messageIndex) {
    const message = chat[messageIndex];
    if (!message) return {};
    return message.extra?.[EXTRA_KEY] ?? {};
}

/**
 * Check if an agent has already run on a message.
 * @param {number} messageIndex
 * @param {string} agentId
 * @returns {boolean}
 */
export function hasAgentRun(messageIndex, agentId) {
    return Boolean(getRunRecords(messageIndex)[agentId]);
}

/**
 * Get a specific agent's run record for a message.
 * @param {number} messageIndex
 * @param {string} agentId
 * @returns {AgentRunRecord|null}
 */
export function getAgentRunRecord(messageIndex, agentId) {
    return getRunRecords(messageIndex)[agentId] ?? null;
}

/**
 * Record that an agent ran on a message.
 * If the agent previously ran, the old record is overwritten (idempotent).
 *
 * @param {number} messageIndex
 * @param {object} record
 * @param {string} record.agentId
 * @param {string} record.agentName
 * @param {'pre'|'post'} record.phase
 * @param {string|null} [record.originalText]
 * @param {string|null} [record.result]
 * @param {string} [record.mode]
 */
export function recordAgentRun(messageIndex, record) {
    const message = chat[messageIndex];
    if (!message) return;

    if (!message.extra) message.extra = {};
    if (!message.extra[EXTRA_KEY]) message.extra[EXTRA_KEY] = {};

    message.extra[EXTRA_KEY][record.agentId] = {
        agentId: record.agentId,
        agentName: record.agentName,
        phase: record.phase,
        lastRunTimestamp: Date.now(),
        originalText: record.originalText ?? null,
        result: record.result ?? null,
        mode: record.mode ?? 'rewrite',
    };

    saveChatDebounced();
    debug(`${LOG_PREFIX} Recorded run: ${record.agentName} on message ${messageIndex} (${record.mode})`);
}

/**
 * Clear a specific agent's run record for a message.
 * @param {number} messageIndex
 * @param {string} agentId
 */
export function clearAgentRun(messageIndex, agentId) {
    const message = chat[messageIndex];
    if (!message?.extra?.[EXTRA_KEY]) return;

    delete message.extra[EXTRA_KEY][agentId];

    if (Object.keys(message.extra[EXTRA_KEY]).length === 0) {
        delete message.extra[EXTRA_KEY];
    }

    saveChatDebounced();
}

/**
 * Revert a rewrite-mode agent's changes on a message.
 * Restores the original text from the run record.
 *
 * @param {number} messageIndex
 * @param {string} agentId
 * @returns {boolean} true if reverted
 */
export function revertAgentRewrite(messageIndex, agentId) {
    const record = getAgentRunRecord(messageIndex, agentId);
    if (!record || record.mode !== 'rewrite' || record.originalText === null) {
        return false;
    }

    const message = chat[messageIndex];
    if (!message) return false;

    message.mes = record.originalText;
    clearAgentRun(messageIndex, agentId);

    debug(`${LOG_PREFIX} Reverted rewrite from ${record.agentName} on message ${messageIndex}`);
    return true;
}
