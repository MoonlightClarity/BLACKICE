import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexRuntime } from '../lib/codex.mjs';
import { normalizeContextOptions, contextSnapshot, estimateContextTokens, splitContext, summarySource, reportedWindowFromError, contextTextChunks } from '../lib/context.mjs';
import { ProviderRuntime } from '../lib/providers.mjs';
import { renderContextStatus, renderContextFields } from '../public/context-ui.mjs';

test('900k is an explicit request, while defaults preserve native model configuration', () => {
  assert.deepEqual(normalizeContextOptions(), { preset: 'model', windowTokens: null, autoCompact: true });
  assert.equal(normalizeContextOptions({ preset: '900k', windowTokens: 1000000 }).windowTokens, 900000);
  assert.equal(normalizeContextOptions({ preset: 'custom', windowTokens: 123456 }).windowTokens, 123456);
  for (const options of [null, [], { preset: 'invented' }, { preset: 'custom' }, { preset: 'custom', windowTokens: 4095 }, { autoCompact: 'false' }, { outputReserveTokens: 0 }, { preset: 'custom', windowTokens: 4096, outputReserveTokens: 3000, headroomTokens: 2000 }]) assert.throws(() => normalizeContextOptions(options), { code: 'INVALID_CONTEXT' });
});

test('reported model capacity bounds requested capacity and all remaining counts stay estimated', () => {
  const snapshot = contextSnapshot({ options: { preset: '900k' }, modelWindowTokens: 828400, modelWindowSource: 'provider-reported', messages: ['hello'], lastUsage: { inputTokens: 3000, outputTokens: 8 }, lastInputEstimate: 1000 });
  assert.equal(snapshot.requestedWindowTokens, 900000); assert.equal(snapshot.modelWindowTokens, 828400); assert.equal(snapshot.effectiveWindowTokens, 828400);
  assert.equal(snapshot.inputBudgetTokens, 828400 - snapshot.outputReserveTokens - snapshot.headroomTokens);
  assert.equal(snapshot.actualInputTokens, 3000); assert.equal(snapshot.actualOutputTokens, 8); assert.equal(snapshot.remainingIsEstimate, true);
  assert.equal(snapshot.estimatedInputTokens, estimateContextTokens([['hello'], []]) * 3); assert.match(snapshot.warnings[0], /828,400/);
  const unknown = contextSnapshot(); assert.equal(unknown.modelWindowTokens, null); assert.equal(unknown.windowSource, 'working-budget'); assert.match(unknown.warnings[0], /not a model capability claim/);
  const configured = contextSnapshot({ modelWindowTokens: 900000, modelWindowSource: 'user-configured' }); assert.equal(configured.modelWindowTokens, null); assert.equal(configured.configuredModelWindowTokens, 900000); assert.equal(configured.windowSource, 'user-configured');
  assert.throws(() => contextSnapshot({ options: { compactAtTokens: 900000 }, modelWindowTokens: 100000, modelWindowSource: 'provider-reported' }), { code: 'INVALID_CONTEXT' });
  assert.equal(reportedWindowFromError('maximum context length is 128,000 tokens'), 128000);
});

