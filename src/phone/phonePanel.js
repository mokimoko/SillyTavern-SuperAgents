/**
 * phone/phonePanel.js — diegetic phone / messenger floating panel.
 *
 * The UI half of the phone module. Renders a phone-style panel with a
 * conversation list, per-character thread view, message bubbles, an input
 * bar, a typing indicator, and staggered reveal of multi-text replies. It
 * also surfaces an unread badge on its own header.
 *
 * Ported from VerseManager's phonePanel.js. The structural change matches the
 * State Card port: VM docked this to the left screen edge with a bespoke
 * floating toggle button; here it's a free-floating draggable panel built on
 * ui/draggablePanel.js and surfaced through the modal's Settings tab via
 * registerPanelControl. No edge docking: a compact top-left launcher handles
 * per-chat show/hide, while the Settings control owns the default for new chats.
 * Unread state appears both in the panel header and on the closed launcher.
 *
 * Styles live in phone/phonePanel.css, injected as a runtime <link> (the same
 * convention ui/stateCard.css uses) so the phone's CSS travels with the module
 * rather than bloating the root stylesheet. CSS_HREF is hardcoded for the same
 * TDZ reason documented in stateCard.js.
 *
 * Namespace: VM's vm-phone-* → sa-phone-*.
 */

import { eventSource, event_types } from '../../../../../../script.js';
import { getContext } from '../../../../../extensions.js';
import { extension_settings } from '../../../../../extensions.js';
import { saveSettingsDebounced } from '../../../../../../script.js';
import { MODULE_NAME, debug } from '../core/runtime.js';
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
    isPhoneEnabled,
    getPhoneAgent,
    getPhoneConfig,
    getAllThreads,
    getThread,
    markThreadRead,
    getTotalUnread,
    addUserText,
    generateAndStoreReply,
    clearThread,
    onNewText,
    isPhoneBusy,
} from './phoneAgent.js';

const LOG_PREFIX = '[SuperAgents/phonePanel]';
const PANEL_ID = 'phone';
const CSS_HREF = '/scripts/extensions/third-party/SillyTavern-SuperAgents/src/phone/phonePanel.css?v=0.41.2-groups';

// ============================================================================
// STATE
// ============================================================================

/** @type {HTMLElement|null} */ let panelEl = null;
/** @type {ReturnType<typeof makeDraggablePanel>|null} */ let controller = null;

let activeThread = null;     // charKey being viewed, or null = list/contacts
let currentView = 'conversations';
let isTyping = false;
let isSendInProgress = false; // guards onNewText from double-rendering mid-send

// ============================================================================
// VISIBILITY PERSISTENCE (draggablePanel owns position separately)
// ============================================================================

function isVisiblePersisted() {
    return !!extension_settings[MODULE_NAME]?.phoneVisible;
}
function persistVisible(v) {
    const root = extension_settings[MODULE_NAME] ?? (extension_settings[MODULE_NAME] = {});
    root.phoneVisible = !!v;
    saveSettingsDebounced();
}

/**
 * True when SillyTavern is actually inside a chat (character or group), false
 * on the Landing Page / empty state. Mirrors stateCard.js's isInChat so the
 * Phone follows the same "persist visibility, but only surface inside a chat"
 * rule. The shared presence helper supports legacy globals and newer context.
 */
const isInChat = isStoryChatOpen;

function phoneSurface() {
    return getActiveSurfacePresentation('phone') || {};
}

function phoneCopy() {
    return phoneSurface().copy || {};
}

function isPhoneSurfaceAvailable() {
    return phoneSurface().capabilities?.available !== false && isPhoneEnabled();
}

function applyPhoneChrome() {
    if (!panelEl) return;
    const surface = phoneSurface();
    const copy = surface.copy || {};
    const title = panelEl.querySelector('.sa-phone-title');
    if (title) title.textContent = surface.title || 'Messages';
    panelEl.querySelector('.sa-phone-back')?.setAttribute('title', copy.back || 'Back');
    panelEl.querySelector('.sa-phone-compose')?.setAttribute('title', copy.newMessageAction || 'New message');
    panelEl.querySelector('.sa-phone-clear')?.setAttribute('title', copy.clear || 'Clear messages');
    panelEl.querySelector('.sa-phone-close')?.setAttribute('title', copy.hide || 'Hide');
    panelEl.querySelector('.sa-phone-input')?.setAttribute('placeholder', copy.inputPlaceholder || 'Message…');
    panelEl.querySelector('.sa-phone-send')?.setAttribute('title', copy.send || 'Send');
}

