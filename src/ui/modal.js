/**
 * ui/modal.js — the unified SuperAgents management modal.
 *
 * One modal replaces VerseManager's four scattered surfaces (editor modal,
 * group modal, library tab, manage tab). Structure mirrors the user's
 * SimpleSummarizer / LandingPageRedux modal: a persistent DOM tree created
 * once and reused, a 56px icon rail on the left, and a content pane on the
 * right that re-renders per tab.
 *
 * Tabs (icon rail):
 *   - manage   → agent list, toggles, run/delete/export, import
 *   - groups   → group list, toggles, delete, and create/edit groups
 *               (group editor is an in-pane sub-view)
 *   - library  → browse + instantiate built-in templates
 *   - settings → global settings + floating-panel show/hide toggles
 *
 * Editing a single agent opens an EDITOR sub-view inside the content pane
 * (not a separate modal) — wired in the editor port step.
 *
 * Floating panels (State Card, Phone) don't live in this modal; they're
 * draggable widgets (ui/draggablePanel.js). The Settings tab exposes
 * show/hide + reset-position for whatever panels register via
 * registerPanelControl(), so the modal stays decoupled from panels that
 * land in later steps.
 *
 * CSS prefix: sam- (super-agents modal). Shared tokens come from style.css.
 */

import { MODULE_NAME, debug } from '../../index.js';
import {
    getAgents,
    getAgentById,
    toggleAgent,
    toggleAgentPaused,
    deleteAgent,
    deleteAgents,
    setAgentsEnabled,
    getGlobalSettings,
    setGlobalSettings,
    getGroups,
    getGroupById,
    deleteGroup,
    toggleGroup,
    instantiateTemplate,
} from '../data/store.js';
import { AGENT_CATEGORIES } from '../data/normalize.js';
import { readMergeArray, clearAgentChatState } from '../modes/mergeVariable.js';
import { resolveAgentIcon, resolveGroupIcon } from './iconResolver.js';
import { listBuiltInTemplates } from '../data/templateSync.js';
import { importAgents, exportAllAgents, exportAgent } from '../data/importExport.js';
import { runAgentOnLastMessage, runGroupOnLastMessage, rerollAgentPreGen } from '../core/lifecycle.js';
import { renderAgentEditor } from './editor.js';
import { renderGroupEditor } from './groupEditor.js';
import { initCardTooltips } from './cardTooltip.js';
import { samConfirm } from './confirmDialog.js';
import { makeModalDraggable } from './draggableModal.js';
import {
    clearAgentSelection,
    getAgentSelectionState,
    getSelectedAgentIds,
    setAgentSelected,
    setAllAgentsSelected,
} from './agentSelection.js';
import { listPresentationProfiles } from '../presentation/profileCatalog.js';
import {
    getPresentationProfileId,
    setPresentationProfile,
} from '../presentation/presentationState.js';
import {
    getStateCardStyleId,
    setStateCardStyle,
    STATE_CARD_STYLE_OPTIONS,
} from '../presentation/stateCardAppearance.js';
import { resetSurfaceDockPosition } from './surfaceDockPosition.js';
import { refreshSurfaceDock } from './surfaceDock.js';
import {
    isWeatherCycleInstalled,
    syncWeatherCycleIntegration,
} from '../integration/weatherCycle.js';
import { listConnectionProfiles } from '../core/profiles.js';

const LOG_PREFIX = '[SuperAgents/modal]';

const OVERLAY_ID = 'sam-overlay';
const MODAL_ID = 'sam-modal';

const TABS = [
    { id: 'manage',   icon: 'fa-robot',        label: 'Agents' },
    { id: 'groups',   icon: 'fa-layer-group',  label: 'Groups' },
    { id: 'library',  icon: 'fa-book-open',    label: 'Library' },
    { id: 'settings', icon: 'fa-gear',         label: 'Settings' },
];

// ============================================================================
// STATE
// ============================================================================

let isOpen = false;
let activeTab = 'manage';
let draggableModal = null;

// Editor sub-view state. When editorOpen is true, the content pane shows the
// agent editor instead of the active tab. editingAgentId null = new agent.
let editorOpen = false;
let editingAgentId = null;

// Group-editor sub-view state. When groupEditorOpen is true, the content pane
// shows the group editor instead of the active tab. editingGroupId null = new.
let groupEditorOpen = false;
let editingGroupId = null;

/**
 * Registered floating-panel controls, surfaced as toggles in the Settings tab.
 * Each: { id, label, getLabel, icon, getIcon, controller } where controller is the object
 * returned by makeDraggablePanel ({ show, hide, toggle, isOpen,
 * isDefaultVisible, isAvailable, resetPosition }).
 * @type {Map<string, {id:string,label:string,getLabel?:Function,icon:string,getIcon?:Function,controller:object}>}
 */
const panelControls = new Map();

/**
 * Register a floating panel so the Settings tab can show/hide/reset it.
 * Called by the State Card and Phone modules as they initialize.
 * @param {{id:string,label?:string,getLabel?:Function,icon?:string,getIcon?:Function,controller:object}} entry
 */
export function registerPanelControl(entry) {
    if (!entry?.id || !entry?.controller) return;
    panelControls.set(entry.id, {
        id: entry.id,
        label: entry.label || entry.id,
        getLabel: entry.getLabel,
        icon: entry.icon || 'fa-window-maximize',
        getIcon: entry.getIcon,
        controller: entry.controller,
    });
    // If Settings is currently visible, reflect the new control immediately.
    if (isOpen && activeTab === 'settings') renderContent();
}

/**
 * Re-sync every registered panel to current agent state, then repaint the
 * Settings tab so panel toggles reflect availability. Called after an agent is
 * enabled/disabled (or added/removed) so a panel whose agent just went away
 * hides itself, and one whose agent just came back can reappear (per its own
 * persisted intent). Each controller may expose reconcile() for the first half;
 * panels without it are simply left as-is.
 */
