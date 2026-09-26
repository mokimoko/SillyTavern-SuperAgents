/**
 * data/store.js — in-memory state, CRUD, and persistence.
 *
 * Stores agents/groups/globalSettings flat under the extension's
 * `extension_settings` key (unlike VM which nested under `.agents`).
 *
 * Normalization lives in `./normalize.js`; template sync and import/export
 * live in their own files. This module is intentionally focused.
 */

import { MODULE_NAME, debug } from '../core/runtime.js';
import { extension_settings } from '../../../../../extensions.js';
import { saveSettingsDebounced } from '../../../../../../script.js';

import {
    createDefaultAgent,
    createDefaultGroup,
    normalizeAgent,
    normalizeGroup,
    generateId,
} from './normalize.js';
import { reconcileGroupMembership } from './groupMembership.js';
import { applyLibraryUsageSettings } from './libraryUsage.js';
import { isTemplateLinked } from './templateLink.js';

const LOG_PREFIX = '[SuperAgents/store]';

// ----------------------------------------------------------------------
// In-memory state
// ----------------------------------------------------------------------

/** @type {object[]} */
let agents = [];

/** @type {object[]} */
let groups = [];

/** Subscribers used by lightweight integrations such as UIBedazzler. */
const agentsPauseListeners = new Set();
const agentPauseListeners = new Set();
const storeChangeListeners = new Set();

// Story Apps use agent records for their configuration, but the active-set
// switch controls only the ordinary agents that run in the story pipeline.
function isStoryAppAgent(agent) {
    return agent?.afterDarkConfig?.enabled === true
        || agent?.dramaQueenConfig?.enabled === true
        || agent?.sourceTemplateId === 'tpl-after-dark'
        || agent?.sourceTemplateId === 'tpl-drama-queen';
}

/** Global agent settings (per-extension, not per-agent). */
let globalSettings = {
    agentsPaused: false,            // global execution gate; individual enabled flags stay untouched
    enabledSetDisabled: false,      // true after the active enabled set was explicitly switched off
    enabledSetSnapshot: [],         // IDs to restore; agents already off are intentionally absent
    useDefaultConnection: false,    // route blank-profile agents through the shared default below
    connectionProfile: '',          // default profile when an agent has none
    economyMode: false,             // use lower-call defaults for new Library agents
    deferPostAgentsOnSwipe: false,  // postpone costly post-reply calls until the next normal reply
    defaultExecutionMode: 'parallel',
    showNotifications: true,
    showNotificationsLauncher: true, // show the Notifications button in Story Apps
    showCalendarLauncher: true,      // show the Calendar button in Story Apps
    groupChatEnabled: true,          // expose the OOC Group Chat UtilitiesApp
    calendarStorySync: true,        // accept validated hidden Calendar directives from story replies
    weatherCycleIntegration: false, // mirror eligible World State snapshots into st-weather-cycle
    weatherCycleAfternoonSkyColor: '#ffe09d',
    weatherCycleAfternoonGlowColor: '#e59548',
    weatherCycleAfternoonIntensity: 0.18,
    weatherCycleTwilightSkyColor: '#3e4989',
    weatherCycleTwilightGlowColor: '#ee8053',
    weatherCycleTwilightIntensity: 0.20,
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

const WEATHER_PHASE_DEFAULTS = Object.freeze({
    weatherCycleAfternoonSkyColor: '#ffe09d',
    weatherCycleAfternoonGlowColor: '#e59548',
    weatherCycleAfternoonIntensity: 0.18,
    weatherCycleTwilightSkyColor: '#3e4989',
    weatherCycleTwilightGlowColor: '#ee8053',
    weatherCycleTwilightIntensity: 0.20,
});

function normalizeWeatherPhaseSettings() {
    for (const [key, fallback] of Object.entries(WEATHER_PHASE_DEFAULTS)) {
        if (key.endsWith('Color')) {
            const value = String(globalSettings[key] ?? '').trim();
            globalSettings[key] = /^#[\da-f]{6}$/i.test(value) ? value : fallback;
            continue;
        }
        const value = Number(globalSettings[key]);
        globalSettings[key] = Number.isFinite(value)
            ? Math.min(1, Math.max(0, value))
            : fallback;
    }
}

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
    // Sibling modules intentionally mutate the live arrays before calling this
    // function (template sync/import). Keep membership and group-owned phase
    // consistent at that final write boundary as well as in the CRUD helpers.
    reconcileGroupMembership(agents, groups, { includeAgentFallback: false });
    const root = getRoot();
    root.agents = agents.map(a => ({ ...a }));
    root.groups = groups.map(g => ({ ...g }));
    root.globalSettings = { ...globalSettings };
    saveSettingsDebounced();
    notifyStoreChange();
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
    globalSettings.agentsPaused = Boolean(globalSettings.agentsPaused);
    globalSettings.useDefaultConnection = Boolean(globalSettings.useDefaultConnection);
    globalSettings.connectionProfile = String(globalSettings.connectionProfile ?? '').trim();
    globalSettings.economyMode = Boolean(globalSettings.economyMode);
    globalSettings.deferPostAgentsOnSwipe = Boolean(globalSettings.deferPostAgentsOnSwipe);
    globalSettings.groupChatEnabled = globalSettings.groupChatEnabled !== false;
    globalSettings.weatherCycleIntegration = Boolean(globalSettings.weatherCycleIntegration);
    normalizeWeatherPhaseSettings();
    globalSettings.enabledSetDisabled = Boolean(globalSettings.enabledSetDisabled);
    globalSettings.enabledSetSnapshot = Array.isArray(globalSettings.enabledSetSnapshot)
        ? [...new Set(globalSettings.enabledSetSnapshot.map(id => String(id ?? '').trim()).filter(Boolean))]
        : [];
    if (!globalSettings.enabledSetDisabled) globalSettings.enabledSetSnapshot = [];

    // Older versions included Story Apps in the saved active set. Restore
    // those apps now so an already-disabled set does not keep hiding them.
    const savedStoryApps = new Set(globalSettings.enabledSetSnapshot.filter(id =>
        agents.some(agent => agent.id === id && isStoryAppAgent(agent))));
    if (savedStoryApps.size) {
        for (const agent of agents) {
            if (savedStoryApps.has(agent.id)) agent.enabled = true;
        }
        globalSettings.enabledSetSnapshot = globalSettings.enabledSetSnapshot.filter(id => !savedStoryApps.has(id));
        if (!globalSettings.enabledSetSnapshot.length) globalSettings.enabledSetDisabled = false;
        persist();
    }

    // Groups historically stored the same relationship in two places. The UI
    // edits group.agentIds, while the executor reads agent.groupId. Reconcile on
    // every load so old and partially-saved configurations repair themselves.
    const membership = reconcileGroupMembership(agents, groups);
    if (membership.changed) persist();

    debug(`${LOG_PREFIX} loaded ${agents.length} agents, ${groups.length} groups`);
}

