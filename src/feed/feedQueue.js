const PRIORITY = Object.freeze({ ambient: 0, consider: 1, publish: 2 });

function stronger(left = 'ambient', right = 'ambient') {
    return (PRIORITY[right] ?? 0) > (PRIORITY[left] ?? 0) ? right : left;
}

/** Merge same-branch Feed cues and serialize calls so multiple events become one decision. */
export function createFeedQueue({ execute, defer = callback => setTimeout(callback, 0) }) {
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
            const key = String(input.key || 'feed');
            const existing = pending.get(key);
            if (existing) {
                existing.behavior = stronger(existing.behavior, input.behavior);
                if (input.reason) existing.reasons.add(input.reason);
                if (input.source) existing.sources.add(input.source);
                if (input.agent) existing.agent = input.agent;
                if (input.message) existing.message = input.message;
                if (input.author) existing.author = input.author;
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

    function clear(reason = 'feed queue cleared') {
        for (const request of pending.values()) {
            request.waiters.forEach(waiter => waiter.resolve({ accepted: false, postsGenerated: 0, error: reason }));
        }
        pending.clear();
    }

    return Object.freeze({ enqueue, clear, isBusy: () => draining || pending.size > 0 });
}
