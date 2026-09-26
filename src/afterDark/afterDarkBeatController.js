/** Narrow, event-driven live remote for the active After Dark beat. */

import { chat_metadata, saveChatDebounced } from '../../../../../../script.js';
import { readMergeArray } from '../modes/mergeVariable.js';
import { makeDraggablePanel, mountDraggablePanel } from '../ui/draggablePanel.js';
import { resolveSurfaceVisibility, setSurfaceVisibility } from '../ui/surfaceVisibilityState.js';
import {
    AFTER_DARK_NUDGE_VARIABLE,
    getCurrentAfterDarkNudge,
    readAfterDarkInjectionEnabled,
    readAfterDarkProgressionMode,
} from './afterDarkState.js';

const PANEL_ID = 'sa-after-dark-beat-controller';
const SURFACE_ID = 'after-dark-beat-controller';
const UI_STATE_VAR = 'sa_after_dark_beat_controller_ui';
const CSS_HREF = '/scripts/extensions/third-party/SillyTavern-SuperAgents/src/afterDark/afterDarkBeatController.css?v=0.51.0-collapse-width';

let panel = null;
let controller = null;
let callbacks = null;

function esc(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

function readUiState() {
    try {
        const raw = chat_metadata?.variables?.[UI_STATE_VAR];
        const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
        return { collapsed: value?.collapsed === true };
    } catch {
        return { collapsed: false };
    }
}

function writeCollapsed(collapsed) {
    if (!chat_metadata.variables) chat_metadata.variables = {};
    chat_metadata.variables[UI_STATE_VAR] = JSON.stringify({ collapsed: !!collapsed });
    saveChatDebounced();
}

function injectStylesheet() {
    if (document.querySelector('link[data-sa-after-dark-beat-controller]')) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = CSS_HREF;
    link.setAttribute('data-sa-after-dark-beat-controller', '');
    document.head.appendChild(link);
}

function iconButton(action, icon, title, extra = '') {
    return `<button type="button" data-action="${action}" title="${esc(title)}" aria-label="${esc(title)}" ${extra}><i class="fa-solid ${icon}"></i></button>`;
}

function markup(context) {
    const state = context.state;
    const pitch = state.pitches[state.active.pitchIndex];
    const stageIndex = state.active.stageIndex;
    const stage = pitch.stages[stageIndex];
    const collapsed = readUiState().collapsed;
    const injectionEnabled = readAfterDarkInjectionEnabled(chat_metadata);
    const injectionButton = iconButton(
        'injection',
        injectionEnabled ? 'fa-stop' : 'fa-play',
        injectionEnabled ? 'Pause After Dark injection' : 'Resume After Dark injection',
        `class="is-injection-toggle ${injectionEnabled ? '' : 'is-paused'}" aria-pressed="${injectionEnabled}"`,
    );
    const progressionMode = readAfterDarkProgressionMode(chat_metadata, context.agent?.afterDarkConfig);
    const nudge = injectionEnabled && progressionMode === 'nudge'
        ? getCurrentAfterDarkNudge(state, readMergeArray(AFTER_DARK_NUDGE_VARIABLE))
        : null;
    const progression = {
        auto: ['fa-forward-step', 'Auto', 'Smart Nudge'],
        nudge: ['fa-lightbulb', 'Smart Nudge', 'None'],
        none: ['fa-circle-minus', 'None', 'Auto'],
    }[progressionMode];
    const status = nudge?.status === 'hold' ? '' : (nudge?.status || '');
    const statusTitle = nudge?.reason || '';
    const segments = pitch.stages.map((_, index) => `<i class="${index < stageIndex ? 'is-done' : ''} ${index === stageIndex ? 'is-current' : ''}"></i>`).join('');

    if (collapsed) {
        return `<div class="sa-ad-beat-collapsed">
            <b>${esc(stage.label)}</b><em>${stageIndex + 1}/${pitch.stages.length}</em>
            ${injectionButton}
            ${iconButton('expand', 'fa-chevron-up', 'Expand beat controller')}
            ${iconButton('close', 'fa-xmark', 'Close beat controller')}
        </div>`;
    }

    return `<div class="sa-ad-beat-shell ${status ? `is-${status}` : ''}">
        <div class="sa-ad-beat-top">
            <b title="${esc(pitch.title)}">${esc(stage.label)}</b>
            <em>${stageIndex + 1}/${pitch.stages.length}</em>
            ${status ? `<span class="sa-ad-beat-status" title="${esc(statusTitle)}" aria-label="${esc(`${status}: ${statusTitle}`)}"><i class="fa-solid ${status === 'ready' ? 'fa-circle-check' : status === 'diverged' ? 'fa-triangle-exclamation' : status === 'overshot' ? 'fa-forward' : 'fa-minus'}"></i></span>` : ''}
            ${injectionButton}
            ${iconButton('collapse', 'fa-chevron-down', 'Collapse beat controller')}
            ${iconButton('close', 'fa-xmark', 'Close beat controller')}
        </div>
        <div class="sa-ad-beat-progress" aria-hidden="true">${segments}</div>
        <p title="${esc(stage.direction)}">${esc(stage.direction)}</p>
        <div class="sa-ad-beat-actions">
            ${iconButton('back', 'fa-arrow-left', 'Previous beat', stageIndex === 0 ? 'disabled' : '')}
            ${iconButton('next', 'fa-arrow-right', status === 'overshot' ? 'Next beat — the scene may have moved ahead' : 'Next beat', stageIndex >= pitch.stages.length - 1 ? 'disabled' : '')}
            ${iconButton('adapt', 'fa-wand-magic-sparkles', status === 'diverged' ? 'Adapt from this beat — plan may have diverged' : 'Adapt from current beat')}
            ${iconButton('progression', progression[0], `${progression[1]} progression selected — click for ${progression[2]}`, `class="${progressionMode !== 'none' ? 'is-on' : ''} ${progressionMode === 'nudge' ? 'is-nudge' : ''}" aria-pressed="${progressionMode !== 'none'}"`)}
            ${iconButton('open', 'fa-up-right-from-square', 'Open full After Dark planner')}
        </div>
    </div>`;
}

function handleAction(button) {
    const action = button.dataset.action;
    if (action === 'close') return hideForCurrentChat();
    if (action === 'collapse' || action === 'expand') {
        writeCollapsed(action === 'collapse');
        syncAfterDarkBeatController();
        controller?.reposition();
        return;
    }
    if (action === 'back') callbacks?.onMove?.(-1);
    if (action === 'next') callbacks?.onMove?.(1);
    if (action === 'adapt') callbacks?.onAdapt?.();
    if (action === 'injection') callbacks?.onInjectionToggle?.();
    if (action === 'progression') callbacks?.onProgression?.();
    if (action === 'open') callbacks?.onOpen?.();
}

export function initAfterDarkBeatController(options) {
    if (panel) return;
    callbacks = options;
    injectStylesheet();
    panel = document.createElement('aside');
    panel.id = PANEL_ID;
    panel.className = 'sa-ad-beat-controller';
    panel.style.display = 'none';
    panel.setAttribute('aria-label', 'After Dark current beat controller');
    panel.innerHTML = '<div class="sa-ad-beat-content"></div>';
    mountDraggablePanel(panel);
    controller = makeDraggablePanel(panel, {
        id: PANEL_ID,
        defaultAnchor: 'center-right',
        resizable: false,
        snapToEdges: false,
    });
    panel.addEventListener('click', event => {
        const button = event.target.closest('button[data-action]');
        if (button && !button.disabled) handleAction(button);
    });
    syncAfterDarkBeatController();
}

export function syncAfterDarkBeatController() {
    if (!panel || !callbacks) return;
    const context = callbacks.getContext?.();
    const enabled = context?.agent?.afterDarkConfig?.showBeatController !== false;
    if (!enabled || !context?.state?.active) {
        controller?.hide();
        return;
    }
    panel.classList.toggle('is-collapsed', readUiState().collapsed);
    panel.classList.toggle('is-busy', context.busy === true);
    panel.classList.toggle('is-injection-paused', !readAfterDarkInjectionEnabled(chat_metadata));
    const content = panel.querySelector('.sa-ad-beat-content');
    if (content) content.innerHTML = markup(context);
    // show() restores the saved position. Avoid reapplying it while an open
    // controller may be under the pointer during an unrelated state update.
    if (resolveSurfaceVisibility(SURFACE_ID, true)) {
        if (!controller?.isOpen()) controller?.show();
    }
    else controller?.hide();
}

export function showForCurrentChat() {
    setSurfaceVisibility(SURFACE_ID, true);
    syncAfterDarkBeatController();
    controller?.bringToFront();
    callbacks?.onVisibilityChange?.();
}

export function hideForCurrentChat() {
    setSurfaceVisibility(SURFACE_ID, false);
    controller?.hide();
    callbacks?.onVisibilityChange?.();
}

export function isBeatControllerOpen() {
    return controller?.isOpen() ?? false;
}

export function toggleForCurrentChat() {
    if (isBeatControllerOpen()) {
        hideForCurrentChat();
        return false;
    }
    showForCurrentChat();
    return isBeatControllerOpen();
}