/**
 * Bring the phone's visibility in line with chat presence and user intent.
 * The current chat's last launcher/close choice wins over the persistent
 * Settings default. Landing-page hiding does not change either value.
 */
function reconcileVisibility() {
    if (!controller) return;
    if (!isPhoneSurfaceAvailable() || !isInChat()) {
        // Hide without persisting — preserve the "I want this open" intent.
        controller.hide();
        refreshSurfaceDock();
        return;
    }
    if (resolveSurfaceVisibility(PANEL_ID, isVisiblePersisted())) {
        controller.show();
        openView();
    } else {
        controller.hide();
    }
    refreshSurfaceDock();
}

// ============================================================================
// CSS INJECTION
// ============================================================================

function injectStylesheet() {
    if (document.querySelector('link[data-sa-phone]')) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = CSS_HREF;
    link.setAttribute('data-sa-phone', '');
    document.head.appendChild(link);
}

// ============================================================================
// INIT
// ============================================================================

/**
 * Build the phone panel DOM, make it draggable, register its Settings control,
 * and wire text + chat listeners. Called once from index.js during init.
 */
export function initPhonePanel() {
    if (panelEl) return;

    injectStylesheet();

    panelEl = document.createElement('div');
    panelEl.id = 'sa-phone-panel';
    panelEl.className = 'sa-phone-panel';
    const surface = phoneSurface();
    const copy = phoneCopy();
    panelEl.dataset.saPresentationProfile = getActivePresentationProfile().id;
    panelEl.innerHTML = `
        <div class="sa-phone-header" title="Drag to move">
            <i class="fa-solid fa-grip-lines sa-phone-grip"></i>
            <button class="sa-phone-back" data-no-drag title="${copy.back || 'Back'}" style="display:none">
                <i class="fa-solid fa-chevron-left"></i>
            </button>
            <span class="sa-phone-title">${surface.title || 'Messages'}</span>
            <span class="sa-phone-badge" style="display:none">0</span>
            <button class="sa-phone-compose" data-no-drag title="${copy.newMessageAction || 'New message'}" style="display:none">
                <i class="fa-solid fa-pen-to-square"></i>
            </button>
            <button class="sa-phone-clear" data-no-drag title="${copy.clear || 'Clear messages'}" style="display:none">
                <i class="fa-solid fa-trash-can"></i>
            </button>
            <button class="sa-phone-close" data-no-drag title="${copy.hide || 'Hide'}">
                <i class="fa-solid fa-xmark"></i>
            </button>
        </div>
        <div class="sa-phone-body"></div>
        <div class="sa-phone-input-bar" style="display:none">
            <input type="text" class="sa-phone-input" data-no-drag placeholder="${copy.inputPlaceholder || 'Message...'}" maxlength="500" />
            <button class="sa-phone-send" data-no-drag title="${copy.send || 'Send'}">
                <i class="fa-solid fa-paper-plane"></i>
            </button>
        </div>
    `;
    mountDraggablePanel(panelEl);

    // Floating-panel behaviour: drag by the header, snap to L/R edges, anchor
    // bottom-right by default. The input + buttons opt out of drag via
    // [data-no-drag] so typing/clicking inside still works.
    controller = makeDraggablePanel(panelEl, {
        id: PANEL_ID,
        handle: '.sa-phone-header',
        defaultAnchor: 'bottom-right',
        snapToEdges: true,
        resizable: true,
        minW: 300,
        minH: 420,
    });

    // Closing remembers this chat's choice; its Settings default remains intact.
    panelEl.querySelector('.sa-phone-close')?.addEventListener('click', () => hide(false));
    panelEl.querySelector('.sa-phone-back')?.addEventListener('click', handleBack);
    panelEl.querySelector('.sa-phone-clear')?.addEventListener('click', handleClear);
    panelEl.querySelector('.sa-phone-compose')?.addEventListener('click', showContactsList);

    // Input + send.
    const input = panelEl.querySelector('.sa-phone-input');
    const sendBtn = panelEl.querySelector('.sa-phone-send');
    sendBtn?.addEventListener('click', () => handleSend(input));
    input?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSend(input);
        }
    });

    // Register with the modal's Settings tab (show/hide + reset-position).
    registerPanelControl({
        id: PANEL_ID,
        getLabel: () => phoneSurface().settingsLabel || 'Phone',
        getIcon: () => phoneSurface().panelIcon || 'fa-mobile-screen-button',
        controller: {
            show:          () => show(),
            hide:          () => hide(),
            toggle:        () => (isOpen() ? hide() : show()),
            isOpen,
            isDefaultVisible: isVisiblePersisted,
            // Available only when a phone agent exists and is enabled.
            isAvailable:   isPhoneSurfaceAvailable,
            // Re-sync visibility when agents change (enable/disable/delete).
            reconcile:     () => reconcileVisibility(),
            resetPosition: () => controller?.resetPosition(),
        },
    });
    onPresentationChanged(() => {
        if (!panelEl) return;
        panelEl.dataset.saPresentationProfile = getActivePresentationProfile().id;
        applyPhoneChrome();
        if (!isPhoneSurfaceAvailable()) controller?.hide();
        if (currentView === 'contacts') showContactsList();
        else if (currentView === 'thread' && activeThread) showThread(activeThread);
        else showConversationList();
        refreshSurfaceDock();
    });

    // New texts from phoneAgent (evaluation + reply paths) → badge + reveal.
    onNewText(async (charKey, texts) => {
        debug(`${LOG_PREFIX} new text(s) from ${charKey}: ${texts.length}`);
        updateBadge();
        if (isSendInProgress) return; // send flow renders its own

        if (isOpen() && activeThread === charKey) {
            const body = bodyEl();
            if (body) {
                if (texts.length > 1) {
                    await animateIncomingTexts(charKey, texts.length, body);
                } else {
                    isTyping = false;
                    renderMessages(charKey, body);
                    body.scrollTop = body.scrollHeight;
                }
            }
            markThreadRead(charKey);
            updateBadge();
        }
    });

    // Chat change: the previous thread view is stale, and we may have moved
    // between Landing and a chat. Drop the active-thread pointer, then reconcile
    // visibility against the new chat state — this restores the phone if the
    // user had it open and we're (still) in a chat, or hides it (without
    // clearing intent) on Landing. Runs on first load too, so a persisted-open
    // phone survives a refresh straight into a chat.
    eventSource.on(event_types.CHAT_CHANGED, () => {
        updateBadge();
        activeThread = null;
        reconcileVisibility();
    });
    if (event_types.MESSAGE_SWIPED) {
        eventSource.on(event_types.MESSAGE_SWIPED, () => {
            updateBadge();
            if (isOpen()) openView();
        });
    }
    if (event_types.MESSAGE_DELETED) {
        eventSource.on(event_types.MESSAGE_DELETED, () => {
            updateBadge();
            if (isOpen()) openView();
        });
    }

    updateBadge();

    // Initial reconciliation applies the chat state or persistent default. On
    // Landing it stays hidden until a chat opens. The
    // CHAT_CHANGED handler above also fires once on load, but calling this here
    // covers the case where the chat is already present at init time.
    reconcileVisibility();

    debug(`${LOG_PREFIX} phone panel initialized`);
}

