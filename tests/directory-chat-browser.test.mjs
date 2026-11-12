import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter,once} from 'node:events';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';
import {createHarnessServer} from '../server.mjs';
import {PLANNING_ONTOLOGY_MODULES} from '../public/planning-module-policy.mjs';

const phaseOf=o=>o.prompt.includes('SHADOWDANCER DIRECTORY MODE.')?JSON.parse(o.prompt.split('CURRENT_DIRECTORY:\n').at(-1).split('\nREPOSITORY ')[0]):null;
class SyntheticRuntime extends EventEmitter {
  calls=[];store={get:()=>({baseUrl:'https://api.example.invalid/v1'})};
  status(){return{connected:true,authenticated:true,defaultModel:'fixture::remote',defaultModelSelection:'fixture::remote',defaultModelAvailable:true,models:[{id:'fixture::remote',model:'fixture::remote',displayName:'Isolated fixture',available:true,supportsTools:true}],activeTurns:0};}
  async init(){} async start(){return this.status();} async close(){}
  async runAgent(o){
    const phase=phaseOf(o);this.calls.push({phase:phase?.label||'ordinary',delegate:o.dynamicTools?.some(t=>t.name==='relay_delegate')||false,hostOnly:o.hostOnlyTools===true,thread:o.threadId||null});
    assert.ok(this.calls.length<35,'Bounded synthetic turns only');
    const output=phase?JSON.stringify(phase.label==='context-page'?{summary:'Synthetic prior evidence only.',refs:[]}:phase.label==='decompose'?{atomic:true}:phase.label==='integration'?{answer:'DIRECTORY_RENDERED_RESULT',used_refs:phase.payload.required_refs}:{status:'complete',nextAction:'',finding:'Synthetic evidence only.',candidate_answer:'A bounded answer.',uncertainty:''}):'ORDINARY_RENDERED_RESULT';
    o.onEvent?.({type:'thread',threadId:'fixture-'+this.calls.length,turnId:'turn-'+this.calls.length,model:'fixture::remote'});
    o.onEvent?.({type:'message',itemId:'result-'+this.calls.length,text:output,phase:'final_answer'});
    return{output,threadId:'fixture-'+this.calls.length};
  }
}
function disabledControllers(){
  const desktop=new EventEmitter();desktop.status=()=>({available:false,enabled:false,busy:false});desktop.setEnabled=async()=>desktop.status();
  const browser=new EventEmitter();browser.status=()=>({available:false,contained:true,acceptingActions:false,tabs:[],activeTabId:null,browsers:{relay:{available:false,tabs:[]}}});browser.cancel=async()=>{};browser.close=async()=>{};
  const applicationWorkspace=new EventEmitter();applicationWorkspace.status=()=>({available:false,sessions:[],documents:[],supportedApps:[],documentStorage:{healthy:true}});applicationWorkspace.close=async()=>{};
  return{desktop,browser,applicationWorkspace};
}
test('rendered Chat Directory controls reach the real engine and persist independently', {skip:process.env.BLACKICE_DIRECTORY_BROWSER_QA!=='yes',timeout:100000},async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'blackice-directory-rendered-'));
  const out=path.resolve(process.env.BLACKICE_DIRECTORY_BROWSER_OUT||'.build/directory-chat-browser');
  const cwd=path.join(root,'workspace'),dataDir=path.join(root,'data'),profile=path.join(root,'edge');
  await Promise.all([mkdir(cwd),mkdir(profile),mkdir(out,{recursive:true})]);
  const runtime=new SyntheticRuntime(),report={scope:'Real /next/ UI and real server/engine; deterministic local provider, no real provider or user profile',startedAt:new Date().toISOString(),checks:[],screenshots:[],requests:[],runtimeCalls:runtime.calls,rendererErrors:[],externalPageRequests:[],sourceHashes:{}};
  for(const file of ['server.mjs','lib/engine.mjs','public/next/chat/chat.mjs','public/next/chat/render.mjs','public/next/chat/send.mjs','public/next/chat/execution-preferences.mjs'])report.sourceHashes[file]=createHash('sha256').update(await readFile(new URL('../'+file,import.meta.url))).digest('hex');
  let app,child,ws,next=0,origin,port;const pending=new Map();
  const until=async(fn,label,limit=14000)=>{const end=Date.now()+limit;let last;while(Date.now()<end){try{const v=await fn();if(v)return v;}catch(e){last=e;}await sleep(75);}throw Error(label+' timed out: '+(last?.message||''));};
  const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++next,timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout '+method));},12000);pending.set(id,{resolve:v=>{clearTimeout(timer);resolve(v);},reject:e=>{clearTimeout(timer);reject(e);}});ws.send(JSON.stringify({id,method,params}));});
  const evaluate=async expression=>{const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result?.value;};
  const click=async selector=>{const box=await evaluate('(()=>{const el=document.querySelector('+JSON.stringify(selector)+');if(!el||el.disabled)return null;el.scrollIntoView({block:"center"});const r=el.getBoundingClientRect();return r.width&&r.height?{x:r.x+r.width/2,y:r.y+r.height/2}:null})()');assert.ok(box,'Clickable '+selector);await send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...box});await send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...box});};
  const choose=async(selector,value)=>{
    // Native keyboard change on the real, focused select. No module state injection.
    await evaluate('document.querySelector('+JSON.stringify(selector)+').focus();true');
    const target=await evaluate('[...document.querySelector('+JSON.stringify(selector)+').options].findIndex(o=>o.value==='+JSON.stringify(value)+')');assert.ok(target>=0);
    const key=async(key,code,v)=>{await send('Input.dispatchKeyEvent',{type:'keyDown',key,code,windowsVirtualKeyCode:v});await send('Input.dispatchKeyEvent',{type:'keyUp',key,code,windowsVirtualKeyCode:v});};
    await key('Home','Home',36);for(let i=0;i<target;i++)await key('ArrowDown','ArrowDown',40);await key('Tab','Tab',9);
    await until(()=>evaluate('document.querySelector('+JSON.stringify(selector)+').value==='+JSON.stringify(value)),selector+' = '+value);
  };
  const modes=()=>evaluate('({directoryMode:document.querySelector("#next-chat-directory-mode").value,subagentControlPresent:Boolean(document.querySelector("#next-chat-subagents-mode"))})');
  const boot=()=>until(()=>evaluate('Boolean(document.querySelector("#next-chat-directory-mode")&&!document.querySelector("#next-chat-directory-mode").disabled&&document.querySelector("#next-chat-model").options.length>1)'),'Chat composer');
  const screenshot=async name=>{const result=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});const file=path.join(out,name+'.png');await writeFile(file,Buffer.from(result.data,'base64'));report.screenshots.push(file);};
  const checkpoint=(name,evidence={})=>report.checks.push({name,...evidence});
  const startServer=async()=>{
    app=await createHarnessServer({runtime,port:port||0,dataDir,defaultCwd:cwd,remoteAccess:false,taskViability:false,responseCycle:false,autoAttachDesktop:false,...disabledControllers()});
    origin=await app.listen();port=Number(new URL(origin).port);origin=new URL(origin).origin;
  };
  const submit=async(task,expectedModes,expectedPhases)=>{
    await until(()=>evaluate('!document.querySelector("#next-chat-send").disabled'),'Send ready');
    const before=new Set(app.engine.listRuns().map(r=>r.id)),callStart=runtime.calls.length,requestStart=report.requests.length;
    await click('#next-chat-input');await send('Input.insertText',{text:task});await click('#next-chat-send');
    const run=await until(()=>app.engine.listRuns().find(r=>!before.has(r.id)),'UI admitted run');
    await until(()=>app.engine.getRun(run.id).settled,'Real execution settled');
    const saved=app.engine.getRun(run.id);assert.equal(saved.status,'completed',saved.error||JSON.stringify(saved.nodes));assert.deepEqual(saved.executionModes,expectedModes);
    const calls=runtime.calls.slice(callStart);assert.deepEqual(calls.map(c=>c.phase).filter(phase=>phase!=='context-page'),expectedPhases);assert.ok(calls.length<=expectedPhases.length+6,'Context pages stay bounded');assert.equal(Boolean(saved.nodes.agent.shadowdancer),expectedPhases.includes('work'));assert.equal(saved.nodes.agent.output,expectedPhases.includes('work')?'DIRECTORY_RENDERED_RESULT':'ORDINARY_RENDERED_RESULT');
    const active=calls.find(c=>c.phase==='work'||c.phase==='ordinary');assert.equal(active.delegate,expectedModes.subagentsMode!=='off');
    const request=report.requests.slice(requestStart).find(r=>r.path==='/api/runs'||r.path.endsWith('/continue'));assert.ok(request,'Actual UI HTTP run payload');
    assert.deepEqual({directoryMode:(request.body.input||request.body).directoryMode,subagentsMode:(request.body.input||request.body).subagentsMode},expectedModes);
    await until(()=>evaluate('document.querySelector('+JSON.stringify('[data-run-id="'+run.id+'"] .next-status-pill')+')?.textContent==="Response saved"&&!document.querySelector("#next-chat-send").disabled'),'Rendered saved turn');
    checkpoint(task,{runId:run.id,executionModes:saved.executionModes,phases:calls.map(c=>c.phase),delegate:active.delegate,payload:request.body.input||request.body});
    return saved;
  };
  const openChat=async id=>{await until(()=>evaluate('Boolean(document.querySelector('+JSON.stringify('.next-conversation[data-conversation="'+id+'"]')+'))'),'Saved chat selector');await click('.next-conversation[data-conversation="'+id+'"]');await boot();await until(()=>evaluate('document.querySelector(".next-conversation[aria-current=true]")?.dataset.conversation==='+JSON.stringify(id)),'Selected conversation');};
  try{
    await startServer();
    const browser=process.env.BLACKICE_NEXT_BROWSER_PATH||'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
    child=spawn(browser,['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--disable-extensions','--disable-background-networking','--disable-sync','--remote-allow-origins=*','--remote-debugging-port=0','--user-data-dir='+profile,'--window-size=1440,1000','about:blank'],{windowsHide:true,stdio:['ignore','ignore','pipe']});
    let stderr='';child.stderr.on('data',b=>stderr=(stderr+String(b)).slice(-12000));child.on('error',e=>report.browserError=e.message);
    const debug=await until(async()=>Number((await readFile(path.join(profile,'DevToolsActivePort'),'utf8')).split(/\r?\n/)[0]),'Isolated Edge debugger');
    const target=await until(async()=>(await(await fetch('http://127.0.0.1:'+debug+'/json/list')).json()).find(t=>t.type==='page'),'Disposable browser page');
    ws=new WebSocket(target.webSocketDebuggerUrl);await once(ws,'open');
    ws.addEventListener('message',event=>{const p=JSON.parse(event.data);if(p.id&&pending.has(p.id)){const j=pending.get(p.id);pending.delete(p.id);p.error?j.reject(Error(p.error.message)):j.resolve(p.result);}
      if(p.method==='Runtime.exceptionThrown')report.rendererErrors.push(p.params.exceptionDetails?.exception?.description||p.params.exceptionDetails?.text);
      if(p.method==='Network.requestWillBeSent'){const r=p.params.request;if(/^https?:/.test(r.url)&&new URL(r.url).origin!==origin)report.externalPageRequests.push(r.url);if(r.method==='POST'&&r.postData){let body;try{body=JSON.parse(r.postData);}catch{}if(body)report.requests.push({path:new URL(r.url).pathname,body});}}});
    await send('Runtime.enable');await send('Network.enable');await send('Page.enable');
    await send('Page.navigate',{url:origin+'/next/'});await boot();
    const geometry=await evaluate('["#next-chat-directory-mode"].map(s=>{const e=document.querySelector(s),r=e.getBoundingClientRect();return{selector:s,options:[...e.options].map(o=>({value:o.value,text:o.textContent})),label:e.closest("label").textContent,title:e.title,visible:r.width>0&&r.height>0&&r.x>=0&&r.right<=innerWidth&&r.y>=0&&r.bottom<=innerHeight,hit:e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))}})');
    assert.ok(geometry.every(g=>g.visible&&g.hit));assert.deepEqual(geometry[0].options.map(o=>o.value),['on','off']);assert.deepEqual(await modes(),{directoryMode:'on',subagentControlPresent:false});checkpoint('Visible Directory On/Off control with default delegation and no subagent selector',{geometry});await screenshot('01-default-on');
    const allOn=Object.fromEntries(PLANNING_ONTOLOGY_MODULES.map(({id})=>[id,true]));
    await click('#next-chat-ontology-inline summary');
    assert.equal(await evaluate('document.querySelectorAll("#next-chat-ontology-modules input[type=checkbox]").length'),16);
    for(const {id,label} of PLANNING_ONTOLOGY_MODULES.filter(module=>module.id!=='subagents')){
      const option=choice=>'#next-chat-ontology-modules input[aria-label='+JSON.stringify(label+' '+choice)+']';
      assert.equal(await evaluate('document.querySelector('+JSON.stringify(option('on'))+').checked'),true);
      await click(option('off'));
      const saved=()=>evaluate('JSON.parse(localStorage.getItem("blackice.next.chatOntology.new")).planningOntology');
      await until(async()=>((await saved()).modules[id]===false),'Saved module Off: '+id);
      assert.deepEqual(await saved(),{version:2,modules:{...allOn,[id]:false}});
      await click(option('on'));await until(async()=>((await saved()).modules[id]===true),'Saved module On: '+id);
      assert.deepEqual(await saved(),{version:2,modules:allOn});
    }
    await click('#next-chat-ontology-inline summary');checkpoint('All eight configurable module On/Off controls persist independently without changing other modules');
    await choose('#next-chat-plan','off');await choose('#next-chat-directory-mode','on');
    const a=await submit('Synthetic A Directory On',{directoryMode:'on',subagentsMode:'default'},['decompose','work','integration']);await screenshot('02-directory-on');
    const frozen=JSON.stringify(app.engine.getRun(a.id));
    await choose('#next-chat-directory-mode','off');
    const off=await submit('Synthetic A Directory Off',{directoryMode:'off',subagentsMode:'default'},['ordinary']);assert.equal(JSON.stringify(app.engine.getRun(a.id)),frozen);await screenshot('03-directory-off');
    await choose('#next-chat-directory-mode','on');
    const latestOn=await submit('Synthetic A Directory On again',{directoryMode:'on',subagentsMode:'default'},['decompose','work','integration']);assert.equal(JSON.stringify(app.engine.getRun(a.id)),frozen);await screenshot('04-on-again');
    await choose('#next-chat-directory-mode','on');
    await click('#next-chat-input');await send('Input.insertText',{text:'Unsent A draft retained'});
    await click('#next-chat-new');await boot();assert.deepEqual(await modes(),{directoryMode:'on',subagentControlPresent:false});
    await choose('#next-chat-plan','off');await choose('#next-chat-directory-mode','off');
    const b=await submit('Synthetic B independent ordinary',{directoryMode:'off',subagentsMode:'default'},['ordinary']);
    await openChat(a.taskId||a.id);assert.deepEqual(await modes(),{directoryMode:'on',subagentControlPresent:false});assert.equal(await evaluate('document.querySelector("#next-chat-input").value'),'Unsent A draft retained');
    await openChat(b.taskId||b.id);assert.deepEqual(await modes(),{directoryMode:'off',subagentControlPresent:false});
    await send('Page.reload');await boot();await openChat(a.taskId||a.id);assert.deepEqual(await modes(),{directoryMode:'on',subagentControlPresent:false});assert.equal(await evaluate('document.querySelector("#next-chat-input").value'),'Unsent A draft retained');checkpoint('Conversation isolation and unsent draft survive reload');await screenshot('05-reload-local-draft');
    // Remove only this fixture's mode preference to verify durable server fallback, not localStorage.
    await evaluate('localStorage.removeItem('+JSON.stringify('blackice.next.chatExecution.'+(a.taskId||a.id))+');true');
    await send('Page.navigate',{url:'about:blank'});await app.close();app=null;
    const beforeRestart=runtime.calls.length;await startServer();assert.equal(runtime.calls.length,beforeRestart,'No model replay on restart');
    assert.deepEqual(app.engine.getRun(latestOn.id).executionModes,{directoryMode:'on',subagentsMode:'default'});
    assert.deepEqual(app.engine.getRun(b.id).executionModes,{directoryMode:'off',subagentsMode:'default'});
    await send('Page.navigate',{url:origin+'/next/'});await boot();await openChat(a.taskId||a.id);
    assert.deepEqual(await modes(),{directoryMode:'on',subagentControlPresent:false});checkpoint('Backend restart restores admitted server modes without browser preference or replay');await screenshot('06-backend-restart-fallback');
    await evaluate('document.querySelector("#next-chat-input").value="";document.querySelector("#next-chat-input").dispatchEvent(new Event("input",{bubbles:true}));true');
    await choose('#next-chat-plan','off');await choose('#next-chat-directory-mode','on');
    await submit('Synthetic A On after restart',{directoryMode:'on',subagentsMode:'default'},['decompose','work','integration']);
    assert.deepEqual(report.rendererErrors,[]);assert.deepEqual(report.externalPageRequests,[]);await screenshot('07-on-after-restart');
    report.ok=true;
  }catch(error){report.ok=false;report.error=error.stack;try{await screenshot('failure');report.dom=await evaluate('document.body.innerText');}catch{}throw error;}
  finally{
    report.finishedAt=new Date().toISOString();report.runtimeCallCount=runtime.calls.length;
    await writeFile(path.join(out,'receipt.json'),JSON.stringify(report,null,2));
    if(ws?.readyState===1){try{await send('Browser.close');}catch{}ws.close();}
    if(child&&child.exitCode===null){await Promise.race([once(child,'exit').catch(()=>{}),sleep(1500)]);if(child.exitCode===null)child.kill();}
    if(app)await app.close();
    // This root was generated above exclusively for this test.
    await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:250});
    console.log(JSON.stringify({ok:report.ok,out,checks:report.checks.length,runtimeCalls:report.runtimeCallCount,screenshots:report.screenshots}));
  }
});
