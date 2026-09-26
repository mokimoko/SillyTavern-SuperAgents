/**
 * render/hooks/continuityGuard.js — the Continuity Guard interactive flag.
 *
 * UNLIKE every other render hook (which passively styles a data container and
 * calls el.replaceWith), this one is INTERACTIVE. It draws a quiet, clickable
 * "continuity" flag under a flagged message and, ONLY on click, runs a single
 * combined confirm+repair LLM call, then routes the result through the same
 * message-write + recordAgentRun path a rewrite uses — so the existing diff
 * button (ui/diffButton.js) lights up for free and revert comes with it.
 *
 * Flag UI (locked decision — Option A): subtle italic "continuity" text, no
 * question mark, right-aligned, dotted underline, muted colour, a 12px
 * triangle-alert icon. Quiet enough that a false positive is ignorable — reads
 * as a margin annotation, not an alarm.
 *
 * Two gates neutralise the risk of editing live prose:
 *   1. The human click (a false flag costs nothing if ignored).
 *   2. The LLM may return break:false and VETO a bad deterministic flag before
 *      any prose is touched.
 *
 * Data flow: continuityDetect stashes a finding on message.saContinuityGuard
 * (a TOP-LEVEL sibling key, swipe-scoped — NOT under message.extra, which ST
 * structuredClones per swipe and would shadow with stale data). The renderer
 * injects a hidden .continuity-guard-data marker via saAgentData; this hook
 * turns it into the flag and wires the click.
 */

import { chat, saveChatDebounced } from '../../../../../../../script.js';
import { getContext } from '../../../../../../extensions.js';
import { callAgentLLM, isAbortError } from '../../core/llm.js';
import { getAgentById, isAgentsPaused } from '../../data/store.js';
import { recordAgentRun } from '../../core/idempotency.js';
import { readMergeArray } from '../../modes/mergeVariable.js';
import { refreshMessage } from '../renderer.js';
import { debug } from '../../core/runtime.js';

const LOG_PREFIX = '[SuperAgents/continuityGuard]';

// State-card + narrative-engine merge variables (repair-call context).
const STATE_VAR = 'sa_state_card';
const NARRATIVE_VAR = 'sa_narrative_engine';

// ============================================================================
// FINDING STORAGE (top-level sibling, swipe-scoped)
// ============================================================================

/**
 * Read the stashed Stage-1 finding for a message's active swipe.
 * @param {object} message — chat[n]
 * @returns {object|null}
 */
function readFinding(message) {
    if (!message?.saContinuityGuard) return null;
    const swipeId = message.swipe_id ?? 0;
    return message.saContinuityGuard[swipeId] ?? null;
}

// ============================================================================
// STATE READ (repair-call context)
// ============================================================================

/** Read the raw State Card blob string (first snapshot item's json field). */
function readStateCardJson() {
    const arr = readMergeArray(STATE_VAR);
    if (!arr.length) return '';
    const blob = arr[0]?.json;
    return typeof blob === 'string' ? blob.trim() : '';
}

/** Read the raw Narrative Engine blob string (first snapshot item's json field). */
function readNarrativeJson() {
    const arr = readMergeArray(NARRATIVE_VAR);
    if (!arr.length) return '';
    const blob = arr[0]?.json;
    return typeof blob === 'string' ? blob.trim() : '';
}

// ============================================================================
// COMBINED CONFIRM + REPAIR LLM CALL (on click only)
// ============================================================================

/**
 * Build the strict-JSON system prompt for the single confirm+repair call.
 * Precision-over-recall flips ON here: a hallucinated fix now edits real prose,
 * so the instruction is conservative — fix ONLY the identified break, change as
 * little as possible, return everything else verbatim, and allow a veto.
 * @param {object|null} finding — Stage-1 suspicion (may be null for every-N sweep)
 * @param {string} stateJson
 * @param {string} narrativeJson
 * @returns {string}
 */
