import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ProviderRuntime } from '../lib/providers.mjs';
import { CodexRuntime } from '../lib/codex.mjs';
import { createChatExecutionReview } from '../lib/chat-execution-review.mjs';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const longContinuation='Reassess the complete retained execution evidence. '.repeat(1400)+'CONTINUATION_TAIL';
const longDirection='Include the newly supplied constraint. '.repeat(1600)+'DIRECTION_TAIL';
const tool = { type: 'function', name: 'relay_once', description: 'One fixture operation.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } };
const receipt = { success: true, contentItems: [{ type: 'inputText', text: 'The fixture operation was confirmed once.' }] };
const response = (type, text, toolCall = false) => type === 'openai'
  ? { status: 'completed', output: toolCall ? [{ type: 'function_call', call_id: 'one-effect', name: 'relay_once', arguments: '{}' }] : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }], usage: { input_tokens: 3, output_tokens: 2 } }
  : type === 'anthropic'
    ? { content: toolCall ? [{ type: 'tool_use', id: 'one-effect', name: 'relay_once', input: {} }] : [{ type: 'text', text }], stop_reason: toolCall ? 'tool_use' : 'end_turn', usage: { input_tokens: 3, output_tokens: 2 } }
    : { choices: [{ message: toolCall ? { role: 'assistant', content: null, tool_calls: [{ id: 'one-effect', type: 'function', function: { name: 'relay_once', arguments: '{}' } }] } : { role: 'assistant', content: text }, finish_reason: toolCall ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } };

async function apiFixture(t, type, replies, options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'blackice-final-runtime-'));
  class Native extends EventEmitter { status() { return { connected: false, authenticated: false, models: [] }; } async close() {} }
  const requests = [];
  const runtime = await new ProviderRuntime({ codex: new Native(), dataDir: directory, ...options, fetchImpl: async (_url, request) => {
    requests.push(JSON.parse(request.body));
    const body = replies[requests.length - 1];
    assert.ok(body, 'Only the intended model requests are made.');
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  } }).init();
  await runtime.saveProvider({ id: 'fixture', type, baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'fixture-key', models: ['model'] });
  t.after(async () => { await runtime.close(); await rm(directory, { recursive: true, force: true }); });
  return { runtime, requests, options: { cwd: directory, prompt: 'Perform the bounded fixture task.', model: 'fixture::model' } };
}

for (const type of ['openai', 'anthropic', 'compatible']) test(`${type}: a final review returns to the same history without replaying confirmed work`, async t => {
  const f = await apiFixture(t, type, [response(type, '', true), response(type, 'Premature candidate.'), response(type, 'Reassessed final answer.')]);
  const events = [], candidates = []; let operations = 0;
  const result = await f.runtime.runAgent({ ...f.options, dynamicTools: [tool], onToolCall: async () => { operations++; return receipt; }, onEvent: event => events.push(event), onBeforeFinal: async candidate => {
    candidates.push(candidate);
    assert.equal(operations, 1, 'The actual tool receipt precedes review and is never replayed.');
    return candidates.length === 1 ? { continue: true, prompt: longContinuation } : undefined;
  } });
  assert.equal(result.output, 'Reassessed final answer.'); assert.equal(operations, 1); assert.equal(f.requests.length, 3);
  assert.deepEqual(candidates.map(item => item.output), ['Premature candidate.', 'Reassessed final answer.']);
  assert.ok(candidates.every(item => item.threadId === result.threadId && item.turnId === result.turnId));
  assert.deepEqual(candidates.map(item => item.usage.totalTokens), [10, 15]); assert.equal(result.usage.totalTokens, 15);
  assert.deepEqual(events.filter(event => event.type === 'message' && event.phase === 'final_answer').map(event => event.text), ['Reassessed final answer.']);
  assert.equal(events.filter(event => event.type === 'planning.continuation').length, 1);
  const boundaries = events.filter(event => ['provider.final', 'host.final-review'].includes(event.type));
  assert.deepEqual(boundaries.map(event => event.type), ['provider.final', 'host.final-review', 'provider.final', 'host.final-review']);
  const expectedStop = { openai: 'completed', anthropic: 'end_turn', compatible: 'stop' }[type];
  assert.deepEqual(boundaries.filter(event => event.type === 'provider.final').map(event => ({
    termination: event.providerTermination, providerType: event.providerType, configured: event.reviewConfigured
  })), Array(2).fill({ termination: expectedStop, providerType: type, configured: true }));
  assert.deepEqual(boundaries.filter(event => event.type === 'host.final-review').map(event => event.reviewDecision), ['continue', 'accepted']);
  const record = await f.runtime.readThread(result.threadId);
  assert.match(JSON.stringify(record.messages), /BLACKICE INTERNAL CONTINUATION/);
  assert.match(JSON.stringify(f.requests[2]), /Premature candidate/);
  assert.match(JSON.stringify(f.requests[2]), /confirmed once/);
  assert.ok(JSON.stringify(f.requests[2]).includes(longContinuation),'a large continuation reaches the provider intact');
});

