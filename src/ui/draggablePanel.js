/**
 * ui/draggablePanel.js — shared free-form draggable panel helper.
 *
 * SuperAgents' persistent display surfaces (the State Card and the Phone) are
 * free-floating widgets the user can drag anywhere, rather than screen-edge
 * docked panels. This sidesteps the right-edge collision with White Lotus
 * entirely: nothing is docked, so nothing competes for an edge — the user
 * parks each panel wherever there's room and we remember the spot.
 *
 * The drag/snap/persist model is ported from the user's DynamicAudioRedux
 * miniplayer (a proven pattern in this same ST setup):
 *   - Pointer events (mouse + touch + pen in one API) with setPointerCapture
 *     so a drag keeps tracking even when the pointer leaves the element.
 *   - Interactive controls (buttons, inputs, scrollables, [data-no-drag])
 *     opt out of drag so clicks/scrolls inside the panel still work.
 *   - Viewport clamping so a panel can never be dragged fully off-screen.
 *   - Optional snap to the LEFT/RIGHT edges only (top/bottom skipped to stay
 *     clear of ST's chat input bar and topbar).
 *   - Position persisted per-panel under extension_settings[MODULE_NAME].panels
 *     and re-clamped on window resize.
 *
 * This module owns only the drag/position concern. Each consumer builds its
 * own DOM and calls makeDraggablePanel(el, opts); the helper returns a small
 * controller ({ show, hide, toggle, isOpen, resetPosition, destroy }).
 */

import { saveSettingsDebounced } from '../../../../../../script.js';
import { extension_settings } from '../../../../../extensions.js';
import { MODULE_NAME, debug } from '../../index.js';

const LOG_PREFIX = '[SuperAgents/panel]';

// ---- Layout constants (mirror DynamicAudioRedux miniplayer) ----------
const EDGE_GAP = 20;          // default px gap from viewport edges
const SNAP_THRESHOLD = 24;    // snap if a panel edge is within this many px
const SNAP_GAP = 10;          // px gap from the edge after snapping

// ============================================================================
// POSITION PERSISTENCE
// ============================================================================

/**
 * The panels position bag lives at extension_settings[MODULE_NAME].panels.
 * Shape: { [panelId]: { x:number, y:number } }. A missing/null entry means
 * "use the panel's default anchor" (which re-evaluates on resize).
 * @returns {Record<string, {x:number, y:number}>}
 */
function getPanelStore() {
    const root = extension_settings[MODULE_NAME] ?? (extension_settings[MODULE_NAME] = {});
    if (!root.panels || typeof root.panels !== 'object') root.panels = {};
    return root.panels;
}

/** @returns {{x:number, y:number}|null} saved coords for a panel, or null. */
function readPanelPosition(id) {
    const pos = getPanelStore()[id];
    if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)) return pos;
    return null;
}

/** Persist a panel's coords and schedule a settings save. */
function writePanelPosition(id, x, y) {
    getPanelStore()[id] = { x, y };
    saveSettingsDebounced();
}

/** Clear a panel's saved coords (falls back to the default anchor). */
function clearPanelPosition(id) {
    delete getPanelStore()[id];
    saveSettingsDebounced();
}

// ============================================================================
// GEOMETRY
// ============================================================================

/** Clamp x/y so the panel stays fully within the viewport. */
function clampToViewport(x, y, el) {
    const width = el.offsetWidth || 280;
    const height = el.offsetHeight || 120;
    const maxX = Math.max(0, window.innerWidth - width);
    const maxY = Math.max(0, window.innerHeight - height);
    return {
        x: Math.max(0, Math.min(x, maxX)),
        y: Math.max(0, Math.min(y, maxY)),
    };
}

/**
 * Resolve a default anchor keyword into viewport coordinates. Anchors keep a
 * panel near a corner/edge with EDGE_GAP padding; left/right are honored,
 * vertical is top/center/bottom.
 * @param {string} anchor e.g. 'bottom-right', 'center-right', 'top-right'
 * @param {HTMLElement} el
 * @returns {{x:number, y:number}}
 */
