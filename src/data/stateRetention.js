function valueAtPath(root, rawPath) {
    let current = root;
    for (const part of String(rawPath || '').split('.').filter(Boolean)) {
        if (current === null || typeof current !== 'object') return undefined;
        current = current[part];
    }
    return current;
}

function comparableEntry(entry, changeField, attentionField) {
    const comparable = {};
    for (const key of Object.keys(entry || {}).sort()) {
        if (key === changeField || key === attentionField) continue;
        comparable[key] = entry[key];
    }
    return JSON.stringify(comparable);
}

function matchesRule(entry, rule) {
    const value = valueAtPath(entry, rule.path);
    return (rule.values || []).some(candidate => candidate === value);
}

function hasEntries(value) {
    return Array.isArray(value) && value.length > 0;
}

function knowledgePositionMatchesTruth(position, truthStatus) {
    if (truthStatus === 'confirmed') return position === 'knows-true' || position === 'believes-true';
    if (truthStatus === 'false') return position === 'knows-false' || position === 'believes-false';
    return false;
}

/** Only fully resolved, public, contextual records with no remaining access split are safe to forget. */
function isSafelyPrunableKnowledge(entry) {
    if (!entry || typeof entry !== 'object') return false;
    if (entry.lifecycle !== 'resolved' || entry.durability !== 'contextual') return false;
    if (entry.visibility !== 'public' || entry.truthStatus === 'unresolved') return false;
    if (hasEntries(entry.revealPrerequisites)
        || hasEntries(entry.coverFor)
        || hasEntries(entry.coverStories)) return false;

    const perspectives = Array.isArray(entry.perspectives) ? entry.perspectives : [];
    return perspectives.length > 0 && perspectives.every(perspective => (
        knowledgePositionMatchesTruth(perspective?.position, entry.truthStatus)
    ));
}

function cloneValue(value) {
    if (typeof structuredClone === 'function') return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
}

function parseLogicalItem(item, jsonField) {
    if (!jsonField) return item && typeof item === 'object' ? cloneValue(item) : null;
    try {
        return JSON.parse(item?.[jsonField]);
    } catch {
        return null;
    }
}

function writeLogicalItem(item, logical, jsonField) {
    if (jsonField) return { ...item, [jsonField]: JSON.stringify(logical) };
    return logical;
}

export function normalizeRetentionConfig(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const maxEntries = Math.max(1, Math.min(50, Number(source.maxEntries) || 8));
    const dormantAfter = Math.max(1, Math.min(50, Number(source.dormantAfter) || 2));
    const pruneAfter = Math.max(dormantAfter + 1, Math.min(100, Number(source.pruneAfter) || 5));
    return {
        enabled: Boolean(source.enabled),
        strategy: source.strategy === 'knowledge' ? 'knowledge' : 'working-set',
        collectionPath: String(source.collectionPath || '').trim(),
        maxEntries,
        dormantAfter,
        pruneAfter,
        changeField: String(source.changeField || 'changed').trim(),
        attentionField: String(source.attentionField || 'attention').trim(),
        excludeParticipants: Boolean(source.excludeParticipants),
        excludePlayerPersonas: Boolean(source.excludePlayerPersonas),
        participantFields: Array.isArray(source.participantFields)
            ? source.participantFields.map(field => String(field ?? '').trim()).filter(Boolean)
            : [],
        protectedWhen: Array.isArray(source.protectedWhen)
            ? source.protectedWhen.filter(rule => rule && typeof rule.path === 'string' && Array.isArray(rule.values))
                .map(rule => ({ path: rule.path.trim(), values: [...rule.values] }))
            : [],
    };
}

