/**
 * Visual authoring for merge-variable JSON state. It owns a small schema tree,
 * mirrors that tree to the raw developer textareas, and renders an example of
 * the JSON the agent should return.
 */

const KINDS = [
    ['string', 'Text'],
    ['number', 'Number'],
    ['integer', 'Whole number'],
    ['boolean', 'Yes / no'],
    ['textList', 'List of text'],
    ['numberList', 'List of numbers'],
    ['group', 'Group of fields'],
    ['namedGroup', 'One entry per name'],
    ['groupList', 'List of field groups'],
];
const GROUP_KINDS = new Set(['group', 'namedGroup', 'groupList']);
const FRIENDLY_RULES = new Set(['nondecreasing', 'maxDelta', 'appendOnlySet']);
let nextNodeId = 1;

function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function esc(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;');
}

function kindForSchema(schema) {
    if (schema?.type === 'object') {
        if (schema.additionalProperties && typeof schema.additionalProperties === 'object') return 'namedGroup';
        return 'group';
    }
    if (schema?.type === 'array') {
        if (schema.items?.type === 'object') return 'groupList';
        if (schema.items?.type === 'number' || schema.items?.type === 'integer') return 'numberList';
        return 'textList';
    }
    if (schema?.type === 'number' || schema?.type === 'integer' || schema?.type === 'boolean') return schema.type;
    return 'string';
}

function schemaExtras(schema) {
    const extras = clone(schema || {});
    for (const key of ['type', 'properties', 'required', 'additionalProperties', 'items', 'minimum', 'maximum', 'maxLength', 'maxItems', 'maxProperties']) {
        delete extras[key];
    }
    return extras;
}

function schemaToNode(name, schema, required, rules, path) {
    const kind = kindForSchema(schema);
    let childSchema = null;
    if (kind === 'group') childSchema = schema;
    if (kind === 'namedGroup') childSchema = schema.additionalProperties;
    if (kind === 'groupList') childSchema = schema.items;
    const childPrefix = kind === 'namedGroup' ? [...path, '*'] : path;
    const children = childSchema
        ? Object.entries(childSchema.properties || {}).map(([childName, child]) => schemaToNode(
            childName,
            child,
            (childSchema.required || []).includes(childName),
            rules,
            [...childPrefix, childName],
        ))
        : [];
    const rule = rules.find(entry => entry.path === path.join('.') && FRIENDLY_RULES.has(entry.type));
    return {
        id: nextNodeId++,
        name,
        kind,
        required,
        minimum: Number.isFinite(schema?.minimum) ? schema.minimum : '',
        maximum: Number.isFinite(schema?.maximum) ? schema.maximum : '',
        maxLength: Number.isFinite(schema?.maxLength) ? schema.maxLength : '',
        maxItems: Number.isFinite(schema?.maxItems)
            ? schema.maxItems
            : (kind === 'namedGroup' && Number.isFinite(schema?.maxProperties) ? schema.maxProperties : ''),
        rule: rule?.type || '',
        maxDelta: rule?.type === 'maxDelta' && Number.isFinite(rule.maximum) ? rule.maximum : 10,
        extras: schemaExtras(schema),
        itemExtras: schema?.type === 'array' ? (() => {
            const extras = clone(schema.items || {});
            delete extras.type;
            return extras;
        })() : {},
        children,
    };
}

function schemaToTree(schema, invariants) {
    const root = schema && typeof schema === 'object' && !Array.isArray(schema) ? schema : {};
    const rules = Array.isArray(invariants) ? invariants : [];
    return {
        children: Object.entries(root.properties || {}).map(([name, child]) => schemaToNode(
            name,
            child,
            (root.required || []).includes(name),
            rules,
            [name],
        )),
        extras: schemaExtras(root),
        allowExtra: root.additionalProperties === true,
    };
}

function cleanNumber(value) {
    const number = Number(value);
    return value !== '' && Number.isFinite(number) ? number : undefined;
}

