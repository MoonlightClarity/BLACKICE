import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHarnessServer } from '../server.mjs';
import { BrowserWorkspace } from '../lib/browser.mjs';
import { ProviderRuntime } from '../lib/providers.mjs';
import { recordFixturePlan } from './fixture-task-plan.mjs';

const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const waitFor=async(check,label='condition')=>{const deadline=Date.now()+4000;while(Date.now()<deadline){const value=check();if(value)return value;await new Promise(resolve=>setTimeout(resolve,5));}assert.fail(`${label} did not settle`);};
const jsonResponse=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
const answer=text=>({status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text}]}],usage:{input_tokens:7,output_tokens:3,total_tokens:10}});
const functionCall=(name,args,id='browser-call')=>({status:'completed',output:[{type:'function_call',id:`item-${id}`,call_id:id,name,arguments:JSON.stringify(args)}],usage:{input_tokens:7,output_tokens:3,total_tokens:10}});
const toolResult=(request,callId)=>{
  const receipt=request.input.find(item=>item.type==='function_call_output'&&item.call_id===callId);
  assert.ok(receipt,`Missing provider tool result for ${callId}`);
  // Planning On appends a separate sequencing receipt after the tool's own
  // payload. Decode that primary JSON object without joining metadata into it.
  const text=receipt.output.find(item=>item.type==='input_text').text,value=JSON.parse(text);
  assert.equal(value.error,undefined,text);
  return value;
};
const graph=(model='default')=>({id:'capability-flow',name:'Capabilities integration',nodes:[{id:'input',type:'input',name:'Task'},{id:'agent',type:'agent',name:'Agent',prompt:'Inspect the requested result and report verified evidence.',model},{id:'output',type:'output',name:'Result'}],edges:[{source:'input',target:'agent'},{source:'agent',target:'output'}],settings:{maxParallel:2}});

class FakeCodex extends EventEmitter {
  constructor(ready=false,execute){super();this.ready=ready;this.execute=execute;this.calls=[];this.closed=false;}
  status(){return{connected:this.ready,authenticated:this.ready,defaultModel:'codex-fixture',models:[{id:'codex-fixture',model:'codex-fixture',supportedReasoningEfforts:[]}],activeTurns:0,lastError:this.ready?null:'Codex fixture is offline'};}
  async start(){if(!this.ready)throw new Error('Codex fixture is offline');return this.status();}
  async runAgent(options){this.calls.push(options);return this.execute?this.execute(options):{output:'Codex fixture result',threadId:'fixture-thread',turnId:'fixture-turn'};}
  async close(){this.closed=true;}
}
class NoDesktop extends EventEmitter{status(){return{available:false,enabled:false};}async setEnabled(){return this.status();}}
class FakeBrowserDriver extends EventEmitter {
  constructor(execute){super();this.execute=execute;this.calls=[];this.shown=[];this.released=[];this.closed=false;this.tabs=[{tabId:'fixture-tab',browser:'relay',title:'Fixture browser',url:'https://example.test/'}];this.activeTab='fixture-tab';this.ownerActiveTabs={};}
  status(){return{available:!this.closed,contained:true,tabs:this.tabs.map(tab=>({...tab,...(tab.owner?{owner:{...tab.owner}}:{})})),activeTab:this.activeTab,ownerActiveTabs:{...this.ownerActiveTabs}};}
  async perform(args,options={}){
    this.calls.push({args,options});let tabId=args.tabId||this.activeTab;
    if(args.action==='open'){
      tabId=`fixture-open-${this.tabs.length}`;
      this.tabs.push({tabId,browser:'relay',title:'Verified fixture page',url:args.url,...(options.owner?{owner:{...options.owner}}:{})});
      if(options.owner)this.ownerActiveTabs[`${options.owner.taskId}\0${options.owner.nodeId}`]=tabId;else this.activeTab=tabId;
    }
    const result=this.execute?await this.execute(args,options):{title:'Verified fixture page',text:'Observed page state'};
    return{tabId,...result};
  }
  async releaseOwner(owner){this.released.push({...owner});return{suspended:[],retained:[]};}
  async show(tabId){this.shown.push(tabId);if(tabId==='missing')throw new Error('Browser tab not found.');return{tabId:tabId||'fixture-tab',visible:true};}
  async close(){this.closed=true;}
}

