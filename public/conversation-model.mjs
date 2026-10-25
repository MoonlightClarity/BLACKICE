import { taskTitle } from './task-title.mjs';
import { REASONING_LEVELS, reasoningSelectionSupported } from './reasoning-model.mjs';
import { newerTaskState } from './run-state-model.mjs';
import { PLANNING_MODES, planningModeDetail, selectPlanningEffort } from './planning-mode.mjs';
import { serviceTierSupport } from './service-tier-model.mjs';
export const isActiveRun = run => ['queued', 'running', 'waiting'].includes(run?.status);
// A terminal status can arrive before its tools release the conversation and execution slot.
export const isSettlingRun = run => Boolean(run && !isActiveRun(run) && run.settled === false);
export function conversationRecovery(run = {}) {
  if (run.status !== 'failed') return null;
  const code = run.errorCode || Object.values(run.nodes || {}).find(node => node.errorCode)?.errorCode;
  if (['CODEX_RUN_TIMEOUT', 'PROVIDER_TIMEOUT', 'PROVIDER_IDLE_TIMEOUT'].includes(code)) return { action: 'run-limits', label: 'Time limits' };
  if (['PROVIDER_AUTH', 'PROVIDER_ACCESS', 'PROVIDER_QUOTA', 'PROVIDER_ENDPOINT', 'PROVIDER_UNAVAILABLE', 'PROVIDER_MODEL', 'PROVIDER_PROTOCOL', 'INVALID_DEFAULT_MODEL', 'CONTEXT_OVERFLOW'].includes(code)) return { action: 'connections', label: 'Models' };
  if (!code && /(?:API key|authentication|unauthorized|provider.+(?:disabled|configured)|model.+(?:unavailable|not found)|context.+(?:limit|exceed))/i.test(String(run.error?.message || run.error || ''))) return { action: 'connections', label: 'Models' };
  return null;
}
export const runUserText = run => typeof run?.input === 'string' ? run.input : run?.input?.task || '';
const time = run => Date.parse(run?.createdAt || '') || 0;
const text = value => typeof value === 'string' ? value : '';
const artifactId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value);

