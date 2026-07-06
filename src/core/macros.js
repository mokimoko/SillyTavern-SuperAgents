/**
 * core/macros.js — expose agent tracker state as SillyTavern macros.
 *
 * Gameplan Step 8 (from the Recast study): Recast registers {{recast_latest}}
 * and {{recast_<pass_id>}} so other extensions / Quick Replies / prompt
 * templates can read pass output. We do the same for tracker state, which is
 * our differentiator — persistent structured world/character state that other
 * parts of a preset will want to read.
 *
 * For every merge-variable agent we register two macros, keyed off the agent's
 * mergeVariable.variableName (e.g. variableName "world_state" → {{agent_world_state}}):
 *
 *   {{agent_<name>}}      → the formatted, human/LLM-readable state block
 *                           (same text the agent injects into context, via
 *                           formatMergeVariableData). Empty string if no state.
 *   {{agent_<name>_raw}}  → the raw JSON array string of accumulated items,
 *                           for QRs / scripts that want to parse it.
 *
 * Plus one convenience macro:
 *   {{agent_state_list}}  → comma-separated list of available agent macro names,
 *                           so a user can discover what's queryable.
 *
 * Registration is idempotent and re-runnable: agents can be created, renamed,
 * or have their variableName changed at runtime, so refreshMacros() re-syncs
 * the registry. The lifecycle calls refreshMacros() via onPostProcessComplete
 * and on CHAT_CHANGED so newly-instantiated agents become queryable without a
 * reload.
 *
 * Uses the stable MacrosParser.registerMacro path. ST is mid-migration to an
 * experimental macro engine, but the legacy parser works under both engines,
 * which is what we want for a personal extension that just needs to run.
 */

import { MacrosParser } from '../../../../../../scripts/macros.js';
import { eventSource, event_types } from '../../../../../events.js';
import { debug } from '../../index.js';
import { getAgents } from '../data/store.js';
import { readMergeArray, formatMergeVariableData } from '../modes/mergeVariable.js';

const LOG_PREFIX = '[SuperAgents/macros]';
const MACRO_PREFIX = 'agent_';

// The set of macro names we've registered, so refreshMacros can detect which
// ones are stale (agent deleted / variableName changed) and overwrite cleanly.
// MacrosParser has no public "unregister", so we re-register stale names with a
// resolver that reflects current state — a removed agent's macro simply resolves
// to empty rather than dangling on old data.
const registered = new Set();

/**
 * Sanitize a variableName into a macro-safe suffix. Macro names are
 * {{word}}-style; spaces/punctuation in a user's variableName would break the
 * token. Lowercase, non-alphanumerics → underscore, collapse repeats, trim.
 */
function macroSafe(name) {
    return String(name || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_|_$/g, '');
}

// Suffixes reserved for the built-in variant macros ({{..._raw}}, {{..._value}}).
// A per-field macro must never shadow these, so a field literally named "raw"
// or "value" is skipped by the field loop.
const RESERVED_FIELD_SUFFIXES = new Set(['raw', 'value']);

/**
 * Normalize a stored field value into a plain string for macro output.
 * Unwraps a bare-JSON-quoted string (batching can stringify single values) and
 * joins arrays into a readable comma list.
 */
function fieldToString(val) {
    if (typeof val === 'string' && val.startsWith('"') && val.endsWith('"')) {
        try { val = JSON.parse(val); } catch { /* keep raw */ }
    }
    return Array.isArray(val) ? val.join(', ') : String(val ?? '').trim();
}

/**
 * Collect the merge-variable agents that have a usable variableName.
 * @returns {{ agent: object, varName: string, macroName: string }[]}
 */
function collectStateAgents() {
    const out = [];
    const seen = new Set();
    for (const agent of getAgents()) {
        const varName = agent?.mergeVariable?.variableName;
        if (!varName) continue;
        const safe = macroSafe(varName);
        if (!safe || seen.has(safe)) continue;   // skip blanks + collisions
        seen.add(safe);
        out.push({ agent, varName, macroName: MACRO_PREFIX + safe });
    }
    return out;
}

/**
 * Register (or refresh) all agent state macros. Safe to call repeatedly.
 */