function buildRepairSystemPrompt(finding, stateJson, narrativeJson) {
    const suspicion = finding?.reason
        ? `A cheap deterministic check flagged a SPECIFIC suspected break:\n`
          + `  "${finding.reason}"\n`
          + (finding.evidence ? `  Evidence in the prose: ${finding.evidence}\n` : '')
          + `Confirm or reject THIS suspicion first; you may also catch a clearly related break.\n`
        : `No specific suspicion was supplied. Do one open pass: check the message `
          + `against the tracked state below for any clear continuity break `
          + `(a character voiced who isn't present, someone acting against their `
          + `tracked condition, a tracked fact contradicted).\n`;

    return [
        `You are a continuity guard for an ongoing roleplay. You are given the latest`,
        `assistant message and the CURRENTLY TRACKED STATE. Decide whether the message`,
        `contradicts that tracked state, and if so, repair it.`,
        ``,
        suspicion,
        ``,
        `TRACKED STATE — State Card (authoritative roster + conditions):`,
        `<state_card>`,
        stateJson || '(none)',
        `</state_card>`,
        ``,
        `TRACKED STATE — Narrative Engine (spatial / dress / condition context):`,
        `<narrative_engine>`,
        narrativeJson || '(none)',
        `</narrative_engine>`,
        ``,
        `RULES:`,
        `- If there is NO real contradiction, set "break" to false and DO NOT rewrite.`,
        `  A deterministic flag can be wrong; vetoing it is correct and expected.`,
        `- If there IS a break, fix ONLY that break. Change as little as possible.`,
        `  Preserve every other sentence VERBATIM — same wording, same formatting,`,
        `  same paragraphing. Do not improve prose, do not add or remove content`,
        `  beyond the minimal edit that resolves the contradiction.`,
        `- Never write for or about the user's own character beyond what the original did.`,
        ``,
        `Respond with STRICT JSON and nothing else — no prose, no code fences:`,
        `{"break": true|false, "what": "one-line description of the break (or why none)",`,
        ` "fixed_message": "the full corrected message (omit or empty string if break is false)"}`,
    ].join('\n');
}

/**
 * Run the combined confirm+repair call for a message.
 * @param {number} mesId
 * @param {object} finding
 * @param {string} agentId — the guard agent's id (for the run record / diff)
 * @param {string} agentName
 * @param {string} profileRef
 * @returns {Promise<{break:boolean, what:string, fixed_message?:string}|null>}
 */
async function runRepairCall(mesId, finding, agentId, agentName, profileRef) {
    const message = chat[mesId];
    if (!message) return null;

    const stateJson = readStateCardJson();
    const narrativeJson = readNarrativeJson();

    const systemPrompt = buildRepairSystemPrompt(finding, stateJson, narrativeJson);
    const userContent = `Latest assistant message to check:\n<message>\n${message.mes}\n</message>`;

    const raw = await callAgentLLM({
        systemPrompt,
        userContent,
        profileRef: profileRef || '',
        maxTokens: 8192,
        callerName: `continuity-guard:${agentName}`,
    });

    return parseRepairEnvelope(raw);
}

/**
 * Parse the strict-JSON envelope, tolerating stray prose or code fences the
 * model may wrap around it.
 * @param {string} raw
 * @returns {{break:boolean, what:string, fixed_message?:string}|null}
 */
