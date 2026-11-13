import {stableId} from '../core/dom.mjs';

const ACTIONS=new Set(['set','update','pause','resume','clear']);
const RESUMABLE=new Set(['paused','blocked','interrupted','budget_exhausted']);
const ACTIVE_AUTONOMY=new Set(['active','waiting']);

/** The proposed objective is editable; only saved chat history, never inferred facts, supplies calibration. */
export function autonomyCalibrationObjective({draft='',firstTask='',turns=0}={}) {
  const task=String(firstTask||'').trim();
  const initial=task || String(draft||'').trim();
  if(!initial)return '';
  const refinement=task&&Number(turns)>1?'\n\nHonor all corrections, constraints and decisions established later in this same conversation. Verify the agreed outcome before declaring completion.':'';
  return initial.slice(0,12000-refinement.length)+refinement;
}
export function parseGoalCommand(value) {
  const match=String(value??'').trim().match(/^\/goal(?:\s+([\s\S]*))?$/i);
  if(!match)return null;
  const body=(match[1]||'').trim();
  if(!body||/^(status|show)$/i.test(body))return {action:'status'};
  if(/^--(?:\s|$)/.test(body)) {
    const objective=body.slice(2).trim();
    if(!objective)throw Error('Enter an objective after /goal --.');
    return {action:'set',objective};
  }
  const control=body.toLowerCase();
  if(['pause','resume','clear'].includes(control))return {action:control};
  if(['continue','unpause'].includes(control))return {action:'resume'};
  return {action:'set',objective:body};
}
export function goalPresentation(goal,{running=false}={}) {
  if(!goal)return null;
  const status=String(goal.status||'active'),working=typeof goal.running==='boolean'?goal.running:running;
  const labels={active:working?'Running':'Ready to continue',paused:goal.pauseRequest?.status==='unverified'?'Pause needs verification':goal.pauseRequest?.status==='pausing'?'Pausing current execution':working?'Pausing after this turn':'Paused',
    completed:'Completed',waiting:'Waiting',blocked:'Needs attention',interrupted:'Interrupted',budget_exhausted:'Turn limit reached'};
  const turns=Number.isFinite(Number(goal.turns))?Math.max(0,Number(goal.turns)):0;
  const limit=goal.maxTurns==null?null:Number(goal.maxTurns);
  return {status,label:labels[status]||status,objective:String(goal.objective||''),
    progress:turns+' '+(turns===1?'turn':'turns')+(limit>0?' / '+limit:' · No turn limit'),
    reason:String(goal.lastReason||''),canPause:['active','waiting'].includes(status)||(working&&!goal.pauseRequest),canResume:RESUMABLE.has(status)&&!working&&(!goal.pauseRequest||goal.pauseRequest.settled===true),working};
}
export async function updateConversationGoal({api,conversationId,goal,action,objective,maxTurns,executionOptions={}}) {
  if(!conversationId||conversationId==='new')throw Error('Start a conversation before changing its saved goal.');
  if(!ACTIONS.has(action))throw Error('Unknown goal action.');
  if(['set','update'].includes(action)&&(!String(objective??'').trim()))throw Error('Enter an objective for this goal.');
  if(maxTurns!==undefined&&maxTurns!==null&&(!Number.isInteger(maxTurns)||maxTurns<1))throw Error('Use a positive whole number for the turn limit, or leave it empty.');
  return api('/api/conversations/'+encodeURIComponent(conversationId)+'/goal','POST',{
    ...(['set','resume'].includes(action)?executionOptions:{}),action,requestId:stableId('goal'),
    ...(action==='pause'&&goal?.running&&goal?.currentRunId?{pauseRunId:goal.currentRunId}:{}),
    ...(Number.isInteger(goal?.revision)?{expectedRevision:goal.revision}:{}),
    ...(['pause','resume'].includes(action)&&goal?.id&&Number.isSafeInteger(goal.generation)?{
      expectedControl:{goalId:goal.id,generation:goal.generation,status:goal.status,runId:goal.currentRunId||null}
    }:{}),
    ...(objective!==undefined?{objective:String(objective).trim()}:{}),...(maxTurns!==undefined?{maxTurns}:{})
  });
}

