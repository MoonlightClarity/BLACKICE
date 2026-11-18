import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHarnessServer } from '../server.mjs';
import { ConnectionManager } from '../lib/mcp.mjs';

const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const waitFor=async(check,label='condition')=>{const deadline=Date.now()+5000;while(Date.now()<deadline){const value=check();if(value)return value;await new Promise(resolve=>setTimeout(resolve,5));}assert.fail(`${label} did not settle`);};
// These fixtures exercise identity, learning, context and MCP integration.
// Recursive planning and its final review use dedicated planning fixtures.
const graph=()=>({id:'agent-integration',name:'Integration task',nodes:[{id:'input',type:'input'},{id:'agent',type:'agent',name:'Verifier',prompt:'Verify the requested result.',model:'fixture-model'},{id:'output',type:'output'}],edges:[{source:'input',target:'agent'},{source:'agent',target:'output'}],settings:{maxParallel:1,planningMode:'off'}});
class Runtime extends EventEmitter {
  constructor(execute){super();this.execute=execute;this.calls=[];this.closed=false;}
  status(){return{connected:true,authenticated:true,defaultModel:'fixture-model',models:[{model:'fixture-model',supportedReasoningEfforts:[{reasoningEffort:'medium'}]}]};}
  async start(){return this.status();}
  async runAgent(options){this.calls.push(options);return this.execute?this.execute(options,this.calls.length):{output:'Verified fixture result.',threadId:'fixture-thread'};}
  async close(){this.closed=true;}
}
class NoDesktop extends EventEmitter {status(){return{available:false,enabled:false};}async setEnabled(){return this.status();}}
const tool=(options,name,args,context)=>options.onToolCall({name,arguments:args},context);
const text=result=>result.contentItems.filter(item=>item.type==='inputText').map(item=>item.text).join('\n');
const toolData=result=>{assert.equal(result.success,true,text(result));return JSON.parse(result.contentItems.find(item=>item.type==='inputText').text);};
async function application(t,{execute,connectionsFactory,maxConcurrentRuns=4}={}){
  const directory=await mkdtemp(path.join(tmpdir(),'relay-agent-integration-')),dataDir=path.join(directory,'data'),cwd=path.join(directory,'workspace');
  const runtime=new Runtime(execute),connections=connectionsFactory?await connectionsFactory({dataDir,cwd}):undefined;
  const app=await createHarnessServer({port:0,dataDir,defaultCwd:cwd,runtime,desktop:new NoDesktop(),maxConcurrentRuns,...(connections?{connections}:{})});
  t.after(async()=>{await app.close();assert.match(path.basename(directory),/^relay-agent-integration-/);await rm(directory,{recursive:true,force:true});});
  assert.equal(app.learning.status().retired,true);
  const url=await app.listen(),home=await fetch(url),cookie=home.headers.get('set-cookie').split(';',1)[0];await home.arrayBuffer();
  const request=async(route,{method='GET',body,authenticated=true}={})=>{const response=await fetch(new URL(route,url),{method,headers:{...(authenticated?{Cookie:cookie}:{}),...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:response.status,data:await response.json()};};
  const settled=id=>waitFor(()=>{const run=app.engine.getRun(id);return run.settled&&run;},'foreground run');
  return{app,runtime,request,settled,directory,dataDir,cwd};
}

test('identity tools stay read-only while owner edits refresh only the next immutable turn snapshot',async t=>{
  let initialRevision,initialPrompt;
  const {app,runtime,request,settled}=await application(t,{execute:async(options,index)=>{
    assert.ok(options.dynamicTools.some(item=>item.name==='relay_identity'));assert.match(options.prompt,/BLACKICE GLOBAL IDENTITY/);
    if(index===1){
      initialPrompt=options.prompt;const record=toolData(await tool(options,'relay_identity',{action:'read',kind:'user'}));initialRevision=record.revision;
      await assert.rejects(tool(options,'relay_identity',{action:'update',kind:'user',content:record.content+'\n- Prefer compact handoffs.\n',expectedRevision:record.revision,expectedHash:record.diskHash,sourceQuote:'Prefer compact handoffs.'}),/user-controlled and read-only/);
      assert.equal((await request('/api/identity/user')).data.content,record.content);
      const response=await request('/api/identity/user',{method:'PUT',body:{content:record.content+'\n- Prefer compact handoffs.\n',expectedRevision:record.revision,expectedHash:record.diskHash}});assert.equal(response.status,200);const saved=response.data;
      assert.equal(saved.revision,record.revision+1);assert.equal(options.prompt,initialPrompt,'saving cannot mutate the current turn snapshot');
    }else assert.match(options.prompt,/Prefer compact handoffs/);
    return{output:'Verified fixture result.',threadId:`fixture-thread-${index}`};
  }});
  const first=app.engine.startRun({workflow:graph(),input:'Prefer compact handoffs. Please save that preference.'}),done=await settled(first.id);
  assert.equal(done.status,'completed',done.error);assert.equal(done.nodes.agent.identity.revisions.user,initialRevision);assert.equal(done.nodes.agent.identity.truncated,false);
  assert.ok(done.events.some(event=>event.data.type==='identity'&&event.data.action==='read'));
  const second=app.engine.startRun({workflow:graph(),input:'Use the profile on the next turn.'});const next=await settled(second.id);
  assert.equal(next.status,'completed',next.error);
  assert.equal(next.nodes.agent.identity.revisions.user,initialRevision+1);assert.equal(runtime.calls.length,2);
  assert.equal((await request('/api/identity',{authenticated:false})).status,401);
  const current=(await request('/api/identity/user')).data;
  const stale=await request('/api/identity/user',{method:'PUT',body:{content:'Overwrites newer preference',expectedRevision:initialRevision,expectedHash:current.diskHash}});assert.equal(stale.status,409);
  const versions=await request('/api/identity/user/versions');assert.ok(versions.data.length>=2);
});

test('workflow and node context settings survive HTTP validation, reach the runtime, and publish measured context events',async t=>{
  const measured={effectiveWindowTokens:128000,actualInputTokens:4500,remainingTokens:110000,warnings:['Requested window exceeds this fixture model.']};
  const {app,runtime,request,settled}=await application(t,{maxConcurrentRuns:1,execute:async options=>{options.onEvent({type:'context',context:measured});return{output:'Context verified.',threadId:'context-thread'};}});
  const flow=graph();flow.settings.context={preset:'900k',autoCompact:true};flow.nodes[1].context={preset:'custom',windowTokens:64000,autoCompact:false,outputReserveTokens:2048};
  const started=await request('/api/runs',{method:'POST',body:{workflow:flow,input:'Verify explicit context budgets.'}});assert.equal(started.status,201);
  const run=await settled(started.data.id);assert.equal(run.status,'completed',run.error);
  assert.equal(run.workflow.settings.context.windowTokens,900000);assert.equal(run.workflow.nodes[1].context.windowTokens,64000);assert.deepEqual(runtime.calls[0].context,run.workflow.nodes[1].context);
  assert.deepEqual(run.nodes.agent.contextStatus,measured);assert.ok(run.events.some(event=>event.data.type==='context'));
  const bad=graph();bad.settings.context={preset:'custom',windowTokens:100};assert.equal((await request('/api/runs',{method:'POST',body:{workflow:bad,input:'Invalid budget'}})).status,400);
  let observedSignal;const entered=deferred(),release=deferred();runtime.compactThread=async(threadId,options)=>{assert.equal(threadId,'context-thread');observedSignal=options.signal;options.onEvent({type:'context',context:{...measured,compactionCount:1}});entered.resolve();await release.promise;if(options.signal.aborted)throw Object.assign(new Error('Compaction stopped'),{name:'AbortError'});return{compactionCount:1};};
  const compact=app.engine.compactRun(run.id,{nodeId:'agent'});const outcome=compact.then(()=>null,error=>error);await entered.promise;
  let closing;
  try{
    assert.equal(app.engine.cancelCompactions(),1,'emergency stop reaches compaction on a completed run');assert.equal(observedSignal.aborted,true);assert.equal(app.engine.cancelCompactions(),0,'repeated stop is idempotent');
    assert.throws(()=>app.engine.startRun({workflow:graph(),input:'Do not overlap compaction at capacity one'}),{status:409,code:'RUN_CAPACITY'});let closed=false;closing=app.close().then(()=>{closed=true;});await tick();assert.equal(observedSignal.aborted,true);assert.equal(closed,false,'shutdown waits for compaction acknowledgement');
  }finally{release.resolve();await outcome;if(closing)await closing;}
  assert.equal((await outcome).name,'AbortError');assert.equal(app.engine.executions.size,0);
});

test('completed foreground tasks never schedule a background learning provider turn',async t=>{
  const {app,runtime,settled,dataDir}=await application(t,{execute:async options=>{
    assert.ok(!options.dynamicTools.some(item=>item.name==='relay_learn'));
    return{output:'Verified fixture result.',threadId:'no-learning-'+runtime.calls.length};
  }});
  for(const input of ['First foreground task','Second foreground task']){
    const run=await settled(app.engine.startRun({workflow:graph(),input}).id);assert.equal(run.status,'completed',run.error);
  }
  await tick();assert.equal(runtime.calls.length,2);assert.deepEqual(app.learning.status(),{available:false,retired:true,enabled:false});
  assert.equal(app.learning.active,false);assert.equal(app.knowledge.listApprovals().length,0);assert.equal(app.knowledge.list().length,0);
  await assert.rejects(readFile(path.join(dataDir,'learning.json')),{code:'ENOENT'});
});

test('retired learning routes cannot create a review or publish generated knowledge',async t=>{
  const {app,runtime,request,settled,dataDir}=await application(t);
  const run=await settled(app.engine.startRun({workflow:graph(),input:'Verify the fixture export'}).id);assert.equal(run.status,'completed',run.error);
  for(const route of ['/api/learning/review','/api/learning/settings']){
    const result=await request(route,{method:'POST',body:{runId:run.id,mode:'auto'}});assert.equal(result.status,410);assert.equal(result.data.code,'LEARNING_RETIRED');
  }
  await tick();assert.equal(runtime.calls.length,1);assert.equal(app.knowledge.list().length,0);assert.equal(app.knowledge.listApprovals().length,0);
  await assert.rejects(readFile(path.join(dataDir,'learning.json')),{code:'ENOENT'});
});

test('connected capabilities are registered and call a real MCP transport through the engine with redacted API state and shutdown cleanup',async t=>{
  const methods=[],wire=[];let manager;
  const {app,request,settled,dataDir}=await application(t,{connectionsFactory:async({dataDir})=>{
    manager=new ConnectionManager({dataDir,fetchImpl:async(_url,options)=>{
      if(options.method==='DELETE')return new Response(null,{status:204});const message=JSON.parse(options.body);methods.push(message.method);wire.push(options);
      if(message.id===undefined)return new Response(null,{status:202});
      const result=message.method==='initialize'?{protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'Fixture MCP',version:'1'}}:message.method==='tools/list'?{tools:[{name:'verify_fixture',description:'Read fixture status',inputSchema:{type:'object',properties:{label:{type:'string'}},required:['label']}}]}:{content:[{type:'text',text:`Verified MCP fixture ${message.params.arguments.label}`}],structuredContent:{verified:true}};
      return new Response(JSON.stringify({jsonrpc:'2.0',id:message.id,result}),{status:200,headers:{'Content-Type':'application/json',...(message.method==='initialize'?{'Mcp-Session-Id':'fixture-session'}:{})}});
    }});return manager;
  },execute:async options=>{
    assert.ok(options.dynamicTools.some(item=>item.name==='relay_connections'));assert.match(options.prompt,/CONNECTED CAPABILITIES/);
    const listed=await tool(options,'relay_connections',{action:'connections'});assert.match(text(listed),/fixture-mcp/);
    const tools=await tool(options,'relay_connections',{action:'tools',connectionId:'fixture-mcp'});assert.match(text(tools),/verify_fixture/);
    const result=await tool(options,'relay_connections',{action:'call',connectionId:'fixture-mcp',name:'verify_fixture',arguments:{label:'artifact'}});assert.equal(result.success,true);assert.match(text(result),/Verified MCP fixture artifact/);
    return{output:'Connected fixture verified.',threadId:'mcp-thread'};
  }});
  assert.equal((await request('/api/connections',{authenticated:false})).status,401);
  const saved=await request('/api/connections',{method:'POST',body:{id:'fixture-mcp',name:'Fixture MCP',transport:'http',url:'https://fixture.invalid/mcp',headers:{Authorization:'Bearer fixture-only-secret-123'}}});assert.equal(saved.status,200);assert.ok(!JSON.stringify(saved.data).includes('fixture-only-secret'));
  const started=app.engine.startRun({workflow:graph(),input:'Verify the fixture using the connected capability.'});const run=await settled(started.id);assert.equal(run.status,'completed',run.error);assert.ok(run.events.some(event=>event.data.type==='connection.action'&&event.data.toolName==='verify_fixture'));
  assert.deepEqual(methods,['initialize','notifications/initialized','tools/list','tools/call']);assert.equal(wire.at(-1).headers.Authorization,'Bearer fixture-only-secret-123');
  assert.ok(!(await readFile(path.join(dataDir,'connections.json'),'utf8')).includes('fixture-only-secret'));assert.ok(!JSON.stringify((await request('/api/status')).data).includes('fixture-only-secret'));
  const client=manager.clients.get('fixture-mcp');await app.close();assert.equal(client.closed,true);assert.equal(manager.closed,true);assert.equal(app.runtime.closed,true);
});

test('owner identity edits stay durable while retired learning routes reject mutation and shutdown preserves identity boundaries',async t=>{
  const {app,request,dataDir}=await application(t);
  const initial=(await request('/api/identity/soul')).data;
  const saved=await request('/api/identity/soul',{method:'PUT',body:{content:'# Relay persona\n\nUse specific evidence in handoffs.\n',expectedRevision:initial.revision,expectedHash:initial.diskHash}});assert.equal(saved.status,200);
  const restored=await request('/api/identity/soul/restore',{method:'POST',body:{revision:initial.revision,expectedRevision:saved.data.revision,expectedHash:saved.data.diskHash}});assert.equal(restored.status,200);assert.equal(restored.data.content,initial.content);assert.equal(restored.data.provenance.restoredFrom,initial.revision);
  for(const [route,method,body] of [['/api/learning','GET'],['/api/learning/settings','POST',{mode:'off'}],['/api/learning/settings','POST',{mode:'invalid'}],['/api/learning/review','POST',{runId:'missing'}]]){
    const result=await request(route,{method,body});assert.equal(result.status,410);assert.equal(result.data.code,'LEARNING_RETIRED');
  }
  await assert.rejects(readFile(path.join(dataDir,'learning.json')),{code:'ENOENT'});
  const entered=deferred(),release=deferred();app.desktop.setEnabled=async()=>{entered.resolve();await release.promise;return{enabled:false};};const closing=app.close();await entered.promise;
  try{assert.equal((await request('/api/learning/settings',{method:'POST',body:{mode:'auto'}})).status,503);assert.equal((await request('/api/identity/soul',{method:'PUT',body:{content:'Too late',expectedRevision:restored.data.revision}})).status,503);}finally{release.resolve();await closing;}
});
