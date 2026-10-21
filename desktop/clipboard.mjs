// This capability is exposed only to BLACKICE's own top-level desktop window.
// It has no read operation, server endpoint, selectable format or arbitrary IPC.
export const MAX_CLIPBOARD_CHARS = 4 * 1024 * 1024;

export function isTrustedDesktopSender(event, mainWindow, origin) {
  if (!mainWindow || mainWindow.isDestroyed() || !event || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) return false;
  try {
    const url = new URL(event.senderFrame.url);
    return url.origin === origin && ['/', '/index.html'].includes(url.pathname);
  } catch { return false; }
}

export function createClipboardHandler({ trustedSender, writeText }) {
  if (typeof trustedSender !== 'function' || typeof writeText !== 'function') throw new TypeError('Clipboard requires a scoped sender check and writer.');
  return (event, ...args) => {
    if (!trustedSender(event)) throw new Error('BLACKICE desktop request is not allowed.');
    if (args.length !== 1 || typeof args[0] !== 'string' || !args[0].length || args[0].length > MAX_CLIPBOARD_CHARS) throw new Error('Choose text within the clipboard size limit.');
    try { writeText(args[0]); }
    catch { throw new Error('The desktop clipboard is unavailable. Try copying again.'); }
    return { copied: true };
  };
}
