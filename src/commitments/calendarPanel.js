/** Refined modern Calendar presentation over setting-neutral Commitments. */

import { eventSource, event_types, saveSettingsDebounced } from '../../../../../../script.js';
import { extension_settings } from '../../../../../extensions.js';
import { MODULE_NAME, debug } from '../../index.js';
import { makeDraggablePanel, mountDraggablePanel } from '../ui/draggablePanel.js';
import { isStoryChatOpen } from '../ui/chatPresence.js';
import { registerPanelControl } from '../ui/modal.js';
import { refreshSurfaceDock } from '../ui/surfaceDock.js';
import { resolveSurfaceVisibility, setSurfaceVisibility } from '../ui/surfaceVisibilityState.js';
import {
    getActivePresentationProfile,
    getActiveSurfacePresentation,
    onPresentationChanged,
} from '../presentation/presentationState.js';
import {
    createCommitment,
    getCommitment,
    getCommitmentState,
    markCommitmentRead,
    markVisibleCommitmentsAsRead,
    onCommitmentsChanged,
    removeCommitment,
    setCommitmentStatus,
    updateCommitment,
} from './commitments.js';
import {
    calendarFormMarkup,
    fillCalendarForm,
    readCalendarForm,
    reconcileCalendarTimeFields,
    resetCalendarForm,
} from './calendarForm.js';
import {
    calendarEmptyMarkup,
    escapeCalendarText,
    filterCommitments,
    renderCommitmentCard,
} from './calendarView.js';

const LOG_PREFIX = '[SuperAgents/calendarPanel]';
const CSS_HREF = '/scripts/extensions/third-party/SillyTavern-SuperAgents/src/commitments/calendarPanel.css?v=0.41.2-groups';
let panelEl = null;
let controller = null;
const PANEL_ID = 'calendar';
let activeFilter = 'upcoming';

const inChat = isStoryChatOpen;

function calendarSurface() {
    return getActiveSurfacePresentation('calendar') || {};
}

function isCalendarAvailable() {
    return calendarSurface().capabilities?.available !== false;
}

function applyCalendarChrome() {
    if (!panelEl) return;
    const surface = calendarSurface();
    const copy = surface.copy || {};
    const icon = panelEl.querySelector('.sa-calendar-monogram i');
    if (icon) icon.className = `fa-regular ${surface.panelIcon || 'fa-calendar'}`;
    const eyebrow = panelEl.querySelector('.sa-calendar-brand small');
    if (eyebrow) eyebrow.textContent = surface.eyebrow || 'COMMITMENTS';
    const name = panelEl.querySelector('.sa-calendar-surface-name');
    if (name) name.textContent = surface.title || surface.label || 'Calendar';
    panelEl.querySelector('.sa-calendar-add')?.setAttribute('title', copy.add || 'Add commitment');
    panelEl.querySelector('.sa-calendar-close')?.setAttribute('title', copy.hide || 'Hide');
    panelEl.querySelectorAll('[data-filter]').forEach(button => {
        button.textContent = surface.filters?.[button.dataset.filter] || button.dataset.filter;
    });
}

function persistedVisible() {
    return !!extension_settings[MODULE_NAME]?.calendarVisible;
}

function persistVisible(value) {
    const root = extension_settings[MODULE_NAME] ?? (extension_settings[MODULE_NAME] = {});
    root.calendarVisible = !!value;
    saveSettingsDebounced();
}

function injectStylesheet() {
    if (document.querySelector('link[data-sa-calendar]')) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = CSS_HREF;
    link.setAttribute('data-sa-calendar', '');
    document.head.appendChild(link);
}

function bindCards(list) {
    list.querySelectorAll('[data-commitment-id]').forEach(card => {
        const commitmentId = card.dataset.commitmentId;
        card.querySelector('[data-action="status"]')?.addEventListener('change', event => {
            setCommitmentStatus(commitmentId, event.currentTarget.value);
        });
        card.querySelector('[data-action="edit"]')?.addEventListener('click', () => {
            const item = getCommitment(commitmentId);
            const form = panelEl.querySelector('.sa-calendar-form');
            if (!item || !form) return;
            fillCalendarForm(form, item, calendarSurface());
            form.hidden = false;
            form.querySelector('[name="title"]')?.focus();
        });
        card.querySelector('[data-action="delete"]')?.addEventListener('click', () => {
            const item = getCommitment(commitmentId);
            if (item && confirm(`Delete “${item.title}” from this story branch?`)) removeCommitment(commitmentId);
        });
        card.addEventListener('click', event => {
            if (event.target.closest('button, select')) return;
            markCommitmentRead(commitmentId);
        });
    });
}

