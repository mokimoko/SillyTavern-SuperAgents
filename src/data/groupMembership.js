/**
 * Keep the two historical group-membership representations consistent.
 *
 * The Groups UI stores membership on `group.agentIds`, while older runtime and
 * imported data may store it on `agent.groupId`. A single agent can only execute
 * in one ordered group, so explicit group lists are authoritative. The agent
 * field is retained as a derived compatibility index for the execution engine
 * and older exports.
 */

function cleanId(value) {
    return typeof value === 'string' ? value.trim() : '';
}

/**
 * Reconcile group.agentIds and agent.groupId in place.
 *
 * Explicit group lists win. When `includeAgentFallback` is true, an unclaimed
 * agent's valid legacy groupId is appended to that group. Duplicate membership
 * is resolved in stored group order. A group's phase is authoritative for its
 * members because the editor describes the phase as when the group runs.
 *
 * @param {object[]} agents
 * @param {object[]} groups
 * @param {{includeAgentFallback?: boolean, syncPhase?: boolean}} [options]
 * @returns {{changed:boolean, claimed:number, duplicatesRemoved:number, staleRemoved:number, legacyRecovered:number}}
 */
export function reconcileGroupMembership(agents, groups, options = {}) {
    const includeAgentFallback = options.includeAgentFallback !== false;
    const syncPhase = options.syncPhase !== false;
    const agentById = new Map((agents || []).map(agent => [cleanId(agent?.id), agent]).filter(([id]) => id));
    const groupById = new Map((groups || []).map(group => [cleanId(group?.id), group]).filter(([id]) => id));
    const claimedBy = new Map();
    let changed = false;
    let duplicatesRemoved = 0;
    let staleRemoved = 0;
    let legacyRecovered = 0;

    // First pass: explicit group lists are the source of truth. Prune stale IDs,
    // local duplicates, and cross-group duplicates while preserving list order.
    for (const group of groups || []) {
        const groupId = cleanId(group?.id);
        const nextIds = [];
        const seenHere = new Set();
        for (const rawId of Array.isArray(group?.agentIds) ? group.agentIds : []) {
            const agentId = cleanId(rawId);
            if (!agentId || !agentById.has(agentId)) {
                staleRemoved++;
                changed = true;
                continue;
            }
            if (seenHere.has(agentId) || claimedBy.has(agentId)) {
                duplicatesRemoved++;
                changed = true;
                continue;
            }
            seenHere.add(agentId);
            claimedBy.set(agentId, groupId);
            nextIds.push(agentId);
        }
        if (!Array.isArray(group.agentIds)
            || nextIds.length !== group.agentIds.length
            || nextIds.some((id, index) => id !== group.agentIds[index])) {
            group.agentIds = nextIds;
            changed = true;
        }
    }

    // Second pass: recover legacy/imported data that only populated agent.groupId.
    if (includeAgentFallback) {
        for (const agent of agents || []) {
            const agentId = cleanId(agent?.id);
            const legacyGroupId = cleanId(agent?.groupId);
            if (!agentId || claimedBy.has(agentId) || !groupById.has(legacyGroupId)) continue;
            groupById.get(legacyGroupId).agentIds.push(agentId);
            claimedBy.set(agentId, legacyGroupId);
            legacyRecovered++;
            changed = true;
        }
    }

    // Materialize the compatibility index and the effective group phase.
    for (const agent of agents || []) {
        const agentId = cleanId(agent?.id);
        const groupId = claimedBy.get(agentId) || null;
        if (agent.groupId !== groupId) {
            agent.groupId = groupId;
            changed = true;
        }
        if (syncPhase && groupId) {
            const groupPhase = groupById.get(groupId)?.phase;
            if ((groupPhase === 'pre' || groupPhase === 'post') && agent.phase !== groupPhase) {
                agent.phase = groupPhase;
                changed = true;
            }
        }
    }

    return {
        changed,
        claimed: claimedBy.size,
        duplicatesRemoved,
        staleRemoved,
        legacyRecovered,
    };
}
