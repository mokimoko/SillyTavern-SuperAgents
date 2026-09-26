/**
 * modes/postProcess.js — non-LLM post-processing modes.
 *
 * extract: pull regex matches from the message into a chat_metadata variable.
 * append: append static (macro-expanded) text to the message.
 *
 * Neither makes an LLM call. Split out of VM's runner.js so the lifecycle
 * engine routes here for the cheap, deterministic modes.
 */

import { chat_metadata, substituteParams } from '../../../../../../script.js';
import { recordAgentRun } from '../core/idempotency.js';
import { debug } from '../core/runtime.js';

const LOG_PREFIX = '[SuperAgents/postProcess]';

/**
 * Extract regex matches from the message text into chat_metadata.
 * Stored under `agent_<extractVariable>` (VM-compatible key).
 *
 * @param {object} agent
 * @param {object} message — chat[n]
 * @param {number} messageIndex
 * @returns {{changed: boolean}}
 */
export function executeExtractAgent(agent, message, messageIndex) {
    const pp = agent.postProcess;
    if (!pp?.extractPattern || !pp?.extractVariable) return { changed: false };

    try {
        const regex = new RegExp(pp.extractPattern, 'g');
        const matches = message.mes.match(regex);
        if (matches) {
            chat_metadata[`agent_${pp.extractVariable}`] = matches.join('\n');
            recordAgentRun(messageIndex, {
                agentId: agent.id,
                agentName: agent.name,
                phase: 'post',
                originalText: null,
                result: matches.join('\n'),
                mode: 'extract',
            });
            return { changed: true };
        }
    } catch (err) {
        debug(`${LOG_PREFIX} extract error in "${agent.name}":`, err);
    }

    return { changed: false };
}

/**
 * Append static text (macro-expanded) to the message.
 *
 * @param {object} agent
 * @param {object} message — chat[n]
 * @param {number} messageIndex
 * @returns {{changed: boolean}}
 */
export function executeAppendAgent(agent, message, messageIndex) {
    const pp = agent.postProcess;
    if (!pp?.appendText) return { changed: false };

    const expanded = substituteParams(pp.appendText);
    if (!expanded.trim()) return { changed: false };

    const originalText = message.mes;
    message.mes += expanded;

    recordAgentRun(messageIndex, {
        agentId: agent.id,
        agentName: agent.name,
        phase: 'post',
        originalText,
        result: expanded,
        mode: 'append',
    });

    return { changed: true };
}
