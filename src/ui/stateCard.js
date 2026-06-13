/**
 * ui/stateCard.js — State Card floating panel.
 *
 * A draggable glass HUD that renders schema-driven state (world events, user
 * stats, per-character cards with meters/tags) extracted by a state-card
 * agent into a chat-local merge variable. The data shape and schema are
 * identical to VerseManager's state card; the difference here is the shell:
 * instead of an edge-docked sidebar, this is a free-floating panel built on
 * ui/draggablePanel.js, so it never competes for a screen edge (White Lotus
 * collision dissolved). It registers with the modal's Settings tab via
 * registerPanelControl, which gives the user show/hide + reset-position.
 *
 * Data source: the enabled agent whose `stateCard.schema` is set. That agent's
 * `mergeVariable.variableName` (default `sa_state_card`) holds an array whose
 * first item's `json` field is the full state blob, e.g.
 *   [{ json: '{"worldEvents":[...],"user":{...},"characters":{...}}', ... }]
 * (written by modes/mergeVariable.js in snapshot mode).
 *
 * Styles live in ui/stateCard.css, injected as a <link> at init so the
 * panel's CSS travels with this module rather than bloating the root stylesheet.
 *
 * Ported from VM's stateCardSidebar.js. Namespace vm→sa; sidebar→floating panel.
 */

import {
    chat_metadata,
    this_chid,
    eventSource,
    event_types,
    saveSettingsDebounced,
} from '../../../../../../script.js';
import { selected_group } from '../../../../../group-chats.js';
import { extension_settings } from '../../../../../extensions.js';
import { MODULE_NAME, debug } from '../../index.js';
import { getEnabledAgents } from '../data/store.js';
import { makeDraggablePanel } from './draggablePanel.js';
import { registerPanelControl } from './modal.js';
import { onPostProcessComplete } from '../core/lifecycle.js';

const LOG_PREFIX = '[SuperAgents/stateCard]';
const PANEL_ID = 'state-card';
const DEFAULT_VARIABLE = 'sa_state_card';
// Hardcoded (not `${MODULE_NAME}`): MODULE_NAME is still in its import TDZ when
// this module evaluates due to the index.js↔ui circular import, so building the
// href at top level would yield ".../undefined/...". templateSync.js hardcodes
// its base path for the same reason.
const CSS_HREF = '/scripts/extensions/third-party/SillyTavern-SuperAgents/src/ui/stateCard.css';

// ============================================================================
// STATE
// ============================================================================

/** @type {HTMLElement|null} */ let panelEl = null;
/** @type {ReturnType<typeof makeDraggablePanel>|null} */ let controller = null;
let currentSchema = null;
let currentVariable = DEFAULT_VARIABLE;

// Cached HTML from the last successful render. Lets us preserve the display
// across transient empty reads (e.g. when batch mode gets `state_card: {}`
// back from the LLM and would otherwise clobber the panel with "State data
// is empty"). Cleared on CHAT_CHANGED, on agent disable, and on parse failure
// so the user always sees fresh state when context legitimately changes.
let lastGoodHtml = null;

// Debounce token for MESSAGE_RECEIVED / CHARACTER_MESSAGE_RENDERED triggers.
// Multiple events fire in rapid succession; one trailing update() per burst.
let refreshTimer = null;
function scheduleRefresh(delay = 150) {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
        refreshTimer = null;
        update();
    }, delay);
}

// ============================================================================
// CHAT-ACTIVE DETECTION
// ============================================================================

/**
 * True when SillyTavern is actually inside a chat (character or group),
 * false on the Landing Page / empty state. Used to gate visibility so the
 * panel doesn't punch through the landing UI on first load.
 */
function isInChat() {
    // `this_chid` is undefined on Landing and a string index in a character chat;
    // `selected_group` is null on Landing and a group id in a group chat.
    return (this_chid != null) || !!selected_group;
}

// ============================================================================
// VISIBILITY PERSISTENCE (own key — draggablePanel owns position separately)
// ============================================================================

function isVisiblePersisted() {
    return !!extension_settings[MODULE_NAME]?.stateCardVisible;
}
function persistVisible(v) {
    const root = extension_settings[MODULE_NAME] ?? (extension_settings[MODULE_NAME] = {});
    root.stateCardVisible = !!v;
    saveSettingsDebounced();
}

