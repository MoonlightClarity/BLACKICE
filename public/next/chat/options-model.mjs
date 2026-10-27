import { reasoningChoices, reasoningSupport } from '../../reasoning-model.mjs';
import { serviceTierSupport } from '../../service-tier-model.mjs';

export const DEFAULT_CHAT_OPTIONS=Object.freeze({
  model:'default',effort:'default',serviceTier:'default',planningMode:'auto',
});
export const PLANNING_MODES=Object.freeze(['auto','on','maximal','off']);
export function normalizeChatOptions(value={}){
  const model=typeof value?.model==='string'&&value.model.length<=180?value.model:'default';
  const effort=typeof value?.effort==='string'&&value.effort.length<=25?value.effort:'default';
  const serviceTier=['default','fast'].includes(value?.serviceTier)?value.serviceTier:'default';
  const planningMode=PLANNING_MODES.includes(value?.planningMode)?value.planningMode:'auto';
  return {model,effort,serviceTier,planningMode};
}
export function resolvedDefaultModel(status={}) {
  const saved=typeof status.defaultModel==='string'&&status.defaultModel.trim()&&status.defaultModel!=='default'?status.defaultModel.trim():null;
  const model=saved&&(status.models||[]).find(item=>(item?.id||item?.model)===saved);
  const name=model?.displayName||saved||'';
  const label=name?'Default · '+name:status.defaultModelInitializing?'Default · resolving…':'Default · not configured';
  return {id:saved,name,label,available:status.defaultModelAvailable!==false};
}
export function chatOptionChoices(status={},raw={}){
  const selected=normalizeChatOptions(raw);
  const defaultInfo=resolvedDefaultModel(status);
  const models=[{id:'default',label:defaultInfo.label,disabled:false}];
  for(const item of status.models||[]){
    const id=item?.id||item?.model;
    if(typeof id!=='string'||!id||models.some(x=>x.id===id))continue;
    models.push({id,label:item.displayName||id,disabled:item.available===false});
  }
  const efforts=reasoningChoices(status,selected.model,selected.effort)
    .map(item=>({id:item.value,label:item.label,disabled:!item.available,verified:item.verified}));
  const fast=serviceTierSupport(status,selected.model,'fast');
  const tiers=[{id:'default',label:'Standard',disabled:false},
    {id:'fast',label:'Fast',disabled:!fast.available,verified:fast.verified}];
  return {models,efforts,tiers,selected,defaultInfo};
}
export function validateChatOptions(status={},raw={}){
  const selection=normalizeChatOptions(raw);
  if(selection.model!=='default'){
    const matching=(status.models||[]).find(m=>(m.id||m.model)===selection.model);
    if(!matching||matching.available===false)throw Error('Choose an available model.');
  }
  const reason=reasoningSupport(status,selection.model,selection.effort);
  if(!reason.available)throw Error(reason.error||'This reasoning level is not available for the selected model.');
  const tier=serviceTierSupport(status,selection.model,selection.serviceTier);
  if(!tier.available)throw Error(tier.error||'This service tier is not available for the selected model.');
  return selection;
}
