/**
 * Recover JSON objects from a model response without trusting prose around
 * them. Results are ordered by closing position, so callers can try the final
 * outer object first by iterating backward.
 */
export function extractJsonObjectCandidates(response) {
    const text = String(response ?? '').trim();
    if (!text) return [];

    const candidates = [];
    const seen = new Set();
    const starts = [];
    let inString = false;
    let escaped = false;

    for (let index = 0; index < text.length; index++) {
        const char = text[index];
        if (inString) {
            if (escaped) escaped = false;
            else if (char === '\\') escaped = true;
            else if (char === '"') inString = false;
            continue;
        }
        if (char === '"') {
            inString = true;
            continue;
        }
        if (char === '{') {
            starts.push(index);
            continue;
        }
        if (char !== '}' || starts.length === 0) continue;

        const start = starts.pop();
        const raw = text.slice(start, index + 1);
        if (seen.has(raw)) continue;
        try {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                seen.add(raw);
                candidates.push(parsed);
            }
        } catch {
            // Keep scanning: a later or inner object may still be valid JSON.
        }
    }

    return candidates;
}

function normalizeEnvelopeKey(value) {
    return String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function extractionTagAlias(pattern) {
    const source = String(pattern ?? '');
    const match = source.match(/\\\[([a-z0-9_-]+)\\\]/i);
    return match?.[1] || '';
}

function buildRecoveryRegex(pattern) {
    try {
        const source = String(pattern ?? '');
        const slashMatch = source.match(/^\/(.+)\/([gimsuy]*)$/);
        if (slashMatch) {
            return new RegExp(slashMatch[1], slashMatch[2].replaceAll('g', ''));
        }
        return new RegExp(source, 's');
    } catch {
        return null;
    }
}

/**
 * Recover expected batch values when a model slightly misses the outer JSON
 * contract. Exact keys win, followed by normalized key/name/tag aliases, then
 * the task's own tagged extraction format. Values remain untrusted; callers
 * still pass them through each agent's normal state validation transaction.
 * An optional candidate predicate lets validated trackers safely identify an
 * otherwise unlabeled bare object by schema.
 */
export function recoverBatchEnvelope(response, agents, parsedEnvelope = {}, acceptsCandidate = null) {
    const envelope = parsedEnvelope
        && typeof parsedEnvelope === 'object'
        && !Array.isArray(parsedEnvelope)
        ? { ...parsedEnvelope }
        : {};
    const candidateObjects = [envelope, ...extractJsonObjectCandidates(response)]
        .filter(value => value && typeof value === 'object' && !Array.isArray(value));

    for (const agent of agents ?? []) {
        const key = agent?.sidecarCall?.responseKey || agent?.id;
        if (!key || (envelope[key] !== undefined && envelope[key] !== null)) continue;

        const aliases = new Set([
            key,
            agent?.id,
            agent?.name,
            extractionTagAlias(agent?.mergeVariable?.extractPattern),
        ].map(normalizeEnvelopeKey).filter(Boolean));

        let found = false;
        for (let index = candidateObjects.length - 1; index >= 0 && !found; index--) {
            for (const [candidateKey, value] of Object.entries(candidateObjects[index])) {
                if (!aliases.has(normalizeEnvelopeKey(candidateKey))) continue;
                if (value === undefined || value === null) continue;
                envelope[key] = value;
                found = true;
                break;
            }
        }
        if (found) continue;

        if (typeof acceptsCandidate === 'function') {
            for (let index = candidateObjects.length - 1; index >= 0; index--) {
                if (acceptsCandidate(agent, candidateObjects[index])) {
                    envelope[key] = candidateObjects[index];
                    found = true;
                    break;
                }
            }
        }
        if (found) continue;

        const extractionRegex = buildRecoveryRegex(agent?.mergeVariable?.extractPattern);
        const taggedMatch = extractionRegex?.exec(String(response ?? ''));
        if (taggedMatch?.[0]) envelope[key] = taggedMatch[0];
    }

    return envelope;
}
