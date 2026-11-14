import {stableId} from '../core/dom.mjs';

/**
 * Autonomy is a chat operating mode, not a persistent Goal. Selection data
 * comes from the live provider catalog, not a hardcoded capability matrix.
 */
export function autonomyModelChoices(status={},saved=[]){
  const entries=new Map();
  for(const item of Array.isArray(status.models)?status.models:[]){
    const id=item?.id||item?.model;
    if(typeof id!=='string'||!id||id==='default'||entries.has(id))continue;
    entries.set(id,{id,label:item.displayName||id,available:item.available!==false});
  }
  for(const id of saved){
    if(typeof id==='string'&&id&&!entries.has(id))entries.set(id,{id,label:id+' (not currently in catalog)',available:false});
  }
  return [...entries.values()];
}
export function selectedAutonomyModels(modelRows){
  return modelRows.filter(row=>row.input.checked).map(row=>row.id);
}

export function createAutonomyControls({view,api,getStatus,getContext,onResult=()=>{},onChange=()=>{},onError=()=>{}}){
  let owner='new',value=null,busy=false,loading=false,locked=false,readonly=false,destroyed=false,readToken=0;
  let readError='',selectedModels=[],modelRows=[],editorOwner=null;
  const {autonomyToggle:toggle,autonomySettings:settings,autonomyDialog:dialog,autonomyForm:form,
    autonomyCalibration:calibration,autonomySearch:search,autonomyModels:models,autonomyError:errorText,
    autonomyCancel:cancel,autonomySave:save}=view;
  const paint=()=>{
    if(destroyed)return;
    const enabled=value?.enabled===true;
    toggle.textContent=enabled?'Autonomy: On':'Autonomy: Off';
    toggle.setAttribute('aria-checked',String(enabled));
    toggle.dataset.state=enabled?'on':'off';
    const unavailable=owner==='new'||busy||loading||locked||readonly;
    toggle.disabled=unavailable;
    toggle.title=owner==='new'?'Start a conversation before enabling autonomous operation.'
      :readError|| (enabled?'Disable automatic continuation without deleting calibration.'
      :value?'Resume autonomous operation with saved calibration and model allowlist.'
      :'Configure permitted models and turn autonomous operation on.');
    settings.disabled=unavailable;
    settings.title='Edit autonomy calibration and model whitelist.';
    settings.hidden=owner==='new'&&!value;
    save.disabled=busy;cancel.disabled=busy;calibration.readOnly=busy;search.disabled=busy;
  };
  const close=()=>{editorOwner=null;if(dialog.open)dialog.close();};
  function populate(){
    const status=getStatus()||{};
    models.replaceChildren();modelRows=[];
    const existing=Array.isArray(value?.modelAllowlist)?value.modelAllowlist:[];
    const options=autonomyModelChoices(status,existing);
    const preferred=getContext()?.model;
    const suggested=preferred&&preferred!=='default'?preferred:status.defaultModel;
    const checkSet=new Set(existing.length?existing:suggested?[suggested]:[]);
    for(const item of options){
      const label=models.ownerDocument.createElement('label');
      label.className='next-chat-autonomy-model';
      label.title=item.id;
      const input=models.ownerDocument.createElement('input');input.type='checkbox';input.value=item.id;
      input.checked=checkSet.has(item.id);
      const name=models.ownerDocument.createElement('span');
      name.textContent=item.label+(item.available?'':' · unavailable');
      if(!item.available)label.dataset.unavailable='true';
      label.append(input,name);models.append(label);
      modelRows.push({id:item.id,input,label,text:(item.label+' '+item.id).toLowerCase(),available:item.available});
    }
    filterModels();
  }
  function filterModels(){
    const query=search.value.trim().toLowerCase();
    for(const row of modelRows)row.label.hidden=!!query&&!row.text.includes(query);
  }
  function showEditor(){
    if(destroyed||owner==='new'||busy||loading||locked||readonly)return;
    editorOwner=owner;calibration.value=value?.calibration||'';
    search.value='';errorText.hidden=true;errorText.textContent='';
    populate();save.textContent=value?.enabled?'Save calibration':'Enable autonomy';
    dialog.showModal();calibration.focus({preventScroll:true});
  }
  function accept(next,target=owner){
    if(destroyed||target!==owner)return false;
    if(next&&value&&next.id===value.id&&Number(next.revision)<Number(value.revision))return false;
    value=next||null;loading=false;readError='';paint();onChange();
    return true;
  }
  async function refresh(){
    if(owner==='new'||destroyed)return null;
    const target=owner,token=++readToken;
    loading=true;paint();
    try{
      const result=await api('/api/conversations/'+encodeURIComponent(target)+'/autonomy','GET');
      if(destroyed||owner!==target||token!==readToken)return null;
      accept(result?.autonomy??null,target);
      return value;
    }catch(error){
      if(!destroyed&&owner===target&&token===readToken){readError=String(error?.message||'Could not load autonomy settings.');paint();}
      return null;
    }finally{if(!destroyed&&owner===target&&token===readToken){loading=false;paint();}}
  }
  async function act(action,patch={}){
    if(destroyed||owner==='new'||busy||locked||readonly)return false;
    const target=owner;
    busy=true;paint();onChange();
    try{
      const result=await api('/api/conversations/'+encodeURIComponent(target)+'/autonomy','POST',{
        action,requestId:stableId('autonomy'),
        ...(Number.isSafeInteger(value?.revision)?{expectedRevision:value.revision}:{}),...patch,
      });
      accept(result?.autonomy??null,target);
      if(result?.run?.id)await onResult(result,target);
      return result;
    }catch(error){
      if(['AUTONOMY_REVISION_CONFLICT','AUTONOMY_GOAL_CONFLICT'].includes(error?.code))await refresh();
      onError(error);throw error;
    }finally{busy=false;paint();onChange();}
  }
  toggle.addEventListener('click',async()=>{
    if(destroyed||busy||loading||locked||readonly||owner==='new')return;
    if(value?.enabled)await act('disable').catch(()=>{});
    else if(value)await act('resume').catch(()=>{});
    else showEditor();
  });
  settings.addEventListener('click',showEditor);
  search.addEventListener('input',filterModels);
  cancel.addEventListener('click',close);
  dialog.addEventListener('cancel',event=>{if(busy)event.preventDefault();else editorOwner=null;});
  form.addEventListener('submit',async event=>{
    event.preventDefault();
    if(busy||locked||readonly||editorOwner!==owner)return;
    const modelAllowlist=selectedAutonomyModels(modelRows);
    errorText.hidden=true;
    try{
      if(!modelAllowlist.length)throw Error('Select at least one model to permit autonomous operation.');
      if(modelAllowlist.length>64)throw Error('Select at most 64 models.');
      const selectedModel=value?.selectedModel&&modelAllowlist.includes(value.selectedModel)?value.selectedModel:null;
      const result=await act(value?.enabled?'calibrate':'enable',{
        calibration:calibration.value,modelAllowlist,selectedModel,
      });
      if(result)close();
    }catch(error){errorText.textContent=String(error?.message||error);errorText.hidden=false;}
  });
  paint();
  return{
    update({conversationId='new',busy:externalBusy=false,readonly:isReadonly=false}={}){
      const target=conversationId||'new',changed=target!==owner;
      locked=Boolean(externalBusy);readonly=Boolean(isReadonly);
      if(changed){++readToken;owner=target;value=null;loading=false;readError='';close();if(owner!=='new')void refresh();}
      paint();
    },
    refresh,
    handleEvent(event){
      if(event?.type!=='autonomy.updated')return false;
      const data=event.data||{},target=data.conversationId;
      if(target!==owner)return false;
      if(accept(data.autonomy,target)){
        const runId=data.autonomy?.currentRunId;
        if(runId&&runId!==getContext()?.runId)void onResult({autonomy:data.autonomy,run:{id:runId}},target);
      }
      return true;
    },
    getAutonomy:()=>value,
    isBusy:()=>busy,
    close,
    destroy(){destroyed=true;++readToken;close();}
  };
}
