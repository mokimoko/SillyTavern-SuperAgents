/** Hidden, validated story-to-Calendar reconciliation directives. */

import { normalizeTimeExpression } from './timeExpressions.js';

export const CALENDAR_RECONCILIATION_TAG = 'SA-CALENDAR';

const DIRECTIVE_RE = /<!--SA-CALENDAR:(\{[\s\S]*?\})-->/g;
const ACTIONS = new Set(['create', 'reschedule']);
const COMMITMENT_TYPES = new Set([
    'appointment',
    'promise',
    'deadline',
    'reminder',
    'availability',
    'obligation',
]);

function cleanText(value, maxLength = 1000) {
    return String(value ?? '').trim().slice(0, maxLength);
}

function meaningfulTime(time) {
    if (!time || typeof time !== 'object' || Array.isArray(time)) return false;
    const normalized = normalizeTimeExpression(time);
    if (normalized.kind === 'exact') return Boolean(normalized.label || normalized.date);
    if (normalized.kind === 'relative') return Boolean(normalized.anchorLabel);
    if (normalized.kind === 'window') return Boolean(normalized.startLabel || normalized.endLabel);
    if (normalized.kind === 'recurring') return Boolean(normalized.rule);
    if (normalized.kind === 'anchor') return Boolean(normalized.anchorLabel);
    return Boolean(normalized.trigger);
}

/** Persistent model contract for one exact, branch-authorized historical record. */
export function buildCalendarReconciliationCue(commitment, grant, originalTime = '', surfaceLabel = 'Calendar') {
    const commitmentId = cleanText(commitment?.id, 160);
    const token = cleanText(grant?.token, 200);
    if (!commitmentId || !token) return '';
    const target = JSON.stringify(commitmentId);
    const authorization = JSON.stringify(token);
    const title = JSON.stringify(cleanText(commitment?.title, 240) || 'Untitled commitment');
    const prior = cleanText(originalTime, 300);
    return [
        '<calendar_story_reconciliation persistent="true">',
        `${surfaceLabel} is awaiting a possible replacement for the historical ${commitment.status} commitment ${title}${prior ? ` (${prior})` : ''}.`,
        'This authorization remains active across a short multi-turn negotiation. Suggestions, questions, tentative requests, and pending approval are not replacements.',
        `If this response canonically establishes or confirms a concrete replacement plan—or the recent visible conversation already established one that ${surfaceLabel} has not captured—append one hidden directive after the prose. Do not mention the directive.`,
        `<!--SA-CALENDAR:{"action":"reschedule","commitmentId":${target},"grant":${authorization},"time":{"kind":"relative","amount":2,"unit":"days","relation":"after","anchorLabel":"now","label":"two days from now"}}-->`,
        'Replace the example time with only what canon establishes. Use exact(calendarId/date/clock/label), relative(amount/unit/relation/anchorLabel/label), window(startLabel/endLabel), recurring(rule/nextLabel), anchor(relation/anchorLabel), or unscheduled(trigger). Add title, type, participants, location, visibility, or notes only when the replacement canon establishes them.',
        'Never translate a fictional or non-Gregorian date into Gregorian. Do not emit for an unchanged plan or infer missing agreement. The original record remains historical; the directive creates one linked successor.',
        '</calendar_story_reconciliation>',
    ].join('\n');
}

/** Low-pressure watcher retained after the active negotiation window closes. */
export function buildDormantCalendarReconciliationCue(commitment, grant) {
    const commitmentId = cleanText(commitment?.id, 160);
    const token = cleanText(grant?.token, 200);
    if (!commitmentId || !token) return '';
    return [
        '<calendar_story_watch dormant="true">',
        `Do not mention, revive, or steer toward the unresolved ${commitment.status} commitment ${JSON.stringify(cleanText(commitment.title, 240))}.`,
        'Only if the current response or recent visible conversation canonically establishes its concrete replacement, append a hidden directive after the prose using the exact identifiers below and replacing the example time with the setting-neutral time actually established:',
        `<!--SA-CALENDAR:{"action":"reschedule","commitmentId":${JSON.stringify(commitmentId)},"grant":${JSON.stringify(token)},"time":{"kind":"anchor","relation":"after","anchorLabel":"the established story anchor"}}-->`,
        'Never emit the example unchanged, infer agreement, or invent missing time details.',
        '</calendar_story_watch>',
    ].join('\n');
}

/** Always-passive contract for capturing a newly established canonical plan. */
export function buildCalendarStoryCreationCue(grant, surfaceLabel = 'Calendar') {
    const token = cleanText(grant?.token, 200);
    if (!token) return '';
    return [
        '<calendar_story_creation persistent="true">',
        `If and only if this response canonically establishes one new persona-visible appointment, promise, deadline, reminder, availability block, or obligation, append one hidden directive after the prose. Never mention it or steer the story toward creating an entry for ${surfaceLabel}.`,
        'Do not capture questions, unaccepted proposals, vague intentions, repeated mentions, private NPC plans, or plans already logged.',
        `<!--SA-CALENDAR:{"action":"create","grant":${JSON.stringify(token)},"title":"","type":"","time":{"kind":"unscheduled","trigger":""}}-->`,
        'Fill only canon-established details. Type is appointment, promise, deadline, reminder, availability, or obligation. Time is exact, relative, window, recurring, anchor, or unscheduled; preserve fictional and non-Gregorian wording.',
        'Emit at most one. Use an awaiting record\'s reschedule authorization for its replacement instead of creating a duplicate.',
        '</calendar_story_creation>',
    ].join('\n');
}

export function normalizeCalendarDirective(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
    const action = cleanText(input.action, 40).toLowerCase();
    if (!ACTIONS.has(action) || !meaningfulTime(input.time)) return null;
    const commitmentId = cleanText(input.commitmentId, 160);
    const grant = cleanText(input.grant, 200);
    const title = cleanText(input.title, 240);
    const requestedType = cleanText(input.type, 40);
    const type = COMMITMENT_TYPES.has(requestedType) ? requestedType : '';
    if (action === 'create' && (!grant || !title || !type)) return null;
    if (action === 'reschedule' && (!commitmentId || !grant)) return null;
    return {
        action,
        commitmentId,
        grant,
        title,
        type,
        time: normalizeTimeExpression(input.time),
        participants: Array.isArray(input.participants)
            ? input.participants.map(value => cleanText(value, 120)).filter(Boolean).slice(0, 16)
            : [],
        location: cleanText(input.location, 240),
        visibility: cleanText(input.visibility, 40),
        notes: cleanText(input.notes, 2000),
    };
}

/** Parse valid directives and remove every Calendar directive from visible prose. */
export function parseCalendarDirectives(text) {
    const source = String(text ?? '');
    const directives = [];
    for (const match of source.matchAll(DIRECTIVE_RE)) {
        try {
            const directive = normalizeCalendarDirective(JSON.parse(match[1]));
            if (directive) directives.push(directive);
        } catch {
            // Invalid model output is stripped but never reaches Calendar state.
        }
    }
    return {
        directives,
        cleanText: source.replace(DIRECTIVE_RE, '').replace(/\n{3,}/g, '\n\n').trimEnd(),
    };
}