function artifactPath(value, base, decode = false) {
  if (typeof value !== 'string' || !value || value.length > 8000 || /[\x00-\x1f\x7f]/.test(value)) return null;
  let source = value;
  if (decode) { try { source = decodeURIComponent(source); } catch { return null; } }
  if (/[\x00-\x1f\x7f]/.test(source)) return null;
  source = source.replaceAll('\\', '/').replace(/^\/([a-z]:\/)/i, '$1');
  if (/^[a-z][a-z0-9+.-]*:/i.test(source) && !/^[a-z]:\//i.test(source)) return null;
  const absolute = /^(?:[a-z]:\/|\/)/i.test(source);
  if (!absolute) {
    const parent = artifactPath(base);
    if (!parent) return null;
    source = `${parent}/${source}`;
  }
  const drive = /^[a-z]:\//i.test(source), unc = source.startsWith('//'), prefix = drive ? source.slice(0, 3) : unc ? '//' : '/';
  const parts = [];
  for (const part of source.slice(prefix.length).split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { if (parts.length <= (unc ? 2 : 0)) return null; parts.pop(); }
    else parts.push(part);
  }
  const normalized = prefix + parts.join('/');
  return drive || unc ? normalized.toLowerCase() : normalized;
}

/** Exact registered paths become opaque preview IDs; this never opens a local path. */
export function createRegisteredArtifactResolver(run) {
  const state = run?.taskState, cwd = run?.cwd, taskId = state?.taskId || run?.taskId || run?.id, paths = new Map();
  if (artifactId(taskId) && Array.isArray(state?.artifacts)) for (const artifact of state.artifacts) {
    const key = artifactPath(artifact?.path, cwd);
    if (!key || !artifactId(artifact?.id)) continue;
    const previous = paths.get(key);
    paths.set(key, paths.has(key) && previous?.artifactId !== artifact.id ? null : { taskId, artifactId: artifact.id });
  }
  return href => {
    const key = artifactPath(href, cwd, true), match = key && paths.get(key);
    return match ? { ...match } : null;
  };
}

export function conversationId(run, runs = [], index = null) {
  if (!run) return 'new'; if (run.taskId) return run.taskId;
  // Batch callers supply one index instead of rebuilding it for every run.
  const byId = index || new Map(runs.map(item => [item.id, item])), visited = new Set(); let root = run;
  while (root.parentRunId && byId.has(root.parentRunId) && !visited.has(root.parentRunId)) { visited.add(root.id); root = byId.get(root.parentRunId); }
  return root.taskId || root.id;
}
export function conversationRuns(runs, selected) {
  if (!selected) return [];
  const byId = new Map(runs.filter(Boolean).map(run => [run.id, run])); if (!byId.has(selected.id)) byId.set(selected.id, selected);
  const family = new Set(), taskId = conversationId(selected, [...byId.values()]), children = new Map(), queue = [selected.id];
  for (const run of byId.values()) { if (run.taskId === taskId || run.id === taskId) queue.push(run.id); if (run.parentRunId) { const values = children.get(run.parentRunId) || []; values.push(run.id); children.set(run.parentRunId, values); } }
  while (queue.length) { const id = queue.pop(); if (family.has(id) || !byId.has(id)) continue; family.add(id); const parent = byId.get(id).parentRunId; if (parent) queue.push(parent); queue.push(...children.get(id) || []); }
  return [...family].map(id => byId.get(id)).filter(Boolean).sort((a, b) => time(a) - time(b) || a.id.localeCompare(b.id));
}
export function conversationSummaries(runs) {
  const groups = new Map(), byId = new Map(runs.map(run => [run.id, run]));
  for (const run of [...runs].sort((a, b) => time(a) - time(b))) {
    const id = conversationId(run, runs, byId), existing = groups.get(id);
    if (!existing) groups.set(id, { id, rootRunId: run.id, runId: run.id, title: taskTitle(runUserText(run), { max: 140, fallback: run.workflowName || 'Conversation' }), updatedAt: run.createdAt, status: run.status, settled: run.settled, runs: 1 });
    else { existing.runId = run.id; existing.updatedAt = run.createdAt; existing.status = run.status; existing.settled = run.settled; existing.runs++; }
  }
  // Preserve first-active-run precedence without scanning every run for every group.
  const activeGroups = new Set();
  for (const run of runs) {
    if (!isActiveRun(run) && !isSettlingRun(run)) continue;
    const id = conversationId(run, runs, byId), item = groups.get(id);
    if (item && !activeGroups.has(id)) { item.runId = run.id; item.status = run.status; item.settled = run.settled; activeGroups.add(id); }
  }
  return [...groups.values()].sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0));
}
export const selectedConversationModel = (draft = {}, preferences = {}, agent) => draft.model || agent?.resolvedModel || agent?.model || preferences.model || 'default';
export const conversationEfforts = ['default', ...REASONING_LEVELS];
export const selectedConversationEffort = (draft = {}, agent, appDefault = 'default') => conversationEfforts.includes(draft.effort) ? draft.effort : conversationEfforts.includes(agent?.effort) ? agent.effort : conversationEfforts.includes(appDefault) ? appDefault : 'default';
/** Existing chats retain captured tier or legacy omission; app Fast defaults affect only new chats. */
export const selectedConversationServiceTier = (draft = {}, agent, run, status = {}, selection = draft.model || agent?.resolvedModel || agent?.model || 'default') => ['default', 'fast'].includes(draft.serviceTier) ? draft.serviceTier : ['default', 'fast'].includes(agent?.serviceTier) ? agent.serviceTier : !run && status.runtimeSettings?.defaultServiceTier === 'fast' && serviceTierSupport(status, selection, 'fast').available ? 'fast' : undefined;
export const conversationPlanDetails = ['compact', 'balanced', 'detailed'];
export const selectedConversationPlanDetail = (draft = {}, preferences = {}, run) => [draft.planDetail, run?.planDetail, run?.workflow?.settings?.planDetail, run?.taskState?.plan?.detail, preferences.planDetail, 'balanced'].find(value => conversationPlanDetails.includes(value));
export const selectedConversationPlanningMode = (draft = {}, preferences = {}, run) => [draft.planningMode, run?.planningMode, run?.input?.planningMode, run?.workflow?.settings?.planningMode, ...Object.values(run?.nodes || {}).map(node => node.planning?.mode), preferences.planningMode, 'auto'].find(value => PLANNING_MODES.includes(value));
// Effective runtime detail is not an explicit preference. In particular, going
// from Maximal to Auto must let the next agent scale its own outline again.
export const conversationPlanDetailHint = (draft = {}, preferences = {}, run) => [draft.planDetail, run?.input?.planDetail, run?.workflow?.settings?.planDetail, !PLANNING_MODES.includes(run?.planningMode) ? run?.planDetail : undefined, !PLANNING_MODES.includes(run?.planningMode) ? run?.taskState?.plan?.detail : undefined, preferences.planDetail].find(value => conversationPlanDetails.includes(value));
export const conversationPlanningConfig = (draft = {}, preferences = {}, run) => {
  const planningMode = selectedConversationPlanningMode(draft, preferences, run), detail = conversationPlanDetailHint(draft, preferences, run);
  return { planningMode, ...(detail === undefined || planningMode === 'off' ? {} : { planDetail: planningModeDetail(planningMode, detail) }) };
};
export function conversationReasoningChoice({ draft = {}, preferences = {}, run, agent, status = {} } = {}) {
  // A new turn has no steering target until its thread and turn receipts arrive.
  // Keep reasoning aligned with the saved model shown by the composer meanwhile.
  agent ||= run?.workflow?.nodes?.find(node => node.type === 'agent');
  if (!reasoningSelectionSupported(status, selectedConversationModel(draft, preferences, agent))) return { effort: 'default', source: 'route-managed', requestedEffort: draft.effort ?? agent?.effort ?? null };
  const mode = selectedConversationPlanningMode(draft, preferences, run), prior = run?.nodes?.[agent?.id]?.effortSelection;
  let requestedEffort = conversationEfforts.includes(draft.effort) ? draft.effort : agent?.effort;
  if (!conversationEfforts.includes(draft.effort) && prior && agent?.effort === prior.effort && (mode === 'maximal' || prior.source === 'maximal-model-catalog')) requestedEffort = prior.requestedEffort ?? undefined;
  return selectPlanningEffort({ mode, status, model: selectedConversationModel(draft, preferences, agent), requestedEffort, defaultEffort: status.runtimeSettings?.defaultEffort });
}
export const selectedConversationContext = (draft = {}, preferences = {}, agent, run) => draft.context || agent?.context || run?.workflow?.settings?.context || preferences.context;