export function refreshMacros() {
    const stateAgents = collectStateAgents();
    const liveNames = new Set();

    for (const { agent, macroName } of stateAgents) {
        liveNames.add(macroName);
        const rawName = `${macroName}_raw`;
        const valueName = `${macroName}_value`;

        // Formatted state — resolver reads current state at expansion time, so
        // the macro always reflects the latest accumulated data, not a snapshot
        // taken at registration.
        MacrosParser.registerMacro(
            macroName,
            () => {
                try {
                    const text = formatMergeVariableData(agent.mergeVariable);
                    return text?.trim() ? text : '';
                } catch (err) {
                    debug(`${LOG_PREFIX} macro {{${macroName}}} resolver failed:`, err);
                    return '';
                }
            },
            `SuperAgents: formatted state for "${agent.name}".`,
        );

        // Raw JSON array — for scripts/QRs that want to parse items themselves.
        MacrosParser.registerMacro(
            rawName,
            () => {
                try {
                    return JSON.stringify(readMergeArray(agent.mergeVariable.variableName));
                } catch (err) {
                    debug(`${LOG_PREFIX} macro {{${rawName}}} resolver failed:`, err);
                    return '[]';
                }
            },
            `SuperAgents: raw JSON state array for "${agent.name}".`,
        );

        // Bare payload value — the single "content" field of the first stored
        // item, with no formatting, header, or emoji. Declared per-agent via
        // sidecarCall.display.contentField (falls back to the first fieldName).
        // This is the paste-ready form: drop {{agent_<name>_value}} straight
        // into an image-gen call, a /sd command, or any downstream consumer
        // that wants ONLY the payload, not the decorated display string.
        MacrosParser.registerMacro(
            valueName,
            () => {
                try {
                    const mv = agent.mergeVariable;
                    const arr = readMergeArray(mv.variableName);
                    if (!arr.length) return '';
                    const field = agent?.sidecarCall?.display?.contentField
                        || mv.fieldNames?.[0];
                    if (!field) return '';
                    return fieldToString(arr[0][field]);
                } catch (err) {
                    debug(`${LOG_PREFIX} macro {{${valueName}}} resolver failed:`, err);
                    return '';
                }
            },
            `SuperAgents: bare payload value for "${agent.name}" (paste-ready, no formatting).`,
        );

        // Per-field macros — one {{agent_<name>_<field>}} for every declared
        // fieldName, resolving to that field's value on the first stored item.
        // Lets you pull a single column out of a multi-field agent, e.g.
        // {{agent_sa_soundtrack_track}} for just the track name to search on,
        // or {{agent_sa_art_prompt_style}} for the style tags alone.
        const fieldNames = Array.isArray(agent?.mergeVariable?.fieldNames)
            ? agent.mergeVariable.fieldNames
            : [];
        for (const field of fieldNames) {
            const safeField = macroSafe(field);
            if (!safeField || RESERVED_FIELD_SUFFIXES.has(safeField)) continue;
            const fieldMacro = `${macroName}_${safeField}`;
            MacrosParser.registerMacro(
                fieldMacro,
                () => {
                    try {
                        const arr = readMergeArray(agent.mergeVariable.variableName);
                        if (!arr.length) return '';
                        return fieldToString(arr[0][field]);
                    } catch (err) {
                        debug(`${LOG_PREFIX} macro {{${fieldMacro}}} resolver failed:`, err);
                        return '';
                    }
                },
                `SuperAgents: "${field}" field of "${agent.name}".`,
            );
            registered.add(fieldMacro);
            liveNames.add(fieldMacro);
        }

        registered.add(macroName);
        registered.add(rawName);
        registered.add(valueName);
    }

    // Stale macros (agent removed or variableName changed): re-point their
    // resolvers at "" so they no longer surface obsolete data. We can't delete
    // them from the parser, but a neutral resolver is harmless.
    for (const name of registered) {
        // Recover the base macro name by stripping any known suffix, so a live
        // agent's _raw / _value variants aren't mistaken for stale bases.
        let base = name;
        if (name.endsWith('_raw')) base = name.slice(0, -4);
        else if (name.endsWith('_value')) base = name.slice(0, -6);
        if (liveNames.has(base)) continue;
        MacrosParser.registerMacro(
            name,
            () => (name.endsWith('_raw') ? '[]' : ''),
            'SuperAgents: (inactive agent state).',
        );
    }

    // Discovery macro: what agent-state macros currently resolve to real data.
    MacrosParser.registerMacro(
        'agent_state_list',
        () => stateAgents.map(s => `{{${s.macroName}}}`).join(', '),
        'SuperAgents: list of available agent-state macros.',
    );

    debug(`${LOG_PREFIX} refreshed ${stateAgents.length} agent state macro(s)`);
}

/**
 * Initialize macro exposure. Registers once now, then re-syncs whenever the
 * active chat changes (state is chat-local) so macros track the current chat.
 * Called once from index.js.
 */
export function initMacros() {
    refreshMacros();
    eventSource.on(event_types.CHAT_CHANGED, refreshMacros);
    debug(`${LOG_PREFIX} macro exposure initialized`);
}