function isCollapsedPersisted() {
    return !!extension_settings[MODULE_NAME]?.stateCardCollapsed;
}
function persistCollapsed(v) {
    const root = extension_settings[MODULE_NAME] ?? (extension_settings[MODULE_NAME] = {});
    root.stateCardCollapsed = !!v;
    saveSettingsDebounced();
}

// ── Per-character card collapse state ───────────────────────────────────────
// Character stat cards default to COLLAPSED; the user opens the ones they care
// about and that choice survives re-renders (every gen rebuilds the card DOM)
// and reloads. Stored as a name→bool "expanded" map so only the cards the user
// explicitly opened are remembered; everything else falls back to collapsed.
function getCharExpandStore() {
    const root = extension_settings[MODULE_NAME] ?? (extension_settings[MODULE_NAME] = {});
    if (!root.stateCardCharExpanded || typeof root.stateCardCharExpanded !== 'object') {
        root.stateCardCharExpanded = {};
    }
    return root.stateCardCharExpanded;
}
/** True if this character's card was last left expanded (default false). */
function isCharExpanded(name) {
    return !!getCharExpandStore()[name];
}
/** Persist a character card's expanded/collapsed state. */
function persistCharExpanded(name, expanded) {
    getCharExpandStore()[name] = !!expanded;
    saveSettingsDebounced();
}

// ============================================================================
// CHARACTER COLORS — deterministic from name hash
// ============================================================================

const CHAR_COLORS = [
    '#D4537E', '#7F77DD', '#1D9E75', '#EF9F27', '#378ADD',
    '#D85A30', '#639922', '#9A7EC0', '#5A8DB8', '#BA7517',
];

function hashColor(name) {
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
        hash = name.charCodeAt(i) + ((hash << 5) - hash);
    }
    return CHAR_COLORS[Math.abs(hash) % CHAR_COLORS.length];
}

// ============================================================================
// CSS INJECTION
// ============================================================================

function injectStylesheet() {
    if (document.querySelector(`link[data-sa-state-card]`)) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = CSS_HREF;
    link.setAttribute('data-sa-state-card', '');
    document.head.appendChild(link);
}

// ============================================================================
// INIT
// ============================================================================

/**
 * Build the panel DOM, make it draggable, register it with the Settings tab,
 * and wire refresh triggers. Called once from index.js during init.
 */
