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
    getStateTransaction,
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
    runAgentOnLastMessage,
    runGroupOnMessage,
    runGroupOnLastMessage,
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
    getEnabledSetState,
    toggleEnabledAgentSet,
    isAgentPaused,
    setAgentPaused,
    toggleAgentPaused,
    onAgentPauseChange,
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
    isAgentsPaused,
    setAgentsPaused,
    toggleAgentsPaused,
    onAgentsPauseChange,
    // template instantiation (checkpoint helper)
    instantiateTemplate,
} from './src/data/store.js';
import { syncFromTemplates, listBuiltInTemplates } from './src/data/templateSync.js';
import { importAgents, exportAllAgents, exportAgent } from './src/data/importExport.js';
import { createPublicIntegrationApi } from './src/integration/publicApi.js';
import { initWeatherCycleIntegration } from './src/integration/weatherCycle.js';
import {
    createPresentationIntegrationApi,
    getActiveSurfacePresentation,
    initPresentationProfiles,
} from './src/presentation/presentationState.js';

// Render layer
import { initRenderer, registerRenderHook, refreshMessage } from './src/render/renderer.js';
import { renderWorldStateHud } from './src/render/hooks/worldStateHud.js';
import { renderContinuityCheck } from './src/render/hooks/continuityCheck.js';
import { renderNarrativeEngine } from './src/render/hooks/narrativeEngine.js';
import { renderParallelOffscreen } from './src/render/hooks/parallelOffscreen.js';
import { renderDirectionMenu, initDirectionMenuDelegation } from './src/render/hooks/directionMenuRenderer.js';
import { renderDirectorPlan } from './src/render/hooks/directorPlan.js';
import { renderSoundtrackSuggester } from './src/render/hooks/soundtrackSuggester.js';
import { renderArtPrompt } from './src/render/hooks/artPromptGenerator.js';
import { renderActorInterview } from './src/render/hooks/actorInterview.js';
import { renderCommentarySection } from './src/render/hooks/commentarySection.js';
import { renderGenericOutput } from './src/render/hooks/genericOutput.js';
import { renderWishLedger } from './src/render/hooks/wishLedger.js';
import { renderContinuityGuard, initContinuityGuardDelegation } from './src/render/hooks/continuityGuard.js';
import { initContinuityGuardRunner } from './src/modes/continuityGuardRunner.js';

// UI layer: unified management modal (Step 9)
import { openModal, closeModal, isModalOpen, registerPanelControl } from './src/ui/modal.js';
import { resolveAgentIcon, resolveGroupIcon } from './src/ui/iconResolver.js';
import { initRunIndicator } from './src/ui/runIndicator.js';
import { initNativeStopButton } from './src/ui/nativeStopButton.js';
import { initDiffButtons } from './src/ui/diffButton.js';
import { initWorldStateEditor } from './src/ui/worldStateEditor.js';
import { initSurfaceDock } from './src/ui/surfaceDock.js';
import {
    initStateCard,
    show as showStateCard,
    hide as hideStateCard,
    isOpen as isStateCardOpen,
    hasDisplayComponents as hasStateCardComponents,
    update as updateStateCard,
} from './src/ui/stateCard.js';

// Phone module (Step 9): diegetic texting logic + floating messenger panel
import {
    getAllThreads as getPhoneThreads,
    getThread as getPhoneThread,
    getTotalUnread as getPhoneUnread,
    initPhoneAgent,
    isPhoneEnabled,
    onPhoneActivity,
    requestCharacterText,
} from './src/phone/phoneAgent.js';
import {
    initPhonePanel,
    show as showPhone,
    hide as hidePhone,
    isOpen as isPhoneOpen,
    openThread as openPhoneThread,
} from './src/phone/phonePanel.js';

// Shared social Feed: branch-aware artifact logic + editorial floating panel
import {
    getFeedPost,
    getFeedConfig,
    getFeedState,
    initFeedAgent,
    isFeedEnabled,
    listFeedPosts,
    onFeedActivity,
    requestCharacterPost,
} from './src/feed/feedAgent.js';
import {
    initFeedPanel,
    show as showFeed,
    hide as hideFeed,
    isOpen as isFeedOpen,
    openPost as openFeedPost,
} from './src/feed/feedPanel.js';