// ----------------------------------------------------------------------
// Agent CRUD
// ----------------------------------------------------------------------

/** @returns {object[]} shallow-copied agent list */
export function getAgents() {
    return [...agents];
}

/**
 * Enabled agents, sorted by injection order.
 *
 * Global pause is intentionally NOT applied here. Enabledness also controls
 * presentation and reference context (Story Apps, State Card, injections),
 * which remain visible as a frozen snapshot while execution is paused.
 */
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
 * Persist the management list's stacking order in one write. Injection order
 * controls execution; display agents also own a separate State Card order.
 */
export function reorderAgents(agentIds) {
    const byId = new Map(agents.map(agent => [agent.id, agent]));
    const seen = new Set();
    const ordered = [];
    const currentStack = agents
        .map((agent, index) => ({
            agent,
            index,
            order: Number(agent.stateCard?.order ?? agent.injection?.order ?? 100),
        }))
        .sort((left, right) => (
            ((Number.isFinite(left.order) ? left.order : 100) - (Number.isFinite(right.order) ? right.order : 100))
            || (left.index - right.index)
        ))
        .map(entry => entry.agent.id);

    for (const id of agentIds || []) {
        const agent = byId.get(id);
        if (!agent || seen.has(id)) continue;
        seen.add(id);
        ordered.push(agent);
    }
    for (const agent of agents) {
        if (!seen.has(agent.id)) ordered.push(agent);
    }
    if (ordered.length !== agents.length) return false;

    const changed = ordered.some((agent, index) => agent.id !== currentStack[index]);
    if (!changed) return false;

    const step = ordered.length <= 99 ? 10 : 1;
    ordered.forEach((agent, index) => {
        const order = (index + 1) * step;
        agent.injection = { ...agent.injection, order };
        if (agent.stateCard && typeof agent.stateCard === 'object') {
            agent.stateCard = { ...agent.stateCard, order };
        }
    });
    agents = ordered;
    persist();
    return true;
}

/**
 * Create or update an agent. Returns the normalized stored version.
 * @param {object} agent
 * @returns {object}
 */
export function saveAgent(agent) {
    const normalized = normalizeAgent(agent);
    const idx = agents.findIndex(a => a.id === normalized.id);
    const groupWasProvided = Object.prototype.hasOwnProperty.call(agent ?? {}, 'groupId');
    if (idx >= 0 && !groupWasProvided) normalized.groupId = agents[idx].groupId;
    if (idx >= 0) {
        agents[idx] = normalized;
    } else {
        agents.push(normalized);
    }

    if (groupWasProvided) {
        for (const group of groups) {
            group.agentIds = group.agentIds.filter(id => id !== normalized.id);
        }
        const target = groups.find(group => group.id === normalized.groupId);
        if (target) target.agentIds.push(normalized.id);
    }
    reconcileGroupMembership(agents, groups, { includeAgentFallback: false });
    persist();
    return normalized;
}

