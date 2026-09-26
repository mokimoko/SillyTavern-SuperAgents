/** Pure state shaping and prompt projection for the After Dark UtilityApp. */

import { normalizeAfterDarkState } from '../data/stateCanonicalization.js';

export { normalizeAfterDarkState };

export const AFTER_DARK_VARIABLE = 'sa_after_dark';
export const AFTER_DARK_AUTO_ADVANCE_KEY = 'saAfterDarkAutoAdvance';
export const AFTER_DARK_AUTO_CHECKPOINT_KEY = 'saAfterDarkAutoCheckpoint';
export const AFTER_DARK_PROGRESSION_MODE_KEY = 'saAfterDarkProgressionMode';
export const AFTER_DARK_INJECTION_KEY = 'saAfterDarkIncludeInjection';
export const AFTER_DARK_DROPPED_PLAN_KEY = 'saAfterDarkDroppedPlan';
export const AFTER_DARK_NUDGE_VARIABLE = 'sa_after_dark_nudge';
export const AFTER_DARK_STAGES = Object.freeze([
    'Set the Trap',
    'Cross the Line',
    'Sex Is Underway',
    'Turn It Up',
    'What Now?',
]);

const STRENGTHS = new Set(['opening', 'pursuit', 'pressure', 'commitment']);
const NUDGE_STATUSES = new Set(['hold', 'ready', 'diverged', 'overshot']);
const PROGRESSION_MODES = new Set(['auto', 'nudge', 'none']);