test('an accepted API final needs no extra pass and local review failures do not degrade provider health', async t => {
  const f = await apiFixture(t, 'compatible', [response('compatible', 'Complete answer.'), response('compatible', 'Unaccepted candidate.')]);
  let calls = 0;
  const accepted = await f.runtime.runAgent({ ...f.options, onBeforeFinal: async () => { calls++; } });
  assert.equal(accepted.output, 'Complete answer.'); assert.equal(calls, 1); assert.equal(f.requests.length, 1);
  const health = structuredClone(f.runtime.checks.get('fixture')), events = [];
  await assert.rejects(f.runtime.runAgent({ ...f.options, onEvent: event => events.push(event), onBeforeFinal: async () => { throw Object.assign(new Error('The saved plan cannot be reviewed.'), { code: 'TASK_REVIEW_UNAVAILABLE' }); } }), { code: 'TASK_REVIEW_UNAVAILABLE' });
  assert.deepEqual(f.runtime.checks.get('fixture'), health);
  assert.equal(events.filter(event => event.type === 'message' && event.phase === 'final_answer').length, 0);
  assert.equal(events.findLast(event => event.type === 'usage').usage.totalTokens, 5);
  assert.equal(events.find(event => event.type === 'provider.final')?.providerTermination, 'stop');
  assert.equal(events.find(event => event.type === 'host.final-review')?.reviewDecision, 'rejected');
});

test('API steering accepted during final review continues before completing', async t => {
  const f = await apiFixture(t, 'compatible', [response('compatible', 'Old candidate.'), response('compatible', 'The new direction is included.')]);
  const started = deferred(), release = deferred(); let count = 0;
  const work = f.runtime.runAgent({ ...f.options, onBeforeFinal: async candidate => { if (++count === 1) { started.resolve(candidate); await release.promise; } } });
  const first = await started.promise;
  assert.equal((await f.runtime.steerAgent(first.threadId, longDirection)).accepted, true);
  release.resolve();
  const result = await work;
  assert.equal(result.output, 'The new direction is included.'); assert.equal(count, 2);
  assert.match(JSON.stringify(f.requests[1]), /newly supplied constraint/);
  assert.ok(JSON.stringify(f.requests[1]).includes(longDirection));
});

test('API cancellation interrupts a pending final review without another provider request', async t => {
  const f = await apiFixture(t, 'compatible', [response('compatible', 'Stopped candidate.')]);
  const started = deferred(), release = deferred(), controller = new AbortController();
  const work = f.runtime.runAgent({ ...f.options, signal: controller.signal, onBeforeFinal: async () => { started.resolve(); await release.promise; return { continue: true, prompt: 'Must never run.' }; } });
  work.catch(() => {}); await started.promise; controller.abort();
  await assert.rejects(work, { code: 'ABORT_ERR' }); release.resolve(); await tick();
  assert.equal(f.requests.length, 1); assert.equal(f.runtime.active.size, 0); assert.equal(f.runtime.checks.has('fixture'), false);
});

test('API continuation consumes the configured request budget', async t => {
  const f = await apiFixture(t, 'compatible', [response('compatible', 'Unreviewed candidate.')], { maxSteps: 1 });
  await f.runtime.saveProvider({ id: 'fixture', maxSteps: 1 });
  await assert.rejects(f.runtime.runAgent({ ...f.options, onBeforeFinal: async () => ({ continue: true, prompt: 'Return to the saved plan.' }) }), { code: 'PROVIDER_STEP_LIMIT' });
  assert.equal(f.requests.length, 1);
});

