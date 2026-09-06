/** Setting-neutral time expressions and presentation profiles for Commitments. */

export const TIME_EXPRESSION_KINDS = Object.freeze([
    'exact',
    'relative',
    'window',
    'recurring',
    'anchor',
    'unscheduled',
]);

const TIME_UNITS = new Set(['minutes', 'hours', 'days', 'weeks', 'months', 'seasons', 'years']);
const RELATIONS = new Set(['after', 'before']);

function cleanText(value, maxLength = 240) {
    return String(value ?? '').trim().slice(0, maxLength);
}

function finiteNumber(value, fallback = null) {
    if (value === null || value === undefined || value === '') return fallback;
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

export function normalizeTimeExpression(input = {}) {
    const requestedKind = cleanText(input.kind ?? input.type, 40).toLowerCase();
    const kind = TIME_EXPRESSION_KINDS.includes(requestedKind) ? requestedKind : 'unscheduled';
    const orderKey = finiteNumber(input.orderKey);
    const common = {
        kind,
        calendarId: cleanText(input.calendarId, 80) || (kind === 'exact' ? 'gregorian' : ''),
        label: cleanText(input.label, 240),
        orderKey,
    };

    if (kind === 'exact') {
        return {
            ...common,
            date: cleanText(input.date, 120),
            clock: cleanText(input.clock ?? input.time, 80),
            precision: ['minute', 'hour', 'day', 'month', 'season', 'year'].includes(input.precision)
                ? input.precision
                : (input.clock || input.time ? 'minute' : 'day'),
        };
    }

    if (kind === 'relative') {
        return {
            ...common,
            amount: Math.max(0, Math.min(100000, finiteNumber(input.amount, 1))),
            unit: TIME_UNITS.has(input.unit) ? input.unit : 'days',
            relation: RELATIONS.has(input.relation) ? input.relation : 'after',
            anchorId: cleanText(input.anchorId, 160),
            anchorLabel: cleanText(input.anchorLabel, 240) || 'now',
        };
    }

    if (kind === 'window') {
        return {
            ...common,
            startLabel: cleanText(input.startLabel, 160),
            endLabel: cleanText(input.endLabel, 160),
        };
    }

    if (kind === 'recurring') {
        return {
            ...common,
            rule: cleanText(input.rule, 240),
            nextLabel: cleanText(input.nextLabel, 160),
        };
    }

    if (kind === 'anchor') {
        return {
            ...common,
            relation: RELATIONS.has(input.relation) ? input.relation : 'after',
            anchorId: cleanText(input.anchorId, 160),
            anchorLabel: cleanText(input.anchorLabel, 240),
        };
    }

    return {
        ...common,
        trigger: cleanText(input.trigger, 240),
    };
}

function sentenceCase(value) {
    const text = cleanText(value, 300);
    return text ? `${text[0].toUpperCase()}${text.slice(1)}` : '';
}

function formatGregorianDate(date, clock = '') {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ''));
    if (!match) return [date, clock].filter(Boolean).join(' · ');
    const [, year, month, day] = match;
    const monthName = [
        'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
        'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
    ][Number(month) - 1];
    let clockLabel = cleanText(clock, 80);
    const clockMatch = /^(\d{2}):(\d{2})$/.exec(clockLabel);
    if (clockMatch) {
        const hour = Number(clockMatch[1]);
        const minute = clockMatch[2];
        clockLabel = `${hour % 12 || 12}:${minute} ${hour >= 12 ? 'PM' : 'AM'}`;
    }
    return [`${monthName || month} ${Number(day)}, ${year}`, clockLabel].filter(Boolean).join(' · ');
}

function formatNeutral(expression) {
    const value = normalizeTimeExpression(expression);
    if (value.label) return value.label;
    if (value.kind === 'exact') {
        const formatted = value.calendarId === 'gregorian'
            ? formatGregorianDate(value.date, value.clock)
            : [value.date, value.clock].filter(Boolean).join(' · ');
        return formatted || 'Date not fixed';
    }
    if (value.kind === 'relative') {
        const unit = value.amount === 1 ? value.unit.replace(/s$/, '') : value.unit;
        return sentenceCase(`${value.amount} ${unit} ${value.relation} ${value.anchorLabel}`);
    }
    if (value.kind === 'window') {
        return [value.startLabel, value.endLabel].filter(Boolean).join(' → ') || 'Within a story window';
    }
    if (value.kind === 'recurring') {
        return value.nextLabel ? `${value.rule || 'Recurring'} · next ${value.nextLabel}` : value.rule || 'Recurring';
    }
    if (value.kind === 'anchor') {
        return sentenceCase(`${value.relation} ${value.anchorLabel || 'a story event'}`);
    }
    return value.trigger || 'Time not fixed';
}

