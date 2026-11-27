import {stableId} from '../core/dom.mjs';

const ACTIONS=new Set(['set','update','pause','resume','clear']);
const RESUMABLE=new Set(['paused','blocked','interrupted','budget_exhausted']);
const ACTIVE_GOAL=new Set(['active','waiting']);
const EDITOR_STALE_MESSAGE='This Goal changed while you were editing. Your draft has not been submitted. Close and reopen the editor to review the newer Goal.';
const EDITOR_READONLY_MESSAGE='This conversation is read-only. Your draft has not been submitted.';
const toComputerDateTime=iso=>{if(!iso)return '';const d=new Date(iso);if(!Number.isFinite(d.getTime()))return '';const two=v=>String(v).padStart(2,'0');return [d.getFullYear(),two(d.getMonth()+1),two(d.getDate())].join('-')+'T'+two(d.getHours())+':'+two(d.getMinutes())+':'+two(d.getSeconds());};
export const computerDeadlineInput=value=>{
  const match=/^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)(?::(\d\d))?$/.exec(value);
  if(!match)throw Error('Enter a complete computer-local date and time.');
  const [year,month,day,hour,minute,second]=match.slice(1).map(Number);
  if(!Number.isSafeInteger(year)||year<100||month<1||month>12||day<1||day>31||hour>23||minute>59||(second||0)>59)
    throw Error('The deadline calendar fields are invalid.');
  const instant=new Date(year,month-1,day,hour,minute,second||0);
  const same=d=>d.getFullYear()===year&&d.getMonth()===month-1&&d.getDate()===day
    &&d.getHours()===hour&&d.getMinutes()===minute&&d.getSeconds()===(second||0);
  if(!same(instant))throw Error('That local deadline does not exist at the DST spring-forward transition. Choose a valid time.');
  // A DST autumn fold has two UTC instants that share one datetime-local value.
  // Do not choose the first silently: an explicit ISO UTC offset is required.
  for(let delta=-180;delta<=180;delta+=15){
    if(delta!==0&&same(new Date(instant.getTime()+delta*60000)))
      throw Error('That local deadline is ambiguous at the DST fall-back transition. Supply a deadline with an explicit UTC offset.');
  }
  return {deadlineAt:instant.toISOString(),deadlineTimeZone:Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC'};
};

/** The proposed objective is editable; only saved chat history, never inferred facts, supplies calibration. */
export function goalDraftObjective({draft='',firstTask='',turns=0}={}) {
  const task=String(firstTask||'').trim();
  const initial=task || String(draft||'').trim();
  if(!initial)return '';
  const refinement=task&&Number(turns)>1?'\n\nHonor all corrections, constraints and decisions established later in this same conversation. Verify the agreed outcome before declaring completion.':'';
  return initial.slice(0,12000-refinement.length)+refinement;
}
/**
 * Self-driving is a reusable ordinary Goal objective, not a separate engine,
 * permission mode, scheduler, or source of verification authority.
 * Its starting wording was used in the verified plain-Goal feasibility runs.
 */