function nativeFixture(t) {
  const cwd = process.cwd(), client = new CodexRuntime({ command: process.execPath, cwd, requestTimeoutMs: 1000, runTimeoutMs: 4000, spawnImpl() { throw Error('No native process is launched by this fixture.'); } });
  const requests = [], sent = []; let nextThread = 0, nextTurn = 0;
  client.child = {};
  Object.assign(client.info, { connected: true, authenticated: true, defaultModel: 'fixture-model', models: [{ id: 'fixture-model', model: 'fixture-model', isDefault: true, defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }], contextWindowTokens: 128000 }] });
  client._request = async (method, params = {}) => {
    requests.push({ method, params: structuredClone(params) });
    if (method === 'config/read') return { config: { plugins: {}, mcp_servers: {}, skills: { config: [] } } };
    if (method === 'skills/list') return { data: (params.cwds || []).map(cwd => ({ cwd, skills: [], errors: [] })) };
    if (method === 'thread/start') return { thread: { id: `native-${++nextThread}`, ephemeral: Boolean(params.ephemeral) }, model: params.model };
    if (method === 'turn/start') return { turn: { id: `turn-${++nextTurn}`, status: 'inProgress' } };
    if (['thread/unsubscribe', 'turn/interrupt'].includes(method)) return {};
    if (method === 'turn/steer') return { turnId: params.expectedTurnId };
    throw Error(`Unexpected native fixture request: ${method}`);
  };
  client._send = message => sent.push(message);
  t.after(() => { client.closing = true; client._connectionFailed(Object.assign(new Error('Fixture closed.'), { code: 'CODEX_CLOSED' }), client.child); });
  async function begin(options) {
    const work = client.runAgent({ cwd, prompt: 'A bounded planning fixture.', model: 'fixture-model', effort: 'medium', serviceTier: 'default', ...options });
    work.catch(() => {}); await tick();
    const state = [...client.threads.values()].at(-1); assert.ok(state); return { work, state };
  }
  function complete(state, text, totalTokens = 5) {
    const turnId = state.turnId, item = { type: 'agentMessage', id: `answer-${turnId}`, phase: 'final_answer', text };
    client._notification('thread/tokenUsage/updated', { threadId: state.threadId, turnId, tokenUsage: { total: { inputTokens: totalTokens - 2, outputTokens: 2, totalTokens }, last: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } } });
    client._notification('item/completed', { threadId: state.threadId, turnId, item });
    client._notification('turn/completed', { threadId: state.threadId, turn: { id: turnId, status: 'completed', items: [item] } });
  }
  return { client, requests, sent, begin, complete };
}

test('native final review normalizes legacy history input and keeps one persistent thread with cumulative usage', async t => {
  const f = nativeFixture(t), events = [], candidates = [];
  const { work, state } = await f.begin({ codexHistory: 'relay', onEvent: event => events.push(event), onBeforeFinal: async candidate => { candidates.push(candidate); return candidates.length === 1 ? { continue: true, prompt: longContinuation } : undefined; } });
  f.complete(state, 'Premature native candidate.', 5); await tick();
  assert.equal(f.requests.filter(row => row.method === 'thread/start').length, 1);
  assert.equal(f.requests.filter(row => row.method === 'thread/unsubscribe').length, 0);
  const starts = f.requests.filter(row => row.method === 'turn/start'); assert.equal(starts.length, 2);
  assert.equal(starts[1].params.threadId, state.threadId); assert.match(starts[1].params.input[0].text, /INTERNAL CONTINUATION/);
  assert.ok(starts[1].params.input[0].text.includes(longContinuation));
  for (const key of ['model', 'effort', 'serviceTier', 'serviceTierForTurn']) assert.equal(starts[1].params[key], starts[0].params[key]);
  assert.equal(f.client.status().activeTurns, 1);
  f.complete(state, 'Reassessed native final.', 10);
  const result = await work;
  assert.equal(result.output, 'Reassessed native final.'); assert.equal(result.codexHistory, 'codex'); assert.equal(result.usage.totalTokens, 10);
  assert.deepEqual(candidates.map(row => row.output), ['Premature native candidate.', 'Reassessed native final.']);
  assert.deepEqual(candidates.map(row => row.usage.totalTokens), [5, 10]);
  assert.deepEqual(events.filter(row => row.type === 'message').map(row => row.text), ['Reassessed native final.']);
  const boundaries = events.filter(event => ['provider.final', 'host.final-review'].includes(event.type));
  assert.deepEqual(boundaries.map(event => [event.type, event.providerTermination ?? event.reviewDecision]), [
    ['provider.final','completed'], ['host.final-review','continue'], ['provider.final','completed'], ['host.final-review','accepted'],
  ]);
  assert.ok(boundaries.filter(event => event.type === 'provider.final').every(event => event.terminationField === 'turn-status'));
  assert.equal(f.requests.filter(row => row.method === 'thread/unsubscribe').length, 1, 'Completion releases the subscription while retaining persistent history.');
  assert.equal(f.client.status().activeTurns, 0); assert.equal(f.client.contexts.has(result.threadId), true);
});

