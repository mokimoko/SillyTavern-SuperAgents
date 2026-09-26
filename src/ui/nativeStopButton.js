/**
 * ui/nativeStopButton.js — reuse SillyTavern's native ✕ (#mes_stop) to cancel
 * an in-flight SuperAgents run, and hide the send button while it runs.
 *
 * SuperAgents already ships a dedicated #sa_stop control (ui/runIndicator.js).
 * This module is the alternative the user asked for: instead of a second
 * button, drive ST's OWN stop button — the same ✕ a normal generation shows —
 * and mirror ST's "generating" body state so the send button hides, exactly
 * like the main generation does.
 *
 * Mechanism (adapted from the White Lotus utilitiesGen stop-button integration):
 *   - On run start: show #mes_stop, set body[data-generating]="true" (ST's CSS
 *     hides #send_but and shows the stop affordance off this attribute), and
 *     arm a capture-phase click listener.
 *   - The listener routes a click on the stop button to cancelAgentRun() and
 *     swallows it, so ST's own (now irrelevant) stopGeneration() doesn't run.
 *   - On run end: disarm the listener and restore the button + body attribute —
 *     but only if a REAL generation isn't currently in progress, so we never
 *     steal the stop button from, or wrongly clear the generating state of, an
 *     actual main generation. (Our post-gen runs start AFTER main gen ends, but
 *     our PRE-gen run overlaps GENERATION_AFTER_COMMANDS while main gen is
 *     spinning up — hence the guard.)
 *
 * Driven entirely by lifecycle.onRunStateChange(active); no polling.
 *
 * This is opt-in via initNativeStopButton(). If you prefer the separate
 * #sa_stop button, use initRunIndicator() instead (don't init both — they'd
 * both react to the same run state, which is harmless but redundant).
 */

import { cancelAgentRun, onRunStateChange, isAgentRunActive } from '../core/lifecycle.js';
import { debug } from '../core/runtime.js';

const LOG_PREFIX = '[SuperAgents/nativeStop]';

/** Saved value of body[data-generating] so we can restore it after our run. */
let prevGeneratingAttr = null;

/** Whether our capture listener is currently armed. */
let armed = false;

/**
 * Is a real main generation in progress right now? If so we must not touch the
 * stop button or the generating attribute — it belongs to that generation.
 */
function mainGenerationActive() {
    try {
        const sp = window?.SillyTavern?.streamingProcessor;
        if (sp && !sp.isFinished) return true;
    } catch { /* ignore */ }
    return false;
}

/** Capture-phase click handler — routes a stop-button click to our cancel. */
function onStopButtonClick(e) {
    if (!isAgentRunActive()) return;
    if (!e.target.closest('#mes_stop, .mes_stop')) return;
    // A real generation owns the button — let ST handle it, don't hijack.
    if (mainGenerationActive()) return;

    const stopped = cancelAgentRun();
    if (stopped) {
        debug(`${LOG_PREFIX} user cancelled the active agent run via #mes_stop`);
        // Swallow the click so ST's own stopGeneration() (a no-op for us, but
        // it can emit GENERATION_STOPPED) doesn't also fire.
        e.preventDefault();
        e.stopPropagation();
        // Restore UI promptly; the run-state listener will also fire false when
        // the run actually unwinds.
        teardown();
    }
}

/** Show ST's native stop button, hide the send button, arm the listener. */
function setup() {
    if (armed) return;
    // Don't fight a real generation for the button.
    if (mainGenerationActive()) return;

    const stop = document.getElementById('mes_stop');
    if (stop) stop.style.display = 'flex';

    if (typeof document !== 'undefined' && document.body) {
        prevGeneratingAttr = document.body.getAttribute('data-generating');
        document.body.setAttribute('data-generating', 'true');
    }

    // Capture phase so we run before ST's delegated bubble-phase handler.
    document.addEventListener('click', onStopButtonClick, true);
    armed = true;
}

/** Hide the stop button, restore the send button + body state, disarm. */
function teardown() {
    if (!armed) return;
    document.removeEventListener('click', onStopButtonClick, true);
    armed = false;

    // If a real generation took over in the meantime, leave its UI alone.
    if (mainGenerationActive()) {
        prevGeneratingAttr = null;
        return;
    }

    const stop = document.getElementById('mes_stop');
    if (stop) stop.style.display = 'none';

    if (typeof document !== 'undefined' && document.body) {
        if (prevGeneratingAttr === null) {
            document.body.removeAttribute('data-generating');
        } else {
            document.body.setAttribute('data-generating', prevGeneratingAttr);
        }
    }
    prevGeneratingAttr = null;
}

/**
 * Initialize the native stop-button integration. Binds to run-state changes;
 * setup on run start, teardown on run end.
 */
export function initNativeStopButton() {
    onRunStateChange((active) => {
        if (active) setup();
        else teardown();
    });
    // Reflect a run already in progress (e.g. hot-reload mid-run).
    if (isAgentRunActive()) setup();
    debug(`${LOG_PREFIX} native stop-button integration initialized`);
}
