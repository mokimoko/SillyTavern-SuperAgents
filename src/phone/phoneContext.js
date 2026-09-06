/** Build optional cross-extension state context for Phone-only LLM calls. */

function findCaseInsensitive(object, key) {
    if (!object || typeof object !== 'object' || Array.isArray(object)) return null;
    const match = Object.keys(object).find(candidate => candidate.toLowerCase() === key.toLowerCase());
    return match ? { key: match, value: object[match] } : null;
}

function stateSourceSections(character, options) {
    if (options.includeStateSources === false) return [];
    const api = globalThis.SuperAgents?.integration;
    if (!api?.listStateSources || !api?.getState) return [];

    const sections = [];
    try {
        for (const source of api.listStateSources()) {
            if (!source.enabled || !source.validated) continue;
            const resolved = api.getState(source.variableName, options);
            const match = findCaseInsensitive(resolved?.value?.characters, character);
            if (!match) continue;
            sections.push([
                `Persistent state — ${source.agentName || source.variableName} (${match.key}):`,
                JSON.stringify(match.value, null, 2),
            ].join('\n'));
        }
    } catch { /* Optional state context must never block texting. */ }
    return sections;
}

function stateTrackSections(character, options) {
    if (options.includeStateTracks === false) return [];
    const api = globalThis.DynamicEvents?.integration;
    if (!api?.getStateTrackContexts) return [];

    try {
        return api.getStateTrackContexts({
            subject: character,
            messageIndex: options.messageIndex,
            swipeId: options.swipeId,
        }).map(context => [
            `Active State Track — ${context.trackName}: ${context.stateName}`,
            context.text,
        ].filter(Boolean).join('\n'));
    } catch {
        return [];
    }
}

export function buildPhoneStateContext(character, { messageIndex, swipeId, config = {} } = {}) {
    const name = String(character || '').trim();
    if (!name || config?.enabled === false) return '';

    const options = {
        messageIndex,
        swipeId,
        includeStateSources: config?.includeStateSources !== false,
        includeStateTracks: config?.includeStateTracks !== false,
    };
    const sections = [
        ...stateSourceSections(name, options),
        ...stateTrackSections(name, options),
    ];
    if (!sections.length) return '';

    const requestedMax = Number(config?.maxChars || 6000);
    const maxChars = Number.isFinite(requestedMax) ? Math.max(500, requestedMax) : 6000;
    const text = [
        `### Current state for ${name}`,
        'Use this state to determine tone, restraint, initiative, and subtext. Do not invent milestones.',
        ...sections,
    ].join('\n\n');
    return text.length > maxChars ? `${text.slice(0, maxChars)}\n[State context truncated]` : text;
}
