/** Branch-aware World Threads utility and proposal lifecycle. */

import { chat, saveChatDebounced, saveSettingsDebounced } from '../../../../../../script.js';
import { eventSource, event_types } from '../../../../../events.js';
import { extension_settings } from '../../../../../extensions.js';
import { MODULE_NAME, debug } from '../core/runtime.js';
import { getEnabledAgents, onStoreChange } from '../data/store.js';
import { readMergeArray, storeBatchedSidecarResult } from '../modes/mergeVariable.js';
import { findLastAssistantIndex, onPostProcessComplete, onRunStateChange, runAgentOnLastMessage } from '../core/lifecycle.js';
import { SUPERAGENTS_EVENTS } from '../integration/events.js';
import { makeDraggablePanel, mountDraggablePanel } from '../ui/draggablePanel.js';
import { isStoryChatOpen } from '../ui/chatPresence.js';
import { refreshSurfaceDock } from '../ui/surfaceDock.js';
import { resolveSurfaceVisibility, setSurfaceVisibility } from '../ui/surfaceVisibilityState.js';
import {
    acceptWorldEvent,
    dismissWorldEventProposals,
    readWorldEventState,
    removeWorldEvent,
    removeWorldEventHistory,
    resolveWorldEvent,
    updateWorldEvent,
    worldEventProposalKey,
} from './worldEventState.js';
import { readWorldThreadEditor, renderWorldThreads } from './worldThreadsView.js';

const LOG_PREFIX = '[SuperAgents/worldEvents]';
const VARIABLE_NAME = 'sa_world_events';
const PANEL_ID = 'world-threads';
const CSS_HREF = '/scripts/extensions/third-party/SillyTavern-SuperAgents/src/worldEvents/worldEvents.css?v=0.45.0';

let initialized = false;
let panelEl = null;
let controller = null;
let pendingCommit = null;
let runActive = false;
let lastPresentedKey = '';
let activeTab = 'active';
let editingId = '';

function getWorldEventsAgent(agentId = '') {
    const candidates = getEnabledAgents().filter(agent => agent.worldEventsConfig?.enabled
        || agent.sourceTemplateId === 'tpl-world-events'
        || agent.mergeVariable?.variableName === VARIABLE_NAME);
    return (agentId ? candidates.find(agent => agent.id === agentId) : candidates[0]) ?? null;
}

function currentContext(agentId = '', messageIndexOverride = null) {
    const agent = getWorldEventsAgent(agentId);
    const messageIndex = Number.isInteger(messageIndexOverride) ? messageIndexOverride : findLastAssistantIndex();
    return {
        agent,
        messageIndex,
        message: messageIndex >= 0 ? chat[messageIndex] : null,
        state: readWorldEventState(readMergeArray(agent?.mergeVariable?.variableName || VARIABLE_NAME)),
    };
}

function maxRoster(agent) {
    return Math.min(8, Math.max(1, Math.floor(Number(agent?.worldEventsConfig?.maxRoster) || 8)));
}

function persistedVisible() {
    return !!extension_settings[MODULE_NAME]?.worldThreadsVisible;
}

function persistVisible(value) {
    const root = extension_settings[MODULE_NAME] ?? (extension_settings[MODULE_NAME] = {});
    root.worldThreadsVisible = !!value;
    saveSettingsDebounced();
}

function injectStylesheet() {
    if (document.querySelector('link[data-sa-world-events]')) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = CSS_HREF;
    link.setAttribute('data-sa-world-events', '');
    document.head.appendChild(link);
}

function commitState(context, state) {
    if (!context.agent || !context.message || chat[context.messageIndex] !== context.message) return false;
    const stored = storeBatchedSidecarResult(
        context.agent,
        state,
        context.message,
        context.messageIndex,
        'world_events_user',
    );
    if (!stored) return false;
    saveChatDebounced();
    render();
    refreshSurfaceDock();
    return true;
}