export function initStateCard() {
    if (panelEl) return;

    injectStylesheet();

    panelEl = document.createElement('div');
    panelEl.id = 'sa-state-card-panel';
    panelEl.className = 'sa-sc-panel';
    panelEl.innerHTML = `
        <div class="sa-sc-header" title="Drag to move">
            <i class="fa-solid fa-grip-lines sa-sc-grip"></i>
            <span class="sa-sc-title">State Card</span>
            <div class="sa-sc-collapse" data-no-drag title="Collapse"><i class="fa-solid fa-minus"></i></div>
            <div class="sa-sc-close" data-no-drag title="Close"><i class="fa-solid fa-xmark"></i></div>
        </div>
        <div class="sa-sc-body">
            <div class="sa-sc-empty">No state data yet.</div>
        </div>
    `;
    document.body.appendChild(panelEl);

    // Floating-panel behaviour: drag by the header, snap to L/R edges, anchor
    // center-right by default (clear of the chat input bar).
    controller = makeDraggablePanel(panelEl, {
        id: PANEL_ID,
        handle: '.sa-sc-header',
        defaultAnchor: 'center-right',
        snapToEdges: true,
        resizable: true,
        minW: 240,
        minH: 220,
    });

    // Close button hides the panel (and remembers the choice, which also
    // unchecks the Settings-tab toggle since that reads isOpen()).
    panelEl.querySelector('.sa-sc-close')?.addEventListener('click', () => hide());

    // Collapse button folds the body away but keeps the panel "open" (no
    // visibility persistence change) so it stays a slim header bar in place.
    panelEl.querySelector('.sa-sc-collapse')?.addEventListener('click', () => toggleCollapsed());

    // Restore persisted collapsed state so a folded panel stays folded across reloads.
    applyCollapsed(isCollapsedPersisted());

    // Register with the modal's Settings tab so the user gets a show/hide
    // toggle + reset-position control. Wrap show/hide so visibility persists.
    registerPanelControl({
        id: PANEL_ID,
        label: 'State Card',
        icon: 'fa-id-card',
        controller: {
            show:          () => show(),
            hide:          () => hide(),
            toggle:        () => (isOpen() ? hide() : show()),
            isOpen,
            resetPosition: () => controller?.resetPosition(),
        },
    });

    // Refresh triggers.
    //
    // We listen to a wider set than the original (post-process + CHAT_CHANGED +
    // MESSAGE_SWIPED) because the post-process callback can race with the
    // merge-variable write in batch mode — by the time the listener fires,
    // the variable may or may not be populated depending on which agent in
    // the batch was processed last. MESSAGE_RECEIVED + CHARACTER_MESSAGE_RENDERED
    // are debounced fallback reads that catch the write once it lands, so
    // the panel never gets stuck on stale "no state yet" because of timing.
    onPostProcessComplete(() => update());
    eventSource.on(event_types.MESSAGE_RECEIVED, () => scheduleRefresh(250));
    if (event_types.CHARACTER_MESSAGE_RENDERED) {
        eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, () => scheduleRefresh(150));
    }
    eventSource.on(event_types.MESSAGE_SWIPED, () => scheduleRefresh(100));

    // CHAT_CHANGED is the *real* invalidation: a new chat means the cached
    // state belongs to the previous conversation. Drop the cache, then
    // reconcile visibility against the new chat-active state.
    eventSource.on(event_types.CHAT_CHANGED, () => {
        lastGoodHtml = null;
        setTimeout(reconcileVisibility, 200);
    });

    // Initial reconciliation: only show on the Landing Page if the persisted
    // flag is set AND we're already in a chat. If ST loaded straight to a
    // chat the user will see the panel; if we're on Landing it stays hidden
    // until they pick a chat.
    reconcileVisibility();

    debug(`${LOG_PREFIX} initialized`);
}

/**
 * Bring panel visibility in line with persisted intent and chat presence.
 * Called on init and after every CHAT_CHANGED. The persisted "visible" flag
 * captures user intent; this function decides whether that intent applies
 * right now (we're in a chat) or has to wait (we're on Landing).
 */
function reconcileVisibility() {
    if (!controller) return;
    if (!isInChat()) {
        // Don't persist the hide — keep the user's "I want this visible"
        // intent so re-entering a chat restores it.
        controller.hide();
        return;
    }
    if (isVisiblePersisted()) {
        controller.show();
        update();
    } else {
        update();
    }
}

// ============================================================================
// SHOW / HIDE
// ============================================================================

export function show() {
    if (!controller) return;
    controller.show();
    persistVisible(true);
    update();
}

export function hide() {
    if (!controller) return;
    controller.hide();
    persistVisible(false);
}

export function isOpen() {
    return !!controller?.isOpen();
}

// ============================================================================
// COLLAPSE / EXPAND — folds the body away but keeps the panel open
// ============================================================================

/**
 * Apply the collapsed class to the panel and sync the toggle button's icon
 * (minus when expanded, plus when collapsed). Pure DOM; no persistence.
 */
function applyCollapsed(collapsed) {
    if (!panelEl) return;
    panelEl.classList.toggle('sa-sc-collapsed-panel', collapsed);
    const icon = panelEl.querySelector('.sa-sc-collapse i');
    if (icon) icon.className = collapsed ? 'fa-solid fa-plus' : 'fa-solid fa-minus';
    const btn = panelEl.querySelector('.sa-sc-collapse');
    if (btn) btn.title = collapsed ? 'Expand' : 'Collapse';
}

/** Flip collapsed state, persist it, and reflect it in the DOM. */
function toggleCollapsed() {
    const next = !isCollapsedPersisted();
    persistCollapsed(next);
    applyCollapsed(next);
}

// ============================================================================
// DATA SOURCE
// ============================================================================

/**
 * Find the enabled agent that drives the state card (the one with a
 * stateCard schema). Returns null when none is active.
 * @returns {object|null}
 */
function getStateCardAgent() {
    return getEnabledAgents().find(a => a.stateCard && a.stateCard.schema) || null;
}

