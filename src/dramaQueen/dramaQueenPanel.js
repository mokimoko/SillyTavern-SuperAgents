/** Draggable author-facing desk for planning and steering dramatic pressure. */

import { chat, chat_metadata, saveChatDebounced } from '../../../../../../script.js';
import { eventSource, event_types } from '../../../../../events.js';
import { findLastAssistantIndex, onRunStateChange, runAgentOnLastMessage } from '../core/lifecycle.js';
import { getEnabledAgents, getGlobalSettings, onStoreChange, saveAgent } from '../data/store.js';
import {
    bindVariableToMessage,
    getStateTransaction,
    readMergeArray,
    storeBatchedSidecarResult,
    writeMergeArray,
} from '../modes/mergeVariable.js';
import { isStoryChatOpen } from '../ui/chatPresence.js';
import { makeDraggablePanel, mountDraggablePanel } from '../ui/draggablePanel.js';
import { refreshSurfaceDock } from '../ui/surfaceDock.js';
import {
    initDramaQueenBeatController,
    isDramaQueenBeatControllerOpen,
    showDramaQueenBeatController,
    syncDramaQueenBeatController,
    toggleDramaQueenBeatController,
} from './dramaQueenBeatController.js';
import { requestDramaQueenIntent } from './dramaQueenRequests.js';
import {
    DRAMA_QUEEN_AUTO_CHECKPOINT_KEY,
    DRAMA_QUEEN_NUDGE_VARIABLE,
    activateDramaQueenProposal,
    applyDramaQueenDropGuard,
    applyDramaQueenPatch,
    clearDramaQueenDroppedPlan,
    dropDramaQueenEngine,
    getCurrentDramaQueenNudge,
    isDramaQueenRequestTargetCurrent,
    markDramaQueenPlanDropped,
    moveDramaQueenBeat,
    readDramaQueenInjectionEnabled,
    readDramaQueenProgressionMode,
    readDramaQueenState,
    setDramaQueenDamageCeiling,
    setDramaQueenPressure,
    setDramaQueenStageDirection,
    writeDramaQueenInjectionEnabled,
    writeDramaQueenProgressionMode,
} from './dramaQueenState.js';
import { dramaQueenBodyMarkup } from './dramaQueenView.js';

const PANEL_ID = 'sa-drama-queen-panel';
const CSS_HREF = '/scripts/extensions/third-party/SillyTavern-SuperAgents/src/dramaQueen/dramaQueenPanel.css?v=0.51.0-progression';
const ICON_HREF = '/scripts/extensions/third-party/SillyTavern-SuperAgents/images/icons/drama-queen.png?v=0.51.0';

let initialized = false;
let panel = null;
let panelController = null;
let busy = false;
let busyIntent = '';
let settingsOpen = false;
let outlineOpen = false;
let viewedBeat = null;
let adaptMode = 'keep-anchor';
let adaptNote = '';
let hauntNote = '';
let hauntComposerOpen = false;
let requestController = null;

function planningPromptSuffix(intent, options = {}) {
    if (intent === 'find-fault-lines') {
        return `## This run: Find the Fault Lines
Generate a fresh set of engines by mining established canon only and set every proposal's intent to find-fault-lines. Do not invent backstory or offscreen facts. Each catalyst must be a proposed next development that activates an established fault line, not a recap of what just happened. Use only established or inferred catalyst provenance.`;
    }
    if (intent === 'let-it-haunt-them') {
        const note = String(options.eventNote || '').trim().slice(0, 1600);
        return `## This run: Let It Haunt Them
Generate a fresh set of delayed-fallout engines and set every proposal's intent to let-it-haunt-them. Build consequences that return later rather than merely continuing the immediate confrontation. Label note-derived catalysts user-note.${note ? `\n\nPrivate event note:\n${note}` : ''}`;
    }
    return `## This run: Stir the Pot
Generate a fresh set of bold, grounded alternatives and set every proposal's intent to stir-the-pot. New catalysts are welcome and must be labeled new-catalyst. Favor complications caused by a character actively pursuing something over arbitrary accidents.`;
}

function planningTimeoutMs() {
    const configured = getGlobalSettings().agentCallTimeoutMs;
    if (configured === 0) return 0;
    // Multi-option dramatic engines are materially larger than ordinary
    // sidecars. Slower reasoning models need room to close the JSON cleanly.
    return Math.max(180000, Number(configured) || 0);
}

