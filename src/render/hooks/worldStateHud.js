/**
 * render/hooks/worldStateHud.js — World State HUD render hook.
 *
 * Transforms .ws-hud-data containers (built by modes/sidecar.js's
 * buildSidecarDisplayData from the World State template) into a styled HUD:
 *   - Location line (subtle, standalone)
 *   - Stats row: date, clock-face SVG, weather icon (tinted), temperature word
 *
 * Design: stage direction, not dashboard — a quiet environmental annotation
 * that never competes with the narrative below it.
 *
 * Registered as a render hook in index.js; renderer.js calls renderWorldStateHud
 * on every .ws-hud-data element it injects. Self-contained: all styling inline.
 *
 * Ported verbatim from VM's renderers/worldStateHud.js.
 */

// ============================================================================
// WEATHER → ICON + COLOR
// ============================================================================

const WEATHER_DATA = {
    'clear':              { icon: 'fa-sun',                  color: '#D4A053' },
    'sunny':              { icon: 'fa-sun',                  color: '#D4A053' },
    'partly cloudy':      { icon: 'fa-cloud-sun',            color: '#C4A870' },
    'overcast':           { icon: 'fa-cloud',                color: '#8890A0' },
    'cloudy':             { icon: 'fa-cloud',                color: '#8890A0' },
    'light rain':         { icon: 'fa-cloud-rain',           color: '#6A9DC0' },
    'rain':               { icon: 'fa-cloud-rain',           color: '#5A8DB8' },
    'drizzle':            { icon: 'fa-cloud-rain',           color: '#7AAAC8' },
    'heavy rain':         { icon: 'fa-cloud-showers-heavy',  color: '#4A7DA8' },
    'downpour':           { icon: 'fa-cloud-showers-heavy',  color: '#4070A0' },
    'thunderstorm':       { icon: 'fa-bolt',                 color: '#9A7EC0' },
    'storm':              { icon: 'fa-bolt',                 color: '#9070B8' },
    'snow':               { icon: 'fa-snowflake',            color: '#8CB8D8' },
    'light snow':         { icon: 'fa-snowflake',            color: '#A0C8E0' },
    'heavy snow':         { icon: 'fa-snowflake',            color: '#7AA8C8' },
    'blizzard':           { icon: 'fa-snowflake',            color: '#6898B8' },
    'fog':                { icon: 'fa-smog',                 color: '#8A8E98' },
    'mist':               { icon: 'fa-smog',                 color: '#909498' },
    'haze':               { icon: 'fa-smog',                 color: '#8A8E98' },
    'windy':              { icon: 'fa-wind',                 color: '#90A0B0' },
    'breezy':             { icon: 'fa-wind',                 color: '#98A8B8' },
    'clear night':        { icon: 'fa-moon',                 color: '#7888B0' },
    'moonlit night':      { icon: 'fa-cloud-moon',           color: '#8090B0' },
    'starry':             { icon: 'fa-moon',                 color: '#6878A8' },
    'hail':               { icon: 'fa-cloud-showers-heavy',  color: '#6090B0' },
    'sleet':              { icon: 'fa-cloud-rain',           color: '#7098B8' },
};

const DEFAULT_WEATHER = { icon: 'fa-cloud', color: '#8890A0' };

function getWeatherData(weather) {
    const key = (weather ?? '').trim().toLowerCase();
    return WEATHER_DATA[key] || DEFAULT_WEATHER;
}

// ============================================================================
// TEMPERATURE → COLOR
// ============================================================================

const TEMP_COLORS = {
    'freezing':   '#6BA4CC',
    'cold':       '#5DADE2',
    'cool':       '#7FB3D8',
    'mild':       '#A0A8B0',
    'warm':       '#C4956A',
    'hot':        '#D4836A',
    'scorching':  '#C05050',
};

function getTempColor(temp) {
    const key = (temp ?? '').trim().toLowerCase();
    return TEMP_COLORS[key] || '#A0A8B0';
}

// ============================================================================
// CLOCK SVG
// ============================================================================

/** Parse "HH:MM AM/PM" or "HH:MM" (24h) → { hours12, minutes }. */
function parseTime(timeStr) {
    const match = (timeStr ?? '').match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
    if (!match) return { hours12: 12, minutes: 0 };

    let hours = parseInt(match[1], 10);
    const minutes = parseInt(match[2], 10);
    const ampm = (match[3] ?? '').toUpperCase();

    if (ampm === 'PM' && hours < 12) hours += 12;
    if (ampm === 'AM' && hours === 12) hours = 0;

    return { hours12: hours % 12, minutes };
}

/**
 * Build a minimal clock-face SVG: hands, faint ticks at 12/3/6/9, center dot.
 * Sized to sit inline with ~11px text.
 */
