/** Conditional, batch-compatible semantic checks contributed by UtilityApps. */

import { chat, chat_metadata } from '../../../../../../script.js';
import { readMergeArray } from '../modes/mergeVariable.js';
import { getAgentById } from '../data/store.js';
import {
    AFTER_DARK_NUDGE_VARIABLE,
    applyAfterDarkDropGuard,
    getAfterDarkPlanIdentity,
    getAfterDarkStateSignature,
    getCurrentAfterDarkNudge,
    readAfterDarkProgressionMode,
    readAfterDarkInjectionEnabled,
    readAfterDarkState,
} from '../afterDark/afterDarkState.js';
import {
    DRAMA_QUEEN_NUDGE_VARIABLE,
    applyDramaQueenDropGuard,
    getCurrentDramaQueenNudge,
    getDramaQueenPlanIdentity,
    getDramaQueenStateSignature,
    readDramaQueenProgressionMode,
    readDramaQueenState,
    readDramaQueenInjectionEnabled,
} from '../dramaQueen/dramaQueenState.js';

export const AFTER_DARK_NUDGE_AGENT_ID = '__utility_after_dark_nudge__';
export const DRAMA_QUEEN_NUDGE_AGENT_ID = '__utility_drama_queen_nudge__';

function afterDarkNudgeSchema(identity, beatIndex, messageIndex, swipeId) {
    return {
        type: 'object',
        required: ['version', 'utility', 'planIdentity', 'beatIndex', 'messageIndex', 'swipeId', 'status'],
        properties: {
            version: { type: 'number', const: 1 },
            utility: { type: 'string', const: 'after-dark' },
            planIdentity: { type: 'string', const: identity },
            beatIndex: { type: 'number', const: beatIndex },
            messageIndex: { type: 'number', const: messageIndex },
            swipeId: { type: 'number', const: swipeId },
            status: { type: 'string', enum: ['hold', 'ready', 'diverged', 'overshot'] },
            reason: { type: 'string', maxLength: 240 },
        },
        additionalProperties: false,
    };
}

function createAfterDarkNudgeTask(agent, message, messageIndex, generationType) {
    if (!agent?.enabled || agent.paused || generationType !== 'normal'
        || !readAfterDarkInjectionEnabled(chat_metadata)
        || readAfterDarkProgressionMode(chat_metadata, agent.afterDarkConfig) !== 'nudge') return null;
    const variableName = agent.mergeVariable?.variableName || 'sa_after_dark';
    const state = applyAfterDarkDropGuard(readAfterDarkState(readMergeArray(variableName)), chat_metadata);
    if (!state.active) return null;
    const pitch = state.pitches[state.active.pitchIndex];
    const stage = pitch?.stages[state.active.stageIndex];
    if (!pitch || !stage || state.active.stageIndex >= pitch.stages.length - 1) return null;

    const planIdentity = getAfterDarkPlanIdentity(state);
    const stateSignature = getAfterDarkStateSignature(state);
    const swipeId = Math.max(0, Number(message?.swipe_id) || 0);
    const existing = getCurrentAfterDarkNudge(state, readMergeArray(AFTER_DARK_NUDGE_VARIABLE));
    if (existing?.messageIndex === messageIndex && existing.swipeId === swipeId) return null;

    const responseShape = {
        version: 1,
        utility: 'after-dark',
        planIdentity,
        beatIndex: state.active.stageIndex,
        messageIndex,
        swipeId,
        status: 'hold',
        reason: 'One short private reason.',
    };
    const prompt = [
        'Judge whether the newest assistant response substantially reached the current After Dark beat.',
        'Choose one status: hold = not reached; ready = reached and advancing makes sense; diverged = canon made the beat or remaining plan questionable; overshot = the response materially entered a later beat.',
        'Judge actions on the page, not atmosphere or intent. Suggestive lead-up does not complete a physical milestone.',
        'Do not advance the plan, rewrite the scene, or moralize. Give one concrete reason under 160 characters.',
        `Plan: ${pitch.title}`,
        `Setup: ${pitch.setup}`,
        `Dynamic: ${pitch.dynamic}`,
        `Current beat ${state.active.stageIndex + 1}/${pitch.stages.length} — ${stage.label}: ${stage.direction}`,
        `Steering strength: ${state.active.strength}`,
        'For a solo call, return exactly this object inside [AFTER_DARK_NUDGE] tags. A batch contract may override the tags:',
        `[AFTER_DARK_NUDGE]\n${JSON.stringify(responseShape)}\n[/AFTER_DARK_NUDGE]`,
    ].join('\n\n');

    return {
        id: AFTER_DARK_NUDGE_AGENT_ID,
        name: 'After Dark beat check',
        prompt,
        phase: 'post',
        enabled: true,
        paused: false,
        groupId: null,
        connectionProfile: agent.connectionProfile || '',
        maxTokens: 180,
        injection: { order: 9999 },
        activationPolicy: { mode: 'always' },
        utilityAnalysis: {
            silent: true,
            utility: 'after-dark',
            isCurrent: () => {
                const liveAgent = getAgentById(agent.id);
                if (!liveAgent?.enabled || liveAgent.paused
                    || !readAfterDarkInjectionEnabled(chat_metadata)
                    || readAfterDarkProgressionMode(chat_metadata, liveAgent.afterDarkConfig) !== 'nudge'
                    || chat[messageIndex] !== message
                    || (message?.swipe_id ?? 0) !== swipeId) return false;
                const liveState = applyAfterDarkDropGuard(readAfterDarkState(readMergeArray(
                    liveAgent.mergeVariable?.variableName || 'sa_after_dark',
                )), chat_metadata);
                return getAfterDarkStateSignature(liveState) === stateSignature;
            },
        },
        sidecarCall: {
            enabled: true,
            maxTokens: 180,
            responseKey: 'after_dark_nudge',
            includeHistory: true,
            historyMessageCount: 2,
            genesisHistoryCount: 2,
            richContext: { enabled: false },
            display: { enabled: false },
        },
        mergeVariable: {
            enabled: true,
            variableName: AFTER_DARK_NUDGE_VARIABLE,
            extractPattern: '\\[AFTER_DARK_NUDGE\\]\\s*([\\s\\S]*?)\\s*\\[\\/AFTER_DARK_NUDGE\\]',
            fieldNames: ['json'],
            keyFields: [],
            mode: 'snapshot',
            stripFromResponse: true,
            injectFormatted: false,
            autoInject: false,
            validation: {
                enabled: true,
                jsonField: 'json',
                schemaVersion: 1,
                schema: afterDarkNudgeSchema(planIdentity, state.active.stageIndex, messageIndex, swipeId),
                invariants: [],
            },
        },
    };
}

