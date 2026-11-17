import { text } from '../core/dom.mjs';

// Folder edits affect organization only. Schedule controls remain owned by tasks.mjs.
export function createScheduleFolders({ mount, api, notify, refresh }) {
  let organization = { revision: 0, folders: [], assignments: {} }, pending = false, lastRevision = -1;
  const closed = new Set();
  let fileSelects = [];
  const add = (parent, tag, value, cls) => text(parent, value, tag, cls);
  const manager = add(mount, 'details', '', 'next-card next-schedule-folder-manager');
  add(manager, 'summary', 'Manage folders');
  add(manager, 'p', 'Folders organize cronjobs. Moving or removing a folder does not change schedules or run jobs.', 'next-help');
  const form = add(manager, 'form', '', 'next-schedule-folder-form');
  function field(label, tag, name) {
    const wrapper = add(form, 'label', label, 'next-label');
    const el = add(wrapper, tag, '', 'next-field'); el.name = name; return el;
  }
  const selected = field('Folder to edit', 'select', 'folder');
  const name = field('Folder name', 'input', 'name'); name.required = true; name.maxLength = 120;
  const parent = field('Create inside', 'select', 'parent');
  const actions = add(form, 'div', '', 'next-row');
  const save = add(actions, 'button', 'Create folder'); save.type = 'submit';
  const remove = add(actions, 'button', 'Remove folder'); remove.type = 'button'; remove.hidden = true;
  const notice = add(manager, 'p', '', 'next-help'); notice.setAttribute('role', 'status');
  function path(id, seen = new Set()) {
    const folder = organization.folders.find(item => item.id === id);
    if (!folder || seen.has(id)) return '';
    seen.add(id);
    return [path(folder.parentId, seen), folder.name].filter(Boolean).join(' / ');
  }
  function options(select, first, chosen = '') {
    select.replaceChildren(); const root = add(select, 'option', first); root.value = '';
    for (const folder of [...organization.folders].sort((a,b) => path(a.id).localeCompare(path(b.id)))) {
      const option = add(select, 'option', path(folder.id)); option.value = folder.id;
    }
    select.value = chosen;
  }
  function editSelection() {
    const folder = organization.folders.find(item => item.id === selected.value);
    name.value = folder?.name || ''; parent.value = folder?.parentId || '';
    save.textContent = folder ? 'Save folder' : 'Create folder'; remove.hidden = !folder;
    parent.parentElement.firstChild.textContent = folder ? 'Move inside' : 'Create inside';
  }
  selected.addEventListener('change', editSelection);
  async function mutate(payload) {
    if (pending) return false;
    for (const select of fileSelects) select.disabled = true;
    pending = true; save.disabled = remove.disabled = selected.disabled = name.disabled = parent.disabled = true; notice.textContent = '';
    try {
      organization = await api('/api/operations/folders', 'POST', { ...payload, expectedRevision: organization.revision });
      await refresh(); return true;
    } catch (error) {
      notice.textContent = error.message; notify?.(error.message, true);
      // A conflict needs a new snapshot, not an automatic replay of the edit.
      if (error.status === 409) await refresh();
      return false;
    } finally { for (const select of fileSelects) select.disabled = false; pending = false; save.disabled = remove.disabled = selected.disabled = name.disabled = parent.disabled = false; }
  }
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (await mutate({ action: selected.value ? 'update' : 'create', id: selected.value, name: name.value, parentId: parent.value || null })) {
      selected.value = ''; editSelection(); notice.textContent = 'Folder saved.';
    }
  });
  remove.addEventListener('click', async () => {
    if (await mutate({ action: 'remove', id: selected.value })) {
      selected.value = ''; editSelection(); notice.textContent = 'Folder removed. Its cronjobs are Unfiled; child folders moved up one level.';
    }
  });
  add(manager, 'p', 'Remove folder keeps every cronjob and moves child folders up one level.', 'next-help');
  return {
    group(container, deployments, value) {
      organization = value || { revision: 0, folders: [], assignments: {} };
      if (lastRevision !== organization.revision) {
        const chosen = selected.value, chosenParent = parent.value;
        options(selected, 'New folder', chosen); options(parent, 'Top level', chosenParent);
        lastRevision = organization.revision;
      }
      fileSelects = [];
      const targets = new Map(), folders = organization.folders || [];
      function branch(parentId, host, ancestors = new Set()) {
        for (const folder of folders.filter(item => (item.parentId || null) === parentId).sort((a,b) => a.name.localeCompare(b.name))) {
          if (ancestors.has(folder.id)) continue;
          const next = new Set(ancestors).add(folder.id);
          const details = add(host, 'details', '', 'next-schedule-folder-branch');
          details.open = !closed.has(folder.id);
          details.dataset.scheduleFolder = folder.id;
          const summary = add(details, 'summary', folder.name);
          const direct = deployments.filter(item => organization.assignments?.[item.id] === folder.id).length;
          const descendants = new Set([folder.id]);
          for (let changed = true; changed;) { changed = false; for (const item of folders) if (descendants.has(item.parentId) && !descendants.has(item.id)) { descendants.add(item.id); changed = true; } }
          const count = deployments.filter(item => descendants.has(organization.assignments?.[item.id])).length;
          const badge = add(summary, 'span', String(count), 'next-status-pill'); badge.title = 'Cronjobs in this folder and subfolders';
          details.addEventListener('toggle', () => details.open ? closed.delete(folder.id) : closed.add(folder.id));
          const children = add(details, 'div', '', 'next-schedule-folder-children');
          const cards = add(children, 'div', '', 'next-grid'); targets.set(folder.id, cards);
          branch(folder.id, children, next);
          if (!direct && !folders.some(item => item.parentId === folder.id)) add(cards, 'p', 'Empty folder', 'next-help');
        }
      }
      branch(null, container);
      const unfiled = add(container, 'section', '', 'next-schedule-unfiled'); add(unfiled, 'h3', 'Unfiled');
      const cards = add(unfiled, 'div', '', 'next-grid'); targets.set('', cards);
      if (!deployments.some(item => !targets.has(organization.assignments?.[item.id]))) add(cards, 'p', 'No unfiled cronjobs.', 'next-help');
      return {
        target: task => targets.get(organization.assignments?.[task.id]) || cards,
        fileControl(card, task) {
          const label = add(card, 'label', 'File in folder', 'next-label next-schedule-file-control');
          const select = add(label, 'select', '', 'next-field');
          select.setAttribute('aria-label', 'File ' + (task.name || 'cronjob') + ' in folder');
          options(select, 'Unfiled', organization.assignments?.[task.id] || '');
          select.disabled = pending; fileSelects.push(select);
          select.addEventListener('change', async () => {
            select.disabled = true;
            const ok = await mutate({ action: 'assign', deploymentId: task.id, folderId: select.value || null });
            if (!ok) { select.value = organization.assignments?.[task.id] || ''; select.disabled = false; }
          });
        }
      };
    }
  };
}
