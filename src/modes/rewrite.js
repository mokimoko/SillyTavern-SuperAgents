/**
 * modes/rewrite.js — LLM post-gen prose transformation.
 *
 * A rewrite agent sends its prompt + the current message to the LLM and
 * replaces (or appends to) the message with the response. This is the mode
 * that overlaps with Recast; it's kept as a thin option here, not the
 * architectural center (per the gameplan's Option-B lean).
 *
 * VM's version carried the full dual CMRS/quiet-prompt ladder inline (~120
 * lines). On callAgentLLM() it's a single call. Streaming + onChunk are
 * plumbed through so a Recast-style inline diff/progress UI can attach at
 * Step 10 without touching this module again.
 */

import { substituteParams } from '../../../../../../script.js';
import { callAgentLLM, isAbortError } from '../core/llm.js';
import { recordAgentRun, hasAgentRun, revertAgentRewrite } from '../core/idempotency.js';
import { formatMergeVariableData } from './mergeVariable.js';
import { getGlobalSettings } from '../data/store.js';

const LOG_PREFIX = '[SuperAgents/rewrite]';

/**
 * Run a rewrite-mode agent on a message.
 *
 * @param {object} agent
 * @param {object} message — chat[n]
 * @param {number} messageIndex
 * @param {string} generationType
 * @param {object} [opts]
 * @param {boolean} [opts.stream]      Stream the rewrite (CMRS only).
 * @param {Function|null} [opts.onChunk] Progress callback for streaming UIs.
 * @returns {Promise<{changed: boolean, error?: string}>}
 */
export async function executeRewriteAgent(agent, message, messageIndex, generationType, opts = {}) {
    const { stream = false, onChunk = null, signal = null, timeoutMs } = opts;

    const currentText = message.mes;
    if (!currentText?.trim()) return { changed: false };

    let expandedPrompt = substituteParams(agent.prompt).trim();
    if (!expandedPrompt) return { changed: false };

    // Inject merge variable state into the prompt (mirrors pre-gen injection)
    if (agent.mergeVariable?.enabled && agent.mergeVariable.injectFormatted && agent.mergeVariable.variableName) {
        const formatted = formatMergeVariableData(agent.mergeVariable);
        if (formatted) expandedPrompt += '\n\n' + formatted;
    }

    // If this agent already ran on this message (regenerate / manual re-run),
    // restore the original text first so we rewrite from clean source.
    if (hasAgentRun(messageIndex, agent.id)) {
        revertAgentRewrite(messageIndex, agent.id);
    }

    const rewriteMode = agent.postProcess.rewriteMode || 'rewrite';
    const actionInstruction = rewriteMode === 'append'
        ? 'Generate only the new content that should be appended after the assistant response. Do not repeat or rewrite the original response. Return only the appended content.'
        : 'Rewrite the assistant response according to the instructions above. Return only the final rewritten response. If no changes are needed, return the original response verbatim.';

    const maxTokens = agent.postProcess.rewriteMaxTokens || agent.maxTokens || 8192;
    const showNotifications = getGlobalSettings().showNotifications;

    if (showNotifications) {
        toastr.info(`Running ${rewriteMode}...`, agent.name, { timeOut: 0, extendedTimeOut: 0 });
    }

    try {
        const systemPrompt = `${expandedPrompt}\n\n${actionInstruction}`;
        const userContent = `Assistant name: ${message.name || 'Assistant'}\nGeneration type: ${generationType}\n\nCurrent assistant response:\n<assistant_response>\n${currentText}\n</assistant_response>`;

        let response = await callAgentLLM({
            systemPrompt,
            userContent,
            profileRef: agent.connectionProfile || '',
            maxTokens,
            stream,
            onChunk,
            signal,
            timeoutMs,
            callerName: `rewrite:${agent.name}`,
        });

        // Clean up <assistant_response> wrapper if the model echoed it
        response = String(response ?? '').trim();
        const wrapperMatch = response.match(/^\s*<assistant_response>\s*([\s\S]*?)\s*<\/assistant_response>\s*$/i);
        if (wrapperMatch) response = wrapperMatch[1].trim();

        if (!response) {
            if (showNotifications) {
                toastr.clear();
                toastr.warning('Empty response', agent.name, { timeOut: 5000 });
            }
            return { changed: false };
        }

        const originalText = message.mes;
        message.mes = rewriteMode === 'append'
            ? originalText + '\n\n' + response
            : response;

        const changed = message.mes !== originalText;

        recordAgentRun(messageIndex, {
            agentId: agent.id,
            agentName: agent.name,
            phase: 'post',
            originalText,
            result: response,
            mode: 'rewrite',
        });

        if (showNotifications) {
            toastr.clear();
            if (changed) toastr.success('', agent.name, { timeOut: 3000 });
            else toastr.info('No change', agent.name, { timeOut: 2000 });
        }

        return { changed };

    } catch (err) {
        if (isAbortError(err)) {
            if (showNotifications) {
                toastr.clear();
                const msg = err.reason === 'timeout' ? 'Timed out' : 'Stopped';
                toastr.info(msg, agent.name, { timeOut: 4000 });
            }
            return { changed: false, cancelled: true };
        }
        console.error(`${LOG_PREFIX} rewrite agent "${agent.name}" failed:`, err);
        if (showNotifications) {
            toastr.clear();
            toastr.error(`Failed: ${err.message}`, agent.name, { timeOut: 8000 });
        }
        return { changed: false, error: err.message };
    }
}
