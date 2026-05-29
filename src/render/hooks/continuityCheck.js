/**
 * Continuity Check Renderer
 *
 * Transforms .cc-check-data containers (built by buildSidecarDisplayData
 * from the Continuity Check agent's sidecar output) into styled collapsible
 * displays showing detected contradictions and issues.
 *
 * Registered as a render hook in index.js (SuperAgents). renderer.js calls
 * renderContinuityCheck on every .cc-check-data element it injects.
 * Ported verbatim from VM's renderers/continuityCheck.js.
 */

// ============================================================================
// CONSTANTS
// ============================================================================

const MONO = "ui-monospace,'Cascadia Code','Source Code Pro',Menlo,Consolas,monospace";
const SANS = "system-ui,-apple-system,'Segoe UI',sans-serif";

const SEVERITY_STYLES = {
    error:   { color: '#f56565', icon: 'fa-circle-exclamation', label: 'ERROR' },
    warning: { color: '#ed8936', icon: 'fa-triangle-exclamation', label: 'WARN' },
    note:    { color: '#a0aec0', icon: 'fa-circle-info', label: 'NOTE' },
};

const CATEGORY_ICONS = {
    name:        'fa-id-badge',
    location:    'fa-location-dot',
    timeline:    'fa-clock',
    character:   'fa-user-slash',
    item:        'fa-box-open',
    personality: 'fa-masks-theater',
    environment: 'fa-cloud-sun',
};

const VERDICT_STYLES = {
    clean:        { color: '#48bb78', icon: 'fa-circle-check', label: 'Clean — no issues' },
    minor_issues: { color: '#ed8936', icon: 'fa-triangle-exclamation', label: 'Minor issues' },
    major_issues: { color: '#f56565', icon: 'fa-circle-exclamation', label: 'Major issues' },
};

// ============================================================================
// MAIN RENDER FUNCTION
// ============================================================================

/**
 * Transform a .cc-check-data element into the styled Continuity Check display.
 * Called by the render hook system in renderer.js.
 *
 * The element's textContent contains the raw JSON string from the
 * mergeVariable's "json" field.
 *
 * @param {HTMLElement} el — the data container element
 */
export function renderContinuityCheck(el) {
    const raw = (el.textContent ?? '').trim();
    if (!raw) return;

    let data;
    try {
        data = JSON.parse(raw);
    } catch {
        return;
    }

    if (!data || typeof data !== 'object') return;

    const issues = Array.isArray(data.issues) ? data.issues : [];
    const verdict = data.verdict || (issues.length === 0 ? 'clean' : 'minor_issues');
    const verdictStyle = VERDICT_STYLES[verdict] ?? VERDICT_STYLES.clean;

    // ── Build issue rows ──
    const rows = issues.map(issue => {
        const sev = SEVERITY_STYLES[issue.severity] ?? SEVERITY_STYLES.note;
        const catIcon = CATEGORY_ICONS[issue.category] ?? 'fa-question';
        const catLabel = (issue.category ?? 'unknown').toUpperCase();

        return `<div style="display:flex;gap:10px;align-items:flex-start;padding:6px 8px;margin-bottom:3px;background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.04);border-left:2px solid ${sev.color};border-radius:3px">`
            // Severity + category badge
            + `<div style="flex-shrink:0;display:flex;flex-direction:column;align-items:center;gap:2px;min-width:70px">`
            + `<span style="font-family:${MONO};color:${sev.color};font-size:9px;font-weight:700;letter-spacing:0.05em">`
            + `<i class="fa-solid ${sev.icon}" style="font-size:9px;margin-right:3px"></i>${sev.label}</span>`
            + `<span style="font-family:${MONO};color:#4a5568;font-size:9px;letter-spacing:0.03em">`
            + `<i class="fa-solid ${catIcon}" style="font-size:8px;margin-right:2px"></i>${catLabel}</span>`
            + `</div>`
            // Description + suggestion
            + `<div style="flex:1;min-width:0">`
            + `<div style="font-family:${SANS};color:#e2e8f0;font-size:12px;line-height:1.45">${escHtml(issue.description ?? '')}</div>`
            + (issue.suggestion
                ? `<div style="font-family:${SANS};color:#718096;font-size:11px;line-height:1.4;margin-top:3px;font-style:italic">💡 ${escHtml(issue.suggestion)}</div>`
                : '')
            + `</div>`
            + `</div>`;
    });

    // ── Assemble as collapsible <details> ──
    const container = document.createElement('details');
    container.className = 'cc-check-rendered';
    container.style.cssText = 'margin:10px 0';

    // Auto-open if there are issues
    if (verdict !== 'clean') {
        container.open = true;
    }

    const summary = document.createElement('summary');
    summary.style.cssText = [
        'padding:8px 12px',
        'background:rgba(15,17,21,0.85)',
        'border:1px solid rgba(255,255,255,0.05)',
        `border-left:3px solid ${verdictStyle.color}`,
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
    summary.innerHTML = `<span style="color:${verdictStyle.color};margin-right:6px">`
        + `<i class="fa-solid ${verdictStyle.icon}"></i></span> Continuity Check`
        + `<span style="float:right;color:${verdictStyle.color};font-size:10px;font-weight:600">`
        + `${verdictStyle.label}${issues.length > 0 ? ` (${issues.length})` : ''}</span>`;

    const body = document.createElement('div');
    body.style.cssText = [
        'padding:8px',
        'background:rgba(10,12,14,0.7)',
        'border:1px solid rgba(255,255,255,0.03)',
        'border-top:none',
        `border-left:3px solid ${verdictStyle.color}33`,
        'border-radius:0 0 3px 3px',
    ].join(';');

    if (rows.length === 0) {
        body.innerHTML = `<div style="text-align:center;padding:12px;color:#48bb78;font-family:${SANS};font-size:12px">`
            + `<i class="fa-solid fa-circle-check" style="margin-right:5px"></i>No continuity issues detected</div>`;
    } else {
        body.innerHTML = rows.join('');
    }

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
