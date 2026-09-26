/** Stateless markup for the Drama Queen planning desk. */

import { DRAMA_QUEEN_DAMAGE_CEILINGS, DRAMA_QUEEN_PRESSURES } from './dramaQueenState.js';

const INTENT_LABELS = {
    'find-fault-lines': 'Fault lines',
    'stir-the-pot': 'Stir the pot',
    'make-it-worse': 'Make it worse',
    'let-it-haunt-them': 'Let it haunt them',
};

const PRESSURE_LABELS = {
    simmer: 'Simmer',
    press: 'Press',
    corner: 'Corner',
    break: 'Break',
};

const DAMAGE_LABELS = {
    sting: 'Sting',
    strain: 'Strain',
    rupture: 'Rupture',
    catastrophe: 'Catastrophe',
};

export function escapeDramaQueenHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

function settingsMarkup(agent, injectionEnabled) {
    const config = agent.dramaQueenConfig || {};
    const probes = (config.probeTerms || []).join(', ');
    return `<section class="sa-dq-settings" data-no-drag>
        <label for="sa-dq-probes">Private lore probe</label>
        <p>Used only to wake relevant lore while planning. These terms are never posted to chat.</p>
        <div class="sa-dq-settings-row">
            <input id="sa-dq-probes" value="${escapeDramaQueenHtml(probes)}" placeholder="conflict, secret, loyalty…">
            <button type="button" data-action="save-settings">Save</button>
        </div>
        <label class="sa-dq-setting-toggle">
            <input id="sa-dq-include-injection" type="checkbox" ${injectionEnabled ? 'checked' : ''}>
            <span><b>Include beat injection</b><small>Use the active beat in story generations. Turn this off to roleplay normally without dropping the engine.</small></span>
        </label>
        <label class="sa-dq-setting-toggle">
            <input id="sa-dq-show-controller" type="checkbox" ${config.showBeatController !== false ? 'checked' : ''}>
            <span><b>Compact beat controller</b><small>Keep the current beat available beside the chat.</small></span>
        </label>
    </section>`;
}

function choiceButtons(values, labels, current, action) {
    return values.map(value => `<button type="button" data-action="${action}" data-value="${value}" class="${value === current ? 'is-current' : ''}" aria-pressed="${value === current}">${labels[value]}</button>`).join('');
}

