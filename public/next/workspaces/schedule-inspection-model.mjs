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
  if (trigger.type === 'cron') return trigger.expression + ' · ' + trigger.timezone;
  if (trigger.type === 'interval') return 'Every ' + trigger.everySeconds + ' seconds';
  return trigger.type || 'manual';
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
    timezone: trigger.type === 'cron' ? trigger.timezone : 'America/New_York',
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
  if (type === 'cron') trigger = { type, expression: required(draft.expression, 'Cron expression'), timezone: required(draft.timezone, 'Timezone') };
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
  if (existingAgents.length === 1 && draft.agentModel !== null && draft.agentModel !== undefined) {
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
  // Omitted workflow and attachmentIds intentionally retain their exact saved values.
  return payload;
}

export function scheduleJobs(snapshot, deploymentId, limit = 10) {
  const matches = (snapshot?.jobs || []).filter(job => job.deploymentId === deploymentId);
  return { total: matches.length, jobs: matches.slice(0, limit) };
}