// ============================================================================
// SHOW / HIDE
// ============================================================================

export function show(persist = true) {
    if (!controller) return;
    if (persist) persistVisible(true);
    if (isInChat()) setSurfaceVisibility(PANEL_ID, true);
    if (!isInChat() || !isPhoneSurfaceAvailable()) {
        controller.hide();
        refreshSurfaceDock();
        return;
    }
    controller.show();
    openView();
    refreshSurfaceDock();
}

/** Open one Phone thread without making Phone a dependency of the caller. */
export function openThread(charKey, { persist = false } = {}) {
    const character = String(charKey || '').trim();
    if (!controller || !character || !isInChat() || !isPhoneSurfaceAvailable()) return false;
    if (persist) persistVisible(true);
    setSurfaceVisibility(PANEL_ID, true);
    controller.show();
    showThread(character);
    refreshSurfaceDock();
    return true;
}

export function hide(persist = true) {
    if (!controller) return;
    if (persist) persistVisible(false);
    if (isInChat()) setSurfaceVisibility(PANEL_ID, false);
    controller.hide();
    activeThread = null;
    refreshSurfaceDock();
}

export function isOpen() {
    return !!controller?.isOpen();
}

export function toggleTemporary() {
    if (isOpen()) hide(false); else show(false);
}

function bodyEl() {
    return panelEl?.querySelector('.sa-phone-body') || null;
}

// ============================================================================
// VIEW ROUTING  (decide list vs contacts vs single thread)
// ============================================================================

