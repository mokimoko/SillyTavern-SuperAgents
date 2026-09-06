/** Character, tag, and group activation scope for agents. */

import { characters, this_chid } from '../../../../../../script.js';
import { getContext } from '../../../../../extensions.js';
import { tag_map as tagMap } from '../../../../../tags.js';

export function scopeMatches(scope, context) {
    const mode = scope?.mode || 'any';
    if (mode === 'any') return true;

    if (mode === 'character') {
        const bindings = scope?.characterBindings ?? [];
        if (!bindings.length || !context.avatar) return false;
        const avatar = context.avatar.toLowerCase();
        return bindings.some(binding => String(binding).toLowerCase() === avatar);
    }

    if (mode === 'tag') {
        const bindings = scope?.tagBindings ?? [];
        if (!bindings.length) return false;
        return bindings.some(binding => context.tagIds.includes(String(binding)));
    }

    if (mode === 'group') {
        const bindings = scope?.groupBindings ?? [];
        if (!bindings.length || !context.groupId) return false;
        return bindings.some(binding => String(binding) === context.groupId);
    }

    return true;
}

export function getCurrentScopeContext() {
    const context = getContext();
    const groupId = context?.groupId ? String(context.groupId) : '';
    const character = !groupId && this_chid !== undefined ? characters[this_chid] : null;
    const avatar = character?.avatar || '';
    const entityId = groupId || avatar;
    const tagIds = entityId && Array.isArray(tagMap?.[entityId])
        ? tagMap[entityId].map(String)
        : [];

    return { groupId, avatar, tagIds };
}

export function agentMatchesCurrentScope(agent) {
    return scopeMatches(agent?.scope, getCurrentScopeContext());
}