export function reconcilePanels() {
    for (const c of panelControls.values()) {
        c.controller.reconcile?.();
    }
    if (isOpen && activeTab === 'settings') renderContent();
}

// ============================================================================
// OPEN / CLOSE
// ============================================================================

/**
 * Open the modal (optionally to a specific tab). Idempotent: if already open,
 * just switches tab and re-renders.
 * @param {string|null} [tab]
 */
export function openModal(tab = null) {
    if (tab && TABS.some(t => t.id === tab)) activeTab = tab;

    if (isOpen) {
        renderContent();
        return;
    }

    isOpen = true;
    ensureModalDOM();
    renderContent();

    requestAnimationFrame(() => {
        document.getElementById(OVERLAY_ID)?.classList.add('sam-visible');
        document.getElementById(MODAL_ID)?.classList.add('sam-visible');
        requestAnimationFrame(() => draggableModal?.clamp());
    });

    debug(`${LOG_PREFIX} opened (tab: ${activeTab})`);
}

/** Close the modal (DOM is kept for reuse). */
export function closeModal() {
    if (!isOpen) return;
    document.getElementById(OVERLAY_ID)?.classList.remove('sam-visible');
    document.getElementById(MODAL_ID)?.classList.remove('sam-visible');
    clearAgentSelection();
    isOpen = false;
    debug(`${LOG_PREFIX} closed`);
}

/** @returns {boolean} */
export function isModalOpen() {
    return isOpen;
}

// ============================================================================
// DOM CREATION (persistent — built once, reused)
// ============================================================================

function ensureModalDOM() {
    if (document.getElementById(MODAL_ID)) return;

    const overlay = document.createElement('div');
    overlay.id = OVERLAY_ID;
    overlay.className = 'sam-overlay';
    overlay.addEventListener('click', closeModal);
    document.body.appendChild(overlay);

    const modal = document.createElement('div');
    modal.id = MODAL_ID;
    modal.className = 'sam-modal';
    modal.innerHTML = `
        <div class="sam-header">
            <div class="sam-title"><i class="fa-solid fa-people-group"></i> SuperAgents</div>
            <div class="sam-close" id="sam-close" title="Close (Esc)"><i class="fa-solid fa-xmark"></i></div>
        </div>
        <div class="sam-body">
            <div class="sam-rail" id="sam-rail"></div>
            <div class="sam-content" id="sam-content"></div>
        </div>
    `;
    document.body.appendChild(modal);

    draggableModal = makeModalDraggable(modal, modal.querySelector('.sam-header'), {
        prefix: 'sam-modal',
        visibleClass: 'sam-visible',
        ignoreSelector: '.sam-close',
    });

    modal.querySelector('#sam-close')?.addEventListener('click', closeModal);
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && isOpen) closeModal();
    });

    // Reveal full text of truncated card names / descriptions on hover.
    initCardTooltips(modal);
}

// ============================================================================
// ICON RAIL + CONTENT ROUTER
// ============================================================================

function renderRail() {
    const rail = document.getElementById('sam-rail');
    if (!rail) return;

    rail.innerHTML = TABS.map(t => `
        <div class="sam-rail-item ${t.id === activeTab ? 'sam-rail-active' : ''}" data-tab="${t.id}" title="${t.label}">
            <i class="fa-solid ${t.icon}"></i>
        </div>
    `).join('');

    rail.querySelectorAll('.sam-rail-item').forEach(el => {
        el.addEventListener('click', () => {
            editorOpen = false;       // leave the editor sub-view on any tab switch
            editingAgentId = null;
            groupEditorOpen = false;  // and the group editor sub-view
            editingGroupId = null;
            activeTab = el.dataset.tab;
            renderContent();
        });
    });
}

function renderContent() {
    renderRail();
    const content = document.getElementById('sam-content');
    if (!content) return;

    // Editor sub-view takes over the content pane when open.
    if (editorOpen) {
        renderAgentEditor(content, editingAgentId, {
            onSaved: () => { editorOpen = false; editingAgentId = null; activeTab = 'manage'; renderContent(); },
            onCancel: () => { editorOpen = false; editingAgentId = null; renderContent(); },
        });
        return;
    }

    // Group-editor sub-view likewise takes over the content pane when open.
    if (groupEditorOpen) {
        renderGroupEditor(content, editingGroupId, {
            onSaved: () => { groupEditorOpen = false; editingGroupId = null; activeTab = 'groups'; renderContent(); },
            onCancel: () => { groupEditorOpen = false; editingGroupId = null; activeTab = 'groups'; renderContent(); },
        });
        return;
    }

    switch (activeTab) {
        case 'manage':   renderManageTab(content); break;
        case 'groups':   renderGroupsTab(content); break;
        case 'library':  renderLibraryTab(content); break;
        case 'settings': renderSettingsTab(content); break;
        default:         renderManageTab(content);
    }
}

// ============================================================================
// TAB: MANAGE  (agents list)
// ============================================================================

