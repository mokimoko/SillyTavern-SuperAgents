/** Compact in-chat launchers for temporarily showing and hiding diegetic surfaces. */

import { eventSource, event_types } from '../../../../../../script.js';
import { isStoryChatOpen } from './chatPresence.js';
import { attachMovableSurfaceDock, repositionSurfaceDock } from './surfaceDockPosition.js';

const CSS_HREF = '/scripts/extensions/third-party/SillyTavern-SuperAgents/src/ui/surfaceDock.css?v=0.42.9';
const DOCK_ID = 'sa-surface-dock';
export const INITIAL_REFRESH_DELAYS = Object.freeze([0, 50, 200, 500, 1000, 2000]);

let dockEl = null;
let surfaces = [];
let eventsBound = false;

function injectStylesheet() {
    let link = document.querySelector('link[data-sa-surface-dock]');
    if (!link) {
        link = document.createElement('link');
        link.rel = 'stylesheet';
        link.setAttribute('data-sa-surface-dock', '');
        document.head.appendChild(link);
    }
    link.href = CSS_HREF;
}

function surfaceLabel(surface) {
    return String(surface.getLabel?.() || surface.label || surface.id).trim();
}

function surfaceIcon(surface) {
    return String(surface.getIcon?.() || surface.icon || 'fa-window-maximize').trim();
}

function surfaceTone(surface) {
    return String(surface.getTone?.() || surface.tone || surface.id).trim();
}

export function refreshSurfaceDock() {
    if (!dockEl) return;

    const chatOpen = isStoryChatOpen();
    let availableCount = 0;

    for (const surface of surfaces) {
        const button = dockEl.querySelector(`[data-sa-surface="${surface.id}"]`);
        if (!button) continue;

        const available = chatOpen && (surface.isAvailable?.() ?? true);
        button.hidden = !available;
        if (!available) continue;
        availableCount += 1;

        const open = !!surface.isOpen?.();
        const unread = Math.max(0, Number(surface.getUnread?.() || 0));
        const hasUnread = !open && unread > 0;
        const label = surfaceLabel(surface);
        const action = open ? 'Hide' : 'Open';
        const unreadText = hasUnread ? `, ${unread > 99 ? '99+' : unread} unread` : '';
        const icon = surfaceIcon(surface);
        const tone = surfaceTone(surface);

        const previousTone = button.dataset.saTone;
        if (previousTone && previousTone !== tone) button.classList.remove(`sa-surface-launcher--${previousTone}`);
        button.dataset.saTone = tone;
        button.classList.add(`sa-surface-launcher--${tone}`);
        const iconEl = button.querySelector('i');
        if (iconEl) iconEl.className = `fa-solid ${icon}`;

        button.classList.toggle('is-open', open);
        button.classList.toggle('has-unread', hasUnread);
        button.setAttribute('aria-pressed', String(open));
        button.setAttribute('aria-label', `${action} ${label}${unreadText}`);
        button.title = `${action} ${label}${unreadText}`;
        button.querySelector('.sa-surface-launcher-dot')?.toggleAttribute('hidden', !hasUnread);
    }

    dockEl.hidden = !chatOpen || availableCount === 0;
    if (!dockEl.hidden) repositionSurfaceDock();
}

/**
 * @param {Array<{id:string,label?:string,getLabel?:Function,icon?:string,getIcon?:Function,tone?:string,getTone?:Function,
 * isAvailable?:Function,isOpen:Function,getUnread:Function,toggle:Function}>} entries
 */
export function initSurfaceDock(entries) {
    surfaces = Array.isArray(entries) ? entries.filter(entry => entry?.id && entry?.toggle) : [];
    injectStylesheet();

    // Prefer an element already restored in the live DOM. This also repairs a
    // stale module reference after a frontend remount.
    dockEl = document.getElementById(DOCK_ID) || dockEl || document.createElement('aside');
    dockEl.id = DOCK_ID;
    dockEl.className = 'sa-surface-dock';
    dockEl.setAttribute('aria-label', 'Story apps');
    const grip = edge => `
        <button class="sa-surface-dock-grip sa-surface-dock-grip--${edge}" type="button"
                aria-label="Drag Story Apps" title="Drag Story Apps · Double-click to reset position">
            <i class="fa-solid fa-grip-vertical" aria-hidden="true"></i>
        </button>`;
    dockEl.innerHTML = grip('left') + surfaces.map(surface => `
        <button class="sa-surface-launcher sa-surface-launcher--${surfaceTone(surface)}"
                type="button" data-sa-surface="${surface.id}" data-sa-tone="${surfaceTone(surface)}" aria-pressed="false">
            <i class="fa-solid ${surfaceIcon(surface)}" aria-hidden="true"></i>
            <span class="sa-surface-launcher-dot" hidden aria-hidden="true"></span>
        </button>`).join('') + grip('right');
    if (!dockEl.isConnected) document.body.appendChild(dockEl);
    attachMovableSurfaceDock(dockEl);

    dockEl.querySelectorAll('[data-sa-surface]').forEach(button => {
        button.addEventListener('click', () => {
            const surface = surfaces.find(entry => entry.id === button.dataset.saSurface);
            if (!surface || !(surface.isAvailable?.() ?? true)) return;
            surface.toggle();
            requestAnimationFrame(refreshSurfaceDock);
        });
    });

    if (!eventsBound) {
        eventsBound = true;
        eventSource.on(event_types.CHAT_CHANGED, refreshSurfaceDock);
        if (event_types.MESSAGE_SWIPED) eventSource.on(event_types.MESSAGE_SWIPED, refreshSurfaceDock);
        if (event_types.APP_READY) eventSource.on(event_types.APP_READY, refreshSurfaceDock);
        if (event_types.CHARACTER_MESSAGE_RENDERED) {
            eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, refreshSurfaceDock);
        }
        globalThis.addEventListener?.('focus', refreshSurfaceDock);
    }
    // Some older profiles restore their active chat before third-party
    // extensions finish binding CHAT_CHANGED. Bounded retries cover that
    // startup race without leaving a polling loop behind.
    for (const delay of INITIAL_REFRESH_DELAYS) setTimeout(refreshSurfaceDock, delay);
}
