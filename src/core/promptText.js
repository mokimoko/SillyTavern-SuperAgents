/** Keep optional app history useful without letting a long entry dominate the main prompt. */
export function truncatePromptText(value, maxChars) {
    const text = String(value ?? '').replace(/\s+/g, ' ').trim();
    if (text.length <= maxChars) return text;
    const prefix = text.slice(0, maxChars - 1);
    const lastSpace = prefix.lastIndexOf(' ');
    const end = lastSpace >= Math.floor(maxChars * 0.75) ? lastSpace : prefix.length;
    return `${prefix.slice(0, end).trimEnd()}…`;
}

/** Keep the newest complete lines within a shared character budget. */
export function recentPromptLines(lines, maxChars) {
    const selected = [];
    let length = 0;
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        const added = line.length + (selected.length ? 1 : 0);
        if (length + added > maxChars) break;
        selected.unshift(line);
        length += added;
    }
    return selected;
}
