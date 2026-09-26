/**
 * Stable state contract and narrow command surface for optional integrations.
 * Consumers must feature-detect `window.SuperAgents.integration` and its
 * `apiVersion`; they should never import SuperAgents files directly.
 */

import { chat } from '../../../../../../script.js';
import { getAgents, isAgentsPaused } from '../data/store.js';
import { readMergeArray, resolveStateTraceDetailed } from '../modes/mergeVariable.js';
import { projectActivePersona } from '../core/participants.js';
import { SUPERAGENTS_EVENTS } from './events.js';
import {
    KNOWLEDGE_ACCESS_API_VERSION,
    checkKnowledgeCapability,
    isKnowledgeStateAgent,
    knowledgeCapabilities,
    listKnowledgeCandidates,
} from './knowledgeAccess.js';

export const INTEGRATION_API_VERSION = 10;

function clone(value) {
    if (value === undefined) return undefined;
    try {
        return structuredClone(value);
    } catch {
        return JSON.parse(JSON.stringify(value));
    }
}

function findStateAgent(variableName) {
    return getAgents().find(agent => agent.mergeVariable?.enabled
        && agent.mergeVariable.variableName === variableName) ?? null;
}

function logicalValue(agent, items) {
    if (!Array.isArray(items)) return null;
    const jsonField = agent?.mergeVariable?.validation?.jsonField;
    if (jsonField && items.length === 1 && typeof items[0]?.[jsonField] === 'string') {
        try {
            return JSON.parse(items[0][jsonField]);
        } catch {
            return null;
        }
    }

    if (agent?.mergeVariable?.mode === 'snapshot' && items.length === 1) {
        const { _addedAt, _messageIndex, ...value } = items[0];
        return value;
    }
    return items;
}

function resolveState(variableName, options = {}) {
    const agent = findStateAgent(variableName);
    const requestedIndex = Number(options.messageIndex);
    const messageIndex = Number.isInteger(requestedIndex)
        ? Math.max(0, Math.min(requestedIndex, Math.max(0, chat.length - 1)))
        : chat.length - 1;
    const swipeId = options.swipeId ?? chat[messageIndex]?.swipe_id ?? 0;

    let items = null;
    let distance = Infinity;
    let sourceMessageIndex = -1;
    if (options.preferLive === true) {
        const live = readMergeArray(variableName);
        if (live.length) {
            items = live;
            distance = 0;
        }
    } else if (chat.length && messageIndex >= 0) {
        const trace = resolveStateTraceDetailed(chat, messageIndex, swipeId, variableName);
        items = trace.items;
        distance = trace.distance;
        sourceMessageIndex = trace.foundIndex;
    }

    // Landing-page/manual consumers can still inspect the live chat variable.
    if (items === null) {
        const live = readMergeArray(variableName);
        if (live.length) items = live;
    }

    // Persona-scoped trackers (Relationship Ledger) store personas.<name>.<slice>.
    // Consumers expect the character-keyed slice, so project the active persona
    // here — the persona dimension stays transparent to DE and other readers.
    const rawValue = logicalValue(agent, items);
    const value = agent?.mergeVariable?.personaScoped ? projectActivePersona(rawValue) : rawValue;

    return clone({
        found: items !== null,
        apiVersion: INTEGRATION_API_VERSION,
        agentId: agent?.id ?? null,
        agentName: agent?.name ?? null,
        variableName,
        schemaVersion: agent?.mergeVariable?.validation?.schemaVersion ?? null,
        messageIndex,
        swipeId,
        sourceMessageIndex,
        distance,
        value,
        items,
    });
}

function resolveAgentState(agentId, options = {}) {
    const agent = getAgents().find(candidate => candidate.id === agentId);
    const variableName = agent?.mergeVariable?.variableName;
    return variableName ? resolveState(variableName, options) : null;
}

