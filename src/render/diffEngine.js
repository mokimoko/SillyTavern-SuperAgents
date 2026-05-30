/**
 * render/diffEngine.js — pure diff rendering for the ReCast-style viewer.
 *
 * v0 scope (per RECAST_DIFF_GAMEPLAN.md, "read-only diff + revert"):
 * this module is DOM-free and side-effect-free. It turns an (originalText,
 * resultText) pair into escaped inline HTML with <del>/<ins> spans.
 *
 * The gameplan assumed ST bundled jsdiff as a global `Diff`. It does not —
 * ReCast hand-rolls Myers in util/diffViewer.js for exactly this reason.
 * Rather than vendor jsdiff or port Myers, this module uses a token-level
 * LCS dynamic-programming diff. ~30 lines, mathematically correct, O(n*m)
 * memory and time. Prefix/suffix stripping keeps the DP confined to the
 * actually-changed middle, so prose rewrites where 80%+ is unchanged stay
 * cheap. A cell-count cap (1M) bails to a coarse delete-old/insert-new diff
 * for pathological cases so we never blow up memory.
 *
 * Kept deliberately small and testable. If per-change accept/reject lands in
 * v1, buildSegments()/rebuild() get added here without disturbing these.
 */

// Bail to plain escaped text past this combined length, so a pathological
// rewrite (e.g. a whole-document replace) can't lock the UI on diffing.
const MAX_DIFF_CHARS = 200000;

// Hard cap on DP cells (oldMid.length * newMid.length). Above this we fall
// back to a coarse "delete all of old middle, insert all of new middle" diff
// — accurate but not as readable. ~1M cells ≈ 4 MB for Int32Array rows.
const MAX_DP_CELLS = 1_000_000;

/**
 * Escape HTML-significant characters so message text can't inject markup into
 * the diff popup.
 * @param {string} str
 * @returns {string}
 */
export function escapeHtml(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * Tokenize text into words and whitespace runs. Whitespace is kept as its own
 * tokens so the diff round-trips (concatenating tokens reproduces the input).
 * @param {string} text
 * @returns {string[]}
 */
function tokenize(text) {
    if (!text) return [];
    // split on whitespace runs, keeping them as separate tokens via the
    // capturing group. Empty strings from edge splits are filtered out.
    return text.split(/(\s+)/).filter(t => t.length > 0);
}

/**
 * Compute a token-level diff via LCS DP, returning a list of parts shaped
 * like jsdiff: `[{value, added?, removed?}, ...]`. Adjacent same-type ops
 * are merged so we emit one span per change run rather than one per token.
 *
 * @param {string[]} a — old tokens
 * @param {string[]} b — new tokens
 * @returns {Array<{value: string, added?: boolean, removed?: boolean}>}
 */
function lcsDiff(a, b) {
    const m = a.length;
    const n = b.length;

    // DP table of LCS lengths.
    const dp = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            if (a[i - 1] === b[j - 1]) dp[i][j] = dp[i - 1][j - 1] + 1;
            else dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
        }
    }

    // Backtrack, building reversed ops then flipping at the end so we can
    // merge adjacent same-type ops as we go.
    const out = [];
    let i = m, j = n;
    const push = (kind, tok) => {
        const last = out[out.length - 1];
        if (last && last.kind === kind) last.value = tok + last.value;
        else out.push({ kind, value: tok });
    };
    while (i > 0 && j > 0) {
        if (a[i - 1] === b[j - 1]) {
            push('eq', a[i - 1]); i--; j--;
        } else if (dp[i - 1][j] >= dp[i][j - 1]) {
            push('del', a[i - 1]); i--;
        } else {
            push('ins', b[j - 1]); j--;
        }
    }
    while (i > 0) { push('del', a[i - 1]); i--; }
    while (j > 0) { push('ins', b[j - 1]); j--; }

    // We built right-to-left; reverse for normal order. Then translate to the
    // jsdiff-shaped parts the renderer expects.
    out.reverse();
    return out.map(({ kind, value }) => {
        if (kind === 'ins') return { value, added: true };
        if (kind === 'del') return { value, removed: true };
        return { value };
    });
}

/**
 * Compute jsdiff-shaped parts for the full (original, result) pair, including
 * the prefix/suffix stripping optimization and the DP-cell safety bail.
 * @param {string} original
 * @param {string} result
 * @returns {Array<{value:string, added?:boolean, removed?:boolean}>}
 */
function computeParts(original, result) {
    const a = tokenize(original);
    const b = tokenize(result);

    // Strip common prefix.
    let pre = 0;
    while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
    // Strip common suffix (operating on the remaining slices).
    let suf = 0;
    while (
        suf < a.length - pre &&
        suf < b.length - pre &&
        a[a.length - 1 - suf] === b[b.length - 1 - suf]
    ) suf++;

    const aMid = a.slice(pre, a.length - suf);
    const bMid = b.slice(pre, b.length - suf);

    let midParts;
    if (aMid.length * bMid.length > MAX_DP_CELLS) {
        // Coarse fallback: mark whole changed middle as one delete + one insert.
        midParts = [];
        if (aMid.length) midParts.push({ value: aMid.join(''), removed: true });
        if (bMid.length) midParts.push({ value: bMid.join(''), added: true });
    } else if (aMid.length === 0 && bMid.length === 0) {
        midParts = [];
    } else if (aMid.length === 0) {
        midParts = [{ value: bMid.join(''), added: true }];
    } else if (bMid.length === 0) {
        midParts = [{ value: aMid.join(''), removed: true }];
    } else {
        midParts = lcsDiff(aMid, bMid);
    }

    const parts = [];
    const prefixStr = a.slice(0, pre).join('');
    const suffixStr = a.slice(a.length - suf).join('');
    if (prefixStr) parts.push({ value: prefixStr });
    parts.push(...midParts);
    if (suffixStr) parts.push({ value: suffixStr });
    return parts;
}

/**
 * Render an inline word-level diff of originalText → resultText as an HTML
 * string. Deletions are wrapped in <del class="sa-diff-del">, insertions in
 * <ins class="sa-diff-ins">, unchanged runs are plain escaped text.
 *
 * Degrades gracefully past MAX_DIFF_CHARS combined input.
 *
 * @param {string} originalText
 * @param {string} resultText
 * @returns {string} HTML
 */
export function renderInlineHtml(originalText, resultText) {
    const original = String(originalText ?? '');
    const result = String(resultText ?? '');

    if (original.length + result.length > MAX_DIFF_CHARS) {
        return '<div class="sa-diff-toobig">Change is too large to diff inline. '
            + 'Showing the current text:</div><div class="sa-diff-plain">'
            + escapeHtml(result) + '</div>';
    }

    const parts = computeParts(original, result);

    let html = '';
    for (const part of parts) {
        const text = escapeHtml(part.value);
        if (part.added) {
            html += '<ins class="sa-diff-ins">' + text + '</ins>';
        } else if (part.removed) {
            html += '<del class="sa-diff-del">' + text + '</del>';
        } else {
            html += text;
        }
    }
    return '<div class="sa-diff-body">' + html + '</div>';
}
