/** Optional World State → st-weather-cycle synchronization. */

import { eventSource, event_types } from '../../../../../../script.js';
import { getAgents, getGlobalSettings, onStoreChange } from '../data/store.js';
import {
    applyWeatherCyclePhaseEffect,
    clearWeatherCyclePhaseEffect,
    initWeatherCycleEffects,
    isWeatherCycleEnabled,
    resolveWorldPhaseEffect,
    syncManualWeatherCyclePhaseEffect,
    syncWeatherCycleCompatibilityUi,
    syncWeatherCyclePhaseBadge,
} from './weatherCycleEffects.js';

const WORLD_STATE_VARIABLE = 'sa_world_state';
const WEATHER_PREFIX = 'st-weather-cycle';
const INITIAL_SYNC_DELAYS = Object.freeze([0, 100, 500, 1000, 2000]);

let initialized = false;
let queued = false;
let forceQueuedSync = false;
let manualOverrideActive = false;
let syncingFromWorldState = false;

function normalized(value) {
    return String(value ?? '').trim().toLowerCase();
}

export function mapWorldWeather(weather) {
    const value = normalized(weather);
    if (!value || value === 'unknown') return null;

    if (['thunderstorm', 'storm'].includes(value)) {
        return { weather: 'rain', lightningEnabled: true };
    }
    if (['light rain', 'rain', 'drizzle', 'heavy rain', 'downpour', 'hail'].includes(value)) {
        return { weather: 'rain', lightningEnabled: false };
    }
    if (['snow', 'light snow', 'heavy snow', 'blizzard', 'sleet'].includes(value)) {
        return { weather: 'snow', lightningEnabled: false };
    }
    if (['fog', 'mist'].includes(value)) {
        return { weather: 'fog', lightningEnabled: false };
    }
    if (value === 'haze') {
        return { weather: 'heat', lightningEnabled: false };
    }

    // Clear/sunny/cloud/wind/night variants have no closer Weather Cycle
    // effect than its neutral "clear" state. Unknown legacy labels are left
    // alone instead of silently guessing.
    if ([
        'clear', 'sunny', 'partly cloudy', 'overcast', 'cloudy',
        'windy', 'breezy', 'clear night', 'moonlit night', 'starry',
    ].includes(value)) {
        return { weather: 'clear', lightningEnabled: false };
    }
    return null;
}

function timeFromClock(clock) {
    const match = String(clock ?? '').trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
    if (!match) return null;
    let hour = Number(match[1]) % 12;
    if (match[3].toUpperCase() === 'PM') hour += 12;
    if (hour >= 5 && hour < 12) return 'morning';
    if (hour >= 12 && hour < 17) return 'day';
    if (hour >= 17 && hour < 21) return 'evening';
    return 'night';
}

export function mapWorldTime(timeOfDay, setting, clock) {
    if (normalized(setting) === 'indoors') return 'indoors';

    const value = normalized(timeOfDay);
    if (['dawn', 'morning'].includes(value)) return 'morning';
    if (value === 'afternoon') return 'afternoon';
    if (['day', 'noon'].includes(value)) return 'day';
    if (value === 'twilight') return 'twilight';
    if (['evening', 'dusk'].includes(value)) return 'evening';
    if (['night', 'late night', 'midnight'].includes(value)) return 'night';
    return timeFromClock(clock);
}

export function isWeatherCycleInstalled() {
    return !!(
        document.getElementById(`${WEATHER_PREFIX}-weather`)
        || document.getElementById(`${WEATHER_PREFIX}-floating-weather`)
    );
}

function findEligibleWorldStateAgent() {
    return getAgents().find(agent => agent.enabled
        && agent.mergeVariable?.enabled
        && agent.mergeVariable?.validation?.enabled
        && (agent.sourceTemplateId === 'tpl-world-state'
            || agent.mergeVariable.variableName === WORLD_STATE_VARIABLE)) ?? null;
}

function readEligibleWorldState() {
    const agent = findEligibleWorldStateAgent();
    if (!agent) return null;

    const resolved = globalThis.SuperAgents?.integration?.getAgentState?.(agent.id);
    const value = resolved?.value;
    if (!resolved?.found || !value || typeof value !== 'object' || Array.isArray(value)) return null;
    return { agent, resolved, value };
}

function setSelectValue(name, value) {
    if (!value) return false;
    const control = document.getElementById(`${WEATHER_PREFIX}-${name}`)
        || document.getElementById(`${WEATHER_PREFIX}-floating-${name}`);
    if (!control) return false;
    if (control.value === value) return true;
    control.value = value;
    control.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
}