test('native stage-only search results renew ordinary review once and transport-only repeats remain bounded',async t=>{
 const f=nativeFixture(t),events=[],decisions=[];
 const input='Inspect current sources and complete the requested work.';
 const review=createChatExecutionReview({input,onDecision:decision=>decisions.push(decision)});
 const {work,state}=await f.begin({prompt:input,
  onEvent:event=>{events.push(event);review.observe(event);},
  onBeforeFinal:candidate=>review.beforeFinal(candidate),
 });
 f.complete(state,'Initial source inspection is unfinished.',5);await tick();
 assert.equal(f.requests.filter(row=>row.method==='turn/start').length,2);
 const deliverSearch=index=>{
  const item={type:'webSearch',id:'search-'+index,query:'current evidence',
   action:{type:'search',query:null,queries:['current evidence']},
   results:[{type:'text_result',domain:'fixture.invalid',ref_id:'turn'+index+'search0',
    title:'Current source',snippet:'A source needing inspection.',url:'https://fixture.invalid/source'}],
   startedAtMs:index*1000,completedAtMs:index*1000+10};
  const metadata={threadId:state.threadId,turnId:state.turnId};
  f.client._notification('item/started',{...metadata,item:{...item,action:null,results:null,completedAtMs:null}});
  f.client._notification('item/completed',{...metadata,item});
 };
 deliverSearch(1);
 const delivered=events.findLast(event=>event.type==='item'&&event.item?.type==='webSearch'&&event.stage==='completed');
 assert.ok(delivered,'the actual native adapter emitted the completed item');
 assert.equal(Object.hasOwn(delivered.item,'status'),false,'no fixture status is added to hide the producer schema');
 assert.equal(delivered.item.results.length,1);
 f.complete(state,'A new source was found but has not been checked.',10);await tick();
 assert.equal(f.requests.filter(row=>row.method==='turn/start').length,3,'new completed native evidence must reach another review turn');
 deliverSearch(2);
 const final='No additional evidence was obtained; the requested outcome remains unverified.';
 f.complete(state,final,15);
 const result=await work;
 assert.equal(result.output,final);
 assert.equal(f.requests.filter(row=>row.method==='thread/start').length,1);
 assert.equal(f.requests.filter(row=>row.method==='turn/start').length,3,'transport changes alone must not reopen review');
 assert.deepEqual(decisions.map(row=>[row.reviewDecision,row.evidenceRevision]),[['continue',0],['continue',1],['accepted',1]]);
 assert.equal(decisions.at(-1).reason,'no-new-task-evidence');
 assert.equal(decisions[1].evidenceFingerprint,decisions[2].evidenceFingerprint);
 assert.ok(decisions.every(row=>row.outcomeVerification==='not-evaluated'&&row.uncertainToolCount===0));
 assert.deepEqual(events.filter(event=>event.type==='message').map(event=>event.text),[final],'unfinished candidates stay withheld');
});

