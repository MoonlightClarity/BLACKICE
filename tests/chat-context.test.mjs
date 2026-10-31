import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HarnessEngine } from '../lib/engine.mjs';
import { ProviderRuntime } from '../lib/providers.mjs';
import { normalizeContextOptions, estimateContextTokens } from '../lib/context.mjs';

const graph = (agent = {}, settings = {}) => ({ id: 'editable-context', name: 'Conversation settings', nodes: [
  { id: 'input', type: 'input' }, { id: 'agent', type: 'agent', name: 'Assistant', model: 'fixture-model', prompt: 'Verify the actual workspace before acting.', effort: 'high', ...agent }, { id: 'output', type: 'output' },
], edges: [{ source: 'input', target: 'agent' }, { source: 'agent', target: 'output' }], settings: { maxParallel: 1, planningMode: 'off', ...settings } });
const agentOf = run => run.workflow.nodes.find(node => node.id === 'agent');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const settle = async (engine, run) => { await engine.executions.get(run.id); const saved = engine.getRun(run.id); assert.equal(saved.settled, true); return saved; };

class Runtime extends EventEmitter {
  calls = [];
  status() { return { connected: true, authenticated: true, defaultModel: 'fixture-model', models: [{ id: 'fixture-model', model: 'fixture-model' }] }; }
  async runAgent(options) {
    this.calls.push(options);
    if (this.execute) return this.execute(options);
    const threadId = options.threadId || `fixture-thread-${this.calls.length}`;
    options.onEvent?.({ type: 'thread', threadId, model: options.model, effort: options.effort, codexHistory: options.codexHistory });
    return { output: 'Actual fixture reply.', threadId, codexHistory: options.codexHistory };
  }
  async close() {}
}

async function harness(t, { runtime = new Runtime(), history = 'codex' } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'relay-chat-context-')), cwd = path.join(directory, 'workspace'), dataDir = path.join(directory, 'data'); await mkdir(cwd);
  const engine = await new HarnessEngine({ runtime, dataDir, defaultCwd: cwd }).init(), engines = [engine];
  engine.runtimeSettings = { get: () => ({ codexHistory: history }) };
  t.after(async () => { for (const instance of engines) await instance.close(); await runtime.close(); assert.match(path.basename(directory), /^relay-chat-context-/); await rm(directory, { recursive: true, force: true }); });
  return { engine, runtime, directory, cwd, dataDir, engines };
}

test('an existing API conversation accepts 900k, keeps its thread, and can explicitly reset inherited settings to model default', async t => {
  const requests = [], server = createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/v1/models') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ data: [{ id: 'big', context_length: 1000000, max_output_tokens: 8192 }] })); return;
    }
    let raw = ''; for await (const chunk of request) raw += chunk; requests.push(JSON.parse(raw));
    response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Verified API reply.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 40, completion_tokens: 8, total_tokens: 48 } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const fixture = await harness(t), runtime = await new ProviderRuntime({ codex: new Runtime(), dataDir: fixture.directory }).init();
  fixture.engine.runtime = runtime; t.after(() => runtime.close());
  await runtime.saveProvider({ id: 'local', type: 'compatible', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, models: [{ id: 'big', contextWindowTokens: 1000000, contextWindowSource: 'provider-reported' }], context: { preset: 'custom', windowTokens: 64000 } });
  const workflow = graph({ model: 'local::big' }, { context: { preset: 'custom', windowTokens: 32000 } }), originalGraph = structuredClone(workflow);
  const first = await settle(fixture.engine, fixture.engine.startRun({ workflow, input: 'Remember the original API discussion.' }));
  const second = await settle(fixture.engine, fixture.engine.continueRun(first.id, { nodeId: 'agent', message: 'Expand this existing chat.', context: { preset: '900k' } }));
  assert.equal(second.status, 'completed', second.error); assert.equal(second.nodes.agent.threadId, first.nodes.agent.threadId); assert.equal(second.nodes.agent.contextStatus.requestedWindowTokens, 900000); assert.equal(second.nodes.agent.contextStatus.effectiveWindowTokens, 900000);
  assert.match(JSON.stringify(requests[1].messages), /Remember the original API discussion/); assert.equal((await runtime.readThread(first.nodes.agent.threadId)).contextOptions.windowTokens, 900000);
  const reset = await settle(fixture.engine, fixture.engine.continueRun(second.id, { nodeId: 'agent', message: 'Use this model’s default capacity.', context: { preset: 'model' } }));
  assert.equal(reset.status, 'completed', reset.error); assert.deepEqual(agentOf(reset).context, normalizeContextOptions()); assert.equal(reset.nodes.agent.contextStatus.requestedWindowTokens, null); assert.equal(reset.nodes.agent.contextStatus.effectiveWindowTokens, 1000000);
  const kept = await settle(fixture.engine, fixture.engine.continueRun(reset.id, { nodeId: 'agent', message: 'Keep my per-chat choice.' }));
  assert.deepEqual(agentOf(kept).context, normalizeContextOptions()); assert.equal(kept.nodes.agent.threadId, first.nodes.agent.threadId);
  assert.deepEqual(fixture.engine.getRun(first.id), first); assert.deepEqual(fixture.engine.getRun(second.id), second); assert.deepEqual(workflow, originalGraph); assert.equal(runtime.store.get('local').context.windowTokens, 64000);
});

