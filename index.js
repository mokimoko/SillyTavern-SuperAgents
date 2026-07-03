/**
 * SuperAgents — extracted-and-improved successor to VerseManager's agents.
 *
 * Init order matters; everything else loads through this entry. Modules
 * land incrementally per the gameplan and get wired in here as they arrive.
 *
 * Currently live:
 *   - core/llm.js          — single LLM call path (callAgentLLM)
 *   - core/profiles.js     — connection profile resolution
 *   - core/idempotency.js  — per-message run tracking
 *   - core/activation.js   — shouldActivate / snapshot
 *   - core/lifecycle.js    — generation event engine (the orchestrator)
 *   - data/*               — store, normalize, templateSync, importExport
 *   - modes/mergeVariable  — structured data extraction & storage
 *   - modes/sidecar        — sidecar LLM calls (post-gen & pre-gen)
 *   - modes/batch          — JSON-envelope batching (post-gen & pre-gen)
 *   - modes/rewrite        — LLM prose rewrite/append
 *   - modes/postProcess    — non-LLM extract/append
 *   - render/*             — renderer, regexProcessor, hooks
 *
 * Public surface: `window.SuperAgents`.
 */

import { extension_settings } from '../../../extensions.js';

// LLM keystone
import { callAgentLLM, extractResponseText } from './src/core/llm.js';
import {
    isCMRSAvailable,
    resolveProfileId,
    getProfileNameById,
    getCurrentProfileId,
    getCurrentProfileName,
    listConnectionProfiles,
} from './src/core/profiles.js';

// Idempotency
import {
    hasAgentRun,
    getRunRecords,
    getAgentRunRecord,
    recordAgentRun,
    clearAgentRun,
    revertAgentRewrite,
} from './src/core/idempotency.js';

// Modes
import {
    readMergeArray,
    writeMergeArray,
    formatMergeVariableData,
    executeMergeVariable,
    storeSidecarResult,
    storeBatchedSidecarResult,
} from './src/modes/mergeVariable.js';
import {
    executeSidecarAgent,
    executePreGenSidecarAgent,
    buildSidecarDisplayData,
    buildHistoryContext,
    buildPreGenContext,
    groupSidecarsByProfile,
} from './src/modes/sidecar.js';
import {
    executeSidecarBatch,
    executePreGenSidecarBatch,
    processPreGenAgents,
} from './src/modes/batch.js';
import { executeRewriteAgent } from './src/modes/rewrite.js';
import { executeExtractAgent, executeAppendAgent } from './src/modes/postProcess.js';

// Core engine: activation + lifecycle
import {
    normalizeGenType,
    shouldActivate,
    buildActivationSnapshot,
    getSnapshotAgents,
} from './src/core/activation.js';
import {
    initLifecycle,
    runAgentOnMessage,
    isAgentRunActive,
    cancelAgentRun,
    onRunStateChange,
    onPostProcessComplete,
} from './src/core/lifecycle.js';

// Coexistence guard + macro exposure (Step 8)
import {
    initCompatibility,
    isExternalGenerationActive,
    getExternalGenerationDepth,
    beginSelfGeneration,
    endSelfGeneration,
} from './src/core/compatibility.js';
import { initMacros, refreshMacros } from './src/core/macros.js';

// User-facing slash commands (/sa-run, /sa-list, /sa-toggle, /sa-open)
import { registerSlashCommands } from './src/core/slashCommands.js';

// Per-turn / per-session call accounting (cost hint)
import { getStats, formatTurnHint, resetAll as resetStats } from './src/core/callStats.js';

// One-time VerseManager → SuperAgents settings migration
import { migrateFromVM } from './src/core/migration.js';

// Data layer
import {
    loadFromSettings,
    // agents
    getAgents,
    getEnabledAgents,
    getAgentById,
    getAgentByName,
    saveAgent,
    deleteAgent,
    toggleAgent,
    createDefaultAgent,
    // groups
    getGroups,
    getGroupById,
    saveGroup,
    deleteGroup,
    toggleGroup,
    createDefaultGroup,
    // settings
    getGlobalSettings,
    setGlobalSettings,
    // template instantiation (checkpoint helper)
    instantiateTemplate,
} from './src/data/store.js';
import { syncFromTemplates, listBuiltInTemplates } from './src/data/templateSync.js';
import { importAgents, exportAllAgents, exportAgent } from './src/data/importExport.js';

