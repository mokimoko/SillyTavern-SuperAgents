/**
 * ui/cardTooltip.js — hover tooltips for truncated card text.
 *
 * The management modal clips long agent / group / template descriptions to a
 * single line (`.sam-card-desc` uses text-overflow: ellipsis; likewise
 * `.sam-card-name`). This helper reveals the full text in a floating tooltip
 * on hover — but ONLY when the text is actually truncated, so short entries
 * don't trigger a redundant tooltip.
 *
 * The tooltip element lives on <body> (not inside the modal) so the modal's
 * overflow:hidden never clips it, and a single delegated listener on the modal
 * root survives the per-tab innerHTML re-renders.
 *
 * Styles live in style.css under the .sam-tip prefix.
 */

// Hover the whole name+description block, not just a single 11px text line —
// a much more forgiving target. We then pick whichever line is actually
// truncated (description preferred) and anchor the tooltip to it.
const SELECTOR = '.sam-card-info';
const LINES = ['.sam-card-desc', '.sam-card-name'];
const GAP = 8;          // px between the card line and the tooltip
const EDGE = 8;         // px min gap from the viewport edge

let tipEl = null;
let boundRoot = null;

/** Lazily create the single shared tooltip element. */
function ensureTipEl() {
    if (tipEl) return tipEl;
    tipEl = document.createElement('div');
    tipEl.className = 'sam-tip';
    tipEl.setAttribute('role', 'tooltip');
    document.body.appendChild(tipEl);
    return tipEl;
}

/** True when the element's text is visually clipped by the ellipsis. */
function isTruncated(el) {
    return el.scrollWidth > el.clientWidth + 1;
}

function showTip(target) {
    const text = target.textContent?.trim();
    if (!text) return;

    const tip = ensureTipEl();
    tip.textContent = text;
    tip.classList.add('sam-tip-visible');

    // Measure after content + visibility so offsetWidth/Height are real.
    const rect = target.getBoundingClientRect();
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;

    // Horizontal: centre over the line, clamped to the viewport.
    let left = rect.left + rect.width / 2 - tw / 2;
    left = Math.max(EDGE, Math.min(left, window.innerWidth - tw - EDGE));

    // Vertical: prefer above; flip below if there isn't room up top.
    let top = rect.top - th - GAP;
    if (top < EDGE) top = rect.bottom + GAP;

    tip.style.left = `${Math.round(left)}px`;
    tip.style.top = `${Math.round(top)}px`;
}

function hideTip() {
    if (tipEl) tipEl.classList.remove('sam-tip-visible');
}

/** Within a hovered info block, return the first truncated line, or null. */
function truncatedLine(info) {
    for (const sel of LINES) {
        const el = info.querySelector(sel);
        if (el && isTruncated(el)) return el;
    }
    return null;
}

function onOver(e) {
    const info = e.target.closest(SELECTOR);
    if (!info) return;
    const line = truncatedLine(info);
    if (line) showTip(line);
    else hideTip();
}

function onOut(e) {
    const info = e.target.closest(SELECTOR);
    if (!info) return;
    // Ignore moves that stay within the same info block.
    if (info.contains(e.relatedTarget)) return;
    hideTip();
}

/**
 * Wire hover tooltips onto a modal root. Idempotent — safe to call once when
 * the modal DOM is first built.
 * @param {HTMLElement} root
 */
export function initCardTooltips(root) {
    if (!root || boundRoot === root) return;
    boundRoot = root;

    root.addEventListener('mouseover', onOver);
    root.addEventListener('mouseout', onOut);
    // Hide while the list scrolls so the tooltip never floats detached.
    root.addEventListener('scroll', hideTip, true);
}
