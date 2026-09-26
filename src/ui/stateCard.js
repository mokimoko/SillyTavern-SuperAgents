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
    chat,
    chat_metadata,
    eventSource,
    event_types,
    saveSettingsDebounced,
} from '../../../../../../script.js';
import { extension_settings } from '../../../../../extensions.js';
import { MODULE_NAME, debug } from '../core/runtime.js';
import { getEnabledAgents, getAgentById } from '../data/store.js';
import { makeDraggablePanel, mountDraggablePanel } from './draggablePanel.js';
import { registerPanelControl } from './modal.js';
import { refreshSurfaceDock } from './surfaceDock.js';
import { isStoryChatOpen } from './chatPresence.js';
import { resolveSurfaceVisibility, setSurfaceVisibility } from './surfaceVisibilityState.js';
import { onPostProcessComplete, findLastAssistantIndex } from '../core/lifecycle.js';
import {
    resolveStateTraceDetailed,
    clearAgentChatState,
    removeCollectionRecordFromAgentChatState,
} from '../modes/mergeVariable.js';
import { getActivePersonaName, projectActivePersona } from '../core/participants.js';
import { SUPERAGENTS_EVENTS } from '../integration/events.js';
import {
    getResolvedStateCardStyleId,
    initStateCardAppearance,
    onStateCardStyleChanged,
} from '../presentation/stateCardAppearance.js';

const LOG_PREFIX = '[SuperAgents/stateCard]';
const PANEL_ID = 'state-card';
const DEFAULT_VARIABLE = 'sa_state_card';

// Staleness horizon (user's "both" answer). The backward trace reports how many
// messages back it had to walk to find real state. Within this many messages we
// still show it — so a single junk/empty generation (last good state is 1 hop
// back) never blanks the panel. Beyond it, the last real state is too far back
// to trust, so we show honest empty instead of a fossil. A swipe that lands on
// an untracked branch is covered the same way: nearby prior state shows through,
// distant/absent state reads empty.
const STALENESS_HORIZON = 6;
const CSS_HREF = `/scripts/extensions/third-party/${MODULE_NAME}/src/ui/stateCard.css?v=0.50.3`;

// ============================================================================
// STATE
// ============================================================================

/** @type {HTMLElement|null} */ let panelEl = null;
/** @type {ReturnType<typeof makeDraggablePanel>|null} */ let controller = null;
let currentSchema = null;
let currentVariable = DEFAULT_VARIABLE;
/** window listener for SUPERAGENTS_EVENTS.STATE_COMMITTED (kept for teardown). */
let stateCommitHandler = null;
let appearanceUnsubscribe = null;

