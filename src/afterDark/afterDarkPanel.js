/** Draggable author-facing UtilityApp for planning and steering After Dark scenes. */

import { chat, chat_metadata, saveChatDebounced } from '../../../../../../script.js';
import { eventSource, event_types } from '../../../../../events.js';
import { debug } from '../core/runtime.js';
import { getEnabledAgents, onStoreChange, saveAgent } from '../data/store.js';
import { findLastAssistantIndex, onRunStateChange, runAgentOnLastMessage } from '../core/lifecycle.js';
import { bindVariableToMessage, readMergeArray, storeBatchedSidecarResult, writeMergeArray } from '../modes/mergeVariable.js';
import { SUPERAGENTS_EVENTS } from '../integration/events.js';
import { makeDraggablePanel, mountDraggablePanel } from '../ui/draggablePanel.js';
import { isStoryChatOpen } from '../ui/chatPresence.js';
import { refreshSurfaceDock } from '../ui/surfaceDock.js';
import { requestAfterDarkAdaptation } from './afterDarkAdaptation.js';
import {
    initAfterDarkBeatController,
    isBeatControllerOpen,
    showForCurrentChat as showBeatControllerForCurrentChat,
    syncAfterDarkBeatController,
    toggleForCurrentChat as toggleBeatControllerForCurrentChat,
} from './afterDarkBeatController.js';
import {
    activateAfterDarkPitch,
    applyAfterDarkDropGuard,
    applyAfterDarkPatch,
    AFTER_DARK_AUTO_CHECKPOINT_KEY,
    AFTER_DARK_NUDGE_VARIABLE,
    clearAfterDarkDroppedPlan,
    dropAfterDarkPlan,
    getAfterDarkStateSignature,
    getCurrentAfterDarkNudge,
    markAfterDarkPlanDropped,
    moveAfterDarkStage,
    readAfterDarkInjectionEnabled,
    readAfterDarkProgressionMode,
    readAfterDarkState,
    setAfterDarkStageDirection,
    setAfterDarkStrength,
    writeAfterDarkProgressionMode,
    writeAfterDarkInjectionEnabled,
} from './afterDarkState.js';

const PANEL_ID = 'sa-after-dark-panel';
const CSS_HREF = '/scripts/extensions/third-party/SillyTavern-SuperAgents/src/afterDark/afterDarkPanel.css?v=0.51.0-settings-toggle';
const ICON_HREF = '/scripts/extensions/third-party/SillyTavern-SuperAgents/images/icons/after-dark.png?v=0.48.0';
const LOG_PREFIX = '[SuperAgents/afterDark]';

let panel = null;
let controller = null;
let initialized = false;
let busy = false;
let settingsOpen = false;
let viewedStageIndex = null;
let outlineOpen = false;
let adaptMode = 'after';
let adaptNote = '';
let adaptationController = null;

