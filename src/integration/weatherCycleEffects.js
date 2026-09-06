/** SuperAgents-owned time lighting layered inside Weather Cycle's visual host. */

import { getGlobalSettings, setGlobalSettings } from '../data/store.js';

const WEATHER_PREFIX = 'st-weather-cycle';
const OVERLAY_ID = 'sa-weather-cycle-phase-overlay';
const SETTINGS_GROUP_ID = 'sa-weather-cycle-lighting-settings';
const WEATHER_STORAGE_KEY = 'st-weather-cycle-settings';
const CSS_HREF = '/scripts/extensions/third-party/SillyTavern-SuperAgents/src/integration/weatherCycleEffects.css?v=0.42.7';

const CUSTOM_PHASES = Object.freeze([
    { value: 'afternoon', label: 'Afternoon', before: 'evening' },
    { value: 'twilight', label: 'Twilight', before: 'night' },
]);

const PHASE_SETTING_FIELDS = Object.freeze([
    { key: 'weatherCycleAfternoonSkyColor', id: 'sa-weather-cycle-afternoon-sky', label: 'Afternoon Sky', type: 'color' },
    { key: 'weatherCycleAfternoonGlowColor', id: 'sa-weather-cycle-afternoon-glow', label: 'Afternoon Glow', type: 'color' },
    { key: 'weatherCycleAfternoonIntensity', id: 'sa-weather-cycle-afternoon-intensity', label: 'Afternoon Strength', type: 'range' },
    { key: 'weatherCycleTwilightSkyColor', id: 'sa-weather-cycle-twilight-sky', label: 'Twilight Sky', type: 'color' },
    { key: 'weatherCycleTwilightGlowColor', id: 'sa-weather-cycle-twilight-glow', label: 'Twilight Glow', type: 'color' },
    { key: 'weatherCycleTwilightIntensity', id: 'sa-weather-cycle-twilight-intensity', label: 'Twilight Strength', type: 'range' },
]);

function normalized(value) {
    return String(value ?? '').trim().toLowerCase();
}

function clamp(value, min = 0, max = 1) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : min;
}

