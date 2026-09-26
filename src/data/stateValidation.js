/**
 * Declarative validation for merge-variable state.
 *
 * This intentionally implements a small JSON-Schema-like subset rather than
 * taking a runtime dependency: type, required, properties,
 * additionalProperties, items, enum, const, numeric/string/array/object bounds,
 * and pattern. Tracker updates are rejected as a unit when any field is invalid.
 */

const DEFAULT_MAX_ERRORS = 20;
const MAX_SCHEMA_DEPTH = 40;
const VALID_INVARIANT_TYPES = new Set([
    'nondecreasing',
    'maxDelta',
    'appendOnlySet',
    'capWhen',
    'minimumWhen',
]);
const VALID_COMPARISON_OPERATORS = new Set(['eq', 'neq', 'gt', 'gte', 'lt', 'lte']);

function valueType(value) {
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'array';
    if (Number.isInteger(value)) return 'integer';
    return typeof value;
}

function typeMatches(value, expected) {
    if (expected === 'number') return typeof value === 'number' && Number.isFinite(value);
    if (expected === 'integer') return Number.isInteger(value);
    if (expected === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
    if (expected === 'array') return Array.isArray(value);
    if (expected === 'null') return value === null;
    return typeof value === expected;
}

function addError(errors, maxErrors, path, message) {
    if (errors.length < maxErrors) errors.push(`${path}: ${message}`);
}

function validateValue(value, schema, path, errors, maxErrors, depth = 0) {
    if (!schema || typeof schema !== 'object' || errors.length >= maxErrors) return;
    if (depth > MAX_SCHEMA_DEPTH) {
        addError(errors, maxErrors, path, 'schema nesting is too deep');
        return;
    }

    if (Array.isArray(schema.anyOf)) {
        const matched = schema.anyOf.some(candidate => {
            const candidateErrors = [];
            validateValue(value, candidate, path, candidateErrors, maxErrors, depth + 1);
            return candidateErrors.length === 0;
        });
        if (!matched) addError(errors, maxErrors, path, 'does not match any allowed schema');
        return;
    }

    const expectedTypes = Array.isArray(schema.type)
        ? schema.type
        : (typeof schema.type === 'string' ? [schema.type] : []);
    if (expectedTypes.length && !expectedTypes.some(type => typeMatches(value, type))) {
        addError(
            errors,
            maxErrors,
            path,
            `expected ${expectedTypes.join(' or ')}, received ${valueType(value)}`,
        );
        return;
    }

    if (Object.prototype.hasOwnProperty.call(schema, 'const') && value !== schema.const) {
        addError(errors, maxErrors, path, `must equal ${JSON.stringify(schema.const)}`);
    }
    if (Array.isArray(schema.enum) && !schema.enum.some(entry => Object.is(entry, value))) {
        addError(errors, maxErrors, path, `must be one of ${schema.enum.map(String).join(', ')}`);
    }

    if (typeof value === 'number' && Number.isFinite(value)) {
        if (Number.isFinite(schema.minimum) && value < schema.minimum) {
            addError(errors, maxErrors, path, `must be at least ${schema.minimum}`);
        }
        if (Number.isFinite(schema.maximum) && value > schema.maximum) {
            addError(errors, maxErrors, path, `must be at most ${schema.maximum}`);
        }
    }

    if (typeof value === 'string') {
        if (Number.isFinite(schema.minLength) && value.length < schema.minLength) {
            addError(errors, maxErrors, path, `must contain at least ${schema.minLength} characters`);
        }
        if (Number.isFinite(schema.maxLength) && value.length > schema.maxLength) {
            addError(errors, maxErrors, path, `must contain at most ${schema.maxLength} characters`);
        }
        if (typeof schema.pattern === 'string' && schema.pattern) {
            try {
                if (!new RegExp(schema.pattern).test(value)) {
                    addError(errors, maxErrors, path, `must match /${schema.pattern}/`);
                }
            } catch {
                addError(errors, maxErrors, path, 'validation schema contains an invalid pattern');
            }
        }
    }

    if (Array.isArray(value)) {
        if (Number.isFinite(schema.minItems) && value.length < schema.minItems) {
            addError(errors, maxErrors, path, `must contain at least ${schema.minItems} items`);
        }
        if (Number.isFinite(schema.maxItems) && value.length > schema.maxItems) {
            addError(errors, maxErrors, path, `must contain at most ${schema.maxItems} items`);
        }
        if (schema.items && typeof schema.items === 'object') {
            value.forEach((entry, index) => {
                validateValue(entry, schema.items, `${path}[${index}]`, errors, maxErrors, depth + 1);
            });
        }
    }

    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        const propertyCount = Object.keys(value).length;
        if (Number.isFinite(schema.minProperties) && propertyCount < schema.minProperties) {
            addError(errors, maxErrors, path, `must contain at least ${schema.minProperties} properties`);
        }
        if (Number.isFinite(schema.maxProperties) && propertyCount > schema.maxProperties) {
            addError(errors, maxErrors, path, `must contain at most ${schema.maxProperties} properties`);
        }

        const properties = schema.properties && typeof schema.properties === 'object'
            ? schema.properties
            : {};
        const required = Array.isArray(schema.required) ? schema.required : [];

        for (const key of required) {
            if (!Object.prototype.hasOwnProperty.call(value, key)) {
                addError(errors, maxErrors, `${path}.${key}`, 'is required');
            }
        }

        for (const [key, entry] of Object.entries(value)) {
            if (properties[key]) {
                validateValue(entry, properties[key], `${path}.${key}`, errors, maxErrors, depth + 1);
            } else if (schema.additionalProperties === false) {
                addError(errors, maxErrors, `${path}.${key}`, 'is not an allowed field');
            } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
                validateValue(
                    entry,
                    schema.additionalProperties,
                    `${path}.${key}`,
                    errors,
                    maxErrors,
                    depth + 1,
                );
            }
        }
    }
}

