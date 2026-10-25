/** Privacy-preserving Electron child-process diagnostics.
 * No URL, page title, model text, command output or user profile contents.
 */
const allowedReasons = new Set([
  'clean-exit', 'abnormal-exit', 'killed', 'crashed', 'oom',
  'launch-failed', 'integrity-failure', 'memory-eviction',
]);
const allowedTypes = new Set(['renderer','GPU','Utility','Zygote','Sandbox helper','Pepper Plugin','Pepper Plugin Broker','Unknown']);
export function electronExitReceipt(type, details = {}, webContentsId) {
  const processType = allowedTypes.has(type) ? type : 'Unknown';
  const reason = allowedReasons.has(details?.reason) ? details.reason : 'unknown';
  const event = {
    component: 'electron-process',
    event: 'process_gone',
    level: reason === 'clean-exit' ? 'info' : reason === 'killed' ? 'warning' : 'error',
    processType, reason,
  };
  if (Number.isSafeInteger(details?.exitCode)) event.exitCode = details.exitCode;
  if (Number.isSafeInteger(webContentsId) && webContentsId > 0 && processType === 'renderer')
    event.webContentsId = webContentsId;
  return event;
}
