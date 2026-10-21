const validId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(value);
const revision = value => Number.isSafeInteger(value) && value >= 0;
const text = (value, limit = 200) => typeof value === 'string' ? value.slice(0, limit) : '';

/** Presence and read receipts are a separate transient view, never draft data. */
export function normalizePlanningAwareness(value, taskId) {
  if (!value || value.taskId !== taskId || !revision(value.revision) || !Array.isArray(value.presence) || !Array.isArray(value.workers)) throw new Error('Shared editing status could not be read.');
  return { taskId, revision: value.revision,
    presence: value.presence.slice(0, 100).filter(item => validId(item?.editorId) && (item.stepId == null || validId(item.stepId)) && Number.isFinite(Date.parse(item.expiresAt))).map(item => ({ editorId: item.editorId, stepId: item.stepId || null, label: text(item.label) || 'Another editor', expiresAt: item.expiresAt })),
    workers: value.workers.slice(0, 512).filter(item => typeof item?.id === 'string' && (item.scopeStepId == null || validId(item.scopeStepId))).map(item => ({ id: text(item.id, 300), runId: text(item.runId, 120), nodeId: text(item.nodeId, 120), label: text(item.label) || 'Agent', scopeStepId: item.scopeStepId || null, lastReadRevision: revision(item.lastReadRevision) ? item.lastReadRevision : null, lastReadAt: Number.isFinite(Date.parse(item.lastReadAt)) ? item.lastReadAt : null, pendingRevision: revision(item.pendingRevision) ? item.pendingRevision : null, state: ['unread', 'current', 'needs-review', 'finished'].includes(item.state) ? item.state : 'unread', status: text(item.status, 60) })),
  };
}

export function planningAwarenessView(snapshot, { task, stepId = null, editorId = '', now = Date.now() } = {}) {
  const parents = new Map((task?.steps || []).map(step => [step.id, step.parentId || null]));
  const ancestor = (possible, id) => {
    const seen = new Set();
    for (let current = id; current && !seen.has(current); current = parents.get(current)) { if (current === possible) return true; seen.add(current); }
    return false;
  };
  const relevant = scope => !stepId || !scope || ancestor(scope, stepId) || ancestor(stepId, scope);
  const presence = (snapshot?.presence || []).filter(item => Date.parse(item.expiresAt) > now && relevant(item.stepId)).map(item => ({ ...item, mine: item.editorId === editorId }));
  const needsReview = item => item.state === 'needs-review' || item.pendingRevision != null && (item.lastReadRevision == null || item.lastReadRevision < item.pendingRevision);
  const priority = item => needsReview(item) ? 0 : item.state === 'finished' ? 3 : item.lastReadRevision == null ? 1 : 2;
  const workers = (snapshot?.workers || []).filter(item => relevant(item.scopeStepId)).sort((a, b) => priority(a) - priority(b));
  return { presence, workers, pending: workers.filter(needsReview), read: workers.filter(item => item.lastReadRevision != null), revision: snapshot?.revision ?? null };
}

/** Activity leases carry only a generated id and the saved step being edited.
 * Writes for an old lease are drained before its release. A late response cannot
 * replace the current task, clear another lease, or become a saved-plan update.
 */