async function application(t,{runtimeFactory,driver=new FakeBrowserDriver(),browser:providedBrowser,maxConcurrentRuns=4}={}){
  const directory=await mkdtemp(path.join(tmpdir(),'relay-capabilities-test-')),dataDir=path.join(directory,'data'),cwd=path.join(directory,'workspace');
  const runtime=runtimeFactory?await runtimeFactory({dataDir,cwd}):new FakeCodex(true);
  const browser=providedBrowser||new BrowserWorkspace({driver});
  const app=await createHarnessServer({runtime,browser,desktop:new NoDesktop(),port:0,dataDir,defaultCwd:cwd,maxConcurrentRuns});
  const url=await app.listen(),target=new URL(url);
  t.after(async()=>{await app.close();assert.match(path.basename(directory),/^relay-capabilities-test-/);await rm(directory,{recursive:true,force:true});});
  const request=(route,{method='GET',body,headers={}}={})=>new Promise((resolve,reject)=>{
    const payload=body===undefined?undefined:JSON.stringify(body);
    const req=http.request({hostname:target.hostname,port:target.port,path:route,method,headers:{...(payload===undefined?{}:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)}),...headers}},res=>{
      const parts=[];res.on('data',part=>parts.push(part));res.on('end',()=>{const text=Buffer.concat(parts).toString();let data=text;try{if(String(res.headers['content-type']).includes('application/json'))data=JSON.parse(text);}catch(error){reject(error);return;}resolve({status:res.statusCode,headers:res.headers,data,text});});res.on('error',reject);
    });
    req.setTimeout(4000,()=>req.destroy(new Error('Capabilities HTTP request timed out')));req.on('error',reject);req.end(payload);
  });
  const home=await request('/'),auth={Cookie:home.headers['set-cookie'][0].split(';',1)[0]};
  const api=(route,options={})=>request(route,{...options,headers:{...auth,...options.headers}});
  const settled=id=>waitFor(()=>{const run=app.engine.getRun(id);return run.settled&&run;},'capability run');
  return{app,runtime,browser,driver,api,request,auth,directory,dataDir,cwd,settled};
}

test('HTTP preflight checks each selected provider instead of aggregate runtime readiness and default falls back to a configured remote model',async t=>{
  const codex=new FakeCodex(false),requests=[];
  const {api,app,settled,runtime}=await application(t,{runtimeFactory:async({dataDir})=>{
    const runtime=await new ProviderRuntime({codex,dataDir,fetchImpl:async(url,options)=>{
      const body=JSON.parse(options.body);requests.push({url,body});
      if(requests.length===1){
        assert.ok(body.tools.find(tool=>tool.name==='relay_task')?.parameters?.properties?.plan);
        return jsonResponse(functionCall('relay_task',{action:'read'},'default-task-read'));
      }
      if(requests.length===2){
        const current=toolResult(body,'default-task-read');
        assert.equal(current.plan.origin,'runtime');assert.deepEqual(current.steps,[]);
        return jsonResponse(functionCall('relay_task',{action:'plan',expectedRevision:current.revision,plan:{layout:'sequence'},steps:[{id:'verify-provider',title:'Verify the selected remote provider',kind:'action',status:'active',operation:{kind:'reasoning',target:'The admitted remote-fixture provider request'},result:'The configured remote provider identifies the admitted model in its received request.',note:'Compare this received request model with remote-fixture and the fixture assertions about the unused offline provider.',doneWhen:'The request observed by this configured provider names remote-fixture.'}]},'default-task-plan'));
      }
      if(requests.length===3){
        const planned=toolResult(body,'default-task-plan');
        assert.equal(planned.plan.origin,'agent');assert.equal(planned.plan.detail,'detailed');assert.equal(planned.steps[0].id,'verify-provider');
        assert.equal(body.model,'remote-fixture');
        return jsonResponse(functionCall('relay_task',{action:'step',expectedRevision:planned.revision,stepId:'verify-provider',status:'done',evidence:'The configured provider received this request with model remote-fixture.'},'default-task-done'));
      }
      assert.equal(requests.length,4);assert.equal(toolResult(body,'default-task-done').steps[0].status,'done');
      return jsonResponse(answer('Remote provider selected correctly'));
    }}).init();
    await runtime.saveProvider({id:'cloud',type:'openai',models:['remote-fixture'],apiKey:'fixture-private-provider-key'});
    await runtime.saveProvider({id:'disabled',type:'compatible',models:['offline-fixture'],enabled:false});return runtime;
  }});
  const status=(await api('/api/status')).data;
  assert.equal(status.connected,true);assert.equal(status.authenticated,true);assert.equal(status.codex.connected,false);
  assert.equal(status.defaultModel,'cloud::remote-fixture');
  for(const model of ['codex-fixture','missing::model','disabled::offline-fixture']){
    const denied=await api('/api/runs',{method:'POST',body:{workflow:graph(model),input:'Do not start unavailable models'}});
    assert.equal(denied.status,400,model);assert.match(denied.data.error,/offline|configured|disabled/i);
  }
  const mixed=graph('cloud::remote-fixture');mixed.nodes.splice(2,0,{id:'offline-agent',type:'agent',name:'Offline',prompt:'Must not start',model:'codex-fixture'});mixed.edges.push({source:'input',target:'offline-agent'},{source:'offline-agent',target:'output'});
  assert.equal((await api('/api/runs',{method:'POST',body:{workflow:mixed,input:'Preflight all branches'}})).status,400);
  assert.equal(requests.length,0,'a bad parallel branch prevents every provider request');assert.equal(codex.calls.length,0);assert.equal(app.engine.listRuns().length,0);
  const started=await api('/api/runs',{method:'POST',body:{workflow:graph(),input:'Use the available default'}});
  assert.equal(started.status,201);const run=await settled(started.data.id);
  assert.equal(run.status,'completed',run.error);assert.match(run.output,/Remote provider selected correctly/);
  assert.equal(requests.length,4);assert.ok(requests.every(request=>request.body.model==='remote-fixture'));assert.equal(codex.calls.length,0);
  assert.equal(run.nodes.agent.planning.status,'recorded');assert.equal(run.taskState.plan.authoredBy.runId,run.id);
  assert.equal(runtime.resolveModel('cloud::remote-fixture').available,true);
});

