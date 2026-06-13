/**
 * Director Plan Renderer
 *
 * Transforms .director-plan-data containers (built by buildSidecarDisplayData
 * from a Director-style pre-gen agent's stored output) into a styled
 * collapsible block showing the scene plan the director model produced for
 * the turn. The plan is free-form prose/outline text, not structured fields,
 * so this renderer just presents the text in a readable panel.
 *
 * Registered as a render hook in index.js (SuperAgents). renderer.js calls
 * renderDirectorPlan on every .director-plan-data element it injects.
 *
 * The element's textContent is the raw plan string (the "plan" field of the
 * agent's snapshot merge variable).
 */

const MONO = "ui-monospace,'Cascadia Code','Source Code Pro',Menlo,Consolas,monospace";
const SANS = "system-ui,-apple-system,'Segoe UI',sans-serif";

/**
 * Transform a .director-plan-data element into the styled Director display.
 * @param {HTMLElement} el — the data container element
 */
export function renderDirectorPlan(el) {
    const raw = (el.textContent ?? '').trim();
    if (!raw) return;

    // The plan may have arrived as a JSON-wrapped string (envelope batching
    // stores strings verbatim, but a single-field object snapshot may stringify
    // it). Unwrap a bare JSON string if that's what we got.
    let text = raw;
    if (raw.startsWith('"') && raw.endsWith('"')) {
        try { text = JSON.parse(raw); } catch { /* keep raw */ }
    }
    text = String(text).trim();
    if (!text) return;

    // ── Assemble as collapsible <details>, COLLAPSED by default. Sharp edges,
    //    subtle/semi-transparent, no emoji — a quiet marginal annotation that
    //    doesn't compete with the prose. ──
    const container = document.createElement('details');
    container.className = 'director-plan-rendered';
    container.open = false;
    container.style.cssText = 'margin:8px 0;font-size:11px';

    const summary = document.createElement('summary');
    summary.style.cssText = [
        'padding:5px 10px',
        'background:rgba(255,255,255,0.02)',
        'border:1px solid rgba(255,255,255,0.06)',
        'border-left:2px solid rgba(255,255,255,0.18)',
        'color:rgba(255,255,255,0.42)',
        `font-family:${MONO}`,
        'font-size:10px',
        'font-weight:500',
        'text-transform:uppercase',
        'letter-spacing:0.18em',
        'cursor:pointer',
        'list-style:none',
        'user-select:none',
        'transition:color 0.15s ease,border-color 0.15s ease',
    ].join(';');
    summary.textContent = 'Director';

    // Hover: lift the whole thing slightly so it reads as interactive without
    // being loud. Scoped to this element via inline listeners (no global CSS).
    summary.addEventListener('mouseenter', () => {
        summary.style.color = 'rgba(255,255,255,0.7)';
        summary.style.borderLeftColor = 'rgba(255,255,255,0.35)';
    });
    summary.addEventListener('mouseleave', () => {
        summary.style.color = 'rgba(255,255,255,0.42)';
        summary.style.borderLeftColor = 'rgba(255,255,255,0.18)';
    });

    const body = document.createElement('div');
    body.style.cssText = [
        'padding:9px 12px',
        'background:rgba(0,0,0,0.18)',
        'border:1px solid rgba(255,255,255,0.06)',
        'border-top:none',
        'border-left:2px solid rgba(255,255,255,0.12)',
        `font-family:${SANS}`,
        'font-size:12px',
        'line-height:1.6',
        'color:rgba(255,255,255,0.68)',
        'white-space:pre-wrap',
        'word-break:break-word',
    ].join(';');
    body.textContent = text;

    container.appendChild(summary);
    container.appendChild(body);
    el.replaceWith(container);
}
