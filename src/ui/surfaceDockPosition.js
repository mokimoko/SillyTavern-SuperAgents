/** Persistent free-form positioning for the Story Apps launcher row. */

import { saveSettingsDebounced } from '../../../../../../script.js';
import { extension_settings } from '../../../../../extensions.js';
import { MODULE_NAME } from '../core/runtime.js';

const POSITION_KEY = 'storyAppsPosition';
const MOVE_THRESHOLD = 4;
const HANDLE_CLEARANCE = 20;

let dockEl = null;
let cleanup = null;
let dragging = false;

function getRoot() {
    return extension_settings[MODULE_NAME] ?? (extension_settings[MODULE_NAME] = {});
}

function readPosition() {
    const value = getRoot()[POSITION_KEY];
    if (!value || !Number.isFinite(value.x) || !Number.isFinite(value.y)) return null;
    return { x: value.x, y: value.y };
}

function writePosition(x, y) {
    getRoot()[POSITION_KEY] = { x: Math.round(x), y: Math.round(y) };
    saveSettingsDebounced();
}

export function clampSurfaceDockPosition(x, y, width, height, viewportWidth, viewportHeight, horizontalClearance = 0) {
    const clearance = Math.max(0, Number(horizontalClearance) || 0);
    return {
        x: Math.max(clearance, Math.min(Number(x) || 0, Math.max(clearance, viewportWidth - width - clearance))),
        y: Math.max(0, Math.min(Number(y) || 0, Math.max(0, viewportHeight - height))),
    };
}

function clampToViewport(x, y, element) {
    const rect = element.getBoundingClientRect();
    return clampSurfaceDockPosition(
        x,
        y,
        rect.width || element.offsetWidth || 40,
        rect.height || element.offsetHeight || 40,
        window.innerWidth,
        window.innerHeight,
        HANDLE_CLEARANCE,
    );
}

function applyPosition() {
    if (!dockEl || dragging) return;
    const saved = readPosition();
    if (!saved) {
        dockEl.style.left = '';
        dockEl.style.top = '';
        dockEl.style.right = '';
        dockEl.style.bottom = '';
        return;
    }

    const clamped = clampToViewport(saved.x, saved.y, dockEl);
    dockEl.style.left = `${clamped.x}px`;
    dockEl.style.top = `${clamped.y}px`;
    dockEl.style.right = 'auto';
    dockEl.style.bottom = 'auto';
}

export function attachMovableSurfaceDock(element) {
    if (!element) return;
    if (dockEl === element && cleanup) {
        applyPosition();
        return;
    }
    cleanup?.();
    dockEl = element;
    const handles = [...element.querySelectorAll('.sa-surface-dock-grip')];
    if (handles.length === 0) return;

    let dragState = null;
    let suppressClick = false;
    let suppressTimer = null;

    const onPointerDown = (event) => {
        if (event.pointerType === 'mouse' && event.button !== 0) return;
        const rect = element.getBoundingClientRect();
        dragState = {
            pointerId: event.pointerId,
            handle: event.currentTarget,
            startX: event.clientX,
            startY: event.clientY,
            offsetX: event.clientX - rect.left,
            offsetY: event.clientY - rect.top,
            moved: false,
        };
        try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* optional browser support */ }
    };

    const onPointerMove = (event) => {
        if (!dragState || event.pointerId !== dragState.pointerId) return;
        if (!dragState.moved) {
            const distance = Math.hypot(
                event.clientX - dragState.startX,
                event.clientY - dragState.startY,
            );
            if (distance < MOVE_THRESHOLD) return;
            dragState.moved = true;
            dragging = true;
            element.classList.add('sa-surface-dock--dragging');
        }

        const position = clampToViewport(
            event.clientX - dragState.offsetX,
            event.clientY - dragState.offsetY,
            element,
        );
        element.style.left = `${position.x}px`;
        element.style.top = `${position.y}px`;
        element.style.right = 'auto';
        element.style.bottom = 'auto';
        event.preventDefault();
    };

    const finishDrag = (event, cancelled = false) => {
        if (!dragState || event.pointerId !== dragState.pointerId) return;
        try { dragState.handle.releasePointerCapture(event.pointerId); } catch { /* capture may already be gone */ }

        const moved = dragState.moved;
        dragState = null;
        dragging = false;
        element.classList.remove('sa-surface-dock--dragging');

        if (moved && !cancelled) {
            const rect = element.getBoundingClientRect();
            const position = clampToViewport(rect.left, rect.top, element);
            writePosition(position.x, position.y);
            suppressClick = true;
            clearTimeout(suppressTimer);
            suppressTimer = setTimeout(() => { suppressClick = false; }, 0);
        } else if (moved) {
            // A cancelled touch/pen gesture should not leave an unsaved visual
            // position behind.
            applyPosition();
        }
    };

    const onPointerUp = event => finishDrag(event);
    const onPointerCancel = event => finishDrag(event, true);
    const onClick = (event) => {
        if (suppressClick) {
            suppressClick = false;
            event.stopImmediatePropagation();
        }
        event.preventDefault();
    };
    const onResize = () => applyPosition();

    for (const handle of handles) {
        handle.addEventListener('pointerdown', onPointerDown);
        handle.addEventListener('pointermove', onPointerMove);
        handle.addEventListener('pointerup', onPointerUp);
        handle.addEventListener('pointercancel', onPointerCancel);
        handle.addEventListener('click', onClick);
        handle.addEventListener('dblclick', resetSurfaceDockPosition);
    }
    window.addEventListener('resize', onResize);

    cleanup = () => {
        clearTimeout(suppressTimer);
        for (const handle of handles) {
            handle.removeEventListener('pointerdown', onPointerDown);
            handle.removeEventListener('pointermove', onPointerMove);
            handle.removeEventListener('pointerup', onPointerUp);
            handle.removeEventListener('pointercancel', onPointerCancel);
            handle.removeEventListener('click', onClick);
            handle.removeEventListener('dblclick', resetSurfaceDockPosition);
        }
        window.removeEventListener('resize', onResize);
        element.classList.remove('sa-surface-dock--dragging');
        if (dockEl === element) dockEl = null;
        cleanup = null;
        dragging = false;
    };

    applyPosition();
}

export function repositionSurfaceDock() {
    applyPosition();
}

export function resetSurfaceDockPosition() {
    delete getRoot()[POSITION_KEY];
    saveSettingsDebounced();
    applyPosition();
}
