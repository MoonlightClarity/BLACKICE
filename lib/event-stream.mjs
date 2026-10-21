// A false write means Node accepted bytes into its queue. Disconnect only when
// that queue exceeds the bound, so one slow viewer cannot retain every diff.
export const EVENT_STREAM_BUFFER_BYTES = 8 * 1024 * 1024;
export function writeEventStream(response, text, { maxBufferBytes = EVENT_STREAM_BUFFER_BYTES } = {}) {
  if (response.destroyed || response.writableEnded) return false;
  if (response.writableLength + Buffer.byteLength(text) > maxBufferBytes) { response.destroy(); return false; }
  try { response.write(text); return true; }
  catch { response.destroy(); return false; }
}
