/**
 * Agent-list ordering helpers. The management list mirrors the effective
 * State Card stacking order and exposes one lightweight native drag binding.
 */

export function getAgentStackOrder(agent) {
    const value = Number(agent?.stateCard?.order ?? agent?.injection?.order ?? 100);
    return Number.isFinite(value) ? value : 100;
}

export function sortAgentsForStacking(agents) {
    return [...(agents || [])]
        .map((agent, index) => ({ agent, index }))
        .sort((left, right) => (
            (getAgentStackOrder(left.agent) - getAgentStackOrder(right.agent))
            || (left.index - right.index)
        ))
        .map(entry => entry.agent);
}

/**
 * Make direct child agent cards reorderable from their grip. Persistence is
 * deferred until drag-end so pointer movement never causes settings writes.
 * Arrow keys on a focused grip provide the same operation without a mouse.
 */
export function bindAgentListOrdering(list, onReorder) {
    if (!list || typeof onReorder !== 'function') return;

    let draggedCard = null;
    let startOrder = '';
    const cards = () => [...list.querySelectorAll(':scope > .sam-agent-card')];
    const currentOrder = () => cards().map(card => card.dataset.agentId).filter(Boolean);

    const commitIfChanged = () => {
        const nextOrder = currentOrder();
        if (nextOrder.join('\u0000') !== startOrder) onReorder(nextOrder);
    };

    list.querySelectorAll('.sam-agent-drag-handle').forEach(handle => {
        handle.addEventListener('dragstart', event => {
            draggedCard = handle.closest('.sam-agent-card');
            if (!draggedCard) return;
            startOrder = currentOrder().join('\u0000');
            draggedCard.classList.add('sam-agent-card-dragging');
            list.classList.add('sam-agent-list-dragging');
            handle.setAttribute('aria-grabbed', 'true');
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', draggedCard.dataset.agentId || '');
            event.dataTransfer.setDragImage(draggedCard, 18, draggedCard.offsetHeight / 2);
        });

        handle.addEventListener('dragend', () => {
            if (!draggedCard) return;
            commitIfChanged();
            draggedCard.classList.remove('sam-agent-card-dragging');
            list.classList.remove('sam-agent-list-dragging');
            handle.setAttribute('aria-grabbed', 'false');
            draggedCard = null;
            startOrder = '';
        });

        handle.addEventListener('keydown', event => {
            if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
            const card = handle.closest('.sam-agent-card');
            const sibling = event.key === 'ArrowUp'
                ? card?.previousElementSibling
                : card?.nextElementSibling;
            if (!card || !sibling?.classList.contains('sam-agent-card')) return;

            event.preventDefault();
            startOrder = currentOrder().join('\u0000');
            if (event.key === 'ArrowUp') list.insertBefore(card, sibling);
            else list.insertBefore(sibling, card);
            commitIfChanged();
            handle.focus();
        });
    });

    list.addEventListener('dragover', event => {
        if (!draggedCard) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';

        const nextCard = cards()
            .filter(card => card !== draggedCard)
            .find(card => event.clientY < card.getBoundingClientRect().top + card.offsetHeight / 2);
        list.insertBefore(draggedCard, nextCard || null);

        const scrollPane = list.closest('.sam-content');
        const bounds = scrollPane?.getBoundingClientRect();
        if (!scrollPane || !bounds) return;
        if (event.clientY < bounds.top + 36) scrollPane.scrollBy(0, -12);
        else if (event.clientY > bounds.bottom - 36) scrollPane.scrollBy(0, 12);
    });

    list.addEventListener('drop', event => {
        if (draggedCard) event.preventDefault();
    });
}