/** Old per-chat choices stay with their draft; new chats follow the persisted app default. */
export function restoreConversationDrafts(saved = {}) {
  const legacy = !Object.hasOwn(saved, 'conversationDrafts');
  const drafts = saved.conversationDrafts && typeof saved.conversationDrafts === 'object' && !Array.isArray(saved.conversationDrafts) ? structuredClone(saved.conversationDrafts) : {};
  // Modern top-level fields mirror the selected chat, not the New chat draft.
  // An unchanged empty New draft may never have needed a storage entry.
  if (!drafts.new || typeof drafts.new !== 'object' || Array.isArray(drafts.new)) drafts.new = { task: legacy && typeof saved.task === 'string' ? saved.task : '', attachmentIds: legacy && Array.isArray(saved.attachmentIds) ? saved.attachmentIds : [] };
  for (const draft of Object.values(drafts)) if (draft && typeof draft === 'object' && !Array.isArray(draft)) {
    if (!conversationEfforts.includes(draft.effort)) delete draft.effort;
    if (!['default', 'fast'].includes(draft.serviceTier)) delete draft.serviceTier;
    if (!conversationPlanDetails.includes(draft.planDetail)) delete draft.planDetail;
    if (!PLANNING_MODES.includes(draft.planningMode)) delete draft.planningMode;
    if (!draft.context || typeof draft.context !== 'object' || Array.isArray(draft.context)) delete draft.context;
  }
  if (saved.modelPreferenceVersion !== 2 && (drafts.new.task?.trim() || drafts.new.attachmentIds?.length) && !drafts.new.model && saved.model) drafts.new.model = saved.model;
  const prefs = { model: 'default', modelPreferenceVersion: 2, cwd: typeof saved.cwd === 'string' ? saved.cwd : '', desktop: Boolean(saved.desktop) };
  for (const key of ['desktopConfigured', 'context']) if (saved[key] !== undefined) prefs[key] = saved[key];
  if (conversationPlanDetails.includes(saved.planDetail)) prefs.planDetail = saved.planDetail;
  if (PLANNING_MODES.includes(saved.planningMode)) prefs.planningMode = saved.planningMode;
  return { prefs, drafts };
}

