/** Pure output-budget calculation for JSON-envelope sidecar batches. */

export const FALLBACK_BATCH_MAX_TOKENS = 8192;
export const ENVELOPE_OVERHEAD_FRACTION = 0.08;

function positiveNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? Math.floor(number) : null;
}

/**
 * A group override wins over the global ceiling. Agent budgets describe
 * payload content, so the request adds room for the shared JSON envelope.
 */
export function calculateBatchBudget(agents, options = {}) {
    const groupCeiling = positiveNumber(options.groupMaxTokens);
    const globalCeiling = positiveNumber(options.globalMaxTokens);
    const ceiling = groupCeiling || globalCeiling || FALLBACK_BATCH_MAX_TOKENS;
    const requestedContent = (agents || []).reduce(
        (sum, agent) => sum + (positiveNumber(agent?.sidecarCall?.maxTokens)
            || positiveNumber(agent?.maxTokens) || 2048),
        0,
    );
    const usableContent = Math.max(1, Math.floor(ceiling * (1 - ENVELOPE_OVERHEAD_FRACTION)));
    const requestedWithEnvelope = Math.max(1, Math.ceil(
        requestedContent / (1 - ENVELOPE_OVERHEAD_FRACTION),
    ));

    return {
        ceiling,
        requestedContent,
        usableContent,
        maxTokens: Math.min(ceiling, requestedWithEnvelope),
        constrained: requestedContent > usableContent,
        source: groupCeiling ? 'group' : globalCeiling ? 'global' : 'fallback',
    };
}
