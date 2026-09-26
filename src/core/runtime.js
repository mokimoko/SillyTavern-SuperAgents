/** Shared extension identity and debug logging with no dependency on index.js. */

import { extension_settings } from '../../../../../extensions.js';

export const MODULE_NAME = 'SillyTavern-SuperAgents';
export const LOG_PREFIX = '[SuperAgents]';

const DEFAULT_SETTINGS = {
    enabled: true,
    debug: false,
};

export function getSettings() {
    if (!extension_settings[MODULE_NAME] || typeof extension_settings[MODULE_NAME] !== 'object') {
        extension_settings[MODULE_NAME] = {};
    }
    const settings = extension_settings[MODULE_NAME];
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
        if (settings[key] === undefined) settings[key] = value;
    }
    return settings;
}

export function debug(...args) {
    if (getSettings().debug) console.log(LOG_PREFIX, ...args);
}
