/**
 * ui/runIndicator.js — the in-input "stop agents" affordance.
 *
 * Mirrors SillyTavern's own #mes_stop button: a circle-stop icon that lives in
 * #rightSendForm and is visible only while work is in flight. Ours appears
 * while a SuperAgents run is active (post-gen batch or a manual single run) and
 * cancels it on click via lifecycle.cancelAgentRun().
 *
 * Why a separate button (not piggy-backing ST's #mes_stop): ST's stop aborts
 * the MAIN generation. Our agent passes (sidecar / rewrite) run AFTER the main
 * message has already arrived, so ST's stop is long gone by then. A dedicated
 * control is the only honest way to interrupt an agent pass.
 *
 * Visibility is driven by lifecycle.onRunStateChange(active) — no polling.
 */

import { cancelAgentRun, onRunStateChange, isAgentRunActive } from '../core/lifecycle.js';
import { debug } from '../../index.js';

const LOG_PREFIX = '[SuperAgents/runIndicator]';
const BTN_ID = 'sa_stop';

let btn = null;
let mounted = false;

/** Build the button element (idempotent). */
function buildButton() {
    if (btn) return btn;
    btn = document.createElement('div');
    btn.id = BTN_ID;
    btn.className = 'sa-stop-btn displayNone';
    btn.title = 'Stop SuperAgents run';
    btn.setAttribute('tabindex', '0');
    btn.innerHTML = '<i class="fa-solid fa-circle-stop"></i>';

    const onActivate = (e) => {
        e?.preventDefault?.();
        e?.stopPropagation?.();
        const stopped = cancelAgentRun();
        if (stopped) {
            debug(`${LOG_PREFIX} user cancelled the active agent run`);
            // Hide immediately for responsiveness; the run-state listener will
            // also fire false when the run actually unwinds.
            setVisible(false);
        }
    };
    btn.addEventListener('click', onActivate);
    btn.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') onActivate(e);
    });
    return btn;
}

/** Insert the button into the send form, if it isn't there yet. */
function mount() {
    if (mounted && document.getElementById(BTN_ID)) return true;

    const form = document.getElementById('rightSendForm');
    if (!form) return false;

    const el = buildButton();
    // Place just before ST's own #mes_stop so the controls read left-to-right
    // as [script btns][agent stop][main stop][impersonate][send].
    const anchor = document.getElementById('mes_stop');
    if (anchor && anchor.parentElement === form) {
        form.insertBefore(el, anchor);
    } else {
        form.appendChild(el);
    }
    mounted = true;
    return true;
}

function setVisible(visible) {
    if (!btn) return;
    btn.classList.toggle('displayNone', !visible);
}

/**
 * Initialize the indicator. Mounts the button (retrying briefly if the send
 * form isn't in the DOM yet at load) and binds it to run-state changes.
 */
export function initRunIndicator() {
    // The send form is usually present at load, but retry a few times in case
    // this runs before ST finishes building #rightSendForm.
    let attempts = 0;
    const tryMount = () => {
        if (mount()) {
            // Reflect any run already in progress (e.g. hot-reload mid-run).
            setVisible(isAgentRunActive());
            return;
        }
        if (++attempts < 20) setTimeout(tryMount, 250);
        else console.warn(`${LOG_PREFIX} #rightSendForm not found; stop button not mounted`);
    };
    tryMount();

    onRunStateChange((active) => {
        // Defensive remount: if some other extension rebuilt the send form and
        // dropped our node, put it back before toggling.
        if (!document.getElementById(BTN_ID)) { mounted = false; mount(); }
        setVisible(active);
    });

    debug(`${LOG_PREFIX} run indicator initialized`);
}
