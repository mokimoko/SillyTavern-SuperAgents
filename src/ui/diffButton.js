/**
 * ui/diffButton.js — ReCast-style diff viewer entry point (v0).
 *
 * Adds a message-action button (in .extraMesButtons) that opens a read-only
 * inline word-level diff of a rewrite agent's change, with a single writeback
 * action: "Revert to original" (reuses core/idempotency.revertAgentRewrite).
 * Closing the popup keeps the agent's version. There is NO per-change toggle
 * and NO text reconstruction in v0 — see RECAST_DIFF_GAMEPLAN.md §"v0".
 *
 * Visibility test (gameplan §1, as amended during recon):
 *   a run record exists whose mode === 'rewrite', originalText is non-null,
 *   originalText !== result, AND result.trim() === message.mes.trim().
 * The final clause is the swipe/staleness guard: agentRuns carries no
 * _swipeId, so we can't ask "was this recorded on the current swipe?". But if
 * the user swiped away (or hand-edited), message.mes no longer matches the
 * record's result, the diff would be a lie, and the button hides itself. This
 * sidesteps the missing _swipeId entirely (the gameplan's "biggest unknown").
 *
 * Why mode === 'rewrite' only: executeRewriteAgent records BOTH rewrite and
 * LLM-append as mode 'rewrite' with the full new text in `result`, so the
 * content-match test holds for them. The non-LLM static append records mode
 * 'append' with only the appended fragment in `result` (not the full text),
 * which would fail content-match — and revertAgentRewrite refuses anything
 * but mode 'rewrite' anyway. So 'rewrite' is exactly the coherent v0 set.
 *
 * Patterns mirrored from ui/runIndicator.js: idempotent build, defensive
 * re-inject after re-render. Injection + delegation both live here.
 */

import { chat, saveChatDebounced } from '../../../../../../script.js';
import { getContext } from '../../../../../extensions.js';
import { eventSource, event_types } from '../../../../../events.js';
import { Popup, POPUP_TYPE, POPUP_RESULT } from '../../../../../popup.js';
import { getRunRecords, revertAgentRewrite } from '../core/idempotency.js';
import { onPostProcessComplete } from '../core/lifecycle.js';
import { refreshMessage } from '../render/renderer.js';
import { renderInlineHtml, escapeHtml } from '../render/diffEngine.js';

const LOG_PREFIX = '[SuperAgents/diffButton]';
const BTN_CLASS = 'sa_diff_btn';
const BTN_TITLE = 'View agent changes (diff)';
const BTN_ICON = 'fa-solid fa-code-compare';

// ============================================================================
// VISIBILITY — which (if any) record this message should show a button for
// ============================================================================

/**
 * Return the run record this message should diff, or null if none qualifies.
 * If multiple rewrite records match, returns the most recent (by timestamp) —
 * v0 shows one button for the latest change (gameplan §6.4).
 * @param {number} mesId
 * @returns {object|null}
 */
function pickDiffableRecord(mesId) {
    const message = chat[mesId];
    if (!message || message.is_user || message.is_system) return null;
    if (typeof message.mes !== 'string') return null;

    const records = getRunRecords(mesId);
    const current = message.mes.trim();

    let best = null;
    for (const record of Object.values(records)) {
        if (!record || record.mode !== 'rewrite') continue;
        if (record.originalText == null || record.result == null) continue;
        if (record.originalText === record.result) continue;       // no-op change
        if (String(record.result).trim() !== current) continue;    // stale / swiped / edited
        if (!best || (record.lastRunTimestamp ?? 0) > (best.lastRunTimestamp ?? 0)) {
            best = record;
        }
    }
    return best;
}

// ============================================================================
// BUTTON INJECTION
// ============================================================================

/**
 * Inject (or remove) the diff button for one .mes element based on the
 * visibility test. Idempotent: safe to call repeatedly on the same element.
 * @param {Element} mesEl
 */
function syncButton(mesEl) {
    const mesIdAttr = mesEl.getAttribute('mesid');
    if (mesIdAttr == null) return;
    const mesId = parseInt(mesIdAttr, 10);
    if (Number.isNaN(mesId) || mesId < 0) return;

    const existing = mesEl.querySelector('.' + BTN_CLASS);
    const record = pickDiffableRecord(mesId);

    // No qualifying record → remove a stale button if present, done.
    if (!record) {
        if (existing) existing.remove();
        return;
    }

    if (existing) return; // already present and still valid

    const container = mesEl.querySelector('.extraMesButtons');
    if (!container) return; // ST hasn't built the action row yet

    const btn = document.createElement('div');
    btn.className = BTN_CLASS + ' mes_button interactable';
    btn.title = BTN_TITLE;
    btn.tabIndex = 0;
    btn.setAttribute('data-agent-id', record.agentId);
    btn.innerHTML = `<i class="${BTN_ICON}"></i>`;
    // Place it at the front of the extra-buttons row.
    container.insertBefore(btn, container.firstChild);
}