/**
 * Choose what to show when the panel opens, mirroring VM's openPanel logic:
 * multiple threads (or a group chat) → conversation list; a single solo
 * thread → open it directly; nothing yet → contacts (group) or the current
 * character's empty thread (solo).
 * @param {string|null} [charKey] open a specific thread directly
 */
function openView(charKey = null) {
    if (charKey) { showThread(charKey); return; }

    const threads = getAllThreads();
    const keys = Object.keys(threads);
    const ctx = getContext();
    const isGroup = !!ctx.groupId;

    if (keys.length > 1 || (keys.length === 1 && isGroup)) {
        showConversationList();
    } else if (keys.length === 1 && !isGroup) {
        showThread(keys[0]);
    } else if (isGroup) {
        showContactsList();
    } else {
        const charObj = ctx?.characters?.[ctx?.characterId];
        const currentChar = charObj?.name ?? charObj?.data?.name;
        if (currentChar) showThread(currentChar); else showContactsList();
    }
}

// ============================================================================
// HEADER CHROME HELPERS
// ============================================================================

function headerEls() {
    return {
        back:    panelEl.querySelector('.sa-phone-back'),
        clear:   panelEl.querySelector('.sa-phone-clear'),
        compose: panelEl.querySelector('.sa-phone-compose'),
        title:   panelEl.querySelector('.sa-phone-title'),
        inputBar: panelEl.querySelector('.sa-phone-input-bar'),
    };
}

// ============================================================================
// CONTACTS / GROUP SUPPORT
// ============================================================================

/**
 * Characters available to text: group members in a group chat, else the
 * current solo character.
 * @returns {string[]}
 */
function getAvailableContacts() {
    const ctx = getContext();
    const contacts = [];

    if (ctx.groupId) {
        const group = ctx.groups?.find(g => g.id === ctx.groupId);
        if (group?.members) {
            for (const avatar of group.members) {
                const char = ctx.characters?.find(c => c.avatar === avatar);
                const name = char?.name ?? char?.data?.name;
                if (name) contacts.push(name);
            }
        }
        return contacts;
    }

    const charObj = ctx.characters?.[ctx.characterId];
    const name = charObj?.name ?? charObj?.data?.name;
    if (name) contacts.push(name);
    return contacts;
}

/** Show the contacts list (start a new conversation). */
function showContactsList() {
    currentView = 'contacts';
    activeThread = null;
    const body = bodyEl();
    if (!body) return;
    const { back, clear, compose, title, inputBar } = headerEls();

    const threads = getAllThreads();
    if (back) back.style.display = Object.keys(threads).length > 0 ? '' : 'none';
    if (inputBar) inputBar.style.display = 'none';
    if (clear) clear.style.display = 'none';
    if (compose) compose.style.display = 'none';
    const copy = phoneCopy();
    if (title) title.textContent = copy.newMessage || 'New Message';

    const contacts = getAvailableContacts();
    if (contacts.length === 0) {
        body.innerHTML = `<div class="sa-phone-empty"><i class="fa-solid fa-user-slash"></i><p>${escHtml(copy.noContacts || 'No characters available')}</p></div>`;
        return;
    }

    const existing = new Set(Object.keys(threads));
    body.innerHTML = contacts.map(name => `
        <div class="sa-phone-contact-item" data-char="${escAttr(name)}">
            <div class="sa-phone-contact-avatar"><i class="fa-solid fa-user"></i></div>
            <div class="sa-phone-contact-name">${escHtml(name)}</div>
            ${existing.has(name) ? `<div class="sa-phone-contact-badge">${escHtml(copy.activeContact || 'active')}</div>` : ''}
        </div>
    `).join('');

    body.querySelectorAll('.sa-phone-contact-item').forEach(el => {
        el.addEventListener('click', () => showThread(el.dataset.char));
    });
}

/** Back → conversation list if any threads exist, else contacts. */
function handleBack() {
    const threads = getAllThreads();
    if (Object.keys(threads).length > 0) showConversationList(); else showContactsList();
}

// ============================================================================
// CONVERSATION LIST
// ============================================================================

