import { createPlanningAwarenessController } from './planning-awareness.mjs';

const clone = value => structuredClone(value);
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const own = (value, key) => Object.hasOwn(value, key);
const validId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(value);
const validGroupId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(value) && !['all', 'ungrouped'].includes(value);
const GROUPS = ['sequence', 'parallel', 'choice'];
const STEP_FIELDS = ['title', 'kind', 'doneWhen', 'result', 'note', 'condition', 'status', 'evidence', 'blockedReason', 'skipReason', 'parentId', 'beforeId', 'dependsOn', 'selectedChildId'];

/** Grouping belongs to the saved-plan catalog, independently of executable steps. */
export function planningCatalogOutline(plans = [], organization = {}, { groupId = '', query = '' } = {}) {
  const groups = new Map((organization?.groups || []).map(group => [group.id, { ...group, plans: [] }]));
  const ungrouped = { id: 'ungrouped', name: 'Ungrouped', plans: [], planCount: 0 };
  for (const plan of plans) {
    if (!plan.groupId) { ungrouped.plans.push(plan); continue; }
    if (!groups.has(plan.groupId)) groups.set(plan.groupId, { id: plan.groupId, name: plan.groupName || 'Saved group', plans: [] });
    groups.get(plan.groupId).plans.push(plan);
  }
  ungrouped.planCount = ungrouped.plans.length;
  const needle = String(query).trim().toLocaleLowerCase();
  return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name)).concat(ungrouped)
    .filter(group => (!groupId || group.id === groupId) && (!needle || group.plans.length || group.name.toLocaleLowerCase().includes(needle)));
}

export function planningDraftValues(task, stepId = null) {
  if (!stepId) return { goal: task.goal || '', layout: task.plan?.layout || 'sequence', detail: task.plan?.detail || 'balanced', selectedChildId: task.plan?.selectedChildId || '' };
  const step = task.steps?.find(item => item.id === stepId);
  if (!step) return null;
  const siblings = task.steps.filter(item => (item.parentId || '') === (step.parentId || ''));
  return Object.fromEntries(STEP_FIELDS.map(key => [key, key === 'dependsOn' ? [...(step.dependsOn || [])] : key === 'beforeId' ? siblings[siblings.findIndex(item => item.id === stepId) + 1]?.id || '' : key === 'kind' ? step.kind || 'action' : key === 'status' ? step.status || 'pending' : step[key] || '']));
}

export function planningChangedFields(draft) {
  if (!draft) return [];
  return Object.keys(draft.values).filter(key => !equal(draft.values[key], draft.original[key]));
}

