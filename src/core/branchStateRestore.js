/** Restore live tracker variables after the chat tail is deleted. */

import { chat, chat_metadata, saveChatDebounced } from '../../../../../../script.js';
import { getAgents } from '../data/store.js';
import { SUPERAGENTS_EVENTS } from '../integration/events.js';
import { resolveStateTraceDetailed, writeMergeArray } from '../modes/mergeVariable.js';
import { getUtilityAnalysisVariables } from './utilityAnalysis.js';

export function restoreStateAfterMessageDeletion() {
    const variableNames = new Set(
        getAgents().map(agent => agent.mergeVariable?.variableName).filter(Boolean),
    );
    for (const name of getUtilityAnalysisVariables()) variableNames.add(name);
    for (const name of Object.keys(chat_metadata?.saAgentBaseline || {})) variableNames.add(name);

    const lastIndex = chat.length - 1;
    const lastSwipe = chat[lastIndex]?.swipe_id ?? 0;
    const baselineIndex = lastIndex >= 0 && !chat[lastIndex]?.is_user && !chat[lastIndex]?.is_system
        ? lastIndex - 1
        : lastIndex;
    let changed = false;

    for (const name of variableNames) {
        const trace = lastIndex >= 0
            ? resolveStateTraceDetailed(chat, lastIndex, lastSwipe, name)
            : { items: null };
        const serialized = JSON.stringify(trace.items ?? []);
        if (chat_metadata?.variables?.[name] !== serialized) {
            writeMergeArray(name, trace.items ?? []);
            changed = true;
            if (typeof globalThis.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
                globalThis.dispatchEvent(new CustomEvent(SUPERAGENTS_EVENTS.SNAPSHOT_REUSED, {
                    detail: {
                        variableName: name,
                        messageIndex: lastIndex,
                        source: 'message_deletion_restore',
                    },
                }));
            }
        }

        if (Object.prototype.hasOwnProperty.call(chat_metadata?.saAgentBaseline || {}, name)) {
            const prior = baselineIndex >= 0
                ? resolveStateTraceDetailed(chat, baselineIndex, chat[baselineIndex]?.swipe_id ?? 0, name).items
                : null;
            const baseline = prior === null ? null : JSON.stringify(prior);
            if (chat_metadata.saAgentBaseline[name] !== baseline) {
                chat_metadata.saAgentBaseline[name] = baseline;
                changed = true;
            }
        }
    }

    if (changed) saveChatDebounced();
    return changed;
}
