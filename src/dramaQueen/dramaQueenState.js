/** Pure state transitions and writer projection for Drama Queen. */

import { DRAMA_QUEEN_BEATS, normalizeDramaQueenState } from '../data/stateCanonicalization.js';

export { DRAMA_QUEEN_BEATS, normalizeDramaQueenState };

export const DRAMA_QUEEN_VARIABLE = 'sa_drama_queen';
export const DRAMA_QUEEN_NUDGE_VARIABLE = 'sa_drama_queen_nudge';
export const DRAMA_QUEEN_INJECTION_KEY = 'saDramaQueenIncludeInjection';
export const DRAMA_QUEEN_DROPPED_PLAN_KEY = 'saDramaQueenDroppedPlan';
export const DRAMA_QUEEN_AUTO_CHECKPOINT_KEY = 'saDramaQueenAutoCheckpoint';
export const DRAMA_QUEEN_PROGRESSION_MODE_KEY = 'saDramaQueenProgressionMode';
export const DRAMA_QUEEN_INTENTS = Object.freeze([
    'find-fault-lines', 'stir-the-pot', 'make-it-worse', 'let-it-haunt-them',
]);
export const DRAMA_QUEEN_PRESSURES = Object.freeze(['simmer', 'press', 'corner', 'break']);
export const DRAMA_QUEEN_DAMAGE_CEILINGS = Object.freeze(['sting', 'strain', 'rupture', 'catastrophe']);

const PRESSURES = new Set(DRAMA_QUEEN_PRESSURES);
const DAMAGE_CEILINGS = new Set(DRAMA_QUEEN_DAMAGE_CEILINGS);
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

export function emptyDramaQueenState() {
    return { version: 1, sceneRead: '', proposals: [], active: null };
}

export function readDramaQueenState(items) {
    const item = Array.isArray(items) ? items.at(-1) : null;
    if (!item) return emptyDramaQueenState();
    const raw = item.json ?? item.text ?? item;
    try {
        return normalizeDramaQueenState(typeof raw === 'string' ? JSON.parse(raw) : raw);
    } catch {
        return emptyDramaQueenState();
    }
}

/** Identity covers only the selected engine revision. Beat and steering are checked separately. */
export function getDramaQueenPlanIdentity(state) {
    const current = normalizeDramaQueenState(state);
    if (!current.active) return '';
    const proposal = current.proposals[current.active.proposalIndex];
    if (!proposal) return '';
    return `${proposal.id}:${current.active.activatedAtMessage}:${hashString(JSON.stringify(proposal))}`;
}

export function readDramaQueenProgressionMode(metadata, config = {}) {
    const stored = String(metadata?.[DRAMA_QUEEN_PROGRESSION_MODE_KEY] || '').trim().toLowerCase();
    if (PROGRESSION_MODES.has(stored)) return stored;
    if (config?.smartNudge === true) return 'nudge';
    return 'none';
}

export function writeDramaQueenProgressionMode(metadata, mode) {
    const next = PROGRESSION_MODES.has(mode) ? mode : 'none';
    if (metadata && typeof metadata === 'object') metadata[DRAMA_QUEEN_PROGRESSION_MODE_KEY] = next;
    return next;
}

export function readDramaQueenAutoCheckpoint(metadata, fallback = -1) {
    const value = Number(metadata?.[DRAMA_QUEEN_AUTO_CHECKPOINT_KEY]);
    return Number.isFinite(value) ? value : Number(fallback);
}

function getDramaQueenPlanLineage(state) {
    const current = normalizeDramaQueenState(state);
    const proposal = current.active ? current.proposals[current.active.proposalIndex] : null;
    return proposal ? `${proposal.id}:${current.active.activatedAtMessage}` : '';
}

/** Chat-local master switch. Existing chats default to enabled. */
export function readDramaQueenInjectionEnabled(metadata) {
    return metadata?.[DRAMA_QUEEN_INJECTION_KEY] !== false;
}