function renderManageTab(container) {
    const agents = getAgents();
    const agentIds = agents.map(agent => agent.id);
    const selectionState = getAgentSelectionState(agentIds);
    const selectedIds = getSelectedAgentIds();
    const selectedAgents = agents.filter(agent => selectedIds.has(agent.id));
    const selectedAgentsEnabled = selectedAgents.length > 0 && selectedAgents.every(agent => agent.enabled);
    const selectionLabel = selectionState.allSelected ? 'Deselect all agents' : 'Select all agents';
    const enableLabel = selectedAgentsEnabled ? 'Disable selected agents' : 'Enable selected agents';

    const agentCards = agents.length === 0
        ? `<div class="sam-empty"><i class="fa-solid fa-robot"></i><p>No agents yet. Create one, or instantiate a built-in from the Library.</p></div>`
        : agents.map(agent => renderAgentCard(agent, selectedIds.has(agent.id))).join('');

    container.innerHTML = `
        <div class="sam-tab-head">
            <div class="sam-tab-title">Agents</div>
            <div class="sam-tab-actions sam-agent-toolbar">
                <button class="sam-toolbar-btn sam-select-all-agents ${selectionState.selectedCount ? 'active' : ''} ${selectionState.partiallySelected ? 'partial' : ''}" data-act="select-all-agents" title="${selectionLabel}" aria-label="${selectionLabel}" aria-pressed="${selectionState.allSelected ? 'true' : selectionState.partiallySelected ? 'mixed' : 'false'}" ${selectionState.total ? '' : 'disabled'}><i class="fa-solid ${selectionState.allSelected ? 'fa-square-minus' : 'fa-list-check'}" aria-hidden="true"></i></button>
                <button class="sam-toolbar-btn sam-enable-selected-agents ${selectedAgentsEnabled ? 'active' : ''}" data-act="toggle-selected-agents" title="${selectionState.selectedCount ? enableLabel : 'Select agents to enable or disable'}" aria-label="${selectionState.selectedCount ? enableLabel : 'Select agents to enable or disable'}" ${selectionState.selectedCount ? '' : 'disabled'}><i class="fa-solid ${selectedAgentsEnabled ? 'fa-toggle-on' : 'fa-toggle-off'}" aria-hidden="true"></i></button>
                ${selectionState.selectedCount ? `<button class="sam-toolbar-btn sam-toolbar-danger" data-act="delete-selected-agents" title="Delete ${selectionState.selectedCount} selected agent${selectionState.selectedCount === 1 ? '' : 's'}" aria-label="Delete ${selectionState.selectedCount} selected agent${selectionState.selectedCount === 1 ? '' : 's'}"><i class="fa-solid fa-trash" aria-hidden="true"></i><span class="sam-toolbar-count">${selectionState.selectedCount}</span></button>` : ''}
                <span class="sam-toolbar-divider" aria-hidden="true"></span>
                <button class="sam-toolbar-btn sam-toolbar-accent" data-act="new-agent" title="New agent" aria-label="New agent"><span class="sam-add-glyph" aria-hidden="true"><i class="fa-solid fa-robot"></i><i class="fa-solid fa-plus sam-add-mark"></i></span></button>
                <button class="sam-toolbar-btn" data-act="import" title="Import agents from JSON" aria-label="Import agents from JSON"><i class="fa-solid fa-file-import" aria-hidden="true"></i></button>
                <button class="sam-toolbar-btn" data-act="export-all" title="Export all agents" aria-label="Export all agents"><i class="fa-solid fa-file-export" aria-hidden="true"></i></button>
            </div>
        </div>

        <div class="sam-divider-label"><i class="fa-solid fa-robot"></i> Agents</div>
        <div class="sam-list" id="sam-agent-list">${agentCards}</div>
    `;

    bindManageTab(container);
}

// ============================================================================
// TAB: GROUPS  (group list)
// ============================================================================

function renderGroupsTab(container) {
    const groups = getGroups();

    const groupCards = groups.length === 0
        ? `<div class="sam-empty"><i class="fa-solid fa-layer-group"></i><p>No groups yet. Group agents to batch-toggle and order them.</p></div>`
        : groups.map(renderGroupCard).join('');

    container.innerHTML = `
        <div class="sam-tab-head">
            <div class="sam-tab-title">Groups</div>
            <div class="sam-tab-actions">
                <button class="sam-btn sam-btn-accent" data-act="new-group"><i class="fa-solid fa-plus"></i> New Group</button>
            </div>
        </div>

        <div class="sam-list" id="sam-group-list">${groupCards}</div>
    `;

    bindGroupsTab(container);
}

