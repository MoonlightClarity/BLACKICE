import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProviderRuntime } from '../lib/providers.mjs';
import { directoryToolRecovery } from '../lib/directory-tool-recovery.mjs';

const MARKER = '[BLACKICE DIRECTORY RECOVERY]\n';
const json = value => new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });
const tool = { type: 'function', name: 'relay_workspace', description: 'Fixture operation.', inputSchema: {
  type: 'object', required: ['action'], properties: { action: { type: 'string' } }, additionalProperties: false } };
const call = (id, action = 'write') => ({ id, name: 'relay_workspace', arguments: JSON.stringify({ action }) });
const errorText = id => 'DIRECTORY_FOCUS original ' + id + ' — résumé 東京';
const rejected = id => ({ success: false, code: 'DIRECTORY_FOCUS', actionDispatched: false, hostHandlerEntered: true,
  contentItems: [{ type: 'inputText', text: errorText(id) }] });
const snapshot = { taskId: 'task', revision: 1, actionRevision: 1, focus: null, ready: ['save'],
  actions: [{ id: 'save', objective: 'Save output', state: 'pending', dependsOn: [] }] };
const status = { ready: false, reason: 'pending-actions', readyActions: ['save'], focus: null, unknown: [] };
const final = type => type === 'openai'
  ? { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done.' }] }] }
  : type === 'anthropic' ? { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done.' }] }
  : { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Done.' } }] };
const callsResponse = (type, calls) => type === 'openai'
  ? { status: 'completed', output: calls.map(c => ({ type: 'function_call', id: 'item-' + c.id, call_id: c.id, name: c.name, arguments: c.arguments })) }
  : type === 'anthropic' ? { stop_reason: 'tool_use', content: calls.map(c => ({ type: 'tool_use', id: c.id, name: c.name, input: JSON.parse(c.arguments) })) }
  : { choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null,
    tool_calls: calls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })) } }] };

class Native extends EventEmitter {
  calls = [];
  status() { return { connected: true, authenticated: true, models: [{ id: 'native-fixture', model: 'native-fixture', supportsTools: true }] }; }
  async runAgent(options) { this.calls.push(options); return { output: 'Native unchanged', threadId: 'native-thread', turnId: 'native-turn' }; }
  async close() {}
}
async function fixture(t, { type = 'compatible', maxSteps = null, reply, localLlama = false } = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'provider-directory-recovery-'));
  const requests = [], events = [], native = new Native();
  const baseUrl=localLlama?'http://localhost:8080/v1':'http://127.0.0.1:45679/v1';
  const runtime = await new ProviderRuntime({ codex: native, dataDir, maxSteps,
    modelLimitResolver: { enrich: async (_config, models) => models },
    fetchImpl: async (url, options = {}) => {
      assert.ok(String(url).startsWith(localLlama?'http://localhost:8080/':'http://127.0.0.1:45679/'), 'Fixture transport cannot reach a real provider.');
      if ((options.method || 'GET') === 'GET') return json({ data: [{ id: 'fixture', context_length: 1000000, max_output_tokens: 128000 }] });
      const body = JSON.parse(options.body); requests.push(body);
      return json(await reply?.(body, requests.length) || final(type));
    } }).init();
  t.after(async () => { await runtime.close(); await rm(dataDir, { recursive: true, force: true }); });
  await runtime.saveProvider({ id: 'fixture', type, baseUrl, ...(localLlama?{preset:'llamacpp'}:{}), models: ['fixture'], maxTokens: 90000, maxSteps,
    ...(type !== 'compatible' ? { apiKey: 'synthetic-directory-recovery-fixture' } : {}) });
  const run = overrides => runtime.runAgent({ cwd: dataDir, model: 'fixture::fixture', prompt: 'Complete the current task — preserve this request.',
    timeoutMs: null, context: { autoCompact: false, enforceKnownCapacityOnly: true }, dynamicTools: [tool],
    onToolCall: c => rejected(c.callId), onEvent: event => events.push(event), ...overrides });
  return { runtime, requests, events, native, dataDir, run };
}
const recoveryHook = observer => {
  let state = null;
  return async candidate => {
    await observer?.(candidate);
    const next = directoryToolRecovery(state, candidate.failure, snapshot, status, { runId: 'run', nodeId: 'agent', status: 'running' });
    state = next.state;
    return next.prompt ? { prompt: next.prompt } : null;
  };
};

