const esc = value => String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

function badges(event) {
    return `<span class="sa-wt-badges">
        <span data-kind="importance" data-value="${esc(event.importance)}">${esc(event.importance)}</span>
        <span data-kind="distance" data-value="${esc(event.distance)}">${esc(event.distance)}</span>
        <span data-kind="tone" data-value="${esc(event.tone)}">${esc(event.tone)}</span>
    </span>`;
}

function empty(icon, title, body) {
    return `<div class="sa-wt-empty">
        <i class="fa-solid ${icon}" aria-hidden="true"></i>
        <strong>${esc(title)}</strong>
        <p>${esc(body)}</p>
    </div>`;
}

function select(name, values, selected) {
    return `<label><span>${esc(name)}</span><select name="${esc(name)}">
        ${values.map(value => `<option value="${value}" ${value === selected ? 'selected' : ''}>${value}</option>`).join('')}
    </select></label>`;
}

function editor(event) {
    return `<form class="sa-wt-editor" data-event-id="${esc(event.id)}">
        <label><span>Thread title</span><input name="title" maxlength="100" value="${esc(event.title)}" required></label>
        <label><span>What is happening</span><textarea name="description" maxlength="320" required>${esc(event.description)}</textarea></label>
        <div class="sa-wt-editor-grid">
            ${select('importance', ['major', 'average', 'minor'], event.importance)}
            ${select('distance', ['local', 'distant'], event.distance)}
            ${select('tone', ['positive', 'neutral', 'negative'], event.tone)}
        </div>
        <div class="sa-wt-editor-actions">
            <button type="button" data-action="cancel-edit">Cancel</button>
            <button type="submit"><i class="fa-solid fa-check"></i> Save changes</button>
        </div>
    </form>`;
}

function activeCard(event, editingId) {
    if (event.id === editingId) return editor(event);
    return `<article class="sa-wt-card" data-importance="${esc(event.importance)}">
        <div class="sa-wt-card-copy">
            <div class="sa-wt-card-title"><strong>${esc(event.title)}</strong>${badges(event)}</div>
            <p>${esc(event.description)}</p>
        </div>
        <div class="sa-wt-card-actions">
            <button type="button" data-action="edit" data-event-id="${esc(event.id)}"><i class="fa-solid fa-pen"></i> Edit</button>
            <button type="button" data-action="resolve" data-event-id="${esc(event.id)}"><i class="fa-solid fa-check"></i> Resolve</button>
            <button class="is-danger" type="button" data-action="remove" data-event-id="${esc(event.id)}" title="Erase from this branch"><i class="fa-solid fa-trash-can"></i></button>
        </div>
    </article>`;
}

function activeView(state, editingId) {
    if (!state.roster.length) {
        return empty('fa-wind', 'No active world threads', 'Choose a suggestion when you want something to begin moving beyond the scene.');
    }
    return ['local', 'distant'].map(distance => {
        const events = state.roster.filter(event => event.distance === distance);
        if (!events.length) return '';
        return `<section class="sa-wt-group">
            <div class="sa-wt-group-label"><i class="fa-solid ${distance === 'local' ? 'fa-location-dot' : 'fa-compass'}"></i>${distance === 'local' ? 'Near the scene' : 'Elsewhere'}</div>
            ${events.map(event => activeCard(event, editingId)).join('')}
        </section>`;
    }).join('');
}

function suggestionsView(state, maxRoster) {
    if (!state.proposals.length) {
        return empty('fa-inbox', 'No suggestions waiting', 'The agent will leave a fresh set here on its next scheduled run.');
    }
    const full = state.roster.length >= maxRoster;
    return `<div class="sa-wt-suggestion-note">Choose one thread to activate. Closing this utility keeps the set for later.</div>
        <div class="sa-wt-suggestions">${state.proposals.map((event, index) => `
            <button class="sa-wt-proposal" type="button" data-action="accept" data-proposal-index="${index}" ${full ? 'disabled' : ''}>
                <span class="sa-wt-card-title"><strong>${esc(event.title)}</strong>${badges(event)}</span>
                <span>${esc(event.description)}</span>
            </button>`).join('')}</div>
        <footer class="sa-wt-suggestion-footer">
            <span>${full ? 'Resolve or remove an active thread before adding another.' : `Active roster: ${state.roster.length}/${maxRoster}`}</span>
            <button type="button" data-action="dismiss"><i class="fa-solid fa-ban"></i> None — discard set</button>
        </footer>`;
}

function historyView(state) {
    if (!state.history.length) {
        return empty('fa-clock-rotate-left', 'Nothing resolved yet', 'Finished threads stay here as a compact branch history.');
    }
    return `<div class="sa-wt-history">${[...state.history].reverse().map(event => `
        <article class="sa-wt-card sa-wt-card--history">
            <div class="sa-wt-card-copy">
                <div class="sa-wt-card-title"><strong>${esc(event.title)}</strong>${badges(event)}</div>
                <p>${esc(event.description)}</p>
                <small>Active at message ${event.addedAtMessage} · resolved at ${event.resolvedAtMessage}</small>
            </div>
            <button class="is-danger" type="button" data-action="remove-history" data-event-id="${esc(event.id)}" title="Erase from history"><i class="fa-solid fa-trash-can"></i></button>
        </article>`).join('')}</div>`;
}

export function renderWorldThreads(panelEl, { state, tab, maxRoster, editingId }) {
    if (!panelEl) return;
    panelEl.querySelectorAll('[data-tab]').forEach(button => {
        const selected = button.dataset.tab === tab;
        button.classList.toggle('is-active', selected);
        button.setAttribute('aria-selected', String(selected));
    });
    const counts = { active: state.roster.length, suggestions: state.proposals.length, history: state.history.length };
    for (const [name, count] of Object.entries(counts)) {
        const countEl = panelEl.querySelector(`[data-tab-count="${name}"]`);
        if (countEl) countEl.textContent = String(count);
    }
    const body = panelEl.querySelector('.sa-wt-body');
    if (!body) return;
    body.innerHTML = tab === 'suggestions'
        ? suggestionsView(state, maxRoster)
        : tab === 'history'
            ? historyView(state)
            : activeView(state, editingId);
}

export function readWorldThreadEditor(form) {
    const data = new FormData(form);
    return {
        title: data.get('title'),
        description: data.get('description'),
        importance: data.get('importance'),
        distance: data.get('distance'),
        tone: data.get('tone'),
    };
}
