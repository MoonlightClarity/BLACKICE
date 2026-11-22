import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createHash} from 'node:crypto';
import {mkdtemp, mkdir, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {HarnessEngine} from '../lib/engine.mjs';
import {IdentityStore} from '../lib/identity.mjs';

const MODEL = 'fixture-codex';
const VIBE = 'mistral-vibe::pf1-fixture';
const sha = text => createHash('sha256').update(text).digest('hex');
const count = (text, value) => text.split(value).length - 1;
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return {promise, resolve};
};
const taskInput = task => ({task, chatPlanning:'off', directoryActions:'off', pastChats:'off'});
const flow = (model = MODEL, prompt = 'PF1_CURRENT_NODE: inspect only the assigned fixture.') => ({
  id:'pf1-framing', name:'Task framing fixture',
  nodes:[
    {id:'input', type:'input', name:'User input'},
    {id:'agent', type:'agent', name:'Verifier', model, prompt},
    {id:'output', type:'output'},
  ],
  edges:[{source:'input', target:'agent'}, {source:'agent', target:'output'}],
  settings:{maxParallel:1, planningMode:'off'},
});
const userBlock = prompt => prompt.split('\nUSER TASK\n')[1].split('\n\nUPSTREAM RESULTS (context from previous agents)\n')[0];

class Runtime extends EventEmitter {
  constructor(execute) {
    super();
    this.execute = execute;
    this.calls = [];
    this.steers = [];
  }
  status() {
    return {
      connected:true, authenticated:true, isolatedHistory:true, defaultModel:MODEL,
      models:[MODEL, VIBE].map(model => ({
        id:model, model, available:true, supportsTools:true, contextWindowTokens:200000, maxOutputTokens:8192,
      })),
    };
  }
  async runAgent(options) {
    this.calls.push(options);
    const index = this.calls.length;
    const providerId = options.model.startsWith('mistral-vibe::') ? 'mistral-vibe' : 'codex';
    const threadId = options.threadId || (providerId === 'mistral-vibe' ? 'vibe_pf1_' : 'codex_pf1_') + index;
    const turnId = 'pf1_turn_' + index;
    options.onEvent?.({type:'thread', threadId, turnId, providerId, model:options.model, resumed:Boolean(options.threadId)});
    options.onPromptAccepted?.(options.prompt);
    const result = this.execute ? await this.execute(options, index) : {output:'PF1 fixture complete.'};
    options.onEvent?.({type:'message', threadId, turnId, phase:'final_answer', text:result.output});
    options.onEvent?.({type:'turn', threadId, turnId, status:'completed'});
    return {...result, threadId, turnId};
  }
  async steerAgent(threadId, text) {
    this.steers.push({threadId, text});
    return {accepted:true};
  }
}

async function setup(t, {withIdentity = true, execute} = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'blackice-pf1-'));
  const dataDir = path.join(root, 'data');
  const identity = withIdentity ? await new IdentityStore({dataDir}).init() : undefined;
  if (identity) {
    for (const [kind, content] of [
      ['soul', '# Owner behavior\nPF1_SOUL_雪: finish the current authorized assignment.\n'],
      ['user', '# User profile\nPF1_USER_λ: prefers precise results and café examples.\n'],
    ]) {
      const before = await identity.read(kind);
      await identity.update({kind, content, expectedRevision:before.revision, expectedHash:before.diskHash});
    }
  }
  const runtime = new Runtime(execute);
  const engine = new HarnessEngine({runtime, dataDir, defaultCwd:root, identity});
  engine.runtimeSettings = {get:() => ({codexHistory:'relay', runTimeoutMs:null, executionGuardrails:false})};
  await engine.init();
  t.after(async () => {
    await engine.close();
    await identity?.close();
    await rm(root, {recursive:true, force:true});
  });
  return {root, dataDir, runtime, engine, identity};
}

async function finish(engine, started) {
  await engine.executions.get(started.id);
  const result = engine.getRun(started.id);
  assert.equal(result.settled, true);
  return result;
}
function complete(run) {
  assert.equal(run.status, 'completed', run.error);
}
function precedes(prompt, first, second) {
  const left = prompt.indexOf(first), right = prompt.indexOf(second);
  assert.ok(left >= 0, 'Missing first fragment: ' + first);
  assert.ok(right >= 0, 'Missing second fragment: ' + second);
  assert.ok(left < right, 'Current turn must precede supporting context.');
}

