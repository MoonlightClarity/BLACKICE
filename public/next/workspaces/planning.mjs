import { text, escapeHTML } from '../core/dom.mjs';
import { renderRecordedAnalyticPasses } from './tradecraft-timeline.mjs';
import { projectPlanningOntology } from '../../planning-ontology.mjs';
import { changeTaskState, taskActions, taskActionLabel, taskIsRunning } from './task-lifecycle.mjs';
import { taskPlanView, reconcilePlanSession, selectPlanStep, togglePlanBranch, planKeyboard, visiblePlanNodes, planKindLabel, planLogicFields, planAttemptHistory, planBranchText } from '../../task-plan-model.mjs';
import { renderTaskPlanMapSVG, taskPlanMap, planMapZoom, planMapFitZoom, reconcilePlanMapSession } from '../../task-plan-map.mjs';
import { createPlanningDraft, planningDraftDirty, planningDraftOperations, acceptPlanningSnapshot, rebasePlanningDraft, commitPlanningDraft, projectVisualModel, buildIntelligenceProject, intelligenceProjectDraft, isIntelligenceProject, renderIntelligenceComposer, renderIntelligenceLanding, renderIntelligenceOverview, intelligenceStarterText, intelligenceTextFromProject, intelligenceProjectFromText, renderIntelligenceMapWorkspace } from './planning-visual.mjs';

