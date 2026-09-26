/**
 * data/normalize.js — pure data shaping. No side effects, no ST imports.
 *
 * Holds the agent/group/mergeVariable default factories and the normalize
 * functions that take whatever shape comes in (legacy save, SillyBunny
 * import, template JSON) and return a canonical InChatAgent / AgentGroup.
 *
 * Split out of VM's monolithic store.js so the storage layer stays focused
 * on CRUD + persistence.
 */

import { normalizeRegexScript } from '../render/regexProcessor.js';
import { normalizeRetentionConfig } from './stateRetention.js';
import { normalizeValidationConfig } from './stateValidation.js';

// ----------------------------------------------------------------------
// Constants
// ----------------------------------------------------------------------

export const DEFAULT_MAX_TOKENS = 8192;

export const AGENT_CATEGORIES = {
    content:    { label: 'Content',    icon: 'fa-film' },
    tracker:    { label: 'Tracker',    icon: 'fa-chart-line' },
    randomizer: { label: 'Randomizer', icon: 'fa-dice' },
    custom:     { label: 'Custom',     icon: 'fa-puzzle-piece' },
};

const VALID_CATEGORIES = Object.keys(AGENT_CATEGORIES);
const VALID_PHASES = ['pre', 'post', 'both'];
const VALID_POST_PROCESS_TYPES = ['regex', 'append', 'extract', 'rewrite'];
const VALID_REWRITE_MODES = ['rewrite', 'append'];

// ----------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------

