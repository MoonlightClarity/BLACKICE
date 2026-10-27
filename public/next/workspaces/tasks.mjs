import { text } from '../core/dom.mjs';
import { workflowCatalogWindow } from './workflow-overview-model.mjs';
import { createTaskHistory } from './task-lifecycle.mjs';
import { jobLinkedRun } from './tasks-visual-model.mjs';
import { scheduleTriggerLabel, scheduleEditDraft, scheduleUpdateFromDraft, scheduleJobs } from './schedule-inspection-model.mjs';

export function createTasksWorkspace({mount,api,events,getStatus,notify,onNavigate}) {
  mount.innerHTML=[
    '<div class="next-panel next-task-workspace next-visual-workspace"><div class="next-panel-inner next-task-workspace-inner">',
    '<header class="next-panel-head"><div><h1>Tasks</h1><p>Your saved work, organized by its recorded status.</p></div>',
    '<button type="button" id="next-tasks-refresh">Refresh</button></header>',
    '<nav class="next-visual-tabs" role="tablist" aria-label="Tasks views">',
    '<button type="button" role="tab" id="next-tasks-tab-board" aria-selected="true" aria-controls="next-tasks-panel-board">Work board</button>',
    '<button type="button" role="tab" id="next-tasks-tab-schedules" aria-selected="false" aria-controls="next-tasks-panel-schedules" tabindex="-1">Schedules</button>',
    '<button type="button" role="tab" id="next-tasks-tab-results" aria-selected="false" aria-controls="next-tasks-panel-results" tabindex="-1">Results</button>',
    '<button type="button" role="tab" id="next-tasks-tab-jobs" aria-selected="false" aria-controls="next-tasks-panel-jobs" tabindex="-1">Job history</button></nav>',
    '<section id="next-tasks-panel-board" class="next-task-panel" role="tabpanel" aria-labelledby="next-tasks-tab-board"><section id="next-tasks-history"></section></section>',
    '<section id="next-tasks-panel-schedules" class="next-task-panel" role="tabpanel" aria-labelledby="next-tasks-tab-schedules" hidden>',
    '<header class="next-task-schedules-head"><h2>Schedules</h2><div class="next-row"><button type="button" id="next-tasks-pause">Pause schedules</button><button type="button" id="next-tasks-resume">Resume</button></div></header>',
    '<p class="next-help" role="status" id="next-tasks-info">Loading schedules…</p>',
    '<h2>Scheduled work</h2><div id="next-tasks-deployments" class="next-grid"></div>',
    '<section id="next-tasks-schedule-detail" class="next-card next-schedule-inspector" aria-label="Schedule inspection and editing" hidden></section>',
    '<details class="next-card next-schedule-removed" id="next-tasks-removed" hidden><summary>Removed schedules (audit history)</summary><div id="next-tasks-removed-list"></div></details>',
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
    '<label class="next-label">After a clean restart or explicit resume<select class="next-field" name="catchUpPolicy"><option value="skip">Skip missed occurrences (default)</option><option value="once">Run one missed occurrence</option></select></label>',
    '<label class="next-label next-catchup-age" hidden>Maximum missed-run age in seconds<input class="next-field" type="number" min="60" max="604800" name="catchUpMaxAge" value="86400"></label>',
    '<label class="next-label">Result destination<select class="next-field" name="outboundType"><option value="local">BLACKICE local Results (default)</option><option value="webhook">HTTPS webhook (opt-in)</option></select></label>',
    '<label class="next-label next-outbound-url" hidden>HTTP(S) webhook URL<input class="next-field" type="url" name="outboundUrl" autocomplete="off" placeholder="https://alerts.example.com/receive"></label>',
    '<p class="next-help">Opting in sends the saved result excerpt and job outcome to that HTTPS endpoint. Its URL is kept private in inspection views. No external delivery occurs by default.</p>',
    '<label><input type="checkbox" name="enabled"> Enable after creation</label>',
    '<div class="next-row"><button type="button" id="next-tasks-preview">Preview next runs</button><button type="submit" class="next-primary">Save schedule</button></div>',
    '<p class="next-help" role="status" id="next-tasks-preview-output"></p>',
    '</form></details></section>',
    '<section id="next-tasks-panel-results" class="next-task-panel" role="tabpanel" aria-labelledby="next-tasks-tab-results" hidden>',
    '<h2>Scheduled results</h2><p class="next-help">Results are available locally in BLACKICE. They are not automatically sent to ChatGPT or another destination. Mark reviewed only after inspecting the result.</p>',
    '<p class="next-help" id="next-tasks-results-count" role="status"></p><div id="next-tasks-results" class="next-task-job-list"></div></section>',
    '<section id="next-tasks-panel-jobs" class="next-task-panel" role="tabpanel" aria-labelledby="next-tasks-tab-jobs" hidden>',
    '<h2>Job history</h2><p class="next-help" id="next-tasks-job-count" role="status"></p><div id="next-tasks-jobs" class="next-task-job-list"></div>',
    '<button type="button" id="next-tasks-jobs-more" hidden>Show more jobs</button></section>',
    '</div></div>',
  ].join('');
  const $=id=>mount.querySelector('#'+id);
  const view={info:$('next-tasks-info'),deployments:$('next-tasks-deployments'),jobs:$('next-tasks-jobs'),results:$('next-tasks-results'),
    pause:$('next-tasks-pause'),resume:$('next-tasks-resume'),form:$('next-tasks-form'),
    preview:$('next-tasks-preview-output'),detail:$('next-tasks-schedule-detail'),workflow:mount.querySelector('[name=workflow]'),
    workflowSearch:$('next-tasks-workflow-search'),workflowMore:$('next-tasks-workflow-more')};
  const add=(parent,tag,label,cls)=>text(parent,label,tag,cls);
  let active=false,busy=false,revision=0,subscriptions=null,refreshTimer=null,snapshot=null,mutationError='';
  let workflowList=[],workflowLimit=80,workflowQuery='',workflowEpoch=0,workflowTimer=null,workflowLoaded=false,workflowLoading=false;
  let section='board',jobsLimit=35,selectedScheduleId=null,scheduleMode='inspect',editSource=null,editForm=null,editNotice=null;
  const sections=['board','schedules','results','jobs'];
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
  const detailRow=(parent,label,value)=>{
    const item=add(parent,'div','','next-schedule-detail-row');
    add(item,'strong',label);add(item,'span',value == null || value === ''?'Not set':String(value));
    return item;
  };
  function scheduleField(parent,label,name,value,{tag='input',type='text',choices,required=false}={}){
    const wrapper=add(parent,'label',label,'next-label next-schedule-field');
    const field=wrapper.ownerDocument.createElement(tag);
    field.className='next-field';field.setAttribute('name',name);
    if(tag==='select'){
      for(const [id,title] of choices||[]){const option=add(field,'option',title);option.value=id;}
    }else if(tag==='input'){field.type=type;if(type==='checkbox')field.checked=value===true;}
    if(type!=='checkbox')field.value=String(value??'');
    field.required=required;
    wrapper.append(field);return field;
  }
  function selectedSchedule(){
    return (snapshot?.deployments||[]).find(task=>task.id===selectedScheduleId)||null;
  }
  function chooseSchedule(id){
    if(selectedScheduleId===id&&scheduleMode==='inspect'){selectedScheduleId=null;view.detail.hidden=true;view.detail.replaceChildren();return;}
    selectedScheduleId=id;scheduleMode='inspect';editSource=null;editForm=null;editNotice=null;
    paintScheduleDetail();
  }
  function openScheduleEditor(){
    const selected=selectedSchedule();
    if(!selected)return;
    editSource=structuredClone(selected);
    scheduleMode='edit';editForm=null;editNotice=null;
    paintScheduleDetail();
  }
  function paintScheduleDetail(){
    if(!selectedScheduleId){view.detail.hidden=true;return;}
    const selected=selectedSchedule();
    if(!selected){selectedScheduleId=null;scheduleMode='inspect';editSource=null;editForm=null;view.detail.hidden=true;return;}
    view.detail.hidden=false;
    if(scheduleMode==='edit'&&editForm){
      if(editNotice)editNotice.textContent=selected.revision!==editSource.revision
        ?'This schedule changed after you opened the editor. Your draft is preserved; saving will require a reload and review.'
        :'Editing saved revision '+editSource.revision+'. Your changes are not yet applied.';
      return;
    }
    view.detail.replaceChildren();
    const top=add(view.detail,'div','','next-schedule-detail-head');
    add(top,'h3',selected.name||'Scheduled task');
    const close=add(top,'button','Close');close.type='button';close.dataset.scheduleClose=selected.id;
    close.addEventListener('click',()=>{selectedScheduleId=null;scheduleMode='inspect';editSource=null;editForm=null;view.detail.hidden=true;});
    if(scheduleMode==='edit'){
      const original=editSource||structuredClone(selected),draft=scheduleEditDraft(original);
      const note=add(view.detail,'p','Editing saved revision '+original.revision+'. Your changes are not yet applied.','next-help');
      editNotice=note;
      const form=add(view.detail,'form','','next-schedule-edit-form next-stack');
      editForm=form;form.dataset.scheduleEdit=selected.id;
      scheduleField(form,'Name','name',draft.name,{required:true});
      scheduleField(form,'Task instructions','input',draft.input,{tag:'textarea',required:true});
      scheduleField(form,'Working folder','cwd',draft.cwd,{required:true});
      const recovery=scheduleField(form,'After a clean restart or explicit resume','catchUpPolicy',draft.catchUpPolicy,{
        tag:'select',choices:[['skip','Skip missed occurrences (default)'],['once','Run one missed occurrence']]
      });
      const maxAge=scheduleField(form,'Maximum missed-run age in seconds','catchUpMaxAge',draft.catchUpMaxAge,{type:'number'});
      const showRecovery=()=>{maxAge.parentElement.hidden=recovery.value!=='once';};
      recovery.addEventListener('change',showRecovery);showRecovery();
      const outboundType=scheduleField(form,'Result destination','outboundType',draft.outboundType,{
        tag:'select',choices:[['local','BLACKICE local Results (default)'],['webhook','HTTP(S) webhook (opt-in)']]
      });
      const outboundUrl=scheduleField(form,'Webhook URL (full configured address)','outboundUrl',draft.outboundUrl);
      outboundUrl.autocomplete='off';
      const showOutbound=()=>{outboundUrl.parentElement.hidden=outboundType.value!=='webhook';};
      outboundType.addEventListener('change',showOutbound);showOutbound();
      add(form,'p','Opt-in external delivery sends the saved result excerpt and outcome. Previously admitted jobs retain their original destination.','next-help');
      const triggerControl=scheduleField(form,'Trigger','triggerType',draft.triggerType,{tag:'select',choices:[['cron','Cron schedule'],['interval','Interval'],['manual','Manual'],['webhook','Webhook']]});
      const cronExpression=scheduleField(form,'Cron expression (five fields)','expression',draft.expression);
      const timezone=scheduleField(form,'Timezone (IANA)','timezone',draft.timezone);
      const interval=scheduleField(form,'Interval in seconds','everySeconds',draft.everySeconds,{type:'number'});
      const updateTriggerFields=()=>{
        cronExpression.parentElement.hidden=timezone.parentElement.hidden=triggerControl.value!=='cron';
        interval.parentElement.hidden=triggerControl.value!=='interval';
      };
      triggerControl.addEventListener('change',updateTriggerFields);updateTriggerFields();
      scheduleField(form,'Overlap handling','overlap',draft.overlap,{tag:'select',choices:[['skip','Skip while busy'],['queue','Queue each occurrence'],['parallel','Allow parallel runs']]});
      scheduleField(form,'Automatic retry attempts (0-3)','maxAttempts',draft.maxAttempts,{type:'number'});
      scheduleField(form,'Retry backoff (seconds)','backoffSeconds',draft.backoffSeconds,{type:'number'});
      scheduleField(form,'Maximum admitted jobs (optional)','maxIterations',draft.maxIterations,{type:'number'});
      scheduleField(form,'Run for seconds after activation (optional)','runForSeconds',draft.runForSeconds,{type:'number'});
      scheduleField(form,'End time (ISO with timezone; optional)','endAt',draft.endAt);
      if(draft.agentModel!==null){
        scheduleField(form,'Agent model','agentModel',draft.agentModel,{required:true});
        scheduleField(form,'Agent reasoning effort','agentEffort',draft.agentEffort,{tag:'select',choices:[
          ['','Use app setting'],['default','Model default'],['none','None'],['minimal','Minimal'],['low','Low'],['medium','Medium'],['high','High'],['xhigh','Extra high'],['max','Max'],['ultra','Ultra']
        ]});
        add(form,'p','A model change updates only future job admissions. Complex multi-agent graphs should be edited in Workflows.','next-help');
      }
      const enabledLabel=add(form,'label','','next-schedule-checkbox');
      const enabled=enabledLabel.ownerDocument.createElement('input');enabled.type='checkbox';enabled.setAttribute('name','enabled');enabled.checked=draft.enabled;enabledLabel.append(enabled);
      add(enabledLabel,'span','Enable future scheduled runs');
      add(form,'p','Saving changes the next admissions only. Already admitted jobs retain their original instructions and workflow; saved job history is not rewritten.','next-help');
      const output=add(form,'p','','next-help next-schedule-feedback');output.setAttribute('role','status');
      const buttons=add(form,'div','','next-row');
      const preview=add(buttons,'button','Preview next runs');preview.type='button';preview.dataset.schedulePreview=selected.id;
      const save=add(buttons,'button','Save changes','next-primary');save.type='submit';save.dataset.scheduleSave=selected.id;
      const cancel=add(buttons,'button','Cancel');cancel.type='button';cancel.dataset.scheduleCancel=selected.id;
      const reload=add(buttons,'button','Reload current version');reload.type='button';reload.dataset.scheduleReload=selected.id;
      const currentDraft=()=>{
        const fields=form.elements;
        const values={};
        for(const key of ['name','input','cwd','triggerType','expression','timezone','everySeconds','overlap','maxAttempts','backoffSeconds','maxIterations','runForSeconds','endAt','outboundType','outboundUrl','catchUpPolicy','catchUpMaxAge']){
          values[key]=fields.namedItem(key).value;
        }
        values.enabled=fields.namedItem('enabled').checked;
        if(draft.agentModel!==null){
          values.agentModel=fields.namedItem('agentModel').value;
          values.agentEffort=fields.namedItem('agentEffort').value;
        }
        return values;
      };
      preview.addEventListener('click',async()=>{
        output.textContent='Checking the schedule...';
        try{
          const proposal=scheduleUpdateFromDraft(original,currentDraft());
          if(!['cron','interval'].includes(proposal.trigger.type)){output.textContent='This trigger runs manually or through a webhook.';return;}
          const data=await api('/api/operations/schedule-preview','POST',{trigger:proposal.trigger,count:3});
          output.textContent=(data.occurrences||[]).map(entry=>entry.local||humanTime(entry.at||entry.iso)).join(' · ')||'No upcoming runs.';
        }catch(error){output.textContent=error.message;}
      });
      cancel.addEventListener('click',()=>{scheduleMode='inspect';editSource=null;editForm=null;paintScheduleDetail();});
      reload.addEventListener('click',()=>{editSource=structuredClone(selectedSchedule());editForm=null;paintScheduleDetail();});
      form.addEventListener('submit',async event=>{
        event.preventDefault();if(busy)return;
        let proposed;
        try{proposed=scheduleUpdateFromDraft(original,currentDraft());}catch(error){output.textContent=error.message;return;}
        busy=true;save.disabled=true;preview.disabled=true;reload.disabled=true;output.textContent='Saving changes...';
        try{
          if(['cron','interval'].includes(proposed.trigger.type))await api('/api/operations/schedule-preview','POST',{trigger:proposed.trigger,count:1});
          await api('/api/operations/deployments/'+encodeURIComponent(selected.id),'PUT',proposed);
          scheduleMode='inspect';editSource=null;editForm=null;editNotice=null;
          await refresh();notify('Schedule updated. Future admissions use the saved settings.');
        }catch(error){
          output.textContent=error.message+(String(error.message).match(/revision|changed|conflict|409/i)?' Reload the current version and review your edits before retrying.':'');
          notify(error.message,true);
        }finally{busy=false;save.disabled=false;preview.disabled=false;reload.disabled=false;}
      });
      return;
    }
    const actions=add(view.detail,'div','','next-row');
    const edit=add(actions,'button','Edit schedule');edit.type='button';edit.dataset.scheduleEditOpen=selected.id;
    edit.addEventListener('click',openScheduleEditor);
    if(['cron','interval'].includes(selected.trigger?.type)){
      const preview=add(actions,'button','Preview upcoming runs');preview.type='button';preview.dataset.scheduleInspectPreview=selected.id;
      const previewOutput=add(view.detail,'p','','next-help next-schedule-feedback');previewOutput.setAttribute('role','status');
      preview.addEventListener('click',async()=>{
        previewOutput.textContent='Checking the saved schedule...';
        try{const response=await api('/api/operations/schedule-preview','POST',{trigger:selected.trigger,count:3});
          previewOutput.textContent=(response.occurrences||[]).map(item=>item.local||humanTime(item.at||item.iso)).join(' · ')||'No upcoming runs.';
        }catch(error){previewOutput.textContent=error.message;}
      });
    }
    const facts=add(view.detail,'div','','next-schedule-detail-grid');
    const status=snapshot?.status||{};
    detailRow(facts,'State',selected.enabled?'Enabled':'Disabled');
    detailRow(facts,'Ticker',status.ticker?.state||'Not reported');
    detailRow(facts,'Last successful tick',humanTime(status.ticker?.lastSuccessAt));
    if(status.ticker?.lastError)detailRow(facts,'Ticker error',status.ticker.lastError);
    if(selected.overdue)detailRow(facts,'Overdue since',humanTime(selected.overdueSince));
    detailRow(facts,'Dispatcher',status.paused?'Paused':status.blockedReason||'Ready');
    detailRow(facts,'Trigger',scheduleTriggerLabel(selected.trigger));
    detailRow(facts,'Next scheduled run',humanTime(selected.nextAt));
    detailRow(facts,'Overlap',selected.overlap||'parallel');
    detailRow(facts,'Retry',String(selected.retry?.maxAttempts??0)+' attempts · '+String(selected.retry?.backoffSeconds??30)+'s backoff');
    detailRow(facts,'Limits',[
      selected.limits?.maxIterations==null?'Unlimited admissions':'Up to '+selected.limits.maxIterations+' jobs',
      selected.limits?.runForSeconds==null?'No duration cap':selected.limits.runForSeconds+' seconds',
      selected.limits?.endAt?'Until '+selected.limits.endAt:'No end date'
    ].join(' · '));
    detailRow(facts,'Admitted jobs',selected.admittedJobs??0);
    detailRow(facts,'Working folder',selected.cwd);
    detailRow(facts,'Missed runs after restart/resume',selected.missedRunPolicy?.onResume==='once'
      ?'Run one if no older than '+selected.missedRunPolicy.maxAgeSeconds+' seconds'
      :'Skip (default)');
    detailRow(facts,'Result delivery',selected.deliveryTarget?.type==='webhook'
      ?'HTTPS webhook configured at '+(selected.deliveryTarget.host||'saved destination')+' (path hidden)'
      :'BLACKICE local Results only');
    detailRow(facts,'Revision',selected.revision);
    detailRow(facts,'Schedule ID',selected.id);
    detailRow(facts,'Attachments',selected.attachmentIds?.length?selected.attachmentIds.join(', '):'None');
    if(selected.limitStatus?.reached)add(view.detail,'p',selected.limitStatus.reason||'This schedule has reached its lifetime limit.','next-help');
    add(view.detail,'h4','Task instructions');
    add(view.detail,'pre',selected.input||'','next-schedule-source');
    if(selected.changeHistory?.length){
      add(view.detail,'h4','Schedule change audit');
      for(const change of selected.changeHistory.slice(-8).reverse()){
        const line=add(view.detail,'div','','next-schedule-job');
        add(line,'strong',change.kind||'changed');
        add(line,'span',humanTime(change.at)+' · '+(change.source||'unspecified')+' · revision '+change.revision);
      }
    }
    if(selected.occurrenceHistory?.length){
      add(view.detail,'h4','Recent scheduled occurrences');
      for(const event of selected.occurrenceHistory.slice(-10).reverse()){
        const row=add(view.detail,'div','','next-schedule-job');
        add(row,'strong',event.kind==='admitted'?'Admitted':event.kind==='refused'?'Not admitted':'Skipped');
        add(row,'span',humanTime(event.scheduledAt)+(event.throughAt?' – '+humanTime(event.throughAt):'')+(event.reason?' · '+event.reason:''));
        if(event.jobId){
          const match=(snapshot.jobs||[]).find(job=>job.id===event.jobId);
          const linked=match&&jobLinkedRun(match);
          if(linked){const open=add(row,'button','Open run');open.type='button';open.addEventListener('click',()=>onNavigate?.('chat',{conversationId:linked.runId}));}
        }
      }
    }
    add(view.detail,'h4','Pinned workflow');
    const steps=add(view.detail,'div','','next-schedule-steps');
    for(const node of selected.workflow?.nodes||[]){
      const step=add(steps,'details','','next-schedule-step');
      add(step,'summary',node.name||node.id);
      detailRow(step,'Type',node.type);
      if(node.type==='agent'){
        detailRow(step,'Model',node.model||'default');detailRow(step,'Effort',node.effort||'App default');
        detailRow(step,'Fast tier',node.serviceTier||'Default');detailRow(step,'Desktop',node.desktop?'Enabled':'Disabled');
      }
      if(node.prompt)add(step,'pre',node.prompt,'next-schedule-source');
    }
    const {total,jobs}=scheduleJobs(snapshot,selected.id,10);
    add(view.detail,'h4','Saved job history ('+total+')');
    if(!jobs.length)add(view.detail,'p','No admitted runs yet.','next-help');
    for(const job of jobs){
      const row=add(view.detail,'div','','next-schedule-job');
      add(row,'span',humanTime(job.createdAt)+' · '+job.status+' · '+(job.source||'unknown'));
      const linked=jobLinkedRun(job);
      if(linked){
        const open=add(row,'button',linked.current?'Open run':'Open previous attempt');open.type='button';open.dataset.scheduleRunId=linked.runId;
        open.addEventListener('click',()=>onNavigate?.('chat',{conversationId:linked.runId}));
      }
      if(job.error)add(row,'p',String(job.error?.message||job.error),'next-help');
    }
    if(total>jobs.length)add(view.detail,'p','Showing '+jobs.length+' of '+total+' jobs. Open the Job history tab for additional runs.','next-help');
  }
  function paint(){
    if(!snapshot)return;
    const status=snapshot.status||{},enabled=status.paused!==true;
    view.pause.disabled=!enabled||busy;
    view.resume.disabled=enabled||busy;
    view.info.textContent=mutationError|| (status.healthy===false?status.error||'Task storage needs attention.'
      :status.paused?'Schedules paused: '+(status.pauseReason||'manual pause')
      :status.blockedReason?'Dispatch blocked: '+status.blockedReason
      :status.ticker?.state==='stale'?'Scheduler heartbeat stale. Last successful tick: '+humanTime(status.ticker.lastSuccessAt)
      :status.ticker?.state==='error'?'Scheduler tick failed: '+(status.ticker.lastError||'Unknown failure')
      :'Schedules ready · '+(status.enabled||0)+' active · '+(status.running||0)+' running'+(status.ticker?.lastSuccessAt?' · Last tick: '+humanTime(status.ticker.lastSuccessAt):''));
    view.deployments.replaceChildren();
    const deployments=Array.isArray(snapshot.deployments)?snapshot.deployments:[];
    if(!deployments.length)add(view.deployments,'p','No saved schedules yet. Create one below.','next-empty');
    for(const task of deployments){
      const card=add(view.deployments,'article','','next-card');
      add(card,'h3',task.name||'Scheduled task');
      add(card,'p',task.input?.slice(0,180)||'','next-help');
      const meta=add(card,'p','','next-help');
      const trigger=task.trigger||{};
      meta.textContent=scheduleTriggerLabel(trigger)+' · '+(task.overdue?'Overdue since: '+humanTime(task.overdueSince):'Next: '+humanTime(task.nextAt));
      const controls=add(card,'div','','next-row');
      const inspect=add(controls,'button',selectedScheduleId===task.id?'Hide inspection':'Inspect / edit');
      inspect.type='button';inspect.dataset.scheduleInspect=task.id;inspect.disabled=busy;
      inspect.addEventListener('click',()=>chooseSchedule(task.id));
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
      add(removal,'summary','Remove future scheduling');
      add(removal,'p','Stops future scheduling and cancels unstarted jobs. Running work and job history remain. A removal audit is retained; the schedule cannot be restored from this screen.');
      const remove=add(removal,'button','Remove schedule permanently');remove.type='button';remove.disabled=busy;
      remove.dataset.scheduleRemove=task.id;
      remove.addEventListener('click',()=>void execute('/api/operations/deployments/'+encodeURIComponent(task.id),'DELETE',{expectedRevision:task.revision}));
    }
    paintScheduleDetail();
    const removedList=$('next-tasks-removed-list');
    removedList.replaceChildren();
    const removed=Array.isArray(snapshot.removedDeployments)?snapshot.removedDeployments:[];
    $('next-tasks-removed').hidden=removed.length===0;
    for(const record of removed){
      const line=add(removedList,'div','','next-schedule-job');
      add(line,'strong',record.name||record.id);
      add(line,'span','Removed: '+humanTime(record.removedAt)+' · Source: '+(record.removedBy||'not-recorded'));
      if(record.removedBy==='not-recorded')add(line,'p','This older record does not identify who removed the schedule.','next-help');
    }
    view.results.replaceChildren();
    const inbox=snapshot.results||{items:[],total:0,available:0,acknowledged:0};
    $('next-tasks-tab-results').textContent=inbox.available?'Results ('+inbox.available+' to review)':'Results';
    $('next-tasks-results-count').textContent=inbox.available+' awaiting review · '+inbox.acknowledged+' reviewed · '+inbox.total+' total (new receipt tracking only)';
    if(!inbox.items?.length)add(view.results,'p','No local scheduled results recorded yet. Older job history remains available in Job history.','next-empty');
    for(const result of inbox.items||[]){
      const delivery=result.delivery||{},card=add(view.results,'article','','next-card next-schedule-result');
      card.dataset.resultJobId=result.id;
      const title=add(card,'div','','next-task-job-top');
      add(title,'strong',result.deploymentName||result.id);
      const state=add(title,'span',delivery.state==='acknowledged'?'Reviewed':'Awaiting review','next-status-pill');
      state.dataset.state=delivery.state==='acknowledged'?'saved':'running';
      add(card,'p','Agent outcome: '+(delivery.outcome||result.status||'unknown')+' · Available: '+humanTime(delivery.availableAt),'next-help');
      if(delivery.error)add(card,'p','Run error: '+delivery.error,'next-help');
      const outbound=(snapshot.jobs||[]).find(item=>item.id===result.id)?.outbound;
      if(outbound){
        add(card,'p','HTTPS webhook '+outbound.state+' · '+outbound.host
          +(outbound.httpStatus?' · HTTP '+outbound.httpStatus:''),'next-help');
        if(outbound.state==='unknown')add(card,'p','The destination may have accepted this result. BLACKICE will not resend it automatically.','next-help');
        if(outbound.error)add(card,'p','Webhook: '+outbound.error,'next-help');
        if(['failed','unknown'].includes(outbound.state)&&(outbound.attempts?.length||0)<3){
          const retry=add(card,'button',outbound.state==='unknown'?'Review resend risk':'Retry HTTPS delivery');
          retry.type='button';retry.dataset.outboundRetry=result.id;retry.disabled=busy;
          let confirmed=false;
          retry.addEventListener('click',()=>{
            if(outbound.state==='unknown'&&!confirmed){
              confirmed=true;retry.textContent='Send again (may duplicate)';
              retry.setAttribute('aria-label','Confirm explicit webhook resend; destination may already have received the previous result');
              return;
            }
            void execute('/api/operations/jobs/'+encodeURIComponent(result.id)+'/redeliver','POST',{
              expectedRevision:outbound.revision,...(outbound.state==='unknown'?{confirmPossibleDuplicate:true}:{})
            });
          });
        }
      }
      if(delivery.preview!==null&&delivery.preview!==undefined){
        add(card,'pre',delivery.preview,'next-schedule-source next-schedule-result-preview');
        if(delivery.previewTruncated)add(card,'p','Preview shortened. Open the saved run for the full output.','next-help');
      }else add(card,'p','No verified output preview is available. The saved execution receipt may still be inspected.','next-help');
      const actions=add(card,'div','','next-row');
      if(delivery.sourceRunId){
        const open=add(actions,'button','Open saved run');open.type='button';open.dataset.resultRunId=delivery.sourceRunId;
        open.addEventListener('click',()=>onNavigate?.('chat',{conversationId:delivery.sourceRunId}));
      }
      if(delivery.state==='available'){
        const acknowledge=add(actions,'button','Mark reviewed');acknowledge.type='button';
        acknowledge.dataset.resultAcknowledge=result.id;acknowledge.disabled=busy;
        acknowledge.addEventListener('click',()=>void execute('/api/operations/jobs/'+encodeURIComponent(result.id)+'/acknowledge','POST',{expectedRevision:delivery.revision}));
      }else add(actions,'span','Reviewed: '+humanTime(delivery.acknowledgedAt),'next-help');
    }
    if((inbox.items?.length||0)<inbox.total)add(view.results,'p','Showing '+inbox.items.length+' of '+inbox.total+' receipts. More are retained in Job history.','next-help');
    view.jobs.replaceChildren();
    const allJobs=Array.isArray(snapshot.jobs)?snapshot.jobs:[],jobs=allJobs.slice(0,jobsLimit);
    $('next-tasks-job-count').textContent='Showing '+jobs.length+' of '+allJobs.length+' saved jobs';
    $('next-tasks-jobs-more').hidden=jobs.length>=allJobs.length;
    if(!jobs.length)add(view.jobs,'p','No recorded scheduled jobs.','next-empty');
    for(const job of jobs){
      const row=add(view.jobs,'article','','next-task-job-row');row.dataset.jobId=job.id;
      const top=add(row,'div','','next-task-job-top');
      add(top,'strong',deployments.find(d=>d.id===job.deploymentId)?.name||removed.find(d=>d.id===job.deploymentId)?.name||job.deploymentName||job.name||job.id);
      const badge=add(top,'span',job.status||'unknown','next-status-pill');badge.dataset.state=job.status||'unknown';
      const linked=jobLinkedRun(job);
      add(row,'p',humanTime(job.createdAt)+(linked?.attemptNumber?' · Attempt '+linked.attemptNumber:'')+(job.error?' · '+(job.error?.message||job.error):''),'next-task-job-meta');
      const actions=add(row,'div','','next-task-job-actions');
      if(linked){const open=add(actions,'button',linked.current?'Open task':'Open previous attempt');open.type='button';open.dataset.jobRunId=linked.runId;open.addEventListener('click',()=>onNavigate?.('chat',{conversationId:linked.runId}));}
      const receipt=add(row,'details','','next-task-menu');receipt.dataset.jobInspect=job.id;
      add(receipt,'summary','Inspect job receipt');
      detailRow(receipt,'Job ID',job.id);detailRow(receipt,'Source',job.source||'unknown');
      detailRow(receipt,'Schedule revision',job.deploymentRevision??'Unknown');
      detailRow(receipt,'Created',humanTime(job.createdAt));detailRow(receipt,'Finished',humanTime(job.finishedAt));
      if(job.error)detailRow(receipt,'Error',job.error?.message||job.error);
      if(job.outbound){
        detailRow(receipt,'External result',job.outbound.state+' · '+job.outbound.host);
        if(job.outbound.error)detailRow(receipt,'Delivery uncertainty',job.outbound.error);
        for(const deliveryAttempt of job.outbound.attempts||[])
          detailRow(receipt,'Webhook attempt '+deliveryAttempt.number,
            deliveryAttempt.state+(deliveryAttempt.httpStatus?' · HTTP '+deliveryAttempt.httpStatus:''));
      }
      for(const attempt of job.attempts||[]){
        const item=add(receipt,'div','','next-schedule-job');
        add(item,'strong','Attempt '+(attempt.number||'?')+' · '+(attempt.status||'unknown'));
        if(attempt.runId)detailRow(item,'Run ID',attempt.runId);
        if(attempt.error)detailRow(item,'Error',attempt.error?.message||attempt.error);
      }
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
  const catchUpCreate=view.form.querySelector('[name=catchUpPolicy]'),catchUpCreateMaxAge=view.form.querySelector('[name=catchUpMaxAge]');
  const updateCatchUpCreate=()=>{catchUpCreateMaxAge.closest('label').hidden=catchUpCreate.value!=='once';};
  catchUpCreate.addEventListener('change',updateCatchUpCreate);updateCatchUpCreate();
  const outboundCreate=view.form.querySelector('[name=outboundType]'),outboundCreateUrl=view.form.querySelector('[name=outboundUrl]');
  const updateOutboundCreate=()=>{outboundCreateUrl.closest('label').hidden=outboundCreate.value!=='webhook';};
  outboundCreate.addEventListener('change',updateOutboundCreate);updateOutboundCreate();
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
      missedRunPolicy:{onResume:fields.catchUpPolicy.value,maxAgeSeconds:Number(fields.catchUpMaxAge.value)},
      deliveryTarget:fields.outboundType.value==='webhook'
        ?{type:'webhook',url:fields.outboundUrl.value.trim()}
        :{type:'local'},
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
      if(request.deliveryTarget.type==='webhook'){fields.outboundUrl.value='';fields.outboundType.value='local';updateOutboundCreate();}
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
