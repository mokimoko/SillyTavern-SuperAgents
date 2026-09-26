/**
 * render/renderer.js — displays styled agent output from message.extra.saAgentData.
 *
 * A MutationObserver watches the chat DOM. When a message has saAgentData
 * (written by sidecar.js's buildSidecarDisplayData, or by regexProcessor.js for
 * inline-tag agents), the renderer injects the pre-computed styled HTML into the
 * message display and runs any matching render hooks.
 *
 * Persisted data follows the source agent's presentation state. Paused agents
 * remain enabled, so their frozen message UI stays visible; disabled or deleted
 * agents do not render until enabled again.
 *
 * Swipe-aware: saAgentData entries are tagged with `_swipeId`; the renderer only
 * displays data matching the message's current `swipe_id`. MESSAGE_SWIPED /
 * CHARACTER_MESSAGE_RENDERED trigger a re-render so the correct swipe shows.
 *
 * Timer fix (gameplan problem #3): there is NO setTimeout re-render dodge. New
 * sidecar data is shown by an explicit refreshMessage() call the moment it lands,
 * and CHARACTER_MESSAGE_RENDERED is the authoritative re-render safety net.
 *
 * Ported from VM's renderer.js. Namespace updated vm→sa.
 */

import { chat, eventSource, event_types } from '../../../../../../script.js';
import { DOMPurify } from '../../../../../../lib.js';
import { debug } from '../core/runtime.js';
import { getAgentById, getEnabledAgents, onStoreChange } from '../data/store.js';
import { canRenderSidecarData } from './sidecarDisplayPolicy.js';

const LOG_PREFIX = '[SuperAgents/renderer]';
const RENDERED_ATTR = 'data-sa-agent-rendered';

/**
 * Render hooks — map of CSS class → render function. After injecting agent
 * HTML, any element matching a registered hook class is passed to its render
 * function. Lets templates use simple data containers while a JS renderer
 * handles the visual display.
 * @type {Map<string, function(HTMLElement): void>}
 */
const renderHooks = new Map();

/**
 * Register a render hook. After agent HTML is injected, any elements with the
 * given className are passed to renderFn.
 * @param {string} className - CSS class to match (without the dot)
 * @param {function(HTMLElement): void} renderFn
 */
export function registerRenderHook(className, renderFn) {
    renderHooks.set(className, renderFn);
    debug(`${LOG_PREFIX} registered render hook for .${className}`);
}

/** @type {MutationObserver|null} */
let observer = null;
let unsubscribeStoreChange = null;
let enabledAgentSignature = '';
let enabledRefreshQueued = false;
let initRetryTimer = null;
let initAttempts = 0;
const chatMutationListeners = new Set();

/** Reuse the renderer's chat observer instead of installing parallel subtree observers. */
export function onChatDomMutation(listener) {
    if (typeof listener !== 'function') return () => {};
    chatMutationListeners.add(listener);
    return () => chatMutationListeners.delete(listener);
}

// ============================================================================
// INIT / DESTROY
// ============================================================================

/** Initialize the renderer: MutationObserver + event hooks. */
export function initRenderer() {
    if (observer || initRetryTimer) return;
    const tryStart = () => {
        initRetryTimer = null;
        if (observer) return;
        const chatContainer = document.getElementById('chat');
        if (chatContainer) {
            initAttempts = 0;
            startObserver(chatContainer);
            return;
        }
        if (++initAttempts < 20) {
            initRetryTimer = setTimeout(tryStart, 250);
        } else {
            initAttempts = 0;
            console.warn(`${LOG_PREFIX} #chat not found; renderer not bound`);
        }
    };
    tryStart();
}

