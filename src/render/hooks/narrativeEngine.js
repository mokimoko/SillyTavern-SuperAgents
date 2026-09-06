/**
 * Narrative Engine Renderer
 *
 * Transforms .ne-engine-data containers (built by buildSidecarDisplayData
 * from the Narrative Engine agent's sidecar output) into a styled collapsible
 * panel showing continuity-tracking fields.
 *
 * Registered as a render hook in index.js (SuperAgents). renderer.js calls
 * renderNarrativeEngine on every .ne-engine-data element it injects.
 *
 * Aesthetic: aligned to the SuperAgents family (sharp edges, monospace label,
 * muted rgba palette, 2px accent border, collapsed by default). Accent is a
 * muted pewter-teal — a cooled, desaturated nod to the Engine's original teal
 * so it keeps its identity while sitting in the family's quiet register.
 * Structurally a labeled field tracker: one row per populated continuity field.
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

// Muted pewter-teal — cooled/desaturated nod to the Engine's original teal.
const ACCENT = '120,155,150';
const ACCENT_TEXT = `color-mix(in srgb, rgb(${ACCENT}) 65%, var(--SmartThemeBodyColor, #fff) 35%)`;

// ============================================================================
// MAIN RENDER FUNCTION
// ============================================================================

/**
 * Transform a .ne-engine-data element into the styled Engine display.
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

    // ── Build field rows for every populated field ──
    const rows = [];
    for (const field of FIELDS) {
        const value = data[field.key];
        if (!value || (typeof value === 'string' && !value.trim())) continue;

        const displayVal = typeof value === 'string' ? value : JSON.stringify(value);
        rows.push(
            `<div style="display:flex;gap:10px;align-items:flex-start;padding:6px 0;border-top:1px solid var(--sa-border-faint,rgba(255,255,255,0.05))">`
            + `<span style="font-family:${MONO};color:${ACCENT_TEXT};font-weight:600;font-size:9.5px;width:74px;text-align:right;letter-spacing:0.08em;flex-shrink:0;display:inline-flex;align-items:flex-start;justify-content:flex-end;gap:5px;padding-top:2px">`
            + `<i class="fa-solid ${field.icon}" style="font-size:9px;opacity:0.7;margin-top:1px"></i>${field.label}</span>`
            + `<span style="font-family:${SANS};color:var(--sa-text-body,rgba(255,255,255,0.8));font-size:12px;line-height:1.55;white-space:pre-wrap;word-break:break-word">${escHtml(displayVal)}</span>`
            + `</div>`,
        );
    }

    if (rows.length === 0) return;

    // ── Collapsible <details>, COLLAPSED by default (family convention). ──
    const container = document.createElement('details');
    container.className = 'ne-engine-rendered';
    container.open = false;
    container.style.cssText = 'margin:8px 0;font-size:11px';

    const summary = document.createElement('summary');
    summary.style.cssText = [
        'display:flex',
        'align-items:center',
        'gap:8px',
        'padding:5px 10px',
        'background:var(--sa-surface-input,rgba(255,255,255,0.02))',
        'border:1px solid var(--sa-border-soft,rgba(255,255,255,0.06))',
        `border-left:2px solid rgba(${ACCENT},0.45)`,
        'color:var(--sa-text-secondary,rgba(255,255,255,0.65))',
        `font-family:${MONO}`,
        'font-size:10px',
        'font-weight:500',
        'letter-spacing:0.1em',
        'cursor:pointer',
        'list-style:none',
        'user-select:none',
        'transition:color 0.15s ease,border-color 0.15s ease',
    ].join(';');

    const glyph = document.createElement('span');
    glyph.innerHTML = '&#9881;'; // ⚙ gear — steady, mechanical, fits "engine"
    glyph.style.cssText = `color:${ACCENT_TEXT};font-size:11px`;

    const label = document.createElement('span');
    label.style.cssText = 'text-transform:uppercase;letter-spacing:0.18em;opacity:0.7';
    label.textContent = 'Narrative Engine';

    const count = document.createElement('span');
    count.style.cssText = `margin-left:auto;text-transform:none;letter-spacing:0.02em;color:${ACCENT_TEXT};font-family:${MONO};font-size:9.5px`;
    count.textContent = rows.length + (rows.length === 1 ? ' field' : ' fields');

    summary.appendChild(glyph);
    summary.appendChild(label);
    summary.appendChild(count);

    summary.addEventListener('mouseenter', () => {
        summary.style.color = 'var(--sa-text-primary,rgba(255,255,255,0.85))';
        summary.style.borderLeftColor = `rgba(${ACCENT},0.75)`;
    });
    summary.addEventListener('mouseleave', () => {
        summary.style.color = 'var(--sa-text-secondary,rgba(255,255,255,0.65))';
        summary.style.borderLeftColor = `rgba(${ACCENT},0.45)`;
    });

    const body = document.createElement('div');
    body.style.cssText = [
        'padding:3px 12px 8px',
        'background:var(--sa-surface-info,rgba(0,0,0,0.18))',
        'border:1px solid var(--sa-border-soft,rgba(255,255,255,0.06))',
        'border-top:none',
        `border-left:2px solid rgba(${ACCENT},0.3)`,
    ].join(';');
    // First row's top-border would double the body's edge; strip it.
    body.innerHTML = rows.join('').replace('border-top:1px solid var(--sa-border-faint,rgba(255,255,255,0.05))', 'border-top:none');

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