function render() {
    if (!panelEl || !controller?.isOpen()) return;
    const state = getCommitmentState();
    const profile = getActivePresentationProfile();
    const surface = calendarSurface();
    const list = panelEl.querySelector('.sa-calendar-list');
    const badge = panelEl.querySelector('.sa-calendar-badge');
    if (badge) {
        badge.textContent = state.unread > 99 ? '99+' : String(state.unread);
        badge.hidden = state.unread === 0;
    }
    applyCalendarChrome();
    panelEl.dataset.saPresentationProfile = profile.id;
    panelEl.setAttribute('aria-label', surface.label || 'Calendar');
    panelEl.querySelectorAll('[data-filter]').forEach(button => {
        const selected = button.dataset.filter === activeFilter;
        button.classList.toggle('is-active', selected);
        button.setAttribute('aria-pressed', String(selected));
    });
    if (!list) return;
    const items = filterCommitments(state.commitments, activeFilter);
    if (!items.length) {
        list.innerHTML = calendarEmptyMarkup(activeFilter, surface);
        list.querySelector('[data-action="empty-add"]')?.addEventListener('click', () => openComposer());
        return;
    }
    list.innerHTML = items.map(item => renderCommitmentCard(item, surface)).join('');
    bindCards(list);
}

function openComposer(commitment = null) {
    const form = panelEl?.querySelector('.sa-calendar-form');
    if (!form) return;
    if (commitment) fillCalendarForm(form, commitment, calendarSurface()); else resetCalendarForm(form, calendarSurface());
    form.hidden = false;
    form.querySelector('[name="title"]')?.focus();
}

function closeComposer() {
    const form = panelEl?.querySelector('.sa-calendar-form');
    if (!form) return;
    form.hidden = true;
    resetCalendarForm(form, calendarSurface());
}

function submitCommitment(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const record = readCalendarForm(form);
    const stored = record.id ? updateCommitment(record.id, record) : createCommitment(record);
    if (!stored) {
        const surface = calendarSurface();
        toastr.warning(`Give the ${surface.entryLabel || 'commitment'} a title first.`, surface.title || 'Calendar');
        return;
    }
    closeComposer();
    render();
}

function reconcile() {
    if (!controller) return;
    if (!inChat() || !isCalendarAvailable()) {
        controller.hide();
        refreshSurfaceDock();
        return;
    }
    if (resolveSurfaceVisibility(PANEL_ID, persistedVisible())) {
        controller.show();
        markVisibleCommitmentsAsRead();
        render();
    } else {
        controller.hide();
    }
    refreshSurfaceDock();
}