/**
 * Read the raw state JSON string from the merge variable array.
 * The state-card agent stores a single snapshot item whose `json` field holds
 * the full blob; fall back to the first field if the schema names it differently.
 * @returns {string|null}
 */
function readStateJson() {
    try {
        const raw = chat_metadata?.variables?.[currentVariable];
        if (!raw) return null;
        const arr = JSON.parse(raw);
        if (Array.isArray(arr) && arr.length > 0) {
            const first = arr[0];
            const blob = first.json ?? first[Object.keys(first).find(k => !k.startsWith('_'))];
            return typeof blob === 'string' ? blob.trim() : null;
        }
        return null;
    } catch {
        return null;
    }
}

// ============================================================================
// UPDATE — resolve agent, read state, re-render
// ============================================================================

/**
 * Re-read the current state and re-render. No-op on DOM if the panel is hidden,
 * but still cheap. Resolves the active state-card agent each call so enabling/
 * disabling or swapping agents is picked up without a reload.
 *
 * Preserves the previous render across transient empty reads. Three cases:
 *   1. No agent enabled       → always show the "no agent" notice (intent-clear).
 *   2. Variable empty/unset   → if we have cached HTML, keep it; otherwise notice.
 *   3. Parsed object is empty → same as 2; the LLM returned {} this turn but
 *                                old state is still meaningful for the user.
 */
export function update() {
    if (!panelEl) return;

    const agent = getStateCardAgent();
    currentSchema = agent?.stateCard?.schema || null;
    currentVariable = agent?.mergeVariable?.variableName || DEFAULT_VARIABLE;

    if (!agent) {
        // Explicit config state, not a transient — clear the cache so re-enabling
        // doesn't blink stale data back in before the next extraction.
        lastGoodHtml = null;
        renderNotice('No state-card agent enabled.', 'Enable one from the Library or Agents tab.');
        return;
    }

    const raw = readStateJson();
    if (!raw) {
        // Variable not yet populated. First-time empty → show the prompt-to-generate
        // notice. Subsequent empty → keep the last good render so a single bad
        // extraction doesn't wipe the user's view.
        if (!lastGoodHtml) {
            renderNotice('No state data yet.', 'Generate a message to populate.');
        }
        return;
    }

    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (err) {
        debug(`${LOG_PREFIX} state JSON parse failed:`, err);
        if (!lastGoodHtml) {
            renderNotice('State data could not be read.', 'The last extraction may have been malformed.');
        }
        return;
    }

    // The LLM occasionally returns an empty envelope value (e.g. `state_card: {}`
    // in batch mode), which storeBatchedSidecarResult dutifully stores as
    // `{json: "{}"}`. Treat that as a transient miss too — keep the last good
    // display rather than wiping it to "State data is empty".
    if (!hasMeaningfulState(parsed)) {
        if (!lastGoodHtml) {
            renderNotice('No state data yet.', 'Generate a message to populate.');
        }
        return;
    }

    renderCards(parsed, currentSchema);
}

/**
 * Treat a parsed state as "meaningful" if it carries at least one tracked
 * dimension (world events, user stats, characters, or a legacy v2 scene).
 * Empty objects from a failed extraction don't qualify, so we preserve the
 * prior render instead of clobbering it.
 */
function hasMeaningfulState(data) {
    if (!data || typeof data !== 'object') return false;
    if (Array.isArray(data.worldEvents) && data.worldEvents.length > 0) return true;
    if (data.user && typeof data.user === 'object' && Object.keys(data.user).length > 0) return true;
    if (data.characters && typeof data.characters === 'object' && Object.keys(data.characters).length > 0) return true;
    if (data.scene && typeof data.scene === 'object' && Object.keys(data.scene).length > 0) return true;
    return false;
}

// ============================================================================
// RENDER
// ============================================================================

function bodyEl() {
    return panelEl?.querySelector('.sa-sc-body') || null;
}

function renderNotice(main, hint) {
    const body = bodyEl();
    if (!body) return;
    body.innerHTML = `<div class="sa-sc-empty">${esc(main)}<span class="sa-sc-empty-hint">${esc(hint)}</span></div>`;
}

/**
 * Render the full panel body from parsed state data + schema.
 * @param {object} data  { worldEvents:[...], user:{...}, characters:{...} }
 * @param {object} schema  agent.stateCard.schema
 */
