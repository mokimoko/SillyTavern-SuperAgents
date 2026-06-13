/**
 * data/store.js — in-memory state, CRUD, and persistence.
 *
 * Stores agents/groups/globalSettings flat under the extension's
 * `extension_settings` key (unlike VM which nested under `.agents`).
 *
 * Normalization lives in `./normalize.js`; template sync and import/export
 * live in their own files. This module is intentionally focused.
 */

import { MODULE_NAME, debug } from '../../index.js';
import { extension_settings } from '../../../../../extensions.js';
import { saveSettingsDebounced } from '../../../../../../script.js';

import {
    createDefaultAgent,
    createDefaultGroup,
    normalizeAgent,
    normalizeGroup,
    generateId,
} from './normalize.js';

const LOG_PREFIX = '[SuperAgents/store]';

// ----------------------------------------------------------------------
// In-memory state
// ----------------------------------------------------------------------

/** @type {object[]} */
let agents = [];

/** @type {object[]} */
let groups = [];

/** Global agent settings (per-extension, not per-agent). */
let globalSettings = {
    connectionProfile: '',          // default profile when an agent has none
    defaultExecutionMode: 'parallel',
    showNotifications: true,
    showCostHint: true,             // per-turn agents-vs-calls hint (gameplan §6)
    defaultMaxTokens: 8192,
    batchByProfile: true,           // group sidecars by profile into one envelope
    batchMaxTokens: 16384,          // cap on batched envelope so backends don't truncate
    respectMutex: true,             // honor GENERATION_MUTEX_CAPTURED from other extensions
    agentCallTimeoutMs: 90000,      // per-call wall-clock ceiling; a stalled stream
                                    // can't wedge the run forever (0 = no timeout)
    useNativeStopButton: true,      // reuse ST's native ✕ (#mes_stop) + hide send
                                    // button while an agent run is active. false =
                                    // use the separate #sa_stop button instead.
};

// ----------------------------------------------------------------------
// Persistence
// ----------------------------------------------------------------------

function getRoot() {
    if (!extension_settings[MODULE_NAME] || typeof extension_settings[MODULE_NAME] !== 'object') {
        extension_settings[MODULE_NAME] = {};
    }
    return extension_settings[MODULE_NAME];
}

function persist() {
    const root = getRoot();
    root.agents = agents.map(a => ({ ...a }));
    root.groups = groups.map(g => ({ ...g }));
    root.globalSettings = { ...globalSettings };
    saveSettingsDebounced();
}

/**
 * Load agents/groups/globalSettings from extension_settings into memory.
 * Idempotent; safe to call multiple times.
 */
export function loadFromSettings() {
    const root = getRoot();

    if (Array.isArray(root.agents)) {
        agents = root.agents.map(normalizeAgent);
    }
    if (Array.isArray(root.groups)) {
        groups = root.groups.map(normalizeGroup);
    }
    if (root.globalSettings && typeof root.globalSettings === 'object') {
        globalSettings = { ...globalSettings, ...root.globalSettings };
    }

    debug(`${LOG_PREFIX} loaded ${agents.length} agents, ${groups.length} groups`);
}

// ----------------------------------------------------------------------
// Agent CRUD
// ----------------------------------------------------------------------

/** @returns {object[]} shallow-copied agent list */
export function getAgents() {
    return [...agents];
}

/** @returns {object[]} enabled agents, sorted by injection order */
export function getEnabledAgents() {
    return agents
        .filter(a => a.enabled)
        .sort((a, b) => (a.injection?.order ?? 0) - (b.injection?.order ?? 0));
}

/** @returns {object|undefined} */
export function getAgentById(id) {
    return agents.find(a => a.id === id);
}

/** Case-insensitive name lookup. */
export function getAgentByName(name) {
    const lower = String(name ?? '').trim().toLowerCase();
    return agents.find(a => a.name.toLowerCase() === lower);
}