test('PF1 current task and node instructions precede the complete identity and preserve its audit', {timeout:20000}, async t => {
  const {engine, runtime, identity} = await setup(t);
  const task = 'PF1_FRESH_TASK: inspect the current fixture, not identity metadata.';
  const workflow = flow();
  const snapshot = await identity.snapshot();
  const run = await finish(engine, engine.startRun({workflow, input:taskInput(task)}));
  complete(run);
  const prompt = runtime.calls[0].prompt;
  assert.ok(prompt.startsWith('HOST TURN AUTHORITY\n'));
  assert.equal(userBlock(prompt), task);
  precedes(prompt, workflow.nodes[1].prompt, snapshot.text);
  precedes(prompt, '\nUSER TASK\n' + task, snapshot.text);
  assert.equal(count(prompt, task), 1);
  assert.equal(count(prompt, snapshot.text), 1);
  assert.deepEqual(run.nodes.agent.identity.revisions, snapshot.revisions);
  assert.equal(run.nodes.agent.identity.truncated, false);
  assert.match(prompt, /PF1_SOUL_雪/);
  assert.match(prompt, /PF1_USER_λ/);
  const audit = run.nodes.agent.instructionAudit;
  assert.equal(audit.sections.find(item => item.id === 'soul').sourceHash, snapshot.documents.soul.hash);
  const user = audit.contextSources.find(item => item.id === 'user-profile');
  assert.equal(user.revision, snapshot.documents.user.revision);
  assert.equal(user.sha256, sha(snapshot.documents.user.content));
  assert.ok(runtime.calls[0].dynamicTools.some(tool => tool.name === 'relay_identity'));
});

test('PF1 identity absence keeps the current task and node scope without an empty replacement', {timeout:20000}, async t => {
  const {engine, runtime} = await setup(t, {withIdentity:false});
  const task = 'PF1_NO_IDENTITY_TASK';
  const workflow = flow(MODEL, 'PF1_NO_IDENTITY_NODE');
  complete(await finish(engine, engine.startRun({workflow, input:taskInput(task)})));
  const prompt = runtime.calls[0].prompt;
  assert.ok(prompt.startsWith('HOST TURN AUTHORITY\n'));
  assert.equal(userBlock(prompt), task);
  assert.equal(count(prompt, task), 1);
  assert.match(prompt, /PF1_NO_IDENTITY_NODE/);
  assert.doesNotMatch(prompt, /BLACKICE GLOBAL IDENTITY|SOUL_DOCUMENT=|USER_PROFILE_DATA=/);
});

test('PF1 native follow-up keeps its current instructions and task before identity without a fresh root task', {timeout:20000}, async t => {
  const {engine, runtime, identity} = await setup(t);
  const workflow = flow(VIBE, 'PF1_NATIVE_CURRENT_NODE');
  const first = await finish(engine, engine.startRun({workflow, input:taskInput('PF1_NATIVE_ORIGINAL_TASK')}));
  complete(first);
  const next = await finish(engine, engine.continueRun(first.id, {nodeId:'agent', message:'PF1_NATIVE_FOLLOWUP_TASK'}));
  complete(next);
  const prompt = runtime.calls[1].prompt, snapshot = await identity.snapshot();
  assert.equal(runtime.calls[1].threadId, first.nodes.agent.threadId);
  assert.equal(next.modelHandoff, undefined);
  assert.match(prompt, /CURRENT AGENT INSTRUCTIONS\nPF1_NATIVE_CURRENT_NODE/);
  assert.match(prompt, /USER FOLLOW-UP\nPF1_NATIVE_FOLLOWUP_TASK/);
  assert.doesNotMatch(prompt, /PF1_NATIVE_ORIGINAL_TASK|ORIGINAL USER TASK|RELAY CONTINUITY/);
  precedes(prompt, 'CURRENT AGENT INSTRUCTIONS\nPF1_NATIVE_CURRENT_NODE', snapshot.text);
  precedes(prompt, 'USER FOLLOW-UP\nPF1_NATIVE_FOLLOWUP_TASK', snapshot.text);
  assert.equal(count(prompt, 'PF1_NATIVE_FOLLOWUP_TASK'), 1);
  assert.equal(count(prompt, snapshot.text), 1);
});