function getDramaQueenAgent() {
    return getEnabledAgents().find(agent => (
        agent.dramaQueenConfig?.enabled || agent.sourceTemplateId === 'tpl-drama-queen'
    )) || null;
}

function currentContext() {
    const agent = getDramaQueenAgent();
    const messageIndex = findLastAssistantIndex();
    const state = readDramaQueenState(readMergeArray(agent?.mergeVariable?.variableName || 'sa_drama_queen'));
    return {
        agent,
        messageIndex,
        message: messageIndex >= 0 ? chat[messageIndex] : null,
        state: applyDramaQueenDropGuard(state, chat_metadata),
        injectionEnabled: readDramaQueenInjectionEnabled(chat_metadata),
        progressionMode: readDramaQueenProgressionMode(chat_metadata, agent?.dramaQueenConfig),
        busy,
    };
}

function injectStylesheet() {
    if (document.querySelector('link[data-sa-drama-queen]')) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = CSS_HREF;
    link.setAttribute('data-sa-drama-queen', '');
    document.head.appendChild(link);
}

function commitState(context, state, source = 'drama_queen_user', options = {}) {
    if (!context.agent || !context.message || chat[context.messageIndex] !== context.message) return false;
    const stored = storeBatchedSidecarResult(
        context.agent,
        state,
        context.message,
        context.messageIndex,
        source,
    );
    if (!stored) {
        const transaction = getStateTransaction(context.message, context.agent.id);
        const reason = transaction?.errors?.[0];
        toastr.warning(
            reason
                ? `The new plans could not be saved: ${reason}`
                : 'The new plans could not be saved, so the previous set was preserved.',
            'Drama Queen',
        );
        return false;
    }
    if (options.markDropped) markDramaQueenPlanDropped(chat_metadata, options.markDropped);
    if (options.clearDropped) clearDramaQueenDroppedPlan(chat_metadata);
    if (options.resetAutoCheckpoint) {
        chat_metadata[DRAMA_QUEEN_AUTO_CHECKPOINT_KEY] = context.messageIndex;
    }
    writeMergeArray(DRAMA_QUEEN_NUDGE_VARIABLE, []);
    bindVariableToMessage(context.message, DRAMA_QUEEN_NUDGE_VARIABLE);
    bindVariableToMessage(context.message, context.agent.mergeVariable.variableName);
    saveChatDebounced();
    render();
    syncDramaQueenBeatController();
    refreshSurfaceDock();
    return true;
}

function updateFooter(context) {
    const labels = {
        'find-fault-lines': ['fa-magnifying-glass', 'Fault lines'],
        'stir-the-pot': ['fa-spoon', 'Stir the pot'],
        'let-it-haunt-them': ['fa-ghost', 'Haunt them'],
    };
    for (const button of panel?.querySelectorAll('[data-action="intent"]') || []) {
        const intent = button.dataset.intent;
        button.disabled = busy || !context.agent || context.messageIndex < 0;
        button.innerHTML = busy && busyIntent === intent
            ? '<i class="fa-solid fa-circle-notch fa-spin"></i> Planning…'
            : `<i class="fa-solid ${labels[intent][0]}"></i> ${labels[intent][1]}`;
    }
}

function syncHauntComposer() {
    const composer = panel?.querySelector('.sa-dq-haunt-composer');
    if (!composer) return;
    composer.hidden = !hauntComposerOpen;
    const textarea = composer.querySelector('#sa-dq-haunt-note');
    if (textarea && document.activeElement !== textarea && textarea.value !== hauntNote) {
        textarea.value = hauntNote;
    }
    const submit = composer.querySelector('[data-action="haunt-submit"]');
    if (submit) submit.disabled = busy;
}

function render() {
    if (!panel || !panelController?.isOpen()) return;
    const context = currentContext();
    const body = panel.querySelector('.sa-dq-body');
    const controllerButton = panel.querySelector('[data-action="controller"]');
    if (!body) return;

    updateFooter(context);
    panel.classList.toggle('is-busy', busy);
    if (controllerButton) {
        const enabled = context.agent?.dramaQueenConfig?.showBeatController !== false;
        controllerButton.disabled = !context.state.active || !enabled;
        const title = !context.state.active
            ? 'Activate a Drama Queen engine to use the compact controller'
            : enabled
                ? `${isDramaQueenBeatControllerOpen() ? 'Hide' : 'Show'} compact Drama Queen controller`
                : 'Enable the compact controller in Drama Queen settings';
        controllerButton.title = title;
        controllerButton.setAttribute('aria-label', title);
    }

    const nudge = context.progressionMode === 'nudge'
        ? getCurrentDramaQueenNudge(context.state, readMergeArray(DRAMA_QUEEN_NUDGE_VARIABLE))
        : null;
    body.innerHTML = dramaQueenBodyMarkup({
        ...context,
        settingsOpen,
        outlineOpen,
        viewedBeat,
        adaptMode,
        adaptNote,
        nudge,
    });
    syncHauntComposer();
}

