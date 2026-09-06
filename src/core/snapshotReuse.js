/** Restore branch-aware memory for cadence-skipped, reference-only agents. */

import {
    chat,
    chat_metadata,
    saveChatDebounced,
} from '../../../../../../script.js';
import {
    resolveStateTraceDetailed,
    writeMergeArray,
} from '../modes/mergeVariable.js';
import { SUPERAGENTS_EVENTS } from '../integration/events.js';

function parseStoredArray(raw) {
    if (typeof raw !== 'string') return null;
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

function resolveReusableSnapshot(variableName, lastIndex, swipeId) {
    const trace = resolveStateTraceDetailed(chat, lastIndex, swipeId, variableName);
    if (trace.items !== null) return trace;

    // Legacy/system-marked messages are intentionally skipped by the branch
    // tracer. Prefer a non-empty live value, then the frozen turn baseline that
    // swipe/regenerate already treats as the authoritative pre-turn state.
    const live = parseStoredArray(chat_metadata?.variables?.[variableName]);
    if (live?.length) return { items: live, distance: Infinity, foundIndex: -1 };
    const baseline = parseStoredArray(chat_metadata?.saAgentBaseline?.[variableName]);
    if (baseline !== null) return { items: baseline, distance: Infinity, foundIndex: -1 };
    if (live !== null) return { items: live, distance: Infinity, foundIndex: -1 };
    return trace;
}

function emitSnapshotReused(agent, trace) {
    if (typeof globalThis.dispatchEvent !== 'function' || typeof CustomEvent !== 'function') return;
    globalThis.dispatchEvent(new CustomEvent(SUPERAGENTS_EVENTS.SNAPSHOT_REUSED, {
        detail: {
            agentId: agent.id,
            agentName: agent.name,
            variableName: agent.mergeVariable.variableName,
            messageIndex: trace.foundIndex,
            distance: trace.distance,
            source: 'cadence_snapshot_reuse',
        },
    }));
}

/**
 * Restore each skipped agent's most recent snapshot on the visible branch.
 * The event lets integrations refresh before the main request is assembled.
 */
export function restoreRetainedSnapshots(agents = []) {
    const lastIndex = chat.length - 1;
    if (lastIndex < 0) return [];

    const restored = [];
    let changed = false;
    for (const agent of agents) {
        const variableName = agent?.mergeVariable?.variableName;
        if (!variableName) continue;
        const swipeId = chat[lastIndex]?.swipe_id ?? 0;
        const trace = resolveReusableSnapshot(variableName, lastIndex, swipeId);
        if (trace.items === null) continue;

        const serialized = JSON.stringify(trace.items);
        if (chat_metadata?.variables?.[variableName] !== serialized) {
            writeMergeArray(variableName, trace.items);
            changed = true;
        }
        restored.push(agent.id);
        emitSnapshotReused(agent, trace);
    }

    if (changed) saveChatDebounced();
    return restored;
}