// Debounce token for MESSAGE_RECEIVED / CHARACTER_MESSAGE_RENDERED triggers.
// Multiple events fire in rapid succession; one trailing update() per burst.
let refreshTimer = null;
let renderDirty = true;
function scheduleRefresh(delay = 150) {
    renderDirty = true;
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = null;
    if (!isOpen()) return;
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
const isInChat = isStoryChatOpen;

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

function persistCardsExpanded(names, expanded) {
    const store = getCharExpandStore();
    for (const name of names) store[name] = !!expanded;
    saveSettingsDebounced();
}

// ── Per-component (section) collapse state ──────────────────────────────────
// Each display component (Scene State, Relationships, Off-Screen, …) can be
// folded independently, keyed by its merge-variable name so the choice survives
// re-renders and reloads. Components default EXPANDED.
function getCompCollapseStore() {
    const root = extension_settings[MODULE_NAME] ?? (extension_settings[MODULE_NAME] = {});
    if (!root.stateCardComponentCollapsed || typeof root.stateCardComponentCollapsed !== 'object') {
        root.stateCardComponentCollapsed = {};
    }
    return root.stateCardComponentCollapsed;
}
/** True if this component's section was last left collapsed (default false). */
function isCompCollapsed(key) {
    return !!getCompCollapseStore()[key];
}
/** Persist a component section's collapsed state. */
function persistCompCollapsed(key, collapsed) {
    getCompCollapseStore()[key] = !!collapsed;
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
    initStateCardAppearance();
    panelEl.dataset.saStateCardStyle = getResolvedStateCardStyleId();
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
    mountDraggablePanel(panelEl);
    appearanceUnsubscribe = onStateCardStyleChanged((resolvedStyleId) => {
        if (panelEl) panelEl.dataset.saStateCardStyle = resolvedStyleId;
    });

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

    // Closing remembers this chat's choice; its Settings default remains intact.
    panelEl.querySelector('.sa-sc-close')?.addEventListener('click', () => hide(false));

    // Collapse button folds the body away but keeps the panel "open" (no
    // visibility persistence change) so it stays a slim header bar in place.
    panelEl.querySelector('.sa-sc-collapse')?.addEventListener('click', () => toggleCollapsed());

    // Restore persisted collapsed state so a folded panel stays folded across reloads.
    applyCollapsed(isCollapsedPersisted());

    // Settings owns the persistent default plus the reset-position control.
    registerPanelControl({
        id: PANEL_ID,
        label: 'State Card',
        icon: 'fa-id-card',
        controller: {
            show:          () => show(),
            hide:          () => hide(),
            toggle:        () => (isOpen() ? hide() : show()),
            isOpen,
            isDefaultVisible: isVisiblePersisted,
            // Available only when at least one enabled agent supplies a component.
            isAvailable:   () => hasDisplayComponents(),
            // Re-sync visibility when agents change (enable/disable/delete).
            reconcile:     () => reconcileVisibility(),
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
    onPostProcessComplete(() => scheduleRefresh(0));
    eventSource.on(event_types.MESSAGE_RECEIVED, () => scheduleRefresh(250));
    if (event_types.CHARACTER_MESSAGE_RENDERED) {
        eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, () => scheduleRefresh(150));
    }
    eventSource.on(event_types.MESSAGE_SWIPED, () => scheduleRefresh(100));
    if (event_types.MESSAGE_DELETED) eventSource.on(event_types.MESSAGE_DELETED, () => scheduleRefresh(100));

    // CHAT_CHANGED is the *real* invalidation: a new chat means any prior
    // render belongs to the previous conversation. Reconcile visibility against
    // the new chat-active state; update() will resolve fresh state via the trace.
    eventSource.on(event_types.CHAT_CHANGED, () => {
        renderDirty = true;
        setTimeout(reconcileVisibility, 200);
    });

    // State-commit trigger. The listeners above cover the normal post-gen flow,
    // but a component can commit OUTSIDE it: a manual /sa-run, or a tracker whose
    // sidecar lands after onPostProcessComplete already fired (e.g. the Active
    // Roster committing in a later/retried batch — observed ~30s behind the main
    // batch). Those commits dispatch SUPERAGENTS_EVENTS.STATE_COMMITTED on the
    // window but were previously invisible to the panel, so their section only
    // appeared after the user toggled the panel off/on. Refresh on any commit so
    // late/manual state lands on its own. Debounced with the other triggers.
    stateCommitHandler = (event) => {
        const variableName = event?.detail?.variableName;
        // Ignore commits that cannot affect this panel. Older emitters may not
        // include a variable name, so keep those as refresh-worthy for compat.
        if (variableName && !getDisplayComponents().some(comp => comp.variable === variableName)) return;

        // Commits from one batch can arrive nearly together. One trailing paint
        // shows the final state without rebuilding the hidden or intermediate UI.
        scheduleRefresh(60);
    };
    globalThis.addEventListener(SUPERAGENTS_EVENTS.STATE_COMMITTED, stateCommitHandler);

    // Initial reconciliation: only show on the Landing Page if the persisted
    // flag is set AND we're already in a chat. If ST loaded straight to a
    // chat the user will see the panel; if we're on Landing it stays hidden
    // until they pick a chat.
    reconcileVisibility();

    debug(`${LOG_PREFIX} initialized`);
}

/**
 * Bring panel visibility in line with this chat's last state, falling back to
 * the Settings default when the chat has no saved choice yet.
 */
function reconcileVisibility() {
    if (!controller) return;
    renderDirty = true;
    // Gate on both chat presence and a backing agent being enabled. Hiding for
    // either reason does NOT clear the persisted "visible" intent, so the panel
    // returns on its own once we're back in a chat AND its agent is enabled.
    if (!isInChat() || !hasDisplayComponents()) {
        controller.hide();
        refreshSurfaceDock();
        return;
    }
    if (resolveSurfaceVisibility(PANEL_ID, isVisiblePersisted())) {
        controller.show();
        if (renderDirty) update();
    } else {
        controller.hide();
        renderDirty = true;
    }
    refreshSurfaceDock();
}

// ============================================================================
// SHOW / HIDE
// ============================================================================

export function show(persist = true) {
    if (!controller) return;
    if (persist) persistVisible(true);
    if (isInChat()) setSurfaceVisibility(PANEL_ID, true);
    if (!isInChat() || !hasDisplayComponents()) {
        controller.hide();
        refreshSurfaceDock();
        return;
    }
    controller.show();
    if (renderDirty) update();
    refreshSurfaceDock();
}

export function hide(persist = true) {
    if (!controller) return;
    if (persist) persistVisible(false);
    if (isInChat()) setSurfaceVisibility(PANEL_ID, false);
    controller.hide();
    refreshSurfaceDock();
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
 * Collect every enabled agent that contributes a COMPONENT to the panel — one
 * with a stateCard display schema and a merge variable to read data from, not
 * explicitly hidden (`stateCard.display === false`). The panel is a neutral host
 * that stacks these components as sections; each carries a display `order`
 * (`stateCard.order`, falling back to `injection.order`) that decides its
 * vertical position. Sorted ascending by order, then name for stable ties.
 * @returns {Array<{agent:object,name:string,variable:string,schema:object,order:number}>}
 */
function getDisplayComponents() {
    return getEnabledAgents()
        .filter(a => a.stateCard && a.stateCard.schema
            && a.stateCard.enabled !== false
            && a.stateCard.display !== false
            && a.mergeVariable?.enabled && a.mergeVariable.variableName)
        .map(a => ({
            agent: a,
            name: a.name || 'State',
            variable: a.mergeVariable.variableName,
            schema: a.stateCard.schema,
            order: a.stateCard.order ?? a.injection?.order ?? 0,
        }))
        .sort((x, y) => (x.order - y.order) || x.name.localeCompare(y.name));
}

/** True when at least one display component exists (gates panel availability). */
export function hasDisplayComponents() {
    return getDisplayComponents().length > 0;
}

/**
 * Resolve the state items array for the currently-viewed message+swipe, with
 * the staleness horizon applied.
 *
 * Anchors the backward trace on the last assistant message + its active swipe.
 * The trace reports how far back it found state; within STALENESS_HORIZON we
 * accept it (recent state shows through a transient empty gen or an untracked
 * swipe), beyond it we treat as empty (too stale to trust). If there is no
 * assistant message yet, read the raw global var so an in-progress first
 * generation still populates the panel.
 * @returns {object[]|null}
 */
function readResolvedStateArray(variableName = currentVariable) {
    const lastIdx = findLastAssistantIndex();
    if (lastIdx >= 0) {
        const swipeId = chat[lastIdx]?.swipe_id ?? 0;
        const { items, distance } = resolveStateTraceDetailed(
            chat,
            lastIdx,
            swipeId,
            variableName,
            { maxDistance: STALENESS_HORIZON },
        );
        if (items !== null) {
            // Beyond the horizon → the freshest real state is too far back; show
            // empty rather than a fossil. Within it → accept (this is what holds
            // the panel through a single junk gen or an untracked swipe).
            if (distance > STALENESS_HORIZON) return null;
            return items;
        }
        // items === null: nothing anywhere down the trace. Fall through to the
        // raw var only as a last resort (covers the brief window between a fresh
        // extraction landing in the var and it being pinned per-swipe).
    }
    const raw = chat_metadata?.variables?.[variableName];
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
}

/**
 * Read + parse the state blob for an arbitrary merge variable (e.g. the
 * Relationship Ledger's `sa_relationship_ledger`), resolved via the same
 * backward trace + staleness horizon as the main panel. Returns the parsed
 * object, or null when there's no usable state. Used to pull relationship data
 * into the display agent's cards.
 * @returns {object|null}
 */
function readStateBlobFor(variableName) {
    try {
        const arr = readResolvedStateArray(variableName);
        if (!Array.isArray(arr) || arr.length === 0) return null;
        const first = arr[0];
        const blob = first.json ?? first[Object.keys(first).find(k => !k.startsWith('_'))];
        if (typeof blob !== 'string') return null;
        const parsed = JSON.parse(blob.trim());
        return (parsed && typeof parsed === 'object') ? parsed : null;
    } catch {
        return null;
    }
}

// ============================================================================
// UPDATE — resolve agent, read state, re-render
// ============================================================================

/**
 * Re-read the current state and re-render. Hidden panels are marked dirty and
 * rebuilt only when shown. Resolves active components each time so enabling,
 * disabling, or swapping agents is picked up without a reload.
 *
 * The "hold vs. blank" decision now lives in the backward trace + staleness
 * horizon (readResolvedStateArray), NOT in a cached-HTML crutch: recent state
 * shows through a transient empty gen or an untracked swipe, distant/absent
 * state reads as honest empty. So update() simply renders whatever the resolver
 * returns for the message being viewed.
 */
export function update() {
    if (!panelEl) return;
    if (!isOpen()) {
        renderDirty = true;
        return;
    }
    renderDirty = false;

    const components = getDisplayComponents();
    if (components.length === 0) {
        renderNotice('No display components enabled.', 'Enable a tracker (State Card, Relationship Ledger, …) from the Library or Agents tab.');
        return;
    }

    // Build a section per component, in display order. A component whose state
    // is empty or unreadable for the viewed message is skipped, so the panel
    // never shows a bare header with nothing under it.
    const sections = [];
    for (const comp of components) {
        let data = readStateBlobFor(comp.variable);
        // Persona-scoped components (Relationship Ledger) store per-persona; show
        // only the active persona's slice, mirroring what DE sees via the API.
        if (comp.agent?.mergeVariable?.personaScoped) data = projectActivePersona(data);
        if (!hasRecognizedStateShape(data)) continue;
        const inner = hasMeaningfulState(data)
            ? buildComponentBody(data, comp.schema, comp.variable)
            : '<div class="sa-sc-empty sa-sc-component-empty">No tracked entries.</div>';
        if (inner) {
            const knowledgeCardKeys = data.facts && typeof data.facts === 'object'
                ? Object.keys(data.facts).map(factId => `${comp.variable}::knowledge::${factId}`)
                : [];
            sections.push({ comp, inner, knowledgeCardKeys });
        }
    }

    if (sections.length === 0) {
        renderNotice('No state data yet.', 'Generate a message to populate.');
        return;
    }

    renderSections(sections);
}

/**
 * Treat a parsed state as "meaningful" if it carries at least one tracked
 * dimension (world events, user stats, characters, or a legacy v2 scene).
 * Empty objects (e.g. a failed `{}` extraction) don't qualify — but note the
 * trace already prefers a nearby prior good snapshot over such an empty, so
 * this mostly guards the genuine start-of-chat / horizon-exceeded empties.
 */
function hasMeaningfulState(data) {
    if (!data || typeof data !== 'object') return false;
    if (Array.isArray(data.worldEvents) && data.worldEvents.length > 0) return true;
    if (data.users && typeof data.users === 'object' && Object.keys(data.users).length > 0) return true;
    if (data.user && typeof data.user === 'object' && Object.keys(data.user).length > 0) return true;
    if (data.characters && typeof data.characters === 'object' && Object.keys(data.characters).length > 0) return true;
    if (data.relationships && typeof data.relationships === 'object' && Object.keys(data.relationships).length > 0) return true;
    if (data.facts && typeof data.facts === 'object' && Object.keys(data.facts).length > 0) return true;
    if (data.scene && typeof data.scene === 'object' && Object.keys(data.scene).length > 0) return true;
    return false;
}

/**
 * Distinguish a valid, deliberately empty tracker result from missing/malformed
 * state. An empty `characters` object is meaningful for Active Roster: it says
 * nobody currently belongs in the bounded working set and should render as an
 * explicit empty section instead of making the component appear broken.
 */
function hasRecognizedStateShape(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
    return ['worldEvents', 'users', 'user', 'characters', 'relationships', 'facts', 'scene']
        .some(key => Object.prototype.hasOwnProperty.call(data, key));
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
 * Project the user-stats card to show ONLY the currently-active persona.
 *
 * A chat may cycle through several player personas ({{user}} is just whoever is
 * selected now). Scene State stores stats per-persona under `users` (keyed by
 * persona name); here we pick the active persona's slice so the panel never
 * shows a pile of retired personas. Falls back to the sole persona when the
 * active one can't be matched, and still understands the legacy single `user`
 * object from before this became persona-aware.
 *
 * @param {object} data    parsed component state
 * @param {object} schema  the component's stateCard.schema
 * @returns {{ label: string, data: object } | null}
 */
function pickActiveUserStats(data, schema = {}) {
    // New persona-keyed shape: users = { personaName: {health,...} }.
    if (data.users && typeof data.users === 'object' && !Array.isArray(data.users)) {
        const keys = Object.keys(data.users).filter(k => data.users[k] && typeof data.users[k] === 'object');
        if (keys.length === 0) return null;
        const active = getActivePersonaName().toLowerCase();
        // Match the active persona; if it isn't tracked yet, only auto-show when
        // there's a single persona (no ambiguity about whose stats these are).
        let key = keys.find(k => k.toLowerCase() === active);
        if (!key && keys.length === 1) key = keys[0];
        if (!key) return null;
        return { label: key, data: data.users[key] };
    }
    // Legacy single-user shape (pre-persona-aware chats).
    if (data.user && typeof data.user === 'object' && Object.keys(data.user).length > 0) {
        return { label: schema.userLabel || 'You', data: data.user };
    }
    return null;
}

/**
 * Build the inner HTML for ONE component's section from its parsed state data +
 * schema. Returns a string of cards (world events, user, character cards, legacy
 * scene) — no DOM writes. `compKey` namespaces per-character collapse state so
 * the same character appearing in two components (e.g. Scene State and
 * Relationships) folds independently.
 * @param {object} data  { worldEvents?:[...], user?:{...}, characters?:{...} }
 * @param {object} schema  the agent's stateCard.schema
 * @param {string} compKey  the component's merge-variable name
 * @returns {string}
 */
function buildComponentBody(data, schema, compKey) {
    schema = schema || {};
    let html = '';

    if (Array.isArray(data.worldEvents) && data.worldEvents.length > 0) {
        html += buildWorldEventsCard(data.worldEvents, schema.worldEvents);
    }

    const activeUser = pickActiveUserStats(data, schema);
    if (activeUser && Object.keys(activeUser.data).length > 0) {
        html += buildCard({
            type: 'user', icon: '♦', label: activeUser.label, data: activeUser.data,
            textFieldDefs: schema.userTextFields || [], meterDefs: schema.userStats || [],
        });
    }

    if (data.characters && typeof data.characters === 'object') {
        for (const [name, charData] of Object.entries(data.characters)) {
            if (!charData || typeof charData !== 'object') continue;
            const color = hashColor(name);
            const initial = name.charAt(0).toUpperCase();
            const avatarHtml = `<div class="sa-sc-avatar" style="background:${color}15;color:${color}">${esc(initial)}</div>`;
            // Namespaced collapse key: "<variable>::<name>" so the same character
            // in different components keeps independent open/closed state.
            const cardKey = `${compKey}::${name}`;
            html += buildCard({
                type: 'character', iconHtml: avatarHtml, label: name, data: charData,
                textFieldDefs: schema.characterTextFields || [], meterDefs: schema.meters || [],
                // Default collapsed; restore the user's last open/closed choice.
                collapsed: !isCharExpanded(cardKey),
                cardName: cardKey,
            });
        }
    }

    if (data.relationships && typeof data.relationships === 'object') {
        for (const [edgeKey, edgeData] of Object.entries(data.relationships)) {
            if (!edgeData || typeof edgeData !== 'object') continue;
            const source = String(edgeData.source || '').trim();
            const target = String(edgeData.target || '').trim();
            const label = source && target ? `${source} → ${target}` : edgeKey;
            const displayData = { ...edgeData };
            delete displayData.source;
            delete displayData.target;
            const cardKey = `${compKey}::relationship::${edgeKey}`;
            html += buildCard({
                type: 'relationship', icon: '↔', label, data: displayData,
                textFieldDefs: schema.relationshipTextFields || [],
                meterDefs: schema.relationshipMeters || [],
                collapsed: !isCharExpanded(cardKey),
                cardName: cardKey,
            });
        }
    }

    if (data.facts && typeof data.facts === 'object') {
        for (const [factId, factData] of Object.entries(data.facts)) {
            if (!factData || typeof factData !== 'object') continue;
            const summary = String(factData.summary || '').trim();
            const displayData = { recordId: factId, ...factData };
            delete displayData.summary;
            displayData.perspectives = Array.isArray(factData.perspectives)
                ? factData.perspectives.map((perspective) => {
                    const character = String(perspective?.character || 'Unknown');
                    const position = String(perspective?.position || 'unrecorded');
                    const confidence = Number.isFinite(perspective?.confidence)
                        ? ` (${perspective.confidence}%)`
                        : '';
                    const access = perspective?.access ? ` via ${perspective.access}` : '';
                    const intent = perspective?.disclosureIntent
                        ? `; intent: ${perspective.disclosureIntent}`
                        : '';
                    return `${character}: ${position}${confidence}${access}${intent}`;
                })
                : [];
            const cardKey = `${compKey}::knowledge::${factId}`;
            html += buildCard({
                type: 'knowledge', icon: '◆', label: summary || factId, data: displayData,
                textFieldDefs: schema.factTextFields || [],
                meterDefs: schema.factMeters || [],
                collapsed: !isCharExpanded(cardKey),
                cardName: cardKey,
                deleteRecordId: factId,
            });
        }
    }

    // Legacy v2 scene card (backwards compat).
    if (data.scene && Object.keys(data.scene).length > 0 && !data.worldEvents && !data.user && !data.users) {
        html += buildCard({
            type: 'scene', icon: '◈', label: 'Scene', data: data.scene,
            textFieldDefs: schema.sceneFields || [], meterDefs: [],
        });
    }

    return html;
}

/**
 * Render all component sections into the panel body and wire collapse handlers.
 * Each section gets a titled, foldable header (the agent's name); a single
 * component still gets its header so the panel reads consistently.
 * @param {Array<{comp:object,inner:string,knowledgeCardKeys:string[]}>} sections
 */
function renderSections(sections) {
    const body = bodyEl();
    if (!body) return;

    body.innerHTML = sections.map(({ comp, inner, knowledgeCardKeys }) => {
        const collapsed = isCompCollapsed(comp.variable);
        const allKnowledgeExpanded = knowledgeCardKeys.length > 0
            && knowledgeCardKeys.every(isCharExpanded);
        const knowledgeToggle = knowledgeCardKeys.length > 0
            ? `<button class="sa-sc-knowledge-toggle" data-action="${allKnowledgeExpanded ? 'collapse' : 'expand'}" title="${allKnowledgeExpanded ? 'Collapse all knowledge records' : 'Expand all knowledge records'}" aria-label="${allKnowledgeExpanded ? 'Collapse all knowledge records' : 'Expand all knowledge records'}"><i class="fa-solid ${allKnowledgeExpanded ? 'fa-angles-up' : 'fa-angles-down'}"></i></button>`
            : '';
        return `<div class="sa-sc-component${collapsed ? ' sa-sc-comp-collapsed' : ''}" data-comp="${esc(comp.variable)}" data-agent-id="${esc(comp.agent?.id || '')}">
            <div class="sa-sc-component-header">
                <span class="sa-sc-component-title">${esc(comp.name)}</span>
                <span class="sa-sc-component-header-right">
                    ${knowledgeToggle}
                    <button class="sa-sc-comp-clear" data-agent-id="${esc(comp.agent?.id || '')}" title="Clear ${esc(comp.name)} state (this chat)" aria-label="Clear state"><i class="fa-solid fa-eraser"></i></button>
                    <span class="sa-sc-component-caret">▾</span>
                </span>
            </div>
            <div class="sa-sc-component-body">${inner}</div>
        </div>`;
    }).join('') || '<div class="sa-sc-empty">State data is empty.</div>';

    // Component header → fold the whole section (persisted per component).
    body.querySelectorAll('.sa-sc-component > .sa-sc-component-header').forEach(header => {
        header.addEventListener('click', () => {
            const comp = header.closest('.sa-sc-component');
            if (!comp) return;
            const nowCollapsed = comp.classList.toggle('sa-sc-comp-collapsed');
            const key = comp.getAttribute('data-comp');
            if (key) persistCompCollapsed(key, nowCollapsed);
        });
    });

    body.querySelectorAll('.sa-sc-knowledge-toggle').forEach(button => {
        button.addEventListener('click', (event) => {
            event.stopPropagation();
            const comp = button.closest('.sa-sc-component');
            if (!comp) return;
            const cards = [...comp.querySelectorAll('.sa-sc-card[data-type="knowledge"]')];
            const expand = cards.some(card => card.classList.contains('sa-sc-collapsed'));
            const keys = cards.map(card => card.getAttribute('data-char-name')).filter(Boolean);
            persistCardsExpanded(keys, expand);
            for (const card of cards) card.classList.toggle('sa-sc-collapsed', !expand);
            button.dataset.action = expand ? 'collapse' : 'expand';
            button.title = expand ? 'Collapse all knowledge records' : 'Expand all knowledge records';
            button.setAttribute('aria-label', button.title);
            const icon = button.querySelector('i');
            if (icon) icon.className = `fa-solid ${expand ? 'fa-angles-up' : 'fa-angles-down'}`;
        });
    });

    // Per-component clear (the hover-only eraser). stopPropagation so it doesn't
    // also fold the section. Confirms first, then wipes this agent's chat state
    // and re-renders — the now-empty component drops out of the panel.
    body.querySelectorAll('.sa-sc-comp-clear').forEach(btn => {
        btn.addEventListener('click', (event) => {
            event.stopPropagation();
            const agent = getAgentById(btn.getAttribute('data-agent-id'));
            if (!agent) return;
            if (!confirm(`Clear "${agent.name}" stored state from THIS chat?\n\nThis wipes its tracked values and every per-message snapshot in the current chat. The agent stays enabled and repopulates on the next generation.`)) return;
            clearAgentChatState(agent);
            update();
        });
    });

    body.querySelectorAll('.sa-sc-card-delete').forEach(button => {
        button.addEventListener('click', (event) => {
            event.stopPropagation();
            const component = button.closest('.sa-sc-component');
            const card = button.closest('.sa-sc-card[data-type="knowledge"]');
            const agent = getAgentById(component?.getAttribute('data-agent-id'));
            const recordId = button.getAttribute('data-record-id') || '';
            const label = card?.querySelector('.sa-sc-card-label')?.textContent?.trim() || recordId;
            if (!agent || !recordId) return;
            if (!confirm(`Delete knowledge record “${label}” from THIS chat?\n\nThis removes it from the live ledger and every stored branch snapshot. A future tracker run may recreate it if the information remains relevant to the story.`)) return;
            const result = removeCollectionRecordFromAgentChatState(agent, 'facts', recordId);
            if (!result.removed) return;
            delete getCharExpandStore()[`${component?.getAttribute('data-comp')}::knowledge::${recordId}`];
            update();
        });
    });

    // Character, relationship, and knowledge cards collapse on their own header
    // click (world events + user are pinned). Namespaced keys survive re-render.
    body.querySelectorAll('.sa-sc-card[data-type="character"] .sa-sc-card-header, .sa-sc-card[data-type="relationship"] .sa-sc-card-header, .sa-sc-card[data-type="knowledge"] .sa-sc-card-header').forEach(header => {
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

function buildCard({
    type, icon, iconHtml, label, data, textFieldDefs, meterDefs,
    collapsed = false, cardName = null, deleteRecordId = null,
}) {
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
            metersHtml += `<div class="${wrapClass}" data-meter-key="${esc(key)}" style="--sa-sc-meter-color:${color}">
                <div class="sa-sc-meter-head">
                    <span class="sa-sc-meter-label"><span class="sa-sc-meter-dot" style="background:${color}"></span>${esc(meterLabel)}</span>
                    <span class="sa-sc-meter-num">${Math.round(value)}</span>
                </div>
                <div class="sa-sc-meter-track"><div class="sa-sc-meter-fill" style="width:${pct}%;background:${color}"></div></div>
            </div>`;
        }
        if (useDual) metersHtml += '</div>';
    }

    // ── Compact meter strip (collapsible cards only — shown when collapsed) ──
    let compactHtml = '';
    const isCollapsible = type === 'character' || type === 'relationship' || type === 'knowledge';
    if (isCollapsible && meterFields.length > 0) {
        const compactMeters = meterFields.map(({ key, value }) => {
            const def = meterDefs.find(m => m.key === key);
            const color = def?.color || '#A0A8B0';
            const max = def?.max || 100;
            const pct = Math.min(100, Math.max(0, (value / max) * 100));
            return `<div class="sa-sc-compact-meter" data-meter-key="${esc(key)}" style="--sa-sc-meter-color:${color}">
                <div class="sa-sc-compact-track"><div class="sa-sc-compact-fill" style="width:${pct}%;background:${color}"></div></div>
            </div>`;
        }).join('');
        compactHtml = `<div class="sa-sc-compact">${compactMeters}</div>`;
    }

    const iconContent = iconHtml ? iconHtml : `<span class="sa-sc-card-icon">${icon || '◈'}</span>`;
    const isPinned = !isCollapsible;
    const collapseIcon = isPinned ? '' : '<span class="sa-sc-collapse-icon">▾</span>';
    const deleteButton = deleteRecordId
        ? `<button class="sa-sc-card-delete" data-record-id="${esc(deleteRecordId)}" title="Delete this knowledge record" aria-label="Delete this knowledge record"><i class="fa-solid fa-trash-can"></i></button>`
        : '';
    const pinnedClass = isPinned ? ' sa-sc-pinned' : '';
    // Character, relationship, and knowledge cards may start collapsed.
    const collapsedClass = (!isPinned && collapsed) ? ' sa-sc-collapsed' : '';
    const nameAttr = cardName ? ` data-char-name="${esc(cardName)}"` : '';

    return `<div class="sa-sc-card${pinnedClass}${collapsedClass}" data-type="${type}"${nameAttr}>
        <div class="sa-sc-card-header">
            ${iconContent}
            <span class="sa-sc-card-label">${esc(label)}</span>
            ${deleteButton}
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
    renderDirty = true;
    if (stateCommitHandler) {
        globalThis.removeEventListener(SUPERAGENTS_EVENTS.STATE_COMMITTED, stateCommitHandler);
        stateCommitHandler = null;
    }
    appearanceUnsubscribe?.();
    appearanceUnsubscribe = null;
    controller?.destroy();
    controller = null;
    panelEl = null;
    currentSchema = null;
}