async function requestPlan(intent, extra = {}) {
    const context = currentContext();
    if (!context.agent || !context.message || busy) return;
    if (context.state.active && intent !== 'make-it-worse'
        && !confirm('Replace the active Drama Queen engine with fresh private proposals?')) return;

    // All proposal intents share After Dark's reliable manual-agent pipeline;
    // only the private planning instruction changes between buttons.
    if (intent !== 'make-it-worse') {
        busy = true;
        busyIntent = intent;
        render();
        syncDramaQueenBeatController();
        try {
            const result = await runAgentOnLastMessage(context.agent.id, {
                promptSuffix: planningPromptSuffix(intent, extra),
                allowWhilePaused: true,
                timeoutMs: planningTimeoutMs(),
            });
            if (result?.dataStored && chat[context.messageIndex] === context.message) {
                clearDramaQueenDroppedPlan(chat_metadata);
                bindVariableToMessage(context.message, context.agent.mergeVariable.variableName);
                writeMergeArray(DRAMA_QUEEN_NUDGE_VARIABLE, []);
                bindVariableToMessage(context.message, DRAMA_QUEEN_NUDGE_VARIABLE);
                viewedBeat = null;
                outlineOpen = false;
                adaptNote = '';
                if (intent === 'let-it-haunt-them') hauntNote = '';
                hauntComposerOpen = false;
                saveChatDebounced();
            }
        } finally {
            busy = false;
            busyIntent = '';
            render();
            syncDramaQueenBeatController();
            refreshSurfaceDock();
        }
        return;
    }

    busy = true;
    busyIntent = intent;
    requestController = new AbortController();
    render();
    syncDramaQueenBeatController();
    try {
        const result = await requestDramaQueenIntent(context.agent, context.state, {
            intent,
            message: context.message,
            messageIndex: context.messageIndex,
            signal: requestController.signal,
            ...extra,
        });
        if (!result.ok) {
            if (!result.cancelled) toastr.warning(result.error, 'Drama Queen');
            return;
        }

        const live = currentContext();
        if (!isDramaQueenRequestTargetCurrent(result.target, live.message, live.messageIndex, live.state)) {
            toastr.info('The story or plan changed, so the stale private result was discarded.', 'Drama Queen');
            return;
        }

        if (intent === 'make-it-worse') {
            const applied = applyDramaQueenPatch(live.state, result.patch, {
                planIdentity: result.target.planIdentity,
                anchorBeatIndex: extra.anchorBeatIndex,
                anchorMode: extra.anchorMode,
            });
            if (!applied.ok) {
                toastr.warning(applied.error, 'Drama Queen');
                return;
            }
            if (commitState(live, applied.state, 'drama_queen_adapt', { resetAutoCheckpoint: true })) {
                adaptNote = '';
                toastr.success('The selected suffix was adapted. Locked beats were preserved.', 'Drama Queen');
            }
            return;
        }

        if (commitState(live, result.state, 'drama_queen_plan', { clearDropped: true })) {
            viewedBeat = null;
            outlineOpen = false;
            adaptNote = '';
            const count = result.state.proposals.length;
            toastr.success(`${count} private pressure engine${count === 1 ? '' : 's'} ready.`, 'Drama Queen');
        }
    } finally {
        busy = false;
        busyIntent = '';
        requestController = null;
        render();
        syncDramaQueenBeatController();
    }
}

function setInjectionEnabled(enabled) {
    const context = currentContext();
    const next = writeDramaQueenInjectionEnabled(chat_metadata, enabled);
    chat_metadata[DRAMA_QUEEN_AUTO_CHECKPOINT_KEY] = context.messageIndex;
    writeMergeArray(DRAMA_QUEEN_NUDGE_VARIABLE, []);
    if (context.message) bindVariableToMessage(context.message, DRAMA_QUEEN_NUDGE_VARIABLE);
    saveChatDebounced();
    render();
    syncDramaQueenBeatController();
    return next;
}