function renderCards(data, schema) {
    const body = bodyEl();
    if (!body) return;
    schema = schema || {};

    let html = '';

    if (Array.isArray(data.worldEvents) && data.worldEvents.length > 0) {
        html += buildWorldEventsCard(data.worldEvents, schema.worldEvents);
    }

    if (data.user && typeof data.user === 'object') {
        html += buildCard({
            type: 'user', icon: '♦', label: 'You', data: data.user,
            textFieldDefs: [], meterDefs: schema.userStats || [],
        });
    }

    if (data.characters && typeof data.characters === 'object') {
        for (const [name, charData] of Object.entries(data.characters)) {
            if (!charData || typeof charData !== 'object') continue;
            const color = hashColor(name);
            const initial = name.charAt(0).toUpperCase();
            const avatarHtml = `<div class="sa-sc-avatar" style="background:${color}15;color:${color}">${esc(initial)}</div>`;
            html += buildCard({
                type: 'character', iconHtml: avatarHtml, label: name, data: charData,
                textFieldDefs: schema.characterTextFields || [], meterDefs: schema.meters || [],
                // Default collapsed; restore the user's last open/closed choice.
                collapsed: !isCharExpanded(name),
                cardName: name,
            });
        }
    }

    // Legacy v2 scene card (backwards compat).
    if (data.scene && Object.keys(data.scene).length > 0 && !data.worldEvents && !data.user) {
        html += buildCard({
            type: 'scene', icon: '◈', label: 'Scene', data: data.scene,
            textFieldDefs: schema.sceneFields || [], meterDefs: [],
        });
    }

    body.innerHTML = html || '<div class="sa-sc-empty">State data is empty.</div>';
    if (html) lastGoodHtml = html;

    // Character cards collapse on header click (world events + user are pinned).
    // Persist the new state by character name so it survives the next re-render.
    body.querySelectorAll('.sa-sc-card[data-type="character"] .sa-sc-card-header').forEach(header => {
        header.addEventListener('click', () => {
            const card = header.closest('.sa-sc-card');
            if (!card) return;
            const nowCollapsed = card.classList.toggle('sa-sc-collapsed');
            const name = card.getAttribute('data-char-name');
            if (name) persistCharExpanded(name, !nowCollapsed);
        });
    });
}

// ============================================================================
// WORLD EVENTS CARD
// ============================================================================

function buildWorldEventsCard(events, config) {
    const label = config?.label || 'World Events';
    const icon = config?.icon || '◈';
    const maxItems = config?.maxItems || 3;
    const listHtml = events.slice(0, maxItems)
        .map(e => `<div class="sa-sc-event">${esc(String(e))}</div>`)
        .join('');

    return `<div class="sa-sc-card sa-sc-pinned sa-sc-world-events" data-type="world-events">
        <div class="sa-sc-card-header">
            <span class="sa-sc-card-icon">${icon}</span>
            <span class="sa-sc-card-label">${esc(label)}</span>
        </div>
        <div class="sa-sc-card-body">${listHtml}</div>
    </div>`;
}

// ============================================================================
// CARD BUILDER
// ============================================================================

