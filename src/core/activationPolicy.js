/** Chat-local lifecycle gates for initialization and one-shot agents. */

import {
    chat,
    chat_metadata,
    saveChatDebounced,
} from '../../../../../../script.js';

const STORE_KEY = 'saActivationPolicyRuns';

export const ActivationPolicyMode = Object.freeze({
    ALWAYS: 'always',
    UNTIL_STATE: 'until-state',
    ONCE_PER_CHAT: 'once-per-chat',
    ONCE_PER_BRANCH: 'once-per-branch',
});

function policyMode(agent) {
    return Object.values(ActivationPolicyMode).includes(agent?.activationPolicy?.mode)
        ? agent.activationPolicy.mode
        : ActivationPolicyMode.ALWAYS;
}

function hasTrackedState(agent) {
    const variableName = String(agent?.mergeVariable?.variableName || '').trim();
    if (!agent?.mergeVariable?.enabled || !variableName) return false;
    try {
        const parsed = JSON.parse(chat_metadata?.variables?.[variableName] || '[]');
        return Array.isArray(parsed) && parsed.length > 0;
    } catch {
        return false;
    }
}

/**
 * A branch identity only records actual alternate-swipe choices. Appending a
 * normal swipe-0 message therefore does not turn the same growing branch into
 * a new branch every turn.
 */
export function currentBranchKey(messages = chat) {
    const choices = [];
    for (let index = 0; index < (messages || []).length; index++) {
        const swipeId = Math.max(0, Number(messages[index]?.swipe_id) || 0);
        if (swipeId > 0) choices.push(`${index}:${swipeId}`);
    }
    return choices.join('|') || 'main';
}

function readRecord(agentId) {
    return chat_metadata?.[STORE_KEY]?.[agentId] || null;
}

/** Apply the configured lifecycle gate before probability and cadence gates. */
export function activationPolicyAllows(agent) {
    const mode = policyMode(agent);
    if (mode === ActivationPolicyMode.ALWAYS) return true;
    if (mode === ActivationPolicyMode.UNTIL_STATE) return !hasTrackedState(agent);

    const record = readRecord(agent?.id);
    if (mode === ActivationPolicyMode.ONCE_PER_CHAT) return !record?.chat;
    if (mode === ActivationPolicyMode.ONCE_PER_BRANCH) {
        return !record?.branches?.[currentBranchKey()];
    }
    return true;
}

/** Mark a successful run. Failed or rejected initialization calls never call this. */
export function markActivationPolicyComplete(agent) {
    const mode = policyMode(agent);
    if (mode !== ActivationPolicyMode.ONCE_PER_CHAT
        && mode !== ActivationPolicyMode.ONCE_PER_BRANCH) return false;
    if (!chat_metadata || typeof chat_metadata !== 'object' || !agent?.id) return false;

    chat_metadata[STORE_KEY] ||= {};
    const record = chat_metadata[STORE_KEY][agent.id] ||= { chat: false, branches: {} };
    record.branches ||= {};
    if (mode === ActivationPolicyMode.ONCE_PER_CHAT) record.chat = true;
    else record.branches[currentBranchKey()] = Date.now();
    record.completedAt = Date.now();
    saveChatDebounced();
    return true;
}

/** Re-arm one-shot behavior for this agent in the current chat. */
export function clearActivationPolicyState(agent) {
    const store = chat_metadata?.[STORE_KEY];
    if (!store || !agent?.id || !(agent.id in store)) return false;
    delete store[agent.id];
    if (Object.keys(store).length === 0) delete chat_metadata[STORE_KEY];
    saveChatDebounced();
    return true;
}