function setProgressionMode(mode) {
    const context = currentContext();
    if (!context.agent || !context.message || !context.state.active || busy) return;
    const current = readDramaQueenProgressionMode(chat_metadata, context.agent.dramaQueenConfig);
    const next = writeDramaQueenProgressionMode(chat_metadata, mode);
    if (next === current) return;
    chat_metadata[DRAMA_QUEEN_AUTO_CHECKPOINT_KEY] = context.messageIndex;
    writeMergeArray(DRAMA_QUEEN_NUDGE_VARIABLE, []);
    bindVariableToMessage(context.message, DRAMA_QUEEN_NUDGE_VARIABLE);
    saveChatDebounced();
    render();
    syncDramaQueenBeatController();
}

function cycleProgressionMode() {
    const context = currentContext();
    const modes = ['auto', 'nudge', 'none'];
    const current = readDramaQueenProgressionMode(chat_metadata, context.agent?.dramaQueenConfig);
    setProgressionMode(modes[(modes.indexOf(current) + 1) % modes.length]);
}

function moveActiveBeat(delta) {
    const context = currentContext();
    if (!context.agent || !context.message || !context.state.active || busy) return;
    const proposal = context.state.proposals[context.state.active.proposalIndex];
    viewedBeat = Math.max(0, Math.min(
        proposal.stages.length - 1,
        context.state.active.beatIndex + Number(delta || 0),
    ));
    commitState(context, moveDramaQueenBeat(context.state, delta), 'drama_queen_user', { resetAutoCheckpoint: true });
}

function adaptPlan() {
    const context = currentContext();
    if (!context.state.active || busy) return;
    const proposal = context.state.proposals[context.state.active.proposalIndex];
    const anchorBeatIndex = Math.max(0, Math.min(
        proposal.stages.length - 1,
        viewedBeat ?? context.state.active.beatIndex,
    ));
    requestPlan('make-it-worse', {
        anchorBeatIndex,
        anchorMode: adaptMode,
        instruction: adaptNote,
    });
}

function getViewedStage(context) {
    const proposal = context.state.active
        ? context.state.proposals[context.state.active.proposalIndex]
        : null;
    if (!proposal) return { proposal: null, stage: null, index: -1 };
    const index = Math.max(0, Math.min(
        proposal.stages.length - 1,
        viewedBeat ?? context.state.active.beatIndex,
    ));
    return { proposal, stage: proposal.stages[index], index };
}

function syncBeatEditActions() {
    const context = currentContext();
    const { stage } = getViewedStage(context);
    const textarea = panel?.querySelector('#sa-dq-beat-direction');
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
    const textarea = panel?.querySelector('#sa-dq-beat-direction');
    const direction = String(textarea?.value || '').replace(/\s+/g, ' ').trim();
    if (!stage || index < 0 || !direction || direction === stage.direction) return;
    const nextState = setDramaQueenStageDirection(context.state, index, direction);
    if (commitState(context, nextState, 'drama_queen_beat_edit', { resetAutoCheckpoint: true })) {
        toastr.success(`Beat ${index + 1} wording saved.`, 'Drama Queen');
    }
}

function saveSettings() {
    const context = currentContext();
    if (!context.agent) return;
    const wasShowingController = context.agent.dramaQueenConfig?.showBeatController !== false;
    const showBeatController = panel.querySelector('#sa-dq-show-controller')?.checked !== false;
    const includeInjection = panel.querySelector('#sa-dq-include-injection')?.checked !== false;
    const probeTerms = String(panel.querySelector('#sa-dq-probes')?.value || '')
        .split(',').map(value => value.trim()).filter(Boolean).slice(0, 20);
    saveAgent({
        ...context.agent,
        dramaQueenConfig: {
            ...context.agent.dramaQueenConfig,
            enabled: true,
            showBeatController,
            probeTerms,
        },
    });
    setInjectionEnabled(includeInjection);
    if (showBeatController && !wasShowingController && context.state.active) showDramaQueenBeatController();
    else syncDramaQueenBeatController();
    settingsOpen = false;
    toastr.success('Drama Queen preferences saved.', 'Drama Queen');
    render();
}

