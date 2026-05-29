/**
 * core/slashCommands.js — user-facing slash commands.
 *
 * Ported from VM's agents/index.js slash block, namespaced sa-* so SuperAgents
 * and VerseManager can stay installed side by side without colliding on
 * command names (parity with the vm_*→sa_* merge-variable rename).
 *
 * Commands:
 *   /sa-run [name]     — run an agent on the last assistant message
 *   /sa-list           — list configured agents + enabled state
 *   /sa-toggle [name]  — flip an agent on/off
 *   /sa-open           — open the unified management modal
 *
 * The callback signature is ST's (namedArgs, unnamedValue). /sa-run accepts an
 * optional message= named arg to target a specific index instead of the last
 * assistant message.
 */

import { chat } from '../../../../../../script.js';
import { SlashCommand } from '../../../../../slash-commands/SlashCommand.js';
import { SlashCommandParser } from '../../../../../slash-commands/SlashCommandParser.js';
import { debug } from '../../index.js';

import {
    getAgents,
    getAgentById,
    getAgentByName,
    toggleAgent,
} from '../data/store.js';
import { runAgentOnMessage, cancelAgentRun, isAgentRunActive } from './lifecycle.js';
import { openModal } from '../ui/modal.js';

const LOG_PREFIX = '[SuperAgents/slash]';

// ============================================================================
// HELPERS
// ============================================================================

/** @returns {number} index of the most recent assistant message, or -1. */
function getLastAssistantIndex() {
    for (let i = chat.length - 1; i >= 0; i--) {
        if (chat[i] && !chat[i].is_user && !chat[i].is_system) return i;
    }
    return -1;
}

/** Resolve an agent by name first, then by id. */
function resolveAgent(value) {
    const name = String(value ?? '').trim();
    if (!name) return null;
    return getAgentByName(name) || getAgentById(name) || null;
}

// ============================================================================
// COMMAND HANDLERS
// ============================================================================

/** /sa-run [name] — run an agent on the last assistant message (or message=N). */
async function handleRun(args, value) {
    const agent = resolveAgent(value);
    if (!agent) {
        toastr.warning('Usage: /sa-run [agent name]');
        return '';
    }

    const targetIndex = args?.message !== undefined && args.message !== ''
        ? Number(args.message)
        : getLastAssistantIndex();

    if (!Number.isFinite(targetIndex) || targetIndex < 0) {
        toastr.warning('No assistant message to run the agent on.');
        return '';
    }

    toastr.info(`Running "${agent.name}"...`);
    const result = await runAgentOnMessage(agent.id, targetIndex);
    return result?.changed ? 'changed' : 'unchanged';
}

/** /sa-list — list all agents with enabled state, phase, and category. */
function handleList() {
    const agents = getAgents();
    if (agents.length === 0) {
        toastr.info('No agents configured.');
        return 'No agents';
    }

    const lines = agents.map(a => {
        const status = a.enabled ? '✅' : '⬜';
        const cat = a.category ? ` [${a.category}]` : '';
        const phase = a.phase ? ` (${a.phase})` : '';
        return `${status} ${a.name}${cat}${phase}`;
    });

    const output = lines.join('\n');
    console.log(`${LOG_PREFIX} agent list:\n${output}`);
    toastr.info(`${agents.length} agent(s) configured. See console for the full list.`);
    return output;
}

/** /sa-toggle [name] — flip an agent on/off. */
function handleToggle(args, value) {
    const agent = resolveAgent(value);
    if (!agent) {
        toastr.warning('Usage: /sa-toggle [agent name]');
        return '';
    }

    const newState = toggleAgent(agent.id);
    const label = newState ? 'enabled' : 'disabled';
    toastr.success(`${agent.name} — ${label}`);
    return label;
}

/** /sa-open — open the unified management modal. */
function handleOpen() {
    try {
        openModal();
    } catch (err) {
        console.warn(`${LOG_PREFIX} openModal failed:`, err);
    }
    return '';
}

/** /sa-stop — cancel the in-flight agent run, if any. */
function handleStop() {
    if (!isAgentRunActive()) {
        toastr.info('No agent run is active.');
        return 'idle';
    }
    const stopped = cancelAgentRun();
    if (stopped) toastr.info('Stopping agent run…');
    return stopped ? 'stopping' : 'idle';
}

// ============================================================================
// REGISTRATION
// ============================================================================

/** Register all SuperAgents slash commands. Called once from index.js init. */
export function registerSlashCommands() {
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'sa-run',
        callback: handleRun,
        helpString: 'Run a SuperAgents agent on the last assistant message. Usage: /sa-run [agent name] (optional message=N to target a specific message index).',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'sa-list',
        callback: handleList,
        helpString: 'List all configured SuperAgents agents with their enabled/disabled state, phase, and category.',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'sa-toggle',
        callback: handleToggle,
        helpString: 'Toggle a SuperAgents agent on or off. Usage: /sa-toggle [agent name].',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'sa-open',
        callback: handleOpen,
        helpString: 'Open the SuperAgents management modal.',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'sa-stop',
        callback: handleStop,
        helpString: 'Cancel the in-flight SuperAgents run (post-gen or manual). Does nothing if no run is active.',
    }));

    debug(`${LOG_PREFIX} slash commands registered (/sa-run, /sa-list, /sa-toggle, /sa-open, /sa-stop)`);
}
