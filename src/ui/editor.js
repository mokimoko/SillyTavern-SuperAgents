/**
 * ui/editor.js — the agent editor, rendered as an in-pane view inside the
 * unified modal's content area (not a separate overlay, per the Step 9 design).
 *
 * Ported from VerseManager's editorModal.js. Like VM, this edits the COMMON
 * fields — identity, prompt, phase, connection profile, max tokens, pre-gen
 * injection, rewrite post-processing, and activation conditions — and preserves
 * the advanced structured config (sidecarCall, mergeVariable, regexScripts,
 * stateCard, triggerPatterns, phoneConfig) untouched via object spread. Those
 * are authored through templates / JSON import, not this form.
 *
 * Entry point:
 *   renderAgentEditor(container, agentId, { onSaved, onCancel })
 *     - agentId null/undefined → new agent (createDefaultAgent)
 *     - agentId string         → edit existing
 *     - onSaved(agent)         → called after a successful save
 *     - onCancel()             → called on back/cancel/Escape
 *
 * Uses ST's ambient globals ($ / toastr), consistent with VM's editor.
 */

import { getContext } from '../../../../../extensions.js';
import { debug } from '../../index.js';
import { createDefaultAgent, getAgentById, saveAgent } from '../data/store.js';
import { AGENT_CATEGORIES } from '../data/normalize.js';

const LOG_PREFIX = '[SuperAgents/editor]';

// Escape key handler reference, so we can detach it on close.
let escHandler = null;

// ============================================================================
// PROFILE HELPERS
// ============================================================================

