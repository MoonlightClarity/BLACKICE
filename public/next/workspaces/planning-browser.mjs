import { text, stableId } from '../core/dom.mjs';
import { PLANNING_MODULE_TEMPLATES, planningModuleTemplate, projectPlanningRequest, planningOutlineRows } from '../../planning-browser-model.mjs';
import { createPlanningWorkspace } from './planning.mjs';
import { cycleForNode, cycleStageRows, cycleStateLabel, stageOutputSummary, cycleModelSelection, cycleModelRunFields, renderCycleControls, renderStageFindings, renderAccuracyTargets } from './response-cycle-ui.mjs';

const pathFor = id => '/api/planning-browser/requests/' + encodeURIComponent(id);
const nodePath = (requestId, nodeId) => pathFor(requestId) + '/nodes/' + encodeURIComponent(nodeId);
const clean = value => String(value ?? '');
const clone = value => structuredClone(value);
const labelFor = value => clean(value).replaceAll('_', ' ');
const activeWork = assignment => ['queued', 'prepared', 'starting', 'running', 'cancelling'].includes(assignment?.status);
const conversationKey = item => item?.conversationId || item?.rootId || item?.id || '';
const responseValues = node => node.response?.values || {};
const fieldsFor = node => node?.kind ? planningModuleTemplate(node.kind).fields : [];
const attemptFor = (document, nodeId) => (document?.attempts || []).filter(item => item.nodeId === nodeId).at(-1) || null;
const draftMatches = (draft, node) => draft.title === (node.title || '') && draft.prompt === (node.prompt || '')
  && JSON.stringify(draft.values) === JSON.stringify(node.response?.values || {})
  && ['grounding', 'openQuestions', 'challengeResponses'].every(key => JSON.stringify(draft[key]) === JSON.stringify(node.response?.[key] || []));