test('persistent Codex follow-ups receive the edited context and reasoning while preserving past turns', async t => {
  const { engine, runtime } = await harness(t), first = await settle(engine, engine.startRun({ workflow: graph({ context: { preset: 'custom', windowTokens: 64000 } }), input: 'Start the persistent chat.' }));
  const next = await settle(engine, engine.continueRun(first.id, { nodeId: 'agent', message: 'Use a larger context and maximum reasoning.', context: { preset: '900k' }, effort: 'max' }));
  assert.equal(next.status, 'completed', next.error); assert.equal(runtime.calls[1].threadId, first.nodes.agent.threadId); assert.deepEqual(runtime.calls[1].context, normalizeContextOptions({ preset: '900k' })); assert.equal(runtime.calls[1].effort, 'max'); assert.equal(next.nodes.agent.resolvedEffort, 'max'); assert.equal(next.nodes.agent.threadId, first.nodes.agent.threadId);
  const reset = await settle(engine, engine.continueRun(next.id, { nodeId: 'agent', message: 'Reset the budget and use ultra.', context: {}, effort: 'ultra' }));
  assert.deepEqual(runtime.calls[2].context, normalizeContextOptions()); assert.equal(runtime.calls[2].effort, 'ultra'); assert.equal(reset.nodes.agent.resolvedEffort, 'ultra'); assert.equal(agentOf(first).effort, 'high'); assert.equal(agentOf(first).context.windowTokens, 64000); assert.deepEqual(engine.getRun(first.id), first); assert.deepEqual(engine.getRun(next.id), next);
  const modelDefault = await settle(engine, engine.continueRun(reset.id, { nodeId: 'agent', message: 'Restore this model’s reasoning default.', effort: 'default' }));
  assert.equal(runtime.calls[3].effort, 'default'); assert.equal(agentOf(modelDefault).effort, 'default'); assert.equal(modelDefault.nodes.agent.resolvedEffort, 'default');
});

test('a private follow-up uses its edited 900k budget but respects the previously confirmed capacity of the same model', async t => {
  const runtime = new Runtime(); runtime.execute = async options => {
    const index = runtime.calls.length, threadId = `private-${index}`, output = index === 1 ? 'FIRST_EVIDENCE\n' + 'x'.repeat(700000) + '\nLATEST_EVIDENCE' : 'Verified follow-up.';
    options.onEvent({ type: 'thread', threadId, model: options.model, codexHistory: 'relay' });
    if (index === 1) options.onEvent({ type: 'context', threadId, context: { windowSource: 'provider-reported', modelWindowTokens: 200000 } });
    return { output, threadId, codexHistory: 'relay' };
  };
  const { engine } = await harness(t, { runtime, history: 'relay' }), first = await settle(engine, engine.startRun({ workflow: graph(), input: 'Original private conversation.' }));
  const next = await settle(engine, engine.continueRun(first.id, { nodeId: 'agent', message: 'Expand and continue privately.', context: { preset: '900k' } }, { historyRuns: [first] }));
  assert.equal(next.status, 'completed', next.error); assert.equal(runtime.calls[1].threadId, undefined); assert.equal(runtime.calls[1].context.windowTokens, 900000); assert.equal(next.nodes.agent.continuity.effectiveWindowTokens, 200000); assert.equal(next.nodes.agent.continuity.windowSource, 'provider-reported'); assert.equal(next.nodes.agent.continuity.truncated, true); assert.ok(estimateContextTokens([[runtime.calls[1].developerInstructions, runtime.calls[1].prompt], runtime.calls[1].dynamicTools]) <= next.nodes.agent.continuity.inputBudgetTokens); assert.match(runtime.calls[1].prompt, /LATEST_EVIDENCE/); assert.equal(agentOf(first).context, undefined);
});