// Render layer
import { initRenderer, registerRenderHook, refreshMessage } from './src/render/renderer.js';
import { renderWorldStateHud } from './src/render/hooks/worldStateHud.js';
import { renderContinuityCheck } from './src/render/hooks/continuityCheck.js';
import { renderNarrativeEngine } from './src/render/hooks/narrativeEngine.js';
import { renderParallelOffscreen } from './src/render/hooks/parallelOffscreen.js';
import { renderDirectionMenu, initDirectionMenuDelegation } from './src/render/hooks/directionMenuRenderer.js';
import { renderDirectorPlan } from './src/render/hooks/directorPlan.js';

// UI layer: unified management modal (Step 9)
import { openModal, closeModal, isModalOpen, registerPanelControl } from './src/ui/modal.js';
import { resolveAgentIcon, resolveGroupIcon } from './src/ui/iconResolver.js';
import { initRunIndicator } from './src/ui/runIndicator.js';
import { initNativeStopButton } from './src/ui/nativeStopButton.js';
import { initDiffButtons } from './src/ui/diffButton.js';
import {
    initStateCard,
    show as showStateCard,
    hide as hideStateCard,
    update as updateStateCard,
} from './src/ui/stateCard.js';

// Phone module (Step 9): diegetic texting logic + floating messenger panel
import { initPhoneAgent } from './src/phone/phoneAgent.js';
import {
    initPhonePanel,
    show as showPhone,
    hide as hidePhone,
} from './src/phone/phonePanel.js';

export const MODULE_NAME = 'SillyTavern-SuperAgents';
export const LOG_PREFIX = '[SuperAgents]';

// ----------------------------------------------------------------------
// Top-level extension settings (top-level toggles only — store.js owns
// agents/groups/globalSettings further down)
// ----------------------------------------------------------------------

const DEFAULT_SETTINGS = {
    enabled: true,
    debug: false,
};

export function getSettings() {
    if (!extension_settings[MODULE_NAME] || typeof extension_settings[MODULE_NAME] !== 'object') {
        extension_settings[MODULE_NAME] = {};
    }
    const s = extension_settings[MODULE_NAME];
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
        if (s[k] === undefined) s[k] = v;
    }
    return s;
}

export function debug(...args) {
    if (getSettings().debug) console.log(LOG_PREFIX, ...args);
}

// ----------------------------------------------------------------------
// Public namespace
// ----------------------------------------------------------------------

