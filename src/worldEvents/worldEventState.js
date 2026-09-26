const VALID_IMPORTANCE = new Set(['major', 'average', 'minor']);
const VALID_DISTANCE = new Set(['local', 'distant']);
const VALID_TONE = new Set(['positive', 'neutral', 'negative']);

function cleanText(value, maxLength) {
    return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function cleanEvent(value, proposal = false) {
    if (!value || typeof value !== 'object') return null;
    const title = cleanText(value.title, 100);
    const description = cleanText(value.description, 320);
    if (!title || !description) return null;
    const event = {
        title,
        description,
        importance: VALID_IMPORTANCE.has(value.importance) ? value.importance : 'average',
        distance: VALID_DISTANCE.has(value.distance) ? value.distance : 'distant',
        tone: VALID_TONE.has(value.tone) ? value.tone : 'neutral',
    };
    if (!proposal) {
        event.id = cleanText(value.id, 80);
        event.addedAtMessage = Math.max(0, Number(value.addedAtMessage) || 0);
        if (!event.id) return null;
    }
    return event;
}

export function normalizeWorldEventState(value) {
    const source = value && typeof value === 'object' ? value : {};
    return {
        roster: Array.isArray(source.roster)
            ? source.roster.map(item => cleanEvent(item, false)).filter(Boolean)
            : [],
        proposals: Array.isArray(source.proposals)
            ? source.proposals.map(item => cleanEvent(item, true)).filter(Boolean)
            : [],
        history: Array.isArray(source.history)
            ? source.history.map(item => {
                const event = cleanEvent(item, false);
                if (!event) return null;
                return {
                    ...event,
                    resolvedAtMessage: Math.max(event.addedAtMessage, Number(item.resolvedAtMessage) || 0),
                };
            }).filter(Boolean).slice(-20)
            : [],
    };
}

export function readWorldEventState(items) {
    const raw = items?.[0]?.json;
    if (typeof raw !== 'string' || !raw.trim()) return normalizeWorldEventState();
    try {
        return normalizeWorldEventState(JSON.parse(raw));
    } catch {
        return normalizeWorldEventState();
    }
}

function comparable(event) {
    return `${event.title}\u241f${event.description}`.toLocaleLowerCase();
}

export function acceptWorldEvent(state, proposal, messageIndex, maxRoster = 8) {
    const current = normalizeWorldEventState(state);
    const candidate = cleanEvent(proposal, true);
    const limit = Math.max(1, Math.floor(Number(maxRoster) || 8));
    if (!candidate) return { state: current, accepted: false, reason: 'invalid' };
    if (current.roster.some(event => comparable(event) === comparable(candidate))) {
        return {
            state: { ...current, proposals: [] },
            accepted: false,
            reason: 'duplicate',
        };
    }
    if (current.roster.length >= limit) {
        return { state: current, accepted: false, reason: 'full' };
    }

    const baseId = `we-${Math.max(0, Number(messageIndex) || 0)}`;
    let serial = 1;
    while ([...current.roster, ...current.history].some(event => event.id === `${baseId}-${serial}`)) serial += 1;
    return {
        state: {
            roster: [...current.roster, {
                ...candidate,
                id: `${baseId}-${serial}`,
                addedAtMessage: Math.max(0, Number(messageIndex) || 0),
            }],
            proposals: [],
            history: current.history,
        },
        accepted: true,
        reason: '',
    };
}

export function dismissWorldEventProposals(state) {
    return { ...normalizeWorldEventState(state), proposals: [] };
}

export function removeWorldEvent(state, eventId) {
    const current = normalizeWorldEventState(state);
    const id = String(eventId ?? '').trim();
    return {
        ...current,
        roster: current.roster.filter(event => event.id !== id),
    };
}

export function updateWorldEvent(state, eventId, update) {
    const current = normalizeWorldEventState(state);
    const id = String(eventId ?? '').trim();
    const existing = current.roster.find(event => event.id === id);
    const next = cleanEvent({ ...existing, ...update, id }, false);
    if (!existing || !next) return current;
    return {
        ...current,
        roster: current.roster.map(event => event.id === id ? next : event),
    };
}

export function resolveWorldEvent(state, eventId, messageIndex) {
    const current = normalizeWorldEventState(state);
    const id = String(eventId ?? '').trim();
    const event = current.roster.find(item => item.id === id);
    if (!event) return current;
    return {
        ...current,
        roster: current.roster.filter(item => item.id !== id),
        history: [...current.history, {
            ...event,
            resolvedAtMessage: Math.max(event.addedAtMessage, Number(messageIndex) || 0),
        }].slice(-20),
    };
}

export function removeWorldEventHistory(state, eventId) {
    const current = normalizeWorldEventState(state);
    const id = String(eventId ?? '').trim();
    return {
        ...current,
        history: current.history.filter(event => event.id !== id),
    };
}

export function worldEventProposalKey(state, messageIndex, swipeId = 0) {
    const proposals = normalizeWorldEventState(state).proposals;
    if (!proposals.length) return '';
    return `${Number(messageIndex) || 0}:${Number(swipeId) || 0}:${JSON.stringify(proposals)}`;
}
