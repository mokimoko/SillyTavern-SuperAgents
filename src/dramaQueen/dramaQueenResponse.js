/** Recover the useful outer Drama Queen payload from imperfect model output. */

import { extractJsonObjectCandidates } from '../data/structuredOutput.js';
import { DRAMA_QUEEN_BEATS, normalizeDramaQueenState } from './dramaQueenState.js';

function parseJson(value) {
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    const text = String(value ?? '')
        .trim()
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/i, '');
    if (!text) return null;
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

function unwrapPlan(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const nested = value.drama_queen ?? value.dramaQueen ?? value.plan ?? value.result;
    const parsedNested = parseJson(nested);
    const source = parsedNested || value;
    const proposals = source.proposals ?? source.engines ?? source.options;
    if (Array.isArray(proposals) && !Array.isArray(source.proposals)) {
        return { ...source, proposals };
    }
    // A truncated outer envelope can still contain one or more fully closed
    // proposal objects. The balanced-object extractor returns those objects
    // independently, so wrap proposal-shaped candidates and salvage them.
    if (!Array.isArray(proposals) && (Array.isArray(source.stages)
        || Array.isArray(source.beats) || Array.isArray(source.arc))) {
        return { version: 1, sceneRead: '', proposals: [source], active: null };
    }
    return source;
}

function completePlan(value, minimumProposals = 1) {
    const source = unwrapPlan(value);
    if (!source || !Array.isArray(source.proposals)) return null;
    const normalized = normalizeDramaQueenState({ ...source, active: null });
    const proposals = normalized.proposals.filter(proposal => (
        proposal.stages.length === DRAMA_QUEEN_BEATS.length
        && proposal.stages.every(stage => stage.direction)
        && proposal.incompatibleAgendas.length >= 2
    ));
    return proposals.length >= minimumProposals ? { ...normalized, proposals, active: null } : null;
}

function proposalPlan(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    if (!value.title || !value.faultLine || !Array.isArray(value.stages ?? value.beats ?? value.arc)) return null;
    return completePlan({ version: 1, sceneRead: '', proposals: [value], active: null });
}

export function parseDramaQueenPlanResponse(response, options = {}) {
    const minimumProposals = Math.max(1, Math.min(6,
        Math.floor(Number(options.minimumProposals) || 1)));
    const text = String(response ?? '');
    const tagged = text.match(/\[DRAMA_QUEEN\]\s*([\s\S]*?)\s*\[\/DRAMA_QUEEN\]/i)?.[1];
    const taggedValue = parseJson(tagged);
    if (taggedValue) {
        const state = completePlan(taggedValue, minimumProposals);
        if (state) return state;
    }

    const candidates = extractJsonObjectCandidates(text);
    for (let index = candidates.length - 1; index >= 0; index--) {
        const state = completePlan(candidates[index], minimumProposals);
        if (state) return state;
    }

    // Match After Dark's truncation recovery: retain every fully closed engine
    // rather than returning only the last proposal object before the cutoff.
    const recoveredProposals = [];
    const seenIds = new Set();
    for (const candidate of candidates) {
        const state = proposalPlan(candidate);
        const proposal = state?.proposals[0];
        if (!proposal || seenIds.has(proposal.id)) continue;
        seenIds.add(proposal.id);
        recoveredProposals.push(proposal);
    }
    return recoveredProposals.length >= minimumProposals ? {
        version: 1,
        sceneRead: '',
        proposals: recoveredProposals.slice(0, 6),
        active: null,
    } : null;
}

export function parseDramaQueenPatchResponse(response) {
    const text = String(response ?? '');
    const tagged = text.match(/\[DRAMA_QUEEN_PATCH\]\s*([\s\S]*?)\s*\[\/DRAMA_QUEEN_PATCH\]/i)?.[1];
    const candidates = [parseJson(tagged), ...extractJsonObjectCandidates(text).reverse()].filter(Boolean);
    for (const candidate of candidates) {
        const nested = candidate?.drama_queen_patch ?? candidate?.dramaQueenPatch ?? candidate?.patch;
        const source = parseJson(nested) || candidate;
        if (source && typeof source === 'object' && !Array.isArray(source)) return source;
    }
    return null;
}
