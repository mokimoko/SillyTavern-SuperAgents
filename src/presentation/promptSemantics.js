/** Model-facing contracts derived from presentation descriptors. */

export function fillPresentationTemplate(template, values = {}) {
    return String(template || '').replace(/\{([a-zA-Z]+)\}/g, (match, key) => (
        Object.hasOwn(values, key) ? String(values[key]) : match
    ));
}

export function buildModelBehaviorContract(surface = {}) {
    const behavior = surface.modelBehavior;
    if (!behavior) return '';
    const lines = [
        `[${surface.title || surface.label || 'Story surface'} behavior contract]`,
        behavior.medium ? `Medium: ${behavior.medium}.` : '',
        behavior.delivery ? `Delivery: ${behavior.delivery}.` : '',
        behavior.replyMode ? `Response model: ${behavior.replyMode}.` : '',
        behavior.protocolNote || '',
        ...(behavior.rules || []).map(rule => `- ${rule}`),
    ].filter(Boolean);
    return lines.join('\n');
}

