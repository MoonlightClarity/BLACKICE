import { taskPlanView, planKindLabel, planAncestors, visiblePlanNodes, reconcilePlanSession, selectPlanStep, togglePlanBranch, planKeyboard, planStepContext, savedPlanNotes, planLogicFields, planBranchText, planAttemptHistory } from './task-plan-model.mjs';
import { taskPlanMap, renderTaskPlanMapSVG, taskPlanExport, planMapZoom, planMapFitZoom, reconcilePlanMapSession } from './task-plan-map.mjs';
import { planningModeLabel } from './planning-mode.mjs';

const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const paths = {
  plan: '<path d="m12 2 8 4v12l-8 4-8-4V6Z"/><path d="M8 8h3v8m0-5h5m-5 5h5"/><path d="m14 9 2 2-2 2m0 1 2 2-2 2"/>',
  action: '<path d="m5 4 12 3 2 12-12-3Z"/><path d="m9 8 6 4-5 3"/>',
  sequence: '<path d="M5 4v16M5 7h8m-8 5h12m-12 5h8"/><path d="m15 5 2 2-2 2m4 1 2 2-2 2m-4 1 2 2-2 2"/>',
  parallel: '<path d="M12 3v4M5 12V7h14v5M5 16v3h14v-3m-7 3v3"/><path d="m3 11 2 2 2-2m10 0 2 2 2-2"/>',
  choice: '<path d="m12 3 4 4-4 4-4-4Z"/><path d="M8 7H5v11m11-11h3v11M3 16l2 2 2-2m10 0 2 2 2-2"/>',
  done: '<path d="m5 12 4 4L19 6"/>',
  active: '<path d="m6 4 13 8-13 8Z"/><path d="m10 9 5 3-5 3"/>',
  pending: '<path d="m12 4 8 8-8 8-8-8Z"/>',
  blocked: '<path d="m12 3 10 18H2Z"/><path d="M12 9v5m0 3h.01"/>',
  skipped: '<path d="m5 5 14 14M6 12h12"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  focus: '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m8 0h5v-5"/><path d="m12 8 4 4-4 4-4-4Z"/>',
  more: '<path d="M5 12h.01M12 12h.01M19 12h.01"/>',
  method: '<path d="m5 3 13 3v15l-13-3Z"/><path d="M8 8h6m-6 4h4m-4 4h6m4-10 3-2v14l-3 3"/>',
  file: '<path d="M5 3h10l5 5v13H5Z"/><path d="M15 3v6h5M8 13h9m-9 4h6"/>',
  guide: '<path d="M4 4h16v12H9l-5 4Z"/><path d="M8 8h8m-8 4h5"/>',
  expand: '<path d="M4 9V4h5m6 0h5v5M4 15v5h5m6 0h5v-5"/>',
  collapse: '<path d="M9 4v5H4m11-5v5h5M9 20v-5H4m11 5v-5h5"/>',
  map: '<path d="M8 12h4m0 0V5h5m-5 7h5m-5 0v7h5"/><rect x="2" y="9" width="6" height="6" rx="1"/><path d="M17 3h5v4h-5zm0 7h5v4h-5zm0 7h5v4h-5z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  download: '<path d="M12 3v12m-4-4 4 4 4-4M4 16v5h16v-5"/>',
};
const icon = (name, size = 18) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.action}</svg>`;
let instance = 0;

export function installTaskPlanStyles() {
  if (typeof document === 'undefined' || document.getElementById('blackice-task-plan-styles')) return;
  const link = document.createElement('link'); link.id = 'blackice-task-plan-styles'; link.rel = 'stylesheet'; link.href = '/task-plan.css'; document.head.append(link);
}

const phaseCopy = view => ({ preparing: 'Preparing the plan', unavailable: 'Conversation only', missing: 'Plan not recorded', empty: 'No saved steps yet', off: 'Planning off', working: view.active.length > 1 ? `${view.active.length} steps in progress` : 'In progress', closing: 'Closing unused paths', blocked: 'Needs attention', complete: 'Plan complete', paused: view.planningEnabled ? 'Progress saved' : 'Planning off · saved notes' }[view.phase]);
const button = (action, label, glyph, extra = '') => `<button type="button" class="task-plan-control" data-plan-action="${action}" ${extra}>${glyph ? icon(glyph, 16) : ''}<span>${escape(label)}</span></button>`;

export function renderPlanHeader(view, options = {}) {
  const title = view.title.length > 160 ? `${view.title.slice(0, 157)}…` : view.title;
  const expandedGoal = view.goal.length > title.length || title.length > 64 || /\n/.test(view.goal);
  const goal = expandedGoal ? `<details class="task-plan-goal" data-plan-disclosure="goal"><summary><h2>${escape(title)}</h2><span class="task-plan-goal-toggle"><span>Full task</span>${icon('chevron', 14)}</span></summary><p class="task-plan-goal-text" tabindex="0" role="region" aria-label="Full task">${escape(view.goal)}</p></details>` : `<h2>${escape(title)}</h2>`;

  const count = view.progress.total ? `<strong>${view.progress.done}<span> / ${view.progress.total}</span></strong><span>steps done${view.progress.skipped ? ` · ${view.progress.skipped} skipped` : ''}</span>` : `<span>${view.progress.skipped ? `${view.progress.skipped} ${view.progress.skipped === 1 ? 'step' : 'steps'} skipped` : view.nodes.length ? 'A branch decision comes next' : view.live && view.planningEnabled && view.planningAvailable ? 'A clear approach comes first' : 'Saved steps appear here'}</span>`;
  const ratio = view.progress.total ? Math.max(0, Math.min(100, view.progress.done / view.progress.total * 100)) : 0;
  return `<div class="task-plan-eyebrow">${icon('plan', 18)}<span>Task plan</span><span class="task-plan-phase" data-phase="${escape(view.phase)}"><i aria-hidden="true"></i>${escape(phaseCopy(view))}</span></div>${goal}<div class="task-plan-methods">${view.planningMode !== 'auto' ? `<span class="task-plan-mode">Planning ${escape(planningModeLabel(view.planningMode))}</span>` : ''}${view.plan.taskType && view.plan.taskType !== 'general' ? `<span class="task-plan-type">${escape(view.plan.taskType)}</span>` : ''}${view.plan.layout && view.plan.layout !== 'sequence' ? `<span class="task-plan-layout-label">${icon(view.plan.layout, 14)}${escape(planKindLabel(view.plan.layout))}</span>` : ''}</div>${view.plan.branch ? `<p class="task-plan-option-note">${escape(planBranchText(view.plan.branch, id => view.byId.get(id)?.title || id)).replaceAll('\n', '<br/>')}</p>` : ''}<div class="task-plan-progress-copy">${count}${view.nodes.length ? '<small>Reported progress</small>' : ''}</div><div class="task-plan-progress-track" aria-hidden="true"><span class="task-plan-progress-done" style="width:${ratio}%"></span></div>`;
}

function renderPlanRow(node, expanded, ids) {
  const condition = node.branchRole ? `<span class="task-plan-row-condition">${node.branchRole} path</span>` : node.isChoiceOption && node.condition ? `<span class="task-plan-row-condition">If ${escape(String(node.condition).replace(/^if\s+/i, ''))}</span>` : '';
  const summary = node.isGroup ? node.branch !== 'included' ? node.statusLabel : node.kind === 'choice' && !node.selectedChildId ? node.branchLogic ? 'Waiting for condition' : 'Choose a path' : `${node.doneCount} / ${node.leafCount} done${node.skippedCount ? ` · ${node.skippedCount} skipped` : ''}` : '';
  return `${node.isGroup ? `<button type="button" class="task-plan-expander" data-plan-action="toggle" data-step-id="${escape(node.id)}" aria-label="${expanded ? 'Collapse' : 'Expand'} ${escape(node.title)}" aria-controls="${ids.group}" tabindex="-1">${icon('chevron', 12)}</button>` : '<span class="task-plan-expander-spacer" aria-hidden="true"></span>'}<span class="task-plan-node-mark" aria-hidden="true">${icon(node.branch !== 'included' ? 'pending' : node.isGroup ? node.kind : node.status, 16)}</span><span class="task-plan-row-copy"><span class="task-plan-row-title" id="${ids.label}"><span class="task-plan-step-number">${escape(node.number)}</span>${escape(node.title)}</span>${node.isGroup ? `<span class="task-plan-row-kind">${escape(planKindLabel(node.kind))}${summary ? `<span>${escape(summary)}</span>` : ''}</span>` : ''}${condition}${node.owner ? `<span class="task-plan-row-owner">${escape(node.owner.label || node.owner.nodeId)}${node.execution ? ` · ${escape(node.execution.status)}` : ''}</span>` : ''}${node.isSelectedOption ? '<span class="task-plan-chosen">Chosen path</span>' : ''}</span><span class="task-plan-row-state" id="${ids.status}">${escape(node.statusLabel)}</span>`;
}

function field(label, value, modifier = '') {
  return value ? `<div class="task-plan-detail-field ${modifier}"><dt>${label}</dt><dd>${escape(value)}</dd></div>` : '';
}

export function renderPlanInspector(view, session, options = {}, prefix = 'task-plan') {
  const step = view.byId.get(session.selectedId);
  if (!step) return '';
  const path = planAncestors(view, step.id).map(id => view.byId.get(id));
  const breadcrumbs = path.length ? `<nav class="task-plan-breadcrumbs" aria-label="Step parents">${path.map(parent => `<button type="button" data-plan-action="select" data-step-id="${escape(parent.id)}" title="${escape(parent.title)}">${escape(parent.number)} ${escape(parent.title)}</button>`).join(`<span aria-hidden="true">${icon('chevron', 10)}</span>`)}</nav>` : '';
  const dependencies = step.dependsOn.map(id => view.byId.get(id)).filter(Boolean);
  const files = new Map((view.state.artifacts || []).map(item => [item.id, item]));
  const artifacts = [...new Set(Array.isArray(step.artifactIds) ? step.artifactIds : [])].map(id => files.get(id)).filter(Boolean);
  const actualFields = field('Done when', step.doneWhen, 'task-plan-criterion') + field('Expected result', step.result) + field('Evidence', step.evidence, 'task-plan-evidence') + field('Blocked by', step.blockedReason, 'task-plan-blocker') + field('Why skipped', step.skipReason) + field('Note', step.note) + field('Condition', step.condition) + planLogicFields(view, step).map(([label, value]) => field(label, value)).join('') + field('Path', step.branchRole) + field('Readiness', step.availability?.reason) + field('Owner', step.owner?.label || step.owner?.nodeId) + field('Execution', step.execution?.status) + field('Current attempt', step.attempt > 1 ? step.attempt : '');
  const branch = step.branch === 'option' ? '<p class="task-plan-option-note">An option the agent is considering. It is outside the active plan until a path is chosen.</p>' : step.branch === 'not-selected' ? '<p class="task-plan-option-note">This path was not chosen. It remains visible for context and is outside the completion count.</p>' : step.kind === 'choice' && !step.selectedChildId ? `<p class="task-plan-option-note">${step.branchLogic ? 'Resolve the next condition before selecting a path. An unknown fact is not false.' : 'The agent will choose a path using the conditions below.'} Choosing a row here only inspects it.</p>` : '';
  const next = view.focus?.id === step.id && view.state.checkpoint?.nextAction ? field('Next action', view.state.checkpoint.nextAction) : '';
  const attempts = planAttemptHistory(step);
  const history = attempts.length ? `<details class="task-plan-attempt-history"><summary>Previous attempts · ${attempts.length}${step.pastAttemptsOmitted ? ` shown of ${attempts.length + step.pastAttemptsOmitted}` : ''}</summary><p>Earlier work remains recorded. Returning to a step does not undo its effects.</p>${attempts.map(attempt => `<section><h4>Attempt ${escape(attempt.attempt || '?')} · ${escape(attempt.status)}</h4>${attempt.at ? `<p>Archived on <time datetime="${escape(attempt.at)}">${escape(attempt.at)}</time></p>` : ''}<dl>${field('Revisited because', attempt.reason)}${attempt.fields.map(([label, value]) => field(label, value)).join('')}</dl></section>`).join('')}</details>` : '';
  return `${breadcrumbs}<div class="task-plan-detail-heading"><div><span class="task-plan-detail-kicker">${step.isGroup ? 'Branch' : 'Step'} ${escape(step.number)}${step.stepType ? ` · ${escape(step.stepType)}` : ''}</span><h3 id="${prefix}-detail-title">${escape(step.title)}</h3></div><span class="task-plan-detail-status" data-status="${escape(step.status)}">${escape(step.statusLabel)}</span></div>${branch}<dl class="task-plan-detail-fields">${actualFields}${next}</dl>${history}${!actualFields && !branch && !next ? `<p class="task-plan-detail-empty">${step.isGroup ? 'Open the substeps to inspect their approach and results.' : 'The agent will add checks and results as this step takes shape.'}</p>` : ''}${dependencies.length ? `<div class="task-plan-dependencies"><h4>Depends on</h4>${dependencies.map(item => `<button type="button" data-plan-action="select" data-step-id="${escape(item.id)}">${icon(item.status === 'done' ? 'done' : 'pending', 13)}<span>${escape(item.number)} ${escape(item.title)}</span></button>`).join('')}</div>` : ''}${artifacts.length ? `<div class="task-plan-step-files"><h4>Step files</h4>${artifacts.map(artifact => `<a class="task-plan-file" href="/api/tasks/${encodeURIComponent(view.taskId)}/artifacts/${encodeURIComponent(artifact.id)}/preview" data-plan-action="artifact" data-artifact-id="${escape(artifact.id)}">${icon('file', 19)}<span><strong>${escape(artifact.title || artifact.fileName || 'Saved file')}</strong><small>File bytes checked</small></span>${icon('chevron', 12)}</a>`).join('')}</div>` : ''}${options.canGuide && options.onDraftDirection ? `<div class="task-plan-detail-actions">${button('guide', 'Guide this step', 'guide', 'title="Prepare a message about this step; review it before sending"')}<span>Opens a draft</span></div>` : ''}`;
}

function renderInspectorTray(view, session, expanded, compact, prefix) {
  const step = view.byId.get(session.selectedId);
  if (!step) return '';
  return `<button type="button" class="task-plan-inspector-toggle" data-plan-action="details" aria-expanded="${expanded}" aria-controls="${prefix}-detail-body"><span class="task-plan-inspector-selection"><small>${step.isGroup ? 'Branch' : 'Step'} ${escape(step.number)} · ${escape(step.statusLabel)}</small><strong id="${prefix}-inspector-title">${escape(step.title)}</strong></span><span class="task-plan-inspector-toggle-label">${compact && expanded ? session.presentation === 'map' ? 'Back to map' : 'Back to outline' : expanded ? 'Hide details' : 'Details'}${icon('chevron', 15)}</span></button>`;
}

function renderEmpty(view) {
  const title = view.phase === 'off' ? 'Automatic planning is off.' : view.phase === 'preparing' ? 'First, a clear approach.' : view.phase === 'unavailable' ? 'Keep the conversation going.' : view.phase === 'missing' ? 'The plan was not recorded.' : 'No saved steps yet.';
  const detail = view.planningMessage || (view.phase === 'off' ? 'Your agent can answer without creating an outline. Existing task notes are kept.' : view.phase === 'unavailable' ? 'This model does not expose saved planning tools. Its response remains available in Conversation.' : view.phase === 'missing' ? 'The agent returned without saving an outline. Its response is available in Conversation; no steps were marked complete.' : view.live ? 'Your agent is breaking the task into manageable steps. This outline will grow and update as the work happens.' : 'This conversation has no saved plan. New tasks with planning enabled build one automatically.');
  const notes = savedPlanNotes(view.state);
  return `${notes.length ? '' : '<div class="task-plan-empty-art" aria-hidden="true"><svg width="210" height="140" viewBox="0 0 210 140" fill="none"><path class="task-plan-empty-vein" d="M104 24v30M42 86V54h126v32M42 104v19m126-19v19m-64-69v69"/><path d="m104 7 18 10-6 18-22-3-4-15Z"/><path d="m42 77 13 7-3 15-18-2-5-10Zm126 0 16 5-3 18-19-4-5-9Z"/><path class="task-plan-empty-reflection" d="m35 122 14 2m111-2 17 3m-80-2 15 2"/><path d="m102 15 11 6-6 7m-9-11 4 8m-65 59 9 7m121-7 6 9"/></svg></div>'}<h3>${notes.length && !view.planningEnabled ? 'Saved task notes' : title}</h3><p>${escape(detail)}</p>${notes.map(section => `<div class="task-plan-empty-checkpoint"><strong>Saved ${escape(section.label.toLowerCase())}</strong>${section.entries.map(value => `<p>${escape(value)}</p>`).join('')}</div>`).join('')}`;
}

function renderMap(view, session, prefix) {
  const focus = view.byId.get(session.mapFocusId), path = focus ? [...planAncestors(view, focus.id), focus.id].map(id => view.byId.get(id)) : [];
  const map = taskPlanMap(view, { focusId: session.mapFocusId, collapsed: session.collapsed });
  const crumbs = `<button type="button" data-plan-action="map-reset"${focus ? '' : ' aria-current="page"'} title="Show the whole saved plan">Whole plan</button>${path.map(node => `<span aria-hidden="true">${icon('chevron', 10)}</span><button type="button" data-plan-action="map-parent" data-step-id="${escape(node.id)}"${node.id === focus.id ? ' aria-current="page"' : ''} title="${escape(node.title)}">${escape(node.number)} ${escape(node.title)}</button>`).join('')}`;
  const selected = view.byId.get(session.selectedId);
  return `<div class="task-plan-map-navigation"><nav class="task-plan-breadcrumbs" aria-label="Map focus">${crumbs}</nav>${selected ? button('map-focus', selected.isGroup ? 'Focus branch' : 'Focus step', 'focus', `title="Inspect ${escape(selected.title)} on its own"${selected.id === session.mapFocusId ? ' disabled' : ''}`) : ''}</div><div class="task-plan-map-controls" role="group" aria-label="Map zoom">${button('map-zoom-out', 'Zoom out', 'minus', `aria-label="Zoom out"${session.mapZoom <= .35 ? ' disabled' : ''}`)}${button('map-fit', `${Math.round(session.mapZoom * 100)}% · Fit width`, '', 'title="Fit the width while keeping labels readable. Scroll or swipe through larger maps."')}${button('map-zoom-in', 'Zoom in', 'plus', `aria-label="Zoom in"${session.mapZoom >= 2.5 ? ' disabled' : ''}`)}</div><div class="task-plan-map-canvas" tabindex="0" role="region" aria-label="Task mind map. Scroll or swipe to pan." aria-describedby="${prefix}-map-help">${renderTaskPlanMapSVG(view, session, { prefix: `${prefix}-map` })}</div><p class="task-plan-map-help" id="${prefix}-map-help">Numbers show order. Dotted branches are alternatives; dashed arrows are dependencies.${map.externalDependencies.length ? ` ${map.externalDependencies.length} ${map.externalDependencies.length === 1 ? 'dependency lies' : 'dependencies lie'} outside this view; inspect the step’s details to follow them.` : ''}<span class="sr-only"> Arrow keys move between steps; Enter opens details. F focuses the selected branch. Escape returns to the whole plan.</span></p>`;
}

function downloadPlan(file) {
  const url = URL.createObjectURL(new Blob([file.text], { type: file.contentType })), link = document.createElement('a');
  try { link.href = url; link.download = file.fileName; document.body.append(link); link.click(); }
  finally { link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
}

/**
 * A persistent outline controller. Tree elements retain their identity across
 * SSE updates. Inspection, disclosure, and keyboard focus are per task; none of
 * these controls edits the saved plan or starts an agent.
 */
export function initTaskPlanUI({ mount, onArtifact, onMethod, onDraftDirection, onSaveMethod, onOpenMethods, onContinue, onRepeat, onOpenPlanning, onSelection, onEnlargedChange, externalInspector = false, onExport = downloadPlan, onError = () => {} } = {}) {
  if (!mount) throw new Error('A task plan mount is required.');
  installTaskPlanStyles();
  const compactMedia = typeof window !== 'undefined' ? window.matchMedia?.('(max-width: 600px)') : null;
  let compact = compactMedia?.matches === true, enlarged = false;
  const prefix = `blackice-plan-${++instance}`, sessions = new Map(), elements = new Map(), regionMarkup = new Map(), busy = new Set();
  let view = taskPlanView(), session = {}, current = {}, currentKey = '', renderedKey = '', pending = null, destroyed = false, sequence = 0;
  mount.classList.add('task-plan-workspace'); mount.setAttribute('aria-label', 'Task plan'); mount.id ||= `${prefix}-workspace`; mount.dataset.planEnlarged = 'false';
  mount.innerHTML = `<section class="task-plan-header" data-plan-region="header"></section><div class="task-plan-outline-bar"><div class="task-plan-toolbar" data-plan-region="toolbar"></div><button type="button" class="task-plan-control task-plan-size-toggle" data-plan-action="enlarge" aria-expanded="false" aria-controls="${escape(mount.id)}" aria-label="Enlarge plan" title="Enlarge plan">${icon('expand', 16)}<span>Enlarge</span></button></div><div class="task-plan-tree-viewport"><div class="task-plan-empty" data-plan-region="empty"></div><ul id="${prefix}-outline" class="task-plan-tree" role="tree" aria-label="Task steps" aria-describedby="${prefix}-tree-help"></ul><div id="${prefix}-map-panel" class="task-plan-map-viewport" data-plan-region="map" role="tabpanel" aria-labelledby="${prefix}-map-tab" hidden inert></div></div><section class="task-plan-inspector" data-plan-region="inspector" aria-labelledby="${prefix}-inspector-title" hidden></section><footer class="task-plan-footer" data-plan-region="footer"></footer><p class="sr-only" id="${prefix}-tree-help">Use Up and Down to move between steps. Right expands a branch; Left collapses it. Home and End move to the first and last visible step. Selecting a step inspects it without changing the plan. Open Details to read its checks and results; Escape returns to the outline.</p><span class="sr-only" data-plan-region="announcement" role="status" aria-live="polite" aria-atomic="true"></span>`;
  const $ = selector => mount.querySelector(selector), region = name => $(`[data-plan-region="${name}"]`);
  const tree = $('.task-plan-tree'), viewport = $('.task-plan-tree-viewport'), inspector = region('inspector');
  const sizeControl = $('[data-plan-action="enlarge"]'), sizeScroll = new Map();
  const detailsExpanded = () => !externalInspector && Boolean(session.selectedId) && (session.inspectorExpanded ?? !compact);
  const detailBody = () => $('.task-plan-detail-body');
  const detailToggle = () => $('[data-plan-action="details"]');
  const mapCanvas = () => $('.task-plan-map-canvas');
  const mapNode = id => [...mount.querySelectorAll('[data-plan-map-node]')].find(element => element.dataset.planMapNode === id);
  const selectedElement = () => session.presentation === 'map' ? mapNode(session.selectedId) : elements.get(session.selectedId)?.element;
  function visible(element) {
    if (!element?.isConnected || element.disabled || element.hasAttribute?.('disabled')) return false;
    for (let parent = element; parent; parent = parent.parentElement) if (parent.hidden || parent.inert || parent.tagName === 'DETAILS' && !parent.open && !parent.querySelector('summary')?.contains(element)) return false;
    return true;
  }
  const options = () => ({ ...current, onArtifact, onMethod, onDraftDirection, onSaveMethod, onOpenMethods });
  const saveSession = () => { if (!currentKey) return; sessions.set(currentKey, session); if (sessions.size > 50) sessions.delete(sessions.keys().next().value); };
  function replaceRegion(name, markup) {
    const element = region(name); if (!element || regionMarkup.get(name) === markup) return;
    const open = new Set([...element.querySelectorAll('details[data-plan-disclosure]')].filter(item => item.open).map(item => item.dataset.planDisclosure));
    regionMarkup.set(name, markup); element.innerHTML = markup;
    for (const detail of element.querySelectorAll('details[data-plan-disclosure]')) if (open.has(detail.dataset.planDisclosure)) detail.open = true;
  }
  function focusToken() {
    const active = document.activeElement; if (!active || !mount.contains(active)) return null;
    if (active === mapCanvas()) return { canvas: true, element: active };
    const control = active.closest?.('[data-plan-action]'), node = active.closest?.('[data-plan-node]');
    return control ? { action: control.dataset.planAction, stepId: control.dataset.stepId || '', artifactId: control.dataset.artifactId || '', element: active } : node ? { node: node.dataset.planNode, element: active } : active.closest?.('details[data-plan-disclosure]') ? { disclosure: active.closest('details[data-plan-disclosure]').dataset.planDisclosure, goalText: active.classList.contains('task-plan-goal-text'), scrollTop: active.scrollTop, element: active } : null;
  }
  function restoreFocus(token) {
    if (!token || visible(token.element) && mount.contains(token.element)) return;
    const target = token.canvas ? mapCanvas() : token.node ? elements.get(token.node)?.element : token.disclosure ? [...mount.querySelectorAll('details[data-plan-disclosure]')].find(element => element.dataset.planDisclosure === token.disclosure)?.querySelector(token.goalText ? '.task-plan-goal-text' : 'summary') : [...mount.querySelectorAll('[data-plan-action]')].find(element => element.dataset.planAction === token.action && (element.dataset.stepId || '') === token.stepId && (element.dataset.artifactId || '') === token.artifactId);
    const zoomFallback = ['map-zoom-in', 'map-zoom-out'].includes(token.action) ? $('[data-plan-action="map-fit"]') : null;
    const next = [target, zoomFallback, selectedElement(), detailToggle()].find(visible);
    next?.focus({ preventScroll: true }); if (token.goalText && next === target) next.scrollTop = token.scrollTop || 0;
  }
  function renderTree() {
    const seen = new Set();
    function renderChildren(nodes, parent) {
      for (const [index, node] of nodes.entries()) {
        seen.add(node.id); let entry = elements.get(node.id);
        if (!entry) {
          const element = document.createElement('li'), row = document.createElement('div'), group = document.createElement('ul'), suffix = ++sequence;
          element.className = 'task-plan-node'; element.dataset.planNode = node.id; element.setAttribute('role', 'treeitem');
          row.className = 'task-plan-row'; group.className = 'task-plan-children'; group.setAttribute('role', 'group');
          const ids = { label: `${prefix}-label-${suffix}`, status: `${prefix}-status-${suffix}`, group: `${prefix}-group-${suffix}` };
          group.id = ids.group; element.append(row, group); entry = { element, row, group, ids, signature: '' }; elements.set(node.id, entry);
        }
        const { element, row, group, ids } = entry, expanded = !session.collapsed.has(node.id);
        element.dataset.status = node.status; element.dataset.readiness = node.availability?.state || '';  element.dataset.branch = node.branch; element.dataset.kind = node.kind;
        element.classList.toggle('is-selected', session.selectedId === node.id); element.classList.toggle('is-current', view.focus?.id === node.id); element.classList.toggle('is-group', node.isGroup); element.classList.toggle('is-expanded', expanded);
        element.tabIndex = session.selectedId === node.id ? 0 : -1;
        element.setAttribute('aria-selected', String(session.selectedId === node.id)); element.setAttribute('aria-level', String(node.depth)); element.setAttribute('aria-posinset', String(node.position)); element.setAttribute('aria-setsize', String(node.siblingCount)); element.setAttribute('aria-labelledby', ids.label); element.setAttribute('aria-describedby', ids.status);
        if (node.isGroup) element.setAttribute('aria-expanded', String(expanded)); else element.removeAttribute('aria-expanded');
        const markup = renderPlanRow(node, expanded, ids);
        if (entry.signature !== markup) { entry.signature = markup; row.innerHTML = markup; }
        group.hidden = !node.isGroup || !expanded; renderChildren(node.children, group);
        if (parent.children[index] !== element) parent.insertBefore(element, parent.children[index] || null);
      }
    }
    renderChildren(view.roots, tree);
    for (const [id, entry] of elements) if (!seen.has(id)) { entry.element.remove(); elements.delete(id); }
  }
  function captureGoalDisclosure() {
    if (currentKey !== renderedKey) return;
    const goal = $('[data-plan-disclosure="goal"]'); if (goal) session.goalOpen = goal.open;
  }
  function render({ announce = false } = {}) {
    if (destroyed) return;
    session = reconcilePlanMapSession(view, session);
    // Native details toggles are queued; read the owned DOM before replacing it.
    captureGoalDisclosure();
    if (session.inspectorStepId !== session.selectedId) { session.inspectorStepId = session.selectedId; session.inspectorTop = 0; inspector.scrollTop = 0; }
    const token = focusToken(), scrollTop = viewport.hidden ? session.scrollTop || 0 : viewport.scrollTop, scrollLeft = viewport.hidden ? session.scrollLeft || 0 : viewport.scrollLeft, inspectorTop = inspector.scrollTop;
    const canvas = mapCanvas();
    if (currentKey === renderedKey && session.presentation === 'map' && canvas && !region('map').hidden) { session.mapScrollTop = canvas.scrollTop; session.mapScrollLeft = canvas.scrollLeft; }
    mount.dataset.planPhase = view.phase; mount.dataset.planTask = view.taskId; mount.dataset.planOrigin = view.origin;
    const expanded = detailsExpanded(), mapped = session.presentation === 'map'; mount.dataset.planCompact = String(compact); mount.dataset.planDetails = expanded ? 'open' : 'closed'; mount.dataset.planPresentation = session.presentation;
    replaceRegion('header', renderPlanHeader(view, options()));
    const goal = $('[data-plan-disclosure="goal"]'); if (goal) goal.open = session.goalOpen === true; renderedKey = currentKey;
    replaceRegion('toolbar', `${view.nodes.length ? `<div class="task-plan-view-tabs" role="tablist" aria-label="Plan view"><button id="${prefix}-outline-tab" type="button" role="tab" data-plan-action="view-outline" aria-controls="${prefix}-outline" aria-selected="${!mapped}" tabindex="${mapped ? '-1' : '0'}">${icon('sequence', 14)}<span>Outline</span></button><button id="${prefix}-map-tab" type="button" role="tab" data-plan-action="view-map" aria-controls="${prefix}-map-panel" aria-selected="${mapped}" tabindex="${mapped ? '0' : '-1'}">${icon('map', 14)}<span>Mind map</span></button></div>` : '<span class="task-plan-outline-label">Steps and branches</span>'}<div class="task-plan-outline-actions">${view.focus ? button('current', 'Current step', 'focus', `title="Locate ${escape(view.focus.title)}"`) : ''}<details class="task-plan-menu" data-plan-disclosure="menu"><summary aria-label="Plan actions" title="Plan actions">${icon('more', 18)}</summary><div>${view.nodes.some(node => node.isGroup) ? button('expand-all', 'Expand all branches', 'expand') + button('collapse-all', 'Collapse all branches', 'collapse') : ''}${view.nodes.length ? button('export-svg', 'Export editable SVG', 'download') + button('export-mm', 'Export Freeplane (.mm)', 'download') : ''}${onOpenPlanning ? button('planning', 'Open Planning', 'plan') : ''}<p>Viewing and expanding steps starts no work.</p></div></details></div>`);
    region('toolbar').hidden = compact && expanded; region('toolbar').inert = compact && expanded;
    viewport.hidden = compact && expanded; viewport.inert = compact && expanded;
    region('empty').hidden = view.nodes.length > 0; tree.hidden = !view.nodes.length || mapped; tree.inert = tree.hidden;
    region('map').hidden = !view.nodes.length || !mapped; region('map').inert = region('map').hidden;
    if (!view.nodes.length) replaceRegion('empty', renderEmpty(view));
    renderTree();
    if (mapped && view.nodes.length) replaceRegion('map', renderMap(view, session, prefix));
    inspector.hidden = externalInspector || !session.selectedId;
    replaceRegion('inspector', session.selectedId ? renderInspectorTray(view, session, expanded, compact, prefix) + `<div id="${prefix}-detail-body" class="task-plan-detail-body"${expanded ? '' : ' hidden inert'}>${renderPlanInspector(view, session, options(), prefix)}</div>` : '');
    if (detailBody()) { detailBody().hidden = !expanded; detailBody().inert = !expanded; }
    replaceRegion('footer', `${view.state.interruption ? `<p class="task-plan-interruption">${icon('blocked', 14)}<span>${escape(view.state.interruption.reason || 'Work stopped. The saved plan is kept.')}</span></p>` : ''}<div class="task-plan-footer-line">${!view.planningEnabled ? '<p>Automatic planning is off. Saved steps and notes are kept.</p>' : ''}${current.canContinue && current.settled && !view.live && !view.complete && onContinue ? button('continue', 'Draft next action', 'guide') : ''}${current.canRepeat && current.settled && !view.live && view.complete && current.runStatus === 'completed' && onRepeat ? button('repeat', 'Make repeatable', 'method') : ''}</div>`);
    region('footer').hidden = !view.state.interruption && view.planningEnabled && !(current.canContinue && current.settled && !view.live && !view.complete && onContinue) && !(current.canRepeat && current.settled && !view.live && view.complete && current.runStatus === 'completed' && onRepeat);
    viewport.scrollTop = scrollTop; viewport.scrollLeft = scrollLeft; inspector.scrollTop = expanded ? inspectorTop : 0;
    if (mapped && mapCanvas()) { mapCanvas().scrollTop = session.mapScrollTop || 0; mapCanvas().scrollLeft = session.mapScrollLeft || 0; }
    restoreFocus(token); saveSession();
    if (announce) region('announcement').textContent = `${phaseCopy(view)}. ${view.progress.done} of ${view.progress.total} steps done${view.progress.skipped ? `, ${view.progress.skipped} skipped` : ''}.`;
  }
  function hasTextSelection() {
    const selection = typeof window !== 'undefined' ? window.getSelection?.() : null;
    return Boolean(selection && !selection.isCollapsed && selection.containsNode?.(mount, true));
  }
  function update(value = {}) {
    if (destroyed) return;
    const next = taskPlanView(value.taskState, value), key = next.taskId || value.runId || 'new';
    if (key === currentKey && hasTextSelection()) { pending = value; return; }
    pending = null; const oldPhase = view.phase, oldProgress = JSON.stringify(view.progress), changing = key !== currentKey;
    if (changing) { captureGoalDisclosure(); saveSession(); currentKey = key; session = sessions.get(key) || {}; for (const entry of elements.values()) entry.element.remove(); elements.clear(); }
    current = value; view = next; session = reconcilePlanMapSession(view, reconcilePlanSession(view, session));
    if (changing) sizeScroll.clear();
    render({ announce: !changing && (oldPhase !== view.phase || oldProgress !== JSON.stringify(view.progress)) });
    if (changing) { viewport.scrollTop = session.scrollTop || 0; viewport.scrollLeft = session.scrollLeft || 0; inspector.scrollTop = detailsExpanded() ? session.inspectorTop || 0 : 0; setEnlarged(false, { focusControl: false }); }
  }
  function reveal(id, focus = true) {
    const entry = elements.get(id); if (!entry) return;
    if (compact && detailsExpanded()) { if (focus) detailToggle()?.focus({ preventScroll: true }); return; }
    if (session.presentation === 'map') {
      const element = mapNode(id), canvas = mapCanvas(); if (!element || !canvas) return;
      if (focus && visible(element)) element.focus({ preventScroll: true });
      const bounds = element.getBoundingClientRect?.(), frame = canvas.getBoundingClientRect?.(); if (!bounds || !frame) return;
      if (bounds.top < frame.top + 8) canvas.scrollTop -= frame.top + 8 - bounds.top;
      else if (bounds.bottom > frame.bottom - 8) canvas.scrollTop += bounds.bottom - frame.bottom + 8;
      if (bounds.left < frame.left + 8) canvas.scrollLeft -= frame.left + 8 - bounds.left;
      else if (bounds.right > frame.right - 8) canvas.scrollLeft += bounds.right - frame.right + 8;
      recordScroll(); return;
    }
    if (focus && visible(entry.element)) entry.element.focus({ preventScroll: true });
    const bounds = entry.row.getBoundingClientRect?.(), frame = viewport.getBoundingClientRect?.();
    if (!bounds || !frame) return;
    if (bounds.top < frame.top + 8) viewport.scrollTop -= frame.top + 8 - bounds.top;
    else if (bounds.bottom > frame.bottom - 8) viewport.scrollTop += bounds.bottom - frame.bottom + 8;
  }
  function selectStep(id, { focus = true, notify = true } = {}) {
    if (!view.byId.has(id)) return false;
    session = selectPlanStep(view, session, id); render(); reveal(id, focus); if (notify) notifySelection(); return true;
  }
  const recordScroll = () => { if (!viewport.hidden) { session.scrollTop = viewport.scrollTop; session.scrollLeft = viewport.scrollLeft; } if (session.presentation === 'map' && mapCanvas() && !region('map').hidden) { session.mapScrollTop = mapCanvas().scrollTop; session.mapScrollLeft = mapCanvas().scrollLeft; } if (detailsExpanded()) session.inspectorTop = inspector.scrollTop; saveSession(); };
  function setEnlarged(value, { focusControl = true } = {}) {
    const next = value === true; if (destroyed || next === enlarged) return false;
    recordScroll();
    const offsets = { top: viewport.scrollTop, left: viewport.scrollLeft, inspector: inspector.scrollTop, mapTop: mapCanvas()?.scrollTop || 0, mapLeft: mapCanvas()?.scrollLeft || 0 };
    sizeScroll.set(enlarged, offsets); enlarged = next; mount.dataset.planEnlarged = String(enlarged);
    sizeControl.setAttribute('aria-expanded', String(enlarged)); sizeControl.setAttribute('aria-label', enlarged ? 'Restore plan size' : 'Enlarge plan'); sizeControl.title = enlarged ? 'Restore plan size · Esc' : 'Enlarge plan';
    sizeControl.innerHTML = `${icon(enlarged ? 'collapse' : 'expand', 16)}<span>${enlarged ? 'Restore' : 'Enlarge'}</span>`;
    // Change the host layout without replacing the plan, map or external editor.
    onEnlargedChange?.(enlarged);
    const saved = sizeScroll.get(enlarged) || offsets;
    viewport.scrollTop = saved.top; viewport.scrollLeft = saved.left; inspector.scrollTop = saved.inspector;
    if (mapCanvas()) { mapCanvas().scrollTop = saved.mapTop; mapCanvas().scrollLeft = saved.mapLeft; }
    recordScroll();
    if (focusControl && visible(sizeControl)) sizeControl.focus({ preventScroll: true });
    return true;
  }
  function setPresentation(value, { focusTab = false } = {}) {
    if (!['outline', 'map'].includes(value) || !view.nodes.length) return;
    recordScroll(); session.presentation = value; render();
    if (focusTab) $(`[data-plan-action="view-${value}"]`)?.focus({ preventScroll: true });
  }
  function focusMap(id) {
    if (id !== null && !view.byId.has(id)) return false;
    recordScroll(); session = { ...session, presentation: 'map', mapFocusId: id, mapZoom: 1 };
    if (id) { session = selectPlanStep(view, session, id); if (view.byId.get(id).isGroup) session = togglePlanBranch(view, session, id, true); }
    render(); if (mapCanvas()) { mapCanvas().scrollTop = 0; mapCanvas().scrollLeft = 0; } recordScroll(); return true;
  }
  function changeMapZoom(value) {
    const canvas = mapCanvas(), old = session.mapZoom || 1, width = canvas?.clientWidth || 400, height = canvas?.clientHeight || 300;
    const centerX = (canvas?.scrollLeft || 0) + width / 2, centerY = (canvas?.scrollTop || 0) + height / 2;
    session.mapZoom = planMapZoom(value); render();
    if (mapCanvas()) { mapCanvas().scrollLeft = Math.max(0, centerX * session.mapZoom / old - width / 2); mapCanvas().scrollTop = Math.max(0, centerY * session.mapZoom / old - height / 2); } recordScroll();
  }
  function notifySelection(openDetails = false) { onSelection?.({ taskId: view.taskId, stepId: session.selectedId, openDetails }); }
  function setDetailsExpanded(expanded) {
    if (externalInspector) { if (expanded) notifySelection(true); return; }
    if (!session.selectedId) return;
    recordScroll();
    if (detailsExpanded()) session.inspectorTop = inspector.scrollTop;
    session.inspectorExpanded = expanded; if (expanded) session.pinned = true; render();
    if (expanded) { inspector.scrollTop = session.inspectorTop || 0; detailToggle()?.focus({ preventScroll: true }); }
    else if (compact) reveal(session.selectedId);
    else detailToggle()?.focus({ preventScroll: true });
  }
  function disclosureToggle(event) {
    if (event.target.dataset?.planDisclosure !== 'goal' || !mount.contains(event.target)) return;
    session.goalOpen = event.target.open; saveSession();
  }
  function responsiveChange(event) {
    if (destroyed || compact === event.matches) return;
    recordScroll();
    const active = document.activeElement, fromCanvas = active === mapCanvas(), fromTree = tree.contains(active) || region('map').contains(active), fromDetails = detailBody()?.contains(active);
    compact = event.matches;
    // A viewport change must not conceal whichever reading surface owns focus.
    if (compact && fromTree) session.inspectorExpanded = false;
    else if (fromDetails) session.inspectorExpanded = true;
    render();
    if (fromTree && !fromCanvas) reveal(session.selectedId);
  }

  async function click(event) {
    const control = event.target.closest?.('[data-plan-action]');
    if (control && mount.contains(control)) {
      const action = control.dataset.planAction;
      if (action === 'artifact' && (event.button && event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || !onArtifact)) return;
      event.preventDefault();
      const menu = control.closest?.('details[data-plan-disclosure="menu"]'); if (menu) menu.open = false;
      if (action === 'enlarge') { setEnlarged(!enlarged); return; }
      if (action === 'view-outline' || action === 'view-map') { setPresentation(action === 'view-map' ? 'map' : 'outline', { focusTab: true }); return; }
      if (action === 'details') { setDetailsExpanded(!detailsExpanded()); return; }
      if (action === 'toggle') { session = { ...session, selectedId: control.dataset.stepId }; session = togglePlanBranch(view, session, control.dataset.stepId); render(); reveal(session.selectedId); notifySelection(); return; }
      if (action === 'select' || action === 'map-select') { selectStep(control.dataset.stepId); return; }
      if (action === 'map-focus') { focusMap(session.selectedId); reveal(session.selectedId); return; }
      if (action === 'map-parent') { focusMap(control.dataset.stepId); reveal(session.selectedId); return; }
      if (action === 'map-reset') { focusMap(null); return; }
      if (action === 'map-zoom-in' || action === 'map-zoom-out') { changeMapZoom(session.mapZoom + (action === 'map-zoom-in' ? .2 : -.2)); return; }
      if (action === 'map-fit') { const map = taskPlanMap(view, { focusId: session.mapFocusId, collapsed: session.collapsed }), canvas = mapCanvas(); changeMapZoom(planMapFitZoom(map, canvas?.clientWidth)); if (mapCanvas()) { mapCanvas().scrollTop = 0; mapCanvas().scrollLeft = 0; } recordScroll(); return; }
      if (action === 'current') { if (view.focus) { session = selectPlanStep(view, session, view.focus.id, { pinned: false }); render(); reveal(view.focus.id); notifySelection(); } return; }
      if (action === 'expand-all' || action === 'collapse-all') { for (const node of view.nodes) if (node.isGroup) session = togglePlanBranch(view, session, node.id, action === 'expand-all'); render(); reveal(session.selectedId); return; }
      let callback, payload;
      if ((action === 'export-svg' || action === 'export-mm') && view.nodes.length) { callback = onExport; payload = taskPlanExport(view, action === 'export-mm' ? 'mm' : 'svg'); }
      if (action === 'guide' && current.canGuide && onDraftDirection) { callback = onDraftDirection; payload = { ...planStepContext(view, view.byId.get(session.selectedId)), runId: current.runId }; }
      if (action === 'method' && view.method && onMethod) { callback = onMethod; payload = view.method; }
      if (action === 'planning' && onOpenPlanning) { callback = onOpenPlanning; payload = { taskId: view.taskId, taskState: view.state, runId: current.runId, runStatus: current.runStatus }; }
      if (action === 'save-method' && current.canSaveMethod && view.nodes.length && onSaveMethod) { callback = onSaveMethod; payload = { taskState: view.state, runId: current.runId }; }
      if (action === 'artifact' && onArtifact && view.state.artifacts?.some(item => item.id === control.dataset.artifactId)) { callback = onArtifact; payload = { taskId: view.taskId, artifactId: control.dataset.artifactId }; }
      if (action === 'continue' && current.canContinue && current.settled && !view.live && !view.complete && onContinue) { callback = onContinue; payload = { taskState: view.state, runId: current.runId }; }
      if (action === 'repeat' && current.canRepeat && current.settled && !view.live && view.complete && current.runStatus === 'completed' && onRepeat) { callback = onRepeat; payload = { taskState: view.state, runId: current.runId }; }
      if (!callback) return;
      const operation = `${currentKey}:${action}:${control.dataset.artifactId || ''}`;
      if (busy.has(operation)) return; busy.add(operation); control.setAttribute('aria-busy', 'true');
      try { await callback(payload); } catch (error) { onError(error); } finally { busy.delete(operation); if (control.isConnected) control.removeAttribute('aria-busy'); }
      return;
    }
    const node = event.target.closest?.('[data-plan-node]');
    if (node && tree.contains(node)) selectStep(node.dataset.planNode);
  }
  function keydown(event) {
    if (!event.defaultPrevented && event.key === 'Escape' && inspector.contains(event.target) && detailsExpanded()) { event.preventDefault(); event.stopPropagation(); setDetailsExpanded(false); return; }
    if (event.defaultPrevented || event.altKey || event.metaKey || event.ctrlKey) return;
    if (event.key === 'Escape' && session.presentation === 'map' && region('map').contains(event.target) && session.mapFocusId) { event.preventDefault(); event.stopPropagation(); focusMap(null); reveal(session.selectedId); return; }
    if (event.key === 'Escape' && enlarged) { event.preventDefault(); event.stopPropagation(); setEnlarged(false); return; }
    const tab = event.target.closest?.('[data-plan-action]');
    if (tab && ['view-outline', 'view-map'].includes(tab.dataset.planAction) && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { event.preventDefault(); setPresentation(event.key === 'Home' ? 'outline' : event.key === 'End' ? 'map' : session.presentation === 'map' ? 'outline' : 'map', { focusTab: true }); return; }
    if (session.presentation === 'map' && region('map').contains(event.target)) {
      const element = event.target.closest?.('[data-plan-map-node]');
      if (!element || event.target !== element) return;
      const id = element.dataset.planMapNode, node = view.byId.get(id), map = taskPlanMap(view, { focusId: session.mapFocusId, collapsed: session.collapsed }), nodes = map.nodes.filter(node => !node.isGoal), index = nodes.findIndex(node => node.id === id);
      let target;
      if (event.key === 'ArrowDown') target = nodes[Math.min(nodes.length - 1, index + 1)]?.id;
      else if (event.key === 'ArrowUp') target = nodes[Math.max(0, index - 1)]?.id;
      else if (event.key === 'Home') target = nodes[0]?.id;
      else if (event.key === 'End') target = nodes.at(-1)?.id;
      else if (event.key === 'ArrowRight') { if (node.isGroup && session.collapsed.has(id)) session = togglePlanBranch(view, session, id, true); else target = node.children[0]?.id; }
      else if (event.key === 'ArrowLeft') { if (node.isGroup && !session.collapsed.has(id)) session = togglePlanBranch(view, session, id, false); else target = node.parentId; }
      else if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); session = selectPlanStep(view, session, id); setDetailsExpanded(true); return; }
      else if (event.key === ' ') { if (node.isGroup) session = togglePlanBranch(view, session, id); }
      else if (event.key.toLowerCase() === 'f') { event.preventDefault(); focusMap(id); reveal(id); return; }
      else return;
      event.preventDefault(); event.stopPropagation();
      if (target) session = selectPlanStep(view, session, target); render(); reveal(session.selectedId); notifySelection(); return;
    }
    if (!tree.contains(event.target)) return;
    const node = event.target.closest?.('[data-plan-node]'); if (!node || event.target !== node) return;
    session = { ...session, selectedId: node.dataset.planNode };
    if (event.key === 'Enter' && !view.byId.get(node.dataset.planNode)?.isGroup) { event.preventDefault(); event.stopPropagation(); session = selectPlanStep(view, session, node.dataset.planNode); setDetailsExpanded(true); return; }
    const result = planKeyboard(view, session, event.key); if (!result.handled) return;
    event.preventDefault(); event.stopPropagation(); session = result.session; render(); reveal(result.focusId); notifySelection();
  }
  const selectionChange = () => { if (pending && !hasTextSelection()) { const value = pending; pending = null; update(value); } };
  const mapScroll = event => { if (event.target === mapCanvas()) recordScroll(); };
  mount.addEventListener('click', click); mount.addEventListener('keydown', keydown); mount.addEventListener('toggle', disclosureToggle, true); mount.addEventListener('scroll', mapScroll, true); compactMedia?.addEventListener?.('change', responsiveChange); viewport.addEventListener('scroll', recordScroll, { passive: true }); inspector.addEventListener('scroll', recordScroll, { passive: true }); document.addEventListener('selectionchange', selectionChange);
  update();
  return { update, selectStep, setPresentation, focusMap, setEnlarged, exportPlan: format => taskPlanExport(view, format), getSelection: () => ({ taskId: view.taskId, selectedId: session.selectedId, collapsed: [...session.collapsed], pinned: session.pinned, detailsExpanded: detailsExpanded(), compact, enlarged, presentation: session.presentation, mapFocusId: session.mapFocusId, mapZoom: session.mapZoom, mapVisibleIds: taskPlanMap(view, { focusId: session.mapFocusId, collapsed: session.collapsed }).nodes.filter(node => !node.isGoal).map(node => node.id), visibleIds: visiblePlanNodes(view, session.collapsed).map(node => node.id) }), destroy() { if (destroyed) return; setEnlarged(false, { focusControl: false }); destroyed = true; pending = null; saveSession(); mount.removeEventListener('click', click); mount.removeEventListener('keydown', keydown); mount.removeEventListener('toggle', disclosureToggle, true); mount.removeEventListener('scroll', mapScroll, true); compactMedia?.removeEventListener?.('change', responsiveChange); viewport.removeEventListener('scroll', recordScroll); inspector.removeEventListener('scroll', recordScroll); document.removeEventListener('selectionchange', selectionChange); elements.clear(); sessions.clear(); } };
}
