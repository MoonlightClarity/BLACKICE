import { isChatModeModel } from './model-routes.mjs';

export const REASONING_LEVELS = ['none','minimal','low','medium','high','xhigh','max','ultra'];
export const reasoningLabel = value => value === 'default' ? 'Model default' : value === 'xhigh' ? 'Extra high' : String(value || '').replace(/^./, letter => letter.toUpperCase());
export function reasoningModel(status = {}, selection = 'default') {
  const id = selection === 'default' ? status.defaultModel : selection === 'codex' ? (status.codex || status).defaultModel : selection;
  return (status.models || []).find(model => (model.id || model.model) === id || model.model === id);
}
export const reasoningSelectionSupported = (status = {}, selection = 'default') => !isChatModeModel(selection, status) && reasoningModel(status, selection)?.supportsReasoningSelection !== false;
export function reasoningSupport(status = {}, selection = 'default', effort = 'default') {
  if (!reasoningSelectionSupported(status, selection)) return effort === 'default' || effort == null
    ? { available: true, verified: true, error: '' }
    : { available: false, verified: true, error: 'This model does not expose reasoning selection. Use the model default.' };
  if (effort === 'default' || effort == null) return { available:true, verified:true, error:'' };
  if (!REASONING_LEVELS.includes(effort)) return {available:false,verified:true,error:'Choose a valid reasoning level.'};
  const model=reasoningModel(status,selection),supported=(model?.supportedReasoningEfforts || []).map(item=>typeof item==='string'?item:item.reasoningEffort).filter(Boolean);
  if (!supported.length) return {available:true,verified:false,error:''};
  return supported.includes(effort) ? {available:true,verified:true,error:''} : {available:false,verified:true,error:`${model.displayName || model.id || model.model} does not offer ${reasoningLabel(effort)} reasoning. Choose another level or model.`};
}
export function reasoningChoices(status = {}, selection = 'default', selected = 'default') {
  if (!reasoningSelectionSupported(status, selection)) return [{ value: 'default', label: 'Model default', available: true, verified: true, error: '' }];
  const model=reasoningModel(status,selection),advertised=(model?.supportedReasoningEfforts || []).map(item=>typeof item==='string'?item:item.reasoningEffort).filter(value=>REASONING_LEVELS.includes(value));
  const levels=advertised.length?advertised:REASONING_LEVELS;
  const values=['default',...levels,...(selected && selected!=='default' && !levels.includes(selected)?[selected]:[])];
  return values.map(value=>({value,label:reasoningLabel(value),...reasoningSupport(status,selection,value)}));
}
