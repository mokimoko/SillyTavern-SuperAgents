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
        enabled: false,
        conditions: {
            triggerKeywords: [],
            triggerPatterns: [],
            triggerProbability: 100,
            generationTypes: ['normal', 'continue', 'impersonate'],
        },
        groupId: null,
        sourceTemplateId: '',
        sourceTemplateVersion: 0,
        mergeVariable: defaultMergeVariable(),
        stateCard: null,
        phoneConfig: null,
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
        mode: 'accumulate',
        resolveField: '',
        resolveAction: 'RESOLVED',
        stripFromResponse: true,
        injectFormatted: true,
        formatHeader: '',
        formatItem: '',
        formatEmpty: 'No data tracked.',
    };
}

function defaultSidecarCall() {
    return {
        enabled: false,
        maxTokens: DEFAULT_MAX_TOKENS,
        responseKey: '',
        includeHistory: false,
        historyMessageCount: 20,
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

    return {
        enabled: Boolean(raw.enabled),
        variableName: typeof raw.variableName === 'string' ? raw.variableName.trim() : d.variableName,
        extractPattern: typeof raw.extractPattern === 'string' ? raw.extractPattern : d.extractPattern,
        fieldNames: Array.isArray(raw.fieldNames)
            ? raw.fieldNames.map(f => String(f ?? '').trim()).filter(Boolean)
            : d.fieldNames,
        keyFields: Array.isArray(raw.keyFields)
            ? raw.keyFields.map(f => String(f ?? '').trim()).filter(Boolean)
            : d.keyFields,
        mode: raw.mode === 'snapshot' ? 'snapshot' : 'accumulate',
        resolveField: typeof raw.resolveField === 'string' ? raw.resolveField.trim() : d.resolveField,
        resolveAction: typeof raw.resolveAction === 'string' ? raw.resolveAction.trim() : d.resolveAction,
        stripFromResponse: raw.stripFromResponse !== false,
        injectFormatted: raw.injectFormatted !== false,
        formatHeader: typeof raw.formatHeader === 'string' ? raw.formatHeader : d.formatHeader,
        formatItem: typeof raw.formatItem === 'string' ? raw.formatItem : d.formatItem,
        formatEmpty: typeof raw.formatEmpty === 'string' ? raw.formatEmpty : d.formatEmpty,
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
        generationTypes: Array.isArray(raw.generationTypes)
            ? raw.generationTypes.map(t => String(t ?? '').trim()).filter(Boolean)
            : d.generationTypes,
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
        injection: { ...d.injection, ...(raw.injection ?? {}) },
        postProcess: normalizePostProcess(raw.postProcess),
        regexScripts: Array.isArray(raw.regexScripts)
            ? raw.regexScripts.map(s => normalizeRegexScript(s ?? {}))
            : d.regexScripts,
        connectionProfile: typeof raw.connectionProfile === 'string'
            ? raw.connectionProfile
            : d.connectionProfile,
        maxTokens: Number.isFinite(Number(raw.maxTokens)) ? Number(raw.maxTokens) : d.maxTokens,
        enabled: Boolean(raw.enabled),
        conditions: normalizeConditions(raw.conditions),
        groupId: typeof raw.groupId === 'string' ? raw.groupId : null,
        sourceTemplateId: typeof raw.sourceTemplateId === 'string'
            ? raw.sourceTemplateId
            : d.sourceTemplateId,
        sourceTemplateVersion: Number.isFinite(Number(raw.sourceTemplateVersion))
            ? Number(raw.sourceTemplateVersion)
            : 0,
        mergeVariable,
        stateCard: raw.stateCard && typeof raw.stateCard === 'object' ? raw.stateCard : null,
        phoneConfig: raw.phoneConfig && typeof raw.phoneConfig === 'object' ? raw.phoneConfig : null,
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
        phase: ['pre', 'post'].includes(raw.phase) ? raw.phase : d.phase,
        order: Number.isFinite(Number(raw.order)) ? Number(raw.order) : d.order,
        enabled: raw.enabled !== false,
    };
}