test('context and effort edits bind request receipts without mutating active work, defaults, or replaying after restart', async t => {
  const { engine, runtime, dataDir, cwd, engines } = await harness(t), first = await settle(engine, engine.startRun({ workflow: graph(), input: 'Original task.' })), hold = deferred();
  runtime.execute = () => hold.promise;
  const request = { requestId: 'edited-context-turn', nodeId: 'agent', message: 'Admit this turn once.', context: { preset: '900k' }, effort: 'ultra' }, next = engine.continueRun(first.id, request);
  try {
    assert.equal(engine.continueRun(first.id, { ...request, context: { preset: '900k', windowTokens: 900000, autoCompact: true } }).id, next.id);
    for (const changed of [{ context: { preset: 'model' } }, { context: undefined }, { effort: 'max' }, { effort: undefined }]) assert.throws(() => engine.continueRun(first.id, { ...request, ...changed }), { code: 'RUN_REQUEST_CONFLICT' });
    assert.throws(() => engine.continueRun(first.id, { nodeId: 'agent', message: 'Try to alter active work.', context: { preset: 'model' }, effort: 'none' }), { code: 'CHAT_BUSY' });
    assert.deepEqual(engine.getRun(next.id).workflow, next.workflow); assert.equal(agentOf(engine.getRun(first.id)).effort, 'high'); assert.equal(agentOf(engine.getRun(first.id)).context, undefined);
  } finally { hold.resolve({ output: 'Admitted once.', threadId: first.nodes.agent.threadId }); }
  const accepted = await settle(engine, next); engine.runs.delete(next.id);
  assert.throws(() => engine.continueRun(first.id, request), { code: 'RUN_REQUEST_RECOVERY_REQUIRED', runId: next.id }); assert.equal(runtime.calls.length, 2);
  engine.restoreArchivedRun(accepted); assert.equal(engine.continueRun(first.id, request).id, next.id); await engine.close();
  const restored = await new HarnessEngine({ runtime, dataDir, defaultCwd: cwd }).init(); engines.push(restored); runtime.resolveModel = () => { throw new Error('A replay cannot resolve the current default.'); };
  assert.equal(restored.continueRun(first.id, request).id, next.id); assert.equal(runtime.calls.length, 2); assert.throws(() => restored.continueRun(first.id, { ...request, effort: 'max' }), { code: 'RUN_REQUEST_CONFLICT' });
});

test('invalid context, effort, and confirmed-capacity settings fail before admitting or interrupting any work', async t => {
  const runtime = new Runtime(); runtime.status = () => ({ connected: true, authenticated: true, defaultModel: 'fixture-model', models: [{ id: 'fixture-model', model: 'fixture-model', contextWindowTokens: 32768, contextWindowSource: 'provider-reported' }] });
  const { engine } = await harness(t, { runtime }), first = await settle(engine, engine.startRun({ workflow: graph(), input: 'An existing chat.' }));
  let cancellations = 0; engine.learning = { cancelBackground() { cancellations++; }, scheduleAfterRun: async () => {} };
  for (const context of [null, [], { preset: 'invented' }, { preset: 'custom', windowTokens: 1 }, { preset: '900k', outputReserveTokens: 32768 }]) assert.throws(() => engine.continueRun(first.id, { nodeId: 'agent', message: 'Invalid choice.', context }), { code: 'INVALID_CONTEXT' });
  for (const effort of [null, '', 'MAX', 'extreme', 1, {}]) assert.throws(() => engine.continueRun(first.id, { nodeId: 'agent', message: 'Invalid choice.', effort }), { status: 400, code: 'INVALID_EFFORT' });
  assert.equal(cancellations, 0); assert.equal(engine.runs.size, 1); assert.equal(runtime.calls.length, 1); assert.deepEqual(engine.getRun(first.id), first);
});

