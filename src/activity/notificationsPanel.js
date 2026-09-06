/** A quiet, source-linked notification center projected from Activity artifacts. */

import {
    eventSource,
    event_types,
    saveSettingsDebounced,
} from '../../../../../../script.js';
import { extension_settings } from '../../../../../extensions.js';
import { MODULE_NAME, debug } from '../../index.js';
import { makeDraggablePanel, mountDraggablePanel } from '../ui/draggablePanel.js';
import { registerPanelControl } from '../ui/modal.js';
import { refreshSurfaceDock } from '../ui/surfaceDock.js';
import { isStoryChatOpen } from '../ui/chatPresence.js';
import { resolveSurfaceVisibility, setSurfaceVisibility } from '../ui/surfaceVisibilityState.js';
import {
    getActivePresentationProfile,
    getActiveSurfacePresentation,
    onPresentationChanged,
} from '../presentation/presentationState.js';
import {
    getNotificationState,
    markAllNotificationsRead,
    onActivityChanged,
    openActivitySource,
} from './activityHub.js';

const LOG_PREFIX = '[SuperAgents/notifications]';
const CSS_HREF = '/scripts/extensions/third-party/SillyTavern-SuperAgents/src/activity/notificationsPanel.css?v=0.41.2-groups';
let panelEl = null;
let controller = null;
const PANEL_ID = 'notifications';

const inChat = isStoryChatOpen;

function isNotificationsAvailable() {
    return getActiveSurfacePresentation('notifications')?.capabilities?.available !== false;
}

function persistedVisible() {
    return !!extension_settings[MODULE_NAME]?.notificationsVisible;
}

function persistVisible(value) {
    const root = extension_settings[MODULE_NAME] ?? (extension_settings[MODULE_NAME] = {});
    root.notificationsVisible = !!value;
    saveSettingsDebounced();
}

function injectStylesheet() {
    if (document.querySelector('link[data-sa-notifications]')) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = CSS_HREF;
    link.setAttribute('data-sa-notifications', '');
    document.head.appendChild(link);
}

function esc(value) {
    const div = document.createElement('div');
    div.textContent = String(value ?? '');
    return div.innerHTML;
}

