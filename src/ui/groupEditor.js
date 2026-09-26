/**
 * ui/groupEditor.js — the agent-group editor, rendered as an in-pane view
 * inside the unified modal's content area (not a separate overlay), matching
 * the agent editor's contract in ui/editor.js.
 *
 * Ported from VerseManager's groupModal.js, which was a standalone
 * promise-based overlay. Here it's restructured to the SuperAgents in-pane
 * sub-view pattern: same sae-/sam- form classes, same jQuery + toastr
 * ambient globals, same Back/Cancel/Escape behavior, same head/form/foot
 * skeleton as renderAgentEditor.
 *
 * Beyond VM's original four fields (name, description, executionMode,
 * agentIds), this also surfaces `phase` and `order` — both are real group
 * fields the lifecycle engine reads, and the project rule is to keep
 * everything, not strip config the form merely didn't show.
 *
 * Entry point:
 *   renderGroupEditor(container, groupId, { onSaved, onCancel })
 *     - groupId null/undefined → new group (createDefaultGroup)
 *     - groupId string         → edit existing
 *     - onSaved(group)         → called after a successful save
 *     - onCancel()             → called on back/cancel/Escape
 */

import { debug } from '../core/runtime.js';
import {
    getAgents,
    getGroupById,
    saveGroup,
    createDefaultGroup,
    getGlobalSettings,
} from '../data/store.js';
import { AGENT_CATEGORIES } from '../data/normalize.js';

const LOG_PREFIX = '[SuperAgents/groupEditor]';

// Escape key handler reference, so we can detach it on close.

// ============================================================================
// BUILD HTML
// ============================================================================

function buildEditorHTML(group, allAgents, inheritedBatchMaxTokens) {
    const selected = new Set(group.agentIds);

    const agentRows = allAgents.length === 0
        ? `<div class="sam-empty sam-empty-sm">No agents available yet. Create some on the Agents tab first.</div>`
        : allAgents.map(a => {
            const cat = AGENT_CATEGORIES[a.category] || AGENT_CATEGORIES.custom;
            const phase = { pre: 'Pre', post: 'Post', both: 'Both' }[a.phase] || a.phase || '—';
            return `
            <label class="sae-group-agent">
                <input type="checkbox" class="sae-group-cb" data-agent-id="${esc(a.id)}" ${selected.has(a.id) ? 'checked' : ''}>
                <span class="sae-group-agent-icon"><i class="fa-solid ${cat.icon}"></i></span>
                <span class="sae-group-agent-name">${esc(a.name || 'Unnamed')}</span>
                <span class="sam-badge">${esc(phase)}</span>
            </label>`;
        }).join('');

    return `
    <div class="sae-head">
        <button class="sam-btn sae-back" id="sae-group-back"><i class="fa-solid fa-arrow-left"></i> Back</button>
        <div class="sae-head-title">${group.name ? 'Edit Group' : 'New Group'}</div>
    </div>

    <div class="sae-form">
        <div class="sam-divider-label"><i class="fa-solid fa-tag"></i> Identity</div>

        <div class="sae-field">
            <div class="sae-label">Name</div>
            <input type="text" id="sae-group-name" class="sae-input" value="${esc(group.name)}" placeholder="e.g. Tracker Pack">
        </div>
        <div class="sae-field">
            <div class="sae-label">Description</div>
            <input type="text" id="sae-group-desc" class="sae-input" value="${esc(group.description)}" placeholder="Optional description">
        </div>

        <div class="sam-divider-label"><i class="fa-solid fa-gears"></i> Execution</div>
        <div class="sae-field">
            <div class="sae-label">Execution mode</div>
            <div class="sae-desc">Parallel: sidecars sharing a connection profile are combined into one batch; different profiles run concurrently. Sequential: one member at a time, each seeing prior stored results.</div>
            <select id="sae-group-exec-mode" class="sae-select">
                <option value="parallel" ${group.executionMode === 'parallel' ? 'selected' : ''}>Parallel</option>
                <option value="sequential" ${group.executionMode === 'sequential' ? 'selected' : ''}>Sequential</option>
            </select>
        </div>
        <div class="sae-field">
            <div class="sae-label">Batch output token ceiling</div>
            <div class="sae-desc">Maximum output requested for each connection-profile batch in this parallel group. Leave blank to use the SuperAgents default (${Number(inheritedBatchMaxTokens).toLocaleString()}). Raise it only as far as that profile's provider/model supports. Sequential groups ignore this setting.</div>
            <input type="number" id="sae-group-batch-max-tokens" class="sae-input" min="256" max="1000000" step="256" value="${Number.isFinite(group.batchMaxTokens) ? group.batchMaxTokens : ''}" placeholder="Use global default (${Number(inheritedBatchMaxTokens).toLocaleString()})">
        </div>
        <div class="sae-row">
            <div class="sae-field sae-grow">
                <div class="sae-label">Phase</div>
                <div class="sae-desc">When this group runs relative to the main generation.</div>
                <select id="sae-group-phase" class="sae-select">
                    <option value="post" ${group.phase === 'post' ? 'selected' : ''}>Post-gen — process after response</option>
                    <option value="pre" ${group.phase === 'pre' ? 'selected' : ''}>Pre-gen — inject before generation</option>
                </select>
            </div>
            <div class="sae-field sae-fixed">
                <div class="sae-label">Order</div>
                <input type="number" id="sae-group-order" class="sae-input" min="0" max="999" value="${Number.isFinite(group.order) ? group.order : 100}">
            </div>
        </div>

        <div class="sam-divider-label"><i class="fa-solid fa-robot"></i> Members</div>
        <div class="sae-desc">An agent belongs to one execution group. Selecting one here moves it from any other group.</div>
        <div class="sae-group-select-actions">
            <button type="button" class="sam-btn sam-btn-sm" id="sae-group-all"><i class="fa-solid fa-check-double"></i> All</button>
            <button type="button" class="sam-btn sam-btn-sm" id="sae-group-none"><i class="fa-solid fa-xmark"></i> None</button>
            <span class="sae-group-count" id="sae-group-count"></span>
        </div>
        <div class="sae-group-agent-list">
            ${agentRows}
        </div>
    </div>

    <div class="sae-foot">
        <button class="sam-btn" id="sae-group-cancel">Cancel</button>
        <button class="sam-btn sam-btn-accent" id="sae-group-save"><i class="fa-solid fa-floppy-disk"></i> ${group.name ? 'Save' : 'Create Group'}</button>
    </div>`;
}