/** Re-sync buttons on every currently-rendered message. */
function syncAllVisible() {
    document.querySelectorAll('#chat .mes[mesid]').forEach(syncButton);
}

// ============================================================================
// POPUP — open the read-only diff for a given message + agent
// ============================================================================

/**
 * Open the diff popup for a message/agent pair.
 * @param {number} mesId
 * @param {string} agentId
 */
async function openDiffPopup(mesId, agentId) {
    const record = getRunRecords(mesId)[agentId];
    if (!record || record.mode !== 'rewrite' || record.originalText == null) {
        toastr.info('No change to show for this message.');
        return;
    }

    const agentLabel = escapeHtml(record.agentName || 'agent');
    const summary = `<div class="sa-diff-summary">Changes by <b>${agentLabel}</b> — `
        + `<span class="sa-diff-del">red struck-through</span> was removed, `
        + `<span class="sa-diff-ins">green</span> was added.</div>`;
    const diffHtml = renderInlineHtml(record.originalText, record.result);

    const content = document.createElement('div');
    content.innerHTML = summary + diffHtml;

    let revertRequested = false;

    const popup = new Popup(content, POPUP_TYPE.TEXT, '', {
        wide: true,
        allowVerticalScrolling: true,
        okButton: 'Keep changes',
        cancelButton: false,
        customButtons: [{
            text: 'Revert to original',
            icon: 'fa-solid fa-rotate-left',
            classes: ['sa-diff-revert-btn'],
            result: POPUP_RESULT.NEGATIVE, // closes the popup with this result
            action: () => { revertRequested = true; },
        }],
    });

    await popup.show();

    if (revertRequested) {
        doRevert(mesId, agentId);
    }
}

/**
 * Revert a rewrite to its original text and repaint, mirroring the exact
 * sequence lifecycle.js uses after a rewrite (gameplan §6.2 — do not invent a
 * new repaint path). revertAgentRewrite restores message.mes + clears the
 * record; we then repaint and drop the now-orphaned button.
 * @param {number} mesId
 * @param {string} agentId
 */
function doRevert(mesId, agentId) {
    const ok = revertAgentRewrite(mesId, agentId);
    if (!ok) {
        toastr.warning('Could not revert (no original text on record).');
        return;
    }

    const message = chat[mesId];
    // revertAgentRewrite already calls saveChatDebounced via clearAgentRun, but
    // call it again defensively in case the message.mes write needs flushing.
    saveChatDebounced();

    const context = getContext();
    if (typeof context?.updateMessageBlock === 'function') {
        context.updateMessageBlock(mesId, message);
    }
    refreshMessage(mesId);

    // The record is gone, so the visibility test now fails — drop the button.
    const mesEl = document.querySelector(`#chat .mes[mesid="${mesId}"]`);
    if (mesEl) syncButton(mesEl);
}

// ============================================================================
// EVENT WIRING
// ============================================================================

/** Resolve a .mes element's id from a descendant node. */
function mesIdFromNode(node) {
    const mesEl = node.closest?.('.mes[mesid]');
    if (!mesEl) return null;
    const id = parseInt(mesEl.getAttribute('mesid'), 10);
    return Number.isNaN(id) ? null : id;
}

let delegationBound = false;

/** @type {MutationObserver|null} */
let chatObserver = null;
let syncPending = false;

/**
 * Debounced re-sync after any chat DOM mutation. ST's updateMessageBlock (used
 * after manual /sa-run rewrites) tears down and rebuilds the message DOM
 * without firing any event we can listen to — the only honest way to catch
 * that is observing the DOM directly, same pattern render/renderer.js uses.
 * rAF coalesces a burst of mutations from one rebuild into a single re-sync.
 */
function scheduleSyncAll() {
    if (syncPending) return;
    syncPending = true;
    requestAnimationFrame(() => {
        syncPending = false;
        syncAllVisible();
    });
}