/** Build only the edits the person made. Runtime ownership and receipts are never copied. */
export function planningEditOperations(draft) {
  if (!draft) return [];
  const value = draft.values, changes = new Set(planningChangedFields(draft));
  const requireText = (text, label) => { if (!String(text || '').trim()) throw new Error(`${label} is required.`); return String(text).trim(); };
  if (draft.mode === 'remove') return [{ type: 'remove', stepId: draft.stepId }];
  if (draft.mode === 'add') {
    const kind = value.kind || 'action', step = { id: draft.stepId, title: requireText(value.title, 'A step title'), kind, status: 'pending', parentId: value.parentId || null, dependsOn: [...value.dependsOn] };
    if (value.doneWhen.trim()) step.doneWhen = value.doneWhen.trim();
    if (value.result.trim()) step.result = value.result.trim();
    if (value.condition.trim()) step.condition = value.condition.trim();
    if (kind === 'action') requireText(step.doneWhen, 'An observable done criterion');
    const operations = [{ type: 'add', step, ...(value.beforeId ? { beforeId: value.beforeId } : {}) }];
    if (GROUPS.includes(kind)) {
      for (const [index, child] of value.children.entries()) operations.push({ type: 'add', step: { id: `${draft.stepId}-${index + 1}`, title: requireText(child.title, `Child ${index + 1} title`), doneWhen: requireText(child.doneWhen, `Child ${index + 1} done criterion`), kind: 'action', status: 'pending', parentId: draft.stepId, dependsOn: [], ...(kind === 'choice' ? { condition: requireText(child.condition, `Path ${index + 1} condition`) } : {}) } });
    }
    return operations;
  }
  if (!draft.stepId) {
    const patch = {};
    for (const key of ['goal', 'layout', 'detail']) if (changes.has(key)) patch[key] = value[key];
    if (own(patch, 'goal')) patch.goal = requireText(patch.goal, 'The task objective');
    const operations = Object.keys(patch).length ? [{ type: 'metadata', patch }] : [];
    if (changes.has('selectedChildId') || changes.has('layout') && value.layout !== 'choice' && draft.original.selectedChildId) operations.push({ type: 'choose', stepId: null, selectedChildId: value.layout === 'choice' ? value.selectedChildId || null : null });
    return operations;
  }
  const patch = {};
  for (const key of STEP_FIELDS.filter(key => !['parentId', 'beforeId', 'dependsOn', 'selectedChildId'].includes(key))) if (changes.has(key)) patch[key] = value[key] === '' && !['title', 'kind', 'status'].includes(key) ? null : value[key];
  if (own(patch, 'title')) patch.title = requireText(patch.title, 'A step title');
  const operations = Object.keys(patch).length ? [{ type: 'update', stepId: draft.stepId, patch }] : [];
  if (changes.has('parentId') || changes.has('beforeId')) operations.push({ type: 'move', stepId: draft.stepId, parentId: value.parentId || null, ...(value.beforeId ? { beforeId: value.beforeId } : {}) });
  if (changes.has('dependsOn')) operations.push({ type: 'dependencies', stepId: draft.stepId, dependsOn: [...value.dependsOn] });
  if (changes.has('selectedChildId') || changes.has('kind') && value.kind !== 'choice' && draft.original.selectedChildId) operations.push({ type: 'choose', stepId: draft.stepId, selectedChildId: value.kind === 'choice' ? value.selectedChildId || null : null });
  return operations;
}

export function planningDraftDiff(draft, task) {
  const latest = draft.mode === 'add' ? draft.original : planningDraftValues(task, draft.stepId);
  if (!latest) return [{ key: 'step', before: draft.original.title, current: 'Removed from the saved plan', mine: draft.values.title, conflict: true }];
  return planningChangedFields(draft).map(key => ({ key, before: draft.original[key], current: latest[key], mine: draft.values[key], conflict: !equal(draft.original[key], latest[key]) && !equal(draft.values[key], latest[key]) }));
}

/** A saved-plan editor keeps one current document per task and small field drafts.
 * Reads can be abandoned; a successful write is still remembered after leaving.
 */