function setCheckboxValue(name, value) {
    const control = document.getElementById(`${WEATHER_PREFIX}-${name}`)
        || document.getElementById(`${WEATHER_PREFIX}-floating-${name}`);
    if (!control) return false;
    if (control.checked === value) return true;
    control.checked = value;
    control.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
}

export function getWeatherCycleIntegrationStatus() {
    const enabled = getGlobalSettings().weatherCycleIntegration === true;
    const installed = isWeatherCycleInstalled();
    const weatherCycleEnabled = installed && isWeatherCycleEnabled();
    const state = readEligibleWorldState();
    const weather = state ? mapWorldWeather(state.value.weather) : null;
    const time = state
        ? mapWorldTime(state.value.timeOfDay, state.value.setting, state.value.time)
        : null;
    const phaseEffect = state
        ? resolveWorldPhaseEffect(state.value.timeOfDay, state.value.setting)
        : null;
    return {
        enabled,
        installed,
        weatherCycleEnabled,
        worldStateEnabled: !!state?.agent,
        hasMappableState: !!(weather || time),
        weather,
        time,
        phaseEffect,
    };
}

export function syncWeatherCycleIntegration({ force = false } = {}) {
    if (force) manualOverrideActive = false;
    syncWeatherCycleCompatibilityUi();
    const status = getWeatherCycleIntegrationStatus();
    if (!status.enabled || !status.installed) manualOverrideActive = false;

    if (manualOverrideActive && status.weatherCycleEnabled) {
        syncManualWeatherCyclePhaseEffect();
        return { ...status, manualOverrideActive: true };
    }

    if (!status.enabled || !status.installed || !status.weatherCycleEnabled
        || !status.worldStateEnabled || !status.hasMappableState) {
        if (status.installed) syncManualWeatherCyclePhaseEffect();
        else {
            clearWeatherCyclePhaseEffect();
            syncWeatherCyclePhaseBadge();
        }
        return { ...status, manualOverrideActive: false };
    }

    syncingFromWorldState = true;
    try {
        if (status.weather) {
            setSelectValue('weather', status.weather.weather);
            setCheckboxValue('lightningEnabled', status.weather.lightningEnabled);
        }
        if (status.time) {
            setSelectValue('time', status.time);
            applyWeatherCyclePhaseEffect(status.phaseEffect);
            syncWeatherCyclePhaseBadge(status.phaseEffect);
        } else {
            // A weather-only World State update must not erase a lighting choice
            // the user made manually.
            syncManualWeatherCyclePhaseEffect();
        }
    } finally {
        syncingFromWorldState = false;
    }
    return { ...status, manualOverrideActive: false };
}

export function applyManualWeatherCycleOverride() {
    manualOverrideActive = getGlobalSettings().weatherCycleIntegration === true;
    syncManualWeatherCyclePhaseEffect();
    return manualOverrideActive;
}

function queueSync(force = false) {
    forceQueuedSync ||= force;
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
        const forceThisSync = forceQueuedSync;
        forceQueuedSync = false;
        queued = false;
        syncWeatherCycleIntegration({ force: forceThisSync });
    });
}

export function initWeatherCycleIntegration() {
    if (initialized) return;
    initialized = true;
    initWeatherCycleEffects();

    globalThis.addEventListener?.('superagents:state-committed', event => {
        if (event.detail?.variableName === WORLD_STATE_VARIABLE) queueSync(true);
    });
    eventSource.on(event_types.CHAT_CHANGED, () => queueSync(true));
    if (event_types.MESSAGE_SWIPED) eventSource.on(event_types.MESSAGE_SWIPED, () => queueSync(true));
    onStoreChange(queueSync);
    document.addEventListener('change', event => {
        const id = event.target?.id ?? '';
        if (new RegExp(`^${WEATHER_PREFIX}-(floating-)?enabled$`).test(id)) {
            queueSync();
        } else if (!syncingFromWorldState
            && new RegExp(`^${WEATHER_PREFIX}-(floating-)?(weather|time)$`).test(id)) {
            applyManualWeatherCycleOverride();
        }
    });
    document.addEventListener('click', event => {
        if (event.target?.id === `${WEATHER_PREFIX}-reset` && !syncingFromWorldState) {
            applyManualWeatherCycleOverride();
        }
    });

    // Weather Cycle initializes earlier by loading order, but both extensions
    // defer parts of their UI until APP_READY. Bounded retries cover that race.
    for (const delay of INITIAL_SYNC_DELAYS) setTimeout(queueSync, delay);
}
