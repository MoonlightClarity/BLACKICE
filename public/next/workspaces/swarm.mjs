import { text, stableId } from '../core/dom.mjs';

const phases = ['proposed', 'queued', 'delivered', 'accepted', 'completed'];
const phaseLabel = { proposed: 'Proposed', queued: 'Queued', delivered: 'Delivered (reported)',
  accepted: 'Accepted', completed: 'Completed (recorded)' };
const pretty = value => String(value || 'not_ready').replaceAll('_', ' ');
const message = error => String(error?.message || error || 'Unknown Swarm error.');
const parseIds = value => String(value || '').split(',').map(v => v.trim()).filter(Boolean);
const labelDate = value => value ? new Date(value).toLocaleString() : '—';
const itemId = project => project.items?.[0]?.id || null;
const classFor = value => 'swarm-state-' + String(value || 'unknown').replace(/[^a-z0-9_-]/g, '');
const get = (root, selector) => root.querySelector(selector);

export function createSwarmWorkspace({ mount, api, events, notify = () => {} } = {}) {
  let data = null, active = false, selectedProject = null, selectedItem = null, waiting = false;
  let sequence = 0, notice = '', remoteChanged = false;
  const el = (parent, tag, value = '', cls = '') => text(parent, value, tag, cls);
  const button = (parent, label, handler, cls = '') => {
    const node = el(parent, 'button', label, cls);
    node.type = 'button';
    node.addEventListener('click', handler);
    return node;
  };
  const form = (parent, className, submit) => {
    const result = el(parent, 'form', '', className);
    result.addEventListener('submit', event => {
      event.preventDefault();
      if (!waiting) void submit();
    });
    return result;
  };
  const field = (parent, label, { tag = 'input', value = '', options = null, required = false,
    placeholder = '', rows = 3 } = {}) => {
    const wrapper = el(parent, 'label', '', 'swarm-field');
    el(wrapper, 'span', label, 'swarm-field-label');
    const node = el(wrapper, tag);
    if (tag === 'textarea') node.rows = rows;
    if (tag === 'input') node.type = 'text';
    if (options) for (const [key, title] of options) {
      const option = el(node, 'option', title);
      option.value = key;
    }
    node.value = value == null ? '' : String(value);
    node.dataset.initialValue = node.value;
    node.required = required;
    node.placeholder = placeholder;
    node.className = 'swarm-input';
    return node;
  };
  const submit = (parent, label) => {
    const node = el(parent, 'button', label, 'swarm-submit');
    node.type = 'submit';
    node.disabled = waiting;
    return node;
  };
  const pill = (parent, value, caption = value) => {
    const node = el(parent, 'span', caption, 'swarm-badge ' + classFor(value));
    node.dataset.state = value;
    return node;
  };
  const heading = (parent, label, description = '') => {
    const group = el(parent, 'div', '', 'swarm-section-title');
    el(group, 'h3', label);
    if (description) el(group, 'p', description);
    return group;
  };
  let retryCandidate = null;
  const mutate = async (action, rest) => {
    if (waiting) return;
    waiting = true; remoteChanged = false;
    // Reuse the same mutation ID after an uncertain response; never duplicate a saved effect.
    const payload = JSON.stringify({ action, ...rest });
    const mutationId = retryCandidate?.payload === payload ? retryCandidate.mutationId : stableId('swarm');
    retryCandidate = { payload, mutationId };
    let failed = false;
    try {
      const result = await api('/api/swarm/actions', 'POST',
        { mutationId, action, ...rest });
      retryCandidate = null;
      selectedProject = result.project.id;
      if (result.project.items?.length && !selectedItem) selectedItem = result.project.items.at(-1).id;
      notice = 'Coordination record saved. No worker action or delivery was implied.';
      notify(action.replaceAll('_', ' ') + ' saved.');
      await refresh(true);
    } catch (error) {
      failed = true; remoteChanged = true;
      notice = message(error) + ' The draft remains in place; inspect current records before retrying. An identical retry reuses its mutation ID.';
      notify(notice, true);
      const shell = get(mount, '.swarm-shell');
      if (shell) {
        let status = get(shell, '.swarm-notice, .swarm-warning');
        if (!status) {
          status = el(shell, 'div', '', 'swarm-warning');
          status.setAttribute('role', 'status');
          get(shell, '.swarm-top')?.insertAdjacentElement('afterend', status);
        }
        status.className = 'swarm-warning';
        status.textContent = notice;
      }
    } finally { waiting = false; if (!failed) render(); }
  };
  const refresh = async (force = false) => {
    if (!active && !force) return;
    const current = ++sequence;
    try {
      const latest = await api('/api/swarm', 'GET');
      if (current !== sequence) return;
      data = latest;
      if (!latest.projects?.some(p => p.id === selectedProject)) selectedProject = latest.projects?.[0]?.id || null;
      const project = latest.projects?.find(p => p.id === selectedProject);
      if (!project?.items?.some(item => item.id === selectedItem)) selectedItem = itemId(project || { items: [] });
      remoteChanged = false;
      render();
    } catch (error) {
      if (current !== sequence) return;
      notice = 'Could not read current Swarm records: ' + message(error);
      render();
    }
  };
  const changeProject = id => {
    selectedProject = id;
    selectedItem = itemId(data.projects.find(p => p.id === id) || { items: [] });
    notice = ''; render();
  };
  const createProject = root => {
    const section = el(root, 'details', '', 'swarm-disclosure');
    if (!data?.projects?.length) section.open = true;
    el(section, 'summary', 'Create a Swarm project');
    const proposedId = stableId('project').slice(0, 100);
    const action = form(section, 'swarm-form swarm-two', () => mutate('create_project', {
      value: { id: proposedId, name: name.value, objective: objective.value }
    }));
    const name = field(action, 'Project name', { required: true, placeholder: 'Launch readiness' });
    const objective = field(action, 'Outcome and boundaries', { tag: 'textarea', required: true,
      placeholder: 'Coordination objective, not an executable task plan.' });
    submit(action, 'Create project');
  };
  const workerSection = (root, project) => {
    const panel = el(root, 'section', '', 'swarm-panel');
    heading(panel, 'Workers & ownership', 'Scopes are declarations, not proof a worker is running.');
    const list = el(panel, 'div', '', 'swarm-worker-list');
    for (const worker of project.workers) {
      const line = el(list, 'article', '', 'swarm-worker');
      pill(line, worker.kind, worker.kind);
      el(line, 'strong', worker.label);
      el(line, 'small', worker.id, 'swarm-id');
      el(line, 'p', worker.scope);
      el(line, 'span', worker.actorId ? 'Bound to connector ID ' + worker.actorId : 'No authenticated worker identity bound', 'swarm-muted');
    }
    if (!project.workers.length) el(list, 'p', 'No workers registered.', 'swarm-muted');
    const details = el(panel, 'details', '', 'swarm-disclosure');
    el(details, 'summary', 'Register worker');
    const proposedWorkerId = stableId('worker').slice(0, 100);
    const f = form(details, 'swarm-form', () => mutate('register_worker', {
      projectId: project.id, expectedProjectRevision: project.revision,
      value: { id: proposedWorkerId, label: name.value, scope: scope.value,
        kind: kind.value, ...(actor.value.trim() ? { actorId: actor.value.trim() } : {}) }
    }));
    const name = field(f, 'Worker name', { required: true });
    const kind = field(f, 'Type', { tag: 'select', options: [['agent', 'Agent'], ['human', 'Human']] });
    const scope = field(f, 'Authorized scope', { tag: 'textarea', required: true,
      placeholder: 'Explicit files, outcomes and limitations' });
    const actor = field(f, 'Optional bound connector identity', {
      placeholder: 'Exact authenticated worker client ID, if known' });
    submit(f, 'Register worker');
  };
  const createWorkItem = (root, project) => {
    const panel = el(root, 'details', '', 'swarm-disclosure');
    el(panel, 'summary', '+ Propose work item');
    const proposedItemId = stableId('item').slice(0, 100);
    const f = form(panel, 'swarm-form swarm-two', () => mutate('propose_item', {
      projectId: project.id, expectedProjectRevision: project.revision,
      value: { id: proposedItemId, title: title.value, scope: scope.value,
        requirements: requirements.value, ownerId: owner.value || null,
        dependsOn: parseIds(deps.value), verificationTarget: verify.value }
    }));
    const title = field(f, 'Title', { required: true, placeholder: 'Isolated test implementation' });
    const owner = field(f, 'Owner', { tag: 'select', options: [['', 'Unassigned'],
      ...project.workers.map(w => [w.id, w.label])] });
    const scope = field(f, 'Scope', { tag: 'textarea', required: true, placeholder: 'Owned files or interfaces' });
    const requirements = field(f, 'Acceptance requirements', { tag: 'textarea', required: true,
      placeholder: 'What has to be demonstrated and what remains unknown?' });
    const deps = field(f, 'Dependency IDs (comma-separated)', {
      placeholder: 'Optional prior work item IDs' });
    const verify = field(f, 'Evidence authority needed', { tag: 'select', options:
      [['source', 'Source review'], ['unit', 'Unit test'], ['integration', 'Integration'],
        ['packaged', 'Packaged runtime'], ['live_worker', 'Live worker'], ['external', 'External']] });
    verify.value = 'integration';
    submit(f, 'Propose item (no dispatch)');
  };
  const projectRail = (root, projects) => {
    const rail = el(root, 'aside', '', 'swarm-rail');
    heading(rail, 'Projects', 'Choose an explicit shared coordination board.');
    for (const project of projects) {
      const b = button(rail, '', () => changeProject(project.id), 'swarm-project-select');
      b.dataset.projectId = project.id; b.setAttribute('aria-pressed', String(selectedProject === project.id));
      el(b, 'strong', project.name); el(b, 'small', project.items.length + ' scoped items');
      pill(b, project.summary.blocked ? 'blocked' : 'neutral',
        project.summary.blocked + ' needs review');
    }
    createProject(rail);
    const legend = el(rail, 'div', '', 'swarm-legend');
    heading(legend, 'Evidence policy');
    el(legend, 'p', 'A stored claim is not a reproduced observation. Source SHA-256 checks saved text integrity, not external origin. Failed and stale records remain visible.');
    el(legend, 'p', 'REA adaptation: exact source and requirement revisions, claim authority, observed / derived / inferred / unknown. Nothing from reverse-engineering workflows is executed here.');
    return rail;
  };
  const card = (column, project, item) => {
    const b = button(column, '', () => { selectedItem = item.id; render(); }, 'swarm-card');
    b.dataset.itemId = item.id;
    b.setAttribute('aria-pressed', String(item.id === selectedItem));
    const top = el(b, 'div', '', 'swarm-card-top');
    el(top, 'strong', item.title);
    pill(top, item.readiness, pretty(item.readiness));
    el(b, 'p', item.scope);
    const owner = project.workers.find(w => w.id === item.ownerId);
    const foot = el(b, 'div', '', 'swarm-card-foot');
    el(foot, 'span', owner ? owner.label : 'Unassigned');
    el(foot, 'span', 'r' + item.requirementRevision);
    if (item.dependsOn.length) el(b, 'small', '↳ ' + item.dependsOn.join(' · '), 'swarm-muted');
    if (item.unresolvedFailures?.length) pill(b, 'contradicted',
      item.unresolvedFailures.length + ' failed evidence');
  };
  const board = (root, project) => {
    const wrap = el(root, 'div', '', 'swarm-board-columns');
    for (const phase of phases) {
      const col = el(wrap, 'section', '', 'swarm-column');
      const items = project.items.filter(item => item.phase === phase);
      const head = el(col, 'header', '', 'swarm-column-title');
      el(head, 'h3', phaseLabel[phase]); el(head, 'span', String(items.length));
      if (!items.length) el(col, 'p', 'No items', 'swarm-column-empty');
      for (const item of items) card(col, project, item);
    }
  };
  const sourcePanel = (root, project) => {
    const details = el(root, 'details', '', 'swarm-disclosure');
    el(details, 'summary', 'Source records · ' + project.sources.length);
    const list = el(details, 'div', '', 'swarm-ledger');
    for (const source of project.sources) {
      const entry = el(list, 'article', '', 'swarm-ledger-row');
      el(entry, 'strong', source.id + ' · r' + source.revision);
      el(entry, 'small', source.reference || '(local note)', 'swarm-muted');
      el(entry, 'p', source.text);
      el(entry, 'small', 'SHA-256 ' + source.digest + ' · origin not authenticated', 'swarm-muted');
      for (const prior of source.history || []) {
        const previous = el(entry, 'details', '', 'swarm-revision');
        el(previous, 'summary', 'Previous source r' + prior.revision + ' · ' + labelDate(prior.supersededAt));
        el(previous, 'p', prior.text);
        el(previous, 'small', 'SHA-256 ' + prior.digest + ' · ' + (prior.reference || 'local note'), 'swarm-muted');
      }
    }
    const f = form(details, 'swarm-form', () => {
      const existing = project.sources.find(source => source.id === id.value);
      void mutate('record_source', { projectId: project.id,
        ...(existing ? { expectedSourceRevision: existing.revision } : { expectedProjectRevision: project.revision }),
        value: { id: id.value, text: content.value, reference: reference.value } });
    });
    const id = field(f, 'Source ID (same ID updates and revisions its content)', { required: true,
      placeholder: 'source_a' });
    const reference = field(f, 'Source reference or URL');
    const content = field(f, 'Recorded source content / exact summary', { tag: 'textarea', required: true, rows: 4 });
    submit(f, 'Record source revision');
  };
  const evidenceSection = (root, project, item) => {
    const panel = el(root, 'section', '', 'swarm-panel');
    heading(panel, 'Evidence & applicability', 'Claims remain reported until independently corroborated.');
    const line = el(panel, 'div', '', 'swarm-badge-row');
    pill(line, item.proof.assessment, item.proof.comparableObservedEvidence ?
      'Comparable claimed ' + item.verificationTarget + ' observation' : 'No comparable observed ' + item.verificationTarget);
    pill(line, 'neutral', 'Requirements r' + item.requirementRevision);
    if (item.staleEvidence.length) pill(line, 'stale', item.staleEvidence.length + ' stale');
    if (item.unresolvedFailures.length) pill(line, 'contradicted', item.unresolvedFailures.length + ' unresolved failures');
    const rows = el(panel, 'div', '', 'swarm-ledger');
    const all = [...item.applicableEvidence.map(e => ({ ...e, applicable: true })),
      ...item.staleEvidence.map(e => ({ ...e, applicable: false }))];
    if (!all.length) el(rows, 'p', 'No evidence for this item.', 'swarm-muted');
    for (const entry of all) {
      const card = el(rows, 'article', '', 'swarm-ledger-row');
      const caption = el(card, 'div', '', 'swarm-badge-row');
      el(caption, 'strong', entry.claim);
      pill(caption, entry.applicable ? entry.outcome : 'stale', entry.applicable ? entry.outcome : 'stale');
      pill(caption, entry.epistemic, entry.epistemic);
      pill(caption, entry.authority, entry.authority.replaceAll('_', ' '));
      el(card, 'p', entry.note || 'No interpretation supplied.');
      el(card, 'small', entry.id + ' · source ' + entry.sourceId + ' r' + entry.sourceRevision +
        ' · requirement r' + entry.requirementRevision + ' · ' + labelDate(entry.at), 'swarm-muted');
      el(card, 'small', 'Reported by ' + entry.reportedBy.label + '; origin not independently authenticated.', 'swarm-muted');
    }
    if (!project.sources.length) el(panel, 'p', 'Record a source before attaching evidence.', 'swarm-muted');
    const reportedEvidenceId = stableId('evidence').slice(0, 100);
    const f = form(panel, 'swarm-form swarm-two', () => {
      const source = project.sources.find(s => s.id === sourceId.value);
      if (!source) return notify('Choose a current source first.', true);
      return mutate('record_evidence', { projectId: project.id, itemId: item.id,
        value: { id: reportedEvidenceId, claim: claim.value, epistemic: epistemic.value,
          authority: authority.value, outcome: outcome.value,
          sourceId: source.id, sourceRevision: source.revision, requirementRevision: item.requirementRevision,
          note: note.value } });
    });
    const claim = field(f, 'Checkable claim', { required: true, placeholder: 'What was actually observed?' });
    const sourceId = field(f, 'Exact source revision', { tag: 'select',
      options: project.sources.map(s => [s.id, s.id + ' · r' + s.revision]) });
    const epistemic = field(f, 'Way of knowing', { tag: 'select', options:
      [['observed', 'Observed (reported)'], ['derived', 'Derived'], ['inferred', 'Inferred'], ['unknown', 'Unknown']] });
    const authority = field(f, 'Claimed authority', { tag: 'select', options:
      [['source', 'Source'], ['unit', 'Unit test'], ['integration', 'Integration'],
        ['packaged', 'Packaged runtime'], ['live_worker', 'Live worker'], ['external', 'External']] });
    const outcome = field(f, 'Outcome', { tag: 'select', options:
      [['pass', 'Pass (reported)'], ['fail', 'Fail (reported)'], ['unknown', 'Unknown']] });
    const note = field(f, 'Evidence / limitations', { tag: 'textarea', rows: 2 });
    const save = submit(f, 'Append evidence');
    save.disabled = !project.sources.length || waiting;
    if (item.unresolvedFailures.length) {
      const resolve = form(panel, 'swarm-form swarm-three', () => mutate('resolve_failure', {
        projectId: project.id, itemId: item.id,
        value: { evidenceId: old.value, replacementId: replacement.value, reason: rationale.value }
      }));
      const old = field(resolve, 'Unresolved failed evidence', { tag: 'select',
        options: item.unresolvedFailures.map(eid => [eid, eid]) });
      const replacement = field(resolve, 'Applicable passing replacement', { tag: 'select',
        options: item.applicableEvidence.filter(e => e.outcome === 'pass').map(e => [e.id, e.id]) });
      const rationale = field(resolve, 'Why the new evidence resolves this exact claim', { required: true });
      submit(resolve, 'Record resolution (retain failure)');
    }
  };
  const detailPanel = (root, project, item) => {
    const detail = el(root, 'aside', '', 'swarm-detail');
    if (!item) {
      el(detail, 'h2', 'Select an item');
      el(detail, 'p', 'Propose an item to record ownership, dependencies and evidence.', 'swarm-muted');
      return;
    }
    const title = el(detail, 'div', '', 'swarm-detail-heading');
    el(title, 'h2', item.title); pill(title, item.readiness, pretty(item.readiness));
    el(detail, 'p', item.scope, 'swarm-item-scope');
    const meta = el(detail, 'div', '', 'swarm-facts');
    const owner = project.workers.find(w => w.id === item.ownerId);
    for (const [k, v] of [['Phase', phaseLabel[item.phase]], ['Owner', owner?.label || 'Unassigned'],
      ['Dependencies', item.dependsOn.join(', ') || 'None'], ['Item revision', 'r' + item.revision],
      ['Requirement revision', 'r' + item.requirementRevision],
      ['Readiness decision', item.readyDecision?.disposition ?
        pretty(item.readyDecision.disposition) + ' at requirements r' + item.readyDecision.requirementRevision : 'None'],
      ['Integration', (item.integration?.status || 'not_started') +
        (item.integration?.reference ? ' · ' + item.integration.reference : '')],
      ['Completion current', item.completionCurrent ? 'Yes (recorded)' : 'No']]) {
      const row = el(meta, 'div'); el(row, 'strong', k); el(row, 'span', v);
    }
    const waiting = item.dependenciesWaiting || [];
    if (waiting.length) el(detail, 'p', 'Waiting for recorded completion and integration: ' + waiting.join(', '), 'swarm-warning');
    const editPanel = el(detail, 'details', '', 'swarm-disclosure');
    el(editPanel, 'summary', 'Edit scope, owner, requirements, dependencies');
    const edit = form(editPanel, 'swarm-form', () => mutate('edit_item',
      itemAction(item, { title: titleField.value, scope: scope.value, requirements: requirements.value,
        ownerId: ownerId.value || null, dependsOn: parseIds(depends.value), verificationTarget: verify.value })));
    const titleField = field(edit, 'Title', { value: item.title, required: true });
    const ownerId = field(edit, 'Owner', { tag: 'select', value: item.ownerId || '',
      options: [['', 'Unassigned'], ...project.workers.map(w => [w.id, w.label])] });
    const scope = field(edit, 'Scope', { tag: 'textarea', value: item.scope, required: true });
    const requirements = field(edit, 'Acceptance requirements', {
      tag: 'textarea', value: item.requirements, required: true });
    const depends = field(edit, 'Dependency IDs', { value: item.dependsOn.join(', ') });
    const verify = field(edit, 'Required evidence authority', { tag: 'select',
      value: item.verificationTarget,
      options: [['source', 'Source'], ['unit', 'Unit'], ['integration', 'Integration'],
        ['packaged', 'Packaged'], ['live_worker', 'Live worker'], ['external', 'External']] });
    submit(edit, 'Save scoped revision');
    const controls = el(detail, 'section', '', 'swarm-panel');
    heading(controls, 'Coordination controls', 'Each transition is recorded, never inferred from worker text.');
    if (item.phase !== 'completed') {
      const next = phases[phases.indexOf(item.phase) + 1];
      const f = form(controls, 'swarm-form', () => mutate('transition',
        itemAction(item, { phase: next, reference: reference.value, note: phaseNote.value })));
      el(f, 'p', 'Next: ' + phaseLabel[next], 'swarm-muted');
      const reference = field(f, 'External dispatch / integration reference (required for delivery)');
      const phaseNote = field(f, 'Coordination note');
      submit(f, 'Record ' + phaseLabel[next]);
    }
    const readyForm = form(controls, 'swarm-form', () => mutate('request_ready',
      itemAction(item, { note: requestNote.value })));
    const requestNote = field(readyForm, 'Worker-ready request · not approval', {
      required: true, value: item.readyRequest?.note || '',
      placeholder: 'State why the work can be reviewed and known limitations.' });
    submit(readyForm, 'Request readiness');
    const decisionForm = form(controls, 'swarm-form', () => mutate('decide_ready',
      itemAction(item, { disposition: decision.value, reason: decisionNote.value,
        evidenceIds: parseIds(decisionEvidence.value) })));
    const decision = field(decisionForm, 'Coordinator disposition', { tag: 'select',
      options: [['approved', 'Approved for integration (not verified delivery)'],
        ['not_ready', 'Not ready'], ['blocked', 'Blocked'], ['out_of_scope', 'Out of scope'],
        ['contradicted', 'Contradicted']] });
    const decisionEvidence = field(decisionForm, 'Applicable evidence IDs (comma separated)', {
      value: item.readyDecision?.evidenceIds?.join(', ') || '',
      placeholder: 'At least one passing ID to approve' });
    const decisionNote = field(decisionForm, 'Decision rationale', { required: true,
      value: item.readyDecision?.reason || '' });
    submit(decisionForm, 'Record coordinator decision');
    const integrate = form(controls, 'swarm-form', () => mutate('record_integration',
      itemAction(item, { status: disposition.value, reference: integrationRef.value, note: integrationNote.value })));
    const disposition = field(integrate, 'Integration record', { tag: 'select',
      options: [['proposed', 'Proposed integration'], ['recorded', 'Recorded (reported reference)'],
        ['rejected', 'Rejected integration']] });
    const integrationRef = field(integrate, 'Exact commit / PR / integration reference', {
      value: item.integration?.reference || '' });
    const integrationNote = field(integrate, 'Limitations / review notes', { value: item.integration?.note || '' });
    submit(integrate, 'Save integration record · no merge');
    sourcePanel(detail, project);
    evidenceSection(detail, project, item);
    const history = el(detail, 'details', '', 'swarm-disclosure');
    el(history, 'summary', 'Phase history · ' + item.phaseHistory.length);
    for (const phase of item.phaseHistory) {
      const row = el(history, 'p', phaseLabel[phase.phase] + ' · ' + labelDate(phase.at) +
        ' · by ' + phase.actor.label + (phase.reference ? ' · ' + phase.reference : ''),
        'swarm-muted');
      row.dataset.phase = phase.phase;
    }
    const revisions = el(detail, 'details', '', 'swarm-disclosure');
    el(revisions, 'summary', 'Previous requirement revisions · ' + (item.requirementHistory?.length || 0));
    for (const prior of item.requirementHistory || []) {
      const record = el(revisions, 'article', '', 'swarm-ledger-row');
      el(record, 'strong', 'Requirements r' + prior.revision + ' · superseded ' + labelDate(prior.supersededAt));
      el(record, 'p', prior.requirements);
      el(record, 'small', 'Scope: ' + prior.scope + ' · Owner: ' + (prior.ownerId || 'Unassigned') +
        ' · Dependencies: ' + (prior.dependsOn.join(', ') || 'None') +
        ' · Evidence authority: ' + prior.verificationTarget, 'swarm-muted');
    }
    const decisions = el(detail, 'details', '', 'swarm-disclosure');
    el(decisions, 'summary', 'Readiness request and decision history · ' + (item.readinessHistory?.length || 0));
    for (const record of item.readinessHistory || []) {
      const row = el(decisions, 'article', '', 'swarm-ledger-row');
      el(row, 'strong', (record.kind === 'request' ? 'Worker request' : 'Coordinator ' + record.disposition) +
        ' · requirements r' + record.requirementRevision);
      el(row, 'p', record.note || record.reason || 'No rationale recorded.');
      el(row, 'small', 'By ' + record.actor.label + ' · ' + labelDate(record.at) +
        (record.evidenceIds ? ' · Evidence ' + record.evidenceIds.join(', ') : ''), 'swarm-muted');
    }
    const integrations = el(detail, 'details', '', 'swarm-disclosure');
    el(integrations, 'summary', 'Integration record history · ' + (item.integrationHistory?.length || 0));
    for (const entry of item.integrationHistory || []) {
      const row = el(integrations, 'article', '', 'swarm-ledger-row');
      el(row, 'strong', entry.status + ' · requirements r' + entry.requirementRevision);
      el(row, 'p', (entry.reference || '(no external reference)') + (entry.note ? ' · ' + entry.note : ''));
      el(row, 'small', 'Recorded by ' + entry.actor.label + ' · ' + labelDate(entry.at) +
        ' · not independently verified', 'swarm-muted');
    }
  };
  const itemAction = (item, value) => ({ projectId: selectedProject, itemId: item.id,
    expectedItemRevision: item.revision, value });
  const content = (root, project) => {
    const head = el(root, 'section', '', 'swarm-project-header');
    const name = el(head, 'div');
    el(name, 'h2', project.name);
    el(name, 'p', project.objective);
    const numbers = el(head, 'div', '', 'swarm-stats');
    for (const [caption, number] of [['Scoped', project.summary.total],
      ['Ready (approved)', project.summary.ready], ['Needs review', project.summary.blocked]])
      { const block = el(numbers, 'span'); el(block, 'strong', String(number)); el(block, 'small', caption); }
    const edit = el(root, 'details', '', 'swarm-disclosure');
    el(edit, 'summary', 'Edit project identity & objective');
    const f = form(edit, 'swarm-form', () => mutate('edit_project', { projectId: project.id,
      expectedProjectRevision: project.revision, value: { name: projectName.value, objective: objective.value } }));
    const projectName = field(f, 'Name', { value: project.name, required: true });
    const objective = field(f, 'Objective', { tag: 'textarea', value: project.objective, required: true });
    submit(f, 'Save project revision');
    workerSection(root, project);
    createWorkItem(root, project);
    const section = el(root, 'section', '', 'swarm-board-section');
    heading(section, 'Coordination pipeline', 'Stages are explicit records. No assignment is automatically dispatched or executed.');
    board(section, project);
    const selected = project.items.find(item => item.id === selectedItem) || null;
    detailPanel(root, project, selected);
  };
  const render = () => {
    if (!active) return;
    mount.replaceChildren();
    const shell = el(mount, 'div', '', 'swarm-shell');
    const header = el(shell, 'header', '', 'swarm-top');
    const title = el(header, 'div', '', 'swarm-title');
    el(title, 'span', 'TEAM COORDINATION / EVIDENCE LEDGER', 'swarm-eyebrow');
    el(title, 'h1', 'Swarm');
    el(title, 'p', 'Project management across human and agent owners. Not recursive task Planning.');
    const actions = el(header, 'div', '', 'swarm-actions');
    button(actions, 'Refresh', () => void refresh(true), 'swarm-refresh');
    el(actions, 'span', data ? data.projects.length + ' projects' : 'Connecting…', 'swarm-muted');
    if (notice || remoteChanged) {
      const status = el(shell, 'div', '', remoteChanged ? 'swarm-warning' : 'swarm-notice');
      status.setAttribute('role', 'status');
      el(status, 'span', remoteChanged ? 'New Swarm changes are available. Refresh without losing your draft.' : notice);
      if (remoteChanged) button(status, 'Refresh now', () => void refresh(true));
    }
    if (!data) { el(shell, 'p', 'Loading saved coordination records…', 'swarm-empty'); return; }
    const layout = el(shell, 'div', '', 'swarm-layout');
    projectRail(layout, data.projects);
    const main = el(layout, 'main', '', 'swarm-main');
    const project = data.projects.find(value => value.id === selectedProject);
    if (project) content(main, project);
    else {
      const blank = el(main, 'section', '', 'swarm-empty');
      el(blank, 'h2', 'Build a coordinated project');
      el(blank, 'p', 'Define the outcome, register workers, assign scoped work and review evidence by revision. Nothing is launched by creating a project.');
    }
  };
  const off = events?.subscribe?.(receipt => {
    if (receipt.type !== 'swarm.updated' || !active) return;
    const input = get(mount, 'input:focus, textarea:focus, select:focus');
    const dirty = [...mount.querySelectorAll('.swarm-input')].some(field => field.value !== field.dataset.initialValue);
    if (input || dirty || waiting) {
      remoteChanged = true;
      const shell = get(mount, '.swarm-shell');
      if (shell) {
        let status = get(shell, '.swarm-notice, .swarm-warning');
        if (!status) {
          status = el(shell, 'div', '', 'swarm-warning');
          status.setAttribute('role', 'status');
          get(shell, '.swarm-top')?.insertAdjacentElement('afterend', status);
        }
        status.className = 'swarm-warning';
        status.textContent = 'New Swarm updates are available; the unfinished form is preserved. Refresh once you have saved or copied your draft.';
      }
      return;
    }
    void refresh(true);
  }) || (() => {});
  return {
    enter() { active = true; render(); void refresh(); },
    leave() { active = false; },
    updateStatus() {},
    destroy() { off(); },
    openProjectId(id) { selectedProject = id; if (active) void refresh(true); },
  };
}