function renderAgentCard(agent, bulkSelected = false) {
    const cat = AGENT_CATEGORIES[agent.category] || AGENT_CATEGORIES.custom;
    const icon = resolveAgentIcon(agent);
    const phase = { pre: 'Pre', post: 'Post', both: 'Both' }[agent.phase] || agent.phase || '—';
    const isPreGen = (agent.phase === 'pre' || agent.phase === 'both') && !!agent.sidecarCall?.enabled;
    // "Run on last" (post-gen target selection) stays separate and always present.
    // Reroll button visibility (capability) vs. active state (has data) are two
    // separate questions. CAPABILITY: a pre-gen planner with self-memory on —
    // only it has memory to blindfold. DATA: there's a prior plan in the agent's
    // merge variable that a reroll would replace. A reroll with no prior plan is
    // just a first run — nothing to "re-" do — so the button renders present but
    // disabled/greyed, showing the capability without inviting a no-op.
    // (We intentionally do NOT also gate on a last-assistant message: pre-gen
    // plans off the pending user text, so the button must stay live when
    // planning the very first reply, when there's no assistant message yet.)
    const canReroll = isPreGen && !!agent.sidecarCall?.richContext?.selfMemory;
    let rerollBtn = '';
    if (canReroll) {
        const varName = agent.mergeVariable?.variableName;
        const hasPlan = !!varName && readMergeArray(varName).length > 0;
        const attrs = !agent.enabled
            ? `disabled title="Enable this agent before rerolling."`
            : agent.paused
                ? `disabled title="Resume this agent before rerolling."`
            : hasPlan
                ? `title="Reroll (re-plan, ignoring self-memory this pass)"`
                : `disabled title="No plan to reroll yet."`;
        const cls = hasPlan && agent.enabled && !agent.paused ? 'sam-icon-btn' : 'sam-icon-btn sam-icon-btn-disabled';
        rerollBtn = `<button class="${cls}" data-act="reroll" data-id="${agent.id}" ${attrs}><i class="fa-solid fa-dice"></i></button>`;
    }
    const pauseTitle = agent.paused
        ? 'Resume agent (restore updates; frozen state is preserved)'
        : 'Pause agent (freeze its current state and context)';
    const runAttrs = !agent.enabled
        ? 'disabled title="Enable this agent before running it."'
        : agent.paused
            ? 'disabled title="Resume this agent before running it."'
        : 'title="Run on last message"';
    return `
    <div class="sam-card sam-agent-card ${bulkSelected ? 'sam-bulk-selected' : ''} ${agent.paused ? 'sam-agent-frozen' : ''}" data-agent-id="${agent.id}" aria-selected="${bulkSelected}">
        <label class="sam-agent-select" title="Select this agent for bulk actions">
            <input type="checkbox" data-act="select-agent" data-id="${agent.id}" ${bulkSelected ? 'checked' : ''} aria-label="Select ${esc(agent.name || 'Unnamed')} for bulk actions">
        </label>
        <label class="sam-agent-enable-toggle" title="${agent.enabled ? 'Disable' : 'Enable'} this agent">
            <input type="checkbox" data-act="toggle" data-id="${agent.id}" ${agent.enabled ? 'checked' : ''} aria-label="${agent.enabled ? 'Disable' : 'Enable'} ${esc(agent.name || 'Unnamed')}">
            <span aria-hidden="true"></span>
        </label>
        <div class="sam-card-icon"><i class="fa-solid ${icon}"></i></div>
        <div class="sam-card-info">
            <div class="sam-card-name">${esc(agent.name || 'Unnamed')}</div>
            <div class="sam-card-desc">${esc(agent.description || 'No description')}</div>
        </div>
        <div class="sam-badges">
            <span class="sam-badge">${esc(phase)}</span>
            <span class="sam-badge sam-badge-soft">${esc(cat.label)}</span>
            ${agent.paused ? '<span class="sam-badge sam-badge-frozen">Frozen</span>' : ''}
        </div>
        <div class="sam-card-actions">
            <button class="sam-icon-btn sam-agent-pause-btn ${agent.paused ? 'is-paused' : ''}" data-act="pause" data-id="${agent.id}" title="${pauseTitle}" aria-pressed="${agent.paused}"><i class="fa-solid fa-pause"></i></button>
            <button class="sam-icon-btn ${!agent.enabled || agent.paused ? 'sam-icon-btn-disabled' : ''}" data-act="run" data-id="${agent.id}" ${runAttrs}><i class="fa-solid fa-play"></i></button>
            ${rerollBtn}
            <button class="sam-icon-btn" data-act="export" data-id="${agent.id}" title="Export"><i class="fa-solid fa-file-export"></i></button>
            <button class="sam-icon-btn" data-act="clear" data-id="${agent.id}" title="Clear stored state (this chat)"><i class="fa-solid fa-eraser"></i></button>
            <button class="sam-icon-btn sam-icon-danger" data-act="delete" data-id="${agent.id}" title="Delete"><i class="fa-solid fa-trash"></i></button>
        </div>
    </div>`;
}

function renderGroupCard(group) {
    const n = group.agentIds?.length || 0;
    const mode = group.executionMode === 'sequential' ? 'Sequential' : 'Parallel';
    const icon = resolveGroupIcon(group);
    const runAttrs = n > 0
        ? 'title="Run group on last message"'
        : 'disabled title="Add an agent before running this group."';
    return `
    <div class="sam-card" data-group-id="${group.id}">
        <div class="sam-card-icon"><i class="fa-solid ${icon}"></i></div>
        <div class="sam-card-info">
            <div class="sam-card-name">${esc(group.name || 'Unnamed Group')}</div>
            <div class="sam-card-desc">${esc(group.description || `${n} agent${n !== 1 ? 's' : ''}`)}</div>
        </div>
        <div class="sam-badges">
            <span class="sam-badge">${mode}</span>
            <span class="sam-badge sam-badge-soft">${n} agent${n !== 1 ? 's' : ''}</span>
        </div>
        <div class="sam-card-actions">
            <button class="sam-icon-btn ${n > 0 ? '' : 'sam-icon-btn-disabled'}" data-act="run-group" data-id="${group.id}" ${runAttrs}><i class="fa-solid fa-play"></i></button>
            <button class="sam-icon-btn" data-act="edit-group" data-id="${group.id}" title="Edit group"><i class="fa-solid fa-pen"></i></button>
            <button class="sam-icon-btn sam-icon-danger" data-act="delete-group" data-id="${group.id}" title="Delete group"><i class="fa-solid fa-trash"></i></button>
        </div>
        <label class="sam-switch">
            <input type="checkbox" data-act="toggle-group" data-id="${group.id}" ${group.enabled ? 'checked' : ''}>
            <span class="sam-switch-track"></span>
        </label>
    </div>`;
}

// ---- Manage tab wiring ------------------------------------------------

function bindManageTab(container) {
    // Header + global settings
    container.querySelector('[data-act="new-agent"]')?.addEventListener('click', onNewAgent);
    container.querySelector('[data-act="import"]')?.addEventListener('click', handleImport);
    container.querySelector('[data-act="export-all"]')?.addEventListener('click', handleExportAll);
    container.querySelector('[data-act="select-all-agents"]')?.addEventListener('click', () => {
        const agents = getAgents();
        const selectionState = getAgentSelectionState(agents.map(agent => agent.id));
        setAllAgentsSelected(agents.map(agent => agent.id), !selectionState.allSelected);
        refreshManage();
    });
    container.querySelector('[data-act="toggle-selected-agents"]')?.addEventListener('click', onToggleSelectedAgents);
    container.querySelector('[data-act="delete-selected-agents"]')?.addEventListener('click', onDeleteSelectedAgents);

    // Agent rows
    container.querySelectorAll('#sam-agent-list [data-act]').forEach(el => {
        const id = el.dataset.id;
        switch (el.dataset.act) {
            case 'select-agent': el.addEventListener('change', function () { setAgentSelected(id, this.checked); refreshManage(); }); break;
            case 'toggle': el.addEventListener('change', () => { toggleAgent(id); refreshManage(); reconcilePanels(); }); break;
            case 'pause':  el.addEventListener('click', () => { toggleAgentPaused(id); refreshManage(); }); break;
            case 'run':    el.addEventListener('click', () => runOnLastMessage(id)); break;
            case 'reroll': el.addEventListener('click', () => rerollAgentPreGen(id)); break;
            case 'edit':   el.addEventListener('click', () => onEditAgent(id)); break;
            case 'export': el.addEventListener('click', () => handleExportSingle(id)); break;
            case 'clear':  el.addEventListener('click', () => onClearAgent(id)); break;
            case 'delete': el.addEventListener('click', () => onDeleteAgent(id)); break;
        }
    });

    container.querySelectorAll('#sam-agent-list .sam-agent-card').forEach(card => {
        card.addEventListener('click', event => {
            if (event.target.closest('button, input, label, .sam-card-actions')) return;
            onEditAgent(card.dataset.agentId);
        });
    });
}

