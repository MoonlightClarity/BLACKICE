const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url'),{EventEmitter}=require('node:events');
const [root,out]=process.argv.slice(2);
fs.mkdirSync(out,{recursive:true});
app.setPath('userData',path.join(out,'profile'));
app.disableHardwareAcceleration();
let win,server,failed=false;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const run=script=>win.webContents.executeJavaScript(script,true);
const until=async(label,read)=>{
  for(let count=0;count<120;count++){const result=await read();if(result)return result;await sleep(50);}
  throw Error('Timed out: '+label);
};
const click=(label,selector='body')=>run(`[...document.querySelectorAll(${JSON.stringify(selector+' button')})].find(b=>!b.hidden&&b.textContent.trim()===${JSON.stringify(label)})?.click()`);
const dialog='dialog[aria-label="Action Directory"][open]';
const fill=(selector,value)=>run(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});el.value=${JSON.stringify(value)};el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));})()`);
const text=selector=>run(`document.querySelector(${JSON.stringify(selector)})?.textContent||''`);
const calls=[];
class Runtime extends EventEmitter {
 status(){return {connected:true,authenticated:true,defaultModel:'fixture-model',models:[{id:'fixture-model',model:'fixture-model',supportsTools:true}]};}
 async start(){}
 async close(){}
 async runAgent(options){
  calls.push({prep:options.responseOnly===true,tools:options.dynamicTools?.map(tool=>tool.name)||[]});
  if(options.responseOnly)return {output:JSON.stringify({status:'proposed',focus:'inspect',reason:'Test the openable outline',actions:[{id:'inspect',objective:'Review starter row',dependsOn:[]}]})};
  const use=async args=>{
   const call={name:'relay_directory_action',callId:'fixture-'+args.action,arguments:args};
   const result=await options.onToolCall(call);
   options.onToolResultDelivered?.({call,result});
   assert.equal(result.success,true,JSON.stringify(result));
   return JSON.parse(result.contentItems[0].text);
  };
  const state=await use({action:'read'});
  assert.equal(state.actions[0].id,'inspect');
  await use({action:'block',id:'inspect',claim:'Synthetic starter sighted'});
  options.onEvent?.({type:'message',text:'Offline fixture turn completed.'});
  return {output:'Offline fixture turn completed.'};
 }
}
(async()=>{
 await app.whenReady();
 const {createHarnessServer}=await import(pathToFileURL(path.join(root,'server.mjs')));
 server=await createHarnessServer({runtime:new Runtime(),dataDir:path.join(out,'data'),defaultCwd:out,port:0,remoteAccess:false});
 const base=await server.listen({waitForRemote:false});
 win=new BrowserWindow({show:false,width:1200,height:650,webPreferences:{offscreen:true,backgroundThrottling:false}});
 await win.loadURL(base+'/next');
 const ids=['#next-chat-directory-actions','#next-chat-planning-actions','#next-chat-directory-diagnostics'];
 await until('actual independent Chat selectors',()=>run(`[${ids.map(JSON.stringify).join(',')}].every(id=>!!document.querySelector(id))`));
 const values=()=>run(`[${ids.map(JSON.stringify).join(',')}].map(id=>document.querySelector(id).value)`);
 assert.deepEqual(await values(),['off','off','off']);
 await fill(ids[0],'on');await fill(ids[1],'on');await fill(ids[2],'maximal');
 assert.deepEqual(await values(),['on','on','maximal']);
 await fill('#next-chat-input','Fixture: editable action outline');
 await run('document.querySelector("#next-chat-send").click()');
 const done=await until('admitted synthetic turn',()=>[...server.engine.runs.values()].find(row=>row.settled));
 assert.equal(done.status,'completed',done.error);
 assert.equal(done.directoryActions,'on');assert.equal(done.chatPlanning,'on');assert.equal(done.directoryDiagnostics,'maximal');
 assert.equal(calls.length,2);assert.deepEqual(calls[0],{prep:true,tools:[]});
 assert.ok(calls[1].tools.includes('relay_directory_action'));
 assert.deepEqual(done.planningModuleReceipts.map(row=>row.phase),['started','completed']);
 await until('module receipt renders in actual Chat activity',async()=>String(await text('.next-chat-planning-modules')).includes('Task decomposition: Plan recorded'));
 await until('actual Action outline launch appears',()=>run('[...document.querySelectorAll("button")].some(b=>!b.hidden&&b.textContent==="Action outline")'));
 await click('Action outline');
 await until('Directory opening from real button',async()=>String(await text(dialog)).includes('Review starter row'));
 await fill(dialog+' input[aria-label="New action objective"]','App-authored independent follow-up');
 await click('Add action',dialog);
 await until('added action appears',async()=>String(await text(dialog)).includes('pending · App-authored independent follow-up'));
 const row=async()=>{
  const ledger=await server.engine.actionDirectories.get(done.taskId||done.id,done.input);
  return ledger.read().actions.find(action=>action.objective==='App-authored independent follow-up');
 };
 const added=await row();assert.equal(added.authority,'human');
 await fill(dialog+' input[aria-label="New action objective"]','Dependent fixture step');
 await fill(dialog+' input[aria-label="New action dependencies"]',added.id);
 await click('Add action',dialog);
 await until('dependent fixture step is saved',async()=>String(await text(dialog)).includes('Dependent fixture step'));
 const selected=dialog+' details';
 const rowClick=label=>run(`(()=>{const row=[...document.querySelectorAll(${JSON.stringify(selected)})].find(r=>r.querySelector('summary').textContent.includes('App-authored independent follow-up'));row.open=true;[...row.querySelectorAll('button')].find(b=>b.textContent===${JSON.stringify(label)}).click();})()`);
 await rowClick('Focus');
 await until('canonical focus persisted',async()=>(await row())?.state==='active');
 await fill(dialog+' input[aria-label="Reason to block '+added.id+'"]','User redirect from renderer');
 await rowClick('Block');
 await until('canonical block persisted',async()=>(await row())?.state==='blocked');
 assert.equal((await row()).observation.claim,'User redirect from renderer');
 await until('derived dependency blocker displayed',async()=>String(await text(dialog)).includes('blocked by '+added.id));
 assert(await run("[...document.querySelectorAll('dialog[open] details')].find(r=>r.querySelector('summary').textContent.includes('Dependent fixture step')).querySelector('button').disabled"));
 await click('Close',dialog);
 await click('Action outline');
 await run(`document.querySelector(${JSON.stringify(dialog)}).dispatchEvent(new Event('close'))`);
 await until('reopened outline shows persisted block',async()=>String(await text(dialog)).includes('blocked · App-authored independent follow-up'));
 for(const width of [1200,390]){
  win.setContentSize(width,650);await sleep(150);
  const dims=await run(`(()=>{const d=document.querySelector(${JSON.stringify(dialog)}).getBoundingClientRect();return {left:d.left,right:d.right,width:innerWidth};})()`);
  assert(dims.left>=0&&dims.right<=dims.width);
  fs.writeFileSync(path.join(out,'action-directory-'+width+'.png'),(await win.webContents.capturePage()).toPNG());
 }
 await click('Close',dialog);
 await click('Receipts');
 await until('receipts is the single header entry',()=>run('!!document.querySelector(".next-activity-inspector[open]") && ![...document.querySelectorAll(".next-chat-head-actions button")].some(b=>["Activity","Turn receipts"].includes(b.textContent.trim()))'));
 await click('Turn receipts','.next-activity-inspector[open]');
 await until('receipts open separately',()=>run('!!document.querySelector(\'dialog[aria-label="Turn receipts"][open]\')'));
 assert.equal(await run('!!document.querySelector(\'dialog[aria-label="Action Directory"][open]\')'),false);
 const diagnosticText=await text('dialog[aria-label="Turn receipts"][open]');
 assert.doesNotMatch(diagnosticText,/App-authored independent follow-up|User redirect from renderer/);
 await until('Maximal export controls are visible',()=>run('[...document.querySelectorAll(\'dialog[aria-label="Turn receipts"][open] button\')].some(b=>b.textContent==="Download trace JSON" && b.getClientRects().length)'));
 const trace=await run(`fetch(${JSON.stringify('/api/conversations/'+done.id+'/receipts?taskId='+done.id+'&view=machine')}).then(r=>r.json())`);
 assert.equal(trace.audience,'machine');assert(trace.entries.some(e=>e.kind==='directory.snapshot'&&e.metadata.phase==='delivered'));
 assert.doesNotMatch(JSON.stringify(trace),/Synthetic starter sighted/);
 await run('Object.defineProperty(navigator,"clipboard",{configurable:true,value:{writeText:async value=>{window.fixtureTrace=JSON.parse(value);}}})');
 await click('Copy trace JSON','dialog[aria-label="Turn receipts"][open]');
 await until('JSON copy uses selected Maximal run',()=>run(`window.fixtureTrace?.runId===${JSON.stringify(done.id)} && window.fixtureTrace?.entries.length>0`));
 await click('Back to Receipts','dialog[aria-label="Turn receipts"][open]');
 await until('back restores Receipts',()=>run('!!document.querySelector(".next-activity-inspector[open]") && !document.querySelector(\'dialog[aria-label="Turn receipts"][open]\')'));
 fs.writeFileSync(path.join(out,'checks.json'),JSON.stringify({
  passed:true,synthetic:true,checks:['Three independent actual controls and admitted modes','Offline host Planning phase, public activity and Directory main tool kept separate','Actual Action outline opens','Add/focus/block persisted as human','Reopen retains saved state','1200/390 outline fit','Turn receipts independent'],
 },null,2));
})().catch(error=>{fs.writeFileSync(path.join(out,'error.txt'),error.stack);failed=true;}).finally(async()=>{
 win?.destroy();if(server)await server.close();app.exit(failed?1:0);
});
setTimeout(()=>app.exit(2),45000).unref();
