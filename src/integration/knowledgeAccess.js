export const KNOWLEDGE_ACCESS_API_VERSION = 1;

export const KnowledgeCapability = Object.freeze({
    NOTICE: 'notice',
    INVESTIGATE: 'investigate',
    CONCEAL: 'conceal',
    COVER_STRAIN: 'cover-strain',
    APPROACH_EVIDENCE: 'approach-evidence',
    DISCLOSE: 'disclose',
});

const SAFE_CAPABILITIES = Object.freeze([
    KnowledgeCapability.NOTICE,
    KnowledgeCapability.INVESTIGATE,
    KnowledgeCapability.CONCEAL,
    KnowledgeCapability.COVER_STRAIN,
    KnowledgeCapability.APPROACH_EVIDENCE,
]);
const UNCERTAIN_POSITIONS = new Set(['suspects-true', 'suspects-false', 'uncertain']);
const INFORMED_POSITIONS = new Set(['knows-true', 'knows-false', 'believes-true', 'believes-false']);
const CONCEALMENT_INTENTS = new Set(['conceal', 'protect']);

function text(value) {
    return String(value ?? '').trim();
}

function matchesPerspective(perspective, character) {
    return text(perspective?.character).localeCompare(character, undefined, { sensitivity: 'accent' }) === 0;
}

function candidateKey(factId, character, capability) {
    const input = `${factId}\u0000${character}\u0000${capability}`;
    let hash = 2166136261;
    for (let index = 0; index < input.length; index += 1) {
        hash ^= input.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return `knowledge-${(hash >>> 0).toString(36)}`;
}

function denied(capability, reasonCodes) {
    return {
        allowed: false,
        capability,
        reasonCodes: [...new Set(reasonCodes)],
        candidate: null,
    };
}

function redactedCandidate(record, factId, perspective, capability) {
    return {
        recordId: factId,
        character: text(perspective.character),
        capability,
        position: perspective.position,
        access: perspective.access,
        disclosureIntent: perspective.disclosureIntent,
        visibility: record.visibility,
        sensitivity: record.sensitivity,
        recordType: record.recordType,
        hasCoverStory: Boolean(record.coverFor?.length || record.coverStories?.length),
        prerequisiteCount: Array.isArray(record.revealPrerequisites)
            ? record.revealPrerequisites.length
            : 0,
        attention: 'active',
    };
}

export function isKnowledgeStateAgent(agent) {
    const merge = agent?.mergeVariable;
    const factSchema = merge?.validation?.schema?.properties?.facts?.additionalProperties;
    return Boolean(merge?.enabled
        && merge?.validation?.enabled
        && merge?.variableName
        && factSchema?.properties?.perspectives
        && (merge.retention?.strategy === 'knowledge'
            || merge.mainContext?.mode === 'knowledge'
            || agent.sourceTemplateId === 'tpl-knowledge-ledger'));
}

/**
 * Evaluate a non-disclosing narrative capability against one fact perspective.
 * Returned candidates intentionally omit the proposition, truth, policy prose,
 * evidence basis, and prerequisite text.
 */
export function checkKnowledgeCapability(record, {
    factId = '',
    character = '',
    capability = '',
} = {}) {
    const normalizedCapability = text(capability);
    if (normalizedCapability === KnowledgeCapability.DISCLOSE) {
        return denied(normalizedCapability, ['automatic-disclosure-disabled']);
    }
    if (!SAFE_CAPABILITIES.includes(normalizedCapability)) {
        return denied(normalizedCapability, ['unknown-capability']);
    }
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
        return denied(normalizedCapability, ['record-unavailable']);
    }

    const reasons = [];
    if (record.attention !== 'active') reasons.push('record-inactive');
    if (record.lifecycle === 'resolved') reasons.push('record-resolved');
    const normalizedCharacter = text(character);
    const perspectives = Array.isArray(record.perspectives)
        ? record.perspectives.filter(item => matchesPerspective(item, normalizedCharacter))
        : [];
    if (!normalizedCharacter || perspectives.length === 0) reasons.push('perspective-missing');
    if (perspectives.length > 1) reasons.push('perspective-ambiguous');
    if (reasons.length) return denied(normalizedCapability, reasons);

    const perspective = perspectives[0];
    const position = text(perspective.position);
    const intent = text(perspective.disclosureIntent);
    if (position === 'unaware') return denied(normalizedCapability, ['perspective-unaware']);

    switch (normalizedCapability) {
        case KnowledgeCapability.NOTICE:
            if (!UNCERTAIN_POSITIONS.has(position)) reasons.push('position-not-eligible');
            break;
        case KnowledgeCapability.INVESTIGATE:
            if (!UNCERTAIN_POSITIONS.has(position)) reasons.push('position-not-eligible');
            if (intent !== 'investigate') reasons.push('intent-not-eligible');
            break;
        case KnowledgeCapability.CONCEAL:
            if (!INFORMED_POSITIONS.has(position)) reasons.push('position-not-eligible');
            if (!CONCEALMENT_INTENTS.has(intent)) reasons.push('intent-not-eligible');
            break;
        case KnowledgeCapability.COVER_STRAIN:
            if (!UNCERTAIN_POSITIONS.has(position)) reasons.push('position-not-eligible');
            if (!record.coverFor?.length && !record.coverStories?.length) reasons.push('no-linked-cover-story');
            break;
        case KnowledgeCapability.APPROACH_EVIDENCE:
            if (!UNCERTAIN_POSITIONS.has(position)) reasons.push('position-not-eligible');
            if (intent !== 'investigate') reasons.push('intent-not-eligible');
            if (!record.revealPrerequisites?.length) reasons.push('no-reveal-prerequisite');
            break;
        default:
            reasons.push('unknown-capability');
    }
    if (reasons.length) return denied(normalizedCapability, reasons);

    return {
        allowed: true,
        capability: normalizedCapability,
        reasonCodes: [],
        candidate: redactedCandidate(record, text(factId), perspective, normalizedCapability),
    };
}

export function listKnowledgeCandidates(state, { capabilities = SAFE_CAPABILITIES } = {}) {
    const requested = [...new Set((Array.isArray(capabilities) ? capabilities : [capabilities])
        .map(text)
        .filter(capability => SAFE_CAPABILITIES.includes(capability)))];
    const facts = state?.facts;
    if (!facts || typeof facts !== 'object' || Array.isArray(facts) || !requested.length) return [];

    const candidates = [];
    const usedKeys = new Map();
    for (const [factId, record] of Object.entries(facts)) {
        for (const perspective of record?.perspectives || []) {
            const character = text(perspective?.character);
            for (const capability of requested) {
                const result = checkKnowledgeCapability(record, { factId, character, capability });
                if (!result.allowed) continue;
                const baseKey = candidateKey(factId, character, capability);
                const collision = usedKeys.get(baseKey) || 0;
                usedKeys.set(baseKey, collision + 1);
                candidates.push({
                    key: collision ? `${baseKey}-${collision + 1}` : baseKey,
                    value: result.candidate,
                });
            }
        }
    }
    return candidates;
}

export function knowledgeCapabilities() {
    return [...SAFE_CAPABILITIES];
}
