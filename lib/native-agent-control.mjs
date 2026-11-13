import {createHash} from 'node:crypto';
import {createMissionWorkflow} from '../public/mission-model.mjs';

const ACTIVE = new Set(['queued', 'running', 'waiting']);
const sha = value => createHash('sha256').update(value).digest('hex');
const response = value => ({success:true, contentItems:[{type:'inputText',text:JSON.stringify(value)}]});
const fail = (message, code = 'NATIVE_AGENT_INVALID', status = 400) =>
  Object.assign(new Error(message), {code, status});
const required = (value, label, max = 50000) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0'))
    throw fail(label + ' must be nonempty and at most ' + max + ' characters.');
  return value.trim();
};
const key = (run, nodeId, requestId) =>
  'native_' + sha(run.id + '\0' + nodeId + '\0' + required(requestId, 'requestId', 120)).slice(0, 64);
const modelFor = (run, nodeId) => run.workflow?.nodes?.find(node => node.id === nodeId)?.model || 'default';
const agentNode = value => value.workflow?.nodes?.find(node => node.type === 'agent');
const brief = (value, max = 5000) => typeof value === 'string' ? value.slice(-max) : '';
const visibleRun = value => ({
  runId:value.id, conversationId:value.taskId || value.id, status:value.status,
  settled:value.settled === true, createdAt:value.createdAt, finishedAt:value.finishedAt || null,
  task:brief(value.input, 240), output:brief(value.output),
  outputTruncated:typeof value.output === 'string' && value.output.length > 5000,
  agent:value.workflow?.nodes?.filter(node => node.type === 'agent').map(node => ({
    id:node.id, model:node.model, status:value.nodes?.[node.id]?.status || 'unknown'
  })) || [],
  nativeController:value.nativeController || null, childRunIds:value.nativeChildRunIds || [],
  ...(value.error ? {error:String(value.error.message || value.error).slice(0,1000)} : {})
});

export const NATIVE_AGENT_TOOL = {
  type:'function', name:'relay_agents',
  description:'Manage BLACKICE agents from inside BLACKICE using the same durable run and Goal engine that external agents and the user see. List/get, start a manual or explicitly autonomous conversation, steer a running agent, stop one, or update its Goal. A new agent defaults to manual execution; autonomy must be enabled deliberately. No external bridge or new agent process is required.',
  inputSchema:{type:'object', additionalProperties:false, required:['action'], properties:{
    action:{type:'string',enum:['list','get','start','steer','stop','goal']},
    runId:{type:'string',minLength:1,maxLength:120},
    requestId:{type:'string',minLength:1,maxLength:120,description:'Stable unique ID for a mutation; reuse only for the identical action.'},
    scope:{type:'string',enum:['all','mine'],description:'list: all visible native runs, or just runs launched by this agent.'},
    offset:{type:'integer',minimum:0,maximum:1000000},
    limit:{type:'integer',minimum:1,maximum:50},
    task:{type:'string',minLength:1,maxLength:50000},
    model:{type:'string',minLength:1,maxLength:400,description:'Optional model for a new agent; otherwise inherit this agent’s pinned model.'},
    effort:{type:'string',enum:['default','none','minimal','low','medium','high','xhigh','max','ultra']},
    planningMode:{type:'string',enum:['ontology','off']},
    autonomous:{type:'boolean',description:'start: default false. Set true to enable persistent Goal mode across turns.'},
    maxTurns:{type:['integer','null'],minimum:1,description:'Optional turn limit for the autonomous Goal. Null means unlimited.'},
    nodeId:{type:'string',minLength:1,maxLength:120,description:'steer: running agent node; inferred from observed target if omitted.'},
    message:{type:'string',minLength:1,maxLength:50000,description:'Direction to a running agent.'},
    goalAction:{type:'string',enum:['read','set','update','pause','resume']},
    objective:{type:'string',minLength:1,maxLength:50000},
    expectedRevision:{type:'integer',minimum:0,description:'Read the current Goal revision before mutating it.'}
  }}
};

