/** Render a plain custom sidecar result without requiring a bespoke hook. */
export function renderGenericOutput(el) {
    let content = (el.textContent || '').trim();
    if (!content) return;

    // Batched single-field results can arrive as a JSON string.
    if (content.startsWith('"') && content.endsWith('"')) {
        try { content = JSON.parse(content); } catch { /* keep original */ }
    }

    const name = (el.getAttribute('data-agent-name') || 'Agent output').trim();
    const iconClass = (el.getAttribute('data-agent-icon') || 'fa-solid fa-robot').trim();

    const panel = document.createElement('details');
    panel.className = 'sa-generic-output-rendered';

    const summary = document.createElement('summary');
    summary.className = 'sa-generic-output-summary';

    const icon = document.createElement('i');
    icon.className = iconClass;
    icon.setAttribute('aria-hidden', 'true');

    const label = document.createElement('span');
    label.textContent = name;

    const hint = document.createElement('span');
    hint.className = 'sa-generic-output-hint';
    hint.textContent = 'agent note';

    const body = document.createElement('div');
    body.className = 'sa-generic-output-body';
    body.textContent = String(content);

    summary.append(icon, label, hint);
    panel.append(summary, body);
    el.replaceWith(panel);
}