function collectPathValues(root, rawPath) {
    const values = new Map();
    const segments = String(rawPath || '').split('.').filter(Boolean);
    if (!segments.length) return values;

    function walk(value, index, resolved) {
        if (index >= segments.length) {
            values.set(resolved.join('.'), value);
            return;
        }
        if (value === null || typeof value !== 'object') return;

        const segment = segments[index];
        if (segment === '*') {
            for (const [key, entry] of Object.entries(value)) {
                walk(entry, index + 1, [...resolved, key]);
            }
            return;
        }
        if (Object.prototype.hasOwnProperty.call(value, segment)) {
            walk(value[segment], index + 1, [...resolved, segment]);
        }
    }

    walk(root, 0, []);
    return values;
}

function readResolvedPath(root, rawPath, wildcardValues = []) {
    const segments = String(rawPath || '').split('.').filter(Boolean);
    let wildcardIndex = 0;
    let current = root;
    for (const rawSegment of segments) {
        const segment = rawSegment === '*' ? wildcardValues[wildcardIndex++] : rawSegment;
        if (segment === undefined || current === null || typeof current !== 'object') return undefined;
        if (!Object.prototype.hasOwnProperty.call(current, segment)) return undefined;
        current = current[segment];
    }
    return current;
}

function wildcardValuesForPath(templatePath, resolvedPath) {
    const template = String(templatePath || '').split('.').filter(Boolean);
    const resolved = String(resolvedPath || '').split('.').filter(Boolean);
    return template.flatMap((segment, index) => segment === '*' ? [resolved[index]] : []);
}

function compareInvariantValue(actual, operator, expected) {
    switch (operator) {
        case 'eq': return actual === expected;
        case 'neq': return actual !== expected;
        case 'gt': return Number(actual) > Number(expected);
        case 'gte': return Number(actual) >= Number(expected);
        case 'lt': return Number(actual) < Number(expected);
        case 'lte': return Number(actual) <= Number(expected);
        default: return false;
    }
}

function validateInvariants(current, previous, invariants, path, errors, maxErrors) {
    if (!previous || typeof previous !== 'object') return;

    for (const invariant of invariants) {
        const currentValues = collectPathValues(current, invariant.path);
        const previousValues = collectPathValues(previous, invariant.path);

        for (const [resolvedPath, value] of currentValues) {
            if (!previousValues.has(resolvedPath)) continue;
            const prior = previousValues.get(resolvedPath);

            if (invariant.type === 'nondecreasing'
                && typeof value === 'number'
                && typeof prior === 'number'
                && value < prior) {
                addError(
                    errors,
                    maxErrors,
                    `${path}.${resolvedPath}`,
                    `must not decrease (previous ${prior}, proposed ${value})`,
                );
            } else if (invariant.type === 'maxDelta'
                && typeof value === 'number'
                && typeof prior === 'number'
                && Math.abs(value - prior) > invariant.maximum) {
                addError(
                    errors,
                    maxErrors,
                    `${path}.${resolvedPath}`,
                    `may change by at most ${invariant.maximum} (previous ${prior}, proposed ${value})`,
                );
            } else if (invariant.type === 'appendOnlySet'
                && Array.isArray(value)
                && Array.isArray(prior)
                && prior.some(entry => !value.some(candidate => Object.is(candidate, entry)))) {
                addError(
                    errors,
                    maxErrors,
                    `${path}.${resolvedPath}`,
                    'must preserve previously recorded entries',
                );
            } else if (invariant.type === 'capWhen' || invariant.type === 'minimumWhen') {
                const wildcards = wildcardValuesForPath(invariant.path, resolvedPath);
                const whenValue = readResolvedPath(current, invariant.whenPath, wildcards);
                if (!compareInvariantValue(whenValue, invariant.operator, invariant.value)) continue;

                const violatesCap = invariant.type === 'capWhen'
                    && typeof value === 'number'
                    && value > invariant.maximum;
                const violatesMinimum = invariant.type === 'minimumWhen'
                    && typeof value === 'number'
                    && value < invariant.minimum;
                if (violatesCap || violatesMinimum) {
                    const boundary = violatesCap
                        ? `must be at most ${invariant.maximum}`
                        : `must be at least ${invariant.minimum}`;
                    addError(
                        errors,
                        maxErrors,
                        `${path}.${resolvedPath}`,
                        `${boundary} while ${invariant.whenPath} ${invariant.operator} ${JSON.stringify(invariant.value)}`,
                    );
                }
            }
        }
    }
}