test('compatible recovery follows the eighth durable original result and the same attempt retains its full budget/history/tools', async t => {
  const dispatched = [], candidates = [];
  const f = await fixture(t, { reply: (_body, index) => index <= 12 ? callsResponse('compatible', [call('write-' + index)]) : final('compatible') });
  const result = await f.run({
    onToolCall: c => { dispatched.push(structuredClone(c)); return rejected(c.callId); },
    onDirectoryToolRecovery: recoveryHook(async candidate => {
      candidates.push(candidate);
      const saved = await f.runtime.readThread(candidate.threadId);
      assert.equal(saved.pendingToolCalls, undefined); assert.equal(saved.pendingToolResults, undefined);
      assert.equal(saved.messages.at(-1).role, 'tool');
      assert.equal(saved.messages.at(-1).tool_call_id, candidate.failure.lastCallId);
      assert.equal(saved.messages.at(-1).content, errorText(candidate.failure.lastCallId));
    }),
  });
  assert.equal(result.output, 'Done.'); assert.equal(dispatched.length, 12); assert.equal(f.requests.length, 13);
  assert.equal(candidates[0].failure.lastCallId, 'write-8');
  for (const c of candidates) {
    assert.equal(c.threadId, result.threadId); assert.equal(c.turnId, result.turnId);
    assert.equal(c.signal, candidates[0].signal); assert.equal(c.remainingSteps, null);
  }
  for (let index = 0; index < 8; index++) assert.equal(f.requests[index].messages.some(m => String(m.content).startsWith(MARKER)), false);
  const ninth = f.requests[8].messages;
  assert.equal(ninth.at(-2).role, 'tool'); assert.equal(ninth.at(-2).tool_call_id, 'write-8');
  assert.equal(ninth.at(-2).content, errorText('write-8')); assert.ok(ninth.at(-1).content.startsWith(MARKER));
  const saved = await f.runtime.readThread(result.threadId);
  const originalResults = saved.messages.filter(m => m.role === 'tool');
  assert.equal(originalResults.length, 12);
  for (let index = 0; index < 12; index++) {
    const id = 'write-' + (index + 1), original = originalResults[index];
    assert.equal(original.tool_call_id, id); assert.equal(original.content, errorText(id));
    assert.ok(saved.messages.some(m => m.role === 'assistant' && m.tool_calls?.some(c => c.id === id)));
  }
  assert.equal(saved.messages.filter(m => String(m.content).startsWith(MARKER)).length, 1);
  assert.equal(saved.transcript.filter(m => String(m.content).startsWith(MARKER)).length, 1);
  assert.equal(saved.contextOptions.autoCompact, false);
  assert.equal(saved.contextOptions.enforceKnownCapacityOnly, true);
  for (const request of f.requests) {
    assert.equal(request.max_tokens, 90000); assert.equal(request.model, 'fixture');
    assert.deepEqual(request.tools, f.requests[0].tools);
    assert.ok(request.messages.some(m => m.content === 'Complete the current task — preserve this request.'));
  }
});

test('a complete eight-failure batch is recorded before one instruction; a later success in the same batch resets eligibility', async t => {
  for (const trailingSuccess of [false, true]) await t.test(String(trailingSuccess), async t => {
    const calls = Array.from({ length: 8 }, (_, i) => call('batch-' + i));
    if (trailingSuccess) calls.push(call('successful-read', 'read'));
    let hooks = 0;
    const f = await fixture(t, { reply: (_body, index) => index === 1 ? callsResponse('compatible', calls) : final('compatible') });
    await f.run({ onToolCall: c => c.callId === 'successful-read' ? { success: true, contentItems: [{ type: 'inputText', text: 'Already read.' }] } : rejected(c.callId),
      onDirectoryToolRecovery: recoveryHook(() => { hooks++; }) });
    assert.equal(hooks, trailingSuccess ? 0 : 1);
    const messages = f.requests[1].messages;
    assert.equal(messages.filter(m => m.role === 'tool').length, calls.length);
    assert.equal(messages.filter(m => String(m.content).startsWith(MARKER)).length, trailingSuccess ? 0 : 1);
    if (!trailingSuccess) assert.equal(messages.at(-2).tool_call_id, 'batch-7');
  });
});

