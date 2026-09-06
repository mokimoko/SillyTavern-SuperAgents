function clone(value) {
    if (value === undefined) return undefined;
    if (typeof structuredClone === 'function') return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
}

function parseItem(item, jsonField) {
    try {
        return JSON.parse(item?.[jsonField]);
    } catch {
        return null;
    }
}

function valuesAtPath(root, rawPath) {
    const segments = String(rawPath || '').split('.').map(part => part.trim()).filter(Boolean);
    let values = [root];
    for (const segment of segments) {
        const next = [];
        for (const value of values) {
            if (!value || typeof value !== 'object') continue;
            if (segment === '*') {
                next.push(...Object.values(value));
            } else if (Object.prototype.hasOwnProperty.call(value, segment)) {
                next.push(value[segment]);
            }
        }
        values = next;
        if (values.length === 0) break;
    }
    return values;
}

function hasMeaningfulValue(value) {
    if (Array.isArray(value)) return value.length > 0;
    if (value && typeof value === 'object') return Object.keys(value).length > 0;
    if (typeof value === 'string') return value.trim().length > 0;
    return value !== null && value !== undefined && value !== false;
}

function knowledgePriority(entry) {
    let score = 0;
    if (entry?.attention === 'active') score += 100;
    if (entry?.lifecycle !== 'resolved') score += 80;
    if (entry?.visibility === 'secret') score += 60;
    else if (entry?.visibility === 'private') score += 40;
    if (entry?.truthStatus === 'unresolved') score += 50;
    if (entry?.sensitivity === 'critical') score += 40;
    else if (entry?.sensitivity === 'high') score += 20;
    if (entry?.durability === 'structural') score += 30;
    else if (entry?.durability === 'durable') score += 15;
    score += Math.max(Number(entry?.pressure) || 0, Number(entry?.disclosureRisk) || 0) / 10;
    return score;
}

function compactPerspective(perspective) {
    return {
        character: perspective?.character,
        position: perspective?.position,
        access: perspective?.access,
        disclosureIntent: perspective?.disclosureIntent,
    };
}

function compactKnowledgeEntry(entry) {
    const compact = {
        summary: entry?.summary,
        recordType: entry?.recordType,
        truthStatus: entry?.truthStatus,
        visibility: entry?.visibility,
        lifecycle: entry?.lifecycle,
        disclosurePolicy: entry?.disclosurePolicy,
        perspectives: Array.isArray(entry?.perspectives)
            ? entry.perspectives.map(compactPerspective)
            : [],
    };
    for (const key of ['controllers', 'revealPrerequisites', 'coverFor', 'coverStories']) {
        if (Array.isArray(entry?.[key]) && entry[key].length > 0) compact[key] = clone(entry[key]);
    }
    return compact;
}

function projectKnowledge(logical, maxDetailedEntries) {
    const facts = logical?.facts;
    if (!facts || typeof facts !== 'object' || Array.isArray(facts)) return logical;

    const ranked = Object.entries(facts)
        .map(([id, entry], order) => ({ id, entry, order, priority: knowledgePriority(entry) }))
        .sort((left, right) => right.priority - left.priority || left.order - right.order);
    const detailed = ranked.slice(0, maxDetailedEntries);
    const omitted = ranked.slice(maxDetailedEntries);
    const projected = {
        facts: Object.fromEntries(detailed.map(({ id, entry }) => [id, compactKnowledgeEntry(entry)])),
    };
    if (omitted.length > 0) {
        projected.omittedFactStubs = omitted.map(({ id, entry }) => ({
            id,
            summary: entry?.summary,
            truthStatus: entry?.truthStatus,
            visibility: entry?.visibility,
            lifecycle: entry?.lifecycle,
        }));
    }
    return projected;
}

/** Project full tracker state into a smaller, disclosure-safe payload for the main model. */
export function projectItemsForMainContext(items, rawConfig, jsonField = 'json') {
    const config = rawConfig && typeof rawConfig === 'object' ? rawConfig : {};
    if (!Array.isArray(items)) return items;
    const maxDetailedEntries = Math.max(1, Math.min(24, Number(config.maxDetailedEntries) || 12));
    const projected = items.map(item => {
        const logical = parseItem(item, jsonField);
        if (!logical || !config.enabled || config.mode !== 'knowledge') return item;
        return {
            ...item,
            [jsonField]: JSON.stringify(projectKnowledge(logical, maxDetailedEntries)),
        };
    });

    const presencePath = String(config.presencePath || '').trim();
    if (!presencePath) return projected;
    return projected.filter(item => {
        const logical = parseItem(item, jsonField);
        // Malformed legacy state should remain visible for diagnosis rather than
        // disappearing behind an empty-projection rule.
        if (!logical) return true;
        return valuesAtPath(logical, presencePath).some(hasMeaningfulValue);
    });
}
