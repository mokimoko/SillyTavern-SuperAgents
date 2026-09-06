const BEHAVIOR_PRIORITY = Object.freeze({ ambient: 0, consider: 1, send: 2 });

function strongerBehavior(left = 'ambient', right = 'ambient') {
    return (BEHAVIOR_PRIORITY[right] ?? 0) > (BEHAVIOR_PRIORITY[left] ?? 0) ? right : left;
}

/** Collect same-turn Phone requests by character+branch and execute them serially. */
export function createPhoneQueue({ execute, defer = callback => setTimeout(callback, 0) }) {
    const pending = new Map();
    let scheduled = false;
    let draining = false;

    async function drain() {
        if (draining) return;
        scheduled = false;
        draining = true;
        try {
            while (pending.size) {
                const [key, request] = pending.entries().next().value;
                pending.delete(key);
                request.reason = [...request.reasons].filter(Boolean).join('\n');
                request.sources = [...request.sources];
                try {
                    const result = await execute(request);
                    request.waiters.forEach(waiter => waiter.resolve(result));
                } catch (error) {
                    request.waiters.forEach(waiter => waiter.reject(error));
                }
            }
        } finally {
            draining = false;
            if (pending.size && !scheduled) schedule();
        }
    }

    function schedule() {
        if (scheduled) return;
        scheduled = true;
        defer(drain);
    }

    function enqueue(input) {
        return new Promise((resolve, reject) => {
            const key = String(input.key || 'phone');
            const existing = pending.get(key);
            if (existing) {
                existing.behavior = strongerBehavior(existing.behavior, input.behavior);
                if (input.reason) existing.reasons.add(input.reason);
                if (input.source) existing.sources.add(input.source);
                if (input.agent) existing.agent = input.agent;
                if (input.message) existing.message = input.message;
                if (Number.isInteger(input.messageIndex)) existing.messageIndex = input.messageIndex;
                existing.waiters.push({ resolve, reject });
            } else {
                pending.set(key, {
                    ...input,
                    behavior: input.behavior || 'ambient',
                    reasons: new Set(input.reason ? [input.reason] : []),
                    sources: new Set(input.source ? [input.source] : []),
                    waiters: [{ resolve, reject }],
                });
            }
            schedule();
        });
    }

    function clear(reason = 'phone queue cleared') {
        for (const request of pending.values()) {
            const result = { accepted: false, textsGenerated: 0, error: reason };
            request.waiters.forEach(waiter => waiter.resolve(result));
        }
        pending.clear();
    }

    return Object.freeze({
        enqueue,
        clear,
        isBusy: () => draining || pending.size > 0,
        pendingCount: () => pending.size,
    });
}
