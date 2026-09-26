/**
 * modes/mergeVariable.js — structured data extraction, storage, and formatting.
 *
 * Merge variables are chat-local JSON arrays stored in chat_metadata.variables.
 * Agents can extract structured data from message text (or sidecar LLM
 * responses) and accumulate/snapshot it over the conversation. The formatted
 * state is injected back into the LLM context for continuity.
 *
 * Two modes:
 *   - snapshot: replace the entire array each turn
 *   - accumulate: add/update/resolve items over time (keyed merge)
 *
 * Ported from VerseManager's runner.js — was inline there, now its own module.
 */

import {
    chat,
    chat_metadata,
    substituteParams,
    saveChatDebounced,
} from '../../../../../../script.js';
import { debug } from '../core/runtime.js';
import { recordAgentRun } from '../core/idempotency.js';
import { validateMergeItems } from '../data/stateValidation.js';
import { canonicalizeMergeItems } from '../data/stateCanonicalization.js';
import { applyStateRetention } from '../data/stateRetention.js';
import { projectItemsForMainContext } from '../data/mainContextProjection.js';
import { renderMainContextTemplate } from '../data/mainContextTemplate.js';
import { extractJsonObjectCandidates } from '../data/structuredOutput.js';
import {
    getActivePersonaName,
    getConfiguredParticipantExclusion,
    projectActivePersona,
} from '../core/participants.js';
import { emitStateTransaction } from '../integration/events.js';
import { clearActivationPolicyState, markActivationPolicyComplete } from '../core/activationPolicy.js';

const LOG_PREFIX = '[SuperAgents/mergeVar]';
const INHERITED_SNAPSHOT_VERSION = 1;
const INHERITED_SNAPSHOT_SEARCH_LIMIT = 100;

function isInheritedSnapshot(value) {
    return !Array.isArray(value)
        && value?.saInheritedSnapshot === INHERITED_SNAPSHOT_VERSION;
}

function sameItems(left, right) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    const stable = value => JSON.stringify(value, (key, item) => (
        key === '_addedAt' || key === '_messageIndex' ? undefined : item
    ));
    try { return stable(left) === stable(right); } catch { return false; }
}

// ============================================================================
// READ / WRITE
// ============================================================================

/**
 * Read a JSON array from a chat-local variable.
 * @param {string} varName
 * @returns {object[]}
 */