function render() {
    if (!panelEl || !controller?.isOpen()) return;
    const context = currentContext();
    renderWorldThreads(panelEl, {
        state: context.state,
        tab: activeTab,
        maxRoster: maxRoster(context.agent),
        editingId,
    });
    const generate = panelEl.querySelector('[data-action="generate"]');
    if (generate) {
        generate.disabled = runActive || !context.agent || context.messageIndex < 0;
        generate.innerHTML = runActive
            ? '<i class="fa-solid fa-circle-notch fa-spin"></i><span>Generating…</span>'
            : `<i class="fa-solid fa-wand-magic-sparkles"></i><span>${context.state.proposals.length ? 'Refresh' : 'Generate'}</span>`;
    }
}

async function generateSuggestions() {
    const context = currentContext();
    if (runActive || !context.agent || context.messageIndex < 0) return;
    await runAgentOnLastMessage(context.agent.id);
}

function handleAction(button) {
    const context = currentContext();
    const action = button.dataset.action;
    const eventId = button.dataset.eventId || '';
    if (action === 'close') return hide(false);
    if (action === 'generate') return generateSuggestions();
    if (action === 'cancel-edit') {
        editingId = '';
        return render();
    }
    if (!context.agent || !context.message) return;

    if (action === 'accept') {
        const proposal = context.state.proposals[Number(button.dataset.proposalIndex)];
        const result = acceptWorldEvent(context.state, proposal, context.messageIndex, maxRoster(context.agent));
        if (result.reason === 'full') return toastr.warning('Resolve or remove an active thread first.', 'World Threads');
        if (!commitState(context, result.state)) return;
        activeTab = 'active';
        toastr.success(result.accepted ? `“${proposal.title}” is now active.` : 'That thread is already active.', 'World Threads');
        return render();
    }
    if (action === 'dismiss') {
        if (commitState(context, dismissWorldEventProposals(context.state))) render();
        return;
    }
    if (action === 'edit') {
        editingId = eventId;
        return render();
    }
    if (action === 'resolve') {
        editingId = '';
        if (commitState(context, resolveWorldEvent(context.state, eventId, context.messageIndex))) render();
        return;
    }
    if (action === 'remove') {
        const item = context.state.roster.find(event => event.id === eventId);
        if (item && confirm(`Erase “${item.title}” from this story branch?`)) {
            editingId = '';
            if (commitState(context, removeWorldEvent(context.state, eventId))) render();
        }
        return;
    }
    if (action === 'remove-history') {
        const item = context.state.history.find(event => event.id === eventId);
        if (item && confirm(`Erase “${item.title}” from World Threads history?`)) {
            if (commitState(context, removeWorldEventHistory(context.state, eventId))) render();
        }
    }
}

function buildPanel() {
    injectStylesheet();
    panelEl = document.createElement('section');
    panelEl.id = 'sa-world-threads-panel';
    panelEl.className = 'sa-wt-panel';
    panelEl.setAttribute('aria-label', 'World Threads utility');
    panelEl.innerHTML = `
        <header class="sa-wt-header" title="Drag to move">
            <div class="sa-wt-brand">
                <small>AUTHOR UTILITY</small><strong>World Threads</strong>
            </div>
            <div class="sa-wt-header-actions" data-no-drag>
                <button class="sa-wt-generate" data-action="generate" type="button" title="Generate fresh World Events suggestions"><i class="fa-solid fa-wand-magic-sparkles"></i><span>Generate</span></button>
                <button data-action="close" type="button" title="Hide" aria-label="Close World Threads"><i class="fa-solid fa-xmark"></i></button>
            </div>
        </header>
        <nav class="sa-wt-tabs" role="tablist" aria-label="World Threads views">
            <button data-no-drag data-tab="active" type="button"><span>Active</span><b data-tab-count="active">0</b></button>
            <button data-no-drag data-tab="suggestions" type="button"><span>Suggestions</span><b data-tab-count="suggestions">0</b></button>
            <button data-no-drag data-tab="history" type="button"><span>History</span><b data-tab-count="history">0</b></button>
        </nav>
        <main class="sa-wt-body"></main>
        <div class="sa-wt-knowledge"><i class="fa-solid fa-eye-slash"></i> Author knowledge only until the story establishes awareness.</div>`;
    mountDraggablePanel(panelEl);
    controller = makeDraggablePanel(panelEl, {
        id: PANEL_ID,
        handle: '.sa-wt-header',
        defaultAnchor: 'top-right',
        snapToEdges: true,
        resizable: true,
        minW: 390,
        minH: 420,
    });

    panelEl.addEventListener('click', event => {
        const tab = event.target.closest('[data-tab]');
        if (tab) {
            activeTab = tab.dataset.tab;
            editingId = '';
            render();
            return;
        }
        const action = event.target.closest('[data-action]');
        if (action) handleAction(action);
    });
    panelEl.addEventListener('submit', event => {
        const form = event.target.closest('.sa-wt-editor');
        if (!form) return;
        event.preventDefault();
        const context = currentContext();
        const next = updateWorldEvent(context.state, form.dataset.eventId, readWorldThreadEditor(form));
        editingId = '';
        if (commitState(context, next)) render();
    });
}