test('native review waits for admitted operation settlement and never repeats it', async t => {
  const f = nativeFixture(t), dispatched = deferred(), release = deferred(); let operations = 0, reviews = 0;
  const { work, state } = await f.begin({ dynamicTools: [tool], onToolCall: async () => { operations++; dispatched.resolve(); await release.promise; return receipt; }, onBeforeFinal: async () => { reviews++; assert.equal(f.sent.filter(row => row.result?.success).length, 1); } });
  const operation = f.client._dynamicToolCall({ id: 41, params: { threadId: state.threadId, turnId: state.turnId, callId: 'one-effect', tool: 'relay_once', arguments: {} } });
  await dispatched.promise;
  f.complete(state, 'Actual result reviewed.'); await tick(); assert.equal(reviews, 0); assert.equal(f.client.status().activeTurns, 1);
  release.resolve(); await operation;
  assert.equal((await work).output, 'Actual result reviewed.'); assert.equal(reviews, 1); assert.equal(operations, 1);
});

test('a later native tool invalidates earlier deferred final text, including late completion fallback', async t => {
  const f = nativeFixture(t), events = [], candidates = []; let operations = 0;
  const { work, state } = await f.begin({ dynamicTools: [tool], onEvent: event => events.push(event), onToolCall: async () => { operations++; return receipt; }, onBeforeFinal: async candidate => { candidates.push(candidate.output); } });
  const metadata = { threadId: state.threadId, turnId: state.turnId };
  const commentary = { type: 'agentMessage', id: 'progress', phase: 'commentary', text: 'Checking the bounded fixture operation.' };
  const premature = { type: 'agentMessage', id: 'early-final', phase: 'final_answer', text: 'Premature text must never become the final result.' };
  const final = { type: 'agentMessage', id: 'current-final', phase: 'final_answer', text: 'Only the reassessed final answer.' };
  f.client._notification('item/completed', { ...metadata, item: commentary });
  f.client._notification('item/agentMessage/delta', { ...metadata, itemId: premature.id, delta: premature.text });
  f.client._notification('item/completed', { ...metadata, item: premature });
  await f.client._dynamicToolCall({ id: 42, params: { ...metadata, callId: 'one-effect', tool: 'relay_once', arguments: {} } });
  // A late item receipt or final turn snapshot cannot restore the invalidated
  // candidate after the real operation has superseded it.
  f.client._notification('item/completed', { ...metadata, item: premature });
  f.client._notification('item/completed', { ...metadata, item: final });
  f.client._notification('turn/completed', { threadId: state.threadId, turn: { id: state.turnId, status: 'completed', items: [premature, final] } });
  assert.equal((await work).output, final.text); assert.deepEqual(candidates, [final.text]); assert.equal(operations, 1);
  assert.deepEqual(events.filter(event => event.type === 'message').map(event => event.text), [commentary.text, final.text]);
  assert.equal(events.filter(event => event.type === 'item' && event.item?.id === premature.id).length, 0);
});

test('native steering accepted while review is pending is included in the next turn', async t => {
  const f = nativeFixture(t), started = deferred(), release = deferred(); let reviews = 0;
  const { work, state } = await f.begin({ onBeforeFinal: async () => { if (++reviews === 1) { started.resolve(); await release.promise; } } });
  f.complete(state, 'Earlier candidate.'); await started.promise;
  const direction = await f.client.steerAgent(state.threadId, longDirection);
  assert.equal(direction.accepted, true); assert.equal(direction.queued, true);
  release.resolve(); await tick();
  assert.ok(JSON.stringify(f.requests.filter(row => row.method === 'turn/start')[1].params.input).includes(longDirection));
  f.complete(state, 'The direction was incorporated.', 10);
  assert.equal((await work).output, 'The direction was incorporated.'); assert.equal(reviews, 2);
});

test('native cancellation during final review releases the thread without starting another turn', async t => {
  const f = nativeFixture(t), started = deferred(), release = deferred(), controller = new AbortController();
  const { work, state } = await f.begin({ signal: controller.signal, onBeforeFinal: async () => { started.resolve(); await release.promise; return { continue: true, prompt: 'Must not start.' }; } });
  f.complete(state, 'Cancelled candidate.'); await started.promise; controller.abort();
  await assert.rejects(work, { code: 'ABORT_ERR' }); release.resolve(); await tick();
  assert.equal(f.requests.filter(row => row.method === 'turn/start').length, 1); assert.equal(f.requests.filter(row => row.method === 'turn/interrupt').length, 0);
  assert.equal(f.client.status().activeTurns, 0);
});

