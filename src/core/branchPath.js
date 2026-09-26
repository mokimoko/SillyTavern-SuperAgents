/** Compact, backward-compatible swipe-branch identities for story-app records. */

function swipeId(value) {
    const number = Number(value);
    return Number.isInteger(number) && number >= 0 ? number : 0;
}

function resolveBranchHead(chat, options) {
    if (!Array.isArray(chat) || chat.length === 0) return null;
    const requestedIndex = options.messageIndex == null ? NaN : Number(options.messageIndex);
    const messageIndex = Number.isInteger(requestedIndex)
        ? Math.max(0, Math.min(requestedIndex, chat.length - 1))
        : chat.length - 1;
    const requestedSwipe = options.swipeId == null ? NaN : Number(options.swipeId);
    const activeSwipe = Number.isInteger(requestedSwipe) && requestedSwipe >= 0
        ? requestedSwipe
        : swipeId(chat[messageIndex]?.swipe_id);
    return { messageIndex, swipeId: activeSwipe };
}

export function resolveChatBranch(chat, options = {}) {
    const head = resolveBranchHead(chat, options);
    if (!head) return { messageIndex: null, swipeId: null, branchPath: null };
    const branchPath = chat.slice(0, head.messageIndex + 1).map((message, index) => (
        index === head.messageIndex ? head.swipeId : swipeId(message?.swipe_id)
    ));
    return { ...head, branchPath };
}

/** Queue identity scans swipes without allocating the full branch path. */
export function resolveQueueBranch(chat, options = {}) {
    const head = resolveBranchHead(chat, options);
    if (!head) return { messageIndex: null, swipeId: null, queuePath: '0|' };
    let queuePath = `${head.messageIndex + 1}|`;
    for (let index = 0; index <= head.messageIndex; index++) {
        const activeSwipe = index === head.messageIndex ? head.swipeId : swipeId(chat[index]?.swipe_id);
        if (activeSwipe > 0) queuePath += `${index}:${activeSwipe},`;
    }
    return { ...head, queuePath };
}

function compactView(value) {
    if (Array.isArray(value)) {
        return {
            v: 1,
            l: value.length,
            s: value.flatMap((item, index) => {
                const swipe = swipeId(item);
                return swipe > 0 ? [[index, swipe]] : [];
            }),
        };
    }
    if (!value || typeof value !== 'object' || Number(value.v) !== 1) return null;
    const length = Math.max(0, Math.floor(Number(value.l) || 0));
    const seen = new Set();
    const swipes = Array.isArray(value.s) ? value.s
        .map(pair => [Math.floor(Number(pair?.[0])), swipeId(pair?.[1])])
        .filter(([index, swipe]) => index >= 0 && index < length && swipe > 0 && !seen.has(index) && seen.add(index))
        .sort((a, b) => a[0] - b[0]) : [];
    return { v: 1, l: length, s: swipes };
}

export function compactBranchPath(value) {
    const compact = compactView(value);
    return compact?.l > 0 ? compact : null;
}

export function cloneBranchPath(value) {
    const compact = compactBranchPath(value);
    return compact ? { ...compact, s: compact.s.map(pair => [...pair]) } : null;
}

export function branchPathLength(value) {
    return compactView(value)?.l ?? 0;
}

export function deletedTailStart(chat, messageIndex) {
    const index = Number(messageIndex);
    return messageIndex != null && Number.isInteger(index) && index >= 0
        ? Math.min(index, chat?.length ?? 0)
        : chat?.length ?? 0;
}

export function isAnchoredInDeletedTail(entry, firstDeletedIndex) {
    const index = entry?.messageIndex == null ? NaN : Number(entry.messageIndex);
    return (Number.isInteger(index) && index >= firstDeletedIndex)
        || branchPathLength(entry?.branchPath) > firstDeletedIndex;
}

/** True when the stored branch is a prefix of the currently viewed branch. */
export function isBranchPathVisible(storedValue, currentValue) {
    const stored = compactView(storedValue);
    const current = compactView(currentValue);
    if (!stored || !current || current.l < stored.l) return false;

    let storedIndex = 0;
    let currentIndex = 0;
    while (storedIndex < stored.s.length || currentIndex < current.s.length) {
        const storedPair = stored.s[storedIndex];
        const currentPair = current.s[currentIndex];
        const storedMessage = storedPair?.[0] ?? Infinity;
        const currentMessage = currentPair?.[0] ?? Infinity;
        if (currentMessage >= stored.l && storedMessage === Infinity) break;
        if (storedMessage !== currentMessage) return false;
        if (storedPair[1] !== currentPair[1]) return false;
        storedIndex++;
        currentIndex++;
    }
    return true;
}
