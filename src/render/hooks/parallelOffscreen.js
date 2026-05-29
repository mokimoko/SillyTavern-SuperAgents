/**
 * Parallel Off-Screen Renderer
 *
 * Transforms .parallel-hud-data containers (injected by regexProcessor from
 * the Parallel Off-Screen agent template) into styled displays showing
 * off-screen developments with color-coded relevance tags.
 *
 * Design: subtle, collapsible. Complements the World State HUD's stage-
 * direction aesthetic — this is background intel, not a dashboard widget.
 *
 * Registered as a render hook in index.js (SuperAgents). renderer.js calls
 * renderParallelOffscreen on every .parallel-hud-data element it injects.
 * Ported verbatim from VM's renderers/parallelOffscreen.js.
 */

// ============================================================================
// RELEVANCE → ICON + COLOR
// ============================================================================

const RELEVANCE_MAP = {
    'rising tension':   { icon: 'fa-arrow-trend-up',   color: '#C4956A', label: 'Rising Tension' },
    'opportunity':      { icon: 'fa-door-open',         color: '#6AAF8B', label: 'Opportunity' },
    'complication':     { icon: 'fa-triangle-exclamation', color: '#C89050', label: 'Complication' },
    'threat':           { icon: 'fa-skull',             color: '#C06060', label: 'Threat' },
    'alliance forming': { icon: 'fa-handshake',         color: '#6A9DC0', label: 'Alliance Forming' },
    'quiet shift':      { icon: 'fa-feather',           color: '#8890A0', label: 'Quiet Shift' },
    'countdown':        { icon: 'fa-hourglass-half',    color: '#C0A050', label: 'Countdown' },
    'imminent':         { icon: 'fa-bolt',              color: '#D06060', label: 'Imminent' },
};

const DEFAULT_RELEVANCE = { icon: 'fa-circle-info', color: '#8890A0', label: 'Update' };

function getRelevanceData(relevance) {
    const key = (relevance ?? '').trim().toLowerCase();
    return RELEVANCE_MAP[key] || DEFAULT_RELEVANCE;
}

// ============================================================================
// BULLET PARSING
// ============================================================================

/**
 * Parse the raw content block into individual bullet entries.
 * Expected format: "- Subject: development\n- Subject: development"
 * Returns array of { subject, detail } objects.
 */
function parseBullets(rawContent) {
    const lines = (rawContent ?? '')
        .split('\n')
        .map(l => l.trim())
        .filter(l => l.startsWith('-'));

    return lines.map(line => {
        // Strip the leading "- "
        const text = line.replace(/^-\s*/, '');

        // Split on first colon
        const colonIdx = text.indexOf(':');
        if (colonIdx > 0 && colonIdx < 60) {
            return {
                subject: text.substring(0, colonIdx).trim(),
                detail: text.substring(colonIdx + 1).trim(),
            };
        }

        // No colon — treat whole line as detail
        return { subject: '', detail: text };
    }).filter(b => b.detail);
}

// ============================================================================
// MAIN RENDER FUNCTION
// ============================================================================

/**
 * Transform a .parallel-hud-data element into the styled Parallel display.
 * Called by the render hook system in renderer.js.
 *
 * @param {HTMLElement} el — the data container element
 */
export function renderParallelOffscreen(el) {
    const scope     = el.dataset.scope ?? '';
    const relevance = el.dataset.relevance ?? '';
    const rawContent = el.textContent ?? '';

    if (!rawContent.trim()) return;

    const { icon, color, label } = getRelevanceData(relevance);
    const bullets = parseBullets(rawContent);

    if (bullets.length === 0) return;

    // ── Header line ──
    // Scope + relevance badge, collapsible
    const headerHtml = `<div style="display:flex;align-items:center;gap:8px;cursor:pointer;user-select:none">`
        + `<i class="fa-solid fa-globe" style="font-size:9px;color:rgba(200,205,215,0.3)"></i>`
        + `<span style="font-size:10.5px;color:rgba(200,205,215,0.4);font-style:italic;letter-spacing:0.02em">`
            + `${escHtml(scope)}`
        + `</span>`
        + `<span style="display:inline-flex;align-items:center;gap:4px;font-size:9px;padding:1px 6px;border-radius:3px;`
            + `background:${hexToRgba(color, 0.1)};color:${color};border:0.5px solid ${hexToRgba(color, 0.2)};opacity:0.7">`
            + `<i class="fa-solid ${icon}" style="font-size:8px"></i>`
            + `${escHtml(label)}`
        + `</span>`
        + `</div>`;

    // ── Bullet items ──
    const bulletsHtml = bullets.map(b => {
        const subjectSpan = b.subject
            ? `<span style="color:rgba(200,205,215,0.5);font-weight:500">${escHtml(b.subject)}:</span> `
            : '';
        return `<div style="display:flex;align-items:baseline;gap:6px;padding:1px 0;font-size:10.5px;color:rgba(200,205,215,0.35);line-height:1.55">`
            + `<span style="color:${hexToRgba(color, 0.3)};font-size:7px;flex-shrink:0;margin-top:3px">●</span>`
            + `<span>${subjectSpan}${escHtml(b.detail)}</span>`
            + `</div>`;
    }).join('');

    // ── Assemble ──
    // Use a <details> for collapsibility, default open
    const container = document.createElement('details');
    container.className = 'parallel-hud-rendered';
    container.setAttribute('open', '');
    container.style.cssText = 'margin:8px 0 10px;padding:0;font-family:system-ui,-apple-system,sans-serif';

    const summary = document.createElement('summary');
    summary.style.cssText = 'list-style:none;outline:none';
    // Hide default marker
    summary.innerHTML = headerHtml;

    const body = document.createElement('div');
    body.style.cssText = 'padding:4px 0 0 17px';
    body.innerHTML = bulletsHtml;

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

function hexToRgba(hex, alpha) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${alpha})`;
}
