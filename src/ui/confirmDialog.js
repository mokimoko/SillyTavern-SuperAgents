const escapeHtml = value => String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

let closeActiveDialog = null;

export function samConfirm(message, {
    confirmText = 'Delete',
    cancelText = 'Cancel',
    danger = true,
} = {}) {
    closeActiveDialog?.(false);

    return new Promise(resolve => {
        let settled = false;
        const overlay = document.createElement('div');
        overlay.id = 'sam-confirm-overlay';
        overlay.className = 'sam-confirm-overlay';
        overlay.innerHTML = `
            <div class="sam-confirm-box" role="dialog" aria-modal="true" aria-labelledby="sam-confirm-message">
                <div class="sam-confirm-msg" id="sam-confirm-message">${escapeHtml(message)}</div>
                <div class="sam-confirm-buttons">
                    <button class="sam-btn" data-sam-confirm="cancel" type="button">${escapeHtml(cancelText)}</button>
                    <button class="sam-btn ${danger ? 'sam-btn-danger' : 'sam-btn-accent'}" data-sam-confirm="ok" type="button">${escapeHtml(confirmText)}</button>
                </div>
            </div>`;
        document.body.appendChild(overlay);

        const cleanup = result => {
            if (settled) return;
            settled = true;
            document.removeEventListener('keydown', onKeyDown);
            overlay.classList.remove('sam-visible');
            setTimeout(() => overlay.remove(), 200);
            closeActiveDialog = null;
            resolve(result);
        };
        const onKeyDown = event => {
            if (event.key === 'Escape') cleanup(false);
        };
        closeActiveDialog = cleanup;

        overlay.querySelector('[data-sam-confirm="ok"]')?.addEventListener('click', () => cleanup(true));
        overlay.querySelector('[data-sam-confirm="cancel"]')?.addEventListener('click', () => cleanup(false));
        overlay.addEventListener('click', event => {
            if (event.target === overlay) cleanup(false);
        });
        document.addEventListener('keydown', onKeyDown);
        requestAnimationFrame(() => {
            overlay.classList.add('sam-visible');
            overlay.querySelector('[data-sam-confirm="cancel"]')?.focus();
        });
    });
}
