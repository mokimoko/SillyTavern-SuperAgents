/** Compact in-chat launchers for temporarily showing and hiding diegetic surfaces. */

import { eventSource, event_types } from '../../../../../../script.js';
import { isStoryChatOpen } from './chatPresence.js';
import { attachMovableSurfaceDock, repositionSurfaceDock } from './surfaceDockPosition.js';

const CSS_HREF = '/scripts/extensions/third-party/SillyTavern-SuperAgents/src/ui/surfaceDock.css?v=0.50.2-utility-controls';
const DOCK_ID = 'sa-surface-dock';
export const INITIAL_REFRESH_DELAYS = Object.freeze([0, 50, 200, 500, 1000, 2000]);

let dockEl = null;
let surfaces = [];
let utilities = [];
let eventsBound = false;
let utilityMenuOpen = false;

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

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;');
}

export function refreshSurfaceDock() {
    if (!dockEl) return;

    const chatOpen = isStoryChatOpen();
    const storyGroup = dockEl.querySelector('.sa-story-launchers');
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
    if (storyGroup) storyGroup.hidden = !chatOpen || availableCount === 0;

    const utilityButton = dockEl.querySelector('[data-sa-utilities]');
    const utilityMenu = dockEl.querySelector('.sa-utility-menu');
    const availableUtilities = utilities.filter(entry => entry.isAvailable?.() ?? true);
    if (utilityButton) {
        const unread = availableUtilities.reduce((sum, entry) => sum + Math.max(0, Number(entry.getUnread?.() || 0)), 0);
        utilityButton.hidden = !chatOpen || availableUtilities.length === 0;
        utilityButton.classList.toggle('has-unread', unread > 0);
        utilityButton.classList.toggle('is-open', utilityMenuOpen);
        utilityButton.setAttribute('aria-expanded', String(utilityMenuOpen));
        utilityButton.title = unread ? `Utilities, ${unread > 99 ? '99+' : unread} waiting` : 'Utilities';
        const badge = utilityButton.querySelector('.sa-utility-launcher-count');
        if (badge) {
            badge.textContent = unread > 99 ? '99+' : String(unread);
            badge.hidden = unread === 0;
        }
    }
    utilityMenu?.querySelectorAll('[data-sa-utility-row]').forEach(row => {
        const entry = utilities.find(candidate => candidate.id === row.dataset.saUtilityRow);
        const available = chatOpen && (entry?.isAvailable?.() ?? true);
        row.hidden = !available;
        if (!available || !entry) return;
        const button = row.querySelector('[data-sa-utility]');
        const unread = Math.max(0, Number(entry.getUnread?.() || 0));
        button?.classList.toggle('is-open', !!entry.isOpen?.());
        const count = button.querySelector('.sa-utility-menu-count');
        if (count) {
            count.textContent = unread > 99 ? '99+' : String(unread);
            count.hidden = unread === 0;
        }
        const secondary = row.querySelector('[data-sa-utility-secondary]');
        if (secondary) {
            const secondaryAvailable = entry.isSecondaryAvailable?.() ?? true;
            secondary.disabled = !secondaryAvailable;
            secondary.classList.toggle('is-open', secondaryAvailable && !!entry.isSecondaryOpen?.());
            secondary.setAttribute('aria-pressed', String(secondaryAvailable && !!entry.isSecondaryOpen?.()));
            secondary.setAttribute('aria-disabled', String(!secondaryAvailable));
            const secondaryTitle = secondaryAvailable
                ? (entry.secondaryLabel || `Open ${surfaceLabel(entry)}`)
                : (entry.secondaryUnavailableLabel || `${surfaceLabel(entry)} has no active plan to control`);
            secondary.title = secondaryTitle;
            secondary.setAttribute('aria-label', secondaryTitle);
        }
    });
    if (!chatOpen || availableUtilities.length === 0) closeUtilityMenu();

    dockEl.hidden = !chatOpen || (availableCount === 0 && availableUtilities.length === 0);
    if (!dockEl.hidden) repositionSurfaceDock();
}

/**
 * @param {Array<{id:string,label?:string,getLabel?:Function,icon?:string,getIcon?:Function,tone?:string,getTone?:Function,
 * isAvailable?:Function,isOpen:Function,getUnread:Function,toggle:Function}>} entries
 * @param {Array<{id:string,label:string,description?:string,icon?:string,isAvailable?:Function,isOpen:Function,getUnread:Function,toggle:Function,
 * secondaryAction?:Function,secondaryLabel?:string,secondaryUnavailableLabel?:string,secondaryIcon?:string,isSecondaryAvailable?:Function,isSecondaryOpen?:Function}>} utilityEntries
 */
