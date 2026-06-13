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
 * Shape: { [panelId]: { x:number, y:number, w?:number, h?:number } }. A
 * missing/null entry means "use the panel's default anchor" (which
 * re-evaluates on resize). w/h are optional and only present once the user
 * has resized the panel; absent w/h means "use the panel's CSS size".
 * @returns {Record<string, {x:number, y:number, w?:number, h?:number}>}
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

/** Persist a panel's coords (merging — never clobbers a stored w/h). */
function writePanelPosition(id, x, y) {
    const store = getPanelStore();
    store[id] = { ...(store[id] || {}), x, y };
    saveSettingsDebounced();
}

/** @returns {{w:number, h:number}|null} saved size for a panel, or null. */
function readPanelSize(id) {
    const pos = getPanelStore()[id];
    if (pos && Number.isFinite(pos.w) && Number.isFinite(pos.h)) {
        return { w: pos.w, h: pos.h };
    }
    return null;
}

/** Persist a panel's size (merging — never clobbers a stored x/y). */
function writePanelSize(id, w, h) {
    const store = getPanelStore();
    store[id] = { ...(store[id] || {}), w, h };
    saveSettingsDebounced();
}

/** Clear a panel's saved coords AND size (falls back to default anchor + CSS size). */
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

/**
 * Apply a panel's stored size, if any, as explicit width/height (clamped to
 * the viewport and to the panel's min sizes). No-op when the user has never
 * resized this panel — the CSS-defined size stays in force. Width/height take
 * over the CSS `width`/`max-height` so the panel can grow past its defaults.
 * @param {HTMLElement} el
 * @param {string} id
 * @param {{minW:number, minH:number}} bounds
 */