function buildClockSVG(timeStr) {
    const { hours12, minutes } = parseTime(timeStr);
    const cx = 10, cy = 10;

    const hourAngle = (hours12 * 30) + (minutes * 0.5);
    const minuteAngle = minutes * 6;

    const handEnd = (angleDeg, length) => {
        const rad = (angleDeg - 90) * (Math.PI / 180);
        return {
            x: (cx + length * Math.cos(rad)).toFixed(1),
            y: (cy + length * Math.sin(rad)).toFixed(1),
        };
    };

    const h = handEnd(hourAngle, 4.2);
    const m = handEnd(minuteAngle, 6.2);

    const ticks = [0, 90, 180, 270].map(deg => {
        const inner = handEnd(deg, 7.2);
        const outer = handEnd(deg, 8.5);
        return `<line x1="${inner.x}" y1="${inner.y}" x2="${outer.x}" y2="${outer.y}" stroke="rgba(180,190,205,0.18)" stroke-width="0.8" stroke-linecap="round"/>`;
    }).join('');

    return `<svg width="14" height="14" viewBox="0 0 20 20" style="vertical-align:middle;flex-shrink:0">`
        + `<circle cx="${cx}" cy="${cy}" r="9" fill="none" stroke="rgba(180,190,205,0.1)" stroke-width="0.6"/>`
        + ticks
        + `<line x1="${cx}" y1="${cy}" x2="${h.x}" y2="${h.y}" stroke="rgba(200,208,220,0.55)" stroke-width="1.6" stroke-linecap="round"/>`
        + `<line x1="${cx}" y1="${cy}" x2="${m.x}" y2="${m.y}" stroke="rgba(200,208,220,0.38)" stroke-width="1.0" stroke-linecap="round"/>`
        + `<circle cx="${cx}" cy="${cy}" r="0.9" fill="rgba(200,208,220,0.4)"/>`
        + `</svg>`;
}

// ============================================================================
// MAIN RENDER FUNCTION
// ============================================================================

/**
 * Transform a .ws-hud-data element into the styled World State HUD.
 *   Line 1 — Location (subtle italic, standalone)
 *   Line 2 — Date · Time · Weather · Temperature (muted metadata row)
 * No container/card/border. Just clean annotative text.
 * @param {HTMLElement} el — the data container element
 */
export function renderWorldStateHud(el) {
    const location = el.dataset.location ?? '';
    const date     = el.dataset.date ?? '';
    const time     = el.dataset.time ?? '';
    const weather  = el.dataset.weather ?? '';
    const temp     = el.dataset.temp ?? '';

    if (!location && !date && !time) return;

    const { icon: weatherIcon, color: weatherColor } = getWeatherData(weather);
    const tempColor = getTempColor(temp);
    const clockSvg = time ? buildClockSVG(time) : '';

    // ── Location line — subtle, italic, standalone ──
    const locationLine = location
        ? `<div style="display:flex;align-items:center;gap:5px;margin-bottom:3px;font-size:11.5px;color:rgba(200,205,215,0.4);font-style:italic;letter-spacing:0.02em">`
            + `<i class="fa-solid fa-location-dot" style="font-size:8px;opacity:0.6"></i>`
            + `<span>${escHtml(location)}</span>`
            + `</div>`
        : '';

    // ── Stats line — muted, compact, mid-dot separators ──
    const parts = [];

    if (date) {
        parts.push(
            `<span style="display:inline-flex;align-items:center;gap:4px">`
            + `<i class="fa-regular fa-calendar" style="font-size:9px;opacity:0.45"></i>`
            + `${escHtml(date)}</span>`,
        );
    }
    if (time) {
        parts.push(
            `<span style="display:inline-flex;align-items:center;gap:2px">`
            + `${clockSvg}`
            + `<span>${escHtml(time)}</span></span>`,
        );
    }
    if (weather) {
        parts.push(
            `<span style="display:inline-flex;align-items:center;gap:4px">`
            + `<i class="fa-solid ${weatherIcon}" style="font-size:10px;color:${weatherColor};opacity:0.5"></i>`
            + `${escHtml(weather)}</span>`,
        );
    }
    if (temp) {
        parts.push(
            `<span style="color:${tempColor};opacity:0.65">${escHtml(temp)}</span>`,
        );
    }

    const dot = '<span style="opacity:0.2;margin:0 1px">·</span>';
    const statsLine = parts.length > 0
        ? `<div style="display:flex;align-items:center;gap:6px;font-size:10.5px;color:rgba(200,205,215,0.32);flex-wrap:wrap;line-height:1.5">`
            + parts.join(dot)
            + `</div>`
        : '';

    // ── Assemble ──
    const hud = document.createElement('div');
    hud.className = 'ws-hud-rendered';
    hud.style.cssText = 'margin:0 0 10px;padding:0;font-family:system-ui,-apple-system,sans-serif';
    hud.innerHTML = locationLine + statsLine;

    el.replaceWith(hud);
}

// ============================================================================
// HELPERS
// ============================================================================

function escHtml(str) {
    const div = document.createElement('div');
    div.textContent = str ?? '';
    return div.innerHTML;
}
