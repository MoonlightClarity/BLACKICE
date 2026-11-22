import { missingApiModelConnection } from '../../provider-availability.mjs';
import { reasoningChoices, reasoningSupport } from '../../reasoning-model.mjs';
import { serviceTierSupport } from '../../service-tier-model.mjs';
import { UNKNOWN_CHAT_MODEL } from './model.mjs';
import {assertExecutablePlanningMode} from '../../response-cycle-model.mjs';

export const DEFAULT_CHAT_OPTIONS=Object.freeze({
  model:'default',effort:'default',serviceTier:'default',planningMode:'off',planningExecutionMode:'automatic',
});
export function normalizeChatOptions(value={}){
  const model=typeof value?.model==='string'&&value.model.length<=400?value.model:'default';
  const effort=typeof value?.effort==='string'&&value.effort.length<=25?value.effort:'default';
  const serviceTier=['default','fast'].includes(value?.serviceTier)?value.serviceTier:'default';
  const planningMode='off';
  const planningExecutionMode=value?.planningExecutionMode??'automatic';
  return {model,effort,serviceTier,planningMode,planningExecutionMode};
}
/** Reading a saved run must not erase a no-execution constraint. */
export function savedChatExecutionMode(run,fallback='automatic'){
  const modes=[run?.planningExecutionMode,run?.workflow?.settings?.planningExecutionMode];
  return modes.includes('plan_only')?'plan_only':modes.find(value=>value!==undefined)??fallback;
}
export function resolvedDefaultModel(status={}) {
  const saved=typeof status.defaultModel==='string'&&status.defaultModel.trim()&&status.defaultModel!=='default'?status.defaultModel.trim():null;
  const model=saved&&(status.models||[]).find(item=>(item?.id||item?.model)===saved);
  if(missingApiModelConnection(status,saved))return {id:null,name:'',label:'Default API connection removed',available:false,connectionRemoved:true};
  const name=model?.displayName||saved||'';
  const label=name?'Default · '+name:status.defaultModelInitializing?'Default · resolving…':'Default · not configured';
  return {id:saved,name,label,available:status.defaultModelAvailable!==false};
}
export function chatOptionChoices(status={},raw={}){
  const selected=normalizeChatOptions(raw);
  const defaultInfo=resolvedDefaultModel(status),localDefault=status.localDefaultModelStatus;
  const isRetired=id=>/^(?:antigravity|qwen_code)::/.test(id||'');
  const models=[{id:'default',label:defaultInfo.label,disabled:defaultInfo.connectionRemoved===true}];
  for(const item of status.models||[]){
    const id=item?.id||item?.model;
    // Catalogs can be cached in a mounted chat even after the runtime has
    // retired its adapters. Do not offer obsolete native CLIs as choices.
    if(typeof id!=='string'||!id||isRetired(id)||missingApiModelConnection(status,id)||models.some(x=>x.id===id))continue;
    const local=localDefault?.eligible===true&&localDefault.model===id;
    models.push({id,label:(local?'Local · ':'')+(item.displayName||id),disabled:item.available===false,...(local?{shortcut:'local'}:{})});
  }
  if(selected.model!=='default'&&!models.some(item=>item.id===selected.model)){
    const old=isRetired(selected.model),removed=missingApiModelConnection(status,selected.model);
    const removedLocal=(status.providers||[]).some(provider=>['llamacpp','ollama','lmstudio'].includes(provider.preset)&&selected.model.startsWith(provider.id+'::'));
    const provider=selected.model.startsWith('antigravity::')?'Antigravity':selected.model.startsWith('qwen_code::')?'Qwen Code':'';
    // A selected *historical* model is retained in the control for an exact
    // label, but is never offered as a new selectable model.
    models.push({id:selected.model,label:old
      ?provider+' · '+selected.model.split('::').slice(1).join('::')+' · retired (historical chat)'
      :removed?'API connection removed. Choose a model.'
      :selected.model===UNKNOWN_CHAT_MODEL?'Saved model unknown · choose a model':selected.model+' · unavailable',
      disabled:true,historical:old||removed||removedLocal});
  }
  const efforts=reasoningChoices(status,selected.model,selected.effort)
    .map(item=>({id:item.value,label:item.label,disabled:!item.available,verified:item.verified}));
  const fast=serviceTierSupport(status,selected.model,'fast');
  const tiers=[{id:'default',label:'Standard',disabled:false},
    {id:'fast',label:'Fast',disabled:!fast.available,verified:fast.verified}];
  return {models,efforts,tiers,selected,defaultInfo};
}
export function validateChatOptions(status={},raw={}){
  assertExecutablePlanningMode(raw?.planningExecutionMode);
  const selection=normalizeChatOptions(raw);
  if(selection.model===UNKNOWN_CHAT_MODEL)throw Error('This chat has no saved model evidence. Choose a model to continue.');
  const route=selection.model==='default'?status.defaultModel:selection.model;
  if(missingApiModelConnection(status,route))throw Error('The API connection was removed. Choose another model.');
  if(selection.model!=='default'){
    const matching=(status.models||[]).find(m=>(m.id||m.model)===selection.model);
    if(!matching||matching.available===false)throw Error(matching?.availabilityReason||'Choose an available model.');
  }
  const reason=reasoningSupport(status,selection.model,selection.effort);
  if(!reason.available)throw Error(reason.error||'This reasoning level is not available for the selected model.');
  const tier=serviceTierSupport(status,selection.model,selection.serviceTier);
  if(!tier.available)throw Error(tier.error||'This service tier is not available for the selected model.');
  return selection;
}