function hexToRgba(hex, alpha) {
    const clean = String(hex ?? '').replace('#', '');
    const value = /^[\da-f]{6}$/i.test(clean) ? Number.parseInt(clean, 16) : 0;
    return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${clamp(alpha)})`;
}

function injectStylesheet() {
    let link = document.querySelector('link[data-sa-weather-cycle-effects]');
    if (!link) {
        link = document.createElement('link');
        link.rel = 'stylesheet';
        link.setAttribute('data-sa-weather-cycle-effects', '');
        document.head.appendChild(link);
    }
    link.href = CSS_HREF;
}

export function isWeatherCycleEnabled() {
    const control = document.getElementById(`${WEATHER_PREFIX}-enabled`)
        || document.getElementById(`${WEATHER_PREFIX}-floating-enabled`);
    return !!control?.checked;
}

function getWeatherControl(name) {
    return document.getElementById(`${WEATHER_PREFIX}-${name}`)
        || document.getElementById(`${WEATHER_PREFIX}-floating-${name}`);
}

function getWeatherControls(name) {
    return [
        document.getElementById(`${WEATHER_PREFIX}-${name}`),
        document.getElementById(`${WEATHER_PREFIX}-floating-${name}`),
    ].filter(Boolean);
}

function readPersistedTime() {
    try {
        return normalized(globalThis.localStorage?.getItem(WEATHER_STORAGE_KEY)
            ? JSON.parse(globalThis.localStorage.getItem(WEATHER_STORAGE_KEY)).time
            : '');
    } catch {
        return '';
    }
}

function ensureCustomTimeOptions(select) {
    for (const phase of CUSTOM_PHASES) {
        let option = select.querySelector(`option[value="${phase.value}"]`);
        if (!option) {
            option = document.createElement('option');
            option.value = phase.value;
            option.textContent = phase.label;
        }
        const anchor = select.querySelector(`option[value="${phase.before}"]`);
        if (option.nextElementSibling !== anchor) select.insertBefore(option, anchor);
    }
}

function renameTimeControl(select) {
    const label = select.closest('label')?.querySelector('span');
    if (label && ['time', 'lighting'].includes(normalized(label.textContent))) {
        label.textContent = 'Lighting';
    }
}

function settingRow(field) {
    if (field.type === 'color') {
        return `<label class="${WEATHER_PREFIX}-settings-row"><span>${field.label}</span>`
            + `<input type="color" id="${field.id}"></label>`;
    }
    return `<label class="${WEATHER_PREFIX}-settings-row ${WEATHER_PREFIX}-slider-row">`
        + `<span>${field.label}</span><div class="${WEATHER_PREFIX}-slider-with-number">`
        + `<input type="range" id="${field.id}" min="0" max="1" step="0.01">`
        + `<input type="number" id="${field.id}-number" min="0" max="1" step="0.01">`
        + '</div></label>';
}

function syncPhaseSettingControls() {
    const settings = getGlobalSettings();
    for (const field of PHASE_SETTING_FIELDS) {
        const input = document.getElementById(field.id);
        if (!input) continue;
        input.value = settings[field.key];
        const number = document.getElementById(`${field.id}-number`);
        if (number) number.value = settings[field.key];
    }
}

function bindPhaseSetting(field) {
    const input = document.getElementById(field.id);
    if (!input) return;
    const number = document.getElementById(`${field.id}-number`);
    const commit = raw => {
        const value = field.type === 'range' ? clamp(raw) : String(raw);
        input.value = value;
        if (number) number.value = value;
        setGlobalSettings({ [field.key]: value });
        syncManualWeatherCyclePhaseEffect();
    };
    input.addEventListener('input', () => commit(input.value));
    number?.addEventListener('change', () => commit(number.value));
}

function ensurePhaseSettingsUi() {
    if (document.getElementById(SETTINGS_GROUP_ID)) {
        syncPhaseSettingControls();
        return;
    }
    const content = document.querySelector(`#${WEATHER_PREFIX}-settings .${WEATHER_PREFIX}-settings-content`);
    if (!content) return;

    const group = document.createElement('details');
    group.id = SETTINGS_GROUP_ID;
    group.className = `${WEATHER_PREFIX}-settings-group`;
    group.open = true;
    group.innerHTML = `<summary class="${WEATHER_PREFIX}-group-title">SuperAgents Lighting</summary>`
        + '<p class="sa-weather-cycle-settings-note">Colors for the extra Afternoon and Twilight phases.</p>'
        + PHASE_SETTING_FIELDS.map(settingRow).join('')
        + '<button type="button" id="sa-weather-cycle-lighting-reset">Reset SuperAgents Lighting</button>';
    const actions = content.querySelector(`.${WEATHER_PREFIX}-settings-actions`);
    content.insertBefore(group, actions);

    for (const field of PHASE_SETTING_FIELDS) bindPhaseSetting(field);
    document.getElementById('sa-weather-cycle-lighting-reset')?.addEventListener('click', () => {
        setGlobalSettings({
            weatherCycleAfternoonSkyColor: '#ffe09d',
            weatherCycleAfternoonGlowColor: '#e59548',
            weatherCycleAfternoonIntensity: 0.18,
            weatherCycleTwilightSkyColor: '#3e4989',
            weatherCycleTwilightGlowColor: '#ee8053',
            weatherCycleTwilightIntensity: 0.20,
        });
        syncPhaseSettingControls();
        syncManualWeatherCyclePhaseEffect();
    });
    syncPhaseSettingControls();
}

