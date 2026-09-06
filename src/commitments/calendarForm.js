/** Profile-driven Calendar composer and setting-neutral record translation. */

function esc(value) {
    return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function options(values, labels) {
    return values.map(value => `<option value="${value}">${esc(labels?.[value] || value)}</option>`).join('');
}

export function calendarFormMarkup(surface = {}) {
    const c = surface.copy || {};
    const types = ['appointment', 'promise', 'deadline', 'reminder', 'availability', 'obligation'];
    const kinds = ['exact', 'relative', 'window', 'recurring', 'anchor', 'unscheduled'];
    const statuses = ['scheduled', 'postponed', 'completed', 'missed', 'cancelled'];
    return `
        <form class="sa-calendar-form" hidden>
            <div class="sa-calendar-form-heading">
                <div><small>${esc(c.formEyebrow || 'COMMITMENT')}</small><strong class="sa-calendar-form-title">${esc(c.addTitle || 'Add to Calendar')}</strong></div>
                <button class="sa-calendar-form-cancel" data-no-drag type="button" title="${esc(c.closeEditor || 'Close editor')}"><i class="fa-solid fa-xmark"></i></button>
            </div>
            <label class="sa-calendar-field sa-calendar-field--wide"><span>${esc(c.title || 'Title')}</span><input name="title" data-no-drag maxlength="240" required placeholder="${esc(c.titlePlaceholder || '')}" /></label>
            <div class="sa-calendar-form-grid">
                <label class="sa-calendar-field"><span>${esc(c.kind || 'Kind')}</span><select name="type" data-no-drag>${options(types, surface.typeLabels)}</select></label>
                <label class="sa-calendar-field"><span>${esc(c.timeExpression || 'Time expression')}</span><select name="timeKind" data-no-drag>${options(kinds, surface.timeKindLabels)}</select></label>
            </div>
            <div class="sa-calendar-time-fields sa-calendar-time-fields--exact" data-time-fields="exact">
                <label class="sa-calendar-field"><span>${esc(c.calendarSystem || 'Calendar system')}</span><select name="exactMode" data-no-drag><option value="gregorian">${esc(c.gregorian || 'Gregorian')}</option><option value="local">${esc(c.storyCalendar || 'Story / local calendar')}</option></select></label>
                <label class="sa-calendar-field" data-exact-field="calendarId" hidden><span>${esc(c.calendarSystem || 'Calendar system')}</span><input name="calendarId" data-no-drag maxlength="80" placeholder="setting-calendar" /></label>
                <label class="sa-calendar-field" data-exact-field="gregorianDate"><span>${esc(c.date || 'Date')}</span><input name="date" data-no-drag type="date" /></label>
                <label class="sa-calendar-field" data-exact-field="localDate" hidden><span>${esc(c.date || 'Date')}</span><input name="localDate" data-no-drag maxlength="120" placeholder="${esc(c.datePlaceholder || '')}" /></label>
                <label class="sa-calendar-field" data-exact-field="gregorianClock"><span>${esc(c.time || 'Time')}</span><input name="clock" data-no-drag type="time" /></label>
                <label class="sa-calendar-field" data-exact-field="localClock" hidden><span>${esc(c.time || 'Time')}</span><input name="localClock" data-no-drag maxlength="80" placeholder="${esc(c.timePlaceholder || '')}" /></label>
                <label class="sa-calendar-field sa-calendar-field--wide" data-exact-field="label"><span>${esc(c.authoredLabel || 'Display label')}</span><input name="timeLabel" data-no-drag maxlength="240" placeholder="${esc(c.authoredLabelPlaceholder || '')}" /></label>
            </div>
            <div class="sa-calendar-time-fields" data-time-fields="relative" hidden>
                <label class="sa-calendar-field"><span>${esc(c.amount || 'Amount')}</span><input name="amount" data-no-drag type="number" min="0" max="100000" value="1" /></label>
                <label class="sa-calendar-field"><span>${esc(c.unit || 'Unit')}</span><select name="unit" data-no-drag><option>minutes</option><option>hours</option><option selected>days</option><option>weeks</option><option>months</option><option>seasons</option><option>years</option></select></label>
                <label class="sa-calendar-field"><span>${esc(c.relation || 'Relation')}</span><select name="relation" data-no-drag><option value="after">${esc(c.after || 'After')}</option><option value="before">${esc(c.before || 'Before')}</option></select></label>
                <label class="sa-calendar-field"><span>${esc(c.anchor || 'Anchor')}</span><input name="relativeAnchor" data-no-drag maxlength="240" placeholder="${esc(c.relativeAnchorPlaceholder || '')}" /></label>
            </div>
            <div class="sa-calendar-time-fields" data-time-fields="window" hidden>
                <label class="sa-calendar-field"><span>${esc(c.windowOpens || 'Window opens')}</span><input name="startLabel" data-no-drag maxlength="160" placeholder="${esc(c.windowStartPlaceholder || '')}" /></label>
                <label class="sa-calendar-field"><span>${esc(c.windowCloses || 'Window closes')}</span><input name="endLabel" data-no-drag maxlength="160" placeholder="${esc(c.windowEndPlaceholder || '')}" /></label>
            </div>
            <div class="sa-calendar-time-fields sa-calendar-time-fields--single" data-time-fields="recurring" hidden>
                <label class="sa-calendar-field"><span>${esc(c.pattern || 'Pattern')}</span><input name="rule" data-no-drag maxlength="240" placeholder="${esc(c.patternPlaceholder || '')}" /></label>
                <label class="sa-calendar-field"><span>${esc(c.nextOccurrence || 'Next occurrence')}</span><input name="nextLabel" data-no-drag maxlength="160" placeholder="${esc(c.nextPlaceholder || '')}" /></label>
            </div>
            <div class="sa-calendar-time-fields" data-time-fields="anchor" hidden>
                <label class="sa-calendar-field"><span>${esc(c.relation || 'Relation')}</span><select name="anchorRelation" data-no-drag><option value="after">${esc(c.after || 'After')}</option><option value="before">${esc(c.before || 'Before')}</option></select></label>
                <label class="sa-calendar-field"><span>${esc(c.storyEvent || 'Story event')}</span><input name="anchorLabel" data-no-drag maxlength="240" placeholder="${esc(c.storyEventPlaceholder || '')}" /></label>
            </div>
            <div class="sa-calendar-time-fields sa-calendar-time-fields--single" data-time-fields="unscheduled" hidden>
                <label class="sa-calendar-field"><span>${esc(c.trigger || 'Trigger or condition')}</span><input name="trigger" data-no-drag maxlength="240" placeholder="${esc(c.triggerPlaceholder || '')}" /></label>
            </div>
            <div class="sa-calendar-form-grid">
                <label class="sa-calendar-field"><span>${esc(c.participants || 'Participants')}</span><input name="participants" data-no-drag maxlength="800" placeholder="${esc(c.participantsPlaceholder || '')}" /></label>
                <label class="sa-calendar-field"><span>${esc(c.location || 'Location')}</span><input name="location" data-no-drag maxlength="240" placeholder="${esc(c.optional || 'Optional')}" /></label>
            </div>
            <div class="sa-calendar-form-grid sa-calendar-form-grid--footer">
                <label class="sa-calendar-field"><span>${esc(c.visibility || 'Visibility')}</span><select name="visibility" data-no-drag><option value="persona">${esc(c.personaOnly || 'Persona only')}</option><option value="shared">${esc(c.sharedCircle || 'Shared circle')}</option><option value="public">${esc(c.public || 'Public')}</option></select></label>
                <label class="sa-calendar-field"><span>${esc(c.status || 'Status')}</span><select name="status" data-no-drag>${options(statuses, surface.statusLabels)}</select></label>
            </div>
            <label class="sa-calendar-field sa-calendar-field--wide"><span>${esc(c.notes || 'Notes')}</span><textarea name="notes" data-no-drag maxlength="2000" placeholder="${esc(c.notesPlaceholder || '')}"></textarea></label>
            <input name="commitmentId" type="hidden" />
            <button class="sa-calendar-form-save" data-no-drag type="submit"><i class="fa-solid fa-check"></i><span>${esc(c.save || 'Save commitment')}</span></button>
        </form>`;
}

export function reconcileCalendarTimeFields(form) {
    const kind = form?.elements?.timeKind?.value || 'exact';
    form?.querySelectorAll('[data-time-fields]').forEach(group => { group.hidden = group.dataset.timeFields !== kind; });
    const local = form?.elements?.exactMode?.value === 'local';
    form?.querySelectorAll('[data-exact-field]').forEach(field => {
        const name = field.dataset.exactField;
        field.hidden = local
            ? ['gregorianDate', 'gregorianClock'].includes(name)
            : !['gregorianDate', 'gregorianClock', 'label'].includes(name);
    });
}

export function resetCalendarForm(form, surface = {}) {
    if (!form) return;
    form.reset();
    form.elements.commitmentId.value = '';
    form.elements.amount.value = '1';
    form.elements.relativeAnchor.value = 'now';
    form.querySelector('.sa-calendar-form-title').textContent = surface.copy?.addTitle || 'Add to Calendar';
    reconcileCalendarTimeFields(form);
}

export function fillCalendarForm(form, commitment, surface = {}) {
    if (!form || !commitment) return;
    resetCalendarForm(form, surface);
    const time = commitment.time || {};
    const localExact = time.kind === 'exact' && time.calendarId && time.calendarId !== 'gregorian';
    const values = {
        commitmentId: commitment.id, title: commitment.title, type: commitment.type,
        timeKind: time.kind, exactMode: localExact ? 'local' : 'gregorian',
        calendarId: localExact ? time.calendarId : '', date: localExact ? '' : time.date,
        localDate: localExact ? time.date : '', clock: localExact ? '' : time.clock,
        localClock: localExact ? time.clock : '', timeLabel: time.label,
        amount: time.amount, unit: time.unit, relation: time.relation,
        relativeAnchor: time.anchorLabel, startLabel: time.startLabel, endLabel: time.endLabel,
        rule: time.rule, nextLabel: time.nextLabel, anchorRelation: time.relation,
        anchorLabel: time.anchorLabel, trigger: time.trigger,
        participants: commitment.participants?.join(', '), location: commitment.location,
        visibility: commitment.visibility, status: commitment.status, notes: commitment.notes,
    };
    for (const [name, value] of Object.entries(values)) {
        if (form.elements[name] && value != null) form.elements[name].value = String(value);
    }
    form.querySelector('.sa-calendar-form-title').textContent = surface.copy?.editTitle || 'Edit Commitment';
    reconcileCalendarTimeFields(form);
}

export function readCalendarForm(form) {
    const data = new FormData(form);
    const value = name => String(data.get(name) || '').trim();
    const kind = value('timeKind') || 'exact';
    let time;
    if (kind === 'exact') {
        const local = value('exactMode') === 'local';
        time = {
            kind,
            calendarId: local ? (value('calendarId') || 'local') : 'gregorian',
            date: local ? value('localDate') : value('date'),
            clock: local ? value('localClock') : value('clock'),
            label: value('timeLabel'),
        };
    } else if (kind === 'relative') {
        time = { kind, amount: Number(value('amount') || 1), unit: value('unit'), relation: value('relation'), anchorLabel: value('relativeAnchor') || 'now' };
    } else if (kind === 'window') {
        time = { kind, startLabel: value('startLabel'), endLabel: value('endLabel') };
    } else if (kind === 'recurring') {
        time = { kind, rule: value('rule'), nextLabel: value('nextLabel') };
    } else if (kind === 'anchor') {
        time = { kind, relation: value('anchorRelation'), anchorLabel: value('anchorLabel') };
    } else {
        time = { kind: 'unscheduled', trigger: value('trigger') };
    }
    return {
        id: value('commitmentId'), title: value('title'), type: value('type'), status: value('status'),
        participants: value('participants').split(',').map(item => item.trim()).filter(Boolean),
        location: value('location'), visibility: value('visibility'), notes: value('notes'), time,
    };
}
