/**
 * data/templateSync.js — keep instantiated agents in sync with their source
 * templates as those templates evolve.
 *
 * When a user instantiates a template (via the Library tab) the resulting
 * agent gets `sourceTemplateId` + `sourceTemplateVersion` markers. When this
 * extension ships an updated template (bumped `version` in the JSON), we
 * patch the existing agent's structural fields without disturbing the
 * user's customizations.
 *
 * Synced fields: prompt, phase, injection, postProcess, mergeVariable,
 * regexScripts, maxTokens, description, category, tags, icon, author,
 * stateCard, sidecarCall, phoneConfig.
 *
 * Preserved (never touched): id, name, enabled, conditions,
 * connectionProfile, groupId.
 *
 * Run non-blocking from index.js init.
 */

import { _internal } from './store.js';
import { normalizeMergeVariable } from './normalize.js';
import { normalizeRegexScript } from '../render/regexProcessor.js';

const LOG_PREFIX = '[SuperAgents/templateSync]';

// ----------------------------------------------------------------------
// Config
// ----------------------------------------------------------------------

const TEMPLATE_BASE_PATH = '/scripts/extensions/third-party/SillyTavern-SuperAgents/src/templates';

// Only files actually present on disk are listed here. fetchAllTemplates
// filters 404s in JS, but the browser still logs each failed GET — so this
// list stays in step with what's been ported. All 13 built-ins are now shipped.
const TEMPLATE_FILES = [
    'world-state.json',
    'state-card.json',
    'phone-messenger.json',
    'continuity-check.json',
    'narrative-engine.json',
    'direction-menu.json',
    'parallel-offscreen.json',
    'prose-polisher.json',
    'prose-guardian.json',
    'event-spark.json',
    'secret-keeper.json',
    'dead-dove-escalation.json',
    'intimacy-kink-randomiser.json',
    'director.json',
];

/**
 * Fields that belong to the template author. These get refreshed when the
 * template's `version` bumps. User-territory fields stay as-is.
 */
const TEMPLATE_SYNC_FIELDS = [
    'prompt',
    'phase',
    'injection',
    'postProcess',
    'mergeVariable',
    'regexScripts',
    'maxTokens',
    'description',
    'category',
    'tags',
    'icon',
    'author',
    'stateCard',
    'sidecarCall',
    'phoneConfig',
];

// ----------------------------------------------------------------------
// Fetch built-in templates
// ----------------------------------------------------------------------

/**
 * Pull every built-in template JSON from disk. Missing/broken files yield
 * null and are silently filtered out — this is intentional so the extension
 * works even before all templates ship.
 *
 * @returns {Promise<object[]>}
 */
async function fetchAllTemplates() {
    const results = await Promise.all(
        TEMPLATE_FILES.map(async (file) => {
            try {
                const resp = await fetch(`${TEMPLATE_BASE_PATH}/${file}`);
                if (!resp.ok) return null;
                return await resp.json();
            } catch {
                return null;
            }
        }),
    );
    return results.filter(Boolean);
}

// ----------------------------------------------------------------------
// Apply template fields to an existing agent
// ----------------------------------------------------------------------

function applyTemplateFields(agent, template) {
    for (const field of TEMPLATE_SYNC_FIELDS) {
        if (template[field] === undefined) continue;

        if (field === 'mergeVariable') {
            agent.mergeVariable = normalizeMergeVariable(template.mergeVariable);
        } else if (field === 'regexScripts') {
            agent.regexScripts = Array.isArray(template.regexScripts)
                ? template.regexScripts.map(normalizeRegexScript)
                : [];
        } else if (field === 'injection' || field === 'postProcess') {
            // Merge so we don't blow away any defaults the template omits
            agent[field] = { ...agent[field], ...template[field] };
        } else {
            agent[field] = template[field];
        }
    }
    agent.sourceTemplateVersion = template.version;
}

// ----------------------------------------------------------------------
// Public: syncFromTemplates
// ----------------------------------------------------------------------

/**
 * Update any agent whose source template has a higher version than the
 * version stamped on the agent. User-territory fields are preserved.
 *
 * @returns {Promise<string[]>} display names of agents that were updated
 */
export async function syncFromTemplates() {
    let templates;
    try {
        templates = await fetchAllTemplates();
    } catch (err) {
        console.warn(`${LOG_PREFIX} fetchAllTemplates failed:`, err);
        return [];
    }

    if (!templates.length) return [];

    const byId = new Map(templates.map(t => [t.id, t]));
    const agents = _internal.getAgentsRef();
    const updated = [];

    for (const agent of agents) {
        if (!agent.sourceTemplateId) continue;

        const template = byId.get(agent.sourceTemplateId);
        if (!template) continue;

        const have = agent.sourceTemplateVersion ?? 0;
        if ((template.version ?? 0) <= have) continue;

        applyTemplateFields(agent, template);
        updated.push(agent.name || template.name || agent.sourceTemplateId);
    }

    if (updated.length > 0) {
        _internal.persist();
        console.log(`${LOG_PREFIX} synced ${updated.length} agent(s) to newer template version(s):`, updated);
    }

    return updated;
}

/**
 * Return the raw built-in templates list. Useful for the Library UI.
 * @returns {Promise<object[]>}
 */
export async function listBuiltInTemplates() {
    return fetchAllTemplates();
}