export const SELF_DRIVING_GOAL_OBJECTIVE = [
  'Use the accessible workspace to identify and perform worthwhile, permitted work independently.',
  'Inspect actual source records and operational artifacts, correct any demonstrable discrepancies in editable operational artifacts, verify the saved results and any linked requirements, then continue exploring other useful opportunities.',
  'Preserve original source evidence and any standing owner restrictions. Do not invent work or substitute a report for a feasible repair.'
].join(' ');

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
  if(control==='self-driving')return {action:'set',objective:SELF_DRIVING_GOAL_OBJECTIVE};
  return {action:'set',objective:body};
}
export function goalPresentation(goal,{running=false}={}) {
  if(!goal)return null;
  const status=String(goal.status||'active'),working=typeof goal.running==='boolean'?goal.running:running;
  const labels={active:working?'Running':'Ready to continue',paused:goal.pauseRequest?.status==='unverified'?'Pause needs verification':goal.pauseRequest?.status==='pausing'?'Pausing current execution':working?'Pausing after this turn':'Paused',
    completed:'Completed',waiting:'Waiting',blocked:'Needs attention',interrupted:'Interrupted',budget_exhausted:'Turn limit reached'};
  const turns=Number.isFinite(Number(goal.turns))?Math.max(0,Number(goal.turns)):0;
  const limit=goal.maxTurns==null?null:Number(goal.maxTurns);
  if(status==='paused'&&goal.deadlineExpiredAt&&goal.pauseRequest?.status!=='pausing')labels.paused='Deadline reached';
  return {status,label:labels[status]||status,objective:String(goal.objective||''),
    progress:turns+' '+(turns===1?'turn':'turns')+(limit>0?' / '+limit:' · No turn limit'),
    reason:String(goal.lastReason||''),canPause:['active','waiting'].includes(status)||(working&&!goal.pauseRequest),canResume:RESUMABLE.has(status)&&!working&&!goal.deadlineExpiredAt&&(!goal.pauseRequest||goal.pauseRequest.settled===true),working};
}
export async function updateConversationGoal({api,conversationId,goal,action,objective,maxTurns,deadlineAt,deadlineTimeZone,executionOptions={}}) {
  if(!conversationId||conversationId==='new')throw Error('Start a conversation before changing its saved goal.');
  if(!ACTIONS.has(action))throw Error('Unknown goal action.');
  if(['set','update'].includes(action)&&(!String(objective??'').trim()))throw Error('Enter an objective for this goal.');
  if(maxTurns!==undefined&&maxTurns!==null&&(!Number.isSafeInteger(maxTurns)||maxTurns<1))throw Error('Use a positive whole number for the turn limit, or leave it empty.');
  return api('/api/conversations/'+encodeURIComponent(conversationId)+'/goal','POST',{
    ...(['set','resume'].includes(action)?executionOptions:{}),action,requestId:stableId('goal'),
    ...(action==='pause'&&goal?.running&&goal?.currentRunId?{pauseRunId:goal.currentRunId}:{}),
    ...(Number.isInteger(goal?.revision)?{expectedRevision:goal.revision}:{}),
    ...(['pause','resume'].includes(action)&&goal?.id&&Number.isSafeInteger(goal.generation)?{
      expectedControl:{goalId:goal.id,generation:goal.generation,status:goal.status,runId:goal.currentRunId||null}
    }:{}),
    ...(objective!==undefined?{objective:String(objective).trim()}:{}),...(maxTurns!==undefined?{maxTurns}:{}),
    ...(deadlineAt!==undefined?{deadlineAt}:{}),...(deadlineTimeZone!==undefined?{deadlineTimeZone}:{})
  });
}