function clean(value, max = 900) {
    return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function hashString(value) {
    let hash = 0x811c9dc5;
    for (let index = 0; index < value.length; index++) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(36);
}

export function readAfterDarkProgressionMode(metadata, config = {}) {
    const stored = String(metadata?.[AFTER_DARK_PROGRESSION_MODE_KEY] || '').trim().toLowerCase();
    if (PROGRESSION_MODES.has(stored)) return stored;
    if (metadata?.[AFTER_DARK_AUTO_ADVANCE_KEY] === true) return 'auto';
    if (config?.smartNudge === true) return 'nudge';
    return 'none';
}

export function writeAfterDarkProgressionMode(metadata, mode) {
    const next = PROGRESSION_MODES.has(mode) ? mode : 'none';
    metadata[AFTER_DARK_PROGRESSION_MODE_KEY] = next;
    metadata[AFTER_DARK_AUTO_ADVANCE_KEY] = next === 'auto';
    return next;
}

export function readAfterDarkAutoAdvance(metadata, config = {}) {
    return readAfterDarkProgressionMode(metadata, config) === 'auto';
}

/** Chat-local master switch. Missing values intentionally migrate to enabled. */
export function readAfterDarkInjectionEnabled(metadata) {
    return metadata?.[AFTER_DARK_INJECTION_KEY] !== false;
}

export function writeAfterDarkInjectionEnabled(metadata, enabled) {
    if (metadata && typeof metadata === 'object') {
        metadata[AFTER_DARK_INJECTION_KEY] = enabled !== false;
    }
    return enabled !== false;
}

export function readAfterDarkAutoCheckpoint(metadata, fallback = -1) {
    const value = Number(metadata?.[AFTER_DARK_AUTO_CHECKPOINT_KEY]);
    return Number.isFinite(value) ? value : Number(fallback);
}

export function emptyAfterDarkState() {
    return { version: 1, sceneRead: '', pitches: [], active: null };
}

export function readAfterDarkState(items) {
    const item = Array.isArray(items) ? items[items.length - 1] : null;
    if (!item) return emptyAfterDarkState();
    const raw = item.json ?? item.text ?? item;
    try {
        return normalizeAfterDarkState(typeof raw === 'string' ? JSON.parse(raw) : raw);
    } catch {
        return emptyAfterDarkState();
    }
}

/** Stable identity for one selected plan revision; active beat is tracked separately. */
export function getAfterDarkPlanIdentity(state) {
    const current = normalizeAfterDarkState(state);
    if (!current.active) return '';
    const pitch = current.pitches[current.active.pitchIndex];
    if (!pitch) return '';
    return `${pitch.id}:${current.active.activatedAtMessage}:${hashString(JSON.stringify(pitch))}`;
}

function getAfterDarkPlanLineage(state) {
    const current = normalizeAfterDarkState(state);
    const pitch = current.active ? current.pitches[current.active.pitchIndex] : null;
    return pitch ? `${pitch.id}:${current.active.activatedAtMessage}` : '';
}

export function markAfterDarkPlanDropped(metadata, state) {
    const identity = getAfterDarkPlanLineage(state);
    if (!metadata || typeof metadata !== 'object') return identity;
    if (identity) metadata[AFTER_DARK_DROPPED_PLAN_KEY] = identity;
    else delete metadata[AFTER_DARK_DROPPED_PLAN_KEY];
    return identity;
}

export function clearAfterDarkDroppedPlan(metadata) {
    if (metadata && typeof metadata === 'object') delete metadata[AFTER_DARK_DROPPED_PLAN_KEY];
}

/** Prevent any older revision of a dropped plan from returning through message/swipe history. */
export function applyAfterDarkDropGuard(state, metadata) {
    const current = normalizeAfterDarkState(state);
    const droppedIdentity = String(metadata?.[AFTER_DARK_DROPPED_PLAN_KEY] || '');
    return current.active && droppedIdentity === getAfterDarkPlanLineage(current)
        ? dropAfterDarkPlan(current)
        : current;
}

export function getAfterDarkStateSignature(state) {
    return JSON.stringify(normalizeAfterDarkState(state));
}

export function normalizeAfterDarkPatch(value) {
    const source = value && typeof value === 'object' ? value : {};
    const startStageIndex = Math.floor(Number(source.startStageIndex));
    const stages = Array.isArray(source.stages)
        ? source.stages.map((stage, offset) => ({
            label: AFTER_DARK_STAGES[startStageIndex + offset] || clean(stage?.label, 60),
            direction: clean(stage?.direction, 900),
        })).filter(stage => stage.direction)
        : [];
    return {
        pitchId: clean(source.pitchId, 60),
        startStageIndex,
        stages,
    };
}

/**
 * Replace a suffix of the active pitch without allowing the model to mutate
 * the locked prefix, unused pitches, or active-stage selection.
 */
export function applyAfterDarkPatch(state, value, expected = {}) {
    const current = normalizeAfterDarkState(state);
    if (!current.active) return { ok: false, state: current, error: 'No active pitch.' };
    const pitchIndex = current.active.pitchIndex;
    const pitch = current.pitches[pitchIndex];
    const patch = normalizeAfterDarkPatch(value);
    const expectedStart = Math.floor(Number(expected.startStageIndex));
    const startStageIndex = Number.isFinite(expectedStart) ? expectedStart : patch.startStageIndex;

    if (!pitch || !patch.pitchId || patch.pitchId !== pitch.id) {
        return { ok: false, state: current, error: 'The patch targets a different pitch.' };
    }
    if (!Number.isInteger(startStageIndex) || startStageIndex < 0 || startStageIndex >= AFTER_DARK_STAGES.length
        || patch.startStageIndex !== startStageIndex) {
        return { ok: false, state: current, error: 'The patch starts at an unexpected beat.' };
    }
    const requiredCount = AFTER_DARK_STAGES.length - startStageIndex;
    if (patch.stages.length !== requiredCount) {
        return { ok: false, state: current, error: `Expected ${requiredCount} replacement beat${requiredCount === 1 ? '' : 's'}.` };
    }

    const lockedPrefix = pitch.stages.slice(0, startStageIndex);
    const nextPitch = { ...pitch, stages: [...lockedPrefix, ...patch.stages] };
    const pitches = current.pitches.map((candidate, index) => index === pitchIndex ? nextPitch : candidate);
    return { ok: true, state: { ...current, pitches }, error: '' };
}

export function readAfterDarkNudge(items) {
    const item = Array.isArray(items) ? items[items.length - 1] : null;
    const raw = item?.json ?? item?.text ?? item;
    try {
        const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
        const status = clean(value?.status, 20).toLowerCase();
        if (!value || value.version !== 1 || value.utility !== 'after-dark' || !NUDGE_STATUSES.has(status)) return null;
        return {
            version: 1,
            utility: 'after-dark',
            planIdentity: clean(value.planIdentity, 160),
            beatIndex: Math.max(0, Math.floor(Number(value.beatIndex) || 0)),
            messageIndex: Math.max(0, Math.floor(Number(value.messageIndex) || 0)),
            swipeId: Math.max(0, Math.floor(Number(value.swipeId) || 0)),
            status,
            reason: clean(value.reason, 240),
        };
    } catch {
        return null;
    }
}

export function getCurrentAfterDarkNudge(state, items) {
    const current = normalizeAfterDarkState(state);
    const nudge = readAfterDarkNudge(items);
    if (!current.active || !nudge) return null;
    return nudge.planIdentity === getAfterDarkPlanIdentity(current)
        && nudge.beatIndex === current.active.stageIndex
        ? nudge
        : null;
}

export function activateAfterDarkPitch(state, pitchIndex, messageIndex) {
    const current = normalizeAfterDarkState(state);
    const index = Math.max(0, Math.min(current.pitches.length - 1, Number(pitchIndex) || 0));
    const pitch = current.pitches[index];
    if (!pitch) return current;
    return {
        ...current,
        active: {
            pitchIndex: index,
            stageIndex: 0,
            strength: pitch.heat,
            activatedAtMessage: Math.max(0, Number(messageIndex) || 0),
        },
    };
}

export function moveAfterDarkStage(state, delta) {
    const current = normalizeAfterDarkState(state);
    if (!current.active) return current;
    const pitch = current.pitches[current.active.pitchIndex];
    const last = Math.max(0, pitch.stages.length - 1);
    return {
        ...current,
        active: {
            ...current.active,
            stageIndex: Math.max(0, Math.min(last, current.active.stageIndex + Number(delta || 0))),
        },
    };
}

export function setAfterDarkStageDirection(state, stageIndex, direction) {
    const current = normalizeAfterDarkState(state);
    if (!current.active) return current;
    const pitchIndex = current.active.pitchIndex;
    const pitch = current.pitches[pitchIndex];
    const index = Math.floor(Number(stageIndex));
    const nextDirection = clean(direction, 900);
    if (!pitch || !Number.isInteger(index) || index < 0 || index >= pitch.stages.length || !nextDirection) {
        return current;
    }
    const stages = pitch.stages.map((stage, candidateIndex) => (
        candidateIndex === index ? { ...stage, direction: nextDirection } : stage
    ));
    const pitches = current.pitches.map((candidate, candidateIndex) => (
        candidateIndex === pitchIndex ? { ...candidate, stages } : candidate
    ));
    return { ...current, pitches };
}

export function shouldAutoAdvanceAfterDark(state, options = {}) {
    const current = normalizeAfterDarkState(state);
    if (!options.enabled || options.generationType !== 'normal' || !current.active) return false;
    const pitch = current.pitches[current.active.pitchIndex];
    if (!pitch || current.active.stageIndex >= pitch.stages.length - 1) return false;
    const lastAssistantIndex = Number(options.lastAssistantIndex);
    const stateMessageIndex = Number(options.stateMessageIndex);
    return Number.isFinite(lastAssistantIndex)
        && Number.isFinite(stateMessageIndex)
        && lastAssistantIndex > stateMessageIndex;
}

export function setAfterDarkStrength(state, strength) {
    const current = normalizeAfterDarkState(state);
    if (!current.active || !STRENGTHS.has(strength)) return current;
    return { ...current, active: { ...current.active, strength } };
}

export function dropAfterDarkPlan(state) {
    return { ...normalizeAfterDarkState(state), active: null };
}

function strengthDirection(strength) {
    return {
        opening: 'Create a believable opening. Make the opportunity clear, then leave room for the user to act.',
        pursuit: 'The relevant NPCs notice the opening and make a move. Do not wait for the user to proposition them.',
        pressure: 'The NPCs or circumstances sustain the pressure and make the opportunity difficult to ignore. Do not decide the user’s response.',
        commitment: 'Move decisively into the planned development unless the user clearly resists or redirects it.',
    }[strength] || '';
}

export function buildAfterDarkInjection(state, options = {}) {
    const current = normalizeAfterDarkState(state);
    if (!current.active) return '';
    const pitch = current.pitches[current.active.pitchIndex];
    const stage = pitch?.stages[current.active.stageIndex];
    if (!pitch || !stage) return '';
    const guardrails = pitch.guardrails.length
        ? `\nPlan-specific boundaries:\n${pitch.guardrails.map(item => `- ${item}`).join('\n')}`
        : '';
    const autoDirection = options.autoAdvance
        ? '\n- Auto is on. Substantially reach this beat during this response; do not merely foreshadow it. Stop before the next beat.'
        : '';
    return `<after_dark_plan>\n## After Dark — Current Beat\nPlan: ${pitch.title}\nCast: ${pitch.cast.join(', ') || 'Use the relevant established participants'}\nTone: ${pitch.flavor}\nSetup: ${pitch.setup}\nDynamic: ${pitch.dynamic}\nKink/motif: ${pitch.kink.idea}${pitch.kink.reason ? ` — ${pitch.kink.reason}` : ''}\n\n### This response\n${stage.label}: ${stage.direction}\nSteering: ${strengthDirection(current.active.strength)}\n\n### Rules\n- Continue with full initiative from the latest event. Keep characterization, continuity, knowledge boundaries, and spatial logic intact.\n- Write only the current beat. Do not rush through later beats or summarize the rest of the plan.\n- Do not stall in charged looks, suggestive banter, or repeated setup when the beat calls for physical action.\n- Sex and desire do not automatically mean love, healing, trust, commitment, confession, tenderness, or relationship progression. Let casual, physical, funny, selfish, messy, kinky, impulsive, dark, or mutually bad-decision sex remain what it is.\n- Once sexual action begins, use direct language, maintain spatial awareness, and do not race to climax.\n- The user controls their persona. Do not write the user’s actions, dialogue, thoughts, consent, arousal, choices, or reactions.${guardrails}${autoDirection}\n</after_dark_plan>`;
}
