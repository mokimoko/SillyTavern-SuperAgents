/**
 * ui/editor.js — the agent editor, rendered as an in-pane view inside the
 * unified modal's content area (not a separate overlay, per the Step 9 design).
 *
 * Presents the execution route first (when the agent runs and whether it uses
 * direct injection, a sidecar call, or a rewrite), then reveals only the
 * relevant context, memory, extraction, and post-processing controls. The
 * structured-memory builder is shared by new and library agents; bespoke
 * renderer schemas and phone/guard internals remain template-owned.
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

import { characters } from '../../../../../../script.js';
import { groups } from '../../../../../group-chats.js';
import { tags as stTags } from '../../../../../tags.js';
import { debug } from '../core/runtime.js';
import { createDefaultAgent, getAgentById, getGlobalSettings, saveAgent } from '../data/store.js';
import { listConnectionProfiles } from '../core/profiles.js';
import { refreshMacros } from '../core/macros.js';
import { AGENT_CATEGORIES } from '../data/normalize.js';
import { createIconPicker } from './iconPicker.js';
import { createStructuredMemoryBuilder } from './structuredMemoryBuilder.js';

const LOG_PREFIX = '[SuperAgents/editor]';

// Escape key handler reference, so we can detach it on close.

// Live icon-picker instance for the open editor, so readFormToAgent (a
// standalone function) can read the chosen class without a closure.
let iconPicker = null;
let structuredMemoryBuilder = null;

// ============================================================================
// BUILD HTML
// ============================================================================

function buildEditorHTML(agent, profiles) {
    const catOptions = Object.entries(AGENT_CATEGORIES)
        .map(([key, val]) => `<option value="${key}" ${agent.category === key ? 'selected' : ''}>${val.label}</option>`)
        .join('');
    const profileOptions = profiles
        .map(profile => `<option value="${esc(profile.name)}" ${agent.connectionProfile === profile.name || agent.connectionProfile === profile.id ? 'selected' : ''}>${esc(profile.name)}</option>`)
        .join('');
    const globalSettings = getGlobalSettings();
    const defaultProfileRef = String(globalSettings.connectionProfile || '');
    const defaultProfile = profiles.find(profile => profile.name === defaultProfileRef || profile.id === defaultProfileRef);
    const inheritedProfileLabel = globalSettings.useDefaultConnection && defaultProfileRef
        ? `Use default connection — ${defaultProfile?.name || `${defaultProfileRef} (missing)`}`
        : 'Use current SillyTavern connection';
    const templateLinked = Boolean(agent.sourceTemplateId) && agent.sourceTemplateLinked !== false;

    const pp = agent.postProcess;
    const cond = agent.conditions;
    const stateGate = cond.stateGate ?? {
        enabled: false, variableName: '', jsonField: 'json', path: '', operator: 'eq', value: 'true', requireFresh: true,
    };
    const inj = agent.injection;
    const rc = agent.sidecarCall?.richContext ?? {
        enabled: false, character: false, persona: false, worldInfo: false,
        summary: false, simpleSummarizer: false, authorsNote: false, pendingUser: false, historyCount: 0,
        selfMemory: false, selfMemoryCount: 0,
    };
    const mv = agent.mergeVariable ?? {};
    const validation = mv.validation ?? {};
    const validationJsonField = (mv.fieldNames || []).includes(validation.jsonField)
        ? validation.jsonField
        : '';
    const structuredState = !!(validation.enabled && validation.schema
        && typeof validation.schema === 'object' && !Array.isArray(validation.schema)
        && !!validationJsonField);
    const memoryShape = structuredState ? 'structured' : (mv.extractPattern ? 'custom' : 'plain');
    const sidecar = agent.sidecarCall ?? {};
    const executionMode = sidecar.enabled
        ? 'sidecar'
        : (agent.postProcess?.rewriteEnabled ? 'rewrite' : 'direct');
    const effectiveMaxTokens = executionMode === 'sidecar'
        ? (sidecar.maxTokens || agent.maxTokens || 8192)
        : (agent.maxTokens || 8192);
    const genericDisplay = sidecar.display?.hookClass === 'sa-generic-output-data';
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
    const isWorldEvents = agent.worldEventsConfig?.enabled === true
        || agent.sourceTemplateId === 'tpl-world-events';
    const isAfterDark = agent.afterDarkConfig?.enabled === true
        || agent.sourceTemplateId === 'tpl-after-dark';
    const lockedExecution = isGuard || isWorldEvents || isAfterDark || !!agent.phoneConfig || !!agent.feedConfig;
    // Current N for whichever field renders (top-level first, then legacy block).
    const everyNValue = (typeof agent.everyN === 'number' && agent.everyN > 0)
        ? agent.everyN
        : (typeof agent.continuityGuard?.everyN === 'number' && agent.continuityGuard.everyN > 0
            ? agent.continuityGuard.everyN
            : (isGuard ? 5 : 1));
    const everyNCadence = agent.everyNCadence === 'all-attempts' ? 'all-attempts' : 'new-replies';
    const activationPolicyMode = agent.activationPolicy?.mode || 'always';
    const scope = agent.scope ?? {
        mode: 'any', characterBindings: [], tagBindings: [], groupBindings: [],
    };
    const multiOptions = (items, selected) => items.map(item =>
        `<option value="${esc(item.value)}" ${selected.includes(String(item.value)) ? 'selected' : ''}>${esc(item.label)}</option>`
    ).join('');
    const seenAvatars = new Set();
    const characterOptions = characters
        .filter(character => character?.name && character?.avatar)
        .filter(character => {
            const key = String(character.avatar).toLowerCase();
            if (seenAvatars.has(key)) return false;
            seenAvatars.add(key);
            return true;
        })
        .map(character => ({
            value: character.avatar,
            label: `${character.name} (${String(character.avatar).replace(/\.[^.]+$/, '')})`,
        }))
        .sort((a, b) => a.label.localeCompare(b.label));
    const tagOptions = (Array.isArray(stTags) ? stTags : [])
        .filter(tag => tag?.id && tag?.name)
        .map(tag => ({ value: tag.id, label: tag.name }))
        .sort((a, b) => a.label.localeCompare(b.label));
    const groupOptions = (Array.isArray(groups) ? groups : [])
        .filter(group => group?.id && group?.name)
        .map(group => ({ value: String(group.id), label: group.name }))
        .sort((a, b) => a.label.localeCompare(b.label));

    return `
    <div class="sae-head">
        <button class="sam-btn sae-back" id="sae-back"><i class="fa-solid fa-arrow-left"></i> Back</button>
        <div class="sae-head-copy">
            <div class="sae-head-title">${agent.name ? 'Edit Agent' : 'New Agent'}</div>
            <div class="sae-head-summary" id="sae-head-summary"></div>
        </div>
    </div>

    <div class="sae-form" data-special="${isGuard ? 'guard' : (isWorldEvents ? 'world-events' : (isAfterDark ? 'after-dark' : (agent.phoneConfig ? 'phone' : (agent.feedConfig ? 'feed' : ''))))}">
        <div class="sam-divider-label"><i class="fa-solid fa-id-card"></i> Identity</div>

        ${agent.sourceTemplateId ? `
        <label class="sae-template-link">
            <input type="checkbox" id="sae-template-linked" ${templateLinked ? 'checked' : ''}>
            <span>
                <strong>Keep linked to the Library template</strong>
                <small>Linked agents receive future template updates and mark the Library card as Linked. Turn this off when using the template as a starting point for your own agent; the current agent stays unchanged.</small>
            </span>
        </label>` : ''}

        <div class="sae-row sae-identity-row">
            <div class="sae-field sae-identity-name">
                <div class="sae-label">Name</div>
                <input type="text" id="sae-name" class="sae-input" value="${esc(agent.name)}" placeholder="My Agent">
            </div>
            <div class="sae-field sae-identity-category">
                <div class="sae-label">Category</div>
                <select id="sae-category" class="sae-select">${catOptions}</select>
            </div>
            <div class="sae-field sae-identity-author">
                <div class="sae-label">Author</div>
                <input type="text" id="sae-author" class="sae-input" value="${esc(agent.author)}" placeholder="Optional">
            </div>
        </div>
        <div class="sae-field">
            <div class="sae-label">Description</div>
            <textarea id="sae-desc" class="sae-textarea sae-description-textarea" rows="3" placeholder="What does this agent do?">${esc(agent.description)}</textarea>
        </div>
        <div class="sae-field sae-icon-field">
            <button type="button" class="sae-icon-disclosure" id="sae-icon-toggle" aria-expanded="false">
                <span class="sae-icon-disclosure-preview"><i id="sae-icon-summary-preview" class="fa-solid ${esc(agent.icon || AGENT_CATEGORIES[agent.category]?.icon || 'fa-puzzle-piece')}"></i></span>
                <span class="sae-icon-disclosure-copy">
                    <strong>Icon</strong>
                    <small id="sae-icon-summary-text">${esc(agent.icon || 'Category default')}</small>
                </span>
                <span class="sae-icon-disclosure-action">Choose icon <i id="sae-icon-chevron" class="fa-solid fa-chevron-right"></i></span>
            </button>
            <div id="sae-icon-mount" class="sae-hidden"></div>
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

        ${agent.feedConfig ? `
        <div class="sam-divider-label"><i class="fa-solid fa-mobile-screen"></i> In-World App</div>
        <div class="sae-field">
            <div class="sae-label">App name</div>
            <div class="sae-desc">Shown in the floating social app and supplied to its generation prompt.</div>
            <input type="text" id="sae-feed-app-name" class="sae-input" maxlength="40" value="${esc(agent.feedConfig.appName || 'Twatter')}" placeholder="Twatter">
        </div>
        ` : ''}

        <div class="sam-divider-label"><i class="fa-solid fa-gears"></i> Execution</div>
        <div class="sae-execution-intro">
            <i class="fa-solid fa-route"></i>
            <div><strong>Choose when it works, then what it does.</strong><span>The editor only shows settings that affect that route.</span></div>
        </div>
        <div class="sae-field">
            <div class="sae-label">When does it run?</div>
            <div class="sae-desc">Before guides the next reply. After reacts to the reply that just arrived.</div>
            <select id="sae-phase" class="sae-select" ${lockedExecution ? 'disabled' : ''}>
                <option value="pre" ${agent.phase === 'pre' ? 'selected' : ''}>Before the reply</option>
                <option value="post" ${agent.phase === 'post' ? 'selected' : ''}>After the reply</option>
                <option value="both" ${agent.phase === 'both' ? 'selected' : ''}>Before and after</option>
            </select>
        </div>
        <div class="sae-field">
            <div class="sae-label">What does it do?</div>
            <select id="sae-execution-mode" class="sae-select" ${lockedExecution ? 'disabled' : ''}>
                <option value="direct" ${executionMode === 'direct' ? 'selected' : ''}>Use the prompt directly / deterministic tools</option>
                <option value="sidecar" ${executionMode === 'sidecar' ? 'selected' : ''}>Make a separate LLM call</option>
                <option value="rewrite" ${executionMode === 'rewrite' ? 'selected' : ''}>Rewrite or append to the reply with an LLM</option>
            </select>
            <div class="sae-route-note" id="sae-route-note"></div>
        </div>
        ${isGuard ? '' : `
        <div class="sae-row sae-cadence-row">
            <div class="sae-field sae-fixed">
                <div class="sae-label">Run every N replies</div>
                <div class="sae-desc">1 runs every time; 3 runs on every third eligible reply.</div>
                <input type="number" id="sae-everyn" class="sae-input" min="1" step="1" value="${everyNValue}">
            </div>
            <div class="sae-field sae-grow">
                <div class="sae-label">When you swipe or regenerate</div>
                <div class="sae-desc">Choose whether rerolls keep the original reply's run/skip result or count again toward N.</div>
                <select id="sae-everyn-cadence" class="sae-select">
                    <option value="new-replies" ${everyNCadence === 'new-replies' ? 'selected' : ''}>Reuse the original decision — swipes do not advance N</option>
                    <option value="all-attempts" ${everyNCadence === 'all-attempts' ? 'selected' : ''}>Count every attempt — swipes advance N</option>
                </select>
            </div>
        </div>
        <div class="sae-field">
            <label class="checkbox_label">
                <input type="checkbox" id="sae-reuse-snapshot" ${agent.reuseSnapshotBetweenRuns ? 'checked' : ''}>
                <span>Reuse saved snapshot between runs</span>
            </label>
            <div class="sae-desc">When every N skips this agent, keep its last branch snapshot available to the main prompt, macros, and integrations without making another provider call.</div>
        </div>
        <div class="sae-field">
            <div class="sae-label">Run policy</div>
            <div class="sae-desc">Choose normal automatic cadence, manual-only use, or a one-shot lifecycle.</div>
            <select id="sae-activation-policy" class="sae-select">
                <option value="always" ${activationPolicyMode === 'always' ? 'selected' : ''}>Keep using the normal cadence</option>
                <option value="manual" ${activationPolicyMode === 'manual' ? 'selected' : ''}>Only when I click Run</option>
                <option value="until-state" ${activationPolicyMode === 'until-state' ? 'selected' : ''}>Run until remembered state exists, then sleep</option>
                <option value="once-per-chat" ${activationPolicyMode === 'once-per-chat' ? 'selected' : ''}>Run once per chat</option>
                <option value="once-per-branch" ${activationPolicyMode === 'once-per-branch' ? 'selected' : ''}>Run once per story branch</option>
            </select>
            <div class="sae-desc" id="sae-activation-policy-warning" style="display:none;color:var(--warning,#e0a030)">“Until remembered state exists” requires Memory with a variable name.</div>
        </div>
        `}
        <div class="sae-field" id="sae-profile-field">
            <div class="sae-label">Connection profile</div>
            <div class="sae-desc">Choose a profile for this agent, or let it inherit the connection described below.</div>
            <select id="sae-profile" class="sae-select">
                <option value="">${esc(inheritedProfileLabel)}</option>
                ${profileOptions}
            </select>
        </div>

        <div id="sae-sidecar-section">
            <div class="sam-divider-label"><i class="fa-solid fa-satellite-dish"></i> Separate LLM Call</div>
            <p class="sae-hint" id="sae-sidecar-desc">The main reply stays untouched; this agent receives its own prompt and context.</p>
            <div class="sae-row">
                <div class="sae-field sae-grow">
                    <div class="sae-label">Token budget</div>
                    <div class="sae-desc">Actual output limit used by this sidecar call.</div>
                    <input type="number" id="sae-sidecar-max-tokens" class="sae-input" min="64" max="32000" value="${effectiveMaxTokens}">
                </div>
                <div class="sae-field sae-grow">
                    <div class="sae-label">Batch response key</div>
                    <div class="sae-desc">Unique key when compatible agents share one call.</div>
                    <input type="text" id="sae-sidecar-response-key" class="sae-input" value="${esc(sidecar.responseKey || '')}" placeholder="auto_from_agent_name">
                </div>
            </div>
            <div class="sae-sidecar-options">
                <label class="sae-option-check"><input type="checkbox" id="sae-sidecar-history" ${sidecar.includeHistory ? 'checked' : ''}> <span><strong>Include recent chat</strong><small>Give the sidecar conversational context in addition to the latest scene.</small></span></label>
                <label class="sae-option-check"><input type="checkbox" id="sae-sidecar-display" ${sidecar.display?.enabled ? 'checked' : ''}> <span><strong>Show result under the message</strong><small>${genericDisplay || !sidecar.display?.hookClass ? 'Use SuperAgents’ generic collapsible note.' : 'This library agent uses its custom renderer.'}</small></span></label>
            </div>
            <div class="sae-row" id="sae-sidecar-history-fields">
                <div class="sae-field sae-grow">
                    <div class="sae-label">Normal history</div>
                    <div class="sae-desc">Messages included on regular updates.</div>
                    <input type="number" id="sae-sidecar-history-count" class="sae-input" min="1" max="100" value="${sidecar.historyMessageCount || 20}">
                </div>
                <div class="sae-field sae-grow">
                    <div class="sae-label">First-run history</div>
                    <div class="sae-desc">Wider baseline window for a tracker with no stored state. 0 uses normal history.</div>
                    <input type="number" id="sae-sidecar-genesis-count" class="sae-input" min="0" max="100" value="${sidecar.genesisHistoryCount || 0}">
                </div>
            </div>
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
                        <div class="sae-label">Memory name</div>
                        <div class="sae-desc">The stable name used by prompts and other extensions to find this agent's remembered data.</div>
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
                    <div class="sam-row">
                        <div class="sam-row-info">
                            <div class="sam-row-title">Auto-inject state into chat</div>
                            <div class="sam-row-desc">Add this tracker's state to every main-chat generation automatically. Turn off to place it yourself with the macro below.</div>
                        </div>
                        <label class="sam-switch">
                            <input type="checkbox" id="sae-mv-autoinject" ${mv.autoInject !== false ? 'checked' : ''}>
                            <span class="sam-switch-track"></span>
                        </label>
                    </div>
                    <div class="sae-field">
                        <div class="sae-label">Custom chat macro (optional)</div>
                        <div class="sae-desc">Registers <code>{{sa_<span id="sae-macro-preview">${esc(mv.macroName || 'name')}</span>}}</code>, resolving to this tracker's formatted state (active persona only). Drop it anywhere in your preset for exact placement. Letters, numbers, <code>_</code>, <code>-</code>.</div>
                        <div style="display:flex;align-items:center;gap:2px;">
                            <span style="opacity:0.7;font-family:monospace;white-space:nowrap;">{{sa_</span>
                            <input type="text" id="sae-mv-macroname" class="sae-input" style="flex:1;min-width:0;font-family:monospace;" value="${esc(mv.macroName || '')}" placeholder="relationship_ledger" maxlength="48">
                            <span style="opacity:0.7;font-family:monospace;">}}</span>
                        </div>
                    </div>
                    <div class="sae-structured-card">
                        <div class="sae-structured-title"><i class="fa-solid fa-align-left"></i> Main-chat reference</div>
                        <p>This is the read-only version shown to the narrative model. It is separate from the JSON and from the feedback sent to this agent.</p>
                        <div class="sae-field">
                            <div class="sae-label">Main-chat reference label</div>
                            <div class="sae-desc">Optional heading above the projected state. Leave blank to reuse the agent-feedback label.</div>
                            <input type="text" id="sae-mv-main-header" class="sae-input" value="${esc(mv.mainContext?.formatHeader ?? '')}" placeholder="CURRENT SCENE STATE — reference only:">
                        </div>
                        <div class="sae-field">
                            <div class="sae-label">Main-chat structured text</div>
                            <div class="sae-desc">Supports <code>{{field}}</code>, JSON paths such as <code>{{json.status}}</code>, <code>{{#each json.characters}}…{{/each}}</code>, and <code>{{#if json.events}}…{{else}}…{{/if}}</code>. Inside a loop use <code>{{@key}}</code>, <code>{{@index}}</code>, <code>{{this}}</code>, or a property name. Leave blank to reuse the agent-feedback format.</div>
                            <textarea id="sae-mv-main-formatitem" class="sae-textarea" rows="12" spellcheck="false" placeholder="&lt;scene_state&gt;&#10;Reference only.&#10;{{#each json.characters}}- {{@key}}: {{feeling}}{{/each}}&#10;&lt;/scene_state&gt;">${esc(mv.mainContext?.formatItem ?? '')}</textarea>
                        </div>
                        <div class="sae-field">
                            <div class="sae-label">Meaningful collection path (optional)</div>
                            <div class="sae-desc">Suppresses the entire main-chat reference when this JSON collection is empty. Supports dotted paths and <code>*</code>, for example <code>characters</code> or <code>personas.*.characters</code>.</div>
                            <input type="text" id="sae-mv-main-presence" class="sae-input" value="${esc(mv.mainContext?.presencePath ?? '')}" placeholder="characters">
                        </div>
                        <div class="sae-field">
                            <div class="sae-label">Main-chat text when memory is empty</div>
                            <div class="sae-desc">Usually left blank so first-run update instructions stay private to the tracker.</div>
                            <input type="text" id="sae-mv-main-empty" class="sae-input" value="${esc(mv.mainContext?.formatEmpty ?? '')}" placeholder="Leave blank to inject nothing">
                        </div>
                    </div>
                    <div class="sae-field">
                        <div class="sae-label">Label for the fed-back block (optional)</div>
                        <div class="sae-desc">Shown above the previous output, e.g. "Previously established Wants &amp; Needs:".</div>
                        <input type="text" id="sae-mv-header" class="sae-input" value="${esc(mv.formatHeader || '')}" placeholder="Previously established:">
                    </div>
                    <div class="sae-field">
                        <div class="sae-label">What kind of answer should be remembered?</div>
                        <div class="sae-desc">Choose structured fields when you want a tracker or data other extensions can use. SuperAgents will generate the JSON configuration from your fields.</div>
                        <select id="sae-memory-shape" class="sae-select">
                            <option value="plain" ${memoryShape === 'plain' ? 'selected' : ''}>Complete answer — plain text</option>
                            <option value="structured" ${memoryShape === 'structured' ? 'selected' : ''}>Structured fields — visual builder</option>
                            <option value="custom" ${memoryShape === 'custom' ? 'selected' : ''}>Custom extraction — advanced</option>
                        </select>
                    </div>
                    <div id="sae-structured-authoring" class="${memoryShape === 'structured' ? '' : 'sae-hidden'}">
                        <div class="sae-structured-card">
                            <div class="sae-structured-title"><i class="fa-solid fa-table-list"></i> Design the remembered data</div>
                            <p>The agent fills these values during chat. You define their names and types here; SuperAgents creates the schema, validates updates, and feeds the complete state back automatically.</p>
                            <div id="sae-structured-builder-mount"></div>
                        </div>
                    </div>
                    <div class="sae-field" id="sae-memory-format-field">
                        <div class="sae-label">How remembered text is sent back</div>
                        <div class="sae-desc">For a complete answer, use <code>{{text}}</code>. Custom extraction can use its named fields, such as <code>{{location}}</code>.</div>
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
                            <div class="sam-row-title"><i class="fa-solid fa-chevron-right" id="sae-mv-adv-chevron"></i> Memory details</div>
                            <div class="sam-row-desc">Choose whether memory replaces the prior snapshot or grows into a list. Technical extraction and validation settings are kept in Developer details.</div>
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
                        <div class="sam-row sae-adv-toggle" id="sae-mv-dev-toggle">
                            <div class="sam-row-info">
                                <div class="sam-row-title"><i class="fa-solid fa-chevron-right" id="sae-mv-dev-chevron"></i> Developer details</div>
                                <div class="sam-row-desc">Regex captures, internal field names, JSON Schema, and cross-turn rules. Library agents normally do not need changes here.</div>
                            </div>
                        </div>
                        <div id="sae-memory-developer" class="sae-hidden">
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
                        <div class="sae-field" id="sae-mv-keyfields-wrap">
                            <div class="sae-label">Key fields</div>
                            <div class="sae-desc">Which field(s) identify a unique item, for Accumulate mode's update/merge. Ignored in Snapshot mode. Comma-separated.</div>
                            <input type="text" id="sae-mv-keyfields" class="sae-input" value="${esc((mv.keyFields || []).join(', '))}" placeholder="text">
                        </div>
                        <div class="sae-row">
                            <div class="sae-field sae-grow">
                                <div class="sae-label">Resolution field</div>
                                <div class="sae-desc">Optional field whose special value removes an accumulated item.</div>
                                <input type="text" id="sae-mv-resolve-field" class="sae-input" value="${esc(mv.resolveField || '')}" placeholder="status">
                            </div>
                            <div class="sae-field sae-grow">
                                <div class="sae-label">Resolution value</div>
                                <div class="sae-desc">Case-insensitive value that marks the item resolved.</div>
                                <input type="text" id="sae-mv-resolve-action" class="sae-input" value="${esc(mv.resolveAction || 'RESOLVED')}" placeholder="RESOLVED">
                            </div>
                        </div>
                        <div class="sam-divider-label"><i class="fa-solid fa-code-branch"></i> Generated validation configuration</div>
                        <p class="sae-hint">The visual field builder keeps these values synchronized. Edit them directly only for schema features the builder does not expose.</p>
                        <div class="sam-row">
                            <div class="sam-row-info">
                                <div class="sam-row-title">Validate extracted state</div>
                                <div class="sam-row-desc">Reject malformed updates and keep the last valid snapshot.</div>
                            </div>
                            <label class="sam-switch">
                                <input type="checkbox" id="sae-mv-validation-enabled" ${validation.enabled ? 'checked' : ''}>
                                <span class="sam-switch-track"></span>
                            </label>
                        </div>
                        <div class="sae-row">
                            <div class="sae-field sae-grow">
                                <div class="sae-label">Internal JSON capture name</div>
                                <div class="sae-desc">The storage slot containing the complete JSON answer. This is normally <code>json</code>.</div>
                                <input type="text" id="sae-mv-validation-jsonfield" class="sae-input" value="${esc(validationJsonField)}" placeholder="json">
                            </div>
                            <div class="sae-field sae-fixed">
                                <div class="sae-label">Schema version</div>
                                <input type="number" id="sae-mv-validation-version" class="sae-input" min="1" step="1" value="${Number(validation.schemaVersion) || 1}">
                            </div>
                        </div>
                        <div class="sae-field">
                            <div class="sae-label">Generated schema (JSON)</div>
                            <div class="sae-desc">Raw version of the visual remembered-field builder. Changes made here are loaded back into the builder after leaving the field.</div>
                            <textarea id="sae-mv-validation-schema" class="sae-textarea" rows="12" spellcheck="false">${esc(JSON.stringify(validation.schema || {}, null, 2))}</textarea>
                        </div>
                        <div class="sae-field">
                            <div class="sae-label">Generated across-turn rules (JSON)</div>
                            <div class="sae-desc">Raw version of rules such as “never decrease,” “limit each change,” and “only add items.” Less common conditional rules can be authored here.</div>
                            <textarea id="sae-mv-validation-invariants" class="sae-textarea" rows="8" spellcheck="false">${esc(JSON.stringify(validation.invariants || [], null, 2))}</textarea>
                        </div>
                        </div>
                    </div>
                    <div id="sae-memory-post-note" class="sae-hint"><i class="fa-solid fa-circle-info"></i> <span></span></div>
                </div>
            </div>

        <div id="sae-injection-section">
            <div class="sam-divider-label"><i class="fa-solid fa-syringe"></i> Pre-gen Injection</div>
            <p class="sae-hint">Where this agent's prompt is placed in the context during generation.</p>
            <div class="sam-row" id="sae-inj-result-row">
                <div class="sam-row-info">
                    <div class="sam-row-title">Inject this call's result into the main reply</div>
                    <div class="sam-row-desc">Turn this off for a silent classifier. Its validated Memory is still stored for macros and integrations.</div>
                </div>
                <label class="sam-switch">
                    <input type="checkbox" id="sae-inj-result" ${inj.injectResult !== false ? 'checked' : ''}>
                    <span class="sam-switch-track"></span>
                </label>
            </div>
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
            <div id="sae-richctx-warn" class="sae-hint" style="color:var(--warning,#e0a030);${agent.sidecarCall?.enabled ? 'display:none' : ''}"><i class="fa-solid fa-triangle-exclamation"></i> Rich context is used only by a separate LLM call. Choose that execution route above to enable it.</div>
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
                    <label class="sae-check"><input type="checkbox" id="sae-rc-simple-summarizer" ${rc.simpleSummarizer ? 'checked' : ''}> Simple Summarizer memory</label>
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
                    <div class="sae-desc">Show this sidecar its own last N stored outputs so it can build on them instead of repeating itself. Requires a separate LLM call, enabled memory, and a variable name.</div>
                    <input type="number" id="sae-rc-selfmemory-count" class="sae-input" min="0" max="20" value="${rc.selfMemoryCount ?? 0}" ${selfMemEligible ? '' : 'disabled'}>
                </div>
            </div>
        </div>

        <div id="sae-post-section">
            <div id="sae-rewrite-settings">
                <div class="sam-divider-label"><i class="fa-solid fa-wand-magic-sparkles"></i> Reply Rewrite</div>
                <p class="sae-hint">The reply is sent through this agent's prompt, then replaced or extended with the result.</p>
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
            <div id="sae-direct-post-tools">
                <div class="sam-divider-label"><i class="fa-solid fa-screwdriver-wrench"></i> Deterministic Post-Processing</div>
                <p class="sae-hint">Optional no-LLM tools for agents that inject instructions before the reply, then read or append to the resulting message.</p>
                <div class="sam-row">
                    <div class="sam-row-info">
                        <div class="sam-row-title">Enable deterministic action</div>
                        <div class="sam-row-desc">Useful for simple append or metadata extraction workflows.</div>
                    </div>
                    <label class="sam-switch"><input type="checkbox" id="sae-post-enabled" ${pp.enabled ? 'checked' : ''}><span class="sam-switch-track"></span></label>
                </div>
                <div id="sae-post-tools-fields" class="${pp.enabled ? '' : 'sae-hidden'}">
                    <div class="sae-field">
                        <div class="sae-label">Action</div>
                        <select id="sae-post-type" class="sae-select">
                            <option value="append" ${pp.type === 'append' ? 'selected' : ''}>Append text to the reply</option>
                            <option value="extract" ${pp.type === 'extract' ? 'selected' : ''}>Extract matching text into metadata</option>
                        </select>
                    </div>
                    <div class="sae-field" id="sae-post-append-field">
                        <div class="sae-label">Text to append</div>
                        <textarea id="sae-post-append" class="sae-textarea" rows="3" placeholder="Text or macros to append…">${esc(pp.appendText || '')}</textarea>
                    </div>
                    <div id="sae-post-extract-fields">
                        <div class="sae-field"><div class="sae-label">Extraction regex</div><input id="sae-post-extract-pattern" class="sae-input" value="${esc(pp.extractPattern || '')}" placeholder="\\[TAG[\\s\\S]*?\\[/TAG\\]"></div>
                        <div class="sae-field"><div class="sae-label">Metadata variable</div><input id="sae-post-extract-variable" class="sae-input" value="${esc(pp.extractVariable || '')}" placeholder="scene_note"></div>
                    </div>
                </div>
            </div>
        </div>

        <div class="sam-divider-label"><i class="fa-solid fa-filter"></i> Conditions</div>
        <div class="sae-field">
            <div class="sae-label">Chat scope</div>
            <div class="sae-desc">Limit this agent to particular characters, native tags, or group chats. Any chat runs everywhere.</div>
            <select id="sae-scope-mode" class="sae-select">
                <option value="any" ${scope.mode === 'any' ? 'selected' : ''}>Any chat</option>
                <option value="character" ${scope.mode === 'character' ? 'selected' : ''}>Selected characters</option>
                <option value="tag" ${scope.mode === 'tag' ? 'selected' : ''}>Selected native tags</option>
                <option value="group" ${scope.mode === 'group' ? 'selected' : ''}>Selected group chats</option>
            </select>
        </div>
        <div class="sae-field sae-scope-bindings" id="sae-scope-character-wrap">
            <div class="sae-label">Characters</div>
            <div class="sae-desc">Runs only in solo chats with one of these character cards. Ctrl/Cmd-click to select several.</div>
            <select id="sae-scope-characters" class="sae-select" multiple size="6">
                ${multiOptions(characterOptions, scope.characterBindings || [])}
            </select>
        </div>
        <div class="sae-field sae-scope-bindings" id="sae-scope-tag-wrap">
            <div class="sae-label">Tags</div>
            <div class="sae-desc">Runs when the current character or group has any selected SillyTavern tag.</div>
            <select id="sae-scope-tags" class="sae-select" multiple size="6">
                ${multiOptions(tagOptions, scope.tagBindings || [])}
            </select>
        </div>
        <div class="sae-field sae-scope-bindings" id="sae-scope-group-wrap">
            <div class="sae-label">Groups</div>
            <div class="sae-desc">Runs only in the selected SillyTavern group chats.</div>
            <select id="sae-scope-groups" class="sae-select" multiple size="6">
                ${multiOptions(groupOptions, scope.groupBindings || [])}
            </select>
        </div>
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
            <div class="sae-desc">Choose which kinds of generation can trigger this agent. Swipe includes regenerating the latest reply.</div>
            <div class="sae-check-row">
                <label class="sae-check"><input type="checkbox" id="sae-gen-normal" ${cond.generationTypes.includes('normal') ? 'checked' : ''}> Normal</label>
                <label class="sae-check"><input type="checkbox" id="sae-gen-swipe" ${cond.generationTypes.includes('swipe') ? 'checked' : ''}> Swipe / regenerate</label>
                <label class="sae-check"><input type="checkbox" id="sae-gen-continue" ${cond.generationTypes.includes('continue') ? 'checked' : ''}> Continue</label>
                <label class="sae-check"><input type="checkbox" id="sae-gen-impersonate" ${cond.generationTypes.includes('impersonate') ? 'checked' : ''}> Impersonate</label>
            </div>
        </div>
        <div class="sam-divider-label"><i class="fa-solid fa-arrow-right-to-bracket"></i> Before reply · input triggers</div>
        <p class="sae-hint">Checked while the turn is being scheduled, before the new assistant response exists. Keywords and regex patterns are alternatives: matching either one activates the agent. Leave both empty for no input filter.</p>
        <div class="sae-field">
            <div class="sae-label">Input keywords</div>
            <div class="sae-desc">Match the latest committed message or pending user message. Comma-separated; case-insensitive.</div>
            <input type="text" id="sae-keywords" class="sae-input" value="${esc((cond.triggerKeywords || []).join(', '))}" placeholder="fight, battle, combat">
        </div>
        <div class="sae-field">
            <div class="sae-label">Input regex patterns <span class="sae-advanced-label">advanced</span></div>
            <div class="sae-desc">Also checked before generation against the same input. One regular expression per line.</div>
            <textarea id="sae-trigger-patterns" class="sae-textarea sae-textarea-compact" rows="3" placeholder="\\b(confession|admission)\\b">${esc((cond.triggerPatterns || []).join('\n'))}</textarea>
        </div>
        <div class="sae-field">
            <label class="sae-check"><input type="checkbox" id="sae-state-gate-enabled" ${stateGate.enabled ? 'checked' : ''}> Wait for another agent’s state before replying</label>
            <div class="sae-desc">Pre-generation only. Ordinary agents run first; this agent runs afterward only when the freshly remembered value matches.</div>
        </div>
        <div id="sae-state-gate-fields">
            <div class="sae-grid-2">
                <div class="sae-field">
                    <div class="sae-label">State variable</div>
                    <input id="sae-state-gate-variable" class="sae-input" value="${esc(stateGate.variableName || '')}" placeholder="sa_prompt_base">
                </div>
                <div class="sae-field">
                    <div class="sae-label">Field path</div>
                    <input id="sae-state-gate-path" class="sae-input" value="${esc(stateGate.path || '')}" placeholder="nsfw">
                </div>
            </div>
            <div class="sae-grid-2">
                <div class="sae-field">
                    <div class="sae-label">Comparison</div>
                    <select id="sae-state-gate-operator" class="sae-select">
                        <option value="eq" ${stateGate.operator === 'eq' ? 'selected' : ''}>Equals</option>
                        <option value="neq" ${stateGate.operator === 'neq' ? 'selected' : ''}>Does not equal</option>
                        <option value="exists" ${stateGate.operator === 'exists' ? 'selected' : ''}>Exists</option>
                        <option value="not_exists" ${stateGate.operator === 'not_exists' ? 'selected' : ''}>Does not exist</option>
                        <option value="contains" ${stateGate.operator === 'contains' ? 'selected' : ''}>Contains</option>
                    </select>
                </div>
                <div class="sae-field" id="sae-state-gate-value-wrap">
                    <div class="sae-label">Expected value</div>
                    <input id="sae-state-gate-value" class="sae-input" value="${esc(stateGate.value ?? 'true')}" placeholder="true">
                </div>
            </div>
            <label class="sae-check"><input type="checkbox" id="sae-state-gate-fresh" ${stateGate.requireFresh !== false ? 'checked' : ''}> Require the source agent to store valid state this turn</label>
        </div>
        <div id="sae-current-response-trigger">
            <div class="sam-divider-label"><i class="fa-solid fa-arrow-right-from-bracket"></i> After reply · output trigger</div>
            <p class="sae-hint">Available for a post-generation separate LLM call. This is checked only after the new assistant response is complete.</p>
            <div class="sae-field">
                <div class="sae-label">Generated-response regex <span class="sae-advanced-label">advanced</span></div>
                <div class="sae-desc">Make the post-reply sidecar call only when the new response matches. Empty means run whenever the conditions above allow it. Manual runs ignore this gate.</div>
                <input type="text" id="sae-sidecar-current-pattern" class="sae-input" value="${esc(sidecar.currentMessagePattern || '')}" placeholder="&lt;wish\\b[^&gt;]*&gt;[\\s\\S]*?&lt;\\/wish&gt;">
            </div>
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
    const $mode = $('#sae-execution-mode');
    let mode = $mode.val() || 'direct';
    const specialRoute = $('.sae-form').attr('data-special') || '';
    const ownsSpecialLlmCall = specialRoute === 'phone' || specialRoute === 'feed'
        || specialRoute === 'guard' || specialRoute === 'world-events' || specialRoute === 'after-dark';

    // A rewrite has no pre-generation target. Keep the form in a valid route
    // instead of saving a combination the lifecycle cannot execute.
    $mode.find('option[value="rewrite"]').prop('disabled', phase === 'pre');
    if (phase === 'pre' && mode === 'rewrite') {
        mode = 'direct';
        $mode.val(mode);
    }

    $('#sae-injection-section').toggle(includesPre);
    $('#sae-inj-result-row').toggle(includesPre && mode === 'sidecar');
    $('#sae-profile-field').toggle(ownsSpecialLlmCall || mode === 'sidecar' || mode === 'rewrite');
    $('#sae-sidecar-section').toggle(mode === 'sidecar');
    $('#sae-richctx-section').toggle(mode === 'sidecar');
    $('#sae-post-section').toggle(includesPost && mode !== 'sidecar');
    $('#sae-rewrite-settings').toggle(mode === 'rewrite');
    $('#sae-direct-post-tools').toggle(mode === 'direct');
    $('#sae-memory-block').toggle(mode === 'sidecar' || includesPost);
    $('#sae-sidecar-history-fields').toggle($('#sae-sidecar-history').is(':checked'));
    $('#sae-current-response-trigger').toggle(mode === 'sidecar' && includesPost);
    $('#sae-mv-keyfields-wrap').toggle($('#sae-mv-mode').val() === 'accumulate');
    const memoryShape = $('#sae-memory-shape').val() || 'plain';
    $('#sae-structured-authoring').toggleClass('sae-hidden', memoryShape !== 'structured');
    $('#sae-memory-format-field').toggle(memoryShape !== 'structured');

    const scopeMode = $('#sae-scope-mode').val() || 'any';
    $('.sae-scope-bindings').addClass('sae-hidden');
    $(`#sae-scope-${scopeMode}-wrap`).removeClass('sae-hidden');

    const stateGateEnabled = $('#sae-state-gate-enabled').is(':checked');
    $('#sae-state-gate-fields').toggle(stateGateEnabled);
    const stateGateOperator = $('#sae-state-gate-operator').val() || 'eq';
    $('#sae-state-gate-value-wrap').toggle(!['exists', 'not_exists'].includes(stateGateOperator));

    const hasPattern = !!($('#sae-mv-pattern').val() || '').trim();
    const memoryNote = memoryShape === 'structured'
        ? (hasPattern
            ? 'The captured JSON is checked against your fields and carried forward automatically.'
            : 'The complete answer is treated as JSON, checked against your fields, and carried forward automatically.')
        : memoryShape === 'custom'
            ? 'Custom extraction uses the capture pattern and named fields in Developer details.'
            : 'The complete answer is stored as one plain-text value.';
    $('#sae-memory-post-note span').text(memoryNote);
    $('#sae-memory-post-note').toggle(mode === 'sidecar' && includesPost);
    const waitsForState = $('#sae-activation-policy').val() === 'until-state';
    const hasStateTarget = $('#sae-mv-enabled').is(':checked')
        && !!String($('#sae-mv-varname').val() || '').trim();
    $('#sae-activation-policy-warning').toggle(waitsForState && !hasStateTarget);

    const desc = phase === 'post'
        ? 'Runs after the reply in the background. The original reply stays untouched.'
        : phase === 'both'
            ? 'Runs once before and once after — two separate LLM calls per turn.'
            : 'Runs before generation and injects its result as guidance for the reply.';
    $('#sae-sidecar-desc').text(desc);

    const special = $('.sae-form').data('special');
    let summary;
    let routeNote;
    if (special === 'guard') {
        summary = 'After the reply · deterministic continuity guard';
        routeNote = 'This library agent has its own guarded runtime.';
    } else if (special === 'world-events') {
        summary = 'After the reply · user-guided world-event proposals';
        routeNote = 'Generates a private chooser; only events you approve enter the story prompt.';
    } else if (special === 'phone') {
        summary = 'After the reply · phone-message evaluator';
        routeNote = 'This library agent uses its specialized phone configuration.';
    } else if (special === 'feed') {
        summary = 'After the reply · social Feed publisher';
        routeNote = 'This library agent owns the shared Feed and its publish/withhold protocol.';
    } else if (mode === 'sidecar') {
        summary = `${phase === 'pre' ? 'Before' : phase === 'post' ? 'After' : 'Before + after'} · separate LLM call`;
        routeNote = includesPost
            ? 'Observes the reply without changing it. Remember or display the result below if you need to use it later.'
            : 'Creates private guidance and injects that result into the upcoming reply.';
    } else if (mode === 'rewrite') {
        summary = `${phase === 'both' ? 'Before + after' : 'After'} · LLM rewrite`;
        routeNote = phase === 'both'
            ? 'Injects the prompt before generation, then uses it again to revise the resulting reply.'
            : 'Uses this prompt to revise the reply after it arrives.';
    } else {
        summary = `${phase === 'pre' ? 'Before' : phase === 'post' ? 'After' : 'Before + after'} · no separate LLM call`;
        routeNote = includesPost
            ? 'Uses deterministic extraction, append, or memory tools. Enable at least one post-generation action below.'
            : 'Injects this prompt directly into the next main generation.';
    }
    $('#sae-head-summary').text(summary);
    $('#sae-route-note').text(routeNote);

    updatePostToolVisibility();
}

function updatePostToolVisibility() {
    const enabled = $('#sae-post-enabled').is(':checked');
    const type = $('#sae-post-type').val() || 'append';
    $('#sae-post-tools-fields').toggleClass('sae-hidden', !enabled);
    $('#sae-post-append-field').toggle(type === 'append');
    $('#sae-post-extract-fields').toggle(type === 'extract');
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

    const eligible = $('#sae-execution-mode').val() === 'sidecar'
        && $('#sae-mv-enabled').is(':checked')
        && !!($('#sae-mv-varname').val() || '').trim();
    let carryOn = $inject.is(':checked') && $('#sae-mv-enabled').is(':checked');
    let selfOn = eligible && $self.is(':checked');

    if (!eligible) {
        selfOn = false;
        $self.prop('checked', false);
    }

    if (carryOn && selfOn) {
        if (changed === 'self') {
            carryOn = false;
            $inject.prop('checked', false);
        } else {
            selfOn = false;
            $self.prop('checked', false);
        }
    }

    if (carryOn) {
        $self.prop('checked', false).prop('disabled', true);
        $('#sae-rc-selfmemory-count').prop('disabled', true);
        $('#sae-selfmem-conflict-note').removeClass('sae-hidden');
    } else {
        $self.prop('disabled', !eligible);
        $('#sae-rc-selfmemory-count').prop('disabled', !eligible);
        $('#sae-selfmem-conflict-note').addClass('sae-hidden');
    }
    $self.closest('.sae-check').toggleClass('sae-check-disabled', !eligible || carryOn);

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
    const triggerPatterns = ($('#sae-trigger-patterns').val() || '')
        .split(/\r?\n/).map(value => value.trim()).filter(Boolean);
    const executionMode = $('#sae-execution-mode').val() || 'direct';
    const phase = $('#sae-phase').val() || 'pre';
    const name = ($('#sae-name').val() || '').trim();
    const sidecarMaxTokens = parseInt($('#sae-sidecar-max-tokens').val(), 10) || 8192;
    const safeKey = value => String(value || 'agent_output')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '') || 'agent_output';

    const genTypes = [];
    if ($('#sae-gen-normal').is(':checked')) genTypes.push('normal');
    if ($('#sae-gen-swipe').is(':checked')) genTypes.push('swipe');
    if ($('#sae-gen-continue').is(':checked')) genTypes.push('continue');
    if ($('#sae-gen-impersonate').is(':checked')) genTypes.push('impersonate');
    const selectedValues = selector => Array.from(
        document.querySelector(selector)?.selectedOptions ?? [],
        option => option.value,
    );

    const result = {
        ...existingAgent,
        sourceTemplateLinked: Boolean(existingAgent.sourceTemplateId)
            && $('#sae-template-linked').is(':checked'),
        name,
        description: ($('#sae-desc').val() || '').trim(),
        icon: iconPicker ? iconPicker.getValue() : (existingAgent.icon || ''),
        category: $('#sae-category').val(),
        author: ($('#sae-author').val() || '').trim(),
        tags,
        prompt: $('#sae-prompt').val() || '',
        phase,
        connectionProfile: $('#sae-profile').val() || '',
        // Keep the legacy top-level fallback aligned with the visible budget.
        maxTokens: executionMode === 'sidecar' ? sidecarMaxTokens : (existingAgent.maxTokens || 8192),
        // General "run every N messages" throttle. 1 (or blank/invalid) = every
        // message = throttle off. Read from whichever N input the form rendered
        // (the general Execution field, or the Continuity Guard's own field).
        everyN: (() => {
            const el = document.getElementById('sae-everyn');
            if (!el) return existingAgent.everyN ?? 1;
            const v = parseInt(el.value, 10);
            return (Number.isFinite(v) && v > 0) ? v : 1;
        })(),
        everyNCadence: document.getElementById('sae-everyn-cadence')?.value === 'all-attempts'
            ? 'all-attempts'
            : (document.getElementById('sae-everyn-cadence') ? 'new-replies' : (existingAgent.everyNCadence || 'new-replies')),
        reuseSnapshotBetweenRuns: document.getElementById('sae-reuse-snapshot')
            ? $('#sae-reuse-snapshot').is(':checked')
            : existingAgent.reuseSnapshotBetweenRuns === true,
        activationPolicy: {
            mode: $('#sae-activation-policy').val() || existingAgent.activationPolicy?.mode || 'always',
        },
        scope: {
            mode: $('#sae-scope-mode').val() || 'any',
            characterBindings: selectedValues('#sae-scope-characters'),
            tagBindings: selectedValues('#sae-scope-tags'),
            groupBindings: selectedValues('#sae-scope-groups'),
        },
        injection: {
            ...existingAgent.injection,
            position: parseInt($('#sae-inj-position').val()),
            depth: parseInt($('#sae-inj-depth').val()) || 1,
            role: parseInt($('#sae-inj-role').val()),
            order: parseInt($('#sae-inj-order').val()) || 100,
            scan: $('#sae-inj-scan').is(':checked'),
            template: $('#sae-inj-template').val() || '',
            injectResult: document.getElementById('sae-inj-result')
                ? $('#sae-inj-result').is(':checked')
                : existingAgent.injection?.injectResult !== false,
        },
        sidecarCall: {
            ...existingAgent.sidecarCall,
            enabled: executionMode === 'sidecar',
            maxTokens: sidecarMaxTokens,
            responseKey: ($('#sae-sidecar-response-key').val() || '').trim() || safeKey(name),
            includeHistory: $('#sae-sidecar-history').is(':checked'),
            historyMessageCount: Math.max(1, parseInt($('#sae-sidecar-history-count').val(), 10) || 20),
            genesisHistoryCount: Math.max(0, parseInt($('#sae-sidecar-genesis-count').val(), 10) || 0),
            currentMessagePattern: ($('#sae-sidecar-current-pattern').val() || '').trim(),
            display: (() => {
                const prior = existingAgent.sidecarCall?.display ?? {};
                const enabled = $('#sae-sidecar-display').is(':checked');
                const customHook = prior.hookClass && prior.hookClass !== 'sa-generic-output-data';
                return {
                    ...prior,
                    enabled,
                    hookClass: customHook ? prior.hookClass : 'sa-generic-output-data',
                    position: prior.position === 'bottom' ? 'bottom' : 'top',
                    dataMap: customHook ? (prior.dataMap || {}) : {},
                    contentField: customHook ? (prior.contentField || '') : 'text',
                };
            })(),
            richContext: {
                ...(existingAgent.sidecarCall?.richContext ?? {}),
                enabled: $('#sae-rc-enabled').is(':checked'),
                character: $('#sae-rc-character').is(':checked'),
                persona: $('#sae-rc-persona').is(':checked'),
                worldInfo: $('#sae-rc-worldinfo').is(':checked'),
                summary: $('#sae-rc-summary').is(':checked'),
                simpleSummarizer: $('#sae-rc-simple-summarizer').is(':checked'),
                authorsNote: $('#sae-rc-authorsnote').is(':checked'),
                pendingUser: $('#sae-rc-pendinguser').is(':checked'),
                historyCount: parseInt($('#sae-rc-history').val()) || 0,
                selfMemory: $('#sae-rc-selfmemory').is(':checked'),
                selfMemoryCount: parseInt($('#sae-rc-selfmemory-count').val()) || 0,
            },
        },
        postProcess: {
            ...existingAgent.postProcess,
            enabled: executionMode === 'direct' && $('#sae-post-enabled').is(':checked'),
            type: $('#sae-post-type').val() || existingAgent.postProcess?.type || 'append',
            appendText: $('#sae-post-append').val() || '',
            extractPattern: $('#sae-post-extract-pattern').val() || '',
            extractVariable: ($('#sae-post-extract-variable').val() || '').trim(),
            rewriteEnabled: executionMode === 'rewrite',
            rewriteMode: $('#sae-rewrite-mode').val(),
            rewriteMaxTokens: parseInt($('#sae-rewrite-tokens').val()) || 8192,
        },
        conditions: {
            ...existingAgent.conditions,
            triggerKeywords: keywords,
            triggerPatterns,
            triggerProbability: parseInt($('#sae-probability').val()),
            generationTypes: genTypes,
            generationTypesVersion: 2,
            stateGate: {
                enabled: $('#sae-state-gate-enabled').is(':checked'),
                variableName: ($('#sae-state-gate-variable').val() || '').trim(),
                jsonField: existingAgent.conditions?.stateGate?.jsonField || 'json',
                path: ($('#sae-state-gate-path').val() || '').trim(),
                operator: $('#sae-state-gate-operator').val() || 'eq',
                value: $('#sae-state-gate-value').val() ?? 'true',
                requireFresh: $('#sae-state-gate-fresh').is(':checked'),
            },
        },
        feedConfig: existingAgent.feedConfig ? {
            ...existingAgent.feedConfig,
            appName: ($('#sae-feed-app-name').val() || '').trim().slice(0, 40) || 'Twatter',
        } : existingAgent.feedConfig,
    };

    // Memory / carry-output. The controls now render for every phase and for
    // both simple and structured agents, so we write mergeVariable whenever the
    // controls are present. Everything the form exposes (format lines, strip,
    // and the developer extraction fields) round-trips here. Fields not
    // rendered here remain preserved by the object spread.
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
        const memoryShape = $('#sae-memory-shape').val() || 'plain';
        const structuredField = ($('#sae-mv-validation-jsonfield').val() || '').trim() || 'json';
        const fieldNames = memoryShape === 'structured' ? [structuredField]
            : memoryShape === 'plain' ? ['text']
                : fieldsInput.length ? fieldsInput
                    : (emv.fieldNames?.length ? emv.fieldNames : ['text']);
        const storageMode = $('#sae-mv-mode').val() === 'accumulate' ? 'accumulate' : 'snapshot';
        const keyFields = storageMode === 'snapshot' ? [] : (keyFieldsInput.length
            ? keyFieldsInput
            : (emv.keyFields?.length ? emv.keyFields : fieldNames.slice(0, 1)));
        const parseJsonEditor = (selector, label, fallback) => {
            const raw = ($(selector).val() || '').trim();
            if (!raw) return fallback;
            try {
                return JSON.parse(raw);
            } catch (error) {
                throw new Error(`${label} is not valid JSON: ${error.message}`);
            }
        };
        const customValidation = memoryShape === 'custom' && $('#sae-mv-validation-enabled').is(':checked');
        const builderValue = memoryShape === 'structured' ? structuredMemoryBuilder?.getValue() : null;
        const validationSchema = builderValue?.schema ?? (customValidation
            ? parseJsonEditor('#sae-mv-validation-schema', 'JSON Schema', {})
            : (emv.validation?.schema || {}));
        const validationInvariants = builderValue?.invariants ?? (customValidation
            ? parseJsonEditor('#sae-mv-validation-invariants', 'Cross-turn invariants', [])
            : (emv.validation?.invariants || []));
        if (!validationSchema || Array.isArray(validationSchema) || typeof validationSchema !== 'object') {
            throw new Error('JSON Schema must be a JSON object.');
        }
        if (!Array.isArray(validationInvariants)) {
            throw new Error('Cross-turn invariants must be a JSON array.');
        }

        const needsPostSidecarOutput = executionMode === 'sidecar'
            && (phase === 'post' || phase === 'both')
            && $('#sae-sidecar-display').is(':checked');
        result.mergeVariable = {
            ...existingAgent.mergeVariable,
            enabled: $('#sae-mv-enabled').is(':checked') || needsPostSidecarOutput,
            variableName: ($('#sae-mv-varname').val() || '').trim() || (needsPostSidecarOutput ? `sa_${safeKey(name)}` : ''),
            injectFormatted: $('#sae-mv-inject').is(':checked'),
            autoInject: $('#sae-mv-autoinject').is(':checked'),
            // Match normalize.sanitizeMacroName: lowercase, [a-z0-9_-] only.
            macroName: String($('#sae-mv-macroname').val() || '')
                .trim().toLowerCase().replace(/[^a-z0-9_-]/g, ''),
            formatHeader: $('#sae-mv-header').val() || '',
            // Preserve an intentionally-empty field rather than inventing a
            // default: fall back to the prior value when the box is blank. This
            // keeps an untouched save byte-identical for agents that legitimately
            // leave these empty (e.g. Director, which never injects formatted
            // memory so formatEmpty stays ""). The one exception is below: a
            // NEW agent that turns injection ON with no format line at all would
            // feed back blank lines, so seed {{text}} in exactly that case.
            formatItem: (() => {
                if (memoryShape === 'structured') return `{{${structuredField}}}`;
                const typed = ($('#sae-mv-formatitem').val() || '').trim();
                if (memoryShape === 'plain') return typed || '{{text}}';
                if (typed) return typed;
                if (emv.formatItem) return emv.formatItem;
                // Only seed a usable default when memory is actually fed back
                // and nothing prior exists — otherwise preserve empty.
                return $('#sae-mv-inject').is(':checked') ? '{{text}}' : '';
            })(),
            formatEmpty: (($('#sae-mv-formatempty').val() || '').trim()
                || emv.formatEmpty || ''),
            mainContext: {
                ...(emv.mainContext || {}),
                presencePath: String($('#sae-mv-main-presence').val() || '').trim(),
                formatHeader: (() => {
                    const value = String($('#sae-mv-main-header').val() || '').trim();
                    return value || null;
                })(),
                formatItem: (() => {
                    const value = String($('#sae-mv-main-formatitem').val() || '').trim();
                    return value || null;
                })(),
                formatEmpty: String($('#sae-mv-main-empty').val() || '').trim(),
            },
            stripFromResponse: $('#sae-mv-strip').is(':checked'),
            mode: storageMode,
            extractPattern: memoryShape === 'plain' ? '' : ($('#sae-mv-pattern').val() || '').trim(),
            fieldNames,
            keyFields,
            resolveField: ($('#sae-mv-resolve-field').val() || '').trim(),
            resolveAction: ($('#sae-mv-resolve-action').val() || '').trim() || 'RESOLVED',
            validation: {
                ...(emv.validation || {}),
                enabled: memoryShape === 'structured' || customValidation,
                jsonField: memoryShape === 'structured'
                    ? structuredField
                    : (($('#sae-mv-validation-jsonfield').val() || '').trim()),
                schemaVersion: Math.max(1, parseInt($('#sae-mv-validation-version').val(), 10) || 1),
                schema: validationSchema,
                invariants: validationInvariants,
            },
        };

        if (result.sidecarCall.display?.hookClass === 'sa-generic-output-data') {
            result.sidecarCall.display.contentField = result.mergeVariable.fieldNames[0] || 'text';
        }
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
export function renderAgentEditor(container, agentId, cb = {}) {
    const existing = agentId ? getAgentById(agentId) : null;
    const agent = existing ? { ...existing } : createDefaultAgent();
    // A brand-new prompt should do something useful without hidden switches.
    // Direct pre-generation injection is the simplest, cheapest functional route.
    if (!existing) agent.phase = 'pre';

    container.innerHTML = `<div class="sam-empty sam-empty-sm">Loading editor…</div>`;
    const profiles = listConnectionProfiles();
    container.innerHTML = buildEditorHTML(agent, profiles);

    const schemaInput = container.querySelector('#sae-mv-validation-schema');
    const invariantsInput = container.querySelector('#sae-mv-validation-invariants');
    const builderMount = container.querySelector('#sae-structured-builder-mount');
    if (schemaInput && invariantsInput && builderMount) {
        structuredMemoryBuilder = createStructuredMemoryBuilder({
            schema: agent.mergeVariable?.validation?.schema || {},
            invariants: agent.mergeVariable?.validation?.invariants || [],
            schemaInput,
            invariantsInput,
        });
        builderMount.appendChild(structuredMemoryBuilder.el);
    }

    updateSectionVisibility();
    // Establish the carry-output ↔ self-memory exclusion for the loaded state.
    // A pre-guard agent with both on resolves to carry-output winning here.
    syncMemoryExclusion();

    const updateIconSummary = value => {
        const custom = String(value || '').trim();
        const category = $('#sae-category').val() || 'custom';
        const fallback = AGENT_CATEGORIES[category]?.icon || 'fa-puzzle-piece';
        $('#sae-icon-summary-preview').attr('class', `fa-solid ${custom || fallback}`);
        $('#sae-icon-summary-text').text(custom || 'Category default');
    };

    // Mount the searchable icon picker into its collapsed disclosure.
    iconPicker = createIconPicker({ value: agent.icon || '', onChange: updateIconSummary });
    const iconMount = container.querySelector('#sae-icon-mount');
    if (iconMount) iconMount.appendChild(iconPicker.el);
    updateIconSummary(agent.icon || '');

    $('#sae-icon-toggle').on('click', function () {
        const nowHidden = $('#sae-icon-mount').toggleClass('sae-hidden').hasClass('sae-hidden');
        this.setAttribute('aria-expanded', String(!nowHidden));
        $('#sae-icon-chevron')
            .toggleClass('fa-chevron-right', nowHidden)
            .toggleClass('fa-chevron-down', !nowHidden);
    });
    $('#sae-category').on('change', () => {
        if (!iconPicker?.getValue()) updateIconSummary('');
    });

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
        iconPicker = null;
        structuredMemoryBuilder?.destroy();
        structuredMemoryBuilder = null;
    };
    const cancel = () => { cleanup(); cb.onCancel?.(); };

    $('#sae-phase, #sae-execution-mode').on('change', function () {
        const mode = $('#sae-execution-mode').val();
        const phase = $('#sae-phase').val();
        // A post-gen sidecar with no stored/displayed result is effectively
        // invisible. Seed the useful plain-output path when the user chooses it.
        if (this.id === 'sae-execution-mode' && mode === 'sidecar' && phase !== 'pre'
            && !$('#sae-mv-enabled').is(':checked')) {
            $('#sae-mv-enabled, #sae-sidecar-display').prop('checked', true);
            $('#sae-mv-mode').val('snapshot');
            $('#sae-mv-fields').val('text');
            $('#sae-mv-keyfields').val('');
            $('#sae-memory-fields').removeClass('sae-hidden');
        }
        updateSectionVisibility();
        syncMemoryExclusion();
    });
    $('#sae-scope-mode').on('change', updateSectionVisibility);
    $('#sae-state-gate-enabled, #sae-state-gate-operator').on('change', updateSectionVisibility);
    $('#sae-rc-enabled').on('change', function () {
        $('#sae-richctx-flags').toggleClass('sae-hidden', !this.checked);
    });
    $('#sae-sidecar-history').on('change', updateSectionVisibility);
    $('#sae-sidecar-display').on('change', function () {
        if (this.checked && $('#sae-phase').val() !== 'pre') {
            $('#sae-mv-enabled').prop('checked', true);
            $('#sae-memory-fields').removeClass('sae-hidden');
        }
        syncMemoryExclusion();
    });
    $('#sae-post-enabled, #sae-post-type').on('change', updatePostToolVisibility);
    $('#sae-mv-enabled').on('change', function () {
        $('#sae-memory-fields').toggleClass('sae-hidden', !this.checked);
        // Enabling/disabling the memory block changes whether carry-output is
        // active, which drives the self-memory exclusion. Re-sync.
        syncMemoryExclusion();
        updateSectionVisibility();
    });
    $('#sae-mv-varname').on('input', () => {
        syncMemoryExclusion();
        updateSectionVisibility();
    });
    $('#sae-activation-policy').on('change', updateSectionVisibility);
    // Live-preview the custom macro token as the user types, sanitized the same
    // way normalize/save will store it.
    $('#sae-mv-macroname').on('input', function () {
        const v = String($(this).val() || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
        $('#sae-macro-preview').text(v || 'name');
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
    $('#sae-mv-dev-toggle').on('click', function () {
        const details = $('#sae-memory-developer');
        const nowHidden = details.toggleClass('sae-hidden').hasClass('sae-hidden');
        $('#sae-mv-dev-chevron')
            .toggleClass('fa-chevron-right', nowHidden)
            .toggleClass('fa-chevron-down', !nowHidden);
    });
    // The post-gen caveat note depends on whether an extraction pattern exists;
    // re-run the phase/pattern visibility check as the pattern box changes.
    $('#sae-mv-pattern').on('input', updateSectionVisibility);
    $('#sae-mv-mode').on('change', updateSectionVisibility);
    $('#sae-memory-shape').on('change', function () {
        if (this.value === 'structured') {
            $('#sae-mv-validation-enabled').prop('checked', true);
            if (!($('#sae-mv-validation-jsonfield').val() || '').trim()) $('#sae-mv-validation-jsonfield').val('json');
        } else if (this.value === 'plain') {
            $('#sae-mv-validation-enabled').prop('checked', false);
            const format = ($('#sae-mv-formatitem').val() || '').trim();
            if (!format || format === '{{json}}') $('#sae-mv-formatitem').val('{{text}}');
        } else {
            $('#sae-memory-advanced, #sae-memory-developer').removeClass('sae-hidden');
            $('#sae-mv-adv-chevron, #sae-mv-dev-chevron')
                .removeClass('fa-chevron-right')
                .addClass('fa-chevron-down');
        }
        updateSectionVisibility();
    });
    $('#sae-probability').on('input', function () {
        $('#sae-probability-val').text(this.value + '%');
    });

    $('#sae-back, #sae-cancel').on('click', cancel);

    document.addEventListener('keydown', onEscape);

    $('#sae-save').on('click', () => {
        let updated;
        try {
            updated = readFormToAgent(agent);
        } catch (error) {
            toastr.warning(error.message || 'The structured-state settings are invalid.');
            return;
        }
        if (!updated.name) {
            toastr.warning('Agent name is required.');
            $('#sae-name').focus();
            return;
        }
        if (updated.activationPolicy?.mode === 'until-state'
            && (!updated.mergeVariable?.enabled || !updated.mergeVariable?.variableName)) {
            toastr.warning('“Run until remembered state exists” requires Memory with a variable name.');
            $('#sae-activation-policy').focus();
            return;
        }
        const saved = saveAgent(updated);
        // Re-sync macros so a just-set/changed custom {{sa_…}} name (or an edited
        // variableName) is queryable immediately, not only after the next
        // generation or chat switch.
        refreshMacros();
        debug(`${LOG_PREFIX} saved agent ${saved.name} (${saved.id})`);
        toastr.success(`Agent "${saved.name}" saved.`);
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
