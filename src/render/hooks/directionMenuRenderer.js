/**
 * Direction Menu Renderer
 *
 * Transforms .dm-menu-data containers (injected by regexProcessor from the
 * Direction Menu agent template) into a styled 4-option card.
 *
 * Parses the raw text content flexibly — handles variations in how the LLM
 * labels the four options (parentheses, brackets, colons, bold, etc.).
 *
 * Uses event delegation on #chat for click handling — individual event
 * listeners on row elements get destroyed when ST's formatting pipeline
 * re-renders message DOM after the agent renderer runs. Delegation survives
 * any amount of DOM rebuilds.
 *
 * Registered as a render hook in index.js (SuperAgents). renderer.js calls
 * renderDirectionMenu on every .dm-menu-data element it injects (the element
 * is produced by the template's regex script from the inline [DIRECTIONS]
 * block, with renderPlacement "bottom"). Ported verbatim from VM's
 * renderers/directionMenuRenderer.js.
 */

// ============================================================================
// OPTION DEFINITIONS
// ============================================================================

const OPTIONS = [
    { key: 'variation', label: 'Variation', color: 'color-mix(in srgb, rgb(110,165,255) 65%, var(--SmartThemeBodyColor, #fff) 35%)' },
    { key: 'opposite',  label: 'Opposite',  color: 'color-mix(in srgb, rgb(255,140,100) 65%, var(--SmartThemeBodyColor, #fff) 35%)' },
    { key: 'outside',   label: 'Outside',   color: 'color-mix(in srgb, rgb(110,200,150) 65%, var(--SmartThemeBodyColor, #fff) 35%)' },
    { key: 'wildcard',  label: 'Wildcard',  color: 'color-mix(in srgb, rgb(190,140,255) 65%, var(--SmartThemeBodyColor, #fff) 35%)' },
];

// ============================================================================
// DELEGATION SETUP (runs once)
// ============================================================================

let delegationInstalled = false;

/**
 * Install a single delegated click handler on #chat.
 * Handles all direction menu clicks without per-element listeners.
 */
export function initDirectionMenuDelegation() {
    if (delegationInstalled) return;

    const chat = document.getElementById('chat');
    if (!chat) {
        // Retry once — chat may not be in DOM yet at init
        setTimeout(() => {
            const retry = document.getElementById('chat');
            if (retry && !delegationInstalled) installDelegation(retry);
        }, 1000);
        return;
    }

    installDelegation(chat);
}

function installDelegation(chatEl) {
    chatEl.addEventListener('click', (e) => {
        const row = e.target.closest('[data-dm-option]');
        if (!row) return;

        // Already selected? (menu is locked)
        const menu = row.closest('.dm-menu-rendered');
        if (!menu || menu.hasAttribute('data-dm-selected')) return;

        e.stopPropagation();
        e.preventDefault();

        const label = row.dataset.dmLabel || '';
        const text = row.dataset.dmText || '';

        if (!label || !text) return;

        selectDirection(label, text, row, menu);
    });

    delegationInstalled = true;
}

/**
 * Inject CSS for hover effects (replaces JS mouseenter/mouseleave).
 * Called once alongside delegation setup.
 */
function injectStyles() {
    if (document.getElementById('dm-menu-styles')) return;
    const style = document.createElement('style');
    style.id = 'dm-menu-styles';
    style.textContent = `
        .dm-menu-rendered:not([data-dm-selected]) [data-dm-option] {
            cursor: pointer;
        }
        .dm-menu-rendered:not([data-dm-selected]) [data-dm-option]:hover {
            background: var(--sa-surface-rail-hot, rgba(255,255,255,0.03));
        }
        .dm-menu-rendered[data-dm-selected] [data-dm-option] {
            opacity: 0.35;
            cursor: default;
        }
        .dm-menu-rendered[data-dm-selected] [data-dm-option].dm-selected {
            opacity: 1;
            background: var(--sa-surface-input, rgba(255,255,255,0.04));
        }
    `;
    document.head.appendChild(style);
}

// ============================================================================
// PARSER
// ============================================================================

/**
 * Parse the raw text between [DIRECTIONS]...[/DIRECTIONS] into 4 options.
 * Handles many LLM formatting variations:
 *   1. (variation) text        ← intended format
 *   1. (Variation): text       ← with colon
 *   1. [Variation] text        ← brackets
 *   1. **Variation** — text    ← bold + dash
 *   1. Variation: text         ← plain label
 *   Variation: text            ← no number
 *
 * @param {string} raw
 * @returns {{ variation: string, opposite: string, outside: string, wildcard: string } | null}
 */