function listStateSources() {
    return getAgents()
        .filter(agent => agent.mergeVariable?.enabled && agent.mergeVariable.variableName)
        .map(agent => ({
            agentId: agent.id,
            agentName: agent.name,
            enabled: agent.enabled,
            paused: Boolean(agent.paused || isAgentsPaused()),
            variableName: agent.mergeVariable.variableName,
            mode: agent.mergeVariable.mode,
            validated: Boolean(agent.mergeVariable.validation?.enabled),
            schemaVersion: agent.mergeVariable.validation?.schemaVersion ?? null,
        }));
}

function humanizeFieldName(value) {
    return String(value || '')
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/[_-]+/g, ' ')
        .replace(/^./, match => match.toUpperCase());
}

function describeValidationSchema(schema) {
    const fields = [];
    const collections = [];

    function walk(node, path = '') {
        if (!node || typeof node !== 'object') return;
        const properties = node.properties && typeof node.properties === 'object'
            ? node.properties
            : null;
        if (properties) {
            for (const [key, child] of Object.entries(properties)) {
                walk(child, path ? `${path}.${key}` : key);
            }
        }

        if (node.additionalProperties && typeof node.additionalProperties === 'object') {
            collections.push({
                path,
                placeholder: '$subject',
                itemPath: path ? `${path}.$subject` : '$subject',
            });
            walk(node.additionalProperties, path ? `${path}.$subject` : '$subject');
        }

        const types = Array.isArray(node.type) ? node.type : [node.type].filter(Boolean);
        if (path && types.some(type => ['number', 'integer', 'string', 'boolean', 'array'].includes(type))) {
            const key = path.split('.').at(-1);
            fields.push({
                path,
                key,
                label: humanizeFieldName(key),
                type: types.length === 1 ? types[0] : types,
                minimum: Number.isFinite(node.minimum) ? node.minimum : null,
                maximum: Number.isFinite(node.maximum) ? node.maximum : null,
                enum: Array.isArray(node.enum) ? clone(node.enum) : null,
            });
        }
    }

    walk(schema);
    return { fields, collections };
}

function valueAtPath(root, rawPath) {
    let current = root;
    for (const part of String(rawPath || '').split('.').filter(Boolean)) {
        if (current === null || typeof current !== 'object') return undefined;
        current = current[part];
    }
    return current;
}

function describeStateSource(variableName, options = {}) {
    const agent = findStateAgent(variableName);
    if (!agent) return null;
    const validation = agent.mergeVariable?.validation || {};
    // Persona-scoped trackers nest the character-keyed ledger under
    // personas.<name>. Consumers bind against the character-keyed slice, so
    // describe the INNER schema (collections come out as `characters`, not
    // `personas`) and read subjects from the active-persona projection that
    // resolveState already applied.
    const describedSchema = agent.mergeVariable?.personaScoped
        ? (validation.schema?.properties?.personas?.additionalProperties ?? validation.schema)
        : validation.schema;
    const description = describeValidationSchema(describedSchema);
    const resolved = resolveState(variableName, options);
    const collections = description.collections.map(collection => {
        const value = valueAtPath(resolved?.value, collection.path);
        return {
            ...collection,
            subjects: value && typeof value === 'object' && !Array.isArray(value)
                ? Object.entries(value)
                    .filter(([, entry]) => entry?.attention !== 'dormant')
                    .map(([subject]) => subject)
                : [],
        };
    });

    return clone({
        agentId: agent.id,
        agentName: agent.name,
        variableName,
        validated: Boolean(validation.enabled),
        schemaVersion: validation.schemaVersion ?? null,
        fields: description.fields,
        collections,
    });
}

function listKnowledgeSources() {
    return getAgents()
        .filter(isKnowledgeStateAgent)
        .map(agent => ({
            agentId: agent.id,
            agentName: agent.name,
            enabled: agent.enabled,
            variableName: agent.mergeVariable.variableName,
            schemaVersion: agent.mergeVariable.validation?.schemaVersion ?? null,
        }));
}

