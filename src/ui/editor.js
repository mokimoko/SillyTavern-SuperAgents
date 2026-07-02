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
import { createIconPicker } from './iconPicker.js';

const LOG_PREFIX = '[SuperAgents/editor]';

// Escape key handler reference, so we can detach it on close.
let escHandler = null;

// Live icon-picker instance for the open editor, so readFormToAgent (a
// standalone function) can read the chosen class without a closure.
let iconPicker = null;

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
    const rc = agent.sidecarCall?.richContext ?? {
        enabled: false, character: false, persona: false, worldInfo: false,
        summary: false, authorsNote: false, pendingUser: false, historyCount: 0,
    };
    const mv = agent.mergeVariable ?? {};
    // "Advanced" = template-authored structured extraction. Simple carry-output
    // toggles step aside for these so a save can't clobber their config.
    const mvAdvanced = (mv.fieldNames?.length > 1) || !!mv.extractPattern;

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
            <div class="sae-label">Icon</div>
            <div class="sae-desc">Shown in the manager and the hover panel. Overrides the category icon. Leave on the category default if unsure.</div>
            <div id="sae-icon-mount"></div>
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

        <div id="sae-sidecar-section">
            <div class="sam-divider-label"><i class="fa-solid fa-satellite-dish"></i> LLM Call (Sidecar)</div>
            <p class="sae-hint">Let this agent make its own LLM call, separate from the main generation. Required for rich context and for anything that needs the model's own output (trackers, planners).</p>
            <div class="sam-row">
                <div class="sam-row-info">
                    <div class="sam-row-title">Make its own LLM call</div>
                    <div class="sam-row-desc" id="sae-sidecar-desc">Runs before generation and injects its output into the reply.</div>
                </div>
                <label class="sam-switch">
                    <input type="checkbox" id="sae-sidecar-enabled" ${agent.sidecarCall?.enabled ? 'checked' : ''}>
                    <span class="sam-switch-track"></span>
                </label>
            </div>
            ${!mvAdvanced ? `
            <div id="sae-memory-block">
                <div class="sam-divider-label"><i class="fa-solid fa-brain"></i> Memory / Carry Output</div>
                <p class="sae-hint">Remember this agent's last output and feed it back next turn — for trackers that build on what they said before. No display or extraction pattern needed.</p>
                <div class="sam-row">
                    <div class="sam-row-info">
                        <div class="sam-row-title">Remember this agent's output</div>
                        <div class="sam-row-desc">Store the whole output and hand it back to this agent on the next turn.</div>
                    </div>
                    <label class="sam-switch">
                        <input type="checkbox" id="sae-mv-enabled" ${mv.enabled ? 'checked' : ''}>
                        <span class="sam-switch-track"></span>
                    </label>
                </div>
                <div id="sae-memory-fields" class="${mv.enabled ? '' : 'sae-hidden'}">
                    <div class="sae-field">
                        <div class="sae-label">Variable name</div>
                        <div class="sae-desc">A name to store the output under.</div>
                        <input type="text" id="sae-mv-varname" class="sae-input" value="${esc(mv.variableName || '')}" placeholder="wants_needs">
                    </div>
                    <div class="sam-row">
                        <div class="sam-row-info">
                            <div class="sam-row-title">Feed previous output back in</div>
                            <div class="sam-row-desc">Include last turn's stored output in this agent's prompt for continuity.</div>
                        </div>
                        <label class="sam-switch">
                            <input type="checkbox" id="sae-mv-inject" ${mv.injectFormatted !== false ? 'checked' : ''}>
                            <span class="sam-switch-track"></span>
                        </label>
                    </div>
                    <div class="sae-field">
                        <div class="sae-label">Label for the fed-back block (optional)</div>
                        <div class="sae-desc">Shown above the previous output, e.g. "Previously established Wants &amp; Needs:".</div>
                        <input type="text" id="sae-mv-header" class="sae-input" value="${esc(mv.formatHeader || '')}" placeholder="Previously established:">
                    </div>
                </div>
            </div>` : `
            <div id="sae-memory-advanced-note" class="sae-hint"><i class="fa-solid fa-lock"></i> This agent uses structured extraction (authored via template). Edit its JSON to change memory settings.</div>`}
            <div id="sae-memory-post-note" class="sae-hint"><i class="fa-solid fa-hourglass-half"></i> Structured extraction is required for post-gen memory — simple carry-output is pre-gen only for now.</div>
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
            <div class="sae-field">
                <div class="sae-label">Injection template</div>
                <div class="sae-desc">Wraps this agent's output before it enters the main prompt. Use <code>{{output}}</code> for the text. Empty = inject raw. (e.g. a Director plan wrapped in &lt;director&gt;…&lt;/director&gt; so the writer treats it as direction, not dialogue.)</div>
                <textarea id="sae-inj-template" class="sae-textarea" rows="3" placeholder="<director>\n{{output}}\n</director>">${esc(inj.template || '')}</textarea>
            </div>
        </div>

        <div id="sae-richctx-section">
            <div class="sam-divider-label"><i class="fa-solid fa-book-open"></i> Rich Context</div>
            <p class="sae-hint">Give this agent the same inputs the main chat sees. Requires the agent to make its own LLM call (sidecar/pre-gen). All off = the agent only gets the plain recent history it would otherwise receive.</p>
            <div id="sae-richctx-warn" class="sae-hint" style="color:var(--warning,#e0a030);${agent.sidecarCall?.enabled ? 'display:none' : ''}"><i class="fa-solid fa-triangle-exclamation"></i> This agent has no sidecar/pre-gen LLM call configured, so rich context won't be used. Director and tracker templates set this up; custom agents need a sidecar call (authored via template/JSON import).</div>
            <div class="sam-row">
                <div class="sam-row-info">
                    <div class="sam-row-title">Enable rich context</div>
                    <div class="sam-row-desc">Master switch for the sections below.</div>
                </div>
                <label class="sam-switch">
                    <input type="checkbox" id="sae-rc-enabled" ${rc.enabled ? 'checked' : ''}>
                    <span class="sam-switch-track"></span>
                </label>
            </div>
            <div id="sae-richctx-flags" class="${rc.enabled ? '' : 'sae-hidden'}">
                <div class="sae-check-row">
                    <label class="sae-check"><input type="checkbox" id="sae-rc-character" ${rc.character ? 'checked' : ''}> Character card</label>
                    <label class="sae-check"><input type="checkbox" id="sae-rc-persona" ${rc.persona ? 'checked' : ''}> Player persona</label>
                    <label class="sae-check"><input type="checkbox" id="sae-rc-worldinfo" ${rc.worldInfo ? 'checked' : ''}> World Info / lore</label>
                </div>
                <div class="sae-check-row">
                    <label class="sae-check"><input type="checkbox" id="sae-rc-summary" ${rc.summary ? 'checked' : ''}> Running summary</label>
                    <label class="sae-check"><input type="checkbox" id="sae-rc-authorsnote" ${rc.authorsNote ? 'checked' : ''}> Author's Note</label>
                    <label class="sae-check"><input type="checkbox" id="sae-rc-pendinguser" ${rc.pendingUser ? 'checked' : ''}> Pending user message</label>
                </div>
                <div class="sae-field">
                    <div class="sae-label">History messages</div>
                    <div class="sae-desc">How many recent messages to include as a labelled block (0 = none). The pending user message is added separately above.</div>
                    <input type="number" id="sae-rc-history" class="sae-input" min="0" max="100" value="${rc.historyCount}">
                </div>
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
    const includesPre = phase === 'pre' || phase === 'both';
    $('#sae-injection-section').toggle(includesPre);
    $('#sae-post-section').toggle(phase === 'post' || phase === 'both');

    // Simple carry-output memory only works on the pre-gen leg today (the
    // engine's no-regex raw-blob store exists only there). Post-only gets a
    // "coming later" note instead of toggles that would silently store nothing.
    $('#sae-memory-block').toggle(includesPre);
    $('#sae-memory-advanced-note').toggle(includesPre);
    $('#sae-memory-post-note').toggle(phase === 'post');

    // Phase-aware helper under the sidecar master toggle.
    const desc = phase === 'post'
        ? 'Runs after the reply and stores its output as state for later turns.'
        : phase === 'both'
            ? 'Runs before and after — two LLM calls per turn.'
            : 'Runs before generation and injects its output into the reply.';
    $('#sae-sidecar-desc').text(desc);
}