function handleAction(button) {
    const action = button.dataset.action;
    if (action === 'close') return hide();
    if (action === 'controller') {
        toggleDramaQueenBeatController();
        render();
        return;
    }
    if (busy) return;
    if (action === 'settings') {
        settingsOpen = !settingsOpen;
        return render();
    }
    if (action === 'intent') {
        if (button.dataset.intent === 'let-it-haunt-them') {
            hauntComposerOpen = true;
            syncHauntComposer();
            panel.querySelector('#sa-dq-haunt-note')?.focus();
            return;
        }
        return requestPlan(button.dataset.intent);
    }
    if (action === 'haunt-cancel') {
        hauntComposerOpen = false;
        return syncHauntComposer();
    }
    if (action === 'haunt-submit') {
        return requestPlan('let-it-haunt-them', { eventNote: hauntNote });
    }
    if (action === 'save-settings') return saveSettings();

    const context = currentContext();
    if (!context.agent || !context.message) return;
    if (action === 'activate') {
        viewedBeat = 0;
        const next = activateDramaQueenProposal(
            context.state,
            Number(button.dataset.proposal),
            context.messageIndex,
        );
        const committed = commitState(context, next, 'drama_queen_user', { clearDropped: true, resetAutoCheckpoint: true });
        if (committed && context.agent.dramaQueenConfig?.showBeatController !== false) {
            showDramaQueenBeatController();
        }
        return;
    }
    if (!context.state.active) return;
    if (action === 'back') return moveActiveBeat(-1);
    if (action === 'next') return moveActiveBeat(1);
    if (action === 'live-beat') {
        const target = Number(button.dataset.beat);
        viewedBeat = target;
        return commitState(context, moveDramaQueenBeat(
            context.state,
            target - context.state.active.beatIndex,
        ), 'drama_queen_user', { resetAutoCheckpoint: true });
    }
    if (action === 'view-beat') {
        viewedBeat = Number(button.dataset.beat);
        outlineOpen = true;
        return render();
    }
    if (action === 'reset-beat-edit') {
        const { stage } = getViewedStage(context);
        const textarea = panel.querySelector('#sa-dq-beat-direction');
        if (stage && textarea) textarea.value = stage.direction;
        syncBeatEditActions();
        return;
    }
    if (action === 'save-beat-edit') return saveBeatWording();
    if (action === 'progression') return setProgressionMode(button.dataset.mode);
    if (action === 'pressure') {
        return commitState(context, setDramaQueenPressure(context.state, button.dataset.value));
    }
    if (action === 'damage') {
        return commitState(context, setDramaQueenDamageCeiling(context.state, button.dataset.value));
    }
    if (action === 'adapt-mode') {
        adaptMode = button.dataset.mode === 'replace-anchor' ? 'replace-anchor' : 'keep-anchor';
        return render();
    }
    if (action === 'adapt') return adaptPlan();
    if (action === 'drop' && confirm('Drop the active Drama Queen engine? The unused proposals will remain here.')) {
        delete chat_metadata[DRAMA_QUEEN_AUTO_CHECKPOINT_KEY];
        return commitState(context, dropDramaQueenEngine(context.state), 'drama_queen_user', { markDropped: context.state });
    }
}