// ---- Groups tab wiring ------------------------------------------------

function bindGroupsTab(container) {
    container.querySelector('[data-act="new-group"]')?.addEventListener('click', onNewGroup);

    // Group rows
    container.querySelectorAll('#sam-group-list [data-act]').forEach(el => {
        const id = el.dataset.id;
        switch (el.dataset.act) {
            case 'toggle-group': el.addEventListener('change', () => onToggleGroup(id)); break;
            case 'run-group':    el.addEventListener('click', () => runGroupOnLastMessage(id)); break;
            case 'edit-group':   el.addEventListener('click', () => onEditGroup(id)); break;
            case 'delete-group': el.addEventListener('click', () => onDeleteGroup(id)); break;
        }
    });
}

function refreshManage() {
    const content = document.getElementById('sam-content');
    if (content && activeTab === 'manage') renderManageTab(content);
}

function refreshGroups() {
    const content = document.getElementById('sam-content');
    if (content && activeTab === 'groups') renderGroupsTab(content);
}

async function onDeleteAgent(id) {
    const agent = getAgentById(id);
    if (!agent) return;
    if (!await samConfirm(`Delete agent "${agent.name}"? This cannot be undone.`)) return;
    deleteAgent(id);
    setAgentSelected(id, false);
    refreshManage();
    reconcilePanels();
    toastr.info(`Deleted "${agent.name}".`);
}

function onToggleSelectedAgents() {
    const agents = getAgents();
    const selectedIds = getSelectedAgentIds();
    const selectedAgents = agents.filter(agent => selectedIds.has(agent.id));
    if (!selectedAgents.length) return;
    const disable = selectedAgents.every(agent => agent.enabled);
    setAgentsEnabled(selectedAgents.map(agent => agent.id), !disable);
    refreshManage();
    reconcilePanels();
    toastr.info(`${disable ? 'Disabled' : 'Enabled'} ${selectedAgents.length} selected agent${selectedAgents.length === 1 ? '' : 's'}.`);
}

async function onDeleteSelectedAgents() {
    const agents = getAgents();
    const selectedIds = getSelectedAgentIds();
    const selectedAgents = agents.filter(agent => selectedIds.has(agent.id));
    if (!selectedAgents.length) return;
    const names = selectedAgents.slice(0, 3).map(agent => `“${agent.name}”`).join(', ');
    const remainder = selectedAgents.length > 3 ? ` and ${selectedAgents.length - 3} more` : '';
    if (!await samConfirm(`Delete ${selectedAgents.length} selected agent${selectedAgents.length === 1 ? '' : 's'} (${names}${remainder})? This cannot be undone.`)) return;
    const deletedCount = deleteAgents(selectedAgents.map(agent => agent.id));
    clearAgentSelection();
    refreshManage();
    reconcilePanels();
    toastr.info(`Deleted ${deletedCount} agent${deletedCount === 1 ? '' : 's'}.`);
}

// Wipe an agent's stored state from the CURRENT chat (live value, per-swipe
// snapshots, transaction log). Leaves the agent enabled; the next generation
// repopulates fresh state. Scoped to the open chat only.
function onClearAgent(id) {
    const agent = getAgentById(id);
    if (!agent) return;
    if (!agent.mergeVariable?.variableName) {
        toastr.warning(`"${agent.name}" has no chat data to clear.`);
        return;
    }
    if (!confirm(`Clear "${agent.name}" stored state from THIS chat?\n\nThis wipes its tracked values and every per-message snapshot in the current chat. The agent stays enabled and repopulates on the next generation.`)) return;
    const summary = clearAgentChatState(agent);
    reconcilePanels();
    toastr.info(`Cleared "${agent.name}" state from this chat (${summary.messagesTouched} message(s)).`);
}

function onToggleGroup(id) {
    const result = toggleGroup(id);
    if (result) {
        const label = result.groupEnabled ? 'enabled' : 'disabled';
        toastr.info(`Group ${label} — ${result.agentCount} agent(s) toggled.`);
    }
    refreshGroups();
    reconcilePanels();
}

function onDeleteGroup(id) {
    const group = getGroupById(id);
    if (!group) return;
    if (!confirm(`Delete group "${group.name}"? Agents in it are not deleted.`)) return;
    deleteGroup(id);
    refreshGroups();
    toastr.info(`Deleted group "${group.name}".`);
}

// Open the in-pane agent editor (new or existing).
function onNewAgent()      { editorOpen = true; editingAgentId = null; renderContent(); }
function onEditAgent(id)   { editorOpen = true; editingAgentId = id; renderContent(); }
function onNewGroup()      { groupEditorOpen = true; editingGroupId = null; renderContent(); }
function onEditGroup(id)   { groupEditorOpen = true; editingGroupId = id; renderContent(); }

// ---- Run / import / export -------------------------------------------

// Thin wrapper: the "find last assistant message + run + toast" logic now lives
// in lifecycle.runAgentOnLastMessage so the flyout play badge shares it verbatim.
async function runOnLastMessage(agentId) {
    await runAgentOnLastMessage(agentId);
}

function handleImport() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.multiple = true;
    input.addEventListener('change', async () => {
        for (const file of input.files) {
            try {
                const data = JSON.parse(await file.text());
                const imported = importAgents(data);
                toastr.success(`Imported ${imported.length} agent(s) from "${file.name}".`);
            } catch (err) {
                console.error(`${LOG_PREFIX} import error for ${file.name}:`, err);
                toastr.error(`Failed to import "${file.name}": ${err.message}`);
            }
        }
        refreshManage();
    });
    input.click();
}

