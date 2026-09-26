/**
 * core/compatibility.js — coexistence guard for other generation-driving
 * extensions (Stepped Thinking, Qvink Memory, Recast, etc.).
 *
 * The problem (gameplan Step 8 / problem from the Recast study):
 * SuperAgents' post-gen orchestrator fires on MESSAGE_RECEIVED. Other
 * extensions that issue their own LLM passes (Stepped Thinking's reasoning
 * injection, Qvink Memory's summaries, Recast's rewrite passes) also ride the
 * generation lifecycle. When two of these run against the same turn they can:
 *   - double-fire on a single user action,
 *   - interleave setExtensionPrompt writes,
 *   - or trip each other's idempotency assumptions.
 *
 * SillyTavern serializes actual generation behind a single mutex, and Recast's
 * compatibility.js coordinates by watching the generation lifecycle rather than
 * grabbing the mutex itself. We mirror that: a lightweight, event-driven flag
 * that tracks whether a *foreign* generation is currently in flight, so the
 * lifecycle can diagnose overlap without taking a second lock.
 *
 * This module deliberately holds no locks of its own. It only OBSERVES. The
 * lifecycle consults isExternalGenerationActive() before running post-gen and
 * logs overlap; SillyTavern's generation mutex remains the serializer.
 */

import { eventSource, event_types } from '../../../../../events.js';
import { debug } from './runtime.js';

const LOG_PREFIX = '[SuperAgents/compat]';

// Known extension module keys that drive their own generations. Used only for
// debug attribution — coordination itself is event-driven and name-agnostic.
const KNOWN_DRIVERS = ['qvink_memory', 'SillyTavern-Stepped-Thinking', 'recast-post-processing'];

// Depth counter rather than a boolean: nested/overlapping generations (a
// foreign pre-gen that itself triggers another pass) must not clear the flag
// until ALL of them have unwound.
let externalGenDepth = 0;

// Set true only while SuperAgents itself is the active generator, so our own
// lifecycle-driven sidecar calls don't get counted as "external" and make us
// defer against ourselves.
let selfGenerationDepth = 0;
let initialized = false;

// The deadline guard: if an END event is somehow missed (an extension throws
// mid-pass and never emits GENERATION_ENDED), a stuck flag would deadlock our
// post-gen forever. We stamp the last capture time and treat the flag as stale
// after this many ms, matching the spirit of the lifecycle's streaming-wait
// deadline (gameplan fix #4).
const STALE_CEILING_MS = 45000;
let lastCaptureAt = 0;

/**
 * Mark that SuperAgents itself is about to drive a generation (a sidecar /
 * pre-gen / rewrite LLM call). While this is set, foreign-generation tracking
 * ignores the resulting lifecycle events so we never defer against our own work.
 * The lifecycle wraps its own LLM-driving sections with begin/endSelfGeneration.
 */
export function beginSelfGeneration() {
    selfGenerationDepth++;
}

export function endSelfGeneration() {
    selfGenerationDepth = Math.max(0, selfGenerationDepth - 1);
}

/**
 * @returns {boolean} true if a generation NOT initiated by SuperAgents is
 * currently in flight (and the flag hasn't gone stale).
 */
export function isExternalGenerationActive() {
    if (externalGenDepth <= 0) return false;
    // Stale-flag safety net: a missed END event can't wedge us permanently.
    if (lastCaptureAt && (Date.now() - lastCaptureAt) > STALE_CEILING_MS) {
        debug(`${LOG_PREFIX} external-gen flag went stale (${STALE_CEILING_MS}ms); clearing`);
        externalGenDepth = 0;
        return false;
    }
    return true;
}

/** Current foreign-generation nesting depth (debug/introspection). */
export function getExternalGenerationDepth() {
    return externalGenDepth;
}

function onGenerationStarted() {
    // A generation began. If it's ours, ignore — our own sidecar/pre-gen calls
    // are bracketed by beginSelfGeneration() and must not count as foreign.
    if (selfGenerationDepth > 0) return;
    externalGenDepth++;
    lastCaptureAt = Date.now();
    debug(`${LOG_PREFIX} external generation captured (depth=${externalGenDepth})`);
}

function onGenerationSettled(reason) {
    if (selfGenerationDepth > 0) return;
    if (externalGenDepth > 0) {
        externalGenDepth--;
        debug(`${LOG_PREFIX} external generation ${reason} (depth=${externalGenDepth})`);
    }
    if (externalGenDepth <= 0) {
        externalGenDepth = 0;
        lastCaptureAt = 0;
    }
}

/**
 * Bind the coexistence listeners. Called once from index.js, BEFORE
 * initLifecycle so the guard is live before any post-gen work can run.
 */
export function initCompatibility() {
    if (initialized) return;
    initialized = true;
    eventSource.on(event_types.GENERATION_STARTED, onGenerationStarted);
    eventSource.on(event_types.GENERATION_ENDED, onGenerationEnded);
    eventSource.on(event_types.GENERATION_STOPPED, onGenerationStopped);

    debug(`${LOG_PREFIX} compatibility guard initialized (watching for: ${KNOWN_DRIVERS.join(', ')})`);
}

/** Reset all coexistence state. Used on unload / re-init. */
export function destroyCompatibility() {
    if (initialized) {
        eventSource.removeListener(event_types.GENERATION_STARTED, onGenerationStarted);
        eventSource.removeListener(event_types.GENERATION_ENDED, onGenerationEnded);
        eventSource.removeListener(event_types.GENERATION_STOPPED, onGenerationStopped);
    }
    initialized = false;
    externalGenDepth = 0;
    selfGenerationDepth = 0;
    lastCaptureAt = 0;
}

function onGenerationEnded() {
    onGenerationSettled('ended');
}

function onGenerationStopped() {
    onGenerationSettled('stopped');
}
