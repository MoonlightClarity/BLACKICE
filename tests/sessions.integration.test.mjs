import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHarnessServer } from '../server.mjs';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const waitFor = async (condition, label = 'condition') => {
  const until = Date.now() + 4000;
  while (Date.now() < until) { const value = condition(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail(`${label} did not become ready`);
};
const decode = result => { assert.equal(result.success, true); return JSON.parse(result.contentItems[0].text); };
const tool = (name, arguments_) => ({ name, arguments: arguments_ });

class FakeRuntime extends EventEmitter {
  constructor(execute = async options => ({ output: 'Fixture result', threadId: options.threadId || 'fixture-thread' })) { super(); this.execute = execute; this.calls = []; this.steers = []; }
  status() { return { connected: true, authenticated: true, defaultModel: 'fixture-model', activeTurns: 0 }; }
  async start() { return this.status(); }
  async close() {}
  async runAgent(options) { this.calls.push(options); return this.execute(options, this.calls.length); }
  async steerAgent(threadId, message) { this.steers.push({ threadId, message }); return { accepted: true, threadId, turnId: 'fixture-turn' }; }
}
class NoDesktop extends EventEmitter {
  status() { return { available: false, enabled: false }; }
  async setEnabled() { return this.status(); }
}

const graph = {
  id: 'session-flow', name: 'Session integration',
  nodes: [
    { id: 'input', type: 'input', name: 'Task' },
    { id: 'alpha', type: 'agent', name: 'Alpha', prompt: 'ALPHA_MARKER' },
    { id: 'beta', type: 'agent', name: 'Beta', prompt: 'BETA_MARKER' },
    { id: 'output', type: 'output', name: 'Result' },
  ],
  edges: [{ source: 'input', target: 'alpha' }, { source: 'input', target: 'beta' }, { source: 'alpha', target: 'output' }, { source: 'beta', target: 'output' }],
  settings: { maxParallel: 2, planningMode: 'off' },
};
const singleAgentGraph = () => ({ ...structuredClone(graph), nodes: graph.nodes.filter(node => node.id !== 'beta'), edges: graph.edges.filter(edge => edge.source !== 'beta' && edge.target !== 'beta') });

async function application(t, options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'relay-session-test-'));
  const dataDir = path.join(directory, 'data'), cwd = path.join(directory, 'project-a'), otherCwd = path.join(directory, 'project-b');
  await mkdir(otherCwd, { recursive: true });
  const runtime = options.runtime || new FakeRuntime();
  const app = await createHarnessServer({ runtime, desktop: new NoDesktop(), dataDir, defaultCwd: cwd, port: 0, ...options });
  const url = await app.listen();
  let closed = false;
  const close = async () => { if (!closed) { await app.close(); closed = true; } };
  t.after(async () => {
    await close();
    assert.match(path.basename(directory), /^relay-session-test-/);
    await rm(directory, { recursive: true, force: true });
  });
  const target = new URL(url);
  const request = (route, { method = 'GET', body, headers = {} } = {}) => new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({ hostname: target.hostname, port: target.port, path: route, method, headers: { ...(payload === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }), ...headers } }, res => {
      const parts = [];
      res.on('data', part => parts.push(part));
      res.on('end', () => {
        const text = Buffer.concat(parts).toString();
        let data = text;
        if (String(res.headers['content-type']).includes('application/json')) { try { data = JSON.parse(text); } catch (error) { reject(error); return; } }
        resolve({ status: res.statusCode, headers: res.headers, data });
      });
      res.on('error', reject);
    });
    req.setTimeout(4000, () => req.destroy(new Error('Session HTTP request timed out')));
    req.on('error', reject); req.end(payload);
  });
  const home = await request('/');
  const auth = { Cookie: home.headers['set-cookie'][0].split(';', 1)[0] };
  const api = (route, options = {}) => request(route, { ...options, headers: { ...auth, ...options.headers } });
  const settled = id => waitFor(() => { const value = app.engine.getRun(id); return value.settled && value; }, 'settled run');
  return { app, runtime, request, api, auth, cwd, otherCwd, dataDir, close, settled };
}

