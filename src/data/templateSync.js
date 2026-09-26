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
 * stateCard, sidecarCall, phoneConfig, feedConfig.
 *
 * Preserved (never touched): id, name, enabled, conditions,
 * connectionProfile, groupId.
 *
 * Run non-blocking from index.js init.
 */

import { _internal } from './store.js';
import { normalizeMergeVariable } from './normalize.js';
import { normalizeRegexScript } from '../render/regexProcessor.js';
import { MODULE_NAME, debug } from '../core/runtime.js';
import { isTemplateLinked } from './templateLink.js';

const LOG_PREFIX = '[SuperAgents/templateSync]';

// ----------------------------------------------------------------------
// Config
// ----------------------------------------------------------------------

const TEMPLATE_BASE_PATH = `/scripts/extensions/third-party/${MODULE_NAME}/src/templates`;

// Only files actually present on disk are listed here. fetchAllTemplates
// filters 404s in JS, but the browser still logs each failed GET — so this
// list stays in step with the templates actually shipped.
const TEMPLATE_FILES = [
    'world-state.json',
    'state-card.json',
    'world-events.json',
    'relationship-ledger.json',
    'social-web-ledger.json',
    'knowledge-ledger.json',
    'prompt-profile.json',
    'prompt-nsfw.json',
    'phone-messenger.json',
    'social-feed.json',
    'continuity-check.json',
    'continuity-guard.json',
    'narrative-engine.json',
    'direction-menu.json',
    'parallel-offscreen.json',
    'prose-polisher.json',
    'prose-guardian.json',
    'event-spark.json',
    'dead-dove-escalation.json',
    'intimacy-kink-randomiser.json',
    'after-dark.json',
    'drama-queen.json',
    'director.json',
    'soundtrack-suggester.json',
    'art-prompt-generator.json',
    'actor-interview.json',
    'character-diary.json',
    'commentary-section.json',
    'wish-granter.json',
];

let templateFetchPromise = null;

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
    'worldEventsConfig',
    'sidecarCall',
    'phoneConfig',
    'feedConfig',
    'afterDarkConfig',
    'dramaQueenConfig',
    'continuityGuard',
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
    if (!templateFetchPromise) {
        templateFetchPromise = Promise.all(
            TEMPLATE_FILES.map(async (file) => {
                try {
                    const resp = await fetch(`${TEMPLATE_BASE_PATH}/${file}`);
                    if (!resp.ok) return null;
                    return await resp.json();
                } catch {
                    return null;
                }
            }),
        ).then(results => results.filter(Boolean));
    }
    const templates = await templateFetchPromise;
    return typeof structuredClone === 'function'
        ? structuredClone(templates)
        : JSON.parse(JSON.stringify(templates));
}

// ----------------------------------------------------------------------
// Apply template fields to an existing agent
// ----------------------------------------------------------------------

function applyTemplateFields(agent, template) {
    for (const field of TEMPLATE_SYNC_FIELDS) {
        if (template[field] === undefined) continue;

        if (field === 'mergeVariable') {
            // Injection placement is the USER's call, not the template author's:
            // carry the auto-inject preference and custom macro name across a
            // template version bump so re-syncing never silently re-enables
            // auto-injection or drops a {{sa_…}} macro the user placed in a preset.
            const userAutoInject = agent.mergeVariable?.autoInject;
            const userMacroName = agent.mergeVariable?.macroName;
            const userMainContext = agent.mergeVariable?.mainContext;
            const hasUserMainTemplate = typeof userMainContext?.formatItem === 'string';
            const hasLegacyRelationshipProjection = agent.sourceTemplateId === 'tpl-relationship-ledger'
                && userMainContext?.formatItem?.includes('{{#each json.personas}}{{#each characters}}');
            const hasLegacyActivePersonaLabel = agent.sourceTemplateId === 'tpl-relationship-ledger'
                && userMainContext?.formatItem?.includes('{{#each json.characters}}- {{@key}} → active persona');
            agent.mergeVariable = normalizeMergeVariable(template.mergeVariable);
            if (userAutoInject !== undefined) agent.mergeVariable.autoInject = userAutoInject;
            if (userMacroName) agent.mergeVariable.macroName = userMacroName;
            // Once an agent has an explicit main-chat projection, treat that
            // presentation as user-authored territory. Recognized legacy
            // built-ins still upgrade to the current structured default once.
            if (hasUserMainTemplate
                && !hasLegacyRelationshipProjection
                && !hasLegacyActivePersonaLabel) {
                agent.mergeVariable.mainContext = {
                    ...agent.mergeVariable.mainContext,
                    formatHeader: userMainContext.formatHeader,
                    formatItem: userMainContext.formatItem,
                    formatEmpty: userMainContext.formatEmpty,
                };
            }
        } else if (field === 'regexScripts') {
            agent.regexScripts = Array.isArray(template.regexScripts)
                ? template.regexScripts.map(normalizeRegexScript)
                : [];
        } else if (field === 'injection' || field === 'postProcess') {
            // Merge so we don't blow away any defaults the template omits
            agent[field] = { ...agent[field], ...template[field] };
        } else if (field === 'feedConfig') {
            // Keep user-chosen in-world branding across template upgrades. The
            // original default is migrated so existing installs receive the new
            // default without treating it as a customization.
            const currentAppName = String(agent.feedConfig?.appName || '').trim();
            agent.feedConfig = { ...template.feedConfig, ...agent.feedConfig };
            if (!currentAppName || currentAppName === 'Murmur') {
                agent.feedConfig.appName = template.feedConfig.appName;
            }
        } else if (field === 'afterDarkConfig' || field === 'dramaQueenConfig') {
            // Lore probe terms are explicitly user-authored; template upgrades
            // may add config defaults but must not replace that private list.
            const userProbeTerms = agent[field]?.probeTerms;
            agent[field] = { ...template[field], ...agent[field] };
            if (Array.isArray(userProbeTerms)) agent[field].probeTerms = [...userProbeTerms];
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
        debug(`${LOG_PREFIX} fetchAllTemplates failed:`, err);
        return [];
    }

    if (!templates.length) return [];

    const byId = new Map(templates.map(t => [t.id, t]));
    const agents = _internal.getAgentsRef();
    const updated = [];

    for (const agent of agents) {
        if (!isTemplateLinked(agent)) continue;

        const template = byId.get(agent.sourceTemplateId);
        if (!template) continue;

        const have = agent.sourceTemplateVersion ?? 0;
        if ((template.version ?? 0) <= have) continue;

        applyTemplateFields(agent, template);
        updated.push(agent.name || template.name || agent.sourceTemplateId);
    }

    if (updated.length > 0) {
        _internal.persist();
        debug(`${LOG_PREFIX} synced ${updated.length} agent(s) to newer template version(s):`, updated);
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