export function syncWeatherCycleCompatibilityUi() {
    const controls = getWeatherControls('time');
    for (const control of controls) {
        ensureCustomTimeOptions(control);
        renameTimeControl(control);
    }

    // Weather Cycle may have restored a custom persisted value before our
    // options existed, which leaves the native selects blank. Restore it once
    // the matching options have been added.
    const persisted = readPersistedTime();
    if (CUSTOM_PHASES.some(phase => phase.value === persisted)) {
        for (const control of controls) control.value = persisted;
    }
    ensurePhaseSettingsUi();
}

export function syncWeatherCyclePhaseBadge(phase = null) {
    const badge = document.getElementById(`${WEATHER_PREFIX}-badge`);
    if (!badge) return;
    if (!isWeatherCycleEnabled()) {
        badge.textContent = 'Weather: off';
        return;
    }
    const weather = getWeatherControl('weather')?.value;
    const nativeTime = getWeatherControl('time')?.value;
    if (!weather || !nativeTime) return;
    badge.textContent = `Weather: ${weather} | Lighting: ${phase || nativeTime}`;
}

export function resolveWorldPhaseEffect(timeOfDay, setting) {
    if (normalized(setting) === 'indoors') return null;
    const phase = normalized(timeOfDay);
    if (phase === 'afternoon') return 'afternoon';
    if (phase === 'twilight' || phase === 'dusk') return 'twilight';
    return null;
}

export function clearWeatherCyclePhaseEffect() {
    document.getElementById(OVERLAY_ID)?.remove();
}

export function applyWeatherCyclePhaseEffect(phase) {
    if (!['afternoon', 'twilight'].includes(phase)) {
        clearWeatherCyclePhaseEffect();
        return false;
    }

    const visuals = document.getElementById(`${WEATHER_PREFIX}-visuals`);
    if (!visuals) {
        clearWeatherCyclePhaseEffect();
        return false;
    }

    injectStylesheet();
    let overlay = document.getElementById(OVERLAY_ID);
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = OVERLAY_ID;
        overlay.setAttribute('aria-hidden', 'true');
        visuals.appendChild(overlay);
    }
    overlay.dataset.phase = phase;
    const settings = getGlobalSettings();
    if (phase === 'afternoon') {
        const intensity = clamp(settings.weatherCycleAfternoonIntensity);
        overlay.style.background = [
            `radial-gradient(ellipse at 78% 18%, ${hexToRgba(settings.weatherCycleAfternoonSkyColor, intensity)}, transparent 48%)`,
            `linear-gradient(180deg, ${hexToRgba(settings.weatherCycleAfternoonSkyColor, intensity * 0.28)}, ${hexToRgba(settings.weatherCycleAfternoonGlowColor, intensity * 0.56)})`,
        ].join(', ');
    } else {
        const intensity = clamp(settings.weatherCycleTwilightIntensity);
        overlay.style.background = [
            `radial-gradient(ellipse at 74% 72%, ${hexToRgba(settings.weatherCycleTwilightGlowColor, intensity * 0.75)}, transparent 46%)`,
            `linear-gradient(180deg, ${hexToRgba(settings.weatherCycleTwilightSkyColor, intensity)}, ${hexToRgba(settings.weatherCycleTwilightSkyColor, intensity * 0.7)} 54%, ${hexToRgba(settings.weatherCycleTwilightGlowColor, intensity * 0.55)})`,
        ].join(', ');
    }
    return true;
}

export function syncManualWeatherCyclePhaseEffect() {
    if (!isWeatherCycleEnabled()) {
        clearWeatherCyclePhaseEffect();
        syncWeatherCyclePhaseBadge();
        return null;
    }
    const phase = normalized(getWeatherControl('time')?.value);
    const customPhase = CUSTOM_PHASES.some(item => item.value === phase) ? phase : null;
    applyWeatherCyclePhaseEffect(customPhase);
    syncWeatherCyclePhaseBadge(customPhase);
    return customPhase;
}

export function initWeatherCycleEffects() {
    injectStylesheet();
    syncWeatherCycleCompatibilityUi();
}
