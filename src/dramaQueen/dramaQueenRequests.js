/** Provider requests for private Drama Queen planning. State commits remain a UI concern. */

import { callAgentLLM, isAbortError } from '../core/llm.js';
import { getGlobalSettings } from '../data/store.js';
import { buildDramaQueenAdaptationContext, buildDramaQueenAnalysisContext } from './dramaQueenContext.js';
import { parseDramaQueenPatchResponse, parseDramaQueenPlanResponse } from './dramaQueenResponse.js';
import {
    DRAMA_QUEEN_BEATS,
    DRAMA_QUEEN_INTENTS,
    createDramaQueenRequestTarget,
    getDramaQueenPlanIdentity,
    normalizeDramaQueenPatch,
    normalizeDramaQueenState,
} from './dramaQueenState.js';

const LOG_PREFIX = '[SuperAgents/dramaQueen]';
const INTENT_LABELS = {
    'find-fault-lines': 'Find the Fault Lines',
    'stir-the-pot': 'Stir the Pot',
    'make-it-worse': 'Make It Worse',
    'let-it-haunt-them': 'Let It Haunt Them',
};

export async function requestDramaQueenPlan(agent, priorState, options = {}) {
    if (!agent) return { ok: false, error: 'Drama Queen is unavailable.' };
    const intent = DRAMA_QUEEN_INTENTS.includes(options.intent) ? options.intent : 'stir-the-pot';
    const proposalCount = Math.max(1, Math.min(6,
        Math.floor(Number(options.proposalCount ?? agent.dramaQueenConfig?.proposalCount) || 4)));
    const target = createDramaQueenRequestTarget(options.message, options.messageIndex, priorState);
    const systemPrompt = await buildDramaQueenAnalysisContext(agent, options);
    const normalizedPrior = normalizeDramaQueenState(priorState);
    const activeProposal = normalizedPrior.active
        ? normalizedPrior.proposals[normalizedPrior.active.proposalIndex]
        : null;
    const priorProposalSummary = normalizedPrior.proposals.map(proposal => ({
        id: proposal.id,
        title: proposal.title,
        catalyst: proposal.catalyst?.event || '',
        faultLine: proposal.faultLine,
    }));
    const provenanceRule = intent === 'find-fault-lines'
        ? 'Mine established canon only: do not invent backstory or offscreen facts. The catalyst must still be a proposed next development that activates an established fault line, not a recap of the latest scene; use established or inferred provenance.'
        : intent === 'let-it-haunt-them'
            ? 'Build delayed fallout from active conflict or the private event note. Label note-derived catalysts user-note.'
            : 'Take a bolder turn. Grounded new catalysts are welcome and must be labeled new-catalyst; favor complications caused by a character pursuing something over arbitrary accidents.';
    const userContent = [
        `Planning intent: ${INTENT_LABELS[intent]}. Return ${proposalCount} distinct dramatic engine proposal${proposalCount === 1 ? '' : 's'}.`,
        provenanceRule,
        intent === 'let-it-haunt-them' && activeProposal
            ? `Existing active conflict to build delayed fallout from:\n${JSON.stringify({
                proposal: activeProposal,
                active: normalizedPrior.active,
            })}`
            : priorProposalSummary.length
                ? `Previously shown engines are an avoid-repeat list, not material to continue. Return genuinely new alternatives; do not reuse their IDs, titles, catalysts, or central arcs:\n${JSON.stringify(priorProposalSummary)}`
                : '',
        'This is private author planning, not an argument generator or an ethics summary. Build forward motion from incompatible agendas, active wants, tactics, leverage, temptation, stakes, and consequences—not generic insults, passive discomfort, misunderstandings, or random disasters.',
        'For each engine, silently identify the non-player mover, their immediate want, and the tactic that sets the chain in motion. Express those specifics throughout the returned fields; do not merely explain that the present situation could damage trust or dignity.',
        'Before drafting the JSON, silently brainstorm more possibilities than requested, reject any that reuse a sibling\'s catalyst or central choice, and return only the strongest distinct engines.',
        'The proposals must fan out. Use meaningfully different dramatic machinery and trajectories—such as a secret or lie coming due, a tempting opportunity with a price, a loyalty or alliance shift, a status reversal, a public/private contradiction, or a character-specific wildcard—choosing only what the supplied material can support.',
        'Every catalyst must occur after the latest supplied story moment and materially change what someone can or must do next. An established quote, gesture, room choice, cover story, or other action that already happened is evidence for an engine, not its catalyst.',
        'Each engine needs an earned turn before the cost lands: change who has leverage, what someone believes, which alliance holds, or which escape remains. Escalation must not be six repetitions of the opening problem at increasing volume.',
        'Make stakes and consequences concrete. Name access, allegiance, duty, reputation, safety, leverage, a promise, a resource, or a future option that can actually change instead of saying only that trust, dignity, tension, or a relationship is at risk.',
        'Every proposal must contain exactly six stages with the canonical labels in order. Keep future beats private. Damage limits will be applied by the controller, so make the directions scalable rather than assuming maximum destruction.',
        'Be compact: sceneRead is one sentence; each metadata field is one short sentence; each beat direction is at most two short sentences. Complete every required beat before adding detail.',
        'Return only one object inside [DRAMA_QUEEN] tags with top-level version, sceneRead, proposals, and active:null.',
        '[DRAMA_QUEEN]',
        JSON.stringify({
            version: 1,
            sceneRead: 'Current dramatic pressure in one sentence.',
            proposals: [{
                id: 'short-id', title: 'Engine title', cast: ['Character'], intent,
                faultLine: 'Established incompatibility.', incompatibleAgendas: ['Agenda A', 'Agenda B'],
                refusal: 'What someone will not accept.', leverage: 'Credible source of pressure.', stakes: 'What can be lost.',
                catalyst: { event: 'Triggering development.', provenance: 'established', basis: 'Why it is grounded.' },
                easyExit: 'The painless escape the arc can remove.', consequences: ['Concrete possible fallout.'],
                stages: DRAMA_QUEEN_BEATS.map(label => ({ label, direction: 'Self-contained authorial direction.' })),
                guardrails: ['Do not author the player persona.'],
            }],
            active: null,
        }),
        '[/DRAMA_QUEEN]',
    ].filter(Boolean).join('\n\n');
    try {
        const response = await callAgentLLM({
            systemPrompt,
            userContent,
            profileRef: agent.connectionProfile || '',
            maxTokens: Math.min(6000, Math.max(4000, proposalCount * 1500)),
            callerName: 'drama-queen-plan',
            signal: options.signal ?? null,
            timeoutMs: getGlobalSettings().agentCallTimeoutMs,
        });
        const state = parseDramaQueenPlanResponse(response, {
            minimumProposals: Math.min(2, proposalCount),
        });
        return state ? { ok: true, state, target } : {
            ok: false, error: 'The response ended before two complete drama options could be recovered. Your previous options were preserved.', target,
        };
    } catch (error) {
        if (isAbortError(error)) return { ok: false, cancelled: true, error: error.message, target };
        console.error(`${LOG_PREFIX} planning request failed`, error);
        return { ok: false, error: error?.message || 'The planning call failed.', target };
    }
}