function nodeToSchema(node) {
    const schema = { ...(node.extras || {}) };
    if (node.kind === 'string') {
        schema.type = 'string';
        const maxLength = cleanNumber(node.maxLength);
        if (maxLength !== undefined) schema.maxLength = maxLength;
    } else if (node.kind === 'number' || node.kind === 'integer') {
        schema.type = node.kind;
        const minimum = cleanNumber(node.minimum);
        const maximum = cleanNumber(node.maximum);
        if (minimum !== undefined) schema.minimum = minimum;
        if (maximum !== undefined) schema.maximum = maximum;
    } else if (node.kind === 'boolean') {
        schema.type = 'boolean';
    } else if (node.kind === 'textList' || node.kind === 'numberList') {
        schema.type = 'array';
        schema.items = { ...(node.itemExtras || {}), type: node.kind === 'numberList' ? 'number' : 'string' };
        const maxItems = cleanNumber(node.maxItems);
        if (maxItems !== undefined) schema.maxItems = maxItems;
    } else {
        const objectSchema = {
            type: 'object',
            properties: Object.fromEntries(node.children.map(child => [child.name, nodeToSchema(child)])),
            additionalProperties: false,
        };
        const required = node.children.filter(child => child.required).map(child => child.name);
        if (required.length) objectSchema.required = required;
        if (node.kind === 'namedGroup') {
            schema.type = 'object';
            schema.additionalProperties = objectSchema;
            const maxProperties = cleanNumber(node.maxItems);
            if (maxProperties !== undefined) schema.maxProperties = maxProperties;
        } else if (node.kind === 'groupList') {
            schema.type = 'array';
            schema.items = objectSchema;
            const maxItems = cleanNumber(node.maxItems);
            if (maxItems !== undefined) schema.maxItems = maxItems;
        } else {
            Object.assign(schema, objectSchema);
        }
    }
    return schema;
}

function treeToSchema(tree) {
    const schema = {
        ...(tree.extras || {}),
        type: 'object',
        properties: Object.fromEntries(tree.children.map(node => [node.name, nodeToSchema(node)])),
        additionalProperties: !!tree.allowExtra,
    };
    const required = tree.children.filter(node => node.required).map(node => node.name);
    if (required.length) schema.required = required;
    return schema;
}

function walkNodes(nodes, prefix, callback) {
    for (const node of nodes) {
        const path = [...prefix, node.name];
        callback(node, path);
        if (GROUP_KINDS.has(node.kind)) {
            walkNodes(node.children, node.kind === 'namedGroup' ? [...path, '*'] : path, callback);
        }
    }
}

function treeToInvariants(tree, preserved = []) {
    const rules = [...preserved];
    walkNodes(tree.children, [], (node, path) => {
        if (!node.rule) return;
        const rule = { type: node.rule, path: path.join('.') };
        if (node.rule === 'maxDelta') rule.maximum = cleanNumber(node.maxDelta) ?? 10;
        rules.push(rule);
    });
    return rules;
}

function exampleForNode(node) {
    if (node.kind === 'number' || node.kind === 'integer') return cleanNumber(node.minimum) ?? 0;
    if (node.kind === 'boolean') return false;
    if (node.kind === 'textList') return ['example'];
    if (node.kind === 'numberList') return [0];
    const object = Object.fromEntries(node.children.map(child => [child.name, exampleForNode(child)]));
    if (node.kind === 'namedGroup') return { Name: object };
    if (node.kind === 'groupList') return [object];
    if (node.kind === 'group') return object;
    return 'example';
}

function treeToExample(tree) {
    return Object.fromEntries(tree.children.map(node => [node.name, exampleForNode(node)]));
}