test('provider HTTP tools registered by the engine invoke the actual browser workspace and return images without persisting pixels in the trace',async t=>{
  const requests=[],driver=new FakeBrowserDriver(async args=>args.action==='screenshot'?{imageUrl:'data:image/png;base64,UElYRUxT'}:{text:'The page shows the verified fixture value'}),personalTab=driver.status().tabs[0];
  let planRevision,openedTabId;
  const {api,settled}=await application(t,{driver,runtimeFactory:async({dataDir})=>{
    const runtime=await new ProviderRuntime({codex:new FakeCodex(false),dataDir,fetchImpl:async(_url,options)=>{
      const request=JSON.parse(options.body);requests.push(request);
      if(requests.length===1){
        assert.ok(request.tools.find(tool=>tool.name==='relay_task')?.parameters?.properties?.steps?.items?.properties?.operation,'the provider receives the current operation-aware task schema');
        return jsonResponse(functionCall('relay_task',{action:'read'},'task-read'));
      }
      if(requests.length===2){
        const current=toolResult(request,'task-read');
        assert.equal(current.plan.origin,'runtime');assert.deepEqual(current.steps,[]);
        return jsonResponse(functionCall('relay_task',{action:'plan',expectedRevision:current.revision,plan:{layout:'sequence'},steps:[
          {id:'open-browser',title:'Open the fixture page',kind:'action',status:'active',operation:{kind:'tool',tool:'relay_browser',action:'open',target:'https://example.test/fixture'},result:'A task-owned tab ID and the observed fixture page text.',note:'Call relay_browser open for https://example.test/fixture and inspect its returned tab ID and text.',doneWhen:'The browser returns a task-owned tab ID and the fixture page text.'},
          {id:'verify-browser',title:'Capture the fixture page',kind:'action',status:'pending',operation:{kind:'tool',tool:'relay_browser',action:'screenshot',target:'The task-owned tab returned by open-browser'},result:'An actual screenshot from the observed task-owned browser tab.',note:'Call relay_browser screenshot with the tab ID returned by open-browser and inspect its returned image.',doneWhen:'The browser returns the actual screenshot from that task-owned tab.'}
        ]},'task-plan'));
      }
      if(requests.length===3){
        const planned=toolResult(request,'task-plan');
        assert.equal(planned.plan.origin,'agent');assert.equal(planned.plan.detail,'detailed');assert.equal(planned.steps[0].id,'open-browser');planRevision=planned.revision;
        return jsonResponse(functionCall('relay_browser',{action:'open',url:'https://example.test/fixture'},'open'));
      }
      if(requests.length===4){
        const opened=toolResult(request,'open');
        assert.ok(opened.tabId);assert.notEqual(opened.tabId,personalTab.tabId);
        assert.equal(opened.text,'The page shows the verified fixture value');openedTabId=opened.tabId;
        return jsonResponse(functionCall('relay_task',{action:'step',expectedRevision:planRevision,stepId:'open-browser',status:'done',evidence:`Browser open returned task-owned tab ${openedTabId} and the expected fixture page text.`},'open-done'));
      }
      if(requests.length===5){
        const state=toolResult(request,'open-done');assert.equal(state.steps[0].status,'done');
        return jsonResponse(functionCall('relay_task',{action:'edit',expectedRevision:state.revision,operations:[{type:'update',stepId:'verify-browser',patch:{status:'active',operation:{kind:'tool',tool:'relay_browser',action:'screenshot',target:openedTabId}}}]},'image-plan'));
      }
      if(requests.length===6){
        const state=toolResult(request,'image-plan');planRevision=state.revision;assert.equal(state.steps[1].status,'active');
        return jsonResponse(functionCall('relay_browser',{action:'screenshot',tabId:openedTabId},'image'));
      }
      if(requests.length===7){
        const image=toolResult(request,'image');assert.equal(image.tabId,openedTabId);
        assert.match(JSON.stringify(request.input),/UElYRUxT/,'the actual screenshot reaches the provider before it reports completion');
        return jsonResponse(functionCall('relay_task',{action:'step',expectedRevision:planRevision,stepId:'verify-browser',status:'done',evidence:`Browser screenshot returned an actual image from task-owned tab ${openedTabId}.`},'image-done'));
      }
      assert.equal(requests.length,8);assert.ok(toolResult(request,'image-done').steps.every(step=>step.status==='done'));
      return jsonResponse(answer('Verified the browser workspace result'));
    }}).init();await runtime.saveProvider({id:'cloud',type:'openai',models:['tool-fixture'],apiKey:'fixture-browser-private-key'});return runtime;
  }});
  const start=await api('/api/runs',{method:'POST',body:{workflow:graph('cloud::tool-fixture'),input:'Open and verify the fixture page'}});
  assert.equal(start.status,201);const run=await settled(start.data.id);assert.equal(run.status,'completed',run.error);
  assert.deepEqual(driver.calls.map(call=>call.args.action),['open','screenshot']);assert.equal(driver.calls[0].args.url,'https://example.test/fixture');
  for(const {args,options} of driver.calls){assert.equal(args.owner,undefined);assert.equal(options.owner.taskId,run.taskId||run.id);assert.equal(options.owner.runId,run.id);assert.equal(options.owner.nodeId,'agent');}
  assert.deepEqual(driver.status().tabs.find(tab=>tab.tabId===personalTab.tabId),personalTab);assert.equal(driver.status().activeTab,personalTab.tabId);
  assert.ok(requests[0].tools.some(tool=>tool.name==='relay_browser'));
  assert.ok(requests[0].input.some(item=>String(item.content).includes('BROWSER WORKSPACE')));
  assert.equal(requests.length,8);assert.equal(run.nodes.agent.planning.status,'recorded');assert.equal(run.taskState.plan.authoredBy.runId,run.id);
  const wire=JSON.stringify(requests[6].input);assert.match(wire,/The page shows the verified fixture value/);assert.match(wire,/UElYRUxT/,'pixels reach the selected provider as an actual tool result');
  assert.ok(!JSON.stringify(run.events).includes('UElYRUxT'),'trace does not retain screenshot payloads');assert.ok(run.events.some(event=>event.data.type==='browser.action'));
  assert.match(run.output,/Verified the browser workspace result/);
});