test('HTTP continuation preserves its original snapshot and resumes only the chosen saved conversation', async t => {
  const runtime = new FakeRuntime(async options => {
    const selected = options.prompt.includes('ALPHA_MARKER');
    return { output: options.threadId ? 'Refined result' : selected ? 'Alpha result' : 'Beta result', threadId: options.threadId || (selected ? 'alpha-thread' : 'beta-thread'), usage: { totalTokens: 20, total: { totalTokens: options.threadId ? 40 : 20 } } };
  });
  const { api, settled, app } = await application(t, { runtime });
  assert.equal((await api('/api/runtime/settings', { method: 'POST', body: { codexHistory: 'codex' } })).status, 200);
  const initial = await api('/api/runs', { method: 'POST', body: { workflow: graph, input: 'Original task' } });
  assert.equal(initial.status, 201);
  const original = await settled(initial.data.id);
  assert.equal(original.status, 'completed', original.error);
  const savedOriginal = structuredClone(original);
  const callsBefore = runtime.calls.length;
  // Mutating the saved editor draft must not change the original conversation snapshot.
  const modified = structuredClone(graph); modified.nodes.find(node => node.id === 'alpha').prompt = 'CHANGED_EDITOR_INSTRUCTIONS';
  assert.equal((await api('/api/workflows', { method: 'POST', body: modified })).status, 200);
  const response = await api(`/api/runs/${original.id}/continue`, { method: 'POST', body: { nodeId: 'alpha', message: 'Refine the result using the prior context.' } });
  assert.equal(response.status, 201);
  const continued = await settled(response.data.id);
  assert.equal(continued.status, 'completed');
  assert.equal(continued.kind, 'continuation');
  assert.equal(continued.workflowId, graph.id);
  assert.equal(continued.parentRunId, original.id);
  assert.deepEqual(continued.continuedFrom, { runId: original.id, nodeId: 'alpha', threadId: 'alpha-thread' });
  assert.deepEqual(continued.workflow.nodes.map(node => node.id), ['input', 'alpha', 'output']);
  assert.equal(continued.workflow.nodes.find(node => node.id === 'alpha').prompt, 'ALPHA_MARKER');
  assert.equal(runtime.calls.length, callsBefore + 1);
  assert.equal(runtime.calls.at(-1).threadId, 'alpha-thread');
  assert.deepEqual(runtime.calls.at(-1).usageBaseline, { totalTokens: 20 });
  assert.equal(runtime.calls.at(-1).cwd, original.cwd);
  assert.equal(continued.output, '[Alpha]\nRefined result');
  assert.deepEqual(app.engine.getRun(original.id), savedOriginal, 'follow-up never rewrites the original run or its metrics');
  assert.equal((await api(`/api/runs/${original.id}/continue`, { method: 'POST', body: { nodeId: 'output', message: 'Invalid target' } })).status, 400);
  assert.equal((await api('/api/runs/missing/continue', { method: 'POST', body: { nodeId: 'alpha', message: 'Unknown run' } })).status, 404);
});

test('HTTP directions target the working agent and capacity one retains cancellation until acknowledgement', async t => {
  const running = deferred(), release = deferred();
  const runtime = new FakeRuntime(async options => {
    options.onEvent({ type: 'turn', threadId: 'live-thread', turnId: 'fixture-turn' });
    running.resolve(options);
    return release.promise;
  });
  const { api, app, settled } = await application(t, { runtime, maxConcurrentRuns: 1 });
  const start = await api('/api/runs', { method: 'POST', body: { workflow: singleAgentGraph(), input: 'A working task' } });
  const options = await running.promise;
  try {
    const accepted = await api(`/api/runs/${start.data.id}/steer`, { method: 'POST', body: { nodeId: 'alpha', message: 'Use the corrected target.' } });
    assert.equal(accepted.status, 200);
    assert.deepEqual(runtime.steers, [{ threadId: 'live-thread', message: 'Use the corrected target.' }]);
    assert.equal((await api(`/api/runs/${start.data.id}/continue`, { method: 'POST', body: { nodeId: 'alpha', message: 'Premature continuation' } })).status, 409);
    assert.equal((await api(`/api/runs/${start.data.id}/cancel`, { method: 'POST', body: {} })).status, 200);
    assert.equal(options.signal.aborted, true);
    assert.equal((await api(`/api/runs/${start.data.id}/steer`, { method: 'POST', body: { nodeId: 'alpha', message: 'Too late' } })).status, 409);
    assert.equal(runtime.steers.length, 1);
    assert.equal((await api('/api/runs', { method: 'POST', body: { workflow: graph, input: 'Must wait' } })).status, 409);
    assert.equal((await api(`/api/runs/${start.data.id}/continue`, { method: 'POST', body: { nodeId: 'alpha', message: 'Must also wait' } })).status, 409);
    const status = await api('/api/status');
    assert.equal(status.data.execution.activeRunId, start.data.id);
    assert.equal(status.data.execution.stopping, true);
  } finally { release.resolve({ output: 'Discard this late output', threadId: 'live-thread' }); }
  const completed = await settled(start.data.id);
  assert.equal(completed.status, 'cancelled');
  assert.equal(completed.nodes.alpha.status, 'cancelled');
  assert.equal(completed.output, '');
  assert.ok(app.engine.getRun(start.data.id).events.some(event => event.data.type === 'steer'));
});


