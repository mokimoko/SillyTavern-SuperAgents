/**
 * Commentary Section Renderer
 *
 * Transforms .commentary-section-data containers (built by
 * buildSidecarDisplayData from the Commentary Section post-gen agent's stored
 * output) into a dark-mode, AO3-style reader comment panel: an audience
 * reacting to the scene that just aired.
 *
 * The data container carries:
 *   - data-scene attribute → short scene descriptor (collapsed summary)
 *   - data-count attribute → count phrase, e.g. "5 readers" (summary right)
 *   - textContent          → one comment per line, "@handle :: comment".
 *                            A leading "> " marks a single-level reply.
 *
 * Multi-item like Actor Interview / Parallel Off-Screen: multiplicity lives
 * inside a single block's textContent, parsed here into per-comment rows.
 * Registered as a render hook in index.js; renderer.js calls
 * renderCommentarySection on every .commentary-section-data element it injects.
 *
 * Aesthetic: deliberately a touch different from the rest of the family — a
 * darker semi-transparent panel evoking a dark-mode AO3 comment section. Flat
 * comment blocks split by hairline rules, handle + timestamp on one baseline
 * row, small slate-blue monogram avatars, single replies indented with a left
 * rule. Still the family collapsed <details> shell + monospace label. Muted
 * slate-blue accent to differentiate from Soundtrack (purple), Art (amber),
 * Actor (clay/rose) and Narrative (pewter-teal).
 */

const MONO = "ui-monospace,'Cascadia Code','Source Code Pro',Menlo,Consolas,monospace";
const SANS = "system-ui,-apple-system,'Segoe UI',sans-serif";

// Muted slate-blue accent — the last unused cool tone in the family. Used for
// the left border, the handle color (link-like, AO3 pseud energy) and avatars.
const ACCENT = '95,130,175';

/**
 * Synthetic relative timestamps. The model doesn't emit times (keeps the block
 * clean and avoids it fumbling relative math); we assign plausible "just now /
 * N min ago" values client-side, newest-looking at the bottom like a real
 * thread that's been accruing. Purely cosmetic flavor.
 */
function synthTimes(n) {
    const labels = [];
    // Roughly-increasing minute offsets, a little jittered, oldest first.
    let mins = Math.max(2, n) + Math.floor(Math.random() * 3);
    for (let i = 0; i < n; i++) {
        if (i === n - 1) {
            labels.push(Math.random() < 0.5 ? 'just now' : '1 min ago');
        } else {
            labels.push(`${mins} min ago`);
            mins = Math.max(1, mins - (1 + Math.floor(Math.random() * 3)));
        }
    }
    return labels;
}

/**
 * Parse the raw body into comment entries.
 * Expected: "@handle :: comment" per line. A leading "> " marks a reply
 * (depth 1). Falls back gracefully if a line has no "::" (whole line treated
 * as the comment, no handle).
 * @returns {Array<{handle: string, text: string, reply: boolean}>}
 */
function parseComments(raw) {
    return (raw ?? '')
        .split('\n')
        .map(l => l.trim())
        .filter(Boolean)
        .map(line => {
            let reply = false;
            // Strip one or more leading "> " markers; any depth collapses to
            // a single reply level (flat + one-reply design).
            let rest = line;
            while (rest.startsWith('>')) {
                reply = true;
                rest = rest.replace(/^>\s*/, '');
            }
            const idx = rest.indexOf('::');
            if (idx > -1) {
                let handle = rest.slice(0, idx).trim();
                const text = rest.slice(idx + 2).trim();
                return { handle, text, reply };
            }
            return { handle: '', text: rest, reply };
        })
        .filter(c => c.text);
}

/** First alphanumeric char of a handle, lowercased, for the monogram. */
function monogram(handle) {
    const m = (handle ?? '').replace(/^@+/, '').match(/[a-z0-9]/i);
    return m ? m[0].toLowerCase() : '\u25CF';
}

/** Normalize a handle for display — ensure a single leading @. */
function fmtHandle(handle) {
    const h = (handle ?? '').replace(/^@+/, '').trim();
    return h ? '@' + h : '';
}

/**
 * Build one comment block (top-level or reply).
 * @param {{handle:string,text:string,reply:boolean}} c
 * @param {string} time — synthetic relative timestamp label
 * @param {boolean} last — whether this is the final row (drops bottom rule)
 */