/** The server owns the goal and its loop. This view never schedules work itself. */
export function createGoalControls({view,api,getContext,onStart,onResult=()=>{},onChange=()=>{},onGoalChange=()=>{},notify=()=>{},onError=()=>{}}) {
  let owner='new',goal=null,loading=false,busy=false,locked=false,readonly=false,working=false,destroyed=false,readToken=0,editorOwner=null;
  let readError='',queuedRead=null;
  let specificGoalDraft='',selfDrivingGoalDraft=SELF_DRIVING_GOAL_OBJECTIVE,editorType='specific',editorBinding=null;
  // Goal revisions advance during ordinary progress; only a change of the
  // owner-controlled configuration invalidates an open editor.
  const goalEditBinding=current=>current?JSON.stringify({
    id:current.id??null,generation:current.generation??null,
    // Starting or finishing a Goal changes what Save means. A running Goal
    // can move between active and waiting without invalidating its editor.
    lifecycle:ACTIVE_GOAL.has(current.status)?'enabled':(current.status??null),
    objective:current.objective??'',maxTurns:current.maxTurns??null,
    deadlineAt:current.deadlineAt??null,deadlineTimeZone:current.deadlineTimeZone??null,
    deadlineExpiredAt:current.deadlineExpiredAt??null
  }):null;
  const editorStale=()=>editorOwner!==null&&editorBinding!==goalEditBinding(goal);
  const editorBlockReason=()=>readonly?EDITOR_READONLY_MESSAGE:editorStale()?EDITOR_STALE_MESSAGE:'';
  const showEditorBlock=()=>{
    if(!view.goalDialog.open)return;
    const reason=editorBlockReason();
    if(reason){view.goalError.textContent=reason;view.goalError.hidden=false;}
    else if([EDITOR_READONLY_MESSAGE,EDITOR_STALE_MESSAGE].includes(view.goalError.textContent)){
      view.goalError.textContent='';view.goalError.hidden=true;
    }
  };
  const paint=()=>{
    if(destroyed)return;
    const current=goalPresentation(goal,{running:working});
    view.goalCard.hidden=!current;
    const enabled=Boolean(goal&&ACTIVE_GOAL.has(goal.status));
    const pausePending=goal?.status==='paused'&&goal.pauseRequest&&goal.pauseRequest.settled!==true;
    view.goalToggle.disabled=busy||locked||loading||readonly||Boolean(pausePending);
    view.goalToggle.setAttribute('aria-checked',String(enabled));
    view.goalToggle.dataset.state=enabled?'on':'off';
    view.goalToggle.textContent=enabled?'Goal: On':'Goal: Off';
    view.goalToggle.title=readError|| (pausePending?'Waiting for the current Goal turn to stop.':enabled?'Pause Goal Mode, retaining its saved objective and progress.':goal&&RESUMABLE.has(goal.status)?'Resume this saved Goal Mode in the same chat.':'Create an explicit persistent goal for this conversation.');
    if(current){
      view.goalStatus.textContent=current.label;view.goalCard.dataset.status=current.status;
      view.goalObjective.textContent=current.objective;view.goalProgress.textContent=current.progress;
      view.goalDeadline.textContent=goal?.deadlineAt?'Stop time: '+new Date(goal.deadlineAt).toLocaleString()+' (computer local); originally '+(goal.deadlineTimeZone||'UTC')+' · '+goal.deadlineAt:'';
      view.goalDeadline.hidden=!goal?.deadlineAt;
       if(view.goalDeadlineBrief){view.goalDeadlineBrief.textContent=goal?.deadlineAt?'Stops '+new Date(goal.deadlineAt).toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}):'';view.goalDeadlineBrief.hidden=!goal?.deadlineAt;}
      view.goalReason.textContent=current.reason;view.goalReason.hidden=!current.reason;
      view.goalPause.hidden=!current.canPause;view.goalResume.hidden=!current.canResume;
      for(const control of [view.goalEdit,view.goalPause,view.goalResume,view.goalClear])control.disabled=busy||locked||readonly;
    }
    const blocked=Boolean(editorBlockReason());
    if(view.goalDialog.open){
      if(editorType==='self-driving')view.goalType.setAttribute('aria-describedby','next-chat-goal-mode-help');
      else view.goalType.removeAttribute('aria-describedby');
      const creating=!goal||goal.status==='completed';
      view.goalSave.textContent=creating
        ? editorType==='self-driving'?'Start Self-driving Goal':'Start Goal'
        : ACTIVE_GOAL.has(goal.status)?'Save & continue':'Save Goal';
    }
    view.goalSave.disabled=busy||locked||blocked;
    view.goalCancel.disabled=busy||locked;
    view.goalInput.readOnly=busy||locked||readonly;
    view.goalType.disabled=busy||locked||readonly||editorStale();
    view.goalLimit.disabled=busy||locked||blocked;
    view.goalDeadlineInput.disabled=busy||locked||blocked;
    showEditorBlock();
    view.goalCard.setAttribute('aria-busy',String(busy));
  };
  const closeEditor=()=>{
    editorOwner=null;editorBinding=null;
    if(view.goalDialog.open)view.goalDialog.close();
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
  async function act(action,values={}, {fromEditor=false}={}) {
    if(destroyed||busy||locked||readonly)return false;
    const target=owner;
    busy=true;paint();onChange();
    try {
      if(loading&&queuedRead)await queuedRead.catch(()=>{});
      if(target!==owner||destroyed)return false;
      if(readError)throw Error(readError);
      // A refresh may have completed while this action waited for saved
      // state. Recheck the exact editor's owner-controlled configuration
      // immediately before dispatching the revision-checked POST.
      if(fromEditor&&editorBlockReason())throw Error(editorBlockReason());
      const result=await updateConversationGoal({api,conversationId:target,goal,action,...values,
        executionOptions:getContext()?.executionOptions||{}});
      if(accept(result?.goal??null,target))await onResult(result,target);
      return result;
    } catch(error) {if(['GOAL_REVISION_CONFLICT','GOAL_PAUSE_TARGET','GOAL_PAUSE_PENDING','GOAL_DEADLINE_EXPIRED'].includes(error?.code)&&target===owner&&!destroyed)await refresh();onError(error);throw error;}
    finally {busy=false;if(!destroyed){paint();onChange();}}
  }
  function showEditor() {
    if(destroyed||busy||locked||loading||readonly)return;
    editorOwner=owner;editorBinding=goalEditBinding(goal);
    const context=getContext()||{},turns=Math.max(0,Number(context.calibration?.turns)||0);
    const existing=goal?.objective||goalDraftObjective({draft:context.draft,firstTask:context.calibration?.firstTask,turns});
    const selfDriving=existing.startsWith(SELF_DRIVING_GOAL_OBJECTIVE);
    specificGoalDraft=selfDriving?'':existing;
    selfDrivingGoalDraft=selfDriving?existing:SELF_DRIVING_GOAL_OBJECTIVE;
    editorType=selfDriving?'self-driving':'specific';
    view.goalType.value=editorType;
    view.goalModeHelp.hidden=!selfDriving;
    view.goalInput.value=existing;
    view.goalLimit.value=goal?.maxTurns==null?'':String(goal.maxTurns);
    view.goalDeadlineInput.value=toComputerDateTime(goal?.deadlineAt);
    view.goalDeadlineInput.dataset.original=view.goalDeadlineInput.value;
    view.goalTitle.textContent=goal&&goal.status!=='completed'?'Edit Goal':'Create Goal';
    // Save action text is controlled by paint(), which also reflects the
    // selected starting point and whether the existing Goal is running.
    if(view.goalContext){view.goalContext.hidden=owner==='new';view.goalContext.textContent=owner==='new'?'':`Using this chat’s ${turns} saved ${turns===1?'turn':'turns'} as context. Your corrections and selected settings stay with this conversation.`;}
    view.goalError.hidden=true;
    view.goalDialog.showModal();
    paint(); // Restore editable controls after a previous stale or read-only editor.
    // Expose the starting-point choice on creation; preserve direct text
    // editing focus when reopening an existing Goal.
    (goal?view.goalInput:view.goalType).focus({preventScroll:true});
  }
  async function command(command,{consumeDraft=true}={}) {
    if(!command)return false;
    if(command.action==='status'){
      if(owner!=='new')await refresh();
      const current=goalPresentation(goal,{running:working});
      if(readError)throw Error(readError);
      notify(current?current.label+' · '+current.progress+': '+current.objective:'No Goal Mode objective is set. Use /goal followed by an objective.');
      return {goal};
    }
    if(owner==='new'){
      if(command.action!=='set')throw Error('This conversation does not have a goal yet.');
      const result=await onStart({objective:command.objective,maxTurns:command.maxTurns??null,
        ...(command.deadlineAt!==undefined?{deadlineAt:command.deadlineAt}:{}),
        ...(command.deadlineTimeZone!==undefined?{deadlineTimeZone:command.deadlineTimeZone}:{})},{consumeDraft});
      return result||false;
    }
    return act(command.action,{...(command.objective!==undefined?{objective:command.objective}:{}),...(command.maxTurns!==undefined?{maxTurns:command.maxTurns}:{}),
      ...(command.deadlineAt!==undefined?{deadlineAt:command.deadlineAt}:{}),
      ...(command.deadlineTimeZone!==undefined?{deadlineTimeZone:command.deadlineTimeZone}:{})});
  }
  view.goalToggle.addEventListener('click',async()=>{
    if(destroyed||busy||locked||loading||readonly)return;
    if(goal&&ACTIVE_GOAL.has(goal.status))await act('pause').catch(()=>{});
    else if(goal&&RESUMABLE.has(goal.status)&&!goal.deadlineExpiredAt)await act('resume').catch(()=>{});
    else if(goal?.deadlineExpiredAt)showEditor();
    else showEditor();
  });
  view.goalEdit.addEventListener('click',showEditor);
  view.goalType.addEventListener('change',()=>{
    if(destroyed||busy||locked||readonly||editorStale()||!view.goalDialog.open)return;
    if(!['specific','self-driving'].includes(view.goalType.value)||editorType===view.goalType.value)return;
    if(view.goalType.value==='self-driving'){
      specificGoalDraft=view.goalInput.value;
      view.goalInput.value=selfDrivingGoalDraft;
      view.goalModeHelp.hidden=false;
    }else{
      selfDrivingGoalDraft=view.goalInput.value;
      view.goalInput.value=specificGoalDraft;
      view.goalModeHelp.hidden=true;
    }
    editorType=view.goalType.value;
    paint();
    view.goalInput.focus({preventScroll:true});
  });
  view.goalCancel.addEventListener('click',closeEditor);
  view.goalDialog.addEventListener('cancel',event=>{if(busy)event.preventDefault();else{editorOwner=null;editorBinding=null;}});
  for(const [button,action]of [[view.goalPause,'pause'],[view.goalResume,'resume'],[view.goalClear,'clear']])
    button.addEventListener('click',()=>void act(action).catch(()=>{}));
  view.goalForm.addEventListener('submit',async event=>{
    event.preventDefault();
    if(busy||locked||editorOwner!==owner)return;
    const blocked=editorBlockReason();
    if(blocked){view.goalError.textContent=blocked;view.goalError.hidden=false;paint();return;}
    const objective=view.goalInput.value.trim(),limit=view.goalLimit.value.trim();
    const maxTurns=limit===''?null:Number(limit);
    const deadlineValue=view.goalDeadlineInput.value, original=view.goalDeadlineInput.dataset.original||'';
    view.goalError.hidden=true;
    try{
      if(!objective)throw Error('Enter the outcome you want BLACKICE to achieve.');
      if(maxTurns!==null&&(!Number.isSafeInteger(maxTurns)||maxTurns<1))throw Error('Use a positive whole number for the turn limit, or leave it empty.');
      const deadlineOptions=deadlineValue===original?{}:deadlineValue?computerDeadlineInput(deadlineValue):{deadlineAt:null};
      let result;
      if(owner==='new')result=await command({action:'set',objective,maxTurns,...deadlineOptions},{consumeDraft:false});
      else result=await act(goal&&goal.status!=='completed'?'update':'set',{objective,maxTurns,...deadlineOptions},{fromEditor:true});
      if(result)closeEditor();
    }catch(error){view.goalError.textContent=String(error?.message||error);view.goalError.hidden=false;}
  });
  paint();
  return {
    update(context={}) {
      const target=context.conversationId||'new',changed=target!==owner;
      readonly=Boolean(context.readonly);locked=Boolean(context.busy);working=Boolean(context.running);
      if(changed){
        ++readToken;owner=target;goal=null;loading=false;readError='';closeEditor();if(view.goalDetails)view.goalDetails.open=false;
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
