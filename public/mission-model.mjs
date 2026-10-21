import { taskPlanView } from './task-plan-model.mjs';
import { taskTitle } from './task-title.mjs';
import { codexModelLifecycleLabel } from './connection-models.mjs';
import { isSettlingRun } from './conversation-model.mjs';
import { PLANNING_MODES } from './planning-mode.mjs';
import { modelRouteMetadata, isChatModeModel, CHAT_MODE_LABEL } from './model-routes.mjs';
const ACTIVE = new Set(['queued', 'running', 'waiting']);
export const taskText = run => typeof run?.input === 'string' ? run.input : run?.input?.task || '';
export const missionDesktopPreference = (preferences = {}, desktop = {}) => preferences.desktopConfigured === true ? Boolean(preferences.desktop) : Boolean(desktop.enabled && desktop.available !== false);
export function missionMilestones(state) {
  if (state?.planVersion === 1) {
    const view = taskPlanView(state), steps = view.includedLeaves, current = view.focus;
    const next = steps.find(step => step.status === 'pending' && step !== current && step.ready) || null;
    const checkpointAction = state.checkpoint?.nextAction || (!current ? state.checkpoint?.nextSteps?.[0] : '');
    return { steps, current, next, lastWin: steps.filter(step => step.status === 'done').at(-1) || null, done: view.progress.done, total: view.progress.total, skipped: view.progress.skipped, complete: view.complete, blocked: view.blocked.length, nextAction: typeof checkpointAction === 'string' ? checkpointAction.trim() : '' };
  }
  const steps = Array.isArray(state?.steps) ? state.steps : [], completed = steps.filter(step => step.status === 'done');
  const current = steps.find(step => step.status === 'active') || steps.find(step => step.status === 'blocked') || steps.find(step => step.status === 'pending') || null;
  const next = steps.find(step => step.status === 'pending' && step !== current) || null;
  const checkpointAction = state?.checkpoint?.nextAction || (!current ? state?.checkpoint?.nextSteps?.[0] : '');
  return { steps, current, next, lastWin: completed.at(-1) || null, done: completed.length, total: steps.length, complete: steps.length > 0 && completed.length === steps.length, blocked: steps.filter(step => step.status === 'blocked').length, nextAction: typeof checkpointAction === 'string' ? checkpointAction.trim() : '' };
}
export function modelFailure(status = {}, value = 'default') {
  const model = value === 'default' ? status.defaultModel : value;
  if (typeof model !== 'string' || !model.includes('::')) return null;
  const separator=model.indexOf('::'),provider=status.providers?.find(provider => provider.id === model.slice(0,separator));
  const failure=provider?.modelChecks?.[model.slice(separator+2)]?.lastFailure;
  return (failure?.scope!=='request'?failure:null) || provider?.lastFailure || null;
}
function nativeModelMetadata(model) {
  return {
    source: model?.source === 'custom' ? 'custom' : 'advertised',
    access: model?.access ? { ...model.access } : { state: 'unverified' },
    ...(model?.lifecycle ? { lifecycle: { ...model.lifecycle } } : {}),
    ...(typeof model?.hidden === 'boolean' ? { hidden: model.hidden } : {}),
    ...(Array.isArray(model?.inputModalities) ? { inputModalities: model.inputModalities.filter(value => typeof value === 'string') } : {}),
    ...(typeof model?.availabilityNux?.message === 'string' ? { availabilityNux: { message: model.availabilityNux.message } } : {}),
  };
}
export function missionModels(status = {}, selected = 'default') {
  const codex = status.codex || status, codexReady = Boolean(codex.connected && codex.authenticated);
  const defaultValue = status.defaultModel || codex.defaultModel || '', remoteDefault = defaultValue.includes('::');
  const defaultEntry = (status.models || []).find(model => defaultValue ? model.id === defaultValue || model.model === defaultValue : model.isDefault && !String(model.id || model.model).includes('::'));
  const defaultLabel = defaultEntry?.displayName || defaultValue || 'Codex';
  const defaultAvailable = typeof status.defaultModelAvailable === 'boolean' ? status.defaultModelAvailable : remoteDefault ? defaultEntry?.available === true : Boolean(defaultValue) && codexReady && defaultEntry?.available !== false;
  const defaultMetadata = { ...(remoteDefault ? {} : nativeModelMetadata(defaultEntry)), ...modelRouteMetadata({ ...defaultEntry, id: defaultValue, available: defaultAvailable }, status) };
  const models = [{ value: 'default', label: `Default · ${remoteDefault ? defaultLabel : `Codex · ${defaultLabel}`}${defaultMetadata.hidden ? ' · Hidden by Codex' : ''}${codexModelLifecycleLabel(defaultMetadata) ? ` · ${codexModelLifecycleLabel(defaultMetadata)}` : ''}`, available: defaultAvailable, error: status.defaultModelError || defaultMetadata.availabilityReason || '', provider: remoteDefault ? defaultEntry?.providerId || defaultValue.split('::')[0] : 'codex', ...defaultMetadata }];
  const seen = new Set(['default']);
  for (const model of status.models || []) {
    const catalogValue = model.id || model.model, remote = String(catalogValue).includes('::');
    // Retain a saved routing slug when it identifies this catalog row. Emitting
    // one option per row avoids duplicate models and preserves the user's draft.
    const value = !remote && selected !== 'default' && (model.id === selected || model.model === selected) ? selected : catalogValue;
    if (!value || seen.has(value) || isChatModeModel(value, status)) continue; seen.add(value);
    const metadata = { ...(remote ? {} : nativeModelMetadata(model)), ...modelRouteMetadata(model, status) }, failure = model.error || metadata.availabilityReason;
    models.push({ value, label: `${remote ? model.displayName || value : `Codex · ${model.displayName || value}`}${metadata.hidden ? ' · Hidden by Codex' : metadata.source === 'custom' ? ' · Custom model ID' : ''}${codexModelLifecycleLabel(metadata) ? ` · ${codexModelLifecycleLabel(metadata)}` : ''}`, available: remote ? model.available === true : codexReady && model.available !== false, provider: model.providerId || (remote ? value.split('::')[0] : 'codex'), ...metadata, ...(failure ? { error: failure } : {}) });
  }
  if (selected !== 'default' && isChatModeModel(selected, status)) models.push({ value: selected, label: CHAT_MODE_LABEL, provider: 'chatgpt', ...modelRouteMetadata({ id: selected }, status) });
  return models;
}
export function recentMissions(runs, limit = 4) {
  const byId = new Map(runs.map(run => [run.id, run])), groups = new Map();
  for (const run of [...runs].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))) {
    let root = run; const seen = new Set([run.id]);
    while (root.parentRunId && byId.has(root.parentRunId) && !seen.has(root.parentRunId)) { root = byId.get(root.parentRunId); seen.add(root.id); }
    if (!groups.has(root.id)) groups.set(root.id, { ...run, originalTask: taskText(root), threadRootId: root.id });
  }
  return [...groups.values()].slice(0, limit);
}
export function missionProgress(run) {
  if (!run) return { phase: 'idle', title: 'Start with the result you want.', detail: 'Your draft is saved on this computer.', completed: 0, total: 0, active: false };
  const nodes = Object.entries(run.nodes || {}), completed = nodes.filter(([, node]) => node.status === 'completed').length;
  const working = nodes.find(([, node]) => node.status === 'running'), active = ACTIVE.has(run.status);
  const name = working ? run.workflow?.nodes?.find(node => node.id === working[0])?.name : null;
  const milestones = missionMilestones(run.taskState), plan = run.taskState?.steps?.length ? milestones.steps : null, planDone = milestones.done, planTotal = milestones.total;
  if (isSettlingRun(run)) return { phase: run.status === 'cancelled' ? 'stopping' : 'finishing', active: false, completed: plan ? planDone : completed, total: plan ? planTotal : nodes.length, source: plan ? 'agent-plan' : 'workflow-stages', title: run.status === 'cancelled' ? 'Stopping this task.' : 'Finishing this response.', detail: `${run.status === 'failed' && run.error ? `${String(run.error?.message || run.error)} ` : ''}Waiting for active work to finish. Your saved progress is kept.` };
  return { phase: run.status, active, completed: plan ? planDone : completed, total: plan ? planTotal : nodes.length, source: plan ? 'agent-plan' : 'workflow-stages',
    title: milestones.current?.status === 'blocked' ? 'A milestone needs attention.' : active ? run.status === 'queued' ? 'Getting your agent ready.' : name ? `${name} is working.` : 'Your agent is working.' : run.status === 'completed' && plan && !milestones.complete ? 'Response finished. Milestones remain.' : ({ completed: 'Your result is ready.', failed: 'This task needs attention.', cancelled: run.settled === true ? 'Task stopped.' : 'Stop requested.' }[run.status] || 'Pick up this task.'),
    detail: milestones.current?.status === 'blocked' ? milestones.current.blockedReason || 'Open the saved milestone to see what is needed.' : active ? `${plan ? `${planDone} of ${planTotal} saved steps marked complete. ` : ''}${latestMissionActivity(run) || 'You can leave this view and return here.'}` : run.status === 'completed' ? plan && !milestones.complete ? `${planDone} of ${planTotal} saved milestones marked done. ${milestones.nextAction || milestones.current?.title || 'Continue the saved work.'}` : 'Read the result, then continue the conversation if you need more.' : String(run.error?.message || run.error || 'Open the activity to see where the task stopped.') };
}
export function selectMissionRun({ runs = [], currentRun }, { selectedId = null, hideCompleted = false } = {}) {
  const active = ACTIVE.has(currentRun?.status) ? currentRun : runs.find(run => ACTIVE.has(run.status));
  if (active) return active;
  if (hideCompleted) return null;
  return currentRun?.id === selectedId ? currentRun : runs.find(run => run.id === selectedId) || currentRun || null;
}
export function latestMissionActivity(run) {
  const brief = value => typeof value === 'string' ? value.trim().replace(/^#{1,6}\s*/, '').split('\n').find(line => line.trim())?.slice(0, 170) || '' : '';
  const actions = { windows: 'List open windows', inspect: 'Inspect app controls', invoke: 'Invoke a control', set_value: 'Set a control value', select: 'Select an item', toggle: 'Toggle a control', expand: 'Expand a control', collapse: 'Collapse a control', screenshot: 'Observe the page', read: 'Read page content', open: 'Open a page', navigate: 'Navigate to a page', click: 'Activate an element', fill: 'Fill a field', type: 'Enter text', search: 'Search saved context', remember: 'Save memory', save: 'Save a skill' };
  for (const event of [...(run?.events || [])].reverse()) {
    const data = event.data || {};
    if (data.type === 'protocol' || data.item?.type === 'userMessage') continue;
    if (data.type === 'message' && brief(data.text)) return brief(data.text);
    if (brief(data.message)) return brief(data.message);
    if (data.type === 'plan' && brief(data.explanation)) return brief(data.explanation);
    if (data.type === 'knowledge' && data.status === 'completed') return `${data.action === 'read' ? 'Read' : data.action === 'search' ? 'Searched' : 'Updated'} ${data.tool === 'relay_skills' ? 'skills' : data.tool === 'relay_history' ? 'past tasks' : 'memory'}${data.title ? ` · ${brief(data.title)}` : ''}`;
    const item = data.item;
    if (item?.type === 'commandExecution') { const action = item.commandActions?.[0]; if (action?.name || action?.path) return `${action.type === 'read' ? 'Reading' : action.type === 'search' ? 'Searching' : 'Working with'} ${brief(action.name || action.path)}`; return item.status === 'completed' ? 'A workspace command finished.' : 'Running a workspace command.'; }
    if (item?.type === 'fileChange') return `${item.status === 'completed' || data.stage === 'completed' ? 'Updated' : 'Updating'} workspace files.`;
    if (['dynamicToolCall', 'mcpToolCall'].includes(item?.type)) { const prefix = item.tool === 'relay_browser' ? 'Browser' : item.tool === 'relay_desktop' ? 'Windows' : item.tool === 'relay_skills' ? 'Skills' : item.tool === 'relay_memory' ? 'Memory' : 'Connected tool'; return `${prefix} · ${actions[item.arguments?.action] || 'Working on your task'}${item.status === 'completed' ? ' · done' : ''}`; }
  }
  return '';
}
export function createMissionWorkflow({ task, model = 'default', effort, cwd = '', desktop = false, id, context, planDetail, planningMode = 'auto' }) {
  if (!PLANNING_MODES.includes(planningMode)) throw new Error('Choose Maximal, On, Auto, or Off planning.');
  const title = taskTitle(task, { max: 80, fallback: 'New mission' });
  return { id, name: title, description: 'A focused task started from Mission.', version: 1,
    nodes: [{ id: 'input', type: 'input', name: 'Your task', x: 40, y: 100 },
      { id: 'agent', type: 'agent', name: 'BLACKICE agent', role: 'Task owner', model, ...(effort===undefined?{}:{effort}), sandbox: 'danger-full-access', desktop: Boolean(desktop), x: 340, y: 100,
        prompt: 'Complete the user task end to end. Inspect the available context, use the workspace and connected tools when useful, and verify the result. Follow the selected planning mode and its attached runtime instructions; preserve existing task notes when automatic planning is off. When planning is enabled, keep the saved outline specific to this task, reuse a suitable method when useful, and record actual progress and evidence. Continue authorized work without requesting approval for each step. Keep user-facing updates concrete and concise. Lead the final answer with the outcome, make checked wins visible, and give one concrete next action only when something remains. Put detailed evidence after the main result. Report blockers, errors and limitations plainly. Never claim an action or verification you did not perform.' },
      { id: 'output', type: 'output', name: 'Your result', x: 640, y: 100 }],
    edges: [{ id: 'task-agent', source: 'input', target: 'agent' }, { id: 'agent-result', source: 'agent', target: 'output' }], settings: { cwd, maxParallel: 1, planningMode, ...(context?{context}: {}), ...(planDetail===undefined?{}:{planDetail}) } };
}