export function buildRetentionPrompt(rawConfig) {
    const config = normalizeRetentionConfig(rawConfig);
    if (!config.enabled || !config.collectionPath) return '';
    if (config.strategy === 'knowledge') {
        return `### KNOWLEDGE LEDGER ADMISSION + RETENTION — HIGHEST PRIORITY
Treat \`${config.collectionPath}\` as a compact continuity safeguard, not a lorebook. ${config.maxEntries} records is the normal working target; fewer is better.

ADMIT a proposition only when at least one is true:
- Relevant characters have meaningfully different access, belief, suspicion, or certainty.
- It is an unresolved claim, rumor, deliberate lie, or cover story.
- Disclosure requires a narrative gate or forgetting access would cause a continuity error.
- Investigation, concealment, or disclosure pressure can still change future behavior.

DO NOT ADMIT:
- Public/common facts every relevant character can freely know; ordinary undisputed lore; scenery or transient observations resolved in the same scene.
- Preferences or trivia with no future information consequence.
- Relationship feelings/social topology, current goals/locations/off-screen plans, or other state owned by another tracker.

LIFECYCLE:
- Every record must set \`changed\` true only for a meaningful information-state change; paraphrase and continued stasis are false.
- Set \`lifecycle\` to open while any access split, false belief, unresolved truth, concealment, investigation, reveal gate, or linked cover story remains. Set it to resolved only when those information consequences are canonically finished.
- Runtime marks unchanged records dormant after ${config.dormantAfter} tracker runs. Dormant means "retain for continuity, omit from ordinary event selection," not forgotten.
- A record is safe to cull only when ALL are true: lifecycle=resolved, durability=contextual, visibility=public, truthStatus is resolved, revealPrerequisites/coverFor/coverStories are empty, and every listed perspective agrees with the resolved truth.
- Structural, durable, open, private/secret, unresolved, gated, linked, or perspective-divergent records are NEVER automatically pruned. If protected records fill the hard ledger cap, preserve them and decline to add lower-value material.
- At capacity, remove the stalest safely-cullable record before admitting a new qualifying one. Never delete protected state merely to make room.`;
    }
    const participantRules = config.excludeParticipants
        ? `
- The current non-user scene lead is eligible for this roster. "Independent" means the character has agency, not that they must be off-screen; retain a present lead when they have a current objective, commitment, or plausible next action.
- On the first run, establish every clearly qualifying named non-user character from visible history. Do not return an empty collection merely because no previous roster exists.
- An empty collection is correct only when no established non-user character qualifies after applying those rules. Conservative tracking must not erase obvious current agency.`
        : '';
    return `### ACTIVE WORKING-SET RETENTION — HIGHEST PRIORITY
Treat \`${config.collectionPath}\` as a bounded active simulation frontier, not a permanent NPC database.
- Return at most ${config.maxEntries} entries. Keep characters with a current goal, open loop, plausible near-term action, or meaningful relationship to what may happen next.${participantRules}
- Set \`${config.changeField}\` to true only when canon supports a meaningful new development since the prior state. Paraphrasing, "still waiting," "still not texting," or merely continuing the same activity is NOT a change.
- Set \`${config.attentionField}\` to "active" for every entry you retain. Omit dormant, resolved, incidental, and no-longer-relevant characters entirely; do not copy every prior entry forward.
- A removed character is not erased from canon. Phone history, chat history, and durable memory retain continuity and may justify adding them again later.
- Prefer an empty collection over stale filler. Never invent activity merely to keep an entry alive.`;
}