test('capacity one waits for the cancelled browser driver before allowing another execution',async t=>{
  const released=deferred();let driverSignal;
  const driver=new FakeBrowserDriver((args,{signal})=>{if(args.action!=='snapshot')return{};driverSignal=signal;return released.promise;});
  const {app,api,browser,settled}=await application(t,{driver,maxConcurrentRuns:1,runtimeFactory:async()=>new FakeCodex(true,async options=>{
    await recordFixturePlan(options);
    options.onEvent({type:'turn',threadId:'working-thread',turnId:'working-turn'});
    const opened=await options.onToolCall({name:'relay_browser',arguments:{action:'open',url:'https://example.test/cancellation'}});assert.equal(opened.success,true,JSON.stringify(opened));
    await options.onToolCall({name:'relay_browser',arguments:{action:'snapshot',tabId:JSON.parse(opened.contentItems[0].text).tabId}});
    return{output:'Must be discarded',threadId:'working-thread'};
  })});
  const start=await api('/api/runs',{method:'POST',body:{workflow:graph(),input:'Await the browser action'}});assert.equal(start.status,201);
  try{
    await waitFor(()=>driverSignal,'contained browser driver entry');
    assert.deepEqual(driver.calls.map(call=>call.args.action),['open','snapshot']);assert.notEqual(driver.calls[1].args.tabId,'fixture-tab');
    assert.equal(driver.calls[1].options.owner.runId,start.data.id);assert.equal(driver.calls[1].options.owner.nodeId,'agent');
    assert.equal((await api(`/api/runs/${start.data.id}/cancel`,{method:'POST',body:{}})).status,200);assert.equal(driverSignal.aborted,true);
    assert.equal(browser.status().recovery.required,true);assert.deepEqual(driver.released,[],'task cleanup must wait for the physical browser action');
    assert.equal((await api('/api/runs',{method:'POST',body:{workflow:graph(),input:'Must wait for previous driver'}})).status,409);
    assert.equal(app.engine.getRun(start.data.id).settled,false);
  }finally{released.resolve({text:'Late driver result'});}
  const run=await settled(start.data.id);assert.equal(run.status,'cancelled');assert.equal(run.output,'');assert.equal(run.nodes.agent.status,'cancelled');
  assert.deepEqual(driver.released,[{taskId:run.taskId||run.id,runId:run.id,nodeId:'agent'}]);assert.equal(browser.status().recovery,undefined);
});

