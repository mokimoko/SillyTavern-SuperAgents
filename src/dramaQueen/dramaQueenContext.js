/** Private story context for Drama Queen planning and adaptation calls. */

import { getAgents } from '../data/store.js';
import { readMergeArray } from '../modes/mergeVariable.js';
import { buildBasicKnowledgeInput } from '../groupChat/groupChatContext.js';
import { DRAMA_QUEEN_BEATS, getDramaQueenPlanIdentity } from './dramaQueenState.js';

const SUPPORTING_TEMPLATES = [
    ['tpl-relationship-ledger', 'Relationship Ledger'],
    ['tpl-social-web-ledger', 'Social Web Ledger'],
    ['tpl-state-card', 'Scene State'],
    ['tpl-world-state', 'World State'],
];

const BEAT_CONTRACT = `## Six-beat dramatic engine
A beat is a durable story milestone, not one line of sniping. Use these exact labels:
1. Expose the Fault Line — reveal the existing incompatible need, loyalty, fear, secret, or value.
2. Test the Boundary — an NPC or circumstance credibly tests what someone will not accept.
3. Remove the Easy Exit — close the painless workaround without inventing arbitrary bad luck.
4. Force a Choice — make incompatible agendas demand an answer while leaving the player persona's choice open.
5. Make It Cost Something — apply a concrete consequence that obeys the selected damage ceiling.
6. Live With the Change — create durable fallout and a changed situation; do not force reconciliation or total closure.

Each direction must stand alone because the writer sees only the current beat. Never author the player persona's thoughts, dialogue, choice, or reaction.`;

const STORY_ENGINE_CONTRACT = `## What makes an engine worth playing
A proposal is not a diagnosis of why the current scene is tense. It is a character-specific chain of trouble that makes an author curious about what happens next.

- Desire creates motion: identify which non-player character actively wants what now, what tactic they can use, and why another agenda cannot simply accommodate it.
- The catalyst must change the situation after the latest supplied moment. It may activate an established detail, prompt a revealing choice, bring a consequence due, or introduce a grounded new complication when the intent permits. Never use the catalyst field to quote or paraphrase something that has already just happened.
- Earn surprise from character and canon. Favor a revealing misuse of trust, a tempting bargain with an ugly price, a loyalty collision, a secret becoming useful to the wrong person, an alliance or status shift, a public/private contradiction, or a victory that creates a worse obligation. These are possibilities, not a required checklist.
- Build toward a turn: by the middle of the engine, somebody's apparent advantage, understanding, alliance, or safe option should change. A louder repetition of the opening conflict is not escalation.
- Make the cost concrete and playable: altered access, trust, allegiance, reputation, duty, safety, leverage, or future options. Avoid vague statements that “tension” or “the relationship” is at risk.
- Give sibling proposals different dramatic machinery and different likely trajectories. Do not return four moral readings of the same immediate act, four confrontations, or four versions of whether someone will confess.

Before returning a proposal, apply three tests: its catalyst creates a new next move; its engine could sustain several beats without repetition; and its title plus summary make the specific trouble sound tempting to play. If it fails, replace it.`;

function buildPlanOutputContract(proposalCount = 4) {
    const count = Math.max(2, Math.min(6, Math.floor(Number(proposalCount) || 4)));
    return `## Required Drama Queen output
Return exactly one JSON object inside [DRAMA_QUEEN] tags containing exactly ${count} complete, genuinely different proposals. Do not return only one proposal and do not omit fields. The intent value must match the run-specific instruction; stir-the-pot below is only the structural example.

[DRAMA_QUEEN]
${JSON.stringify({
    version: 1,
    sceneRead: 'Current dramatic pressure in one sentence.',
    proposals: [{
        id: 'unique-short-id',
        title: 'Engine title',
        cast: ['Relevant character'],
        intent: 'stir-the-pot',
        faultLine: 'Established incompatibility.',
        incompatibleAgendas: ['First concrete agenda.', 'Second incompatible agenda.'],
        refusal: 'What someone will not accept.',
        leverage: 'Credible source of pressure.',
        stakes: 'What can concretely be lost or changed.',
        catalyst: {
            event: 'A proposed development occurring after the latest scene moment.',
            provenance: 'new-catalyst',
            basis: 'Why this development is grounded.',
        },
        easyExit: 'The painless escape the arc can remove.',
        consequences: ['Concrete possible fallout.'],
        stages: DRAMA_QUEEN_BEATS.map(label => ({
            label,
            direction: 'Self-contained authorial direction.',
        })),
        guardrails: ['Do not author the player persona.'],
    }],
    active: null,
})}
[/DRAMA_QUEEN]

Use exactly ${count} proposal objects in the proposals array. Keep the JSON compact: one short sentence per scalar field, two short agenda items, two concise consequences, and one short sentence per beat direction. Finish every proposal's closing brace before starting the next. Spend output tokens on complete alternatives, not explanation, repetition, or flourish.`;
}

