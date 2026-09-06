/**
 * Soundtrack Suggester Renderer
 *
 * Transforms .soundtrack-suggester-data containers (built by
 * buildSidecarDisplayData from the Soundtrack Suggester post-gen agent's
 * stored output) into a styled collapsible block showing the track that
 * scores the scene.
 *
 * The data container carries:
 *   - data-track   attribute → "Artist — Song Title"
 *   - data-vibe    attribute → "genre, instrumentation, tempo"
 *   - textContent            → the "why it fits" line
 *
 * Registered as a render hook in index.js. renderer.js calls
 * renderSoundtrackSuggester on every .soundtrack-suggester-data element it
 * injects. Visual style deliberately mirrors directorPlan.js (quiet, sharp-
 * edged, monospace label) so the built-in agents feel like one family.
 */

const MONO = "ui-monospace,'Cascadia Code','Source Code Pro',Menlo,Consolas,monospace";
const SANS = "system-ui,-apple-system,'Segoe UI',sans-serif";
const ACCENT_TEXT = 'color-mix(in srgb, rgb(160,140,220) 65%, var(--SmartThemeBodyColor, #fff) 35%)';

/**
 * Transform a .soundtrack-suggester-data element into the styled display.
 * @param {HTMLElement} el — the data container element
 */
export function renderSoundtrackSuggester(el) {
    const track = (el.getAttribute('data-track') ?? '').trim();
    const vibe = (el.getAttribute('data-vibe') ?? '').trim();
    let why = (el.textContent ?? '').trim();

    // Unwrap a bare JSON string if the "why" arrived quoted (envelope batching
    // can stringify a single-field value).
    if (why.startsWith('"') && why.endsWith('"')) {
        try { why = JSON.parse(why); } catch { /* keep raw */ }
    }
    why = String(why).trim();

    // Nothing to show if the model produced no track at all.
    if (!track && !why) return;

    // ── Collapsible <details>, COLLAPSED by default. Summary shows a music
    //    glyph + the track name so it's useful even folded. ──
    const container = document.createElement('details');
    container.className = 'soundtrack-suggester-rendered';
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
        'border-left:2px solid rgba(160,140,220,0.45)',
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
    glyph.textContent = '\u266A'; // ♪
    glyph.style.cssText = `color:${ACCENT_TEXT};font-size:12px`;

    const label = document.createElement('span');
    label.style.cssText = 'text-transform:uppercase;letter-spacing:0.18em;opacity:0.7';
    label.textContent = 'Soundtrack';

    const trackInline = document.createElement('span');
    trackInline.style.cssText = 'margin-left:auto;text-transform:none;letter-spacing:0.02em;color:var(--sa-text-secondary,rgba(255,255,255,0.65));font-family:' + SANS + ';font-size:11px;font-style:italic;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
    trackInline.textContent = track;

    summary.appendChild(glyph);
    summary.appendChild(label);
    if (track) summary.appendChild(trackInline);

    summary.addEventListener('mouseenter', () => {
        summary.style.color = 'var(--sa-text-primary,rgba(255,255,255,0.85))';
        summary.style.borderLeftColor = 'rgba(160,140,220,0.75)';
    });
    summary.addEventListener('mouseleave', () => {
        summary.style.color = 'var(--sa-text-secondary,rgba(255,255,255,0.65))';
        summary.style.borderLeftColor = 'rgba(160,140,220,0.45)';
    });

    const body = document.createElement('div');
    body.style.cssText = [
        'padding:9px 12px',
        'background:var(--sa-surface-info,rgba(0,0,0,0.18))',
        'border:1px solid var(--sa-border-soft,rgba(255,255,255,0.06))',
        'border-top:none',
        'border-left:2px solid rgba(160,140,220,0.3)',
        `font-family:${SANS}`,
        'font-size:12px',
        'line-height:1.6',
        'color:var(--sa-text-body,rgba(255,255,255,0.8))',
    ].join(';');

    if (track) {
        const trackRow = document.createElement('div');
        trackRow.style.cssText = 'color:var(--sa-text-primary,rgba(255,255,255,0.85));font-weight:600;margin-bottom:2px';
        trackRow.textContent = track;
        body.appendChild(trackRow);
    }

    if (vibe) {
        const vibeRow = document.createElement('div');
        vibeRow.style.cssText = `font-family:${MONO};font-size:10px;letter-spacing:0.04em;color:${ACCENT_TEXT};margin-bottom:7px`;
        vibeRow.textContent = vibe;
        body.appendChild(vibeRow);
    }

    if (why) {
        const whyRow = document.createElement('div');
        whyRow.style.cssText = 'color:var(--sa-text-secondary,rgba(255,255,255,0.65));font-style:italic;white-space:pre-wrap;word-break:break-word';
        whyRow.textContent = why;
        body.appendChild(whyRow);
    }

    // ── "Search on YouTube" link. Builds a YouTube search URL from the track
    //    string (normalize the em-dash separator to a space, then URL-encode).
    //    Opens in a new tab; the top result is almost always the song. ──
    if (track) {
        const query = track.replace(/\s*[\u2014\u2013-]\s*/g, ' ').trim();
        const ytUrl = 'https://www.youtube.com/results?search_query=' + encodeURIComponent(query);

        const ytLink = document.createElement('a');
        ytLink.href = ytUrl;
        ytLink.target = '_blank';
        ytLink.rel = 'noopener noreferrer';
        ytLink.textContent = '\u25B6 Search on YouTube';
        ytLink.style.cssText = [
            'display:inline-block',
            'margin-top:9px',
            'padding:4px 10px',
            'background:rgba(160,140,220,0.12)',
            'border:1px solid rgba(160,140,220,0.35)',
            `color:${ACCENT_TEXT}`,
            `font-family:${MONO}`,
            'font-size:10px',
            'letter-spacing:0.06em',
            'text-decoration:none',
            'cursor:pointer',
            'transition:background 0.15s ease,border-color 0.15s ease',
        ].join(';');
        ytLink.addEventListener('mouseenter', () => {
            ytLink.style.background = 'rgba(160,140,220,0.22)';
            ytLink.style.borderColor = 'rgba(160,140,220,0.6)';
        });
        ytLink.addEventListener('mouseleave', () => {
            ytLink.style.background = 'rgba(160,140,220,0.12)';
            ytLink.style.borderColor = 'rgba(160,140,220,0.35)';
        });
        body.appendChild(ytLink);
    }

    container.appendChild(summary);
    container.appendChild(body);
    el.replaceWith(container);
}
