/** Recover complete After Dark pitches from imperfect or truncated model output. */

import { extractJsonObjectCandidates } from '../data/structuredOutput.js';
import { AFTER_DARK_STAGES, normalizeAfterDarkState } from './afterDarkState.js';

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
    const nested = value.after_dark ?? value.afterDark ?? value.plan ?? value.result;
    const source = parseJson(nested) || value;
    const pitches = source.pitches ?? source.options ?? source.ideas;
    return Array.isArray(pitches) && !Array.isArray(source.pitches)
        ? { ...source, pitches }
        : source;
}

function completeState(value) {
    const source = unwrapPlan(value);
    if (!source || !Array.isArray(source.pitches)) return null;
    const normalized = normalizeAfterDarkState({ ...source, active: null });
    const pitches = normalized.pitches.filter(pitch => (
        pitch.stages.length === AFTER_DARK_STAGES.length
        && pitch.stages.every(stage => stage.direction)
    ));
    return pitches.length ? { ...normalized, pitches, active: null } : null;
}

function pitchState(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    if (!value.title || !value.setup || !Array.isArray(value.stages)) return null;
    return completeState({ version: 1, sceneRead: '', pitches: [value], active: null });
}

export function parseAfterDarkPlanResponse(response) {
    const text = String(response ?? '');
    const tagged = text.match(/\[AFTER_DARK\]\s*([\s\S]*?)\s*\[\/AFTER_DARK\]/i)?.[1];
    const taggedValue = parseJson(tagged);
    if (taggedValue) {
        const state = completeState(taggedValue);
        if (state) return state;
    }

    const candidates = extractJsonObjectCandidates(text);

    // Complete outer objects close last. Prefer one of those before considering
    // isolated pitch objects recovered from a truncated outer array.
    for (let index = candidates.length - 1; index >= 0; index--) {
        const state = completeState(candidates[index]);
        if (state) return state;
    }

    const recoveredPitches = [];
    const seenIds = new Set();
    for (const candidate of candidates) {
        const state = pitchState(candidate);
        const pitch = state?.pitches[0];
        if (!pitch || seenIds.has(pitch.id)) continue;
        seenIds.add(pitch.id);
        recoveredPitches.push(pitch);
    }
    return recoveredPitches.length ? {
        version: 1,
        sceneRead: '',
        pitches: recoveredPitches.slice(0, 6),
        active: null,
    } : null;
}