test('per-turn tool cancellation reaches the browser even while the outer workflow signal remains live',{timeout:30000},async t=>{
  const toolController=new AbortController(),driverEntered=deferred();let driverSignal,outerSignal;
  const driver=new FakeBrowserDriver((args,{signal})=>{if(args.action!=='snapshot')return{};driverSignal=signal;return new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>reject(Object.assign(new Error('Fixture turn aborted'),{name:'AbortError'})),{once:true});driverEntered.resolve();});});
  const {api,settled}=await application(t,{driver,runtimeFactory:async()=>new FakeCodex(true,async options=>{
    await recordFixturePlan(options);
    outerSignal=options.signal;
    const opened=await options.onToolCall({name:'relay_browser',arguments:{action:'open',url:'https://example.test/turn-cancellation'}});assert.equal(opened.success,true,JSON.stringify(opened));
    await options.onToolCall({name:'relay_browser',arguments:{action:'snapshot',tabId:JSON.parse(opened.contentItems[0].text).tabId}},{signal:toolController.signal});
    return{output:'Unexpected completion',threadId:'fixture-thread'};
  })});
  const start=await api('/api/runs',{method:'POST',body:{workflow:graph(),input:'Exercise runtime timeout boundary'}});assert.equal(start.status,201);await driverEntered.promise;
  assert.deepEqual(driver.calls.map(call=>call.args.action),['open','snapshot']);assert.notEqual(driver.calls[1].args.tabId,'fixture-tab');assert.equal(driver.calls[1].options.owner.runId,start.data.id);
  assert.equal(outerSignal.aborted,false);toolController.abort();
  await waitFor(()=>driverSignal.aborted,'per-turn driver cancellation');
  const run=await settled(start.data.id);assert.equal(run.status,'failed');assert.match(run.error,/cancelled|aborted/i);
});

