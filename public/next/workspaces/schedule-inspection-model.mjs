import {scheduleDraftFromTrigger,scheduleLabel,scheduleTriggerFromDraft} from '../../schedule-model.mjs';
import {createMissionWorkflow} from '../../mission-model.mjs';
import {DEFAULT_CHAT_OPTIONS,chatOptionChoices,normalizeChatOptions,validateChatOptions} from '../chat/options-model.mjs';
import {contextOptions,contextModelInfo,validateContextOptions} from '../core/context-controls.mjs';
import {reasoningSupport} from '../../reasoning-model.mjs';
import {serviceTierSupport} from '../../service-tier-model.mjs';

// Pure schedule inspector/editor helpers. Never change an admitted job or its snapshot.
const agents = workflow => (workflow?.nodes || []).filter(node => node.type === 'agent');
const required = (value, label) => {
  const result = String(value ?? '').trim();
  if (!result) throw Error(label + ' is required.');
  return result;
};
const integer = (value, label, min, max, optional = false) => {
  if (optional && String(value ?? '').trim() === '') return null;
  const trimmed = String(value ?? '').trim();
  if (!/^\d+$/.test(trimmed)) throw Error(label + ' must be a whole number.');
  const result = Number(trimmed);
  if (!Number.isSafeInteger(result) || result < min || result > max) throw Error(label + ' must be between ' + min + ' and ' + max + '.');
  return result;
};

export function scheduleTriggerLabel(trigger = {}) {
  return scheduleLabel(trigger);
}

export function scheduleEditDraft(deployment) {
  const trigger = deployment.trigger || { type: 'manual' };
  const agent = agents(deployment.workflow);
  return {
    name: deployment.name || '',
    input: deployment.input || '',
    cwd: deployment.cwd || '',
    enabled: deployment.enabled === true,
    triggerType: trigger.type || 'manual',
    expression: trigger.type === 'cron' ? trigger.expression : '0 9 * * *',
    timezone: scheduleDraftFromTrigger(trigger).timezone,
    everySeconds: trigger.type === 'interval' ? String(trigger.everySeconds) : '3600',
    overlap: deployment.overlap || 'parallel',
    maxAttempts: String(deployment.retry?.maxAttempts ?? 0),
    backoffSeconds: String(deployment.retry?.backoffSeconds ?? 30),
    maxIterations: deployment.limits?.maxIterations == null ? '' : String(deployment.limits.maxIterations),
    runForSeconds: deployment.limits?.runForSeconds == null ? '' : String(deployment.limits.runForSeconds),
    endAt: deployment.limits?.endAt || '',
    agentModel: agent.length === 1 ? agent[0].model || 'default' : null,
    agentEffort: agent.length === 1 ? agent[0].effort || '' : null,
    outboundType: deployment.deliveryTarget?.type || 'local',
    outboundUrl: deployment.deliveryTarget?.url || '', // Show the exact configured URL, including the path and query.
    catchUpPolicy: deployment.missedRunPolicy?.onResume || 'skip',
    catchUpMaxAge: String(deployment.missedRunPolicy?.maxAgeSeconds ?? 86400),
  };
}