function dramaQueenNudgeSchema(identity, beatIndex, messageIndex, swipeId) {
    return {
        type: 'object',
        required: ['version', 'utility', 'planIdentity', 'beatIndex', 'messageIndex', 'swipeId', 'status'],
        properties: {
            version: { type: 'number', const: 1 },
            utility: { type: 'string', const: 'drama-queen' },
            planIdentity: { type: 'string', const: identity },
            beatIndex: { type: 'number', const: beatIndex },
            messageIndex: { type: 'number', const: messageIndex },
            swipeId: { type: 'number', const: swipeId },
            status: { type: 'string', enum: ['hold', 'ready', 'diverged', 'overshot'] },
            reason: { type: 'string', maxLength: 240 },
        },
        additionalProperties: false,
    };
}

function createDramaQueenNudgeTask(agent, message, messageIndex, generationType) {
    if (!agent?.enabled || agent.paused || generationType !== 'normal'
        || !readDramaQueenInjectionEnabled(chat_metadata)
        || readDramaQueenProgressionMode(chat_metadata, agent.dramaQueenConfig) !== 'nudge') return null;
    const variableName = agent.mergeVariable?.variableName || 'sa_drama_queen';
    const state = applyDramaQueenDropGuard(readDramaQueenState(readMergeArray(variableName)), chat_metadata);
    if (!state.active) return null;
    const proposal = state.proposals[state.active.proposalIndex];
    const stage = proposal?.stages[state.active.beatIndex];
    if (!proposal || !stage || state.active.beatIndex >= proposal.stages.length - 1) return null;

    const planIdentity = getDramaQueenPlanIdentity(state);
    const stateSignature = getDramaQueenStateSignature(state);
    const swipeId = Math.max(0, Number(message?.swipe_id) || 0);
    const existing = getCurrentDramaQueenNudge(state, readMergeArray(DRAMA_QUEEN_NUDGE_VARIABLE));
    if (existing?.messageIndex === messageIndex && existing.swipeId === swipeId) return null;

    const responseShape = {
        version: 1,
        utility: 'drama-queen',
        planIdentity,
        beatIndex: state.active.beatIndex,
        messageIndex,
        swipeId,
        status: 'hold',
        reason: 'One short private reason.',
    };
    const prompt = [
        'Judge whether the newest assistant response substantially reached the current Drama Queen beat.',
        'Choose one status: hold = not reached; ready = reached and advancing makes sense; diverged = canon made the remaining engine questionable; overshot = the response materially entered a later beat.',
        'Judge concrete story change, not tone, arguing, or dramatic language. Never advance state or rewrite the scene.',
        `Engine: ${proposal.title}`,
        `Fault line: ${proposal.faultLine}`,
        `Current beat ${state.active.beatIndex + 1}/${proposal.stages.length} — ${stage.label}: ${stage.direction}`,
        `Pressure: ${state.active.pressure}. Damage ceiling: ${state.active.damageCeiling}.`,
        'For a solo call, return exactly this object inside [DRAMA_QUEEN_NUDGE] tags. A batch contract may override the tags:',
        `[DRAMA_QUEEN_NUDGE]\n${JSON.stringify(responseShape)}\n[/DRAMA_QUEEN_NUDGE]`,
    ].join('\n\n');

    return {
        id: DRAMA_QUEEN_NUDGE_AGENT_ID,
        name: 'Drama Queen beat check',
        prompt,
        phase: 'post',
        enabled: true,
        paused: false,
        groupId: null,
        connectionProfile: agent.connectionProfile || '',
        maxTokens: 180,
        injection: { order: 9999 },
        activationPolicy: { mode: 'always' },
        utilityAnalysis: {
            silent: true,
            utility: 'drama-queen',
            isCurrent: () => {
                const liveAgent = getAgentById(agent.id);
                if (!liveAgent?.enabled || liveAgent.paused
                    || !readDramaQueenInjectionEnabled(chat_metadata)
                    || readDramaQueenProgressionMode(chat_metadata, liveAgent.dramaQueenConfig) !== 'nudge'
                    || chat[messageIndex] !== message
                    || (message?.swipe_id ?? 0) !== swipeId) return false;
                const liveState = applyDramaQueenDropGuard(readDramaQueenState(readMergeArray(
                    liveAgent.mergeVariable?.variableName || 'sa_drama_queen',
                )), chat_metadata);
                return getDramaQueenStateSignature(liveState) === stateSignature;
            },
        },
        sidecarCall: {
            enabled: true,
            maxTokens: 180,
            responseKey: 'drama_queen_nudge',
            includeHistory: true,
            historyMessageCount: 2,
            genesisHistoryCount: 2,
            richContext: { enabled: false },
            display: { enabled: false },
        },
        mergeVariable: {
            enabled: true,
            variableName: DRAMA_QUEEN_NUDGE_VARIABLE,
            extractPattern: '\\[DRAMA_QUEEN_NUDGE\\]\\s*([\\s\\S]*?)\\s*\\[\\/DRAMA_QUEEN_NUDGE\\]',
            fieldNames: ['json'],
            keyFields: [],
            mode: 'snapshot',
            stripFromResponse: true,
            injectFormatted: false,
            autoInject: false,
            validation: {
                enabled: true,
                jsonField: 'json',
                schemaVersion: 1,
                schema: dramaQueenNudgeSchema(planIdentity, state.active.beatIndex, messageIndex, swipeId),
                invariants: [],
            },
        },
    };
}

/** Future utilities can add descriptors here without entering lifecycle.js. */
export function buildPostGenUtilityTasks({ agents, message, messageIndex, generationType } = {}) {
    const tasks = [];
    const afterDark = (agents || []).find(agent => agent.afterDarkConfig?.enabled
        || agent.sourceTemplateId === 'tpl-after-dark');
    const nudge = createAfterDarkNudgeTask(afterDark, message, messageIndex, generationType);
    if (nudge) tasks.push(nudge);
    const dramaQueen = (agents || []).find(agent => agent.dramaQueenConfig?.enabled
        || agent.sourceTemplateId === 'tpl-drama-queen');
    const dramaNudge = createDramaQueenNudgeTask(dramaQueen, message, messageIndex, generationType);
    if (dramaNudge) tasks.push(dramaNudge);
    return tasks;
}

export function getUtilityAnalysisVariables() {
    return [AFTER_DARK_NUDGE_VARIABLE, DRAMA_QUEEN_NUDGE_VARIABLE];
}