/** A visible, revision-aware document workspace. Opening it never invokes a model. */
export function createPlanningBrowser({ mount, api, events, notify = () => {}, onNavigate, getStatus = () => ({}), createLegacy = createPlanningWorkspace }) {
  mount.replaceChildren();
  const add = (parent, tag, value = '', cls = '') => text(parent, value, tag, cls);
  const button = (parent, value, action, cls = '') => {
    const element = add(parent, 'button', value, cls); element.setAttribute('type', 'button');
    element.addEventListener('click', action); return element;
  };
  const input = (parent, label, value = '', { rows = 0, required = false, help = '', id = '' } = {}) => {
    const wrapper = add(parent, 'label', '', 'pb-field');
    add(wrapper, 'span', label, 'pb-field-title');
    if (help) add(wrapper, 'small', help);
    const element = add(wrapper, rows ? 'textarea' : 'input', '', 'pb-input');
    if (!rows) element.setAttribute('type', 'text'); else element.rows = rows;
    element.value = clean(value); element.required = required;
    if (id) element.id = id;
    return element;
  };
  const select = (parent, label, values, selected = '') => {
    const wrapper = add(parent, 'label', label, 'pb-field'), element = add(wrapper, 'select', '', 'pb-input');
    for (const [value, title] of values) { const option = add(element, 'option', title); option.setAttribute('value', value); }
    if (selected) element.value = selected;
    return element;
  };
  const pill = (parent, value, state = value) => { const span = add(parent, 'span', value === 'ready' ? 'Response ready' : labelFor(value), 'pb-pill'); span.dataset.state = state; return span; };
  const note = (parent, message, tone = '') => { const element = add(parent, 'p', message, 'pb-note'); if (tone) element.dataset.tone = tone; return element; };
  const shell = add(mount, 'div', '', 'planning-browser');
  const header = add(shell, 'header', '', 'pb-header'), heading = add(header, 'div');
  add(heading, 'h1', 'Planning');
  add(heading, 'p', 'Feasibility, inference, plan, think, and respond — with child cycles for questions that need further work.');
  const headerActions = add(header, 'div', '', 'pb-header-actions');
  const browserButton = button(headerActions, 'Planning browser', () => showMode('browser'), 'pb-quiet');
  const legacyButton = button(headerActions, 'Legacy plans', () => showMode('legacy'), 'pb-quiet');
  const refreshButton = button(headerActions, 'Refresh', () => refresh()); refreshButton.dataset.action = 'refresh';
  const layout = add(shell, 'div', '', 'pb-layout');
  const rail = add(layout, 'aside', '', 'pb-rail'); rail.setAttribute('aria-label', 'Planning conversations');
  const railHead = add(rail, 'div', '', 'pb-rail-head'); add(railHead, 'h2', 'Conversations');
  const search = input(rail, 'Find a conversation', '', { id: 'pb-conversation-search' }); search.setAttribute('type', 'search');
  const archive = select(rail, 'Show', [['all', 'All conversations'], ['active', 'Active'], ['archived', 'Archived']]);
  const list = add(rail, 'nav', '', 'pb-list'); list.setAttribute('aria-label', 'Conversation list');
  const workspace = add(layout, 'main', '', 'pb-workspace');
  const tabRow = add(workspace, 'div', '', 'pb-tabs-row'), tabs = add(tabRow, 'div', '', 'pb-request-tabs');
  tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', 'Concurrent planning requests');
  const newRequestButton = button(tabRow, '+ Request', () => showRequestForm()); newRequestButton.dataset.action = 'new-request';
  const createArea = add(workspace, 'section', '', 'pb-create'); createArea.hidden = true;
  const notice = add(workspace, 'p', '', 'pb-notice'); notice.setAttribute('role', 'status'); notice.setAttribute('aria-live', 'polite');
  const detail = add(workspace, 'section', '', 'pb-workspace'); detail.setAttribute('role', 'tabpanel'); detail.id = 'pb-request-panel';
  const legacyMount = add(shell, 'section', '', 'pb-legacy'); legacyMount.hidden = true;

  let active = false, destroyed = false, mode = 'browser', legacy = null, unsubscribe = null, timer = null;
  let catalog = { conversations: [], requests: [], templates: PLANNING_MODULE_TEMPLATES }, conversationId = '', requestId = '', catalogGeneration = 0, catalogController = null, catalogError = '';
  let creatingRequest = false, pendingConversation = null, pendingRequest = null;
  const sessions = new Map(), selectedRequests = new Map(), requestDrafts = new Map();
  const session = id => {
    if (!sessions.has(id)) sessions.set(id, { document: null, selectedId: '', presentation: 'outline', collapsed: new Set(), drafts: new Map(), creations: new Map(), sourceDraft: { title: '', text: '', url: '' }, pending: new Set(), error: '', notice: '', readGeneration: 0, controller: null });
    return sessions.get(id);
  };
  const requestRows = () => catalog.requests.filter(row => clean(row.conversationId) === conversationId);
  const current = () => requestId ? session(requestId) : null;
  const selectedNode = state => state?.document?.nodes?.find(node => node.id === state.selectedId);
  const nodeIds = document => new Map((document?.nodes || []).map(node => [node.id, node]));
  const nodeTitle = (document, id) => document?.nodes?.find(node => node.id === id)?.title || 'Unavailable module';
  const dirty = draft => Boolean(draft?.dirty);

  function draftFor(state, node) {
    let draft = state.drafts.get(node.id);
    if (!draft || !dirty(draft) && (draft.baseRevision !== node.revision || draft.baseResponseId !== (node.response?.id || null))) {
      draft = { baseRevision: node.revision, baseResponseId: node.response?.id || null, title: node.title || '', prompt: node.prompt || '', values: clone(responseValues(node)), grounding: clone(node.response?.grounding || []), openQuestions: clone(node.response?.openQuestions || []), challengeResponses: clone(node.response?.challengeResponses || []), dirty: false };
      state.drafts.set(node.id, draft);
    }
    return draft;
  }
  function accept(document) {
    if (!document?.id || !Array.isArray(document.nodes)) throw Error('The planning request could not be read.');
    const state = session(document.id);
    if (state.document && Number(document.revision) < Number(state.document.revision)) return state;
    state.document = document.nodes.every(node => node.readiness) ? clone(document) : projectPlanningRequest(document);
    state.knownCycles ||= new Set();
    for (const cycle of document.cycles || []) if (!state.knownCycles.has(cycle.id)) { state.knownCycles.add(cycle.id); if (cycle.parentCycleId) state.collapsed.add(cycle.id); }
    if (!state.document.nodes.some(node => node.id === state.selectedId)) state.selectedId = state.document.nodes[0]?.id || '';
    const row = { ...catalog.requests.find(item => item.id === document.id), ...document };
    const index = catalog.requests.findIndex(item => item.id === document.id);
    if (index < 0) catalog.requests.push(row); else catalog.requests[index] = row;
    return state;
  }
  function renderKeepingFocus() {
    const focused = mount.ownerDocument.activeElement, key = detail.contains(focused) ? focused?.dataset?.fieldKey : null;
    const start = focused?.selectionStart, end = focused?.selectionEnd;
    const inspectorTop = detail.querySelector('.pb-inspector')?.scrollTop || 0;
    renderDetail();
    if (key) { const replacement = [...detail.querySelectorAll('[data-field-key]')].find(element => element.dataset.fieldKey === key); replacement?.focus?.({ preventScroll: true }); if (Number.isInteger(start) && Number.isInteger(end)) replacement?.setSelectionRange?.(start, end); }
    const inspector = detail.querySelector('.pb-inspector'); if (inspector) inspector.scrollTop = inspectorTop;
  }
  function renderRail() {
    list.replaceChildren();
    const query = search.value.trim().toLowerCase(), groups = new Map();
    for (const row of catalog.conversations) groups.set(conversationKey(row), row);
    for (const row of catalog.requests) if (!groups.has(clean(row.conversationId))) groups.set(clean(row.conversationId), { id: row.conversationId, title: row.conversationTitle || (row.conversationId ? 'Conversation ' + row.conversationId : 'Independent requests'), state: 'active' });
    if (!groups.size) groups.set('', { id: '', title: 'Independent requests', state: 'active' });
    for (const [id, row] of groups) {
      const title = row.title || row.rootTitle || row.name || 'Conversation';
      if (query && !title.toLowerCase().includes(query) || archive.value !== 'all' && (row.state || row.bucket || 'active') !== archive.value) continue;
      const count = catalog.requests.filter(item => clean(item.conversationId) === id).length;
      const control = button(list, '', () => chooseConversation(id), 'pb-conversation'); control.dataset.conversationId = id;
      control.setAttribute('aria-current', String(id === conversationId));
      add(control, 'strong', title); add(control, 'small', count + (count === 1 ? ' request' : ' requests') + ((row.state || row.bucket) === 'archived' ? ' · Archived' : ''));
    }
    if (!list.children.length) add(list, 'p', 'No matching conversations.', 'pb-help');
  }
  function renderTabs() {
    tabs.replaceChildren();
    for (const row of requestRows()) {
      const state = sessions.get(row.id), doc = state?.document || row;
      const control = button(tabs, '', () => void chooseRequest(row.id), 'pb-request-tab'); control.dataset.requestId = row.id;
      control.setAttribute('role', 'tab'); control.setAttribute('aria-selected', String(requestId === row.id)); control.setAttribute('aria-controls', 'pb-request-panel'); control.tabIndex = requestId === row.id ? 0 : -1;
      add(control, 'strong', row.title || 'Planning request');
      const activeCount = (doc.nodes || []).filter(node => activeWork(attemptFor(doc, node.id))).length || doc.summary?.running || 0;
      const draftCount = state ? [...state.drafts.values()].filter(dirty).length : 0;
      add(control, 'small', activeCount ? activeCount + ' running' : draftCount ? draftCount + ' unsaved draft' + (draftCount === 1 ? '' : 's') : 'Open request');
      control.addEventListener('keydown', event => {
        const rows = requestRows(), index = rows.findIndex(item => item.id === row.id);
        const next = event.key === 'ArrowRight' ? (index + 1) % rows.length : event.key === 'ArrowLeft' ? (index + rows.length - 1) % rows.length : event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : null;
        if (next == null) return; event.preventDefault(); void chooseRequest(rows[next].id).then(() => [...tabs.children].find(element => element.dataset.requestId === rows[next].id)?.focus());
      });
    }
  }
  function chooseConversation(id) {
    pendingConversation = null; pendingRequest = null;
    conversationId = clean(id); createArea.hidden = true;
    const rows = requestRows(), remembered = selectedRequests.get(conversationId);
    requestId = rows.some(row => row.id === remembered) ? remembered : rows[0]?.id || '';
    renderRail(); renderTabs(); renderDetail();
    if (requestId) void readRequest(requestId);
  }
  async function chooseRequest(id) {
    pendingConversation = null; pendingRequest = null;
    requestId = id; selectedRequests.set(conversationId, id); createArea.hidden = true;
    renderTabs(); renderDetail(); await readRequest(id);
  }
  async function loadCatalog() {
    if (!active || destroyed || mode !== 'browser') return;
    const generation = ++catalogGeneration; catalogController?.abort(); catalogController = new AbortController();
    try {
      const result = await api('/api/planning-browser', 'GET', undefined, { signal: catalogController.signal });
      if (!active || destroyed || generation !== catalogGeneration) return;
      if (!Array.isArray(result?.requests) || !Array.isArray(result?.conversations)) throw Error('Planning returned an unreadable catalog.');
      catalog = { ...result, templates: result.templates || PLANNING_MODULE_TEMPLATES };
      const damaged = Array.isArray(result.errors) ? result.errors : [];
      catalogError = damaged.length ? damaged.length + ' saved request' + (damaged.length === 1 ? '' : 's') + ' could not be read. Available requests remain visible.\n' + damaged.slice(0, 3).map(row => clean(row.id || row.requestId || 'Unknown request') + ': ' + clean(row.message || row.code || 'Unreadable saved graph').slice(0, 240)).join('\n') + (damaged.length > 3 ? '\n' + (damaged.length - 3) + ' more unreadable requests.' : '') : '';
      if (pendingRequest) {
        const target = pendingRequest; pendingRequest = null; requestId = target.id;
        const state = session(requestId), row = catalog.requests.find(item => item.id === requestId);
        conversationId = clean(row?.conversationId || state.document?.conversationId);
        if (target.nodeId) state.selectedId = target.nodeId;
        renderRail(); renderTabs(); renderKeepingFocus();
        await readRequest(requestId);
        if (!active || destroyed || generation !== catalogGeneration || requestId !== target.id) return;
        if (state.document) conversationId = clean(state.document.conversationId);
        selectedRequests.set(conversationId, requestId); renderRail(); renderTabs(); renderKeepingFocus();
        return;
      }
      if (pendingConversation != null) { conversationId = pendingConversation; pendingConversation = null; }
      else if (!conversationId && !catalog.requests.some(row => !row.conversationId)) conversationId = conversationKey(catalog.conversations[0]) || clean(catalog.requests[0]?.conversationId);
      const rows = requestRows();
      if (!rows.some(row => row.id === requestId)) requestId = rows.find(row => row.id === selectedRequests.get(conversationId))?.id || rows[0]?.id || '';
      renderRail(); renderTabs(); renderKeepingFocus();
      if (requestId) await readRequest(requestId);
    } catch (cause) { if (active && generation === catalogGeneration && cause.name !== 'AbortError') { catalogError = cause.message; notice.textContent = catalogError; } }
  }
  async function readRequest(id) {
    if (!active || destroyed || mode !== 'browser') return;
    const state = session(id), generation = ++state.readGeneration; state.controller?.abort(); state.controller = new AbortController();
    try {
      const result = await api(pathFor(id), 'GET', undefined, { signal: state.controller.signal });
      if (!active || destroyed || generation !== state.readGeneration) return;
      if (result.id !== id) throw Error('Planning returned a different request.');
      accept(result);
      if (id === requestId) { renderTabs(); renderKeepingFocus(); }
    } catch (cause) { if (active && generation === state.readGeneration && cause.name !== 'AbortError') { state.error = cause.message; if (id === requestId) renderKeepingFocus(); } }
  }
  async function mutate(id, key, route, method, body, onAccepted) {
    const state = session(id); if (state.pending.has(key)) return;
    state.pending.add(key); state.error = ''; state.notice = '';
    if (id === requestId) renderKeepingFocus();
    try {
      const payload = /\/(responses|cancel)$/.test(route) ? body : { ...body, clientRequestId: body.clientRequestId || stableId('planning') };
      const result = await api(route, method, payload);
      accept(result); const message = onAccepted?.(result); state.notice = typeof message === 'string' ? message : 'Saved. The document shows the recorded result.';
    } catch (cause) { state.error = cause.message; }
    finally { state.pending.delete(key); if (active && mode === 'browser') { renderRail(); renderTabs(); if (id === requestId) renderKeepingFocus(); } }
  }
  function showRequestForm() {
    createArea.replaceChildren(); createArea.hidden = false;
    const id = conversationId, draft = requestDrafts.get(id) || { title: '', objective: '', planningExecutionMode: 'automatic' }; requestDrafts.set(id, draft);
    add(createArea, 'h3', 'New planning cycle');
    const form = add(createArea, 'form', '', 'pb-form');
    const title = input(form, 'Request title', draft.title, { required: true, id: 'pb-request-title' });
    const objective = input(form, 'What should this request establish or change?', draft.objective, { rows: 3, required: true, id: 'pb-request-objective', help: 'Record the intended contribution. Adding the request does not start a model.' });
    const mode = select(form, 'Execution', [['automatic', 'Automatic'], ['plan_only', 'Plan only']], draft.planningExecutionMode || 'automatic');
    mode.dataset.fieldKey = 'new-cycle-mode'; mode.addEventListener('change', () => { draft.planningExecutionMode = mode.value; });
    add(form, 'p', 'Plan only pauses after Plan for inspection or editing by you or a supervising model. Continue is explicit and uses the saved plan revision.', 'pb-help');
    title.addEventListener('input', () => { draft.title = title.value; }); objective.addEventListener('input', () => { draft.objective = objective.value; });
    const actions = add(form, 'div', '', 'pb-actions'), save = add(actions, 'button', 'Create request', 'pb-primary'); save.setAttribute('type', 'submit'); save.dataset.action = 'create-request';
    button(actions, 'Cancel', () => { createArea.hidden = true; });
    form.addEventListener('submit', async event => {
      event.preventDefault(); if (creatingRequest || !title.value.trim() || !objective.value.trim()) return;
      creatingRequest = true; save.disabled = true; notice.textContent = '';
      try {
        const cwd = getStatus()?.cwd;
        const result = await api('/api/planning-browser/requests', 'POST', { ...(id ? { conversationId: id } : {}), title: title.value.trim(), objective: objective.value.trim(), planningExecutionMode: mode.value, ...(cwd ? { cwd } : {}), clientRequestId: stableId('planning_request') });
        accept(result); requestDrafts.delete(id);
        if (active && conversationId === id) { conversationId = clean(result.conversationId); requestId = result.id; selectedRequests.set(conversationId, result.id); createArea.hidden = true; renderRail(); renderTabs(); renderDetail(); }
      } catch (cause) { notice.textContent = cause.message; }
      finally { creatingRequest = false; save.disabled = false; }
    });
    title.focus?.();
  }
  function showNodeForm(parentId = null) {
    const id = requestId, state = current(), parent = state?.document?.nodes.find(node => node.id === parentId);
    if (!state?.document) return;
    const draftKey = parentId || 'root', draft = state.creations.get(draftKey) || { kind: 'frame', title: '', prompt: '' }; state.creations.set(draftKey, draft);
    createArea.replaceChildren(); createArea.hidden = false;
    add(createArea, 'h3', parent ? 'Expand “' + parent.title + '”' : 'Add a module');
    add(createArea, 'p', 'Give the child a distinct contribution to make. Its required response fields depend on the module kind.', 'pb-help');
    const form = add(createArea, 'form', '', 'pb-form'), grid = add(form, 'div', '', 'pb-create-grid');
    const kind = select(grid, 'Module kind', PLANNING_MODULE_TEMPLATES.map(template => [template.kind, template.label]), draft.kind);
    const title = input(grid, 'Module title', draft.title, { required: true, id: 'pb-node-title' });
    const description = add(form, 'p', planningModuleTemplate(kind.value)?.description || '', 'pb-help');
    kind.addEventListener('change', () => { draft.kind = kind.value; description.textContent = planningModuleTemplate(kind.value)?.description || ''; });
    const prompt = input(form, 'Question or instruction', draft.prompt, { rows: 3, required: true, id: 'pb-node-prompt' });
    title.addEventListener('input', () => { draft.title = title.value; }); prompt.addEventListener('input', () => { draft.prompt = prompt.value; });
    const actions = add(form, 'div', '', 'pb-actions'), save = add(actions, 'button', 'Add module', 'pb-primary'); save.setAttribute('type', 'submit'); save.dataset.action = 'create-node';
    button(actions, 'Cancel', () => { createArea.hidden = true; });
    form.addEventListener('submit', async event => {
      event.preventDefault(); if (!title.value.trim() || !prompt.value.trim()) return;
      const body = { kind: kind.value, title: title.value.trim(), prompt: prompt.value.trim(), ...(parent ? { parentId: parent.id, expectedParentRevision: parent.revision } : {}) };
      const before = new Set(state.document.nodes.map(node => node.id)); save.disabled = true;
      await mutate(id, 'child:' + (parentId || 'root'), pathFor(id) + '/nodes', 'POST', body, result => {
        const added = result.nodes.find(node => !before.has(node.id)); if (added) state.selectedId = added.id;
        state.creations.delete(draftKey);
        if (parentId) state.collapsed.delete(parentId);
        if (id === requestId) createArea.hidden = true;
      });
      save.disabled = false;
    }); title.focus?.();
  }
  function chooseNode(id) {
    const state = current(), byId = nodeIds(state?.document); if (!byId.has(id)) return;
    pendingConversation = null; pendingRequest = null;
    state.selectedId = id; const seen = new Set(); let parent = byId.get(id)?.parentId;
    while (parent && !seen.has(parent)) { seen.add(parent); state.collapsed.delete(parent); parent = byId.get(parent)?.parentId; }
    renderDetail();
  }
  function showCycleForm(parent = null) {
    const document = current()?.document, state = current(); if (!document) return;
    createArea.replaceChildren(); createArea.hidden = false;
    add(createArea, 'h3', parent ? 'Refine ' + (parent.title || 'this stage') : 'Add a response cycle');
    const form = add(createArea, 'form', '', 'pb-form');
    const title = input(form, 'Child question or contribution', '', { required: true });
    const purpose = input(form, 'What must this cycle establish?', '', { rows: 3, required: true });
    const owning = parent && cycleForNode(document, parent);
    const mode = select(form, 'Execution', [['automatic', 'Automatic'], ['plan_only', 'Plan only']], owning?.planningExecutionMode || 'automatic');
    const save = add(form, 'button', 'Create cycle', 'pb-primary'); save.setAttribute('type', 'submit'); save.dataset.action = 'create-cycle';
    button(form, 'Cancel', () => { createArea.hidden = true; });
    let submission = null;
    form.addEventListener('submit', async event => {
      event.preventDefault(); if (state.pending.has('new-cycle') || !title.value.trim() || !purpose.value.trim()) return;
      const body = { title: title.value.trim(), purpose: purpose.value.trim(), planningExecutionMode: mode.value, expectedRequestRevision: document.revision, ...(parent ? { parentNodeId: parent.id, expectedParentRevision: parent.revision } : {}) };
      const fingerprint = JSON.stringify(body); if (submission?.fingerprint !== fingerprint) submission = { fingerprint, clientRequestId: stableId('child_cycle') };
      await mutate(document.id, 'new-cycle', pathFor(document.id) + '/cycles', 'POST', { ...body, clientRequestId: submission.clientRequestId }, result => {
        createArea.hidden = true; const id = result.cycleAction?.cycleId; if (id) { state.selectedId = id; state.collapsed.delete(parent?.id); }
        return 'Cycle created. Its five stages are ready to inspect.';
      });
    });
    title.focus?.();
  }
  function rowState(node) { return node.readiness?.state || 'empty'; }
  function moduleSummary(parent, node) {
    const top = add(parent, 'span', '', 'pb-module-top');
    if (node.number) add(top, 'span', node.number + ' ', 'pb-module-number');
    add(top, 'strong', node.title || 'Untitled contribution', 'pb-module-title');
    const meta = add(parent, 'span', '', 'pb-module-meta'); add(meta, 'span', planningModuleTemplate(node.kind)?.label || node.kind, 'pb-module-kind');
    const cycle = cycleForNode(current()?.document || { nodes: [], cycles: [] }, node);
    if (node.kind === 'cycle' && cycle) { add(meta, 'span', cycleStateLabel(cycle.state)); add(meta, 'span', cycleStageRows(current().document, cycle).filter(row => row.node?.response).length + '/5 stages recorded'); }
    else pill(meta, rowState(node));
    if (node.readiness?.state === 'running') add(meta, 'span', 'Worker active');
    if (node.assignment) add(meta, 'span', node.assignment.label || node.assignment.name || 'Assigned worker');
    const openChildren = node.kind === 'cycle'
      ? (current()?.document?.cycles || []).filter(child => child.parentCycleId === node.id && child.state !== 'completed').length
      : node.readiness?.unresolvedChildren?.length || 0;
    if (openChildren) add(meta, 'span', openChildren + (openChildren === 1 ? ' child question open' : ' child questions open'));
    const summary = stageOutputSummary(node); if (summary) add(parent, 'span', summary.label + ': ' + summary.text, 'pb-module-output');
    return meta;
  }
  function visibleRows(document, state) {
    const all = planningOutlineRows(document), byId = nodeIds(document);
    return all.filter(row => { let parent = row.parentId; const seen = new Set(); while (parent && !seen.has(parent)) { if (state.collapsed.has(parent)) return false; seen.add(parent); parent = byId.get(parent)?.parentId; } return true; });
  }
  function renderOutline(parent, document, state) {
    const tree = add(parent, 'div', '', 'pb-outline'); tree.setAttribute('role', 'tree'); tree.setAttribute('aria-label', 'Recursive planning modules');
    const rows = visibleRows(document, state);
    for (const row of rows) {
      const children = document.nodes.filter(node => node.parentId === row.id), wrapper = add(tree, 'div', '', 'pb-outline-item'); wrapper.style.setProperty('--pb-depth', String(Math.max(0, row.depth || 0)));
      const toggle = button(wrapper, children.length ? state.collapsed.has(row.id) ? '▸' : '▾' : '·', () => { if (state.collapsed.has(row.id)) state.collapsed.delete(row.id); else { state.collapsed.add(row.id); const selectedRow = planningOutlineRows(document).find(item => item.id === state.selectedId); if (selectedRow?.path?.includes(row.id)) state.selectedId = row.id; } renderDetail(); }, 'pb-toggle');
      toggle.disabled = !children.length; toggle.setAttribute('aria-label', (state.collapsed.has(row.id) ? 'Expand ' : 'Collapse ') + row.title); toggle.dataset.toggleNode = row.id;
      const control = button(wrapper, '', () => chooseNode(row.id), 'pb-module-row'); control.dataset.nodeId = row.id; control.setAttribute('role', 'treeitem'); control.setAttribute('aria-selected', String(state.selectedId === row.id)); control.setAttribute('aria-level', String((row.depth || 0) + 1)); control.tabIndex = state.selectedId === row.id ? 0 : -1;
      if (children.length) control.setAttribute('aria-expanded', String(!state.collapsed.has(row.id)));
      moduleSummary(control, row); if (row.prompt) add(control, 'span', row.prompt, 'pb-module-prompt');
      control.addEventListener('keydown', event => {
        const index = rows.findIndex(item => item.id === row.id); let target;
        if (event.key === 'ArrowDown') target = rows[index + 1]; else if (event.key === 'ArrowUp') target = rows[index - 1]; else if (event.key === 'Home') target = rows[0]; else if (event.key === 'End') target = rows.at(-1);
        else if (event.key === 'ArrowRight' && children.length) { state.collapsed.delete(row.id); target = children[0]; }
        else if (event.key === 'ArrowLeft') { if (children.length && !state.collapsed.has(row.id)) { state.collapsed.add(row.id); target = row; } else target = document.nodes.find(node => node.id === row.parentId); }
        else return;
        event.preventDefault(); if (target) state.selectedId = target.id; renderDetail(); [...detail.querySelectorAll('[data-node-id]')].find(element => element.dataset.nodeId === state.selectedId)?.focus?.({ preventScroll: true });
      });
    }
    tree.scrollTop = state.outlineTop || 0;
    tree.addEventListener('scroll', () => { state.outlineTop = tree.scrollTop; });
  }
  function renderGraph(parent, document, state) {
    const viewport = add(parent, 'div', '', 'pb-graph'); viewport.setAttribute('role', 'region'); viewport.setAttribute('aria-label', 'Module knowledge graph'); viewport.tabIndex = 0;
    const stage = add(viewport, 'div', '', 'pb-graph-stage'), rows = visibleRows(document, state), positions = new Map(), counts = new Map();
    for (const row of rows) { const depth = Math.max(0, row.depth || 0), order = counts.get(depth) || 0; counts.set(depth, order + 1); positions.set(row.id, { x: 24 + depth * 285, y: 24 + order * 142 }); }
    const width = Math.max(540, (Math.max(0, ...counts.keys()) + 1) * 285), height = Math.max(350, Math.max(0, ...counts.values()) * 142 + 30); stage.style.width = width + 'px'; stage.style.height = height + 'px';
    const svg = mount.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('class', 'pb-graph-edges'); svg.setAttribute('width', width); svg.setAttribute('height', height); svg.setAttribute('viewBox', `0 0 ${width} ${height}`); svg.setAttribute('aria-hidden', 'true'); stage.append(svg);
    const markerId = stableId('pb_arrow'), defs = mount.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'defs'), marker = mount.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'marker');
    for (const [key, value] of Object.entries({ id: markerId, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 6, markerHeight: 6, orient: 'auto-start-reverse' })) marker.setAttribute(key, value);
    const arrow = mount.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'path'); arrow.setAttribute('d', 'M0 0 L10 5 L0 10 Z'); arrow.setAttribute('fill', 'context-stroke'); marker.append(arrow); defs.append(marker); svg.append(defs);
    const edges = [...document.edges];
    for (const node of document.nodes) if (node.parentId && !edges.some(edge => edge.kind === 'contains' && edge.from === node.parentId && edge.to === node.id)) edges.push({ kind: 'contains', from: node.parentId, to: node.id });
    for (const edge of edges) {
      const from = positions.get(edge.from), to = positions.get(edge.to); if (!from || !to) continue;
      const line = mount.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'path'); line.setAttribute('class', 'pb-graph-edge'); line.dataset.kind = edge.kind; line.dataset.selected = String(edge.from === state.selectedId || edge.to === state.selectedId);
      const x1 = from.x + 225, y1 = from.y + 52, x2 = to.x, y2 = to.y + 52, bend = Math.max(35, Math.abs(x2 - x1) / 2);
      line.setAttribute('d', `M${x1} ${y1} C${x1 + bend} ${y1} ${x2 - bend} ${y2} ${x2} ${y2}`);
      line.setAttribute('marker-end', `url(#${markerId})`);
      const title = mount.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'title'); title.textContent = nodeTitle(document, edge.from) + ' ' + labelFor(edge.kind) + ' ' + nodeTitle(document, edge.to); line.append(title); svg.append(line);
    }
    viewport.scrollLeft = state.graphLeft || 0; viewport.scrollTop = state.graphTop || 0;
    viewport.addEventListener('scroll', () => { state.graphLeft = viewport.scrollLeft; state.graphTop = viewport.scrollTop; });
    for (const row of rows) {
      const where = positions.get(row.id), card = button(stage, '', () => chooseNode(row.id), 'pb-graph-node'); card.dataset.nodeId = row.id; card.setAttribute('aria-selected', String(state.selectedId === row.id)); card.style.left = where.x + 'px'; card.style.top = where.y + 'px'; moduleSummary(card, row);
    }
    add(parent, 'p', 'Containment groups child work. Typed links record dependencies, inputs, support, and challenges. Select a module to inspect each relationship.', 'pb-graph-legend');
  }
  function renderRelationships(parent, document, node, state) {
    const section = add(parent, 'section', '', 'pb-inspector-section'); add(section, 'h4', 'Inputs and relationships');
    const edges = document.edges.filter(edge => edge.from === node.id || edge.to === node.id), list = add(section, 'ul', '', 'pb-link-list');
    for (const edge of edges) {
      const other = edge.from === node.id ? edge.to : edge.from, row = add(list, 'li');
      const link = button(row, nodeTitle(document, edge.from) + ' → ' + labelFor(edge.kind) + ' → ' + nodeTitle(document, edge.to), () => chooseNode(other), 'pb-link-button');
      link.disabled = !document.nodes.some(item => item.id === other);
      if (edge.sourceResponseId || edge.sourceField) {
        const producer = document.nodes.find(item => item.id === edge.to), field = fieldsFor(producer || {}).find(item => item.id === edge.sourceField);
        add(link, 'small', [edge.sourceResponseId ? 'Recorded response' : 'Response pending', field?.label || (edge.sourceField ? 'Recorded output field' : ''), edge.freshness === 'pinned' ? 'Pinned input' : 'Latest input'].filter(Boolean).join(' · '));
        const provenance = add(row, 'details', '', 'pb-history'); add(provenance, 'summary', 'Input provenance'); add(provenance, 'p', edge.sourceResponseId || 'Response not yet recorded', 'pb-provenance');
      }
      if (edge.note || edge.reason) add(row, 'p', edge.note || edge.reason, 'pb-help');
    }
    if (!edges.length) add(section, 'p', 'No explicit links recorded. A nearby node does not imply support.', 'pb-help');
    const disclosure = add(section, 'details'); disclosure.dataset.disclosureKey = 'link-editor'; add(disclosure, 'summary', 'Link another module');
    const form = add(disclosure, 'form', '', 'pb-link-form');
    const kind = select(form, 'Relationship from this module', [['depends_on', 'Depends on'], ['consumes', 'Consumes response from'], ['supports', 'Supports'], ['challenges', 'Challenges'], ['informs', 'Informs']]);
    const target = select(form, 'Linked module', document.nodes.filter(item => item.id !== node.id).map(item => [item.id, item.title || 'Untitled contribution']));
    const output = select(form, 'Output field', [['', 'Whole recorded response']]), freshness = select(form, 'Input freshness', [['latest', 'Follow latest response'], ['pinned', 'Pin the recorded response']]);
    const refreshOutput = () => { const saved = document.nodes.find(item => item.id === target.value); output.replaceChildren(); for (const [value, title] of [['', 'Whole recorded response'], ...fieldsFor(saved || {}).map(field => [field.id, field.label])]) { const option = add(output, 'option', title); option.setAttribute('value', value); } output.parentElement.hidden = kind.value !== 'consumes'; freshness.parentElement.hidden = kind.value !== 'consumes'; };
    kind.addEventListener('change', refreshOutput); target.addEventListener('change', refreshOutput); refreshOutput();
    const save = add(form, 'button', 'Add link'); save.setAttribute('type', 'submit'); save.disabled = document.nodes.length < 2 || state.pending.has(node.id);
    form.addEventListener('submit', event => { event.preventDefault(); if (!target.value) return; const response = document.nodes.find(item => item.id === target.value)?.response; void mutate(document.id, node.id, pathFor(document.id) + '/edges', 'POST', { expectedNodeRevision: node.revision, from: node.id, to: target.value, kind: kind.value, ...(kind.value === 'consumes' ? { freshness: freshness.value, ...(output.value ? { sourceField: output.value } : {}), ...(response ? { sourceResponseId: response.id, sourceResponseRevision: response.revision } : {}) } : {}) }); });
  }
  function renderProvenance(parent, response) {
    if (!response) return;
    const provenance = response.provenance || {}, p = add(parent, 'p', '', 'pb-provenance');
    const origin = provenance.kind === 'runtime' ? 'Model response' : provenance.kind === 'supervising_model' ? 'Supervising model response' : provenance.kind === 'external_agent' ? 'External agent response' : provenance.kind === 'human' ? 'Human response' : 'Response origin not recorded';
    p.dataset.responseId = response.id;
    p.textContent = [origin, 'Revision ' + response.revision, provenance.at, provenance.model || provenance.modelId].filter(Boolean).join(' · ');
    const details = add(parent, 'details', '', 'pb-history'); details.dataset.disclosureKey = 'provenance:' + response.id; add(details, 'summary', 'Response provenance');
    const references = [['Response', response.id], ['Prompt revision', response.nodeRevision], ['Author', provenance.author], ['Run', provenance.runId], ['Worker', provenance.executionNodeId || provenance.nodeId], ['Connection', provenance.receipt?.connectionId], ['Direct job', provenance.receipt?.jobId], ['Direct request', provenance.receipt?.requestId], ['Tool', provenance.receipt?.tool], ['Content hash', provenance.contentHash]];
    for (const [label, value] of references) if (value != null && value !== '') add(details, 'p', label + ': ' + value, 'pb-provenance');
  }
  function readinessItem(document, fields, key, value) {
    if (typeof value === 'string') return fields.find(field => field.id === value)?.label || nodeTitle(document, value);
    if (key === 'staleInputs') {
      if (value?.kind === 'module_revision') return 'This response uses module revision ' + value.expected + '; the module is now at revision ' + value.current + '.';
      if (value?.kind === 'producer_changed') return '“' + nodeTitle(document, value.nodeId) + '” has a newer response available.';
      if (value?.kind === 'consumed_response_changed') return 'The response from “' + nodeTitle(document, value.nodeId) + '” changed after this answer was recorded.';
      return value?.nodeId ? 'The recorded input from “' + nodeTitle(document, value.nodeId) + '” changed.' : 'A recorded input changed; review its current source.';
    }
    if (value?.field) return (fields.find(field => field.id === value.field)?.label || labelFor(value.field)) + (value.sourceId ? ' · Source ' + value.sourceId : '');
    if (value?.nodeId) return nodeTitle(document, value.nodeId);
    return value?.sourceId || value?.id || (typeof value?.reason === 'string' ? labelFor(value.reason) : 'Review this response requirement.');
  }
  function renderViability(parent, document, node, state) {
    const viability = node.readiness?.viability;
    const recoveryIssue = document.viability?.nodeId === node.id ? document.viability.recoveryIssue : null;
    if (!viability && !recoveryIssue) return;
    const readinessState = recoveryIssue ? 'needs_evidence' : viability.state;
    const section = add(parent, 'section', '', 'pb-inspector-section pb-viability');
    section.dataset.viabilityState = readinessState;
    add(section, 'h4', document.viability?.scope === 'deployment' ? 'Schedule setup' : 'Task viability');
    const labels = {
      ready: 'No essential input remains unresolved in this check.',
      awaiting_input: 'Answer the essential questions below to complete this check.',
      needs_evidence: 'This check needs supporting sources before it can guide the next action.',
      stale: 'Inputs changed. Review the current check before using its result.'
    };
    add(section, 'p', labels[readinessState] || 'Review the saved viability check.', 'pb-help');
    renderAccuracyTargets({ add }, section, node.response?.requirements, 'Requirement accuracy targets');
    if (recoveryIssue?.message) note(section, recoveryIssue.message, 'warning');
    if (viability?.issues?.length) {
      const issues = add(section, 'ul', '', 'pb-viability-issues');
      for (const issue of [...new Set(viability.issues)]) add(issues, 'li', issue);
    }
    const sourceIds = [...new Set((node.response?.grounding || []).map(link => link.sourceId))];
    if (sourceIds.length) {
      const sourceList = add(section, 'div', '', 'pb-actions');
      add(sourceList, 'span', 'Recorded sources: ');
      for (const id of sourceIds) {
        const source = (document.sources || []).find(item => item.id === id);
        if (!source) continue;
        button(sourceList, source.title || 'Recorded source', () => {
          const disclosure = [...detail.querySelectorAll('[data-disclosure-key]')].find(item => item.dataset.disclosureKey === 'source:' + id);
          if (disclosure) { disclosure.open = true; disclosure.scrollIntoView?.({ block: 'nearest' }); }
        }, 'pb-quiet');
      }
    }
    if (viability?.preferences?.length) {
      const preferences = add(section, 'details', '', 'pb-history'); preferences.dataset.disclosureKey = 'viability-preferences:' + node.id;
      add(preferences, 'summary', 'Preferences · ' + viability.preferences.length);
      add(preferences, 'p', 'These preferences do not block the work.', 'pb-help');
      const list = add(preferences, 'ul');
      for (const preference of viability.preferences) add(list, 'li', preference.label || preference.id);
    }
    if (recoveryIssue || readinessState !== 'awaiting_input') return;
    state.viabilityDrafts ||= new Map();
    for (const fact of viability.blockingFacts || []) {
      const key = node.id + ':' + fact.id, responseId = node.response?.id || null;
      let draft = state.viabilityDrafts.get(key);
      if (!draft) { draft = { answer: '', nodeRevision: node.revision, responseId, submission: null }; state.viabilityDrafts.set(key, draft); }
      else if (!draft.answer.trim() && !draft.submission) { draft.nodeRevision = node.revision; draft.responseId = responseId; }
      const stale = draft.nodeRevision !== node.revision || draft.responseId !== responseId;
      const pendingKey = 'viability:' + node.id, pending = state.pending.has(pendingKey);
      const form = add(section, 'form', '', 'pb-form pb-viability-answer'); form.dataset.requirementId = fact.id;
      if (fact.label) add(form, 'h5', fact.label);
      const answer = input(form, fact.question || fact.label || fact.id, draft.answer, { rows: 3, required: true, help: fact.consequence });
      answer.dataset.fieldKey = 'viability:' + key; answer.dataset.viabilityRequirement = fact.id;
      answer.addEventListener('input', () => { draft.answer = answer.value; });
      if (stale) {
        note(form, 'This check changed while you were answering. Your answer is preserved; review the current question before applying it.', 'warning');
        const keep = button(form, 'Keep answer for this revision', () => { draft.nodeRevision = node.revision; draft.responseId = responseId; draft.submission = null; renderKeepingFocus(); }, 'pb-quiet');
        keep.dataset.action = 'adopt-viability-revision';
      }
      if (!responseId) add(form, 'p', 'Run this module to save its check before recording an answer.', 'pb-help');
      const save = add(form, 'button', document.viability?.pendingIntent ? 'Answer and continue' : 'Save answer', 'pb-primary');
      save.setAttribute('type', 'submit'); save.dataset.action = 'answer-viability';
      save.disabled = pending || stale || !responseId || activeWork(attemptFor(document, node.id));
      form.addEventListener('submit', event => {
        event.preventDefault();
        if (pending || stale || !responseId || activeWork(attemptFor(document, node.id)) || !draft.answer.trim()) return;
        const body = { nodeId: node.id, requirementId: fact.id, answer: draft.answer.trim(), expectedNodeRevision: draft.nodeRevision, expectedResponseId: draft.responseId };
        const fingerprint = JSON.stringify(body);
        if (draft.submission?.fingerprint !== fingerprint) draft.submission = { fingerprint, clientRequestId: stableId('viability_answer') };
        void mutate(document.id, pendingKey, pathFor(document.id) + '/viability/answer', 'POST', { ...body, clientRequestId: draft.submission.clientRequestId }, result => {
          if (draft.answer.trim() === body.answer) state.viabilityDrafts.delete(key);
          if (result.viabilityAction?.resumedRunId) return 'Answer saved. The original conversation resumed.';
          if (result.viabilityAction?.deployment) return 'Answer saved. The schedule setup was updated.';
          return 'Answer saved. The check now shows the recorded result.';
        });
      });
    }
  }
  function runModuleLabel(selection) {
    const status = getStatus() || {};
    const model = [selection?.model, status.runtimeSettings?.defaultModel, status.defaultModel, catalog.runtime?.defaultModel].find(value => typeof value === 'string' && value.trim() && value !== 'default');
    const name = (status.models || []).find(item => (item.id || item.model) === model)?.displayName;
    return 'Run module with ' + (name || model || 'configured model');
  }
  function renderInspector(parent, document, state) {
    const node = selectedNode(state), inspector = add(parent, 'aside', '', 'pb-inspector'); inspector.setAttribute('aria-label', 'Module prompt and response');
    if (!node) { add(inspector, 'p', 'Choose a module to inspect its question, required outputs, sources, and child work.', 'pb-help'); return; }
    inspector.dataset.selectedNodeId = node.id;
    const cycle = cycleForNode(document, node), cycleContext = { add, button, input, select, fieldsFor, chooseNode, mutate, getStatus, runtimeDefaults: catalog.runtime, render: renderKeepingFocus,
      showSource: id => { const saved = [...detail.querySelectorAll('[data-disclosure-key]')].find(item => item.dataset.disclosureKey === 'source:' + id); if (saved) { saved.open = true; saved.scrollIntoView?.({ block: 'nearest' }); } } };
    if (node.kind === 'cycle') {
      add(inspector, 'span', 'Recursive response cycle', 'pb-eyebrow'); add(inspector, 'h3', node.title || 'Response cycle');
      if (cycle) renderCycleControls(cycleContext, inspector, document, cycle, state, { stages: true });
      else add(inspector, 'p', 'The cycle descriptor is unavailable. Refresh this request before starting work.', 'pb-help');
      const provenance = add(inspector, 'details', '', 'pb-history'); add(provenance, 'summary', 'Cycle provenance'); add(provenance, 'p', 'Cycle: ' + node.id + ' · Revision ' + node.revision, 'pb-provenance');
      return;
    }
    const draft = draftFor(state, node), fields = fieldsFor(node), readiness = node.readiness || {}, attempt = attemptFor(document, node.id), busy = state.pending.has(node.id), staleDraft = dirty(draft) && (draft.baseRevision !== node.revision || draft.baseResponseId !== (node.response?.id || null));
    add(inspector, 'span', (planningModuleTemplate(node.kind)?.label || node.kind) + ' · Revision ' + node.revision, 'pb-eyebrow'); add(inspector, 'h3', node.title || 'Untitled contribution');
    const stateLine = add(inspector, 'div', '', 'pb-status'); pill(stateLine, rowState(node)); add(stateLine, 'span', 'Response readiness · separate from execution');
    if (node.prompt) add(inspector, 'p', node.prompt, 'pb-help pb-selected-question');
    renderViability(inspector, document, node, state);
    if (cycle) renderCycleControls(cycleContext, inspector, document, cycle, state, { planEditor: node.kind === 'plan' });
    if (cycle) renderStageFindings(cycleContext, inspector, document, node, cycle);
    const runtimeActions = add(inspector, 'div', '', 'pb-actions pb-run-actions');
    const cycleSelection = cycle && cycleModelSelection(cycleContext, document, cycle, state);
    const run = button(runtimeActions, runModuleLabel(cycleSelection?.selected), () => {
      if (dirty(draft)) { state.error = 'Save or reload your draft before running this module so the worker receives the visible saved prompt and inputs.'; renderKeepingFocus(); return; }
      try { void mutate(document.id, node.id, nodePath(document.id, node.id) + '/run', 'POST', { expectedNodeRevision: node.revision, ...(cycle ? cycleModelRunFields(cycleContext, document, cycle, state) : {}) }); }
      catch (error) { state.error = error.message; renderKeepingFocus(); }
    }, 'pb-primary'); run.dataset.action = 'run-module'; run.disabled = busy || activeWork(attempt) || Boolean(cycle && (state.pending.has('cycle:' + cycle.id) || ['running', 'waiting_children', 'cancelling'].includes(cycle.state)));
    if (activeWork(attempt)) { const cancel = button(runtimeActions, 'Cancel worker', () => void mutate(document.id, node.id, nodePath(document.id, node.id) + '/cancel', 'POST', { attemptId: attempt.id })); cancel.dataset.action = 'cancel-worker'; cancel.disabled = busy; }
    if (node.assignment || attempt) {
      const worker = add(inspector, 'div', '', 'pb-worker'), owner = node.assignment;
      add(worker, 'strong', owner ? 'Owner: ' + (owner.label || owner.name || 'Assigned worker') + (owner.inherited ? ' · inherited branch' : '') : 'Module worker');
      if (attempt) add(worker, 'p', 'Runtime: ' + labelFor(attempt.status || 'recorded'));
      const metadata = attempt?.metadata || {}, model = metadata.model, requestedModel = attempt?.model || attempt?.modelId || owner?.model;
      if (model) add(worker, 'p', 'Model: ' + model);
      else if (requestedModel) add(worker, 'p', 'Requested model: ' + (requestedModel === 'default' ? 'configured default' : requestedModel));
      const message = attempt?.message || (typeof attempt?.error === 'string' ? attempt.error : attempt?.error?.message);
      if (message) add(worker, 'p', message, 'pb-worker-message');
      const references = [['Attempt', attempt?.id], ['Worker', owner?.workerId || owner?.agentId || owner?.nodeId || owner?.id], ['Module run', metadata.runId || attempt?.runId || owner?.runId], ['Provider', metadata.provider], ['Thread', metadata.threadId], ['Turn', metadata.turnId]].filter(([, value]) => value);
      if (references.length) {
        const details = add(worker, 'details', '', 'pb-history pb-attempt-provenance'); details.dataset.disclosureKey = 'attempt:' + (attempt?.id || node.id);
        add(details, 'summary', 'Worker details');
        for (const [label, value] of references) add(details, 'p', label + ': ' + value, 'pb-provenance');
      }
    }
    const problems = [['missingFields', 'Missing response fields'], ['missingGrounding', 'Missing grounding'], ['invalidGrounding', 'Invalid source links'], ['staleInputs', 'Changed inputs'], ['blockedDependencies', 'Unresolved dependencies'], ['openChallenges', 'Open challenges'], ['unresolvedChildren', 'Unresolved child modules']];
    const attentionCount = problems.reduce((count, [key]) => count + (readiness[key]?.length || 0), 0);
    if (attentionCount) {
      const attention = add(inspector, 'details', '', 'pb-readiness-details'); attention.dataset.disclosureKey = 'readiness-details';
      add(attention, 'summary', 'Why this response needs attention · ' + attentionCount + (attentionCount === 1 ? ' item' : ' items'));
      for (const [key, label] of problems) if (readiness[key]?.length) {
        add(attention, 'h5', label); const list = add(attention, 'ul');
        for (const value of readiness[key]) add(list, 'li', readinessItem(document, fields, key, value));
      }
      if (rowState(node) === 'ready' && readiness.unresolvedChildren?.length) add(attention, 'p', 'Own response fields are present; child work remains unresolved. Treat this as a provisional response.', 'pb-help');
    } else if (rowState(node) === 'ready') add(inspector, 'p', 'The required response is available for use. This state does not verify the conclusion or any external action.', 'pb-help');
    if (staleDraft) {
      note(inspector, 'This module changed while you were editing. Your draft is preserved. Review the saved response before applying it to the current revision.', 'warning');
      const actions = add(inspector, 'div', '', 'pb-actions');
      button(actions, 'Reload saved module', () => { state.drafts.delete(node.id); renderDetail(); });
      button(actions, 'Keep draft on this revision', () => { draft.baseRevision = node.revision; draft.baseResponseId = node.response?.id || null; renderDetail(); });
    }
    const definitionEditor = add(inspector, 'details', '', 'pb-definition-editor'); definitionEditor.dataset.disclosureKey = 'definition-editor'; add(definitionEditor, 'summary', 'Edit module prompt');
    const form = add(definitionEditor, 'form', '', 'pb-form');
    const title = input(form, 'Title', draft.title, { required: true }), prompt = input(form, 'Prompt · contribution to make', draft.prompt, { rows: 4, required: true });
    title.dataset.fieldKey = node.id + ':title'; prompt.dataset.fieldKey = node.id + ':prompt';
    for (const [element, key] of [[title, 'title'], [prompt, 'prompt']]) element.addEventListener('input', () => { draft[key] = element.value; draft.dirty = true; });
    const editActions = add(form, 'div', '', 'pb-actions'), savePrompt = add(editActions, 'button', 'Save prompt'); savePrompt.setAttribute('type', 'submit'); savePrompt.disabled = busy || staleDraft;
    form.addEventListener('submit', event => {
      event.preventDefault(); if (busy || staleDraft || !draft.title.trim() || !draft.prompt.trim()) return;
      const submitted = { title: draft.title, prompt: draft.prompt };
      void mutate(document.id, node.id, nodePath(document.id, node.id), 'PATCH', { expectedNodeRevision: draft.baseRevision, ...submitted }, result => {
        const saved = result.nodes.find(value => value.id === node.id); if (saved) draft.baseRevision = saved.revision;
        if (saved) draft.dirty = !draftMatches(draft, saved);
      });
    });
    const typedReadiness = ['viability', 'inference', 'plan', 'think', 'respond'].includes(node.kind) || document.viability?.nodeId === node.id;
    const savedPlan = node.kind === 'plan' && cycle && node.response;
    const responseSection = add(inspector, savedPlan ? 'details' : 'section', '', 'pb-inspector-section'); add(responseSection, savedPlan ? 'summary' : 'h4', savedPlan ? 'Recorded Plan fields and provenance' : 'Required questions');
    if (savedPlan) responseSection.dataset.disclosureKey = 'saved-plan-fields';
    add(responseSection, 'p', typedReadiness ? node.kind === 'plan' ? 'These are the saved Plan fields. Use Edit the saved Plan to change its steps, dependencies, acceptance criteria, and sources.' : ['inference', 'think', 'respond'].includes(node.kind) ? 'These saved fields belong to the complete structured stage response. Run the stage or use the shared structured response API to record a new version.' : 'These saved fields describe the complete readiness check. Use the factual Answer controls above to supply missing facts, or run this module to produce a new complete check.' : 'These fields make the module’s contribution inspectable. Record an answer or the exact missing input; unsupported claims stay visible.', 'pb-help');
    renderProvenance(responseSection, node.response);
    const responseForm = add(responseSection, 'form', '', 'pb-form'), controls = new Map();
    for (const field of fields) {
      const element = input(responseForm, field.label + (field.required ? ' *' : ''), draft.values[field.id] || '', { rows: 3, required: field.required, help: field.description || field.prompt });
      element.dataset.fieldKey = node.id + ':' + field.id; element.dataset.responseField = field.id;
      element.parentElement.dataset.missing = String((readiness.missingFields || []).includes(field.id));
      element.addEventListener('input', () => { draft.values[field.id] = element.value; draft.dirty = true; }); controls.set(field.id, element);
      if (field.grounding === 'required') {
        const source = select(responseForm, 'Grounding for ' + field.label, [['', 'Choose a recorded source'], ...(document.sources || []).map(item => [item.id, item.title || 'Recorded source'])]); source.dataset.fieldKey = node.id + ':source:' + field.id; source.dataset.groundingField = field.id;
        add(responseForm, 'p', 'Link the actual source. A saved source or model response is not independently verified.', 'pb-help');
        const sourceList = add(responseForm, 'ul', '', 'pb-input-list');
        const paintSources = () => {
          sourceList.replaceChildren();
          for (const grounding of draft.grounding.filter(item => item.field === field.id)) {
            const savedSource = (document.sources || []).find(item => item.id === grounding.sourceId), item = add(sourceList, 'li');
            add(item, 'span', savedSource?.title || 'Unavailable source', 'pb-provenance');
            button(item, 'Remove source', () => { draft.grounding = draft.grounding.filter(value => value !== grounding); draft.dirty = true; paintSources(); }, 'pb-quiet');
          }
        };
        source.addEventListener('change', () => { if (!source.value || draft.grounding.some(item => item.field === field.id && item.sourceId === source.value)) return; draft.grounding.push({ field: field.id, sourceId: source.value }); draft.dirty = true; source.value = ''; paintSources(); }); paintSources();
      }
    }
    for (const edge of document.edges.filter(item => item.kind === 'challenges' && item.to === node.id)) {
      const section = add(responseForm, 'div', '', 'pb-inspector-section'); add(section, 'h4', 'Challenge: ' + nodeTitle(document, edge.from));
      const existing = draft.challengeResponses.find(item => item.edgeId === edge.id) || { edgeId: edge.id, disposition: 'open', note: '' };
      const disposition = select(section, 'Disposition', [['open', 'Still open'], ['addressed', 'Addressed in this response']], existing.disposition);
      const explanation = input(section, 'Response to the challenge', existing.note, { rows: 3, help: 'Explain how the challenge changes or limits the answer. A status selection alone does not resolve it.' }); explanation.dataset.fieldKey = node.id + ':challenge:' + edge.id;
      const update = () => { draft.challengeResponses = [...draft.challengeResponses.filter(item => item.edgeId !== edge.id), { edgeId: edge.id, disposition: disposition.value, note: explanation.value }]; draft.dirty = true; };
      disposition.addEventListener('change', update); explanation.addEventListener('input', update);
    }
    const questions = input(responseForm, 'Open questions', draft.openQuestions.join('\n'), { rows: 2, help: 'One unresolved question per line.' }); questions.dataset.fieldKey = node.id + ':open-questions'; questions.addEventListener('input', () => { draft.openQuestions = questions.value.split('\n').map(value => value.trim()).filter(Boolean); draft.dirty = true; });
    const responseActions = add(responseForm, 'div', '', 'pb-actions'), saveResponse = add(responseActions, 'button', 'Save human response'); saveResponse.setAttribute('type', 'submit'); saveResponse.disabled = busy || staleDraft || typedReadiness; saveResponse.dataset.action = 'save-response';
    responseForm.addEventListener('submit', event => {
      event.preventDefault(); if (busy || staleDraft || typedReadiness) return;
      const values = Object.fromEntries(fields.map(field => [field.id, draft.values[field.id] || '']));
      if (fields.some(field => field.required && !clean(values[field.id]).trim())) { state.error = 'Fill the required response fields or state their specific missing input.'; renderKeepingFocus(); return; }
      const submitted = { values, grounding: clone(draft.grounding), openQuestions: clone(draft.openQuestions), challengeResponses: clone(draft.challengeResponses) };
      void mutate(document.id, node.id, nodePath(document.id, node.id) + '/responses', 'POST', { expectedNodeRevision: draft.baseRevision, ...submitted }, result => {
        const saved = result.nodes.find(value => value.id === node.id); if (saved) { draft.baseRevision = saved.revision; draft.baseResponseId = saved.response?.id || null; draft.dirty = !draftMatches(draft, saved); }
      });
    });
    if (typedReadiness) {
      for (const tag of ['input', 'textarea']) for (const control of responseForm.querySelectorAll(tag)) control.readOnly = true;
      for (const tag of ['select', 'button']) for (const control of responseForm.querySelectorAll(tag)) control.disabled = true;
    }
    add(responseSection, 'p', (cycle ? 'Run uses the model settings shown for this cycle. ' : 'Run uses your configured model settings. ') + (typedReadiness ? 'Factual answers are saved with their original source.' : 'Saving a human response records you as its author.'), 'pb-help');
    renderRelationships(inspector, document, node, state);
    const sources = add(inspector, 'section', '', 'pb-inspector-section'); add(sources, 'h4', 'Recorded sources');
    for (const source of document.sources || []) {
      const disclosure = add(sources, 'details', '', 'pb-history'); disclosure.dataset.disclosureKey = 'source:' + source.id; add(disclosure, 'summary', source.title || 'Recorded source');
      add(disclosure, 'p', source.id + ' · ' + labelFor(source.kind || 'source'), 'pb-provenance');
      if (source.text) add(disclosure, 'p', source.text, 'pb-response-value');
      if (source.url) add(disclosure, 'p', source.url, 'pb-provenance');
      if (source.provenance) add(disclosure, 'p', typeof source.provenance === 'string' ? source.provenance : Object.entries(source.provenance).filter(([, value]) => typeof value === 'string').map(([key, value]) => labelFor(key) + ': ' + value).join(' · '), 'pb-provenance');
    }
    const sourceEditor = add(sources, 'details'); sourceEditor.dataset.disclosureKey = 'source-editor'; add(sourceEditor, 'summary', '+ Add source material');
    const sourceDraft = state.sourceDraft;
    const sourceForm = add(sourceEditor, 'form', '', 'pb-form'), sourceTitle = input(sourceForm, 'Source title', sourceDraft.title, { required: true }), sourceText = input(sourceForm, 'Source text', sourceDraft.text, { rows: 3, required: true }), sourceUrl = input(sourceForm, 'Source URL (optional)', sourceDraft.url);
    for (const [element, key] of [[sourceTitle, 'title'], [sourceText, 'text'], [sourceUrl, 'url']]) { element.dataset.fieldKey = document.id + ':source:' + key; element.addEventListener('input', () => { sourceDraft[key] = element.value; }); }
    add(sourceForm, 'p', 'Saved as user-provided material. It becomes available for explicit grounding; saving does not verify its claims.', 'pb-help');
    const sourceSave = add(sourceForm, 'button', 'Save source'); sourceSave.setAttribute('type', 'submit'); sourceSave.disabled = state.pending.has('source');
    sourceForm.addEventListener('submit', event => { event.preventDefault(); if (!sourceTitle.value.trim() || !sourceText.value.trim()) return; const submitted = { ...sourceDraft }; void mutate(document.id, 'source', pathFor(document.id) + '/sources', 'POST', { title: submitted.title.trim(), text: submitted.text.trim(), ...(submitted.url.trim() ? { url: submitted.url.trim() } : {}) }, () => { for (const key of ['title', 'text', 'url']) if (sourceDraft[key] === submitted[key]) sourceDraft[key] = ''; }); });
    const children = document.nodes.filter(value => value.parentId === node.id), childSection = add(inspector, 'section', '', 'pb-inspector-section'); add(childSection, 'h4', 'Child modules · ' + children.length);
    for (const child of children) { const control = button(childSection, child.title, () => chooseNode(child.id), 'pb-link-button'); control.dataset.childNode = child.id; }
    if (cycle) button(childSection, '+ Refine with a child cycle', () => showCycleForm(node), 'pb-primary');
    else button(childSection, '+ Expand into a child module', () => showNodeForm(node.id));
    const history = (document.responses || []).filter(value => value.nodeId === node.id && value.id !== node.response?.id);
    if (history.length) {
      const disclosure = add(inspector, 'details', '', 'pb-history'); disclosure.dataset.disclosureKey = 'response-history'; add(disclosure, 'summary', 'Previous responses · ' + history.length);
      for (const response of history.slice().reverse()) { const article = add(disclosure, 'article'); renderProvenance(article, response); for (const [key, value] of Object.entries(response.values || {})) { add(article, 'h5', fields.find(field => field.id === key)?.label || key); add(article, 'p', value, 'pb-response-value'); } }
    }
  }
  function renderDetail() {
    const previousState = sessions.get(detail.dataset.requestId), previousInspector = detail.querySelector('.pb-inspector');
    if (previousState && previousInspector?.dataset.selectedNodeId) {
      previousState.inspectorSessions ||= new Map(); previousState.inspectorSessions.set(previousInspector.dataset.selectedNodeId, { top: previousInspector.scrollTop, open: new Set([...previousInspector.querySelectorAll('[data-disclosure-key]')].filter(element => element.open).map(element => element.dataset.disclosureKey)) });
    }
    detail.replaceChildren(); detail.dataset.requestId = requestId; const state = current(); notice.textContent = [catalogError, state?.error || state?.notice].filter(Boolean).join('\n');
    if (!requestId) {
      const empty = add(detail, 'div', '', 'pb-empty'); add(empty, 'h2', 'Give each request a place to develop.');
      add(empty, 'p', 'Start with a question or desired outcome. Add modules that test alternatives, inspect evidence, make a decision, or record an action and its result. Expand a module when it contains a further consequential question.');
      button(empty, 'Create planning request', () => showRequestForm(), 'pb-primary'); return;
    }
    if (!state.document) { add(detail, 'p', state.error || 'Opening saved request…', 'pb-empty'); return; }
    const document = state.document, requestHeader = add(detail, 'header', '', 'pb-request-header'), summary = add(requestHeader, 'div', '', 'pb-request-summary');
    add(summary, 'span', 'PLANNING REQUEST', 'pb-eyebrow'); add(summary, 'h2', document.title); if (document.objective) add(summary, 'p', document.objective);
    const requestProvenance = add(summary, 'details', '', 'pb-history'); add(requestProvenance, 'summary', 'Request provenance'); add(requestProvenance, 'p', document.id, 'pb-provenance');
    const actions = add(requestHeader, 'div', '', 'pb-actions'); button(actions, '+ Cycle', () => showCycleForm()); button(actions, '+ Module', () => showNodeForm(), 'pb-quiet');
    const conversation = catalog.conversations.find(group => conversationKey(group) === clean(document.conversationId) && group.source === 'conversation' && typeof group.runId === 'string' && group.runId.trim());
    if (conversation) button(actions, 'Open conversation', () => onNavigate?.('chat', { conversationId: conversation.runId }), 'pb-quiet');
    const content = add(detail, 'div', '', 'pb-content'), canvas = add(content, 'section', '', 'pb-canvas');
    const toolbar = add(canvas, 'div', '', 'pb-canvas-toolbar'), views = add(toolbar, 'div', '', 'pb-view-switch'); views.setAttribute('aria-label', 'Module view');
    for (const value of ['outline', 'graph']) { const control = button(views, value === 'outline' ? 'Outline' : 'Graph', () => { state.presentation = value; renderDetail(); }); control.dataset.view = value; control.setAttribute('aria-pressed', String(state.presentation === value)); }
    const crumbs = add(toolbar, 'nav', '', 'pb-breadcrumbs'); crumbs.setAttribute('aria-label', 'Module path');
    const byId = nodeIds(document), ancestors = [], seen = new Set(); let currentNode = byId.get(state.selectedId);
    while (currentNode && !seen.has(currentNode.id)) { seen.add(currentNode.id); ancestors.unshift(currentNode); currentNode = byId.get(currentNode.parentId); }
    for (const [index, node] of ancestors.entries()) { if (index) add(crumbs, 'span', '/'); button(crumbs, node.title, () => chooseNode(node.id), 'pb-quiet'); }
    if (!document.nodes.length) { const empty = add(canvas, 'div', '', 'pb-empty'); add(empty, 'h3', 'Begin with a module.'); add(empty, 'p', 'A framing module can establish the objective and what would change the decision. You can then connect specific inquiries and evidence.'); button(empty, 'Add first module', () => showNodeForm(), 'pb-primary'); }
    else if (state.presentation === 'graph') renderGraph(canvas, document, state); else renderOutline(canvas, document, state);
    renderInspector(content, document, state);
    const inspectorSession = state.inspectorSessions?.get(state.selectedId), inspector = detail.querySelector('.pb-inspector');
    if (inspectorSession && inspector) { inspector.scrollTop = inspectorSession.top || 0; for (const disclosure of inspector.querySelectorAll('[data-disclosure-key]')) disclosure.open = inspectorSession.open.has(disclosure.dataset.disclosureKey); }
  }
  function showMode(next) {
    mode = next; const isLegacy = mode === 'legacy'; layout.hidden = isLegacy; legacyMount.hidden = !isLegacy; refreshButton.hidden = isLegacy;
    browserButton.setAttribute('aria-pressed', String(!isLegacy)); legacyButton.setAttribute('aria-pressed', String(isLegacy));
    if (isLegacy) { legacy ||= createLegacy({ mount: legacyMount, api, events, notify, onNavigate, getStatus }); if (active) legacy.enter?.(); }
    else { legacy?.leave?.(); if (active) void loadCatalog(); }
  }
  function refresh() { if (mode === 'browser') return loadCatalog(); }
  function stopReads() { catalogGeneration++; catalogController?.abort(); for (const state of sessions.values()) { state.readGeneration++; state.controller?.abort(); } }
  search.addEventListener('input', renderRail); archive.addEventListener('change', renderRail);
  browserButton.setAttribute('aria-pressed', 'true'); legacyButton.setAttribute('aria-pressed', 'false'); renderRail(); renderDetail();
  return {
    enter() { if (active || destroyed) return; active = true; unsubscribe = events.subscribe(event => { if (!active || mode !== 'browser' || !/^(planning_browser\.|planning-browser\.|planning\.browser\.|conversations\.)/.test(event.type || '')) return; const changedId = event.data?.requestId || event.requestId; if (changedId && changedId !== requestId && sessions.has(changedId)) void readRequest(changedId); clearTimeout(timer); timer = setTimeout(() => void loadCatalog(), 160); }); if (mode === 'legacy') legacy?.enter?.(); else void loadCatalog(); },
    leave() { active = false; stopReads(); unsubscribe?.(); unsubscribe = null; clearTimeout(timer); legacy?.leave?.(); },
    destroy() { this.leave(); destroyed = true; legacy?.destroy?.(); sessions.clear(); requestDrafts.clear(); mount.replaceChildren(); },
    openConversationId(id) { if (!id) return; pendingRequest = null; pendingConversation = id; if (mode !== 'browser') showMode('browser'); else if (active) void loadCatalog(); },
    openRequestId(id, { nodeId } = {}) { if (!id) return; pendingConversation = null; pendingRequest = { id, nodeId }; if (mode !== 'browser') showMode('browser'); else if (active) void loadCatalog(); },
    updateStatus() { const run = detail.querySelector('[data-action="run-module"]'); if (run) run.textContent = runModuleLabel(); }
  };
}
