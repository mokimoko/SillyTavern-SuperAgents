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
    chat_metadata,
    substituteParams,
    saveChatDebounced,
} from '../../../../../../script.js';
import { debug } from '../../index.js';
import { recordAgentRun } from '../core/idempotency.js';

const LOG_PREFIX = '[SuperAgents/mergeVar]';

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
 * Format the current merge variable state as readable text for LLM injection.
 * Uses the template's formatHeader / formatItem / formatEmpty fields.
 * @param {object} config - agent.mergeVariable
 * @returns {string}
 */
export function formatMergeVariableData(config) {
    const arr = readMergeArray(config.variableName);

    if (arr.length === 0) {
        return config.formatHeader
            ? `${config.formatHeader}\n${config.formatEmpty}`
            : config.formatEmpty;
    }

    const lines = arr.map(item => {
        let line = config.formatItem;
        for (const field of config.fieldNames) {
            const val = item[field] ?? '';
            // Handle arrays (like knownBy) gracefully
            const display = Array.isArray(val) ? val.join(', ') : String(val);
            line = line.replaceAll(`{{${field}}}`, display);
        }
        return line;
    });

    return config.formatHeader
        ? `${config.formatHeader}\n${lines.join('\n')}`
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
 */
function storePerSwipe(message, varName, items) {
    const swipeId = message.swipe_id ?? 0;
    if (!message.saAgentSwipes) message.saAgentSwipes = {};
    if (!message.saAgentSwipes[varName]) message.saAgentSwipes[varName] = {};
    message.saAgentSwipes[varName][swipeId] = items;
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
 * @returns {{ items: object[]|null, distance: number, foundIndex: number }}
 *          items:      resolved array, or null if nothing anywhere down-trace.
 *          distance:   message hops from the start to where state was found
 *                      (0 = own record; Infinity when items is null).
 *          foundIndex: chat index the state came from (-1 when null).
 */
export function resolveStateTraceDetailed(chat, messageIndex, swipeId, varName) {
    const MISS = { items: null, distance: Infinity, foundIndex: -1 };
    if (!Array.isArray(chat) || !varName) return MISS;

    const startIdx = Number(messageIndex);
    let idx = startIdx;
    let swipe = Number(swipeId) || 0;

    // Bound the walk to the chat length as a belt-and-suspenders guard against
    // any pathological cycle (indices only ever decrease, so this can't loop,
    // but the explicit ceiling documents the intent).
    let steps = chat.length + 1;

    while (idx >= 0 && steps-- > 0) {
        const message = chat[idx];
        if (!message) return MISS;

        // User/system turns never carry state — walk past them transparently,
        // following their own active swipe (almost always 0).
        if (message.is_user || message.is_system) {
            idx -= 1;
            swipe = idx >= 0 ? (chat[idx]?.swipe_id ?? 0) : 0;
            continue;
        }

        const rec = message.saAgentSwipes?.[varName];
        if (rec && Object.prototype.hasOwnProperty.call(rec, swipe)) {
            // Own record for this swipe — this is the answer, even if [].
            return {
                items: rec[swipe] ?? [],
                distance: Math.max(0, startIdx - idx),
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

        const rec = message.saAgentSwipes?.[varName];
        if (rec && Object.prototype.hasOwnProperty.call(rec, swipe)) {
            const items = rec[swipe] ?? [];
            // DIVERGENCE #2: skip tracked-empty rather than stopping on it; an
            // empty plan is nothing to show and must not cut off older plans.
            if (Array.isArray(items) && items.length > 0) {
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
        return new RegExp(pattern, 'gs');
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

        writeMergeArray(mv.variableName, items);
        storePerSwipe(message, mv.variableName, items);

        if (mv.stripFromResponse) {
            message.mes = message.mes.replace(regex, '').trim();
        }

        debug(`${LOG_PREFIX} Merge variable "${mv.variableName}" (snapshot): replaced with ${items.length} item(s)`);

        recordAgentRun(messageIndex, {
            agentId: agent.id,
            agentName: agent.name,
            phase: 'post',
            originalText: null,
            result: `Snapshot: ${items.length} item(s)`,
            mode: 'merge_variable',
        });

        return { changed: true, added: items.length, updated: 0, resolved: 0 };
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

    // Write back
    writeMergeArray(mv.variableName, arr);

    // Strip tags from message if configured
    if (mv.stripFromResponse) {
        message.mes = message.mes.replace(regex, '').trim();
    }

    const totalChanges = added + updated + resolved;
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
    if (!mv?.enabled || !mv.extractPattern || !mv.variableName) return null;

    const regex = buildExtractRegex(mv.extractPattern);
    if (!regex) return null;

    const matches = [...response.matchAll(regex)];
    if (matches.length === 0) {
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

    writeMergeArray(mv.variableName, items);
    storePerSwipe(message, mv.variableName, items);

    debug(`${LOG_PREFIX} Sidecar stored ${items.length} item(s) to "${mv.variableName}"`);
    return items;
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
 * @returns {object[]|null}
 */
export function storeBatchedSidecarResult(agent, extractedValue, message, messageIndex) {
    const mv = agent.mergeVariable;
    if (!mv?.enabled || !mv.variableName) return null;

    if (mv.mode === 'snapshot') {
        // If the LLM returned a string (raw tag format) and the agent has
        // multiple fields + an extractPattern, delegate to storeSidecarResult
        // which does proper regex extraction.
        if (typeof extractedValue === 'string' && mv.fieldNames.length > 1 && mv.extractPattern) {
            return storeSidecarResult(agent, extractedValue, message, messageIndex);
        }

        const item = {};

        if (typeof extractedValue === 'object' && !Array.isArray(extractedValue) && mv.fieldNames.length > 1) {
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
        writeMergeArray(mv.variableName, items);
        storePerSwipe(message, mv.variableName, items);

        debug(`${LOG_PREFIX} Batched result stored for "${agent.name}" → "${mv.variableName}"`);
        return items;
    }

    // Accumulate mode: fall back to regex extraction on the stringified value.
    const valueStr = typeof extractedValue === 'object'
        ? JSON.stringify(extractedValue)
        : String(extractedValue);
    return storeSidecarResult(agent, valueStr, message, messageIndex);
}
