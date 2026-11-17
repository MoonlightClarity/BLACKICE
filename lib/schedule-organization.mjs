// Organization only: never part of a deployment definition or scheduler decision.
export const emptyScheduleOrganization = () => ({ revision: 0, folders: [], assignments: {} });
export function scheduleOrganization(value) {
  return value ? structuredClone(value) : emptyScheduleOrganization();
}
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
export function changeScheduleOrganization(current, input, { id, deploymentIds = [] } = {}) {
  const next = scheduleOrganization(current);
  if (input.expectedRevision !== next.revision) throw fail('Folders changed. Refresh before saving.', 409);
  const folder = next.folders.find(item => item.id === input.id);
  const parentId = input.parentId || null;
  if (['create', 'update'].includes(input.action)) {
    const name = String(input.name || '').trim();
    if (!name || name.length > 120) throw fail('Give the folder a name of 1–120 characters.');
    if (parentId && !next.folders.some(item => item.id === parentId)) throw fail('Parent folder not found.', 404);
    if (input.action === 'create') next.folders.push({ id, name, parentId });
    else {
      if (!folder) throw fail('Folder not found.', 404);
      const visited = new Set([folder.id]);
      for (let parent = parentId; parent;) {
        if (visited.has(parent)) throw fail('A folder cannot be moved inside itself.');
        visited.add(parent);
        parent = next.folders.find(item => item.id === parent)?.parentId;
      }
      Object.assign(folder, { name, parentId });
    }
  } else if (input.action === 'remove') {
    if (!folder) throw fail('Folder not found.', 404);
    next.folders = next.folders.filter(item => item.id !== folder.id);
    for (const child of next.folders) if (child.parentId === folder.id) child.parentId = folder.parentId || null;
    for (const [key, value] of Object.entries(next.assignments)) if (value === folder.id) delete next.assignments[key];
  } else if (input.action === 'assign') {
    if (!deploymentIds.includes(input.deploymentId)) throw fail('Schedule not found.', 404);
    if (input.folderId && !next.folders.some(item => item.id === input.folderId)) throw fail('Folder not found.', 404);
    if (input.folderId) next.assignments[input.deploymentId] = input.folderId;
    else delete next.assignments[input.deploymentId];
  } else throw fail('Unknown folder action.');
  next.revision++;
  return next;
}
