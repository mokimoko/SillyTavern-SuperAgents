/**
 * Render Character Diary sidecar output as a collapsed parchment page.
 */

function unquote(value) {
    const text = String(value ?? '').trim();
    if (text.startsWith('"') && text.endsWith('"')) {
        try { return String(JSON.parse(text)).trim(); } catch { /* keep raw */ }
    }
    return text;
}

function diaryLabel(character) {
    const name = String(character ?? '').trim();
    if (!name) return 'Character Diary';
    return /s$/i.test(name) ? `${name}\u2019 Diary` : `${name}\u2019s Diary`;
}

export function renderCharacterDiary(el) {
    const character = unquote(el.getAttribute('data-character'));
    const title = unquote(el.getAttribute('data-title'));
    const dateline = unquote(el.getAttribute('data-dateline'));
    const entry = unquote(el.textContent);
    if (!entry) return;

    const container = document.createElement('details');
    container.className = 'character-diary-rendered';
    container.open = false;

    const summary = document.createElement('summary');
    summary.className = 'character-diary-summary';

    const glyph = document.createElement('i');
    glyph.className = 'fa-solid fa-book-open character-diary-summary-icon';
    glyph.setAttribute('aria-hidden', 'true');

    const label = document.createElement('span');
    label.className = 'character-diary-summary-label';
    label.textContent = diaryLabel(character);

    const meta = document.createElement('span');
    meta.className = 'character-diary-summary-meta';
    meta.textContent = title || dateline;

    const chevron = document.createElement('i');
    chevron.className = 'fa-solid fa-chevron-down character-diary-chevron';
    chevron.setAttribute('aria-hidden', 'true');

    summary.appendChild(glyph);
    summary.appendChild(label);
    if (meta.textContent) summary.appendChild(meta);
    summary.appendChild(chevron);

    const page = document.createElement('div');
    page.className = 'character-diary-page';

    if (title || dateline) {
        const heading = document.createElement('div');
        heading.className = 'character-diary-heading';

        if (title) {
            const titleEl = document.createElement('div');
            titleEl.className = 'character-diary-title';
            titleEl.textContent = title;
            heading.appendChild(titleEl);
        }

        if (dateline) {
            const dateEl = document.createElement('div');
            dateEl.className = 'character-diary-dateline';
            dateEl.textContent = dateline;
            heading.appendChild(dateEl);
        }

        page.appendChild(heading);
    }

    const prose = document.createElement('div');
    prose.className = 'character-diary-entry';
    prose.textContent = entry;
    page.appendChild(prose);

    if (character) {
        const signature = document.createElement('div');
        signature.className = 'character-diary-signature';
        signature.textContent = `\u2014 ${character}`;
        page.appendChild(signature);
    }

    container.appendChild(summary);
    container.appendChild(page);
    el.replaceWith(container);
}