// Calendar presentation over setting-neutral, branch-aware Commitments.
import {
    createCommitmentsIntegrationApi,
    getCommitment,
    initCommitments,
    listCommitments,
    onCommitmentActivity,
} from './src/commitments/commitments.js';
import {
    getUnread as getCalendarUnread,
    hide as hideCalendar,
    initCalendarPanel,
    isOpen as isCalendarOpen,
    openCommitment,
    show as showCalendar,
} from './src/commitments/calendarPanel.js';

// Shared Activity spine: optional artifact index + source-linked notifications.
import {
    createActivityIntegrationApi,
    initActivityHub,
    registerActivitySource,
} from './src/activity/activityHub.js';
import {
    getUnread as getNotificationsUnread,
    hide as hideNotifications,
    initNotificationsPanel,
    isOpen as isNotificationsOpen,
    show as showNotifications,
} from './src/activity/notificationsPanel.js';

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
        version: '0.42.7',

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
            getEnabledSetState,
            toggleEnabledSet: toggleEnabledAgentSet,
            isAgentPaused,
            setAgentPaused,
            toggleAgentPaused,
            onAgentPauseChange,
            runOnLast:     runAgentOnLastMessage,
            isPaused:      isAgentsPaused,
            setPaused:     setAgentsPaused,
            togglePaused:  toggleAgentsPaused,
            onPauseChange: onAgentsPauseChange,
            createDefault: createDefaultAgent,
        },

        // Group CRUD
        groups: {
            getAll:        getGroups,
            getById:       getGroupById,
            save:          saveGroup,
            delete:        deleteGroup,
            toggle:        toggleGroup,
            runOnMessage:  runGroupOnMessage,
            runOnLast:     runGroupOnLastMessage,
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
            getTransaction: getStateTransaction,
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
            runOnLast:       runAgentOnLastMessage,
            runGroup:        runGroupOnMessage,
            runGroupOnLast:  runGroupOnLastMessage,
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

        // Stable contract for optional integrations such as Dynamic Events.
        // Feature-detect apiVersion; never import SuperAgents internals.
        integration: createPublicIntegrationApi({
            phone: {
                isEnabled: isPhoneEnabled,
                getThread: getPhoneThread,
                listThreads: getPhoneThreads,
                requestText: requestCharacterText,
            },
            feed: {
                isEnabled: isFeedEnabled,
                listPosts: listFeedPosts,
                getPost: getFeedPost,
                requestPost: requestCharacterPost,
            },
            calendar: createCommitmentsIntegrationApi(),
            activity: createActivityIntegrationApi(),
            presentation: createPresentationIntegrationApi(),
        }),

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
            feed: {
                init: initFeedPanel,
                show: showFeed,
                hide: hideFeed,
            },
            calendar: {
                init: initCalendarPanel,
                show: showCalendar,
                hide: hideCalendar,
            },
            notifications: {
                init: initNotificationsPanel,
                show: showNotifications,
                hide: hideNotifications,
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

        // Macro handlers read current chat state at expansion time. Structural
        // changes (new/renamed agents) are refreshed when the editor saves.
        initMacros();

        // Render layer: register hooks, then start the DOM observer.
        registerRenderHook('ws-hud-data', renderWorldStateHud);
        registerRenderHook('cc-check-data', renderContinuityCheck);
        registerRenderHook('ne-engine-data', renderNarrativeEngine);
        registerRenderHook('parallel-hud-data', renderParallelOffscreen);
        registerRenderHook('dm-menu-data', renderDirectionMenu);
        registerRenderHook('director-plan-data', renderDirectorPlan);
        registerRenderHook('soundtrack-suggester-data', renderSoundtrackSuggester);
        registerRenderHook('art-prompt-data', renderArtPrompt);
        registerRenderHook('actor-interview-data', renderActorInterview);
        registerRenderHook('commentary-section-data', renderCommentarySection);
        registerRenderHook('sa-generic-output-data', renderGenericOutput);
        registerRenderHook('sa-wish-ledger-data', renderWishLedger);
        registerRenderHook('continuity-guard-data', renderContinuityGuard);
        // Direction Menu uses delegated click handling on #chat; install it up
        // front (idempotent + self-retries if #chat isn't in the DOM yet).
        initDirectionMenuDelegation();
        // Continuity Guard's flag is clickable; bind its delegated handler too.
        initContinuityGuardDelegation();
        initRenderer();
        initWorldStateEditor();

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

        // Continuity Guard: post-gen deterministic detection + every-N sweep.
        // Runs after each post-gen turn, no-ops unless a Continuity Guard agent
        // AND a State Card agent are enabled with real tracked state. Wired to
        // the same post-process completion hook the State Card + macros use.
        // Its click-driven repair reuses the rewrite/diff/revert machinery, so
        // a confirmed fix lights up the diff button above automatically.
        initContinuityGuardRunner(onPostProcessComplete);

        // User-facing slash commands (/sa-run, /sa-list, /sa-toggle, /sa-open).
        registerSlashCommands();

        // UI: State Card floating panel — registers a show/hide control on the
        // modal's Settings tab and refreshes itself after each post-gen run.
        initStateCard();

        // Phone module: diegetic texting. initPhoneAgent wires the
        // context-injection refresh (the lifecycle drives evaluation);
        // initPhonePanel builds the floating messenger and registers its
        // Settings control. Agent before panel: the panel queries phone state.
        initPresentationProfiles();
        initPhoneAgent();
        initFeedAgent();
        initCommitments();
        initActivityHub({
            phone: { onActivity: onPhoneActivity, listThreads: getPhoneThreads },
            feed: { onActivity: onFeedActivity, listPosts: listFeedPosts },
            calendar: { onActivity: onCommitmentActivity, listCommitments },
        });
        initPhonePanel();
        initFeedPanel();
        initCalendarPanel();
        registerActivitySource('phone', {
            isAvailable: () => isPhoneEnabled()
                && getActiveSurfacePresentation('phone')?.capabilities?.available !== false,
            open: artifact => {
                const character = artifact.context?.character;
                const thread = getPhoneThread(character);
                if (!thread?.messages?.some(message => message.id === artifact.sourceId)) return false;
                return openPhoneThread(character);
            },
        });
        registerActivitySource('feed', {
            isAvailable: () => isFeedEnabled()
                && getActiveSurfacePresentation('feed')?.capabilities?.available !== false,
            open: artifact => getFeedPost(artifact.sourceId)
                ? openFeedPost(artifact.sourceId)
                : false,
        });
        registerActivitySource('calendar', {
            isAvailable: () => getActiveSurfacePresentation('calendar')?.capabilities?.available !== false,
            open: artifact => getCommitment(artifact.sourceId)
                ? openCommitment(artifact.sourceId)
                : false,
        });
        initNotificationsPanel();
        initSurfaceDock([
            {
                id: 'state-card',
                label: 'State Card',
                icon: 'fa-id-card',
                tone: 'state-card',
                isAvailable: hasStateCardComponents,
                isOpen: isStateCardOpen,
                getUnread: () => 0,
                toggle: () => (isStateCardOpen() ? hideStateCard(false) : showStateCard(false)),
            },
            {
                id: 'notifications',
                getLabel: () => getActiveSurfacePresentation('notifications')?.label || 'Notifications',
                getIcon: () => getActiveSurfacePresentation('notifications')?.icon || 'fa-bell',
                getTone: () => getActiveSurfacePresentation('notifications')?.tone || 'notifications',
                isAvailable: () => getGlobalSettings().showNotificationsLauncher !== false
                    && getActiveSurfacePresentation('notifications')?.capabilities?.available !== false,
                isOpen: isNotificationsOpen,
                getUnread: getNotificationsUnread,
                toggle: () => (isNotificationsOpen() ? hideNotifications(false) : showNotifications(false)),
            },
            {
                id: 'phone',
                getLabel: () => getActiveSurfacePresentation('phone')?.label || 'Phone',
                getIcon: () => getActiveSurfacePresentation('phone')?.icon || 'fa-comment-dots',
                getTone: () => getActiveSurfacePresentation('phone')?.tone || 'phone',
                isAvailable: () => isPhoneEnabled()
                    && getActiveSurfacePresentation('phone')?.capabilities?.available !== false,
                isOpen: isPhoneOpen,
                getUnread: getPhoneUnread,
                toggle: () => (isPhoneOpen() ? hidePhone(false) : showPhone(false)),
            },
            {
                id: 'feed',
                getLabel: () => {
                    const configured = String(getFeedConfig()?.appName || '').trim();
                    return configured && configured !== 'Twatter'
                        ? configured
                        : (getActiveSurfacePresentation('feed')?.title || configured || 'Twatter');
                },
                getIcon: () => getActiveSurfacePresentation('feed')?.icon || 'fa-feather-pointed',
                getTone: () => getActiveSurfacePresentation('feed')?.tone || 'feed',
                isAvailable: () => isFeedEnabled()
                    && getActiveSurfacePresentation('feed')?.capabilities?.available !== false,
                isOpen: isFeedOpen,
                getUnread: () => getFeedState().unread,
                toggle: () => (isFeedOpen() ? hideFeed(false) : showFeed(false)),
            },
            {
                id: 'calendar',
                getLabel: () => getActiveSurfacePresentation('calendar')?.label || 'Calendar',
                getIcon: () => getActiveSurfacePresentation('calendar')?.icon || 'fa-calendar-day',
                getTone: () => getActiveSurfacePresentation('calendar')?.tone || 'calendar',
                isAvailable: () => getGlobalSettings().showCalendarLauncher !== false
                    && getActiveSurfacePresentation('calendar')?.capabilities?.available !== false,
                isOpen: isCalendarOpen,
                getUnread: getCalendarUnread,
                toggle: () => (isCalendarOpen() ? hideCalendar(false) : showCalendar(false)),
            },
        ]);
        initWeatherCycleIntegration();

        const { agents: agentStore } = window.SuperAgents;
        const agentCount = agentStore.getAll().length;
        debug(`loaded v0.42.7 — ${agentCount} agent(s) on disk; every-N memory agents can retain branch-aware snapshots as reference-only context between provider calls; chat hydration and first-card greetings cannot trigger automatic post agents, and chat changes invalidate queued or in-flight tracker commits before teardown; World State v11 is grounded by active lore and recent history, supports validated branch corrections, and can optionally synchronize eligible snapshots plus exact Afternoon/Twilight lighting to Weather Cycle, including temporary manual visual overrides that yield to the next World State commit, editable overlay colors, and chronological phase controls; Social Web Ledger explicitly excludes current and prior player personas in solo and batched prompts and filters persona-linked edges at commit time so Relationship Ledger remains authoritative; grouped trackers use an unambiguous JSON-envelope contract and recover renamed keys or task-local tagged blocks before schema validation; structured classifiers recover schema-valid bare JSON and use reasoning-safe output budgets; post-agent jobs are coalesced, tracker commits yield cooperatively, branch-aware Story surfaces cache their visible path, and post-run timings separate model wait from synchronous finalization; deferred fresh-state gates plus staged Prompt Base / Prompt NSFW classifiers are available; initialization and one-shot lifecycle policies remain available; hidden Story App rendering is deferred and State Card refreshes are coalesced; lifecycle engine active; validated transactional state + fail-closed knowledge capability API active; relationship/social-web/knowledge ledgers available; Activity + source-linked Notifications active; adapter-ready branch-aware Calendar/Commitments with deletion-safe rescheduling and passive canonical story-plan capture available; Modern, Cute Retro, Retro Analog, Gamer Modern, Grounded Historical, Historical Fantasy, Xianxia, Post-Apocalyptic, and Near Future presentation profiles drive all story surfaces and Dynamic Events vocabulary through stable IDs; eleven State Card appearance choices include presentation matching and the dark Story Ledger alongside all earlier skins; branch-safe Knowledge controls, compat guard, state macros, slash commands, and route-based agent editor available`);

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