export function createPlanningAwarenessController({ api, onChange = () => {}, enabled = true, setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now, createEditorId = () => `editor-${globalThis.crypto.randomUUID()}`, renewMs = 8000, idleMs = 16000 } = {}) {
  const state = { taskId: '', snapshot: null, error: '', editorId: '', editing: false, advertised: false };
  const retired = new Set();
  let active = false, visible = true, destroyed = false, intent = 0, readAbort, editTimer, expiryTimer, lease = null;
  const notify = () => { if (!destroyed) onChange(state); };
  const path = (id, name) => `/api/tasks/${encodeURIComponent(id)}/plan/${name}`;
  function scheduleExpiry() {
    clearTimer(expiryTimer); expiryTimer = null;
    if (!active || destroyed || !state.snapshot) return;
    const due = state.snapshot.presence.map(item => Date.parse(item.expiresAt)).filter(value => value > now()).sort((a, b) => a - b)[0];
    if (due != null) expiryTimer = setTimer(() => { expiryTimer = null; notify(); scheduleExpiry(); }, Math.max(1, due - now() + 1));
  }
  function remember(value, id) {
    if (!active || destroyed || state.taskId !== id) return;
    state.snapshot = normalizePlanningAwareness(value, id); state.snapshot.presence = state.snapshot.presence.filter(item => !retired.has(item.editorId)); state.error = ''; scheduleExpiry(); notify();
  }
  async function refresh() {
    if (!enabled || !active || destroyed || !validId(state.taskId)) return;
    const id = state.taskId, owner = ++intent; readAbort?.abort(); readAbort = new AbortController(); const controller = readAbort;
    try {
      const value = await api(path(id, 'awareness'), { signal: controller.signal, timeoutMs: 5000 });
      if (owner === intent && !controller.signal.aborted) remember(value, id);
    } catch { if (active && !destroyed && owner === intent && !controller.signal.aborted && id === state.taskId) { state.error = 'Shared editing status is unavailable. Your draft is kept.'; notify(); } }
  }
  function scheduleRenewal(current) {
    clearTimer(editTimer); editTimer = null;
    if (lease !== current || current.stopped || !active || !visible || destroyed) return;
    editTimer = setTimer(() => {
      editTimer = null;
      if (lease !== current || current.stopped) return;
      if (now() - current.activityAt >= idleMs) { stopEditing(current.id); return; }
      send(current);
    }, Math.max(1, Math.min(current.sentAt + renewMs - now(), current.activityAt + idleMs - now())));
  }
  function send(current) {
    if (current.pending || current.stopped || lease !== current || !active || !visible || destroyed) return;
    current.pending = true;
    current.chain = current.chain.catch(() => {}).then(async () => {
      if (current.stopped || lease !== current || !active || !visible || destroyed) return;
      current.sentAt = now();
      try {
        await api(path(current.taskId, 'presence'), { method: 'POST', timeoutMs: 5000 }, { editorId: current.id, stepId: current.stepId });
        if (lease === current && !current.stopped && active && !destroyed) { state.advertised = true; state.error = ''; notify(); void refresh(); }
      } catch { if (lease === current && !current.stopped && active && !destroyed) { state.advertised = false; state.error = 'Editing presence could not be shared. Your draft is kept.'; notify(); } }
      finally { current.pending = false; scheduleRenewal(current); }
    });
  }
  function stopEditing(expectedId) {
    if (!lease || expectedId && lease.id !== expectedId) return;
    const current = lease; current.stopped = true; lease = null;
    retired.add(current.id); if (retired.size > 100) retired.delete(retired.values().next().value);
    clearTimer(editTimer); editTimer = null; state.editorId = ''; state.editing = false; state.advertised = false;
    // Remove only our old badge locally; other editors and all worker receipts remain.
    if (state.snapshot) state.snapshot.presence = state.snapshot.presence.filter(item => item.editorId !== current.id);
    notify();
    current.chain.catch(() => {}).then(() => api(path(current.taskId, 'presence'), { method: 'DELETE', timeoutMs: 5000 }, { editorId: current.id })).catch(() => {}).finally(() => { if (active && !destroyed && state.taskId === current.taskId) void refresh(); });
  }
  function edit(stepId = null) {
    if (!enabled || !active || !visible || destroyed || !validId(state.taskId) || stepId != null && !validId(stepId)) return;
    if (lease && (lease.taskId !== state.taskId || lease.stepId !== stepId)) stopEditing();
    if (!lease) {
      const id = createEditorId(); if (!validId(id)) return;
      lease = { id, taskId: state.taskId, stepId, activityAt: now(), sentAt: now(), stopped: false, pending: false, chain: Promise.resolve() };
      state.editorId = id; state.editing = true; state.advertised = false; notify(); send(lease);
    } else { lease.activityAt = now(); if (!lease.pending) scheduleRenewal(lease); }
  }
  function enter(taskId) {
    if (!enabled || destroyed) return;
    const changed = state.taskId !== taskId;
    if (changed) { stopEditing(); ++intent; readAbort?.abort(); state.taskId = validId(taskId) ? taskId : ''; state.snapshot = null; state.error = ''; clearTimer(expiryTimer); expiryTimer = null; }
    active = true; if (changed) notify();
  }
  function leave() {
    active = false; stopEditing(); ++intent; readAbort?.abort(); clearTimer(expiryTimer); expiryTimer = null;
  }
  return { state, enter, leave, refresh, edit, stopEditing, leaseId: () => lease?.id,
    setVisible(value) { const next = Boolean(value); if (visible === next) return; visible = next; if (!next) stopEditing(); },
    destroy() { leave(); destroyed = true; },
  };
}
