import { text, stableId } from '../core/dom.mjs';
import {organizationOf,folderPath,inFolder,taskFolder,workbookRows,evidenceSummary,runtimeSummary} from './swarm-workbook.mjs';

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

export function createSwarmWorkspace({ mount, api, events, notify = () => {}, onNavigate } = {}) {
  let data = null, active = false, selectedProject = null, selectedItem = null, waiting = false;
  let sequence = 0, notice = '', remoteChanged = false, inspectingItem = false;
  let projectView = 'active';

  let selectedFolder=':all', phaseFilter='all', searchQuery='', returnProject=null, detailTab='overview';
  const org = () => organizationOf(data);
  const creationFiling = () => selectedFolder===':all'?{}:{folderId:selectedFolder===':unfiled'?null:selectedFolder};
  const folderOptions = () => [['','Unfiled'],...org().folders.map(f=>[f.id,folderPath(org(),f.id)])];
  const organize = (action,value,rest={}) => mutate(action,{expectedOrganizationRevision:drafts.get(renderedContext)?.organizationRevision ?? org().revision,...rest,value});
  const folderIcon = parent => {
    const icon=el(parent,'span','','swarm-folder-icon');icon.setAttribute('aria-hidden','true');return icon;
  };
  const chooseFolder = value => {captureDraft();selectedFolder=value;selectedProject=null;inspectingItem=false;notice='';render();};
  const folderControls = rail => {
    const panel=el(rail,'details','','swarm-disclosure swarm-folder-tools');el(panel,'summary','Manage folders');
    const createKey=JSON.stringify([selectedFolder,selectedProject]);
    if(!folderCreateIds.has(createKey))folderCreateIds.set(createKey,stableId('folder').slice(0,100));
    const proposedFolderId=folderCreateIds.get(createKey);
    const f=form(panel,'swarm-form',()=>organize('create_folder',{id:proposedFolderId,name:name.value,parentId:parent.value||null}));
    const name=field(f,'New folder name',{required:true});
    const parent=field(f,'Inside folder',{tag:'select',options:[['','Top level'],...org().folders.map(x=>[x.id,folderPath(org(),x.id)])],value:org().folders.some(x=>x.id===selectedFolder)?selectedFolder:''});
    submit(f,'Create folder');
    const current=org().folders.find(x=>x.id===selectedFolder);
    if(current){
      const edit=form(panel,'swarm-form',()=>organize('edit_folder',{id:current.id,name:label.value,parentId:move.value||null}));
      const label=field(edit,'Folder name',{required:true,value:current.name});
      const move=field(edit,'Move folder inside',{tag:'select',value:current.parentId||'',options:[['','Top level'],...org().folders.filter(x=>!inFolder(org(),x.id,current.id)).map(x=>[x.id,folderPath(org(),x.id)])]});
      submit(edit,'Save folder');
      button(panel,'Remove folder, keep contents',()=>void organize('remove_folder',{id:current.id}),'swarm-folder-remove');
      el(panel,'small','Contents and subfolders move to its parent. Work and evidence are retained.','swarm-muted');
    }
  };

  const lifecycle = project => project.lifecycle || 'active';
  const visibleProjects = () => (data?.projects || []).filter(p => lifecycle(p) === projectView);
  const drafts = new Map();
  const folderCreateIds = new Map();
  let renderedContext = null, renderedProject = null, submittingForm = null, renderedOrgRevision = 0;
  const draftContext = () => JSON.stringify([selectedFolder, selectedProject, inspectingItem ? selectedItem : 'board']);
  const draftFields = () => {
    const seen = new Map();
    return [...mount.querySelectorAll('.swarm-input')].filter(node=>node.dataset.swarmTransient!=='true').map(node => {
      const label = node.parentElement.querySelector('.swarm-field-label')?.textContent || '';
      const count = seen.get(label) || 0; seen.set(label, count + 1);
      return { node, key: label + ':' + count };
    });
  };
  const captureDraft = () => {
    if (!renderedContext || renderedProject?.lifecycle === 'trashed') return;
    const fields = draftFields().filter(({ node }) => node.value !== node.dataset.initialValue)
      .map(({ node, key }) => [key, node.value]);
    const open = [...mount.querySelectorAll('details')].filter(node => node.open)
      .map(node => node.querySelector('summary')?.textContent || '');
    if (fields.length) drafts.set(renderedContext, { fields, open, project: renderedProject, organizationRevision: renderedOrgRevision });
    else drafts.delete(renderedContext);
  };
  const restoreDraft = () => {
    renderedContext = draftContext();
    const draft = drafts.get(renderedContext); renderedOrgRevision=draft?.organizationRevision ?? org().revision; if (!draft) return;
    const values = new Map(draft.fields);
    for (const { node, key } of draftFields()) if (values.has(key)) node.value = values.get(key);
    for (const detail of mount.querySelectorAll('details'))
      if (draft.open.includes(detail.querySelector('summary')?.textContent || '')) detail.open = true;
  };
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
      if (!waiting) { submittingForm = result; try { void submit(); } finally { submittingForm = null; } }
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
    const submittedContext = renderedContext;
    const submittedFields = draftFields().filter(({node}) => submittingForm?.contains(node))
      .map(({node,key}) => [key,node.value]);
    waiting = true; remoteChanged = false;
    // Reuse the same mutation ID after an uncertain response; never duplicate a saved effect.
    if(action==='create_folder' && retryCandidate){const prior=JSON.parse(retryCandidate.payload);if(prior.action===action && JSON.stringify(prior.value)===JSON.stringify(rest.value)){const {action:_action,...original}=prior;rest=original;}}
    const payload = JSON.stringify({ action, ...rest });
    const mutationId = retryCandidate?.payload === payload ? retryCandidate.mutationId : stableId('swarm');
    retryCandidate = { payload, mutationId };
    let failed = false;
    try {
      const result = await api('/api/swarm/actions', 'POST',
        { mutationId, action, ...rest });
      retryCandidate = null;
      if(action==='create_folder')for(const [key,id]of folderCreateIds)if(id===rest.value?.id)folderCreateIds.delete(key);
      captureDraft();
      const submittedValues = new Map(submittedFields);
      const savedDraft = drafts.get(submittedContext);
      if (savedDraft) {
        savedDraft.fields = savedDraft.fields.filter(([key,value]) => !submittedValues.has(key) || submittedValues.get(key) !== value);
        if (!savedDraft.fields.length) drafts.delete(submittedContext);
      }
      if (renderedContext === submittedContext) for (const {node,key} of draftFields()) {
        if (submittedValues.has(key) && submittedValues.get(key) === node.value) node.dataset.initialValue = node.value;
      }
      if (draftContext() === submittedContext) {
        if (result.project) selectedProject = result.project.id;
        if (result.project?.items?.length && !selectedItem) selectedItem = result.project.items.at(-1).id;
      }
      notice = 'Coordination record saved. No worker action or delivery was implied.';
      notify(action.replaceAll('_', ' ') + ' saved.');
      await refresh(true);
    } catch (error) {
      failed = true; remoteChanged = true;
      if(error?.code==='SWARM_REVISION_CONFLICT')retryCandidate=null;
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
      if (selectedProject && !visibleProjects().some(p => p.id === selectedProject)) selectedProject = null;
      if (![':all',':unfiled'].includes(selectedFolder) && !org().folders.some(f=>f.id===selectedFolder)) selectedFolder=':all';
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
    inspectingItem = false;
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
      value: { id: proposedId, name: name.value, objective: objective.value, ...creationFiling() }
    }));
    const name = field(action, 'Project name', { required: true, placeholder: 'Launch readiness' });
    const objective = field(action, 'Outcome and boundaries', { tag: 'textarea', required: true,
      placeholder: 'What should this project accomplish, and what should it leave out?' });
    submit(action, 'Create project');
  };
  const workerSection = (root, project) => {
    const panel = el(root, 'section', '', 'swarm-panel');
    heading(panel, 'Workers & ownership', 'List who owns each piece of work. Adding a team member does not start an agent. Connection details are optional and only needed when linking an agent.');
    const list = el(panel, 'div', '', 'swarm-worker-list');
    for (const worker of project.workers) {
      const line = el(list, 'article', '', 'swarm-worker');
      pill(line, worker.kind, worker.kind);
      el(line, 'strong', worker.label);
      el(line, 'small', worker.id, 'swarm-id');
      el(line, 'p', worker.scope);
      el(line, 'span', worker.actorId ? worker.actorId.startsWith('native_')
        ? 'Bound to native task/node identity ' + worker.actorId + ' (not live-status proof)'
        : 'Bound to shared OAuth grant ' + worker.actorId + ' (not a chat identity)'
      : 'Not linked to an agent connection', 'swarm-muted');
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
    const scope = field(f, 'Responsibilities and limits', { tag: 'textarea', required: true,
      placeholder: 'What this person or agent owns, and any limits' });
    const actor = field(f, 'Agent connection ID (optional, advanced)', {
      placeholder: 'Exact self.id from native relay_swarm_read or OAuth Swarm read; do not invent' });
    submit(f, 'Register worker');
  };
  const createWorkItem = (root, project) => {
    const panel = el(root, 'details', '', 'swarm-disclosure');
    el(panel, 'summary', '+ Propose work item');
    const proposedItemId = stableId('item').slice(0, 100);
    const f = form(panel, 'swarm-form swarm-two', () => mutate('propose_item', {
      projectId: project.id, expectedProjectRevision: project.revision,
      value: { id: proposedItemId, title: title.value, scope: scope.value, ...creationFiling(),
        requirements: requirements.value, ownerId: owner.value || null,
        dependsOn: parseIds(deps.value), verificationTarget: verify.value }
    }));
    const title = field(f, 'Title', { required: true, placeholder: 'Research options or prepare a deliverable' });
    const owner = field(f, 'Owner', { tag: 'select', options: [['', 'Unassigned'],
      ...project.workers.map(w => [w.id, w.label])] });
    const scope = field(f, 'Work to cover', { tag: 'textarea', required: true, placeholder: 'What this item should cover, and what is outside it' });
    const requirements = field(f, 'Done when', { tag: 'textarea', required: true,
      placeholder: 'What has to be demonstrated and what remains unknown?' });
    const deps = field(f, 'Dependency IDs (comma-separated)', {
      placeholder: 'Optional prior work item IDs' });
    const verify = field(f, 'How the result will be checked', { tag: 'select', options:
      [['source', 'Source review'], ['unit', 'Unit test'], ['integration', 'Integration'],
        ['packaged', 'Packaged runtime'], ['live_worker', 'Live worker'], ['external', 'External']] });
    verify.value = 'integration'; verify.dataset.initialValue = verify.value;
    submit(f, 'Propose item (no dispatch)');
  };
  const projectRail = (root, projects) => {
    const rail=el(root,'aside','','swarm-rail');
    button(rail,'Close folders',()=>{get(mount,'.swarm-shell').classList.remove('swarm-folders-open');get(mount,'.swarm-projects-jump')?.focus();},'swarm-folder-close');
    rail.addEventListener('keydown',event=>{if(event.key==='Escape'){get(mount,'.swarm-shell').classList.remove('swarm-folders-open');get(mount,'.swarm-projects-jump')?.focus();}});
    heading(rail,'Folders','Group related workflows and tasks.');
    const views=el(rail,'nav','','swarm-actions swarm-project-views');views.setAttribute('aria-label','Project views');
    for(const [value,label] of [['active','Active'],['archived','Archive'],['trashed','Trash']]){
      const b=button(views,label,()=>{captureDraft();projectView=value;selectedProject=null;inspectingItem=false;render();});
      b.setAttribute('aria-pressed',String(projectView===value));
    }
    const tree=el(rail,'nav','','swarm-folder-tree');tree.setAttribute('aria-label','Swarm folders');
    const entry=(id,label,depth)=>{
      const b=button(tree,'',()=>chooseFolder(id),'swarm-folder-select');b.dataset.folderId=id;b.style.setProperty('--folder-depth',String(depth));
      b.setAttribute('aria-pressed',String(selectedFolder===id));folderIcon(b);el(b,'span',label);
      const count=workbookRows(data,{folder:id,lifecycle:projectView}).length;el(b,'small',String(count));
    };
    entry(':all','All workflows',0);entry(':unfiled','Unfiled',0);
    const visit=(parent,depth)=>{for(const folder of org().folders.filter(f=>(f.parentId||null)===parent).sort((a,b)=>a.name.localeCompare(b.name))){entry(folder.id,folder.name,depth);visit(folder.id,depth+1);}};
    visit(null,0);folderControls(rail);
    const workflows=el(rail,'section','','swarm-workflow-list');heading(workflows,'Workflows / projects','Independent workbooks, not a single global queue.');
    const all=button(workflows,'All task rows',()=>{captureDraft();selectedProject=null;inspectingItem=false;render();},'swarm-project-select');
    all.setAttribute('aria-pressed',String(!selectedProject));
    for(const project of projects){
      if(!inFolder(org(),org().projectFolders[project.id]||null,selectedFolder)&&!workbookRows(data,{folder:selectedFolder,projectId:project.id,lifecycle:projectView}).length)continue;
      const b=button(workflows,'',()=>changeProject(project.id),'swarm-project-select');b.dataset.projectId=project.id;
      b.setAttribute('aria-pressed',String(selectedProject===project.id));el(b,'strong',project.name);
      el(b,'small',project.items.length+' tasks · '+project.items.filter(i=>i.nativeLaunch&&i.nativeLaunch.applicable!==false&&i.nativeLaunch.state!=='settled').length+' open launch records');
    }
    if (projectView === 'active' && projects.length) createProject(rail);
    const legend=el(rail,'details','','swarm-legend');el(legend,'summary','What these states mean');
    el(legend,'p','Stage, runtime and evidence are separate. Filing a task or recording a stage does not run a worker.');
    el(legend,'p','Observed reports, inferences, stale proof and failures remain distinct. Worker-ready is not coordinator approval.');
    return rail;
  };
  const board = (root, project=null) => {
    const filters=el(root,'div','','swarm-sheet-filters');
    const query=field(filters,'Find tasks',{value:searchQuery,placeholder:'Task, workflow or owner'});
    query.dataset.swarmTransient='true';query.classList.add('swarm-sheet-query');query.addEventListener('input',()=>{searchQuery=query.value;draw();});
    const stage=field(filters,'Stage',{tag:'select',value:phaseFilter,options:[['all','All stages'],...phases.map(p=>[p,phaseLabel[p]])]});
    stage.dataset.swarmTransient='true';stage.addEventListener('change',()=>{phaseFilter=stage.value;draw();});
    const region=el(root,'div','','swarm-sheet-region');region.tabIndex=0;region.setAttribute('role','region');region.setAttribute('aria-label','Workflow tasks, scroll horizontally for more columns');
    const draw=()=>{
      region.replaceChildren();const rows=workbookRows(data,{folder:selectedFolder,projectId:project?.id||null,phase:phaseFilter,query:searchQuery,lifecycle:projectView});
      const table=el(region,'table','','swarm-sheet');const caption=el(table,'caption',rows.length+' task'+(rows.length===1?'':'s')+' · stages are recorded; execution is shown separately');
      const head=el(table,'thead'),hr=el(head,'tr');for(const label of ['Task','Workflow / project','Stage','Owner','Runtime','Evidence','Review']){const th=el(hr,'th',label);th.scope='col';}
      const body=el(table,'tbody');
      for(const {project:p,item,folderId} of rows){
        const tr=el(body,'tr');tr.dataset.itemId=item.id;tr.dataset.projectId=p.id;
        const cell=el(tr,'td');const open=button(cell,item.title,()=>{returnProject=selectedProject;selectedProject=p.id;selectedItem=item.id;detailTab='overview';inspectingItem = true; render();const title=get(mount,'.swarm-detail-heading h2');if(title){title.tabIndex=-1;title.focus({ preventScroll: true });}},'swarm-card swarm-task-link');
        open.dataset.itemId=item.id;open.dataset.projectId=p.id;el(cell,'small',folderPath(org(),folderId),'swarm-task-folder');
        el(tr,'td',p.name);pill(el(tr,'td'),item.phase,phaseLabel[item.phase]);el(tr,'td',p.workers.find(w=>w.id===item.ownerId)?.label||'Unassigned');
        el(tr,'td',runtimeSummary(item),'swarm-runtime-cell');const proof=evidenceSummary(item),proofCell=el(tr,'td');pill(proofCell,proof.state,proof.label);if(item.staleEvidence?.length)el(proofCell,'small',item.staleEvidence.length+' stale history');
        const review=el(tr,'td');el(review,'span',pretty(item.readiness));if(item.readyRequest&&!item.readyDecision)el(review,'small','Worker-ready only');
      }
      if(!rows.length){const row=el(body,'tr'),cell=el(row,'td','No tasks match this folder and filter.');cell.colSpan=7;}
    };draw();
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
    const tabs=el(detail,'nav','','swarm-detail-tabs');tabs.setAttribute('aria-label','Task detail sections');
    const pages={};for(const key of ['overview','evidence','coordination','runtime','history']){pages[key]=el(detail,'section','','swarm-detail-page');pages[key].dataset.detailTab=key;}
    const showTab=key=>{detailTab=key;for(const [name,page]of Object.entries(pages))page.hidden=name!==key;for(const node of tabs.querySelectorAll('button'))node.setAttribute('aria-pressed',String(node.dataset.section===key));};
    for(const [key,label]of [['overview','Summary'],['evidence','Evidence'],['coordination','Progress'],['runtime','Runtime'],['history','History']]){const b=button(tabs,label,()=>showTab(key));b.dataset.section=key;}
    showTab(detailTab);
    const summary=pages.overview;
    const known=evidenceSummary(item);const knowledge=el(summary,'div','','swarm-badge-row');pill(knowledge,known.state,known.label);
    el(summary,'p',item.requirements,'swarm-task-requirements');
    el(summary,'p','Worker-ready is a request. Coordinator approval, runtime results and evidence applicability are separate.','swarm-muted');
    const filing=form(summary,'swarm-form swarm-task-filing',()=>organize('file_item',{folderId:filed.value||null},{projectId:project.id,itemId:item.id}));
    const filed=field(filing,'Task folder',{tag:'select',value:taskFolder(org(),project,item)||'',options:folderOptions()});submit(filing,'Move task');
    const meta = el(summary, 'div', '', 'swarm-facts');
    const owner = project.workers.find(w => w.id === item.ownerId);
    for (const [k, v] of [['Phase', phaseLabel[item.phase]], ['Owner', owner?.label || 'Unassigned'],
      ['Dependencies', item.dependsOn.join(', ') || 'None'], ['Item revision', 'r' + item.revision],
      ['Requirement revision', 'r' + item.requirementRevision],
      ['Readiness decision', item.readyDecision?.disposition ?
        pretty(item.readyDecision.disposition) + ' at requirements r' + item.readyDecision.requirementRevision : 'None'],
      ['Integration', pretty(item.integration?.status || 'not_started') +
        (item.integration?.reference ? ' · ' + item.integration.reference : '')],
      ['Completion current', item.completionCurrent ? 'Yes (recorded)' : 'No']]) {
      const row = el(meta, 'div'); el(row, 'strong', k); el(row, 'span', v);
    }
    const waiting = item.dependenciesWaiting || [];
    if (waiting.length) el(summary, 'p', 'Waiting for recorded completion and integration: ' + waiting.join(', '), 'swarm-warning');
    const nativeLaunches = (project.nativeLaunches || []).filter(launch => launch.itemId === item.id);
    if (nativeLaunches.length) {
      const section = el(pages.runtime, 'section', '', 'swarm-panel');
      heading(section, 'Host-launched native workers',
        'A launch reservation and durable dispatch authorization are NOT proof of a provider call. Host runtime.runAgent invocation, worker runtime results, assignment acknowledgments, and accepted work are separate observations. No remote-provider or external-work efficacy is certified.');
      for (const launch of nativeLaunches) {
        const row = el(section, 'article', '', 'swarm-ledger-row');
        pill(row, launch.state, launch.state === 'settled'
          ? 'Runtime ' + (launch.result?.status || 'unknown') + ' (not work proof)'
          : launch.state === 'provider_attempted' ? 'Host dispatch authorized; model call not verified'
            : 'Reserved before provider invocation');
        el(row, 'strong', launch.id);
        el(row, 'p', 'Native task ' + launch.assignedTaskId + ' · worker ' + launch.workerActorId
          + ' · requirements r' + launch.requirementRevision);
        el(row, 'small', 'Reserved ' + labelDate(launch.reservedAt)
          + (launch.providerDispatchAttemptedAt
            ? ' · durable dispatch fence ' + labelDate(launch.providerDispatchAttemptedAt)
            : ' · no recorded dispatch authorization')
          + (launch.result?.recordedAt
            ? ' · runtime result ' + labelDate(launch.result.recordedAt)
            : ' · runtime result unknown'), 'swarm-muted');
        if (launch.result)
          el(row, 'small', 'Host runtime.runAgent call: '
            + (launch.result.hostRunAgentCallAttempted === true ? 'attempted'
              : launch.result.hostRunAgentCallAttempted === false ? 'NOT called'
                : 'unknown (no host call evidence)')
            + ' · remote provider invocation: NOT verified'
            + ' · worker result: ' + (launch.result.status || 'unknown'), 'swarm-muted');
        el(row, 'small', 'Exact assignment SHA-256 ' + launch.assignmentDigest
          + ' · no automatic replay; result and acknowledgment are not work acceptance.', 'swarm-muted');
      }
      if (item.nativeLaunch?.applicable === false)
        el(section, 'p', 'This launch is stale against current requirements/owner. Its previous runtime status is retained, not current proof.', 'swarm-warning');
    }
    const nativeReceipts = (project.nativeDeliveries || []).filter(receipt => receipt.itemId === item.id);
    if (nativeReceipts.length) {
      const section = el(pages.runtime, 'section', '', 'swarm-panel');
      heading(section, 'Native engine handoff',
        'Host-prepared assignment response is not worker acknowledgment. A separately observed token echo acknowledges receipt, never work execution or a release.');
      for (const receipt of nativeReceipts) {
        const row = el(section, 'article', '', 'swarm-ledger-row');
        pill(row, receipt.state, receipt.state === 'acknowledged'
          ? 'Acknowledged by native callback' : 'Response prepared only');
        el(row, 'strong', receipt.id);
        el(row, 'p', 'Requirements r' + receipt.requirementRevision
          + ' · native identity ' + receipt.actorId);
        el(row, 'small', 'Prepared ' + labelDate(receipt.preparedAt)
          + (receipt.acknowledgedAt ? ' · acknowledged ' + labelDate(receipt.acknowledgedAt) : ' · acknowledgment not observed'),
          'swarm-muted');
        el(row, 'small', 'Assignment SHA-256 ' + receipt.assignmentDigest
          + ' · runtime source ' + receipt.originatingRunId
          + ' · does NOT establish provider/model efficacy, external delivery or work completion.', 'swarm-muted');
      }
      if (item.nativeHandoff?.applicable === false)
        el(section, 'p', 'Latest native handoff is stale for current scope or requirements. Do not reuse its acknowledgment as current proof.', 'swarm-warning');
    }
    if (!nativeLaunches.length && !nativeReceipts.length) el(pages.runtime,'p','No native launch or handoff is recorded for this task. A stage change does not start execution.','swarm-muted');
    const editPanel = el(summary, 'details', '', 'swarm-disclosure');
    el(editPanel, 'summary', 'Edit work, owner, completion criteria and dependencies');
    const edit = form(editPanel, 'swarm-form', () => mutate('edit_item',
      itemAction(item, { title: titleField.value, scope: scope.value, requirements: requirements.value,
        ownerId: ownerId.value || null, dependsOn: parseIds(depends.value), verificationTarget: verify.value })));
    const titleField = field(edit, 'Title', { value: item.title, required: true });
    const ownerId = field(edit, 'Owner', { tag: 'select', value: item.ownerId || '',
      options: [['', 'Unassigned'], ...project.workers.map(w => [w.id, w.label])] });
    const scope = field(edit, 'Work to cover', { tag: 'textarea', value: item.scope, required: true });
    const requirements = field(edit, 'Done when', {
      tag: 'textarea', value: item.requirements, required: true });
    const depends = field(edit, 'Dependency IDs', { value: item.dependsOn.join(', ') });
    const verify = field(edit, 'Required evidence authority', { tag: 'select',
      value: item.verificationTarget,
      options: [['source', 'Source'], ['unit', 'Unit'], ['integration', 'Integration'],
        ['packaged', 'Packaged'], ['live_worker', 'Live worker'], ['external', 'External']] });
    submit(edit, 'Save work item');
    const controls = el(pages.coordination, 'section', '', 'swarm-panel');
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
    sourcePanel(pages.evidence, project);
    evidenceSection(pages.evidence, project, item);
    const history = el(pages.history, 'details', '', 'swarm-disclosure');
    el(history, 'summary', 'Phase history · ' + item.phaseHistory.length);
    for (const phase of item.phaseHistory) {
      const row = el(history, 'p', phaseLabel[phase.phase] + ' · ' + labelDate(phase.at) +
        ' · by ' + phase.actor.label + (phase.reference ? ' · ' + phase.reference : ''),
        'swarm-muted');
      row.dataset.phase = phase.phase;
    }
    const revisions = el(pages.history, 'details', '', 'swarm-disclosure');
    el(revisions, 'summary', 'Previous requirement revisions · ' + (item.requirementHistory?.length || 0));
    for (const prior of item.requirementHistory || []) {
      const record = el(revisions, 'article', '', 'swarm-ledger-row');
      el(record, 'strong', 'Requirements r' + prior.revision + ' · superseded ' + labelDate(prior.supersededAt));
      el(record, 'p', prior.requirements);
      el(record, 'small', 'Scope: ' + prior.scope + ' · Owner: ' + (prior.ownerId || 'Unassigned') +
        ' · Dependencies: ' + (prior.dependsOn.join(', ') || 'None') +
        ' · Evidence authority: ' + prior.verificationTarget, 'swarm-muted');
    }
    const decisions = el(pages.history, 'details', '', 'swarm-disclosure');
    el(decisions, 'summary', 'Readiness request and decision history · ' + (item.readinessHistory?.length || 0));
    for (const record of item.readinessHistory || []) {
      const row = el(decisions, 'article', '', 'swarm-ledger-row');
      el(row, 'strong', (record.kind === 'request' ? 'Worker request' : 'Coordinator ' + record.disposition) +
        ' · requirements r' + record.requirementRevision);
      el(row, 'p', record.note || record.reason || 'No rationale recorded.');
      el(row, 'small', 'By ' + record.actor.label + ' · ' + labelDate(record.at) +
        (record.evidenceIds ? ' · Evidence ' + record.evidenceIds.join(', ') : ''), 'swarm-muted');
    }
    const integrations = el(pages.history, 'details', '', 'swarm-disclosure');
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
    if (inspectingItem && lifecycle(project)!=='trashed') {
      const selected = project.items.find(item => item.id === selectedItem);
      if (selected) {
        const back = () => {
          inspectingItem = false; selectedProject=returnProject; render();
          const original = [...mount.querySelectorAll('.swarm-card')].find(node => node.dataset.itemId === selectedItem && node.dataset.projectId === project.id);
          if (original) { original.focus(); original.scrollIntoView({ block: 'nearest' }); }
        };
        button(root, 'Back to task sheet', back, 'swarm-back');
        root.addEventListener('keydown', event => {
          if (event.key === 'Escape' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName)) {
            event.preventDefault(); back();
          }
        });
        detailPanel(root, project, selected);
        return;
      }
      inspectingItem = false;
    }
    const head = el(root, 'section', '', 'swarm-project-header');
    const name = el(head, 'div');
    el(name, 'h2', project.name);
    el(name, 'p', project.objective);
    const lifecycleActions = el(name, 'div', '', 'swarm-actions swarm-project-actions');
    const move = action => void mutate(action, { projectId: project.id,
      expectedProjectRevision: data.projects.find(p => p.id === project.id)?.revision ?? project.revision, value: {} });
    if (lifecycle(project) !== 'active') button(lifecycleActions, 'Restore project', () => move('restore_project'));
    if (lifecycle(project) === 'active') button(lifecycleActions, 'Archive project', () => move('archive_project'));
    if (lifecycle(project) !== 'trashed') button(lifecycleActions, 'Delete project', () => move('trash_project'));
    el(name, 'small', 'Delete moves this project to Trash. Restore keeps its work and history. Neither action stops running workers.', 'swarm-muted');
    if (lifecycle(project) === 'trashed') {
      el(root, 'p', 'This project is in Trash. Restore it to resume editing. Its workers, work items and records are preserved.', 'swarm-notice');
      return;
    }
    const numbers = el(head, 'div', '', 'swarm-stats');
    for (const [caption, number] of [['Work items', project.summary.total],
      ['Ready (approved)', project.summary.ready], ['Needs review', project.summary.blocked]])
      { const block = el(numbers, 'span'); el(block, 'strong', String(number)); el(block, 'small', caption); }
    const setup = el(root, 'details', '', 'swarm-disclosure swarm-project-setup');
    el(setup, 'summary', 'Project settings & team');
    const edit = el(setup, 'details', '', 'swarm-disclosure');
    el(edit, 'summary', 'Edit project identity & objective');
    button(lifecycleActions, 'Edit project', () => {
      setup.open = true; edit.open = true;
      edit.scrollIntoView({ block: 'nearest' }); get(edit, 'input')?.focus();
    });
    const f = form(edit, 'swarm-form', () => mutate('edit_project', { projectId: project.id,
      expectedProjectRevision: project.revision, value: { name: projectName.value, objective: objective.value } }));
    const projectName = field(f, 'Name', { value: project.name, required: true });
    const objective = field(f, 'Objective', { tag: 'textarea', value: project.objective, required: true });
    submit(f, 'Save project revision');
    const filing=form(setup,'swarm-form',()=>organize('file_project',{folderId:folder.value||null},{projectId:project.id}));
    const folder=field(filing,'Workflow / project folder',{tag:'select',value:org().projectFolders[project.id]||'',options:folderOptions()});
    submit(filing,'Move workflow / project');el(filing,'small','Tasks without individual filing follow their project. Evidence and running work do not change.','swarm-muted');
    workerSection(setup, project);
    createWorkItem(root, project);
    const section = el(root, 'section', '', 'swarm-board-section');
    heading(section, 'Task sheet', 'Each workflow progresses independently. Stage records do not dispatch workers.');
    board(section, project);
    root.append(setup);

  };
  const render = () => {
    if (!active) return;
    captureDraft();
    mount.replaceChildren();
    const shell = el(mount, 'div', '', 'swarm-shell');
    const header = el(shell, 'header', '', 'swarm-top');
    const title = el(header, 'div', '', 'swarm-title');
    el(title, 'span', 'PROJECT COORDINATION', 'swarm-eyebrow');
    el(title, 'h1', 'Swarm');
    el(title, 'p', 'Organize concurrent workflows in folders. Track tasks, runtime and evidence separately.');
    const actions = el(header, 'div', '', 'swarm-actions');
    button(actions, 'Folders', () => {
      get(mount,'.swarm-shell').classList.toggle('swarm-folders-open');
      const rail = get(mount, '.swarm-rail');
      rail.tabIndex = -1; rail.focus(); rail.scrollIntoView({ block: 'start' });
    }, 'swarm-projects-jump');
    button(actions, 'Refresh', () => void refresh(true), 'swarm-refresh');
    if(typeof onNavigate==='function'){
      const reusable=button(actions, 'Reusable workflows', () => onNavigate('workflows'), 'swarm-workflows');
      reusable.title='Edit reusable agent stages, run them now, or schedule them. Separate from this project board.';
    }
    el(actions, 'span', data ? data.projects.length + (data.projects.length === 1 ? ' project' : ' projects') : 'Connecting…', 'swarm-muted');
    if (notice || remoteChanged) {
      const status = el(shell, 'div', '', remoteChanged ? 'swarm-warning' : 'swarm-notice');
      status.setAttribute('role', 'status');
      el(status, 'span', remoteChanged ? 'New Swarm changes are available. Refresh without losing your draft.' : notice);
      if (remoteChanged) button(status, 'Refresh now', () => void refresh(true));
    }
    if (!data) { el(shell, 'p', 'Loading saved coordination records…', 'swarm-empty'); return; }
    const layout = el(shell, 'div', '', 'swarm-layout');
    projectRail(layout, visibleProjects());
    const main = el(layout, 'main', '', 'swarm-main');
    const currentProject = visibleProjects().find(value => value.id === selectedProject);
    const retainedDraft = drafts.get(draftContext());
    const project = retainedDraft?.project && currentProject
      ? { ...retainedDraft.project, lifecycle: lifecycle(currentProject) } : currentProject;
    renderedProject = project || null;
    if (retainedDraft?.project && currentProject?.revision !== retainedDraft.project.revision) {
      const warning = el(main, 'div', '', 'swarm-warning');
      el(warning, 'span', 'This draft uses an earlier project revision. Your text is preserved; saving still checks that original revision.');
      button(warning, 'Discard this draft and reload', () => {
        drafts.delete(draftContext()); renderedContext = null; render();
      });
    }
    if(retainedDraft && retainedDraft.organizationRevision!==org().revision){const warning=el(main,'div','','swarm-warning');el(warning,'span','Folder organization changed while this draft was open. Saving keeps the original revision check.');button(warning,'Discard folder draft and reload',()=>{drafts.delete(draftContext());renderedContext=null;render();});}
    if (project) content(main, project);
    else if(visibleProjects().length){
      const h=el(main,'header','','swarm-sheet-heading');el(h,'h2',selectedFolder===':all'?'All workflows':selectedFolder===':unfiled'?'Unfiled tasks':folderPath(org(),selectedFolder));
      el(h,'p','Tasks from independent workflows. Choose a row for its evidence and controls.');board(main);
    } else {
      const blank = el(main, 'section', '', 'swarm-empty');
      el(blank, 'h2', projectView === 'active' ? 'Build a coordinated project' : 'No ' + projectView + ' projects');
      el(blank, 'p', 'Start with a project name and the outcome you want. Then add people or agents and their work. Creating a project does not start workers.');
    }
    if (!project && projectView === 'active' && get(main,'.swarm-empty')) createProject(get(main, '.swarm-empty'));
    restoreDraft();
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
    openProjectId(id) { inspectingItem = false; selectedProject = id; if (active) void refresh(true); },
  };
}
