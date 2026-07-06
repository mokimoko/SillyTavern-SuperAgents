/**
 * Art Prompt Generator Renderer
 *
 * Transforms .art-prompt-data containers into a styled collapsible block
 * showing the generated image prompt with a copy-to-clipboard button.
 *
 * The data container carries:
 *   - data-label  attribute → short scene description
 *   - data-style  attribute → art style / medium
 *   - textContent            → the full image-gen prompt
 *
 * Visual accent: warm amber (#D4A054) to differentiate from Director
 * (white), Soundtrack (purple), and other hooks.
 */

const MONO = "ui-monospace,'Cascadia Code','Source Code Pro',Menlo,Consolas,monospace";
const SANS = "system-ui,-apple-system,'Segoe UI',sans-serif";

/**
 * Transform a .art-prompt-data element into the styled display.
 * @param {HTMLElement} el — the data container element
 */
export function renderArtPrompt(el) {
    const label = (el.getAttribute('data-label') ?? '').trim();
    const style = (el.getAttribute('data-style') ?? '').trim();
    let prompt = (el.textContent ?? '').trim();

    // Unwrap bare JSON string if batching quoted it.
    if (prompt.startsWith('"') && prompt.endsWith('"')) {
        try { prompt = JSON.parse(prompt); } catch { /* keep raw */ }
    }
    prompt = String(prompt).trim();

    if (!label && !prompt) return;

    // ── Collapsible <details>, COLLAPSED by default ──
    const container = document.createElement('details');
    container.className = 'art-prompt-rendered';
    container.open = false;
    container.style.cssText = 'margin:8px 0;font-size:11px';

    const summary = document.createElement('summary');
    summary.style.cssText = [
        'display:flex',
        'align-items:center',
        'gap:8px',
        'padding:5px 10px',
        'background:rgba(255,255,255,0.02)',
        'border:1px solid rgba(255,255,255,0.06)',
        'border-left:2px solid rgba(212,160,84,0.45)',
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
    glyph.textContent = '\u{1F3A8}'; // 🎨
    glyph.style.cssText = 'font-size:12px;line-height:1';

    const labelEl = document.createElement('span');
    labelEl.style.cssText = 'text-transform:uppercase;letter-spacing:0.18em;opacity:0.7';
    labelEl.textContent = 'Art Prompt';

    const sceneInline = document.createElement('span');
    sceneInline.style.cssText = 'margin-left:auto;text-transform:none;letter-spacing:0.02em;color:rgba(255,255,255,0.62);font-family:' + SANS + ';font-size:11px;font-style:italic;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
    sceneInline.textContent = label;

    summary.appendChild(glyph);
    summary.appendChild(labelEl);
    if (label) summary.appendChild(sceneInline);

    summary.addEventListener('mouseenter', () => {
        summary.style.color = 'rgba(255,255,255,0.75)';
        summary.style.borderLeftColor = 'rgba(212,160,84,0.75)';
    });
    summary.addEventListener('mouseleave', () => {
        summary.style.color = 'rgba(255,255,255,0.5)';
        summary.style.borderLeftColor = 'rgba(212,160,84,0.45)';
    });

    const body = document.createElement('div');
    body.style.cssText = [
        'padding:9px 12px',
        'background:rgba(0,0,0,0.18)',
        'border:1px solid rgba(255,255,255,0.06)',
        'border-top:none',
        'border-left:2px solid rgba(212,160,84,0.3)',
        `font-family:${SANS}`,
        'font-size:12px',
        'line-height:1.6',
        'color:rgba(255,255,255,0.7)',
    ].join(';');

    // Style descriptor row (monospace, amber) — the medium/approach.
    if (style) {
        const styleRow = document.createElement('div');
        styleRow.style.cssText = `font-family:${MONO};font-size:10px;letter-spacing:0.04em;color:rgba(212,160,84,0.9);margin-bottom:7px`;
        styleRow.textContent = style;
        body.appendChild(styleRow);
    }

    // The prompt itself — selectable, wrapping, slightly emphasized.
    if (prompt) {
        const promptRow = document.createElement('div');
        promptRow.style.cssText = 'color:rgba(255,255,255,0.82);white-space:pre-wrap;word-break:break-word;user-select:text;margin-bottom:9px';
        promptRow.textContent = prompt;
        body.appendChild(promptRow);
    }

    // Copy-to-clipboard button — the payoff. Lets you grab the prompt and
    // paste it straight into your image generator without selecting text.
    if (prompt) {
        const copyBtn = document.createElement('button');
        copyBtn.type = 'button';
        copyBtn.textContent = 'copy prompt';
        copyBtn.style.cssText = [
            'display:inline-flex',
            'align-items:center',
            'gap:5px',
            'padding:3px 10px',
            'background:rgba(212,160,84,0.12)',
            'border:1px solid rgba(212,160,84,0.35)',
            'border-radius:2px',
            'color:rgba(212,160,84,0.95)',
            `font-family:${MONO}`,
            'font-size:10px',
            'letter-spacing:0.08em',
            'text-transform:uppercase',
            'cursor:pointer',
            'transition:background 0.15s ease,color 0.15s ease',
        ].join(';');

        copyBtn.addEventListener('mouseenter', () => {
            copyBtn.style.background = 'rgba(212,160,84,0.22)';
            copyBtn.style.color = 'rgba(255,255,255,0.95)';
        });
        copyBtn.addEventListener('mouseleave', () => {
            copyBtn.style.background = 'rgba(212,160,84,0.12)';
            copyBtn.style.color = 'rgba(212,160,84,0.95)';
        });

        copyBtn.addEventListener('click', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            try {
                await navigator.clipboard.writeText(prompt);
                const prev = copyBtn.textContent;
                copyBtn.textContent = 'copied ✓';
                setTimeout(() => { copyBtn.textContent = prev; }, 1400);
            } catch {
                // Clipboard API can be blocked; fall back to a text selection.
                const range = document.createRange();
                range.selectNodeContents(body);
                const sel = window.getSelection();
                sel.removeAllRanges();
                sel.addRange(range);
            }
        });

        body.appendChild(copyBtn);
    }

    container.appendChild(summary);
    container.appendChild(body);
    el.replaceWith(container);
}