export function initSurfaceDock(entries, utilityEntries = []) {
    surfaces = Array.isArray(entries) ? entries.filter(entry => entry?.id && entry?.toggle) : [];
    utilities = Array.isArray(utilityEntries) ? utilityEntries.filter(entry => entry?.id && entry?.toggle) : [];
    injectStylesheet();

    // Prefer an element already restored in the live DOM. This also repairs a
    // stale module reference after a frontend remount.
    dockEl = document.getElementById(DOCK_ID) || dockEl || document.createElement('aside');
    dockEl.id = DOCK_ID;
    dockEl.className = 'sa-surface-dock';
    dockEl.setAttribute('aria-label', 'Story Apps and utilities');
    const grip = edge => `
        <button class="sa-surface-dock-grip sa-surface-dock-grip--${edge}" type="button"
                aria-label="Drag Story Apps" title="Drag Story Apps · Double-click to reset position">
            <i class="fa-solid fa-grip-vertical" aria-hidden="true"></i>
        </button>`;
    dockEl.innerHTML = grip('left') + `<div class="sa-story-launchers">${surfaces.map(surface => `
            <button class="sa-surface-launcher sa-surface-launcher--${surfaceTone(surface)}"
                    type="button" data-sa-surface="${surface.id}" data-sa-tone="${surfaceTone(surface)}" aria-pressed="false">
                <i class="fa-solid ${surfaceIcon(surface)}" aria-hidden="true"></i>
                <span class="sa-surface-launcher-dot" hidden aria-hidden="true"></span>
            </button>`).join('')}</div>` + (utilities.length ? `
        <button class="sa-utility-launcher" type="button" data-sa-utilities aria-expanded="false" aria-haspopup="menu" aria-label="Open utilities">
            <i class="fa-solid fa-screwdriver-wrench" aria-hidden="true"></i>
            <span class="sa-utility-launcher-count" hidden></span>
        </button>
        <div class="sa-utility-menu" role="menu" hidden>
            ${utilities.map(entry => `
                <div class="sa-utility-menu-row" role="none" data-sa-utility-row="${entry.id}">
                    ${entry.secondaryAction ? `<button class="sa-utility-menu-secondary" type="button" role="menuitem" data-sa-utility-secondary="${entry.id}" title="${escapeHtml(entry.secondaryLabel || `Open ${surfaceLabel(entry)}`)}" aria-label="${escapeHtml(entry.secondaryLabel || `Open ${surfaceLabel(entry)}`)}" aria-pressed="false" disabled><i class="fa-solid ${escapeHtml(entry.secondaryIcon || 'fa-up-right-from-square')}" aria-hidden="true"></i></button>` : ''}
                    <button type="button" role="menuitem" data-sa-utility="${entry.id}" title="${escapeHtml(entry.description || surfaceLabel(entry))}">
                        <i class="fa-solid ${surfaceIcon(entry)}" aria-hidden="true"></i>
                        <span>${escapeHtml(surfaceLabel(entry))}</span>
                        <b class="sa-utility-menu-count" hidden></b>
                    </button>
                </div>`).join('')}
        </div>` : '') + grip('right');
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
    dockEl.querySelector('[data-sa-utilities]')?.addEventListener('click', event => {
        event.stopPropagation();
        utilityMenuOpen ? closeUtilityMenu() : openUtilityMenu();
    });
    dockEl.querySelectorAll('[data-sa-utility]').forEach(button => {
        button.addEventListener('click', () => {
            const entry = utilities.find(candidate => candidate.id === button.dataset.saUtility);
            if (!entry || !(entry.isAvailable?.() ?? true)) return;
            entry.toggle();
            closeUtilityMenu();
            requestAnimationFrame(refreshSurfaceDock);
        });
    });
    dockEl.querySelectorAll('[data-sa-utility-secondary]').forEach(button => {
        button.addEventListener('click', () => {
            const entry = utilities.find(candidate => candidate.id === button.dataset.saUtilitySecondary);
            if (!entry?.secondaryAction || !(entry.isSecondaryAvailable?.() ?? true)) return;
            entry.secondaryAction();
            closeUtilityMenu();
            requestAnimationFrame(refreshSurfaceDock);
        });
    });

    if (!eventsBound) {
        eventsBound = true;
        eventSource.on(event_types.CHAT_CHANGED, refreshSurfaceDock);
        if (event_types.MESSAGE_SWIPED) eventSource.on(event_types.MESSAGE_SWIPED, refreshSurfaceDock);
        if (event_types.MESSAGE_DELETED) eventSource.on(event_types.MESSAGE_DELETED, refreshSurfaceDock);
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

function openUtilityMenu() {
    const menu = dockEl?.querySelector('.sa-utility-menu');
    const button = dockEl?.querySelector('[data-sa-utilities]');
    if (!menu || !button) return;
    utilityMenuOpen = true;
    menu.hidden = false;
    const rect = button.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    const width = menuRect.width || 210;
    const height = menuRect.height || Math.min(280, 12 + utilities.length * 36);
    const viewportLeft = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8));
    const viewportTop = rect.bottom + height <= window.innerHeight - 8
        ? rect.bottom + 4
        : Math.max(8, rect.top - height - 4);

    // Theme backdrop filters can make the dock the containing block for this
    // fixed child. Translate viewport coordinates back into that local space.
    const containerRect = menu.offsetParent?.getBoundingClientRect?.();
    menu.style.left = `${viewportLeft - (containerRect?.left || 0)}px`;
    menu.style.top = `${viewportTop - (containerRect?.top || 0)}px`;
    button.classList.add('is-open');
    button.setAttribute('aria-expanded', 'true');
    setTimeout(() => document.addEventListener('click', onOutsideUtilityClick), 0);
    document.addEventListener('keydown', onUtilityKeyDown);
}

function closeUtilityMenu() {
    if (!utilityMenuOpen) return;
    utilityMenuOpen = false;
    const menu = dockEl?.querySelector('.sa-utility-menu');
    const button = dockEl?.querySelector('[data-sa-utilities]');
    if (menu) menu.hidden = true;
    button?.classList.remove('is-open');
    button?.setAttribute('aria-expanded', 'false');
    document.removeEventListener('click', onOutsideUtilityClick);
    document.removeEventListener('keydown', onUtilityKeyDown);
}

function onOutsideUtilityClick(event) {
    if (!event.target.closest('#sa-surface-dock')) closeUtilityMenu();
}

function onUtilityKeyDown(event) {
    if (event.key === 'Escape') closeUtilityMenu();
}
