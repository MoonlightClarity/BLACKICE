import { text } from '../core/dom.mjs';
import {createActivityInspector} from '../chat/activity-inspector.mjs';
import { goalPresentation, updateConversationGoal } from '../chat/goals.mjs';
import {planningConversationActivity,planningConversationRunId,planningCurrentConversations} from './planning-current-model.mjs';

const message = error => String(error?.message || error || 'The saved record could not be read.');
const readable = value => typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value, null, 2);
const dateLabel = value => { const time = Date.parse(value); return Number.isFinite(time) ? new Date(time).toLocaleString(undefined, {month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}) : ''; };

/** The current conversation owns Planning. Opening this surface only reads saved
 * Goal records; it never creates a plan or schedules a model. */
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
  add(historyNote, 'span', 'Browse explicit graph requests and earlier planning records. Conversation goals appear in Current work.');
  const historyMount = add(historyPane, 'div', '', 'pc-history-workspace');

  let active = false, destroyed = false, mode = 'current', rows = [], selectedId = '', pendingId = '';
  let state = null, catalogEpoch = 0, detailEpoch = 0, catalogController = null, detailController = null;
  let timer = null, eventTimer = null, unsubscribe = null, catalogError = '', catalogLoaded = false;
  let history = null, historyLoading = null, pendingRequest = null, mutationBusy = false;
  const selected = () => rows.find(row => row.id === selectedId);
  const inspector=createActivityInspector({frame:shell,api,events,getRunId:()=>selected()?.runId||selectedId});
  const noticeText = value => { notice.textContent = value; notice.hidden = !value; };
  const isCurrent = (epoch, id) => !destroyed && active && mode === 'current' && epoch === detailEpoch && id === selectedId;
  const openChat = () => { if(selectedId)onNavigate?.('chat',{conversationId:selectedId}); else onNavigate?.('chat'); };

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

  function renderDetail() {
    detail.replaceChildren();const row=selected();
    if(!row){const empty=add(detail,'div','','pc-empty');add(empty,'h2',catalogLoaded?'Choose a conversation':'Opening current work...');paragraph(empty,'Select a conversation to inspect its goal and retained activity.');if(catalogLoaded&&!rows.length)button(empty,'Start in Chat',openChat,'pc-primary');return;}
    const head=add(detail,'header','','pc-detail-header'),title=add(head,'div');add(title,'p','CURRENT CONVERSATION','pc-eyebrow');add(title,'h2',row.title);
    const controls=add(head,'div','','pc-actions');badge(controls,row.activity.label,row.activity.state);button(controls,'Open Chat',openChat);button(controls,'Activity',()=>void inspector.open(),'pc-quiet');
    if(!state){paragraph(detail,'Loading the conversation goal...','pc-loading');return;}
    renderGoal(add(detail,'div','','pc-overview'),row);
    paragraph(detail,'Activity reads retained updates and tool calls for the selected run. It does not create work or edit saved context.','pc-muted');
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

  async function loadSelected(){
    const row=selected();if(!row||destroyed||!active||mode!=='current')return;
    const id=selectedId,epoch=++detailEpoch;detailController?.abort();detailController=new AbortController();const signal=detailController.signal;
    const previous=state?.owner===id?state:null;if(!previous){state=null;renderDetail();}
    try{const result=await api('/api/conversations/'+encodeURIComponent(id)+'/goal','GET',undefined,{signal});if(!isCurrent(epoch,id))return;const goal=result?.goal??null;state={owner:id,goal};row.goal=goal;row.runId=planningConversationRunId({...row,goal});row.activity=planningConversationActivity(row,goal);}
    catch(error){if(!isCurrent(epoch,id))return;state={owner:id,goal:previous?.goal??null,goalError:message(error)};}
    inspector.refresh(row.runId);renderRail();renderDetail();
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
    unsubscribe=events?.subscribe?.(event=>{if(/^(?:run|goal|conversations?)[.:]/.test(event?.type||''))scheduleRefresh();});
    timer=setInterval(()=>{if(mode==='current'&&rows.some(row=>row.activity.pending))scheduleRefresh();},6000);
    if(mode==='history')void showView('history');else void refresh();
  }
  function leave() {
    active=false;inspector.refresh(null);++catalogEpoch;++detailEpoch;catalogController?.abort();detailController?.abort();
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
