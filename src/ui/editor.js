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
        selfMemory: false, selfMemoryCount: 0,
    };
    const mv = agent.mergeVariable ?? {};
    // Self-memory only functions when the agent runs a sidecar AND persists its
    // output to a merge variable (that variable's per-swipe history is what
    // self-memory reads back). Without both, the checkbox is a dead control, so
    // the editor greys it out rather than pretending it does something.
    const selfMemEligible = !!(agent.sidecarCall?.enabled && mv.variableName);

    // The Continuity Guard is structurally unique: no prompt, no sidecar, no
    // merge variable. Detected structurally so a rename can't break it. When
    // true, the Prompt section is replaced with a short explainer + N field.
    const isGuard = agent.sourceTemplateId === 'tpl-continuity-guard'
        || agent.continuityGuard?.enabled === true;
    // Current N for whichever field renders (top-level first, then legacy block).
    const everyNValue = (typeof agent.everyN === 'number' && agent.everyN > 0)
        ? agent.everyN
        : (typeof agent.continuityGuard?.everyN === 'number' && agent.continuityGuard.everyN > 0
            ? agent.continuityGuard.everyN
            : (isGuard ? 5 : 1));

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

        ${isGuard ? `
        <div class="sam-divider-label"><i class="fa-solid fa-shield-halved"></i> Continuity Guard</div>
        <p class="sae-hint">This agent has no prompt. It watches your State Card and deterministically flags likely continuity breaks — a character speaking who isn't in the tracked roster, or someone acting against a tracked condition — by dropping a subtle clickable flag under the message. The expensive confirm-and-repair LLM call runs only when you click that flag. It requires an enabled State Card agent and no-ops without one.</p>
        <div class="sae-field">
            <div class="sae-label">Sweep every N messages</div>
            <div class="sae-desc">Even on quiet stretches with no detected break, force an open review at least this often. A real deterministic hit flags immediately and resets the count. Default 5.</div>
            <input type="number" id="sae-everyn" class="sae-input" min="1" step="1" value="${everyNValue}" style="max-width:120px">
        </div>
        ` : `
        <div class="sam-divider-label"><i class="fa-solid fa-terminal"></i> Prompt</div>
        <p class="sae-hint">The system prompt sent to the LLM. Supports SillyTavern macros ({{char}}, {{user}}, etc.).</p>
        <textarea id="sae-prompt" class="sae-textarea" rows="10" placeholder="You are a skilled editor...">${esc(agent.prompt)}</textarea>
        `}

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
        ${isGuard ? '' : `
        <div class="sae-field">
            <div class="sae-label">Run every N messages</div>
            <div class="sae-desc">Throttle how often this agent actually fires. 1 = every message (default). 3 = only every 3rd new message, skipping the two in between — useful for expensive agents you want active but not on every turn. Counts new messages only (not swipes or regenerations).</div>
            <input type="number" id="sae-everyn" class="sae-input" min="1" step="1" value="${everyNValue}" style="max-width:120px">
        </div>
        `}
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
            <div id="sae-memory-block">
                <div class="sam-divider-label"><i class="fa-solid fa-brain"></i> Memory / Carry Output</div>
                <p class="sae-hint">Remember this agent's output and feed it back next turn — for trackers that build on what they said before.</p>
                <div class="sam-row">
                    <div class="sam-row-info">
                        <div class="sam-row-title">Remember this agent's output</div>
                        <div class="sam-row-desc">Store the output and hand it back to this agent on the next turn.</div>
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
                    <div id="sae-carryout-conflict-note" class="sae-hint sae-hidden"><i class="fa-solid fa-circle-info"></i> Disabled because "Self-memory" (under Rich Context) is on. Both feed this agent its own output from the same source, so only one can be active. Turn off self-memory there to feed the output back this way instead.</div>
                    <div class="sae-field">
                        <div class="sae-label">Label for the fed-back block (optional)</div>
                        <div class="sae-desc">Shown above the previous output, e.g. "Previously established Wants &amp; Needs:".</div>
                        <input type="text" id="sae-mv-header" class="sae-input" value="${esc(mv.formatHeader || '')}" placeholder="Previously established:">
                    </div>
                    <div class="sae-field">
                        <div class="sae-label">How each remembered item is shown</div>
                        <div class="sae-desc">The line format for each stored item when fed back. Use <code>{{fieldname}}</code> placeholders (e.g. <code>Location: {{location}} | Time: {{time}}</code>). Leave as <code>{{text}}</code> for plain single-value memory.</div>
                        <input type="text" id="sae-mv-formatitem" class="sae-input" value="${esc(mv.formatItem || '')}" placeholder="{{text}}">
                    </div>
                    <div class="sae-field">
                        <div class="sae-label">Shown when nothing is remembered yet</div>
                        <div class="sae-desc">Text fed back on the first turn, before this agent has produced anything.</div>
                        <input type="text" id="sae-mv-formatempty" class="sae-input" value="${esc(mv.formatEmpty || '')}" placeholder="No prior data.">
                    </div>
                    <div class="sam-row">
                        <div class="sam-row-info">
                            <div class="sam-row-title">Remove the raw tag from the message</div>
                            <div class="sam-row-desc">Strip the extracted tag out of the visible reply after reading it. Leave off unless the agent writes a tag into the message itself.</div>
                        </div>
                        <label class="sam-switch">
                            <input type="checkbox" id="sae-mv-strip" ${mv.stripFromResponse ? 'checked' : ''}>
                            <span class="sam-switch-track"></span>
                        </label>
                    </div>
                    <div class="sam-row sae-adv-toggle" id="sae-mv-adv-toggle">
                        <div class="sam-row-info">
                            <div class="sam-row-title"><i class="fa-solid fa-chevron-right" id="sae-mv-adv-chevron"></i> Advanced extraction</div>
                            <div class="sam-row-desc">How data is pulled out of this agent's answer. If the tracker stops updating, the cause is usually here — or re-add the agent from the library to restore the original.</div>
                        </div>
                    </div>
                    <div id="sae-memory-advanced" class="sae-hidden">
                        <div class="sae-field">
                            <div class="sae-label">Storage mode</div>
                            <div class="sae-desc">Snapshot replaces the stored state each turn (trackers). Accumulate builds a list over time, updating items by key (running logs).</div>
                            <select id="sae-mv-mode" class="sae-select">
                                <option value="snapshot" ${mv.mode !== 'accumulate' ? 'selected' : ''}>Snapshot — replace each turn</option>
                                <option value="accumulate" ${mv.mode === 'accumulate' ? 'selected' : ''}>Accumulate — build a list over time</option>
                            </select>
                        </div>
                        <div class="sae-field">
                            <div class="sae-label">Extraction pattern (regex)</div>
                            <div class="sae-desc">A regular expression whose capture groups fill the fields below, in order. Leave empty for plain whole-output memory. Invalid or non-matching patterns simply store nothing — they don't break anything.</div>
                            <input type="text" id="sae-mv-pattern" class="sae-input" value="${esc(mv.extractPattern || '')}" placeholder="\\[TAG\\|([^|]+)\\|([^\\]]+)\\]">
                        </div>
                        <div class="sae-field">
                            <div class="sae-label">Field names</div>
                            <div class="sae-desc">Comma-separated names for the capture groups, in order (e.g. <code>location, time</code>). These are the names you use in the format line above.</div>
                            <input type="text" id="sae-mv-fields" class="sae-input" value="${esc((mv.fieldNames || []).join(', '))}" placeholder="text">
                        </div>
                        <div class="sae-field">
                            <div class="sae-label">Key fields</div>
                            <div class="sae-desc">Which field(s) identify a unique item, for Accumulate mode's update/merge. Ignored in Snapshot mode. Comma-separated.</div>
                            <input type="text" id="sae-mv-keyfields" class="sae-input" value="${esc((mv.keyFields || []).join(', '))}" placeholder="text">
                        </div>
                    </div>
                    <div id="sae-memory-post-note" class="sae-hint"><i class="fa-solid fa-hourglass-half"></i> Without an extraction pattern, memory carries this agent's whole output and works on the pre-gen leg only. Post-gen trackers need an extraction pattern (set one under Advanced).</div>
                </div>
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
                <div class="sae-check-row">
                    <label class="sae-check ${selfMemEligible ? '' : 'sae-check-disabled'}"><input type="checkbox" id="sae-rc-selfmemory" ${rc.selfMemory ? 'checked' : ''} ${selfMemEligible ? '' : 'disabled'}> Self-memory (own recent output)</label>
                </div>
                <div id="sae-selfmem-conflict-note" class="sae-hint sae-hidden"><i class="fa-solid fa-circle-info"></i> Turned off because "Feed previous output back in" (under Memory / Carry Output) is on. Both feed this agent its own output from the same source, so only one can be active. Turn off carry-output there to use self-memory instead.</div>
                <div class="sae-field">
                    <div class="sae-label">Self-memory turns</div>
                    <div class="sae-desc">${selfMemEligible
                        ? `Show this agent its own last N outputs (from the active swipe of each turn), so it can build on them instead of repeating itself. 0 = none. Requires Self-memory checked. Reads from per-swipe snapshots, so it follows the swipe you're viewing.`
                        : `Unavailable for this agent. Self-memory needs the sidecar call enabled and a merge variable to store output in — this agent has neither, so there's nothing to remember.`}</div>
                    <input type="number" id="sae-rc-selfmemory-count" class="sae-input" min="0" max="20" value="${rc.selfMemoryCount ?? 0}" ${selfMemEligible ? '' : 'disabled'}>
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
    const includesPost = phase === 'post' || phase === 'both';
    $('#sae-injection-section').toggle(includesPre);
    $('#sae-post-section').toggle(includesPost);

    // Memory is shown for any phase now: pre-gen uses whole-output carry, and
    // post-gen trackers use extraction-pattern memory. The block stays visible
    // throughout; only the caveat note below is phase/pattern-aware.
    $('#sae-memory-block').show();

    // The "pre-gen only" caveat applies only to WHOLE-OUTPUT memory (no
    // extraction pattern). With a pattern set, memory works post-gen too, so the
    // note is irrelevant. Show it only when the agent runs post AND has no
    // pattern — i.e. the one combination where memory silently wouldn't fire.
    const hasPattern = !!($('#sae-mv-pattern').val() || '').trim();
    $('#sae-memory-post-note').toggle(includesPost && !hasPattern);

    // Phase-aware helper under the sidecar master toggle.
    const desc = phase === 'post'
        ? 'Runs after the reply and stores its output as state for later turns.'
        : phase === 'both'
            ? 'Runs before and after — two LLM calls per turn.'
            : 'Runs before generation and injects its output into the reply.';
    $('#sae-sidecar-desc').text(desc);
}