/** Start observing #chat for message rebuilds. Idempotent. */
function startChatObserver() {
    if (chatObserver) return;
    const chatEl = document.getElementById('chat');
    if (!chatEl) return;

    chatObserver = new MutationObserver((mutations) => {
        // We only care about additions of nodes that smell like a message
        // rebuild — bare .mes elements, .extraMesButtons rows, or anything
        // containing those. Filtering keeps unrelated DOM churn cheap.
        for (const m of mutations) {
            if (m.type !== 'childList' || m.addedNodes.length === 0) continue;
            for (const node of m.addedNodes) {
                if (node.nodeType !== Node.ELEMENT_NODE) continue;
                const cls = node.classList;
                if (cls?.contains('mes') || cls?.contains('extraMesButtons')
                    || node.querySelector?.('.extraMesButtons')) {
                    scheduleSyncAll();
                    return;
                }
            }
        }
    });
    chatObserver.observe(chatEl, { childList: true, subtree: true });
}

/** Bind the delegated click handler on #chat once. */
function bindDelegation() {
    if (delegationBound) return;
    const chatEl = document.getElementById('chat');
    if (!chatEl) return;

    chatEl.addEventListener('click', (e) => {
        const btn = e.target.closest?.('.' + BTN_CLASS);
        if (!btn || !chatEl.contains(btn)) return;
        e.preventDefault();
        e.stopPropagation();
        const mesId = mesIdFromNode(btn);
        const agentId = btn.getAttribute('data-agent-id');
        if (mesId == null || !agentId) return;
        openDiffPopup(mesId, agentId);
    });

    delegationBound = true;
}

/**
 * Re-inject buttons after ST (re)renders a message. MESSAGE_RENDERED /
 * CHARACTER_MESSAGE_RENDERED wipe injected nodes (gameplan §6.3), so we re-run
 * the injector for the affected message on each.
 * @param {number} messageIndex
 */
function onMessageRendered(messageIndex) {
    const idx = Number(messageIndex);
    const mesEl = document.querySelector(`#chat .mes[mesid="${idx}"]`);
    if (mesEl) {
        // The action row may be built a tick after the message node; rAF lets
        // .extraMesButtons exist before we inject.
        requestAnimationFrame(() => syncButton(mesEl));
    }
}

/** After a post-gen run, a brand-new rewrite may now qualify. Re-sync the
 *  affected message (and fall back to a full pass for safety). */
function onPostProcess(messageIndex) {
    const idx = Number(messageIndex);
    requestAnimationFrame(() => {
        const mesEl = document.querySelector(`#chat .mes[mesid="${idx}"]`);
        if (mesEl) syncButton(mesEl);
        else syncAllVisible();
    });
}

// ============================================================================
// INIT
// ============================================================================

/**
 * Initialize the diff buttons: bind delegation, listen for renders/swipes, and
 * do a first pass over already-visible messages.
 */
export function initDiffButtons() {
    let attempts = 0;
    const tryBind = () => {
        bindDelegation();
        startChatObserver();
        if (delegationBound) {
            requestAnimationFrame(syncAllVisible);
            return;
        }
        if (++attempts < 20) setTimeout(tryBind, 250);
        else console.warn(`${LOG_PREFIX} #chat not found; diff buttons not bound`);
    };
    tryBind();

    if (event_types.MESSAGE_RENDERED) {
        eventSource.on(event_types.MESSAGE_RENDERED, onMessageRendered);
    }
    if (event_types.CHARACTER_MESSAGE_RENDERED) {
        eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, onMessageRendered);
    }
    if (event_types.USER_MESSAGE_RENDERED) {
        eventSource.on(event_types.USER_MESSAGE_RENDERED, onMessageRendered);
    }
    if (event_types.MESSAGE_SWIPED) {
        eventSource.on(event_types.MESSAGE_SWIPED, onMessageRendered);
    }
    if (event_types.MESSAGE_EDITED) {
        eventSource.on(event_types.MESSAGE_EDITED, onMessageRendered);
    }
    if (event_types.CHAT_CHANGED) {
        // New chat loaded — re-sync every visible message from scratch.
        eventSource.on(event_types.CHAT_CHANGED, () => requestAnimationFrame(syncAllVisible));
    }

    // The freshest path: the instant a post-gen rewrite finishes, its record
    // exists and message.mes matches it — sync that message's button now
    // rather than waiting for an incidental re-render.
    onPostProcessComplete(onPostProcess);
}
