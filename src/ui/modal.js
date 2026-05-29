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
import { chat } from '../../../../../../script.js';
import {
    getAgents,
    getAgentById,
    toggleAgent,
    deleteAgent,
    getGlobalSettings,
    setGlobalSettings,
    getGroups,
    getGroupById,
    deleteGroup,
    toggleGroup,
    instantiateTemplate,
} from '../data/store.js';
import { AGENT_CATEGORIES } from '../data/normalize.js';
import { listBuiltInTemplates } from '../data/templateSync.js';
import { importAgents, exportAllAgents, exportAgent } from '../data/importExport.js';
import { runAgentOnMessage } from '../core/lifecycle.js';
import { renderAgentEditor } from './editor.js';
import { renderGroupEditor } from './groupEditor.js';

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
 * Each: { id, label, icon, controller } where controller is the object
 * returned by makeDraggablePanel ({ show, hide, toggle, isOpen, resetPosition }).
 * @type {Map<string, {id:string,label:string,icon:string,controller:object}>}
 */
const panelControls = new Map();

/**
 * Register a floating panel so the Settings tab can show/hide/reset it.
 * Called by the State Card and Phone modules as they initialize.
 * @param {{id:string,label:string,icon:string,controller:object}} entry
 */
export function registerPanelControl(entry) {
    if (!entry?.id || !entry?.controller) return;
    panelControls.set(entry.id, {
        id: entry.id,
        label: entry.label || entry.id,
        icon: entry.icon || 'fa-window-maximize',
        controller: entry.controller,
    });
    // If Settings is currently visible, reflect the new control immediately.
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
    });

    debug(`${LOG_PREFIX} opened (tab: ${activeTab})`);
}

