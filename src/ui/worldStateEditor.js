/** Validated, branch-aware correction UI for the current World State snapshot. */

import { chat, saveChatDebounced } from '../../../../../../script.js';
import { getAgents } from '../data/store.js';
import { storeBatchedSidecarResult } from '../modes/mergeVariable.js';
import { buildSidecarDisplayData } from '../modes/sidecar.js';
import { refreshMessage } from '../render/renderer.js';

const OVERLAY_ID = 'sa-world-state-editor-overlay';
const CSS_HREF = '/scripts/extensions/third-party/SillyTavern-SuperAgents/src/ui/worldStateEditor.css?v=0.42.7';
const WORLD_STATE_VARIABLE = 'sa_world_state';
const TEXT_FIELDS = new Set(['location', 'date', 'time']);
const FIELD_LABELS = Object.freeze({
    location: 'Location',
    date: 'Date',
    time: 'Time',
    timeOfDay: 'Time of day',
    weather: 'Weather',
    temperature: 'Temperature',
    setting: 'Setting',
});

let initialized = false;

function esc(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function injectStylesheet() {
    let link = document.querySelector('link[data-sa-world-state-editor]');
    if (!link) {
        link = document.createElement('link');
        link.rel = 'stylesheet';
        link.setAttribute('data-sa-world-state-editor', '');
        document.head.appendChild(link);
    }
    link.href = CSS_HREF;
}

function getWorldStateAgent() {
    return getAgents().find(agent => agent.sourceTemplateId === 'tpl-world-state'
        || agent.mergeVariable?.variableName === WORLD_STATE_VARIABLE) ?? null;
}

function normalizeClock(value) {
    const raw = String(value ?? '').trim();
    if (!raw || raw.toLowerCase() === 'unknown') return 'Unknown';
    const match = raw.match(/^(\d{1,2}):([0-5]\d)\s*(AM|PM)$/i);
    if (!match) return null;
    const hour = Number(match[1]);
    if (hour < 1 || hour > 12) return null;
    return `${String(hour).padStart(2, '0')}:${match[2]} ${match[3].toUpperCase()}`;
}

export function normalizeWorldStateFormValue(raw = {}) {
    const value = {};
    for (const key of Object.keys(FIELD_LABELS)) {
        const fieldValue = String(raw[key] ?? '').trim();
        value[key] = fieldValue || 'Unknown';
    }
    const time = normalizeClock(value.time);
    if (!time) {
        return {
            value: null,
            error: 'Time must use HH:MM AM/PM (for example, 03:45 PM) or Unknown.',
        };
    }
    value.time = time;
    return { value, error: '' };
}

function schemaChoices(agent, field) {
    const choices = agent?.mergeVariable?.validation?.schema?.properties?.[field]?.enum;
    return Array.isArray(choices) ? choices.map(String) : [];
}

function renderField(agent, key, currentValue) {
    const label = FIELD_LABELS[key];
    if (TEXT_FIELDS.has(key)) {
        const placeholder = key === 'time' ? '03:45 PM or Unknown' : 'Unknown';
        return `<label class="sa-world-state-editor-field">
            <span>${esc(label)}</span>
            <input name="${esc(key)}" value="${esc(currentValue)}" placeholder="${esc(placeholder)}" autocomplete="off">
        </label>`;
    }

    const choices = schemaChoices(agent, key);
    const selected = choices.includes(String(currentValue)) ? String(currentValue) : 'Unknown';
    return `<label class="sa-world-state-editor-field">
        <span>${esc(label)}</span>
        <select name="${esc(key)}">
            ${choices.map(choice => `<option value="${esc(choice)}"${choice === selected ? ' selected' : ''}>${esc(choice)}</option>`).join('')}
        </select>
    </label>`;
}

function closeEditor() {
    document.getElementById(OVERLAY_ID)?.remove();
}

function readCurrentState(agent, messageIndex) {
    const resolved = globalThis.SuperAgents?.integration?.getAgentState?.(agent.id, { messageIndex });
    return resolved?.found && resolved.value && typeof resolved.value === 'object'
        ? resolved.value
        : null;
}

function showError(overlay, message) {
    const error = overlay.querySelector('.sa-world-state-editor-error');
    if (!error) return;
    error.textContent = message || '';
    error.hidden = !message;
}

function validationErrorText(error) {
    if (!error) return 'That correction did not pass World State validation.';
    if (typeof error === 'string') return error;
    return [error.path, error.message].filter(Boolean).join(': ')
        || 'That correction did not pass World State validation.';
}

function openEditor(messageIndex) {
    const agent = getWorldStateAgent();
    const message = chat[messageIndex];
    const current = agent ? readCurrentState(agent, messageIndex) : null;
    if (!agent || !message || !current) {
        toastr.warning('No editable World State snapshot is available on this branch.');
        return;
    }

    closeEditor();
    injectStylesheet();

    const overlay = document.createElement('div');
    overlay.id = OVERLAY_ID;
    overlay.className = 'sa-world-state-editor-overlay';
    overlay.innerHTML = `<section class="sa-world-state-editor" role="dialog" aria-modal="true" aria-labelledby="sa-world-state-editor-title">
        <header>
            <div>
                <h3 id="sa-world-state-editor-title">Correct World State</h3>
                <p>Updates the current branch from this point forward.</p>
            </div>
            <button type="button" class="sa-world-state-editor-close" data-sa-world-state-close aria-label="Close"><i class="fa-solid fa-xmark"></i></button>
        </header>
        <form>
            <div class="sa-world-state-editor-grid">
                ${Object.keys(FIELD_LABELS).map(key => renderField(agent, key, current[key] ?? 'Unknown')).join('')}
            </div>
            <p class="sa-world-state-editor-error" role="alert" hidden></p>
            <footer>
                <button type="button" class="menu_button" data-sa-world-state-close>Cancel</button>
                <button type="submit" class="menu_button menu_button_icon"><i class="fa-solid fa-check"></i> Save correction</button>
            </footer>
        </form>
    </section>`;
    document.body.appendChild(overlay);

    const onKeyDown = event => {
        if (event.key !== 'Escape') return;
        document.removeEventListener('keydown', onKeyDown);
        closeEditor();
    };
    document.addEventListener('keydown', onKeyDown);
    const dismiss = () => {
        document.removeEventListener('keydown', onKeyDown);
        closeEditor();
    };

    overlay.addEventListener('click', event => {
        if (event.target === overlay || event.target.closest('[data-sa-world-state-close]')) dismiss();
    });
    overlay.querySelector('form')?.addEventListener('submit', event => {
        event.preventDefault();
        const formData = new FormData(event.currentTarget);
        const raw = Object.fromEntries(Object.keys(FIELD_LABELS).map(key => [key, formData.get(key)]));
        const normalized = normalizeWorldStateFormValue(raw);
        if (!normalized.value) {
            showError(overlay, normalized.error);
            return;
        }

        const stored = storeBatchedSidecarResult(
            agent,
            normalized.value,
            message,
            messageIndex,
            'manual_world_state_edit',
        );
        if (!stored) {
            const transaction = message.saAgentStateTransactions?.[agent.id]?.[message.swipe_id ?? 0];
            showError(overlay, validationErrorText(transaction?.errors?.[0]));
            return;
        }

        buildSidecarDisplayData(agent, message, messageIndex, stored);
        saveChatDebounced();
        refreshMessage(messageIndex);
        dismiss();
        toastr.success('World State corrected for the current branch.');
    });

    requestAnimationFrame(() => overlay.querySelector('input, select')?.focus());
}

function onDocumentClick(event) {
    const button = event.target.closest?.('[data-sa-world-state-edit]');
    if (!button) return;
    event.preventDefault();
    event.stopPropagation();
    const messageIndex = Number(button.dataset.messageIndex);
    if (Number.isInteger(messageIndex) && messageIndex >= 0) openEditor(messageIndex);
}

export function initWorldStateEditor() {
    if (initialized) return;
    initialized = true;
    injectStylesheet();
    document.addEventListener('click', onDocumentClick);
}