export function normalizeValidationConfig(raw) {
    if (!raw || typeof raw !== 'object') {
        return {
            enabled: false,
            jsonField: '',
            canonicalizer: '',
            schemaVersion: 1,
            canonicalizeJson: true,
            maxErrors: DEFAULT_MAX_ERRORS,
            schema: null,
            invariants: [],
        };
    }

    const maxErrors = Number(raw.maxErrors);
    return {
        enabled: Boolean(raw.enabled),
        jsonField: typeof raw.jsonField === 'string' ? raw.jsonField.trim() : '',
        canonicalizer: typeof raw.canonicalizer === 'string' ? raw.canonicalizer.trim() : '',
        schemaVersion: Number.isFinite(Number(raw.schemaVersion))
            ? Math.max(1, Math.floor(Number(raw.schemaVersion)))
            : 1,
        canonicalizeJson: raw.canonicalizeJson !== false,
        maxErrors: Number.isFinite(maxErrors)
            ? Math.max(1, Math.min(100, Math.floor(maxErrors)))
            : DEFAULT_MAX_ERRORS,
        schema: raw.schema && typeof raw.schema === 'object' ? raw.schema : null,
        invariants: Array.isArray(raw.invariants)
            ? raw.invariants
                .filter(entry => entry && typeof entry === 'object')
                .map(entry => ({
                    type: String(entry.type || ''),
                    path: String(entry.path || '').trim(),
                    maximum: Number(entry.maximum),
                    minimum: Number(entry.minimum),
                    whenPath: String(entry.whenPath || '').trim(),
                    operator: String(entry.operator || 'eq'),
                    value: entry.value,
                }))
                .filter(entry => VALID_INVARIANT_TYPES.has(entry.type)
                    && entry.path
                    && (entry.type !== 'maxDelta'
                        || (Number.isFinite(entry.maximum) && entry.maximum >= 0))
                    && (entry.type !== 'capWhen'
                        || (entry.whenPath
                            && VALID_COMPARISON_OPERATORS.has(entry.operator)
                            && Number.isFinite(entry.maximum)))
                    && (entry.type !== 'minimumWhen'
                        || (entry.whenPath
                            && VALID_COMPARISON_OPERATORS.has(entry.operator)
                            && Number.isFinite(entry.minimum))))
            : [],
    };
}

/**
 * Validate a complete proposed merge-variable value without mutating it.
 * `schema` applies to each stored item, or to the parsed value inside
 * `jsonField` when configured.
 */
export function validateMergeItems(items, rawConfig, options = {}) {
    const config = normalizeValidationConfig(rawConfig);
    if (!config.enabled) return { valid: true, items, errors: [] };

    const errors = [];
    if (!Array.isArray(items)) {
        return { valid: false, items: null, errors: ['$: merge-variable state must be an array'] };
    }
    if (!config.schema) {
        return { valid: false, items: null, errors: ['$: validation is enabled but no schema is configured'] };
    }

    const logicalItems = [];
    const normalizedItems = items.map(item => ({ ...item }));
    normalizedItems.forEach((item, index) => {
        let candidate = item;
        if (config.jsonField) {
            const rawJson = item?.[config.jsonField];
            if (typeof rawJson !== 'string') {
                addError(
                    errors,
                    config.maxErrors,
                    `$[${index}].${config.jsonField}`,
                    'must be a JSON string',
                );
                return;
            }
            try {
                candidate = JSON.parse(rawJson);
                if (config.canonicalizeJson) {
                    item[config.jsonField] = JSON.stringify(candidate);
                }
            } catch (error) {
                addError(
                    errors,
                    config.maxErrors,
                    `$[${index}].${config.jsonField}`,
                    `contains invalid JSON (${error.message})`,
                );
                return;
            }
        }

        logicalItems[index] = candidate;
        validateValue(candidate, config.schema, `$[${index}]`, errors, config.maxErrors);
    });

    if (config.invariants.length && Array.isArray(options.previousItems)) {
        normalizedItems.forEach((item, index) => {
            const previousItem = options.previousItems[index];
            if (!previousItem) return;

            let previous = previousItem;
            if (config.jsonField) {
                try {
                    previous = JSON.parse(previousItem?.[config.jsonField]);
                } catch {
                    return;
                }
            }
            validateInvariants(
                logicalItems[index],
                previous,
                config.invariants,
                `$[${index}]`,
                errors,
                config.maxErrors,
            );
        });
    }

    return {
        valid: errors.length === 0,
        items: errors.length === 0 ? normalizedItems : null,
        errors,
    };
}