test('PF1 native retry retains original-task recovery semantics and the accepted thread before identity', {timeout:20000}, async t => {
  const {engine, runtime, identity} = await setup(t, {execute:async (_options, index) => {
    if (index === 1) throw Object.assign(new Error('Fixture interruption after thread acceptance.'), {code:'VIBE_PROCESS_EXIT'});
    return {output:'PF1 retry finished.'};
  }});
  const task = 'PF1_RETRY_ORIGINAL_TASK';
  const first = await finish(engine, engine.startRun({workflow:flow(VIBE), input:taskInput(task)}));
  assert.equal(first.status, 'failed');
  const retried = await finish(engine, engine.retryRun(first.id));
  complete(retried);
  const prompt = runtime.calls[1].prompt, snapshot = await identity.snapshot();
  assert.equal(runtime.calls.length, 2);
  assert.equal(runtime.calls[1].threadId, first.nodes.agent.threadId);
  assert.match(prompt, /ORIGINAL USER TASK\nPF1_RETRY_ORIGINAL_TASK/);
  assert.match(prompt, /Preserve confirmed tool results, accepted directions and completed actions/);
  assert.match(prompt, /Verify the current workspace and any uncertain effects before continuing/);
  precedes(prompt, 'ORIGINAL USER TASK\n' + task, snapshot.text);
  assert.equal(count(prompt, task), 1);
  assert.equal(retried.nodeHandoffs, undefined);
});

test('PF1 saved handoff follows the exact current body and preserves history plus archive integrity', {timeout:20000}, async t => {
  const {engine, runtime, dataDir} = await setup(t);
  const workflow = flow(), node = workflow.nodes[1];
  const current = 'HOST TURN AUTHORITY\nCurrent request controls.\n\nUSER TASK\nPF1_CURRENT_HANDOFF_TASK\n';
  const history = 'BLACKICE GLOBAL IDENTITY\nUSER TASK\nPF1_OLD_UNRELATED_GOAL\nObserved Unicode: 雪 λ café.\n';
  const handoff = {sourceRunId:'pf1-old-run', to:MODEL, context:history, sourceChars:history.length, retainedChars:history.length, truncated:false};
  const fitted = await engine.fitHandoff({...handoff}, node, workflow, current, '', []);
  assert.ok(fitted.prompt.startsWith(current + '\n\nRELAY CONTINUITY\n'));
  precedes(fitted.prompt, 'PF1_CURRENT_HANDOFF_TASK', 'PF1_OLD_UNRELATED_GOAL');
  assert.match(fitted.prompt, /The current request above controls this turn/);
  assert.doesNotMatch(fitted.prompt, /The current request below controls this turn/);
  assert.ok(fitted.prompt.endsWith(history + '\nEND SAVED CONVERSATION\n\n'));
  assert.equal(count(fitted.prompt, history), 1);
  assert.equal(fitted.continuity.sourceChars, history.length);
  assert.equal(fitted.continuity.retainedChars, history.length);
  assert.equal(fitted.continuity.omittedChars, 0);
  assert.equal(fitted.continuity.truncated, false);
  const archive = path.join(dataDir, 'context-archives', sha(history) + '.txt');
  await mkdir(path.dirname(archive), {recursive:true});
  await writeFile(archive, history);
  const archived = {...handoff, archivePath:archive};
  delete archived.context;
  const restored = await engine.fitHandoff(archived, node, workflow, current, '', []);
  assert.equal(restored.prompt, fitted.prompt);
  await writeFile(archive, history + 'TAMPERED');
  await assert.rejects(engine.fitHandoff(archived, node, workflow, current, '', []), {code:'CONTEXT_ARCHIVE_INVALID'});
  assert.equal(await readFile(archive, 'utf8'), history + 'TAMPERED');
  assert.equal(runtime.calls.length, 0);
});

test('PF1 compacted handoff preparation preserves the current body and the complete historical archive', {timeout:20000}, async t => {
  const {engine, runtime} = await setup(t);
  runtime.supportsContinuityCompaction = true;
  const workflow = flow(), node = workflow.nodes[1];
  const current = 'USER TASK\nPF1_COMPACTED_CURRENT_TASK\n';
  const history = 'PF1_HISTORICAL_OBSERVATION 雪\n'.repeat(500);
  const handoff = {sourceRunId:'pf1-compaction-source', to:MODEL, context:history};
  const limits = engine.handoffLimits(node, workflow, [], [], handoff);
  const fitted = await engine.fitHandoff(handoff, node, workflow, current, '', [], {manual:true});
  assert.equal(fitted.prompt, current);
  assert.equal(fitted.runtimeContinuity.text, history);
  assert.equal(fitted.runtimeContinuity.inputBudgetTokens, limits.inputBudgetTokens);
  assert.equal(fitted.runtimeContinuity.sourceRunId, 'pf1-compaction-source');
  assert.equal(await readFile(fitted.runtimeContinuity.transcriptPath, 'utf8'), history);
  assert.equal(path.basename(fitted.runtimeContinuity.transcriptPath), sha(history) + '.txt');
  assert.equal(fitted.continuity.method, 'automatic-compaction');
  assert.equal(fitted.continuity.sourceChars, history.length);
  assert.equal(fitted.continuity.retainedChars, history.length);
  assert.equal(fitted.continuity.omittedChars, 0);
  assert.equal(fitted.continuity.truncated, false);
  assert.equal(runtime.calls.length, 0, 'Preparing preserved continuity must not call a model.');
});