export function createPlanningWorkspace({ mount, api, events, notify = () => {}, onNavigate, getStatus = () => ({}) }) {
  mount.innerHTML = [
    '<div class="next-panel next-planning-workspace next-visual-workspace"><div class="next-panel-inner">',
    '<header class="next-panel-head"><div><h1>Intelligence Planning</h1><p>Define the intelligence requirement, plan collection, test hypotheses, and shape the assessment.</p></div>',
    '<div class="next-intel-header-actions"><button type="button" class="next-primary" id="next-intel-new">New assessment</button><button type="button" id="next-planning-refresh">Refresh</button></div></header>',
    '<div class="next-planning-layout"><aside class="next-planning-catalog" aria-label="Saved plans">',
    '<div class="next-planning-filters"><label class="next-label">Plan type<select class="next-field" id="next-planning-type"><option value="analysis">Intelligence assessments</option><option value="conversation">Agent working plans</option><option value="project">Other project plans</option></select></label>',
    '<label class="next-label">History<select class="next-field" id="next-planning-state"><option value="active">Active</option><option value="archived">Archived</option><option value="deleted">Trash</option></select></label>',
    '<input class="next-field" id="next-planning-query" type="search" maxlength="500" placeholder="Find plans" aria-label="Find plans">',
    '</div><p class="next-help" id="next-planning-info" role="status"></p>',
    '<div id="next-planning-list" class="next-planning-plan-list"></div><button type="button" id="next-planning-more" hidden>Load more</button>',
    '</aside><main id="next-planning-detail" class="next-planning-detail" aria-label="Selected plan"></main>',
    '</div></div></div>',
  ].join('');
  const find = id => mount.querySelector('#' + id), elements = {
    type: find('next-planning-type'), state: find('next-planning-state'), query: find('next-planning-query'),
    list: find('next-planning-list'), detail: find('next-planning-detail'), info: find('next-planning-info'),
    more: find('next-planning-more'), refresh: find('next-planning-refresh'), create: find('next-intel-new'),
  };
  let active = false, destroyed = false, generation = 0, detailGeneration = 0, items = [], selected = null, nextOffset = null, pending = false, timer = null, unsubscribe = null, error = '', detailError = '', readingDetail = false, detailController = null;
  const drafts = new Map(), documents = new Map(), sessions = new Map();
  let composing = false, mapController = null;
  const mountIntelligenceMap = options => {
    mapController?.destroy?.();
    mapController = renderIntelligenceMapWorkspace(options);
    return mapController;
  };
  const key = plan => plan ? plan.kind + ':' + (plan.taskId || plan.id) : '';
  const el = (parent, tag, content, cls) => text(parent, content, tag, cls);
  const button = (parent, label, action, id) => {
    const node = el(parent, 'button', label); node.type = 'button'; if (id) node.id = id;
    node.addEventListener('click', action); return node;
  };
  const badge = (parent, label, status) => { const node = el(parent, 'span', label, 'next-status-pill'); node.dataset.state = status || label; return node; };
  const title = plan => plan.title || plan.name || plan.goal || plan.id || 'Plan';
  async function showComposer(project = null) {
    if (!active || destroyed || pending) return;
    composing = true;
    let cwd = project?.cwd || getStatus()?.cwd || '';
    if (!cwd) { try { cwd = (await api('/api/status'))?.cwd || ''; } catch { /* User can enter an absolute working folder in the text. */ } }
    if (!composing || !active) return;
    mountIntelligenceMap({
      parent: elements.detail, editable: true, project,
      source: intelligenceTextFromProject(project, cwd),
      onSave: async source => {
        const definition = intelligenceProjectFromText(source, project);
        const canUpdate = project && ['draft', 'paused', 'needs_attention'].includes(project.status)
          && (project.tasks || []).every(task => !(task.attempts || []).length);
        const result = canUpdate
          ? await api('/api/projects/' + encodeURIComponent(project.id), 'PUT', { expectedRevision: project.revision, ...definition })
          : await api('/api/projects', 'POST', definition);
        composing = false;
        elements.type.value = 'analysis'; elements.state.value = 'active'; elements.query.value = '';
        await load();
        if (active) await select({ ...result, kind: 'project' });
        notify(canUpdate ? 'Intelligence text updated.' : 'Intelligence assessment draft saved.');
      },
      onCancel: () => { composing = false; drawDetail(); }
    });
  }
  function sessionFor(plan) {
    const id = key(plan); if (!sessions.has(id)) sessions.set(id, { presentation: 'map', mapZoom: 1, fitted: false, goalOpen: false });
    return sessions.get(id);
  }
  function abortDetail() { detailGeneration++; detailController?.abort(); detailController = null; readingDetail = false; }
  function releaseCleanSelection() { const draft = drafts.get(key(selected)); if (draft && !planningDraftDirty(draft) && !pending && !draft.detachedNotes.length) drafts.delete(key(selected)); }
  function draftFor(plan) {
    const id = key(plan); let draft = drafts.get(id);
    if (!draft) { draft = createPlanningDraft(plan); drafts.set(id, draft); }
    else Object.assign(draft, acceptPlanningSnapshot(draft, plan));
    return draft;
  }
  function fullPlan(metadata) {
    const saved = documents.get(metadata.taskId);
    return saved ? { ...metadata, ...saved, kind: 'conversation', bucket: metadata.bucket, editable: metadata.editable } : null;
  }
  function planActions(parent, plan) {
    if (plan.kind === 'project') {
      const action = button(parent, plan.archived ? 'Restore plan' : 'Archive plan', () => void lifecycle(plan, plan.archived ? 'restore' : 'archive'));
      action.dataset.planAction = plan.archived ? 'restore' : 'archive'; action.disabled = pending || !Number.isSafeInteger(plan.organizationRevision);
    } else for (const action of taskActions(plan.bucket || 'active')) {
      const node = button(parent, taskActionLabel(action), () => void lifecycle(plan, action)); node.dataset.planAction = action; node.disabled = pending;
      if (action === 'delete' && taskIsRunning(plan)) { node.disabled = true; node.title = 'Stop the task and wait for it to settle before moving it to Trash.'; }
    }
  }
  function recordedOntology(parent, saved, state) {
    const ontology = projectPlanningOntology(saved);
    if (!ontology.nodes.length) return;
    const disclosure = el(parent, 'details', '', 'next-plan-ontology');
    disclosure.open = state.ontologyOpen !== false;
    const summary = el(disclosure, 'summary', 'Analytical process / technical execution', 'next-plan-ontology-summary');
    summary.setAttribute('aria-label', 'Show the ontology projected from this saved plan');
    disclosure.addEventListener('toggle', () => { state.ontologyOpen = disclosure.open; });
    const lanes = el(disclosure, 'div', '', 'next-plan-ontology-grid');
    const planView = taskPlanView(saved);
    const display = [
      ['analytical', 'Analytical process', 'Questions, competing explanations, evidence tests and judgments'],
      ['technical', 'Technical execution', 'Methods, tool actions, collected material and output checks'],
      ['unclassified', 'Untyped saved work', 'Older or unclassified steps; no role has been inferred']
    ];
    for (const [domain, name, description] of display) {
      const nodes = ontology.lanes[domain];
      if (domain === 'unclassified' && !nodes.length) continue;
      const lane = el(lanes, 'section', '', 'next-plan-ontology-lane');
      lane.dataset.domain = domain;
      el(lane, 'h3', name + ' (' + nodes.length + ')');
      el(lane, 'p', description, 'next-help');
      if (!nodes.length) el(lane, 'p', 'No saved ' + (domain === 'analytical' ? 'analytical' : 'technical') + ' actions yet.', 'next-help');
      for (const node of nodes) {
        const line = el(lane, 'div', '', 'next-plan-ontology-item');
        const action = button(line, node.title, () => {
          Object.assign(state, selectPlanStep(planView, state, node.id));
          drawDetail(); focusStep(node.id);
        });
        action.className = 'next-plan-ontology-link';
        action.title = node.label + (node.doneWhen ? ' — ' + node.doneWhen : '');
        badge(line, node.status, node.status);
        el(line, 'small', node.label, 'next-help next-plan-ontology-type');
      }
    }
    el(disclosure, 'p', ontology.note, 'next-help next-plan-ontology-note');
  }
  function progress(parent, done, total, label) {
    const row = el(parent, 'div', '', 'next-plan-progress');
    const meter = el(row, 'progress', ''); meter.max = Math.max(1, total || 0); meter.value = done || 0;
    meter.setAttribute('aria-label', label); el(row, 'span', label, 'next-help');
  }
  function detailField(parent, label, value) {
    if (!value) return; const section = el(parent, 'div', '', 'next-plan-detail-field');
    el(section, 'h4', label); el(section, 'p', Array.isArray(value) ? value.join('\n') : value, 'next-plan-detail-text');
  }
  function restoreMapViewport(viewport, state, node) {
    viewport.dataset.mapFocus = state.mapFocusId || '';
    viewport.scrollLeft = Number.isFinite(state.mapLeft) ? state.mapLeft : Math.max(0, ((node?.x || 0) + (node?.width || 0) / 2) * state.mapZoom - (viewport.clientWidth || 720) / 2);
    viewport.scrollTop = Number.isFinite(state.mapTop) ? state.mapTop : Math.max(0, ((node?.y || 0) + (node?.height || 0) / 2) * state.mapZoom - (viewport.clientHeight || 380) / 2);
  }
  function focusStep(id, project = false) {
    const attribute = project ? 'data-plan-project-step' : sessionFor(selected).presentation === 'outline' ? 'data-plan-outline-step' : 'data-plan-map-node';
    const node = [...elements.detail.querySelectorAll('[' + attribute + ']')].find(node => node.getAttribute(attribute) === id);
    node?.focus?.({ preventScroll: true }); node?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }
  function preserveDetail(action) {
    const samePlan = elements.detail.querySelector('[data-plan-key]')?.dataset.planKey === key(selected);
    const focused = mount.ownerDocument.activeElement, field = samePlan && elements.detail.contains?.(focused) ? focused : null;
    const fieldId = field?.id, start = field?.selectionStart, end = field?.selectionEnd;
    const panel = mount.querySelector('.next-panel'), top = panel?.scrollTop, viewport = elements.detail.querySelector('.next-plan-map-viewport');
    const left = viewport?.scrollLeft, mapTop = viewport?.scrollTop;
    action();
    const replacement = fieldId && find(fieldId);
    if (replacement) { replacement.focus?.({ preventScroll: true }); if (Number.isInteger(start) && Number.isInteger(end)) replacement.setSelectionRange?.(start, end); }
    const nextViewport = elements.detail.querySelector('.next-plan-map-viewport');
    if (nextViewport && samePlan) { if (Number.isFinite(left)) nextViewport.scrollLeft = left; if (Number.isFinite(mapTop)) nextViewport.scrollTop = mapTop; }
    if (panel && Number.isFinite(top)) panel.scrollTop = top;
  }
  function drawDetail({ retainFocus = false } = {}) { if (retainFocus) preserveDetail(() => detail(selected)); else detail(selected); }
  function renderToolbar(parent, plan, state, renderMap, { view, model } = {}) {
    const toolbar = el(parent, 'div', '', 'next-plan-toolbar'); toolbar.setAttribute('aria-label', 'Plan views');
    for (const [value, label] of [['map', 'Map'], ['outline', 'Outline']]) {
      const choice = button(toolbar, label, () => { state.presentation = value; drawDetail(); }, 'next-plan-' + value + '-view');
      choice.setAttribute('aria-pressed', String(state.presentation === value));
    }
    if (state.presentation === 'map') {
      const empty = view ? !view.nodes.length : !model.nodes.length;
      const zoom = amount => { state.mapZoom = planMapZoom(state.mapZoom + amount); state.fitted = true; renderMap(); };
      const minus = button(toolbar, '−', () => zoom(-0.2), 'next-plan-zoom-out'); minus.setAttribute('aria-label', 'Zoom out'); minus.disabled = empty;
      const output = el(toolbar, 'output', Math.round(state.mapZoom * 100) + '%'); output.id = 'next-plan-zoom'; output.setAttribute('aria-label', 'Map zoom');
      const plus = button(toolbar, '+', () => zoom(0.2), 'next-plan-zoom-in'); plus.setAttribute('aria-label', 'Zoom in'); plus.disabled = empty;
      const fit = button(toolbar, 'Fit', () => {
        const viewport = find('next-planning-map'), width = view ? taskPlanMap(view, { focusId: state.mapFocusId, collapsed: state.collapsed }).width : model.width;
        state.mapZoom = planMapZoom(Math.min(1, Math.max(260, viewport?.clientWidth || 720) / Math.max(1, width))); state.fitted = true; state.mapLeft = 0; state.mapTop = 0; renderMap(); if (viewport) { viewport.scrollLeft = 0; viewport.scrollTop = 0; }
      }, 'next-plan-fit'); fit.disabled = empty;
      if (view) {
        const node = view.byId.get(state.selectedId);
        const collapse = button(toolbar, state.collapsed.has(node?.id) ? 'Expand branch' : 'Collapse branch', () => {
          Object.assign(state, togglePlanBranch(view, state, state.selectedId)); drawDetail();
        }, 'next-plan-collapse'); collapse.disabled = !node?.isGroup;
        const focus = button(toolbar, state.mapFocusId ? 'Whole plan' : 'Focus branch', () => {
          state.mapFocusId = state.mapFocusId ? null : state.selectedId; state.fitted = false; delete state.mapLeft; delete state.mapTop; drawDetail();
        }, 'next-plan-focus'); focus.disabled = !state.mapFocusId && !node?.isGroup;
      }
    }
    return toolbar;
  }
  function conversationVisual(parent, plan, draft, editable) {
    const view = taskPlanView(draft.latest, { runStatus: plan.runStatus || '', settled: !plan.running }), state = sessionFor(plan);
    const previousFocus = state.mapFocusId;
    Object.assign(state, reconcilePlanMapSession(view, reconcilePlanSession(view, state)));
    if (previousFocus !== state.mapFocusId) { delete state.mapLeft; delete state.mapTop; state.fitted = false; }
    const visual = el(parent, 'div', '', 'next-plan-visual'), stage = el(visual, 'section', '', 'next-plan-surface');
    let viewport;
    const renderMap = () => {
      if (!viewport) return;
      viewport.innerHTML = renderTaskPlanMapSVG(view, state, { prefix: 'next-planning-map-svg' });
      const output = find('next-plan-zoom'); if (output) output.textContent = Math.round(state.mapZoom * 100) + '%';
    };
    renderToolbar(stage, plan, state, renderMap, { view });
    if (view.plan.branch) detailField(stage, 'Root conditions', planBranchText(view.plan.branch, id => view.byId.get(id)?.title || id));
    if (!view.nodes.length) el(stage, 'p', 'This saved plan has no steps yet. The shared goal remains available below.', 'next-empty');
    else {
      viewport = el(stage, 'div', '', state.presentation === 'map' ? 'next-plan-map-viewport' : 'next-plan-outline'); viewport.id = 'next-planning-map';
      if (state.presentation === 'map') {
        if (!state.fitted) { const map = taskPlanMap(view, { focusId: state.mapFocusId, collapsed: state.collapsed }); state.mapZoom = planMapFitZoom(map, viewport.clientWidth || 720); state.fitted = true; }
        renderMap(); restoreMapViewport(viewport, state, taskPlanMap(view, { focusId: state.mapFocusId, collapsed: state.collapsed }).byId.get(state.selectedId));
      } else {
        viewport.setAttribute('role', 'tree'); viewport.setAttribute('aria-label', 'Saved plan steps');
        for (const node of visiblePlanNodes(view, state.collapsed)) {
          const row = button(viewport, '', () => chooseStep(node.id)); row.className = 'next-plan-outline-step'; row.dataset.planOutlineStep = node.id; row.dataset.state = node.status;
          el(row, 'span', node.number, 'next-plan-outline-number'); el(row, 'span', node.title, 'next-plan-outline-title');
          row.setAttribute('role', 'treeitem'); row.setAttribute('aria-level', String(node.depth)); row.setAttribute('aria-posinset', String(node.position)); row.setAttribute('aria-setsize', String(node.siblingCount)); row.setAttribute('aria-selected', String(state.selectedId === node.id)); row.tabIndex = state.selectedId === node.id ? 0 : -1;
          row.setAttribute('aria-label', ['Step ' + node.number, node.title, node.branchRole, node.statusLabel].filter(Boolean).join('. '));
          if (view.focus?.id === node.id) row.setAttribute('aria-current', 'step');
          if (node.isGroup) row.setAttribute('aria-expanded', String(!state.collapsed.has(node.id)));
          row.style.setProperty?.('--next-plan-depth', String(node.depth - 1)); el(row, 'span', (node.branchRole ? node.branchRole + ' · ' : '') + node.statusLabel, 'next-help');
        }
      }
      function chooseStep(id) { Object.assign(state, selectPlanStep(view, state, id)); drawDetail(); focusStep(id); }
      viewport.addEventListener('click', event => { const target = event.target.closest?.('[data-plan-map-node]'); if (target) chooseStep(target.getAttribute('data-plan-map-node')); });
      viewport.addEventListener('keydown', event => {
        if (event.altKey || event.ctrlKey || event.metaKey) return;
        const target = event.target.closest?.('[data-plan-map-node],[data-plan-outline-step]');
        const id = target?.getAttribute('data-plan-map-node') || target?.getAttribute('data-plan-outline-step');
        if (id && id !== state.selectedId) Object.assign(state, selectPlanStep(view, state, id));
        if (event.key.toLowerCase() === 'f' && view.byId.get(state.selectedId)?.isGroup) { event.preventDefault(); state.mapFocusId = state.mapFocusId ? null : state.selectedId; state.fitted = false; delete state.mapLeft; delete state.mapTop; drawDetail(); focusStep(state.selectedId); return; }
        const result = planKeyboard(view, state, event.key); if (!result.handled) return;
        event.preventDefault(); Object.assign(state, result.session); drawDetail(); focusStep(state.selectedId);
      });
      el(stage, 'p', 'Select to inspect · Arrow keys move between steps · Dashed arrows show dependencies', 'next-plan-map-hint next-help');
    }
    const inspector = el(visual, 'aside', '', 'next-plan-inspector'); inspector.id = 'next-planning-inspector'; inspector.setAttribute('aria-label', 'Selected step');
    const node = view.byId.get(state.selectedId);
    if (!node) { el(inspector, 'p', 'Choose a saved step to inspect its work.', 'next-empty'); return; }
    inspector.dataset.selectedStepId = node.id;
    el(inspector, 'span', 'Step ' + node.number, 'next-plan-eyebrow'); el(inspector, 'h3', node.title); badge(inspector, node.statusLabel, node.availability?.state || node.status);
    if (node.isGroup) detailField(inspector, 'Structure', planKindLabel(node.kind));
    detailField(inspector, 'Readiness', node.availability?.reason); detailField(inspector, 'Done when', node.doneWhen); detailField(inspector, 'Expected result', node.result);
    detailField(inspector, 'Condition', node.condition); detailField(inspector, 'Evidence', node.evidence); detailField(inspector, 'Blocker', node.blockedReason); detailField(inspector, 'Skipped because', node.skipReason);
    for (const [label, value] of planLogicFields(view, node)) detailField(inspector, label, value);
    detailField(inspector, 'Path', node.branchRole);
    if (node.attempt > 1) detailField(inspector, 'Current attempt', String(node.attempt));
    const attempts = planAttemptHistory(node);
    if (attempts.length) {
      const history = el(inspector, 'details', '', 'next-plan-attempt-history'); history.dataset.stepId = node.id;
      el(history, 'summary', 'Previous attempts · ' + attempts.length + (node.pastAttemptsOmitted ? ' shown of ' + (attempts.length + node.pastAttemptsOmitted) : ''));
      el(history, 'p', 'Earlier work remains recorded. Returning to a step does not undo its effects.', 'next-help');
      for (const attempt of attempts) {
        const record = el(history, 'section', '', 'next-plan-attempt');
        el(record, 'h4', 'Attempt ' + (attempt.attempt || '?') + ' · ' + attempt.status);
        if (attempt.at) { const archived = el(record, 'p', 'Archived on '), when = el(archived, 'time', attempt.at); when.setAttribute('datetime', attempt.at); }
        detailField(record, 'Revisited because', attempt.reason);
        for (const [label, value] of attempt.fields) detailField(record, label, value);
      }
    }
    const prerequisites = node.availability?.prerequisites || node.dependsOn.map(id => ({ id, title: view.byId.get(id)?.title || id }));
    if (prerequisites.length) {
      const section = el(inspector, 'div', '', 'next-plan-detail-field'); el(section, 'h4', 'Prerequisites');
      for (const dependency of prerequisites) {
        const action = button(section, (dependency.satisfied ? '✓ ' : '') + dependency.title, () => { Object.assign(state, selectPlanStep(view, state, dependency.id)); drawDetail(); focusStep(dependency.id); });
        action.className = 'next-plan-dependency'; action.disabled = !view.byId.has(dependency.id);
      }
    }
    if (node.owner) detailField(inspector, 'Worker', node.owner.label || node.owner.nodeId);
    const noteLabel = el(inspector, 'label', 'Notes', 'next-label'), note = el(noteLabel, 'textarea', '', 'next-field');
    note.id = 'next-planning-note'; note.dataset.stepId = node.id; note.rows = 4; note.maxLength = 700; note.value = draft.notes.has(node.id) ? draft.notes.get(node.id) : node.note || ''; note.readOnly = !editable;
    note.addEventListener('input', () => { draft.notes.set(node.id, note.value); updateDraftControls(draft, editable); });
    if (editable) {
      const revisit = el(inspector, 'details', '', 'next-plan-revisit'); revisit.id = 'next-planning-revisit'; revisit.open = draft.revisit?.stepId === node.id;
      el(revisit, 'summary', 'Return to this step');
      el(revisit, 'p', 'Reopen this work and reassess affected later steps. Previous results stay in its history. Save the plan to apply the change.', 'next-help');
      const label = el(revisit, 'label', 'Why revisit this step?', 'next-label'), reason = el(label, 'textarea', '', 'next-field');
      reason.id = 'next-planning-revisit-reason'; reason.rows = 2; reason.maxLength = 1000; reason.value = draft.revisit?.stepId === node.id ? draft.revisit.reason : state.revisitReasons?.[node.id] || '';
      const queue = button(revisit, draft.revisit?.stepId === node.id ? 'Revisit included in draft' : 'Include revisit in plan changes', () => {
        if (pending) return;
        draft.revisit = { stepId: node.id, reason: reason.value }; draft.error = '';
        drawDetail({ retainFocus: true });
      }, 'next-planning-queue-revisit');
      queue.disabled = pending;
      reason.addEventListener('input', () => { state.revisitReasons ||= {}; state.revisitReasons[node.id] = reason.value; if (draft.revisit?.stepId === node.id) { draft.revisit.reason = reason.value; draft.error = ''; updateDraftControls(draft, editable); } });
      if (draft.revisit) {
        el(revisit, 'p', 'Queued return: ' + (view.byId.get(draft.revisit.stepId)?.title || draft.revisit.stepId), 'next-help');
        const cancel = button(revisit, 'Remove revisit from draft', () => { if (pending) return; draft.revisit = null; draft.error = ''; drawDetail({ retainFocus: true }); }, 'next-planning-cancel-revisit'); cancel.disabled = pending;
      }
    }
  }
  function projectDetail(parent, plan) {
    const model = projectVisualModel(plan), state = sessionFor(plan), byId = new Map((plan.tasks || []).map(task => [task.id, task]));
    if (!byId.has(state.selectedId)) state.selectedId = model.tracking.next.taskId || model.nodes[0]?.id || null;
    progress(parent, model.progress.completed, model.progress.total, (model.progress.completed || 0) + ' of ' + (model.progress.total || 0) + ' tasks passed review');
    const next = el(parent, 'div', '', 'next-plan-next-action'); el(next, 'strong', model.tracking.next.title); el(next, 'p', model.tracking.next.description, 'next-help');
    if (plan.archived) el(parent, 'p', 'Archived project plans keep their tasks and worker evidence. Restore the plan before running it.', 'next-help');
    const visual = el(parent, 'div', '', 'next-plan-visual'), stage = el(visual, 'section', '', 'next-plan-surface'); let viewport;
    const choose = id => { state.selectedId = id; drawDetail(); focusStep(id, true); };
    const renderMap = () => {
      const e = escapeHTML, nodes = new Map(model.nodes.map(node => [node.id, node]));
      const edges = model.edges.map(edge => { const a = nodes.get(edge.source), b = nodes.get(edge.target); return '<path class="next-plan-project-edge" d="M' + (a.x + a.width) + ',' + (a.y + a.height / 2) + ' C' + (a.x + a.width + 30) + ',' + (a.y + a.height / 2) + ' ' + (b.x - 30) + ',' + (b.y + b.height / 2) + ' ' + b.x + ',' + (b.y + b.height / 2) + '"><title>' + e(a.label + ' → ' + b.label) + '</title></path>'; }).join('');
      const shapes = model.nodes.map(node => '<g class="next-plan-project-node' + (state.selectedId === node.id ? ' is-selected' : '') + '" role="button" tabindex="' + (state.selectedId === node.id ? 0 : -1) + '" aria-pressed="' + (state.selectedId === node.id) + '" aria-label="' + e(node.label + '. ' + node.statusLabel) + '" data-plan-project-step="' + e(node.id) + '" data-state="' + e(node.status) + '" transform="translate(' + node.x + ' ' + node.y + ')"><rect width="' + node.width + '" height="' + node.height + '" rx="12"/><text x="14" y="25" class="next-plan-project-status">' + e(node.statusLabel) + '</text><text x="14" y="54" class="next-plan-project-title">' + e(node.label.length > 27 ? node.label.slice(0, 26) + '…' : node.label) + '</text><text x="14" y="82" class="next-plan-project-status">' + e(node.blockedBy.length ? node.blockedBy.length + ' prerequisite' + (node.blockedBy.length === 1 ? '' : 's') + ' remaining' : 'Step ' + ((plan.tasks || []).findIndex(task => task.id === node.id) + 1)) + '</text></g>').join('');
      viewport.innerHTML = '<svg class="next-plan-project-map" role="group" aria-label="Project tasks and dependencies" width="' + Math.round(model.width * state.mapZoom) + '" height="' + Math.round(model.height * state.mapZoom) + '" viewBox="0 0 ' + model.width + ' ' + model.height + '">' + edges + shapes + '</svg>';
      const output = find('next-plan-zoom'); if (output) output.textContent = Math.round(state.mapZoom * 100) + '%';
    };
    renderToolbar(stage, plan, state, renderMap, { model });
    viewport = el(stage, 'div', '', state.presentation === 'map' ? 'next-plan-map-viewport' : 'next-plan-outline'); viewport.id = 'next-planning-map';
    if (!model.nodes.length) el(viewport, 'p', 'No saved project tasks.', 'next-empty');
    else if (state.presentation === 'map') {
      if (!state.fitted) { state.mapZoom = planMapFitZoom(model, viewport.clientWidth || 720); state.fitted = true; } renderMap(); restoreMapViewport(viewport, state, model.nodes.find(node => node.id === state.selectedId));
    } else for (const node of model.nodes) { const row = button(viewport, node.label, () => {}); row.className = 'next-plan-outline-step'; row.dataset.planProjectStep = node.id; row.setAttribute('aria-pressed', String(state.selectedId === node.id)); row.tabIndex = state.selectedId === node.id ? 0 : -1; badge(row, node.statusLabel, node.status); }
    viewport.addEventListener('click', event => { const target = event.target.closest?.('[data-plan-project-step]'); if (target) choose(target.getAttribute('data-plan-project-step')); });
    viewport.addEventListener('keydown', event => {
      if (event.ctrlKey || event.metaKey || event.altKey) return; const index = model.nodes.findIndex(node => node.id === state.selectedId); let id;
      if (['ArrowRight', 'ArrowDown'].includes(event.key)) id = model.nodes[Math.min(model.nodes.length - 1, index + 1)]?.id;
      else if (['ArrowLeft', 'ArrowUp'].includes(event.key)) id = model.nodes[Math.max(0, index - 1)]?.id;
      else if (event.key === 'Home') id = model.nodes[0]?.id; else if (event.key === 'End') id = model.nodes.at(-1)?.id;
      else if (event.key === 'Enter' || event.key === ' ') id = state.selectedId;
      if (id) { event.preventDefault(); choose(id); }
    });
    el(stage, 'p', 'Dependencies unlock after review · Select a task to inspect its checks and run receipts', 'next-plan-map-hint next-help');
    const inspector = el(visual, 'aside', '', 'next-plan-inspector'); inspector.id = 'next-planning-inspector'; inspector.setAttribute('aria-label', 'Selected project task');
    const task = byId.get(state.selectedId), node = model.nodes.find(node => node.id === state.selectedId);
    if (task) {
      inspector.dataset.selectedStepId = task.id; el(inspector, 'h3', task.title); badge(inspector, node.statusLabel, node.status);
      detailField(inspector, 'Instructions', task.instructions); detailField(inspector, 'Inputs', task.inputs); detailField(inspector, 'Expected result', task.result); detailField(inspector, 'Acceptance checks', task.acceptanceCriteria); detailField(inspector, 'Needs attention', task.error);
      if (task.dependsOn?.length) { const deps = el(inspector, 'div', '', 'next-plan-detail-field'); el(deps, 'h4', 'Prerequisites'); for (const id of task.dependsOn) button(deps, byId.get(id)?.title || id, () => choose(id)).className = 'next-plan-dependency'; }
      const attempt = task.attempts?.at(-1);
      if (attempt) { detailField(inspector, 'Latest review', attempt.verification?.verdict?.summary); for (const [phase, label] of [['implementation', 'Open implementation'], ['verification', 'Open review']]) if (attempt[phase]?.runId) button(inspector, label, () => onNavigate?.('chat', { conversationId: attempt[phase].runId })); }
    } else el(inspector, 'p', 'Select a task to inspect its saved work.', 'next-empty');
    if (plan.dueDate || model.milestones.length) {
      const milestones = el(parent, 'section', '', 'next-plan-milestones'); milestones.setAttribute('aria-label', 'Project milestones'); el(milestones, 'h3', 'Milestones');
      if (plan.dueDate) el(milestones, 'p', 'Project due ' + plan.dueDate, 'next-help');
      const path = el(milestones, 'div', '', 'next-plan-milestone-path');
      for (const milestone of model.milestones) { const card = el(path, 'article', '', 'next-plan-milestone'); card.dataset.state = milestone.status; el(card, 'h4', milestone.title); badge(card, milestone.status, milestone.status); if (milestone.dueDate) el(card, 'time', milestone.dueDate).setAttribute('datetime', milestone.dueDate); el(card, 'p', milestone.taskIds.length ? milestone.completed + ' of ' + milestone.total + ' tasks reviewed' : 'Manual milestone', 'next-help'); if (milestone.overdue) el(card, 'span', 'Overdue', 'next-help'); }
    }
  }
  function updateDraftControls(draft, editable) {
    const conflict = draft.latest.revision !== draft.base.revision, save = find('next-planning-save'), discard = find('next-planning-discard');
    if (save) save.disabled = pending || !editable || conflict || !planningDraftDirty(draft);
    if (discard) discard.disabled = pending || !planningDraftDirty(draft) && !draft.detachedNotes.length;
    const receipt = find('next-planning-receipt');
    if (receipt) receipt.textContent = draft.error || (!editable ? 'Restore this conversation to edit its plan.' : conflict && planningDraftDirty(draft) ? 'The saved plan changed. Your draft is preserved.' : planningDraftDirty(draft) ? 'Unsaved changes are kept while switching views.' : 'Selection only inspects work. Save applies your notes to the shared plan.');
  }
  function detail(plan) {
    const previous = elements.detail.querySelector('[data-plan-key]'), previousViewport = elements.detail.querySelector('.next-plan-map-viewport'), previousSession = sessions.get(previous?.dataset.planKey);
    if (previousViewport && previousSession && (previousViewport.dataset.mapFocus || '') === (previousSession.mapFocusId || '')) { previousSession.mapLeft = previousViewport.scrollLeft || 0; previousSession.mapTop = previousViewport.scrollTop || 0; }
    mapController?.destroy?.(); mapController = null;
    elements.detail.replaceChildren(); if (destroyed) return;
    if (!plan) {
      mountIntelligenceMap({
        parent: elements.detail, source: intelligenceStarterText({ cwd: getStatus()?.cwd || '' }),
        onEdit: () => void showComposer()
      });
      const heading = elements.detail.querySelector('.next-intel-map-head h2');
      if (heading) heading.textContent = 'Illustrative intelligence map';
      const hint = elements.detail.querySelector('.next-intel-map-head p');
      if (hint) hint.textContent = 'Draft example — not findings. LLMs edit the structured source; BLACKICE turns its explicit entities and links into this map.';
      return;
    }
    const box = el(elements.detail, 'section', '', 'next-plan-detail'); box.dataset.planId = plan.taskId || plan.id; box.dataset.planKey = key(plan);
    const header = el(box, 'header', '', 'next-plan-detail-header'), heading = el(header, 'div'); el(heading, 'span', isIntelligenceProject(plan) ? 'Intelligence assessment' : plan.kind === 'project' ? 'Project plan' : 'Agent working plan', 'next-plan-eyebrow'); el(heading, 'h2', title(plan));
    const management = el(header, 'div', '', 'next-plan-management'); planActions(management, plan);
    if (plan.kind === 'project') {
      if (isIntelligenceProject(plan)) {
        const map = el(box, 'div', '', 'next-intel-embedded');
        mountIntelligenceMap({ parent: map, source: intelligenceTextFromProject(plan), project: plan, onEdit: () => void showComposer(plan) });
        // Keep execution and reviewer receipts available, but separate them
        // from the analytical argument represented by the text-driven map.
        const execution = el(box, 'details', '', 'next-intel-execution-details');
        el(execution, 'summary', 'Agent execution plan and verification');
        const executionBody = el(execution, 'div', '', 'next-intel-execution-body');
        execution.addEventListener('toggle', () => {
          if (execution.open && !executionBody.childNodes.length) projectDetail(executionBody, plan);
        });
        return;
      }
      projectDetail(box, plan);
      return;
    }
    const full = fullPlan(plan);
    if (readingDetail) el(box, 'p', 'Loading saved steps…', 'next-help');
    if (detailError) { const message = el(box, 'p', detailError, 'next-help'); message.setAttribute('role', 'alert'); button(box, 'Retry loading plan', () => void select(plan, { force: true })); }
    if (!full) return;
    const draft = draftFor(full), editable = plan.bucket !== 'deleted' && plan.editable !== false && !detailError && Number.isSafeInteger(draft.base.revision), state = sessionFor(plan);
    const savedProgress = draft.latest.progress || taskPlanView(draft.latest).progress;
    progress(box, savedProgress.done || 0, savedProgress.total || 0, (savedProgress.done || 0) + ' of ' + (savedProgress.total || 0) + ' planned steps done');
    recordedOntology(box, draft.latest, state);
    // Decision policies are first-class saved Planning metadata, not implicit
    // exclusions inferred from a job posting's use of the word "required".
    const criteriaPanel=el(box,'details','','next-plan-criteria');
    criteriaPanel.id='next-planning-decision-criteria';
    const savedCriteria=draft.latest.plan?.decisionCriteria||[];
    el(criteriaPanel,'summary','Decision criteria · '+savedCriteria.length+' classified');
    el(criteriaPanel,'p','Classify what actually constrains a decision: real gates, material barriers, manageable gaps, external claims, preferences and unknowns. Wording such as required is evidence of a claim, not proof of an unavoidable gate. Older job-specific kinds remain supported.','next-help');
    const policyRows=el(criteriaPanel,'div','','next-plan-criteria-rows');
    const kinds=[
      ['hard_gate','Verified hard gate'],['material_barrier','Material barrier / costly gap'],
      ['adaptable_gap','Adaptable / manageable gap'],['stated_requirement','Stated requirement / claim'],
      ['preference','Preference / tradeoff'],['unverified','Unknown / unverified'],
      ['substantial_skill','Substantial skill (legacy)'],['trainable_skill','Trainable skill (legacy)'],
      ['employer_wishlist','Employer wish list (legacy)']
    ];
    const sources=[['user','User'],['external','External source / stakeholder'],['analyst','Analyst inference'],['employer','Employer (legacy)']];
    const evidenceStates=[['','Not classified'],['confirmed','Confirmed'],['reported','Reported by source'],['inferred','Inferred'],['unknown','Unknown'],['contradicted','Contradicted']];
    let policySerial=0;
    const createSelect=(parent,name,options,value)=>{
      const control=el(parent,'select','','next-field');control.setAttribute('name',name);
      for(const [id,title] of options){const option=el(control,'option',title);option.value=id;}
      control.value=value;return control;
    };
    const createPolicyRow=(criterion={})=>{
      const row=el(policyRows,'div','','next-plan-criterion-row');
      row.dataset.criterionId=criterion.id||'decision-'+(++policySerial);
      const name=el(row,'label','Criterion','next-label');
      const label=el(name,'input','','next-field');label.setAttribute('name','label');
      label.maxLength=180;label.value=criterion.label||'';label.readOnly=!editable;
      const kindLabel=el(row,'label','Classification','next-label');
      const kind=createSelect(kindLabel,'kind',kinds,criterion.kind||'preference');kind.disabled=!editable;
      const sourceLabel=el(row,'label','Origin','next-label');
      const source=createSelect(sourceLabel,'source',sources,criterion.source||'user');source.disabled=!editable;
      const evidenceLabel=el(row,'label','Evidence status','next-label');
      const evidence=createSelect(evidenceLabel,'evidenceStatus',evidenceStates,criterion.evidenceStatus||'');evidence.disabled=!editable;
      const priorityLabel=el(row,'label','Priority (1–5)','next-label');
      const priority=el(priorityLabel,'input','','next-field');priority.setAttribute('name','priority');priority.type='number';priority.min=1;priority.max=5;priority.value=String(criterion.priority??3);priority.readOnly=!editable;
      const basisLabel=el(row,'label','Why this classification applies','next-label');
      const basis=el(basisLabel,'textarea','','next-field');basis.setAttribute('name','basis');basis.rows=2;
      basis.maxLength=700;basis.value=criterion.basis||'';basis.readOnly=!editable;
      const mandatory=el(row,'label','','next-label');
      const checked=el(mandatory,'input');checked.type='checkbox';checked.setAttribute('name','verifiedNonNegotiable');
      checked.checked=criterion.verifiedNonNegotiable===true;checked.disabled=!editable;
      el(mandatory,'span','External non-negotiability verified beyond the claimed wording');
      const toggle=()=>{mandatory.hidden=kind.value!=='hard_gate'||!['external','employer'].includes(source.value);};
      kind.addEventListener('change',toggle);source.addEventListener('change',toggle);toggle();
      if(editable)button(row,'Remove criterion',()=>{row.remove();policyFeedback.textContent='Criterion removed from this draft. Save to persist.';});
      return row;
    };
    const policyActions=el(criteriaPanel,'div','','next-row');
    const policyFeedback=el(criteriaPanel,'p','','next-help');policyFeedback.setAttribute('role','status');
    for(const criterion of savedCriteria)createPolicyRow(criterion);
    if(editable){
      button(policyActions,'Add criterion',()=>{createPolicyRow();criteriaPanel.open=true;});
      button(policyActions,'Save criteria',async()=>{
        if(pending||draft.base.revision!==draft.latest.revision){
          policyFeedback.textContent='Refresh this plan before editing a changed revision.';return;
        }
        if(planningDraftDirty(draft)){
          policyFeedback.textContent='Save the other plan changes first, then save the criteria.';return;
        }
        const values=[...policyRows.children].map(row=>{
          const field=name=>row.querySelector('[name='+name+']');
          const value={
            id:row.dataset.criterionId,label:field('label').value,
            kind:field('kind').value,source:field('source').value,
            basis:field('basis').value,priority:Number(field('priority').value)
          };
          if(value.kind==='hard_gate'&&['external','employer'].includes(value.source))
            value.verifiedNonNegotiable=field('verifiedNonNegotiable').checked;
          if(field('evidenceStatus').value)value.evidenceStatus=field('evidenceStatus').value;
          return value;
        });
        pending=true;policyFeedback.textContent='Saving decision criteria…';
        try{
          const updated=await api('/api/tasks/'+encodeURIComponent(plan.taskId)+'/plan/edit','POST',{
            expectedRevision:draft.base.revision,
            operations:[{type:'metadata',patch:{decisionCriteria:values}}]
          });
          if(updated.taskId!==plan.taskId||!Array.isArray(updated.steps))throw Error('The saved criterion update could not be verified.');
          documents.set(plan.taskId,updated);
          drafts.set(key(plan),createPlanningDraft(updated));
          items=items.map(item=>key(item)===key(plan)?{...item,...updated,kind:'conversation',bucket:item.bucket,editable:item.editable}:item);
          if(key(selected)===key(plan))selected={...selected,...updated,kind:'conversation',bucket:selected.bucket,editable:selected.editable};
          notify('Decision criteria saved.');
        }catch(cause){policyFeedback.textContent=cause.message;notify(cause.message,true);}
        finally{pending=false;if(active)drawDetail({retainFocus:true});}
      });
    }
    // Compact optional judgment frame for general decisions, debugging,
    // research, design and recurring work. Nothing here creates a gate or task.
    const framePanel=el(box,'details','','next-plan-metacognition');
    framePanel.id='next-planning-metacognition';
    const savedFrame=draft.latest.plan?.metacognition||{};
    el(framePanel,'summary','Practical judgment · '+Object.keys(savedFrame).length+' notes');
    el(framePanel,'p','Use only what materially improves the decision. Missing information is not negative evidence, and another check is not automatically more useful than acting.','next-help');
    const frameControls=new Map(),frameFields=[["outcome","Useful outcome","What would actually make this work valuable?"],["keyUncertainty","Decision-changing uncertainty","Which assumption matters enough to change the approach?"],["nextProbe","Cheapest useful check","What small test would clarify or falsify that assumption?"],["goodEnough","Good enough","What result would be sufficiently useful, without demanding perfection?"],["reassessWhen","Stop or reassess when","What observation or cost means stop, switch method or seek more evidence?"],["observation","What happened","What did we observe versus expect? What remains unverified?"],["lesson","Transferable correction","What change would prevent a repeat, without overgeneralizing?"]];
    for(const [field,title,hint] of frameFields){
      const fieldLabel=el(framePanel,'label',title,'next-label');
      const control=el(fieldLabel,'textarea','','next-field');
      control.dataset.judgmentField=field;control.rows=2;control.maxLength=700;
      control.placeholder=hint;control.value=savedFrame[field]||'';control.readOnly=!editable;
      frameControls.set(field,control);
    }
    const frameFeedback=el(framePanel,'p','','next-help');frameFeedback.setAttribute('role','status');
    if(editable)button(framePanel,'Save judgment frame',async()=>{
      if(pending||draft.base.revision!==draft.latest.revision){
        frameFeedback.textContent='Refresh this plan before saving changed criteria.';return;
      }
      if(planningDraftDirty(draft)){
        frameFeedback.textContent='Save other plan edits first, then save the judgment frame.';return;
      }
      const frame={};
      for(const [field,control] of frameControls){const value=control.value.trim();if(value)frame[field]=value;}
      if(JSON.stringify(frame)===JSON.stringify(savedFrame)){
        frameFeedback.textContent='No judgment changes to save.';return;
      }
      pending=true;frameFeedback.textContent='Saving judgment frame…';
      try{
        const updated=await api('/api/tasks/'+encodeURIComponent(plan.taskId)+'/plan/edit','POST',{
          expectedRevision:draft.base.revision,
          operations:[{type:'metadata',patch:{metacognition:Object.keys(frame).length?frame:null}}]
        });
        if(updated.taskId!==plan.taskId||!Array.isArray(updated.steps))
          throw Error('The saved judgment frame could not be verified.');
        documents.set(plan.taskId,updated);
        drafts.set(key(plan),createPlanningDraft(updated));
        items=items.map(item=>key(item)===key(plan)?{...item,...updated,kind:'conversation',bucket:item.bucket,editable:item.editable}:item);
        if(key(selected)===key(plan))selected={...selected,...updated,kind:'conversation',bucket:selected.bucket,editable:selected.editable};
        notify('Judgment frame saved.');
      }catch(cause){frameFeedback.textContent=cause.message;notify(cause.message,true);}
      finally{pending=false;if(active)drawDetail({retainFocus:true});}
    });
    const techniqueTimeline = renderRecordedAnalyticPasses(box, draft.latest, { onSelect: id => {
      Object.assign(state, selectPlanStep(taskPlanView(draft.latest), state, id));
      drawDetail(); focusStep(id);
    } });
    if (techniqueTimeline) {
      techniqueTimeline.open = Boolean(state.techniqueTimelineOpen);
      techniqueTimeline.addEventListener('toggle', () => { state.techniqueTimelineOpen = techniqueTimeline.open; });
    }
    const form = el(box, 'form', '', 'next-plan-edit'); form.id = 'next-planning-edit';
    conversationVisual(form, plan, draft, editable);
    const goalDisclosure = el(form, 'details', '', 'next-plan-goal-disclosure'); goalDisclosure.id = 'next-planning-goal-disclosure'; goalDisclosure.open = state.goalOpen; el(goalDisclosure, 'summary', 'Shared goal');
    goalDisclosure.addEventListener('toggle', () => { state.goalOpen = goalDisclosure.open; });
    const label = el(goalDisclosure, 'label', 'Goal', 'next-label'), goal = el(label, 'textarea', '', 'next-field'); goal.id = 'next-planning-goal'; goal.rows = 2; goal.maxLength = 2000; goal.value = draft.goal; goal.readOnly = !editable;
    goal.addEventListener('input', () => { draft.goal = goal.value; updateDraftControls(draft, editable); });
    const actions = el(form, 'div', '', 'next-plan-save-actions next-row'), save = el(actions, 'button', 'Save plan changes', 'next-primary'); save.type = 'submit'; save.id = 'next-planning-save';
    button(actions, 'Discard changes', () => { if (pending) return; drafts.set(key(plan), createPlanningDraft(draft.latest)); drawDetail(); }, 'next-planning-discard');
    button(actions, 'Open conversation', () => onNavigate?.('chat', { conversationId: plan.taskId }));
    const receipt = el(form, 'p', '', 'next-help'); receipt.id = 'next-planning-receipt'; receipt.setAttribute('role', 'status');
    if (draft.latest.revision !== draft.base.revision && planningDraftDirty(draft)) {
      const conflict = el(form, 'div', '', 'next-plan-conflict'); el(conflict, 'p', 'The saved plan changed. Your draft is preserved. Review the saved version before saving again.', 'next-help');
      button(conflict, 'Use saved version', () => { if (pending) return; drafts.set(key(plan), createPlanningDraft(draft.latest)); drawDetail(); });
      button(conflict, 'Keep draft against latest version', () => { if (pending) return; Object.assign(draft, rebasePlanningDraft(draft)); drawDetail(); });
    }
    if (draft.detachedNotes.length) { const detached = el(form, 'details', '', 'next-plan-detached-notes'); el(detached, 'summary', 'Retained notes for removed steps (' + draft.detachedNotes.length + ')'); for (const note of draft.detachedNotes) detailField(detached, note.title, note.note); el(detached, 'p', 'These local notes are retained for reference and are not sent as edits to removed steps.', 'next-help'); }
    updateDraftControls(draft, editable);
    form.addEventListener('submit', async event => {
      event.preventDefault(); if (!active || !editable || pending || draft.latest.revision !== draft.base.revision) return;
      let operations;
      try { operations = planningDraftOperations(draft); } catch (cause) { draft.error = cause.message; updateDraftControls(draft, editable); return; }
      if (!operations.length) { receipt.textContent = 'No changes to save.'; return; }
      const submitted = { goal: draft.goal, notes: new Map(draft.notes), revisit: draft.revisit ? { ...draft.revisit } : null }; pending = true; generation++; updateDraftControls(draft, editable); receipt.textContent = 'Saving…'; paint();
      try {
        const saved = await api('/api/tasks/' + encodeURIComponent(plan.taskId) + '/plan/edit', 'POST', { expectedRevision: draft.base.revision, operations });
        if (!Array.isArray(saved?.steps) || saved.taskId !== plan.taskId) throw Error('The save receipt did not contain this plan. Refresh to inspect its saved state.');
        Object.assign(draft, commitPlanningDraft(draft, saved, submitted));
        if (!documents.has(plan.taskId) || documents.get(plan.taskId).revision <= saved.revision) documents.set(plan.taskId, saved);
        items = items.map(item => key(item) === key(plan) ? { ...item, ...saved, kind: 'conversation', bucket: item.bucket, editable: item.editable } : item);
        if (key(selected) === key(plan)) selected = { ...selected, ...saved, kind: 'conversation', bucket: selected.bucket, editable: selected.editable };
        notify('Plan updated.');
      } catch (cause) { draft.error = cause.message; notify(cause.message, true); }
      finally { pending = false; if (active) { paint(); drawDetail({ retainFocus: true }); } }
    });
  }
  function paint() {
    elements.list.replaceChildren(); if (!items.length) el(elements.list, 'p', elements.type.value === 'analysis' ? 'No intelligence assessments yet. Start with a priority intelligence question.' : 'No matching plans in this view.', 'next-empty');
    for (const item of items) {
      const card = el(elements.list, 'article', '', 'next-planning-plan-card' + (key(selected) === key(item) ? ' is-selected' : '')); card.dataset.planId = item.taskId || item.id;
      el(card, 'h3', title(item));
      if (isIntelligenceProject(item)) el(card, 'p', intelligenceProjectDraft(item).question || 'Priority intelligence question not defined', 'next-intel-catalog-question');
      const row = el(card, 'div', '', 'next-planning-plan-meta'); badge(row, item.runStatus || item.status || 'saved', item.runStatus || item.status || 'saved');
      const p = item.kind === 'project' ? item.summary?.progress : item.progress;
      if (p?.total) el(row, 'span', String(p.done ?? p.completed ?? 0) + '/' + p.total + (item.kind === 'project' ? ' reviewed' : ' steps'), 'next-help');
      const actions = el(card, 'div', '', 'next-planning-plan-actions'); const open = button(actions, 'Open plan', () => void select(item)); open.setAttribute('aria-current', String(key(selected) === key(item)));
      const management = el(actions, 'details', '', 'next-planning-plan-menu'); el(management, 'summary', 'Manage'); planActions(management, item);
    }
    elements.more.hidden = nextOffset == null; elements.more.disabled = pending;
    elements.info.textContent = error || items.length + ' visible plans' + (nextOffset != null ? ' · more available' : '');
  }
  async function select(plan, { force = false } = {}) {
    if (!active || destroyed) return;
    composing = false;
    if (key(selected) !== key(plan)) releaseCleanSelection(); abortDetail(); selected = plan; detailError = ''; paint();
    if (plan.kind === 'project') { detail(plan); return; }
    const cached = documents.get(plan.taskId);
    if (!force && cached?.revision >= plan.revision) { detail(plan); return; }
    const token = detailGeneration, selectedKey = key(plan); detailController = new AbortController(); readingDetail = true; drawDetail({ retainFocus: true });
    try {
      const saved = await api('/api/tasks/' + encodeURIComponent(plan.taskId), 'GET', undefined, { signal: detailController.signal });
      if (!active || token !== detailGeneration || selectedKey !== key(selected)) return;
      if (!Array.isArray(saved?.steps) || saved.taskId !== plan.taskId || !Number.isSafeInteger(saved.revision)) throw Error('The saved plan could not be read. Refresh to retry.');
      if (saved.revision < (documents.get(plan.taskId)?.revision || 0) || saved.revision < plan.revision) throw Error('A newer plan revision is available. Refresh to read it before editing.');
      documents.set(plan.taskId, saved); const draft = drafts.get(selectedKey); if (draft) Object.assign(draft, acceptPlanningSnapshot(draft, { ...selected, ...saved }));
    } catch (cause) { if (active && token === detailGeneration && cause.name !== 'AbortError') detailError = cause.message; }
    finally { if (active && token === detailGeneration && selectedKey === key(selected)) { readingDetail = false; detailController = null; drawDetail({ retainFocus: true }); } }
  }
  async function load({ more = false } = {}) {
    if (!active || destroyed) return;
    const token = ++generation, type = elements.type.value, state = elements.state.value, query = elements.query.value;
    try {
      const data = type !== 'conversation' ? await api('/api/projects') : await api('/api/planning?' + new URLSearchParams({ state, query, limit: '40', offset: String(more ? nextOffset || 0 : 0) }));
      if (!active || token !== generation) return;
      if (type !== 'conversation') { items = (Array.isArray(data?.projects) ? data.projects : []).filter(plan => (plan.archived === true) === (state === 'archived') && (type === 'analysis' ? isIntelligenceProject(plan) : !isIntelligenceProject(plan)) && String(plan.name || plan.title || '').toLowerCase().includes(query.toLowerCase())).map(plan => ({ ...plan, kind: 'project' })); nextOffset = null; }
      else { const values = (Array.isArray(data?.plans) ? data.plans : []).map(plan => ({ ...plan, kind: 'conversation' })); items = more ? [...items, ...values.filter(value => !items.some(item => key(item) === key(value)))] : values; nextOffset = Number.isSafeInteger(data.nextOffset) ? data.nextOffset : null; }
      error = data.healthy === false ? 'Some saved plans could not be read. Available plans are shown.' : ''; paint();
      if (composing || more) return;
      const selectedKey = key(selected); let match = items.find(item => key(item) === selectedKey);
      if (!match && selected?.kind === 'conversation' && drafts.has(selectedKey) && (planningDraftDirty(drafts.get(selectedKey)) || drafts.get(selectedKey).detachedNotes.length)) {
        const exact = { taskId: selected.taskId, limit: '1', offset: '0' }, results = await Promise.all(['all', 'deleted'].map(state => api('/api/planning?' + new URLSearchParams({ ...exact, state }))));
        if (!active || token !== generation || selectedKey !== key(selected)) return;
        const found = results.flatMap(result => result.plans || []).find(item => item.taskId === selected.taskId); if (found) match = { ...found, kind: 'conversation' };
        else { selected = { ...selected, editable: false }; detailError = 'The saved plan is unavailable. Your draft is retained.'; drawDetail({ retainFocus: true }); return; }
      }
      if (match) await select(match, { force: match.kind === 'conversation' });
      else if (items[0]) await select(items[0]); else { releaseCleanSelection(); abortDetail(); selected = null; detail(null); }
    } catch (cause) { if (active && token === generation) { error = cause.message; paint(); notify(cause.message, true); } }
  }
  async function lifecycle(plan, action) {
    if (!active || pending) return;
    pending = true; generation++; abortDetail(); error = ''; paint();
    try {
      if (plan.kind === 'project') await api('/api/planning/organization', 'POST', { expectedRevision: plan.organizationRevision, operations: [{ type: 'update_project', projectId: plan.id, archived: action === 'archive' }] });
      else {
        const result = await changeTaskState(api, [plan], action); if (result.failed.length) throw Error(result.failed[0].error);
        const bucket = action === 'restore' ? 'active' : action === 'archive' ? 'archived' : 'deleted';
        if (key(selected) === key(plan)) selected = { ...selected, bucket, editable: bucket !== 'deleted' };
      }
      notify(action === 'archive' ? 'Plan archived.' : action === 'restore' ? 'Plan restored.' : 'Conversation and its plan moved to Trash.');
      if (active) await load();
    } catch (cause) { error = cause.message; notify(cause.message, true); }
    finally { pending = false; if (active) { paint(); drawDetail({ retainFocus: true }); } }
  }
  function reset() { generation++; releaseCleanSelection(); abortDetail(); selected = null; items = []; nextOffset = null; detailError = ''; error = ''; paint(); detail(null); void load(); }
  elements.type.addEventListener('change', () => { composing = false; const trash = [...elements.state.children].find(option => option.value === 'deleted'); if (trash) trash.disabled = elements.type.value !== 'conversation'; if (elements.type.value !== 'conversation' && elements.state.value === 'deleted') elements.state.value = 'active'; reset(); });
  elements.state.addEventListener('change', reset);
  elements.query.addEventListener('input', () => { generation++; abortDetail(); clearTimeout(timer); timer = setTimeout(reset, 240); });
  elements.refresh.addEventListener('click', () => void load()); elements.more.addEventListener('click', () => void load({ more: true }));
  elements.create.addEventListener('click', () => void showComposer());
  return {
    enter() { if (active || destroyed) return; active = true; unsubscribe = events.subscribe(event => { if (!active || !['planning.updated', 'projects.updated', 'conversations.updated', 'conversations.changed'].includes(event.type)) return; clearTimeout(timer); timer = setTimeout(() => void load(), 600); }); void load(); },
    leave() { active = false; generation++; abortDetail(); unsubscribe?.(); unsubscribe = null; clearTimeout(timer); },
    destroy() { this.leave(); destroyed = true; mapController?.destroy?.(); mapController = null; drafts.clear(); documents.clear(); sessions.clear(); mount.innerHTML = ''; },
  };
}
