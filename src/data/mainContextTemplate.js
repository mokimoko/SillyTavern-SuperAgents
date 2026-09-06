/** Lightweight, non-evaluating templates for main-chat state projections. */

function tokenize(template) {
    const tokens = [];
    const pattern = /{{\s*([\s\S]*?)\s*}}/g;
    let cursor = 0;
    let match;
    while ((match = pattern.exec(template)) !== null) {
        if (match.index > cursor) tokens.push({ type: 'text', value: template.slice(cursor, match.index) });
        tokens.push({ type: 'tag', value: match[1].trim() });
        cursor = pattern.lastIndex;
    }
    if (cursor < template.length) tokens.push({ type: 'text', value: template.slice(cursor) });
    return tokens;
}

function parseNodes(tokens, cursor, stops = new Set()) {
    const nodes = [];
    while (cursor.index < tokens.length) {
        const token = tokens[cursor.index];
        if (token.type === 'text') {
            nodes.push(token);
            cursor.index += 1;
            continue;
        }

        const tag = token.value;
        if (stops.has(tag)) return { nodes, stop: tag };

        if (tag.startsWith('#each ')) {
            cursor.index += 1;
            const body = parseNodes(tokens, cursor, new Set(['/each']));
            if (body.stop === '/each') cursor.index += 1;
            nodes.push({ type: 'each', path: tag.slice(6).trim(), body: body.nodes });
            continue;
        }

        if (tag.startsWith('#if ')) {
            cursor.index += 1;
            const truthy = parseNodes(tokens, cursor, new Set(['else', '/if']));
            let falsyNodes = [];
            if (truthy.stop === 'else') {
                cursor.index += 1;
                const falsy = parseNodes(tokens, cursor, new Set(['/if']));
                falsyNodes = falsy.nodes;
                if (falsy.stop === '/if') cursor.index += 1;
            } else if (truthy.stop === '/if') {
                cursor.index += 1;
            }
            nodes.push({
                type: 'if',
                path: tag.slice(4).trim(),
                truthy: truthy.nodes,
                falsy: falsyNodes,
            });
            continue;
        }

        nodes.push({ type: 'value', path: tag });
        cursor.index += 1;
    }
    return { nodes, stop: '' };
}

function readPath(source, parts) {
    let value = source;
    for (const part of parts) {
        if (value === null || value === undefined) return undefined;
        value = value[part];
    }
    return value;
}

function resolvePath(path, scope, root) {
    const clean = String(path || '').trim();
    if (!clean) return '';
    if (clean === '@key') return scope.key ?? '';
    if (clean === '@index') return scope.index ?? '';
    if (clean === 'this') return scope.value;
    if (clean.startsWith('this.')) return readPath(scope.value, clean.slice(5).split('.'));
    if (clean.startsWith('@root.')) return readPath(root, clean.slice(6).split('.'));

    const parts = clean.split('.');
    const local = readPath(scope.value, parts);
    return local === undefined ? readPath(root, parts) : local;
}

function hasContent(value) {
    if (Array.isArray(value)) return value.length > 0;
    if (value && typeof value === 'object') return Object.keys(value).length > 0;
    if (typeof value === 'number') return Number.isFinite(value);
    return Boolean(value);
}

function displayValue(value) {
    if (value === null || value === undefined) return '';
    if (Array.isArray(value)) return value.map(displayValue).filter(Boolean).join(', ');
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
}

function renderNodes(nodes, scope, root) {
    return nodes.map(node => {
        if (node.type === 'text') return node.value;
        if (node.type === 'value') return displayValue(resolvePath(node.path, scope, root));
        if (node.type === 'if') {
            const branch = hasContent(resolvePath(node.path, scope, root)) ? node.truthy : node.falsy;
            return renderNodes(branch, scope, root);
        }
        if (node.type === 'each') {
            const collection = resolvePath(node.path, scope, root);
            if (Array.isArray(collection)) {
                return collection.map((value, index) => renderNodes(
                    node.body,
                    { value, key: index, index },
                    root,
                )).join('');
            }
            if (collection && typeof collection === 'object') {
                return Object.entries(collection).map(([key, value], index) => renderNodes(
                    node.body,
                    { value, key, index },
                    root,
                )).join('');
            }
            return '';
        }
        return '';
    }).join('');
}

function buildRoot(item) {
    const root = { ...(item || {}) };
    for (const [key, value] of Object.entries(root)) {
        if (typeof value !== 'string' || !/^[\[{]/.test(value.trim())) continue;
        try { root[key] = JSON.parse(value); } catch { /* Keep malformed values as text. */ }
    }
    return root;
}

/**
 * Render an editable main-chat template without executing user-authored code.
 * Supports values, #if/else, and #each over arrays or objects.
 */
export function renderMainContextTemplate(template, item) {
    const source = String(template || '');
    if (!source) return '';
    const root = buildRoot(item);
    const tree = parseNodes(tokenize(source), { index: 0 }).nodes;
    return renderNodes(tree, { value: root, key: '', index: 0 }, root)
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}
