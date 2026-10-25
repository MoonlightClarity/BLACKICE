import { text } from '../core/dom.mjs';
import { workflowCatalogWindow } from './workflow-overview-model.mjs';
import { createTaskHistory } from './task-lifecycle.mjs';
import { jobLinkedRun } from './tasks-visual-model.mjs';

export function createTasksWorkspace({mount,api,events,getStatus,notify,onNavigate}) {
  mount.innerHTML=[
    '<div class="next-panel next-task-workspace next-visual-workspace"><div class="next-panel-inner next-task-workspace-inner">',
    '<header class="next-panel-head"><div><h1>Tasks</h1><p>Your saved work, organized by its recorded status.</p></div>',
    '<button type="button" id="next-tasks-refresh">Refresh</button></header>',
    '<nav class="next-visual-tabs" role="tablist" aria-label="Tasks views">',
    '<button type="button" role="tab" id="next-tasks-tab-board" aria-selected="true" aria-controls="next-tasks-panel-board">Work board</button>',
    '<button type="button" role="tab" id="next-tasks-tab-schedules" aria-selected="false" aria-controls="next-tasks-panel-schedules" tabindex="-1">Schedules</button>',
    '<button type="button" role="tab" id="next-tasks-tab-jobs" aria-selected="false" aria-controls="next-tasks-panel-jobs" tabindex="-1">Job history</button></nav>',
    '<section id="next-tasks-panel-board" class="next-task-panel" role="tabpanel" aria-labelledby="next-tasks-tab-board"><section id="next-tasks-history"></section></section>',
    '<section id="next-tasks-panel-schedules" class="next-task-panel" role="tabpanel" aria-labelledby="next-tasks-tab-schedules" hidden>',
    '<header class="next-task-schedules-head"><h2>Schedules</h2><div class="next-row"><button type="button" id="next-tasks-pause">Pause schedules</button><button type="button" id="next-tasks-resume">Resume</button></div></header>',
    '<p class="next-help" role="status" id="next-tasks-info">Loading schedules…</p>',
    '<h2>Scheduled work</h2><div id="next-tasks-deployments" class="next-grid"></div>',
    '<details class="next-card" style="margin-top:15px" id="next-tasks-create"><summary>Create a schedule</summary>',
    '<form id="next-tasks-form" class="next-stack" style="margin-top:15px">',
    '<label class="next-label">Name<input required class="next-field" name="name" maxlength="160"></label>',
    '<label class="next-label">Task instructions<textarea class="next-field" name="input" rows="3" required></textarea></label>',
    '<label class="next-label">Find saved workflow<input class="next-field" id="next-tasks-workflow-search" type="search" placeholder="Search saved workflows"></label>',
    '<label class="next-label">Saved workflow<select class="next-field" name="workflow" required></select></label>',
    '<button id="next-tasks-workflow-more" type="button" hidden>Show more workflows</button>',
    '<label class="next-label">Trigger<select class="next-field" name="trigger"><option value="manual">Manual</option><option value="cron">Cron schedule</option></select></label>',
    '<label class="next-label">Five-field cron expression<input class="next-field" name="expression" value="0 9 * * *"></label>',
    '<label class="next-label">Timezone<input class="next-field" name="timezone" value="America/New_York"></label>',
    '<label class="next-label">Working folder<input class="next-field" name="cwd" required></label>',
    '<label><input type="checkbox" name="enabled"> Enable after creation</label>',
    '<div class="next-row"><button type="button" id="next-tasks-preview">Preview next runs</button><button type="submit" class="next-primary">Save schedule</button></div>',
    '<p class="next-help" role="status" id="next-tasks-preview-output"></p>',
    '</form></details></section>',
    '<section id="next-tasks-panel-jobs" class="next-task-panel" role="tabpanel" aria-labelledby="next-tasks-tab-jobs" hidden>',
    '<h2>Job history</h2><p class="next-help" id="next-tasks-job-count" role="status"></p><div id="next-tasks-jobs" class="next-task-job-list"></div>',
    '<button type="button" id="next-tasks-jobs-more" hidden>Show more jobs</button></section>',
    '</div></div>',
  ].join('');
  const $=id=>mount.querySelector('#'+id);
  const view={info:$('next-tasks-info'),deployments:$('next-tasks-deployments'),jobs:$('next-tasks-jobs'),
    pause:$('next-tasks-pause'),resume:$('next-tasks-resume'),form:$('next-tasks-form'),
    preview:$('next-tasks-preview-output'),workflow:mount.querySelector('[name=workflow]'),
    workflowSearch:$('next-tasks-workflow-search'),workflowMore:$('next-tasks-workflow-more')};
  const add=(parent,tag,label,cls)=>text(parent,label,tag,cls);
  let active=false,busy=false,revision=0,subscriptions=null,refreshTimer=null,snapshot=null,mutationError='';
  let workflowList=[],workflowLimit=80,workflowQuery='',workflowEpoch=0,workflowTimer=null,workflowLoaded=false,workflowLoading=false;
  let section='board',jobsLimit=35;
  const sections=['board','schedules','jobs'];
  const history=createTaskHistory({mount:$('next-tasks-history'),api,events,notify,onNavigate,prefix:'next-tasks-history',presentation:'board'});
  const humanTime=value=>{
    if(!value)return'Not scheduled';
    const date=new Date(typeof value==='number'?value:Date.parse(value));
    return Number.isFinite(date.getTime())?date.toLocaleString():'Not scheduled';
  };
  async function execute(path,method,payload){
    if(busy)return;
    busy=true;mutationError='';revision++;paint();
    try {await api(path,method,payload);await refresh();return true;}
    catch(error){mutationError=error.message;notify(error.message,true);view.info.textContent=error.message;return false;}
    finally{busy=false;if(active)paint();}
  }
  function activateSection(name,{focus=false}={}){
    if(!sections.includes(name))return;
    section=name;
    for(const id of sections){const tab=$('next-tasks-tab-'+id);tab.setAttribute('aria-selected',String(id===section));tab.tabIndex=id===section?0:-1;$('next-tasks-panel-'+id).hidden=id!==section;}
    if(focus)$('next-tasks-tab-'+name).focus();
    if(!active)return;
    if(section==='board')history.enter();else {history.leave();void refresh();}
    if(section==='schedules'&&!workflowLoaded&&!workflowLoading)void fillWorkflows();
  }
  for(const name of sections){
    const tab=$('next-tasks-tab-'+name);
    tab.addEventListener('click',()=>activateSection(name));
    tab.addEventListener('keydown',event=>{
      const index=sections.indexOf(name),next=event.key==='ArrowRight'?sections[(index+1)%sections.length]:event.key==='ArrowLeft'?sections[(index+sections.length-1)%sections.length]:event.key==='Home'?sections[0]:event.key==='End'?sections.at(-1):null;
      if(next){event.preventDefault();activateSection(next,{focus:true});}
    });
  }
  function paint(){
    if(!snapshot)return;
    const status=snapshot.status||{},enabled=status.paused!==true;
    view.pause.disabled=!enabled||busy;
    view.resume.disabled=enabled||busy;
    view.info.textContent=mutationError|| (status.healthy===false?status.error||'Task storage needs attention.'
      :status.paused?'Schedules paused: '+(status.pauseReason||'manual pause')
      :status.blockedReason?'Dispatch blocked: '+status.blockedReason
      :'Schedules ready · '+(status.enabled||0)+' active · '+(status.running||0)+' running');
    view.deployments.replaceChildren();
    const deployments=Array.isArray(snapshot.deployments)?snapshot.deployments:[];
    if(!deployments.length)add(view.deployments,'p','No saved schedules yet. Create one below.','next-empty');
    for(const task of deployments){
      const card=add(view.deployments,'article','','next-card');
      add(card,'h3',task.name||'Scheduled task');
      add(card,'p',task.input?.slice(0,180)||'','next-help');
      const meta=add(card,'p','','next-help');
      const trigger=task.trigger||{};
      meta.textContent=(trigger.type==='cron'?trigger.expression+' · '+trigger.timezone:trigger.type||'manual')+' · Next: '+humanTime(task.nextAt);
      const controls=add(card,'div','','next-row');
      const state=add(controls,'span',task.enabled?'Enabled':'Disabled','next-status-pill');
      state.dataset.state=task.enabled?'running':'saved';
      const toggle=add(controls,'button',task.enabled?'Disable':'Enable');
      toggle.type='button';toggle.disabled=busy;
      toggle.addEventListener('click',()=>void execute('/api/operations/deployments/'+encodeURIComponent(task.id),'PUT',{
        expectedRevision:task.revision,enabled:!task.enabled,
      }));
      const triggerButton=add(controls,'button','Run now');
      triggerButton.type='button';triggerButton.disabled=busy;
      triggerButton.addEventListener('click',()=>void execute('/api/operations/deployments/'+encodeURIComponent(task.id)+'/trigger','POST',{}));
      const removal=add(card,'details','','next-help');
      add(removal,'summary','Remove schedule');
      add(removal,'p','Removes future scheduling and cancels jobs that have not started. Running work and job history remain. This schedule cannot be restored.');
      const remove=add(removal,'button','Remove schedule permanently');remove.type='button';remove.disabled=busy;
      remove.dataset.scheduleRemove=task.id;
      remove.addEventListener('click',()=>void execute('/api/operations/deployments/'+encodeURIComponent(task.id),'DELETE',{}));
    }
    view.jobs.replaceChildren();
    const allJobs=Array.isArray(snapshot.jobs)?snapshot.jobs:[],jobs=allJobs.slice(0,jobsLimit);
    $('next-tasks-job-count').textContent='Showing '+jobs.length+' of '+allJobs.length+' saved jobs';
    $('next-tasks-jobs-more').hidden=jobs.length>=allJobs.length;
    if(!jobs.length)add(view.jobs,'p','No recorded scheduled jobs.','next-empty');
    for(const job of jobs){
      const row=add(view.jobs,'article','','next-task-job-row');row.dataset.jobId=job.id;
      const top=add(row,'div','','next-task-job-top');
      add(top,'strong',deployments.find(d=>d.id===job.deploymentId)?.name||job.name||job.id);
      const badge=add(top,'span',job.status||'unknown','next-status-pill');badge.dataset.state=job.status||'unknown';
      const linked=jobLinkedRun(job);
      add(row,'p',humanTime(job.createdAt)+(linked?.attemptNumber?' · Attempt '+linked.attemptNumber:'')+(job.error?' · '+(job.error?.message||job.error):''),'next-task-job-meta');
      const actions=add(row,'div','','next-task-job-actions');
      if(linked){const open=add(actions,'button',linked.current?'Open task':'Open previous attempt');open.type='button';open.dataset.jobRunId=linked.runId;open.addEventListener('click',()=>onNavigate?.('chat',{conversationId:linked.runId}));}
      if(job.retryHold||job.status==='failed'){
        const retry=add(actions,'button','Retry');retry.type='button';retry.disabled=busy;
        retry.addEventListener('click',()=>void execute('/api/operations/jobs/'+encodeURIComponent(job.id)+'/retry','POST',{}));
      }
    }
  }
  async function refresh(){
    if(!active)return;
    const generation=++revision;
    try{
      const result=await api('/api/operations');
      if(!active||generation!==revision)return;
      snapshot=result;paint();
    }catch(error){if(active&&generation===revision){view.info.textContent=error.message;notify(error.message,true);}}
  }
  function paintWorkflowOptions(preferred=view.workflow.value){
    if(workflowQuery!==view.workflowSearch.value){
      workflowQuery=view.workflowSearch.value;workflowLimit=80;
      if(workflowQuery.trim())preferred='';
    }
    const {shown,pinned,hidden}=workflowCatalogWindow(workflowList,{
      query:workflowQuery,limit:workflowLimit,selected:preferred,
    });
    view.workflow.replaceChildren();
    const items=pinned?[pinned,...shown]:shown;
    for(const workflow of items){
      const option=view.workflow.ownerDocument.createElement('option');
      option.value=workflow.id;option.textContent=workflow.name||workflow.id;
      view.workflow.append(option);
    }
    if(!items.length){
      const option=view.workflow.ownerDocument.createElement('option');
      option.value='';option.textContent='No matching workflows';view.workflow.append(option);
    }
    view.workflow.value=items.some(item=>item.id===preferred)?preferred:items[0]?.id||'';
    view.workflowMore.hidden=!hidden;
    view.workflowMore.textContent=hidden?'Show '+Math.min(80,hidden)+' more workflows ('+hidden+' remaining)':'';
  }
  async function fillWorkflows(){
    const token=++workflowEpoch;workflowLoading=true;
    try{
      // Only metadata at startup. Fetch the selected graph once on Save.
      const result=await api('/api/workflows?view=index');
      if(!active||token!==workflowEpoch)return;
      workflowList=Array.isArray(result)?result:result?.workflows||[];
      workflowLoaded=true;
      paintWorkflowOptions();
    }catch(error){if(active&&token===workflowEpoch)view.preview.textContent=error.message;}
    finally{if(token===workflowEpoch)workflowLoading=false;}
    if(active&&!view.form.elements.cwd.value)view.form.elements.cwd.value=getStatus?.()?.cwd||'';
  }
  const trigger=()=>{
    const fields=view.form.elements;
    return fields.trigger.value==='cron'?{type:'cron',expression:fields.expression.value.trim(),timezone:fields.timezone.value.trim()}:{type:'manual'};
  };
  view.workflowSearch.addEventListener('input',()=>{
    clearTimeout(workflowTimer);
    workflowTimer=setTimeout(()=>{workflowTimer=null;paintWorkflowOptions();},95);
  });
  view.workflowMore.addEventListener('click',()=>{workflowLimit+=80;paintWorkflowOptions();});
  $('next-tasks-refresh').addEventListener('click',()=>{
    if(section==='board')$('next-tasks-history-refresh').click();
    else{void refresh();if(section==='schedules')void fillWorkflows();}
  });
  $('next-tasks-jobs-more').addEventListener('click',()=>{jobsLimit+=35;paint();});
  view.pause.addEventListener('click',()=>void execute('/api/operations/pause','POST',{reason:'Paused from Tasks workspace.'}));
  view.resume.addEventListener('click',()=>void execute('/api/operations/resume','POST',{}));
  $('next-tasks-preview').addEventListener('click',async()=>{
    if(trigger().type!=='cron'){view.preview.textContent='Manual tasks run when triggered.';return;}
    try{
      const data=await api('/api/operations/schedule-preview','POST',{trigger:trigger(),count:3});
      view.preview.textContent=(data.occurrences||[]).map(entry=>humanTime(entry.at||entry.iso)).join(' · ')||'No upcoming runs.';
    }catch(error){view.preview.textContent=error.message;}
  });
  view.form.addEventListener('submit',async event=>{
    event.preventDefault();if(busy)return;
    const fields=view.form.elements,id=fields.workflow.value;
    if(!workflowList.some(item=>item.id===id)){
      view.preview.textContent='Choose a saved workflow.';return;
    }
    const request={
      name:fields.name.value.trim(),input:fields.input.value.trim(),
      cwd:fields.cwd.value.trim(),trigger:trigger(),enabled:fields.enabled.checked,
      overlap:'queue',retry:{maxAttempts:0,backoffSeconds:30},
    };
    busy=true;view.form.inert=true;
    try{
      // Never send a metadata-only workflow as a scheduled execution graph.
      // Fetch only the selected saved graph, once, before the explicit POST.
      const workflow=await api('/api/workflows/'+encodeURIComponent(id));
      if(!workflow||workflow.id!==id||!Array.isArray(workflow.nodes)||!Array.isArray(workflow.edges))
        throw Error('The selected saved workflow could not be verified. Refresh before scheduling.');
      await api('/api/operations/deployments','POST',{...request,workflow});
      await refresh();
      view.preview.textContent='Saved. Schedule available above.';
      if(fields.name.value.trim()===request.name)fields.name.value='';
      if(fields.input.value.trim()===request.input)fields.input.value='';
      notify('Schedule saved.');
    }catch(error){
      view.preview.textContent=error.message;notify(error.message,true);
    }finally{
      busy=false;view.form.inert=false;
      if(active)paint();
    }
  });
  function onEvent(event){if(!active||section==='board'||event.type!=='operations.updated')return;clearTimeout(refreshTimer);refreshTimer=setTimeout(()=>void refresh(),700);}
  return{
    enter(){if(active)return;active=true;subscriptions=events.subscribe(onEvent);activateSection(section);},
    leave(){active=false;revision++;workflowEpoch++;workflowLoaded=false;workflowLoading=false;history.leave();subscriptions?.();subscriptions=null;clearTimeout(refreshTimer);clearTimeout(workflowTimer);workflowTimer=null;},
    updateStatus(info){if(!view.form.elements.cwd.value)view.form.elements.cwd.value=info?.cwd||'';},
    destroy(){this.leave();history.destroy();mount.innerHTML='';},
  };
}