function buildComment(c, time, last) {
    const row = document.createElement('div');
    const base = [
        c.reply ? 'margin-left:22px' : '',
        c.reply ? 'padding:11px 0 11px 12px' : 'padding:11px 0',
        c.reply ? `border-left:2px solid rgba(${ACCENT},0.22)` : '',
        last ? '' : 'border-bottom:1px solid rgba(255,255,255,0.05)',
    ].filter(Boolean).join(';');
    row.style.cssText = base;

    // Header row: avatar + handle + timestamp (pushed right), baseline aligned.
    const head = document.createElement('div');
    head.style.cssText = 'display:flex;align-items:baseline;gap:8px;margin-bottom:5px';

    const av = document.createElement('div');
    const avA = c.reply ? 0.12 : 0.18;
    const avB = c.reply ? 0.4 : 0.5;
    const avC = c.reply ? 0.85 : 0.95;
    av.style.cssText = [
        'flex-shrink:0',
        'width:20px',
        'height:20px',
        'border-radius:50%',
        `background:rgba(${ACCENT},${avA})`,
        `border:1px solid rgba(${ACCENT},${avB})`,
        `color:rgba(150,180,220,${avC})`,
        'display:flex',
        'align-items:center',
        'justify-content:center',
        `font-family:${MONO}`,
        'font-size:9px',
        'font-weight:600',
        // Nudge down so it visually centers against the baseline-aligned row.
        'align-self:center',
    ].join(';');
    av.textContent = monogram(c.handle);
    head.appendChild(av);

    if (c.handle) {
        const h = document.createElement('span');
        h.style.cssText = `color:rgba(140,175,215,${c.reply ? 0.82 : 0.9});font-weight:500;font-size:12.5px`;
        h.textContent = fmtHandle(c.handle);
        head.appendChild(h);
    }

    const t = document.createElement('span');
    t.style.cssText = 'margin-left:auto;color:rgba(255,255,255,0.28);font-size:10px;flex-shrink:0';
    t.textContent = time;
    head.appendChild(t);

    const body = document.createElement('div');
    body.style.cssText = `color:rgba(255,255,255,${c.reply ? 0.72 : 0.75});word-break:break-word;white-space:pre-wrap;line-height:1.55`;
    body.textContent = c.text;

    row.appendChild(head);
    row.appendChild(body);
    return row;
}

/**
 * Transform a .commentary-section-data element into the styled comment panel.
 * @param {HTMLElement} el — the data container element
 */
export function renderCommentarySection(el) {
    const scene = (el.getAttribute('data-scene') ?? '').trim();
    let count = (el.getAttribute('data-count') ?? '').trim();
    let raw = (el.textContent ?? '').trim();

    // Unwrap a bare JSON string if the body arrived quoted (envelope batching
    // can stringify a single-field value).
    if (raw.startsWith('"') && raw.endsWith('"')) {
        try { raw = JSON.parse(raw); } catch { /* keep raw */ }
    }

    const comments = parseComments(String(raw).trim());
    if (comments.length === 0) return;

    // Fall back to a derived count if the model's phrase is missing.
    if (!count) {
        const n = comments.filter(c => !c.reply).length || comments.length;
        count = `${n} comment${n === 1 ? '' : 's'}`;
    }

    const times = synthTimes(comments.length);

    // ── Collapsible <details>, COLLAPSED by default. ──
    const container = document.createElement('details');
    container.className = 'commentary-section-rendered';
    container.open = false;
    container.style.cssText = 'margin:8px 0;font-size:11px';

    // ── Summary: speech-balloon glyph + label, count on the right. ──
    const summary = document.createElement('summary');
    summary.style.cssText = [
        'display:flex',
        'align-items:center',
        'gap:8px',
        'padding:5px 10px',
        'background:rgba(255,255,255,0.02)',
        'border:1px solid rgba(255,255,255,0.06)',
        `border-left:2px solid rgba(${ACCENT},0.45)`,
        'color:rgba(255,255,255,0.5)',
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
    glyph.textContent = '\uD83D\uDCAC'; // 💬
    glyph.style.cssText = 'font-size:12px;filter:saturate(0.7)';

    const label = document.createElement('span');
    label.style.cssText = 'text-transform:uppercase;letter-spacing:0.18em;opacity:0.7';
    label.textContent = 'Reader Comments';

    const meta = document.createElement('span');
    meta.style.cssText = 'margin-left:auto;text-transform:none;letter-spacing:0.02em;color:rgba(255,255,255,0.4);font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
    // Prefer the scene descriptor in the summary; fall back to the count.
    meta.textContent = scene || count;

    summary.appendChild(glyph);
    summary.appendChild(label);
    summary.appendChild(meta);

    summary.addEventListener('mouseenter', () => {
        summary.style.color = 'rgba(255,255,255,0.75)';
        summary.style.borderLeftColor = `rgba(${ACCENT},0.75)`;
    });
    summary.addEventListener('mouseleave', () => {
        summary.style.color = 'rgba(255,255,255,0.5)';
        summary.style.borderLeftColor = `rgba(${ACCENT},0.45)`;
    });

    // ── Body: darker AO3-style panel. Each comment a flat block, hairline
    //    rules between. Slightly darker bg than the rest of the family. ──
    const body = document.createElement('div');
    body.style.cssText = [
        'padding:6px 14px 12px',
        'background:rgba(0,0,0,0.28)',
        'border:1px solid rgba(255,255,255,0.06)',
        'border-top:none',
        `border-left:2px solid rgba(${ACCENT},0.3)`,
        `font-family:${SANS}`,
        'font-size:13px',
        'line-height:1.55',
        'color:rgba(255,255,255,0.72)',
    ].join(';');

    comments.forEach((c, i) => {
        body.appendChild(buildComment(c, times[i], i === comments.length - 1));
    });

    container.appendChild(summary);
    container.appendChild(body);
    el.replaceWith(container);
}