test('provider and browser HTTP routes require local authentication and report bounded actionable errors without exposing keys',async t=>{
  const secret='fixture-api-private-key-value',requests=[];
  const {api,request,driver,dataDir}=await application(t,{runtimeFactory:async({dataDir})=>{
    const runtime=await new ProviderRuntime({codex:new FakeCodex(true),dataDir,fetchImpl:async(url,options)=>{requests.push({url,options});return url.includes('/models')?jsonResponse({data:[{id:'discovered-fixture'}]}):jsonResponse(answer('Fixture'));}}).init();return runtime;
  }});
  for(const [route,method,body] of [['/api/providers','GET'],['/api/providers','POST',{}],['/api/providers/cloud','DELETE',{}],['/api/providers/cloud/test','POST',{}],['/api/providers/cloud/models','POST',{}],['/api/browser/status','GET'],['/api/browser/action','POST',{action:'tabs'}],['/api/browser/show','POST',{tabId:'fixture-tab'}]])assert.equal((await request(route,{method,body})).status,401,route);
  const saved=await api('/api/providers',{method:'POST',body:{id:'cloud',type:'openai',name:'Fixture cloud',apiKey:secret,models:['fixture-model']}});
  assert.equal(saved.status,200);assert.equal(saved.data.hasApiKey,true);assert.equal(saved.data.secretStorage,'session');assert.ok(!saved.text.includes(secret));
  assert.ok(!(await readFile(path.join(dataDir,'providers.json'),'utf8')).includes(secret));
  assert.equal((await api('/api/providers')).data.length,1);assert.equal((await api('/api/providers/cloud/models',{method:'POST',body:{}})).data.models[0].id,'discovered-fixture');assert.equal((await api('/api/providers/cloud/test',{method:'POST',body:{}})).data.ok,true);
  assert.equal(requests.length,2);assert.equal(requests[0].options.headers.Authorization,`Bearer ${secret}`);
  assert.equal((await api('/api/providers/missing/test',{method:'POST',body:{}})).status,404);
  assert.equal((await api('/api/providers',{method:'POST',body:{id:'codex',type:'openai'}})).status,400);
  assert.equal((await api('/api/providers',{method:'POST',body:{id:'bad',type:'compatible',baseUrl:'javascript:alert(1)'}})).status,400);
  assert.equal((await api('/api/browser/action',{method:'POST',body:{action:'open',url:'http://['}})).status,400);
  assert.equal(driver.calls.length,0,'invalid browser URL never reaches Chromium');
  assert.equal((await api('/api/browser/action',{method:'POST',body:{action:'open',url:'javascript:alert(1)'}})).status,200);
  assert.equal(driver.calls.at(-1).args.url,'javascript:alert(1)','Explicit browser schemes reach the driver unchanged.');
  assert.equal((await api('/api/browser/action',{method:'POST',body:{action:'open',url:'file:///C:/Documents/local.html'}})).status,200);
  assert.equal(driver.calls.at(-1).args.url,'file:///C:/Documents/local.html','The native browser receives the explicit local page URL.');
  assert.equal((await api('/api/browser/action',{method:'POST',body:{action:'tabs'}})).status,200);assert.equal((await api('/api/browser/show',{method:'POST',body:{tabId:'fixture-tab'}})).data.visible,true);assert.deepEqual(driver.shown,['fixture-tab']);
  assert.equal((await api('/api/browser/show',{method:'POST',body:{tabId:'missing'}})).status,404);
  assert.ok(!(await api('/api/status')).text.includes(secret));
  assert.equal((await api('/api/providers/cloud',{method:'DELETE',body:{}})).status,200);assert.equal((await api('/api/providers')).data.length,0);
});

test('shutdown cancels user browser work, drains admitted provider persistence and rejects new capability mutations',async t=>{
  const arrived=deferred(),persistEntered=deferred(),releasePersist=deferred();let browserSignal;
  const driver=new FakeBrowserDriver((_args,{signal})=>{browserSignal=signal;arrived.resolve();return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Object.assign(new Error('Fixture browser closed'),{name:'AbortError'})),{once:true}));});
  const {app,api,runtime}=await application(t,{driver,runtimeFactory:async({dataDir})=>new ProviderRuntime({codex:new FakeCodex(true),dataDir,fetchImpl:async()=>jsonResponse({data:[]})}).init()});
  const persist=runtime.store.persist.bind(runtime.store);
  runtime.store.persist=function(){const result=persist();this.writes=this.writes.then(async()=>{persistEntered.resolve();await releasePersist.promise;});return this.writes;};
  const browsing=api('/api/browser/action',{method:'POST',body:{action:'snapshot',tabId:'fixture-tab'}});await arrived.promise;
  const saving=api('/api/providers',{method:'POST',body:{id:'closing',type:'compatible',models:['fixture']}});await persistEntered.promise;
  let finished=false;const closing=app.close().then(()=>{finished=true;});
  try{
    await waitFor(()=>browserSignal.aborted,'browser shutdown cancellation');
    assert.equal((await api('/api/providers',{method:'POST',body:{id:'late',type:'compatible'}})).status,503);
    assert.equal((await api('/api/browser/action',{method:'POST',body:{action:'tabs'}})).status,503);
    assert.equal(finished,false,'provider snapshot keeps shutdown open until its acknowledged save is durable');
  }finally{releasePersist.resolve();}
  assert.equal((await saving).status,200);assert.equal((await browsing).status,400);await closing;assert.equal(driver.closed,true);
});