function esc(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

function getAfterDarkAgent() {
    return getEnabledAgents().find(agent => agent.afterDarkConfig?.enabled
        || agent.sourceTemplateId === 'tpl-after-dark') || null;
}

function currentContext() {
    const agent = getAfterDarkAgent();
    const messageIndex = findLastAssistantIndex();
    const state = readAfterDarkState(readMergeArray(agent?.mergeVariable?.variableName || 'sa_after_dark'));
    return {
        agent,
        messageIndex,
        message: messageIndex >= 0 ? chat[messageIndex] : null,
        state: applyAfterDarkDropGuard(state, chat_metadata),
        injectionEnabled: readAfterDarkInjectionEnabled(chat_metadata),
        busy,
    };
}

function injectStylesheet() {
    if (document.querySelector('link[data-sa-after-dark]')) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = CSS_HREF;
    link.setAttribute('data-sa-after-dark', '');
    document.head.appendChild(link);
}

function commitState(context, state, options = {}) {
    if (!context.agent || !context.message || chat[context.messageIndex] !== context.message) return false;
    const stored = storeBatchedSidecarResult(
        context.agent,
        state,
        context.message,
        context.messageIndex,
        options.source || 'after_dark_user',
    );
    if (!stored) return false;
    if (options.markDropped) markAfterDarkPlanDropped(chat_metadata, options.markDropped);
    if (options.clearDropped) clearAfterDarkDroppedPlan(chat_metadata);
    if (options.resetAutoCheckpoint) {
        chat_metadata[AFTER_DARK_AUTO_CHECKPOINT_KEY] = context.messageIndex;
    }
    writeMergeArray(AFTER_DARK_NUDGE_VARIABLE, []);
    bindVariableToMessage(context.message, AFTER_DARK_NUDGE_VARIABLE);
    bindVariableToMessage(context.message, context.agent.mergeVariable.variableName);
    saveChatDebounced();
    render();
    syncAfterDarkBeatController();
    refreshSurfaceDock();
    return true;
}

function activeMarkup(state, agent) {
    if (!state.active) return '';
    const pitch = state.pitches[state.active.pitchIndex];
    const stage = pitch?.stages[state.active.stageIndex];
    if (!pitch || !stage) return '';
    const viewed = Math.max(0, Math.min(pitch.stages.length - 1,
        viewedStageIndex === null ? state.active.stageIndex : viewedStageIndex));
    const viewedStage = pitch.stages[viewed];
    const stageButtons = pitch.stages.map((item, index) => `
        <button type="button" data-action="stage" data-stage="${index}" class="${index === state.active.stageIndex ? 'is-current' : ''}" title="Make ${esc(item.label)} the live beat">
            <i>${index + 1}</i><span>${esc(item.label)}</span>
        </button>`).join('');
    const strengths = [
        ['opening', 'Leave an opening'],
        ['pursuit', 'Make a move'],
        ['pressure', 'Turn it up'],
        ['commitment', 'Go for it'],
    ].map(([value, label]) => `<button type="button" data-action="strength" data-strength="${value}" class="${state.active.strength === value ? 'is-current' : ''}">${label}</button>`).join('');
    const progressionMode = readAfterDarkProgressionMode(chat_metadata, agent?.afterDarkConfig);
    const nudge = progressionMode === 'nudge'
        ? getCurrentAfterDarkNudge(state, readMergeArray(AFTER_DARK_NUDGE_VARIABLE))
        : null;
    const progressionModes = [
        ['auto', 'fa-forward-step', 'Auto', 'One beat per completed reply'],
        ['nudge', 'fa-lightbulb', 'Smart Nudge', 'Privately checks beat readiness'],
        ['none', 'fa-circle-minus', 'None', 'Manual control only'],
    ].map(([mode, icon, label, detail]) => `<button type="button" data-action="progression" data-mode="${mode}" class="${progressionMode === mode ? 'is-current' : ''}" aria-pressed="${progressionMode === mode}"><i class="fa-solid ${icon}"></i><span><b>${label}</b><small>${detail}</small></span></button>`).join('');
    const startStageIndex = adaptMode === 'including' ? viewed : viewed + 1;
    const canAdapt = startStageIndex < pitch.stages.length;
    const afterRangeLabel = viewed >= pitch.stages.length - 1
        ? 'No later beats'
        : `Replace ${viewed + 2}–${pitch.stages.length}`;
    const submitLabel = canAdapt
        ? `Replace beat${pitch.stages.length - startStageIndex === 1 ? '' : 's'} ${startStageIndex + 1}–${pitch.stages.length}`
        : 'Choose “Replace this beat too”';
    const outline = pitch.stages.map((item, index) => `<button type="button" data-action="view-stage" data-stage="${index}" class="${index === state.active.stageIndex ? 'is-active' : ''} ${index === viewed ? 'is-viewed' : ''}">
        <i>${index + 1}</i><span><b>${esc(item.label)}</b><small>${esc(item.direction)}</small></span>${index === state.active.stageIndex ? '<em>Live</em>' : ''}
    </button>`).join('');
    return `<section class="sa-ad-active">
        <div class="sa-ad-active-kicker"><span>Current bad idea</span><b>${esc(pitch.flavor)}</b></div>
        <h3>${esc(pitch.title)}</h3>
        <p class="sa-ad-cast"><i class="fa-solid fa-masks-theater"></i> ${esc(pitch.cast.join(' · '))}</p>
        <div class="sa-ad-stage-rail" data-no-drag>${stageButtons}</div>
        <article class="sa-ad-current-beat"><small>${esc(stage.label)}</small><p>${esc(stage.direction)}</p></article>
        ${nudge && nudge.status !== 'hold' ? `<div class="sa-ad-nudge is-${esc(nudge.status)}" title="${esc(nudge.reason)}"><i class="fa-solid ${nudge.status === 'ready' ? 'fa-circle-check' : nudge.status === 'diverged' ? 'fa-triangle-exclamation' : 'fa-forward'}"></i><b>${esc(nudge.status)}</b><span>${esc(nudge.reason)}</span></div>` : ''}
        <div class="sa-ad-progression" role="group" aria-label="Beat progression mode" data-no-drag>${progressionModes}</div>
        <div class="sa-ad-strength" data-no-drag>${strengths}</div>
        <div class="sa-ad-active-actions" data-no-drag>
            <button type="button" data-action="back" ${state.active.stageIndex === 0 ? 'disabled' : ''}><i class="fa-solid fa-arrow-left"></i> Back</button>
            <button type="button" data-action="next" class="is-hot" ${state.active.stageIndex >= pitch.stages.length - 1 ? 'disabled' : ''}>Next beat <i class="fa-solid fa-arrow-right"></i></button>
            <button type="button" data-action="drop" class="is-quiet">Drop it</button>
        </div>
        <details class="sa-ad-beat-outline" ${outlineOpen ? 'open' : ''} data-no-drag>
            <summary>View all beats <span>Previewing never changes the live beat</span></summary>
            <div class="sa-ad-outline-list">${outline}</div>
            <section class="sa-ad-beat-edit">
                <div class="sa-ad-beat-edit-heading"><span>Edit beat ${viewed + 1}</span><b>${esc(viewedStage.label)}</b></div>
                <label for="sa-ad-beat-direction">Beat wording <small>Local edit · no model call</small></label>
                <textarea id="sa-ad-beat-direction" rows="3" maxlength="900">${esc(viewedStage.direction)}</textarea>
                <div class="sa-ad-beat-edit-actions">
                    <button type="button" data-action="reset-beat-edit" disabled>Discard typing</button>
                    <button type="button" class="is-save" data-action="save-beat-edit" disabled><i class="fa-solid fa-floppy-disk"></i> Save wording</button>
                </div>
            </section>
            <section class="sa-ad-adapt-box">
                <div class="sa-ad-adapt-heading"><span>Adapt from beat ${viewed + 1}</span><b>${esc(viewedStage.label)}</b></div>
                <div class="sa-ad-adapt-range">
                    <button type="button" data-action="adapt-mode" data-mode="after" class="${adaptMode === 'after' ? 'is-current' : ''}" ${viewed >= pitch.stages.length - 1 ? 'disabled' : ''}>Keep this beat<small>${afterRangeLabel}</small></button>
                    <button type="button" data-action="adapt-mode" data-mode="including" class="${adaptMode === 'including' ? 'is-current' : ''}">Replace this beat too<small>Replace ${viewed + 1}–${pitch.stages.length}</small></button>
                </div>
                <label for="sa-ad-adapt-note">What should change? <small>Optional and private</small></label>
                <textarea id="sa-ad-adapt-note" rows="2" maxlength="1200" placeholder="Less romantic, more reckless. Do not use an interruption.">${esc(adaptNote)}</textarea>
                <button type="button" class="sa-ad-adapt-submit" data-action="adapt" ${!canAdapt || busy ? 'disabled' : ''}><i class="fa-solid fa-wand-magic-sparkles"></i> ${busy ? 'Adapting…' : submitLabel}</button>
            </section>
        </details>
    </section>`;
}

function pitchMarkup(pitch, index, activeIndex) {
    const kinkSource = pitch.kink.source.replace('-', ' ');
    return `<article class="sa-ad-pitch ${activeIndex === index ? 'is-active' : ''}">
        <div class="sa-ad-pitch-top"><span>${esc(pitch.flavor)}</span><em>${esc(pitch.pace)}</em></div>
        <h3>${esc(pitch.title)}</h3>
        <p class="sa-ad-cast">${esc(pitch.cast.join(' · '))}</p>
        <dl>
            <div><dt>Setup</dt><dd>${esc(pitch.setup)}</dd></div>
            <div><dt>Dynamic</dt><dd>${esc(pitch.dynamic)}</dd></div>
            <div class="sa-ad-kink"><dt>Kink</dt><dd><b>${esc(pitch.kink.idea)}</b><small>${esc(kinkSource)}${pitch.kink.reason ? ` · ${esc(pitch.kink.reason)}` : ''}</small></dd></div>
            <div><dt>Why this one</dt><dd>${esc(pitch.why)}</dd></div>
        </dl>
        <button type="button" class="sa-ad-use" data-action="select" data-pitch="${index}">${activeIndex === index ? 'Restart this plan' : 'Use this bad idea'} <i class="fa-solid fa-fire"></i></button>
    </article>`;
}

function settingsMarkup(agent, injectionEnabled) {
    if (!settingsOpen || !agent) return '';
    const probes = (agent.afterDarkConfig?.probeTerms || []).join(', ');
    const showBeatController = agent.afterDarkConfig?.showBeatController !== false;
    return `<section class="sa-ad-settings" data-no-drag>
        <label for="sa-ad-probes">Private NSFW lorebook probe</label>
        <p>These terms are used only for the dry-run World Info scan when cooking ideas. They are never posted to chat.</p>
        <div><input id="sa-ad-probes" value="${esc(probes)}" placeholder="NSFW, sex, sexual…"><button type="button" data-action="save-settings">Save</button></div>
        <label class="sa-ad-setting-toggle"><input id="sa-ad-include-injection" type="checkbox" ${injectionEnabled ? 'checked' : ''}><span><b>Include beat injection</b><small>Use the active beat in story generations. Turn this off to roleplay normally without dropping the plan.</small></span></label>
        <label class="sa-ad-setting-toggle"><input id="sa-ad-show-controller" type="checkbox" ${showBeatController ? 'checked' : ''}><span><b>Compact beat controller</b><small>Show the narrow live strip while a plan is active.</small></span></label>
    </section>`;
}

function render() {
    if (!panel || !controller?.isOpen()) return;
    const context = currentContext();
    const body = panel.querySelector('.sa-ad-body');
    const cook = panel.querySelector('[data-action="cook"]');
    const controllerButton = panel.querySelector('[data-action="controller"]');
    if (!body || !cook) return;
    cook.disabled = busy || !context.agent || context.messageIndex < 0;
    cook.innerHTML = busy
        ? '<i class="fa-solid fa-circle-notch fa-spin"></i> Cooking…'
        : `<i class="fa-solid fa-wand-magic-sparkles"></i> ${context.state.pitches.length ? 'Rethink this' : 'Cook up some ideas'}`;
    if (controllerButton) {
        const enabled = context.agent?.afterDarkConfig?.showBeatController !== false;
        controllerButton.disabled = !context.state.active || !enabled;
        const title = !context.state.active
            ? 'Start an After Dark plan to use the compact beat controller'
            : enabled
                ? `${isBeatControllerOpen() ? 'Hide' : 'Show'} compact beat controller`
                : 'Enable the compact beat controller in After Dark settings';
        controllerButton.title = title;
        controllerButton.setAttribute('aria-label', title);
    }
    panel.classList.toggle('is-busy', busy);
    if (!context.agent) {
        body.innerHTML = '<div class="sa-ad-empty"><i class="fa-solid fa-martini-glass-citrus"></i><h3>After Dark is off</h3><p>Install and enable the After Dark agent from the SuperAgents Library to use this utility.</p></div>';
        return;
    }
    const state = context.state;
    const pitches = state.pitches.map((pitch, index) => pitchMarkup(pitch, index, state.active?.pitchIndex)).join('');
    body.innerHTML = `${settingsMarkup(context.agent, context.injectionEnabled)}${activeMarkup(state, context.agent)}${state.sceneRead ? `<aside class="sa-ad-scene-read"><span>Right now</span><p>${esc(state.sceneRead)}</p></aside>` : ''}${pitches ? `<section class="sa-ad-pitches"><div class="sa-ad-section-title"><span>Possibilities</span><b>${state.pitches.length}</b></div><div class="sa-ad-pitch-grid">${pitches}</div></section>` : `<div class="sa-ad-empty"><i class="fa-solid fa-match-fire"></i><h3>No trouble planned yet</h3><p>Get a few character-aware ways to turn the current scene spicy. Nothing enters the story until you choose it.</p></div>`}`;
}

async function cookIdeas() {
    const context = currentContext();
    if (!context.agent || context.messageIndex < 0 || busy) return;
    if (context.state.active && !confirm('Replace the current After Dark plan with a fresh set of ideas?')) return;
    const result = await runAgentOnLastMessage(context.agent.id, { allowWhilePaused: true });
    if (result?.dataStored && chat[context.messageIndex] === context.message) {
        clearAfterDarkDroppedPlan(chat_metadata);
        bindVariableToMessage(context.message, context.agent.mergeVariable.variableName);
        saveChatDebounced();
        render();
    }
}

function setInjectionEnabled(enabled) {
    const context = currentContext();
    const next = writeAfterDarkInjectionEnabled(chat_metadata, enabled);
    chat_metadata[AFTER_DARK_AUTO_CHECKPOINT_KEY] = context.messageIndex;
    writeMergeArray(AFTER_DARK_NUDGE_VARIABLE, []);
    if (context.message) bindVariableToMessage(context.message, AFTER_DARK_NUDGE_VARIABLE);
    saveChatDebounced();
    render();
    syncAfterDarkBeatController();
    return next;
}

async function adaptPlan() {
    const context = currentContext();
    if (!context.agent || !context.message || !context.state.active || busy) return;
    const pitch = context.state.pitches[context.state.active.pitchIndex];
    const viewed = Math.max(0, Math.min(pitch.stages.length - 1,
        viewedStageIndex === null ? context.state.active.stageIndex : viewedStageIndex));
    const startStageIndex = adaptMode === 'including' ? viewed : viewed + 1;
    if (startStageIndex >= pitch.stages.length) return;

    const captured = {
        message: context.message,
        messageIndex: context.messageIndex,
        swipeId: context.message.swipe_id ?? 0,
        signature: getAfterDarkStateSignature(context.state),
    };
    busy = true;
    adaptationController = new AbortController();
    render();
    syncAfterDarkBeatController();
    try {
        const result = await requestAfterDarkAdaptation(context.agent, context.state, {
            startStageIndex,
            instruction: adaptNote,
            signal: adaptationController.signal,
        });
        if (!result.ok) {
            if (!result.cancelled) toastr.warning(result.error, 'After Dark');
            return;
        }
        const live = currentContext();
        const stale = live.message !== captured.message
            || live.messageIndex !== captured.messageIndex
            || (live.message?.swipe_id ?? 0) !== captured.swipeId
            || getAfterDarkStateSignature(live.state) !== captured.signature;
        if (stale) {
            toastr.info('The story or plan changed while the adaptation was running, so the stale result was discarded.', 'After Dark');
            return;
        }
        const applied = applyAfterDarkPatch(live.state, result.patch, { startStageIndex });
        if (!applied.ok) {
            toastr.warning(applied.error, 'After Dark');
            return;
        }
        if (commitState(live, applied.state, { resetAutoCheckpoint: true, source: 'after_dark_adapt' })) {
            adaptNote = '';
            toastr.success('The unlocked beats were adapted. Locked beats and other pitches were preserved.', 'After Dark');
        }
    } finally {
        adaptationController = null;
        busy = false;
        render();
        syncAfterDarkBeatController();
    }
}

function moveActiveBeat(delta) {
    const context = currentContext();
    if (!context.agent || !context.message || !context.state.active || busy) return;
    viewedStageIndex = Math.max(0, Math.min(4, context.state.active.stageIndex + Number(delta || 0)));
    commitState(context, moveAfterDarkStage(context.state, delta), { resetAutoCheckpoint: true });
}

function setProgressionMode(mode) {
    const context = currentContext();
    if (!context.agent || !context.message || !context.state.active || busy) return;
    const current = readAfterDarkProgressionMode(chat_metadata, context.agent.afterDarkConfig);
    const next = writeAfterDarkProgressionMode(chat_metadata, mode);
    if (next === current) return;
    chat_metadata[AFTER_DARK_AUTO_CHECKPOINT_KEY] = context.messageIndex;
    writeMergeArray(AFTER_DARK_NUDGE_VARIABLE, []);
    bindVariableToMessage(context.message, AFTER_DARK_NUDGE_VARIABLE);
    saveChatDebounced();
    render();
    syncAfterDarkBeatController();
}

function cycleProgressionMode() {
    const context = currentContext();
    const modes = ['auto', 'nudge', 'none'];
    const current = readAfterDarkProgressionMode(chat_metadata, context.agent?.afterDarkConfig);
    setProgressionMode(modes[(modes.indexOf(current) + 1) % modes.length]);
}

function getViewedStage(context) {
    const pitch = context.state.active
        ? context.state.pitches[context.state.active.pitchIndex]
        : null;
    if (!pitch) return { pitch: null, stage: null, index: -1 };
    const index = Math.max(0, Math.min(pitch.stages.length - 1,
        viewedStageIndex === null ? context.state.active.stageIndex : viewedStageIndex));
    return { pitch, stage: pitch.stages[index], index };
}

function syncBeatEditActions() {
    const context = currentContext();
    const { stage } = getViewedStage(context);
    const textarea = panel?.querySelector('#sa-ad-beat-direction');
    const saveButton = panel?.querySelector('[data-action="save-beat-edit"]');
    const resetButton = panel?.querySelector('[data-action="reset-beat-edit"]');
    if (!stage || !textarea || !saveButton || !resetButton) return;
    const next = String(textarea.value || '').replace(/\s+/g, ' ').trim();
    const changed = next !== stage.direction;
    saveButton.disabled = busy || !changed || !next;
    resetButton.disabled = busy || !changed;
}

function saveBeatWording() {
    const context = currentContext();
    const { stage, index } = getViewedStage(context);
    const textarea = panel?.querySelector('#sa-ad-beat-direction');
    const direction = String(textarea?.value || '').replace(/\s+/g, ' ').trim();
    if (!stage || index < 0 || !direction || direction === stage.direction) return;
    const nextState = setAfterDarkStageDirection(context.state, index, direction);
    if (commitState(context, nextState, {
        resetAutoCheckpoint: true,
        source: 'after_dark_beat_edit',
    })) {
        toastr.success(`Beat ${index + 1} wording saved.`, 'After Dark');
    }
}

function handleAction(button) {
    const action = button.dataset.action;
    if (action === 'close') return hide();
    if (action === 'controller') {
        toggleBeatControllerForCurrentChat();
        render();
        return;
    }
    if (busy) return;
    if (action === 'settings') {
        settingsOpen = !settingsOpen;
        return render();
    }
    if (action === 'cook') return cookIdeas();
    const context = currentContext();
    if (!context.agent || !context.message) return;
    if (action === 'select') {
        viewedStageIndex = 0;
        const committed = commitState(context, activateAfterDarkPitch(context.state, Number(button.dataset.pitch), context.messageIndex), { resetAutoCheckpoint: true, clearDropped: true });
        if (committed && context.agent.afterDarkConfig?.showBeatController !== false) showBeatControllerForCurrentChat();
        return committed;
    }
    if (action === 'back') return moveActiveBeat(-1);
    if (action === 'next') return moveActiveBeat(1);
    if (action === 'stage') {
        const target = Number(button.dataset.stage);
        viewedStageIndex = target;
        return commitState(context, moveAfterDarkStage(context.state,
            target - (context.state.active?.stageIndex || 0)), { resetAutoCheckpoint: true });
    }
    if (action === 'view-stage') {
        viewedStageIndex = Number(button.dataset.stage);
        outlineOpen = true;
        return render();
    }
    if (action === 'reset-beat-edit') {
        const { stage } = getViewedStage(context);
        const textarea = panel.querySelector('#sa-ad-beat-direction');
        if (stage && textarea) textarea.value = stage.direction;
        syncBeatEditActions();
        return;
    }
    if (action === 'save-beat-edit') return saveBeatWording();
    if (action === 'adapt-mode') {
        adaptMode = button.dataset.mode === 'including' ? 'including' : 'after';
        return render();
    }
    if (action === 'adapt') return adaptPlan();
    if (action === 'strength') return commitState(context, setAfterDarkStrength(context.state, button.dataset.strength));
    if (action === 'progression') return setProgressionMode(button.dataset.mode);
    if (action === 'drop' && confirm('Drop the active After Dark plan? The unused ideas will remain here.')) {
        delete chat_metadata[AFTER_DARK_AUTO_CHECKPOINT_KEY];
        return commitState(context, dropAfterDarkPlan(context.state), { markDropped: context.state });
    }
    if (action === 'save-settings') {
        const terms = String(panel.querySelector('#sa-ad-probes')?.value || '')
            .split(',').map(value => value.trim()).filter(Boolean).slice(0, 20);
        const wasShowingBeatController = context.agent.afterDarkConfig?.showBeatController !== false;
        const showBeatController = panel.querySelector('#sa-ad-show-controller')?.checked !== false;
        const includeInjection = panel.querySelector('#sa-ad-include-injection')?.checked !== false;
        saveAgent({
            ...context.agent,
            afterDarkConfig: {
                ...context.agent.afterDarkConfig,
                enabled: true,
                probeTerms: terms,
                showBeatController,
            },
        });
        setInjectionEnabled(includeInjection);
        if (showBeatController && !wasShowingBeatController && context.state.active) showBeatControllerForCurrentChat();
        else syncAfterDarkBeatController();
        toastr.success('After Dark preferences saved.', 'After Dark');
        settingsOpen = false;
        return render();
    }
}

function createPanel() {
    panel = document.createElement('section');
    panel.id = PANEL_ID;
    panel.className = 'sa-ad-panel';
    panel.style.display = 'none';
    panel.setAttribute('aria-label', 'After Dark private NSFW planner');
    panel.innerHTML = `<header class="sa-ad-header">
        <div class="sa-ad-brand"><img src="${ICON_HREF}" alt=""><div><h2>After Dark</h2><p>Private troublemaking department</p></div></div>
        <div class="sa-ad-header-actions" data-no-drag>
            <button type="button" data-action="controller" title="Start an After Dark plan to use the compact beat controller" aria-label="Start an After Dark plan to use the compact beat controller" disabled><i class="fa-solid fa-gamepad"></i></button>
            <button type="button" data-action="settings" title="After Dark settings" aria-label="After Dark settings"><i class="fa-solid fa-sliders"></i></button>
            <button type="button" data-action="close" title="Close" aria-label="Close After Dark"><i class="fa-solid fa-xmark"></i></button>
        </div>
    </header>
    <main class="sa-ad-body"></main>
    <footer class="sa-ad-footer" data-no-drag><span><i class="fa-solid fa-eye-slash"></i> Author eyes only</span><button type="button" data-action="cook"></button></footer>`;
    mountDraggablePanel(panel);
    controller = makeDraggablePanel(panel, {
        id: PANEL_ID,
        handle: '.sa-ad-header',
        defaultAnchor: 'center-right',
        resizable: true,
        minW: 460,
        minH: 430,
    });
    panel.addEventListener('click', event => {
        const button = event.target.closest('button[data-action]');
        if (button && !button.disabled) handleAction(button);
    });
    panel.addEventListener('input', event => {
        if (event.target?.id === 'sa-ad-adapt-note') adaptNote = event.target.value;
        if (event.target?.id === 'sa-ad-beat-direction') syncBeatEditActions();
    });
    panel.addEventListener('toggle', event => {
        if (event.target?.classList?.contains('sa-ad-beat-outline')) outlineOpen = event.target.open;
    }, true);
}

export function initAfterDarkPanel() {
    if (initialized) return;
    initialized = true;
    injectStylesheet();
    createPanel();
    initAfterDarkBeatController({
        getContext: currentContext,
        onMove: moveActiveBeat,
        onProgression: cycleProgressionMode,
        onInjectionToggle: () => setInjectionEnabled(!readAfterDarkInjectionEnabled(chat_metadata)),
        onAdapt: () => {
            const context = currentContext();
            viewedStageIndex = context.state.active?.stageIndex ?? 0;
            outlineOpen = true;
            adaptMode = 'after';
            show();
            render();
            panel.querySelector('#sa-ad-adapt-note')?.focus();
        },
        onOpen: show,
        onVisibilityChange: refreshSurfaceDock,
    });
    onRunStateChange(active => {
        busy = active;
        if (controller?.isOpen()) render();
        syncAfterDarkBeatController();
    });
    onStoreChange(() => {
        if (!getAfterDarkAgent()) {
            adaptationController?.abort();
            if (controller?.isOpen()) hide();
        }
        refreshSurfaceDock();
        render();
        syncAfterDarkBeatController();
    });
    globalThis.addEventListener(SUPERAGENTS_EVENTS.STATE_COMMITTED, event => {
        const context = currentContext();
        syncAfterDarkBeatController();
        if (!context.agent || event?.detail?.agentId !== context.agent.id || event?.detail?.source === 'after_dark_user' || event?.detail?.source === 'after_dark_adapt') return;
        if (event?.detail?.source === 'after_dark_auto') {
            viewedStageIndex = null;
            if (controller?.isOpen()) render();
            refreshSurfaceDock();
            return;
        }
        show();
    });
    eventSource.on(event_types.CHAT_CHANGED, () => {
        adaptationController?.abort();
        settingsOpen = false;
        viewedStageIndex = null;
        outlineOpen = false;
        adaptMode = 'after';
        adaptNote = '';
        if (controller?.isOpen()) hide();
        requestAnimationFrame(syncAfterDarkBeatController);
    });
    const onBranchChanged = () => {
        if (controller?.isOpen()) render();
        syncAfterDarkBeatController();
    };
    if (event_types.MESSAGE_SWIPED) eventSource.on(event_types.MESSAGE_SWIPED, onBranchChanged);
    if (event_types.MESSAGE_DELETED) eventSource.on(event_types.MESSAGE_DELETED, onBranchChanged);
    debug(`${LOG_PREFIX} initialized`);
}

export function isAvailable() {
    return isStoryChatOpen() && !!getAfterDarkAgent();
}

export function show() {
    if (!panel?.isConnected) {
        initialized = false;
        initAfterDarkPanel();
    }
    if (!isAvailable()) {
        toastr.info('Install and enable After Dark from the SuperAgents Library first.', 'After Dark');
        return;
    }
    controller.show();
    render();
    refreshSurfaceDock();
}

export function hide() {
    controller?.hide();
    refreshSurfaceDock();
}

export function isOpen() {
    return controller?.isOpen() ?? false;
}

export function canShowBeatController() {
    const context = currentContext();
    return !!context.state.active && context.agent?.afterDarkConfig?.showBeatController !== false;
}

export function toggleBeatController() {
    if (!canShowBeatController()) return false;
    return toggleBeatControllerForCurrentChat();
}

export function getUnread() {
    return 0;
}
