/** Private provider call for replacing only one active After Dark beat suffix. */

import { callAgentLLM, isAbortError } from '../core/llm.js';
import { getGlobalSettings } from '../data/store.js';
import { extractJsonObjectCandidates } from '../data/structuredOutput.js';
import { buildAfterDarkAdaptationContext } from './afterDarkContext.js';
import { AFTER_DARK_STAGES, normalizeAfterDarkPatch } from './afterDarkState.js';

const LOG_PREFIX = '[SuperAgents/afterDark/adapt]';

function parsePatch(response) {
    const tagged = String(response || '').match(/\[AFTER_DARK_PATCH\]\s*([\s\S]*?)\s*\[\/AFTER_DARK_PATCH\]/i)?.[1];
    const candidates = [tagged, ...extractJsonObjectCandidates(response)].filter(Boolean);
    for (const candidate of candidates) {
        try {
            const value = typeof candidate === 'string' ? JSON.parse(candidate) : candidate;
            const patch = normalizeAfterDarkPatch(value);
            if (patch.pitchId && Number.isInteger(patch.startStageIndex) && patch.stages.length) return patch;
        } catch { /* Try the next bounded candidate. */ }
    }
    return null;
}

export async function requestAfterDarkAdaptation(agent, state, options = {}) {
    const startStageIndex = Math.max(0, Math.floor(Number(options.startStageIndex) || 0));
    const pitch = state?.active ? state.pitches?.[state.active.pitchIndex] : null;
    if (!agent || !pitch || startStageIndex >= AFTER_DARK_STAGES.length) {
        return { ok: false, error: 'There is no beat suffix to adapt.' };
    }
    const count = AFTER_DARK_STAGES.length - startStageIndex;
    const systemPrompt = await buildAfterDarkAdaptationContext(agent, state, {
        startStageIndex,
        instruction: options.instruction,
    });
    const userContent = [
        `Rewrite exactly ${count} beat${count === 1 ? '' : 's'}, beginning at zero-based index ${startStageIndex}.`,
        'Use the canonical labels below. Each direction must stand on its own, give the NPCs something concrete to do, and leave the user’s response open.',
        `Labels: ${AFTER_DARK_STAGES.slice(startStageIndex).join(' | ')}`,
        'Return only this compact tagged JSON object:',
        '[AFTER_DARK_PATCH]',
        JSON.stringify({
            pitchId: pitch.id,
            startStageIndex,
            stages: AFTER_DARK_STAGES.slice(startStageIndex).map(label => ({ label, direction: '...' })),
        }),
        '[/AFTER_DARK_PATCH]',
    ].join('\n');

    try {
        const response = await callAgentLLM({
            systemPrompt,
            userContent,
            profileRef: agent.connectionProfile || '',
            maxTokens: Math.min(1800, Math.max(650, count * 260)),
            callerName: 'after-dark-adapt',
            signal: options.signal ?? null,
            timeoutMs: getGlobalSettings().agentCallTimeoutMs,
        });
        const patch = parsePatch(response);
        return patch
            ? { ok: true, patch }
            : { ok: false, error: 'The adaptation response did not contain a usable beat patch.' };
    } catch (error) {
        if (isAbortError(error)) return { ok: false, cancelled: true, error: error.message };
        console.error(`${LOG_PREFIX} request failed`, error);
        return { ok: false, error: error?.message || 'The adaptation call failed.' };
    }
}
