// Match only immutable task-local metadata. Never resolve a filesystem path or foreign ID.
export function attachmentReferenceMatches(entry, reference) {
  if (!entry || typeof reference !== 'string' || !reference) return false;
  if (entry.id === reference) return true;
  if (/^file_/i.test(reference) || /[\\/\x00]/.test(reference) || reference === '.' || reference === '..') return false;
  if (typeof entry.name !== 'string') return false;
  const dot=entry.name.lastIndexOf('.');
  return reference === entry.name || (dot > 0 && reference === entry.name.slice(0,dot));
}