test('PF1 workflow nodes retain their own assignment and upstream evidence with the current task ahead of identity', {timeout:20000}, async t => {
  const evidence = 'PF1_COMPLETED_UPSTREAM_EVIDENCE';
  const {engine, runtime, identity} = await setup(t, {execute:async (_options, index) => ({
    output:index === 1 ? evidence : 'PF1 consumer finished.',
  })});
  const assignment = {scope:'PF1_ASSIGNED_CONSUMER_SCOPE', inputs:['producer'], result:'A checked result.', doneWhen:'The assigned evidence is inspected.'};
  const workflow = {
    id:'pf1-workflow', name:'PF1 scoped nodes',
    nodes:[
      {id:'input', type:'input', name:'User input'},
      {id:'producer', type:'agent', name:'Producer', model:MODEL, prompt:'PF1_PRODUCER_NODE_ONLY'},
      {id:'consumer', type:'agent', name:'Consumer', model:MODEL, prompt:'PF1_CONSUMER_NODE_ONLY', assignment},
      {id:'output', type:'output'},
    ],
    edges:[
      {source:'input', target:'producer'}, {source:'input', target:'consumer'},
      {source:'producer', target:'consumer'}, {source:'consumer', target:'output'},
    ],
    settings:{maxParallel:1, planningMode:'off'},
  };
  const task = 'PF1_SHARED_WORKFLOW_REQUEST';
  complete(await finish(engine, engine.startRun({workflow, input:taskInput(task)})));
  assert.equal(runtime.calls.length, 2);
  const snapshot = await identity.snapshot();
  for (let i = 0; i < 2; i++) {
    const prompt = runtime.calls[i].prompt;
    assert.equal(userBlock(prompt), task);
    precedes(prompt, workflow.nodes[i + 1].prompt, snapshot.text);
    precedes(prompt, '\nUSER TASK\n' + task, snapshot.text);
  }
  assert.doesNotMatch(runtime.calls[0].prompt, /PF1_CONSUMER_NODE_ONLY|PF1_ASSIGNED_CONSUMER_SCOPE/);
  assert.doesNotMatch(runtime.calls[1].prompt, /PF1_PRODUCER_NODE_ONLY/);
  assert.ok(runtime.calls[1].prompt.includes('[Producer]\n' + evidence));
  assert.ok(runtime.calls[1].prompt.includes('\nWORKER ASSIGNMENT\n' + JSON.stringify(assignment)));
});

test('PF1 accepted direction during handoff remains after historical context and is queued exactly once', {timeout:20000}, async t => {
  const {engine, runtime} = await setup(t);
  const first = await finish(engine, engine.startRun({workflow:flow(), input:taskInput('PF1_PRECEDING_REQUEST')}));
  complete(first);
  const entered = deferred(), release = deferred();
  const fit = engine.fitHandoff.bind(engine);
  engine.fitHandoff = async (...args) => {
    entered.resolve();
    await release.promise;
    return fit(...args);
  };
  const next = engine.continueRun(first.id, {nodeId:'agent', message:'PF1_CURRENT_FOLLOWUP'});
  const execution = engine.executions.get(next.id);
  try {
    await Promise.race([
      entered.promise,
      execution.then(() => assert.fail('The expected fresh-session handoff did not occur.')),
    ]);
    const receipt = await engine.steerRun(next.id, {nodeId:'agent', message:'PF1_LATEST_ACCEPTED_DIRECTION'});
    assert.equal(receipt.accepted, true);
    assert.equal(receipt.queued, true);
  } finally {
    release.resolve();
  }
  const run = await finish(engine, next);
  complete(run);
  const prompt = runtime.calls[1].prompt;
  precedes(prompt, '\nUSER TASK\nPF1_CURRENT_FOLLOWUP', 'RELAY CONTINUITY\n');
  precedes(prompt, 'END SAVED CONVERSATION', 'CURRENT ACCEPTED USER DIRECTIONS\n');
  assert.ok(prompt.split('CURRENT ACCEPTED USER DIRECTIONS\n')[1].includes('PF1_LATEST_ACCEPTED_DIRECTION'));
  assert.equal(runtime.steers.length, 0, 'Queued direction must not be sent to the previous idle provider thread.');
  assert.equal(run.nodes.agent.pendingDirections.length, 1);
  assert.equal(run.nodes.agent.pendingDirections[0].includedIn, 'coordinator-prompt');
});