/** Delete agents and remove them from any groups. Returns the number deleted. */
export function deleteAgents(ids) {
    const idSet = new Set(ids || []);
    if (!idSet.size) return 0;
    const before = agents.length;
    agents = agents.filter(a => !idSet.has(a.id));
    for (const group of groups) {
        group.agentIds = group.agentIds.filter(aid => !idSet.has(aid));
    }
    const deletedCount = before - agents.length;
    if (deletedCount) {
        reconcileGroupMembership(agents, groups, { includeAgentFallback: false });
        persist();
    }
    return deletedCount;
}

/** Delete one agent and remove it from any groups. */
export function deleteAgent(id) {
    return deleteAgents([id]);
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

/** True when one agent is frozen but still logically enabled. */
export function isAgentPaused(id) {
    return Boolean(getAgentById(id)?.paused);
}

/** Pause/resume one agent without changing its enabled state. */
export function setAgentPaused(id, paused) {
    const agent = getAgentById(id);
    if (!agent) return null;
    const next = Boolean(paused);
    if (agent.paused === next) return next;
    agent.paused = next;
    persist();
    for (const fn of agentPauseListeners) {
        try {
            fn(agent, next);
        } catch (err) {
            console.warn(`${LOG_PREFIX} agent-pause listener failed:`, err);
        }
    }
    return next;
}

/** Toggle one agent's frozen state. */
export function toggleAgentPaused(id) {
    const agent = getAgentById(id);
    return agent ? setAgentPaused(id, !agent.paused) : null;
}

/** Subscribe to individual agent pause changes. Returns an unsubscribe function. */
export function onAgentPauseChange(fn) {
    if (typeof fn !== 'function') return () => {};
    agentPauseListeners.add(fn);
    return () => agentPauseListeners.delete(fn);
}

/** Subscribe to persisted agent/config changes. Returns an unsubscribe function. */
export function onStoreChange(fn) {
    if (typeof fn !== 'function') return () => {};
    storeChangeListeners.add(fn);
    return () => storeChangeListeners.delete(fn);
}

function notifyStoreChange() {
    for (const fn of storeChangeListeners) {
        try {
            fn();
        } catch (err) {
            console.warn(`${LOG_PREFIX} store-change listener failed:`, err);
        }
    }
}

/** Set a collection of agents to the same enabled state. Returns changed count. */
export function setAgentsEnabled(ids, enabled) {
    const idSet = new Set(ids || []);
    const nextEnabled = Boolean(enabled);
    let changedCount = 0;
    for (const agent of agents) {
        if (!idSet.has(agent.id) || agent.enabled === nextEnabled) continue;
        agent.enabled = nextEnabled;
        changedCount++;
    }
    if (changedCount) persist();
    return changedCount;
}

/** Read the reversible active-set power state used by the flyout. */
export function getEnabledSetState() {
    const liveIds = new Set(agents.filter(agent => !isStoryAppAgent(agent)).map(agent => agent.id));
    const savedIds = globalSettings.enabledSetSnapshot.filter(id => liveIds.has(id));
    return {
        disabled: globalSettings.enabledSetDisabled,
        count: globalSettings.enabledSetDisabled
            ? savedIds.length
            : agents.filter(agent => agent.enabled && !isStoryAppAgent(agent)).length,
    };
}

/**
 * Disable the currently enabled set, or restore exactly that saved set.
 * Agents that were already disabled are never enabled by this operation.
 */
export function toggleEnabledAgentSet() {
    if (globalSettings.enabledSetDisabled) {
        const savedIds = new Set(globalSettings.enabledSetSnapshot);
        let changedCount = 0;
        for (const agent of agents) {
            if (!savedIds.has(agent.id) || agent.enabled || isStoryAppAgent(agent)) continue;
            agent.enabled = true;
            changedCount++;
        }
        const savedCount = savedIds.size;
        globalSettings.enabledSetDisabled = false;
        globalSettings.enabledSetSnapshot = [];
        persist();
        return { disabled: false, changedCount, savedCount };
    }

    const enabledIds = agents.filter(agent => agent.enabled && !isStoryAppAgent(agent)).map(agent => agent.id);
    if (!enabledIds.length) return { disabled: false, changedCount: 0, savedCount: 0 };
    const enabledIdSet = new Set(enabledIds);
    for (const agent of agents) {
        if (enabledIdSet.has(agent.id)) agent.enabled = false;
    }
    globalSettings.enabledSetDisabled = true;
    globalSettings.enabledSetSnapshot = enabledIds;
    persist();
    return { disabled: true, changedCount: enabledIds.length, savedCount: enabledIds.length };
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
    const configured = applyLibraryUsageSettings(template, template, globalSettings.economyMode);
    return saveAgent({
        ...configured,
        id: generateId(),
        version: 1,
        sourceTemplateId: template.id || template.sourceTemplateId || '',
        sourceTemplateVersion: template.version ?? 0,
        sourceTemplateLinked: true,
        enabled: true,
    });
}

/**
 * Explicitly apply the selected usage preset to existing built-in instances.
 * Custom agents are excluded; all changes are persisted in one store write.
 */
export function applyUsageModeToLibraryAgents(templates, economyMode = globalSettings.economyMode) {
    const byId = new Map((templates || [])
        .filter(template => template && typeof template === 'object')
        .map(template => [templateIdForUsage(template), template]));
    let changedCount = 0;

    for (let index = 0; index < agents.length; index++) {
        const agent = agents[index];
        if (!isTemplateLinked(agent)) continue;
        const template = byId.get(String(agent.sourceTemplateId || '').trim());
        if (!template) continue;
        const updated = applyLibraryUsageSettings(agent, template, economyMode);
        if (JSON.stringify(updated) === JSON.stringify(agent)) continue;
        agents[index] = normalizeAgent(updated);
        changedCount++;
    }

    if (changedCount) persist();
    return changedCount;
}

function templateIdForUsage(template) {
    return String(template?.id || template?.sourceTemplateId || '').trim();
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
    const selectedIds = new Set(normalized.agentIds);

    // Membership is exclusive. Selecting an agent here moves it out of any
    // other group; deselecting it clears the derived agent.groupId below.
    for (const existingGroup of groups) {
        if (existingGroup.id === normalized.id) continue;
        existingGroup.agentIds = existingGroup.agentIds.filter(id => !selectedIds.has(id));
    }
    const idx = groups.findIndex(g => g.id === normalized.id);
    if (idx >= 0) {
        groups[idx] = normalized;
    } else {
        groups.push(normalized);
    }
    reconcileGroupMembership(agents, groups, { includeAgentFallback: false });
    persist();
    return normalized;
}

export function deleteGroup(id) {
    const before = groups.length;
    groups = groups.filter(g => g.id !== id);
    if (groups.length !== before) {
        reconcileGroupMembership(agents, groups, { includeAgentFallback: false });
        persist();
    }
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

/** Resolve an agent's explicit profile or the enabled SuperAgents default. */
export function getEffectiveConnectionProfile(agentProfile = '') {
    const explicit = String(agentProfile ?? '').trim();
    if (explicit) return explicit;
    if (!globalSettings.useDefaultConnection) return '';
    return String(globalSettings.connectionProfile ?? '').trim();
}

export function setGlobalSettings(update) {
    if (!update || typeof update !== 'object') return;
    const wasPaused = globalSettings.agentsPaused;
    Object.assign(globalSettings, update);
    globalSettings.agentsPaused = Boolean(globalSettings.agentsPaused);
    globalSettings.useDefaultConnection = Boolean(globalSettings.useDefaultConnection);
    globalSettings.connectionProfile = String(globalSettings.connectionProfile ?? '').trim();
    globalSettings.economyMode = Boolean(globalSettings.economyMode);
    globalSettings.deferPostAgentsOnSwipe = Boolean(globalSettings.deferPostAgentsOnSwipe);
    globalSettings.weatherCycleIntegration = Boolean(globalSettings.weatherCycleIntegration);
    normalizeWeatherPhaseSettings();
    persist();
    if (globalSettings.agentsPaused !== wasPaused) notifyAgentsPauseChange();
}

/** True when all agent execution is globally paused. */
export function isAgentsPaused() {
    return globalSettings.agentsPaused;
}

/**
 * Pause or resume all agent execution without changing any agent's own
 * enabled flag. Resuming therefore restores the exact active set from before.
 */
export function setAgentsPaused(paused) {
    const next = Boolean(paused);
    if (globalSettings.agentsPaused === next) return next;
    globalSettings.agentsPaused = next;
    persist();
    notifyAgentsPauseChange();
    return next;
}

/** Toggle the global execution gate and return the new paused state. */
export function toggleAgentsPaused() {
    return setAgentsPaused(!globalSettings.agentsPaused);
}

/** Subscribe to pause/resume changes. Returns an unsubscribe function. */
export function onAgentsPauseChange(fn) {
    if (typeof fn !== 'function') return () => {};
    agentsPauseListeners.add(fn);
    return () => agentsPauseListeners.delete(fn);
}

function notifyAgentsPauseChange() {
    for (const fn of agentsPauseListeners) {
        try {
            fn(globalSettings.agentsPaused);
        } catch (err) {
            console.warn(`${LOG_PREFIX} pause listener failed:`, err);
        }
    }
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