function createPanel() {
    panel = document.createElement('section');
    panel.id = PANEL_ID;
    panel.className = 'sa-dq-panel';
    panel.style.display = 'none';
    panel.setAttribute('aria-label', 'Drama Queen private dramatic-pressure planner');
    panel.innerHTML = `<header class="sa-dq-header">
        <div class="sa-dq-brand"><img src="${ICON_HREF}" alt=""><div><h2>Drama Queen</h2><p>Private pressure room</p></div></div>
        <div class="sa-dq-header-actions" data-no-drag>
            <button type="button" data-action="controller" title="Activate an engine to use the compact controller" aria-label="Activate an engine to use the compact controller" disabled><i class="fa-solid fa-gamepad"></i></button>
            <button type="button" data-action="settings" title="Drama Queen settings" aria-label="Drama Queen settings"><i class="fa-solid fa-sliders"></i></button>
            <button type="button" data-action="close" title="Close" aria-label="Close Drama Queen"><i class="fa-solid fa-xmark"></i></button>
        </div>
    </header>
    <main class="sa-dq-body"></main>
    <section class="sa-dq-haunt-composer" data-no-drag hidden>
        <div><span><i class="fa-solid fa-ghost"></i> Let it haunt them</span><button type="button" data-action="haunt-cancel" title="Close" aria-label="Close delayed fallout note"><i class="fa-solid fa-xmark"></i></button></div>
        <label for="sa-dq-haunt-note">What should come back later? <small>Optional · private author note</small></label>
        <textarea id="sa-dq-haunt-note" rows="3" maxlength="1600" placeholder="A lie, promise, humiliation, favor, secret, mistake, or unfinished threat…"></textarea>
        <button type="button" class="sa-dq-haunt-submit" data-action="haunt-submit"><i class="fa-solid fa-wand-magic-sparkles"></i> Generate delayed fallout</button>
    </section>
    <footer class="sa-dq-footer" data-no-drag>
        <span><i class="fa-solid fa-eye-slash"></i> Author eyes only</span>
        <div class="sa-dq-plan-actions">
            <button type="button" data-action="intent" data-intent="find-fault-lines" title="Mine established conflict only"></button>
            <button type="button" data-action="intent" data-intent="stir-the-pot" class="is-primary" title="Create grounded new pressure"></button>
            <button type="button" data-action="intent" data-intent="let-it-haunt-them" title="Build delayed fallout from an event"></button>
        </div>
    </footer>`;
    mountDraggablePanel(panel);
    panelController = makeDraggablePanel(panel, {
        id: PANEL_ID,
        handle: '.sa-dq-header',
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
        if (event.target?.id === 'sa-dq-adapt-note') adaptNote = event.target.value;
        if (event.target?.id === 'sa-dq-beat-direction') syncBeatEditActions();
        if (event.target?.id === 'sa-dq-haunt-note') hauntNote = event.target.value;
    });
    panel.addEventListener('toggle', event => {
        if (event.target?.classList?.contains('sa-dq-beat-outline')) outlineOpen = event.target.open;
    }, true);
}

export function initDramaQueenPanel() {
    if (initialized) return;
    initialized = true;
    injectStylesheet();
    createPanel();
    initDramaQueenBeatController({
        getContext: currentContext,
        onMove: moveActiveBeat,
        onProgression: cycleProgressionMode,
        onInjectionToggle: () => setInjectionEnabled(!readDramaQueenInjectionEnabled(chat_metadata)),
        onAdapt: () => {
            const context = currentContext();
            viewedBeat = context.state.active?.beatIndex ?? 0;
            outlineOpen = true;
            adaptMode = 'keep-anchor';
            show();
            render();
            panel.querySelector('#sa-dq-adapt-note')?.focus();
        },
        onOpen: show,
        onVisibilityChange: refreshSurfaceDock,
    });
    onRunStateChange(() => {
        render();
        syncDramaQueenBeatController();
    });
    onStoreChange(() => {
        if (!getDramaQueenAgent()) {
            requestController?.abort();
            if (panelController?.isOpen()) hide();
        }
        render();
        syncDramaQueenBeatController();
        refreshSurfaceDock();
    });
    eventSource.on(event_types.CHAT_CHANGED, () => {
        requestController?.abort();
        settingsOpen = false;
        outlineOpen = false;
        viewedBeat = null;
        adaptMode = 'keep-anchor';
        adaptNote = '';
        hauntNote = '';
        hauntComposerOpen = false;
        if (panelController?.isOpen()) hide();
        requestAnimationFrame(syncDramaQueenBeatController);
    });
    const onBranchChanged = () => {
        if (panelController?.isOpen()) render();
        syncDramaQueenBeatController();
    };
    if (event_types.MESSAGE_SWIPED) eventSource.on(event_types.MESSAGE_SWIPED, onBranchChanged);
    if (event_types.MESSAGE_DELETED) eventSource.on(event_types.MESSAGE_DELETED, onBranchChanged);
}

export function show() {
    panelController?.show();
    render();
    panelController?.bringToFront();
    refreshSurfaceDock();
}

export function hide() {
    requestController?.abort();
    hauntComposerOpen = false;
    panelController?.hide();
    refreshSurfaceDock();
}

export function isOpen() {
    return panelController?.isOpen() ?? false;
}

export function isAvailable() {
    return isStoryChatOpen() && !!getDramaQueenAgent();
}

export function canShowBeatController() {
    const context = currentContext();
    return !!context.state.active && context.agent?.dramaQueenConfig?.showBeatController !== false;
}

export function toggleBeatController() {
    if (!canShowBeatController()) return false;
    return toggleDramaQueenBeatController();
}

export function getUnread() {
    return 0;
}
