/**
 * Actor Interview Renderer
 *
 * Transforms .actor-interview-data containers (built by
 * buildSidecarDisplayData from the Actor Interview post-gen agent's stored
 * output) into a styled "Behind the Scenes" panel: the cast of the scene
 * steps out of character and gives candid reactions.
 *
 * The data container carries:
 *   - data-scene attribute → short scene descriptor (collapsed summary)
 *   - data-mood  attribute → the mood on set (small caption)
 *   - textContent          → one actor per line, "Name :: reaction"
 *
 * Multi-item like Parallel Off-Screen: multiplicity lives inside a single
 * block's textContent, parsed here into per-actor rows. Registered as a
 * render hook in index.js; renderer.js calls renderActorInterview on every
 * .actor-interview-data element it injects.
 *
 * Aesthetic: refined, part of the SuperAgents family (sharp edges, monospace
 * label, muted palette) but with a touch of personality for the "cast steps
 * out" moment — a thin-ruled monogram per actor, hairline dividers, a muted
 * clay/rose accent to differentiate from Soundtrack (purple) and Art (amber).
 */

const MONO = "ui-monospace,'Cascadia Code','Source Code Pro',Menlo,Consolas,monospace";
const SANS = "system-ui,-apple-system,'Segoe UI',sans-serif";

// Muted clay/rose accent — distinct from soundtrack purple + art amber.
const ACCENT = '190,120,110';
const ACCENT_TEXT = `color-mix(in srgb, rgb(${ACCENT}) 65%, var(--SmartThemeBodyColor, #fff) 35%)`;

/**
 * Parse the raw body into per-actor entries.
 * Expected: "Name :: reaction" per line. Falls back gracefully if a line
 * has no "::" separator (whole line treated as reaction, no name).
 * @returns {Array<{name: string, reaction: string}>}
 */
function parseCast(raw) {
    return (raw ?? '')
        .split('\n')
        .map(l => l.trim())
        .filter(Boolean)
        .map(line => {
            const idx = line.indexOf('::');
            if (idx > -1) {
                return {
                    name: line.slice(0, idx).trim(),
                    reaction: line.slice(idx + 2).trim(),
                };
            }
            return { name: '', reaction: line };
        })
        .filter(a => a.reaction);
}

/** First letter of a name, for the monogram. Falls back to a clapper glyph. */
function monogram(name) {
    const c = (name ?? '').trim().charAt(0).toUpperCase();
    return c || '\u25CF';
}

/**
 * Transform a .actor-interview-data element into the styled BTS panel.
 * @param {HTMLElement} el — the data container element
 */
export function renderActorInterview(el) {
    const scene = (el.getAttribute('data-scene') ?? '').trim();
    const mood = (el.getAttribute('data-mood') ?? '').trim();
    let raw = (el.textContent ?? '').trim();

    // Unwrap a bare JSON string if the body arrived quoted (envelope batching
    // can stringify a single-field value).
    if (raw.startsWith('"') && raw.endsWith('"')) {
        try { raw = JSON.parse(raw); } catch { /* keep raw */ }
    }

    const cast = parseCast(String(raw).trim());
    if (cast.length === 0) return;

    // ── Collapsible <details>, COLLAPSED by default. ──
    const container = document.createElement('details');
    container.className = 'actor-interview-rendered';
    container.open = false;
    container.style.cssText = 'margin:8px 0;font-size:11px';

    // ── Summary: clapperboard glyph + label, scene descriptor on the right. ──
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
    glyph.textContent = '\uD83C\uDFAC'; // 🎬
    glyph.style.cssText = 'font-size:12px;filter:saturate(0.7)';

    const label = document.createElement('span');
    label.style.cssText = 'text-transform:uppercase;letter-spacing:0.18em;opacity:0.7';
    label.textContent = 'Behind the Scenes';

    const sceneInline = document.createElement('span');
    sceneInline.style.cssText = 'margin-left:auto;text-transform:none;letter-spacing:0.02em;color:var(--sa-text-secondary,rgba(255,255,255,0.65));font-family:' + SANS + ';font-size:11px;font-style:italic;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
    sceneInline.textContent = scene;

    summary.appendChild(glyph);
    summary.appendChild(label);
    if (scene) summary.appendChild(sceneInline);

    summary.addEventListener('mouseenter', () => {
        summary.style.color = 'var(--sa-text-primary,rgba(255,255,255,0.85))';
        summary.style.borderLeftColor = `rgba(${ACCENT},0.75)`;
    });
    summary.addEventListener('mouseleave', () => {
        summary.style.color = 'var(--sa-text-secondary,rgba(255,255,255,0.65))';
        summary.style.borderLeftColor = `rgba(${ACCENT},0.45)`;
    });

    // ── Body: panel wrapper, optional mood caption, then per-actor rows. ──
    const body = document.createElement('div');
    body.style.cssText = [
        'padding:9px 12px 10px',
        'background:var(--sa-surface-info,rgba(0,0,0,0.18))',
        'border:1px solid var(--sa-border-soft,rgba(255,255,255,0.06))',
        'border-top:none',
        `border-left:2px solid rgba(${ACCENT},0.3)`,
        `font-family:${SANS}`,
        'font-size:12px',
        'line-height:1.6',
        'color:var(--sa-text-body,rgba(255,255,255,0.8))',
    ].join(';');

    if (mood) {
        const moodRow = document.createElement('div');
        moodRow.style.cssText = `font-family:${MONO};font-size:9.5px;letter-spacing:0.08em;text-transform:uppercase;color:${ACCENT_TEXT};margin-bottom:9px`;
        moodRow.textContent = 'on set \u00B7 ' + mood; // "on set · <mood>"
        body.appendChild(moodRow);
    }

    cast.forEach((actor, i) => {
        const row = document.createElement('div');
        row.style.cssText = [
            'display:flex',
            'align-items:flex-start',
            'gap:9px',
            'padding:8px 0',
            i > 0 ? 'border-top:1px solid var(--sa-border-faint,rgba(255,255,255,0.05))' : '',
        ].filter(Boolean).join(';');

        // Thin-ruled monogram — outlined circle, not a filled dot.
        const mono = document.createElement('div');
        mono.style.cssText = [
            'flex-shrink:0',
            'width:22px',
            'height:22px',
            'border-radius:50%',
            `border:1px solid rgba(${ACCENT},0.5)`,
            `color:${ACCENT_TEXT}`,
            'display:flex',
            'align-items:center',
            'justify-content:center',
            `font-family:${MONO}`,
            'font-size:10px',
            'font-weight:600',
            'margin-top:1px',
        ].join(';');
        mono.textContent = monogram(actor.name);

        const col = document.createElement('div');
        col.style.cssText = 'flex:1;min-width:0';

        if (actor.name) {
            const nameRow = document.createElement('div');
            nameRow.style.cssText = `font-family:${MONO};font-size:9.5px;letter-spacing:0.06em;text-transform:uppercase;color:var(--sa-text-secondary,rgba(255,255,255,0.65));margin-bottom:3px`;
            nameRow.textContent = actor.name;
            col.appendChild(nameRow);
        }

        const quote = document.createElement('div');
        quote.style.cssText = 'color:var(--sa-text-body,rgba(255,255,255,0.8));font-style:italic;white-space:pre-wrap;word-break:break-word;line-height:1.55';
        quote.textContent = actor.reaction;
        col.appendChild(quote);

        row.appendChild(mono);
        row.appendChild(col);
        body.appendChild(row);
    });

    container.appendChild(summary);
    container.appendChild(body);
    el.replaceWith(container);
}
