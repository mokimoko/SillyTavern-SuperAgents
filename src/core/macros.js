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
 * the registry after structural agent changes. Macro handlers read current
 * chat state when expanded, so state updates do not require re-registration.
 *
 * Uses SillyTavern's current macro registry API. Replacing a macro previously
 * registered by this module explicitly unregisters it first, avoiding duplicate
 * registration warnings while still surfacing first-time external collisions.
 */

import { macros, MacroCategory } from '../../../../../../scripts/macros/macro-system.js';
import { debug } from '../../index.js';
import { getAgents, getAgentById } from '../data/store.js';
import { readMergeArray, formatMergeVariableData } from '../modes/mergeVariable.js';

const LOG_PREFIX = '[SuperAgents/macros]';
const MACRO_PREFIX = 'agent_';

// The set of macro names owned by this module. It lets refreshMacros replace its
// own definitions quietly while leaving a warning intact for first-time name
// collisions with core macros or another extension.
const registered = new Set();

function registerMacro(name, handler, description) {
    if (registered.has(name)) {
        macros.registry.unregisterMacro(name);
    }

    const definition = macros.registry.registerMacro(name, {
        category: MacroCategory.MISC,
        description,
        handler,
    });

    if (definition) registered.add(name);
}

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

function isAgentEnabled(agent) {
    return getAgentById(agent?.id)?.enabled === true;
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

    for (const { agent, varName, macroName } of stateAgents) {
        liveNames.add(macroName);
        const rawName = `${macroName}_raw`;
        const valueName = `${macroName}_value`;

        // Bare variable-name macro: {{<variableName>}} → same formatted, persona-
        // projected state as {{agent_<var>}}. Trackers are conventionally named
        // sa_* (sa_state_card, sa_relationship_ledger, sa_parallel), so this lets
        // {{sa_state_card}} resolve directly — matching the obvious intuition —
        // with no per-agent macro-name setup. Skipped only if it would collide
        // with the agent_-prefixed name (i.e. a variable literally named
        // "agent_…"), which the register-below already owns.
        const bareName = macroSafe(varName);
        if (bareName && bareName !== macroName) {
            registerMacro(
                bareName,
                () => {
                    if (!isAgentEnabled(agent)) return '';
                    try {
                        const text = formatMergeVariableData(agent.mergeVariable, { projectPersona: true });
                        return text?.trim() ? text : '';
                    } catch (err) {
                        debug(`${LOG_PREFIX} macro {{${bareName}}} resolver failed:`, err);
                        return '';
                    }
                },
                `SuperAgents: formatted state for "${agent.name}" (by variable name).`,
            );
            liveNames.add(bareName);
        }

        // Formatted state — resolver reads current state at expansion time, so
        // the macro always reflects the latest accumulated data, not a snapshot
        // taken at registration.
        registerMacro(
            macroName,
            () => {
                if (!isAgentEnabled(agent)) return '';
                try {
                    // Placed in a preset, this feeds the MAIN model — project a
                    // persona-scoped var to the active persona, same as chat injection.
                    const text = formatMergeVariableData(agent.mergeVariable, { projectPersona: true });
                    return text?.trim() ? text : '';
                } catch (err) {
                    debug(`${LOG_PREFIX} macro {{${macroName}}} resolver failed:`, err);
                    return '';
                }
            },
            `SuperAgents: formatted state for "${agent.name}".`,
        );

        // Raw JSON array — for scripts/QRs that want to parse items themselves.
        registerMacro(
            rawName,
            () => {
                if (!isAgentEnabled(agent)) return '[]';
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
        registerMacro(
            valueName,
            () => {
                if (!isAgentEnabled(agent)) return '';
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
            registerMacro(
                fieldMacro,
                () => {
                    if (!isAgentEnabled(agent)) return '';
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
            liveNames.add(fieldMacro);
        }

        // Optional user-defined macro: {{sa_<macroName>}} → the same formatted,
        // persona-projected state as {{agent_<var>}}, but under a name the user
        // controls (set in the agent editor) so they can drop it at an exact
        // spot in a preset. mergeVariable.macroName is pre-sanitized by normalize
        // to [a-z0-9_-]; empty means no custom macro. Registered even when
        // auto-injection is off — that's the whole point of manual placement.
        const customSuffix = String(agent?.mergeVariable?.macroName ?? '').trim();
        if (customSuffix) {
            const customName = `sa_${customSuffix}`;
            registerMacro(
                customName,
                () => {
                    if (!isAgentEnabled(agent)) return '';
                    try {
                        const text = formatMergeVariableData(agent.mergeVariable, { projectPersona: true });
                        return text?.trim() ? text : '';
                    } catch (err) {
                        debug(`${LOG_PREFIX} macro {{${customName}}} resolver failed:`, err);
                        return '';
                    }
                },
                `SuperAgents: custom-named formatted state for "${agent.name}".`,
            );
            liveNames.add(customName);
        }
    }

    // Stale macros (agent removed or variableName changed): re-point their
    // resolvers at "" so they no longer surface obsolete data. Keeping a neutral
    // definition preserves existing presets without exposing stale content.
    liveNames.add('agent_state_list');
    for (const name of registered) {
        // Recover the base macro name by stripping any known suffix, so a live
        // agent's _raw / _value variants aren't mistaken for stale bases.
        let base = name;
        if (name.endsWith('_raw')) base = name.slice(0, -4);
        else if (name.endsWith('_value')) base = name.slice(0, -6);
        if (liveNames.has(base)) continue;
        registerMacro(
            name,
            () => (name.endsWith('_raw') ? '[]' : ''),
            'SuperAgents: (inactive agent state).',
        );
    }

    // Discovery macro: what agent-state macros currently resolve to real data.
    registerMacro(
        'agent_state_list',
        () => stateAgents
            .filter(({ agent }) => isAgentEnabled(agent))
            .map(s => `{{${s.macroName}}}`)
            .join(', '),
        'SuperAgents: list of available agent-state macros.',
    );

    debug(`${LOG_PREFIX} refreshed ${stateAgents.length} agent state macro(s)`);
}

/**
 * Initialize macro exposure. Handlers resolve chat-local state at expansion
 * time; structural changes are refreshed by the editor after an agent is saved.
 */
export function initMacros() {
    refreshMacros();
    debug(`${LOG_PREFIX} macro exposure initialized`);
}