function parseRepairEnvelope(raw) {
    const text = String(raw ?? '').trim();
    if (!text) return null;

    // Strip code fences, then grab the first {...} block.
    const unfenced = text.replace(/```(?:json)?/gi, '').trim();
    const start = unfenced.indexOf('{');
    const end = unfenced.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) return null;

    try {
        const obj = JSON.parse(unfenced.slice(start, end + 1));
        if (typeof obj !== 'object' || obj === null) return null;
        return {
            break: obj.break === true,
            what: typeof obj.what === 'string' ? obj.what : '',
            fixed_message: typeof obj.fixed_message === 'string' ? obj.fixed_message : '',
        };
    } catch {
        return null;
    }
}

// ============================================================================
// WRITE-BACK (mirrors executeRewriteAgent's message-write + recordAgentRun)
// ============================================================================

/**
 * Apply a confirmed repair to the message. Writes message.mes, records the run
 * as mode:'rewrite' with originalText — which is exactly what ui/diffButton.js
 * looks for, so the diff/revert button appears automatically. Repaints via ST's
 * updateMessageBlock + the renderer's refreshMessage, the same sequence the
 * lifecycle uses after a rewrite.
 * @param {number} mesId
 * @param {string} fixedMessage
 * @param {string} agentId
 * @param {string} agentName
 * @returns {boolean} true if the message text actually changed
 */
function applyRepair(mesId, fixedMessage, agentId, agentName) {
    const message = chat[mesId];
    if (!message) return false;

    const originalText = message.mes;
    const next = String(fixedMessage ?? '').trim();
    if (!next || next === originalText) return false;

    message.mes = next;

    recordAgentRun(mesId, {
        agentId,
        agentName,
        phase: 'post',
        originalText,
        result: next,
        mode: 'rewrite',
    });

    // Clear the finding for this swipe so the flag doesn't linger post-repair.
    clearFinding(message);
    saveChatDebounced();

    // Repaint: ST's message block, then our render layer.
    const ctx = getContext();
    if (typeof ctx?.updateMessageBlock === 'function') {
        ctx.updateMessageBlock(mesId, message);
    }
    refreshMessage(mesId);
    return true;
}

/** Remove the stashed finding for the message's active swipe. */
function clearFinding(message) {
    if (!message?.saContinuityGuard) return;
    const swipeId = message.swipe_id ?? 0;
    delete message.saContinuityGuard[swipeId];
    if (Object.keys(message.saContinuityGuard).length === 0) {
        delete message.saContinuityGuard;
    }
}

// ============================================================================
// CLICK HANDLER — the two-gate repair flow
// ============================================================================

/**
 * Handle a click on a continuity flag: run the combined confirm+repair call,
 * honour a break:false veto, and apply a confirmed fix.
 * @param {HTMLElement} flagEl — the .continuity-guard-flag element
 */
async function onFlagClick(flagEl) {
    const targetAgentId = flagEl.getAttribute('data-agent-id') || 'continuity-guard';
    if (isAgentsPaused() || getAgentById(targetAgentId)?.paused) {
        toastr.info('SuperAgents are paused. Continuity state is frozen.');
        return;
    }
    const mesId = parseInt(flagEl.getAttribute('data-mesid'), 10);
    if (Number.isNaN(mesId)) return;
    const agentId = targetAgentId;
    const agentName = flagEl.getAttribute('data-agent-name') || 'Continuity Guard';
    const profileRef = flagEl.getAttribute('data-profile') || '';

    const message = chat[mesId];
    if (!message) return;
    const finding = readFinding(message); // may be null (every-N sweep)

    // Visual: enter a "checking" state; disable re-entry.
    if (flagEl.dataset.busy === '1') return;
    flagEl.dataset.busy = '1';
    const labelEl = flagEl.querySelector('.continuity-guard-label');
    const prevLabel = labelEl ? labelEl.textContent : '';
    if (labelEl) labelEl.textContent = 'checking…';
    flagEl.style.opacity = '0.55';

    try {
        const envelope = await runRepairCall(mesId, finding, agentId, agentName, profileRef);

        // A pause requested while the check was in flight freezes the message;
        // discard the result rather than applying a late repair.
        if (isAgentsPaused() || getAgentById(agentId)?.paused) {
            restoreFlag(flagEl, labelEl, prevLabel);
            return;
        }

        if (!envelope) {
            flash(flagEl, 'check failed', '#C08040');
            restoreFlag(flagEl, labelEl, prevLabel);
            return;
        }

        if (!envelope.break) {
            // The LLM veto valve — a bad deterministic flag, no prose touched.
            toastr.info(envelope.what || 'No continuity issue found.', agentName,
                { timeOut: 4000 });
            // Clear the finding so the (rejected) flag goes away for this swipe.
            clearFinding(message);
            saveChatDebounced();
            refreshMessage(mesId);
            return;
        }

        const changed = applyRepair(mesId, envelope.fixed_message, agentId, agentName);
        if (changed) {
            toastr.success(envelope.what || 'Continuity repaired.', agentName,
                { timeOut: 4000 });
            // The flag element is gone after refreshMessage; nothing else to do.
        } else {
            toastr.info('No change applied.', agentName, { timeOut: 3000 });
            restoreFlag(flagEl, labelEl, prevLabel);
        }
    } catch (err) {
        if (isAbortError(err)) {
            restoreFlag(flagEl, labelEl, prevLabel);
            return;
        }
        console.error(`${LOG_PREFIX} repair failed:`, err);
        flash(flagEl, 'error', '#C0504A');
        restoreFlag(flagEl, labelEl, prevLabel);
    } finally {
        flagEl.dataset.busy = '0';
    }
}

/** Restore the flag's resting appearance after a non-destructive outcome. */
function restoreFlag(flagEl, labelEl, prevLabel) {
    flagEl.style.opacity = '';
    if (labelEl && prevLabel) labelEl.textContent = prevLabel;
}

/** Briefly flash a status word on the flag. */
function flash(flagEl, word, color) {
    const labelEl = flagEl.querySelector('.continuity-guard-label');
    if (!labelEl) return;
    labelEl.textContent = word;
    labelEl.style.color = color;
    setTimeout(() => { labelEl.style.color = ''; }, 1600);
}

// ============================================================================
// RENDER HOOK — draw the quiet flag (Option A)
// ============================================================================

/**
 * Transform a hidden .continuity-guard-data marker into the clickable flag.
 * The marker's data attributes carry mesId + agent identity; the finding text
 * lives on the message (read live at click time so a swipe can't stale it).
 *
 * Flag UI (locked): right-aligned italic "continuity", dotted underline, muted
 * colour, 12px triangle-alert icon, no question mark. Title tooltip carries the
 * one-line reason so a curious user can see *why* without clicking.
 * @param {HTMLElement} el — the .continuity-guard-data element
 */
export function renderContinuityGuard(el) {
    const mesId = el.dataset.mesid ?? '';
    const agentId = el.dataset.agentId ?? 'continuity-guard';
    const agentName = el.dataset.agentName ?? 'Continuity Guard';
    const profile = el.dataset.profile ?? '';
    const reason = el.dataset.reason ?? '';
    const flagColor = 'color-mix(in srgb, rgb(200,180,150) 55%, var(--SmartThemeBodyColor, #fff) 45%)';
    const flagHoverColor = 'color-mix(in srgb, rgb(210,190,160) 35%, var(--SmartThemeBodyColor, #fff) 65%)';

    const flag = document.createElement('div');
    flag.className = 'continuity-guard-flag';
    flag.setAttribute('data-mesid', mesId);
    flag.setAttribute('data-agent-id', agentId);
    flag.setAttribute('data-agent-name', agentName);
    flag.setAttribute('data-profile', profile);
    flag.dataset.busy = '0';
    if (reason) flag.title = reason;

    flag.style.cssText = [
        'display:flex',
        'justify-content:flex-end',
        'align-items:center',
        'gap:5px',
        'margin:6px 2px 0 0',
        'font-size:11px',
        'font-style:italic',
        `color:${flagColor}`,
        'cursor:pointer',
        'user-select:none',
        'letter-spacing:0.02em',
    ].join(';');

    flag.innerHTML =
        `<i class="fa-solid fa-triangle-exclamation" `
        + `style="font-size:12px;opacity:0.6;flex-shrink:0"></i>`
        + `<span class="continuity-guard-label" `
        + `style="border-bottom:1px dotted var(--sa-text-muted,rgba(200,180,150,0.4));padding-bottom:1px">`
        + `continuity</span>`;

    // Hover affordance without shouting.
    flag.addEventListener('mouseenter', () => { flag.style.color = flagHoverColor; });
    flag.addEventListener('mouseleave', () => {
        if (flag.dataset.busy !== '1') flag.style.color = flagColor;
    });

    el.replaceWith(flag);
}

// ============================================================================
// DELEGATED CLICK — one listener on #chat (survives re-renders)
// ============================================================================

let delegationBound = false;

/**
 * Install a single delegated click handler on #chat for continuity flags.
 * Idempotent + self-retrying until #chat exists (mirrors diffButton /
 * directionMenu delegation). Call once from index.js init.
 */
export function initContinuityGuardDelegation() {
    if (delegationBound) return;
    let attempts = 0;
    const tryBind = () => {
        const chatEl = document.getElementById('chat');
        if (chatEl) {
            chatEl.addEventListener('click', (e) => {
                const flag = e.target.closest?.('.continuity-guard-flag');
                if (!flag || !chatEl.contains(flag)) return;
                e.preventDefault();
                e.stopPropagation();
                onFlagClick(flag);
            });
            delegationBound = true;
            debug(`${LOG_PREFIX} click delegation bound`);
            return;
        }
        if (++attempts < 20) setTimeout(tryBind, 250);
        else console.warn(`${LOG_PREFIX} #chat not found; flag clicks not bound`);
    };
    tryBind();
}
