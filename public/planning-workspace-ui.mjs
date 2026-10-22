import { initTaskPlanUI } from './task-plan-ui.mjs';
import { taskPlanView, planKindLabel } from './task-plan-model.mjs';
import { createPlanningWorkspaceController, planningDraftDiff, planningCatalogOutline } from './planning-workspace-model.mjs';
import { planningAwarenessView } from './planning-awareness.mjs';
import { coordinationNavigation } from './coordination-navigation.mjs';

const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const labels = { goal: 'Objective', layout: 'Structure', detail: 'Detail', title: 'Title', doneWhen: 'Done when', result: 'Expected result', note: 'Note', condition: 'Condition', status: 'Reported status', evidence: 'Evidence', blockedReason: 'Blocker', skipReason: 'Why skipped', parentId: 'Parent branch', beforeId: 'Position', dependsOn: 'Dependencies', selectedChildId: 'Chosen path', kind: 'Structure', children: 'Child steps' };
const action = (name, text, extra = '') => `<button type="button" data-planning-action="${name}" ${extra}>${escape(text)}</button>`;
const glyph = '<svg viewBox="0 0 24 24" width="23" height="23" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="m12 2 8 4v12l-8 4-8-4V6Z"/><path d="M8 8h3v8m0-5h5m-5 5h5m-2-7 2 2-2 2m0 1 2 2-2 2"/></svg>';

export function installPlanningWorkspaceStyles() {
  if (typeof document === 'undefined' || document.getElementById('blackice-planning-styles')) return;
  const link = document.createElement('link'); link.id = 'blackice-planning-styles'; link.rel = 'stylesheet'; link.href = '/planning-workspace.css'; document.head.append(link);
}

function option(value, label, selected, extra = '') { return `<option value="${escape(value)}"${value === selected ? ' selected' : ''} ${extra}>${escape(label)}</option>`; }
function textField(key, label, value, { max = 1000, rows = 2, required = false, input = false, extra = '' } = {}) {
  return `<label class="planning-field"><span>${escape(label)}</span>${input ? `<input data-planning-field="${key}" maxlength="${max}" value="${escape(value)}"${required ? ' required' : ''} ${extra}>` : `<textarea data-planning-field="${key}" rows="${rows}" maxlength="${max}"${required ? ' required' : ''} ${extra}>${escape(value)}</textarea>`}</label>`;
}
const selectField = (key, label, options, extra = '') => `<label class="planning-field"><span>${escape(label)}</span><select data-planning-field="${key}" ${extra}>${options}</select></label>`;

export function renderPlanningAwareness(task, draft, state, { now = Date.now() } = {}) {
  if (!task || !draft || !state) return '';
  const stepId = draft.mode === 'add' ? draft.values.parentId || null : draft.stepId;
  const view = planningAwarenessView(state.snapshot, { task, stepId, editorId: state.editorId, now });
  const editors = view.presence.map(item => item.mine ? 'You' : item.label);
  if (state.editing && state.advertised && !view.presence.some(item => item.mine)) editors.unshift('You');
  const editing = editors.length ? `<p class="planning-presence" role="status"><span class="planning-presence-dot" aria-hidden="true"></span><span><strong>${escape(editors.slice(0, 3).join(', '))}${editors.length > 3 ? ` +${editors.length - 3}` : ''}</strong> ${editors.length === 1 && editors[0] !== 'You' ? 'is' : 'are'} editing${stepId ? ' this step' : ' the plan'}<small>Draft changes are shared when saved.</small></span></p>` : '';
  let receipts = '';
  if (view.workers.length) {
    const summary = view.pending.length ? `${view.pending.length} ${view.pending.length === 1 ? 'agent needs' : 'agents need'} review` : `Read status for ${view.workers.length} ${view.workers.length === 1 ? 'agent' : 'agents'}`;
    receipts = `<details class="planning-awareness-receipts" data-planning-disclosure="awareness"><summary>${escape(summary)}</summary><ul>${view.workers.slice(0, 12).map(worker => {
      const pending = view.pending.some(item => item.id === worker.id), read = worker.lastReadRevision == null ? 'No plan read recorded' : `Read revision ${worker.lastReadRevision}`;
      return `<li data-planning-worker="${escape(worker.id)}" data-awareness-state="${escape(pending ? 'needs-review' : worker.state)}"><strong>${escape(worker.label)}</strong><span>${pending ? `<em>Needs revision ${escape(worker.pendingRevision ?? view.revision)}</em> · ` : ''}${escape(read)}${worker.state === 'finished' ? ' · Finished' : ''}</span></li>`;
    }).join('')}</ul>${view.workers.length > 12 ? `<p>${view.workers.length - 12} more agents are recorded for this scope.</p>` : ''}<p>Receipts record delivery of the saved plan.${view.pending.length ? ' Saved corrections must be read before the next affected action; an action already underway can finish.' : ''}</p></details>`;
  }
  const error = state.error ? `<p class="planning-awareness-error" role="status">${escape(state.error)}</p>` : '';
  return editing || receipts || error ? `<section class="planning-awareness" aria-label="Shared editing">${editing}${receipts}${error}</section>` : '';
}

