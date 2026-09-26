/**
 * core/migration.js — one-time VerseManager → SuperAgents settings migration.
 *
 * VM's agents feature persisted to:
 *   extension_settings['verseManager'].agents = { agents, groups, globalSettings }
 * (Note: VM's MODULE_NAME is 'verseManager', NOT 'SillyTavern-VerseManager'.)
 *
 * SuperAgents persists the same three keys at the TOP LEVEL of its own
 * namespace: extension_settings['SillyTavern-SuperAgents'].{agents,groups,globalSettings}.
 *
 * This copies a user's existing VM agents into SuperAgents so they aren't
 * orphaned when they switch. Design guarantees:
 *
 *   - IDs are PRESERVED (not regenerated). agent.groupId and group.agentIds
 *     are cross-references; regenerating IDs (as importAgents does) would break
 *     them. We clone verbatim and let store.loadFromSettings() normalize shape
 *     while keeping the ids.
 *   - Variable names (vm_*) are KEPT. A migrated agent is self-consistent — it
 *     writes and reads its own var name — so it keeps working untouched. The
 *     vm_*→sa_* rename only mattered for the built-in TEMPLATES coexisting.
 *   - NO CLOBBER: if SuperAgents already has agents, we never overwrite them.
 *   - ONE-TIME: a `_migratedFromVM` flag guards re-runs. The flag is only set
 *     once we've actually seen VM data — so if VM is installed AFTER the first
 *     SuperAgents load, the migration can still fire on a later load.
 */

import { extension_settings } from '../../../../../extensions.js';
import { MODULE_NAME, debug } from './runtime.js';
import { loadFromSettings, _internal } from '../data/store.js';

const LOG_PREFIX = '[SuperAgents/migration]';
const VM_MODULE_NAME = 'verseManager';

/** Deep clone helper (structuredClone with a JSON fallback). */
function clone(obj) {
    try {
        return structuredClone(obj);
    } catch {
        return JSON.parse(JSON.stringify(obj));
    }
}

/**
 * Run the one-time VM → SuperAgents migration.
 * Safe to call on every init — it self-guards.
 *
 * @returns {{migrated:boolean, agents?:number, groups?:number, reason?:string}}
 */
export function migrateFromVM() {
    const saRoot = extension_settings[MODULE_NAME] ?? (extension_settings[MODULE_NAME] = {});

    // Already handled once — never reconsider.
    if (saRoot._migratedFromVM) {
        return { migrated: false, reason: 'already-ran' };
    }

    // Read VM's agents container.
    const vmContainer = extension_settings[VM_MODULE_NAME]?.agents;
    const vmAgents = Array.isArray(vmContainer?.agents) ? vmContainer.agents : [];
    const vmGroups = Array.isArray(vmContainer?.groups) ? vmContainer.groups : [];
    const vmGlobal = vmContainer?.globalSettings;

    // VM not installed / nothing to migrate. Leave the flag UNSET so a later
    // VM install can still trigger migration on a subsequent load.
    if (vmAgents.length === 0 && vmGroups.length === 0) {
        return { migrated: false, reason: 'no-vm-data' };
    }

    // SuperAgents already has agents — don't clobber. Mark the migration
    // considered (flag set) so we stop checking; the user can still bring VM
    // agents over manually via the import UI if they want both.
    const saHasAgents = Array.isArray(saRoot.agents) && saRoot.agents.length > 0;
    if (saHasAgents) {
        saRoot._migratedFromVM = true;
        _internal.persist(); // writes current in-memory state + the flag
        debug(`${LOG_PREFIX} VM data found but SuperAgents already has agents; skipped (flag set)`);
        return { migrated: false, reason: 'sa-not-empty' };
    }

    // --- Copy (IDs preserved) ---
    saRoot.agents = vmAgents.map(clone);
    saRoot.groups = vmGroups.map(clone);
    if (vmGlobal && typeof vmGlobal === 'object') {
        saRoot.globalSettings = { ...(saRoot.globalSettings ?? {}), ...clone(vmGlobal) };
    }
    saRoot._migratedFromVM = true;

    // Rehydrate the in-memory store (normalizes each agent/group to the SA
    // shape, keeping ids), then persist the normalized result back to disk.
    loadFromSettings();
    _internal.persist();

    debug(`${LOG_PREFIX} migrated ${vmAgents.length} agent(s) + ${vmGroups.length} group(s) from VerseManager`);
    return { migrated: true, agents: vmAgents.length, groups: vmGroups.length };
}