const exchanges = {
  openai: [{ role: 'user', content: 'Original objective.' }, { type: 'reasoning', encrypted_content: 'opaque-reasoning' }, { type: 'function_call', call_id: 'a', name: 'observe', arguments: '{}' }, { type: 'function_call', call_id: 'b', name: 'observe', arguments: '{}' }, { type: 'function_call_output', call_id: 'a', output: 'x'.repeat(3000) }, { type: 'function_call_output', call_id: 'b', output: 'y'.repeat(3000) }, { role: 'assistant', content: 'Complete.' }, { role: 'user', content: 'Next task.' }],
  anthropic: [{ role: 'user', content: 'Original objective.' }, { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'observe', input: {} }, { type: 'tool_use', id: 'b', name: 'observe', input: {} }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'x'.repeat(3000) }, { type: 'tool_result', tool_use_id: 'b', content: 'y'.repeat(3000) }] }, { role: 'assistant', content: 'Complete.' }, { role: 'user', content: 'Next task.' }],
  compatible: [{ role: 'user', content: 'Original objective.' }, { role: 'assistant', content: null, tool_calls: [{ id: 'a', function: { name: 'observe', arguments: '{}' } }, { id: 'b', function: { name: 'observe', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 'a', content: 'x'.repeat(3000) }, { role: 'tool', tool_call_id: 'b', content: 'y'.repeat(3000) }, { role: 'user', content: [{ type: 'text', text: 'Images from tools.' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,PIXELS' } }] }, { role: 'assistant', content: 'Complete.' }, { role: 'user', content: 'Next task.' }],
};
function assertPairs(messages) {
  const pending = new Set();
  for (const message of messages) {
    const calls = message.type === 'function_call' ? [message.call_id] : message.tool_calls?.map(call => call.id) || (Array.isArray(message.content) ? message.content.filter(block => block.type === 'tool_use').map(block => block.id) : []);
    const results = message.type === 'function_call_output' ? [message.call_id] : message.role === 'tool' ? [message.tool_call_id] : Array.isArray(message.content) ? message.content.filter(block => block.type === 'tool_result').map(block => block.tool_use_id) : [];
    calls.forEach(id => pending.add(id)); for (const id of results) { assert.ok(pending.has(id), `orphan result ${id}`); pending.delete(id); }
  }
  assert.equal(pending.size, 0, 'every retained tool call has its result');
}
for (const [type, messages] of Object.entries(exchanges)) test(`${type}: context cuts preserve entire parallel tool exchanges and image supplements`, () => {
  const split = splitContext(messages, 256); assert.ok(split); assertPairs(split.prefix); assertPairs(split.tail);
  assert.equal(split.tail.at(-1).content, 'Next task.'); assert.equal(split.pinnedUser, null);
  if (type === 'compatible') assert.ok(split.prefix.some(message => Array.isArray(message.content) && message.content.some(block => block.type === 'image_url')));
});

test('image bytes and encrypted reasoning are excluded from summary payloads and token estimates', () => {
  const short = [{ type: 'input_image', image_url: 'data:image/png;base64,A' }], large = [{ type: 'input_image', image_url: 'data:image/png;base64,' + 'A'.repeat(1000000) }];
  assert.equal(estimateContextTokens(short), estimateContextTokens(large)); assert.ok(estimateContextTokens(large) < 3000);
  const summary = summarySource([{ type: 'reasoning', encrypted_content: 'PRIVATEOPAQUE' }, ...large]); assert.ok(!summary.includes('PRIVATEOPAQUE')); assert.ok(!summary.includes('base64')); assert.match(summary, /observe the current interface/);
});

test('context components distinguish requested, reported and estimated values and escape content', () => {
  const html = renderContextStatus({ ...contextSnapshot({ options: { preset: '900k' }, modelWindowTokens: 828400, modelWindowSource: 'provider-reported' }), warnings: ['<script>oops</script>'] }, { threadId: 'safe-thread', canCompact: true });
  assert.match(html, /900,000/); assert.match(html, /828,400/); assert.match(html, /Estimated/); assert.ok(!html.includes('<script>')); assert.match(html, /compact-context/);
  assert.match(renderContextFields({ preset: '900k' }), /900k requested/);
});

class FakeCodex extends EventEmitter { status() { return { connected: true, authenticated: true, models: [], defaultModel: 'codex' }; } async close() {} }
const send = (response, value, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); };
function answer(type, text, { call = false, incomplete = false } = {}) {
  if (type === 'openai') return { status: incomplete ? 'incomplete' : 'completed', output: call ? [{ type: 'function_call', id: 'item-a', call_id: 'call-a', name: 'observe', arguments: '{}' }] : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }], usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 } };
  if (type === 'anthropic') return { content: call ? [{ type: 'tool_use', id: 'call-a', name: 'observe', input: {} }] : [{ type: 'text', text }], stop_reason: incomplete ? 'max_tokens' : call ? 'tool_use' : 'end_turn', usage: { input_tokens: 20, output_tokens: 5 } };
  return { choices: [{ message: call ? { role: 'assistant', content: null, tool_calls: [{ id: 'call-a', type: 'function', function: { name: 'observe', arguments: '{}' } }] } : { role: 'assistant', content: text }, finish_reason: incomplete ? 'length' : call ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } };
}
async function harness(t, type, { failSummary = false } = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'relay-context-test-')), requests = []; let normalCalls = 0;
  const server = createServer(async (request, response) => { let raw = ''; for await (const chunk of request) raw += chunk; const body = JSON.parse(raw); requests.push(body); const summary = JSON.stringify(body).includes('Create a concise continuity checkpoint'); send(response, answer(type, summary ? 'Objective kept. The workspace was observed; continue verification.' : ++normalCalls === 1 ? '' : 'Verified workspace.', { call: !summary && normalCalls === 1, incomplete: summary && failSummary })); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  const runtime = await new ProviderRuntime({ codex: new FakeCodex(), dataDir }).init();
  await runtime.saveProvider({ id: 'context', type, baseUrl, apiKey: 'private-context-key', models: [{ id: 'selected-model', contextWindowTokens: 8192, contextWindowSource: 'provider-reported' }] });
  t.after(async () => { await runtime.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); assert.match(path.basename(dataDir), /^relay-context-test-/); await rm(dataDir, { recursive: true, force: true }); });
  return { runtime, dataDir, requests, baseUrl };
}
const options = { preset: 'custom', windowTokens: 8192, outputReserveTokens: 512, headroomTokens: 256, keepRecentTokens: 256, autoCompact: false };
const observe = { name: 'observe', description: 'Observe.', inputSchema: { type: 'object', properties: {} } };
for (const type of ['openai', 'anthropic', 'compatible']) test(`${type}: real selected-model compaction preserves the original transcript and resumes after restart`, async t => {
  const { runtime, dataDir, requests, baseUrl } = await harness(t, type);
  const first = await runtime.runAgent({ cwd: dataDir, model: 'context::selected-model', prompt: 'Observe project ALPHA, then verify.', context: options, dynamicTools: [observe], onToolCall: async () => ({ success: true, contentItems: [{ type: 'inputText', text: 'Evidence ALPHA: ' + 'observed-data '.repeat(400) }] }) });
  assert.equal(first.usage.totalTokens, 50);
  const events = [], compacted = await runtime.compactThread(first.threadId, { onEvent: event => events.push(event) });
  assert.equal(compacted.compacted, true); assert.equal(compacted.checkpoint.summaryModel, 'context::selected-model'); assert.equal(compacted.checkpoint.usage.totalTokens, 25); assert.ok(compacted.checkpoint.afterTokens < compacted.checkpoint.beforeTokens);
  assert.ok(!events.some(event => event.type === 'delta'), 'internal summary must not appear as the agent answer');
  const summaryRequest = requests[2]; assert.equal(summaryRequest.model, 'selected-model'); assert.equal(summaryRequest.tools, undefined);
  const file = path.join(dataDir, 'provider-threads', first.threadId + '.json'), saved = JSON.parse(await readFile(file, 'utf8'));
  assert.match(JSON.stringify(saved.messages), /RELAY CONTEXT CHECKPOINT/); assert.ok(!JSON.stringify(saved.transcript).includes('RELAY CONTEXT CHECKPOINT')); assert.match(JSON.stringify(saved.transcript), /observed-data/); assert.equal(saved.compactions.length, 1); assert.equal(saved.totalUsage.totalTokens, 75); assertPairs(saved.messages); assertPairs(saved.transcript);
  const restored = await new ProviderRuntime({ codex: new FakeCodex(), dataDir }).init(); t.after(() => restored.close()); await restored.saveProvider({ id: 'context', apiKey: 'private-context-key' });
  const resumed = await restored.runAgent({ cwd: dataDir, model: 'context::selected-model', prompt: 'Continue from the checkpoint.', threadId: first.threadId });
  assert.equal(resumed.threadId, first.threadId); assert.equal(resumed.output, 'Verified workspace.'); assert.equal(resumed.context.compactionCount, 1); assert.equal(resumed.usage.total.totalTokens, 100); assert.match(JSON.stringify(requests.at(-1)), /RELAY CONTEXT CHECKPOINT/); assert.equal(restored.listProviders()[0].baseUrl, baseUrl);
});

test('automatic compaction triggers at the configured budget and failed summaries keep every original message', async t => {
  const successful = await harness(t, 'compatible');
  const initial = await successful.runtime.runAgent({ cwd: successful.dataDir, model: 'context::selected-model', prompt: 'Observe ALPHA.', context: { ...options, autoCompact: true, compactAtTokens: 1000 }, dynamicTools: [observe], onToolCall: async () => ({ success: true, contentItems: [{ type: 'inputText', text: 'evidence '.repeat(600) }] }) });
  const continued = await successful.runtime.runAgent({ cwd: successful.dataDir, model: 'context::selected-model', prompt: 'Continue verification.', threadId: initial.threadId });
  assert.equal(continued.context.compactionCount, 1); assert.equal(continued.usage.totalTokens, 50); assert.equal(continued.usage.total.totalTokens, 100);
  const failed = await harness(t, 'compatible', { failSummary: true });
  const first = await failed.runtime.runAgent({ cwd: failed.dataDir, model: 'context::selected-model', prompt: 'Observe BETA.', context: options, dynamicTools: [observe], onToolCall: async () => ({ success: true, contentItems: [{ type: 'inputText', text: 'evidence '.repeat(600) }] }) });
  const file = path.join(failed.dataDir, 'provider-threads', first.threadId + '.json'), before = JSON.parse(await readFile(file, 'utf8'));
  await assert.rejects(failed.runtime.compactThread(first.threadId), { code: 'CONTEXT_SUMMARY_FAILED' });
  const after = JSON.parse(await readFile(file, 'utf8')); assert.deepEqual(after.messages, before.messages); assert.deepEqual(after.transcript, before.transcript); assert.equal(after.compactions.length, 0); assert.equal(after.totalUsage.totalTokens, before.totalUsage.totalTokens + 25);
});

test('native Codex leaves defaults untouched, applies explicit 900k settings, and reports the real smaller window', async t => {
  const cwd = fileURLToPath(new URL('..', import.meta.url)), fixture = fileURLToPath(new URL('./fixtures/context-app-server.mjs', import.meta.url));
  const runtime = new CodexRuntime({ command: process.execPath, args: [fixture], cwd, requestTimeoutMs: 3000, runTimeoutMs: 5000 }); t.after(() => runtime.close());
  const defaultRun = await runtime.runAgent({ cwd, prompt: 'Read config.' }); assert.deepEqual(JSON.parse(defaultRun.output), { config: null });
  const requested = await runtime.runAgent({ cwd, prompt: 'Read config.', context: { preset: '900k' } });
  const config = JSON.parse(requested.output).config; assert.equal(config.model_context_window, 900000); assert.ok(config.model_auto_compact_token_limit < 900000);
  assert.equal(requested.context.requestedWindowTokens, 900000); assert.equal(requested.context.modelWindowTokens, 828400); assert.equal(requested.context.effectiveWindowTokens, 828400);
  const events = [], compacted = await runtime.compactThread(requested.threadId, { onEvent: event => events.push(event) });
  assert.equal(compacted.compacted, true); assert.equal(compacted.method, 'codex-native'); assert.equal(compacted.context.compactionCount, 1); assert.equal(compacted.usage.totalTokens, 25); assert.equal(compacted.usage.total.totalTokens, 50);
  assert.equal(compacted.context.estimatedInputTokens, null, 'native checkpoint size is unknown, not an estimate of an empty prompt');
  assert.equal(compacted.context.remainingTokens, null, 'an unknown checkpoint must not imply an almost-empty window');
  assert.equal(compacted.context.requestedWindowTokens, 900000); assert.equal(compacted.context.modelWindowTokens, 828400);
  assert.equal(compacted.context.actualInputTokens, 20); assert.equal(compacted.context.actualOutputTokens, 5);
  assert.match(compacted.context.estimateMethod, /not reported/i); assert.ok(compacted.context.warnings.some(message => /next agent turn/i.test(message)));
  assert.ok(events.some(event => event.type === 'context' && event.context.compactionCount === 1));
  for (const event of events.filter(event => event.type === 'context' && event.context.compactionCount)) { assert.equal(event.context.estimatedInputTokens, null); assert.equal(event.context.remainingTokens, null); }
  const status = renderContextStatus(compacted.context); assert.match(status, /Estimated current input<\/dt><dd>Not reported/); assert.match(status, /Estimated remaining<\/dt><dd>Not reported/);
  const resumed = await runtime.runAgent({ cwd, threadId: requested.threadId, prompt: 'Read config.', usageBaseline: compacted.usage.total }); assert.equal(resumed.context.compactionCount, 1);
  assert.ok(Number.isFinite(resumed.context.estimatedInputTokens)); assert.ok(resumed.context.estimatedInputTokens > 0); assert.ok(Number.isFinite(resumed.context.remainingTokens)); assert.equal(resumed.context.actualInputTokens, 20); assert.equal(resumed.usage.totalTokens, 25);
  await assert.rejects(runtime.compactThread('../bad'), { code: 'INVALID_THREAD' });
});

function nativeContextRuntime(t) {
  const cwd = fileURLToPath(new URL('..', import.meta.url)), fixture = fileURLToPath(new URL('./fixtures/context-app-server.mjs', import.meta.url));
  const runtime = new CodexRuntime({ command: process.execPath, args: [fixture], cwd, requestTimeoutMs: 3000, runTimeoutMs: 5000 });
  const requests = [], request = runtime._request.bind(runtime);
  runtime._request = (method, params = {}, ...args) => { requests.push({ method, params: structuredClone(params) }); return request(method, params, ...args); };
  t.after(() => runtime.close()); return { runtime, requests, cwd };
}

test('native omitted context preserves 900k continuity, while an explicit model reset clears both saved overrides', async t => {
  const { runtime, requests, cwd } = nativeContextRuntime(t);
  const first = await runtime.runAgent({ cwd, prompt: 'Start with a custom threshold.', context: { preset: '900k', compactAtTokens: 123456 } });
  const inherited = await runtime.runAgent({ cwd, prompt: 'Continue without changing context.', threadId: first.threadId });
  assert.equal(inherited.context.requestedWindowTokens, 900000);
  assert.equal(inherited.context.compactAtTokens, 123456);
  let resume = requests.filter(request => request.method === 'thread/resume').at(-1);
  assert.equal(resume.params.config.model_context_window, 900000); assert.equal(resume.params.config.model_auto_compact_token_limit, 123456);
  const reset = await runtime.runAgent({ cwd, prompt: 'Use model defaults.', threadId: first.threadId, context: { preset: 'model' } });
  resume = requests.filter(request => request.method === 'thread/resume').at(-1);
  assert.deepEqual(resume.params.config, { model_context_window: null, model_auto_compact_token_limit: null });
  assert.equal(reset.context.requestedWindowTokens, null); assert.notEqual(reset.context.compactAtTokens, 123456);
  const continued = await runtime.runAgent({ cwd, prompt: 'Keep the reset defaults.', threadId: first.threadId });
  assert.equal(continued.context.requestedWindowTokens, null); assert.notEqual(continued.context.compactAtTokens, 123456);
  assert.equal(requests.filter(request => request.method === 'thread/resume').at(-1).params.config, undefined, 'omitted context after the reset must not resurrect the old override');
});

test('an explicit native window change derives a fresh threshold when no threshold was supplied', async t => {
  const { runtime, requests, cwd } = nativeContextRuntime(t);
  const first = await runtime.runAgent({ cwd, prompt: 'Start at 900k.', context: { preset: '900k', compactAtTokens: 123456 } });
  const changed = await runtime.runAgent({ cwd, prompt: 'Use a 600k window.', threadId: first.threadId, context: { preset: 'custom', windowTokens: 600000 } });
  const resume = requests.filter(request => request.method === 'thread/resume').at(-1);
  const expected = contextSnapshot({ options: { preset: 'custom', windowTokens: 600000 } });
  assert.equal(resume.params.config.model_context_window, 600000);
  assert.equal(resume.params.config.model_auto_compact_token_limit, expected.compactAtTokens);
  assert.notEqual(resume.params.config.model_auto_compact_token_limit, 123456);
  assert.equal(changed.context.requestedWindowTokens, 600000); assert.equal(changed.context.compactAtTokens, expected.compactAtTokens);
});

test('native compaction can explicitly reset a persistent 900k window and its old threshold', async t => {
  const { runtime, requests, cwd } = nativeContextRuntime(t);
  const first = await runtime.runAgent({ cwd, prompt: 'Start at 900k.', context: { preset: '900k', compactAtTokens: 123456 } });
  const compacted = await runtime.compactThread(first.threadId, { context: { preset: 'model' } });
  assert.equal(compacted.compacted, true); assert.equal(compacted.context.requestedWindowTokens, null);
  const resume = requests.filter(request => request.method === 'thread/resume').at(-1);
  assert.deepEqual(resume.params.config, { model_context_window: null, model_auto_compact_token_limit: null });
  const continued = await runtime.runAgent({ cwd, prompt: 'Continue with reset context.', threadId: first.threadId });
  assert.equal(continued.context.requestedWindowTokens, null); assert.notEqual(continued.context.compactAtTokens, 123456);
});

test('history chunks preserve every Unicode character and fit their stated input budget', () => {
  const text='BEGIN\n'+'🧭漢字abc\n'.repeat(3000)+'MIDDLE_EXACT\n'+'é🙂'.repeat(3000)+'\nEND';
  const chunks=contextTextChunks(text,512);assert.ok(chunks.length>10);assert.equal(chunks.join(''),text);
  for(const chunk of chunks){assert.ok(estimateContextTokens(chunk)<=512);assert.doesNotMatch(chunk,/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);}
});

test('private native history is injected completely and compacted in one ephemeral session before exactly one task turn', async t => {
  const {runtime,requests,cwd}=nativeContextRuntime(t),source='ORIGINAL_GOAL\n'+'x'.repeat(24000)+'\nMIDDLE_EVIDENCE\n'+'漢字🙂'.repeat(7000)+'\nLATEST_EVIDENCE';
  const events=[],result=await runtime.runAgent({cwd,prompt:'Continue the actual task once.',codexHistory:'relay',context:{preset:'custom',windowTokens:8192,outputReserveTokens:512,headroomTokens:256},continuity:{text:source,transcriptPath:path.join(cwd,'full-history.txt')},onEvent:event=>events.push(event)});
  const starts=requests.filter(item=>item.method==='thread/start'),injections=requests.filter(item=>item.method==='thread/inject_items'),compactions=requests.filter(item=>item.method==='thread/compact/start'),turns=requests.filter(item=>item.method==='turn/start');
  assert.equal(starts.length,1);assert.equal(starts[0].params.ephemeral,true);assert.ok(injections.length>3);assert.equal(compactions.length,injections.length);assert.equal(turns.length,1);assert.equal(turns[0].params.input[0].text,'Continue the actual task once.');
  const injected=injections.map(item=>item.params.items[0].content[0].text.split('\n\n').slice(1).join('\n\n')).join('');assert.equal(injected,source);
  for(const request of [...injections,...compactions,...turns])assert.equal(request.params.threadId,result.threadId);
  assert.equal(result.context.compactionCount,compactions.length);assert.equal(runtime.threads.size,0);assert.equal(runtime.contexts.has(result.threadId),false);assert.ok(events.some(event=>event.type==='context'&&event.context.compactionCount>0));
});

test('native compression failure and explicit disable never start the actual task turn', async t => {
  const cwd=fileURLToPath(new URL('..',import.meta.url)),fixture=fileURLToPath(new URL('./fixtures/context-app-server.mjs',import.meta.url));
  for(const autoCompact of [true,false]){
    const runtime=new CodexRuntime({command:process.execPath,args:[fixture,'--fail-compact'],cwd,requestTimeoutMs:3000,runTimeoutMs:5000}),requests=[],request=runtime._request.bind(runtime);runtime._request=(method,params={},...args)=>{requests.push({method,params});return request(method,params,...args);};t.after(()=>runtime.close());
    await assert.rejects(runtime.runAgent({cwd,prompt:'Do not repeat this action.',codexHistory:'relay',context:{preset:'custom',windowTokens:8192,autoCompact},continuity:{text:'Actual saved history. '.repeat(3000)}}),failure=>/original messages were kept/i.test(failure.message));
    assert.equal(requests.filter(item=>item.method==='turn/start').length,0);assert.equal(runtime.threads.size,0);assert.equal(runtime.contexts.size,0);
  }
});

for(const type of ['openai','anthropic','compatible'])test(`${type}: oversized saved continuity uses bounded selected-model summaries without executing tools or losing the original`,async t=>{
  const {runtime,dataDir,requests}=await harness(t,type),source='ORIGINAL_OBJECTIVE\n'+'middle_evidence '.repeat(6000)+'\nLATEST_CONFIRMED_ACTION';let actions=0;
  const result=await runtime.runAgent({cwd:dataDir,model:'context::selected-model',prompt:'Continue this conversation and inspect once.',context:{...options,autoCompact:true},continuity:{text:source,transcriptPath:path.join(dataDir,'original-history.txt')},dynamicTools:[observe],onToolCall:async()=>{actions++;return{success:true,contentItems:[{type:'inputText',text:'Observed once.'}]};}});
  const summaries=requests.filter(body=>JSON.stringify(body).includes('Create a concise continuity checkpoint'));
  assert.ok(summaries.length>3);assert.equal(actions,1);for(const body of summaries){assert.equal(body.model,'selected-model');assert.equal(body.tools,undefined);assert.ok(estimateContextTokens(body)<8192);}
  const saved=await runtime.readThread(result.threadId);assert.equal(saved.transcript[0].content,source);assert.equal(saved.compactions.length,1);assert.equal(saved.compactions[0].chunks,summaries.length);assert.equal(saved.compactions[0].method,'selected-model-summary');assert.match(JSON.stringify(saved.messages),/RELAY CONTEXT CHECKPOINT/);assert.equal(result.output,'Verified workspace.');
});

test('a failed automatic saved-history summary keeps originals and never executes a task action',async t=>{
  const {runtime,dataDir,requests}=await harness(t,'compatible',{failSummary:true}),source='Keep every original byte. '.repeat(3000);let actions=0;
  await assert.rejects(runtime.runAgent({cwd:dataDir,model:'context::selected-model',prompt:'Task must not start after failed compression.',context:{...options,autoCompact:true},continuity:{text:source,transcriptPath:path.join(dataDir,'original.txt')},dynamicTools:[observe],onToolCall:async()=>{actions++;return{success:true};}}),{code:'CONTEXT_SUMMARY_FAILED'});
  assert.equal(actions,0);assert.equal(requests.length,1);const {readdir}=await import('node:fs/promises'),files=await readdir(path.join(dataDir,'provider-threads'));assert.equal(files.length,1);const record=JSON.parse(await readFile(path.join(dataDir,'provider-threads',files[0]),'utf8'));assert.equal(record.transcript[0].content,source);assert.deepEqual(record.messages,[]);assert.deepEqual(record.compactions,[]);
});

test('automatic continuity rejects before any paid summary when the current request leaves no useful checkpoint space',async t=>{
  const {runtime,dataDir,requests}=await harness(t,'compatible'),source='Earlier verified evidence. '.repeat(5000),prompt='Current task requirement.\n'+'x'.repeat(21300);
  await assert.rejects(runtime.runAgent({cwd:dataDir,model:'context::selected-model',prompt,context:{...options,autoCompact:true},continuity:{text:source,transcriptPath:path.join(dataDir,'original.txt')}}),failure=>failure.code==='CONTEXT_OVERFLOW'&&/No summary was requested/.test(failure.message));
  assert.equal(requests.length,0);const {readdir}=await import('node:fs/promises'),files=await readdir(path.join(dataDir,'provider-threads')),record=JSON.parse(await readFile(path.join(dataDir,'provider-threads',files[0]),'utf8'));assert.equal(record.transcript[0].content,source);assert.deepEqual(record.compactions,[]);
});

test('an 8k API model budgets its history checkpoint beside the complete current prompt, developer instructions, tools and wrapper',async t=>{
  const {runtime,dataDir,requests}=await harness(t,'compatible'),source='Earlier confirmed source data. '.repeat(3000),prompt='Current task requirement.\n'+'x'.repeat(19000),developerInstructions='Keep current task instructions exact.\n'+'d'.repeat(1200),tools=[{...observe,description:'Observe only once. '+'t'.repeat(400)}];let actions=0;
  const result=await runtime.runAgent({cwd:dataDir,model:'context::selected-model',prompt,developerInstructions,dynamicTools:tools,onToolCall:async()=>{actions++;return{success:true,contentItems:[{type:'inputText',text:'Observed once.'}]};},context:{...options,autoCompact:true,compactAtTokens:7400},continuity:{text:source,transcriptPath:path.join(dataDir,'original-history.txt')}});
  const summaries=requests.filter(body=>JSON.stringify(body).includes('Create a concise continuity checkpoint')),tasks=requests.filter(body=>!JSON.stringify(body).includes('Create a concise continuity checkpoint'));assert.equal(result.output,'Verified workspace.');assert.equal(actions,1);assert.ok(summaries.length>2);assert.ok(summaries.every(body=>body.max_tokens>=256&&body.max_tokens<512));
  for(const body of tasks){const withSystem=body.messages;assert.ok(estimateContextTokens([withSystem,body.tools||[]])<7424);assert.match(JSON.stringify(withSystem),/Current task requirement/);assert.match(JSON.stringify(withSystem),/Keep current task instructions exact/);assert.match(JSON.stringify(withSystem),/RELAY CONTEXT CHECKPOINT/);}
  const saved=await runtime.readThread(result.threadId);assert.equal(saved.transcript[0].content,source);assert.equal(saved.compactions.length,1);
});

test('native history import reserves the complete current turn before chunking and rejects an unusable checkpoint before opening a thread',async t=>{
  const {runtime,requests,cwd}=nativeContextRuntime(t),context={preset:'custom',windowTokens:8192,outputReserveTokens:512,headroomTokens:256},source='Historical verified data. '.repeat(1000);
  await assert.rejects(runtime.runAgent({cwd,prompt:'x'.repeat(21300),context,codexHistory:'relay',continuity:{text:source,transcriptPath:path.join(cwd,'original.txt')}}),{code:'CONTEXT_OVERFLOW'});
  assert.equal(requests.filter(item=>item.method==='thread/start').length,0);assert.equal(requests.filter(item=>item.method==='thread/compact/start').length,0);assert.equal(requests.filter(item=>item.method==='turn/start').length,0);
  requests.length=0;const prompt='Current instructions. '+'x'.repeat(9000),instructions='Developer payload. '+'y'.repeat(1200),tools=[{...observe,description:'Tool payload. '+'z'.repeat(400)}];
  const result=await runtime.runAgent({cwd,prompt,developerInstructions:instructions,dynamicTools:tools,context,codexHistory:'relay',continuity:{text:source,transcriptPath:path.join(cwd,'original.txt')}}),imports=requests.filter(item=>item.method==='thread/inject_items');
  assert.ok(imports.length>2);for(const entry of imports){const imported=entry.params.items[0].content[0].text,target=Number(/checkpoint under (\d+) tokens/.exec(imported)?.[1]);assert.ok(target>=256);assert.ok(estimateContextTokens([[instructions,prompt,imported],tools])+target<7424,'import plus its stated retained checkpoint target and complete current payload fits');}
  assert.equal(requests.filter(item=>item.method==='thread/start').length,1);assert.equal(requests.filter(item=>item.method==='turn/start').length,1);assert.equal(result.codexHistory,'relay');
});