/** Intent-level entry point for the UI: Make It Worse is always a suffix adaptation. */
export function requestDramaQueenIntent(agent, state, options = {}) {
    if (options.intent === 'make-it-worse') {
        const activeBeatIndex = normalizeDramaQueenState(state).active?.beatIndex;
        return requestDramaQueenAdaptation(agent, state, {
            ...options,
            anchorBeatIndex: Number.isInteger(Number(options.anchorBeatIndex))
                ? Number(options.anchorBeatIndex)
                : activeBeatIndex,
            anchorMode: options.anchorMode === 'replace-anchor' ? 'replace-anchor' : 'keep-anchor',
        });
    }
    return requestDramaQueenPlan(agent, state, options);
}

export async function requestDramaQueenAdaptation(agent, state, options = {}) {
    const proposal = state?.active ? state.proposals?.[state.active.proposalIndex] : null;
    const anchorBeatIndex = Math.floor(Number(options.anchorBeatIndex));
    const anchorMode = options.anchorMode === 'replace-anchor' ? 'replace-anchor' : 'keep-anchor';
    const replacementStart = anchorBeatIndex + (anchorMode === 'keep-anchor' ? 1 : 0);
    if (!agent || !proposal || !Number.isInteger(anchorBeatIndex) || anchorBeatIndex < 0
        || replacementStart >= DRAMA_QUEEN_BEATS.length) {
        return { ok: false, error: 'There is no valid unfinished beat suffix to adapt.' };
    }
    const target = createDramaQueenRequestTarget(options.message, options.messageIndex, state);
    const planIdentity = getDramaQueenPlanIdentity(state);
    const systemPrompt = await buildDramaQueenAdaptationContext(agent, state, options);
    const userContent = [
        `Rewrite exactly ${DRAMA_QUEEN_BEATS.length - replacementStart} beats beginning at zero-based index ${replacementStart}.`,
        'Respect the active damage ceiling. Preserve meaningful friction, established causality, and player authorship.',
        'Return only this compact object:',
        '[DRAMA_QUEEN_PATCH]',
        JSON.stringify({
            proposalId: proposal.id,
            planIdentity,
            anchorBeatIndex,
            anchorMode,
            stages: DRAMA_QUEEN_BEATS.slice(replacementStart).map(label => ({ label, direction: '...' })),
        }),
        '[/DRAMA_QUEEN_PATCH]',
    ].join('\n');
    try {
        const response = await callAgentLLM({
            systemPrompt,
            userContent,
            profileRef: agent.connectionProfile || '',
            maxTokens: Math.min(2200, Math.max(650, (DRAMA_QUEEN_BEATS.length - replacementStart) * 280)),
            callerName: 'drama-queen-adapt',
            signal: options.signal ?? null,
            timeoutMs: getGlobalSettings().agentCallTimeoutMs,
        });
        const patch = normalizeDramaQueenPatch(parseDramaQueenPatchResponse(response));
        return patch.proposalId && patch.stages.length
            ? { ok: true, patch, target }
            : { ok: false, error: 'The adaptation response did not contain a usable suffix patch.', target };
    } catch (error) {
        if (isAbortError(error)) return { ok: false, cancelled: true, error: error.message, target };
        console.error(`${LOG_PREFIX} adaptation request failed`, error);
        return { ok: false, error: error?.message || 'The adaptation call failed.', target };
    }
}
