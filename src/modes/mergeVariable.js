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
 * @param {object} message - chat[n]
 * @param {string} varName - merge variable name
 * @param {object[]} items - the items to store
 */
function storePerSwipe(message, varName, items) {
    const swipeId = message.swipe_id ?? 0;
    if (!message.extra) message.extra = {};
    if (!message.extra.saAgentSwipes) message.extra.saAgentSwipes = {};
    if (!message.extra.saAgentSwipes[varName]) message.extra.saAgentSwipes[varName] = {};
    message.extra.saAgentSwipes[varName][swipeId] = items;
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
            return new RegExp(slashMatch[1], slashMatch[2]);
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
