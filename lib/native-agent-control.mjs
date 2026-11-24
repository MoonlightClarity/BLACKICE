import {createHash} from 'node:crypto';
import {pastChatsRunVisible} from './past-chats.mjs';
import {requireAutonomyModel} from './autonomy-model-allowlist.mjs';
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
  description:"Manage saved BLACKICE conversations. list returns visible runs; get reads one runId. start launches one manual turn from task with a stable requestId and optional model. steer sends message to an active run; stop cancels it. goal reads or changes that run's persistent Goal through goalAction. A Goal supplied at start is paused after the first turn; resume it for further turns. Read returned status and output to determine the result.",
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
    autonomous:{type:'boolean',enum:[false],description:'start: false only. Legacy automatic Autonomy is retired.'},
    goalObjective:{type:'string',minLength:1,maxLength:12000,description:'Optional Goal outcome for a manual child. Saved paused after the initial turn; use goal resume explicitly for more work.'},
    maxTurns:{type:['integer','null'],minimum:1,description:'Turn limit for the saved Goal when explicitly resumed. Defaults to null (no turn cap); set an integer only when the user requests a limit.'},
    nodeId:{type:'string',minLength:1,maxLength:120,description:'steer: running agent node; inferred from observed target if omitted.'},
    message:{type:'string',minLength:1,maxLength:50000,description:'Direction to a running agent.'},
    goalAction:{type:'string',enum:['read','set','update','pause','resume']},
    objective:{type:'string',minLength:1,maxLength:50000},
    expectedRevision:{type:'integer',minimum:0,description:'Read the current Goal revision before mutating it.'}
  }}
};

export const NATIVE_AGENT_SCHEMA_VERSION=2;
// Preserve exact v1 provider schema and interpretation for already-pinned sessions.

export const NATIVE_AGENT_INSTRUCTIONS = "\nAGENT CONVERSATIONS\nUse relay_agents for work in another saved conversation. For a mutation, retain requestId and the returned runId; inspect that run after an uncertain response. start launches one manual turn. A saved Goal continues only after goalAction resume. Read its current revision before changing it. Coordinate shared files and resources, and report the actual run and Goal state.\n";

