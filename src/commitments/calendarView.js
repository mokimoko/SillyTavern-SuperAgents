/** Calendar list rendering kept separate from panel lifecycle and persistence. */

import { formatTimeExpression } from './timeExpressions.js';

export function escapeCalendarText(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

function typeLabel(type, surface) {
    return surface?.typeLabels?.[type] || surface?.typeLabels?.fallback || 'Commitment';
}

function statusLabel(status, surface) {
    return surface?.statusLabels?.[status]
        || (status ? `${status[0].toUpperCase()}${status.slice(1)}` : 'Scheduled');
}

function dateToken(commitment) {
    const time = commitment.time || {};
    if (time.kind === 'exact' && time.calendarId === 'gregorian') {
        const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(time.date || '');
        if (match) {
            const month = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'][Number(match[2]) - 1];
            return `<span class="sa-calendar-date-token"><small>${month}</small><strong>${Number(match[3])}</strong></span>`;
        }
    }
    const icon = time.kind === 'recurring' ? 'fa-arrows-rotate'
        : time.kind === 'relative' ? 'fa-hourglass-half'
            : time.kind === 'window' ? 'fa-left-right'
                : time.kind === 'anchor' ? 'fa-link'
                    : 'fa-compass';
    return `<span class="sa-calendar-date-token sa-calendar-date-token--symbol"><i class="fa-solid ${icon}"></i></span>`;
}

function statusOptions(selected, surface) {
    return ['scheduled', 'postponed', 'completed', 'missed', 'cancelled']
        .map(status => `<option value="${status}" ${status === selected ? 'selected' : ''}>${escapeCalendarText(statusLabel(status, surface))}</option>`)
        .join('');
}

export function renderCommitmentCard(item, surface) {
    const copy = surface?.copy || {};
    const profileId = surface?.timeProfileId || 'modern';
    const metadata = [
        item.participants.length ? item.participants.join(', ') : '',
        item.location,
    ].filter(Boolean).join(' · ');
    return `
        <article class="sa-calendar-card sa-calendar-card--${item.type} ${item.unread ? 'is-unread' : ''} ${['completed', 'missed', 'cancelled'].includes(item.status) ? 'is-history' : ''}"
                 data-commitment-id="${escapeCalendarText(item.id)}">
            ${dateToken(item)}
            <div class="sa-calendar-card-copy">
                <div class="sa-calendar-card-kicker"><span>${escapeCalendarText(typeLabel(item.type, surface))}</span></div>
                <strong>${escapeCalendarText(item.title)}</strong>
                <time>${escapeCalendarText(formatTimeExpression(item.time, profileId))}</time>
                ${metadata ? `<small>${escapeCalendarText(metadata)}</small>` : ''}
                ${item.lineage?.relation === 'rescheduled-from' ? `<small class="sa-calendar-lineage"><i class="fa-solid fa-arrow-rotate-right" aria-hidden="true"></i> ${escapeCalendarText(String(copy.rescheduledFrom || 'Rescheduled from {title}').replace('{title}', item.lineage.title || item.lineage.commitmentId))}</small>` : ''}
                ${item.notes ? `<p>${escapeCalendarText(item.notes)}</p>` : ''}
                <div class="sa-calendar-card-actions">
                    <label class="sa-calendar-status-control" title="${escapeCalendarText(copy.changeStatus || 'Change status')}">
                        <i class="fa-solid fa-sliders" aria-hidden="true"></i>
                        <select data-no-drag data-action="status" aria-label="${escapeCalendarText(copy.changeStatus || 'Change status')}">${statusOptions(item.status, surface)}</select>
                    </label>
                    <div class="sa-calendar-action-buttons">
                        <button data-no-drag data-action="edit" type="button" title="${escapeCalendarText(copy.edit || 'Edit')}" aria-label="${escapeCalendarText(copy.edit || 'Edit')} ${escapeCalendarText(surface?.entryLabel || 'commitment')}"><i class="fa-solid fa-pen" aria-hidden="true"></i></button>
                        <button data-no-drag data-action="delete" type="button" title="${escapeCalendarText(copy.delete || 'Delete')}" aria-label="${escapeCalendarText(copy.delete || 'Delete')} ${escapeCalendarText(surface?.entryLabel || 'commitment')}"><i class="fa-regular fa-trash-can" aria-hidden="true"></i></button>
                    </div>
                </div>
            </div>
        </article>`;
}

export function filterCommitments(commitments, filter) {
    if (filter === 'upcoming') return commitments.filter(item => ['scheduled', 'postponed'].includes(item.status));
    if (filter === 'history') return commitments.filter(item => ['completed', 'missed', 'cancelled'].includes(item.status));
    return commitments;
}

export function calendarEmptyMarkup(filter, surface) {
    const copy = surface?.copy || {};
    const entry = surface?.entryLabel || 'commitment';
    return `
        <div class="sa-calendar-empty">
            <button class="sa-calendar-empty-mark" data-no-drag data-action="empty-add" type="button" aria-label="${escapeCalendarText(copy.add || `Add ${entry}`)}" title="${escapeCalendarText(copy.add || `Add ${entry}`)}"><i class="fa-regular fa-calendar-check"></i></button>
            <small>${escapeCalendarText(filter === 'history' ? (copy.historyKicker || 'ARCHIVE CLEAR') : (copy.openKicker || 'OPEN SPACE'))}</small>
            <strong>${escapeCalendarText(filter === 'history' ? (copy.historyEmpty || 'No finished business yet.') : (copy.upcomingEmpty || 'Nothing is fixed in time.'))}</strong>
            <p>${escapeCalendarText(copy.emptyBody || 'Record an appointment, promise, deadline, or story-anchored obligation.')}</p>
        </div>`;
}
