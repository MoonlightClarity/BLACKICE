import {createMissionWorkflow} from '../../mission-model.mjs';
import {DEFAULT_CHAT_OPTIONS,chatOptionChoices,normalizeChatOptions,validateChatOptions} from '../chat/options-model.mjs';
import {contextOptions,contextModelInfo,validateContextOptions} from '../core/context-controls.mjs';
import {reasoningSupport} from '../../reasoning-model.mjs';
import {serviceTierSupport} from '../../service-tier-model.mjs';

/** Shared Chat execution semantics. Schedule timing is deliberately independent of this profile. */
export const scheduleChatOptionsMarkup=()=>[
  '<div class="next-stack" data-schedule-chat-options>',
  '<h4>Chat execution settings</h4>',
  '<p class="next-help">These settings are pinned to each future scheduled run, independently of the current Chat selection.</p>',
  '<label class="next-label">Model<select class="next-field" name="agentModel"></select></label>',
  '<label class="next-label">Reasoning<select class="next-field" name="agentEffort"></select></label>',
  '<label class="next-label">Speed<select class="next-field" name="agentServiceTier"></select></label>',
  '<label class="next-label">Planning<select class="next-field" name="planningMode">',
    '<option value="forced">Forced</option><option value="advisory">Advisory</option><option value="off">Off</option></select></label>',
  '<label class="next-label">Execution<select class="next-field" name="planningExecutionMode">',
    '<option value="automatic">Automatic</option><option value="plan_only">Plan only</option></select></label>',
  '<details data-schedule-context><summary>Context and compression settings</summary>',
    '<label class="next-label">Context budget<select class="next-field" name="contextPreset">',
      '<option value="model">Model default</option><option value="extended">Extended</option><option value="custom">Custom</option></select></label>',
    '<label class="next-label" data-schedule-context-window>Custom context (tokens)<input class="next-field" type="number" min="4096" max="4000000" step="1" name="contextWindowTokens"></label>',
    '<label class="next-label"><input type="checkbox" name="contextAutoCompact"> Automatically compress when needed</label>',
    '<label class="next-label">Compression trigger (tokens, optional)<input class="next-field" type="number" min="256" max="4000000" name="contextCompactAtTokens"></label>',
    '<label class="next-label">Recent context to keep (tokens, optional)<input class="next-field" type="number" min="256" max="256000" name="contextKeepRecentTokens"></label>',
    '<label class="next-label">Output reserve (tokens, optional)<input class="next-field" type="number" min="256" max="128000" name="contextOutputReserveTokens"></label>',
    '<label class="next-label">Safety headroom (tokens, optional)<input class="next-field" type="number" min="128" max="256000" name="contextHeadroomTokens"></label>',
    '<p class="next-help" data-schedule-context-help></p>',
  '</details>',
  '</div>'
].join('');

const agents=workflow=>(workflow?.nodes||[]).filter(node=>node.type==='agent');
export function chatProfileFromDeployment(deployment={}){
  const workflow=deployment.workflow||{},node=agents(workflow)[0]||{};
  const settings=workflow.settings||{};
  const planningMode=settings.planningMode==='off'?'off':
    settings.planningEnforcement==='forced'?'forced':settings.planningEnforcement==='advisory'?'advisory':'advisory';
  return {options:normalizeChatOptions({
    model:node.model||'default',effort:node.effort||'default',serviceTier:node.serviceTier||'default',
    planningMode,planningExecutionMode:deployment.planningExecutionMode||settings.planningExecutionMode||'automatic'
  }),context:contextOptions(node.context||settings.context||{}),agentCount:agents(workflow).length};
}

export function applyChatProfileToWorkflow(workflow,options,context){
  const profile=normalizeChatOptions(options),copy=structuredClone(workflow);
  const agentNodes=agents(copy);
  if(agentNodes.length!==1)throw Error('Chat settings require a single-agent task. For a multi-agent workflow, configure individual agents in Workflows.');
  const node=agentNodes[0];
  node.model=profile.model;
  node.effort=profile.effort;
  node.serviceTier=profile.serviceTier;
  copy.settings={...copy.settings,planningMode:profile.planningMode==='off'?'off':'on',
    planningExecutionMode:profile.planningExecutionMode};
  if(profile.planningMode==='off')delete copy.settings.planningEnforcement;
  else copy.settings.planningEnforcement=profile.planningMode;
  if(context!==undefined){
    const saved=contextOptions(context);
    copy.settings.context=saved;
    node.context=structuredClone(saved);
  }
  return copy;
}

export function createScheduledChatWorkflow({task,cwd,options=DEFAULT_CHAT_OPTIONS,context}){
  const profile=normalizeChatOptions(options);
  if(profile.planningMode==='off'&&profile.planningExecutionMode==='plan_only')throw Error('Plan only requires Planning On.');
  const created=createMissionWorkflow({task,cwd,model:profile.model,effort:profile.effort,
    serviceTier:profile.serviceTier,planningMode:profile.planningMode,
    id:'scheduled_chat_'+crypto.randomUUID()});
  return applyChatProfileToWorkflow(created,profile,context);
}