test('an unproven or dispatched eighth failure cannot invoke the Directory hook and shared limiter stops repeats', async t => {
  for (const flag of [undefined, true, null]) await t.test(String(flag), async t => {
    let hooks = 0;
    const f = await fixture(t, { reply: (_body, index) => index <= 8 ? callsResponse('compatible', [call('write-' + index)]) : final('compatible') });
    await assert.rejects(f.run({ onToolCall: c => {
      const result = rejected(c.callId);
      if (c.callId === 'write-8') { if (flag === undefined) delete result.actionDispatched; else result.actionDispatched = flag; }
      return result;
    }, onDirectoryToolRecovery: () => { hooks++; return { prompt: 'must not appear' }; } }),{code:'TOOL_FAILURE_LOOP'});
    assert.equal(hooks, 0);assert.equal(f.requests.length,8);
    assert.equal(f.requests.at(-1).messages.some(m => String(m.content).startsWith(MARKER)), false);
  });
});

test('the configured finite step budget is neither increased nor consumed by a separate recovery request', async t => {
  for (const maxSteps of [8, 9]) await t.test(String(maxSteps), async t => {
    let hooks = 0;
    const f = await fixture(t, { maxSteps, reply: (_body, index) => index <= 8 ? callsResponse('compatible', [call('write-' + index)]) : final('compatible') });
    const pending = f.run({ onDirectoryToolRecovery: recoveryHook(() => { hooks++; }) });
    if (maxSteps === 8) await assert.rejects(pending, { code: 'PROVIDER_STEP_LIMIT' });
    else assert.equal((await pending).output, 'Done.');
    assert.equal(f.requests.length, maxSteps); assert.equal(hooks, maxSteps === 8 ? 0 : 1);
  });
});

test('cancellation after the saved failed results prevents an instruction and any further provider request', async t => {
  const controller = new AbortController(); let threadId;
  const f = await fixture(t, { reply: (_body, index) => callsResponse('compatible', [call('write-' + index)]) });
  await assert.rejects(f.run({ signal: controller.signal, onDirectoryToolRecovery: candidate => {
    threadId = candidate.threadId; controller.abort(); return { prompt: 'Cancelled guidance must not be appended.' };
  } }), { code: 'ABORT_ERR' });
  assert.equal(f.requests.length, 8);
  const saved = await f.runtime.readThread(threadId);
  assert.equal(saved.messages.filter(m => m.role === 'tool').length, 8);
  assert.equal(saved.messages.some(m => String(m.content).startsWith(MARKER)), false);
});

for (const type of ['openai', 'anthropic']) test(type + ' retains its provider protocol while shared failure loop stops repeated calls', async t => {
  let hooks = 0, dispatched = 0;
  const f = await fixture(t, { type, reply: (_body, index) => index <= 9 ? callsResponse(type, [call('write-' + index)]) : final(type) });
  await assert.rejects(f.run({ onToolCall:c=>{dispatched++;return rejected(c.callId);},onDirectoryToolRecovery: () => { hooks++; return { prompt: 'must not appear' }; } }), {code:'TOOL_FAILURE_LOOP'});
  assert.equal(hooks, 0);assert.equal(dispatched, 8);assert.equal(f.requests.length, 8);
});

test('native delegation keeps the original hook/options and does not run compatible recovery or new model calls', async t => {
  const f = await fixture(t); let hooks = 0;
  const hook = () => { hooks++; throw Error('Compatible hook cannot run on native path.'); };
  const result = await f.runtime.runAgent({ cwd: f.dataDir, prompt: 'Native task', model: 'native-fixture', timeoutMs: 456789,
    onDirectoryToolRecovery: hook });
  assert.equal(result.output, 'Native unchanged'); assert.equal(hooks, 0);
  assert.equal(f.native.calls.length, 1); assert.equal(f.native.calls[0].onDirectoryToolRecovery, hook);
  assert.equal(f.native.calls[0].timeoutMs, 456789); assert.equal(f.requests.length, 0);
});