export function writeDramaQueenInjectionEnabled(metadata, enabled) {
    if (metadata && typeof metadata === 'object') {
        metadata[DRAMA_QUEEN_INJECTION_KEY] = enabled !== false;
    }
    return enabled !== false;
}

export function markDramaQueenPlanDropped(metadata, state) {
    const identity = getDramaQueenPlanLineage(state);
    if (!metadata || typeof metadata !== 'object') return identity;
    if (identity) metadata[DRAMA_QUEEN_DROPPED_PLAN_KEY] = identity;
    else delete metadata[DRAMA_QUEEN_DROPPED_PLAN_KEY];
    return identity;
}

export function clearDramaQueenDroppedPlan(metadata) {
    if (metadata && typeof metadata === 'object') delete metadata[DRAMA_QUEEN_DROPPED_PLAN_KEY];
}

/** Prevent any older revision of a dropped engine from returning through message/swipe history. */
export function applyDramaQueenDropGuard(state, metadata) {
    const current = normalizeDramaQueenState(state);
    const droppedIdentity = String(metadata?.[DRAMA_QUEEN_DROPPED_PLAN_KEY] || '');
    return current.active && droppedIdentity === getDramaQueenPlanLineage(current)
        ? dropDramaQueenEngine(current)
        : current;
}

export function getDramaQueenStateSignature(state) {
    return hashString(JSON.stringify(normalizeDramaQueenState(state)));
}

export function activateDramaQueenProposal(state, proposalIndex, messageIndex, options = {}) {
    const current = normalizeDramaQueenState(state);
    const index = Number(proposalIndex);
    if (!Number.isInteger(index) || index < 0 || index >= current.proposals.length) return current;
    return {
        ...current,
        active: {
            proposalIndex: index,
            beatIndex: 0,
            pressure: PRESSURES.has(options.pressure) ? options.pressure : 'simmer',
            damageCeiling: DAMAGE_CEILINGS.has(options.damageCeiling) ? options.damageCeiling : 'strain',
            activatedAtMessage: Math.max(0, Math.floor(Number(messageIndex) || 0)),
        },
    };
}

export function moveDramaQueenBeat(state, delta) {
    const current = normalizeDramaQueenState(state);
    if (!current.active) return current;
    const proposal = current.proposals[current.active.proposalIndex];
    const last = Math.max(0, proposal.stages.length - 1);
    return {
        ...current,
        active: {
            ...current.active,
            beatIndex: Math.max(0, Math.min(last, current.active.beatIndex + Math.trunc(Number(delta) || 0))),
        },
    };
}

export function shouldAutoAdvanceDramaQueen(state, options = {}) {
    const current = normalizeDramaQueenState(state);
    if (!options.enabled || options.generationType !== 'normal' || !current.active) return false;
    const proposal = current.proposals[current.active.proposalIndex];
    if (!proposal || current.active.beatIndex >= proposal.stages.length - 1) return false;
    const lastAssistantIndex = Number(options.lastAssistantIndex);
    const stateMessageIndex = Number(options.stateMessageIndex);
    return Number.isFinite(lastAssistantIndex)
        && Number.isFinite(stateMessageIndex)
        && lastAssistantIndex > stateMessageIndex;
}

export function setDramaQueenStageDirection(state, stageIndex, direction) {
    const current = normalizeDramaQueenState(state);
    if (!current.active) return current;
    const proposalIndex = current.active.proposalIndex;
    const proposal = current.proposals[proposalIndex];
    const index = Math.floor(Number(stageIndex));
    const nextDirection = clean(direction, 900);
    if (!proposal || !Number.isInteger(index) || index < 0 || index >= proposal.stages.length || !nextDirection) {
        return current;
    }
    const stages = proposal.stages.map((stage, candidateIndex) => (
        candidateIndex === index ? { ...stage, direction: nextDirection } : stage
    ));
    const proposals = current.proposals.map((candidate, candidateIndex) => (
        candidateIndex === proposalIndex ? { ...candidate, stages } : candidate
    ));
    return { ...current, proposals };
}

