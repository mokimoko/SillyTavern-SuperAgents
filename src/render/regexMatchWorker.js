const MAX_MATCHES = 5000;
const MATCH_TIME_BUDGET_MS = 250;

self.onmessage = ({ data }) => {
    const { source, flags, text } = data;
    try {
        const regex = new RegExp(source, flags);
        const matches = [];
        const deadline = performance.now() + MATCH_TIME_BUDGET_MS;
        let match;
        while ((match = regex.exec(text)) !== null) {
            matches.push({
                fullMatch: match[0],
                groups: Array.from(match).slice(1),
                allGroups: Array.from(match),
                index: match.index,
            });
            if (matches.length >= MAX_MATCHES || performance.now() > deadline) break;
            if (match[0].length === 0) regex.lastIndex++;
            if (!regex.global) break;
        }
        self.postMessage({ matches });
    } catch {
        self.postMessage({ matches: [] });
    }
};
