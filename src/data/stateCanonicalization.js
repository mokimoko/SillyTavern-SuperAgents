/** Conservative, opt-in cleanup for model-authored tracker state. */

const AFTER_DARK_STAGES = Object.freeze([
    'Set the Trap',
    'Cross the Line',
    'Sex Is Underway',
    'Turn It Up',
    'What Now?',
]);
const AFTER_DARK_STRENGTHS = new Set(['opening', 'pursuit', 'pressure', 'commitment']);
const AFTER_DARK_KINK_SOURCES = new Set([
    'established',
    'canon-supported',
    'character-fit',
    'wildcard',
]);

export const DRAMA_QUEEN_BEATS = Object.freeze([
    'Expose the Fault Line',
    'Test the Boundary',
    'Remove the Easy Exit',
    'Force a Choice',
    'Make It Cost Something',
    'Live With the Change',
]);
const DRAMA_QUEEN_INTENTS = new Set(['find-fault-lines', 'stir-the-pot', 'make-it-worse', 'let-it-haunt-them']);
const DRAMA_QUEEN_PRESSURES = new Set(['simmer', 'press', 'corner', 'break']);
const DRAMA_QUEEN_DAMAGE_CEILINGS = new Set(['sting', 'strain', 'rupture', 'catastrophe']);
const DRAMA_QUEEN_CATALYST_SOURCES = new Set(['established', 'inferred', 'new-catalyst', 'user-note']);

const WORLD_FIELDS = ['time', 'timeOfDay', 'weather', 'temperature', 'setting'];
const TIME_OF_DAY = [
    'Dawn', 'Morning', 'Afternoon', 'Twilight', 'Evening', 'Night', 'Late Night', 'Unknown',
];
const WEATHER = [
    'Clear', 'Sunny', 'Partly Cloudy', 'Overcast', 'Cloudy', 'Light Rain', 'Rain', 'Drizzle',
    'Heavy Rain', 'Downpour', 'Thunderstorm', 'Storm', 'Snow', 'Light Snow', 'Heavy Snow',
    'Blizzard', 'Fog', 'Mist', 'Haze', 'Windy', 'Breezy', 'Clear Night', 'Moonlit Night',
    'Starry', 'Hail', 'Sleet', 'Unknown',
];
const TEMPERATURE = ['Freezing', 'Cold', 'Cool', 'Mild', 'Warm', 'Hot', 'Scorching', 'Unknown'];
const SETTING = ['Indoors', 'Outdoors', 'Vehicle', 'Mixed', 'Unknown'];