function reconcile() {
    if (!controller) return;
    if (!isAvailable()) {
        controller.hide();
    } else if (resolveSurfaceVisibility(PANEL_ID, persistedVisible())) {
        controller.show();
        render();
    } else {
        controller.hide();
    }
    refreshSurfaceDock();
}

function tryPresent(commit = pendingCommit) {
    if (runActive || !commit) return;
    pendingCommit = null;
    const context = currentContext(commit.agentId, Number(commit.messageIndex));
    if (!context.agent || context.agent.mergeVariable?.variableName !== commit.variableName) return;
    const key = worldEventProposalKey(context.state, context.messageIndex, context.message?.swipe_id ?? 0);
    if (!key || key === lastPresentedKey) return;
    lastPresentedKey = key;
    activeTab = 'suggestions';
    editingId = '';
    show(false);
}

function queueCurrentState(messageIndex = findLastAssistantIndex()) {
    const agent = getWorldEventsAgent();
    if (!agent || messageIndex < 0) return;
    pendingCommit = {
        agentId: agent.id,
        variableName: agent.mergeVariable?.variableName || VARIABLE_NAME,
        messageIndex,
    };
    setTimeout(() => tryPresent(), 0);
}

export function initWorldEventsAgent() {
    if (initialized) return;
    initialized = true;
    buildPanel();
    globalThis.addEventListener(SUPERAGENTS_EVENTS.STATE_COMMITTED, event => {
        const detail = event?.detail;
        if (!detail || detail.source === 'world_events_user' || !getWorldEventsAgent(detail.agentId)) return;
        pendingCommit = detail;
        setTimeout(() => tryPresent(), 0);
    });
    onRunStateChange(active => {
        runActive = active;
        render();
        if (!active) setTimeout(() => tryPresent(), 0);
    });
    onPostProcessComplete(messageIndex => queueCurrentState(messageIndex));
    onStoreChange(reconcile);
    const onBranchChanged = () => {
        lastPresentedKey = '';
        editingId = '';
        render();
        refreshSurfaceDock();
    };
    if (event_types.MESSAGE_SWIPED) eventSource.on(event_types.MESSAGE_SWIPED, onBranchChanged);
    if (event_types.MESSAGE_DELETED) eventSource.on(event_types.MESSAGE_DELETED, () => {
        pendingCommit = null;
        onBranchChanged();
    });
    eventSource.on(event_types.CHAT_CHANGED, () => {
        pendingCommit = null;
        lastPresentedKey = '';
        editingId = '';
        reconcile();
    });
    reconcile();
    debug(`${LOG_PREFIX} World Threads utility initialized`);
}

export function show(persist = true) {
    if (!controller) return;
    if (persist) persistVisible(true);
    if (isStoryChatOpen()) setSurfaceVisibility(PANEL_ID, true);
    if (!isAvailable()) return controller.hide();
    controller.show();
    render();
    refreshSurfaceDock();
}

export function hide(persist = true) {
    if (persist) persistVisible(false);
    if (isStoryChatOpen()) setSurfaceVisibility(PANEL_ID, false);
    controller?.hide();
    refreshSurfaceDock();
}

export function isOpen() {
    return !!controller?.isOpen();
}

export function isAvailable() {
    return isStoryChatOpen() && !!getWorldEventsAgent();
}

export function getUnread() {
    return isAvailable() ? currentContext().state.proposals.length : 0;
}