function showConversationList() {
    currentView = 'conversations';
    activeThread = null;
    const body = bodyEl();
    if (!body) return;
    const { back, clear, compose, title, inputBar } = headerEls();

    if (back) back.style.display = 'none';
    if (inputBar) inputBar.style.display = 'none';
    if (clear) clear.style.display = 'none';
    const surface = phoneSurface();
    const copy = phoneCopy();
    if (title) title.textContent = surface.title || 'Messages';

    const contacts = getAvailableContacts();
    const threads = getAllThreads();
    const keys = Object.keys(threads).sort((a, b) =>
        (threads[b].lastActivity ?? 0) - (threads[a].lastActivity ?? 0));
    if (compose) compose.style.display = contacts.length > keys.length ? '' : 'none';

    if (keys.length === 0) {
        body.innerHTML = `<div class="sa-phone-empty"><i class="fa-solid fa-comment-slash"></i><p>${escHtml(copy.noMessages || 'No messages yet')}</p></div>`;
        return;
    }

    body.innerHTML = keys.map(charKey => {
        const thread = threads[charKey];
        const lastMsg = thread.messages[thread.messages.length - 1];
        const preview = lastMsg ? `${lastMsg.name}: ${lastMsg.content}`.slice(0, 50) : (copy.noPreview || 'No messages');
        const time = lastMsg ? formatTime(lastMsg.timestamp) : '';
        const unreadClass = thread.unread > 0 ? 'sa-phone-conv-unread' : '';
        const dot = thread.unread > 0 ? '<span class="sa-phone-conv-dot"></span>' : '';
        return `
            <div class="sa-phone-conv-item ${unreadClass}" data-char="${escAttr(charKey)}">
                ${dot}
                <div class="sa-phone-conv-name">${escHtml(charKey)}</div>
                <div class="sa-phone-conv-preview">${escHtml(preview)}</div>
                <div class="sa-phone-conv-time">${time}</div>
            </div>
        `;
    }).join('');

    body.querySelectorAll('.sa-phone-conv-item').forEach(el => {
        el.addEventListener('click', () => showThread(el.dataset.char));
    });
}

// ============================================================================
// THREAD VIEW
// ============================================================================

function showThread(charKey) {
    currentView = 'thread';
    activeThread = charKey;
    const body = bodyEl();
    if (!body) return;
    const { back, clear, compose, title, inputBar } = headerEls();

    const ctx = getContext();
    const threads = getAllThreads();
    const isGroup = !!ctx.groupId;
    // Group: always show back. Solo: show back only with multiple threads.
    if (back) back.style.display = (isGroup || Object.keys(threads).length > 1) ? '' : 'none';
    if (inputBar) inputBar.style.display = phoneSurface().capabilities?.directCompose === false ? 'none' : '';
    if (clear) clear.style.display = '';
    if (compose) compose.style.display = 'none';
    if (title) title.textContent = charKey;

    markThreadRead(charKey);
    updateBadge();

    renderMessages(charKey, body);
    requestAnimationFrame(() => { body.scrollTop = body.scrollHeight; });

    panelEl.querySelector('.sa-phone-input')?.focus();
}

/**
 * Render a thread's bubbles into the body. hideLastN hides the last N stored
 * messages — used by the staggered-reveal animation.
 * @param {string} charKey
 * @param {HTMLElement} container
 * @param {number} [hideLastN=0]
 */
function renderMessages(charKey, container, hideLastN = 0) {
    const thread = getThread(charKey);
    const all = thread?.messages ?? [];
    const messages = hideLastN > 0 ? all.slice(0, -hideLastN) : all;

    if (messages.length === 0) {
        container.innerHTML = `<div class="sa-phone-empty"><p>${escHtml(String(phoneCopy().startConversation || 'Start a conversation with {name}').replace('{name}', charKey))}</p></div>`;
        return;
    }

    let html = messages.map((msg, i) => {
        const isUser = msg.from === 'user';
        const bubbleClass = isUser ? 'sa-phone-bubble-user' : 'sa-phone-bubble-char';
        const time = formatTime(msg.timestamp);
        const prev = messages[i - 1];
        const showName = !isUser && (!prev || prev.from !== msg.from);
        return `
            <div class="sa-phone-msg ${bubbleClass}">
                ${showName ? `<div class="sa-phone-msg-name">${escHtml(msg.name)}</div>` : ''}
                <div class="sa-phone-bubble">${escHtml(msg.content)}</div>
                <div class="sa-phone-msg-time">${time}</div>
            </div>
        `;
    }).join('');

    if (isTyping && phoneSurface().capabilities?.typingIndicator !== false) {
        html += `<div class="sa-phone-msg sa-phone-bubble-char">
            <div class="sa-phone-bubble sa-phone-typing"><span></span><span></span><span></span></div>
        </div>`;
    }

    container.innerHTML = html;
}