function escAttr(value) {
    return esc(value).replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function relativeTime(timestamp) {
    const seconds = Math.max(0, Math.floor((Date.now() - Number(timestamp || 0)) / 1000));
    if (seconds < 60) return 'now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
    return `${Math.floor(seconds / 86400)}d`;
}

function sourcePresentation(sourceApp) {
    const surface = getActiveSurfacePresentation(sourceApp);
    if (surface) return {
        label: surface.sourceLabel || surface.label,
        icon: surface.notificationIcon || surface.icon,
        tone: surface.tone || sourceApp,
    };
    return { label: sourceApp || 'Activity', icon: 'fa-bolt', tone: 'activity' };
}

function presentedArtifact(artifact) {
    const surface = getActiveSurfacePresentation(artifact.sourceApp) || {};
    const copy = surface.copy || {};
    if (artifact.type === 'phone.message') {
        return {
            title: String(copy.notificationTitle || 'Message from {actor}').replace('{actor}', artifact.actor || ''),
            summary: artifact.summary,
        };
    }
    if (artifact.type === 'feed.post') {
        return {
            title: String(copy.notificationTitle || '{actor} posted').replace('{actor}', artifact.actor || ''),
            summary: artifact.summary,
        };
    }
    if (artifact.type === 'calendar.commitment') {
        const status = surface.statusLabels?.[artifact.context?.status] || artifact.context?.status || '';
        const type = surface.typeLabels?.[artifact.context?.type] || artifact.context?.type || surface.entryLabel || '';
        const location = String(artifact.summary || '').split(' · ').slice(1).join(' · ');
        return { title: artifact.title, summary: [status, type].filter(Boolean).join(' ') + (location ? ` · ${location}` : '') };
    }
    return { title: artifact.title, summary: artifact.summary };
}

function render() {
    if (!panelEl || !controller?.isOpen()) return;
    const state = getNotificationState();
    const surface = getActiveSurfacePresentation('notifications') || {};
    const copy = surface.copy || {};
    const list = panelEl.querySelector('.sa-notifications-list');
    const badge = panelEl.querySelector('.sa-notifications-badge');
    const markAll = panelEl.querySelector('.sa-notifications-read-all');
    if (badge) {
        badge.textContent = state.unread > 99 ? '99+' : String(state.unread);
        badge.hidden = state.unread === 0;
    }
    if (markAll) markAll.disabled = state.unread === 0;
    if (!list) return;

    if (!state.artifacts.length) {
        list.innerHTML = `
            <div class="sa-notifications-empty">
                <span class="sa-notifications-empty-orbit"><i class="fa-regular fa-bell-slash"></i></span>
                <strong>${esc(copy.emptyTitle || 'Nothing needs you yet.')}</strong>
                <p>${esc(copy.emptyBody || 'Messages, posts, and commitments gather here without replacing their source apps.')}</p>
            </div>`;
        return;
    }

    list.innerHTML = [...state.artifacts].reverse().map(artifact => {
        const source = sourcePresentation(artifact.sourceApp);
        const presented = presentedArtifact(artifact);
        return `
            <button class="sa-notification-item ${artifact.unread ? 'is-unread' : ''}"
                    type="button" data-artifact-id="${escAttr(artifact.id)}">
                <span class="sa-notification-source sa-notification-source--${source.tone}">
                    <i class="fa-solid ${source.icon}" aria-hidden="true"></i>
                </span>
                <span class="sa-notification-copy">
                    <span class="sa-notification-eyebrow">${esc(source.label)} · ${relativeTime(artifact.timestamp)}</span>
                    <strong>${esc(presented.title)}</strong>
                    ${presented.summary ? `<span>${esc(presented.summary)}</span>` : ''}
                </span>
                <span class="sa-notification-open" aria-hidden="true"><i class="fa-solid fa-arrow-up-right-from-square"></i></span>
            </button>`;
    }).join('');

    list.querySelectorAll('[data-artifact-id]').forEach(item => {
        item.addEventListener('click', async () => {
            item.disabled = true;
            const result = await openActivitySource(item.dataset.artifactId);
            if (!result.opened) {
                toastr.info(copy.unavailable || 'The original app or artifact is no longer available.', surface.title || 'Notifications', {
                    timeOut: 3500,
                });
            }
            render();
            refreshSurfaceDock();
        });
    });
}

function reconcile() {
    if (!controller) return;
    if (!inChat() || !isNotificationsAvailable()) {
        controller.hide();
        refreshSurfaceDock();
        return;
    }
    if (resolveSurfaceVisibility(PANEL_ID, persistedVisible())) {
        controller.show();
        render();
    } else {
        controller.hide();
    }
    refreshSurfaceDock();
}

export function initNotificationsPanel() {
    if (panelEl) return;
    injectStylesheet();
    panelEl = document.createElement('section');
    panelEl.id = 'sa-notifications-panel';
    panelEl.className = 'sa-notifications-panel';
    const surface = getActiveSurfacePresentation('notifications') || {};
    const copy = surface.copy || {};
    panelEl.dataset.saPresentationProfile = getActivePresentationProfile().id;
    panelEl.setAttribute('aria-label', surface.label || 'Notifications');
    panelEl.innerHTML = `
        <header class="sa-notifications-header" title="Drag to move">
            <div class="sa-notifications-brand">
                <span class="sa-notifications-signal"><i class="fa-regular ${surface.panelIcon || 'fa-bell'}"></i></span>
                <div><small>${esc(surface.eyebrow || 'ACTIVITY')}</small><strong>${esc(surface.title || 'Notifications')}</strong></div>
            </div>
            <span class="sa-notifications-badge" hidden>0</span>
            <button class="sa-notifications-read-all" data-no-drag type="button" title="${esc(copy.markAllRead || 'Mark all read')}">
                <i class="fa-solid fa-check-double"></i>
            </button>
            <button class="sa-notifications-close" data-no-drag type="button" title="${esc(copy.hide || 'Hide')}">
                <i class="fa-solid fa-xmark"></i>
            </button>
        </header>
        <main class="sa-notifications-list"></main>`;
    mountDraggablePanel(panelEl);
    controller = makeDraggablePanel(panelEl, {
        id: 'notifications',
        handle: '.sa-notifications-header',
        defaultAnchor: 'top-left',
        snapToEdges: true,
        resizable: true,
        minW: 330,
        minH: 320,
    });

    panelEl.querySelector('.sa-notifications-close')?.addEventListener('click', () => hide(false));
    panelEl.querySelector('.sa-notifications-read-all')?.addEventListener('click', () => {
        markAllNotificationsRead();
        render();
        refreshSurfaceDock();
    });
    registerPanelControl({
        id: 'notifications',
        getLabel: () => getActiveSurfacePresentation('notifications')?.settingsLabel || 'Notifications',
        getIcon: () => getActiveSurfacePresentation('notifications')?.icon || 'fa-bell',
        controller: {
            show: () => show(), hide, toggle: () => (isOpen() ? hide() : show()), isOpen,
            isDefaultVisible: persistedVisible,
            isAvailable: isNotificationsAvailable,
            reconcile,
            resetPosition: () => controller?.resetPosition(),
        },
    });
    onPresentationChanged(() => {
        const next = getActiveSurfacePresentation('notifications') || {};
        if (!panelEl) return;
        panelEl.dataset.saPresentationProfile = getActivePresentationProfile().id;
        panelEl.setAttribute('aria-label', next.label || 'Notifications');
        const icon = panelEl.querySelector('.sa-notifications-signal i');
        if (icon) icon.className = `fa-regular ${next.panelIcon || 'fa-bell'}`;
        const eyebrow = panelEl.querySelector('.sa-notifications-brand small');
        if (eyebrow) eyebrow.textContent = next.eyebrow || 'ACTIVITY';
        const title = panelEl.querySelector('.sa-notifications-brand strong');
        if (title) title.textContent = next.title || 'Notifications';
        const copy = next.copy || {};
        panelEl.querySelector('.sa-notifications-read-all')?.setAttribute('title', copy.markAllRead || 'Mark all read');
        panelEl.querySelector('.sa-notifications-close')?.setAttribute('title', copy.hide || 'Hide');
        if (!isNotificationsAvailable()) controller?.hide();
        render();
        refreshSurfaceDock();
    });
    onActivityChanged(() => {
        render();
        refreshSurfaceDock();
    });
    eventSource.on(event_types.CHAT_CHANGED, () => {
        reconcile();
    });
    if (event_types.MESSAGE_SWIPED) eventSource.on(event_types.MESSAGE_SWIPED, render);
    render();
    reconcile();
    debug(`${LOG_PREFIX} source-linked notification center initialized`);
}

export function show(persist = true) {
    if (!controller) return;
    if (persist) persistVisible(true);
    if (inChat()) setSurfaceVisibility(PANEL_ID, true);
    if (!inChat() || !isNotificationsAvailable()) {
        controller.hide();
        refreshSurfaceDock();
        return;
    }
    controller.show();
    render();
    refreshSurfaceDock();
}

export function hide(persist = true) {
    if (persist) persistVisible(false);
    if (inChat()) setSurfaceVisibility(PANEL_ID, false);
    controller?.hide();
    refreshSurfaceDock();
}

export function isOpen() {
    return !!controller?.isOpen();
}

export function getUnread() {
    return getNotificationState().unread;
}