function handleExportAll() {
    const data = exportAllAgents();
    downloadJson(data, 'superagents-export.json');
    toastr.info(`Exported ${data.agents?.length ?? 0} agent(s).`);
}

function handleExportSingle(agentId) {
    const data = exportAgent(agentId);
    if (!data) return;
    downloadJson(data, `agent-${sanitizeFilename(data.name)}.json`);
}

function downloadJson(data, filename) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
}

function sanitizeFilename(name) {
    return (name || 'unnamed').replace(/[^a-z0-9_-]/gi, '_').substring(0, 40);
}

// ============================================================================
// TAB: SETTINGS  (global + floating-panel controls)
// ============================================================================

function renderSettingsTab(container) {
    const globalSettings = getGlobalSettings();
    const connectionProfiles = listConnectionProfiles();
    const defaultConnectionEnabled = globalSettings.useDefaultConnection === true;
    const defaultConnectionRef = String(globalSettings.connectionProfile || '');
    const selectedDefaultProfile = connectionProfiles.find(profile =>
        profile.name === defaultConnectionRef || profile.id === defaultConnectionRef,
    );
    const missingDefaultOption = defaultConnectionRef && !selectedDefaultProfile
        ? `<option value="${esc(defaultConnectionRef)}" selected>${esc(defaultConnectionRef)} (missing)</option>`
        : '';
    const defaultConnectionOptions = connectionProfiles
        .map(profile => `<option value="${esc(profile.name)}" ${profile === selectedDefaultProfile ? 'selected' : ''}>${esc(profile.name)}</option>`)
        .join('');
    const controls = [...panelControls.values()];
    const presentationProfileId = getPresentationProfileId();
    const presentationOptions = listPresentationProfiles()
        .map(profile => `<option value="${esc(profile.id)}" ${profile.id === presentationProfileId ? 'selected' : ''}>${esc(profile.label)}</option>`)
        .join('');
    const stateCardStyleId = getStateCardStyleId();
    const stateCardStyleOptions = STATE_CARD_STYLE_OPTIONS
        .map(style => `<option value="${esc(style.id)}" ${style.id === stateCardStyleId ? 'selected' : ''}>${esc(style.label)}</option>`)
        .join('');
    const weatherCycleInstalled = isWeatherCycleInstalled();

    const panelRows = controls.length === 0
        ? `<div class="sam-empty sam-empty-sm">No display panels registered yet. The State Card and Phone register here once their build steps land.</div>`
        : controls.map(c => {
            // Settings owns the saved default, not the current-chat state. A
            // dock click or panel close may temporarily differ from this value.
            const defaultVisible = c.controller.isDefaultVisible
                ? !!c.controller.isDefaultVisible()
                : !!c.controller.isOpen?.();
            // Availability describes the feature/agent capability. Chat
            // presence is handled separately by the story-app dock and panel.
            const available = c.controller.isAvailable ? !!c.controller.isAvailable() : true;
            const rowCls = available ? 'sam-row' : 'sam-row sam-row-disabled';
            const desc = available
                ? 'Open by default in new chats. Each chat remembers later Story-app open/close choices.'
                : 'Enable its supporting agent or display source to use this panel.';
            const controlLabel = String(c.getLabel?.() || c.label || c.id);
            const controlIcon = String(c.getIcon?.() || c.icon || 'fa-window-maximize');
            return `
            <div class="${rowCls}" data-panel="${c.id}">
                <div class="sam-row-info">
                    <div class="sam-row-title"><i class="fa-solid ${controlIcon}"></i> ${esc(controlLabel)}</div>
                    <div class="sam-row-desc">${desc}</div>
                </div>
                <div class="sam-row-controls">
                    <button class="sam-btn sam-btn-sm" data-act="reset-panel" data-id="${c.id}" title="Reset position"${available ? '' : ' disabled'}>Reset</button>
                    <label class="sam-switch">
                        <input type="checkbox" data-act="toggle-panel" data-id="${c.id}" ${defaultVisible ? 'checked' : ''}${available ? '' : ' disabled'}>
                        <span class="sam-switch-track"></span>
                    </label>
                </div>
            </div>`;
        }).join('');

    container.innerHTML = `
        <div class="sam-tab-head"><div class="sam-tab-title">Settings</div></div>
        <div class="sam-divider-label"><i class="fa-solid fa-plug"></i> Agent Connections</div>
        <div class="sam-row${connectionProfiles.length ? '' : ' sam-row-disabled'}">
            <div class="sam-row-info">
                <div class="sam-row-title">Default connection for SuperAgents</div>
                <div class="sam-row-desc">When enabled, agents set to “Use default connection” use this profile. Agents with an explicitly selected profile keep their own choice.${connectionProfiles.length ? '' : ' No Connection Manager profiles are currently available.'}</div>
            </div>
            <div class="sam-row-controls sam-default-connection-controls">
                <select class="sae-select sam-default-connection-select" data-setting="connectionProfile" aria-label="Default SuperAgents connection" ${defaultConnectionEnabled && connectionProfiles.length ? '' : 'disabled'}>
                    <option value="">Choose a connection profile</option>
                    ${missingDefaultOption}
                    ${defaultConnectionOptions}
                </select>
                <label class="sam-switch" title="Use a default connection for unassigned agents">
                    <input type="checkbox" data-setting="useDefaultConnection" ${defaultConnectionEnabled ? 'checked' : ''}${connectionProfiles.length ? '' : ' disabled'}>
                    <span class="sam-switch-track"></span>
                </label>
            </div>
        </div>
        <div class="sam-divider-label"><i class="fa-solid fa-sliders"></i> General</div>
        <div class="sam-row">
            <div class="sam-row-info">
                <div class="sam-row-title">Story presentation</div>
                <div class="sam-row-desc">Choose this chat's surface vocabulary, capabilities, model behavior, and visual theme. Story data and action IDs stay unchanged.</div>
            </div>
            <select class="sam-select" data-setting="presentationProfile" aria-label="Story presentation">
                ${presentationOptions}
            </select>
        </div>
        <div class="sam-row">
            <div class="sam-row-info">
                <div class="sam-row-title">State Card style</div>
                <div class="sam-row-desc">Keep the current SillyTavern-aware colors, follow this chat's Story presentation, or lock State Card to a specific design.</div>
            </div>
            <select class="sam-select" data-setting="stateCardStyle" aria-label="State Card style">
                ${stateCardStyleOptions}
            </select>
        </div>
        <div class="sam-row">
            <div class="sam-row-info">
                <div class="sam-row-title">Story Apps position</div>
                <div class="sam-row-desc">Drag the Story Apps button row anywhere on screen. Reset returns it to the top-left corner.</div>
            </div>
            <button class="sam-btn sam-btn-sm" data-act="reset-story-apps" type="button">Reset</button>
        </div>
        <div class="sam-row">
            <div class="sam-row-info">
                <div class="sam-row-title">Show Notifications Story App button</div>
                <div class="sam-row-desc">Keep Notifications available while hiding its launcher from the Story Apps row.</div>
            </div>
            <label class="sam-switch">
                <input type="checkbox" data-setting="showNotificationsLauncher" ${globalSettings.showNotificationsLauncher !== false ? 'checked' : ''}>
                <span class="sam-switch-track"></span>
            </label>
        </div>
        <div class="sam-row">
            <div class="sam-row-info">
                <div class="sam-row-title">Show Calendar Story App button</div>
                <div class="sam-row-desc">Keep Calendar and story-plan syncing available while hiding its launcher from the Story Apps row.</div>
            </div>
            <label class="sam-switch">
                <input type="checkbox" data-setting="showCalendarLauncher" ${globalSettings.showCalendarLauncher !== false ? 'checked' : ''}>
                <span class="sam-switch-track"></span>
            </label>
        </div>
        <div class="sam-row">
            <div class="sam-row-info">
                <div class="sam-row-title">Show notifications</div>
                <div class="sam-row-desc">Toasts when agents run, succeed, or fail.</div>
            </div>
            <label class="sam-switch">
                <input type="checkbox" data-setting="showNotifications" ${globalSettings.showNotifications ? 'checked' : ''}>
                <span class="sam-switch-track"></span>
            </label>
        </div>
        <div class="sam-row${weatherCycleInstalled ? '' : ' sam-row-disabled'}">
            <div class="sam-row-info">
                <div class="sam-row-title">Sync World State to Weather Cycle</div>
                <div class="sam-row-desc">${weatherCycleInstalled
                    ? 'Automatically mirror an enabled World State agent’s validated weather and time-of-day snapshot, with added Afternoon and Twilight lighting. Paused agents retain their frozen state; disabled agents do not control Weather Cycle.'
                    : 'Install and enable st-weather-cycle to use automatic World State synchronization.'}</div>
            </div>
            <label class="sam-switch">
                <input type="checkbox" data-setting="weatherCycleIntegration" ${globalSettings.weatherCycleIntegration ? 'checked' : ''}${weatherCycleInstalled ? '' : ' disabled'}>
                <span class="sam-switch-track"></span>
            </label>
        </div>
        <div class="sam-row">
            <div class="sam-row-info">
                <div class="sam-row-title">Sync story plans to Calendar</div>
                <div class="sam-row-desc">Create a linked replacement when narration explicitly establishes a rescheduled commitment. Tentative suggestions and malformed updates are ignored.</div>
            </div>
            <label class="sam-switch">
                <input type="checkbox" data-setting="calendarStorySync" ${globalSettings.calendarStorySync !== false ? 'checked' : ''}>
                <span class="sam-switch-track"></span>
            </label>
        </div>
        <div class="sam-divider-label"><i class="fa-solid fa-window-restore"></i> Display Panels</div>
        ${panelRows}
        <div class="sam-divider-label"><i class="fa-solid fa-circle-info"></i> About</div>
        <div class="sam-note">
            <p>Floating panels are draggable and never dock to a screen edge, so they
            coexist with other extensions (e.g. White Lotus) without competing for space.
            These switches choose each panel's default. In-story controls are remembered
            separately for each chat.</p>
        </div>
    `;

    container.querySelector('[data-setting="showNotifications"]')?.addEventListener('change', function () {
        setGlobalSettings({ showNotifications: this.checked });
    });
    container.querySelector('[data-setting="useDefaultConnection"]')?.addEventListener('change', function () {
        const select = container.querySelector('[data-setting="connectionProfile"]');
        if (this.checked && select && !select.value && connectionProfiles[0]) {
            select.value = connectionProfiles[0].name;
        }
        if (select) select.disabled = !this.checked;
        setGlobalSettings({
            useDefaultConnection: this.checked,
            connectionProfile: select?.value || '',
        });
    });
    container.querySelector('[data-setting="connectionProfile"]')?.addEventListener('change', function () {
        setGlobalSettings({ connectionProfile: this.value || '' });
    });
    container.querySelector('[data-setting="showNotificationsLauncher"]')?.addEventListener('change', function () {
        setGlobalSettings({ showNotificationsLauncher: this.checked });
        refreshSurfaceDock();
    });
    container.querySelector('[data-setting="showCalendarLauncher"]')?.addEventListener('change', function () {
        setGlobalSettings({ showCalendarLauncher: this.checked });
        refreshSurfaceDock();
    });
    container.querySelector('[data-setting="weatherCycleIntegration"]')?.addEventListener('change', function () {
        setGlobalSettings({ weatherCycleIntegration: this.checked });
        syncWeatherCycleIntegration();
    });
    container.querySelector('[data-setting="presentationProfile"]')?.addEventListener('change', async function () {
        await setPresentationProfile(this.value);
        renderSettingsTab(container);
    });
    container.querySelector('[data-setting="stateCardStyle"]')?.addEventListener('change', function () {
        setStateCardStyle(this.value);
        renderSettingsTab(container);
    });
    container.querySelector('[data-setting="calendarStorySync"]')?.addEventListener('change', function () {
        setGlobalSettings({ calendarStorySync: this.checked });
    });
    container.querySelector('[data-act="reset-story-apps"]')?.addEventListener('click', () => {
        resetSurfaceDockPosition();
        toastr.info('Story Apps position reset.');
    });

    container.querySelectorAll('[data-act="toggle-panel"]').forEach(el => {
        el.addEventListener('change', () => {
            const c = panelControls.get(el.dataset.id);
            if (!c) return;
            // Ignore toggles on unavailable panels. The input is also disabled
            // in markup; this is belt-and-suspenders.
            if (c.controller.isAvailable && !c.controller.isAvailable()) {
                el.checked = false;
                return;
            }
            if (el.checked) c.controller.show?.(); else c.controller.hide?.();
        });
    });
    container.querySelectorAll('[data-act="reset-panel"]').forEach(el => {
        el.addEventListener('click', () => {
            panelControls.get(el.dataset.id)?.controller.resetPosition?.();
            toastr.info('Panel position reset.');
        });
    });
}

