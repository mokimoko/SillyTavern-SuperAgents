/** Context assembled only for an on-demand After Dark planning call. */

import { getAgents } from '../data/store.js';
import { readMergeArray } from '../modes/mergeVariable.js';
import { buildBasicKnowledgeInput } from '../groupChat/groupChatContext.js';

const SUPPORTING_TEMPLATES = [
    ['tpl-prompt-profile', 'Prompt Base'],
    ['tpl-prompt-nsfw', 'Prompt NSFW'],
    ['tpl-relationship-ledger', 'Relationship Ledger'],
    ['tpl-social-web-ledger', 'Social Web Ledger'],
    ['tpl-state-card', 'Scene State'],
];

const STAGE_CONTRACT = `## Five-beat arc
Build a complete erotic arc, not five consecutive gestures from the same moment. A beat is a story milestone that may take one or more roleplay turns. Give the NPCs initiative and leave the user's response open.

Use these exact labels and functions:
1. Set the Trap — move from the current scene into a credible, actionable sexual opportunity.
2. Cross the Line — an NPC makes the first unmistakably sexual move. Charged looks, suggestive dialogue, and incidental contact do not count.
3. Sex Is Underway — deliver the pitch's central sexual premise through sustained sexual activity. Stop teasing the possibility.
4. Turn It Up — deepen the specific kink, power dynamic, group involvement, intensity, or complication while sex is already happening.
5. What Now? — continue, climax, interrupt, deal with consequences, start another round, or make a clean exit in a way that fits this pitch.

Before returning the plan, check:
- If beats 1–4 could fit in one short paragraph of touching and banter, rewrite them at a larger scale.
- Beat 3 contains the payoff, not another almost-kiss, suggestive touch, clothed grinding, hand near clothing, or promise for later.
- Do not interrupt the scene before the premise happens unless denial, near-discovery, or unfinished business is the point of the pitch.
- Write self-contained authorial direction, not dialogue or rigid choreography.
- The user controls their persona. Never decide the user's actions, dialogue, thoughts, consent, arousal, choices, or reactions.`;

function latestLogicalState(agent) {
    const items = readMergeArray(agent?.mergeVariable?.variableName || '');
    const item = items[items.length - 1];
    if (!item) return '';
    const value = item.json ?? item.text ?? '';
    return typeof value === 'string' ? value : JSON.stringify(value);
}

export async function buildAfterDarkAnalysisContext(agent) {
    const probeTerms = Array.isArray(agent?.afterDarkConfig?.probeTerms)
        ? agent.afterDarkConfig.probeTerms.map(value => String(value || '').trim()).filter(Boolean).slice(0, 20)
        : [];
    const knowledge = await buildBasicKnowledgeInput({
        worldInfoScanText: probeTerms.join(' '),
    });
    const agents = getAgents();
    const supporting = SUPPORTING_TEMPLATES.map(([templateId, label]) => {
        const source = agents.find(candidate => candidate.sourceTemplateId === templateId);
        const state = latestLogicalState(source);
        return state ? `### ${label}\n${state}` : '';
    }).filter(Boolean).join('\n\n');
    return [
        '### Current story, cast, persona, and author knowledge',
        knowledge.source || '',
        supporting ? `### Supporting SuperAgents state\n${supporting}` : '',
        STAGE_CONTRACT,
    ].filter(Boolean).join('\n\n');
}

export async function buildAfterDarkAdaptationContext(agent, state, options = {}) {
    const pitch = state?.active ? state.pitches?.[state.active.pitchIndex] : null;
    const startStageIndex = Math.max(0, Math.floor(Number(options.startStageIndex) || 0));
    if (!pitch) return '';
    const lockedStages = pitch.stages.slice(0, startStageIndex);
    const stagesToReplace = pitch.stages.slice(startStageIndex);
    const storyContext = await buildAfterDarkAnalysisContext(agent);
    return [
        '## Adapt the selected After Dark plan',
        'Rewrite only the requested suffix to fit current canon. Keep the pitch ID, title, cast, premise, dynamic, kink/motif, guardrails, every locked beat, and every other pitch unchanged.',
        `Selected pitch:\n${JSON.stringify({
            id: pitch.id,
            title: pitch.title,
            cast: pitch.cast,
            flavor: pitch.flavor,
            setup: pitch.setup,
            dynamic: pitch.dynamic,
            kink: pitch.kink,
            guardrails: pitch.guardrails,
        })}`,
        `Current steering: beat ${Number(state.active.stageIndex) + 1}, strength ${state.active.strength}`,
        `Locked beat prefix (copy is retained by code and must not be returned):\n${JSON.stringify(lockedStages)}`,
        `Existing suffix to critique and replace, beginning at zero-based index ${startStageIndex}:\n${JSON.stringify(stagesToReplace)}`,
        options.instruction ? `User's private change note:\n${String(options.instruction).trim().slice(0, 1200)}` : 'No change note was supplied. Produce a different, coherent continuation.',
        storyContext,
    ].filter(Boolean).join('\n\n');
}
