/**
 * data/importExport.js — agent pack import/export.
 *
 * Compatible with SillyBunny's `sillybunny-inchat-agents` format for free
 * interop — packs from SillyBunny load here, and packs from us load there.
 * Also accepts a single-agent JSON (just the agent object).
 */

import { _internal } from './store.js';
import { createDefaultAgent, normalizeAgent, generateId } from './normalize.js';

const LOG_PREFIX = '[SuperAgents/io]';
const PACK_FORMAT = 'sillybunny-inchat-agents';
const PACK_VERSION = 1;

// ----------------------------------------------------------------------
// Import
// ----------------------------------------------------------------------

/**
 * Import one or more agents from a JSON payload.
 * Accepts either:
 *   - SillyBunny pack: `{ format: 'sillybunny-inchat-agents', agents: [...] }`
 *   - Bare agent:      `{ id, prompt, ... }`
 *
 * Imported agents are given fresh IDs so re-importing doesn't collide with
 * existing ones.
 *
 * @param {object} data
 * @returns {object[]} the imported (normalized + stored) agents
 */
export function importAgents(data) {
    if (!data || typeof data !== 'object') {
        throw new Error('Import payload is not a JSON object');
    }

    let toImport = [];
    if (data.format === PACK_FORMAT && Array.isArray(data.agents)) {
        toImport = data.agents;
    } else if (typeof data.id === 'string' && data.prompt !== undefined) {
        toImport = [data];
    } else {
        throw new Error('Unrecognized agent format (expected SillyBunny pack or a single agent object)');
    }

    if (!toImport.length) return [];

    const agents = _internal.getAgentsRef();
    const imported = [];

    for (const raw of toImport) {
        const agent = normalizeAgent({
            ...createDefaultAgent(),
            ...raw,
            id: generateId(),       // fresh ID on import — no collisions
        });
        agents.push(agent);
        imported.push(agent);
    }

    _internal.persist();
    console.log(`${LOG_PREFIX} imported ${imported.length} agent(s)`);
    return imported;
}

// ----------------------------------------------------------------------
// Export
// ----------------------------------------------------------------------

/**
 * Export every agent as a SillyBunny-compatible pack.
 * @returns {object}
 */
export function exportAllAgents() {
    const agents = _internal.getAgentsRef();
    return {
        format: PACK_FORMAT,
        version: PACK_VERSION,
        agents: agents.map(a => ({ ...a })),
    };
}

/**
 * Export a single agent by ID.
 * @param {string} id
 * @returns {object|null} a shallow-cloned agent, or null if not found
 */
export function exportAgent(id) {
    const agents = _internal.getAgentsRef();
    const agent = agents.find(a => a.id === id);
    return agent ? { ...agent } : null;
}