test('retrying a failed edited turn keeps its context and ultra reasoning without changing the original chat', async t => {
  const { engine, runtime } = await harness(t), first = await settle(engine, engine.startRun({ workflow: graph(), input: 'Start the chat.' }));
  runtime.execute = async () => { throw new Error('Fixture failure before reply.'); };
  const failed = await settle(engine, engine.continueRun(first.id, { nodeId: 'agent', message: 'Continue with these choices.', context: { preset: '900k', autoCompact: false }, effort: 'ultra' })); assert.equal(failed.status, 'failed');
  runtime.execute = undefined; const retried = await settle(engine, engine.retryRun(failed.id));
  assert.equal(retried.status, 'completed', retried.error); assert.deepEqual(runtime.calls[2].context, normalizeContextOptions({ preset: '900k', autoCompact: false })); assert.equal(runtime.calls[2].effort, 'ultra'); assert.deepEqual(engine.getRun(first.id), first); assert.deepEqual(engine.getRun(failed.id), failed);
});

test('native context edits validate against the new budget while genuine catalog capacity still rejects an oversized reserve before admission', async t => {
  for (const reportedWindow of [undefined, 32768]) {
    const runtime = new Runtime();
    runtime.status = () => ({ connected: true, authenticated: true, defaultModel: 'fixture-model', models: [{ id: 'fixture-model', model: 'fixture-model', ...(reportedWindow ? { contextWindowTokens: reportedWindow, contextWindowSource: 'provider-reported' } : {}) }] });
    runtime.execute = async options => {
      const threadId = `native-window-${runtime.calls.length}`;
      options.onEvent({ type: 'thread', model: options.model, effort: options.effort, threadId, codexHistory: 'relay' });
      options.onEvent({ type: 'context', threadId, context: { nativeCompaction: true, windowSource: 'provider-reported', modelWindowTokens: 32768, requestedWindowTokens: null } });
      return { output: 'Actual small-window reply.', threadId, codexHistory: 'relay' };
    };
    const { engine } = await harness(t, { runtime, history: 'relay' }), first = await settle(engine, engine.startRun({ workflow: graph(), input: 'Begin with native model defaults.' }));
    const request = { nodeId: 'agent', message: 'Expand this chat and reserve a larger answer.', context: { preset: '900k', outputReserveTokens: 32768 } };
    if (reportedWindow) {
      assert.throws(() => engine.continueRun(first.id, request, { historyRuns: [first] }), { code: 'INVALID_CONTEXT' }); assert.equal(engine.runs.size, 1); assert.equal(runtime.calls.length, 1);
    } else {
      const next = await settle(engine, engine.continueRun(first.id, request, { historyRuns: [first] }));
      assert.equal(next.status, 'completed', next.error); assert.equal(next.modelHandoff.reportedModelWindowTokens, undefined); assert.equal(next.nodes.agent.continuity.effectiveWindowTokens, 900000); assert.equal(next.nodes.agent.continuity.windowSource, 'user-configured'); assert.equal(runtime.calls[1].context.outputReserveTokens, 32768);
    }
    assert.deepEqual(engine.getRun(first.id), first);
  }
});

test('new tasks inherit persisted reasoning and 900k context once while explicit chat choices, retries and receipt replay remain stable',async t=>{
  const {engine,runtime}=await harness(t);let defaults={codexHistory:'codex',defaultEffort:'ultra',defaultContext:{preset:'900k',autoCompact:false}};
  engine.runtimeSettings={get:()=>structuredClone(defaults)};
  const workflow=graph({effort:undefined}),request={requestId:'inherit-defaults-once',workflow,input:'Use my new chat defaults.'};
  const first=await settle(engine,engine.startRun(request));assert.equal(runtime.calls[0].effort,'ultra');assert.deepEqual(runtime.calls[0].context,normalizeContextOptions(defaults.defaultContext));assert.equal(workflow.nodes[1].effort,undefined);assert.equal(workflow.nodes[1].context,undefined);
  defaults={codexHistory:'codex',defaultEffort:'max',defaultContext:{preset:'model',autoCompact:true}};
  assert.equal(engine.startRun(request).id,first.id);assert.equal(runtime.calls.length,1);
  const follow=await settle(engine,engine.continueRun(first.id,{nodeId:'agent',message:'Retain this chat’s choices.'}));assert.equal(runtime.calls[1].effort,'ultra');assert.equal(runtime.calls[1].context.windowTokens,900000);assert.equal(runtime.calls[1].context.autoCompact,false);
  const explicit=await settle(engine,engine.startRun({workflow:graph({effort:'default',context:{preset:'model',autoCompact:false}}),input:'Use explicit model defaults.'}));assert.equal(runtime.calls[2].effort,'default');assert.equal(runtime.calls[2].context.windowTokens,null);assert.equal(runtime.calls[2].context.autoCompact,false);
  runtime.execute=async()=>{throw Error('Fixture failure.');};const failed=await settle(engine,engine.startRun({workflow,input:'New global defaults now.'}));assert.equal(agentOf(failed).effort,'max');assert.equal(agentOf(failed).context.windowTokens,null);
  defaults.defaultEffort='low';runtime.execute=undefined;const retried=await settle(engine,engine.retryRun(failed.id));assert.equal(agentOf(retried).effort,'max');assert.deepEqual(engine.getRun(first.id),first);assert.deepEqual(engine.getRun(follow.id),follow);assert.deepEqual(engine.getRun(explicit.id),explicit);
});