for(const type of ['compatible','openai','anthropic'])test(type+' shared guard stops eight repeated failed discovery opportunities after durable receipts',async t=>{
 const observed=[];
 const f=await fixture(t,{type,reply:(_body,index)=>index<=9?callsResponse(type,[call('read-'+index,'read')]):final(type)});
 await assert.rejects(f.run({onToolCall:call=>{observed.push(call.callId);return{success:false,code:'INVALID_TASK_VIEW',contentItems:[{type:'inputText',text:'current cursor rejected'}]};}}),{code:'TOOL_FAILURE_LOOP'});
 assert.equal(observed.length,8);assert.equal(f.requests.length,8,'No new provider request after loop detected');
 assert.equal(f.events.filter(event=>event.type==='tool.result'&&event.code==='INVALID_TASK_VIEW').length,8);
});

test('a single compatible batch of independent read failures is one recovery opportunity, not sixteen',async t=>{
 const calls=Array.from({length:16},(_,i)=>call('read-batch-'+i,'read'));
 const f=await fixture(t,{type:'compatible',reply:(_body,index)=>index===1?callsResponse('compatible',calls):final('compatible')});
 const returned=await f.run({onToolCall:()=>({success:false,code:'INVALID_TASK_VIEW',contentItems:[{type:'inputText',text:'cursor invalid'}]})});
 assert.equal(returned.output,'Done.');assert.equal(f.requests.length,2);
 const persisted=await f.runtime.readThread(returned.threadId);
 assert.equal(persisted.messages.filter(message=>message.role==='tool').length,16);
});

test('unknown-effect workspace mutation flood aborts before the ninth same-batch operation',async t=>{
 const calls=Array.from({length:12},(_,i)=>call('write-batch-'+i,'write'));
 const f=await fixture(t,{type:'compatible',reply:(_body,index)=>index===1?callsResponse('compatible',calls):final('compatible')});
 let dispatched=0;
 await assert.rejects(f.run({onToolCall:()=>{dispatched++;return{success:false,code:'WORKSPACE_ERROR',contentItems:[{type:'inputText',text:'unknown'}]};}}),{code:'TOOL_FAILURE_LOOP'});
 assert.equal(dispatched,8);assert.equal(f.requests.length,1);
 assert.equal(f.events.filter(event=>event.type==='tool.result'&&event.code==='WORKSPACE_ERROR').length,8);
});

test('managed local llama.cpp compatible route uses the shared failure limiter without a local model server',async t=>{
 const received=[],f=await fixture(t,{type:'compatible',localLlama:true,reply:(_body,index)=>index<=9?callsResponse('compatible',[call('local-read-'+index,'read')]):final('compatible')});
 await assert.rejects(f.run({onToolCall:c=>{received.push(c.callId);return{success:false,code:'INVALID_TASK_VIEW',contentItems:[{type:'inputText',text:'invalid cursor'}]};}}),{code:'TOOL_FAILURE_LOOP'});
 assert.equal(received.length,8);assert.equal(f.requests.length,8);
 assert.equal(f.events.filter(e=>e.type==='tool.result'&&e.code==='INVALID_TASK_VIEW').length,8);
});
test('compatible Directory focus recovery remains bounded after the injected current-state snapshot',async t=>{
 const f=await fixture(t,{reply:(_body,index)=>index<=25?callsResponse('compatible',[call('focus-'+index,'write')]):final('compatible')});
 let calls=0,hook=0;
 await assert.rejects(f.run({onToolCall:call=>{calls++;return rejected(call.callId);},
  onDirectoryToolRecovery:recoveryHook(()=>{hook++;})}),{code:'TOOL_FAILURE_LOOP'});
 assert.equal(calls,16);assert.equal(f.requests.length,16);assert.equal(hook>0,true);
 assert.equal(f.events.filter(event=>event.type==='tool.result'&&event.code==='DIRECTORY_FOCUS').length,16);
});

test('shared host tool limit does not label a healthy provider or model as failed generation',async t=>{
 const f=await fixture(t,{type:'compatible',reply:(_body,index)=>index<=9?callsResponse('compatible',[call('repeat-'+index,'read')]):final('compatible')});
 let marked=0;const original=f.runtime.generationCheck.bind(f.runtime);
 f.runtime.generationCheck=(...args)=>{marked++;return original(...args);};
 await assert.rejects(f.run({onToolCall:()=>({success:false,code:'INVALID_TASK_VIEW',contentItems:[{type:'inputText',text:'invalid'}]})}),{code:'TOOL_FAILURE_LOOP'});
 assert.equal(marked,0,'BLACKICE host tool-loop refusal must not degrade model/provider generation health');
 assert.equal(f.requests.length,8);
 const status=f.runtime.listProviders().find(provider=>provider.id==='fixture');
 assert.equal(status?.modelChecks?.fixture?.lastGenerationOk,undefined);
});