function buildCard({ type, icon, iconHtml, label, data, textFieldDefs, meterDefs, collapsed = false, cardName = null }) {
    const textFields = [];
    const meterFields = [];
    const listFields = [];

    for (const [key, value] of Object.entries(data)) {
        if (typeof value === 'number') meterFields.push({ key, value });
        else if (typeof value === 'string') textFields.push({ key, value });
        else if (Array.isArray(value)) listFields.push({ key, value });
    }

    // ── Text fields ──
    const fieldsHtml = textFields.map(({ key, value }) => {
        const def = textFieldDefs.find(f => f.key === key);
        const fieldLabel = def?.label || formatKey(key);
        if ((def?.type || 'text') === 'badge') {
            const badgeColor = def?.badgeColor || '#AFA9EC';
            return `<div class="sa-sc-field">
                <span class="sa-sc-field-label">${esc(fieldLabel)}</span>
                <span class="sa-sc-badge" style="background:${badgeColor}18;color:${badgeColor}">${esc(value)}</span>
            </div>`;
        }
        return `<div class="sa-sc-field">
            <span class="sa-sc-field-label">${esc(fieldLabel)}</span>
            <span class="sa-sc-field-value">${esc(value)}</span>
        </div>`;
    }).join('');

    // ── List fields (tags) ──
    const listsHtml = listFields.map(({ key, value }) => {
        const tags = value.map(v => `<span class="sa-sc-tag">${esc(String(v))}</span>`).join('');
        return `<div class="sa-sc-field"><span class="sa-sc-field-label">${esc(formatKey(key))}</span></div>
        <div class="sa-sc-tags">${tags}</div>`;
    }).join('');

    // ── Meters ──
    let metersHtml = '';
    if (meterFields.length > 0) {
        if (fieldsHtml || listsHtml) metersHtml += '<div class="sa-sc-sep"></div>';
        const useDual = meterFields.length >= 2;
        if (useDual) metersHtml += '<div class="sa-sc-meters-dual">';
        for (const { key, value } of meterFields) {
            const def = meterDefs.find(m => m.key === key);
            const meterLabel = def?.label || formatKey(key);
            const color = def?.color || '#A0A8B0';
            const max = def?.max || 100;
            const pct = Math.min(100, Math.max(0, (value / max) * 100));
            const wrapClass = useDual ? 'sa-sc-meter-col' : 'sa-sc-meter';
            metersHtml += `<div class="${wrapClass}">
                <div class="sa-sc-meter-head">
                    <span class="sa-sc-meter-label"><span class="sa-sc-meter-dot" style="background:${color}"></span>${esc(meterLabel)}</span>
                    <span class="sa-sc-meter-num">${Math.round(value)}</span>
                </div>
                <div class="sa-sc-meter-track"><div class="sa-sc-meter-fill" style="width:${pct}%;background:${color}"></div></div>
            </div>`;
        }
        if (useDual) metersHtml += '</div>';
    }

    // ── Compact meter strip (character cards only — shown when collapsed) ──
    let compactHtml = '';
    if (type === 'character' && meterFields.length > 0) {
        const compactMeters = meterFields.map(({ key, value }) => {
            const def = meterDefs.find(m => m.key === key);
            const color = def?.color || '#A0A8B0';
            const max = def?.max || 100;
            const pct = Math.min(100, Math.max(0, (value / max) * 100));
            return `<div class="sa-sc-compact-meter">
                <div class="sa-sc-compact-track"><div class="sa-sc-compact-fill" style="width:${pct}%;background:${color}"></div></div>
            </div>`;
        }).join('');
        compactHtml = `<div class="sa-sc-compact">${compactMeters}</div>`;
    }

    const iconContent = iconHtml ? iconHtml : `<span class="sa-sc-card-icon">${icon || '◈'}</span>`;
    const isPinned = type !== 'character';
    const collapseIcon = isPinned ? '' : '<span class="sa-sc-collapse-icon">▾</span>';
    const pinnedClass = isPinned ? ' sa-sc-pinned' : '';
    // Character cards may start collapsed (persisted per name). Pinned cards never collapse.
    const collapsedClass = (!isPinned && collapsed) ? ' sa-sc-collapsed' : '';
    const nameAttr = cardName ? ` data-char-name="${esc(cardName)}"` : '';

    return `<div class="sa-sc-card${pinnedClass}${collapsedClass}" data-type="${type}"${nameAttr}>
        <div class="sa-sc-card-header">
            ${iconContent}
            <span class="sa-sc-card-label">${esc(label)}</span>
            ${collapseIcon}
        </div>
        ${compactHtml}
        <div class="sa-sc-card-body">${fieldsHtml}${listsHtml}${metersHtml}</div>
    </div>`;
}

// ============================================================================
// HELPERS
// ============================================================================

function formatKey(key) {
    return key.replace(/[_-]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function esc(str) {
    const div = document.createElement('div');
    div.textContent = str ?? '';
    return div.innerHTML;
}

// ============================================================================
// CLEANUP
// ============================================================================

export function destroyStateCard() {
    if (refreshTimer) {
        clearTimeout(refreshTimer);
        refreshTimer = null;
    }
    controller?.destroy();
    controller = null;
    panelEl = null;
    currentSchema = null;
    lastGoodHtml = null;
}
