export const SUPERAGENTS_EVENTS = Object.freeze({
    STATE_COMMITTED: 'superagents:state-committed',
    STATE_REJECTED: 'superagents:state-rejected',
    SNAPSHOT_REUSED: 'superagents:snapshot-reused',
    ACTIVITY_CHANGED: 'superagents:activity-changed',
    COMMITMENTS_CHANGED: 'superagents:commitments-changed',
    PRESENTATION_CHANGED: 'superagents:presentation-changed',
    STATE_CARD_STYLE_CHANGED: 'superagents:state-card-style-changed',
});

/** Publish metadata only; consumers read committed values through the API. */
export function emitStateTransaction(committed, detail) {
    if (typeof globalThis.dispatchEvent !== 'function' || typeof CustomEvent !== 'function') return;
    const eventName = committed
        ? SUPERAGENTS_EVENTS.STATE_COMMITTED
        : SUPERAGENTS_EVENTS.STATE_REJECTED;
    globalThis.dispatchEvent(new CustomEvent(eventName, { detail }));
}
