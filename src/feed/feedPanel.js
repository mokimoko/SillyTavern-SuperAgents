/** Dark floating social Feed for branch-aware posts, comments, and reactions. */

import { eventSource, event_types, saveSettingsDebounced } from '../../../../../../script.js';
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
    addManualPost,
    addUserComment,
    clearFeed,
    getFeedConfig,
    getFeedState,
    isFeedEnabled,
    markFeedRead,
    onNewPost,
    toggleUserReaction,
} from './feedAgent.js';

const LOG_PREFIX = '[SuperAgents/feedPanel]';
const CSS_HREF = '/scripts/extensions/third-party/SillyTavern-SuperAgents/src/feed/feedPanel.css?v=0.41.2-groups';
let panelEl = null;
let controller = null;
const PANEL_ID = 'feed';

function injectStylesheet() {
    if (document.querySelector('link[data-sa-feed]')) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = CSS_HREF;
    link.setAttribute('data-sa-feed', '');
    document.head.appendChild(link);
}

const inChat = isStoryChatOpen;

function feedSurface() {
    return getActiveSurfacePresentation('feed') || {};
}

function feedCopy() {
    return feedSurface().copy || {};
}

function isFeedSurfaceAvailable() {
    return feedSurface().capabilities?.available !== false && isFeedEnabled();
}

// The Feed is "active" only when its agent is enabled — same rule the Phone uses
// (isPhoneEnabled). Being in a chat is necessary but not sufficient: with the
// Feed agent toggled off, the panel is neither available in the dock nor shown.
function isAvailable() {
    return inChat() && isFeedSurfaceAvailable();
}

function persistedVisible() {
    return !!extension_settings[MODULE_NAME]?.feedVisible;
}

function persistVisible(value) {
    const root = extension_settings[MODULE_NAME] ?? (extension_settings[MODULE_NAME] = {});
    root.feedVisible = !!value;
    saveSettingsDebounced();
}

function esc(value) {
    const div = document.createElement('div');
    div.textContent = String(value ?? '');
    return div.innerHTML;
}

function relativeTime(timestamp) {
    const seconds = Math.max(0, Math.floor((Date.now() - Number(timestamp || 0)) / 1000));
    if (seconds < 60) return 'now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
    return `${Math.floor(seconds / 86400)}d`;
}

function audienceLabel(audience) {
    const labels = feedSurface().audienceLabels || {};
    return labels[audience] || labels.shared || 'Shared circle';
}

function updateAppIdentity() {
    const surface = feedSurface();
    const configured = String(getFeedConfig()?.appName || '').trim().slice(0, 40);
    const appName = configured && configured !== 'Twatter' ? configured : (surface.title || configured || 'Twatter');
    const title = panelEl?.querySelector('.sa-feed-app-name');
    if (title) title.textContent = appName;
    panelEl?.setAttribute('aria-label', appName);
    if (panelEl) panelEl.dataset.saPresentationProfile = getActivePresentationProfile().id;
}

function applyFeedChrome() {
    if (!panelEl) return;
    const surface = feedSurface();
    const copy = surface.copy || {};
    const mark = panelEl.querySelector('.sa-feed-brandmark i');
    if (mark) mark.className = `fa-solid ${surface.panelIcon || 'fa-comments'}`;
    const composeToggle = panelEl.querySelector('.sa-feed-compose-toggle');
    if (composeToggle) {
        composeToggle.hidden = surface.capabilities?.directCompose === false;
        composeToggle.title = copy.compose || 'Write a post';
    }
    panelEl.querySelector('.sa-feed-clear')?.setAttribute('title', copy.clear || 'Clear this timeline');
    panelEl.querySelector('.sa-feed-close')?.setAttribute('title', copy.hide || 'Hide');
    panelEl.querySelector('.sa-feed-compose-text')?.setAttribute('placeholder', copy.composePlaceholder || 'What are you sharing?');
    const audience = panelEl.querySelector('.sa-feed-compose-audience');
    if (audience) {
        audience.hidden = surface.capabilities?.audiences === false;
        [...audience.options].forEach(option => { option.textContent = audienceLabel(option.value); });
    }
    const publish = panelEl.querySelector('.sa-feed-compose button');
    if (publish) publish.textContent = copy.publish || 'Publish';
}

