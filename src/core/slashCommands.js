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
 *   /sa-pause [state]  — pause/resume all agents without losing enabled state
 *   /sa-open           — open the unified management modal
 *   /sa-clear [name]   — wipe an agent's stored state from the current chat
 *   /sa-exclude ...    — manage the per-chat Active Roster "never track" list
 *
 * The callback signature is ST's (namedArgs, unnamedValue). /sa-run accepts an
 * optional message= named arg to target a specific index instead of the last
 * assistant message.
 */

import { chat, chat_metadata, saveChatDebounced } from '../../../../../../script.js';
import { SlashCommand } from '../../../../../slash-commands/SlashCommand.js';
import { SlashCommandParser } from '../../../../../slash-commands/SlashCommandParser.js';
import { debug } from './runtime.js';

import {
    getAgents,
    getAgentById,
    getAgentByName,
    toggleAgent,
    isAgentsPaused,
    setAgentsPaused,
    toggleAgentsPaused,
} from '../data/store.js';
import { runAgentOnMessage, cancelAgentRun, isAgentRunActive } from './lifecycle.js';
import { clearAgentChatState } from '../modes/mergeVariable.js';
import { clearActivationPolicyState } from './activationPolicy.js';
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

    const pauseLine = isAgentsPaused()
        ? '⏸ Automatic agent calls paused (saved enablement and state context preserved)'
        : '▶ Agent execution active';
    const output = [pauseLine, ...lines].join('\n');
    console.log(`${LOG_PREFIX} agent list:\n${output}`);
    toastr.info(`${agents.length} agent(s) configured. See console for the full list.`);
    return output;
}

/** /sa-pause [on|off|toggle|status] — control the global execution gate. */
function handlePause(args, value) {
    const action = String(value ?? '').trim().toLowerCase();
    let paused;

    if (!action || action === 'toggle') {
        paused = toggleAgentsPaused();
    } else if (['on', 'pause', 'paused', 'true', '1'].includes(action)) {
        paused = setAgentsPaused(true);
    } else if (['off', 'resume', 'resumed', 'false', '0'].includes(action)) {
        paused = setAgentsPaused(false);
    } else if (action === 'status') {
        paused = isAgentsPaused();
    } else {
        toastr.warning('Usage: /sa-pause [on|off|toggle|status]');
        return '';
    }

    if (paused) toastr.info('Automatic agent calls paused. Stored state and manual runs stay available.');
    else toastr.success('Automatic agent calls resumed with the previously enabled agents.');
    return paused ? 'paused' : 'active';
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

/**
 * /sa-clear [name] — wipe an agent's stored state from the current chat.
 * Deliberate + scoped: requires a named agent, never clears everything at once.
 */
async function handleClear(args, value) {
    const agent = resolveAgent(value);
    if (!agent) {
        toastr.warning('Usage: /sa-clear [agent name]');
        return '';
    }
    const hasMemory = Boolean(agent.mergeVariable?.variableName);
    const summary = hasMemory
        ? clearAgentChatState(agent)
        : { messagesTouched: 0, policyCleared: clearActivationPolicyState(agent) };
    if (!hasMemory && !summary.policyCleared) {
        toastr.warning(`"${agent.name}" has no chat data or completed one-shot run to clear.`);
        return '';
    }

    // Refresh the State Card panel so cleared components drop out immediately.
    // Dynamic import avoids a load-time cycle with the ui layer.
    try {
        const { update } = await import('../ui/stateCard.js');
        update();
    } catch (err) {
        debug(`${LOG_PREFIX} state card refresh after clear failed:`, err);
    }

    toastr.success(`Cleared "${agent.name}" state from this chat (${summary.messagesTouched} message(s)). Its initialization policy is re-armed.`);
    return 'cleared';
}

/**
 * /sa-exclude [add|remove|list|clear] [name] — manage the per-chat "never track"
 * list read by participant-excluding trackers (Active Roster). Player personas
 * are auto-excluded already (any is_user author name); this is for ANYONE ELSE
 * you want kept out of the roster: a persona who hasn't spoken yet, or an NPC you
 * simply don't want tracked, for any reason. Stored on
 * chat_metadata.saRosterExclude; takes effect on the next tracker run.
 */
function handleExclude(args, value) {
    if (!chat_metadata || typeof chat_metadata !== 'object') {
        toastr.warning('No chat is loaded.');
        return '';
    }

    const raw = String(value ?? '').trim();
    const spaceIdx = raw.indexOf(' ');
    const verb = (spaceIdx < 0 ? raw : raw.slice(0, spaceIdx)).toLowerCase() || 'list';
    const name = spaceIdx < 0 ? '' : raw.slice(spaceIdx + 1).trim();
    const norm = s => String(s ?? '').trim().toLowerCase();

    if (!Array.isArray(chat_metadata.saRosterExclude)) chat_metadata.saRosterExclude = [];
    const list = chat_metadata.saRosterExclude;

    switch (verb) {
        case 'add': {
            if (!name) { toastr.warning('Usage: /sa-exclude add [name]'); return ''; }
            if (list.some(n => norm(n) === norm(name))) {
                toastr.info(`"${name}" is already excluded in this chat.`);
                return 'exists';
            }
            list.push(name);
            saveChatDebounced();
            toastr.success(`"${name}" will no longer be tracked in this chat. Continue or /sa-run Active Roster to apply now.`);
            return 'added';
        }
        case 'remove':
        case 'rm': {
            if (!name) { toastr.warning('Usage: /sa-exclude remove [name]'); return ''; }
            const idx = list.findIndex(n => norm(n) === norm(name));
            if (idx < 0) { toastr.info(`"${name}" is not on the exclude list.`); return 'missing'; }
            list.splice(idx, 1);
            saveChatDebounced();
            toastr.success(`"${name}" removed from the exclude list.`);
            return 'removed';
        }
        case 'clear': {
            const had = list.length;
            chat_metadata.saRosterExclude = [];
            saveChatDebounced();
            toastr.success(`Exclude list cleared (${had} name(s) removed).`);
            return 'cleared';
        }
        case 'list':
        default: {
            if (!list.length) {
                toastr.info('No names are manually excluded in this chat. (Player personas are auto-excluded.)');
                return '';
            }
            const output = list.join(', ');
            toastr.info(`Manually excluded in this chat: ${output}`);
            return output;
        }
    }
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
        name: 'sa-pause',
        callback: handlePause,
        helpString: 'Pause or resume all SuperAgents without changing which agents are enabled. With no argument, toggles the state. Usage: /sa-pause [on|off|toggle|status].',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'sa-open',
        callback: handleOpen,
        helpString: 'Open the SuperAgents management modal.',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'sa-clear',
        callback: handleClear,
        helpString: 'Wipe a SuperAgents agent\'s stored state and re-arm its initialization/one-shot policy in the CURRENT chat. Usage: /sa-clear [agent name]. Does not disable the agent.',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'sa-stop',
        callback: handleStop,
        helpString: 'Cancel the in-flight SuperAgents run (post-gen or manual). Does nothing if no run is active.',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'sa-exclude',
        callback: handleExclude,
        helpString: 'Manage the per-chat "never track" list for participant-excluding trackers (Active Roster). Player personas are auto-excluded; use this for anyone else. Usage: /sa-exclude add [name] | remove [name] | list | clear. Takes effect on the next tracker run.',
    }));

    debug(`${LOG_PREFIX} slash commands registered (/sa-run, /sa-list, /sa-toggle, /sa-pause, /sa-open, /sa-clear, /sa-stop, /sa-exclude)`);
}