export const NATIVE_AGENT_INSTRUCTIONS = '\n\nNATIVE BLACKICE AGENT COORDINATION\n' +
  'Use relay_agents to inspect or coordinate independent BLACKICE conversations, including agents started by the user or external MCP controllers. ' +
  'Existing relay_browser, relay_workspace, relay_control and other native tools remain available for direct work; do not spawn a second conversation just to use a tool. ' +
  'start creates one saved conversation through the normal engine with autonomy OFF by default. Set autonomous:true for persistent Goal mode; connected external agents remain available. ' +
  'Use a stable requestId for each mutation, inspect actual run/Goal status after uncertain effects and never equate admission with completion. ' +
  'Use steer only for an active agent; use goal to pause, resume or update its longer-term objective. ' +
  'Concurrent agents share BLACKICE resources, so inspect live state before changing another run and preserve its existing work. ' +
  'An internal agent and an external controller may operate at the same time. Respect observed goal revisions and do not manufacture a completed result.\n';

export function createNativeAgentToolHandler({engine, run, nodeId, signal} = {}) {
  if (!engine?.startRun || !engine?.runs || !run?.id || !nodeId)
    throw fail('Native agent controls require an active BLACKICE run and engine.', 'NATIVE_AGENT_UNAVAILABLE', 503);
  const ensureActive = () => {
    if (signal?.aborted) throw fail('The controlling agent was stopped.', 'NATIVE_AGENT_CANCELLED', 409);
  };
  const getRun = async id => {
    required(id, 'runId', 120);
    const live = engine.runs.get(id);
    if (live) return live;
    try {
      const family = await engine.goals?.conversations?.family(id);
      const saved = family?.runs?.find(item => item.id === id);
      if (saved) return saved;
    } catch {}
    throw fail('BLACKICE run not found: ' + id, 'NATIVE_AGENT_NOT_FOUND', 404);
  };
  const receiptId = (args, action) => {
    const value = key(run, nodeId, args.requestId);
    return value + '_' + action;
  };
  return async function nativeAgentTool(call) {
    ensureActive();
    const args = typeof call?.arguments === 'string' ? JSON.parse(call.arguments) : call?.arguments || {};
    const action = args.action;
    if (action === 'list') {
      const rows = [...engine.runs.values()].reverse()
        .filter(item => args.scope !== 'mine' || item.nativeController?.runId === run.id);
      const offset = args.offset ?? 0, limit = args.limit ?? 20;
      return response({runs:rows.slice(offset, offset + limit).map(visibleRun),total:rows.length,offset,
        nextOffset:offset + limit < rows.length ? offset + limit : null});
    }
    if (action === 'get') {
      const target = await getRun(args.runId);
      let goal = null;
      try {goal = await engine.goals?.get(target.id) || null;} catch {}
      return response({run:visibleRun(target),goal});
    }
    if (action === 'start') {
      const task = required(args.task, 'task');
      const id = receiptId(args, action);
      const autonomous = args.autonomous === true;
      if (autonomous && !engine.goals) throw fail('BLACKICE Goal mode is unavailable.', 'NATIVE_AGENT_GOAL_UNAVAILABLE', 503);
      const selectedModel = args.model || modelFor(run,nodeId);
      const planningMode = args.planningMode || 'ontology';
      const workflow = createMissionWorkflow({
        id:'native_mission_' + id.slice(7,39), task, model:selectedModel, cwd:run.cwd,
        ...(args.effort ? {effort:args.effort} : {}), planningMode
      });
      const accepted = engine.startRun({
        requestId:id, workflow,
        input:{task,cwd:run.cwd, planningMode,
          ...(autonomous ? {goal:{objective:task,maxTurns:args.maxTurns ?? null}} : {})}
      });
      const child = engine.runs.get(accepted.id);
      if (child && !child.nativeController) {
        child.nativeController = {type:'native-agent',runId:run.id,nodeId,requestId:args.requestId};
        run.nativeChildRunIds = [...new Set([...(run.nativeChildRunIds || []),child.id])];
        await engine.persist({checkpoint:true});
      }
      return response({accepted:true,completed:false,run:visibleRun(child || accepted),
        autonomous,controller:{runId:run.id,nodeId}});
    }
    if (action === 'steer') {
      const message = required(args.message, 'message');
      const target = await getRun(args.runId);
      if (target.id === run.id) throw fail('Use your current turn or Goal tool for your own work.', 'NATIVE_AGENT_SELF_TARGET', 409);
      if (target.status !== 'running' || target.settled === true)
        throw fail('The target is not running. Read its saved result or Goal state instead.', 'NATIVE_AGENT_NOT_RUNNING', 409);
      const targetNodeId = args.nodeId || target.workflow?.nodes?.find(item =>
        item.type === 'agent' && target.nodes?.[item.id]?.status === 'running')?.id;
      if (!targetNodeId) throw fail('No running agent node is available to steer.', 'NATIVE_AGENT_NOT_RUNNING', 409);
      const id = receiptId(args, action);
      const hash = sha(JSON.stringify({action,targetId:target.id,targetNodeId,message}));
      const receipts = run.nativeAgentReceipts || [];
      const previous = receipts.find(item => item.id === id);
      if (previous) {
        if (previous.hash !== hash) throw fail('This request ID identifies a different direction.', 'NATIVE_AGENT_REQUEST_CONFLICT', 409);
        if (previous.status === 'delivered') return response({replayed:true,...previous.result});
        throw fail('Earlier direction has an uncertain outcome. Inspect the target events before retrying.', 'NATIVE_AGENT_UNCERTAIN', 409);
      }
      const record = {id,hash,status:'uncertain',targetRunId:target.id,at:new Date().toISOString()};
      run.nativeAgentReceipts = [...receipts,record].slice(-100);
      await engine.persist({checkpoint:true});
      try {
        const delivered = await engine.steerRun(target.id, {nodeId:targetNodeId,message});
        record.status = 'delivered';
        record.result = {targetRunId:target.id,nodeId:targetNodeId,delivery:delivered};
        await engine.persist({checkpoint:true});
        return response(record.result);
      } catch (error) {
        await engine.persist({checkpoint:true});
        throw fail('Steering may have had an effect: ' + error.message + '. Inspect the target before attempting another direction.',
          'NATIVE_AGENT_UNCERTAIN', 409);
      }
    }
    if (action === 'stop') {
      const target = await getRun(args.runId);
      if (target.id === run.id) throw fail('Stop your own execution through the current Goal or user control.', 'NATIVE_AGENT_SELF_TARGET', 409);
      const id = receiptId(args, action);
      const goal = engine.goals?.forRun(target);
      if (goal && ['active','waiting'].includes(goal.status)) {
        const paused = await engine.goals.control(target.id,{action:'pause',expectedRevision:goal.revision,requestId:id});
        return response({targetRunId:target.id,stopRequested:true,goal:paused.goal});
      }
      if (!engine.runs.has(target.id)) return response({targetRunId:target.id,stopRequested:false,settled:target.settled === true});
      const wasActive = ACTIVE.has(target.status);
      const stopped = engine.cancelRun(target.id);
      return response({targetRunId:target.id,stopRequested:wasActive,run:visibleRun(stopped)});
    }
    if (action === 'goal') {
      if (!engine.goals) throw fail('BLACKICE Goal mode is unavailable.', 'NATIVE_AGENT_GOAL_UNAVAILABLE', 503);
      const target = await getRun(args.runId);
      const goalAction = args.goalAction || 'read';
      if (goalAction === 'read') return response({targetRunId:target.id,goal:await engine.goals.get(target.id)});
      if (!Number.isSafeInteger(args.expectedRevision) || args.expectedRevision < 0)
        throw fail('Read the Goal and supply its exact expectedRevision to change it.', 'NATIVE_AGENT_GOAL_REVISION', 409);
      const changed = await engine.goals.control(target.id,{
        action:goalAction,expectedRevision:args.expectedRevision,
        requestId:receiptId(args, 'goal_' + goalAction),
        ...(args.objective ? {objective:args.objective} : {}),
        ...(args.maxTurns !== undefined ? {maxTurns:args.maxTurns} : {})
      });
      return response({targetRunId:target.id,...changed});
    }
    throw fail('Choose a supported BLACKICE agent action.');
  };
}
