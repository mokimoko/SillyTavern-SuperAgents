/** Curated usage defaults for agents instantiated from the built-in Library. */

const STANDARD_OVERRIDES = Object.freeze({
    'tpl-actor-interview': { everyN: 5 },
    'tpl-character-diary': { everyN: 10, triggerProbability: 50 },
    'tpl-continuity-guard': { everyN: 5 },
    'tpl-knowledge-ledger': { everyN: 5 },
    'tpl-parallel-offscreen': { everyN: 1 },
    'tpl-social-web-ledger': { everyN: 5 },
});

const ECONOMY_OVERRIDES = Object.freeze({
    'tpl-actor-interview': { everyN: 10 },
    'tpl-art-prompt-generator': { everyN: 4 },
    'tpl-character-diary': { everyN: 20, triggerProbability: 75 },
    'tpl-commentary-section': { everyN: 3 },
    'tpl-continuity-check': { everyN: 5 },
    'tpl-director': { everyN: 2 },
    'tpl-knowledge-ledger': { everyN: 3 },
    'tpl-narrative-engine': { everyN: 2 },
    'tpl-parallel-offscreen': { everyN: 2, historyMessageCount: 8 },
    'tpl-phone-messenger': { everyN: 3 },
    'tpl-prompt-nsfw': { everyN: 2 },
    'tpl-prompt-profile': { everyN: 2 },
    'tpl-prose-guardian': { everyN: 2 },
    'tpl-prose-polisher': { everyN: 2 },
    'tpl-relationship-ledger': { everyN: 2 },
    'tpl-social-feed': { everyN: 3 },
    'tpl-social-web-ledger': { everyN: 6, historyMessageCount: 12 },
    'tpl-soundtrack-suggester': { everyN: 5 },
    'tpl-state-card': { everyN: 2 },
    'tpl-world-state': { everyN: 2 },
});

function templateId(template) {
    return String(template?.id || template?.sourceTemplateId || '').trim();
}

function positiveInteger(value, fallback = 1) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function boundedProbability(value) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(0, Math.min(100, number)) : undefined;
}

/**
 * Return only the fields owned by the Library usage preset. Prompt, model,
 * token ceilings, and other authored/user settings are excluded.
 */
export function getLibraryUsageSettings(template, economyMode = false) {
    const id = templateId(template);
    const standard = STANDARD_OVERRIDES[id] || {};
    const economy = economyMode ? (ECONOMY_OVERRIDES[id] || {}) : {};
    const everyN = positiveInteger(economy.everyN ?? standard.everyN ?? template?.everyN, 1);
    const hasRememberedSnapshot = Boolean(
        template?.mergeVariable?.enabled && String(template.mergeVariable.variableName || '').trim(),
    );
    const configuredHistory = economy.historyMessageCount
        ?? standard.historyMessageCount
        ?? template?.sidecarCall?.historyMessageCount;
    // Most agents leave probability entirely user-owned. A template may opt
    // into a curated probability when its Standard/Economy cadence is designed
    // as a combined interval + chance pair.
    const triggerProbability = boundedProbability(
        economy.triggerProbability ?? standard.triggerProbability,
    );

    return {
        everyN,
        everyNCadence: 'new-replies',
        reuseSnapshotBetweenRuns: everyN > 1 && hasRememberedSnapshot,
        ...(triggerProbability !== undefined ? { triggerProbability } : {}),
        ...(configuredHistory !== undefined
            ? { historyMessageCount: positiveInteger(configuredHistory, 20) }
            : {}),
    };
}

/** Return a cloned template/agent with the selected Library usage preset. */
export function applyLibraryUsageSettings(value, template, economyMode = false) {
    const settings = getLibraryUsageSettings(template, economyMode);
    const result = {
        ...value,
        everyN: settings.everyN,
        everyNCadence: settings.everyNCadence,
        reuseSnapshotBetweenRuns: settings.reuseSnapshotBetweenRuns,
        ...(settings.triggerProbability !== undefined
            ? {
                conditions: {
                    ...(value?.conditions || {}),
                    triggerProbability: settings.triggerProbability,
                },
            }
            : {}),
    };

    if (settings.historyMessageCount !== undefined && value?.sidecarCall) {
        result.sidecarCall = {
            ...value.sidecarCall,
            historyMessageCount: settings.historyMessageCount,
        };
    }
    return result;
}

export const LIBRARY_USAGE_LABELS = Object.freeze({
    standard: 'Standard',
    economy: 'Economy',
});
