import { writeClipboard, clipboardFailureMessage } from '../../clipboard.mjs';

// Bind only generated Chat preview controls, never source-provided markup.
export function bindChatSvgPreviews(body, { copy = writeClipboard } = {}) {
  for (const figure of body.querySelectorAll('.chat-svg-preview')) {
    const image = figure.querySelector('img'), details = figure.querySelector('.chat-svg-source');
    const button = details?.querySelector('[data-copy-svg]'), source = details?.querySelector('pre > code');
    if (!image || !details || !button || !source) continue;
    const status = body.ownerDocument.createElement('span');
    status.className = 'chat-svg-copy-status'; status.setAttribute('role', 'status');
    button.after(status);
    button.addEventListener('click', async () => {
      if (button.disabled) return;
      button.disabled = true; status.textContent = '';
      try { await copy(source.textContent); status.textContent = 'Copied SVG source.'; }
      catch (error) { status.textContent = clipboardFailureMessage(error); }
      finally { button.disabled = false; }
    });
    const fallback = () => { image.hidden = true; details.open = true; status.textContent = 'Preview unavailable. SVG source is shown below.'; };
    image.addEventListener('error', fallback, { once: true });
    if (image.complete && !image.naturalWidth) fallback();
  }
}
