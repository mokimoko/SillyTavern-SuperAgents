/**
 * Narrative Engine Renderer
 *
 * Transforms .ne-engine-data containers (built by buildSidecarDisplayData
 * from the Narrative Engine agent's sidecar output) into styled collapsible
 * displays showing continuity tracking fields.
 *
 * Registered as a render hook in index.js (SuperAgents). renderer.js calls
 * renderNarrativeEngine on every .ne-engine-data element it injects.
 * Ported verbatim from VM's renderers/narrativeEngine.js.
 */

// ============================================================================
// FIELD DEFINITIONS
// ============================================================================

const FIELDS = [
    { key: 'spatial',   label: 'SPATIAL',   icon: 'fa-location-dot' },
    { key: 'condition', label: 'CONDITION', icon: 'fa-heart-pulse' },
    { key: 'dress',     label: 'DRESS',     icon: 'fa-shirt' },
    { key: 'motifs',    label: 'MOTIFS',    icon: 'fa-key' },
    { key: 'themes',    label: 'THEMES',    icon: 'fa-masks-theater' },
    { key: 'threads',   label: 'THREADS',   icon: 'fa-link' },
];

const MONO = "ui-monospace,'Cascadia Code','Source Code Pro',Menlo,Consolas,monospace";
const SANS = "system-ui,-apple-system,'Segoe UI',sans-serif";

// ============================================================================
// MAIN RENDER FUNCTION
// ============================================================================

/**
 * Transform a .ne-engine-data element into the styled Engine display.
 * Called by the render hook system in renderer.js.
 *
 * The element's textContent contains the raw JSON string from the
 * mergeVariable's "json" field.
 *
 * @param {HTMLElement} el — the data container element
 */
export function renderNarrativeEngine(el) {
    const raw = (el.textContent ?? '').trim();
    if (!raw) return;

    let data;
    try {
        data = JSON.parse(raw);
    } catch {
        return;
    }

    if (!data || typeof data !== 'object') return;

    // ── Build field rows ──
    const rows = [];
    for (const field of FIELDS) {
        const value = data[field.key];
        if (!value || (typeof value === 'string' && !value.trim())) continue;

        const displayVal = typeof value === 'string' ? value : JSON.stringify(value);
        rows.push(
            // Subtle container per entry
            `<div style="display:flex;gap:12px;align-items:flex-start;padding:5px 8px;margin-bottom:3px;background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.04);border-radius:3px">`
            // Label column — monospace, top-aligned, with a small top padding to sit
            // flush with the first line of the value text
            + `<span style="font-family:${MONO};color:#4a5568;font-weight:600;font-size:10px;width:88px;text-align:right;letter-spacing:0.05em;flex-shrink:0;display:inline-flex;align-items:flex-start;justify-content:flex-end;gap:5px;padding-top:2px">`
            + `<i class="fa-solid ${field.icon}" style="font-size:9px;opacity:0.7;margin-top:1px"></i>${field.label}</span>`
            // Value — readable sans-serif
            + `<span style="font-family:${SANS};color:#e2e8f0;font-size:12px;line-height:1.5">${escHtml(displayVal)}</span>`
            + `</div>`,
        );
    }

    if (rows.length === 0) return;

    // ── Assemble as collapsible <details> ──
    const container = document.createElement('details');
    container.className = 'ne-engine-rendered';
    container.style.cssText = 'margin:10px 0';

    const summary = document.createElement('summary');
    summary.style.cssText = [
        'padding:8px 12px',
        'background:rgba(15,17,21,0.85)',
        'border:1px solid rgba(255,255,255,0.05)',
        'border-left:3px solid #38b2ac',
        'border-radius:3px',
        'color:#a0aec0',
        `font-family:${MONO}`,
        'font-size:11px',
        'text-transform:uppercase',
        'letter-spacing:0.1em',
        'cursor:pointer',
        'list-style:none',
        'backdrop-filter:blur(4px)',
        '-webkit-backdrop-filter:blur(4px)',
    ].join(';');
    summary.innerHTML = '<span style="color:#38b2ac;margin-right:6px">&#9198;</span> Narrative Engine';

    const body = document.createElement('div');
    body.style.cssText = [
        'padding:8px',
        'background:rgba(10,12,14,0.7)',
        'border:1px solid rgba(255,255,255,0.03)',
        'border-top:none',
        'border-left:3px solid rgba(56,178,172,0.3)',
        'border-radius:0 0 3px 3px',
    ].join(';');
    body.innerHTML = rows.join('');

    container.appendChild(summary);
    container.appendChild(body);
    el.replaceWith(container);
}

// ============================================================================
// HELPERS
// ============================================================================

function escHtml(str) {
    const div = document.createElement('div');
    div.textContent = str ?? '';
    return div.innerHTML;
}
