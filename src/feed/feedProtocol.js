const AUDIENCES = new Set(['public', 'shared', 'selected']);

function firstBalancedObject(text) {
    const source = String(text ?? '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
    let start = -1;
    let depth = 0;
    let quoted = false;
    let escaped = false;

    for (let index = 0; index < source.length; index++) {
        const char = source[index];
        if (quoted) {
            if (escaped) escaped = false;
            else if (char === '\\') escaped = true;
            else if (char === '"') quoted = false;
            continue;
        }
        if (char === '"') { quoted = true; continue; }
        if (char === '{') {
            if (start < 0) start = index;
            depth++;
        } else if (char === '}' && start >= 0) {
            depth--;
            if (depth === 0) return source.slice(start, index + 1);
        }
    }
    return '';
}

function clean(value, maxLength) {
    return String(value ?? '').trim().slice(0, maxLength);
}

export function parseFeedDecision(response, { fallbackAuthor = 'Character', maxComments = 3 } = {}) {
    const json = firstBalancedObject(response);
    if (!json) throw new Error('Feed response did not contain a JSON object');

    let raw;
    try { raw = JSON.parse(json); } catch { throw new Error('Feed response contained invalid JSON'); }
    const result = raw?.result === 'publish' ? 'publish' : 'withhold';
    if (result === 'withhold') {
        return { result, continuity: clean(raw?.continuity, 1000) };
    }

    const content = clean(raw?.post?.content ?? raw?.post?.text, 4000);
    if (!content) throw new Error('Published Feed response has no post text');
    const author = clean(raw?.post?.author, 120) || fallbackAuthor;
    const comments = Array.isArray(raw?.comments)
        ? raw.comments.slice(0, Math.max(0, maxComments)).map(comment => ({
            author: clean(comment?.author, 120),
            content: clean(comment?.content ?? comment?.text, 1000),
        })).filter(comment => comment.author && comment.content)
        : [];

    return {
        result,
        post: {
            author,
            content,
            audience: AUDIENCES.has(raw?.post?.audience) ? raw.post.audience : 'shared',
        },
        comments,
        continuity: clean(raw?.continuity, 1000),
    };
}

function identityKey(value) {
    return String(value ?? '').trim().toLocaleLowerCase();
}

export function isUserIdentity(value, userName) {
    const key = identityKey(value);
    return Boolean(key) && [identityKey(userName), identityKey('{{user}}')].filter(Boolean).includes(key);
}

/** Generated social activity may never act for the user's persona. */
export function enforceGeneratedIdentity(decision, { author, userName } = {}) {
    if (!decision || decision.result !== 'publish') return decision;
    const resolvedAuthor = String(author || '').trim();
    if (!resolvedAuthor || isUserIdentity(resolvedAuthor, userName)) {
        throw new Error('Feed generation cannot act as the user persona');
    }

    const allowedActor = actor => !isUserIdentity(actor?.author, userName);
    return {
        ...decision,
        post: { ...decision.post, author: resolvedAuthor },
        comments: (decision.comments || []).filter(allowedActor),
        reactions: (decision.reactions || []).filter(allowedActor),
    };
}