function initNamespace() {
    window.SuperAgents = {
        version: '0.8.0',  // Step 11 polish — slash commands (/sa-*), per-turn cost hint, regex-safety hardening

        // Top-level toggles
        getSettings,
        debug,

        // LLM keystone
        callAgentLLM,
        extractResponseText,

        // Profile helpers
        profiles: {
            isCMRSAvailable,
            resolveProfileId,
            getProfileNameById,
            getCurrentProfileId,
            getCurrentProfileName,
            listConnectionProfiles,
        },

        // Idempotency
        idempotency: {
            hasAgentRun,
            getRunRecords,
            getAgentRunRecord,
            recordAgentRun,
            clearAgentRun,
            revertAgentRewrite,
        },

        // Agent CRUD
        agents: {
            getAll:        getAgents,
            getEnabled:    getEnabledAgents,
            getById:       getAgentById,
            getByName:     getAgentByName,
            save:          saveAgent,
            delete:        deleteAgent,
            toggle:        toggleAgent,
            createDefault: createDefaultAgent,
        },

        // Group CRUD
        groups: {
            getAll:        getGroups,
            getById:       getGroupById,
            save:          saveGroup,
            delete:        deleteGroup,
            toggle:        toggleGroup,
            createDefault: createDefaultGroup,
        },

        // Global agent settings
        settings: {
            get: getGlobalSettings,
            set: setGlobalSettings,
        },

        // Merge variable operations
        mergeVar: {
            read:          readMergeArray,
            write:         writeMergeArray,
            format:        formatMergeVariableData,
            execute:       executeMergeVariable,
            storeSidecar:  storeSidecarResult,
            storeBatched:  storeBatchedSidecarResult,
        },

        // Sidecar execution
        sidecar: {
            execute:        executeSidecarAgent,
            executePreGen:  executePreGenSidecarAgent,
            executeBatch:   executeSidecarBatch,
            executePreGenBatch: executePreGenSidecarBatch,
            processPreGen:  processPreGenAgents,
            buildDisplay:   buildSidecarDisplayData,
            buildHistory:   buildHistoryContext,
            buildPreGenCtx: buildPreGenContext,
            groupByProfile: groupSidecarsByProfile,
        },

        // Rewrite + non-LLM post-processing modes
        modes: {
            rewrite: executeRewriteAgent,
            extract: executeExtractAgent,
            append:  executeAppendAgent,
        },

        // Activation logic
        activation: {
            normalizeGenType,
            shouldActivate,
            buildSnapshot:   buildActivationSnapshot,
            getSnapshotAgents,
        },

        // Lifecycle engine — the orchestrator
        lifecycle: {
            init:            initLifecycle,
            runAgent:        runAgentOnMessage,
            isActive:        isAgentRunActive,
            cancel:          cancelAgentRun,
            onRunStateChange,
            onPostProcess:   onPostProcessComplete,
        },

        // Coexistence guard vs other generation-driving extensions (Step 8)
        compat: {
            init:                 initCompatibility,
            isExternalActive:     isExternalGenerationActive,
            externalDepth:        getExternalGenerationDepth,
            beginSelfGeneration,
            endSelfGeneration,
        },

        // Macro exposure: {{agent_<var>}} / {{agent_<var>_raw}} (Step 8)
        macros: {
            init:    initMacros,
            refresh: refreshMacros,
        },

        // Per-turn / per-session call accounting (cost hint — gameplan §6)
        stats: {
            get:       getStats,
            formatTurn: formatTurnHint,
            reset:     resetStats,
        },

        // Render layer
        render: {
            init:         initRenderer,
            registerHook: registerRenderHook,
            refresh:      refreshMessage,
        },

        // UI layer: unified management modal (Step 9)
        ui: {
            openModal,
            closeModal,
            isModalOpen,
            registerPanelControl,
            resolveAgentIcon,
            resolveGroupIcon,
            initRunIndicator,
            initDiffButtons,
            stateCard: {
                init:   initStateCard,
                show:   showStateCard,
                hide:   hideStateCard,
                update: updateStateCard,
            },
            phone: {
                init: initPhonePanel,
                show: showPhone,
                hide: hidePhone,
            },
        },

        // Templates
        templates: {
            sync:        syncFromTemplates,
            listBuiltIn: listBuiltInTemplates,
            instantiate: async (templateId) => {
                const all = await listBuiltInTemplates();
                const tpl = all.find(t => t.id === templateId);
                if (!tpl) {
                    console.warn(LOG_PREFIX, `template "${templateId}" not found`);
                    return null;
                }
                return instantiateTemplate(tpl);
            },
        },

        // Import / export
        io: {
            import:    importAgents,
            exportAll: exportAllAgents,
            export:    exportAgent,
        },
    };
}

// ----------------------------------------------------------------------
// Extensions-menu launcher (wand menu). Mirrors the SimpleSummarizer
// pattern: a list-group item in #extensionsMenu, with a fallback to the
// data-bank wand container / extensions block if the menu isn't present.
// ----------------------------------------------------------------------

function createMenuButton() {
    const btn = document.createElement('div');
    btn.id = 'superagents-menu-btn';
    btn.className = 'list-group-item flex-container flexGap5 interactable';
    btn.title = 'SuperAgents';
    btn.tabIndex = 0;
    btn.innerHTML = '<i class="fa-solid fa-people-group"></i> SuperAgents';
    btn.addEventListener('click', () => openModal());
    return btn;
}

function setupExtensionsMenuButton() {
    if (document.getElementById('superagents-menu-btn')) return;
    const menu = document.getElementById('extensionsMenu');
    if (menu) {
        menu.appendChild(createMenuButton());
        return;
    }
    const alt = document.querySelector('#data_bank_wand_container') || document.querySelector('.extensions_block');
    if (alt) alt.appendChild(createMenuButton());
}

// ----------------------------------------------------------------------
// Init (jQuery $(document).ready)
// ----------------------------------------------------------------------

