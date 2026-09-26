/** Pure display-ownership helpers for merge-variable sidecars. */

export function requiresOwnSwipeDisplay(agent) {
    return agent?.sidecarCall?.display?.inheritState === false;
}

/** Return this agent's successful state for the exact swipe, or null. */
export function getOwnSwipeDisplayItems(agent, message, swipeId = message?.swipe_id ?? 0) {
    const varName = agent?.mergeVariable?.variableName;
    if (!varName) return null;

    const records = message?.saAgentSwipes?.[varName];
    if (!records || !Object.prototype.hasOwnProperty.call(records, swipeId)) return null;

    const items = records[swipeId];
    return Array.isArray(items) ? items : null;
}

/** Episodic displays are valid only when the current swipe owns non-empty state. */
export function canRenderSidecarData(agent, message, swipeId = message?.swipe_id ?? 0) {
    if (!requiresOwnSwipeDisplay(agent)) return true;
    return (getOwnSwipeDisplayItems(agent, message, swipeId)?.length ?? 0) > 0;
}