// ============================================================================
// TAB: LIBRARY  (browse + instantiate built-in templates)
// ============================================================================

// Built-in templates load async over fetch; cache them so tab switches don't
// refetch. Null = not loaded yet.
let templateCache = null;

function renderLibraryTab(container) {
    container.innerHTML = `
        <div class="sam-tab-head"><div class="sam-tab-title">Library</div></div>
        <div class="sam-note">
            <p>Add a built-in template to your agents, then tweak it in the editor.
            Adding creates an independent copy — you can add the same template more than once.</p>
        </div>
        <div class="sam-divider-label"><i class="fa-solid fa-book-open"></i> Built-in Templates</div>
        <div class="sam-list" id="sam-library-list">
            ${templateCache
                ? renderLibraryCards()
                : `<div class="sam-empty sam-empty-sm"><i class="fa-solid fa-spinner fa-spin"></i> Loading templates…</div>`}
        </div>
    `;

    if (!templateCache) {
        listBuiltInTemplates()
            .then(tpls => { templateCache = tpls || []; })
            .catch(err => { console.warn(`${LOG_PREFIX} template load failed:`, err); templateCache = []; })
            .finally(() => {
                // Only repaint if the user is still on the Library tab.
                if (isOpen && activeTab === 'library' && !editorOpen) {
                    const list = document.getElementById('sam-library-list');
                    if (list) { list.innerHTML = renderLibraryCards(); bindLibraryTab(container); }
                }
            });
    } else {
        bindLibraryTab(container);
    }
}

