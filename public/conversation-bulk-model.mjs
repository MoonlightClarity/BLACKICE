/** Guard bulk mutations against stale lists, changing state, and live work. */
export function resolveBulkConversations(selection, resolve, action) {
  if (!(selection instanceof Map) || selection.size === 0) throw new Error('Select at least one conversation.');
  if (!['archive', 'restore', 'delete'].includes(action)) throw new Error('Choose a supported conversation action.');
  const entries = [];
  for (const [id, expected] of selection) {
    const current = resolve(id);
    if (!current || current.runId !== expected?.runId || current.state !== expected?.state) {
      throw new Error('One of the selected conversations changed. Review the selection before continuing.');
    }
    if (action === 'archive' && current.state !== 'active') throw new Error('Only active conversations can be archived.');
    if (action === 'restore' && current.state === 'active') throw new Error('Only archived or trashed conversations can be restored.');
    if (action === 'delete' && current.state === 'deleted') throw new Error('This conversation is already in Trash.');
    if (action === 'delete' && current.working) throw new Error('Stop working conversations before moving them to Trash.');
    entries.push(current);
  }
  return entries;
}