/** Fetch connection-profile names via the /profile-list slash command. */
async function getConnectionProfiles() {
    try {
        const context = getContext();
        const result = await context.executeSlashCommandsWithOptions('/profile-list');
        const parsed = JSON.parse(result.pipe);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

// ============================================================================
// BUILD HTML
// ============================================================================

function buildEditorHTML(agent, profiles) {
    const catOptions = Object.entries(AGENT_CATEGORIES)
        .map(([key, val]) => `<option value="${key}" ${agent.category === key ? 'selected' : ''}>${val.label}</option>`)
        .join('');
    const profileOptions = profiles
        .map(name => `<option value="${esc(name)}" ${agent.connectionProfile === name ? 'selected' : ''}>${esc(name)}</option>`)
        .join('');

    const pp = agent.postProcess;
    const cond = agent.conditions;
    const inj = agent.injection;

    return `
    <div class="sae-head">
        <button class="sam-btn sae-back" id="sae-back"><i class="fa-solid fa-arrow-left"></i> Back</button>
        <div class="sae-head-title">${agent.name ? 'Edit Agent' : 'New Agent'}</div>
    </div>

    <div class="sae-form">
        <div class="sam-divider-label"><i class="fa-solid fa-id-card"></i> Identity</div>

        <div class="sae-field">
            <div class="sae-label">Name</div>
            <input type="text" id="sae-name" class="sae-input" value="${esc(agent.name)}" placeholder="My Agent">
        </div>
        <div class="sae-field">
            <div class="sae-label">Description</div>
            <input type="text" id="sae-desc" class="sae-input" value="${esc(agent.description)}" placeholder="What does this agent do?">
        </div>
        <div class="sae-row">
            <div class="sae-field sae-grow">
                <div class="sae-label">Category</div>
                <select id="sae-category" class="sae-select">${catOptions}</select>
            </div>
            <div class="sae-field sae-grow">
                <div class="sae-label">Author</div>
                <input type="text" id="sae-author" class="sae-input" value="${esc(agent.author)}" placeholder="Optional">
            </div>
        </div>
        <div class="sae-field">
            <div class="sae-label">Tags</div>
            <input type="text" id="sae-tags" class="sae-input" value="${esc((agent.tags || []).join(', '))}" placeholder="prose, editing, quality (comma-separated)">
        </div>

        <div class="sam-divider-label"><i class="fa-solid fa-terminal"></i> Prompt</div>
        <p class="sae-hint">The system prompt sent to the LLM. Supports SillyTavern macros ({{char}}, {{user}}, etc.).</p>
        <textarea id="sae-prompt" class="sae-textarea" rows="10" placeholder="You are a skilled editor...">${esc(agent.prompt)}</textarea>

        <div class="sam-divider-label"><i class="fa-solid fa-gears"></i> Execution</div>
        <div class="sae-field">
            <div class="sae-label">Phase</div>
            <div class="sae-desc">When this agent runs relative to the main generation.</div>
            <select id="sae-phase" class="sae-select">
                <option value="pre" ${agent.phase === 'pre' ? 'selected' : ''}>Pre-gen — inject prompt before generation</option>
                <option value="post" ${agent.phase === 'post' ? 'selected' : ''}>Post-gen — process after response arrives</option>
                <option value="both" ${agent.phase === 'both' ? 'selected' : ''}>Both — inject pre + process post</option>
            </select>
        </div>
        <div class="sae-row">
            <div class="sae-field sae-grow">
                <div class="sae-label">Connection Profile</div>
                <div class="sae-desc">LLM connection for this agent's own calls (sidecar / rewrite).</div>
                <select id="sae-profile" class="sae-select">
                    <option value="">Use current connection</option>
                    ${profileOptions}
                </select>
            </div>
            <div class="sae-field sae-fixed">
                <div class="sae-label">Max Tokens</div>
                <input type="number" id="sae-max-tokens" class="sae-input" min="64" max="32000" value="${agent.maxTokens}">
            </div>
        </div>

        <div id="sae-injection-section">
            <div class="sam-divider-label"><i class="fa-solid fa-syringe"></i> Pre-gen Injection</div>
            <p class="sae-hint">Where this agent's prompt is placed in the context during generation.</p>
            <div class="sae-row">
                <div class="sae-field sae-grow">
                    <div class="sae-label">Position</div>
                    <select id="sae-inj-position" class="sae-select">
                        <option value="0" ${inj.position === 0 ? 'selected' : ''}>In Prompt (top-level)</option>
                        <option value="1" ${inj.position === 1 ? 'selected' : ''}>In Chat (at depth)</option>
                        <option value="2" ${inj.position === 2 ? 'selected' : ''}>Before Prompt</option>
                    </select>
                </div>
                <div class="sae-field sae-fixed">
                    <div class="sae-label">Depth</div>
                    <input type="number" id="sae-inj-depth" class="sae-input" min="0" max="99" value="${inj.depth}">
                </div>
            </div>
            <div class="sae-row">
                <div class="sae-field sae-grow">
                    <div class="sae-label">Role</div>
                    <select id="sae-inj-role" class="sae-select">
                        <option value="0" ${inj.role === 0 ? 'selected' : ''}>System</option>
                        <option value="1" ${inj.role === 1 ? 'selected' : ''}>User</option>
                        <option value="2" ${inj.role === 2 ? 'selected' : ''}>Assistant</option>
                    </select>
                </div>
                <div class="sae-field sae-fixed">
                    <div class="sae-label">Order</div>
                    <input type="number" id="sae-inj-order" class="sae-input" min="0" max="999" value="${inj.order}">
                </div>
            </div>
            <div class="sam-row">
                <div class="sam-row-info">
                    <div class="sam-row-title">Scan for World Info</div>
                    <div class="sam-row-desc">Enable WI keyword scanning on this agent's prompt.</div>
                </div>
                <label class="sam-switch">
                    <input type="checkbox" id="sae-inj-scan" ${inj.scan ? 'checked' : ''}>
                    <span class="sam-switch-track"></span>
                </label>
            </div>
        </div>

        <div id="sae-post-section">
            <div class="sam-divider-label"><i class="fa-solid fa-wand-magic-sparkles"></i> Post-Processing</div>
            <div class="sam-row">
                <div class="sam-row-info">
                    <div class="sam-row-title">Rewrite mode</div>
                    <div class="sam-row-desc">Send the AI response back through this agent's prompt for revision.</div>
                </div>
                <label class="sam-switch">
                    <input type="checkbox" id="sae-rewrite-enabled" ${pp.rewriteEnabled ? 'checked' : ''}>
                    <span class="sam-switch-track"></span>
                </label>
            </div>
            <div id="sae-rewrite-settings" class="${pp.rewriteEnabled ? '' : 'sae-hidden'}">
                <div class="sae-row">
                    <div class="sae-field sae-grow">
                        <div class="sae-label">Rewrite strategy</div>
                        <select id="sae-rewrite-mode" class="sae-select">
                            <option value="rewrite" ${pp.rewriteMode === 'rewrite' ? 'selected' : ''}>Replace — rewrite the full response</option>
                            <option value="append" ${pp.rewriteMode === 'append' ? 'selected' : ''}>Append — add content after the response</option>
                        </select>
                    </div>
                    <div class="sae-field sae-fixed">
                        <div class="sae-label">Rewrite Tokens</div>
                        <input type="number" id="sae-rewrite-tokens" class="sae-input" min="64" max="32000" value="${pp.rewriteMaxTokens}">
                    </div>
                </div>
            </div>
        </div>

        <div class="sam-divider-label"><i class="fa-solid fa-filter"></i> Conditions</div>
        <div class="sae-field">
            <div class="sae-label">Trigger probability</div>
            <div class="sae-desc">Chance this agent activates each generation (100 = always).</div>
            <div class="sae-slider-row">
                <input type="range" id="sae-probability" min="0" max="100" value="${cond.triggerProbability}">
                <span id="sae-probability-val" class="sae-slider-val">${cond.triggerProbability}%</span>
            </div>
        </div>
        <div class="sae-field">
            <div class="sae-label">Generation types</div>
            <div class="sae-desc">Which generation types can trigger this agent.</div>
            <div class="sae-check-row">
                <label class="sae-check"><input type="checkbox" id="sae-gen-normal" ${cond.generationTypes.includes('normal') ? 'checked' : ''}> Normal</label>
                <label class="sae-check"><input type="checkbox" id="sae-gen-continue" ${cond.generationTypes.includes('continue') ? 'checked' : ''}> Continue</label>
                <label class="sae-check"><input type="checkbox" id="sae-gen-impersonate" ${cond.generationTypes.includes('impersonate') ? 'checked' : ''}> Impersonate</label>
            </div>
        </div>
        <div class="sae-field">
            <div class="sae-label">Trigger keywords</div>
            <div class="sae-desc">Only activate if the last message contains one of these (empty = always).</div>
            <input type="text" id="sae-keywords" class="sae-input" value="${esc((cond.triggerKeywords || []).join(', '))}" placeholder="fight, battle, combat (comma-separated)">
        </div>
    </div>

    <div class="sae-foot">
        <button class="sam-btn" id="sae-cancel">Cancel</button>
        <button class="sam-btn sam-btn-accent" id="sae-save"><i class="fa-solid fa-floppy-disk"></i> Save</button>
    </div>`;
}

// ============================================================================
// SECTION VISIBILITY + FORM READ
// ============================================================================

function updateSectionVisibility() {
    const phase = $('#sae-phase').val();
    $('#sae-injection-section').toggle(phase === 'pre' || phase === 'both');
    $('#sae-post-section').toggle(phase === 'post' || phase === 'both');
}

function readFormToAgent(existingAgent) {
    const tags = ($('#sae-tags').val() || '').split(',').map(t => t.trim()).filter(Boolean);
    const keywords = ($('#sae-keywords').val() || '').split(',').map(t => t.trim()).filter(Boolean);

    const genTypes = [];
    if ($('#sae-gen-normal').is(':checked')) genTypes.push('normal');
    if ($('#sae-gen-continue').is(':checked')) genTypes.push('continue');
    if ($('#sae-gen-impersonate').is(':checked')) genTypes.push('impersonate');

    return {
        ...existingAgent,
        name: ($('#sae-name').val() || '').trim(),
        description: ($('#sae-desc').val() || '').trim(),
        category: $('#sae-category').val(),
        author: ($('#sae-author').val() || '').trim(),
        tags,
        prompt: $('#sae-prompt').val() || '',
        phase: $('#sae-phase').val(),
        connectionProfile: $('#sae-profile').val() || '',
        maxTokens: parseInt($('#sae-max-tokens').val()) || 8192,
        injection: {
            ...existingAgent.injection,
            position: parseInt($('#sae-inj-position').val()),
            depth: parseInt($('#sae-inj-depth').val()) || 1,
            role: parseInt($('#sae-inj-role').val()),
            order: parseInt($('#sae-inj-order').val()) || 100,
            scan: $('#sae-inj-scan').is(':checked'),
        },
        postProcess: {
            ...existingAgent.postProcess,
            rewriteEnabled: $('#sae-rewrite-enabled').is(':checked'),
            rewriteMode: $('#sae-rewrite-mode').val(),
            rewriteMaxTokens: parseInt($('#sae-rewrite-tokens').val()) || 8192,
        },
        conditions: {
            ...existingAgent.conditions,
            triggerKeywords: keywords,
            triggerProbability: parseInt($('#sae-probability').val()),
            generationTypes: genTypes,
        },
    };
}

// ============================================================================
// PUBLIC: RENDER EDITOR INTO A CONTAINER
// ============================================================================

/**
 * Render the agent editor into a container (the modal's content pane).
 * @param {HTMLElement} container
 * @param {string|null} agentId  null/undefined → new agent
 * @param {{onSaved?:function(object):void, onCancel?:function():void}} [cb]
 */
export async function renderAgentEditor(container, agentId, cb = {}) {
    const existing = agentId ? getAgentById(agentId) : null;
    const agent = existing ? { ...existing } : createDefaultAgent();

    container.innerHTML = `<div class="sam-empty sam-empty-sm">Loading editor…</div>`;
    const profiles = await getConnectionProfiles();
    container.innerHTML = buildEditorHTML(agent, profiles);

    updateSectionVisibility();

    const cleanup = () => {
        if (escHandler) { document.removeEventListener('keydown', escHandler); escHandler = null; }
    };
    const cancel = () => { cleanup(); cb.onCancel?.(); };

    $('#sae-phase').on('change', updateSectionVisibility);
    $('#sae-rewrite-enabled').on('change', function () {
        $('#sae-rewrite-settings').toggleClass('sae-hidden', !this.checked);
    });
    $('#sae-probability').on('input', function () {
        $('#sae-probability-val').text(this.value + '%');
    });

    $('#sae-back, #sae-cancel').on('click', cancel);

    escHandler = (e) => { if (e.key === 'Escape') { e.stopPropagation(); cancel(); } };
    document.addEventListener('keydown', escHandler);

    $('#sae-save').on('click', () => {
        const updated = readFormToAgent(agent);
        if (!updated.name) {
            toastr.warning('Agent name is required.');
            $('#sae-name').focus();
            return;
        }
        const saved = saveAgent(updated);
        debug(`${LOG_PREFIX} saved agent ${saved.name} (${saved.id})`);
        toastr.success(`Agent "${saved.name}" saved.`);
        cleanup();
        cb.onSaved?.(saved);
    });
}

// ============================================================================
// HELPERS
// ============================================================================

function esc(str) {
    const div = document.createElement('div');
    div.textContent = str ?? '';
    return div.innerHTML;
}