function readFormToAgent(existingAgent) {
    const tags = ($('#sae-tags').val() || '').split(',').map(t => t.trim()).filter(Boolean);
    const keywords = ($('#sae-keywords').val() || '').split(',').map(t => t.trim()).filter(Boolean);

    const genTypes = [];
    if ($('#sae-gen-normal').is(':checked')) genTypes.push('normal');
    if ($('#sae-gen-continue').is(':checked')) genTypes.push('continue');
    if ($('#sae-gen-impersonate').is(':checked')) genTypes.push('impersonate');

    const result = {
        ...existingAgent,
        name: ($('#sae-name').val() || '').trim(),
        description: ($('#sae-desc').val() || '').trim(),
        icon: iconPicker ? iconPicker.getValue() : (existingAgent.icon || ''),
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
            template: $('#sae-inj-template').val() || '',
        },
        // Write the master call toggle + rich-context flags, preserving the
        // rest of the sidecar config (maxTokens, responseKey, display, etc.)
        // which this form doesn't expose.
        sidecarCall: {
            ...existingAgent.sidecarCall,
            enabled: $('#sae-sidecar-enabled').is(':checked'),
            richContext: {
                ...(existingAgent.sidecarCall?.richContext ?? {}),
                enabled: $('#sae-rc-enabled').is(':checked'),
                character: $('#sae-rc-character').is(':checked'),
                persona: $('#sae-rc-persona').is(':checked'),
                worldInfo: $('#sae-rc-worldinfo').is(':checked'),
                summary: $('#sae-rc-summary').is(':checked'),
                authorsNote: $('#sae-rc-authorsnote').is(':checked'),
                pendingUser: $('#sae-rc-pendinguser').is(':checked'),
                historyCount: parseInt($('#sae-rc-history').val()) || 0,
            },
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

    // Simple carry-output memory. Only write mergeVariable when the simple
    // controls are actually present (pre-gen leg + agent not already
    // structured). Otherwise the top-level spread preserves template-authored
    // mergeVariable untouched — this is the seam that lets post/both slot in
    // later without rework. Never write extractPattern here (leave it empty).
    const mvPhase = $('#sae-phase').val();
    const mvIncludesPre = mvPhase === 'pre' || mvPhase === 'both';
    const emv = existingAgent.mergeVariable ?? {};
    const mvAdvanced = (emv.fieldNames?.length > 1) || !!emv.extractPattern;
    if (mvIncludesPre && !mvAdvanced && $('#sae-mv-enabled').length) {
        result.mergeVariable = {
            ...existingAgent.mergeVariable,
            enabled: $('#sae-mv-enabled').is(':checked'),
            variableName: ($('#sae-mv-varname').val() || '').trim(),
            injectFormatted: $('#sae-mv-inject').is(':checked'),
            formatHeader: $('#sae-mv-header').val() || '',
            // Pin simple mode to single-field snapshot, no extraction regex.
            mode: 'snapshot',
            fieldNames: (emv.fieldNames?.length ? emv.fieldNames : ['text']),
            formatItem: (emv.formatItem || '{{text}}'),
            formatEmpty: (emv.formatEmpty || 'No prior data.'),
        };
    }

    return result;
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

    // Mount the searchable icon picker into its placeholder.
    iconPicker = createIconPicker({ value: agent.icon || '' });
    const iconMount = container.querySelector('#sae-icon-mount');
    if (iconMount) iconMount.appendChild(iconPicker.el);

    const cleanup = () => {
        if (escHandler) { document.removeEventListener('keydown', escHandler); escHandler = null; }
        iconPicker = null;
    };
    const cancel = () => { cleanup(); cb.onCancel?.(); };

    $('#sae-phase').on('change', updateSectionVisibility);
    $('#sae-rewrite-enabled').on('change', function () {
        $('#sae-rewrite-settings').toggleClass('sae-hidden', !this.checked);
    });
    $('#sae-rc-enabled').on('change', function () {
        $('#sae-richctx-flags').toggleClass('sae-hidden', !this.checked);
    });
    $('#sae-sidecar-enabled').on('change', function () {
        // The rich-context warning is moot once the agent has its own call.
        $('#sae-richctx-warn').toggle(!this.checked);
    });
    $('#sae-mv-enabled').on('change', function () {
        $('#sae-memory-fields').toggleClass('sae-hidden', !this.checked);
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