test('shutdown waits for an admitted encrypted provider save before its disk write has even been queued',async t=>{
  const entered=deferred(),release=deferred(),secret='fixture-vault-secret-not-on-disk';
  const {app,api,dataDir}=await application(t,{runtimeFactory:async({dataDir})=>new ProviderRuntime({codex:new FakeCodex(true),dataDir,fetchImpl:async()=>jsonResponse({data:[]}),encryptSecret:async value=>{entered.resolve();await release.promise;return Buffer.from(`sealed:${Buffer.from(value).toString('base64')}`);},decryptSecret:value=>Buffer.from(String(value).slice(7),'base64').toString()}).init()});
  const saving=api('/api/providers',{method:'POST',body:{id:'encrypted',type:'openai',models:['fixture'],apiKey:secret}});await entered.promise;
  let finished=false;const closing=app.close().then(()=>{finished=true;});
  try{await tick();assert.equal(finished,false,'the admitted save owns a shutdown lifetime before encryption completes');assert.equal((await api('/api/providers',{method:'POST',body:{id:'late',type:'compatible'}})).status,503);}finally{release.resolve();}
  const saved=await saving;assert.equal(saved.status,200);assert.equal(saved.data.secretStorage,'encrypted');await closing;
  const disk=await readFile(path.join(dataDir,'providers.json'),'utf8');assert.ok(!disk.includes(secret));assert.equal(JSON.parse(disk).providers[0].id,'encrypted');
});

test('shutdown aborts provider connection checks and model discovery instead of leaving background network work alive',async t=>{
  const arrived=deferred(),signals=[];
  const {app,api,runtime}=await application(t,{runtimeFactory:async({dataDir})=>{
    const runtime=await new ProviderRuntime({codex:new FakeCodex(true),dataDir,fetchImpl:async(_url,{signal})=>{
      signals.push(signal);if(signals.length===2)arrived.resolve();return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Object.assign(new Error('Fixture discovery cancelled'),{name:'AbortError'})),{once:true}));
    }}).init();await runtime.saveProvider({id:'checking',type:'compatible',models:['fixture']});return runtime;
  }});
  const checking=api('/api/providers/checking/test',{method:'POST',body:{}}),discovering=api('/api/providers/checking/models',{method:'POST',body:{}});await arrived.promise;
  assert.equal(runtime.discoveryControllers.size,2);await app.close();
  assert.ok(signals.every(signal=>signal.aborted),'every in-flight provider check receives cancellation');
  const responses=await Promise.all([checking,discovering]);for(const response of responses){assert.equal(response.status,400);assert.match(response.data.error,/cancelled/i);}
  assert.equal(runtime.discoveryControllers.size,0);await assert.rejects(runtime.discoverModels('checking'),{code:'PROVIDER_CLOSED'});
});

test('browser cancellation failure does not skip provider, engine or listener shutdown',async t=>{
  const failure=new Error('Fixture browser cancellation failed');let browserClosed=false;
  class BrokenBrowser extends EventEmitter{status(){return{available:false};}cancel(){throw failure;}async close(){browserClosed=true;}}
  const {app,runtime}=await application(t,{browser:new BrokenBrowser()});
  const close=app.close.bind(app);app.close=()=>close().catch(error=>{if(error!==failure)throw error;});
  await assert.rejects(close(),error=>error===failure);assert.equal(browserClosed,true);assert.equal(runtime.closed,true);assert.equal(app.engine.closed,true);assert.equal(app.server.listening,false);
  await assert.rejects(close(),error=>error===failure);
});
