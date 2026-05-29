/**
 * core/profiles.js — connection profile resolution.
 *
 * Centralizes everything related to Connection Manager profiles so the rest
 * of the extension never touches `extensionSettings.connectionManager`
 * directly. Pattern adapted from Recast's profile helpers.
 *
 * Two paths:
 *   - Preferred: ConnectionManagerRequestService (CMRS) — send a request
 *     with a target profile ID and ST handles routing under the hood.
 *     No live profile swap; the user's active profile is untouched.
 *   - Fallback: legacy profile swap via the /profile slash command. Used
 *     only when CMRS is missing (very old ST, or when CMRS itself errors
 *     in a way that warrants a hard retry). swapProfileLegacy() handles
 *     the swap + restore handshake with event waits.
 */

import { getContext } from '../../../../../extensions.js';
import {
    eventSource,
    event_types,
    online_status,
} from '../../../../../../script.js';
import { SlashCommandParser } from '../../../../../slash-commands/SlashCommandParser.js';

const LOG_PREFIX = '[SuperAgents/profiles]';

// ----------------------------------------------------------------------
// CMRS detection
// ----------------------------------------------------------------------

/**
 * True iff the ConnectionManagerRequestService is reachable and the
 * connection-manager extension itself isn't disabled.
 */
export function isCMRSAvailable(ctx = getContext()) {
    if (!ctx) return false;
    const disabled = ctx.extensionSettings?.disabledExtensions?.includes?.('connection-manager');
    if (disabled) return false;
    const cm = ctx.extensionSettings?.connectionManager;
    if (!cm) return false;
    return typeof ctx.ConnectionManagerRequestService?.sendRequest === 'function';
}

// ----------------------------------------------------------------------
// Profile lookups
// ----------------------------------------------------------------------

export function getConnectionProfiles(ctx = getContext()) {
    const profiles = ctx?.extensionSettings?.connectionManager?.profiles;
    return Array.isArray(profiles) ? profiles : [];
}

/**
 * Return the array of {id, name} pairs for UI consumption.
 * Pure read; safe to call any time.
 */
export function listConnectionProfiles(ctx = getContext()) {
    return getConnectionProfiles(ctx).map(p => ({ id: p.id, name: p.name }));
}

export function hasConnectionProfile(ctx, profileId) {
    if (!profileId) return true; // empty ref = "current profile", always valid
    return getConnectionProfiles(ctx).some(p => p.id === profileId);
}

/**
 * Resolve a profile reference (either an ID or a case-insensitive name)
 * to its canonical ID. Returns null if nothing matches.
 */
export function resolveProfileId(ctx, profileRef) {
    if (!profileRef) return null;
    const profiles = getConnectionProfiles(ctx);
    if (!profiles.length) return null;

    // ID exact match first
    const byId = profiles.find(p => p.id === profileRef);
    if (byId) return byId.id;

    // Case-insensitive name fallback
    const lower = String(profileRef).toLowerCase();
    const byName = profiles.find(p => String(p.name ?? '').toLowerCase() === lower);
    return byName ? byName.id : null;
}

export function getProfileNameById(ctx, profileId) {
    if (!profileId) return null;
    const p = getConnectionProfiles(ctx).find(p => p.id === profileId);
    return p ? p.name : null;
}

export function getCurrentProfileId(ctx = getContext()) {
    return ctx?.extensionSettings?.connectionManager?.selectedProfile || '';
}

export function getCurrentProfileName(ctx = getContext()) {
    const direct = ctx?.extensionSettings?.connectionManager?.selectedProfileName;
    if (direct) return direct;
    return getProfileNameById(ctx, getCurrentProfileId(ctx));
}

/**
 * Resolve which profile a request *should* target.
 *
 * CMRS REJECTS empty string as "Profile not found (ID: )" — we have to
 * hand it the connection-manager's currently-selected profile ID for the
 * "use current profile" case. Returns '' only when nothing is selectable
 * (e.g. CMRS disabled or no profiles configured) so the caller can skip
 * the CMRS attempt entirely.
 */
export function resolveTargetProfile(ctx, preferredRef = '') {
    if (!isCMRSAvailable(ctx)) return '';

    if (preferredRef) {
        const id = resolveProfileId(ctx, preferredRef);
        if (id) return id;
        console.warn(`${LOG_PREFIX} requested profile "${preferredRef}" not found; falling back to current`);
    }

    return getCurrentProfileId(ctx) || '';
}

// ----------------------------------------------------------------------
// Legacy swap fallback (only when CMRS unavailable / unsuitable)
// ----------------------------------------------------------------------

function waitUntil(condFn, timeout = 5000, interval = 100) {
    return new Promise((resolve, reject) => {
        const start = Date.now();
        const tick = () => {
            if (condFn()) return resolve();
            if (Date.now() - start > timeout) return reject(new Error('timeout'));
            setTimeout(tick, interval);
        };
        tick();
    });
}

function waitForEvent(type, timeout = 5000) {
    return new Promise((resolve, reject) => {
        let to;
        const off = () => { try { eventSource.removeListener(type, handler); } catch {} };
        const handler = () => { clearTimeout(to); off(); resolve(); };
        to = setTimeout(() => { off(); reject(new Error(`event ${type} timeout`)); }, timeout);
        eventSource.on(type, handler);
    });
}

/**
 * Switch to a target profile via the /profile slash command, wait for the
 * connection to settle, return a handle the caller uses to restore.
 *
 * Returns { success, originalProfileName, swapped } — call restoreProfile()
 * with originalProfileName when done.
 */
export async function swapProfileLegacy(ctx, targetRef) {
    const targetId = resolveProfileId(ctx, targetRef);
    if (!targetId) {
        return { success: false, error: 'profile-not-found' };
    }
    const targetName = getProfileNameById(ctx, targetId);
    const originalName = getCurrentProfileName(ctx);

    if (!targetName || targetName === originalName) {
        return { success: true, originalProfileName: originalName, swapped: false };
    }

    try {
        const profileLoaded = waitForEvent(event_types.CONNECTION_PROFILE_LOADED, 5000);

        await SlashCommandParser.commands['profile'].callback(
            { await: 'true', _scope: null, _abortController: null },
            targetName,
        );

        // Watch the connection cycle through offline → online again
        await waitUntil(() => online_status === 'no_connection', 5000, 100).catch(() => {});
        await profileLoaded.catch(() => {});
        await waitUntil(() => online_status !== 'no_connection', 5000, 100).catch(() => {});

        // ST sometimes double-loads (OpenAI/DeepSeek do this); give it a beat
        await new Promise(r => setTimeout(r, 1500));

        return { success: true, originalProfileName: originalName, swapped: true };
    } catch (err) {
        console.error(`${LOG_PREFIX} swap to "${targetName}" failed:`, err);
        return { success: false, error: String(err?.message || err) };
    }
}

/**
 * Restore a previously-active profile (paired with swapProfileLegacy).
 * Fire-and-forget; never throws.
 */
export async function restoreProfileLegacy(ctx, originalName) {
    if (!originalName) return;
    const currentName = getCurrentProfileName(ctx);
    if (currentName === originalName) return; // already there
    try {
        const profileLoaded = waitForEvent(event_types.CONNECTION_PROFILE_LOADED, 5000);
        await SlashCommandParser.commands['profile'].callback(
            { await: 'true', _scope: null, _abortController: null },
            originalName,
        );
        await profileLoaded.catch(() => {});
        await waitUntil(() => online_status !== 'no_connection', 5000, 100).catch(() => {});
    } catch (err) {
        console.warn(`${LOG_PREFIX} restore to "${originalName}" failed:`, err);
    }
}