export function applyStateRetention(items, rawConfig, options = {}) {
    const config = normalizeRetentionConfig(rawConfig);
    const excludeNames = options.excludeNames instanceof Set ? options.excludeNames : null;
    const shouldFilterParticipants = (config.excludeParticipants || config.excludePlayerPersonas)
        && excludeNames?.size > 0;
    if ((!config.enabled && !shouldFilterParticipants)
        || !config.collectionPath
        || !Array.isArray(items)) return items;

    const jsonField = options.jsonField || '';
    const previousItems = Array.isArray(options.previousItems) ? options.previousItems : [];
    return items.map((item, index) => {
        const logical = parseLogicalItem(item, jsonField);
        const previous = parseLogicalItem(previousItems[index], jsonField);
        const collection = valueAtPath(logical, config.collectionPath);
        const previousCollection = valueAtPath(previous, config.collectionPath) || {};
        if (!collection || typeof collection !== 'object' || Array.isArray(collection)) return item;

        // Participant exclusion (opt-in): drop any collection key that names a
        // player persona or an explicitly excluded participant BEFORE ranking,
        // so they never reach the stored state, the display, or DE subject
        // selection. The name set is computed by the caller (it needs ST chat
        // access this pure-data module deliberately avoids) and passed in.
        if (excludeNames && excludeNames.size) {
            for (const key of Object.keys(collection)) {
                const entry = collection[key];
                const keyParticipants = String(key).split('→');
                const namedParticipant = keyParticipants.some(name => (
                    excludeNames.has(String(name).trim().toLowerCase())
                ));
                const fieldParticipant = config.participantFields.some(field => (
                    excludeNames.has(String(valueAtPath(entry, field) ?? '').trim().toLowerCase())
                ));
                if (namedParticipant || fieldParticipant) delete collection[key];
            }
        }

        if (!config.enabled) return writeLogicalItem(item, logical, jsonField);

        const previousMeta = previousItems[index]?._retention?.[config.collectionPath] || {};
        const ranked = Object.entries(collection).map(([name, entry], order) => {
            const signature = comparableEntry(entry, config.changeField, config.attentionField);
            const priorSignature = previousMeta[name]?.signature
                || comparableEntry(previousCollection[name], config.changeField, config.attentionField);
            const explicitChange = entry?.[config.changeField] === true;
            const meaningfullyChanged = !previousCollection[name]
                || (explicitChange && signature !== priorSignature);
            const unchangedRuns = meaningfullyChanged
                ? 0
                : (Number(previousMeta[name]?.unchangedRuns) || 0) + 1;
            const protectedEntry = (config.strategy === 'knowledge' && !isSafelyPrunableKnowledge(entry))
                || config.protectedWhen.some(rule => matchesRule(entry, rule));
            const pruneAfter = protectedEntry ? config.pruneAfter * 2 : config.pruneAfter;

            entry[config.attentionField] = unchangedRuns >= config.dormantAfter ? 'dormant' : 'active';
            return {
                name,
                entry,
                order,
                signature,
                unchangedRuns,
                protectedEntry,
                keep: protectedEntry || unchangedRuns < pruneAfter,
            };
        }).filter(candidate => candidate.keep);

        ranked.sort((left, right) => Number(right.protectedEntry) - Number(left.protectedEntry)
            || left.unchangedRuns - right.unchangedRuns
            || left.order - right.order);
        const retained = config.strategy === 'knowledge'
            ? (() => {
                const protectedEntries = ranked.filter(candidate => candidate.protectedEntry);
                const available = Math.max(0, config.maxEntries - protectedEntries.length);
                return [...protectedEntries, ...ranked
                    .filter(candidate => !candidate.protectedEntry)
                    .slice(0, available)];
            })()
            : ranked.slice(0, config.maxEntries);
        const retainedCollection = Object.fromEntries(retained
            .sort((left, right) => left.order - right.order)
            .map(candidate => [candidate.name, candidate.entry]));

        const parentPath = config.collectionPath.split('.').filter(Boolean);
        let target = logical;
        for (const part of parentPath.slice(0, -1)) target = target[part];
        target[parentPath.at(-1)] = retainedCollection;

        const retentionMeta = Object.fromEntries(retained.map(candidate => [candidate.name, {
            signature: candidate.signature,
            unchangedRuns: candidate.unchangedRuns,
        }]));
        return {
            ...writeLogicalItem(item, logical, jsonField),
            _retention: {
                ...(item?._retention || {}),
                [config.collectionPath]: retentionMeta,
            },
        };
    });
}