/** Search the saved chat catalog, without loading transcripts or exposing Trash by default. */
export function searchConversations({ summaries = {}, runs = [], state, query = '', limit = 40 } = {}) {
  const normalize = value => String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const words = normalize(query).trim().split(/\s+/).filter(Boolean), phrase = normalize(query).trim();
  const buckets = state ? [state] : ['active', 'archived'];
  return buckets.flatMap(bucket => conversationSidebarItems({ summaries, runs, state: bucket })).map(entry => {
    const title = normalize(entry.title), searchable = normalize(`${entry.title} ${entry.preview || entry.originalTask || ''}`);
    return { entry, score: title === phrase ? 4 : title.startsWith(phrase) ? 3 : title.includes(phrase) ? 2 : 1, matches: words.every(word => searchable.includes(word)) };
  }).filter(item => item.matches).sort((a, b) => b.score - a.score || (Date.parse(b.entry.updatedAt || '') || 0) - (Date.parse(a.entry.updatedAt || '') || 0)).slice(0, Math.max(0, Math.min(200, Number(limit) || 0))).map(item => item.entry);
}
export function conversationSidebarItems({ summaries = {}, runs = [], runSummaries = null, state = 'active' } = {}) {
  const catalog = new Map();
  for (const bucket of ['active', 'archived', 'deleted']) for (const entry of summaries[bucket] || []) {
    const id = entry.taskId || entry.rootId || entry.id;
    catalog.set(id, { ...entry, id, state: entry.state || bucket, runId: entry.runId || entry.latestRunId || entry.id, title: entry.rootTitle || entry.title || 'Conversation' });
  }
  for (const entry of runSummaries || conversationSummaries(runs)) {
    const previous = catalog.get(entry.id);
    // A loaded transcript can contain only older turns after recent-run eviction.
    // Keep the durable latest turn until that turn, or a newer one, is loaded.
    const catalogIsNewer = previous && previous.runId !== entry.runId && (Date.parse(previous.createdAt || previous.updatedAt || '') || 0) > (Date.parse(entry.updatedAt || '') || 0);
    catalog.set(entry.id, { ...(catalogIsNewer ? { ...entry, ...previous } : { ...previous, ...entry }), state: previous?.state || 'active', title: previous?.rootTitle || previous?.title || entry.title });
  }
  return [...catalog.values()].filter(entry => entry.state === state).sort((a, b) => (Date.parse(b.updatedAt || '') || 0) - (Date.parse(a.updatedAt || '') || 0));
}
export function mergeConversationRuns(...collections) {
  const map = new Map();
  for (const runs of collections) for (const run of runs || []) if (run?.id) {
    const old = map.get(run.id);
    if (!old) {
      const taskState = newerTaskState(undefined, run.taskState, run.taskId || run.id);
      if (run.taskState === taskState) map.set(run.id, run);
      else { const initial = { ...run }; if (taskState) initial.taskState = taskState; else delete initial.taskState; map.set(run.id, initial); }
      continue;
    }
    if (old === run) continue;
    const nodes = { ...old.nodes };
    for (const [id, node] of Object.entries(run.nodes || {})) nodes[id] = { ...nodes[id], ...node };
    // Avoid serializing and sorting every historical receipt when the live
    // snapshot only changed status, usage, or other metadata. Event arrays are
    // immutable in the stream reducer; newer events get a different reference.
    let events;
    if (run.events === undefined || old.events === run.events || run.indexed === true && run.events?.length === 0) {
      // A worker run-index entry has intentionally omitted its execution
      // receipts. Keep the fully loaded conversation's event array by reference
      // rather than rebuilding thousands of archived messages on each frame.
      events = old.events || [];
    } else {
      // Live execution keeps a bounded tool ring; archived human/assistant receipts are durable.
      const durable = event => { const data = event.data || event; return ['message', 'steer'].includes(data.type) || data.type === 'item' && data.item?.type === 'agentMessage'; };
      const receipts = new Map();
      for (const event of [...(old.events || []).filter(durable), ...run.events]) {
        const data = event.data || event, nodeId = event.nodeId || data.nodeId || 'agent', itemId = data.itemId || data.item?.id;
        const key = durable(event) && data.type !== 'steer' && itemId ? `message:${nodeId}:${itemId}` : JSON.stringify([event.at, nodeId, data.type, itemId, data.text, data.delta, data.action, data.item]);
        receipts.set(key, event);
      }
      const completed = new Set([...receipts.values()].filter(durable).map(event => { const data = event.data || event; return data.type !== 'steer' && (data.itemId || data.item?.id) ? `${event.nodeId || data.nodeId || 'agent'}:${data.itemId || data.item.id}` : null; }).filter(Boolean));
      events = [...receipts.values()].filter(event => { const data = event.data || event; return data.type !== 'delta' || !data.itemId || !completed.has(`${event.nodeId || data.nodeId || 'agent'}:${data.itemId}`); }).sort((a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0));
    }
    const merged = { ...old, ...run, nodes, events }, taskState = newerTaskState(old.taskState, run.taskState, old.taskId || run.taskId || run.id);
    if (taskState) merged.taskState = taskState;
    else delete merged.taskState;
    map.set(run.id, merged);
  }
  return [...map.values()].sort((a, b) => time(a) - time(b));
}

