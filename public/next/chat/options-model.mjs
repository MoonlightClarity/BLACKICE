import { reasoningChoices, reasoningSupport } from '../../reasoning-model.mjs';
import { serviceTierSupport } from '../../service-tier-model.mjs';
import { UNKNOWN_CHAT_MODEL } from './model.mjs';
import {normalizePlanningOntology} from '../../planning-module-policy.mjs';
import {assertExecutablePlanningMode} from '../../response-cycle-model.mjs';

export const DEFAULT_CHAT_OPTIONS=Object.freeze({
  model:'default',effort:'default',serviceTier:'default',planningMode:'ontology',planningExecutionMode:'automatic',planningOntology:normalizePlanningOntology(),directoryMode:'off',subagentsMode:'default',
});
export const PLANNING_MODES=Object.freeze(['ontology','off']);
export function normalizeChatOptions(value={}){
  const model=typeof value?.model==='string'&&value.model.length<=400?value.model:'default';
  const effort=typeof value?.effort==='string'&&value.effort.length<=25?value.effort:'default';
  const serviceTier=['default','fast'].includes(value?.serviceTier)?value.serviceTier:'default';
  const planningMode=value?.planningMode==='off'?'off':'ontology';
  const planningExecutionMode=value?.planningExecutionMode??'automatic';
  const directoryMode=value?.directoryMode==='on'||value?.directoryMode==='auto'?'on':'off';
  const subagentsMode='default';
  return {model,effort,serviceTier,planningMode,planningExecutionMode,directoryMode,subagentsMode,...(planningMode==='ontology'||value?.planningOntology!==undefined?{planningOntology:normalizePlanningOntology(value?.planningOntology)}:{})};
}
/**
 * A legacy persisted Forced draft had no module policy because Forced was the
 * default before this release. Upgrade only that old new-chat preference; an
 * explicit modern Legacy Forced choice includes the ontology field and survives.
 * Saved historical run contracts are never rewritten by this draft migration.
 */
export function restoreChatPlanningOptions(raw={},runtimeDefault){
  const saved=raw&&typeof raw==='object'&&!Array.isArray(raw)?raw:{};
  const oldForcedDefault=['forced','advisory','on','auto','maximal'].includes(saved.planningMode);
  return normalizeChatOptions({
    ...saved,
    ...(oldForcedDefault?{planningMode:'ontology'}:{}),
    planningOntology:saved.planningOntology??runtimeDefault,
  });
}
/** Reading a saved run must not erase a no-execution constraint. */
export function savedChatExecutionMode(run,fallback='automatic'){
  const modes=[run?.planningExecutionMode,run?.workflow?.settings?.planningExecutionMode];
  return modes.includes('plan_only')?'plan_only':modes.find(value=>value!==undefined)??fallback;
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
  const isRetired=id=>/^(?:antigravity|qwen_code)::/.test(id||'');
  const models=[{id:'default',label:defaultInfo.label,disabled:false}];
  for(const item of status.models||[]){
    const id=item?.id||item?.model;
    // Catalogs can be cached in a mounted chat even after the runtime has
    // retired its adapters. Do not offer obsolete native CLIs as choices.
    if(typeof id!=='string'||!id||isRetired(id)||models.some(x=>x.id===id))continue;
    models.push({id,label:item.displayName||id,disabled:item.available===false});
  }
  if(selected.model!=='default'&&!models.some(item=>item.id===selected.model)){
    const old=isRetired(selected.model);
    const provider=selected.model.startsWith('antigravity::')?'Antigravity':selected.model.startsWith('qwen_code::')?'Qwen Code':'';
    // A selected *historical* model is retained in the control for an exact
    // label, but is never offered as a new selectable model.
    models.push({id:selected.model,label:old
      ?provider+' · '+selected.model.split('::').slice(1).join('::')+' · retired (historical chat)'
      :selected.model===UNKNOWN_CHAT_MODEL?'Saved model unknown · choose a model':selected.model+' · unavailable',
      disabled:true,historical:old});
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