/**
 * Create or update an agent. Returns the normalized stored version.
 * @param {object} agent
 * @returns {object}
 */
export function saveAgent(agent) {
    const normalized = normalizeAgent(agent);
    const idx = agents.findIndex(a => a.id === normalized.id);
    if (idx >= 0) {
        agents[idx] = normalized;
    } else {
        agents.push(normalized);
    }
    persist();
    return normalized;
}

/** Delete an agent and remove it from any groups. */
export function deleteAgent(id) {
    const before = agents.length;
    agents = agents.filter(a => a.id !== id);
    for (const group of groups) {
        group.agentIds = group.agentIds.filter(aid => aid !== id);
    }
    if (agents.length !== before) persist();
}

/**
 * Flip an agent's enabled state.
 * @returns {boolean|null} new state, or null if not found
 */
export function toggleAgent(id) {
    const agent = getAgentById(id);
    if (!agent) return null;
    agent.enabled = !agent.enabled;
    persist();
    return agent.enabled;
}

/**
 * Instantiate a built-in template as a live, enabled agent instance.
 *
 * Normally the Library UI (gameplan step 9) does this. Exposed now so the
 * Step-4 checkpoint can spin up World State for end-to-end testing. Gives
 * the instance a fresh id, stamps source-template markers so templateSync
 * keeps it current, and enables it so it runs immediately.
 *
 * @param {object} template - a template JSON object (from listBuiltInTemplates)
 * @returns {object|null} the saved agent, or null if input is invalid
 */
export function instantiateTemplate(template) {
    if (!template || typeof template !== 'object') return null;
    return saveAgent({
        ...template,
        id: generateId(),
        version: 1,
        sourceTemplateId: template.id || template.sourceTemplateId || '',
        sourceTemplateVersion: template.version ?? 0,
        enabled: true,
    });
}

// ----------------------------------------------------------------------
// Group CRUD
// ----------------------------------------------------------------------

export function getGroups() {
    return [...groups];
}

export function getGroupById(id) {
    return groups.find(g => g.id === id);
}

export function saveGroup(group) {
    const normalized = normalizeGroup(group);
    const idx = groups.findIndex(g => g.id === normalized.id);
    if (idx >= 0) {
        groups[idx] = normalized;
    } else {
        groups.push(normalized);
    }
    persist();
    return normalized;
}

export function deleteGroup(id) {
    const before = groups.length;
    groups = groups.filter(g => g.id !== id);
    if (groups.length !== before) persist();
}

/**
 * Flip a group's enabled state AND batch-toggle every agent in it.
 * @returns {{ groupEnabled: boolean, agentCount: number } | null}
 */
export function toggleGroup(id) {
    const group = groups.find(g => g.id === id);
    if (!group) return null;

    group.enabled = !group.enabled;

    let touched = 0;
    for (const agentId of group.agentIds) {
        const agent = agents.find(a => a.id === agentId);
        if (agent) {
            agent.enabled = group.enabled;
            touched++;
        }
    }
    persist();
    return { groupEnabled: group.enabled, agentCount: touched };
}

// ----------------------------------------------------------------------
// Global settings
// ----------------------------------------------------------------------

export function getGlobalSettings() {
    return { ...globalSettings };
}

export function setGlobalSettings(update) {
    if (!update || typeof update !== 'object') return;
    Object.assign(globalSettings, update);
    persist();
}

// ----------------------------------------------------------------------
// Internals — exposed for sibling modules (templateSync, importExport).
// External code should NOT touch these; use the CRUD API above instead.
// ----------------------------------------------------------------------

export const _internal = {
    /** Live reference to the agents array. Mutate carefully and call persist(). */
    getAgentsRef: () => agents,
    /** Live reference to the groups array. */
    getGroupsRef: () => groups,
    /** Flush in-memory state to extension_settings + trigger save. */
    persist,
};

// Re-export the default factories so other modules can import them via the
// store without going to normalize.js directly.
export { createDefaultAgent, createDefaultGroup };