function render() {
    if (!panelEl || !controller?.isOpen()) return;
    updateAppIdentity();
    const state = getFeedState();
    const stream = panelEl.querySelector('.sa-feed-stream');
    const badge = panelEl.querySelector('.sa-feed-badge');
    const surface = feedSurface();
    const copy = feedCopy();
    if (badge) {
        badge.textContent = String(state.unread || 0);
        badge.hidden = !state.unread;
    }
    if (!stream) return;

    if (!state.posts.length) {
        stream.innerHTML = `
            <div class="sa-feed-empty">
                <span class="sa-feed-empty-kicker">${esc(copy.emptyKicker || 'NO ACTIVITY YET')}</span>
                <i class="fa-regular fa-images"></i>
                <p>${esc(copy.emptyTitle || 'This branch is quiet.')}</p>
                <small>${esc(copy.emptyBody || 'New posts will show up here.')}</small>
            </div>`;
        return;
    }

    stream.innerHTML = [...state.posts].reverse().map(post => {
        const hearts = post.reactions.filter(reaction => reaction.kind === 'heart');
        const userHearted = hearts.some(reaction => reaction.source === 'user') || false;
        const bylineMeta = [
            audienceLabel(post.audience),
            surface.capabilities?.timestamps === false ? '' : relativeTime(post.timestamp),
        ].filter(Boolean).join(' · ');
        const comments = surface.capabilities?.comments === false ? '' : post.comments.map(comment => `
            <div class="sa-feed-comment">
                <strong>${esc(comment.author)}</strong><span>${esc(comment.content)}</span>
            </div>`).join('');
        return `
            <article class="sa-feed-post" data-post-id="${esc(post.id)}">
                <header>
                    <div class="sa-feed-avatar">${esc(post.author.slice(0, 1).toUpperCase())}</div>
                    <div class="sa-feed-byline">
                        <strong>${esc(post.author)}</strong>
                        <span>${bylineMeta}</span>
                    </div>
                </header>
                <div class="sa-feed-copy">${esc(post.content)}</div>
                <div class="sa-feed-meta">
                    ${surface.capabilities?.reactions === false ? '' : `<button class="sa-feed-react ${userHearted ? 'is-active' : ''}" data-no-drag title="${esc(copy.react || 'React')}">
                        <i class="${userHearted ? 'fa-solid' : 'fa-regular'} fa-heart"></i>
                        <span>${hearts.length || ''}</span>
                    </button>`}
                    ${surface.capabilities?.comments === false ? '' : `<button class="sa-feed-comment-toggle" data-no-drag title="${esc(copy.comment || 'Comment')}">
                        <i class="fa-regular fa-message"></i><span>${post.comments.length || ''}</span>
                    </button>`}
                </div>
                ${comments ? `<div class="sa-feed-comments">${comments}</div>` : ''}
                ${surface.capabilities?.comments === false ? '' : `<form class="sa-feed-comment-form" hidden>
                    <input data-no-drag maxlength="500" placeholder="${esc(copy.commentPlaceholder || 'Leave a comment…')}" />
                    <button data-no-drag title="${esc(copy.postComment || 'Post comment')}"><i class="fa-solid fa-arrow-up"></i></button>
                </form>`}
            </article>`;
    }).join('');

    stream.querySelectorAll('.sa-feed-react').forEach(button => {
        button.addEventListener('click', () => {
            toggleUserReaction(button.closest('[data-post-id]')?.dataset.postId, 'heart');
            render();
        });
    });
    stream.querySelectorAll('.sa-feed-comment-toggle').forEach(button => {
        button.addEventListener('click', () => {
            const form = button.closest('[data-post-id]')?.querySelector('.sa-feed-comment-form');
            if (!form) return;
            form.hidden = !form.hidden;
            if (!form.hidden) form.querySelector('input')?.focus();
        });
    });
    stream.querySelectorAll('.sa-feed-comment-form').forEach(form => {
        form.addEventListener('submit', event => {
            event.preventDefault();
            const input = form.querySelector('input');
            const postId = form.closest('[data-post-id]')?.dataset.postId;
            if (addUserComment(postId, input?.value)) render();
        });
    });
}

function reconcile() {
    if (!controller) return;
    if (!isAvailable()) {
        controller.hide();
        refreshSurfaceDock();
        return;
    }
    if (resolveSurfaceVisibility(PANEL_ID, persistedVisible())) {
        controller.show();
        markFeedRead();
        render();
    } else {
        controller.hide();
    }
    refreshSurfaceDock();
}

function submitPost(event) {
    event.preventDefault();
    const input = panelEl.querySelector('.sa-feed-compose-text');
    const audience = panelEl.querySelector('.sa-feed-compose-audience');
    if (!addManualPost({ content: input?.value, audience: audience?.value })) return;
    if (input) input.value = '';
    panelEl.querySelector('.sa-feed-compose')?.setAttribute('hidden', '');
    render();
}