function startObserver(chatContainer) {
    observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
                if (node.nodeType !== Node.ELEMENT_NODE) continue;
                processNode(node);
            }
        }
        for (const listener of chatMutationListeners) {
            try { listener(mutations); } catch (error) {
                console.warn(`${LOG_PREFIX} chat-mutation listener failed:`, error);
            }
        }
    });

    observer.observe(chatContainer, { childList: true, subtree: true });

    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
    if (event_types.MESSAGE_SWIPED) {
        eventSource.on(event_types.MESSAGE_SWIPED, onMessageSwiped);
    }
    if (event_types.CHARACTER_MESSAGE_RENDERED) {
        eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, onCharacterMessageRendered);
    }
    enabledAgentSignature = getEnabledAgentSignature();
    unsubscribeStoreChange = onStoreChange(onStoreChanged);

    requestAnimationFrame(() => renderAllVisible());
    debug(`${LOG_PREFIX} initialized`);
}

/** Tear down the renderer and detach listeners. */
export function destroyRenderer() {
    if (initRetryTimer) clearTimeout(initRetryTimer);
    initRetryTimer = null;
    initAttempts = 0;
    if (observer) {
        observer.disconnect();
        observer = null;
    }
    eventSource.removeListener(event_types.CHAT_CHANGED, onChatChanged);
    if (event_types.MESSAGE_SWIPED) {
        eventSource.removeListener(event_types.MESSAGE_SWIPED, onMessageSwiped);
    }
    if (event_types.CHARACTER_MESSAGE_RENDERED) {
        eventSource.removeListener(event_types.CHARACTER_MESSAGE_RENDERED, onCharacterMessageRendered);
    }
    unsubscribeStoreChange?.();
    unsubscribeStoreChange = null;
    enabledRefreshQueued = false;
}

// ============================================================================
// RENDERING
// ============================================================================

/** Process a newly added DOM node — render it if it's a message (or contains some). */
function processNode(node) {
    if (node.classList?.contains('mes')) {
        renderMessage(node);
    } else if (node.querySelectorAll) {
        node.querySelectorAll('.mes').forEach(renderMessage);
    }
}

/**
 * Render agent data for a single .mes element. Reads chat[mesid].extra.saAgentData
 * and injects styled HTML. Swipe-aware: only renders entries whose `_swipeId`
 * matches the message's current `swipe_id`; legacy entries without `_swipeId`
 * render on all swipes.
 * @param {Element} mesEl
 */
function renderMessage(mesEl) {
    if (mesEl.hasAttribute(RENDERED_ATTR)) return;          // don't double-render

    const mesId = parseInt(mesEl.getAttribute('mesid'), 10);
    if (isNaN(mesId) || mesId < 0) return;

    const message = chat[mesId];
    if (!message?.extra?.saAgentData) return;

    const agentData = message.extra.saAgentData;
    const currentSwipeId = message.swipe_id ?? 0;

    const entries = Object.entries(agentData).filter(([agentId, data]) => {
        const sourceAgent = getAgentById(data?.agentId || agentId);
        return sourceAgent?.enabled
            && (data._swipeId === undefined || data._swipeId === currentSwipeId)
            && canRenderSidecarData(sourceAgent, message, currentSwipeId);
    });
    if (entries.length === 0) {
        mesEl.setAttribute(RENDERED_ATTR, 'empty');
        return;
    }

    const mesText = mesEl.querySelector('.mes_text');
    if (!mesText) return;

    const topFragments = [];
    const bottomFragments = [];

    for (const [, data] of entries) {
        if (!data?.scripts) continue;
        for (const scriptData of data.scripts) {
            if (!Array.isArray(scriptData.extractions)) continue;
            for (const extraction of scriptData.extractions) {
                const html = extraction.rendered?.trim();
                if (!html) continue;
                if (extraction.placement === 'bottom') bottomFragments.push(html);
                else topFragments.push(html);
            }
        }
    }

    if (topFragments.length === 0 && bottomFragments.length === 0) {
        mesEl.setAttribute(RENDERED_ATTR, 'empty');
        return;
    }

    if (topFragments.length > 0) {
        const topContainer = document.createElement('div');
        topContainer.className = 'sa-agent-output sa-agent-output-top';
        topContainer.innerHTML = DOMPurify.sanitize(topFragments.join(''));
        mesText.insertBefore(topContainer, mesText.firstChild);
        runRenderHooks(topContainer);
    }

    if (bottomFragments.length > 0) {
        const bottomContainer = document.createElement('div');
        bottomContainer.className = 'sa-agent-output sa-agent-output-bottom';
        bottomContainer.innerHTML = DOMPurify.sanitize(bottomFragments.join(''));
        mesText.appendChild(bottomContainer);
        runRenderHooks(bottomContainer);
    }

    mesEl.setAttribute(RENDERED_ATTR, 'true');
}