test('automatic private continuity archives every saved byte and keeps one Relay chat without a truncated handoff',async t=>{
  const runtime=new Runtime();runtime.supportsContinuityCompaction=true;runtime.status=()=>({connected:true,authenticated:true,defaultModel:'fixture-model',models:[{id:'fixture-model',model:'fixture-model',contextWindowTokens:32768,contextWindowSource:'provider-reported'}]});
  const original='ORIGINAL\n'+'x'.repeat(180000)+'\nMIDDLE_EVIDENCE\n'+'y'.repeat(180000)+'\nLATEST';runtime.execute=async options=>{const first=runtime.calls.length===1;return{output:first?original:'Continued once.',threadId:`fixture-private-${runtime.calls.length}`,codexHistory:'relay'};};
  const {engine}=await harness(t,{runtime,history:'relay'}),first=await settle(engine,engine.startRun({workflow:graph(),input:'Retain original history.'})),next=await settle(engine,engine.continueRun(first.id,{nodeId:'agent',message:'Continue in this same chat.'},{historyRuns:[first]}));
  assert.equal(next.status,'completed',next.error);assert.equal(next.taskId,first.taskId);assert.equal(next.nodes.agent.continuity.method,'automatic-compaction');assert.equal(next.nodes.agent.continuity.truncated,false);assert.equal(next.nodes.agent.continuity.omittedChars,0);assert.equal(next.modelHandoff.context,undefined);assert.equal(runtime.calls[1].threadId,undefined);assert.match(runtime.calls[1].continuity.text,/MIDDLE_EVIDENCE/);assert.match(runtime.calls[1].continuity.text,/LATEST/);const{readFile}=await import('node:fs/promises');assert.equal(await readFile(next.nodes.agent.continuity.transcriptPath,'utf8'),runtime.calls[1].continuity.text);assert.deepEqual(engine.getRun(first.id),first);
});

test('pre-defaults version-two start receipts retain their original normalized medium identity after upgrade',async t=>{
  const {engine,runtime,cwd}=await harness(t),workflow=graph({effort:undefined}),request={requestId:'old-medium-receipt',workflow,input:'Already admitted before the upgrade.'},first=await settle(engine,engine.startRun(request));
  const{validateWorkflow}=await import('../lib/engine.mjs'),{createHash}=await import('node:crypto'),normalized=validateWorkflow(workflow);delete normalized.id;
  for(const node of normalized.nodes)if(node.effort===undefined)node.effort='medium';
  const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().filter(key=>value[key]!==undefined).map(key=>[key,canonical(value[key])])):value;
  const stored=engine.runs.get(first.id);stored.metadata.clientRequestHashVersion=2;stored.metadata.clientRequestHash=createHash('sha256').update(JSON.stringify(canonical({kind:'start',workflow:normalized,task:request.input,cwd,attachmentIds:[],planningMode:'off'}))).digest('hex');engine.clientRequests.delete(request.requestId);engine.rememberClientRequest(stored);
  engine.runtimeSettings={get:()=>({defaultEffort:'ultra',defaultContext:{preset:'900k'}})};
  assert.equal(engine.startRun(request).id,first.id);assert.equal(runtime.calls.length,1);assert.throws(()=>engine.startRun({...request,input:'Changed task.'}),{code:'RUN_REQUEST_CONFLICT'});
});