export function initFeedPanel() {
    if (panelEl) return;
    injectStylesheet();
    panelEl = document.createElement('section');
    panelEl.id = 'sa-feed-panel';
    panelEl.className = 'sa-feed-panel';
    const surface = feedSurface();
    const copy = feedCopy();
    panelEl.dataset.saPresentationProfile = getActivePresentationProfile().id;
    panelEl.innerHTML = `
        <header class="sa-feed-header" title="Drag to move">
            <div class="sa-feed-brand">
                <span class="sa-feed-brandmark"><i class="fa-solid ${surface.panelIcon || 'fa-comments'}"></i></span>
                <div class="sa-feed-masthead">
                    <strong class="sa-feed-app-name">${esc(surface.title || 'Twatter')}</strong>
                </div>
            </div>
            <span class="sa-feed-badge" hidden>0</span>
            <button class="sa-feed-compose-toggle" data-no-drag title="${esc(copy.compose || 'Write a post')}" ${surface.capabilities?.directCompose === false ? 'hidden' : ''}><i class="fa-solid fa-pen-nib"></i></button>
            <button class="sa-feed-clear" data-no-drag title="${esc(copy.clear || 'Clear this timeline')}"><i class="fa-regular fa-trash-can"></i></button>
            <button class="sa-feed-close" data-no-drag title="${esc(copy.hide || 'Hide')}"><i class="fa-solid fa-xmark"></i></button>
        </header>
        <form class="sa-feed-compose" hidden>
            <textarea class="sa-feed-compose-text" data-no-drag maxlength="2000" placeholder="${esc(copy.composePlaceholder || 'What are you sharing?')}"></textarea>
            <div>
                <select class="sa-feed-compose-audience" data-no-drag>
                    <option value="shared">${esc(surface.audienceLabels?.shared || 'Shared circle')}</option>
                    <option value="public">${esc(surface.audienceLabels?.public || 'Everyone')}</option>
                    <option value="selected">${esc(surface.audienceLabels?.selected || 'Selected circle')}</option>
                </select>
                <button data-no-drag>${esc(copy.publish || 'Publish')}</button>
            </div>
        </form>
        <main class="sa-feed-stream"></main>`;
    mountDraggablePanel(panelEl);

    controller = makeDraggablePanel(panelEl, {
        id: 'feed',
        handle: '.sa-feed-header',
        defaultAnchor: 'top-right',
        snapToEdges: true,
        resizable: true,
        minW: 340,
        minH: 360,
    });
    // Closing remembers this chat's choice; its Settings default remains intact.
    panelEl.querySelector('.sa-feed-close')?.addEventListener('click', () => hide(false));
    panelEl.querySelector('.sa-feed-compose-toggle')?.addEventListener('click', () => {
        const compose = panelEl.querySelector('.sa-feed-compose');
        compose.hidden = !compose.hidden;
        if (!compose.hidden) panelEl.querySelector('.sa-feed-compose-text')?.focus();
    });
    panelEl.querySelector('.sa-feed-compose')?.addEventListener('submit', submitPost);
    panelEl.querySelector('.sa-feed-clear')?.addEventListener('click', () => {
        if (confirm(feedCopy().clearConfirm || 'Clear visible Feed posts on this story branch?')) clearFeed();
    });

    registerPanelControl({
        id: 'feed',
        getLabel: () => feedSurface().settingsLabel || 'Feed',
        getIcon: () => feedSurface().panelIcon || 'fa-newspaper',
        controller: {
            show: () => show(), hide, toggle: () => (isOpen() ? hide() : show()), isOpen,
            isDefaultVisible: persistedVisible,
            isAvailable: isFeedSurfaceAvailable,
            reconcile,
            resetPosition: () => controller?.resetPosition(),
        },
    });
    onPresentationChanged(() => {
        if (!panelEl) return;
        panelEl.dataset.saPresentationProfile = getActivePresentationProfile().id;
        applyFeedChrome();
        if (!isFeedSurfaceAvailable()) controller?.hide();
        render();
        refreshSurfaceDock();
    });

    onNewPost(() => {
        if (isOpen()) markFeedRead();
        render();
        refreshSurfaceDock();
    });
    eventSource.on(event_types.CHAT_CHANGED, () => {
        reconcile();
    });
    if (event_types.MESSAGE_SWIPED) eventSource.on(event_types.MESSAGE_SWIPED, render);
    render();
    reconcile();
    debug(`${LOG_PREFIX} dark resizable feed panel initialized`);
}

export function show(persist = true) {
    if (!controller) return;
    if (persist) persistVisible(true);
    if (inChat()) setSurfaceVisibility(PANEL_ID, true);
    if (!isAvailable()) {
        controller.hide();
        refreshSurfaceDock();
        return;
    }
    controller.show();
    markFeedRead();
    render();
    refreshSurfaceDock();
}

/** Open the Feed and bring one source post into view when it still exists. */
export function openPost(postId, { persist = false } = {}) {
    const id = String(postId || '').trim();
    if (!id || !controller || !isAvailable()) return false;
    show(persist);
    requestAnimationFrame(() => {
        const post = [...(panelEl?.querySelectorAll('[data-post-id]') || [])]
            .find(candidate => candidate.dataset.postId === id);
        if (!post) return;
        post.classList.add('is-source-target');
        post.scrollIntoView({ behavior: 'smooth', block: 'center' });
        setTimeout(() => post.classList.remove('is-source-target'), 1800);
    });
    return true;
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

export function toggleTemporary() {
    if (isOpen()) hide(false); else show(false);
}