function latestLogicalState(agent) {
    const item = readMergeArray(agent?.mergeVariable?.variableName || '').at(-1);
    const value = item?.json ?? item?.text ?? '';
    return typeof value === 'string' ? value : (value ? JSON.stringify(value) : '');
}

export async function buildDramaQueenAnalysisContext(agent, options = {}) {
    const probeTerms = Array.isArray(agent?.dramaQueenConfig?.probeTerms)
        ? agent.dramaQueenConfig.probeTerms.map(value => String(value || '').trim()).filter(Boolean).slice(0, 20)
        : [];
    const knowledge = await buildBasicKnowledgeInput({ worldInfoScanText: probeTerms.join(' ') });
    const supporting = SUPPORTING_TEMPLATES.map(([templateId, label]) => {
        const source = getAgents().find(candidate => candidate.sourceTemplateId === templateId);
        const state = latestLogicalState(source);
        return state ? `### ${label}\n${state}` : '';
    }).filter(Boolean).join('\n\n');
    return [
        '### Current story, cast, persona, and author knowledge',
        knowledge.source || '',
        supporting ? `### Optional supporting SuperAgents state\n${supporting}` : '',
        options.eventNote ? `### Private event note\n${String(options.eventNote).trim().slice(0, 1600)}` : '',
        STORY_ENGINE_CONTRACT,
        BEAT_CONTRACT,
    ].filter(Boolean).join('\n\n');
}

export function buildDramaQueenPlanOutputContract(proposalCount = 4) {
    return buildPlanOutputContract(proposalCount);
}

export async function buildDramaQueenAdaptationContext(agent, state, options = {}) {
    const proposal = state?.active ? state.proposals?.[state.active.proposalIndex] : null;
    if (!proposal) return '';
    const anchorBeatIndex = Math.floor(Number(options.anchorBeatIndex));
    const anchorMode = options.anchorMode === 'replace-anchor' ? 'replace-anchor' : 'keep-anchor';
    const replacementStart = anchorBeatIndex + (anchorMode === 'keep-anchor' ? 1 : 0);
    const storyContext = await buildDramaQueenAnalysisContext(agent, options);
    return [
        '## Adapt the unfinished suffix of the active Drama Queen engine',
        'Keep the proposal ID and every beat before the replacement start byte-for-byte in application state. Do not return or revise unused proposals.',
        `Selected engine identity: ${getDramaQueenPlanIdentity(state)}`,
        `Selected engine:\n${JSON.stringify({
            id: proposal.id,
            title: proposal.title,
            cast: proposal.cast,
            intent: proposal.intent,
            faultLine: proposal.faultLine,
            incompatibleAgendas: proposal.incompatibleAgendas,
            refusal: proposal.refusal,
            leverage: proposal.leverage,
            stakes: proposal.stakes,
            catalyst: proposal.catalyst,
            easyExit: proposal.easyExit,
            consequences: proposal.consequences,
            guardrails: proposal.guardrails,
        })}`,
        `Current steering: beat ${Number(state.active.beatIndex) + 1}, pressure ${state.active.pressure}, damage ceiling ${state.active.damageCeiling}`,
        `Anchor semantics: ${anchorMode}. Anchor is zero-based beat ${anchorBeatIndex}; replacement begins at ${replacementStart}.`,
        `Locked prefix (retained by code):\n${JSON.stringify(proposal.stages.slice(0, replacementStart))}`,
        `Suffix to replace:\n${JSON.stringify(proposal.stages.slice(replacementStart))}`,
        options.instruction
            ? `User's private change note:\n${String(options.instruction).trim().slice(0, 1200)}`
            : 'No private change note was supplied. Make the unfinished arc more dramatically productive without exceeding its ceiling.',
        storyContext,
    ].filter(Boolean).join('\n\n');
}

export {
    BEAT_CONTRACT as DRAMA_QUEEN_BEAT_CONTRACT,
    STORY_ENGINE_CONTRACT as DRAMA_QUEEN_STORY_ENGINE_CONTRACT,
};