const PROFILES = Object.freeze({
    modern: Object.freeze({
        id: 'modern',
        label: 'Modern Calendar',
        surfaceLabel: 'Calendar',
        entryLabel: 'commitment',
        icon: 'fa-calendar-day',
        capabilities: Object.freeze({
            exact: true,
            relative: true,
            window: true,
            recurring: true,
            anchor: true,
            unscheduled: true,
            minutePrecision: true,
        }),
        formatTime: formatNeutral,
    }),
    'cute-retro': Object.freeze({
        id: 'cute-retro',
        label: 'Cute Retro Planner',
        surfaceLabel: 'Planner',
        entryLabel: 'plan',
        icon: 'fa-calendar-week',
        capabilities: Object.freeze({
            exact: true,
            relative: true,
            window: true,
            recurring: true,
            anchor: true,
            unscheduled: true,
            minutePrecision: true,
        }),
        formatTime: formatNeutral,
    }),
    'retro-pc': Object.freeze({
        id: 'retro-pc',
        label: 'Retro Analog Organizer',
        surfaceLabel: 'Organizer',
        entryLabel: 'item',
        icon: 'fa-calendar-days',
        capabilities: Object.freeze({
            exact: true,
            relative: true,
            window: true,
            recurring: true,
            anchor: true,
            unscheduled: true,
            minutePrecision: true,
        }),
        formatTime: formatNeutral,
    }),
    'game-ui': Object.freeze({
        id: 'game-ui',
        label: 'Gamer Modern Event Tracker',
        surfaceLabel: 'Event Tracker',
        entryLabel: 'tracked event',
        icon: 'fa-map-location-dot',
        capabilities: Object.freeze({
            exact: true,
            relative: true,
            window: true,
            recurring: true,
            anchor: true,
            unscheduled: true,
            minutePrecision: true,
        }),
        formatTime: formatNeutral,
    }),
    'grounded-historical': Object.freeze({
        id: 'grounded-historical',
        label: 'Grounded Historical Engagement Book',
        surfaceLabel: 'Engagement Book',
        entryLabel: 'engagement',
        icon: 'fa-book-open',
        capabilities: Object.freeze({
            exact: true,
            relative: true,
            window: true,
            recurring: true,
            anchor: true,
            unscheduled: true,
            minutePrecision: false,
        }),
        formatTime: formatNeutral,
    }),
    'mythic-fantasy': Object.freeze({
        id: 'mythic-fantasy',
        label: 'Historical Fantasy Almanac',
        surfaceLabel: 'Almanac',
        entryLabel: 'entry',
        icon: 'fa-book-open',
        capabilities: Object.freeze({
            exact: true,
            relative: true,
            window: true,
            recurring: true,
            anchor: true,
            unscheduled: true,
            minutePrecision: false,
        }),
        formatTime: formatNeutral,
    }),
    xianxia: Object.freeze({
        id: 'xianxia',
        label: 'Xianxia Seasonal Register',
        surfaceLabel: 'Seasonal Register',
        entryLabel: 'entry',
        icon: 'fa-calendar-days',
        capabilities: Object.freeze({
            exact: true,
            relative: true,
            window: true,
            recurring: true,
            anchor: true,
            unscheduled: true,
            minutePrecision: false,
        }),
        formatTime: formatNeutral,
    }),
    'post-apocalyptic': Object.freeze({
        id: 'post-apocalyptic',
        label: 'Post-Apocalyptic Field Log',
        surfaceLabel: 'Field Log',
        entryLabel: 'log entry',
        icon: 'fa-clipboard-list',
        capabilities: Object.freeze({
            exact: true,
            relative: true,
            window: true,
            recurring: true,
            anchor: true,
            unscheduled: true,
            minutePrecision: false,
        }),
        formatTime: formatNeutral,
    }),
    'near-future': Object.freeze({
        id: 'near-future',
        label: 'Near Future Timeline',
        surfaceLabel: 'Timeline',
        entryLabel: 'timeline item',
        icon: 'fa-timeline',
        capabilities: Object.freeze({
            exact: true,
            relative: true,
            window: true,
            recurring: true,
            anchor: true,
            unscheduled: true,
            minutePrecision: true,
        }),
        formatTime: formatNeutral,
    }),
    almanac: Object.freeze({
        id: 'almanac',
        label: 'Almanac Reference',
        surfaceLabel: 'Almanac',
        entryLabel: 'obligation',
        icon: 'fa-book-open',
        capabilities: Object.freeze({
            exact: true,
            relative: true,
            window: true,
            recurring: true,
            anchor: true,
            unscheduled: true,
            minutePrecision: false,
        }),
        // This reference profile deliberately preserves authored local-calendar
        // labels instead of translating them into Gregorian dates.
        formatTime: formatNeutral,
    }),
});

export function listCommitmentProfiles() {
    return Object.values(PROFILES).map(profile => ({
        id: profile.id,
        label: profile.label,
        surfaceLabel: profile.surfaceLabel,
        entryLabel: profile.entryLabel,
        icon: profile.icon,
        capabilities: { ...profile.capabilities },
    }));
}

export function getCommitmentProfile(profileId = 'modern') {
    const requested = profileId === 'retro-analog' ? 'cute-retro' : profileId;
    return PROFILES[requested] || PROFILES.modern;
}

export function formatTimeExpression(expression, profileId = 'modern') {
    return getCommitmentProfile(profileId).formatTime(expression);
}

export function timeExpressionOrder(expression) {
    const value = normalizeTimeExpression(expression);
    if (value.orderKey != null) return value.orderKey;
    if (value.kind === 'exact' && value.calendarId === 'gregorian' && /^\d{4}-\d{2}-\d{2}$/.test(value.date)) {
        const clock = /^\d{2}:\d{2}$/.test(value.clock) ? value.clock : '23:59';
        const timestamp = Date.parse(`${value.date}T${clock}:00Z`);
        if (Number.isFinite(timestamp)) return timestamp;
    }
    return Number.POSITIVE_INFINITY;
}