function resolveAnchor(anchor, el) {
    const width = el.offsetWidth || 280;
    const height = el.offsetHeight || 120;
    const right = window.innerWidth - width - EDGE_GAP;
    const left = EDGE_GAP;
    const bottom = window.innerHeight - height - EDGE_GAP;
    const top = EDGE_GAP;
    const middle = Math.max(EDGE_GAP, (window.innerHeight - height) / 2);

    const [vert, horiz] = String(anchor || 'bottom-right').split('-');
    const x = horiz === 'left' ? left : right;
    const y = vert === 'top' ? top : vert === 'center' ? middle : bottom;
    return { x, y };
}

// ============================================================================
// POSITION APPLICATION
// ============================================================================

/**
 * Apply a panel's stored position (or default anchor) as fixed left/top.
 * Always switches the element to left/top positioning (clears right/bottom)
 * so drag math is consistent regardless of the panel's CSS defaults.
 * @param {HTMLElement} el
 * @param {string} id
 * @param {string} anchor default-anchor keyword
 */
function applyPosition(el, id, anchor) {
    const saved = readPanelPosition(id);
    const base = saved ?? resolveAnchor(anchor, el);
    const clamped = clampToViewport(base.x, base.y, el);
    el.style.left = clamped.x + 'px';
    el.style.top = clamped.y + 'px';
    el.style.right = 'auto';
    el.style.bottom = 'auto';
}

// ============================================================================
// DRAG WIRING
// ============================================================================

/**
 * Wire pointer-based dragging on a panel.
 * @param {HTMLElement} el the panel element (positioned fixed)
 * @param {object} cfg resolved config
 * @param {HTMLElement} handle the element that initiates drags
 * @param {() => void} persist callback to save position on drag-end
 */
function wireDrag(el, cfg, handle, persist) {
    let dragState = null;

    handle.addEventListener('pointerdown', (e) => {
        // Interactive controls opt out so clicks/scrolls still work.
        if (e.target.closest('button, input, textarea, select, a, [data-no-drag]')) return;
        if (cfg.ignoreSelector && e.target.closest(cfg.ignoreSelector)) return;
        // Mouse: left button only. Touch/pen: always allow.
        if (e.pointerType === 'mouse' && e.button !== 0) return;

        const rect = el.getBoundingClientRect();
        dragState = {
            offsetX: e.clientX - rect.left,
            offsetY: e.clientY - rect.top,
            pointerId: e.pointerId,
            moved: false,
        };
        try {
            handle.setPointerCapture(e.pointerId);
        } catch (err) {
            // Some devices throw on setPointerCapture; non-fatal.
            debug(`${LOG_PREFIX} setPointerCapture failed: ${err.message}`);
        }
        el.style.transition = 'none';
        el.classList.add('sa-panel--dragging');
        e.preventDefault();
    });

    handle.addEventListener('pointermove', (e) => {
        if (!dragState || e.pointerId !== dragState.pointerId) return;
        const clamped = clampToViewport(
            e.clientX - dragState.offsetX,
            e.clientY - dragState.offsetY,
            el,
        );
        el.style.left = clamped.x + 'px';
        el.style.top = clamped.y + 'px';
        el.style.right = 'auto';
        el.style.bottom = 'auto';
        dragState.moved = true;
        cfg.onMove?.(clamped);
    });

    const endDrag = (e) => {
        if (!dragState || e.pointerId !== dragState.pointerId) return;
        try {
            handle.releasePointerCapture(e.pointerId);
        } catch { /* capture may already be lost */ }

        el.style.transition = '';
        el.classList.remove('sa-panel--dragging');

        if (dragState.moved) {
            const rect = el.getBoundingClientRect();
            let finalX = rect.left;
            const finalY = rect.top;

            // Snap to LEFT/RIGHT edges only (skip top/bottom — chat input + topbar).
            if (cfg.snapToEdges) {
                if (rect.left <= SNAP_THRESHOLD) {
                    finalX = SNAP_GAP;
                } else if ((window.innerWidth - rect.right) <= SNAP_THRESHOLD) {
                    finalX = window.innerWidth - rect.width - SNAP_GAP;
                }
            }

            const clamped = clampToViewport(finalX, finalY, el);
            el.style.left = clamped.x + 'px';
            el.style.top = clamped.y + 'px';
            persist(clamped.x, clamped.y);
            cfg.onEnd?.(clamped);
        }
        dragState = null;
    };

    handle.addEventListener('pointerup', endDrag);
    handle.addEventListener('pointercancel', endDrag);
}

