/** Compact labels from the authored task; never changes the message itself. */
export function taskTitle(input, { max = 120, fallback = 'New task' } = {}) {
  const value = typeof input === 'string' ? input : typeof input?.task === 'string' ? input.task : '';
  const generic = /^(?:goal|task|objective|request|outcome|brief|prompt|context|build|problem|question|decision|what to do|your task)\s*:?$/i;
  const tidy = line => line.trim().replace(/^\uFEFF/, '').replace(/^#{1,6}\s+/, '').replace(/\s+#+\s*$/, '').replace(/^>\s*/, '').replace(/^(?:[-*+]\s+|\d+[.)]\s+)(?:\[[ xX]\]\s*)?/, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1').replace(/\s+/g, ' ').trim();
  let result = '';
  for (const line of value.split(/\r?\n/)) {
    if (!line.trim() || /^\s*(?:`{3,}|~{3,}|[-*_]{3,})/.test(line)) continue;
    // Labels need only a small prefix; keep pathological Markdown out of long regex scans.
    const cleaned = tidy(line.slice(0, 4096));
    if (!cleaned || generic.test(cleaned)) continue;
    result = cleaned.replace(/^(?:goal|task|objective|request|outcome)\s*:\s*(?=\S)/i, '');
    break;
  }
  const limit = Number.isSafeInteger(max) && max > 0 ? max : 120;
  const shortened = String(result || fallback).slice(0, limit);
  return shortened.replace(/[\uD800-\uDBFF]$/, '');
}