function parseDirections(raw) {
    if (!raw?.trim()) return null;

    const result = {};

    for (const opt of OPTIONS) {
        // Build a flexible regex for this option's label
        // Matches: optional number+dot, optional delimiters around label, optional colon/dash after
        const pattern = new RegExp(
            '(?:^|\\n)\\s*'                           // line start
            + '(?:\\d+\\.?\\s*)?'                      // optional "1." or "1"
            + '(?:'
            +   '\\(?\\s*\\*{0,2}' + opt.key + '\\*{0,2}\\s*\\)?'   // (variation) or **variation** or variation
            +   '|'
            +   '\\[\\s*\\*{0,2}' + opt.key + '\\*{0,2}\\s*\\]'     // [variation]
            + ')'
            + '\\s*[:—–\\-]?\\s*'                      // optional colon/dash separator
            + '(.+?)(?=\\n\\s*(?:\\d+\\.?\\s*)?(?:[\\(\\[]\\s*\\*{0,2}(?:variation|opposite|outside|wildcard)|$))',
            'is',
        );

        const match = raw.match(pattern);
        if (match) {
            result[opt.key] = match[1].trim().replace(/\*{2,}/g, '');
        }
    }

    // Fallback: if structured parsing missed options, try simple numbered line split
    if (Object.keys(result).length < 4) {
        const lines = raw.trim().split('\n').filter(l => l.trim());
        const numbered = lines.filter(l => /^\s*\d/.test(l));

        if (numbered.length >= 4) {
            for (let i = 0; i < 4 && i < numbered.length; i++) {
                const key = OPTIONS[i].key;
                if (!result[key]) {
                    // Strip the number, any label in parens/brackets, and leading punctuation
                    let text = numbered[i]
                        .replace(/^\s*\d+\.?\s*/, '')
                        .replace(/^[\(\[]\s*\w+\s*[\)\]]\s*[:—–\-]?\s*/, '')
                        .replace(/^\*{2}\w+\*{2}\s*[:—–\-]?\s*/, '')
                        .replace(/^\w+\s*[:—–]\s*/, '')
                        .trim();
                    if (text) result[key] = text;
                }
            }
        }
    }

    return Object.keys(result).length >= 3 ? result : null;
}

// ============================================================================
// MAIN RENDER FUNCTION
// ============================================================================

/**
 * Transform a .dm-menu-data element into the styled Direction Menu.
 * Called by the render hook system in renderer.js.
 *
 * All data needed for click handling is stored in data-* attributes —
 * no event listeners are attached to these elements. The delegated
 * handler on #chat reads the attributes on click.
 *
 * @param {HTMLElement} el — the data container element
 */
export function renderDirectionMenu(el) {
    // Ensure delegation + styles are installed (idempotent)
    injectStyles();
    initDirectionMenuDelegation();

    const raw = el.textContent || el.dataset.content || '';
    const parsed = parseDirections(raw);

    if (!parsed) return;

    // ── Build option rows ──
    const rowEls = [];
    const presentKeys = OPTIONS.filter(o => parsed[o.key]);

    for (let i = 0; i < presentKeys.length; i++) {
        const opt = presentKeys[i];
        const text = parsed[opt.key];
        const isLast = i === presentKeys.length - 1;
        const borderBottom = isLast
            ? ''
            : 'border-bottom:0.5px solid var(--sa-border-faint,rgba(180,185,195,0.04));';

        const row = document.createElement('div');
        row.setAttribute('data-dm-option', opt.key);
        row.setAttribute('data-dm-label', opt.label);
        row.setAttribute('data-dm-text', text);
        row.style.cssText = `padding:8px 12px;display:flex;gap:10px;align-items:flex-start;transition:background 0.15s, opacity 0.2s;${borderBottom}`;
        row.innerHTML = `<span style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.07em;color:${opt.color};flex-shrink:0;width:58px;padding-top:2px">${opt.label}</span>`
            + `<span style="font-size:12.5px;color:var(--sa-text-body,rgba(200,205,215,0.8));line-height:1.55">${escHtml(text)}</span>`;

        rowEls.push(row);
    }

    if (rowEls.length === 0) return;

    // ── Container ──
    const menu = document.createElement('div');
    menu.className = 'dm-menu-rendered';
    menu.style.cssText = 'margin:10px 0 0;border-radius:6px;overflow:hidden;'
        + 'border:0.5px solid var(--sa-border-mid,rgba(180,185,195,0.08));'
        + 'font-family:system-ui,-apple-system,sans-serif';

    const header = document.createElement('div');
    header.style.cssText = 'padding:5px 12px 4px;font-size:10px;text-transform:uppercase;letter-spacing:0.08em;color:var(--sa-text-muted,rgba(200,205,215,0.45));border-bottom:0.5px solid var(--sa-border-soft,rgba(180,185,195,0.06))';
    header.textContent = 'Where does the scene go?';
    menu.appendChild(header);

    for (const row of rowEls) {
        menu.appendChild(row);
    }

    el.replaceWith(menu);
}

// ============================================================================
// SELECTION
// ============================================================================

/**
 * Handle clicking a direction option.
 * Inserts the direction text into ST's send textarea and visually marks the row.
 *
 * @param {string} label - e.g. "Variation"
 * @param {string} text - the direction description
 * @param {HTMLElement} row - the clicked row element
 * @param {HTMLElement} menu - the parent .dm-menu-rendered
 */
function selectDirection(label, text, row, menu) {
    // Lock the menu — prevents re-clicks via delegation check
    menu.setAttribute('data-dm-selected', label.toLowerCase());

    // Visual feedback via CSS class
    row.classList.add('dm-selected');

    // Send as narrator message via /nar slash command
    const textarea = document.getElementById('send_textarea');
    if (textarea) {
        textarea.value = `/nar [Direction: ${label}] ${text}`;
        textarea.dispatchEvent(new Event('input', { bubbles: true }));

        // Brief delay so ST registers the input, then click send
        requestAnimationFrame(() => {
            const sendBtn = document.getElementById('send_but');
            if (sendBtn) sendBtn.click();
        });
    }
}

// ============================================================================
// HELPERS
// ============================================================================

function escHtml(str) {
    const div = document.createElement('div');
    div.textContent = str ?? '';
    return div.innerHTML;
}
