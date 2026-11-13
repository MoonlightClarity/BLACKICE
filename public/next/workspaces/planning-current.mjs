import { text } from '../core/dom.mjs';
import { createDirectoryInspector } from '../chat/artifacts.mjs';
import { goalPresentation, updateConversationGoal } from '../chat/goals.mjs';
import { planningConversationActivity, planningConversationRunId, planningCurrentConversations, planningDirectoryRecord,
  planningDirectoryPhases, planningDirectorySummary, planningDirectoryWorkItems } from './planning-current-model.mjs';

const contextPath = (runId, file) => '/api/shadowdancer/context' + (file ? '/file' : '') + '?runId=' + encodeURIComponent(runId) + (file ? '&file=' + encodeURIComponent(file) : '');
const message = error => String(error?.message || error || 'The saved record could not be read.');
const readable = value => typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value, null, 2);
const dateLabel = value => { const time = Date.parse(value); return Number.isFinite(time) ? new Date(time).toLocaleString(undefined, {month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}) : ''; };

/** The current conversation owns Planning. Opening this surface only reads saved
 * Goal and Directory records; it never creates a plan or schedules a model. */
export function createPlanningWorkspace({ mount, api, events, notify = () => {}, onNavigate,
  getStatus = () => ({}), loadHistoryWorkspace = () => import('./planning-browser.mjs').then(module => module.createPlanningBrowser) }) {
  mount.replaceChildren();
  const add = (parent, tag, value = '', className = '') => text(parent, value, tag, className);
  const button = (parent, label, action, className = '') => {
    const element = add(parent, 'button', label, className); element.setAttribute('type', 'button');
    element.addEventListener('click', action); return element;
  };
  const badge = (parent, label, state = '') => { const node = add(parent, 'span', label, 'pc-badge'); node.dataset.state = state; return node; };
  const shell = add(mount, 'section', '', 'planning-current');
  const header = add(shell, 'header', '', 'pc-header');
  const heading = add(header, 'div', '', 'pc-heading'); add(heading, 'h1', 'Planning');
  add(heading, 'p', 'Goals, work, and results in each conversation.');
  const actions = add(header, 'div', '', 'pc-header-actions');
  const activity = add(actions, 'span', '', 'pc-activity'); activity.setAttribute('role', 'status');
  const refreshButton = button(actions, 'Refresh', () => void refresh()); refreshButton.dataset.action = 'refresh';
  const views = add(shell, 'nav', '', 'pc-views'); views.setAttribute('aria-label', 'Planning views');
  const viewButtons = new Map();
  for (const [id, label] of [['current', 'Current work'], ['history', 'Saved graph plans']]) {
    const control = button(views, label, () => void showView(id)); control.dataset.planningView = id;
    control.setAttribute('aria-pressed', String(id === 'current')); viewButtons.set(id, control);
  }
  const currentPane = add(shell, 'div', '', 'pc-layout');
  const rail = add(currentPane, 'aside', '', 'pc-rail'); rail.setAttribute('aria-label', 'Planning conversations');
  const railHead = add(rail, 'div', '', 'pc-rail-head'); add(railHead, 'h2', 'Conversations');
  const total = add(railHead, 'span', '', 'pc-count');
  const searchLabel = add(rail, 'label', '', 'pc-field'); add(searchLabel, 'span', 'Find a conversation');
  const search = add(searchLabel, 'input'); search.id = 'pc-conversation-search'; search.setAttribute('type', 'search'); search.placeholder = 'Search conversations';
  const filterLabel = add(rail, 'label', '', 'pc-field'); add(filterLabel, 'span', 'Show');
  const filter = add(filterLabel, 'select'); filter.id = 'pc-conversation-view';
  for (const [id, label] of [['active','Saved conversations'],['running','Running now'],['archived','Archived'],['all','All conversations']]) {
    const option = add(filter, 'option', label); option.setAttribute('value', id);
  }
  filter.value = 'active';
  const list = add(rail, 'nav', '', 'pc-conversations'); list.setAttribute('aria-label', 'Conversation list');
  const main = add(currentPane, 'main', '', 'pc-main');
  const notice = add(main, 'p', '', 'pc-notice'); notice.setAttribute('role', 'status'); notice.setAttribute('aria-live', 'polite'); notice.hidden = true;
  const detail = add(main, 'section', '', 'pc-detail'); detail.setAttribute('aria-label', 'Current planning');
  const historyPane = add(shell, 'section', '', 'pc-history'); historyPane.hidden = true;
  const historyNote = add(historyPane, 'div', '', 'pc-history-note');
  add(historyNote, 'strong', 'Saved graph plans');
  add(historyNote, 'span', 'Browse explicit graph requests and earlier planning records. Current Directory work appears in Current work.');
  const historyMount = add(historyPane, 'div', '', 'pc-history-workspace');

  let active = false, destroyed = false, mode = 'current', rows = [], selectedId = '', pendingId = '';
  let state = null, catalogEpoch = 0, detailEpoch = 0, catalogController = null, detailController = null;
  let timer = null, eventTimer = null, unsubscribe = null, catalogError = '', catalogLoaded = false;
  let history = null, historyLoading = null, pendingRequest = null, mutationBusy = false;
  const expanded = new Set();
  const selected = () => rows.find(row => row.id === selectedId);
  const inspector = createDirectoryInspector({frame:shell,api,getConversationId:()=>selectedId,getRunId:()=>selected()?.runId||selectedId});
  shell.querySelector('.next-directory-inspector')?.addEventListener('close',scheduleRefresh);
  const noticeText = value => { notice.textContent = value; notice.hidden = !value; };
  const isCurrent = (epoch, id) => !destroyed && active && mode === 'current' && epoch === detailEpoch && id === selectedId;
  const openChat = () => { if(selectedId)onNavigate?.('chat',{conversationId:selectedId}); else onNavigate?.('chat'); };
  const openContext = file => inspector.open(file ? {file,tab:'files'} : {});

  function renderRail() {
    const visible = planningCurrentConversations(rows, {query:search.value,view:filter.value});
    const running = rows.filter(row => row.activity.running).length;
    activity.textContent = running ? running + ' running' : 'No work running'; activity.dataset.running = String(running > 0);
    total.textContent = String(visible.length); list.replaceChildren();
    if (!visible.length) add(list,'p',catalogError?'Conversations could not be loaded.':!catalogLoaded?'Loading conversations…':search.value?'No matching conversations.':filter.value==='running'?'No conversations are running.':'No conversations in this view.','pc-empty-small');
    for (const row of visible) {
      const control = button(list,'',()=>void selectConversation(row.id),'pc-conversation');
      control.dataset.conversationId = row.id; control.setAttribute('aria-current',String(row.id===selectedId));
      add(control,'strong',row.title);
      const meta=add(control,'span','','pc-conversation-meta'); badge(meta,row.activity.label,row.activity.state);
      add(meta,'time',dateLabel(row.updatedAt||row.createdAt));
      if(row.goal?.status) add(control,'span','Goal · '+({completed:'Completed',paused:'Paused',active:'In progress',waiting:'Waiting'}[row.goal.status]||row.goal.status.replaceAll('_',' ')),'pc-conversation-goal');
    }
  }
  const section = (parent, title, className = '') => { const card=add(parent,'section','', 'pc-card '+className); add(card,'h3',title); return card; };
  const paragraph = (parent, value, className = '') => { if(value)add(parent,'p',readable(value),className); };

  function renderGoal(parent, row) {
    const goal=state?.goal, presentation=goalPresentation(goal,{running:row.activity.running});
    const card=section(parent,presentation?'Conversation goal':'Current request','pc-goal');
    if(presentation){
      const top=add(card,'div','','pc-card-meta'); badge(top,presentation.label,presentation.status); add(top,'span',presentation.progress);
      paragraph(card,presentation.objective,'pc-objective');
      paragraph(card,goal.lastEvidence?.summary||presentation.reason,'pc-progress');
      if(goal.completionEvidence?.summary){ const done=add(card,'div','','pc-goal-result'); add(done,'strong','Recorded result'); paragraph(done,goal.completionEvidence.summary); }
      const controls=add(card,'div','','pc-actions');
      if(presentation.canPause)button(controls,'Pause goal',()=>void actGoal('pause')).disabled=mutationBusy;
      if(presentation.canResume)button(controls,'Resume goal',()=>void actGoal('resume')).disabled=mutationBusy;
      button(controls,'Edit goal in Chat',openChat,'pc-quiet');
    }else{
      const summary=state?.summary;
      paragraph(card,summary?.request||row.title,'pc-objective');
      paragraph(card,'This conversation can plan and work without a persistent goal.','pc-muted');
      button(card,'Open conversation',openChat,'pc-quiet');
    }
    if(state?.goalError) paragraph(card,'Goal unavailable: '+state.goalError,'pc-inline-error');
  }

  function renderOutcome(parent) {
    const summary=state.summary,outcome=summary.outcome;
    const card=section(parent,'Latest outcome review','pc-outcome');
    if(outcome){
      badge(card,outcome.label,outcome.stale?'stale':outcome.status||outcome.decision);
      if(outcome.stale)paragraph(card,summary.reviewStaleReason,'pc-inline-error');
      paragraph(card,outcome.summary,'pc-outcome-summary');
      if(Array.isArray(outcome.remaining)&&outcome.remaining.length){add(card,'h4','Remaining work');const items=add(card,'ul');for(const value of outcome.remaining)add(items,'li',readable(value));}
      if(Array.isArray(outcome.blockers)&&outcome.blockers.length){add(card,'h4','Unresolved items');const items=add(card,'ul');for(const value of outcome.blockers)add(items,'li',readable(value));}
      if(outcome.nextAction&&!/^none\.?$/i.test(outcome.nextAction)){add(card,'h4','Next action');paragraph(card,outcome.nextAction);}
      paragraph(card,'Review of saved evidence'+(outcome.at?' · '+dateLabel(outcome.at):''),'pc-muted');
      const latestReview=state.listing?.files?.filter(file=>file.file.startsWith('runs/'+summary.runId+'/')&&/\/completion\/\d+\.json$/.test(file.file)).at(-1);
      if(latestReview)button(card,'Inspect review',()=>void openContext(latestReview.file),'pc-quiet');
    }else paragraph(card,summary.available?'No outcome review has been recorded for this run.':'The outcome review will appear here when the conversation records one.','pc-muted');
    if(summary.failure)paragraph(card,readable(summary.failure),'pc-inline-error');
  }

  function renderWork(parent) {
    const card=section(parent,'Work items','pc-work-items');
    const summary=state.summary,items=planningDirectoryWorkItems(state.records,{runId:summary.runId});
    if(!items.length)paragraph(card,state.loadingRecords?'Loading saved work…':summary.available?'No decomposed work items have been saved for this run. Direct work and its review still appear here.':'Work items appear here as the conversation develops its plan.','pc-muted');
    const tree=add(card,'div','','pc-work-list');
    for(const item of items){
      const row=add(tree,'details','','pc-work-item');row.dataset.workItemId=item.id;row.open=expanded.has(selectedId+':'+item.id);
      row.addEventListener('toggle',()=>{const key=selectedId+':'+item.id;row.open?expanded.add(key):expanded.delete(key);});
      const head=add(row,'summary');add(head,'span',item.id||'Work','pc-work-number');add(head,'strong',item.objective||'Saved work item');badge(head,item.label,item.state);
      const body=add(row,'div','','pc-work-body');
      if(item.doneWhen){add(body,'h4','Done when');paragraph(body,item.doneWhen);}
      if(item.finding){add(body,'h4','Finding');paragraph(body,item.finding);}
      if(item.nextAction){add(body,'h4','Next action');paragraph(body,item.nextAction);}
      if(item.uncertainty){add(body,'h4','Open questions');paragraph(body,item.uncertainty);}
      if(item.dependsOn.length)paragraph(body,'Depends on '+item.dependsOn.join(', '),'pc-muted');
      const controls=add(body,'div','','pc-actions');button(controls,'View or edit work item',()=>void openContext(item.file),'pc-quiet');
      if(item.resultFile)button(controls,'Inspect result',()=>void openContext(item.resultFile),'pc-quiet');
    }
    if(state.recordError)paragraph(card,state.recordError,'pc-inline-error');
    if(state.loadedModules<summary.workItemFiles.length){
      const more=button(card,state.loadingRecords?'Loading…':'Load more work items ('+state.loadedModules+' of '+summary.workItemFiles.length+')',()=>void loadModules(detailEpoch,selectedId),'pc-quiet');more.disabled=state.loadingRecords;
    }
  }

  function renderPhases(parent) {
    const card=section(parent,'Planning activity','pc-model-phases');
    const phases=planningDirectoryPhases(state.turns,{runId:state.summary.runId});
    paragraph(card,'Recorded model phases for the latest run.','pc-muted');
    if(!phases.length)paragraph(card,state.loadingRecords?'Loading recorded phases…':'No model phases have been saved for this run.','pc-muted');
    const phaseList=add(card,'ol','','pc-phase-list');
    for(const phase of phases.slice(-30).reverse()){
      const row=add(phaseList,'li');const marker=add(row,'span','','pc-phase-marker');marker.setAttribute('aria-hidden','true');
      const body=add(row,'div','','pc-phase-body');const top=add(body,'div','','pc-phase-top');add(top,'strong',phase.title);add(top,'time',dateLabel(phase.at));
      if(phase.module)paragraph(body,phase.module,'pc-phase-module');
      if(phase.excerpt)paragraph(body,phase.excerpt.length>300?phase.excerpt.slice(0,300)+'…':phase.excerpt,'pc-phase-excerpt');
      if(phase.file&&state.listing.files.some(file=>file.file===phase.file))button(body,'Inspect phase',()=>void openContext(phase.file),'pc-quiet pc-small');
    }
    if(phases.length>30)button(card,'View all '+phases.length+' phases',()=>void inspector.open({tab:'turns'}),'pc-quiet');
  }

  function renderDetail() {
    detail.replaceChildren();
    const row=selected();
    if(!row){
      const empty=add(detail,'div','','pc-empty');add(empty,'h2',catalogLoaded?'Choose a conversation':'Opening current work…');
      paragraph(empty,catalogLoaded?'Planning follows the work in your conversations. Select one to see its goal, work items, model phases, and results.':'Loading saved conversations and their current execution state.');
      if(catalogLoaded&&!rows.length)button(empty,'Start in Chat',openChat,'pc-primary');return;
    }
    const head=add(detail,'header','','pc-detail-header');const title=add(head,'div');add(title,'p','CURRENT CONVERSATION','pc-eyebrow');add(title,'h2',row.title);
    const controls=add(head,'div','','pc-actions');badge(controls,row.activity.label,row.activity.state);button(controls,'Open Chat',openChat);
    button(controls,'Context & evidence',()=>void openContext(),'pc-quiet');
    if(!state){paragraph(detail,'Loading the goal and saved planning…','pc-loading');return;}
    const overview=add(detail,'div','','pc-overview');renderGoal(overview,row);
    if(state.contextError){
      const error=section(overview,'Planning records unavailable','pc-context-error');paragraph(error,state.contextError);button(error,'Try again',()=>void loadSelected());
    }else if(state.summary){
      renderOutcome(overview);
      const summary=state.summary;
      if(!summary.available){const empty=add(detail,'div','','pc-empty-context');add(empty,'h3','No Directory work recorded yet');paragraph(empty,'This conversation has no saved Directory planning. Continue in Chat; new planning and results will appear here automatically.');button(empty,'Continue in Chat',openChat,'pc-primary');}
      else{
        const stats=add(detail,'div','','pc-stats');
        for(const [value,label] of [[summary.plannedWorkItems??summary.workItemFiles.length,'work items'],[summary.modelPhases??'—','model phases'],[summary.contextFiles,'context records']]){const stat=add(stats,'div');add(stat,'strong',String(value));add(stat,'span',label);}
        if(!summary.belongsToSelectedRun)paragraph(detail,'The latest run has no summary yet. Earlier records remain available in Context & evidence.','pc-muted');
        const columns=add(detail,'div','','pc-work-columns');renderWork(columns);renderPhases(columns);
        if(summary.notes||summary.pinnedConstraints.length){const notes=section(detail,'Conversation context','pc-context-notes');paragraph(notes,summary.notes);if(summary.pinnedConstraints.length){const items=add(notes,'ul');for(const value of summary.pinnedConstraints)add(items,'li',value);}button(notes,'Edit context',()=>void openContext('conversation/context/summary.json'),'pc-quiet');}
      }
    }
  }

  async function actGoal(action) {
    const owner=selectedId,goal=state?.goal;
    if(mutationBusy||!goal||!owner)return;
    mutationBusy=true;renderDetail();noticeText('');
    try{
      const result=await updateConversationGoal({api,conversationId:owner,goal,action});
      if(!destroyed&&selectedId===owner){state.goal=result?.goal??null;await refresh();}
    }catch(error){if(!destroyed&&selectedId===owner){noticeText(message(error));notify(message(error),true);}}
    finally{mutationBusy=false;if(!destroyed)renderDetail();}
  }

  async function loadModules(epoch,id) {
    if(!isCurrent(epoch,id)||!state?.summary||state.loadingModules)return;
    const current=state,controller=detailController,files=current.summary.workItemFiles.slice(current.loadedModules,current.loadedModules+24);
    current.loadingModules=true;current.loadingRecords=true;renderDetail();
    const observed=new Set(current.listing.files.map(file=>file.file));
    const paths=files.flatMap(file=>{const result=file.file.replace(/module\.json$/,'result.json');return observed.has(result)?[file.file,result]:[file.file];});
    const failures=[];
    for(let start=0;start<paths.length;start+=6){
      const responses=await Promise.allSettled(paths.slice(start,start+6).map(async file=>({...(await api(contextPath(current.summary.runId,file),'GET',undefined,{signal:controller.signal})),file})));
      if(!isCurrent(epoch,id))return;
      for(const response of responses)response.status==='fulfilled'?current.records.push(response.value):failures.push(message(response.reason));
    }
    if(!isCurrent(epoch,id))return;
    current.loadedModules+=files.length;current.loadingModules=false;current.loadingRecords=false;
    if(failures.length)current.recordError=[current.recordError,'Some saved work records could not be read. '+failures[0]].filter(Boolean).join(' ');renderDetail();
  }

  async function loadSelected() {
    const row=selected();if(!row||destroyed||!active||mode!=='current')return;
    const id=selectedId,epoch=++detailEpoch;detailController?.abort();detailController=new AbortController();const signal=detailController.signal;
    const previous=state?.owner===id&&state.summary?.runId===row.runId?state:null;
    if(!previous){state=null;renderDetail();}
    const results=await Promise.allSettled([
      api('/api/conversations/'+encodeURIComponent(id)+'/goal','GET',undefined,{signal}),
      api(contextPath(row.runId),'GET',undefined,{signal})
    ]);
    if(!isCurrent(epoch,id))return;
    const goal=results[0].status==='fulfilled'?results[0].value?.goal??null:previous?.goal??null;
    const observedGoal=results[0].status==='fulfilled'?goal:row.goal;
    let context=results[1];
    const actualRun=planningConversationRunId({...row,goal:observedGoal});
    if(actualRun&&actualRun!==row.runId){
      row.runId=actualRun;row.latestRunId=actualRun;state=null;renderDetail();
      try{context={status:'fulfilled',value:await api(contextPath(actualRun),'GET',undefined,{signal})};}
      catch(error){context={status:'rejected',reason:error};}
      if(!isCurrent(epoch,id))return;
    }
    const missing=context.status==='rejected'&&(context.reason?.code==='SHADOWDANCER_CONTEXT_NOT_FOUND'||context.reason?.status===404);
    const listing=context.status==='fulfilled'?context.value:{files:[]};
    state={owner:id,goal,listing,turns:undefined,records:[],loadedModules:0,loadingModules:false,loadingRecords:true,
      goalError:results[0].status==='rejected'?message(results[0].reason):'',contextError:context.status==='rejected'&&!missing?message(context.reason):'',recordError:''};
    state.summary=planningDirectorySummary({conversation:row,goal,listing});
    row.activity=planningConversationActivity(row,observedGoal);if(results[0].status==='fulfilled')row.goal=goal;
    inspector.refresh(row.runId);renderRail();renderDetail();
    const current=state;
    if(listing.files?.some(file=>file.file==='conversation/context/turns.json')){
      try{const response=await api(contextPath(row.runId,'conversation/context/turns.json'),'GET',undefined,{signal});if(!isCurrent(epoch,id))return;current.turns=planningDirectoryRecord(response);}
      catch(error){if(!isCurrent(epoch,id))return;current.recordError='Planning activity could not be read. '+message(error);}
    }
    if(!isCurrent(epoch,id))return;
    current.summary=planningDirectorySummary({conversation:row,goal,listing,turns:current.turns});
    if(current.summary.workItemFiles.length)await loadModules(epoch,id);
    else{current.loadingRecords=false;renderDetail();}
  }

  async function selectConversation(id) {
    const row=rows.find(row=>row.id===id||row.runId===id||row.latestRunId===id);
    if(!row){pendingId=id;await refresh();return;}
    selectedId=row.id;pendingId='';state=null;++detailEpoch;detailController?.abort();
    inspector.refresh(row.runId);renderRail();renderDetail();await loadSelected();
  }

  async function refresh() {
    if(destroyed||!active)return;
    if(mode==='history'){await history?.refresh?.();return;}
    const epoch=++catalogEpoch;catalogController?.abort();catalogController=new AbortController();
    refreshButton.disabled=true;
    try{
      const result=await api('/api/conversations?state=all','GET',undefined,{signal:catalogController.signal});
      if(destroyed||!active||mode!=='current'||epoch!==catalogEpoch)return;
      if(!Array.isArray(result)&&!Array.isArray(result?.conversations))throw Error('The conversation list could not be read.');
      rows=planningCurrentConversations(result,{view:'all'});catalogLoaded=true;catalogError='';noticeText('');
      let chosen=rows.find(row=>[row.id,row.runId,row.latestRunId].includes(pendingId||selectedId));
      if(!chosen)chosen=rows.find(row=>row.activity.running)||rows.find(row=>row.state!=='archived')||rows[0];
      if(chosen){if(selectedId!==chosen.id)state=null;selectedId=chosen.id;pendingId='';}
      else{selectedId='';state=null;}
      renderRail();renderDetail();await loadSelected();
    }catch(error){if(!destroyed&&active&&epoch===catalogEpoch){catalogError=message(error);noticeText('Conversations could not be refreshed. '+catalogError);renderRail();}}
    finally{if(epoch===catalogEpoch)refreshButton.disabled=false;}
  }

  async function ensureHistory() {
    if(history)return history;
    if(!historyLoading)historyLoading=Promise.resolve().then(loadHistoryWorkspace).then(factory=>{
      if(destroyed)return null;
      history=(factory.createPlanningBrowser||factory)({mount:historyMount,api,events,notify,onNavigate,getStatus});return history;
    }).catch(error=>{historyLoading=null;if(!destroyed){historyMount.replaceChildren();paragraph(historyMount,'Saved graph plans could not open. '+message(error),'pc-inline-error');button(historyMount,'Try again',()=>void showView('history'));}return null;});
    return historyLoading;
  }
  async function showView(next) {
    if(destroyed)return;mode=next==='history'?'history':'current';
    for(const [id,control]of viewButtons)control.setAttribute('aria-pressed',String(id===mode));
    currentPane.hidden=mode!=='current';historyPane.hidden=mode!=='history';
    refreshButton.hidden=mode==='history';
    if(mode==='history'){
      ++detailEpoch;++catalogEpoch;detailController?.abort();catalogController?.abort();refreshButton.disabled=false;
      const instance=await ensureHistory();if(!instance||destroyed||mode!=='history'||!active)return;
      instance.enter?.();
      if(pendingRequest){const request=pendingRequest;pendingRequest=null;instance.openRequestId?.(request.id,request.options);}
      else if(selectedId)instance.openConversationId?.(selectedId);
    }else{history?.leave?.();renderRail();renderDetail();if(active)await refresh();}
  }
  function scheduleRefresh() {
    if(!active||destroyed||mode!=='current'||eventTimer)return;
    eventTimer=setTimeout(()=>{eventTimer=null;void refresh();},1200);
  }
  function enter() {
    if(destroyed||active)return;active=true;
    unsubscribe=events?.subscribe?.(event=>{if(/^(?:run|goal|conversations?|directory|shadowdancer)[.:]/.test(event?.type||''))scheduleRefresh();});
    timer=setInterval(()=>{if(mode==='current'&&rows.some(row=>row.activity.pending))scheduleRefresh();},6000);
    if(mode==='history')void showView('history');else void refresh();
  }
  function leave() {
    active=false;++catalogEpoch;++detailEpoch;catalogController?.abort();detailController?.abort();
    clearInterval(timer);timer=null;clearTimeout(eventTimer);eventTimer=null;unsubscribe?.();unsubscribe=null;history?.leave?.();refreshButton.disabled=false;
  }
  search.addEventListener('input',renderRail);filter.addEventListener('change',renderRail);
  renderRail();renderDetail();
  return {
    enter,activate:enter,leave,deactivate:leave,refresh,
    async openConversationId(id){pendingId=id;if(mode!=='current')await showView('current');else await selectConversation(id);},
    async openRequestId(id,options={}){pendingRequest={id,options};await showView('history');},
    updateStatus(status){history?.updateStatus?.(status);if(active)scheduleRefresh();},
    destroy(){if(destroyed)return;leave();destroyed=true;inspector.destroy();history?.destroy?.();mount.replaceChildren();}
  };
}