function renderLibraryCards() {
    if (!templateCache || templateCache.length === 0) {
        return `<div class="sam-empty sam-empty-sm">No templates found. (They live in <code>src/templates/</code> and are registered in <code>templateSync.js</code>.)</div>`;
    }
    const addedCounts = new Map();
    for (const agent of getAgents()) {
        if (!agent.sourceTemplateId) continue;
        addedCounts.set(agent.sourceTemplateId, (addedCounts.get(agent.sourceTemplateId) || 0) + 1);
    }
    return templateCache.map(template => renderTemplateCard(
        template,
        addedCounts.get(template.id) || 0,
    )).join('');
}

function renderTemplateCard(tpl, addedCount = 0) {
    const cat = AGENT_CATEGORIES[tpl.category] || AGENT_CATEGORIES.custom;
    const phase = { pre: 'Pre', post: 'Post', both: 'Both' }[tpl.phase] || tpl.phase || '—';
    const iconClass = (tpl.icon || '').replace(/^fa-solid\s+/, '') || cat.icon;

    const action = addedCount > 0
        ? `<span class="sam-badge sam-badge-soft" title="${addedCount} instance(s) in your agents"><i class="fa-solid fa-check"></i> Added${addedCount > 1 ? ` ×${addedCount}` : ''}</span>
           <button class="sam-btn sam-btn-sm" data-act="add-template" data-id="${tpl.id}" title="Add another copy">Add again</button>`
        : `<button class="sam-btn sam-btn-accent sam-btn-sm" data-act="add-template" data-id="${tpl.id}"><i class="fa-solid fa-plus"></i> Add</button>`;

    return `
    <div class="sam-card" data-template-id="${tpl.id}">
        <div class="sam-card-icon"><i class="fa-solid ${iconClass}"></i></div>
        <div class="sam-card-info">
            <div class="sam-card-name">${esc(tpl.name || 'Unnamed')}</div>
            <div class="sam-card-desc">${esc(tpl.description || 'No description')}</div>
        </div>
        <div class="sam-badges">
            <span class="sam-badge">${esc(phase)}</span>
            <span class="sam-badge sam-badge-soft">${esc(cat.label)}</span>
        </div>
        <div class="sam-card-actions">${action}</div>
    </div>`;
}

function bindLibraryTab(container) {
    container.querySelectorAll('[data-act="add-template"]').forEach(el => {
        el.addEventListener('click', () => onAddTemplate(el.dataset.id));
    });
}

function onAddTemplate(templateId) {
    const tpl = templateCache?.find(t => t.id === templateId);
    if (!tpl) return;
    const agent = instantiateTemplate(tpl);
    if (!agent) {
        toastr.error(`Could not add "${tpl.name}".`);
        return;
    }
    toastr.success(`Added "${agent.name}" — enabled and ready.`);
    // Repaint the library cards (added-count badges) in place.
    const list = document.getElementById('sam-library-list');
    if (list) { list.innerHTML = renderLibraryCards(); bindLibraryTab(list); }
}

// ============================================================================
// HELPERS
// ============================================================================

function esc(str) {
    const div = document.createElement('div');
    div.textContent = str ?? '';
    return div.innerHTML;
}