function clean(value, max = 1200) {
    return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function cleanList(value, maxItems = 8, maxLength = 100) {
    return Array.isArray(value)
        ? value.map(item => clean(item, maxLength)).filter(Boolean).slice(0, maxItems)
        : [];
}

function normalizedToken(value) {
    return clean(value, 100).toLowerCase().replace(/[\s_]+/g, '-');
}

function normalizeStrength(value) {
    const token = normalizedToken(value);
    if (AFTER_DARK_STRENGTHS.has(token)) return token;
    if (['opening-only', 'opportunity', 'invitation'].includes(token)) return 'opening';
    if (['make-a-move', 'initiate', 'initiative'].includes(token)) return 'pursuit';
    if (['turn-it-up', 'escalate', 'escalation'].includes(token)) return 'pressure';
    if (['go-for-it', 'committed', 'explicit'].includes(token)) return 'commitment';
    return 'pursuit';
}

function normalizeKinkSource(value) {
    const token = normalizedToken(value);
    if (AFTER_DARK_KINK_SOURCES.has(token)) return token;
    if (['canon', 'canonical', 'canon-fit'].includes(token)) return 'canon-supported';
    if (['character', 'character-inference', 'personality-fit', 'inferred'].includes(token)) {
        return 'character-fit';
    }
    if (['explicit', 'lore', 'lore-established'].includes(token)) return 'established';
    return 'wildcard';
}

function normalizeDramaToken(value, allowed, fallback, aliases = {}) {
    const token = normalizedToken(value);
    return allowed.has(token) ? token : (aliases[token] || fallback);
}

function normalizeDramaQueenProposal(value, index) {
    if (!value || typeof value !== 'object') return null;
    const title = clean(value.title, 100);
    const faultLine = clean(value.faultLine ?? value.fault_line ?? value.conflict, 800);
    if (!title || !faultLine) return null;
    const rawStages = value.stages ?? value.beats ?? value.arc;
    const stages = Array.isArray(rawStages)
        ? rawStages.map((stage, stageIndex) => ({
            label: DRAMA_QUEEN_BEATS[stageIndex],
            direction: clean(stage?.direction ?? stage?.instruction ?? stage?.description ?? stage?.summary, 900),
        })).filter(stage => stage.direction).slice(0, DRAMA_QUEEN_BEATS.length)
        : [];
    const catalystSource = normalizeDramaToken(
        value.catalyst?.provenance,
        DRAMA_QUEEN_CATALYST_SOURCES,
        'established',
        { canon: 'established', canonical: 'established', new: 'new-catalyst', invented: 'new-catalyst' },
    );
    return {
        id: clean(value.id, 60) || `engine-${index + 1}`,
        title,
        cast: cleanList(value.cast ?? value.participants, 8, 100),
        intent: normalizeDramaToken(value.intent ?? value.mode, DRAMA_QUEEN_INTENTS, 'stir-the-pot', {
            faultlines: 'find-fault-lines',
            'fault-lines': 'find-fault-lines',
            stir: 'stir-the-pot',
            worsen: 'make-it-worse',
            haunt: 'let-it-haunt-them',
        }),
        faultLine,
        incompatibleAgendas: cleanList(value.incompatibleAgendas ?? value.incompatible_agendas ?? value.agendas, 8, 400),
        refusal: clean(value.refusal ?? value.boundary, 600),
        leverage: clean(value.leverage, 600),
        stakes: clean(value.stakes, 700),
        catalyst: {
            event: clean(value.catalyst?.event ?? value.catalyst?.summary, 700),
            provenance: catalystSource,
            basis: clean(value.catalyst?.basis, 500),
        },
        easyExit: clean(value.easyExit ?? value.easy_exit, 600),
        consequences: cleanList(value.consequences, 8, 500),
        stages,
        guardrails: cleanList(value.guardrails, 8, 300),
    };
}

export function normalizeDramaQueenState(value) {
    const source = value && typeof value === 'object' ? value : {};
    const proposals = Array.isArray(source.proposals)
        ? source.proposals.map(normalizeDramaQueenProposal).filter(Boolean).slice(0, 6)
        : [];
    const rawActive = source.active && typeof source.active === 'object' ? source.active : null;
    const proposalIndex = Math.max(0, Math.floor(Number(rawActive?.proposalIndex) || 0));
    const selected = proposals[proposalIndex];
    return {
        version: 1,
        sceneRead: clean(source.sceneRead, 1000),
        proposals,
        active: rawActive && selected ? {
            proposalIndex,
            beatIndex: Math.max(0, Math.min(
                Math.max(0, selected.stages.length - 1),
                Math.floor(Number(rawActive?.beatIndex) || 0),
            )),
            pressure: normalizeDramaToken(rawActive?.pressure, DRAMA_QUEEN_PRESSURES, 'simmer'),
            damageCeiling: normalizeDramaToken(rawActive?.damageCeiling, DRAMA_QUEEN_DAMAGE_CEILINGS, 'strain'),
            activatedAtMessage: Math.max(0, Math.floor(Number(rawActive?.activatedAtMessage) || 0)),
        } : null,
    };
}

function normalizeAfterDarkPitch(value, index) {
    if (!value || typeof value !== 'object') return null;
    const title = clean(value.title, 100);
    const setup = clean(value.setup, 900);
    if (!title || !setup) return null;
    const stages = Array.isArray(value.stages)
        ? value.stages.map((stage, stageIndex) => ({
            label: AFTER_DARK_STAGES[stageIndex] || clean(stage?.label, 60) || `Beat ${stageIndex + 1}`,
            direction: clean(stage?.direction, 900),
        })).filter(stage => stage.direction).slice(0, 5)
        : [];
    return {
        id: clean(value.id, 60) || `pitch-${index + 1}`,
        title,
        cast: cleanList(value.cast, 8, 100),
        flavor: clean(value.flavor, 60) || 'Just horny',
        heat: normalizeStrength(value.heat),
        pace: clean(value.pace, 40) || 'quick',
        setup,
        dynamic: clean(value.dynamic, 700),
        kink: {
            idea: clean(value.kink?.idea, 300),
            source: normalizeKinkSource(value.kink?.source),
            reason: clean(value.kink?.reason, 500),
        },
        why: clean(value.why, 700),
        stages,
        guardrails: cleanList(value.guardrails, 8, 260),
    };
}

export function normalizeAfterDarkState(value) {
    const source = value && typeof value === 'object' ? value : {};
    const pitches = Array.isArray(source.pitches)
        ? source.pitches.map(normalizeAfterDarkPitch).filter(Boolean).slice(0, 6)
        : [];
    const rawActive = source.active && typeof source.active === 'object' ? source.active : null;
    const pitchIndex = Math.max(0, Math.floor(Number(rawActive?.pitchIndex) || 0));
    const selected = pitches[pitchIndex];
    return {
        version: 1,
        sceneRead: clean(source.sceneRead, 1000),
        pitches,
        active: rawActive && selected ? {
            pitchIndex,
            stageIndex: Math.max(
                0,
                Math.min(selected.stages.length - 1, Math.floor(Number(rawActive?.stageIndex) || 0)),
            ),
            strength: normalizeStrength(rawActive?.strength || selected.heat),
            activatedAtMessage: Math.max(0, Math.floor(Number(rawActive?.activatedAtMessage) || 0)),
        } : null,
    };
}

function removeTrailingCommas(source) {
    let output = '';
    let inString = false;
    let escaped = false;
    for (let index = 0; index < source.length; index++) {
        const char = source[index];
        if (inString) {
            output += char;
            if (escaped) escaped = false;
            else if (char === '\\') escaped = true;
            else if (char === '"') inString = false;
            continue;
        }
        if (char === '"') {
            inString = true;
            output += char;
            continue;
        }
        if (char === ',') {
            let lookahead = index + 1;
            while (/\s/.test(source[lookahead] || '')) lookahead++;
            if (source[lookahead] === ']' || source[lookahead] === '}') continue;
        }
        output += char;
    }
    return output;
}

/** Drop only closing delimiters that are impossible for the current nesting. */
function removeMismatchedJsonClosers(source) {
    const stack = [];
    let output = '';
    let inString = false;
    let escaped = false;
    for (const char of source) {
        if (inString) {
            output += char;
            if (escaped) escaped = false;
            else if (char === '\\') escaped = true;
            else if (char === '"') inString = false;
            continue;
        }
        if (char === '"') {
            inString = true;
            output += char;
            continue;
        }
        if (char === '{' || char === '[') {
            stack.push(char);
            output += char;
            continue;
        }
        if (char === '}' || char === ']') {
            const expected = char === '}' ? '{' : '[';
            if (stack.at(-1) !== expected) continue;
            stack.pop();
        }
        output += char;
    }
    if (!inString) {
        while (stack.length) output += stack.pop() === '{' ? '}' : ']';
    }
    return output;
}

function parseRepairableJson(value) {
    const source = String(value ?? '').trim();
    if (!source) return null;
    const candidates = [
        source,
        removeTrailingCommas(removeMismatchedJsonClosers(source)),
    ];
    for (const candidate of [...new Set(candidates)]) {
        try {
            return JSON.parse(candidate);
        } catch { /* Try the next conservative form. */ }
    }
    return null;
}

function canonicalizeRelationshipLedgerItem(item, rawConfig) {
    const jsonField = String(rawConfig?.jsonField || 'json');
    let ledger;
    try {
        ledger = JSON.parse(item[jsonField]);
    } catch {
        return { ...item };
    }
    const maxEvents = rawConfig?.schema?.properties?.personas?.additionalProperties
        ?.properties?.characters?.additionalProperties?.properties?.significantEvents?.maxItems;
    if (!Number.isInteger(maxEvents) || maxEvents < 1) return { ...item };

    let changed = false;
    for (const persona of Object.values(ledger?.personas || {})) {
        for (const character of Object.values(persona?.characters || {})) {
            if (!Array.isArray(character?.significantEvents)
                || character.significantEvents.length <= maxEvents) continue;
            // Events are chronological. Keep the latest when the model appends
            // beyond the schema cap; milestones retain durable canon separately.
            character.significantEvents = character.significantEvents.slice(-maxEvents);
            changed = true;
        }
    }
    return changed ? { ...item, [jsonField]: JSON.stringify(ledger) } : { ...item };
}

function enumValue(value, allowed, aliases = {}) {
    const source = clean(value, 100);
    if (!source) return null;
    const exact = allowed.find(item => item.toLowerCase() === source.toLowerCase());
    if (exact) return exact;
    return aliases[normalizedToken(source)] || null;
}

function timeValue(value) {
    const source = clean(value, 40).toUpperCase().replace(/\s+/g, ' ');
    let match = /^(\d{1,2}):([0-5]\d)\s*([AP]M)$/.exec(source);
    if (match) {
        const hour = Number(match[1]);
        return hour >= 1 && hour <= 12
            ? `${String(hour).padStart(2, '0')}:${match[2]} ${match[3]}`
            : null;
    }
    match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(source);
    if (match) {
        const hour = Number(match[1]);
        const suffix = hour >= 12 ? 'PM' : 'AM';
        const twelveHour = hour % 12 || 12;
        return `${String(twelveHour).padStart(2, '0')}:${match[2]} ${suffix}`;
    }
    return source === 'UNKNOWN' ? 'Unknown' : null;
}

function timeOfDayValue(value) {
    return enumValue(value, TIME_OF_DAY, {
        dusk: 'Twilight',
        sunrise: 'Dawn',
        midday: 'Afternoon',
        noon: 'Afternoon',
        midnight: 'Late Night',
        overnight: 'Late Night',
    });
}

function weatherValue(value) {
    const source = clean(value, 100);
    if (/\b(indoors?|climate[- ]?controlled|inside)\b/i.test(source)) return null;
    return enumValue(source, WEATHER, {
        rainy: 'Rain',
        'light-rainy': 'Light Rain',
        pouring: 'Downpour',
        'partly-cloudy-skies': 'Partly Cloudy',
        'clear-skies': 'Clear',
        'clear-sky': 'Clear',
        snowy: 'Snow',
        foggy: 'Fog',
        misty: 'Mist',
    });
}

function temperatureValue(value) {
    return enumValue(value, TEMPERATURE, {
        'room-temperature': 'Mild',
        temperate: 'Mild',
        chilly: 'Cool',
        'very-cold': 'Freezing',
        'very-hot': 'Scorching',
    });
}

function settingValue(value) {
    return enumValue(value, SETTING, {
        indoor: 'Indoors',
        inside: 'Indoors',
        outdoor: 'Outdoors',
        outside: 'Outdoors',
        'in-transit': 'Vehicle',
        transit: 'Vehicle',
        traveling: 'Vehicle',
    });
}

const WORLD_RECOGNIZERS = {
    time: timeValue,
    timeOfDay: timeOfDayValue,
    weather: weatherValue,
    temperature: temperatureValue,
    setting: settingValue,
};

function looksLikeDate(value) {
    const source = clean(value, 120);
    return /^\d{4}-\d{1,2}-\d{1,2}$/.test(source)
        || /^(?:\d{1,2}\s+)?(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)(?:\s+\d{1,2})?(?:,?\s+\d{2,4})?$/i.test(source);
}

export function canonicalizeWorldStateItem(value) {
    const source = value && typeof value === 'object' ? value : {};
    let location = clean(source.location, 160) || 'Unknown';
    let date = clean(source.date, 120) || 'Unknown';
    if (looksLikeDate(location) && date !== 'Unknown' && !looksLikeDate(date)) {
        [location, date] = [date, location];
    }

    const originals = WORLD_FIELDS.map(field => clean(source[field], 100));
    const resolved = {};
    const used = new Set();

    // Keep values already in the correct field before considering misplaced facts.
    WORLD_FIELDS.forEach((field, index) => {
        const recognized = WORLD_RECOGNIZERS[field](originals[index]);
        if (!recognized) return;
        resolved[field] = recognized;
        used.add(index);
    });

    WORLD_FIELDS.forEach((field) => {
        if (resolved[field]) return;
        const candidates = originals
            .map((candidate, index) => ({ index, value: WORLD_RECOGNIZERS[field](candidate) }))
            .filter(candidate => candidate.value && candidate.value !== 'Unknown' && !used.has(candidate.index));
        if (candidates.length === 1) {
            resolved[field] = candidates[0].value;
            used.add(candidates[0].index);
        } else {
            resolved[field] = 'Unknown';
        }
    });

    return {
        ...source,
        location,
        date,
        ...resolved,
    };
}

/** Canonicalize only trackers that explicitly opt in through validation config. */
export function canonicalizeMergeItems(items, rawConfig) {
    if (!Array.isArray(items)) return items;
    const canonicalizer = String(rawConfig?.canonicalizer || '').trim().toLowerCase();
    if (!canonicalizer) return items;

    return items.map((item) => {
        if (!item || typeof item !== 'object') return item;
        if (canonicalizer === 'after-dark') {
            const jsonField = String(rawConfig?.jsonField || 'json');
            const parsed = parseRepairableJson(item[jsonField]);
            if (!parsed) return { ...item };
            return { ...item, [jsonField]: JSON.stringify(normalizeAfterDarkState(parsed)) };
        }
        if (canonicalizer === 'drama-queen') {
            const jsonField = String(rawConfig?.jsonField || 'json');
            const parsed = parseRepairableJson(item[jsonField]);
            if (!parsed) return { ...item };
            return { ...item, [jsonField]: JSON.stringify(normalizeDramaQueenState(parsed)) };
        }
        if (canonicalizer === 'world-state') return canonicalizeWorldStateItem(item);
        if (canonicalizer === 'relationship-ledger') {
            return canonicalizeRelationshipLedgerItem(item, rawConfig);
        }
        return { ...item };
    });
}