/**
 * Force re-render a specific message (after new extraction data is stored).
 * This is the timer-free path: callers invoke it the instant data lands.
 * @param {number} messageIndex
 */
export function refreshMessage(messageIndex) {
    const mesEl = document.querySelector(`.mes[mesid="${messageIndex}"]`);
    if (!mesEl) return;
    clearMessageRender(mesEl);
    renderMessage(mesEl);
}

/** Run registered render hooks on a container element. */
function runRenderHooks(container) {
    for (const [className, renderFn] of renderHooks) {
        container.querySelectorAll(`.${className}`).forEach(el => {
            try {
                renderFn(el);
            } catch (err) {
                debug(`${LOG_PREFIX} render hook error for .${className}:`, err);
            }
        });
    }
}

/** Render all visible messages that haven't been rendered yet. */
function renderAllVisible() {
    document.querySelectorAll('.mes:not([' + RENDERED_ATTR + '])').forEach(renderMessage);
}

/** Clear rendered agent output from a message element. */
function clearMessageRender(mesEl) {
    mesEl.querySelectorAll('.sa-agent-output').forEach(el => el.remove());
    mesEl.removeAttribute(RENDERED_ATTR);
}

// ============================================================================
// EVENT HANDLERS
// ============================================================================

/** On chat change, clear render markers so messages re-render with fresh data. */
function onChatChanged() {
    document.querySelectorAll(`[${RENDERED_ATTR}]`).forEach(clearMessageRender);
    requestAnimationFrame(() => renderAllVisible());
}

function getEnabledAgentSignature() {
    return getEnabledAgents().map(agent => agent.id).sort().join('\u0000');
}

/** Repaint persisted message UI only when an agent crosses the on/off boundary. */
function onStoreChanged() {
    const nextSignature = getEnabledAgentSignature();
    if (nextSignature === enabledAgentSignature) return;
    enabledAgentSignature = nextSignature;
    if (enabledRefreshQueued) return;
    enabledRefreshQueued = true;
    requestAnimationFrame(() => {
        enabledRefreshQueued = false;
        document.querySelectorAll(`[${RENDERED_ATTR}]`).forEach(clearMessageRender);
        renderAllVisible();
    });
}

/**
 * On swipe navigation, clear and re-render the affected message. ST replaces
 * .mes_text innerHTML on swipe, destroying our injected containers; RENDERED_ATTR
 * stays so the observer won't re-fire — we re-render manually. renderMessage
 * picks the correct swipe's data because it filters by message.swipe_id.
 * @param {number} messageIndex
 */
function onMessageSwiped(messageIndex) {
    const idx = Number(messageIndex);
    const mesEl = document.querySelector(`.mes[mesid="${idx}"]`);
    if (!mesEl) return;
    clearMessageRender(mesEl);
    requestAnimationFrame(() => renderMessage(mesEl));
}

/**
 * Authoritative re-render safety net. Fires after ST finishes rendering a
 * character message (including after swipes / edits). If our output containers
 * were destroyed by ST's DOM update, re-inject them.
 * @param {number} messageIndex
 */
function onCharacterMessageRendered(messageIndex) {
    const idx = Number(messageIndex);
    const mesEl = document.querySelector(`.mes[mesid="${idx}"]`);
    if (!mesEl) return;

    const message = chat[idx];
    if (!message?.extra?.saAgentData) return;

    const hasOutput = mesEl.querySelector('.sa-agent-output');
    const hasAttr = mesEl.hasAttribute(RENDERED_ATTR);
    if (!hasOutput || !hasAttr) {
        clearMessageRender(mesEl);
        renderMessage(mesEl);
    }
}