/** Close the modal (DOM is kept for reuse). */
export function closeModal() {
    if (!isOpen) return;
    document.getElementById(OVERLAY_ID)?.classList.remove('sam-visible');
    document.getElementById(MODAL_ID)?.classList.remove('sam-visible');
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

    modal.querySelector('#sam-close')?.addEventListener('click', closeModal);
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && isOpen) closeModal();
    });
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
    const gs = getGlobalSettings();

    const agentCards = agents.length === 0
        ? `<div class="sam-empty"><i class="fa-solid fa-robot"></i><p>No agents yet. Create one, or instantiate a built-in from the Library.</p></div>`
        : agents.map(renderAgentCard).join('');

    container.innerHTML = `
        <div class="sam-tab-head">
            <div class="sam-tab-title">Agents</div>
            <div class="sam-tab-actions">
                <button class="sam-btn sam-btn-accent" data-act="new-agent"><i class="fa-solid fa-plus"></i> New</button>
                <button class="sam-btn" data-act="import" title="Import agents from JSON"><i class="fa-solid fa-file-import"></i></button>
                <button class="sam-btn" data-act="export-all" title="Export all agents"><i class="fa-solid fa-file-export"></i></button>
            </div>
        </div>

        <div class="sam-row">
            <div class="sam-row-info">
                <div class="sam-row-title">Show notifications</div>
                <div class="sam-row-desc">Toasts when agents run, succeed, or fail.</div>
            </div>
            <label class="sam-switch">
                <input type="checkbox" data-setting="showNotifications" ${gs.showNotifications ? 'checked' : ''}>
                <span class="sam-switch-track"></span>
            </label>
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

function renderAgentCard(agent) {
    const cat = AGENT_CATEGORIES[agent.category] || AGENT_CATEGORIES.custom;
    const phase = { pre: 'Pre', post: 'Post', both: 'Both' }[agent.phase] || agent.phase || '—';
    return `
    <div class="sam-card" data-agent-id="${agent.id}">
        <div class="sam-card-icon"><i class="fa-solid ${cat.icon}"></i></div>
        <div class="sam-card-info">
            <div class="sam-card-name">${esc(agent.name || 'Unnamed')}</div>
            <div class="sam-card-desc">${esc(agent.description || 'No description')}</div>
        </div>
        <div class="sam-badges">
            <span class="sam-badge">${esc(phase)}</span>
            <span class="sam-badge sam-badge-soft">${esc(cat.label)}</span>
        </div>
        <div class="sam-card-actions">
            <button class="sam-icon-btn" data-act="run" data-id="${agent.id}" title="Run on last message"><i class="fa-solid fa-play"></i></button>
            <button class="sam-icon-btn" data-act="edit" data-id="${agent.id}" title="Edit"><i class="fa-solid fa-pen"></i></button>
            <button class="sam-icon-btn" data-act="export" data-id="${agent.id}" title="Export"><i class="fa-solid fa-file-export"></i></button>
            <button class="sam-icon-btn sam-icon-danger" data-act="delete" data-id="${agent.id}" title="Delete"><i class="fa-solid fa-trash"></i></button>
        </div>
        <label class="sam-switch">
            <input type="checkbox" data-act="toggle" data-id="${agent.id}" ${agent.enabled ? 'checked' : ''}>
            <span class="sam-switch-track"></span>
        </label>
    </div>`;
}

function renderGroupCard(group) {
    const n = group.agentIds?.length || 0;
    const mode = group.executionMode === 'sequential' ? 'Sequential' : 'Parallel';
    return `
    <div class="sam-card" data-group-id="${group.id}">
        <div class="sam-card-icon"><i class="fa-solid fa-layer-group"></i></div>
        <div class="sam-card-info">
            <div class="sam-card-name">${esc(group.name || 'Unnamed Group')}</div>
            <div class="sam-card-desc">${esc(group.description || `${n} agent${n !== 1 ? 's' : ''}`)}</div>
        </div>
        <div class="sam-badges">
            <span class="sam-badge">${mode}</span>
            <span class="sam-badge sam-badge-soft">${n} agent${n !== 1 ? 's' : ''}</span>
        </div>
        <div class="sam-card-actions">
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

    container.querySelector('[data-setting="showNotifications"]')?.addEventListener('change', function () {
        setGlobalSettings({ showNotifications: this.checked });
    });

    // Agent rows
    container.querySelectorAll('#sam-agent-list [data-act]').forEach(el => {
        const id = el.dataset.id;
        switch (el.dataset.act) {
            case 'toggle': el.addEventListener('change', () => toggleAgent(id)); break;
            case 'run':    el.addEventListener('click', () => runOnLastMessage(id)); break;
            case 'edit':   el.addEventListener('click', () => onEditAgent(id)); break;
            case 'export': el.addEventListener('click', () => handleExportSingle(id)); break;
            case 'delete': el.addEventListener('click', () => onDeleteAgent(id)); break;
        }
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

function onDeleteAgent(id) {
    const agent = getAgentById(id);
    if (!agent) return;
    if (!confirm(`Delete agent "${agent.name}"? This cannot be undone.`)) return;
    deleteAgent(id);
    refreshManage();
    toastr.info(`Deleted "${agent.name}".`);
}

function onToggleGroup(id) {
    const result = toggleGroup(id);
    if (result) {
        const label = result.groupEnabled ? 'enabled' : 'disabled';
        toastr.info(`Group ${label} — ${result.agentCount} agent(s) toggled.`);
    }
    refreshGroups();
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

async function runOnLastMessage(agentId) {
    let targetIdx = -1;
    for (let i = chat.length - 1; i >= 0; i--) {
        if (chat[i] && !chat[i].is_user && !chat[i].is_system) { targetIdx = i; break; }
    }
    if (targetIdx < 0) {
        toastr.warning('No assistant message to run the agent on.');
        return;
    }
    const result = await runAgentOnMessage(agentId, targetIdx);
    if (result?.error) toastr.error(`Agent failed: ${result.error}`);
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
    const controls = [...panelControls.values()];

    const panelRows = controls.length === 0
        ? `<div class="sam-empty sam-empty-sm">No display panels registered yet. The State Card and Phone register here once their build steps land.</div>`
        : controls.map(c => {
            const open = !!c.controller.isOpen?.();
            return `
            <div class="sam-row" data-panel="${c.id}">
                <div class="sam-row-info">
                    <div class="sam-row-title"><i class="fa-solid ${c.icon}"></i> ${esc(c.label)}</div>
                    <div class="sam-row-desc">Show this floating panel. Drag it anywhere; position is remembered.</div>
                </div>
                <div class="sam-row-controls">
                    <button class="sam-btn sam-btn-sm" data-act="reset-panel" data-id="${c.id}" title="Reset position">Reset</button>
                    <label class="sam-switch">
                        <input type="checkbox" data-act="toggle-panel" data-id="${c.id}" ${open ? 'checked' : ''}>
                        <span class="sam-switch-track"></span>
                    </label>
                </div>
            </div>`;
        }).join('');

    container.innerHTML = `
        <div class="sam-tab-head"><div class="sam-tab-title">Settings</div></div>
        <div class="sam-divider-label"><i class="fa-solid fa-window-restore"></i> Display Panels</div>
        ${panelRows}
        <div class="sam-divider-label"><i class="fa-solid fa-circle-info"></i> About</div>
        <div class="sam-note">
            <p>Floating panels are draggable and never dock to a screen edge, so they
            coexist with other extensions (e.g. White Lotus) without competing for space.</p>
        </div>
    `;

    container.querySelectorAll('[data-act="toggle-panel"]').forEach(el => {
        el.addEventListener('change', () => {
            const c = panelControls.get(el.dataset.id);
            if (!c) return;
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
    return templateCache.map(renderTemplateCard).join('');
}

function renderTemplateCard(tpl) {
    const cat = AGENT_CATEGORIES[tpl.category] || AGENT_CATEGORIES.custom;
    const phase = { pre: 'Pre', post: 'Post', both: 'Both' }[tpl.phase] || tpl.phase || '—';
    const addedCount = getAgents().filter(a => a.sourceTemplateId === tpl.id).length;
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