export function createPlanningWorkspaceController({ api, onChange = () => {}, onSaved = () => {}, setTimer = setTimeout, clearTimer = clearTimeout, pollMs = 5000, coalesceMs = 350, createId = () => `step-${globalThis.crypto.randomUUID()}`, createGroupId = () => `group-${globalThis.crypto.randomUUID()}`, awarenessEnabled = true, awarenessOptions = {} } = {}) {
  if (typeof api !== 'function') throw new Error('Planning needs the app API.');
  const entries = new Map(), state = { active: false, plans: [], taskId: '', query: '', bucket: 'active', groupId: '', catalogLoading: false, taskLoading: false, error: '', catalogError: '', catalog: null, pane: 'plan', organization: { revision: null, groups: [] }, organizationDraft: null, organizationReceipt: '' };
  let destroyed = false, viewIntent = 0, catalogIntent = 0, taskIntent = 0, organizationReadIntent = 0, pollTimer, refreshTimer, awarenessTimer, catalogAbort, taskAbort, organizationReadAbort, refreshPending = false;
  const notify = reason => { if (!destroyed) onChange(reason, state); };
  const awareness = createPlanningAwarenessController({ ...awarenessOptions, api, enabled: awarenessEnabled, setTimer, clearTimer, onChange: () => notify('awareness') });
  const entry = () => entries.get(state.taskId);
  const draft = () => entry()?.drafts.get(entry().editorKey);
  const editable = () => Boolean(entry()?.task && entry()?.meta?.editable !== false && entry()?.meta?.bucket !== 'deleted');
  function rememberOrganization(value, { allowUnavailable = false } = {}) {
    if (allowUnavailable && value?.revision === null && value.healthy === false) { state.organization = { revision: null, groups: [], healthy: false }; return true; }
    if (!Number.isSafeInteger(value?.revision) || value.revision < 0 || !Array.isArray(value.groups) || value.groups.some(group => !validGroupId(group?.id) || typeof group.name !== 'string')) throw new Error('The saved organization response was incomplete. Refresh the list.');
    if (state.organization.revision !== null && value.revision < state.organization.revision) return false;
    state.organization = clone({ revision: value.revision, groups: value.groups }); return true;
  }
  const planMeta = id => state.plans.find(plan => plan.taskId === id) || entries.get(id)?.meta;
  function organizationValues(current) {
    if (current.mode === 'plan') {
      const meta = planMeta(current.taskId);
      return meta ? { name: meta.name || '', groupId: meta.groupId || '' } : null;
    }
    const group = state.organization.groups.find(group => group.id === current.groupId);
    return group ? { name: group.name } : null;
  }
  function startOrganization(mode, { taskId = state.taskId, groupId = '' } = {}) {
    if (destroyed || state.organization.revision === null || state.organizationDraft?.busy || !['plan', 'create-group', 'rename-group', 'remove-group'].includes(mode)) return false;
    const meta = planMeta(taskId), group = state.organization.groups.find(group => group.id === groupId);
    if (mode === 'plan' && (!meta || meta.editable === false || meta.bucket === 'deleted')) return false;
    if (['rename-group', 'remove-group'].includes(mode) && !group) return false;
    ++organizationReadIntent; organizationReadAbort?.abort();
    const values = mode === 'plan' ? { name: meta.name || '', groupId: meta.groupId || '' } : { name: group?.name || '' };
    state.organizationDraft = { mode, taskId: mode === 'plan' ? taskId : null, groupId: mode === 'create-group' ? createGroupId() : groupId, label: mode === 'plan' ? meta.title || meta.goal || entries.get(taskId)?.task?.goal || 'Untitled plan' : group?.name || '', values: clone(values), original: clone(values), revision: mode === 'plan' ? Number.isSafeInteger(meta.organizationRevision) ? meta.organizationRevision : -1 : state.organization.revision, dirty: mode === 'create-group' || mode === 'remove-group', busy: false, conflict: false, uncertain: false, review: null, error: '' };
    state.organizationReceipt = ''; state.pane = 'saved'; notify('organization'); return true;
  }
  function editOrganization(field, value) {
    const current = state.organizationDraft;
    if (!current || current.busy || !own(current.values, field)) return false;
    current.values[field] = String(value); current.dirty = ['create-group', 'remove-group'].includes(current.mode) || !equal(current.values, current.original); current.error = ''; current.review = null;
    notify('organization-input'); return true;
  }
  function cancelOrganization() {
    if (state.organizationDraft?.busy) return false;
    ++organizationReadIntent; organizationReadAbort?.abort();
    state.organizationDraft = null; notify('organization'); return true;
  }
  async function reviewOrganization() {
    const current = state.organizationDraft; if (!state.active || !current || current.busy || current.reviewBusy) return false;
    const owner = viewIntent, intent = ++organizationReadIntent;
    organizationReadAbort?.abort(); organizationReadAbort = new AbortController(); const read = organizationReadAbort;
    current.reviewBusy = true; notify('organization');
    try {
      let values;
      if (current.mode === 'plan') {
        // A moved or older plan may lie outside the selected group or page.
        // Read that exact saved item instead of reviewing cached metadata.
        const query = new URLSearchParams({ state: 'all', taskId: current.taskId, limit: '1' });
        const result = await api(`/api/planning?${query}`, { signal: read.signal });
        if (!state.active || owner !== viewIntent || intent !== organizationReadIntent || state.organizationDraft !== current) return false;
        if (!Array.isArray(result.plans) || !rememberOrganization(result.organization)) throw new Error('The organization changed during review. Review the current values again.');
        const meta = result.plans.find(plan => plan.taskId === current.taskId);
        if (meta) {
          const listed = state.plans.find(plan => plan.taskId === current.taskId); if (listed) Object.assign(listed, meta);
          if (entries.has(current.taskId)) Object.assign(entries.get(current.taskId).meta, meta);
          values = { name: meta.name || '', groupId: meta.groupId || '' };
        }
      } else {
        await loadCatalog();
        if (!state.active || owner !== viewIntent || intent !== organizationReadIntent || state.organizationDraft !== current) return false;
        if (state.catalogError) throw new Error(state.catalogError);
        values = organizationValues(current);
      }
      if (current.mode !== 'create-group' && !values) throw new Error('This item is no longer available. Cancel this form and choose another item.');
      current.review = { revision: state.organization.revision, values }; current.error = ''; notify('organization'); return true;
    } catch (error) {
      if (state.organizationDraft === current && !read.signal.aborted) { current.error = error.message; notify('organization'); }
      return false;
    } finally { current.reviewBusy = false; if (state.organizationDraft === current) notify('organization'); }
  }
  function applyReviewedOrganization() {
    const current = state.organizationDraft; if (!current?.review || current.busy) return false;
    if (current.review.revision !== state.organization.revision) { current.review = null; current.error = 'The organization changed again. Review the current values before saving.'; notify('organization'); return false; }
    const changed = Object.keys(current.values).filter(key => !equal(current.values[key], current.original[key]));
    const original = clone(current.review.values || { name: '' }), values = clone(original);
    for (const key of changed) values[key] = current.values[key];
    // A lost create response is located by the stable group ID. Reviewing it
    // turns any further change into a rename, never a second group creation.
    if (current.mode === 'create-group' && current.review.values) current.mode = 'rename-group';
    current.revision = current.review.revision; current.original = original; current.values = values; current.review = null; current.conflict = false; current.uncertain = false; current.error = '';
    current.dirty = ['create-group', 'remove-group'].includes(current.mode) || !equal(current.values, current.original); notify('organization'); return true;
  }
  function applyOrganizationOperation(operation, previousRevision) {
    if (operation.type === 'update_plan') {
      const update = meta => {
        if (own(operation, 'name')) meta.name = operation.name;
        if (own(operation, 'groupId')) meta.groupId = operation.groupId;
        meta.title = meta.name || meta.conversationTitle || meta.goal || entries.get(operation.taskId)?.task?.goal || 'Untitled plan';
        meta.groupName = state.organization.groups.find(group => group.id === meta.groupId)?.name || null;
      };
      const listed = state.plans.find(plan => plan.taskId === operation.taskId); if (listed) update(listed);
      if (entries.has(operation.taskId)) update(entries.get(operation.taskId).meta);
    } else if (operation.type === 'rename_group' || operation.type === 'remove_group') {
      for (const meta of [...state.plans, ...[...entries.values()].map(item => item.meta)]) if (meta.groupId === operation.groupId) {
        meta.groupName = operation.type === 'rename_group' ? operation.name : null;
        if (operation.type === 'remove_group') meta.groupId = null;
      }
      if (operation.type === 'remove_group' && state.groupId === operation.groupId) state.groupId = '';
    }
    for (const meta of [...state.plans, ...[...entries.values()].map(item => item.meta)]) if (meta.organizationRevision === previousRevision) meta.organizationRevision = state.organization.revision;
  }
  async function saveOrganization() {
    const current = state.organizationDraft;
    if (!current || current.busy || current.conflict || current.uncertain || current.revision !== state.organization.revision) return false;
    let operation;
    try {
      const name = current.values.name.trim();
      const maximum = current.mode === 'plan' ? 160 : 120;
      if (name.length > maximum || /[\u0000-\u001f\u007f]/.test(name) || current.mode !== 'plan' && current.mode !== 'remove-group' && !name) throw new Error(`Enter a name on one line with at most ${maximum} characters.`);
      if (current.mode === 'plan') {
        const meta = planMeta(current.taskId);
        if (!meta || meta.editable === false || meta.bucket === 'deleted') throw new Error('Restore this plan from Trash before organizing it.');
        operation = { type: 'update_plan', taskId: current.taskId };
        if (name !== current.original.name) operation.name = name || null;
        if (current.values.groupId !== current.original.groupId) operation.groupId = current.values.groupId || null;
        if (operation.groupId && !state.organization.groups.some(group => group.id === operation.groupId)) throw new Error('Choose an available group.');
      } else if (current.mode === 'create-group') operation = { type: 'create_group', id: current.groupId, name };
      else if (current.mode === 'rename-group') operation = { type: 'rename_group', groupId: current.groupId, name };
      else operation = { type: 'remove_group', groupId: current.groupId };
      if (current.mode === 'plan' && Object.keys(operation).length === 2 || current.mode === 'rename-group' && name === current.original.name) {
        state.organizationDraft = null; state.organizationReceipt = 'The saved name and group already match.'; notify('organization'); return true;
      }
    } catch (error) { current.error = error.message; notify('organization'); return false; }
    current.busy = true; current.error = ''; notify('organization'); let received = false;
    try {
      const result = await api('/api/planning/organization', 'POST', { expectedRevision: current.revision, operations: [operation] });
      received = true;
      if (rememberOrganization(result)) applyOrganizationOperation(operation, current.revision);
      ++catalogIntent; catalogAbort?.abort(); state.catalogLoading = false;
      state.organizationDraft = null;
      state.organizationReceipt = ({ plan: 'Plan name and group saved.', 'create-group': 'Group created.', 'rename-group': 'Group renamed.', 'remove-group': 'Group removed. Its plans and Swarms are now ungrouped.' })[current.mode];
      if (state.active) await loadCatalog();
      notify('organization'); return true;
    } catch (error) {
      current.error = error.message || 'The organization could not be saved.'; current.conflict = error.status === 409 || error.code === 'PLANNING_ORGANIZATION_CONFLICT'; current.uncertain = error.uncertain === true || received; current.review = null;
      if (state.active && (current.conflict || current.uncertain)) await loadCatalog();
      notify('organization'); return false;
    } finally { current.busy = false; notify('organization'); }
  }
  function remember(task, meta) {
    if (!task || !validId(task.taskId) || !Number.isSafeInteger(task.revision) || !Array.isArray(task.steps)) throw new Error('The saved plan response was incomplete. Reload the plan.');
    let item = entries.get(task.taskId);
    if (!item) { item = { task: null, meta: {}, editorKey: 'goal', drafts: new Map() }; entries.set(task.taskId, item); }
    if (!item.task || task.revision >= item.task.revision) item.task = clone(task);
    if (meta) item.meta = { ...item.meta, ...meta };
    for (const [key, saved] of item.drafts) {
      if (saved.busy || saved.dirty || saved.mode === 'add' || saved.mode === 'remove') continue;
      const values = planningDraftValues(item.task, saved.stepId);
      if (values) { saved.original = clone(values); saved.values = clone(values); saved.revision = item.task.revision; saved.conflict = false; saved.review = false; }
      else item.drafts.delete(key);
    }
    // Clean historic snapshots may be evicted; unsaved work is never discarded.
    if (entries.size > 40) for (const [id, saved] of entries) { if (entries.size <= 40) break; if (id !== state.taskId && ![...saved.drafts.values()].some(draft => draft.dirty || draft.busy || draft.mode === 'add')) entries.delete(id); }
    return item;
  }
  function selectEditor(stepId = null) {
    const item = entry(); if (!item?.task) return false;
    const key = stepId || 'goal', values = planningDraftValues(item.task, stepId);
    if (!values) return false;
    if (item.editorKey !== key) awareness.stopEditing();
    item.editorKey = key;
    if (!item.drafts.has(key)) item.drafts.set(key, { key, stepId, mode: stepId ? 'step' : 'goal', original: clone(values), values: clone(values), revision: item.task.revision, dirty: false, busy: false, conflict: false, review: false, error: '', receipt: '' });
    notify('editor'); return true;
  }
  function edit(field, value) {
    const current = draft(); if (!current || current.busy || !editable() || !own(current.values, field)) return false;
    current.values[field] = clone(value); current.dirty = current.mode === 'add' || planningChangedFields(current).length > 0; current.error = ''; current.receipt = ''; current.review = false;
    notify('input');
    if (current.dirty) awareness.edit(current.mode === 'add' ? current.values.parentId || null : current.stepId); else awareness.stopEditing();
    return true;
  }
  function startAdd(parentId = null) {
    const item = entry(); if (!editable()) return false;
    awareness.stopEditing();
    if (parentId && !GROUPS.includes(item.task.steps.find(step => step.id === parentId)?.kind)) parentId = null;
    if (!item.drafts.has('new')) {
      const values = { title: '', kind: 'action', doneWhen: '', result: '', condition: '', parentId: parentId || '', beforeId: '', dependsOn: [], children: [{ title: '', doneWhen: '', condition: '' }, { title: '', doneWhen: '', condition: '' }] };
      item.drafts.set('new', { key: 'new', stepId: createId(), mode: 'add', values: clone(values), original: clone(values), revision: item.task.revision, dirty: true, error: '', receipt: '', busy: false, conflict: false, review: false });
    }
    item.editorKey = 'new'; state.pane = 'edit'; notify('editor'); return true;
  }
  function discard() {
    const item = entry(), current = draft(); if (!item || current?.busy) return false;
    awareness.stopEditing();
    const next = current?.mode === 'add' || !item.task.steps.some(step => step.id === current?.stepId) ? null : current.stepId;
    item.drafts.delete(item.editorKey); selectEditor(next); return true;
  }
  function schedulePoll() {
    clearTimer(pollTimer); if (!state.active || destroyed || !pollMs) return;
    pollTimer = setTimer(async () => { await refresh(); schedulePoll(); }, pollMs);
  }
  async function loadCatalog({ append = false } = {}) {
    if (destroyed || !state.active) return;
    const intent = ++catalogIntent, owner = viewIntent, offset = append ? state.catalog?.nextOffset : 0;
    if (append && offset == null) return;
    catalogAbort?.abort(); catalogAbort = new AbortController(); const controller = catalogAbort;
    state.catalogLoading = true; state.catalogError = ''; notify('catalog');
    try {
      const query = new URLSearchParams({ query: state.query.trim(), state: state.bucket, limit: '40', offset: String(offset || 0) });
      if (state.groupId) query.set('groupId', state.groupId);
      const result = await api(`/api/planning?${query}`, { signal: controller.signal });
      if (destroyed || !state.active || intent !== catalogIntent || owner !== viewIntent) return;
      if (!Array.isArray(result.plans) || !Number.isSafeInteger(result.total)) throw new Error('The saved plan list was incomplete. Try again.');
      if (result.organization && !rememberOrganization(result.organization, { allowUnavailable: true })) return;
      if (result.organization && state.groupId && state.groupId !== 'ungrouped' && !state.organization.groups.some(group => group.id === state.groupId)) { state.groupId = ''; await loadCatalog(); return; }
      state.plans = append ? [...new Map([...state.plans, ...result.plans].map(plan => [plan.taskId, plan])).values()] : result.plans;
      state.catalog = result; state.catalogError = result.healthy === false ? 'Some saved plans could not be read. The available plans are listed.' : '';
      for (const meta of state.plans) if (entries.has(meta.taskId)) entries.get(meta.taskId).meta = { ...entries.get(meta.taskId).meta, ...meta };
      if (!editable()) awareness.stopEditing();
    } catch (error) { if (!destroyed && state.active && intent === catalogIntent && owner === viewIntent && !controller.signal.aborted) state.catalogError = error.message; }
    finally { if (!destroyed && intent === catalogIntent && owner === viewIntent) { state.catalogLoading = false; notify('catalog'); } }
  }
  async function loadTask(id = state.taskId, { select = false } = {}) {
    if (!validId(id) || destroyed || !state.active) return;
    const intent = ++taskIntent, owner = viewIntent; taskAbort?.abort(); taskAbort = new AbortController(); const controller = taskAbort;
    if (select) { if (state.taskId !== id) awareness.stopEditing(); state.taskId = id; state.pane = 'plan'; state.error = ''; }
    awareness.enter(id);
    state.taskLoading = true; notify('task-loading');
    try {
      const task = await api(`/api/tasks/${encodeURIComponent(id)}`, { signal: controller.signal });
      if (destroyed || !state.active || owner !== viewIntent || intent !== taskIntent || id !== state.taskId) return;
      const item = remember(task, state.plans.find(plan => plan.taskId === id)); state.error = '';
      if (!item.drafts.has(item.editorKey)) selectEditor(item.editorKey === 'goal' ? null : item.editorKey);
      if (!draft()) selectEditor();
      notify('task'); void awareness.refresh(); return item.task;
    } catch (error) { if (!destroyed && owner === viewIntent && intent === taskIntent && !controller.signal.aborted) { state.error = error.message; notify('error'); } }
    finally { if (!destroyed && owner === viewIntent && intent === taskIntent) { state.taskLoading = false; notify('task-loading'); } }
  }
  async function refresh() {
    if (!state.active || destroyed || refreshPending) return;
    refreshPending = true;
    try { await Promise.allSettled([loadCatalog(), state.taskId ? loadTask() : Promise.resolve()]); }
    finally { refreshPending = false; }
  }
  async function enter({ taskId, taskState, runId, runStatus, bucket, editable: mayEdit } = {}) {
    state.active = true; const owner = ++viewIntent; state.error = '';
    if (taskState) remember(taskState, { ...(runId ? { runId } : {}), ...(runStatus ? { runStatus } : {}), ...(bucket ? { bucket } : {}), ...(mayEdit !== undefined ? { editable: mayEdit } : {}) });
    const id = taskId || taskState?.taskId || state.taskId;
    if (id) state.taskId = id;
    awareness.enter(state.taskId);
    await loadCatalog();
    if (!state.active || destroyed || owner !== viewIntent) return;
    if (!state.taskId) state.taskId = state.plans[0]?.taskId || '';
    if (state.taskId) await loadTask(state.taskId, { select: true });
    else notify('empty');
    schedulePoll();
  }
  function leave() {
    state.active = false; ++viewIntent; ++catalogIntent; ++taskIntent; ++organizationReadIntent;
    awareness.leave();
    clearTimer(awarenessTimer); awarenessTimer = null;
    catalogAbort?.abort(); taskAbort?.abort(); organizationReadAbort?.abort(); clearTimer(pollTimer); clearTimer(refreshTimer); pollTimer = null; refreshTimer = null; state.catalogLoading = false; state.taskLoading = false; refreshPending = false;
  }
  function handleEvent(event) {
    if (event?.type === 'agent.event' && event.data?.type === 'task.state') event = { ...event, type: 'task.state', data: event.data.state || event.data.snapshot || event.data.data };
    if (!state.active || destroyed || !['planning.awareness', 'planning.organization.updated', 'planning.updated', 'task.state', 'task.updated', 'run.updated', 'node.updated', 'run.node.updated', 'conversation.updated', 'conversations.updated', 'conversations.changed'].includes(event?.type)) return;
    if (event.type === 'planning.awareness') {
      if (event.data?.taskId && event.data.taskId !== state.taskId || awarenessTimer) return;
      awarenessTimer = setTimer(() => { awarenessTimer = null; void awareness.refresh(); }, coalesceMs); return;
    }
    const data = event.data || {}, task = data.taskState || (Array.isArray(data.steps) && data.taskId ? data : null);
    if (task?.taskId && entries.has(task.taskId)) { try { remember(task); if (task.taskId === state.taskId) notify('task'); } catch { /* Read the authoritative saved state below. */ } }
    if (refreshTimer) return;
    refreshTimer = setTimer(() => { refreshTimer = null; void refresh(); }, coalesceMs);
  }
  async function reviewLatest() {
    const current = draft(), id = state.taskId; if (!current || current.busy) return;
    const latest = await loadTask(id);
    if (!latest || state.taskId !== id || draft() !== current) return;
    current.review = true; current.conflict = current.revision !== latest.revision || current.conflict; current.error = ''; notify('review');
  }
  function applyReviewedDraft() {
    const current = draft(), task = entry()?.task; if (!current?.review || !task || current.busy || !editable()) return false;
    if (current.mode !== 'add' && current.stepId && !task.steps.some(step => step.id === current.stepId)) { current.error = 'This step was removed. Copy the text you need, then discard this draft or add a new step.'; notify('review'); return false; }
    const changes = planningChangedFields(current), latest = current.mode === 'add' ? clone(current.original) : planningDraftValues(task, current.stepId), values = clone(latest);
    for (const key of changes) values[key] = clone(current.values[key]);
    current.original = clone(latest); current.values = values; current.revision = task.revision; current.review = false; current.conflict = false; current.uncertain = false; current.error = ''; current.dirty = current.mode === 'add' || planningChangedFields(current).length > 0; notify('editor'); return true;
  }
  async function save({ remove = false } = {}) {
    const item = entry(), current = draft(), id = state.taskId; if (!editable() || !current || current.busy) return false;
    if (current.revision !== item.task.revision || current.conflict || current.uncertain) { current.conflict = true; current.error = 'Review the latest saved revision before applying your edits.'; notify('review'); return false; }
    let operations;
    try { operations = remove ? [{ type: 'remove', stepId: current.stepId }] : planningEditOperations(current); if (!operations.length) return false; }
    catch (error) { current.error = error.message; notify('error'); return false; }
    const editingLease = awareness.leaseId();
    current.busy = true; current.error = ''; current.receipt = ''; notify('saving');
    try {
      const result = await api(`/api/tasks/${encodeURIComponent(id)}/plan/edit`, 'POST', { expectedRevision: current.revision, operations });
      if (editingLease) awareness.stopEditing(editingLease);
      const saved = remember(result); current.busy = false; current.dirty = false; current.conflict = false; current.review = false; current.uncertain = false;
      const nextId = remove ? null : current.stepId;
      const values = planningDraftValues(saved.task, nextId);
      item.drafts.delete(current.key);
      if (values) {
        const key = nextId || 'goal'; item.drafts.set(key, { key, stepId: nextId, mode: nextId ? 'step' : 'goal', original: clone(values), values: clone(values), revision: saved.task.revision, dirty: false, busy: false, conflict: false, review: false, error: '', receipt: `Saved revision ${saved.task.revision}.` });
        if (item.editorKey === current.key) item.editorKey = key;
      }
      try { onSaved(saved.task); } catch { /* Keep the actual receipt even if another view has gone away. */ }
      if (state.taskId === id) notify('saved'); return true;
    } catch (error) {
      current.error = error.message; current.conflict = error.status === 409 || error.code === 'TASK_STATE_CONFLICT'; current.uncertain = error.uncertain === true; current.review = false;
      if (state.active && state.taskId === id && (current.conflict || current.uncertain)) await loadTask(id);
      if (state.taskId === id) notify('error'); return false;
    } finally { current.busy = false; if (state.taskId === id) notify('saving'); }
  }
  return { state, entries, entry, draft, editable, awareness, enter, leave, refresh, loadCatalog, selectTask: id => loadTask(id, { select: true }), clearSelection() {
    if (!state.taskId) return false;
    ++taskIntent; taskAbort?.abort(); taskAbort = null; state.taskId = ''; state.taskLoading = false; state.error = ''; state.pane = 'saved'; awareness.enter(''); notify('selection'); return true;
  }, selectEditor, edit, startAdd, discard, save, reviewLatest, applyReviewedDraft, handleEvent, startOrganization, editOrganization, cancelOrganization, saveOrganization, reviewOrganization, applyReviewedOrganization,
    selectDraft(key) { const item = entry(); if (!item?.drafts.has(key)) return false; if (item.editorKey !== key) awareness.stopEditing(); item.editorKey = key; notify('editor'); return true; },
    setPane(pane) { if (['plan', 'edit', 'saved'].includes(pane)) { state.pane = pane; notify('pane'); } },
    setFilter({ query = state.query, bucket = state.bucket, groupId = state.groupId } = {}) { state.query = String(query).slice(0, 500); state.bucket = ['all', 'active', 'archived', 'deleted'].includes(bucket) ? bucket : 'active'; state.groupId = groupId === '' || groupId === 'ungrouped' || validGroupId(groupId) ? groupId : ''; ++catalogIntent; catalogAbort?.abort(); clearTimer(refreshTimer); refreshTimer = setTimer(() => { refreshTimer = null; void loadCatalog(); }, coalesceMs); notify('filter'); },
    destroy() { leave(); destroyed = true; awareness.destroy(); entries.clear(); }
  };
}
