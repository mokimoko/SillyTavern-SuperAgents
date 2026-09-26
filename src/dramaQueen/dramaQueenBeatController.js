/** Compact, event-driven remote for the currently injected Drama Queen beat. */
import { chat_metadata, saveChatDebounced } from '../../../../../../script.js';
import { readMergeArray } from '../modes/mergeVariable.js';
import { makeDraggablePanel, mountDraggablePanel } from '../ui/draggablePanel.js';
import { resolveSurfaceVisibility, setSurfaceVisibility } from '../ui/surfaceVisibilityState.js';
import { DRAMA_QUEEN_NUDGE_VARIABLE, getCurrentDramaQueenNudge, readDramaQueenInjectionEnabled, readDramaQueenProgressionMode } from './dramaQueenState.js';

const ID = 'sa-drama-queen-beat-controller';
const SURFACE = 'drama-queen-beat-controller';
const UI_VAR = 'sa_drama_queen_beat_controller_ui';
let panel, controller, callbacks;
const esc = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
function collapsed() { try { return JSON.parse(chat_metadata?.variables?.[UI_VAR] || '{}').collapsed === true; } catch { return false; } }
function setCollapsed(value) { if (!chat_metadata.variables) chat_metadata.variables = {}; chat_metadata.variables[UI_VAR] = JSON.stringify({ collapsed: !!value }); saveChatDebounced(); }
function button(action, icon, title, extra = '') { return `<button type="button" data-action="${action}" title="${esc(title)}" aria-label="${esc(title)}" ${extra}><i class="fa-solid ${icon}"></i></button>`; }
function markup(context) {
    const proposal = context.state.proposals[context.state.active.proposalIndex];
    const index = context.state.active.beatIndex, beat = proposal.stages[index];
    const injectionEnabled = readDramaQueenInjectionEnabled(chat_metadata);
    const progressionMode = readDramaQueenProgressionMode(chat_metadata, context.agent?.dramaQueenConfig);
    const injectionButton = button('injection', injectionEnabled ? 'fa-stop' : 'fa-play', injectionEnabled ? 'Pause Drama Queen injection' : 'Resume Drama Queen injection', `class="is-injection-toggle ${injectionEnabled ? '' : 'is-paused'}" aria-pressed="${injectionEnabled}"`);
    if (collapsed()) return `<div class="sa-dq-controller-collapsed"><b>${esc(beat.label)}</b><em>${index + 1}/6</em>${injectionButton}${button('expand', 'fa-chevron-up', 'Expand beat controller')}${button('close', 'fa-xmark', 'Close beat controller')}</div>`;
    const nudge = injectionEnabled && progressionMode === 'nudge' ? getCurrentDramaQueenNudge(context.state, readMergeArray(DRAMA_QUEEN_NUDGE_VARIABLE)) : null;
    const progression = {
        auto: ['fa-forward-step', 'Auto', 'Smart Nudge'],
        nudge: ['fa-lightbulb', 'Smart Nudge', 'None'],
        none: ['fa-circle-minus', 'None', 'Auto'],
    }[progressionMode];
    const status = nudge && nudge.status !== 'hold' ? `<span class="sa-dq-nudge is-${esc(nudge.status)}" title="${esc(nudge.reason)}">${esc(nudge.status)}</span>` : '';
    return `<div class="sa-dq-controller-shell"><div class="sa-dq-controller-top"><b title="${esc(proposal.title)}">${esc(beat.label)}</b><em>${index + 1}/6</em>${status}${injectionButton}${button('collapse', 'fa-chevron-down', 'Collapse beat controller')}${button('close', 'fa-xmark', 'Close beat controller')}</div><div class="sa-dq-progress" aria-hidden="true">${proposal.stages.map((_, i) => `<i class="${i < index ? 'is-done' : ''} ${i === index ? 'is-current' : ''}"></i>`).join('')}</div><p title="${esc(beat.direction)}">${esc(beat.direction)}</p><div class="sa-dq-controller-actions">${button('back', 'fa-arrow-left', 'Previous beat', index === 0 ? 'disabled' : '')}${button('next', 'fa-arrow-right', 'Next beat', index === 5 ? 'disabled' : '')}${button('adapt', 'fa-wand-magic-sparkles', 'Adapt from current beat')}${button('progression', progression[0], `${progression[1]} progression selected — click for ${progression[2]}`, `class="${progressionMode !== 'none' ? 'is-on' : ''} ${progressionMode === 'nudge' ? 'is-nudge' : ''}" aria-pressed="${progressionMode !== 'none'}"`)}${button('open', 'fa-up-right-from-square', 'Open Drama Queen')}</div></div>`;
}
function sync() {
    const context = callbacks?.getContext?.();
    if (!context?.state?.active || context.agent?.dramaQueenConfig?.showBeatController === false) return controller?.hide();
    panel.classList.toggle('is-collapsed', collapsed()); panel.classList.toggle('is-busy', context.busy === true); panel.classList.toggle('is-injection-paused', !readDramaQueenInjectionEnabled(chat_metadata));
    panel.querySelector('.sa-dq-controller-content').innerHTML = markup(context);
    if (resolveSurfaceVisibility(SURFACE, true)) { if (!controller.isOpen()) controller.show(); } else controller.hide();
}
export function initDramaQueenBeatController(options) {
    if (panel) return; callbacks = options;
    if (!document.querySelector('link[data-sa-drama-queen-controller]')) { const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = '/scripts/extensions/third-party/SillyTavern-SuperAgents/src/dramaQueen/dramaQueenPanel.css?v=0.51.0-progression'; link.dataset.saDramaQueenController = ''; document.head.appendChild(link); }
    panel = document.createElement('aside'); panel.id = ID; panel.className = 'sa-dq-controller'; panel.style.display = 'none'; panel.setAttribute('aria-label', 'Drama Queen current beat controller'); panel.innerHTML = '<div class="sa-dq-controller-content"></div>'; mountDraggablePanel(panel); controller = makeDraggablePanel(panel, { id: ID, defaultAnchor: 'center-right', resizable: false, snapToEdges: false });
    panel.addEventListener('click', event => { const b = event.target.closest('button[data-action]'); if (!b || b.disabled) return; const a = b.dataset.action; if (a === 'close') hideDramaQueenBeatController(); else if (a === 'collapse' || a === 'expand') { setCollapsed(a === 'collapse'); sync(); controller.reposition(); } else if (a === 'back') callbacks.onMove(-1); else if (a === 'next') callbacks.onMove(1); else if (a === 'adapt') callbacks.onAdapt(); else if (a === 'injection') callbacks.onInjectionToggle(); else if (a === 'progression') callbacks.onProgression(); else if (a === 'open') callbacks.onOpen(); }); sync();
}
export const syncDramaQueenBeatController = sync;
export function isDramaQueenBeatControllerOpen() { return controller?.isOpen() ?? false; }
export function showDramaQueenBeatController() { setSurfaceVisibility(SURFACE, true); sync(); controller?.bringToFront(); callbacks?.onVisibilityChange?.(); }
export function hideDramaQueenBeatController() { setSurfaceVisibility(SURFACE, false); controller?.hide(); callbacks?.onVisibilityChange?.(); }
export function toggleDramaQueenBeatController() { if (isDramaQueenBeatControllerOpen()) { hideDramaQueenBeatController(); return false; } showDramaQueenBeatController(); return true; }
