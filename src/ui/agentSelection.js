const selectedAgentIds = new Set();

export function getSelectedAgentIds() {
    return selectedAgentIds;
}

export function clearAgentSelection() {
    selectedAgentIds.clear();
}

export function setAgentSelected(agentId, selected) {
    if (!agentId) return;
    if (selected) selectedAgentIds.add(agentId);
    else selectedAgentIds.delete(agentId);
}

export function setAllAgentsSelected(agentIds, selected) {
    selectedAgentIds.clear();
    if (!selected) return;
    for (const agentId of agentIds || []) {
        if (agentId) selectedAgentIds.add(agentId);
    }
}

export function pruneAgentSelection(agentIds) {
    const validIds = new Set(agentIds || []);
    for (const agentId of selectedAgentIds) {
        if (!validIds.has(agentId)) selectedAgentIds.delete(agentId);
    }
}

export function getAgentSelectionState(agentIds) {
    const ids = [...(agentIds || [])].filter(Boolean);
    pruneAgentSelection(ids);
    const selectedCount = selectedAgentIds.size;
    const allSelected = ids.length > 0 && selectedCount === ids.length;
    return {
        allSelected,
        partiallySelected: selectedCount > 0 && !allSelected,
        selectedCount,
        total: ids.length,
    };
}