export function readMergeArray(varName) {
    try {
        const raw = chat_metadata?.variables?.[varName];
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

/**
 * Write a JSON array to a chat-local variable.
 * @param {string} varName
 * @param {object[]} arr
 */
export function writeMergeArray(varName, arr) {
    if (!chat_metadata.variables) chat_metadata.variables = {};
    chat_metadata.variables[varName] = JSON.stringify(arr);
}

/**
 * Wipe ALL chat-local state for one agent from the CURRENT chat: the live merge
 * variable, its turn baseline, every per-swipe snapshot on every message, and
 * the agent's per-message transaction log. Used by /sa-clear — e.g. when a
 * schema change leaves stale fields behind (relationship meters lingering in a
 * repurposed tracker) or to reset a tracker mid-chat. The agent stays enabled;
 * the next generation repopulates fresh state. Persists via saveChatDebounced.
 * @param {object} agent
 * @returns {{variableName:string, messagesTouched:number, hadLiveValue:boolean}}
 */
export function clearAgentChatState(agent) {
    const varName = agent?.mergeVariable?.variableName || '';
    const agentId = agent?.id || '';
    let hadLiveValue = false;
    let messagesTouched = 0;
    const policyCleared = clearActivationPolicyState(agent);

    if (varName && chat_metadata?.variables && varName in chat_metadata.variables) {
        delete chat_metadata.variables[varName];
        hadLiveValue = true;
    }
    if (varName && chat_metadata?.saAgentBaseline && varName in chat_metadata.saAgentBaseline) {
        delete chat_metadata.saAgentBaseline[varName];
    }

    for (const message of (chat || [])) {
        if (!message || typeof message !== 'object') continue;
        let touched = false;
        if (varName && message.saAgentSwipes && varName in message.saAgentSwipes) {
            delete message.saAgentSwipes[varName];
            if (Object.keys(message.saAgentSwipes).length === 0) delete message.saAgentSwipes;
            touched = true;
        }
        if (varName && message.saAgentMessageState && varName in message.saAgentMessageState) {
            delete message.saAgentMessageState[varName];
            if (Object.keys(message.saAgentMessageState).length === 0) delete message.saAgentMessageState;
            touched = true;
        }
        if (agentId && message.saAgentStateTransactions && agentId in message.saAgentStateTransactions) {
            delete message.saAgentStateTransactions[agentId];
            if (Object.keys(message.saAgentStateTransactions).length === 0) delete message.saAgentStateTransactions;
            touched = true;
        }
        if (touched) messagesTouched++;
    }

    saveChatDebounced();
    debug(`${LOG_PREFIX} cleared chat state for "${agent?.name}" (${varName}): live=${hadLiveValue}, messages=${messagesTouched}`);
    return { variableName: varName, messagesTouched, hadLiveValue, policyCleared };
}

function removeCollectionRecordFromItems(items, jsonField, collectionPath, recordId) {
    if (!Array.isArray(items) || !jsonField || !collectionPath || !recordId) {
        return { items, removed: false };
    }
    let removed = false;
    const path = collectionPath.split('.').filter(Boolean);
    const nextItems = items.map(item => {
        if (!item || typeof item !== 'object' || typeof item[jsonField] !== 'string') return item;
        try {
            const logical = JSON.parse(item[jsonField]);
            let collection = logical;
            for (const part of path) collection = collection?.[part];
            if (!collection || typeof collection !== 'object'
                || !Object.prototype.hasOwnProperty.call(collection, recordId)) return item;
            delete collection[recordId];
            const nextItem = { ...item, [jsonField]: JSON.stringify(logical) };
            const retention = item?._retention?.[collectionPath];
            if (retention && typeof retention === 'object') {
                const nextRetention = { ...retention };
                delete nextRetention[recordId];
                nextItem._retention = {
                    ...(item._retention || {}),
                    [collectionPath]: nextRetention,
                };
            }
            removed = true;
            return nextItem;
        } catch {
            return item;
        }
    });
    return { items: nextItems, removed };
}

/** Remove one keyed record from an agent's live value, baseline, and all branch snapshots. */
export function removeCollectionRecordFromAgentChatState(agent, collectionPath, recordId) {
    const varName = agent?.mergeVariable?.variableName || '';
    const jsonField = agent?.mergeVariable?.validation?.jsonField
        || agent?.mergeVariable?.fieldNames?.[0]
        || '';
    const cleanPath = String(collectionPath || '').trim();
    const cleanId = String(recordId || '').trim();
    if (!varName || !jsonField || !cleanPath || !cleanId) {
        return { variableName: varName, recordId: cleanId, removed: false, messagesTouched: 0 };
    }

    let removed = false;
    let messagesTouched = 0;

    const liveResult = removeCollectionRecordFromItems(
        readMergeArray(varName), jsonField, cleanPath, cleanId,
    );
    if (liveResult.removed) {
        writeMergeArray(varName, liveResult.items);
        removed = true;
    }

    const baseline = chat_metadata?.saAgentBaseline?.[varName];
    if (typeof baseline === 'string') {
        try {
            const baselineItems = JSON.parse(baseline);
            const baselineResult = removeCollectionRecordFromItems(
                baselineItems, jsonField, cleanPath, cleanId,
            );
            if (baselineResult.removed) {
                chat_metadata.saAgentBaseline[varName] = JSON.stringify(baselineResult.items);
                removed = true;
            }
        } catch { /* A malformed baseline remains untouched. */ }
    }

    for (const message of (chat || [])) {
        const snapshots = message?.saAgentSwipes?.[varName];
        if (!snapshots || typeof snapshots !== 'object') continue;
        let messageTouched = false;
        for (const [swipeId, items] of Object.entries(snapshots)) {
            const result = removeCollectionRecordFromItems(items, jsonField, cleanPath, cleanId);
            if (!result.removed) continue;
            snapshots[swipeId] = result.items;
            messageTouched = true;
            removed = true;
        }
        if (messageTouched) messagesTouched++;
    }

    if (removed) {
        saveChatDebounced();
        emitStateTransaction(true, {
            agentId: agent?.id || '',
            agentName: agent?.name || '',
            variableName: varName,
            messageIndex: -1,
            swipeId: -1,
            source: 'manual_record_delete',
            collectionPath: cleanPath,
            recordId: cleanId,
            errors: [],
        });
        debug(`${LOG_PREFIX} removed ${cleanPath}.${cleanId} from "${agent?.name}" across ${messagesTouched} message(s)`);
    }

    return { variableName: varName, recordId: cleanId, removed, messagesTouched };
}

// ============================================================================
// PER-TURN MEMORY BASELINE (swipe / regenerate correctness)
// ============================================================================

/**
 * Freeze the value a turn feeds back into itself. A fresh turn captures the
 * current live value — the previous turn's committed output, already synced to
 * whatever swipe was active — as this turn's baseline. Every swipe/regenerate
 * of the same turn then restores it, so each re-roll injects the SAME previous
 * value instead of the discarded attempt's output.
 *
 * Baseline lives in chat_metadata (NOT on the message) so it survives
 * regenerate popping the last message. Stored as the raw JSON string (matching
 * chat_metadata.variables), or null when the var was empty at capture time.
 * @param {string} varName
 */
export function captureTurnBaseline(varName) {
    if (!varName) return;
    if (!chat_metadata.saAgentBaseline) chat_metadata.saAgentBaseline = {};
    chat_metadata.saAgentBaseline[varName] = chat_metadata?.variables?.[varName] ?? null;
    saveChatDebounced();
}

/**
 * Restore a var to this turn's frozen baseline before a re-roll's pre-gen reads
 * it. No-op if nothing was frozen (leave the live value as-is); a null baseline
 * means "was empty," so the live var is cleared back to empty.
 * @param {string} varName
 */
export function restoreTurnBaseline(varName) {
    if (!varName) return;
    const base = chat_metadata?.saAgentBaseline?.[varName];
    if (base === undefined) return;
    if (base === null) {
        if (chat_metadata.variables) delete chat_metadata.variables[varName];
        return;
    }
    if (!chat_metadata.variables) chat_metadata.variables = {};
    chat_metadata.variables[varName] = base;
}

// ============================================================================
// FORMAT FOR LLM INJECTION
// ============================================================================

/**
 * Project one stored item's JSON blob down to the active persona's slice.
 * The persona-keyed blob lives (stringified) in the item's json field; parse it,
 * project via participants.projectActivePersona, and re-stringify in place. On
 * any parse failure or non-string field the item passes through untouched, so
 * this is safe on legacy (non-persona) blobs and malformed data alike.
 * @param {object} item
 * @param {string} jsonField
 * @returns {object}
 */
function projectItemToActivePersona(item, jsonField) {
    try {
        const raw = item?.[jsonField];
        if (typeof raw !== 'string') return item;
        const projected = projectActivePersona(JSON.parse(raw));
        return { ...item, [jsonField]: JSON.stringify(projected) };
    } catch {
        return item;
    }
}

/**
 * Format the current merge variable state as readable text for LLM injection.
 * Tracker continuity uses the top-level format fields. Main-model injection may
 * provide read-only wording through mainContext format overrides.
 *
 * When the caller consumes this for the MAIN model (chat injection or a
 * user-placed macro), pass `{ projectPersona: true }`. For a persona-scoped
 * variable (e.g. the Relationship Ledger) that projects each stored blob down to
 * the ACTIVE persona's slice before formatting, so the main model only ever sees
 * the current persona's relationships — mirroring what DE and the State Card get.
 * The tracker's OWN self-continuity feed leaves this false so it still sees every
 * persona and never drops the inactive ones when it writes back.
 *
 * @param {object} config - agent.mergeVariable
 * @param {{ projectPersona?: boolean }} [options]
 * @returns {string}
 */
export function formatMergeVariableData(config, { projectPersona = false } = {}) {
    let arr = readMergeArray(config.variableName);
    const activePersonaName = projectPersona
        ? (getActivePersonaName() || 'active persona')
        : '';
    const mainFormat = projectPersona ? config.mainContext : null;
    const formatHeader = typeof mainFormat?.formatHeader === 'string'
        ? mainFormat.formatHeader
        : config.formatHeader;
    const formatItem = typeof mainFormat?.formatItem === 'string'
        ? mainFormat.formatItem
        : config.formatItem;
    const formatEmpty = typeof mainFormat?.formatEmpty === 'string'
        ? mainFormat.formatEmpty
        : config.formatEmpty;

    if (projectPersona && config.personaScoped) {
        const jsonField = config.validation?.jsonField || config.fieldNames?.[0] || 'json';
        arr = arr.map(item => projectItemToActivePersona(item, jsonField));
    }

    if (projectPersona) {
        const jsonField = config.validation?.jsonField || config.fieldNames?.[0] || 'json';
        arr = projectItemsForMainContext(arr, config.mainContext, jsonField);
    }

    if (arr.length === 0) {
        if (!formatEmpty) return '';
        return formatHeader
            ? `${formatHeader}\n${formatEmpty}`
            : formatEmpty;
    }

    const lines = arr.map(item => {
        if (projectPersona && typeof mainFormat?.formatItem === 'string') {
            return renderMainContextTemplate(formatItem, {
                ...item,
                user: activePersonaName,
            });
        }
        let line = formatItem;
        for (const field of config.fieldNames) {
            const val = item[field] ?? '';
            // Handle arrays (like knownBy) gracefully
            const display = Array.isArray(val) ? val.join(', ') : String(val);
            line = line.replaceAll(`{{${field}}}`, display);
        }
        return line;
    });

    return formatHeader
        ? `${formatHeader}\n${lines.join('\n')}`
        : lines.join('\n');
}

// ============================================================================
// PER-SWIPE STORAGE HELPER
// ============================================================================

/**
 * Store items in per-swipe storage so swipe navigation can restore them.
 *
 * IMPORTANT: this lives at the TOP LEVEL of the message object (message.saAgentSwipes),
 * NOT inside message.extra. ST snapshots and restores `extra` per swipe via
 * structuredClone (syncMesToSwipe/syncSwipeToMes), so anything stored under
 * extra gets shadowed by a stale per-swipe clone and reads back the wrong
 * swipe's data. A sibling key on the message is untouched by swipe sync and
 * still persists to the chat JSONL.
 * @param {object} message - chat[n]
 * @param {string} varName - merge variable name
 * @param {object[]} items - the items to store
 * @param {{messageIndex?:number, allowInherit?:boolean}} [options]
 */
function storePerSwipe(message, varName, items, options = {}) {
    const swipeId = message.swipe_id ?? 0;
    if (!message.saAgentSwipes) message.saAgentSwipes = {};
    if (!message.saAgentSwipes[varName]) message.saAgentSwipes[varName] = {};
    let stored = items;
    const messageIndex = Number(options.messageIndex);
    if (options.allowInherit && items.length > 0 && Number.isInteger(messageIndex) && messageIndex > 0) {
        const priorIndex = messageIndex - 1;
        const priorSwipe = chat[priorIndex]?.swipe_id ?? 0;
        const prior = resolveStateTraceDetailed(
            chat,
            priorIndex,
            priorSwipe,
            varName,
            { maxDistance: INHERITED_SNAPSHOT_SEARCH_LIMIT },
        );
        if (prior.foundIndex >= 0 && sameItems(items, prior.items)) {
            stored = {
                saInheritedSnapshot: INHERITED_SNAPSHOT_VERSION,
                messageIndex: prior.foundIndex,
                swipeId: chat[prior.foundIndex]?.swipe_id ?? 0,
                addedAt: items.at(-1)?._addedAt ?? null,
                stateMessageIndex: items.at(-1)?._messageIndex ?? messageIndex,
            };
        }
    }
    message.saAgentSwipes[varName][swipeId] = stored;
}

function storeStateTransaction(agent, message, messageIndex, source, result, proposedItems) {
    if (!message || !agent?.id) return;
    const swipeId = message.swipe_id ?? 0;
    if (!message.saAgentStateTransactions) message.saAgentStateTransactions = {};
    if (!message.saAgentStateTransactions[agent.id]) {
        message.saAgentStateTransactions[agent.id] = {};
    }
    message.saAgentStateTransactions[agent.id][swipeId] = {
        status: result.valid ? 'committed' : 'rejected',
        timestamp: Date.now(),
        messageIndex,
        swipeId,
        source,
        variableName: agent.mergeVariable?.variableName || '',
        agentVersion: agent.version ?? 1,
        schemaVersion: agent.mergeVariable?.validation?.schemaVersion ?? null,
        validationEnabled: Boolean(agent.mergeVariable?.validation?.enabled),
        errors: result.errors ?? [],
        previousValuePreserved: !result.valid,
        committedItemCount: result.valid ? result.items?.length ?? 0 : 0,
        // Keep rejected proposals for diagnostics. Successful state already
        // lives in saAgentSwipes, so duplicating it here would only bloat chat.
        proposedItems: result.valid ? undefined : proposedItems,
    };
}

export function getStateTransaction(message, agentId, swipeId = message?.swipe_id ?? 0) {
    return message?.saAgentStateTransactions?.[agentId]?.[swipeId] ?? null;
}

/** Validate and atomically commit a complete merge-variable state. */
function commitMergeItems(agent, message, messageIndex, proposedItems, source) {
    const mv = agent.mergeVariable;
    if (typeof agent.utilityAnalysis?.isCurrent === 'function'
        && !agent.utilityAnalysis.isCurrent()) {
        debug(`${LOG_PREFIX} discarded stale utility result for "${agent.name}"`);
        return { committed: false, items: null, errors: ['Utility task context changed before commit.'] };
    }
    const previousItems = readMergeArray(mv.variableName);
    const canonicalItems = canonicalizeMergeItems(proposedItems, mv.validation);
    const result = validateMergeItems(canonicalItems, mv.validation, { previousItems });
    storeStateTransaction(agent, message, messageIndex, source, result, proposedItems);

    const eventDetail = {
        agentId: agent.id,
        agentName: agent.name,
        variableName: mv.variableName,
        messageIndex,
        swipeId: message?.swipe_id ?? 0,
        source,
        agentVersion: agent.version ?? 1,
        schemaVersion: mv.validation?.schemaVersion ?? null,
        errors: result.errors ?? [],
    };

    if (!result.valid) {
        emitStateTransaction(false, eventDetail);
        console.warn(
            `${LOG_PREFIX} Rejected invalid state for "${agent.name}"; previous value preserved:`,
            result.errors,
        );
        // Rejected transactions are still useful branch history. Sidecar
        // callers return null and therefore do not necessarily trigger the
        // lifecycle's normal save path, so persist the audit record here.
        if (message) saveChatDebounced();
        return { committed: false, items: null, errors: result.errors };
    }

    const retentionOptions = {
        previousItems,
        jsonField: mv.validation?.jsonField,
    };
    // Opt-in participant exclusion (e.g. Active Roster): never persist a player
    // persona or explicitly excluded name as a tracked entry. Requires retention
    // (the exclusion runs inside applyStateRetention, alongside the collection it
    // filters); the flag lives on retention config for exactly that reason.
    const participantExclusion = getConfiguredParticipantExclusion(mv.retention);
    if (participantExclusion.normSet.size) retentionOptions.excludeNames = participantExclusion.normSet;
    const committedItems = applyStateRetention(result.items, mv.retention, retentionOptions);
    writeMergeArray(mv.variableName, committedItems);
    if (message) {
        storePerSwipe(message, mv.variableName, committedItems, {
            messageIndex,
            // Episodic displays require an owned array on the exact swipe.
            allowInherit: agent.sidecarCall?.display?.inheritState !== false,
        });
    }
    markActivationPolicyComplete(agent);
    emitStateTransaction(true, eventDetail);
    return { committed: true, items: committedItems, errors: [] };
}

/**
 * Public wrapper: bind a merge variable's current value to a message's active
 * swipe. Used by the pre-gen display path (lifecycle), where the agent's output
 * was written to the chat variable before the bot message existed, so per-swipe
 * storage couldn't be set at write time. Reads the variable and pins it to the
 * now-rendered message's swipe so it survives swipe navigation.
 *
 * @param {object} message - chat[n]
 * @param {string} varName
 */
export function bindVariableToSwipe(message, varName) {
    if (!message || !varName) return;
    const items = readMergeArray(varName);
    storePerSwipe(message, varName, items);
}

/**
 * Pin author-controlled state to the message rather than one sibling swipe.
 * Generated tracker outputs remain in saAgentSwipes; this small override is for
 * local UtilityApp decisions that should survive swiping the same story turn.
 */
export function bindVariableToMessage(message, varName) {
    if (!message || !varName) return;
    if (!message.saAgentMessageState) message.saAgentMessageState = {};
    message.saAgentMessageState[varName] = readMergeArray(varName);
}

// ============================================================================
// BACKWARD STATE TRACE (swipe-awareness read path)
// ============================================================================

/**
 * Resolve the state that should be shown/injected for a given message + swipe
 * by walking BACKWARD through the chat to the most recent tracked snapshot.
 *
 * The rule (user's mental model): show the state for the message you're looking
 * at; if that swipe never tracked its own state, walk back to the last message/
 * swipe that did, following the branch you're actually viewing up-thread.
 *
 *   1. If the current message+swipe has its OWN per-swipe record → return it.
 *      An empty array ([]) is a real "tracked, deliberately empty" answer and
 *      STOPS the walk — it is distinct from an absent key ("not tracked here").
 *   2. No own record → step to the previous message, using THAT message's
 *      currently-active swipe_id (follow the visible branch), and repeat.
 *   3. User/system messages carry no state → transparent, keep walking past them.
 *   4. Reached the top of chat with nothing found → return null (honest empty;
 *      callers render "no state yet" rather than showing a stale value).
 *
 * Absence vs empty is trustworthy because storePerSwipe only writes a key when
 * an extraction actually happened (see storePerSwipe / storeSidecarResult).
 *
 * Iterative (not recursive) so a long chat can't blow the stack.
 *
 * @param {object[]} chat - the live chat array (chat[n])
 * @param {number} messageIndex - where to start the walk
 * @param {number} swipeId - the active swipe at the start message
 * @param {string} varName - merge variable name (e.g. 'sa_state_card')
 * @returns {object[]|null} the resolved items array, or null if none exists
 *          anywhere down the trace.
 */
export function resolveStateTrace(chat, messageIndex, swipeId, varName) {
    return resolveStateTraceDetailed(chat, messageIndex, swipeId, varName).items;
}

/**
 * Same walk as resolveStateTrace, but also reports HOW FAR BACK the state was
 * found — the "staleness distance." distance 0 means the starting message+swipe
 * had its own record; a larger number is how many messages back the walk had to
 * reach. Callers (e.g. the State Card panel) use this to apply a staleness
 * horizon: hold recent state through a transient empty gen, but show honest
 * empty once the last real state is too far back to trust.
 *
 * @param {object[]} chat
 * @param {number} messageIndex
 * @param {number} swipeId
 * @param {string} varName
 * @param {{maxDistance?:number}|number} [options] optional message-hop ceiling
 * @returns {{ items: object[]|null, distance: number, foundIndex: number }}
 *          items:      resolved array, or null if nothing anywhere down-trace.
 *          distance:   message hops from the start to where state was found
 *                      (0 = own record; Infinity when items is null).
 *          foundIndex: chat index the state came from (-1 when null).
 */
export function resolveStateTraceDetailed(chat, messageIndex, swipeId, varName, options = {}) {
    const MISS = { items: null, distance: Infinity, foundIndex: -1 };
    if (!Array.isArray(chat) || !varName) return MISS;

    const startIdx = Number(messageIndex);
    const requestedMax = typeof options === 'number' ? options : options?.maxDistance;
    const maxDistance = Number.isFinite(Number(requestedMax))
        ? Math.max(0, Number(requestedMax))
        : Infinity;
    let idx = startIdx;
    let swipe = Number(swipeId) || 0;
    let inheritedDistance = null;
    let inheritedMeta = null;
    const withInheritedMeta = items => {
        if (!inheritedMeta || !Array.isArray(items)) return items;
        return items.map(item => item && typeof item === 'object' ? {
            ...item,
            _addedAt: inheritedMeta.addedAt ?? item._addedAt,
            _messageIndex: inheritedMeta.stateMessageIndex ?? item._messageIndex,
        } : item);
    };

    // Bound the walk to the chat length as a belt-and-suspenders guard against
    // any pathological cycle (indices only ever decrease, so this can't loop,
    // but the explicit ceiling documents the intent).
    let steps = chat.length + 1;

    while (idx >= 0 && steps-- > 0) {
        if (inheritedDistance === null && (startIdx - idx) > maxDistance) return MISS;
        const message = chat[idx];
        if (!message) return MISS;

        // User/system turns never carry state — walk past them transparently,
        // following their own active swipe (almost always 0).
        if (message.is_user || message.is_system) {
            idx -= 1;
            swipe = idx >= 0 ? (chat[idx]?.swipe_id ?? 0) : 0;
            continue;
        }

        const messageState = message.saAgentMessageState?.[varName];
        if (messageState !== undefined) {
            return {
                items: withInheritedMeta(messageState ?? []),
                distance: Math.max(0, startIdx - idx),
                foundIndex: idx,
            };
        }

        const rec = message.saAgentSwipes?.[varName];
        if (rec && Object.prototype.hasOwnProperty.call(rec, swipe)) {
            if (isInheritedSnapshot(rec[swipe])) {
                if (inheritedDistance === null) inheritedDistance = Math.max(0, startIdx - idx);
                if (!inheritedMeta) inheritedMeta = rec[swipe];
                const targetIndex = Number(rec[swipe].messageIndex);
                if (Number.isInteger(targetIndex) && targetIndex >= 0 && targetIndex < idx) {
                    idx = targetIndex;
                    swipe = Number(rec[swipe].swipeId) || 0;
                } else {
                    idx -= 1;
                    swipe = idx >= 0 ? (chat[idx]?.swipe_id ?? 0) : 0;
                }
                continue;
            }
            // Own record for this swipe — this is the answer, even if [].
            return {
                items: withInheritedMeta(rec[swipe] ?? []),
                distance: inheritedDistance ?? Math.max(0, startIdx - idx),
                foundIndex: idx,
            };
        }

        // No record on this swipe → step back to the previous message's
        // currently-active swipe (follow the branch being viewed up-thread).
        idx -= 1;
        swipe = idx >= 0 ? (chat[idx]?.swipe_id ?? 0) : 0;
    }

    return MISS;
}

/**
 * COLLECT-N sibling of resolveStateTrace: walk BACKWARD from a start point and
 * gather up to `maxCount` tracked states, each read from its own message's
 * currently-active swipe. This is the read path behind agent "self-memory" —
 * a planner (e.g. the Director) seeing its own last few outputs so it can
 * advance the scene instead of restating.
 *
 * It reuses resolveStateTrace's walk discipline VERBATIM in spirit — same
 * swipe-awareness rule (read each message's active swipe, follow the visible
 * branch up-thread), same transparent skip of user/system turns, same
 * iterative/bounded stack safety. TWO DELIBERATE DIVERGENCES from the single-
 * answer walk, both because "recent memory" wants a list, not one resolved
 * value:
 *   1. It does NOT stop at the first hit — it pushes each hit and keeps walking
 *      until it has `maxCount` items or runs out of chat.
 *   2. A tracked-empty record ([]) does NOT stop the walk and is NOT collected.
 *      For the single-answer trace, [] is a real "deliberately empty" answer and
 *      halts the walk; for a memory list an empty plan adds nothing to show and
 *      shouldn't consume a slot or cut off older non-empty plans behind it. So
 *      empties are skipped transparently (walk continues past them).
 *
 * The start swipe is read from the start message itself when `startSwipeId` is
 * not supplied, so callers that only know an anchor INDEX (e.g. "end of chat"
 * at pre-gen time) don't need to resolve the active swipe themselves.
 *
 * @param {object[]} chat - the live chat array
 * @param {number} startIndex - where to begin the backward walk
 * @param {number|null} [startSwipeId] - active swipe at the start message;
 *        null/undefined → read chat[startIndex].swipe_id.
 * @param {string} varName - merge variable name (e.g. 'sa_director_plan')
 * @param {number} maxCount - how many states to collect (>=1)
 * @returns {object[][]} newest-first array of item-arrays (each a stored
 *          snapshot from one message's active swipe). Empty array if none found.
 */
export function collectRecentStates(chat, startIndex, startSwipeId, varName, maxCount) {
    const out = [];
    const cap = Math.max(0, Number(maxCount) || 0);
    if (!Array.isArray(chat) || !varName || cap === 0) return out;

    let idx = Number(startIndex);
    let swipe = (startSwipeId === null || startSwipeId === undefined)
        ? (chat[idx]?.swipe_id ?? 0)
        : (Number(startSwipeId) || 0);

    // Same belt-and-suspenders ceiling as resolveStateTraceDetailed: indices
    // only ever decrease, so this can't loop, but the bound documents intent.
    let steps = chat.length + 1;

    while (idx >= 0 && steps-- > 0 && out.length < cap) {
        const message = chat[idx];
        if (!message) break;

        // User/system turns never carry state — transparent, keep walking.
        if (message.is_user || message.is_system) {
            idx -= 1;
            swipe = idx >= 0 ? (chat[idx]?.swipe_id ?? 0) : 0;
            continue;
        }

        const messageState = message.saAgentMessageState?.[varName];
        if (messageState !== undefined) {
            if (Array.isArray(messageState) && messageState.length > 0) out.push(messageState);
            idx -= 1;
            swipe = idx >= 0 ? (chat[idx]?.swipe_id ?? 0) : 0;
            continue;
        }

        const rec = message.saAgentSwipes?.[varName];
        if (rec && Object.prototype.hasOwnProperty.call(rec, swipe)) {
            const items = rec[swipe] ?? [];
            if (isInheritedSnapshot(items)) {
                const targetIndex = Number(items.messageIndex);
                if (Number.isInteger(targetIndex) && targetIndex >= 0 && targetIndex < idx) {
                    idx = targetIndex;
                    swipe = Number(items.swipeId) || 0;
                    continue;
                }
            }
            // DIVERGENCE #2: skip tracked-empty rather than stopping on it; an
            // empty plan is nothing to show and must not cut off older plans.
            if (!isInheritedSnapshot(items) && Array.isArray(items) && items.length > 0) {
                out.push(items);
            }
        }

        // Step back to the previous message's active swipe (visible branch).
        idx -= 1;
        swipe = idx >= 0 ? (chat[idx]?.swipe_id ?? 0) : 0;
    }

    return out; // newest-first (start message's neighborhood first)
}

// ============================================================================
// REGEX BUILDER
// ============================================================================

/**
 * Build a RegExp from the agent's extractPattern (supports /pattern/flags
 * or plain string).
 * @param {string} pattern
 * @returns {RegExp|null}
 */
function buildExtractRegex(pattern) {
    try {
        const slashMatch = pattern.match(/^\/(.+)\/([gimsuy]*)$/);
        if (slashMatch) {
            // Force the global flag: both call sites use String.matchAll(), which
            // THROWS on a non-global RegExp. A user authoring a custom pattern as
            // /foo/ (no g) would otherwise crash extraction. Dedup so /foo/g stays
            // valid (no doubled flag).
            const flags = slashMatch[2].includes('g') ? slashMatch[2] : slashMatch[2] + 'g';
            return new RegExp(slashMatch[1], flags);
        }
        // Built-in tag names are protocol markers, not case-sensitive story
        // data. Accept harmless casing drift such as [World|...] while leaving
        // explicitly-authored /pattern/flags expressions under user control.
        return new RegExp(pattern, 'gis');
    } catch (err) {
        console.error(`${LOG_PREFIX} Invalid extractPattern:`, err);
        return null;
    }
}

// ============================================================================
// EXECUTE MERGE VARIABLE (from message.mes)
// ============================================================================

/**
 * Extract delta tags from a message, merge into the running variable array.
 * Handles add, update (by key match), and resolve (remove) actions.
 *
 * @param {object} agent
 * @param {object} message - chat[n]
 * @param {number} messageIndex
 * @returns {{ changed: boolean, added: number, updated: number, resolved: number }}
 */
export function executeMergeVariable(agent, message, messageIndex) {
    const mv = agent.mergeVariable;
    if (!mv?.enabled || !mv.extractPattern || !mv.variableName) {
        return { changed: false, added: 0, updated: 0, resolved: 0 };
    }

    const regex = buildExtractRegex(mv.extractPattern);
    if (!regex) {
        return { changed: false, added: 0, updated: 0, resolved: 0 };
    }

    const matches = [...message.mes.matchAll(regex)];
    if (matches.length === 0) {
        return { changed: false, added: 0, updated: 0, resolved: 0 };
    }

    // ── Snapshot mode: replace entire array with this turn's extractions ──
    if (mv.mode === 'snapshot') {
        const messageBeforeStrip = message.mes;
        const items = [];
        for (const match of matches) {
            const item = {};
            for (let i = 0; i < mv.fieldNames.length; i++) {
                item[mv.fieldNames[i]] = (match[i + 1] ?? '').trim();
            }
            item._addedAt = Date.now();
            item._messageIndex = messageIndex;
            items.push(item);
        }

        const commit = commitMergeItems(agent, message, messageIndex, items, 'inline_snapshot');

        if (mv.stripFromResponse) {
            message.mes = message.mes.replace(regex, '').trim();
        }
        const stripped = message.mes !== messageBeforeStrip;

        if (!commit.committed) {
            if (stripped) saveChatDebounced();
            return {
                changed: stripped,
                added: 0,
                updated: 0,
                resolved: 0,
                rejected: true,
                errors: commit.errors,
            };
        }

        debug(`${LOG_PREFIX} Merge variable "${mv.variableName}" (snapshot): replaced with ${commit.items.length} item(s)`);

        recordAgentRun(messageIndex, {
            agentId: agent.id,
            agentName: agent.name,
            phase: 'post',
            originalText: null,
            result: `Snapshot: ${commit.items.length} item(s)`,
            mode: 'merge_variable',
        });

        return { changed: true, added: commit.items.length, updated: 0, resolved: 0 };
    }

    // ── Accumulate mode (default): add / update / resolve logic ──
    const arr = readMergeArray(mv.variableName);
    let added = 0, updated = 0, resolved = 0;

    for (const match of matches) {
        const item = {};
        for (let i = 0; i < mv.fieldNames.length; i++) {
            item[mv.fieldNames[i]] = (match[i + 1] ?? '').trim();
        }

        // Check for resolve action
        if (mv.resolveField && mv.resolveAction) {
            const actionVal = item[mv.resolveField];
            if (actionVal && actionVal.toUpperCase() === mv.resolveAction.toUpperCase()) {
                const keyMatch = (existing) => mv.keyFields.every(
                    k => (existing[k] ?? '').toLowerCase() === (item[k] ?? '').toLowerCase(),
                );
                const idx = arr.findIndex(keyMatch);
                if (idx >= 0) {
                    arr.splice(idx, 1);
                    resolved++;
                }
                continue;
            }
        }

        // Find existing item by key fields
        const keyMatch = (existing) => mv.keyFields.every(
            k => (existing[k] ?? '').toLowerCase() === (item[k] ?? '').toLowerCase(),
        );
        const existingIdx = arr.findIndex(keyMatch);

        if (existingIdx >= 0) {
            // Update non-key fields on the existing item
            for (const field of mv.fieldNames) {
                if (mv.keyFields.includes(field)) continue;
                if (item[field]) {
                    const existing = arr[existingIdx][field];
                    if (Array.isArray(existing)) {
                        // Merge list values without duplicates
                        const newVals = item[field].split(/,\s*/).filter(Boolean);
                        for (const v of newVals) {
                            if (!existing.some(e => e.toLowerCase() === v.toLowerCase())) {
                                existing.push(v);
                            }
                        }
                    } else {
                        arr[existingIdx][field] = item[field];
                    }
                }
            }
            updated++;
        } else {
            item._addedAt = Date.now();
            item._messageIndex = messageIndex;
            arr.push(item);
            added++;
        }
    }

    const messageBeforeStrip = message.mes;
    // Strip tags from message if configured
    if (mv.stripFromResponse) {
        message.mes = message.mes.replace(regex, '').trim();
    }
    const stripped = message.mes !== messageBeforeStrip;

    const totalChanges = added + updated + resolved;
    const commit = commitMergeItems(agent, message, messageIndex, arr, 'inline_accumulate');
    if (!commit.committed) {
        if (stripped) saveChatDebounced();
        return {
            changed: stripped,
            added: 0,
            updated: 0,
            resolved: 0,
            rejected: true,
            errors: commit.errors,
        };
    }

    if (totalChanges > 0) {
        debug(`${LOG_PREFIX} Merge variable "${mv.variableName}": +${added} new, ~${updated} updated, -${resolved} resolved (${arr.length} total)`);

        recordAgentRun(messageIndex, {
            agentId: agent.id,
            agentName: agent.name,
            phase: 'post',
            originalText: null,
            result: `Merge: +${added} ~${updated} -${resolved} (${arr.length} total)`,
            mode: 'merge_variable',
        });
    }

    return { changed: totalChanges > 0, added, updated, resolved };
}

// ============================================================================
// SIDECAR RESULT STORAGE
// ============================================================================

/**
 * Extract data from a sidecar LLM response and store it directly,
 * bypassing message.mes entirely.
 *
 * Uses the agent's mergeVariable config for extraction pattern and storage
 * location, but operates on the raw LLM response instead of the message text.
 *
 * @param {object} agent
 * @param {string} response — raw LLM response text
 * @param {object} message — chat[n] (for per-swipe storage only, not modified)
 * @param {number} messageIndex
 * @returns {object[]|null} extracted items, or null on failure
 */
export function storeSidecarResult(agent, response, message, messageIndex) {
    const mv = agent.mergeVariable;
    if (!mv?.enabled || !mv.variableName) return null;

    // A plain custom sidecar may want to remember its complete answer rather
    // than forcing the user to invent a wrapper tag and regex. Batched sidecars
    // already support this shape; keeping the solo path equivalent prevents an
    // agent from changing behavior merely because it has no connection profile.
    if (!mv.extractPattern) {
        const value = String(response ?? '').trim();
        if (!value) return null;
        const field = mv.fieldNames?.[0] || 'text';
        const item = {
            [field]: value,
            _addedAt: Date.now(),
            _messageIndex: messageIndex,
        };
        const commit = commitMergeItems(agent, message, messageIndex, [item], 'sidecar');
        if (!commit.committed) return null;
        debug(`${LOG_PREFIX} Sidecar stored whole output to "${mv.variableName}"`);
        return commit.items;
    }

    const regex = buildExtractRegex(mv.extractPattern);
    if (!regex) return null;

    const matches = [...response.matchAll(regex)];
    if (matches.length === 0) {
        // Small structured classifiers sometimes return valid bare JSON (or
        // angle-bracket tags) despite being asked for a square-bracket wrapper.
        // For a validated one-field snapshot only, recover JSON candidates and
        // let the normal schema transaction be the hard acceptance boundary.
        const jsonField = mv.validation?.jsonField;
        const canRecoverJson = mv.mode === 'snapshot'
            && mv.validation?.enabled
            && mv.fieldNames?.length === 1
            && mv.fieldNames[0] === jsonField;
        if (canRecoverJson) {
            const candidates = extractJsonObjectCandidates(response);
            const previousItems = readMergeArray(mv.variableName);
            let rejectedCandidate = null;
            for (let index = candidates.length - 1; index >= 0; index--) {
                const item = {
                    [jsonField]: JSON.stringify(candidates[index]),
                    _addedAt: Date.now(),
                    _messageIndex: messageIndex,
                };
                const preview = validateMergeItems([item], mv.validation, { previousItems });
                if (!preview.valid) {
                    rejectedCandidate ??= item;
                    continue;
                }
                const commit = commitMergeItems(agent, message, messageIndex, [item], 'sidecar_json_fallback');
                if (commit.committed) {
                    debug(`${LOG_PREFIX} Sidecar recovered bare JSON for "${agent.name}"`);
                    return commit.items;
                }
            }
            // Preserve the normal rejected-transaction/repair path when JSON
            // was present but no candidate satisfied the schema.
            if (rejectedCandidate) {
                commitMergeItems(agent, message, messageIndex, [rejectedCandidate], 'sidecar_json_fallback');
            }
        }
        debug(`${LOG_PREFIX} Sidecar: no matches in LLM response for "${agent.name}"`);
        return null;
    }

    // Build items from regex capture groups
    const items = [];
    for (const match of matches) {
        const item = {};
        for (let i = 0; i < mv.fieldNames.length; i++) {
            item[mv.fieldNames[i]] = (match[i + 1] ?? '').trim();
        }
        item._addedAt = Date.now();
        item._messageIndex = messageIndex;
        items.push(item);
    }

    const commit = commitMergeItems(agent, message, messageIndex, items, 'sidecar');
    if (!commit.committed) return null;

    debug(`${LOG_PREFIX} Sidecar stored ${commit.items.length} item(s) to "${mv.variableName}"`);
    return commit.items;
}

/**
 * Store a batched sidecar result for a single agent.
 *
 * Unlike storeSidecarResult (which regex-extracts from the full response),
 * this receives the pre-extracted value from the JSON envelope and stores
 * it directly using the agent's mergeVariable config.
 *
 * @param {object} agent
 * @param {*} extractedValue — the value from envelope[responseKey]
 * @param {object} message — chat[n]
 * @param {number} messageIndex
 * @param {string} [source='sidecar_batch'] — transaction source for consumers
 * @returns {object[]|null}
 */
export function storeBatchedSidecarResult(agent, extractedValue, message, messageIndex, source = 'sidecar_batch') {
    const mv = agent.mergeVariable;
    if (!mv?.enabled || !mv.variableName) return null;

    if (mv.mode === 'snapshot') {
        // A batched model may obey the task's tagged output format instead of
        // returning the bare envelope value. Detect an actual extraction match
        // for both single- and multi-field trackers, then reuse the solo path.
        if (typeof extractedValue === 'string' && mv.extractPattern) {
            const extractionRegex = buildExtractRegex(mv.extractPattern);
            if (extractionRegex?.test(extractedValue)) {
                return storeSidecarResult(agent, extractedValue, message, messageIndex);
            }

            // Batch models occasionally preserve the inside of a task-local
            // tag as a JSON string while dropping only its square brackets,
            // e.g. "World|Parking Lot|Day 2|10:30 AM|Morning|Clear|Mild|Indoors".
            // Re-wrap once and reuse the normal extractor; schema validation is
            // still the final acceptance boundary.
            const trimmedValue = extractedValue.trim();
            const wrappedValue = trimmedValue.startsWith('[')
                ? trimmedValue
                : `[${trimmedValue}]`;
            const wrappedRegex = buildExtractRegex(mv.extractPattern);
            const wrappedCaseInsensitive = wrappedRegex
                ? new RegExp(
                    wrappedRegex.source,
                    wrappedRegex.flags.includes('i') ? wrappedRegex.flags : `${wrappedRegex.flags}i`,
                )
                : null;
            if (wrappedCaseInsensitive?.test(wrappedValue)) {
                return storeSidecarResult(agent, wrappedValue, message, messageIndex);
            }
        }

        const item = {};

        if (typeof extractedValue === 'object' && !Array.isArray(extractedValue) && mv.validation?.jsonField) {
            // Validated structured trackers treat the complete envelope value as
            // their logical JSON payload, even when extra legacy/display fields
            // remain declared for migration compatibility.
            for (const field of mv.fieldNames) {
                item[field] = field === mv.validation.jsonField
                    ? JSON.stringify(extractedValue)
                    : '';
            }
        } else if (typeof extractedValue === 'object' && !Array.isArray(extractedValue) && mv.fieldNames.length > 1) {
            // Multi-field agent (e.g. World State with location/date/time/weather/temperature):
            // map object properties directly to fieldNames.
            for (const field of mv.fieldNames) {
                const val = extractedValue[field];
                item[field] = val !== undefined
                    ? (typeof val === 'object' ? JSON.stringify(val) : String(val))
                    : '';
            }
        } else {
            // Single-field agent: stringify the entire value into the first field.
            const valueStr = typeof extractedValue === 'object'
                ? JSON.stringify(extractedValue)
                : String(extractedValue);
            for (let i = 0; i < mv.fieldNames.length; i++) {
                item[mv.fieldNames[i]] = i === 0 ? valueStr : '';
            }
        }

        item._addedAt = Date.now();
        item._messageIndex = messageIndex;

        const items = [item];
        const commit = commitMergeItems(agent, message, messageIndex, items, source);
        if (!commit.committed) return null;

        debug(`${LOG_PREFIX} Batched result stored for "${agent.name}" → "${mv.variableName}"`);
        return commit.items;
    }

    // Accumulate mode: fall back to regex extraction on the stringified value.
    const valueStr = typeof extractedValue === 'object'
        ? JSON.stringify(extractedValue)
        : String(extractedValue);
    return storeSidecarResult(agent, valueStr, message, messageIndex);
}