test('native continuation retains its original total deadline through a later final review', async t => {
  const f = nativeFixture(t), secondReview = deferred(), release = deferred(); let reviews = 0;
  const { work, state } = await f.begin({ timeoutMs: 150, onBeforeFinal: async () => {
    if (++reviews === 1) return { continue: true, prompt: 'Return to the saved plan.' };
    secondReview.resolve(); await release.promise;
  } });
  const originalDeadline = state.cancelDeadline;
  f.complete(state, 'First candidate.'); await tick();
  assert.equal(state.cancelDeadline, originalDeadline, 'A planning return does not start a new execution budget.');
  f.complete(state, 'Second candidate.', 10); await secondReview.promise;
  await assert.rejects(work, { code: 'CODEX_RUN_TIMEOUT' }); release.resolve(); await tick();
  assert.equal(f.requests.filter(row => row.method === 'turn/start').length, 2); assert.equal(f.client.status().activeTurns, 0);
});

test('native local review failures preserve actual usage and do not become model-access failures', async t => {
  const f = nativeFixture(t), events = [];
  const health = { state: 'accepted', scope: 'current-connection', lastSuccessAt: '2026-10-29T00:00:00.000Z' };
  f.client.modelAccess.set('fixture-model', health);
  const { work, state } = await f.begin({ onEvent: event => events.push(event), onBeforeFinal: async () => { throw Object.assign(new Error('The current plan is unavailable.'), { code: 'TASK_REVIEW_UNAVAILABLE' }); } });
  f.complete(state, 'Unaccepted candidate.', 5);
  await assert.rejects(work, { code: 'TASK_REVIEW_UNAVAILABLE' });
  assert.deepEqual(f.client.modelAccess.get('fixture-model'), health);
  assert.equal(events.findLast(row => row.type === 'usage').usage.totalTokens, 5);
  assert.equal(events.filter(row => row.type === 'message').length, 0); assert.equal(f.requests.filter(row => row.method === 'turn/start').length, 1);
});

test('native steering cancels host children, closes admissions until settlement, and preserves confirmed receipts', async t => {
  const f = nativeFixture(t), entered = deferred(), aborted = deferred(), release = deferred(); let calls = 0;
  const { work, state } = await f.begin({ dynamicTools: [tool], onToolCall: async (call, { signal }) => {
    calls++; signal.addEventListener('abort', () => aborted.resolve(), { once: true }); entered.resolve(); await release.promise; return receipt;
  } });
  const params = { threadId: state.threadId, turnId: state.turnId, tool: 'relay_once', arguments: {} };
  const operation = f.client._dynamicToolCall({ id: 71, params: { ...params, callId: 'confirmed' } });
  await entered.promise;
  const steering = f.client.steerAgent(state.threadId, 'Replace the old plan.');
  await aborted.promise;
  await f.client._dynamicToolCall({ id: 72, params: { ...params, callId: 'unstarted' } });
  assert.equal(calls, 1);
  assert.equal(f.sent.find(row => row.id === 72).result.success, false);
  release.resolve(); await operation; await steering;
  assert.equal(f.sent.find(row => row.id === 71).result.success, true);
  assert.equal(state.toolController.signal.aborted, false);
  f.complete(state, 'Reconciled revised plan.');
  assert.equal((await work).output, 'Reconciled revised plan.');
});

test('native steering aborts a stalled planning reviewer without waiting for its voluntary return', async t => {
  const f = nativeFixture(t), entered = deferred(), aborted = deferred(); let reviews = 0;
  const { work, state } = await f.begin({ onBeforeFinal: async ({ signal }) => {
    if (++reviews > 1) return;
    entered.resolve();
    await new Promise((resolve, reject) => signal.addEventListener('abort', () => { aborted.resolve(); reject(signal.reason); }, { once: true }));
  } });
  f.complete(state, 'Superseded candidate.'); await entered.promise;
  await f.client.steerAgent(state.threadId, 'Only do the corrected scope.');
  await aborted.promise; await tick();
  assert.match(JSON.stringify(f.requests.filter(row => row.method === 'turn/start')[1]), /corrected scope/);
  f.complete(state, 'Corrected final.');
  assert.equal((await work).output, 'Corrected final.');
});