function activeMarkup({ state, agent, busy, outlineOpen, viewedBeat, adaptMode, adaptNote, nudge, progressionMode }) {
    if (!state.active) return '';
    const proposal = state.proposals[state.active.proposalIndex];
    const live = state.active.beatIndex;
    const liveBeat = proposal?.stages[live];
    if (!proposal || !liveBeat) return '';

    const viewed = Math.max(0, Math.min(proposal.stages.length - 1, viewedBeat ?? live));
    const viewedStage = proposal.stages[viewed];
    const replacementStart = viewed + (adaptMode === 'replace-anchor' ? 0 : 1);
    const canAdapt = replacementStart < proposal.stages.length;
    const stageButtons = proposal.stages.map((stage, index) => `
        <button type="button" data-action="live-beat" data-beat="${index}" class="${index === live ? 'is-current' : ''}" title="Make ${escapeDramaQueenHtml(stage.label)} the live beat">
            <i>${index + 1}</i><span>${escapeDramaQueenHtml(stage.label)}</span>
        </button>`).join('');
    const outline = proposal.stages.map((stage, index) => `
        <button type="button" data-action="view-beat" data-beat="${index}" class="${index === live ? 'is-active' : ''} ${index === viewed ? 'is-viewed' : ''}">
            <i>${index + 1}</i>
            <span><b>${escapeDramaQueenHtml(stage.label)}</b><small>${escapeDramaQueenHtml(stage.direction)}</small></span>
            ${index === live ? '<em>Live</em>' : ''}
        </button>`).join('');
    const keepRange = viewed >= proposal.stages.length - 1
        ? 'No later beats'
        : `Replace ${viewed + 2}–${proposal.stages.length}`;
    const replaceRange = `Replace ${viewed + 1}–${proposal.stages.length}`;
    const submitLabel = canAdapt
        ? `Replace beat${proposal.stages.length - replacementStart === 1 ? '' : 's'} ${replacementStart + 1}–${proposal.stages.length}`
        : 'Replace this beat too';
    const progressionModes = [
        ['auto', 'fa-forward-step', 'Auto', 'One beat per completed reply'],
        ['nudge', 'fa-lightbulb', 'Smart Nudge', 'Privately checks beat readiness'],
        ['none', 'fa-circle-minus', 'None', 'Manual control only'],
    ].map(([mode, icon, label, detail]) => `<button type="button" data-action="progression" data-mode="${mode}" class="${progressionMode === mode ? 'is-current' : ''}" aria-pressed="${progressionMode === mode}"><i class="fa-solid ${icon}"></i><span><b>${label}</b><small>${detail}</small></span></button>`).join('');

    return `<section class="sa-dq-active">
        <div class="sa-dq-active-kicker"><span>Live engine</span><b>${escapeDramaQueenHtml(INTENT_LABELS[proposal.intent] || proposal.intent)}</b></div>
        <h3>${escapeDramaQueenHtml(proposal.title)}</h3>
        <p class="sa-dq-cast"><i class="fa-solid fa-masks-theater"></i> ${escapeDramaQueenHtml(proposal.cast.join(' · '))}</p>
        <div class="sa-dq-stage-rail" data-no-drag>${stageButtons}</div>
        <article class="sa-dq-current-beat"><small>${escapeDramaQueenHtml(liveBeat.label)}</small><p>${escapeDramaQueenHtml(liveBeat.direction)}</p></article>
        ${nudge && nudge.status !== 'hold' ? `<div class="sa-dq-nudge is-${escapeDramaQueenHtml(nudge.status)}" title="${escapeDramaQueenHtml(nudge.reason)}"><i class="fa-solid ${nudge.status === 'ready' ? 'fa-circle-check' : nudge.status === 'diverged' ? 'fa-triangle-exclamation' : 'fa-forward'}"></i><b>${escapeDramaQueenHtml(nudge.status)}</b><span>${escapeDramaQueenHtml(nudge.reason)}</span></div>` : ''}
        <div class="sa-dq-progression" role="group" aria-label="Beat progression mode" data-no-drag>${progressionModes}</div>
        <div class="sa-dq-steering" data-no-drag>
            <section><span>Pressure</span><div>${choiceButtons(DRAMA_QUEEN_PRESSURES, PRESSURE_LABELS, state.active.pressure, 'pressure')}</div></section>
            <section><span>Damage ceiling</span><div>${choiceButtons(DRAMA_QUEEN_DAMAGE_CEILINGS, DAMAGE_LABELS, state.active.damageCeiling, 'damage')}</div></section>
        </div>
        <div class="sa-dq-active-actions" data-no-drag>
            <button type="button" data-action="back" ${live === 0 ? 'disabled' : ''}><i class="fa-solid fa-arrow-left"></i> Back</button>
            <button type="button" data-action="next" class="is-hot" ${live >= proposal.stages.length - 1 ? 'disabled' : ''}>Next beat <i class="fa-solid fa-arrow-right"></i></button>
            <button type="button" data-action="drop" class="is-quiet">Drop it</button>
        </div>
        <details class="sa-dq-beat-outline" ${outlineOpen ? 'open' : ''} data-no-drag>
            <summary>View all beats <span>Previewing never changes the live beat</span></summary>
            <div class="sa-dq-outline-list">${outline}</div>
            <section class="sa-dq-beat-edit">
                <div class="sa-dq-beat-edit-heading"><span>Edit beat ${viewed + 1}</span><b>${escapeDramaQueenHtml(viewedStage.label)}</b></div>
                <label for="sa-dq-beat-direction">Beat wording <small>Local edit · no model call</small></label>
                <textarea id="sa-dq-beat-direction" rows="3" maxlength="900">${escapeDramaQueenHtml(viewedStage.direction)}</textarea>
                <div class="sa-dq-beat-edit-actions">
                    <button type="button" data-action="reset-beat-edit" disabled>Discard typing</button>
                    <button type="button" class="is-save" data-action="save-beat-edit" disabled><i class="fa-solid fa-floppy-disk"></i> Save wording</button>
                </div>
            </section>
            <section class="sa-dq-adapt-box">
                <div class="sa-dq-adapt-heading"><span>Make it worse from beat ${viewed + 1}</span><b>${escapeDramaQueenHtml(viewedStage.label)}</b></div>
                <div class="sa-dq-adapt-range">
                    <button type="button" data-action="adapt-mode" data-mode="keep-anchor" class="${adaptMode === 'keep-anchor' ? 'is-current' : ''}" ${viewed >= proposal.stages.length - 1 ? 'disabled' : ''}>Keep this beat<small>${keepRange}</small></button>
                    <button type="button" data-action="adapt-mode" data-mode="replace-anchor" class="${adaptMode === 'replace-anchor' ? 'is-current' : ''}">Replace this beat too<small>${replaceRange}</small></button>
                </div>
                <label for="sa-dq-adapt-note">What should change? <small>Optional and private</small></label>
                <textarea id="sa-dq-adapt-note" rows="2" maxlength="1200" placeholder="Make the consequence quieter, crueler, and harder to undo.">${escapeDramaQueenHtml(adaptNote)}</textarea>
                <button type="button" class="sa-dq-adapt-submit" data-action="adapt" ${!canAdapt || busy ? 'disabled' : ''}><i class="fa-solid fa-wand-magic-sparkles"></i> ${busy ? 'Adapting…' : submitLabel}</button>
            </section>
        </details>
    </section>`;
}