test('attached tools retain read-only release skills and scoped history without exposing legacy memory',async t=>{
 const runtime=new FakeRuntime(async options=>{
  const attached=new Map(options.dynamicTools.map(spec=>[spec.name,spec]));
  for(const name of ['relay_history','relay_skills','relay_workspace'])assert.ok(attached.has(name));
  assert.equal(attached.has('relay_memory'),false);assert.equal(attached.has('relay_learn'),false);
  assert.deepEqual(attached.get('relay_skills').inputSchema.properties.action.enum,['search','read']);
  assert.doesNotMatch(options.prompt,/LOCAL_LEGACY_SECRET|OTHER_LEGACY_SECRET/);
  const skills=decode(await options.onToolCall(tool('relay_skills',{action:'search'})));
  assert.ok(Array.isArray(skills.entries));assert.ok(!JSON.stringify(skills).includes('legacy-skill-secret'));
  const history=decode(await options.onToolCall(tool('relay_history',{action:'search'})));
  assert.equal(history.results.length,0,'active run excluded');
  await assert.rejects(options.onToolCall(tool('relay_memory',{action:'remember',title:'No',content:'No'})),/Unknown knowledge tool/);
  await assert.rejects(options.onToolCall(tool('relay_skills',{action:'save'})),/Unknown knowledge action/);
  return{output:'Read-only catalog inspected',threadId:'knowledge-thread'};
 });
 const{api,app,dataDir,settled}=await application(t,{runtime});
 const saved=path.join(dataDir,'knowledge.json'),bytes='LOCAL_LEGACY_SECRET OTHER_LEGACY_SECRET legacy-skill-secret';await writeFile(saved,bytes);
 const started=await api('/api/runs',{method:'POST',body:{workflow:singleAgentGraph(),input:'Inspect the available release methods.'}});
 assert.equal(started.status,201);const run=await settled(started.data.id);assert.equal(run.status,'completed',run.error);
 assert.equal(await readFile(saved,'utf8'),bytes);assert.equal(Object.hasOwn(app,'knowledge'),false);
 assert.equal(runtime.calls.length,1);assert.equal(run.events.some(event=>event.data?.status==='pending_approval'),false);
});

test('cancellation blocks late tool writes without memory machinery',async t=>{
 const entered=deferred(),release=deferred(),runtime=new FakeRuntime(async options=>{entered.resolve(options);return release.promise;});
 const{api,app,settled}=await application(t,{runtime});
 const started=await api('/api/runs',{method:'POST',body:{workflow:singleAgentGraph(),input:'Await cancellation.'}}),active=await entered.promise;
 try{
  await api('/api/runs/'+started.data.id+'/cancel',{method:'POST',body:{}});
  await assert.rejects(active.onToolCall(tool('relay_workspace',{action:'write',path:'late.txt',text:'Must not persist.'})),{name:'AbortError'});
 }finally{release.resolve({output:'Late output',threadId:'cancelled-knowledge-thread'});}
 assert.equal((await settled(started.data.id)).status,'cancelled');
});


test('retired knowledge rejects incomplete mutation bodies without waiting for or writing their contents',async t=>{
 const{app,auth,close}=await application(t),payload=JSON.stringify({id:'late-body-note',kind:'memory',title:'Late body',content:'Never consumed'});
 let pendingRequest;
 const response=new Promise((resolve,reject)=>{
  pendingRequest=http.request({hostname:'127.0.0.1',port:app.server.address().port,path:'/api/knowledge',method:'POST',headers:{...auth,'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)}},res=>{
   const parts=[];res.on('data',part=>parts.push(part));res.on('end',()=>resolve({status:res.statusCode,data:JSON.parse(Buffer.concat(parts).toString())}));res.on('error',reject);
  });
  pendingRequest.setTimeout(4000,()=>pendingRequest.destroy(new Error('Retired endpoint waited for a body')));pendingRequest.on('error',reject);pendingRequest.write(payload.slice(0,1));
 });
 try{const result=await response;assert.equal(result.status,404);assert.equal(Object.hasOwn(app,'knowledge'),false);}
 finally{pendingRequest.destroy();}
 await close();
});