export function initScheduleChatOptions(mount,{getStatus=()=>({}),options=DEFAULT_CHAT_OPTIONS,context}={}){
  if(!mount?.querySelector('[data-schedule-chat-options]'))throw Error('Missing schedule Chat controls.');
  const field=name=>mount.querySelector('[name="'+name+'"]');
  const f={model:field('agentModel'),effort:field('agentEffort'),tier:field('agentServiceTier'),
    planning:field('planningMode'),execution:field('planningExecutionMode'),
    preset:field('contextPreset'),window:field('contextWindowTokens'),
    auto:field('contextAutoCompact'),trigger:field('contextCompactAtTokens'),recent:field('contextKeepRecentTokens'),
    reserve:field('contextOutputReserveTokens'),headroom:field('contextHeadroomTokens')};
  const saved=normalizeChatOptions(options),savedContext=contextOptions(context||getStatus()?.runtimeSettings?.defaultContext||{});
  f.planning.value=saved.planningMode;f.execution.value=saved.planningExecutionMode;
  f.preset.value=savedContext.preset==='900k'?'custom':savedContext.preset;
  f.window.value=String(savedContext.windowTokens||'');
  f.auto.checked=savedContext.autoCompact;
  for(const [key,property]of [['trigger','compactAtTokens'],['recent','keepRecentTokens'],
    ['reserve','outputReserveTokens'],['headroom','headroomTokens']])
    f[key].value=String(savedContext[property]??'');
  const fill=(select,choices,wanted)=>{
    select.replaceChildren();
    for(const choice of choices){
      const option=select.ownerDocument.createElement('option');
      option.value=choice.id;option.textContent=choice.label;option.disabled=Boolean(choice.disabled);
      select.append(option);
    }
    const selected=choices.find(item=>item.id===wanted);
    select.value=selected?wanted:choices[0]?.id||'default';
  };
  const sync=({first=false}={})=>{
    const old={model:first?saved.model:f.model.value,effort:first?saved.effort:f.effort.value,
      serviceTier:first?saved.serviceTier:f.tier.value,planningMode:f.planning.value,
      planningExecutionMode:f.execution.value};
    const choices=chatOptionChoices(getStatus()||{},old);
    fill(f.model,choices.models,old.model);
    fill(f.effort,choices.efforts,old.effort);
    fill(f.tier,choices.tiers,old.serviceTier);
    const info=contextModelInfo(getStatus()||{},f.model.value);
    for(const option of f.preset.querySelectorAll('option')){
      if(option.value==='extended')option.disabled=!info.maxWindow||info.automaticOnly;
      if(option.value==='custom')option.disabled=info.automaticOnly;
    }
    const custom=f.preset.value==='custom';
    f.window.closest('label').hidden=!custom;
    const help=mount.querySelector('[data-schedule-context-help]');
    if(help)help.textContent=info.automaticOnly
      ?'This model manages context automatically. Custom context and compression settings are unavailable.'
      :'Model default follows the selected model. Extended uses its reported maximum; Custom sets a token budget.';
    for(const input of [f.window,f.auto,f.trigger,f.recent,f.reserve,f.headroom])
      input.disabled=info.automaticOnly;
    if(info.automaticOnly){
      f.preset.value='model';f.auto.checked=true;f.window.value='';
      for(const input of [f.trigger,f.recent,f.reserve,f.headroom])input.value='';
    }
  };
  f.model.addEventListener('change',()=>sync());
  f.preset.addEventListener('change',()=>sync());
  f.execution.addEventListener('change',()=>{
    if(f.execution.value==='plan_only')f.planning.value='forced';
  });
  sync({first:true});
  return{
    read(){
      const status=getStatus()||{};
      const chosen={model:f.model.value,effort:f.effort.value,serviceTier:f.tier.value,
        planningMode:f.planning.value,planningExecutionMode:f.execution.value};
      // A saved model may be temporarily unavailable; editing unrelated fields must not retarget it.
      const historical=chosen.model!=='default'&&chosen.model===saved.model&&
        !(status.models||[]).some(item=>(item.id||item.model)===chosen.model&&item.available!==false);
      let profile;
      if(historical){
        profile=normalizeChatOptions(chosen);
        if(profile.planningMode==='off'&&profile.planningExecutionMode==='plan_only')
          throw Error('Plan only requires Planning On.');
        const reason=reasoningSupport(status,profile.model,profile.effort);
        const tier=serviceTierSupport(status,profile.model,profile.serviceTier);
        if(!reason.available&&profile.effort!==saved.effort)throw Error(reason.error);
        if(!tier.available&&profile.serviceTier!==saved.serviceTier)throw Error(tier.error);
      }else profile=validateChatOptions(status,chosen);
      const parse=element=>{
        const value=element.value.trim();
        if(!value)return undefined;
        if(!/^\d+$/.test(value))throw Error('Context values must be whole token counts.');
        return Number(value);
      };
      const raw={preset:f.preset.value,autoCompact:f.auto.checked,
        windowTokens:f.preset.value==='custom'?parse(f.window):null,
        compactAtTokens:parse(f.trigger),keepRecentTokens:parse(f.recent),
        outputReserveTokens:parse(f.reserve),headroomTokens:parse(f.headroom)};
      const info=contextModelInfo(getStatus()||{},profile.model);
      const selectedContext=validateContextOptions(raw,info);
      return{options:profile,context:selectedContext};
    },
    values:f,
    refresh:()=>sync(),
  };
}