export function renderPlanningEditor(task, draft, { editable = true } = {}) {
  if (!task || !draft) return '<p class="planning-empty-note">Choose a saved plan to inspect its objective and steps.</p>';
  const value = draft.values, adding = draft.mode === 'add', step = task.steps.find(item => item.id === draft.stepId), view = taskPlanView(task), nodes = view.nodes;
  const disabled = editable ? '' : ' disabled';
  const structure = (selected, canChange = true, leaf = false) => ['action', 'sequence', 'parallel', 'choice'].filter(kind => adding || kind !== 'action' || leaf).map(kind => option(kind, planKindLabel(kind), selected, !canChange && kind !== selected ? 'disabled' : '')).join('');
  let fields;
  if (!draft.stepId) {
    fields = textField('goal', 'Task objective', value.goal, { max: 12000, rows: 5, required: true }) + `<div class="planning-two-fields">${selectField('layout', 'Root structure', ['sequence', 'parallel', 'choice'].map(kind => option(kind, planKindLabel(kind), value.layout)).join(''))}${selectField('detail', 'Plan detail', ['compact', 'balanced', 'detailed'].map(kind => option(kind, kind[0].toUpperCase() + kind.slice(1), value.detail)).join(''))}</div>`;
    if (value.layout === 'choice') fields += selectField('selectedChildId', 'Chosen path', option('', 'No path chosen', value.selectedChildId) + view.roots.map(item => option(item.id, item.title, value.selectedChildId)).join(''));
    fields += '<p class="planning-field-help">The agent reads this same saved objective and structure. Each action has an observable done criterion.</p>';
  } else {
    const descendants = new Set(); const collect = id => { for (const node of nodes.filter(node => node.parentId === id)) { descendants.add(node.id); collect(node.id); } }; if (!adding) collect(draft.stepId);
    const parents = nodes.filter(node => node.isGroup && node.id !== draft.stepId && !descendants.has(node.id));
    const siblings = nodes.filter(node => (node.parentId || '') === value.parentId && node.id !== draft.stepId && !descendants.has(node.id));
    const parent = view.byId.get(value.parentId), children = nodes.filter(node => node.parentId === draft.stepId);
    fields = textField('title', adding ? 'New step title' : 'Step title', value.title, { max: 300, input: true, required: true });
    if (adding || children.length) fields += selectField('kind', 'Structure', structure(value.kind, true, !children.length));
    fields += textField('doneWhen', 'Done when', value.doneWhen, { required: value.kind === 'action', rows: 3 }) + textField('result', 'Expected result', value.result, { rows: 2 });
    if (adding && value.kind !== 'action') fields += `<fieldset class="planning-new-children"><legend>${value.kind === 'choice' ? 'Two initial paths' : 'Two initial steps'}</legend>${value.children.map((child, index) => `<div class="planning-child-draft"><strong>${value.kind === 'choice' ? 'Path' : 'Step'} ${index + 1}</strong><label><span>Title</span><input data-planning-child="${index}" data-child-field="title" value="${escape(child.title)}" maxlength="300" required></label><label><span>Done when</span><textarea data-planning-child="${index}" data-child-field="doneWhen" rows="2" maxlength="1000" required>${escape(child.doneWhen)}</textarea></label>${value.kind === 'choice' ? `<label><span>Use this path when</span><textarea data-planning-child="${index}" data-child-field="condition" rows="2" maxlength="1000" required>${escape(child.condition)}</textarea></label>` : ''}</div>`).join('')}<p class="planning-field-help">More steps can be added inside the saved branch.</p></fieldset>`;
    fields += `<details class="planning-field-disclosure" data-planning-disclosure="structure"${adding ? ' open' : ''}><summary>Structure & dependencies</summary><div class="planning-two-fields">${selectField('parentId', 'Parent branch', option('', 'Whole plan', value.parentId) + parents.map(node => option(node.id, `${node.number} ${node.title}`, value.parentId)).join(''))}${selectField('beforeId', 'Place before', option('', 'At the end', value.beforeId) + siblings.map(node => option(node.id, `${node.number} ${node.title}`, value.beforeId)).join(''))}</div>${parent?.kind === 'choice' || !value.parentId && task.plan?.layout === 'choice' ? textField('condition', 'Use this path when', value.condition, { required: true }) : ''}${value.kind === 'choice' && !adding ? selectField('selectedChildId', 'Chosen path', option('', 'No path chosen', value.selectedChildId) + children.map(node => option(node.id, node.title, value.selectedChildId)).join('')) : ''}<fieldset class="planning-dependencies"><legend>Depends on</legend>${nodes.filter(node => node.id !== draft.stepId && !descendants.has(node.id)).map(node => `<label><input type="checkbox" data-planning-dependency="${escape(node.id)}"${value.dependsOn.includes(node.id) ? ' checked' : ''}><span>${escape(node.number)} ${escape(node.title)}<small>${escape(node.statusLabel)}</small></span></label>`).join('') || '<p>No other steps yet.</p>'}</fieldset><p class="planning-field-help">Sequence order also creates prerequisites. A dependent step waits until its required inputs are complete.</p></details>`;
    if (!adding) fields += `<details class="planning-field-disclosure" data-planning-disclosure="progress"><summary>Notes & reported progress</summary>${textField('note', 'Note', value.note, { max: 700, rows: 3 })}${step?.kind === 'action' || !children.length ? selectField('status', 'Reported status', [['pending', 'Pending'], ['active', 'Active'], ['blocked', 'Blocked'], ['done', 'Done'], ['skipped', 'Skipped']].map(([status, label]) => option(status, label, value.status)).join('')) : '<p class="planning-field-help">Branch progress comes from its child steps.</p>'}${textField('evidence', 'Evidence and limits of the check', value.evidence, { max: 2000, rows: 3 })}${value.status === 'blocked' ? textField('blockedReason', 'Actual blocker', value.blockedReason, { required: true }) : ''}${value.status === 'skipped' ? textField('skipReason', 'Why this step is skipped', value.skipReason, { required: true }) : ''}<p class="planning-field-help">Reported progress is a saved claim. Runtime execution and external-action receipts remain separate.</p></details>`;
  }
  return `<form id="planning-editor-form" data-planning-editor-key="${escape(draft.key)}"><fieldset class="planning-edit-fields"${disabled}>${fields}</fieldset></form>`;
}

