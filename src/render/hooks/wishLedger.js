/** Render the standalone Wish Granter ledger under the latest response. */

const STYLE_ID = 'sa-wish-ledger-styles';

function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
        .sa-wish-ledger-rendered{margin:8px 0;border:1px solid var(--sa-border-soft,rgba(255,255,255,.08));border-left:2px solid #b58cff;background:var(--sa-surface-info,rgba(0,0,0,.16));font-size:12px}
        .sa-wish-ledger-rendered>summary{display:flex;align-items:center;gap:8px;padding:7px 10px;cursor:pointer;list-style:none;color:var(--sa-text-primary,rgba(255,255,255,.88));font-family:ui-monospace,'Cascadia Code',Consolas,monospace}
        .sa-wish-ledger-rendered>summary::-webkit-details-marker{display:none}
        .sa-wish-ledger-count{margin-left:auto;color:var(--sa-text-secondary,rgba(255,255,255,.6));font-size:10px;letter-spacing:.04em}
        .sa-wish-ledger-body{padding:0 10px 10px;display:grid;gap:8px}
        .sa-wish-ledger-section{display:grid;gap:6px}
        .sa-wish-ledger-heading{margin-top:2px;color:var(--sa-text-secondary,rgba(255,255,255,.58));font:600 9px/1.4 ui-monospace,'Cascadia Code',Consolas,monospace;letter-spacing:.16em;text-transform:uppercase}
        .sa-wish-card{padding:8px 9px;border:1px solid var(--sa-border-soft,rgba(255,255,255,.07));background:var(--sa-surface-input,rgba(255,255,255,.025));border-radius:3px}
        .sa-wish-card[data-active="true"]{border-left:2px solid #8fd7a8}
        .sa-wish-card[data-active="false"]{opacity:.72}
        .sa-wish-meta{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-bottom:5px}
        .sa-wish-id{font:600 10px/1.3 ui-monospace,'Cascadia Code',Consolas,monospace;color:#cdb5ff}
        .sa-wish-pill{padding:1px 6px;border-radius:999px;background:rgba(181,140,255,.12);color:var(--sa-text-secondary,rgba(255,255,255,.68));font-size:9px;text-transform:uppercase;letter-spacing:.06em}
        .sa-wish-text{color:var(--sa-text-primary,rgba(255,255,255,.9));font-style:italic;white-space:pre-wrap;overflow-wrap:anywhere}
        .sa-wish-reality{margin-top:5px;color:var(--sa-text-body,rgba(255,255,255,.74));white-space:pre-wrap;overflow-wrap:anywhere}
        .sa-wish-links{margin-top:5px;color:var(--sa-text-secondary,rgba(255,255,255,.58));font-size:10px}
        .sa-wish-empty{padding:8px;color:var(--sa-text-secondary,rgba(255,255,255,.58));font-style:italic}
    `;
    document.head.appendChild(style);
}

function text(tag, className, value) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    el.textContent = String(value ?? '');
    return el;
}

function parseLedger(raw) {
    let value = String(raw ?? '').trim();
    if (value.startsWith('"') && value.endsWith('"')) {
        try { value = JSON.parse(value); } catch { /* keep original */ }
    }
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : null;
}

function buildWishCard(wish) {
    const card = document.createElement('article');
    card.className = 'sa-wish-card';
    card.dataset.active = wish.active === true ? 'true' : 'false';

    const meta = document.createElement('div');
    meta.className = 'sa-wish-meta';
    meta.append(
        text('span', 'sa-wish-id', wish.id || 'Unnumbered'),
        text('span', 'sa-wish-pill', wish.status || 'unknown'),
        text('span', 'sa-wish-pill', wish.owner || 'Unknown owner'),
        text('span', 'sa-wish-pill', `turn ${wish.turn ?? '?'}`),
    );
    card.append(meta);
    card.append(text('div', 'sa-wish-text', `“${wish.exactWording || 'Wording unavailable'}”`));
    if (wish.realityState) card.append(text('div', 'sa-wish-reality', `Reality: ${wish.realityState}`));

    const links = [];
    if (Array.isArray(wish.overrides) && wish.overrides.length) links.push(`Overrides ${wish.overrides.join(', ')}`);
    if (wish.supersededBy) links.push(`Superseded by ${wish.supersededBy}`);
    if (Number.isInteger(wish.updatedTurn) && wish.updatedTurn !== wish.turn) links.push(`Updated turn ${wish.updatedTurn}`);
    if (links.length) card.append(text('div', 'sa-wish-links', links.join(' · ')));
    return card;
}

function appendSection(body, label, wishes) {
    if (!wishes.length) return;
    const section = document.createElement('section');
    section.className = 'sa-wish-ledger-section';
    section.append(text('div', 'sa-wish-ledger-heading', label));
    for (const wish of wishes) section.append(buildWishCard(wish));
    body.append(section);
}

export function renderWishLedger(el) {
    let ledger;
    try {
        ledger = parseLedger(el.textContent);
    } catch {
        el.remove();
        return;
    }

    ensureStyles();
    document.querySelectorAll('.sa-wish-ledger-rendered').forEach(existing => existing.remove());

    const wishes = Object.values(ledger?.wishes || {})
        .filter(wish => wish && typeof wish === 'object')
        .sort((a, b) => (Number(a.turn) - Number(b.turn)) || String(a.id).localeCompare(String(b.id)));
    const active = wishes.filter(wish => wish.active === true);
    const history = wishes.filter(wish => wish.active !== true);

    const panel = document.createElement('details');
    panel.className = 'sa-wish-ledger-rendered';

    const summary = document.createElement('summary');
    summary.append(
        text('span', '', '✦'),
        text('span', '', 'Wish Ledger'),
        text('span', 'sa-wish-ledger-count', `${active.length} active · ${wishes.length} total`),
    );

    const body = document.createElement('div');
    body.className = 'sa-wish-ledger-body';
    if (!wishes.length) body.append(text('div', 'sa-wish-empty', 'No reality-altering wishes recorded yet.'));
    appendSection(body, 'Active reality', active);
    appendSection(body, 'Superseded / revoked history', history);

    panel.append(summary, body);
    el.replaceWith(panel);
}