export function setDramaQueenPressure(state, pressure) {
    const current = normalizeDramaQueenState(state);
    if (!current.active || !PRESSURES.has(pressure)) return current;
    return { ...current, active: { ...current.active, pressure } };
}

export function setDramaQueenDamageCeiling(state, damageCeiling) {
    const current = normalizeDramaQueenState(state);
    if (!current.active || !DAMAGE_CEILINGS.has(damageCeiling)) return current;
    return { ...current, active: { ...current.active, damageCeiling } };
}

export function dropDramaQueenEngine(state) {
    return { ...normalizeDramaQueenState(state), active: null };
}

export function normalizeDramaQueenPatch(value) {
    const source = value && typeof value === 'object' ? value : {};
    const anchorBeatIndex = Math.floor(Number(source.anchorBeatIndex));
    const anchorMode = source.anchorMode === 'replace-anchor' ? 'replace-anchor' : 'keep-anchor';
    const replacementStart = anchorBeatIndex + (anchorMode === 'keep-anchor' ? 1 : 0);
    const stages = Array.isArray(source.stages)
        ? source.stages.map((stage, offset) => ({
            label: DRAMA_QUEEN_BEATS[replacementStart + offset] || clean(stage?.label, 60),
            direction: clean(stage?.direction, 900),
        })).filter(stage => stage.direction)
        : [];
    return {
        proposalId: clean(source.proposalId, 60),
        planIdentity: clean(source.planIdentity, 180),
        anchorBeatIndex,
        anchorMode,
        stages,
    };
}

/** Replace exactly one requested suffix while preserving the locked prefix and unused proposals. */
export function applyDramaQueenPatch(state, value, expected = {}) {
    const current = normalizeDramaQueenState(state);
    if (!current.active) return { ok: false, state: current, error: 'No active drama engine.' };
    const proposal = current.proposals[current.active.proposalIndex];
    const patch = normalizeDramaQueenPatch(value);
    const anchorBeatIndex = Math.floor(Number(expected.anchorBeatIndex));
    const anchorMode = expected.anchorMode === 'replace-anchor' ? 'replace-anchor' : 'keep-anchor';
    const planIdentity = getDramaQueenPlanIdentity(current);
    if (!proposal || patch.proposalId !== proposal.id) {
        return { ok: false, state: current, error: 'The patch targets a different proposal.' };
    }
    if (expected.planIdentity && expected.planIdentity !== planIdentity) {
        return { ok: false, state: current, error: 'The active plan changed before the patch was applied.' };
    }
    if (patch.planIdentity && patch.planIdentity !== planIdentity) {
        return { ok: false, state: current, error: 'The patch was generated for a stale plan.' };
    }
    if (!Number.isInteger(anchorBeatIndex) || anchorBeatIndex < 0 || anchorBeatIndex >= DRAMA_QUEEN_BEATS.length
        || patch.anchorBeatIndex !== anchorBeatIndex || patch.anchorMode !== anchorMode) {
        return { ok: false, state: current, error: 'The patch has an unexpected anchor.' };
    }
    const replacementStart = anchorBeatIndex + (anchorMode === 'keep-anchor' ? 1 : 0);
    if (replacementStart >= DRAMA_QUEEN_BEATS.length) {
        return { ok: false, state: current, error: 'There is no beat suffix to replace.' };
    }
    const requiredCount = DRAMA_QUEEN_BEATS.length - replacementStart;
    if (patch.stages.length !== requiredCount) {
        return { ok: false, state: current, error: `Expected ${requiredCount} replacement beats.` };
    }
    const nextProposal = {
        ...proposal,
        stages: [...proposal.stages.slice(0, replacementStart), ...patch.stages],
    };
    return {
        ok: true,
        state: {
            ...current,
            proposals: current.proposals.map((candidate, index) => (
                index === current.active.proposalIndex ? nextProposal : candidate
            )),
        },
        error: '',
    };
}

export function createDramaQueenRequestTarget(message, messageIndex, state) {
    return {
        message,
        messageIndex: Number(messageIndex),
        swipeId: Math.max(0, Number(message?.swipe_id) || 0),
        stateSignature: getDramaQueenStateSignature(state),
        planIdentity: getDramaQueenPlanIdentity(state),
        beatIndex: normalizeDramaQueenState(state).active?.beatIndex ?? -1,
    };
}