/**
 * Mutual exclusion between carry-output feedback (#sae-mv-inject) and
 * self-memory (#sae-rc-selfmemory). Both feed the agent its own output from the
 * same per-swipe history and overlap on the newest item, so only one may be on
 * (carry-output wins — see normalizeAgent). This keeps the UI state honest and
 * visible: whichever conflicting control is active, the other is unchecked,
 * disabled, and shows a one-line note explaining why.
 *
 * Called on load and whenever either toggle changes. On load, an agent saved
 * before this guard could have BOTH checked; carry-output wins, so self-memory
 * is forced off here too (the save/normalize guards then persist that).
 *
 * `changed` names the control the user just toggled ('carry' | 'self' | null),
 * so turning one ON deterministically wins the tie rather than depending on
 * scan order. A null (load-time) call defers to carry-output.
 * @param {'carry'|'self'|null} [changed=null]
 */
function syncMemoryExclusion(changed = null) {
    const $inject = $('#sae-mv-inject');
    const $self = $('#sae-rc-selfmemory');
    if (!$inject.length || !$self.length) return;

    // Self-memory is only ever eligible when its own prerequisites hold; if the
    // checkbox was rendered disabled (no sidecar / no varname), leave that as-is
    // and only manage the conflict layer on top.
    const selfPrereqDisabled = $self.prop('disabled') && !$self.data('sae-conflict-locked');

    // Resolve the conflict. If the user just turned self-memory ON, it wins this
    // interaction; otherwise carry-output wins (including the load-time default).
    // Carry-output only actually feeds when the Memory block itself is enabled,
    // so a checked "feed back" toggle under a disabled block does NOT conflict.
    let carryOn = $inject.is(':checked') && $('#sae-mv-enabled').is(':checked');
    let selfOn = $self.is(':checked');

    if (carryOn && selfOn) {
        if (changed === 'self') {
            carryOn = false;
            $inject.prop('checked', false);
        } else {
            selfOn = false;
            $self.prop('checked', false);
        }
    }

    // Apply disabled + note state based on which (if either) is active.
    // Carry-output disables self-memory:
    if (carryOn) {
        $self.prop('checked', false).prop('disabled', true).data('sae-conflict-locked', true);
        $('#sae-rc-selfmemory-count').prop('disabled', true);
        $('#sae-selfmem-conflict-note').removeClass('sae-hidden');
    } else {
        // Release the conflict lock (but respect the underlying prereq-disable).
        if ($self.data('sae-conflict-locked')) {
            $self.data('sae-conflict-locked', false);
            $self.prop('disabled', selfPrereqDisabled);
            $('#sae-rc-selfmemory-count').prop('disabled', selfPrereqDisabled);
        }
        $('#sae-selfmem-conflict-note').addClass('sae-hidden');
    }

    // Self-memory disables carry-output:
    if (selfOn) {
        $inject.prop('checked', false).prop('disabled', true);
        $('#sae-carryout-conflict-note').removeClass('sae-hidden');
    } else {
        $inject.prop('disabled', false);
        $('#sae-carryout-conflict-note').addClass('sae-hidden');
    }
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
        // General "run every N messages" throttle. 1 (or blank/invalid) = every
        // message = throttle off. Read from whichever N input the form rendered
        // (the general Execution field, or the Continuity Guard's own field).
        everyN: (() => {
            const el = document.getElementById('sae-everyn');
            if (!el) return existingAgent.everyN ?? 1;
            const v = parseInt(el.value, 10);
            return (Number.isFinite(v) && v > 0) ? v : 1;
        })(),
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
                selfMemory: $('#sae-rc-selfmemory').is(':checked'),
                selfMemoryCount: parseInt($('#sae-rc-selfmemory-count').val()) || 0,
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

    // Memory / carry-output. The controls now render for every phase and for
    // both simple and structured agents, so we write mergeVariable whenever the
    // controls are present. Everything the form exposes (format lines, strip,
    // and the Advanced extraction fields) round-trips here. Fields the form does
    // NOT expose (resolveField, resolveAction, injectFormatted's siblings) are
    // preserved via the spread of existingAgent.mergeVariable.
    const emv = existingAgent.mergeVariable ?? {};
    if ($('#sae-mv-enabled').length) {
        // Parse comma lists. Guard fieldNames/keyFields against becoming empty:
        // an empty fieldNames array would break extraction (the engine indexes
        // capture groups by it), so fall back to the existing value, then to
        // ['text']. A blank box therefore preserves rather than destroys.
        const parseList = (sel) => ($(sel).val() || '')
            .split(',').map(s => s.trim()).filter(Boolean);
        const fieldsInput = parseList('#sae-mv-fields');
        const keyFieldsInput = parseList('#sae-mv-keyfields');
        const fieldNames = fieldsInput.length ? fieldsInput
            : (emv.fieldNames?.length ? emv.fieldNames : ['text']);
        // Key fields may legitimately be empty for snapshot mode; only fall back
        // when the user left it blank AND we have a prior value to keep.
        const keyFields = keyFieldsInput.length ? keyFieldsInput
            : (emv.keyFields?.length ? emv.keyFields : fieldNames.slice(0, 1));

        result.mergeVariable = {
            ...existingAgent.mergeVariable,
            enabled: $('#sae-mv-enabled').is(':checked'),
            variableName: ($('#sae-mv-varname').val() || '').trim(),
            injectFormatted: $('#sae-mv-inject').is(':checked'),
            formatHeader: $('#sae-mv-header').val() || '',
            // Preserve an intentionally-empty field rather than inventing a
            // default: fall back to the prior value when the box is blank. This
            // keeps an untouched save byte-identical for agents that legitimately
            // leave these empty (e.g. Director, which never injects formatted
            // memory so formatEmpty stays ""). The one exception is below: a
            // NEW agent that turns injection ON with no format line at all would
            // feed back blank lines, so seed {{text}} in exactly that case.
            formatItem: (() => {
                const typed = ($('#sae-mv-formatitem').val() || '').trim();
                if (typed) return typed;
                if (emv.formatItem) return emv.formatItem;
                // Only seed a usable default when memory is actually fed back
                // and nothing prior exists — otherwise preserve empty.
                return $('#sae-mv-inject').is(':checked') ? '{{text}}' : '';
            })(),
            formatEmpty: (($('#sae-mv-formatempty').val() || '').trim()
                || emv.formatEmpty || ''),
            stripFromResponse: $('#sae-mv-strip').is(':checked'),
            mode: ($('#sae-mv-mode').val() === 'accumulate') ? 'accumulate' : 'snapshot',
            extractPattern: ($('#sae-mv-pattern').val() || '').trim(),
            fieldNames,
            keyFields,
        };
    }

    // ── Mutual exclusion: carry-output feedback vs self-memory ──
    // These feed the agent its own output from the SAME source and overlap on
    // the newest item, so they can't both be on (see normalizeAgent for the
    // full rationale). Carry-output wins. Enforced here at read time — not just
    // via the UI wiring — so a stale/raced DOM can never persist both. Mirrors
    // the normalize backstop exactly.
    const carryOutputActive = result.mergeVariable?.enabled
        && result.mergeVariable?.injectFormatted
        && !!result.mergeVariable?.variableName;
    if (carryOutputActive && result.sidecarCall?.richContext?.selfMemory) {
        result.sidecarCall.richContext.selfMemory = false;
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
    // Establish the carry-output ↔ self-memory exclusion for the loaded state.
    // A pre-guard agent with both on resolves to carry-output winning here.
    syncMemoryExclusion();

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
        // Enabling/disabling the memory block changes whether carry-output is
        // active, which drives the self-memory exclusion. Re-sync.
        syncMemoryExclusion();
    });
    // Carry-output ↔ self-memory mutual exclusion. Each toggle re-runs the sync
    // naming itself as the just-changed control so turning one ON wins the tie.
    $('#sae-mv-inject').on('change', () => syncMemoryExclusion('carry'));
    $('#sae-rc-selfmemory').on('change', () => syncMemoryExclusion('self'));
    // Advanced extraction disclosure: collapsed by default for every agent.
    // Rotate the chevron and reveal/hide the extraction fields on click.
    $('#sae-mv-adv-toggle').on('click', function () {
        const adv = $('#sae-memory-advanced');
        const nowHidden = adv.toggleClass('sae-hidden').hasClass('sae-hidden');
        $('#sae-mv-adv-chevron')
            .toggleClass('fa-chevron-right', nowHidden)
            .toggleClass('fa-chevron-down', !nowHidden);
    });
    // The post-gen caveat note depends on whether an extraction pattern exists;
    // re-run the phase/pattern visibility check as the pattern box changes.
    $('#sae-mv-pattern').on('input', updateSectionVisibility);
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