export function scheduleUpdateFromDraft(deployment, draft) {
  if (!Number.isSafeInteger(deployment?.revision) || deployment.revision < 1) throw Error('Reload the schedule before editing.');
  const type = draft.triggerType;
  let trigger;
  if (['daily','weekdays','weekly'].includes(type)) trigger = scheduleTriggerFromDraft({...draft,trigger:type});
  else if (type === 'cron') trigger = { type, expression: required(draft.expression, 'Cron expression'), timezone: required(draft.timezone, 'Timezone') };
  else if (type === 'interval' && Object.hasOwn(draft,'intervalAmount')) trigger = scheduleTriggerFromDraft({...draft,trigger:type});
  else if (type === 'interval') trigger = { type, everySeconds: integer(draft.everySeconds, 'Interval seconds', 1, Number.MAX_SAFE_INTEGER) };
  else if (type === 'manual' || type === 'webhook') trigger = { type };
  else throw Error('Choose a supported trigger.');
  if (!['parallel', 'queue', 'skip'].includes(draft.overlap)) throw Error('Choose an overlap policy.');
  const endAt = String(draft.endAt ?? '').trim();
  if (endAt && (!/(Z|[+-]\d\d:\d\d)$/i.test(endAt) || !Number.isFinite(Date.parse(endAt)))) {
    throw Error('End time needs an ISO timestamp with an explicit timezone.');
  }
  const catchUpPolicy=draft.catchUpPolicy||'skip';
  if(!['skip','once'].includes(catchUpPolicy))throw Error('Choose a supported missed-run recovery policy.');
  const limits = {
    maxIterations: integer(draft.maxIterations, 'Maximum runs', 1, Number.MAX_SAFE_INTEGER, true),
    runForSeconds: integer(draft.runForSeconds, 'Run duration (seconds)', 1, Math.floor(Number.MAX_SAFE_INTEGER / 1000), true),
    endAt: endAt || null,
  };
  const payload = {
    expectedRevision: deployment.revision,
    name: required(draft.name, 'Name'),
    input: required(draft.input, 'Task instructions'),
    cwd: required(draft.cwd, 'Working folder'),
    enabled: draft.enabled === true,
    trigger, overlap: draft.overlap,
    retry: {
      maxAttempts: integer(draft.maxAttempts, 'Retry attempts', 0, 3),
      backoffSeconds: integer(draft.backoffSeconds, 'Retry backoff (seconds)', 1, 3600),
    },
    limits,
    missedRunPolicy: {
      onResume: catchUpPolicy,
      maxAgeSeconds: integer(draft.catchUpMaxAge??'86400','Catch-up maximum age',60,604800),
    },
  };
  const previousDestination=deployment.deliveryTarget?.type||'local';
  const outboundType=draft.outboundType||previousDestination;
  const providedUrl=String(draft.outboundUrl??'').trim();
  if(outboundType==='local'){
    if(previousDestination!=='local')payload.deliveryTarget={type:'local'};
  }else if(outboundType==='webhook'){
    if(providedUrl)payload.deliveryTarget={type:'webhook',url:providedUrl};
    else if(previousDestination!=='webhook')throw Error('Enter the HTTPS webhook URL for external delivery.');
  }else throw Error('Choose local results or an HTTPS webhook.');
  const existingAgents = agents(deployment.workflow);
  if (!draft.chatProfile && existingAgents.length === 1 && draft.agentModel !== null && draft.agentModel !== undefined) {
    const model = required(draft.agentModel, 'Agent model');
    const effort = String(draft.agentEffort ?? '');
    if (!['', 'default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(effort)) {
      throw Error('Choose a supported reasoning effort.');
    }
    if (model !== existingAgents[0].model || effort !== (existingAgents[0].effort || '')) {
      const workflow = structuredClone(deployment.workflow);
      const agent = workflow.nodes.find(node => node.id === existingAgents[0].id);
      agent.model = model;
      if (effort) agent.effort = effort;
      else delete agent.effort;
      payload.workflow = workflow;
    }
  }
  if(draft.chatProfile){
    const saved=chatProfileFromDeployment(deployment);
    const profile=normalizeChatOptions(draft.chatProfile.options);
    const profileChanged=Object.keys(saved.options).some(key=>profile[key]!==saved.options[key]);
    const contextChanged=JSON.stringify(draft.chatProfile.context)!==JSON.stringify(saved.context);
    if(profileChanged||contextChanged){
      const proposed=applyChatProfileToWorkflow(deployment.workflow,profile,
        contextChanged?draft.chatProfile.context:undefined,saved.options);
      if(JSON.stringify(proposed)!==JSON.stringify(deployment.workflow))payload.workflow=proposed;
    }
    if(profile.planningExecutionMode!==saved.options.planningExecutionMode)
      payload.planningExecutionMode=profile.planningExecutionMode;
  }
  if(draft.attachmentIds!==undefined){
    const selected=draft.attachmentIds;
    if(!Array.isArray(selected)||selected.length>10||new Set(selected).size!==selected.length||
      selected.some(id=>typeof id!=='string'||!/^[a-zA-Z0-9_-]{1,160}$/.test(id)))
      throw Error('Use up to ten valid attached files.');
    if(JSON.stringify(selected)!==JSON.stringify(deployment.attachmentIds||[]))
      payload.attachmentIds=[...selected];
  }
  // Omitted workflow and attachmentIds intentionally retain their exact saved values.
  return payload;
}

export function scheduleJobs(snapshot, deploymentId, limit = 10) {
  const matches = (snapshot?.jobs || []).filter(job => job.deploymentId === deploymentId);
  return { total: matches.length, jobs: matches.slice(0, limit) };
}

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
      '<option value="model">Model default</option><option value="extended">Extended</option><option value="custom">Custom</option><option value="900k" hidden>Legacy 900k request</option></select></label>',
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

export function applyChatProfileToWorkflow(workflow,options,context,previousOptions={}){
  const profile=normalizeChatOptions(options),copy=structuredClone(workflow);
  const agentNodes=agents(copy);
  if(agentNodes.length!==1)throw Error('Chat settings require a single-agent task. For a multi-agent workflow, configure individual agents in Workflows.');
  const node=agentNodes[0];
  for(const key of ['model','effort','serviceTier'])
    if(profile[key]!==previousOptions[key])node[key]=profile[key];
  if(profile.planningMode!==previousOptions.planningMode){
    copy.settings??={};
    copy.settings.planningMode=profile.planningMode==='off'?'off':'on';
    if(profile.planningMode==='off')delete copy.settings.planningEnforcement;
    else copy.settings.planningEnforcement=profile.planningMode;
  }
  if(profile.planningExecutionMode!==previousOptions.planningExecutionMode){
    copy.settings??={};
    copy.settings.planningExecutionMode=profile.planningExecutionMode;
  }
  if(context!==undefined){
    const saved=contextOptions(context);
    copy.settings??={};
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
  f.preset.value=savedContext.preset;
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
      if(option.value==='900k')option.hidden=f.preset.value!=='900k';
    }
    const custom=f.preset.value==='custom';
    f.window.closest('label').hidden=!custom;
    const help=mount.querySelector('[data-schedule-context-help]');
    if(help)help.textContent=info.automaticOnly
      ?'This model manages context automatically. Custom context and compression settings are unavailable.'
      :'Model default follows the selected model. Extended uses its reported maximum; Custom sets a token budget.';
    for(const input of [f.preset,f.auto,f.trigger,f.recent,f.reserve,f.headroom])
      input.disabled=info.automaticOnly;
    f.window.disabled=!custom||info.automaticOnly;
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
      // Preserve pinned selections when editing unrelated fields, even if the catalog has changed.
      const sameSavedModel=context!==undefined&&chosen.model===saved.model;
      let profile;
      if(sameSavedModel){
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
      const unchangedContext=JSON.stringify(contextOptions(raw))===JSON.stringify(savedContext);
      const selectedContext=sameSavedModel&&unchangedContext?savedContext:
        info.automaticOnly?contextOptions():validateContextOptions(raw,info);
      return{options:profile,context:selectedContext};
    },
    values:f,
    refresh:()=>sync(),
  };
}