function inferNode(name, value) {
    const base = { id: nextNodeId++, name, required: true, extras: {}, rule: '', maxDelta: 10 };
    if (Array.isArray(value)) {
        if (value[0] && typeof value[0] === 'object' && !Array.isArray(value[0])) {
            return { ...base, kind: 'groupList', maxItems: '', children: Object.entries(value[0]).map(([key, child]) => inferNode(key, child)) };
        }
        return { ...base, kind: typeof value[0] === 'number' ? 'numberList' : 'textList', maxItems: '', children: [] };
    }
    if (value && typeof value === 'object') {
        return { ...base, kind: 'group', children: Object.entries(value).map(([key, child]) => inferNode(key, child)) };
    }
    if (typeof value === 'number') return { ...base, kind: Number.isInteger(value) ? 'integer' : 'number', minimum: '', maximum: '', children: [] };
    if (typeof value === 'boolean') return { ...base, kind: 'boolean', children: [] };
    return { ...base, kind: 'string', maxLength: '', children: [] };
}

function findNode(nodes, id) {
    for (const node of nodes) {
        if (node.id === id) return node;
        const nested = findNode(node.children || [], id);
        if (nested) return nested;
    }
    return null;
}

function removeNode(nodes, id) {
    const index = nodes.findIndex(node => node.id === id);
    if (index >= 0) return nodes.splice(index, 1);
    for (const node of nodes) {
        if (removeNode(node.children || [], id)?.length) return [node];
    }
    return [];
}

function newNode() {
    return {
        id: nextNodeId++, name: 'new_field', kind: 'string', required: true,
        minimum: '', maximum: '', maxLength: '', maxItems: '', rule: '',
        maxDelta: 10, extras: {}, itemExtras: {}, children: [],
    };
}

function ruleOptions(node) {
    if (node.kind === 'number' || node.kind === 'integer') {
        return [['', 'May change normally'], ['nondecreasing', 'Never decrease'], ['maxDelta', 'Limit change each turn']];
    }
    if (node.kind === 'textList') return [['', 'May replace items'], ['appendOnlySet', 'Only add; never remove']];
    return [];
}

function renderNode(node, depth = 0) {
    const kinds = KINDS.map(([value, label]) => `<option value="${value}" ${node.kind === value ? 'selected' : ''}>${label}</option>`).join('');
    const rules = ruleOptions(node);
    const constraints = node.kind === 'number' || node.kind === 'integer' ? `
        <label>Minimum <input class="sae-schema-mini" type="number" data-schema-action="minimum" value="${esc(node.minimum)}"></label>
        <label>Maximum <input class="sae-schema-mini" type="number" data-schema-action="maximum" value="${esc(node.maximum)}"></label>`
        : node.kind === 'string' ? `<label>Max characters <input class="sae-schema-mini" type="number" min="1" data-schema-action="maxLength" value="${esc(node.maxLength)}"></label>`
            : ['textList', 'numberList', 'groupList'].includes(node.kind) ? `<label>Max items <input class="sae-schema-mini" type="number" min="1" data-schema-action="maxItems" value="${esc(node.maxItems)}"></label>`
                : node.kind === 'namedGroup' ? `<label>Max entries <input class="sae-schema-mini" type="number" min="1" data-schema-action="maxItems" value="${esc(node.maxItems)}"></label>`
                : '';
    const ruleControl = rules.length ? `
        <label>Across turns
            <select class="sae-schema-mini" data-schema-action="rule">
                ${rules.map(([value, label]) => `<option value="${value}" ${node.rule === value ? 'selected' : ''}>${label}</option>`).join('')}
            </select>
        </label>
        ${node.rule === 'maxDelta' ? `<label>Maximum change <input class="sae-schema-mini" type="number" min="0" data-schema-action="maxDelta" value="${esc(node.maxDelta)}"></label>` : ''}` : '';
    const children = GROUP_KINDS.has(node.kind) ? `
        <div class="sae-schema-children">
            ${node.children.map(child => renderNode(child, depth + 1)).join('')}
            <button type="button" class="sam-btn sae-schema-add" data-schema-add-child="${node.id}"><i class="fa-solid fa-plus"></i> Add nested field</button>
        </div>` : '';
    return `
        <div class="sae-schema-node" data-schema-id="${node.id}" style="--sae-schema-depth:${depth}">
            <div class="sae-schema-main">
                <i class="fa-solid ${GROUP_KINDS.has(node.kind) ? 'fa-folder-tree' : 'fa-grip-lines'} sae-schema-kind-icon"></i>
                <input class="sae-input sae-schema-name" data-schema-action="name" value="${esc(node.name)}" aria-label="Field name">
                <select class="sae-select sae-schema-type" data-schema-action="kind">${kinds}</select>
                <label class="sae-schema-required"><input type="checkbox" data-schema-action="required" ${node.required ? 'checked' : ''}> Required</label>
                <button type="button" class="sam-btn sae-schema-remove" data-schema-remove="${node.id}" title="Remove field"><i class="fa-solid fa-trash-can"></i></button>
            </div>
            ${(constraints || ruleControl) ? `<div class="sae-schema-constraints">${constraints}${ruleControl}</div>` : ''}
            ${children}
        </div>`;
}