// ============================================================================
// FORM READ
// ============================================================================

function readFormToGroup(existingGroup) {
    const selectedIds = [];
    $('.sae-group-cb:checked').each(function () {
        const id = this.getAttribute('data-agent-id');
        if (id) selectedIds.push(id);
    });

    const rawBatchMaxTokens = String($('#sae-group-batch-max-tokens').val() || '').trim();
    return {
        ...existingGroup,
        name: ($('#sae-group-name').val() || '').trim(),
        description: ($('#sae-group-desc').val() || '').trim(),
        executionMode: $('#sae-group-exec-mode').val() === 'sequential' ? 'sequential' : 'parallel',
        batchMaxTokens: rawBatchMaxTokens ? Number(rawBatchMaxTokens) : null,
        phase: $('#sae-group-phase').val() === 'pre' ? 'pre' : 'post',
        order: parseInt($('#sae-group-order').val()) || 0,
        agentIds: selectedIds,
    };
}

function updateCount() {
    const n = $('.sae-group-cb:checked').length;
    $('#sae-group-count').text(n === 0 ? 'No agents selected' : `${n} selected`);
}

// ============================================================================
// PUBLIC: RENDER EDITOR INTO A CONTAINER
// ============================================================================

/**
 * Render the group editor into a container (the modal's content pane).
 * @param {HTMLElement} container
 * @param {string|null} groupId  null/undefined → new group
 * @param {{onSaved?:function(object):void, onCancel?:function():void}} [cb]
 */
export function renderGroupEditor(container, groupId, cb = {}) {
    const existing = groupId ? getGroupById(groupId) : null;
    const group = existing
        ? { ...existing, agentIds: [...existing.agentIds] }
        : createDefaultGroup();

    const allAgents = getAgents();
    const inheritedBatchMaxTokens = Number(getGlobalSettings().batchMaxTokens) || 16384;
    container.innerHTML = buildEditorHTML(group, allAgents, inheritedBatchMaxTokens);
    updateCount();

    let disposed = false;
    const onEscape = (event) => {
        if (event.key === 'Escape') {
            event.stopPropagation();
            cancel();
        }
    };
    const cleanup = () => {
        if (disposed) return;
        disposed = true;
        document.removeEventListener('keydown', onEscape);
    };
    const cancel = () => { cleanup(); cb.onCancel?.(); };

    $('#sae-group-back, #sae-group-cancel').on('click', cancel);

    $('#sae-group-all').on('click', () => { $('.sae-group-cb').prop('checked', true); updateCount(); });
    $('#sae-group-none').on('click', () => { $('.sae-group-cb').prop('checked', false); updateCount(); });
    container.querySelectorAll('.sae-group-cb').forEach(cb2 => cb2.addEventListener('change', updateCount));

    document.addEventListener('keydown', onEscape);

    $('#sae-group-save').on('click', () => {
        const updated = readFormToGroup(group);
        if (!updated.name) {
            toastr.warning('Group name is required.');
            $('#sae-group-name').focus();
            return;
        }
        const saved = saveGroup(updated);
        debug(`${LOG_PREFIX} saved group ${saved.name} (${saved.id}) — ${saved.agentIds.length} member(s)`);
        toastr.success(`Group "${saved.name}" saved.`);
        cleanup();
        cb.onSaved?.(saved);
    });

    return cleanup;
}

// ============================================================================
// HELPERS
// ============================================================================

function esc(str) {
    const div = document.createElement('div');
    div.textContent = str ?? '';
    return div.innerHTML;
}