test('native steering invalidates a queued callback before it can start and later admits corrected work', async t => {
  const f = nativeFixture(t); let calls = 0;
  const { work, state } = await f.begin({ dynamicTools: [tool], onToolCall: async () => { calls++; return receipt; } });
  const params = { threadId: state.threadId, turnId: state.turnId, tool: 'relay_once', arguments: {} };
  const operation = f.client._dynamicToolCall({ id: 81, params: { ...params, callId: 'queued-old' } });
  const steering = f.client.steerAgent(state.threadId, 'Replace the queued action.');
  await Promise.all([operation, steering]);
  assert.equal(calls, 0); assert.equal(f.sent.find(row => row.id === 81).result.success, false);
  await f.client._dynamicToolCall({ id: 82, params: { ...params, callId: 'corrected' } });
  assert.equal(calls, 1); assert.equal(f.sent.find(row => row.id === 82).result.success, true);
  f.complete(state, 'Corrected work only.'); await work;
});

for (const earlyNotification of [false, true]) test('native queued direction is delivered during continuation opening, notification=' + earlyNotification, async t => {
  const f = nativeFixture(t), entered = deferred(), release = deferred();
  const request = f.client._request.bind(f.client); let starts = 0, reviews = 0, calls = 0;
  f.client._request = async (method, params) => {
    const result = await request(method, params);
    if (method === 'turn/start' && ++starts === 2) { entered.resolve(); await release.promise; }
    return result;
  };
  const { work, state } = await f.begin({ dynamicTools: [tool], onToolCall: async () => { calls++; return receipt; },
    onBeforeFinal: async () => ++reviews === 1 ? { continue: true, prompt: 'Old continuation scope.' } : null });
  f.complete(state, 'First candidate.'); await entered.promise;
  await f.client.steerAgent(state.threadId, 'Revised during opening.');
  await f.client._dynamicToolCall({ id: 91, params: { threadId: state.threadId, turnId: 'turn-2', callId: 'stale', tool: 'relay_once', arguments: {} } });
  assert.equal(calls, 0); assert.equal(f.sent.find(row => row.id === 91).result.code, 'TOOL_SUPERSEDED');
  if (earlyNotification) f.client._notification('turn/started', { threadId: state.threadId, turn: { id: 'turn-2', status: 'inProgress' } });
  release.resolve(); await tick(); await tick();
  const steers = f.requests.filter(row => row.method === 'turn/steer');
  assert.equal(steers.length, 1); assert.equal(steers[0].params.input[0].text, 'Revised during opening.');
  assert.equal(state.pendingDirections.length, 0);
  f.complete(state, 'Revised continuation.'); assert.equal((await work).output, 'Revised continuation.');
});

test('native live direction invalidates earlier final candidates and late completion fallback', async t => {
  const f = nativeFixture(t), candidates = [], events = [];
  const { work, state } = await f.begin({ onEvent: e => events.push(e), onBeforeFinal: async c => { candidates.push(c.output); } });
  const metadata = { threadId: state.threadId, turnId: state.turnId };
  const old = { type: 'agentMessage', id: 'superseded-answer', phase: 'final_answer', text: 'Old scope answer.' };
  f.client._notification('item/completed', { ...metadata, item: old });
  await f.client.steerAgent(state.threadId, 'Use corrected scope.');
  f.client._notification('item/completed', { ...metadata, item: old });
  f.complete(state, 'Corrected scope answer.');
  assert.equal((await work).output, 'Corrected scope answer.');
  assert.deepEqual(candidates, ['Corrected scope answer.']);
  assert.ok(!events.some(e => e.type === 'message' && e.phase === 'final_answer' && e.text === old.text));
});

test('duplicate native completion cannot start two reviews while direction delivery is settling', async t => {
  const f = nativeFixture(t), delivery = deferred(); let reviews = 0;
  const { work, state } = await f.begin({ onBeforeFinal: async () => { reviews++; } });
  state.pendingDirectionDelivery = delivery.promise;
  f.complete(state, 'Confirmed candidate.'); f.complete(state, 'Confirmed candidate.');
  delivery.resolve(); await work;
  assert.equal(reviews, 1);
});