export const shouldSendConversationKey = event => event.key === 'Enter' && !event.shiftKey && !event.altKey && !event.isComposing && event.keyCode !== 229;

/** Only user-visible runtime text. Protocol payloads and generated internal user prompts never become chat messages. */
export function assistantMessages(run) {
  const messages = [], byId = new Map(), anonymous = new Map(); let serial = 0;
  const get = (id, nodeId, at) => { let message = byId.get(id); if (!message) { message = { id, role: 'assistant', nodeId, text: '', at, phase: null }; byId.set(id, message); messages.push(message); } return message; };
  for (const event of run?.events || []) {
    const data = event.data || event, nodeId = event.nodeId || data.nodeId || 'agent';
    if (data.type === 'steer' && data.accepted !== false && text(data.text).trim()) {
      const id = `direction:${nodeId}:${event.at || serial++}:${data.text}`;
      if (!byId.has(id)) { const message = { id, role: 'user', nodeId, text: data.text, at: event.at, direction: true, delivery: data.delivery }; byId.set(id, message); messages.push(message); } anonymous.delete(nodeId); continue;
    }
    if (data.type === 'delta' && text(data.delta)) {
      const id = data.itemId ? `${nodeId}:${data.itemId}` : anonymous.get(nodeId) || `${nodeId}:stream-${serial++}`; anonymous.set(nodeId, id);
      get(id, nodeId, event.at).text += data.delta; continue;
    }
    const item = data.item;
    if (data.type === 'message' || data.type === 'item' && item?.type === 'agentMessage') {
      const content = text(data.text ?? item?.text); if (!content.trim()) continue;
      const itemId = data.itemId || item?.id, id = itemId ? `${nodeId}:${itemId}` : anonymous.get(nodeId) || `${nodeId}:message-${serial++}`;
      const message = get(id, nodeId, event.at); message.text = content; message.phase = data.phase || item?.phase || message.phase; anonymous.delete(nodeId); continue;
    }
    if (data.type === 'item' && ['dynamicToolCall', 'mcpToolCall', 'commandExecution', 'fileChange'].includes(item?.type)) anonymous.delete(nodeId);
  }
  for (const node of run?.workflow?.nodes || []) {
    if (node.type !== 'agent' || run.nodes?.[node.id]?.reused) continue;
    const state = run.nodes?.[node.id], output = text(state?.output); if (!output.trim()) continue;
    const shown = messages.filter(message => message.nodeId === node.id && message.role === 'assistant');
    if (shown.some(message => message.text.trim() === output.trim())) { const final = shown.findLast(message => message.text.trim() === output.trim()); if (state.status === 'completed') final.phase ||= 'final_answer'; continue; }
    if (shown.some(message => message.phase === 'final_answer')) continue;
    const combined = shown.map(message => message.text).join('');
    if (combined.trim() === output.trim()) { if (state.status === 'completed' && shown.length) shown.at(-1).phase ||= 'final_answer'; continue; }
    // A bounded event ring can lose the beginning of a live stream; actual accumulated node output restores it.
    if (combined && output.endsWith(combined) && output.length > combined.length) { const first = shown[0], remove = new Set(shown.slice(1)); first.text = output; for (let index = messages.length - 1; index >= 0; index--) if (remove.has(messages[index])) messages.splice(index, 1); continue; }
    if (!shown.length || state.status === 'completed') messages.push({ id: `${node.id}:saved-output`, role: 'assistant', nodeId: node.id, text: output, phase: state.status === 'completed' ? 'final_answer' : null, at: state.finishedAt || state.startedAt });
  }
  if (!messages.some(message => message.role === 'assistant') && text(run?.output).trim()) messages.push({ id: 'saved-result', role: 'assistant', text: run.output, phase: 'final_answer' });
  return messages.filter(message => message.text.trim());
}
export function conversationTurn(run, runs = []) {
  const parent = runs.find(candidate => candidate.id === run.parentRunId);
  return { id: run.id, run, userText: run.retryOf && parent && runUserText(parent) === runUserText(run) ? '' : runUserText(run), retry: Boolean(run.retryOf), messages: assistantMessages(run) };
}
export function conversationAgents(run, mode = 'continue') {
  const states = run?.nodes || {}, priority = { failed: 3, cancelled: 2, completed: 1 };
  return (run?.workflow?.nodes || []).filter(node => node.type === 'agent' && (mode === 'steer' ? states[node.id]?.threadId && states[node.id].status === 'running' && states[node.id].turnId && !['completed', 'failed', 'interrupted', 'cancelled', 'cancelling'].includes(states[node.id].turnStatus) : ['completed', 'failed', 'cancelled'].includes(states[node.id]?.status))).reverse().sort((a, b) => (priority[states[b.id].status] || 0) - (priority[states[a.id].status] || 0)).map(node => {
    const resolvedModel = states[node.id].resolvedModel || [...(run.events || [])].reverse().find(event => event.nodeId === node.id && event.data?.type === 'thread' && typeof event.data.model === 'string')?.data.model;
    return resolvedModel ? { ...node, resolvedModel } : node;
  });
}
