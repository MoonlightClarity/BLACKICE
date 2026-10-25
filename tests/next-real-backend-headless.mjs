/** Real BLACKICE local server + real headless Chromium, disposable profile.
 * No production data, model calls, foreground windows, or installation changes.
 */
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {createHarnessServer} from '../server.mjs';
import {recordFixturePlan} from './fixture-task-plan.mjs';

class FakeRuntime extends EventEmitter {
  status(){return {connected:true,authenticated:true,defaultModel:'fixture-model',activeTurns:0};}
  async start(){return this.status();}
  async runAgent(options){
    await recordFixturePlan(options);
    options.onEvent?.({type:'delta',delta:'Real local harness response'});
    return {output:'Real local harness response',threadId:'real-test-thread'};
  }
  async close(){}
}
const directory=await mkdtemp(path.join(tmpdir(),'blackice-next-real-e2e-'));
let app,processHandle,ws;
const errors=[],requests=[],responseErrors=[],jobs=new Map();let serial=0;
const until=async(fn,label,ms=18000)=>{
  const expire=Date.now()+ms;let failure;
  while(Date.now()<expire){
    try {const value=await fn();if(value)return value;} catch(error){failure=error;}
    await sleep(130);
  }
  throw Error(label+' timed out. '+(failure?.message||''));
};
async function command(method,params={}){
  const id=++serial;
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{jobs.delete(id);reject(Error('DevTools timed out: '+method));},14000);
    jobs.set(id,{resolve:value=>{clearTimeout(timer);resolve(value);},
      reject:error=>{clearTimeout(timer);reject(error);}});
    ws.send(JSON.stringify({id,method,params}));
  });
}
async function evaluate(expression){
  const result=await command('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
  if(result.exceptionDetails)throw Error(result.exceptionDetails.text||'Renderer error');
  return result.result?.value;
}
try {
  const cwd=path.join(directory,'workspace');await mkdir(cwd);
  app=await createHarnessServer({runtime:new FakeRuntime(),port:0,
    dataDir:path.join(directory,'data'),defaultCwd:cwd});
  const origin=await app.listen();
  app.server.on('request',req=>requests.push(req.method+' '+new URL(req.url,origin).pathname));
  const profile=path.join(directory,'chromium');await mkdir(profile);
  const chrome='C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  processHandle=spawn(chrome,[
    '--headless=new','--disable-gpu','--disable-extensions','--disable-sync',
    '--disable-background-networking','--no-default-browser-check','--no-first-run',
    '--remote-allow-origins=*','--remote-debugging-port=0',
    '--user-data-dir='+profile,'--window-size=1250,840',origin+'/next/',
  ],{stdio:['ignore','pipe','pipe'],windowsHide:true});
  const remote=await until(async()=>{
    const text=await readFile(path.join(profile,'DevToolsActivePort'),'utf8');
    return Number(text.trim().split(/\r?\n/)[0])||null;
  },'Browser startup');
  const page=await until(async()=>{
    const tabs=await(await fetch('http://127.0.0.1:'+remote+'/json/list')).json();
    return tabs.find(tab=>tab.type==='page'&&tab.url.endsWith('/next/'));
  },'Browser target');
  await new Promise((resolve,reject)=>{
    ws=new WebSocket(page.webSocketDebuggerUrl);
    ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});
    ws.addEventListener('message',event=>{
      const packet=JSON.parse(event.data);
      if(packet.id&&jobs.has(packet.id)){
        const entry=jobs.get(packet.id);jobs.delete(packet.id);
        packet.error?entry.reject(Error(packet.error.message)):entry.resolve(packet.result);
      }
      if(packet.method==='Runtime.exceptionThrown')errors.push(packet.params.exceptionDetails?.exception?.description||packet.params.exceptionDetails?.text||'Frontend exception');
      if(packet.method==='Network.responseReceived'&&packet.params.response.status>=400)responseErrors.push({path:new URL(packet.params.response.url).pathname,status:packet.params.response.status});
      if(packet.method==='Runtime.consoleAPICalled'&&packet.params.type==='error')
        errors.push(packet.params.args?.map(x=>x.value||x.description).join(' '));
    });
  });
  await command('Runtime.enable');await command('Page.enable');await command('Network.enable');
  const started=Date.now();
  await until(()=>evaluate('Boolean(document.querySelector("#next-chat-new") && document.querySelector("#next-chat-input"))'),'Live Chat shell');
  const renderMs=Date.now()-started;
  assert.equal(await evaluate('document.querySelector("#next-fatal").hidden'),true);
  assert.equal(await evaluate('document.querySelector("#next-stage > .next-loading")===null'),true);
  assert.equal(await evaluate('document.querySelector("#next-chat").dataset.reader'),'worker');
  assert.ok(!requests.some(r=>r==='GET /api/runs'),'Startup cannot bulk-fetch raw execution traces.');
  await evaluate('(()=>{const picker=document.querySelector("#next-chat-attachments .attachments-file-input");if(!picker)throw Error("Attachment picker unavailable");const files=new DataTransfer();files.items.add(new File(["Fixture file for the task"],"attached-note.txt",{type:"text/plain"}));picker.files=files.files;picker.dispatchEvent(new Event("change",{bubbles:true}));return true;})()');
  await until(()=>evaluate('Boolean(document.querySelector("#next-chat-attachments .attachment-chip"))'),'Actual backend attachment uploaded');
  await evaluate('document.querySelector("#next-chat-input").value="Exercise the real local engine";document.querySelector("#next-chat-input").dispatchEvent(new Event("input",{bubbles:true}));document.querySelector("#next-chat-form").requestSubmit();true');
  await until(()=>app.engine.listRuns().length===1,'Task admitted',16000);
  const receipt=await until(()=>app.engine.listRuns()[0]?.status==='completed'?app.engine.listRuns()[0]:null,'Task completed',18000);
  assert.match(receipt.output,/Real local harness response/);
  assert.equal(receipt.attachmentIds?.length,1,'Uploaded file ID must reach the real task record.');
  await until(()=>evaluate('Boolean(document.querySelector(".next-conversation") && document.querySelector(".next-message-body")?.textContent.includes("Exercise the real local engine"))'),'Saved chat rendered');
  await until(()=>evaluate('document.querySelector("#next-chat-timeline")?.textContent.includes("Real local harness response")'),'Completed answer rendered');
  const reloadMarker='before-reload-'+Date.now();
  await evaluate('globalThis.__realBackendReloadMarker='+JSON.stringify(reloadMarker));
  await command('Page.reload');
  // Page.reload acknowledges before navigation necessarily replaces the old
  // document. Its already-rendered answer must not satisfy this fresh-page wait.
  await until(()=>evaluate('globalThis.__realBackendReloadMarker!=='+JSON.stringify(reloadMarker)+' && document.readyState==="complete" && document.querySelector("#next-chat-timeline")?.textContent.includes("Real local harness response")'),'Saved conversation restored in the new renderer document');
  const savedPlan=await app.tasks.get(receipt.taskId||receipt.id);
  assert.ok(savedPlan.steps.length>0,'The fake agent must record a real durable plan through its attached task tool before testing map hydration.');
  const planIndex=await app.tasks.listPlans({taskIds:[savedPlan.taskId],limit:1});
  assert.equal(planIndex.plans.length,1);assert.equal(Object.hasOwn(planIndex.plans[0],'steps'),false,'The real catalog must remain metadata-only.');
  const planningAt=requests.length;
  await evaluate('document.querySelector("[data-space=planning]").click();true');
  try {
    await until(()=>evaluate('document.querySelectorAll("#next-planning-map [data-plan-map-node]").length>0'),'Real metadata-only catalog hydrated saved steps');
  } catch(error) {
    const stored=await app.tasks.get(receipt.taskId||receipt.id).catch(cause=>({error:cause.message}));
    console.error('Planning diagnostics:',JSON.stringify({requests:requests.slice(planningAt),responseErrors,saved:{taskId:stored.taskId,revision:stored.revision,steps:stored.steps?.map(step=>({id:step.id,status:step.status})),error:stored.error},surface:await evaluate('({workspace:document.querySelector("[data-workspace=planning]")?.textContent,selected:document.querySelector("[data-space=planning]")?.getAttribute("aria-selected"),fatal:document.querySelector("#next-fatal")?.textContent})')}));
    throw error;
  }
  const planNodes=await evaluate('[...document.querySelectorAll("#next-planning-map [data-plan-map-node]")].map(node=>node.getAttribute("data-plan-map-node"))');
  assert.deepEqual(planNodes,[...savedPlan.steps.map(step=>step.id)],'The map renders the actual saved IDs, not a fabricated outline.');
  const detailRequests=requests.slice(planningAt).filter(value=>/^GET \/api\/tasks\/[^/]+$/.test(value));
  assert.equal(detailRequests.length,1,'Opening Planning reads exactly the selected saved plan.');
  assert.equal(requests.some(value=>value==='GET /api/runs'),false);
  assert.equal(errors.length,0,errors.join(' | '));
  console.log('PASS real-server/headless frontend; rendererBootMs='+renderMs+' result='+receipt.status+
    ' browserRequests='+requests.length+' attachedFiles='+receipt.attachmentIds.length+' noBulkHistory=true profile=disposable');
} catch(error){console.error('FAIL:',error.stack||error);if(errors.length)console.error('Renderer errors:',errors);process.exitCode=1;}
finally{
  try{await command('Browser.close');}catch{}
  try{ws?.close();}catch{}
  try{processHandle?.kill();}catch{}
  try{await app?.close();}catch(error){console.error('Harness cleanup:',error.message);}
  await sleep(120);await rm(directory,{recursive:true,force:true,maxRetries:3,retryDelay:200}).catch(()=>{});
}