function resolveKnowledgeSource(requestedSource) {
    const sources = listKnowledgeSources();
    const requested = String(requestedSource || '').trim();
    return sources.find(source => source.variableName === requested)
        || (!requested ? sources.find(source => source.enabled !== false) : null)
        || null;
}

function createKnowledgeAccessApi() {
    return Object.freeze({
        apiVersion: KNOWLEDGE_ACCESS_API_VERSION,
        automaticDisclosure: false,
        capabilities: Object.freeze(knowledgeCapabilities()),
        listSources: () => clone(listKnowledgeSources()),
        check: (options = {}) => {
            const source = resolveKnowledgeSource(options.source);
            if (!source || source.enabled === false) {
                return {
                    allowed: false,
                    capability: String(options.capability || ''),
                    reasonCodes: ['knowledge-source-unavailable'],
                    candidate: null,
                };
            }
            const resolved = resolveState(source.variableName, options);
            const record = resolved?.value?.facts?.[options.factId];
            return clone(checkKnowledgeCapability(record, options));
        },
        listCandidates: (options = {}) => {
            const source = resolveKnowledgeSource(options.source);
            if (!source || source.enabled === false) return [];
            const resolved = resolveState(source.variableName, options);
            return clone(listKnowledgeCandidates(resolved?.value, options));
        },
    });
}

export function createPublicIntegrationApi({ phone = {}, feed = {}, calendar = null, activity = null, presentation = null } = {}) {
    const phoneApi = Object.freeze({
        isEnabled: () => Boolean(phone.isEnabled?.()),
        getThread: (character, options = {}) => clone(phone.getThread?.(character, options) ?? null),
        listThreads: (options = {}) => clone(phone.listThreads?.(options) ?? {}),
        requestText: async (options = {}) => clone(await phone.requestText?.(options) ?? {
            accepted: false,
            textsGenerated: 0,
            error: 'phone integration is unavailable',
        }),
    });
    const feedApi = Object.freeze({
        isEnabled: () => Boolean(feed.isEnabled?.()),
        listPosts: (options = {}) => clone(feed.listPosts?.(options) ?? []),
        getPost: (postId, options = {}) => clone(feed.getPost?.(postId, options) ?? null),
        requestPost: async (options = {}) => clone(await feed.requestPost?.(options) ?? {
            accepted: false,
            postsGenerated: 0,
            error: 'feed integration is unavailable',
        }),
    });
    const knowledgeApi = createKnowledgeAccessApi();

    return Object.freeze({
        apiVersion: INTEGRATION_API_VERSION,
        events: SUPERAGENTS_EVENTS,
        listStateSources,
        describeStateSource,
        getState: resolveState,
        getAgentState: resolveAgentState,
        knowledge: knowledgeApi,
        presentation: presentation ?? Object.freeze({
            apiVersion: 0,
            listProfiles: () => [],
            getProfile: () => null,
            getProfileId: () => 'modern',
            setProfile: () => 'modern',
            getSurface: () => null,
            getAction: () => null,
        }),
        phone: phoneApi,
        feed: feedApi,
        calendar: calendar ?? Object.freeze({
            apiVersion: 0,
            listProfiles: () => [],
            getProfile: () => null,
            setProfile: () => 'modern',
            list: () => [],
            get: () => null,
            create: () => null,
            update: () => null,
            setStatus: () => null,
            remove: () => false,
        }),
        activity: activity ?? Object.freeze({
            apiVersion: 0,
            list: () => [],
            get: () => null,
            publish: () => null,
            registerSource: () => () => {},
            openSource: async () => ({ opened: false, error: 'activity integration is unavailable' }),
            notifications: Object.freeze({
                list: () => [],
                getUnreadCount: () => 0,
                markRead: () => false,
                markAllRead: () => {},
            }),
        }),
    });
}