export function initCalendarPanel() {
    if (panelEl) return;
    injectStylesheet();
    panelEl = document.createElement('section');
    panelEl.id = 'sa-calendar-panel';
    panelEl.className = 'sa-calendar-panel';
    const surface = calendarSurface();
    panelEl.innerHTML = `
        <header class="sa-calendar-header" title="Drag to move">
            <div class="sa-calendar-brand">
                <span class="sa-calendar-monogram"><i class="fa-regular ${surface.panelIcon || 'fa-calendar'}"></i></span>
                <div><small>${escapeCalendarText(surface.eyebrow || 'COMMITMENTS')}</small><strong class="sa-calendar-surface-name">${escapeCalendarText(surface.title || 'Calendar')}</strong></div>
            </div>
            <span class="sa-calendar-badge" hidden>0</span>
            <button class="sa-calendar-add" data-no-drag type="button" title="${escapeCalendarText(surface.copy?.add || 'Add commitment')}"><i class="fa-solid fa-plus"></i></button>
            <button class="sa-calendar-close" data-no-drag type="button" title="Hide"><i class="fa-solid fa-xmark"></i></button>
        </header>
        <div class="sa-calendar-toolbar">
            <div class="sa-calendar-filters" role="group" aria-label="Calendar filter">
                <button data-no-drag data-filter="upcoming" type="button">${escapeCalendarText(surface.filters?.upcoming || 'Upcoming')}</button>
                <button data-no-drag data-filter="all" type="button">${escapeCalendarText(surface.filters?.all || 'All')}</button>
                <button data-no-drag data-filter="history" type="button">${escapeCalendarText(surface.filters?.history || 'History')}</button>
            </div>
        </div>
        ${calendarFormMarkup(surface)}
        <main class="sa-calendar-list"></main>`;
    mountDraggablePanel(panelEl);
    controller = makeDraggablePanel(panelEl, {
        id: 'calendar',
        handle: '.sa-calendar-header',
        defaultAnchor: 'top-right',
        snapToEdges: true,
        resizable: true,
        minW: 380,
        minH: 420,
    });
    panelEl.querySelector('.sa-calendar-close')?.addEventListener('click', () => hide(false));
    panelEl.querySelector('.sa-calendar-add')?.addEventListener('click', () => openComposer());
    panelEl.querySelector('.sa-calendar-form-cancel')?.addEventListener('click', closeComposer);
    panelEl.querySelector('.sa-calendar-form')?.addEventListener('submit', submitCommitment);
    panelEl.querySelector('[name="timeKind"]')?.addEventListener('change', event => {
        reconcileCalendarTimeFields(event.currentTarget.form);
    });
    panelEl.querySelector('[name="exactMode"]')?.addEventListener('change', event => {
        reconcileCalendarTimeFields(event.currentTarget.form);
    });
    panelEl.querySelectorAll('[data-filter]').forEach(button => {
        button.addEventListener('click', () => { activeFilter = button.dataset.filter; render(); });
    });
    registerPanelControl({
        id: 'calendar',
        getLabel: () => calendarSurface().settingsLabel || 'Calendar / Commitments',
        getIcon: () => calendarSurface().icon || 'fa-calendar-day',
        controller: {
            show: () => show(), hide, toggle: () => (isOpen() ? hide() : show()), isOpen,
            isDefaultVisible: persistedVisible,
            isAvailable: isCalendarAvailable,
            reconcile,
            resetPosition: () => controller?.resetPosition(),
        },
    });
    onPresentationChanged(() => {
        const form = panelEl?.querySelector('.sa-calendar-form');
        if (form?.hidden) {
            form.outerHTML = calendarFormMarkup(calendarSurface());
            const nextForm = panelEl.querySelector('.sa-calendar-form');
            nextForm?.querySelector('.sa-calendar-form-cancel')?.addEventListener('click', closeComposer);
            nextForm?.addEventListener('submit', submitCommitment);
            nextForm?.querySelector('[name="timeKind"]')?.addEventListener('change', event => reconcileCalendarTimeFields(event.currentTarget.form));
            nextForm?.querySelector('[name="exactMode"]')?.addEventListener('change', event => reconcileCalendarTimeFields(event.currentTarget.form));
        }
        if (!isCalendarAvailable()) controller?.hide();
        render();
        refreshSurfaceDock();
    });
    onCommitmentsChanged(() => { render(); refreshSurfaceDock(); });
    eventSource.on(event_types.CHAT_CHANGED, () => {
        reconcile();
    });
    if (event_types.MESSAGE_SWIPED) eventSource.on(event_types.MESSAGE_SWIPED, render);
    render();
    reconcile();
    debug(`${LOG_PREFIX} adapter-ready commitment calendar initialized`);
}

export function show(persist = true) {
    if (!controller) return;
    if (persist) persistVisible(true);
    if (inChat()) setSurfaceVisibility(PANEL_ID, true);
    if (!inChat() || !isCalendarAvailable()) {
        controller.hide();
        refreshSurfaceDock();
        return;
    }
    controller.show();
    markVisibleCommitmentsAsRead();
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
    return getCommitmentState().unread;
}

export function openCommitment(commitmentId, { persist = false } = {}) {
    const item = getCommitment(commitmentId);
    if (!item || !controller || !inChat() || !isCalendarAvailable()) return false;
    activeFilter = 'all';
    markCommitmentRead(item.id);
    show(persist);
    requestAnimationFrame(() => {
        const card = [...(panelEl?.querySelectorAll('[data-commitment-id]') || [])]
            .find(candidate => candidate.dataset.commitmentId === item.id);
        if (!card) return;
        card.classList.add('is-source-target');
        card.scrollIntoView({ behavior: 'smooth', block: 'center' });
        setTimeout(() => card.classList.remove('is-source-target'), 1800);
    });
    return true;
}