export function isDramaQueenRequestTargetCurrent(target, message, messageIndex, state) {
    return !!target && target.message === message
        && target.messageIndex === Number(messageIndex)
        && target.swipeId === Math.max(0, Number(message?.swipe_id) || 0)
        && target.stateSignature === getDramaQueenStateSignature(state)
        && target.planIdentity === getDramaQueenPlanIdentity(state)
        && target.beatIndex === (normalizeDramaQueenState(state).active?.beatIndex ?? -1);
}

export function readDramaQueenNudge(items) {
    const item = Array.isArray(items) ? items.at(-1) : null;
    const raw = item?.json ?? item?.text ?? item;
    try {
        const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
        const status = clean(value?.status, 20).toLowerCase();
        if (value?.version !== 1 || value.utility !== 'drama-queen' || !NUDGE_STATUSES.has(status)) return null;
        return {
            version: 1,
            utility: 'drama-queen',
            planIdentity: clean(value.planIdentity, 180),
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

export function getCurrentDramaQueenNudge(state, items) {
    const current = normalizeDramaQueenState(state);
    const nudge = readDramaQueenNudge(items);
    if (!current.active || !nudge) return null;
    return nudge.planIdentity === getDramaQueenPlanIdentity(current)
        && nudge.beatIndex === current.active.beatIndex
        ? nudge : null;
}

function pressureDirection(pressure) {
    return {
        simmer: 'Keep the pressure credible and restrained; sharpen subtext without forcing the milestone.',
        press: 'Have NPCs actively test resistance and make avoidance uncomfortable.',
        corner: 'Close plausible exits and demand an answer, while leaving the player persona free to choose.',
        break: 'Drive this beat to a decisive collision now, within the damage ceiling.',
    }[pressure] || '';
}

function damageDirection(ceiling) {
    return {
        sting: 'Limit lasting harm to embarrassment, irritation, a small loss, or a bruise to trust.',
        strain: 'Relationships or circumstances may be seriously stressed, but remain realistically repairable.',
        rupture: 'A bond, alliance, status, or safety net may break; do not escalate to irreversible catastrophe.',
        catastrophe: 'Major irreversible fallout is allowed when earned by canon and the current beat.',
    }[ceiling] || '';
}

export function buildDramaQueenInjection(state) {
    const current = normalizeDramaQueenState(state);
    if (!current.active) return '';
    const proposal = current.proposals[current.active.proposalIndex];
    const stage = proposal?.stages[current.active.beatIndex];
    if (!proposal || !stage) return '';
    const guardrails = proposal.guardrails.length
        ? `\nPlan-specific guardrails:\n${proposal.guardrails.map(item => `- ${item}`).join('\n')}` : '';
    return `<drama_queen_plan>\n## Drama Queen — Current Beat\nEngine: ${proposal.title}\nCast: ${proposal.cast.join(', ') || 'Use only relevant established participants'}\nFault line: ${proposal.faultLine}\nStakes: ${proposal.stakes}\n\n### This response\n${stage.label}: ${stage.direction}\nPressure: ${pressureDirection(current.active.pressure)}\nDamage ceiling: ${damageDirection(current.active.damageCeiling)}\n\n### Rules\n- Write only the current beat. Future beats and unused proposals are private and must not be inferred or previewed.\n- Preserve characterization, established facts, knowledge boundaries, and spatial logic. Do not add melodramatic randomness just to intensify conflict.\n- Do not dissolve meaningful friction with a frictionless apology, instant forgiveness, consequence-erasing reconciliation, or premature resolution.\n- Let choices and consequences remain difficult, but never exceed the stated damage ceiling. Pressure changes aggressiveness, not the maximum permitted outcome.\n- The user controls their persona. Never write the user persona's thoughts, dialogue, decisions, emotions, or reactions.${guardrails}\n</drama_queen_plan>`;
}