export function createStructuredMemoryBuilder({ schema, invariants, schemaInput, invariantsInput }) {
    const element = document.createElement('div');
    element.className = 'sae-schema-builder';
    let rawInvariants = Array.isArray(invariants) ? clone(invariants) : [];
    let preservedInvariants = rawInvariants.filter(rule => !FRIENDLY_RULES.has(rule?.type));
    let tree = schemaToTree(schema, rawInvariants);

    const syncRaw = () => {
        schemaInput.value = JSON.stringify(treeToSchema(tree), null, 2);
        invariantsInput.value = JSON.stringify(treeToInvariants(tree, preservedInvariants), null, 2);
    };

    const render = () => {
        const example = JSON.stringify(treeToExample(tree), null, 2);
        element.innerHTML = `
            <div class="sae-schema-builder-head">
                <div><strong>Remembered fields</strong><span>Define the data your agent maintains. Groups create nesting; “one entry per name” is useful for characters, locations, quests, or any keyed collection.</span></div>
                <button type="button" class="sam-btn" data-schema-add-root><i class="fa-solid fa-plus"></i> Add field</button>
            </div>
            <div class="sae-schema-list">${tree.children.map(node => renderNode(node)).join('') || '<div class="sae-schema-empty">No fields yet. Add one, or build them from a JSON example.</div>'}</div>
            <div class="sae-schema-import-actions">
                <button type="button" class="sam-btn" data-schema-show-import><i class="fa-solid fa-wand-magic-sparkles"></i> Build from JSON example</button>
            </div>
            <div class="sae-schema-import sae-hidden">
                <div class="sae-desc">Paste an example of the answer you want. SuperAgents will create editable fields from it; object groups can then be changed to “one entry per name.”</div>
                <textarea class="sae-textarea sae-textarea-compact" data-schema-example-input spellcheck="false" placeholder='{ "mood": "calm", "trust": 25 }'></textarea>
                <div class="sae-schema-import-foot"><span data-schema-import-error></span><button type="button" class="sam-btn sam-btn-accent" data-schema-import>Use this example</button></div>
            </div>
            <div class="sae-schema-example">
                <div>
                    <div><strong>Generated JSON example</strong><span>Use this shape in the agent's prompt. It updates as you edit the fields.</span></div>
                    <button type="button" class="sam-btn" data-schema-copy-example><i class="fa-regular fa-copy"></i> Copy example</button>
                </div>
                <pre>${esc(example)}</pre>
            </div>`;
        syncRaw();
    };

    const handleClick = event => {
        const addRoot = event.target.closest('[data-schema-add-root]');
        if (addRoot) {
            tree.children.push(newNode());
            render();
            return;
        }
        const addChild = event.target.closest('[data-schema-add-child]');
        if (addChild) {
            findNode(tree.children, Number(addChild.dataset.schemaAddChild))?.children.push(newNode());
            render();
            return;
        }
        const remove = event.target.closest('[data-schema-remove]');
        if (remove) {
            removeNode(tree.children, Number(remove.dataset.schemaRemove));
            render();
            return;
        }
        if (event.target.closest('[data-schema-show-import]')) {
            element.querySelector('.sae-schema-import')?.classList.toggle('sae-hidden');
            return;
        }
        const copyExample = event.target.closest('[data-schema-copy-example]');
        if (copyExample) {
            const example = JSON.stringify(treeToExample(tree), null, 2);
            const copyPromise = navigator.clipboard?.writeText(example);
            if (copyPromise) {
                copyPromise.then(() => {
                    copyExample.innerHTML = '<i class="fa-solid fa-check"></i> Copied';
                    setTimeout(() => { copyExample.innerHTML = '<i class="fa-regular fa-copy"></i> Copy example'; }, 1400);
                }).catch(() => {});
            }
            return;
        }
        if (event.target.closest('[data-schema-import]')) {
            const input = element.querySelector('[data-schema-example-input]');
            const error = element.querySelector('[data-schema-import-error]');
            try {
                const example = JSON.parse(input.value);
                if (!example || typeof example !== 'object' || Array.isArray(example)) throw new Error('The example must be one JSON object.');
                tree = { children: Object.entries(example).map(([name, value]) => inferNode(name, value)), extras: {}, allowExtra: false };
                render();
            } catch (parseError) {
                error.textContent = parseError.message;
            }
        }
    };

    const handleFieldChange = event => {
        const action = event.target.dataset.schemaAction;
        const row = event.target.closest('[data-schema-id]');
        if (!action || !row) return;
        const node = findNode(tree.children, Number(row.dataset.schemaId));
        if (!node) return;
        if (action === 'required') node.required = event.target.checked;
        else node[action] = event.target.value;
        if (action === 'kind' && GROUP_KINDS.has(node.kind) && !node.children.length) node.children.push(newNode());
        if (action === 'kind' || action === 'rule') render();
        else syncRaw();
    };

    const syncFromRaw = () => {
        try {
            const nextSchema = JSON.parse(schemaInput.value || '{}');
            const nextInvariants = JSON.parse(invariantsInput.value || '[]');
            if (!nextSchema || typeof nextSchema !== 'object' || Array.isArray(nextSchema)) return;
            if (!Array.isArray(nextInvariants)) return;
            rawInvariants = nextInvariants;
            preservedInvariants = rawInvariants.filter(rule => !FRIENDLY_RULES.has(rule?.type));
            tree = schemaToTree(nextSchema, rawInvariants);
            render();
        } catch {
            // The save path reports precise JSON errors; do not erase a visual
            // draft merely because the expert textarea is temporarily invalid.
        }
    };

    element.addEventListener('click', handleClick);
    element.addEventListener('input', handleFieldChange);
    element.addEventListener('change', handleFieldChange);
    schemaInput.addEventListener('change', syncFromRaw);
    invariantsInput.addEventListener('change', syncFromRaw);
    render();

    return {
        el: element,
        getValue() {
            const names = [];
            walkNodes(tree.children, [], (node, path) => {
                if (!node.name.trim()) throw new Error('Every remembered field needs a name.');
                if (node.name.includes('.') || node.name === '*') throw new Error(`Remembered field “${node.name}” cannot contain a dot or be named *.`);
                const parent = path.slice(0, -1).join('.');
                const key = `${parent}:${node.name.toLowerCase()}`;
                if (names.includes(key)) throw new Error(`The field “${node.name}” is duplicated in the same group.`);
                names.push(key);
            });
            if (!tree.children.length) throw new Error('Add at least one remembered field for structured memory.');
            return { schema: treeToSchema(tree), invariants: treeToInvariants(tree, preservedInvariants) };
        },
        destroy() {
            element.removeEventListener('click', handleClick);
            element.removeEventListener('input', handleFieldChange);
            element.removeEventListener('change', handleFieldChange);
            schemaInput.removeEventListener('change', syncFromRaw);
            invariantsInput.removeEventListener('change', syncFromRaw);
        },
    };
}

export const structuredMemoryModel = Object.freeze({
    schemaToTree,
    treeToSchema,
    treeToInvariants,
    treeToExample,
});