function applySize(el, id, bounds) {
    const saved = readPanelSize(id);
    if (!saved) return;
    const maxW = Math.max(bounds.minW, window.innerWidth - EDGE_GAP);
    const maxH = Math.max(bounds.minH, window.innerHeight - EDGE_GAP);
    const w = Math.max(bounds.minW, Math.min(saved.w, maxW));
    const h = Math.max(bounds.minH, Math.min(saved.h, maxH));
    el.style.width = w + 'px';
    el.style.height = h + 'px';
    // A stored size overrides the CSS max-height cap so the body can use the
    // full resized height; the flex body keeps its own overflow scroll.
    el.style.maxHeight = 'none';
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
// RESIZE WIRING
// ============================================================================

// Edge/corner handles to inject. Directions follow ST-Copilot's convention:
// n/s/e/w edges + the four corners. West/north handles also move left/top so
// the opposite edge stays anchored while dragging.
const RESIZE_DIRS = ['n', 's', 'e', 'w', 'ne', 'se', 'sw', 'nw'];

/**
 * Inject the resize-handle elements into the panel once. Handles are absolutely
 * positioned slivers along each edge/corner (styled in draggablePanel.css via
 * the .sa-panel-rh classes). Idempotent: skips if already present.
 * @param {HTMLElement} el
 */
function injectResizeHandles(el) {
    if (el.querySelector('.sa-panel-rh')) return;
    for (const dir of RESIZE_DIRS) {
        const h = document.createElement('div');
        h.className = `sa-panel-rh sa-panel-rh-${dir}`;
        h.setAttribute('data-no-drag', '');   // never start a drag from a handle
        el.appendChild(h);
    }
}

/**
 * Wire pointer-based resizing on a panel's injected handles. Ported from the
 * user's ST-Copilot makeResizable: per-handle pointer capture, rAF-batched
 * style flush, min-size clamp, persist on pointer-up. West/north handles
 * adjust left/top so the far edge stays put.
 * @param {HTMLElement} el the panel element (position: fixed)
 * @param {object} cfg resolved config (uses cfg.minW / cfg.minH)
 * @param {(w:number, h:number) => void} persist called on resize-end
 */
function wireResize(el, cfg, persist) {
    const minW = cfg.minW;
    const minH = cfg.minH;

    el.querySelectorAll('.sa-panel-rh').forEach((h) => {
        const dir = [...h.classList]
            .find(c => /^sa-panel-rh-\w/.test(c))?.replace('sa-panel-rh-', '') || '';
        let active = false, sw, sh, sl, st, sx, sy, rafId = null, pending = {};

        const flush = () => {
            if (pending.w !== undefined) el.style.width = `${pending.w}px`;
            if (pending.h !== undefined) { el.style.height = `${pending.h}px`; el.style.maxHeight = 'none'; }
            if (pending.l !== undefined) { el.style.left = `${pending.l}px`; el.style.right = 'auto'; }
            if (pending.t !== undefined) { el.style.top = `${pending.t}px`; el.style.bottom = 'auto'; }
            rafId = null;
        };

        h.addEventListener('pointerdown', (e) => {
            if (e.pointerType === 'mouse' && e.button !== 0) return;
            e.preventDefault();
            e.stopPropagation();
            active = true;
            pending = {};
            const r = el.getBoundingClientRect();
            sx = e.clientX; sy = e.clientY;
            sw = r.width; sh = r.height; sl = r.left; st = r.top;
            try { h.setPointerCapture(e.pointerId); } catch { /* non-fatal */ }
            el.style.transition = 'none';
            el.classList.add('sa-panel--resizing');
        });

        h.addEventListener('pointermove', (e) => {
            if (!active) return;
            const dx = e.clientX - sx;
            const dy = e.clientY - sy;
            // Clamp so a panel can't grow off the far side of the viewport.
            const maxW = Math.max(minW, window.innerWidth - sl - EDGE_GAP);
            const maxH = Math.max(minH, window.innerHeight - st - EDGE_GAP);
            pending = {};
            if (dir.includes('e')) pending.w = Math.min(maxW, Math.max(minW, sw + dx));
            if (dir.includes('s')) pending.h = Math.min(maxH, Math.max(minH, sh + dy));
            if (dir.includes('w')) {
                const nw = Math.max(minW, Math.min(sw - dx, sl + sw - EDGE_GAP));
                pending.w = nw;
                pending.l = sl + (sw - nw);
            }
            if (dir.includes('n')) {
                const nh = Math.max(minH, Math.min(sh - dy, st + sh - EDGE_GAP));
                pending.h = nh;
                pending.t = st + (sh - nh);
            }
            if (!rafId) rafId = requestAnimationFrame(flush);
        });

        const endResize = (e) => {
            if (!active) return;
            active = false;
            if (rafId) { cancelAnimationFrame(rafId); rafId = null; flush(); }
            try { h.releasePointerCapture(e.pointerId); } catch { /* already lost */ }
            el.style.transition = '';
            el.classList.remove('sa-panel--resizing');
            const r = el.getBoundingClientRect();
            persist(Math.round(r.width), Math.round(r.height));
        };

        h.addEventListener('pointerup', endResize);
        h.addEventListener('pointercancel', endResize);
        h.style.touchAction = 'none';
    });
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
 * @param {boolean} [opts.resizable=false] inject edge/corner resize handles + persist size
 * @param {number} [opts.minW=240] minimum width when resizable
 * @param {number} [opts.minH=200] minimum height when resizable
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
        resizable: !!opts.resizable,
        minW: Number.isFinite(opts.minW) ? opts.minW : 240,
        minH: Number.isFinite(opts.minH) ? opts.minH : 200,
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

    // Restore size first (so position clamping sees the real footprint), then
    // position. Wire drag always; wire resize only when asked.
    if (cfg.resizable) {
        el.classList.add('sa-panel-resizable');
        injectResizeHandles(el);
        applySize(el, cfg.id, { minW: cfg.minW, minH: cfg.minH });
        wireResize(el, cfg, (w, h) => writePanelSize(cfg.id, w, h));
    }
    applyPosition(el, cfg.id, cfg.defaultAnchor);
    wireDrag(el, cfg, handle, (x, y) => writePanelPosition(cfg.id, x, y));

    const onResize = () => {
        if (cfg.resizable) applySize(el, cfg.id, { minW: cfg.minW, minH: cfg.minH });
        applyPosition(el, cfg.id, cfg.defaultAnchor);
    };
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
            if (cfg.resizable) applySize(el, cfg.id, { minW: cfg.minW, minH: cfg.minH });
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
            // clearPanelPosition drops both coords and size for this id.
            clearPanelPosition(cfg.id);
            if (cfg.resizable) {
                // Strip inline sizing so the CSS-defined defaults take back over.
                el.style.width = '';
                el.style.height = '';
                el.style.maxHeight = '';
            }
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