function proposalMarkup(proposal, index, activeIndex) {
    const intent = INTENT_LABELS[proposal.intent] || proposal.intent;
    const provenance = String(proposal.catalyst.provenance || '').replaceAll('-', ' ');
    return `<article class="sa-dq-proposal ${activeIndex === index ? 'is-active' : ''}">
        <div class="sa-dq-proposal-top"><span>${escapeDramaQueenHtml(intent)}</span><em>${escapeDramaQueenHtml(provenance)}</em></div>
        <h3>${escapeDramaQueenHtml(proposal.title)}</h3>
        <p class="sa-dq-cast">${escapeDramaQueenHtml(proposal.cast.join(' · '))}</p>
        <dl>
            <div><dt>Fault line</dt><dd>${escapeDramaQueenHtml(proposal.faultLine)}</dd></div>
            <div><dt>Stakes</dt><dd>${escapeDramaQueenHtml(proposal.stakes)}</dd></div>
            <div><dt>Catalyst</dt><dd>${escapeDramaQueenHtml(proposal.catalyst.event)}</dd></div>
        </dl>
        <button type="button" class="sa-dq-use" data-action="activate" data-proposal="${index}">${activeIndex === index ? 'Restart this engine' : 'Use this engine'} <i class="fa-solid fa-bolt"></i></button>
    </article>`;
}

export function dramaQueenBodyMarkup(options) {
    const { agent, state, settingsOpen } = options;
    if (!agent) {
        return '<div class="sa-dq-empty"><i class="fa-solid fa-masks-theater"></i><h3>Drama Queen is off</h3><p>Install and enable Drama Queen from the SuperAgents Library.</p></div>';
    }
    const proposals = state.proposals.map((proposal, index) => (
        proposalMarkup(proposal, index, state.active?.proposalIndex)
    )).join('');
    return `${settingsOpen ? settingsMarkup(agent, options.injectionEnabled) : ''}
        ${activeMarkup(options)}
        ${state.sceneRead ? `<aside class="sa-dq-scene-read"><span>Right now</span><p>${escapeDramaQueenHtml(state.sceneRead)}</p></aside>` : ''}
        ${proposals ? `<section class="sa-dq-proposals"><div class="sa-dq-section-title"><span>Pressure engines</span><b>${state.proposals.length}</b></div><div class="sa-dq-proposal-grid">${proposals}</div></section>` : '<div class="sa-dq-empty"><i class="fa-solid fa-bolt"></i><h3>No pressure engine yet</h3><p>Choose a planning angle below. Nothing reaches the story until you activate an engine.</p></div>'}`;
}