// ============================================================================
// PUBLIC FACTORY
// ============================================================================

/**
 * Make an existing element a draggable, position-persistent floating panel.
 *
 * The element should already be in the DOM and styled `position: fixed`. The
 * helper takes over its left/top, wires dragging on the handle, restores the
 * saved position (or default anchor), and keeps it on-screen across resizes.
 *
 * @param {HTMLElement} el the panel element
 * @param {object} [opts]
 * @param {string} [opts.id] unique key for position persistence (defaults to el.id)
 * @param {string|HTMLElement} [opts.handle] drag-handle selector (within el) or
 *        element; defaults to the whole panel (minus interactive controls)
 * @param {string} [opts.ignoreSelector] extra selector whose descendants opt out of drag
 * @param {boolean} [opts.snapToEdges=true] snap to left/right edges on drag-end
 * @param {string} [opts.defaultAnchor='bottom-right'] default-position keyword
 * @param {function({x:number,y:number}):void} [opts.onMove] called during drag
 * @param {function({x:number,y:number}):void} [opts.onEnd] called on drag-end
 * @returns {{
 *   element: HTMLElement,
 *   show: () => void,
 *   hide: () => void,
 *   toggle: () => boolean,
 *   isOpen: () => boolean,
 *   resetPosition: () => void,
 *   reposition: () => void,
 *   destroy: () => void,
 * }}
 */
export function makeDraggablePanel(el, opts = {}) {
    const cfg = {
        id: opts.id || el.id,
        ignoreSelector: opts.ignoreSelector || null,
        snapToEdges: opts.snapToEdges !== false,
        defaultAnchor: opts.defaultAnchor || 'bottom-right',
        onMove: opts.onMove || null,
        onEnd: opts.onEnd || null,
    };

    if (!cfg.id) {
        console.warn(`${LOG_PREFIX} makeDraggablePanel called without an id; position won't persist.`);
        cfg.id = `anon_${Math.random().toString(36).slice(2, 8)}`;
    }

    const handle = typeof opts.handle === 'string'
        ? (el.querySelector(opts.handle) || el)
        : (opts.handle instanceof HTMLElement ? opts.handle : el);

    // Restore position, wire drag, keep on-screen on resize.
    applyPosition(el, cfg.id, cfg.defaultAnchor);
    wireDrag(el, cfg, handle, (x, y) => writePanelPosition(cfg.id, x, y));

    const onResize = () => applyPosition(el, cfg.id, cfg.defaultAnchor);
    window.addEventListener('resize', onResize);

    return {
        element: el,
        show() {
            // Make visible FIRST (so offsetWidth/Height are real), then position.
            // If we positioned before .sa-panel-open is applied, the CSS rule
            // `.sa-sc-panel { display: none }` keeps offsetWidth at 0 and
            // clampToViewport falls back to the 280px estimate. That can shift
            // a panel saved near the right/bottom edge by ~10px on every load.
            el.style.display = '';
            el.classList.add('sa-panel-open');
            applyPosition(el, cfg.id, cfg.defaultAnchor);
        },
        hide() {
            el.classList.remove('sa-panel-open');
            el.style.display = 'none';
        },
        toggle() {
            const open = el.style.display === 'none' || !el.classList.contains('sa-panel-open');
            if (open) this.show(); else this.hide();
            return open;
        },
        isOpen() {
            return el.style.display !== 'none' && el.classList.contains('sa-panel-open');
        },
        resetPosition() {
            clearPanelPosition(cfg.id);
            applyPosition(el, cfg.id, cfg.defaultAnchor);
        },
        reposition() {
            applyPosition(el, cfg.id, cfg.defaultAnchor);
        },
        destroy() {
            window.removeEventListener('resize', onResize);
            el.remove();
        },
    };
}

/** Standalone helper: clear a panel's saved position by id. */
export function resetPanelPosition(id) {
    clearPanelPosition(id);
}