/** The server owns the goal and its loop. This view never schedules work itself. */
export function createGoalControls({view,api,getContext,onStart,onResult=()=>{},onChange=()=>{},onGoalChange=()=>{},notify=()=>{},onError=()=>{}}) {
  let owner='new',goal=null,loading=false,busy=false,locked=false,readonly=false,working=false,destroyed=false,readToken=0,editorOwner=null;
  let readError='',queuedRead=null;
  const paint=()=>{
    if(destroyed)return;
    const current=goalPresentation(goal,{running:working});
    view.goalCard.hidden=!current;
    const enabled=Boolean(goal&&ACTIVE_AUTONOMY.has(goal.status));
    const pausePending=goal?.status==='paused'&&goal.pauseRequest&&goal.pauseRequest.settled!==true;
    view.goalToggle.disabled=busy||locked||loading||readonly||Boolean(pausePending);
    view.goalToggle.setAttribute('aria-checked',String(enabled));
    view.goalToggle.dataset.state=enabled?'on':'off';
    view.goalToggle.textContent=enabled?'Autonomy: On':'Autonomy: Off';
    view.goalToggle.title=readError|| (pausePending?'Waiting for the current turn to stop before autonomy can resume.':enabled?'Turn autonomy off; stop automatic continuation and retain this chat and goal.':goal&&RESUMABLE.has(goal.status)?'Resume this saved autonomous goal in the same chat.':'Calibrate this conversation and turn autonomous execution on.');
    if(current){
      view.goalStatus.textContent=current.label;view.goalCard.dataset.status=current.status;
      view.goalObjective.textContent=current.objective;view.goalProgress.textContent=current.progress;
      view.goalReason.textContent=current.reason;view.goalReason.hidden=!current.reason;
      view.goalPause.hidden=!current.canPause;view.goalResume.hidden=!current.canResume;
      for(const control of [view.goalEdit,view.goalPause,view.goalResume,view.goalClear])control.disabled=busy||locked||readonly;
    }
    view.goalSave.disabled=busy||locked;view.goalCancel.disabled=busy||locked;view.goalInput.readOnly=busy||locked;view.goalLimit.disabled=busy||locked;
    view.goalCard.setAttribute('aria-busy',String(busy));
  };
  const closeEditor=()=>{
    editorOwner=null;if(view.goalDialog.open)view.goalDialog.close();
  };
  async function refresh() {
    if(destroyed||owner==='new')return null;
    const target=owner,token=++readToken;
    loading=true;paint();
    const read=api('/api/conversations/'+encodeURIComponent(target)+'/goal','GET');
    queuedRead=read;
    try {
      const result=await read;
      if(destroyed||owner!==target||token!==readToken)return null;
      goal=result?.goal??null;readError='';paint();onGoalChange(goal,target);
      return goal;
    } catch(error) {
      if(!destroyed&&owner===target&&token===readToken){readError=String(error?.message||'Could not load the goal.');paint();}
      return null;
    } finally {
      if(queuedRead===read)queuedRead=null;
      if(!destroyed&&owner===target&&token===readToken){loading=false;paint();}
    }
  }
  function accept(next,target=owner) {
    if(destroyed||target!==owner)return false;
    if(next&&goal&&next.id===goal.id&&Number(next.revision)<Number(goal.revision))return false;
    ++readToken;loading=false;goal=next??null;readError='';paint();onGoalChange(goal,target);return true;
  }
  async function act(action,values={}) {
    if(destroyed||busy||locked||readonly)return false;
    const target=owner;
    busy=true;paint();onChange();
    try {
      if(loading&&queuedRead)await queuedRead.catch(()=>{});
      if(target!==owner||destroyed)return false;
      if(readError)throw Error(readError);
      const result=await updateConversationGoal({api,conversationId:target,goal,action,...values,
        executionOptions:getContext()?.executionOptions||{}});
      if(accept(result?.goal??null,target))await onResult(result,target);
      return result;
    } catch(error) {if(['GOAL_REVISION_CONFLICT','GOAL_PAUSE_TARGET','GOAL_PAUSE_PENDING'].includes(error?.code)&&target===owner&&!destroyed)await refresh();onError(error);throw error;}
    finally {busy=false;if(!destroyed){paint();onChange();}}
  }
  function showEditor() {
    if(destroyed||busy||locked||loading||readonly)return;
    editorOwner=owner;
    const context=getContext()||{},turns=Math.max(0,Number(context.calibration?.turns)||0);
    view.goalInput.value=goal?.objective||autonomyCalibrationObjective({draft:context.draft,firstTask:context.calibration?.firstTask,turns});
    view.goalLimit.value=goal?.maxTurns==null?'':String(goal.maxTurns);
    view.goalTitle.textContent=goal&&goal.status!=='completed'?'Calibrate autonomous goal':'Turn on autonomy';
    view.goalSave.textContent=goal&&goal.status!=='completed'?'Save calibration':'Turn on autonomy';
    if(view.goalContext){view.goalContext.hidden=owner==='new';view.goalContext.textContent=owner==='new'?'':`Using this chat’s ${turns} saved ${turns===1?'turn':'turns'} as context. Your corrections and selected settings stay with this conversation.`;}
    view.goalError.hidden=true;view.goalDialog.showModal();view.goalInput.focus({preventScroll:true});
  }
  async function command(command,{consumeDraft=true}={}) {
    if(!command)return false;
    if(command.action==='status'){
      if(owner!=='new')await refresh();
      const current=goalPresentation(goal,{running:working});
      if(readError)throw Error(readError);
      notify(current?current.label+' · '+current.progress+': '+current.objective:'No goal is set. Use /goal followed by an objective, or choose Goal.');
      return {goal};
    }
    if(owner==='new'){
      if(command.action!=='set')throw Error('This conversation does not have a goal yet.');
      const result=await onStart({objective:command.objective,maxTurns:command.maxTurns??null},{consumeDraft});
      return result||false;
    }
    return act(command.action,{...(command.objective!==undefined?{objective:command.objective}:{}),...(command.maxTurns!==undefined?{maxTurns:command.maxTurns}:{})});
  }
  view.goalToggle.addEventListener('click',async()=>{
    if(destroyed||busy||locked||loading||readonly)return;
    if(goal&&ACTIVE_AUTONOMY.has(goal.status))await act('pause').catch(()=>{});
    else if(goal&&RESUMABLE.has(goal.status))await act('resume').catch(()=>{});
    else showEditor();
  });
  view.goalEdit.addEventListener('click',showEditor);
  view.goalCancel.addEventListener('click',closeEditor);
  view.goalDialog.addEventListener('cancel',event=>{if(busy)event.preventDefault();else editorOwner=null;});
  for(const [button,action]of [[view.goalPause,'pause'],[view.goalResume,'resume'],[view.goalClear,'clear']])
    button.addEventListener('click',()=>void act(action).catch(()=>{}));
  view.goalForm.addEventListener('submit',async event=>{
    event.preventDefault();if(busy||locked||editorOwner!==owner)return;
    const objective=view.goalInput.value.trim(),limit=view.goalLimit.value.trim();
    const maxTurns=limit===''?null:Number(limit);
    view.goalError.hidden=true;
    try{
      if(!objective)throw Error('Enter the outcome you want BLACKICE to achieve.');
      if(maxTurns!==null&&(!Number.isInteger(maxTurns)||maxTurns<1))throw Error('Use a positive whole number for the turn limit, or leave it empty.');
      let result;
      if(owner==='new')result=await command({action:'set',objective,maxTurns},{consumeDraft:false});
      else result=await act(goal&&goal.status!=='completed'?'update':'set',{objective,maxTurns});
      if(result)closeEditor();
    }catch(error){view.goalError.textContent=String(error?.message||error);view.goalError.hidden=false;}
  });
  paint();
  return {
    update(context={}) {
      const target=context.conversationId||'new',changed=target!==owner;
      readonly=Boolean(context.readonly);locked=Boolean(context.busy);working=Boolean(context.running);
      if(changed){
        ++readToken;owner=target;goal=null;loading=false;readError='';closeEditor();
        if(owner!=='new')void refresh();
      }
      paint();
    },
    refresh,
    command,
    handleEvent(event) {
      if(event?.type!=='goal.updated')return false;
      const data=event.data||{},target=data.conversationId;
      if(target!==owner)return false;
      if(accept(data.goal,target)){
        const runId=data.goal?.currentRunId;
        if(runId&&runId!==getContext()?.runId)void onResult({goal:data.goal,run:{id:runId}},target);
      }
      return true;
    },
    getGoal:()=>goal,
    isBusy:()=>busy,
    close:closeEditor,
    destroy(){destroyed=true;++readToken;closeEditor();}
  };
}
