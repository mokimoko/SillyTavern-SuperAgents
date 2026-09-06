/**
 * Deferred pre-generation gates backed by another agent's remembered state.
 *
 * These gates are evaluated after ordinary pre-gen agents have committed their
 * snapshots, so a classifier can decide whether a more specialized agent is
 * needed during the same generation.
 */

const BLOCKED_PATH_PARTS = new Set(['__proto__', 'prototype', 'constructor']);

function parseExpected(value) {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    if (!trimmed) return '';
    try { return JSON.parse(trimmed); } catch { return value; }
}

function readPath(value, path) {
    let current = value;
    for (const part of String(path || '').replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean)) {
        if (BLOCKED_PATH_PARTS.has(part) || current === null || current === undefined) return undefined;
        current = current[part];
    }
    return current;
}

function unwrapItem(item, jsonField) {
    if (!item || typeof item !== 'object') return undefined;
    if (!jsonField) return item;
    const raw = item[jsonField];
    if (typeof raw !== 'string') return raw;
    try { return JSON.parse(raw); } catch { return undefined; }
}

/** Whether an agent has a configured deferred state gate. */
export function hasStateGate(agent) {
    const gate = agent?.conditions?.stateGate;
    return Boolean(gate?.enabled && gate.variableName && gate.path);
}

/**
 * Evaluate an agent gate against merge-variable items.
 * @param {object} agent
 * @param {(variableName:string) => object[]} readItems
 * @returns {{allowed:boolean, found:boolean, actual:unknown, expected:unknown}}
 */
export function evaluateStateGate(agent, readItems) {
    const gate = agent?.conditions?.stateGate ?? {};
    if (!hasStateGate(agent)) {
        return { allowed: true, found: false, actual: undefined, expected: undefined };
    }

    const items = readItems(gate.variableName);
    const root = unwrapItem(Array.isArray(items) ? items[0] : undefined, gate.jsonField || 'json');
    const actual = readPath(root, gate.path);
    const expected = parseExpected(gate.value);
    const found = actual !== undefined && actual !== null;
    let allowed = false;

    switch (gate.operator) {
        case 'neq': allowed = actual !== expected; break;
        case 'exists': allowed = found; break;
        case 'not_exists': allowed = !found; break;
        case 'contains':
            allowed = Array.isArray(actual)
                ? actual.includes(expected)
                : String(actual ?? '').includes(String(expected));
            break;
        case 'eq':
        default:
            allowed = actual === expected;
            break;
    }

    return { allowed, found, actual, expected };
}