export function generateId() {
    return crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

function normalizeCategory(category) {
    const v = typeof category === 'string' ? category.trim().toLowerCase() : '';
    return VALID_CATEGORIES.includes(v) ? v : 'custom';
}

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

// ----------------------------------------------------------------------
// Default factories
// ----------------------------------------------------------------------

/** @returns {object} A new agent with all default fields populated. */
export function createDefaultAgent() {
    return {
        id: generateId(),
        name: '',
        description: '',
        icon: '',
        category: 'custom',
        tags: [],
        version: 1,
        author: '',
        prompt: '',
        phase: 'post',
        injection: {
            position: 1,    // IN_CHAT
            depth: 1,
            role: 0,        // SYSTEM
            order: 100,
            scan: false,
            // Wraps the agent's injected output before it enters the main
            // prompt. {{output}} is replaced with the text. Empty = inject raw.
            // Borrowed from Director's <director>\n{{outline}}\n</director> idea:
            // a tag boundary keeps a planner's plan from being read as dialogue.
            template: '',
            // False turns a pre-gen sidecar into a silent classifier: its
            // stored state remains available without injecting the raw result.
            injectResult: true,
        },
        postProcess: {
            enabled: false,
            type: 'regex',
            regexFind: '',
            regexReplace: '',
            regexFlags: 'g',
            appendText: '',
            extractPattern: '',
            extractVariable: '',
            // Prompt transform (rewrite/append mode)
            rewriteEnabled: false,
            rewriteMode: 'rewrite',
            rewriteMaxTokens: DEFAULT_MAX_TOKENS,
        },
        regexScripts: [],
        connectionProfile: '',
        maxTokens: DEFAULT_MAX_TOKENS,
        everyN: 1,
        everyNCadence: 'new-replies',
        reuseSnapshotBetweenRuns: false,
        activationPolicy: {
            mode: 'always',
        },
        scope: {
            mode: 'any',
            characterBindings: [],
            tagBindings: [],
            groupBindings: [],
        },
        enabled: false,
        paused: false,
        conditions: {
            triggerKeywords: [],
            triggerPatterns: [],
            triggerProbability: 100,
            generationTypes: ['normal', 'continue', 'impersonate', 'swipe'],
            generationTypesVersion: 2,
            stateGate: {
                enabled: false,
                variableName: '',
                jsonField: 'json',
                path: '',
                operator: 'eq',
                value: 'true',
                requireFresh: true,
            },
        },
        groupId: null,
        sourceTemplateId: '',
        sourceTemplateVersion: 0,
        sourceTemplateLinked: false,
        mergeVariable: defaultMergeVariable(),
        stateCard: null,
        worldEventsConfig: null,
        phoneConfig: null,
        feedConfig: null,
        afterDarkConfig: null,
        dramaQueenConfig: null,
        sidecarCall: defaultSidecarCall(),
    };
}

/** @returns {object} A new group with default fields. */
export function createDefaultGroup() {
    return {
        id: generateId(),
        name: '',
        description: '',
        icon: '',
        builtin: false,
        agentIds: [],
        executionMode: 'parallel',
        batchMaxTokens: null,
        phase: 'post',
        order: 100,
        enabled: true,
    };
}

function defaultMergeVariable() {
    return {
        enabled: false,
        variableName: '',
        extractPattern: '',
        fieldNames: [],
        keyFields: [],
        mode: 'snapshot',
        resolveField: '',
        resolveAction: 'RESOLVED',
        stripFromResponse: true,
        injectFormatted: true,
        autoInject: true,
        macroName: '',
        formatHeader: '',
        formatItem: '',
        formatEmpty: 'No data tracked.',
        mainContext: {
            enabled: false,
            mode: 'full',
            maxDetailedEntries: 12,
            presencePath: '',
            formatHeader: null,
            formatItem: null,
            formatEmpty: null,
        },
        retention: normalizeRetentionConfig(),
        validation: normalizeValidationConfig(),
    };
}

/**
 * Sanitize a user-entered custom macro suffix (the X in {{sa_X}}). Lowercase;
 * allow only letters, digits, underscore, and dash; drop everything else. Empty
 * string means "no custom macro". Note: SillyTavern's proven macro charset is
 * effectively [a-z0-9_]; dashes are permitted here per user request but may not
 * resolve under ST's macro engine.
 */
function sanitizeMacroName(raw) {
    return String(raw ?? '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, '');
}

function defaultSidecarCall() {
    return {
        enabled: false,
        maxTokens: DEFAULT_MAX_TOKENS,
        responseKey: '',
        includeHistory: false,
        historyMessageCount: 20,
        // Optional wider window for the first run of a persistent tracker.
        // Once the tracker has stored state, historyMessageCount takes over.
        genesisHistoryCount: 0,
        // Optional post-generation gate evaluated against the response that was
        // just generated. Unlike ordinary activation conditions, this runs late
        // enough to see tags emitted by the assistant.
        currentMessagePattern: '',
        // Rich context: the "what the main chat sees" inputs (card, persona,
        // World Info, Summary, Author's Note, the pending user message). All
        // off by default so a plain tracker pays nothing; a Director turns the
        // relevant ones on. See core/richContext.js.
        richContext: defaultRichContext(),
        display: {
            enabled: false,
            position: 'top',
            hookClass: '',
            dataMap: {},
            contentField: '',
            inheritState: true,
        },
    };
}

/** @returns {object} default rich-context flags (mirrors richContext.js). */
function defaultRichContext() {
    return {
        enabled: false,
        character: false,
        persona: false,
        worldInfo: false,
        summary: false,
        simpleSummarizer: false,
        authorsNote: false,
        pendingUser: false,
        historyCount: 0,
        selfMemory: false,
        selfMemoryCount: 0,
    };
}

// ----------------------------------------------------------------------
// Normalize: mergeVariable
// ----------------------------------------------------------------------

export function normalizeMergeVariable(raw) {
    const d = defaultMergeVariable();
    if (!raw || typeof raw !== 'object') return d;
    const mode = raw.mode === 'accumulate' ? 'accumulate' : 'snapshot';
    const fieldNames = Array.isArray(raw.fieldNames)
        ? raw.fieldNames.map(f => String(f ?? '').trim()).filter(Boolean)
        : d.fieldNames;
    const validation = normalizeValidationConfig(raw.validation);

    // A JSON validation field must name an actual stored field. The editor once
    // defaulted this control to "json" even for legacy multi-capture trackers,
    // which made otherwise valid World State items validate against a missing
    // JSON slot. Clear that impossible configuration during normalization.
    if (validation.jsonField && !fieldNames.includes(validation.jsonField)) {
        validation.jsonField = '';
    }

    const mainContextSource = raw.mainContext && typeof raw.mainContext === 'object'
        ? raw.mainContext
        : {};
    return {
        enabled: Boolean(raw.enabled),
        personaScoped: Boolean(raw.personaScoped),
        variableName: typeof raw.variableName === 'string' ? raw.variableName.trim() : d.variableName,
        extractPattern: typeof raw.extractPattern === 'string' ? raw.extractPattern : d.extractPattern,
        fieldNames,
        keyFields: mode === 'snapshot' ? [] : Array.isArray(raw.keyFields)
            ? raw.keyFields.map(f => String(f ?? '').trim()).filter(Boolean)
            : d.keyFields,
        mode,
        resolveField: typeof raw.resolveField === 'string' ? raw.resolveField.trim() : d.resolveField,
        resolveAction: typeof raw.resolveAction === 'string' ? raw.resolveAction.trim() : d.resolveAction,
        stripFromResponse: raw.stripFromResponse !== false,
        injectFormatted: raw.injectFormatted !== false,
        // Auto-inject the formatted state into the MAIN chat prompt each turn.
        // Independent of injectFormatted (which feeds the tracker its own output):
        // turn this off to place the state yourself via the {{sa_…}}/{{agent_…}}
        // macro instead. Defaults on, so existing agents are unchanged.
        autoInject: raw.autoInject !== false,
        // Optional custom macro suffix → registers {{sa_<macroName>}}.
        macroName: sanitizeMacroName(raw.macroName),
        formatHeader: typeof raw.formatHeader === 'string' ? raw.formatHeader : d.formatHeader,
        formatItem: typeof raw.formatItem === 'string' ? raw.formatItem : d.formatItem,
        formatEmpty: typeof raw.formatEmpty === 'string' ? raw.formatEmpty : d.formatEmpty,
        mainContext: {
            enabled: Boolean(mainContextSource.enabled),
            mode: mainContextSource.mode === 'knowledge' ? 'knowledge' : 'full',
            maxDetailedEntries: Math.max(
                1,
                Math.min(24, Number(mainContextSource.maxDetailedEntries) || 12),
            ),
            presencePath: typeof mainContextSource.presencePath === 'string'
                ? mainContextSource.presencePath.trim()
                : '',
            formatHeader: typeof mainContextSource.formatHeader === 'string'
                ? mainContextSource.formatHeader
                : null,
            formatItem: typeof mainContextSource.formatItem === 'string'
                ? mainContextSource.formatItem
                : null,
            formatEmpty: typeof mainContextSource.formatEmpty === 'string'
                ? mainContextSource.formatEmpty
                : null,
        },
        retention: normalizeRetentionConfig(raw.retention),
        validation,
    };
}

// ----------------------------------------------------------------------
// Normalize: sidecarCall
// ----------------------------------------------------------------------

function normalizeSidecarCall(raw) {
    const d = defaultSidecarCall();
    if (!raw || typeof raw !== 'object') return d;

    const rawDisplay = raw.display && typeof raw.display === 'object' ? raw.display : {};

    return {
        enabled: Boolean(raw.enabled),
        maxTokens: Number.isFinite(Number(raw.maxTokens))
            ? clamp(Number(raw.maxTokens), 16, 16000)
            : d.maxTokens,
        responseKey: typeof raw.responseKey === 'string' ? raw.responseKey.trim() : d.responseKey,
        includeHistory: Boolean(raw.includeHistory),
        historyMessageCount: Number.isFinite(Number(raw.historyMessageCount))
            ? clamp(Number(raw.historyMessageCount), 1, 100)
            : d.historyMessageCount,
        genesisHistoryCount: Number.isFinite(Number(raw.genesisHistoryCount))
            ? clamp(Number(raw.genesisHistoryCount), 0, 100)
            : d.genesisHistoryCount,
        currentMessagePattern: typeof raw.currentMessagePattern === 'string'
            ? raw.currentMessagePattern.trim()
            : d.currentMessagePattern,
        richContext: normalizeRichContext(raw.richContext),
        display: {
            enabled: Boolean(rawDisplay.enabled),
            position: rawDisplay.position === 'bottom' ? 'bottom' : 'top',
            hookClass: typeof rawDisplay.hookClass === 'string' ? rawDisplay.hookClass.trim() : '',
            dataMap: rawDisplay.dataMap && typeof rawDisplay.dataMap === 'object'
                ? { ...rawDisplay.dataMap }
                : {},
            contentField: typeof rawDisplay.contentField === 'string'
                ? rawDisplay.contentField.trim()
                : '',
            inheritState: rawDisplay.inheritState !== false,
        },
    };
}

// ----------------------------------------------------------------------
// Normalize: richContext
// ----------------------------------------------------------------------

function normalizeRichContext(raw) {
    const d = defaultRichContext();
    if (!raw || typeof raw !== 'object') return d;
    return {
        enabled: Boolean(raw.enabled),
        character: Boolean(raw.character),
        persona: Boolean(raw.persona),
        worldInfo: Boolean(raw.worldInfo),
        summary: Boolean(raw.summary),
        simpleSummarizer: Boolean(raw.simpleSummarizer),
        authorsNote: Boolean(raw.authorsNote),
        pendingUser: Boolean(raw.pendingUser),
        historyCount: Number.isFinite(Number(raw.historyCount))
            ? clamp(Number(raw.historyCount), 0, 100)
            : d.historyCount,
        selfMemory: Boolean(raw.selfMemory),
        selfMemoryCount: Number.isFinite(Number(raw.selfMemoryCount))
            ? clamp(Number(raw.selfMemoryCount), 0, 20)
            : d.selfMemoryCount,
    };
}

// ----------------------------------------------------------------------
// Normalize: postProcess
// ----------------------------------------------------------------------

function normalizePostProcess(raw) {
    const d = createDefaultAgent().postProcess;
    if (!raw || typeof raw !== 'object') return d;

    // SillyBunny compat: their field names → ours
    const rewriteEnabled = raw.rewriteEnabled ?? raw.promptTransformEnabled;
    const rawRewriteMode = raw.rewriteMode ?? raw.promptTransformMode;
    const rawRewriteMaxTokens = raw.rewriteMaxTokens ?? raw.promptTransformMaxTokens;

    return {
        ...d,
        ...raw,
        enabled: Boolean(raw.enabled),
        type: VALID_POST_PROCESS_TYPES.includes(String(raw.type)) ? String(raw.type) : d.type,
        rewriteEnabled: Boolean(rewriteEnabled),
        rewriteMode: VALID_REWRITE_MODES.includes(String(rawRewriteMode))
            ? String(rawRewriteMode)
            : d.rewriteMode,
        rewriteMaxTokens: Number.isFinite(Number(rawRewriteMaxTokens))
            ? clamp(Number(rawRewriteMaxTokens), 16, 16000)
            : d.rewriteMaxTokens,
    };
}

// ----------------------------------------------------------------------
// Normalize: conditions
// ----------------------------------------------------------------------

function normalizeConditions(raw) {
    const d = createDefaultAgent().conditions;
    if (!raw || typeof raw !== 'object') return d;

    const generationTypes = Array.isArray(raw.generationTypes)
        ? raw.generationTypes.map(t => String(t ?? '').trim()).filter(Boolean)
        : [...d.generationTypes];

    // Before Swipe was its own option, ST's swipe/regenerate events were
    // treated as "normal". Preserve that behavior once for existing agents,
    // then let the editor's explicit checkbox remain authoritative.
    const generationTypesVersion = Number(raw.generationTypesVersion) || 1;
    if (generationTypesVersion < 2
        && generationTypes.includes('normal')
        && !generationTypes.includes('swipe')) {
        generationTypes.push('swipe');
    }

    const stateGate = raw.stateGate && typeof raw.stateGate === 'object'
        ? raw.stateGate
        : {};
    const stateGateOperators = new Set(['eq', 'neq', 'exists', 'not_exists', 'contains']);

    return {
        ...d,
        ...raw,
        triggerKeywords: Array.isArray(raw.triggerKeywords)
            ? raw.triggerKeywords.map(k => String(k ?? '').trim()).filter(Boolean)
            : d.triggerKeywords,
        triggerPatterns: Array.isArray(raw.triggerPatterns)
            ? raw.triggerPatterns.map(p => String(p ?? '').trim()).filter(Boolean)
            : d.triggerPatterns,
        triggerProbability: Number.isFinite(Number(raw.triggerProbability))
            ? clamp(Number(raw.triggerProbability), 0, 100)
            : d.triggerProbability,
        generationTypes,
        generationTypesVersion: 2,
        stateGate: {
            enabled: Boolean(stateGate.enabled),
            variableName: typeof stateGate.variableName === 'string'
                ? stateGate.variableName.trim()
                : '',
            jsonField: typeof stateGate.jsonField === 'string'
                ? stateGate.jsonField.trim()
                : 'json',
            path: typeof stateGate.path === 'string' ? stateGate.path.trim() : '',
            operator: stateGateOperators.has(stateGate.operator) ? stateGate.operator : 'eq',
            value: typeof stateGate.value === 'string'
                ? stateGate.value
                : JSON.stringify(stateGate.value ?? true),
            requireFresh: stateGate.requireFresh !== false,
        },
    };
}

function normalizeEveryN(raw, fallback = 1) {
    const value = Number(raw);
    return Number.isFinite(value) && value > 0
        ? clamp(Math.floor(value), 1, 100000)
        : fallback;
}

function normalizeContinuityGuard(raw) {
    if (!raw || typeof raw !== 'object') return null;
    return {
        ...raw,
        enabled: Boolean(raw.enabled),
        everyN: normalizeEveryN(raw.everyN, 5),
        requiresStateCard: raw.requiresStateCard !== false,
        detectVariable: typeof raw.detectVariable === 'string'
            ? raw.detectVariable.trim()
            : 'sa_state_card',
        repairContextVariable: typeof raw.repairContextVariable === 'string'
            ? raw.repairContextVariable.trim()
            : 'sa_narrative_engine',
    };
}

function normalizeScope(raw) {
    const modes = new Set(['any', 'character', 'tag', 'group']);
    const cleanList = value => Array.isArray(value)
        ? [...new Set(value.map(entry => String(entry ?? '').trim()).filter(Boolean))]
        : [];
    return {
        mode: modes.has(raw?.mode) ? raw.mode : 'any',
        characterBindings: cleanList(raw?.characterBindings),
        tagBindings: cleanList(raw?.tagBindings),
        groupBindings: cleanList(raw?.groupBindings),
    };
}

function normalizeActivationPolicy(raw) {
    const modes = new Set(['always', 'manual', 'until-state', 'once-per-chat', 'once-per-branch']);
    return {
        mode: modes.has(raw?.mode) ? raw.mode : 'always',
    };
}

// ----------------------------------------------------------------------
// Normalize: agent (top level)
// ----------------------------------------------------------------------

/**
 * @param {object} raw
 * @returns {object} A canonical agent. Always has every field.
 */
export function normalizeAgent(raw = {}) {
    const d = createDefaultAgent();

    // Normalize the two config objects that carry the mutually-exclusive
    // "feed the agent its own output" toggles, so the guard below can see both.
    const mergeVariable = normalizeMergeVariable(raw.mergeVariable);
    const sidecarCall = normalizeSidecarCall(raw.sidecarCall);
    const postProcess = normalizePostProcess(raw.postProcess);
    const continuityGuard = normalizeContinuityGuard(raw.continuityGuard);

    // The lifecycle routes sidecars first and returns before rewrite handling.
    // Persist the route users will actually get instead of allowing a checked
    // rewrite control that can never run.
    if (sidecarCall.enabled && postProcess.rewriteEnabled) {
        postProcess.rewriteEnabled = false;
    }

    // ── Mutual exclusion: carry-output feedback vs self-memory ──
    // Both read the SAME per-swipe history of this agent's output. Carry-output
    // (mergeVariable.injectFormatted) injects the CURRENT stored value;
    // self-memory (richContext.selfMemory) injects a list of recent outputs
    // whose NEWEST entry IS that same current value. With both on, the latest
    // output is fed twice. There is no legitimate case for that, so they are
    // mutually exclusive. Carry-output wins (it's the simpler, more common
    // tracker feed that structured templates rely on); self-memory is forced
    // off. This is the authoritative backstop — it catches template JSON,
    // SillyBunny imports, and hand-edited saves regardless of the editor UI.
    const carryOutputActive = mergeVariable.enabled
        && mergeVariable.injectFormatted
        && !!mergeVariable.variableName;
    if (carryOutputActive && sidecarCall.richContext.selfMemory) {
        sidecarCall.richContext.selfMemory = false;
    }

    return {
        id: typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : d.id,
        name: typeof raw.name === 'string' ? raw.name : d.name,
        description: typeof raw.description === 'string' ? raw.description : d.description,
        icon: typeof raw.icon === 'string' ? raw.icon : d.icon,
        category: normalizeCategory(raw.category),
        tags: Array.isArray(raw.tags)
            ? raw.tags.map(t => String(t ?? '').trim()).filter(Boolean)
            : d.tags,
        version: Number.isFinite(Number(raw.version)) ? Number(raw.version) : d.version,
        author: typeof raw.author === 'string' ? raw.author : d.author,
        prompt: typeof raw.prompt === 'string' ? raw.prompt : d.prompt,
        phase: VALID_PHASES.includes(raw.phase) ? raw.phase : d.phase,
        injection: {
            ...d.injection,
            ...(raw.injection ?? {}),
            injectResult: raw.injection?.injectResult !== false,
        },
        postProcess,
        regexScripts: Array.isArray(raw.regexScripts)
            ? raw.regexScripts.map(s => normalizeRegexScript(s ?? {}))
            : d.regexScripts,
        connectionProfile: typeof raw.connectionProfile === 'string'
            ? raw.connectionProfile
            : d.connectionProfile,
        maxTokens: Number.isFinite(Number(raw.maxTokens)) ? Number(raw.maxTokens) : d.maxTokens,
        everyN: normalizeEveryN(raw.everyN, continuityGuard?.everyN ?? d.everyN),
        everyNCadence: raw.everyNCadence === 'all-attempts' ? 'all-attempts' : 'new-replies',
        reuseSnapshotBetweenRuns: raw.reuseSnapshotBetweenRuns === true,
        activationPolicy: normalizeActivationPolicy(raw.activationPolicy),
        scope: normalizeScope(raw.scope),
        enabled: Boolean(raw.enabled),
        paused: Boolean(raw.paused),
        conditions: normalizeConditions(raw.conditions),
        groupId: typeof raw.groupId === 'string' ? raw.groupId : null,
        sourceTemplateId: typeof raw.sourceTemplateId === 'string'
            ? raw.sourceTemplateId
            : d.sourceTemplateId,
        sourceTemplateVersion: Number.isFinite(Number(raw.sourceTemplateVersion))
            ? Number(raw.sourceTemplateVersion)
            : 0,
        // Existing saves predate this flag. A stamped template source was
        // historically always linked until the user explicitly detaches it.
        sourceTemplateLinked: Boolean(raw.sourceTemplateId)
            && raw.sourceTemplateLinked !== false,
        mergeVariable,
        stateCard: raw.stateCard && typeof raw.stateCard === 'object' ? raw.stateCard : null,
        worldEventsConfig: raw.worldEventsConfig && typeof raw.worldEventsConfig === 'object'
            ? {
                ...raw.worldEventsConfig,
                enabled: raw.worldEventsConfig.enabled !== false,
                maxRoster: Math.floor(clamp(Number(raw.worldEventsConfig.maxRoster) || 8, 1, 8)),
            }
            : null,
        phoneConfig: raw.phoneConfig && typeof raw.phoneConfig === 'object' ? raw.phoneConfig : null,
        feedConfig: raw.feedConfig && typeof raw.feedConfig === 'object' ? raw.feedConfig : null,
        afterDarkConfig: raw.afterDarkConfig && typeof raw.afterDarkConfig === 'object'
            ? {
                enabled: raw.afterDarkConfig.enabled !== false,
                probeTerms: Array.isArray(raw.afterDarkConfig.probeTerms)
                    ? raw.afterDarkConfig.probeTerms.map(value => String(value || '').trim()).filter(Boolean).slice(0, 20)
                    : [],
                pitchCount: Math.max(4, Math.min(6, Math.floor(Number(raw.afterDarkConfig.pitchCount) || 4))),
                showBeatController: raw.afterDarkConfig.showBeatController !== false,
                smartNudge: raw.afterDarkConfig.smartNudge === true,
            }
            : null,
        dramaQueenConfig: raw.dramaQueenConfig && typeof raw.dramaQueenConfig === 'object'
            ? {
                enabled: raw.dramaQueenConfig.enabled === true,
                probeTerms: Array.isArray(raw.dramaQueenConfig.probeTerms)
                    ? raw.dramaQueenConfig.probeTerms.map(value => String(value || '').trim()).filter(Boolean).slice(0, 20)
                    : [],
                proposalCount: Math.max(1, Math.min(6, Math.floor(Number(raw.dramaQueenConfig.proposalCount) || 4))),
                showBeatController: raw.dramaQueenConfig.showBeatController !== false,
                smartNudge: raw.dramaQueenConfig.smartNudge === true,
            }
            : null,
        continuityGuard,
        sidecarCall,
    };
}

// ----------------------------------------------------------------------
// Normalize: group
// ----------------------------------------------------------------------

export function normalizeGroup(raw = {}) {
    const d = createDefaultGroup();
    return {
        id: typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : d.id,
        name: String(raw.name ?? '').trim(),
        description: String(raw.description ?? '').trim(),
        icon: typeof raw.icon === 'string' ? raw.icon.trim() : d.icon,
        builtin: Boolean(raw.builtin),
        agentIds: Array.isArray(raw.agentIds)
            ? raw.agentIds.map(id => String(id ?? '').trim()).filter(Boolean)
            : d.agentIds,
        executionMode: raw.executionMode === 'sequential' ? 'sequential' : 'parallel',
        batchMaxTokens: Number.isFinite(Number(raw.batchMaxTokens)) && Number(raw.batchMaxTokens) > 0
            ? clamp(Math.floor(Number(raw.batchMaxTokens)), 256, 1000000)
            : d.batchMaxTokens,
        phase: ['pre', 'post'].includes(raw.phase) ? raw.phase : d.phase,
        order: Number.isFinite(Number(raw.order)) ? Number(raw.order) : d.order,
        enabled: raw.enabled !== false,
    };
}