export function initPlanningWorkspaceUI({ mount, api, onOpenRun, onNewChat, onArtifact, onSaved, onManagePlan, onError = () => {}, controllerOptions = {} } = {}) {
  if (!mount) throw new Error('Planning needs a workspace mount.');
  installPlanningWorkspaceStyles();
  const media = typeof window !== 'undefined' ? window.matchMedia?.('(max-width: 1050px)') : null;
  let compact = media?.matches === true, planEnlarged = false, destroyed = false, formSignature = '', messagesSignature = '', awarenessSignature = '', actionsSignature = null, taskBarSignature = null, catalogFooterSignature = null, draftSwitcherSignature = null, editorTitle = '', applying = false, planActionBusy = false, catalogEmpty, documentVisible = document.visibilityState !== 'hidden';
  let outlineFocus = '', focusedGroup = '', outlineFilter = '', selectedOutlineLocation = '', organizationReturnTarget = '', organizationFormSignature = '', organizationMessageSignature = '', organizationActionsSignature = '', groupActionsSignature = '', groupFilterSignature = '';
  const catalogRows = new Map(), catalogGroups = new Map(), expandedGroups = new Map();
  const $ = selector => mount.querySelector(selector);
  mount.classList.add('planning-workspace');
  mount.innerHTML = `<header class="planning-heading"><div class="planning-heading-copy">${glyph}<div><h1>Planning</h1><p>Shape the objectives, steps and branches saved with your chats.</p></div></div><div class="planning-heading-actions">${action('refresh', 'Refresh')}${onNewChat ? action('new-chat', 'New chat') : ''}</div></header>${coordinationNavigation('planning')}
    <nav class="planning-mobile-tabs" role="tablist" aria-label="Planning panels"><button type="button" role="tab" data-planning-pane="plan" aria-controls="planning-board-panel" aria-selected="true">Plan</button><button type="button" role="tab" data-planning-pane="edit" aria-controls="planning-editor-panel" aria-selected="false" tabindex="-1">Edit</button><button type="button" role="tab" data-planning-pane="saved" aria-controls="planning-saved-panel" aria-selected="false" tabindex="-1">Saved plans</button></nav>
    <div class="planning-layout"><aside id="planning-saved-panel" class="planning-catalog" aria-label="Saved plans">
      <div class="planning-catalog-heading"><div class="planning-catalog-title"><h2>Saved chat plans</h2>${action('create-group', 'New group')}</div>
        <label class="planning-search"><span class="sr-only">Search saved plans</span><input id="planning-search" type="search" maxlength="500" placeholder="Find a plan…" autocomplete="off"></label>
        <div class="planning-catalog-filters"><select id="planning-state" aria-label="Plan history"><option value="active">Active plans</option><option value="archived">Archive</option><option value="deleted">Trash · read only</option></select><select id="planning-group-filter" aria-label="Filter by group"><option value="">All groups</option><option value="ungrouped">Ungrouped</option></select></div>
        <p id="planning-catalog-status" role="status"></p>
      </div>
      <section id="planning-organization" class="planning-organization" aria-label="Organize plans" hidden><h3 id="planning-organization-title"></h3><div id="planning-organization-fields"></div><div id="planning-organization-messages" aria-live="polite"></div><div id="planning-organization-actions"></div></section>
      <p id="planning-organization-receipt" class="planning-organization-receipt" role="status" hidden></p>
      <div id="planning-catalog-list" class="planning-catalog-list"><ul id="planning-outline" class="planning-outline" role="tree" aria-label="Plans by group" aria-describedby="planning-outline-help"></ul></div>
      <p id="planning-outline-help" class="sr-only">Use arrow keys to navigate groups and plans. Right arrow expands a group; left arrow collapses it. Enter opens a plan. F2 renames the focused item. Each named group has a Remove button; its plans stay saved in Ungrouped.</p>
      <div id="planning-group-actions" class="planning-group-actions"></div><div id="planning-catalog-footer"></div>
    </aside>
    <section id="planning-board-panel" class="planning-board" aria-label="Saved plan"><div id="planning-task-bar" class="planning-task-bar"></div><div id="planning-load-status" role="status"></div><div id="planning-plan-mount"></div><div id="planning-empty" class="planning-workspace-empty" hidden>${glyph}<h2>A place to shape the work.</h2><p>Open a saved chat plan to refine its objective, steps and branches. Start a task in chat to create one. Swarms keeps specialist tasks and their worker history.</p>${onNewChat ? action('new-chat', 'Start a task in chat') : ''}</div></section>
    <aside id="planning-editor-panel" class="planning-editor" aria-label="Plan editor"><header class="planning-editor-heading"><h2 id="planning-editor-title">Objective</h2><span id="planning-editor-revision"></span></header><div id="planning-editor-runtime"></div><div id="planning-editor-messages" aria-live="polite"></div><div id="planning-editor-fields"></div><div id="planning-editor-actions" class="planning-editor-actions"></div><div id="planning-editor-awareness"></div><div id="planning-draft-switcher"></div></aside></div>`;
  const controller = createPlanningWorkspaceController({ ...controllerOptions, api, onSaved, onChange: reason => render(reason) });
  const planUI = initTaskPlanUI({ mount: $('#planning-plan-mount'), externalInspector: true, onArtifact, onEnlargedChange: value => { planEnlarged = value; if (value) controller.state.pane = 'plan'; renderPanes(); }, onSelection: value => { if (applying) return; controller.selectEditor(value.stepId); if (value.openDetails) { planUI.setEnlarged(false, { focusControl: false }); controller.setPane('edit'); $('#planning-editor-form [data-planning-field]')?.focus({ preventScroll: true }); } }, onError });
  function focusCapture(region) {
    const active = document.activeElement; if (!active || !region.contains(active)) return null;
    const data = active.dataset || {};
    return { active, field: data.planningField, organizationField: data.planningOrganizationField, outline: data.planningOutline, child: data.planningChild, childField: data.childField, dependency: data.planningDependency, action: data.planningAction, groupId: data.planningGroupId, task: data.planningTask, draft: data.planningDraft, start: active.selectionStart, end: active.selectionEnd, direction: active.selectionDirection };
  }
  function focusRestore(saved, region) {
    if (!saved || saved.active.isConnected && region.contains(saved.active)) return;
    const target = [...region.querySelectorAll('input,textarea,select,button,[data-planning-outline]')].find(element => saved.field ? element.dataset.planningField === saved.field : saved.organizationField ? element.dataset.planningOrganizationField === saved.organizationField : saved.outline ? element.dataset.planningOutline === saved.outline : saved.child != null ? element.dataset.planningChild === saved.child && element.dataset.childField === saved.childField : saved.dependency ? element.dataset.planningDependency === saved.dependency : saved.task ? element.dataset.planningTask === saved.task : saved.draft ? element.dataset.planningDraft === saved.draft : element.dataset.planningAction === saved.action && element.dataset.planningGroupId === saved.groupId);
    if (!target || target.disabled) return; target.focus({ preventScroll: true });
    if (typeof saved.start === 'number') try { target.setSelectionRange(saved.start, saved.end, saved.direction); } catch { /* Native selects do not expose text ranges. */ }
  }
  function replace(region, markup) {
    if (region.innerHTML === markup) return;
    const focus = focusCapture(region), scroll = region.scrollTop, disclosures = new Set([...region.querySelectorAll('[data-planning-disclosure]')].filter(item => item.open).map(item => item.dataset.planningDisclosure));
    region.innerHTML = markup; for (const item of region.querySelectorAll('[data-planning-disclosure]')) if (disclosures.has(item.dataset.planningDisclosure)) item.open = true;
    region.scrollTop = scroll; focusRestore(focus, region);
  }
  function renderEditorActions(markup) {
    // Native field blur fires change before the pending pointer click. Keep
    // that same Save button when its semantic state did not change; browsers
    // normalize innerHTML whitespace and cannot serve as this render cache.
    if (markup === actionsSignature) return;
    actionsSignature = markup; replace($('#planning-editor-actions'), markup);
  }
  function renderTaskBar(markup) {
    if (markup === taskBarSignature) return;
    taskBarSignature = markup; replace($('#planning-task-bar'), markup);
  }
  function renderCatalogFooter(markup) {
    if (markup === catalogFooterSignature) return;
    catalogFooterSignature = markup; replace($('#planning-catalog-footer'), markup);
  }
  function renderDraftSwitcher(markup) {
    // Opening a native disclosure changes innerHTML serialization, not the
    // saved draft choices. Keep its buttons until those choices change.
    if (markup === draftSwitcherSignature) return;
    draftSwitcherSignature = markup; replace($('#planning-draft-switcher'), markup);
  }
  function outlineNodes() {
    return [...$('#planning-outline').querySelectorAll('[data-planning-outline]')].filter(node => !node.dataset.planningTask || !node.closest('[data-planning-group]').querySelector('[role="group"]').hidden);
  }
  function focusOutline(node, { focus = true } = {}) {
    if (!node) return;
    outlineFocus = node.dataset.planningOutline;
    focusedGroup = node.dataset.planningGroup || node.closest('[data-planning-group]')?.dataset.planningGroup || '';
    for (const item of $('#planning-outline').querySelectorAll('[data-planning-outline]')) item.tabIndex = item === node ? 0 : -1;
    renderGroupActions();
    if (focus) { node.focus({ preventScroll: true }); (node.dataset.planningGroup ? catalogGroups.get(node.dataset.planningGroup)?.header : node)?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }); }
  }
  function toggleGroup(id, value) {
    const group = catalogGroups.get(id); if (!group) return;
    expandedGroups.set(id, value ?? !expandedGroups.get(id)); outlineFocus = `group:${id}`;
    renderCatalog(); focusOutline(group.item);
  }
  function renderGroupActions() {
    const state = controller.state, group = state.organization.groups.find(group => group.id === focusedGroup);
    const markup = group ? `<p>${escape(group.name)}</p><div>${action('rename-group', 'Rename group', state.organizationDraft?.busy ? 'disabled' : '')}</div>` : '<p>Remove a group beside its name. Its plans stay saved in Ungrouped.</p>';
    if (markup !== groupActionsSignature) { groupActionsSignature = markup; replace($('#planning-group-actions'), markup); }
  }
  function renderCatalog() {
    const state = controller.state, list = $('#planning-catalog-list'), tree = $('#planning-outline'), focus = focusCapture(list), scroll = list.scrollTop, seen = new Set(), seenGroups = new Set();
    const groups = planningCatalogOutline(state.plans, state.organization, state), filter = JSON.stringify([state.query, state.bucket, state.groupId]);
    const changedFilter = outlineFilter !== filter; outlineFilter = filter;
    const selectedPlan = state.plans.find(plan => plan.taskId === state.taskId), location = selectedPlan ? `${selectedPlan.groupId || 'ungrouped'}:${selectedPlan.taskId}` : '';
    if (location && location !== selectedOutlineLocation) { expandedGroups.set(selectedPlan.groupId || 'ungrouped', true); outlineFocus = `plan:${selectedPlan.taskId}`; selectedOutlineLocation = location; }
    for (const [groupIndex, group] of groups.entries()) {
      seenGroups.add(group.id); let branch = catalogGroups.get(group.id);
      if (!branch) {
        const item = document.createElement('li'), header = document.createElement('div'), chevron = document.createElement('span'), title = document.createElement('strong'), count = document.createElement('small'), children = document.createElement('ul'), empty = document.createElement('li');
        item.className = 'planning-outline-group'; item.setAttribute('role', 'treeitem'); item.setAttribute('aria-level', '1'); item.dataset.planningGroup = group.id; item.dataset.planningOutline = `group:${group.id}`;
        header.className = 'planning-outline-group-label'; chevron.className = 'planning-outline-chevron'; chevron.setAttribute('aria-hidden', 'true'); count.setAttribute('aria-hidden', 'true'); header.append(chevron, title, count);
        const remove = group.id === 'ungrouped' ? null : document.createElement('button');
        if (remove) { remove.setAttribute('type', 'button'); remove.className = 'planning-group-remove'; remove.dataset.planningAction = 'remove-group'; remove.dataset.planningGroupId = group.id; remove.textContent = 'Remove'; header.append(remove); }
        children.setAttribute('role', 'group'); children.className = 'planning-outline-children'; empty.setAttribute('role', 'none'); empty.className = 'planning-outline-empty'; item.append(header, children);
        branch = { item, header, chevron, title, count, children, empty, remove }; catalogGroups.set(group.id, branch);
      }
      if (!expandedGroups.has(group.id) || changedFilter && group.plans.length) expandedGroups.set(group.id, Boolean(group.plans.length));
      const expanded = expandedGroups.get(group.id), count = group.plans.length, total = Math.max(count, Number(group.planCount) || 0);
      branch.title.textContent = group.name; branch.count.textContent = total > count ? `${count}/${total}` : String(count); branch.chevron.textContent = expanded ? '▾' : '▸';
      if (branch.remove) { branch.remove.setAttribute('aria-label', `Remove group ${group.name}`); branch.remove.title = `Remove ${group.name}; keep its plans in Ungrouped`; branch.remove.disabled = state.organization.revision === null || state.organizationDraft?.busy === true; }
      branch.item.setAttribute('aria-label', `${group.name}, ${count}${total > count ? ` of ${total} loaded` : ''} ${count === 1 ? 'plan' : 'plans'}`);
      branch.item.setAttribute('aria-expanded', String(expanded)); branch.item.setAttribute('aria-posinset', String(groupIndex + 1)); branch.item.setAttribute('aria-setsize', String(groups.length)); branch.children.hidden = !expanded;
      if (tree.children[groupIndex] !== branch.item) tree.insertBefore(branch.item, tree.children[groupIndex] || null);
      if (count) branch.empty.remove();
      for (const [index, plan] of group.plans.entries()) {
        seen.add(plan.taskId); let row = catalogRows.get(plan.taskId);
        if (!row) {
          const item = document.createElement('li'), button = document.createElement('button'), title = document.createElement('strong'), meta = document.createElement('span'), progress = document.createElement('small');
          item.setAttribute('role', 'none'); button.setAttribute('type', 'button'); button.setAttribute('role', 'treeitem'); button.setAttribute('aria-level', '2'); button.className = 'planning-catalog-row'; button.dataset.planningTask = plan.taskId; button.dataset.planningOutline = `plan:${plan.taskId}`; button.append(title, meta, progress); item.append(button);
          row = { item, button, title, meta, progress }; catalogRows.set(plan.taskId, row);
        }
        const total = plan.progress?.total || 0, done = plan.progress?.done || 0, ready = plan.availableWork?.ready?.length ?? plan.progress?.ready?.length ?? 0;
        const values = { title: plan.title || plan.name || plan.goal || 'Untitled plan', meta: `${plan.runStatus || 'Saved'}${plan.bucket === 'archived' ? ' · Archived' : plan.bucket === 'deleted' ? ' · Trash' : ''}`, progress: `${total ? `${done} / ${total} steps done` : 'No steps yet'}${ready ? ` · ${ready} ready` : ''}` };
        // Preserve the exact pointer targets and their children while a poll
        // changes titles, progress, selection or the containing group.
        for (const key of ['title', 'meta', 'progress']) if (row[key].textContent !== values[key]) row[key].textContent = values[key];
        row.button.setAttribute('aria-current', String(plan.taskId === state.taskId)); row.button.setAttribute('aria-selected', String(plan.taskId === state.taskId)); row.button.setAttribute('aria-posinset', String(index + 1)); row.button.setAttribute('aria-setsize', String(count));
        if (branch.children.children[index] !== row.item) branch.children.insertBefore(row.item, branch.children.children[index] || null);
      }
      if (!count) { branch.empty.textContent = total ? 'Choose this group in the filter to load its plans.' : state.query ? 'No matching plans.' : 'No plans in this view.'; if (!branch.children.contains(branch.empty)) branch.children.append(branch.empty); }
    }
    for (const [id, row] of catalogRows) if (!seen.has(id)) { row.item.remove(); catalogRows.delete(id); }
    for (const [id, group] of catalogGroups) if (!seenGroups.has(id)) { group.item.remove(); catalogGroups.delete(id); }
    if (state.plans.length) catalogEmpty?.remove();
    else {
      if (!catalogEmpty) { catalogEmpty = document.createElement('p'); catalogEmpty.className = 'planning-empty-note'; }
      catalogEmpty.textContent = state.catalogLoading ? 'Loading saved plans…' : state.query ? 'No plans match this search.' : state.bucket === 'archived' ? 'No archived plans in this view.' : state.bucket === 'deleted' ? 'No plans in Trash.' : 'No active plans in this view.';
      if (!list.contains(catalogEmpty)) list.append(catalogEmpty);
    }
    const nodes = outlineNodes(), focused = nodes.find(node => node.dataset.planningOutline === outlineFocus) || nodes.find(node => node.dataset.planningTask === state.taskId) || nodes[0];
    if (focused) focusOutline(focused, { focus: false });
    list.scrollTop = scroll; focusRestore(focus, list);
    $('#planning-state').value = state.bucket;
    const options = option('', 'All groups', state.groupId) + state.organization.groups.map(group => option(group.id, group.name, state.groupId)).join('') + option('ungrouped', 'Ungrouped', state.groupId);
    if (options !== groupFilterSignature) { groupFilterSignature = options; $('#planning-group-filter').innerHTML = options; }
    $('#planning-group-filter').value = state.groupId;
    $('[data-planning-action="create-group"]').disabled = state.organization.revision === null || state.organizationDraft?.busy === true;
    $('#planning-catalog-status').textContent = state.catalogError || (state.catalogLoading ? 'Updating…' : state.catalog ? `${state.catalog.total} ${state.bucket === 'archived' ? 'archived' : state.bucket === 'deleted' ? 'deleted' : state.bucket === 'active' ? 'active' : 'saved'} ${state.catalog.total === 1 ? 'plan' : 'plans'}` : '');
    renderCatalogFooter(state.catalogError ? action('reload-list', 'Try again') : state.catalog?.hasMore ? action('more', 'Load more plans', state.catalogLoading ? 'disabled' : '') : '');
    renderGroupActions();
  }
  function renderOrganization(reason) {
    const state = controller.state, draft = state.organizationDraft, region = $('#planning-organization'), receipt = $('#planning-organization-receipt');
    receipt.hidden = !state.organizationReceipt; receipt.textContent = state.organizationReceipt;
    const returnFocus = !draft && region.contains(document.activeElement);
    region.hidden = !draft;
    if (!draft) {
      organizationFormSignature = '';
      if (returnFocus) focusOutline(outlineNodes().find(node => node.dataset.planningOutline === organizationReturnTarget) || outlineNodes()[0]);
      return;
    }
    organizationReturnTarget = draft.mode === 'plan' ? `plan:${draft.taskId}` : `group:${draft.groupId}`;
    const removing = draft.mode === 'remove-group', namingPlan = draft.mode === 'plan', stale = draft.conflict || draft.uncertain || draft.revision !== state.organization.revision;
    $('#planning-organization-title').textContent = removing ? `Remove “${draft.label}”?` : ({ plan: 'Rename or move plan', 'create-group': 'Create a group', 'rename-group': 'Rename group' })[draft.mode];
    const groupOptions = option('', 'Ungrouped', draft.values.groupId) + state.organization.groups.map(group => option(group.id, group.name, draft.values.groupId)).join('');
    const signature = JSON.stringify([draft.mode, draft.taskId, draft.groupId, draft.values, state.organization.groups.map(group => [group.id, group.name])]);
    if (reason === 'organization-input') organizationFormSignature = signature;
    else if (signature !== organizationFormSignature) {
      organizationFormSignature = signature;
      replace($('#planning-organization-fields'), `<form id="planning-organization-form"><fieldset>${namingPlan ? `<p class="planning-organization-target">${escape(draft.label)}</p>` : ''}${removing ? `<p>Remove <strong>${escape(draft.label)}</strong>? Its plans and Swarms will move to Ungrouped. Their saved work is kept.</p>` : `<label class="planning-field"><span>${namingPlan ? 'Plan name' : 'Group name'}</span><input data-planning-organization-field="name" maxlength="${namingPlan ? 160 : 120}" autocomplete="off" value="${escape(draft.values.name)}" placeholder="${namingPlan ? escape(draft.label) : 'For example, Website launch'}"${namingPlan ? ' aria-describedby="planning-name-help"' : ' required'}></label>${namingPlan ? `<p id="planning-name-help" class="planning-field-help">Leave blank to use the chat title or objective.</p><label class="planning-field"><span>Group</span><select data-planning-organization-field="groupId">${groupOptions}</select></label>` : ''}`}</fieldset></form>`);
    }
    const fields = $('#planning-organization-form fieldset'); if (fields) fields.disabled = draft.busy;
    let message = draft.error ? `<p class="planning-error" role="alert">${escape(draft.error)}</p>` : '';
    if (stale) message += `<div class="planning-conflict"><strong>${draft.uncertain ? 'Check the saved organization' : draft.revision < 0 ? 'Load the saved name and group' : 'The organization has changed'}</strong><p>Your name and group edits are kept. Review the current organization before saving.</p>${action('review-organization', draft.reviewBusy ? 'Reading current values…' : 'Review current organization', draft.busy || draft.reviewBusy ? 'disabled' : '')}</div>`;
    if (draft.review) {
      const saved = draft.review.values, groupName = state.organization.groups.find(group => group.id === saved?.groupId)?.name || 'Ungrouped';
      message += `<div class="planning-conflict-review"><h3>Saved now</h3><p>${saved ? escape(saved.name || 'Chat title or objective') : 'This group is not saved yet.'}${namingPlan && saved ? `<br>${escape(groupName)}` : ''}</p>${action('use-organization-review', 'Keep my edits on this revision')}<p>Then choose Save to apply your edits.</p></div>`;
    }
    if (message !== organizationMessageSignature) { organizationMessageSignature = message; replace($('#planning-organization-messages'), message); }
    const actions = `${action('cancel-organization', 'Cancel', draft.busy ? 'disabled' : '')}<button type="submit" form="planning-organization-form" id="planning-organization-save" class="primary"${draft.busy || stale || !draft.dirty ? ' disabled' : ''}>${draft.busy ? 'Saving…' : removing ? 'Remove group' : draft.mode === 'create-group' ? 'Create group' : 'Save organization'}</button>`;
    if (actions !== organizationActionsSignature) { organizationActionsSignature = actions; replace($('#planning-organization-actions'), actions); }
  }
  function renderPanes() {
    const state = controller.state; mount.dataset.planningPane = state.pane; mount.dataset.planningCompact = String(compact); mount.dataset.planEnlarged = String(planEnlarged);
    for (const button of mount.querySelectorAll('.planning-mobile-tabs > button[data-planning-pane]')) { const selected = button.dataset.planningPane === state.pane; button.setAttribute('aria-selected', String(selected)); button.tabIndex = selected ? 0 : -1; }
    for (const [key, id] of [['plan', 'planning-board-panel'], ['edit', 'planning-editor-panel'], ['saved', 'planning-saved-panel']]) { const panel = $(`#${id}`); panel.hidden = planEnlarged ? key !== 'plan' : compact && state.pane !== key; panel.inert = panel.hidden; }
    $('.planning-mobile-tabs').hidden = !compact;
    controller.awareness.setVisible(documentVisible && !$('#planning-editor-panel').hidden && controller.editable());
  }
  function renderEditor(reason) {
    const item = controller.entry(), draft = controller.draft(), task = item?.task, editable = controller.editable();
    const signature = JSON.stringify([controller.state.taskId, draft?.key, draft?.values, editable]);
    if (reason === 'input') formSignature = signature;
    else if (signature !== formSignature) { formSignature = signature; replace($('#planning-editor-fields'), renderPlanningEditor(task, draft, { editable })); }
    if (!task || !draft) { renderEditorActions(''); renderDraftSwitcher(''); $('#planning-editor-runtime').innerHTML = ''; $('#planning-editor-awareness').innerHTML = ''; awarenessSignature = ''; $('#planning-editor-messages').innerHTML = ''; $('#planning-editor-revision').textContent = ''; return; }
    const editFields = $('#planning-editor-form > fieldset'); if (editFields) editFields.disabled = !editable || draft.busy;
    const title = draft.mode === 'add' ? 'Add a step or branch' : draft.stepId ? 'Edit step' : 'Task objective'; if (title !== editorTitle) { editorTitle = title; $('#planning-editor-title').textContent = title; }
    const actor = task.provenance?.actor, source = actor ? `${actor.type === 'external-agent' ? 'External agent' : 'Remote client'}${actor.name ? ` · ${actor.name}` : ''}` : task.provenance?.source === 'human' ? 'You' : task.provenance?.source === 'agent' ? 'Agent' : 'Runtime';
    $('#planning-editor-revision').textContent = `Revision ${task.revision}`;
    $('#planning-editor-revision').title = `Last saved by ${source}`;
    const work = task.availableWork?.byId?.[draft.stepId], execution = work?.execution, owner = work?.owner;
    const runtime = work ? `<div class="planning-runtime-status" data-work-state="${escape(work.state)}"><strong>${escape(({ready:'Ready to proceed',active:'In progress',waiting:'Waiting on prerequisites',blocked:'Blocked','awaiting-choice':'Choose a path',unselected:'Path not selected',done:'Reported done',skipped:'Skipped'})[work.state] || work.state)}</strong>${work.reason ? `<p>${escape(work.reason)}</p>` : ''}${owner ? `<span>Owner · ${escape(owner.label || owner.nodeId)}</span>` : ''}${execution ? `<span>Execution · ${escape(execution.status)}${execution.nodeId ? ` · ${escape(owner?.label || execution.nodeId)}` : ''}</span>` : ''}</div>` : '';
    replace($('#planning-editor-runtime'), runtime);
    const shared = renderPlanningAwareness(task, draft, controller.awareness.state);
    if (shared !== awarenessSignature) { awarenessSignature = shared; replace($('#planning-editor-awareness'), shared); }
    const stale = draft.revision !== task.revision || draft.conflict || draft.uncertain;
    let messages = actor ? `<p class="planning-provenance">Last saved by ${escape(source)}</p>` : '';
    messages += !editable ? '<p class="planning-notice">This plan is in Trash. Restore its chat before editing.</p>' : '';
    if (draft.error) messages += `<p class="planning-error" role="alert">${escape(draft.error)}</p>`;
    if (draft.receipt) messages += `<p class="planning-receipt" role="status">${escape(draft.receipt)}</p>`;
    if (stale) messages += `<div class="planning-conflict"><strong>${draft.uncertain ? 'Check the saved result' : `The saved plan is now revision ${task.revision}`}</strong><p>Your draft from revision ${draft.revision} is kept. Review the latest values before applying it.</p>${action('review', draft.review ? 'Refresh latest revision' : 'Review latest revision', draft.busy ? 'disabled' : '')}</div>`;
    if (draft.review) {
      const diff = planningDraftDiff(draft, task), display = value => Array.isArray(value) ? value.map(item => typeof item === 'string' ? task.steps.find(step => step.id === item)?.title || item : JSON.stringify(item)).join(', ') : String(value ?? '') || 'Empty';
      messages += `<section class="planning-conflict-review" aria-label="Review changed plan"><h3>Your edits against revision ${task.revision}</h3>${diff.length ? diff.map(change => `<div data-planning-conflict-field="${escape(change.key)}"><strong>${escape(labels[change.key] || change.key)}${change.conflict ? ' · both changed' : ''}</strong><dl><dt>Saved now</dt><dd>${escape(display(change.current))}</dd><dt>Your draft</dt><dd>${escape(display(change.mine))}</dd></dl></div>`).join('') : '<p>Your edited fields already match the saved values.</p>'}${action('use-review', 'Keep my edits on this revision', !editable || draft.busy ? 'disabled' : '')}<p>Then review the form and choose Save. Nothing is sent automatically.</p></section>`;
    }
    if (messages !== messagesSignature) { messagesSignature = messages; replace($('#planning-editor-messages'), messages); }
    renderEditorActions(`${action('discard', draft.dirty ? 'Discard draft' : 'Reset form', draft.busy ? 'disabled' : '')}<button type="submit" form="planning-editor-form" class="primary" id="planning-save"${!editable || !draft.dirty || draft.busy || stale ? ' disabled' : ''}>${draft.busy ? 'Saving…' : draft.mode === 'add' ? 'Add to plan' : 'Save changes'}</button>${draft.stepId && draft.mode !== 'add' && editable ? `<details class="planning-remove" data-planning-disclosure="remove"><summary>Remove step</summary><p>Remove this step${task.steps.some(step => step.parentId === draft.stepId) ? ' and its child steps' : ''} from the saved plan. Runtime history is kept. Dependencies may need editing first.</p>${action('remove', 'Remove from plan', draft.busy || stale ? 'disabled' : '')}</details>` : ''}`);
    const drafts = [...item.drafts.values()].filter(value => value.dirty && value.key !== draft.key);
    renderDraftSwitcher(drafts.length ? `<details data-planning-disclosure="drafts"><summary>${drafts.length} other ${drafts.length === 1 ? 'draft' : 'drafts'} in this plan</summary>${drafts.map(value => `<button type="button" data-planning-draft="${escape(value.key)}">${escape(value.values.title || value.values.goal || 'New step')}</button>`).join('')}</details>` : '');
  }
  function render(reason = 'update') {
    if (destroyed) return;
    const item = controller.entry(), task = item?.task, state = controller.state;
    renderPanes(); renderCatalog(); renderOrganization(reason);
    $('#planning-empty').hidden = Boolean(task) || state.taskLoading;
    $('#planning-plan-mount').hidden = !task;
    $('#planning-load-status').textContent = state.error || (state.taskLoading && !task ? 'Loading saved plan…' : '');
    if (task) {
      const meta = item.meta || {}, view = taskPlanView(task, { runStatus: meta.runStatus }), ready = task.availableWork?.ready?.length ?? 0, active = task.availableWork?.active?.length ?? 0;
      const lifecycleDisabled = planActionBusy || meta.running || !meta.runId ? 'disabled' : '';
      const lifecycleHint = meta.running ? ' title="Wait for this task to finish before changing its history."' : !meta.runId ? ' title="This plan is not attached to a saved chat."' : '';
      const lifecycle = meta.bucket === 'active'
        ? `${action('archive-plan', 'Archive plan', `${lifecycleDisabled}${lifecycleHint}`)}${action('trash-plan', 'Move to Trash', `${lifecycleDisabled}${lifecycleHint} class="planning-destructive"`)}`
        : meta.bucket === 'archived'
          ? `${action('restore-plan', 'Restore plan', `${lifecycleDisabled}${lifecycleHint}`)}${action('trash-plan', 'Move to Trash', `${lifecycleDisabled}${lifecycleHint} class="planning-destructive"`)}`
          : meta.bucket === 'deleted' ? action('restore-plan', 'Restore from Trash', `${lifecycleDisabled}${lifecycleHint}`) : '';
      renderTaskBar(`<div class="planning-document-identity"><span>${escape(meta.groupName || 'Ungrouped')}</span><strong>${escape(meta.title || meta.name || task.goal || 'Untitled plan')}</strong></div><div class="planning-work-counts"><span>${ready} ready</span><span>${active} active</span>${meta.bucket === 'archived' ? '<span>Archived chat</span>' : meta.bucket === 'deleted' ? '<span>Trash · read only</span>' : ''}</div><div>${controller.editable() && state.organization.revision !== null ? action('organize-plan', 'Rename / move') : ''}${action('objective', 'Objective')}${controller.editable() ? action('add', 'Add step', 'class="primary"') : ''}${meta.runId && onOpenRun ? action('open-chat', 'Open chat') : ''}${lifecycle}</div>`);
      if (!['input', 'filter', 'pane', 'saving', 'review', 'awareness', 'outline', 'organization', 'organization-input'].includes(reason)) { applying = true; try { planUI.update({ taskState: task, runId: meta.runId, runStatus: meta.runStatus, settled: !view.live, planningMode: meta.planningMode || 'auto' }); const id = controller.draft()?.stepId; if (id && task.steps.some(step => step.id === id)) planUI.selectStep(id, { focus: false, notify: false }); } finally { applying = false; } }
    } else renderTaskBar('');
    renderEditor(reason);
  }
  function input(event) {
    const target = event.target;
    if (target.id === 'planning-search') { controller.setFilter({ query: target.value }); return; }
    if (target.id === 'planning-state') { controller.setFilter({ bucket: target.value }); return; }
    if (target.id === 'planning-group-filter') { controller.setFilter({ groupId: target.value }); return; }
    if (target.dataset.planningOrganizationField) { controller.editOrganization(target.dataset.planningOrganizationField, target.value); return; }
    if (target.dataset.planningChild !== undefined) { const children = structuredClone(controller.draft()?.values.children || []), index = Number(target.dataset.planningChild); if (children[index]) { children[index][target.dataset.childField] = target.value; controller.edit('children', children); } return; }
    if (target.dataset.planningDependency) { const values = controller.draft()?.values.dependsOn || [], id = target.dataset.planningDependency; controller.edit('dependsOn', target.checked ? [...new Set([...values, id])] : values.filter(value => value !== id)); return; }
    const field = target.dataset.planningField; if (!field) return;
    controller.edit(field, target.value);
    if (field === 'parentId') controller.edit('beforeId', '');
    if (['layout', 'kind', 'status', 'parentId'].includes(field)) { formSignature = ''; renderEditor('editor'); }
  }
  function openOrganization(mode, options) {
    if (!controller.startOrganization(mode, options)) return false;
    ($('#planning-organization-form input') || $('#planning-organization-save'))?.focus({ preventScroll: true }); return true;
  }
  async function selectPlan(id) {
    await controller.selectTask(id);
    if (compact && controller.state.taskId === id) ($('#planning-plan-mount [data-plan-node]') || $('[data-planning-action="objective"]'))?.focus({ preventScroll: true });
  }
  async function click(event) {
    const target = event.target.closest?.('button');
    const outline = event.target.closest?.('[data-planning-outline]');
    if (outline && mount.contains(outline) && !target?.dataset.planningAction) {
      focusOutline(outline);
      if (outline.dataset.planningTask) return selectPlan(outline.dataset.planningTask);
      toggleGroup(outline.dataset.planningGroup); return;
    }
    if (!target || !mount.contains(target) || target.disabled) return;
    if (target.dataset.planningPane) { planUI.setEnlarged(false, { focusControl: false }); controller.setPane(target.dataset.planningPane); return; }
    if (target.dataset.planningTask) { await selectPlan(target.dataset.planningTask); return; }
    if (target.dataset.planningDraft) { controller.selectDraft(target.dataset.planningDraft); return; }
    const name = target.dataset.planningAction; if (!name) return;
    if (['objective', 'add', 'organize-plan', 'create-group', 'rename-group', 'remove-group', 'archive-plan', 'trash-plan', 'restore-plan'].includes(name)) planUI.setEnlarged(false, { focusControl: false });
    const item = controller.entry(), draft = controller.draft();
    if (name === 'refresh') return controller.refresh();
    if (name === 'reload-list') return controller.loadCatalog();
    if (name === 'more') return controller.loadCatalog({ append: true });
    if (name === 'create-group') return openOrganization('create-group');
    if (name === 'rename-group') return openOrganization('rename-group', { groupId: focusedGroup });
    if (name === 'remove-group') return openOrganization('remove-group', { groupId: target.dataset.planningGroupId });
    if (name === 'organize-plan') return openOrganization('plan');
    if (name === 'cancel-organization') {
      const current = controller.state.organizationDraft, key = current?.mode === 'plan' ? `plan:${current.taskId}` : `group:${current?.groupId}`;
      if (controller.cancelOrganization()) focusOutline(outlineNodes().find(node => node.dataset.planningOutline === key) || outlineNodes()[0]); return;
    }
    if (name === 'review-organization') return controller.reviewOrganization();
    if (name === 'use-organization-review') return controller.applyReviewedOrganization();
    if (name === 'new-chat') return onNewChat?.();
    if (name === 'objective') { controller.selectEditor(); controller.setPane('edit'); $('#planning-editor-form textarea')?.focus({ preventScroll: true }); return; }
    if (name === 'add') { controller.startAdd(draft?.stepId); $('#planning-editor-form input')?.focus({ preventScroll: true }); return; }
    if (name === 'open-chat' && item?.meta?.runId) return onOpenRun?.(item.meta.runId);
    if (['archive-plan', 'trash-plan', 'restore-plan'].includes(name)) {
      if (!item?.task || !item.meta?.runId || planActionBusy) return;
      const operation = name === 'archive-plan' ? 'archive' : name === 'trash-plan' ? 'delete' : 'restore';
      planActionBusy = true; render();
      try {
        let result = onManagePlan ? await onManagePlan(operation, item.task.taskId, item.meta.runId) : undefined;
        if (result === undefined) result = await api(`/api/conversations/${encodeURIComponent(item.meta.runId)}/${operation}`, 'POST', {});
        if (result === false || destroyed || !controller.state.active) return;
        await controller.loadCatalog();
        if (controller.state.taskId === item.task.taskId) { controller.clearSelection(); const next = outlineNodes()[0]; if (next) focusOutline(next); else $('#planning-search')?.focus?.({ preventScroll: true }); }
      } finally { planActionBusy = false; render(); }
      return;
    }
    if (name === 'discard') return controller.discard();
    if (name === 'review') return controller.reviewLatest();
    if (name === 'use-review') return controller.applyReviewedDraft();
    if (name === 'remove') return controller.save({ remove: true });
  }
  function keydown(event) {
    if (event.defaultPrevented) return;
    if (event.key === 'Escape' && !event.ctrlKey && !event.metaKey && !event.altKey && planEnlarged) { event.preventDefault(); event.stopPropagation(); planUI.setEnlarged(false); return; }
    const outline = event.target.closest?.('[data-planning-outline]');
    if (outline && !event.target.closest?.('[data-planning-action]') && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const nodes = outlineNodes(), index = nodes.indexOf(outline), groupId = outline.dataset.planningGroup, group = groupId ? catalogGroups.get(groupId) : null;
      if (['ArrowDown', 'ArrowUp', 'Home', 'End', 'ArrowRight', 'ArrowLeft', 'Enter', ' ', 'F2'].includes(event.key)) {
        event.preventDefault();
        if (event.key === 'ArrowDown') focusOutline(nodes[Math.min(index + 1, nodes.length - 1)]);
        else if (event.key === 'ArrowUp') focusOutline(nodes[Math.max(index - 1, 0)]);
        else if (event.key === 'Home') focusOutline(nodes[0]);
        else if (event.key === 'End') focusOutline(nodes.at(-1));
        else if (event.key === 'ArrowRight' && group) { if (!expandedGroups.get(groupId)) toggleGroup(groupId, true); else focusOutline(group.children.querySelector('[data-planning-task]')); }
        else if (event.key === 'ArrowLeft') { if (group) { if (expandedGroups.get(groupId)) toggleGroup(groupId, false); } else focusOutline(outline.closest('[data-planning-group]')); }
        else if (event.key === 'F2') { if (groupId && groupId !== 'ungrouped') openOrganization('rename-group', { groupId }); else if (outline.dataset.planningTask) openOrganization('plan', { taskId: outline.dataset.planningTask }); }
        else if (event.key === 'Enter' || event.key === ' ') { if (group) toggleGroup(groupId); else void selectPlan(outline.dataset.planningTask).catch(onError); }
        return;
      }
    }
    if (event.key === 'Escape' && $('#planning-organization').contains(event.target) && !controller.state.organizationDraft?.busy) { event.preventDefault(); const key = controller.state.organizationDraft?.mode === 'plan' ? `plan:${controller.state.organizationDraft.taskId}` : `group:${controller.state.organizationDraft?.groupId}`; controller.cancelOrganization(); focusOutline(outlineNodes().find(node => node.dataset.planningOutline === key) || outlineNodes()[0]); return; }
    const tab = event.target.closest?.('.planning-mobile-tabs > button[data-planning-pane]');
    if (tab && mount.contains(tab) && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { event.preventDefault(); const tabs = [...mount.querySelectorAll('.planning-mobile-tabs > button[data-planning-pane]')], index = tabs.indexOf(tab), next = event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs.at(-1) : tabs[(index + (event.key === 'ArrowLeft' ? -1 : 1) + tabs.length) % tabs.length]; controller.setPane(next.dataset.planningPane); next.focus(); }
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && $('#planning-editor-panel').contains(event.target)) { event.preventDefault(); void controller.save(); }
  }
  function responsive(event) {
    if (compact === event.matches) return;
    if (event.matches) { const active = document.activeElement; controller.state.pane = $('#planning-editor-panel').contains(active) ? 'edit' : $('#planning-saved-panel').contains(active) ? 'saved' : 'plan'; }
    compact = event.matches; render('pane');
  }
  function visibility() { documentVisible = document.visibilityState !== 'hidden'; controller.awareness.setVisible(documentVisible && !$('#planning-editor-panel').hidden && controller.editable()); }
  function pagehide() { documentVisible = false; controller.awareness.setVisible(false); }
  const submit = event => { if (event.target.id === 'planning-editor-form') { event.preventDefault(); void controller.save(); } else if (event.target.id === 'planning-organization-form') { event.preventDefault(); void controller.saveOrganization(); } };
  const focusin = event => { const outline = event.target.closest?.('[data-planning-outline]'); if (outline) focusOutline(outline, { focus: false }); };
  const onClick = event => Promise.resolve(click(event)).catch(onError);
  mount.addEventListener('input', input); mount.addEventListener('change', input); mount.addEventListener('click', onClick); mount.addEventListener('submit', submit); mount.addEventListener('keydown', keydown); mount.addEventListener('focusin', focusin); media?.addEventListener?.('change', responsive);
  document.addEventListener('visibilitychange', visibility); window.addEventListener?.('pagehide', pagehide); window.addEventListener?.('pageshow', visibility);
  render();
  return { controller, enter: options => controller.enter(options), leave: () => { planUI.setEnlarged(false, { focusControl: false }); controller.leave(); }, refresh: () => controller.refresh(), handleEvent: event => controller.handleEvent(event), update: () => render('update'), getState: () => ({ ...controller.state, task: controller.entry()?.task, draft: controller.draft(), awareness: controller.awareness.state }), destroy() { if (destroyed) return; destroyed = true; controller.destroy(); planUI.destroy(); mount.removeEventListener('input', input); mount.removeEventListener('change', input); mount.removeEventListener('click', onClick); mount.removeEventListener('submit', submit); mount.removeEventListener('keydown', keydown); mount.removeEventListener('focusin', focusin); media?.removeEventListener?.('change', responsive); document.removeEventListener('visibilitychange', visibility); window.removeEventListener?.('pagehide', pagehide); window.removeEventListener?.('pageshow', visibility); } };
}