test('repeated malformed provider tool-call arguments have their own bounded protocol failure, not a host-loop label',async t=>{
 const malformed=index=>[{id:'bad-'+index,name:'relay_workspace',arguments:'{bad'}];
 const f=await fixture(t,{type:'compatible',reply:(_body,index)=>index<=12?callsResponse('compatible',malformed(index)):final('compatible')});
 let dispatched=0,marked=0;
 const original=f.runtime.generationCheck.bind(f.runtime);
 f.runtime.generationCheck=(...args)=>{marked++;return original(...args);};
 await assert.rejects(f.run({onToolCall:()=>{dispatched++;return rejected('unexpected');}}),{code:'PROVIDER_TOOL_ARGUMENTS_LOOP'});
 assert.equal(f.requests.length,8);
 assert.equal(dispatched,0,'invalid arguments never dispatch a tool handler');
 assert.equal(marked,1,'a provider protocol failure remains distinguishable from a host tool stop');
 assert.equal(f.events.filter(event=>event.type==='tool.result'&&event.code==='PROVIDER_TOOL_ARGUMENTS_INVALID').length,8);
});

test('a malformed provider batch is fully recorded and safely projected before a corrected next response',async t=>{
 const invalid=Array.from({length:12},(_,i)=>({id:'invalid-'+i,name:'relay_workspace',arguments:'{bad'}));
 const f=await fixture(t,{type:'compatible',reply:(_body,index)=>index===1?callsResponse('compatible',invalid):final('compatible')});
 let dispatched=0;
 const result=await f.run({onToolCall:()=>{dispatched++;return rejected('unexpected');}});
 assert.equal(result.output,'Done.');
 assert.equal(dispatched,0);
 assert.equal(f.requests.length,2);
 assert.equal(f.events.filter(event=>event.type==='tool.result'&&event.code==='PROVIDER_TOOL_ARGUMENTS_INVALID').length,12);
 const stored=await f.runtime.readThread(result.threadId);
 assert.equal(stored.messages.filter(message=>message.role==='tool').length,12);
 assert.ok(f.requests[1].messages.some(message=>String(message.content).includes('Arguments were not a valid JSON object.')));
});

test('invalid non-object tool arguments stop distinctly across provider wire formats',async t=>{
 for(const type of ['compatible','openai','anthropic'])await t.test(type,async t=>{
  const f=await fixture(t,{type,reply:(_body,index)=>index<=9?callsResponse(type,[{id:'nonobject-'+index,name:'relay_workspace',arguments:'[]'}]):final(type)});
  let dispatched=0;
  await assert.rejects(f.run({onToolCall:()=>{dispatched++;return rejected('unexpected');}}),{code:'PROVIDER_TOOL_ARGUMENTS_LOOP'});
  assert.equal(dispatched,0);
  assert.equal(f.requests.length,8);
  assert.equal(f.events.filter(event=>event.type==='tool.result'&&event.code==='PROVIDER_TOOL_ARGUMENTS_INVALID').length,8);
 });
});

test('a large malformed single response preserves its complete batch before a corrected reply',async t=>{
 const calls=Array.from({length:65},(_,i)=>({id:'bad-batch-'+i,name:'relay_workspace',arguments:'[]'}));
 const f=await fixture(t,{type:'compatible',reply:(_body,index)=>index===1?callsResponse('compatible',calls):final('compatible')});
 let dispatched=0;
 const result=await f.run({onToolCall:()=>{dispatched++;return rejected('unexpected');}});
 assert.equal(result.output,'Done.');
 assert.equal(dispatched,0);assert.equal(f.requests.length,2);
 assert.equal(f.events.filter(event=>event.type==='tool.result'&&event.code==='PROVIDER_TOOL_ARGUMENTS_INVALID').length,65);
});