export function createNativeAgentToolHandler({engine, run, nodeId, signal} = {}) {
  if (!engine?.startRun || !engine?.runs || !run?.id || !nodeId)
    throw fail('Native agent controls require an active BLACKICE run and engine.', 'NATIVE_AGENT_UNAVAILABLE', 503);
  const ensureActive = () => {
    if (signal?.aborted) throw fail('The controlling agent was stopped.', 'NATIVE_AGENT_CANCELLED', 409);
    engine.autonomy?.assertRunPolicy?.(run);
  };
  const policy=()=>engine.autonomy?.policyForRun(run);
  const withinScope=target=>{
    if(!pastChatsRunVisible(engine,run,target))return false;
    const current=policy();
    if(!current||current.scope==='blackice')return true;
    const root=run.taskId||run.id;
    if((target.taskId||target.id)===root)return true;
    let owner=target.nativeController;const seen=new Set();
    while(owner&&!seen.has(owner.runId)){
      seen.add(owner.runId);
      if(owner.conversationId===root||owner.runId===run.id)return true;
      const parent=engine.runs.get(owner.runId);
      if(parent&&(parent.taskId||parent.id)===root)return true;
      owner=parent?.nativeController;
    }
    return false;
  };
  const checkScope=target=>{
    if(!pastChatsRunVisible(engine,run,target))throw fail('Past Chats is Off for unrelated conversations.','PAST_CHATS_OFF',403);
    if(!withinScope(target))throw fail('This autonomy scope covers its conversation and delegated work, not this unrelated task.','NATIVE_AGENT_SCOPE',409);
    return target;
  };
  const getRun = async id => {
    required(id, 'runId', 120);
    const live = engine.runs.get(id);
    if (live) return checkScope(live);
    try {
      const family = await engine.goals?.conversations?.family(id);
      const saved = family?.runs?.find(item => item.id === id);
      if (saved) return checkScope(saved);
    } catch(error) {if(error?.code==='PAST_CHATS_OFF'||error?.code==='NATIVE_AGENT_SCOPE')throw error;}
    throw fail('BLACKICE run not found: ' + id + '. Use relay_agents list for actual run IDs; use relay_files for task attachments.', 'NATIVE_AGENT_NOT_FOUND', 404);
  };
  const receiptId = (args, action) => {
    const value = key(run, nodeId, args.requestId);
    return value + '_' + action;
  };
  return async function nativeAgentTool(call) {
    ensureActive();
    let args = typeof call?.arguments === 'string' ? JSON.parse(call.arguments) : call?.arguments || {};
    const action = args.action;
    if (action === 'list') {
      const rows = [...engine.runs.values()].reverse()
        .filter(item => withinScope(item) && (args.scope !== 'mine' || item.nativeController?.runId === run.id));
      const offset = args.offset ?? 0, limit = args.limit ?? 20;
      return response({runs:rows.slice(offset, offset + limit).map(visibleRun),total:rows.length,offset,
        nextOffset:offset + limit < rows.length ? offset + limit : null});
    }
    if (action === 'get') {
      const target = await getRun(args.runId);
      let goal = null;
      try {goal = await engine.goals?.get(target.id) || null;} catch {}
      return response({run:visibleRun(target),goal,autonomy:await engine.autonomy?.get(target.id)||null});
    }
    if (action === 'start') {
      const task = required(args.task, 'task');
      const id = receiptId(args, action);
      const autonomous = args.autonomous === true;
      if (autonomous) throw fail('Legacy automatic Autonomy is retired. Start a manual child or explicitly resume its Goal.', 'AUTONOMY_RETIRED', 410);
      if(args.goalObjective&&!engine.goals)throw fail('BLACKICE goals are unavailable.','NATIVE_AGENT_GOAL_UNAVAILABLE',503);
      if(args.maxTurns!==undefined&&!args.goalObjective)throw fail('maxTurns belongs to an explicit goalObjective, not autonomous operation.');
      const current=policy();
      const selectedModel = args.model || modelFor(run,nodeId);
      if(current)requireAutonomyModel({allowlist:current.modelAllowlist,requestedModel:selectedModel,
        ...(engine.runtime?.status()?.models?.length?{catalog:engine.runtime.status().models}:{})});
      if(autonomous&&current&&!current.enabled)throw fail('Autonomous continuation is disabled for the controlling task.','NATIVE_AGENT_AUTONOMY_DISABLED',409);
      const seed=(autonomous||current||args.goalObjective)?{
        enabled:autonomous,calibration:current?.calibration||'',modelAllowlist:current?.modelAllowlist||[selectedModel],
        selectedModel,scope:'conversation',...(current?{controller:{conversationId:run.taskId||run.id,runId:run.id,
          id:current.id,generation:current.generation,requiresEnabled:current.enabled,
          goalId:run.goal?.id||(current.scope==='goal'?current.goalId:null)}}:{})
      }:null;
      const planningMode = args.planningMode || 'ontology';
      const workflow = createMissionWorkflow({
        id:'native_mission_' + id.slice(7,39), task, model:selectedModel, cwd:run.cwd,
        ...(args.effort ? {effort:args.effort} : {}), planningMode
      });
      const accepted = engine.startRun({
        requestId:id, workflow,
        input:{task,cwd:run.cwd, planningMode,nativeAutonomy:seed,...(run.pastChats!==undefined?{pastChats:run.pastChats}:{}),
          ...(args.goalObjective ? {goal:{objective:required(args.goalObjective,'goalObjective',12000),maxTurns:args.maxTurns ?? null}} : {})}
      });
      const child = engine.runs.get(accepted.id);
      if (child && !child.nativeController) {
        child.nativeController = {type:'native-agent',runId:run.id,nodeId,requestId:args.requestId};
        engine.markRunDirty?.(child.id);
        child.goalPauseAfterInitial = Boolean(args.goalObjective && !autonomous);
        if(seed)child.autonomyRequest=structuredClone(seed);
        run.nativeChildRunIds = [...new Set([...(run.nativeChildRunIds || []),child.id])];
        engine.markRunDirty?.(run.id);
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
        if (['accepted','queued','delivered'].includes(previous.status)) return response({replayed:true,...previous.result});
        throw fail('Earlier direction has an uncertain outcome. Inspect the target events before retrying.', 'NATIVE_AGENT_UNCERTAIN', 409);
      }
      const record = {id,hash,status:'uncertain',targetRunId:target.id,at:new Date().toISOString()};
      run.nativeAgentReceipts = [...receipts,record].slice(-100);
      engine.markRunDirty?.(run.id);
        await engine.persist({checkpoint:true});
      try {
        const delivered = await engine.steerRun(target.id, {nodeId:targetNodeId,message});
        record.status = 'accepted'; // Resolution acknowledges the direction, not provider delivery.
        record.result = {targetRunId:target.id,nodeId:targetNodeId,delivery:delivered};
        engine.markRunDirty?.(run.id);
        await engine.persist({checkpoint:true});
        return response(record.result);
      } catch (error) {
        engine.markRunDirty?.(run.id);
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
      const row=engine.autonomy?.raw?.(target.taskId||target.id);
      if(row?.enabled){
        const live=[...engine.runs.values()].find(item=>(item.taskId||item.id)===(target.taskId||target.id)&&ACTIVE.has(item.status));
        await engine.autonomy.control(target.id,{action:'disable',expectedRevision:row.revision,requestId:id});
        if(live&&ACTIVE.has(live.status))engine.cancelRun(live.id);
        return response({targetRunId:target.id,stopRequested:true,autonomyDisabled:true,...(live?{stoppedRunId:live.id}:{})});
      }
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