jQuery(async () => {
    try {
        getSettings();         // ensure root shape exists
        loadFromSettings();    // hydrate the data layer from extension_settings

        // One-time VerseManager → SuperAgents migration (self-guards; safe to
        // call every load). Runs before the namespace is built so migrated
        // agents are present for everything downstream.
        const migration = migrateFromVM();

        initNamespace();

        // Coexistence guard BEFORE the lifecycle, so the external-generation
        // flag is already tracking by the time any post-gen work can fire.
        initCompatibility();

        // Lifecycle engine — its MESSAGE_SWIPED handler must run before the
        // renderer's so per-swipe state is restored before the DOM re-render.
        initLifecycle();

        // Macro exposure: register {{agent_<var>}} state macros, and refresh
        // them after every post-gen run so newly-accumulated state is queryable
        // without a reload. CHAT_CHANGED re-sync is wired inside initMacros().
        initMacros();
        onPostProcessComplete(() => refreshMacros());

        // Render layer: register hooks, then start the DOM observer.
        registerRenderHook('ws-hud-data', renderWorldStateHud);
        registerRenderHook('cc-check-data', renderContinuityCheck);
        registerRenderHook('ne-engine-data', renderNarrativeEngine);
        registerRenderHook('parallel-hud-data', renderParallelOffscreen);
        registerRenderHook('dm-menu-data', renderDirectionMenu);
        registerRenderHook('director-plan-data', renderDirectorPlan);
        // Direction Menu uses delegated click handling on #chat; install it up
        // front (idempotent + self-retries if #chat isn't in the DOM yet).
        initDirectionMenuDelegation();
        initRenderer();

        // UI: add the wand-menu launcher for the unified modal.
        setupExtensionsMenuButton();

        // UI: in-input stop affordance — lets the user cancel an in-flight
        // agent run (pre-gen planner, post-gen rewrite/sidecar, or a manual run)
        // the same way ST's own stop aborts a generation. Two styles:
        //   - native (default): reuse ST's own ✕ (#mes_stop) and hide the send
        //     button while a run is active, like a normal generation.
        //   - separate: a dedicated #sa_stop button beside ST's stop.
        // Toggle via globalSettings.useNativeStopButton.
        if (getGlobalSettings().useNativeStopButton) {
            initNativeStopButton();
        } else {
            initRunIndicator();
        }

        // UI: ReCast-style diff viewer — a per-message button that opens a
        // read-only inline diff of a rewrite agent's change, with revert.
        initDiffButtons();

        // User-facing slash commands (/sa-run, /sa-list, /sa-toggle, /sa-open).
        registerSlashCommands();

        // UI: State Card floating panel — registers a show/hide control on the
        // modal's Settings tab and refreshes itself after each post-gen run.
        initStateCard();

        // Phone module: diegetic texting. initPhoneAgent wires the
        // context-injection refresh (the lifecycle drives evaluation);
        // initPhonePanel builds the floating messenger and registers its
        // Settings control. Agent before panel: the panel queries phone state.
        initPhoneAgent();
        initPhonePanel();

        const { agents: agentStore } = window.SuperAgents;
        const agentCount = agentStore.getAll().length;
        debug(`loaded v0.8.0 — ${agentCount} agent(s) on disk; lifecycle engine active (pre/post-gen, batching, rewrite, swipe, phone); compat guard + state macros active; slash commands (/sa-run, /sa-list, /sa-toggle, /sa-open); per-turn cost hint; unified modal (manage + library + groups live) + State Card + Phone floating panels; renderers: World State, Continuity Check, Narrative Engine, Direction Menu, Parallel Off-Screen`);

        // Surface a one-time migration result so the user knows their VM agents
        // came across (or that there was a name collision to resolve manually).
        if (migration?.migrated) {
            const msg = `Imported ${migration.agents} agent(s)` +
                (migration.groups ? ` and ${migration.groups} group(s)` : '') +
                ' from VerseManager.';
            toastr.success(msg, 'SuperAgents', { timeOut: 8000 });
            debug(msg);
        }

        // Non-blocking: sync agents with any newer built-in templates.
        // Fails silently if template files aren't shipped yet.
        syncFromTemplates().then(updated => {
            if (updated.length > 0) {
                debug(`synced ${updated.length} agent(s) to newer template versions`);
            }
        }).catch(err => {
            debug(`${LOG_PREFIX} template sync failed:`, err);
        });
    } catch (err) {
        console.error(LOG_PREFIX, 'init failed:', err);
    }
});
