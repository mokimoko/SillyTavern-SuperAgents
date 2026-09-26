/** Chat-local bookkeeping for post-generation work deferred during rerolls. */

import { chat_metadata } from '../../../../../../script.js';

const STORE_KEY = 'saDeferredSwipeAgentIds';

export function isSwipeGeneration(generationType) {
    const type = String(generationType ?? '').trim().toLowerCase();
    return type === 'swipe' || type === 'regenerate';
}

/** Only postpone routes that can make a model/provider call after the reply. */
export function isDeferrablePostAgent(agent) {
    return agent?.sidecarCall?.enabled === true
        || agent?.postProcess?.rewriteEnabled === true
        || agent?.phoneConfig != null
        || agent?.feedConfig != null;
}

export function getDeferredSwipeAgentIds() {
    const ids = Array.isArray(chat_metadata?.[STORE_KEY]) ? chat_metadata[STORE_KEY] : [];
    return [...new Set(ids.map(id => String(id ?? '').trim()).filter(Boolean))];
}

export function rememberDeferredSwipeAgentIds(agentIds) {
    const current = new Set(getDeferredSwipeAgentIds());
    for (const id of agentIds ?? []) {
        const value = String(id ?? '').trim();
        if (value) current.add(value);
    }
    if (chat_metadata && typeof chat_metadata === 'object') {
        chat_metadata[STORE_KEY] = [...current];
    }
}

export function clearDeferredSwipeAgentIds(agentIds = null) {
    if (!chat_metadata || typeof chat_metadata !== 'object' || !Array.isArray(chat_metadata[STORE_KEY])) return;
    if (agentIds == null) {
        chat_metadata[STORE_KEY] = [];
        return;
    }
    const removed = new Set((agentIds ?? []).map(id => String(id ?? '').trim()));
    chat_metadata[STORE_KEY] = getDeferredSwipeAgentIds().filter(id => !removed.has(id));
}

export function pruneDeferredSwipeAgentIds(validAgentIds) {
    if (!chat_metadata || typeof chat_metadata !== 'object' || !Array.isArray(chat_metadata[STORE_KEY])) return;
    const valid = new Set(validAgentIds ?? []);
    chat_metadata[STORE_KEY] = getDeferredSwipeAgentIds().filter(id => valid.has(id));
}