// ============================================================================
// CLEAR / SEND
// ============================================================================

function handleClear() {
    if (!activeThread) return;
    clearThread(activeThread);
    const body = bodyEl();
    if (body) renderMessages(activeThread, body);
    updateBadge();
    toastr.info(phoneCopy().cleared || 'Messages cleared.', phoneSurface().title || 'Phone', { timeOut: 2000 });
}

async function handleSend(inputEl) {
    const text = inputEl.value.trim();
    if (!text || !activeThread || isPhoneBusy()) return;
    if (getPhoneAgent()?.paused) {
        toastr.info('The Phone agent is paused. Its state is frozen.');
        return;
    }

    inputEl.value = '';
    inputEl.disabled = true;
    const body = bodyEl();
    const sendBtn = panelEl?.querySelector('.sa-phone-send');
    if (sendBtn) sendBtn.disabled = true;

    // 1. Show the user's message immediately.
    addUserText(activeThread, text);
    if (body) { renderMessages(activeThread, body); body.scrollTop = body.scrollHeight; }

    // 2. Typing indicator.
    isTyping = true;
    if (body) { renderMessages(activeThread, body); body.scrollTop = body.scrollHeight; }

    // 3. Generate + reveal the reply.
    isSendInProgress = true;
    try {
        const replies = await generateAndStoreReply(activeThread, text);
        isTyping = false;
        if (replies.length > 1 && body) {
            await animateIncomingTexts(activeThread, replies.length, body);
        } else if (body) {
            renderMessages(activeThread, body);
            body.scrollTop = body.scrollHeight;
        }
    } catch (err) {
        console.error(`${LOG_PREFIX} send failed:`, err);
    } finally {
        isSendInProgress = false;
        isTyping = false;
        if (body && activeThread) { renderMessages(activeThread, body); body.scrollTop = body.scrollHeight; }
        inputEl.disabled = false;
        if (sendBtn) sendBtn.disabled = false;
        inputEl.focus();
    }
}

// ============================================================================
// STAGGERED REVEAL
// ============================================================================

/**
 * Reveal multiple already-stored incoming texts one at a time with a typing
 * indicator between each, so the phone feels like a real messaging app. Works
 * by hiding the last N messages and decrementing N after each delay.
 * @param {string} charKey
 * @param {number} count
 * @param {HTMLElement} container
 */
async function animateIncomingTexts(charKey, count, container) {
    if (phoneSurface().capabilities?.typingIndicator === false) {
        isTyping = false;
        renderMessages(charKey, container, 0);
        container.scrollTop = container.scrollHeight;
        return;
    }
    const delayRange = getPhoneConfig()?.typingDelay ?? { min: 800, max: 2500 };

    for (let remaining = count; remaining > 0; remaining--) {
        isTyping = true;
        renderMessages(charKey, container, remaining);
        container.scrollTop = container.scrollHeight;

        const delay = delayRange.min + Math.random() * (delayRange.max - delayRange.min);
        await new Promise(r => setTimeout(r, delay));

        if (activeThread !== charKey) return; // user navigated away
    }

    isTyping = false;
    renderMessages(charKey, container, 0);
    container.scrollTop = container.scrollHeight;
}

// ============================================================================
// BADGE
// ============================================================================

function updateBadge() {
    const badge = panelEl?.querySelector('.sa-phone-badge');
    if (!badge) return;
    const total = getTotalUnread();
    if (total > 0) {
        badge.textContent = total > 99 ? '99+' : String(total);
        badge.style.display = '';
    } else {
        badge.style.display = 'none';
    }
    refreshSurfaceDock();
}

// ============================================================================
// HELPERS
// ============================================================================

function formatTime(timestamp) {
    if (phoneSurface().capabilities?.timestamps === false) return '';
    if (!timestamp) return '';
    const d = new Date(timestamp);
    const hours = d.getHours();
    const mins = String(d.getMinutes()).padStart(2, '0');
    const ampm = hours >= 12 ? 'PM' : 'AM';
    const h = hours % 12 || 12;
    return `${h}:${mins} ${ampm}`;
}

function escHtml(str) {
    const div = document.createElement('div');
    div.textContent = str ?? '';
    return div.innerHTML;
}

function escAttr(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;');
}

// ============================================================================
// CLEANUP
// ============================================================================

export function destroyPhonePanel() {
    controller?.destroy();
    controller = null;
    panelEl = null;
    activeThread = null;
}
