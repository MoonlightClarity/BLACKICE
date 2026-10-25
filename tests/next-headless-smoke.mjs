import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,rm,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {makeFixture} from './next-fixture-server.mjs';
import {exerciseIdentitySettings} from './next-settings-identity-journey.mjs';
import {exerciseProviderSettings} from './next-settings-providers-journey.mjs';
import {exerciseConnectionSettings} from './next-settings-connections-journey.mjs';
import {exerciseConnectionImportSettings} from './next-settings-import-journey.mjs';
import {exerciseKnowledgeManagement} from './next-knowledge-management-journey.mjs';
import {exerciseTaskManagement} from './next-task-management-journey.mjs';
import {exerciseVisualPlanning} from './next-visual-planning-journey.mjs';
import {exerciseActivityVisual} from './next-activity-visual-journey.mjs';

const chrome='C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const fixture=makeFixture({heavyHistory:process.env.BLACKICE_NEXT_HEAVY==='yes',
  largeCatalog:process.env.BLACKICE_NEXT_CATALOG_HEAVY==='yes',
  largeWorkflow:process.env.BLACKICE_NEXT_GRAPH_HEAVY==='yes',
  largeWorkflowCatalog:process.env.BLACKICE_NEXT_WORKFLOW_CATALOG_HEAVY==='yes',
  longTurn:process.env.BLACKICE_NEXT_LONG_TURN==='yes'}),dir=await mkdtemp(join(tmpdir(),'blackice-next-qa-'));
const failures=[],counts={};
let processHandle,ws,nextId=1;
const pending=new Map();
const until=async(fn,label,limitMs=15000)=>{
  const end=Date.now()+limitMs;let last;
  while(Date.now()<end){try{const value=await fn();if(value)return value;}catch(error){last=error;}
    await sleep(120);}
  throw Error(label+' timed out. '+(last?.message||''));
};
function connect(url){
  return new Promise((resolve,reject)=>{
    ws=new WebSocket(url);
    const timer=setTimeout(()=>reject(Error('DevTools socket timeout')),6000);
    ws.addEventListener('open',()=>{clearTimeout(timer);resolve();},{once:true});
    ws.addEventListener('error',()=>{clearTimeout(timer);reject(Error('DevTools socket failed'));},{once:true});
    ws.addEventListener('message',event=>{
      const packet=JSON.parse(event.data);
      if(packet.id&&pending.has(packet.id)){
        const job=pending.get(packet.id);pending.delete(packet.id);
        if(packet.error)job.reject(Error(packet.error.message));
        else job.resolve(packet.result);
      }
      if(packet.method==='Runtime.exceptionThrown')failures.push(packet.params.exceptionDetails?.text||'Renderer exception');
      if(packet.method==='Runtime.consoleAPICalled'&&packet.params.type==='error')failures.push(packet.params.args?.map(a=>a.value||a.description).join(' '));
    });
  });
}
function send(method,params={}){
  const id=nextId++;
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP command timed out: '+method));},10000);
    pending.set(id,{resolve:value=>{clearTimeout(timer);resolve(value);},reject:error=>{clearTimeout(timer);reject(error);}});
    ws.send(JSON.stringify({id,method,params}));
  });
}
async function evaluate(expression){
  const result=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
  if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text||'Page script failed');
  return result.result?.value;
}
try {
  await new Promise(resolve=>fixture.server.listen(0,'127.0.0.1',resolve));
  const port=fixture.server.address().port;
  const profile=join(dir,'chrome');
  await mkdir(profile,{recursive:true});
  processHandle=spawn(chrome,[
    '--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check',
    '--disable-extensions','--disable-background-networking','--disable-sync',
    '--remote-allow-origins=*','--remote-debugging-port=0','--user-data-dir='+profile,
    '--window-size=1360,850','http://127.0.0.1:'+port+'/next/',
  ],{stdio:['ignore','pipe','pipe'],windowsHide:true});
  let childErrors='';
  processHandle.stderr.on('data',chunk=>{childErrors=(childErrors+String(chunk)).slice(-4000);});
  const remote=await until(async()=>{
    const raw=await readFile(join(profile,'DevToolsActivePort'),'utf8');
    return Number(raw.trim().split(/\r?\n/)[0])||null;
  },'Chrome DevTools startup',15000);
  const page=await until(async()=>{
    const targets=await(await fetch('http://127.0.0.1:'+remote+'/json/list')).json();
    return targets.find(tab=>tab.type==='page'&&tab.url.includes('/next/'));
  },'Test page',10000);
  await connect(page.webSocketDebuggerUrl);
  await send('Runtime.enable');await send('Page.enable');
  await until(()=>evaluate('Boolean(document.querySelector("#next-chat-new") && document.querySelector("#next-chat-list"))'),'Chat shell',11000);
  assert.equal(await evaluate('document.querySelector("#next-fatal").hidden'),true);
  await until(()=>evaluate('document.querySelectorAll(".next-conversation").length>0'),'Conversation metadata');
  await until(()=>evaluate('document.querySelector("#next-chat-model")?.options.length>1'),'Chat model choices');
  await evaluate('window.__modelOptionBefore=document.querySelector("#next-chat-model").options[1];document.querySelector("#next-chat-model").focus();true');
  for(let i=0;i<20;i++)fixture.send({type:'runtime.status',data:fixture.state.status});
  await sleep(120);
  assert.equal(await evaluate('document.querySelector("#next-chat-model").options[1]===window.__modelOptionBefore'),true,'Repeated status must not replace identical model option nodes');
  assert.equal(await evaluate('document.activeElement===document.querySelector("#next-chat-model")'),true,'Repeated status must not steal model keyboard focus');
  counts.stableModelMenu=true;
  if(process.env.BLACKICE_NEXT_CATALOG_HEAVY==='yes'){
    assert.equal(fixture.state.conversations.length,12001);
    assert.equal(await evaluate('document.querySelectorAll(".next-conversation").length'),80,'12,001 summaries must not become 12,001 buttons');
    assert.match(await evaluate('document.querySelector(".next-conversation-more")?.textContent||""'),/11921 remaining/);
    await evaluate('document.querySelector(".next-conversation-more").click();true');
    await until(()=>evaluate('document.querySelectorAll(".next-conversation").length===160'),'Bounded catalog expansion');
    const searchAt=Date.now();
    await evaluate('(()=>{const search=document.querySelector("#next-chat-search");search.value="needle";search.dispatchEvent(new Event("input",{bubbles:true}));return true})()');
    await until(()=>evaluate('document.querySelectorAll(".next-conversation").length===1 && document.querySelector(".next-conversation-title")?.textContent.includes("Deep search needle")'),'Full-catalog search of unmounted history');
    counts.catalogSearchMs=Date.now()-searchAt;
    await evaluate('document.querySelector(".next-conversation").click();true');
    await until(()=>evaluate('document.querySelector("#next-chat-title")?.textContent.includes("Deep search needle")'),'Deep saved-conversation selection');
    await evaluate('(()=>{const search=document.querySelector("#next-chat-search");search.value="";search.dispatchEvent(new Event("input",{bubbles:true}));return true})()');
    await until(()=>evaluate('document.querySelectorAll(".next-conversation").length===81 && document.querySelector(".next-conversation[aria-current=true]")?.dataset.conversation==="catalog-9012"'),'Accessible pinned deep conversation without mounting complete catalog');
    await evaluate('document.querySelector("#next-chat-new").click();true');
    await until(()=>evaluate('document.querySelectorAll(".next-conversation").length===80'),'Reset bounded catalog after new conversation');
    counts.largeCatalog=fixture.state.conversations.length;
    counts.visibleCatalog=80;
  }
  assert.ok(!fixture.calls.some(call=>call==='GET /api/runs'),'Startup must not load full execution history');
  assert.equal(await evaluate('document.querySelector("#next-stage > .next-loading") === null'),true,'Bootstrap overlay must be removed.');
  assert.ok(await evaluate('document.querySelector(".next-chat")?.getBoundingClientRect().height > 450'),'Chat must occupy the visible workspace.');
  const messageViewport=await evaluate('(async()=>{const {paintHistory}=await import("/next/chat/render.mjs");const view={timeline:document.createElement("div")};const run={id:"synthetic-long-turn",input:"Inspect large saved turn",status:"completed",settled:true,nodes:{},workflow:{nodes:Array.from({length:1500},(_,i)=>({id:"agent-"+i,type:"agent",name:"Agent "+i}))},precomputedMessages:Array.from({length:3000},(_,i)=>({id:"msg-"+i,nodeId:"agent-"+i%1500,role:"assistant",text:"Response "+i}))};let limit=80;const paint=()=>paintHistory(view,[run],{messageLimits:new Map([[run.id,limit]]),onMoreMessages:()=>{limit+=80;paint()}});const start=performance.now();paint();const initial={visible:view.timeline.querySelectorAll(".next-message[data-role=assistant]").length,more:view.timeline.querySelector(".next-message-more")?.textContent,firstTitle:view.timeline.querySelector(".next-message[data-role=assistant] .next-message-title")?.textContent,lastTitle:[...view.timeline.querySelectorAll(".next-message[data-role=assistant] .next-message-title")].at(-1)?.textContent};view.timeline.querySelector(".next-message-more").click();return {initial,after:{visible:view.timeline.querySelectorAll(".next-message[data-role=assistant]").length,firstTitle:view.timeline.querySelector(".next-message[data-role=assistant] .next-message-title")?.textContent,more:view.timeline.querySelector(".next-message-more")?.textContent},renderMs:Math.round(performance.now()-start),sourceCount:run.precomputedMessages.length}})()');
  assert.deepEqual(messageViewport.initial,{visible:80,more:"Show earlier messages (2920)",firstTitle:"Agent 1420",lastTitle:"Agent 1499"});
  assert.deepEqual(messageViewport.after,{visible:160,firstTitle:"Agent 1340",more:"Show earlier messages (2840)"});
  assert.equal(messageViewport.sourceCount,3000,"Windowing must not discard saved messages.");
  assert.ok(messageViewport.renderMs<1600,"A multi-agent single turn must not freeze its transcript.");
  counts.visibleMessagesPerRun=80;
  counts.multiAgentWindowMs=messageViewport.renderMs;
  counts.chatBoot=true;
  await evaluate('document.querySelector(".next-conversation").click(); true');
  assert.equal(await evaluate('document.querySelector("#next-chat").dataset.reader'), 'worker');
  const inputStart=Date.now();
  await evaluate('document.querySelector("#next-chat-input").value="Can type while loading"; document.querySelector("#next-chat-input").dispatchEvent(new Event("input",{bubbles:true}));true');
  counts.inputResponseMs=Date.now()-inputStart;
  if(process.env.BLACKICE_NEXT_HEAVY==='yes')assert.ok(counts.inputResponseMs<1500,'The composer must remain responsive while large history is parsed.');
  await until(()=>evaluate('document.querySelectorAll(".next-chat-turn").length===12'),'Windowed transcript');
  assert.equal(await evaluate('document.querySelectorAll(".next-chat-turn").length'),12);
  assert.equal(await evaluate('Boolean(document.querySelector(".next-older"))'),true);
  if(process.env.BLACKICE_NEXT_LONG_TURN==='yes'){
    const before=await evaluate('(()=>{const turn=[...document.querySelectorAll(".next-chat-turn")].at(-1);return {count:turn.querySelectorAll(".next-message[data-role=assistant]").length,older:turn.querySelector(".next-message-more")?.textContent,last:[...turn.querySelectorAll(".next-message[data-role=assistant]")].at(-1)?.textContent}})()');
    assert.equal(before.count,80,'A long single turn must mount only the latest 80 responses.');
    assert.equal(before.older,'Show earlier messages (271)');
    assert.match(before.last,/Extended saved message 349/);
    await evaluate('document.querySelector(".next-chat-turn:last-child .next-message-more").click();true');
    await until(()=>evaluate('document.querySelector(".next-chat-turn:last-child").querySelectorAll(".next-message[data-role=assistant]").length===160'),'Older messages loaded in one bounded batch');
    const after=await evaluate('(()=>{const turn=[...document.querySelectorAll(".next-chat-turn")].at(-1);return {count:turn.querySelectorAll(".next-message[data-role=assistant]").length,older:turn.querySelector(".next-message-more")?.textContent,last:[...turn.querySelectorAll(".next-message[data-role=assistant]")].at(-1)?.textContent}})()');
    assert.equal(after.count,160);
    assert.equal(after.older,'Show earlier messages (191)');
    assert.match(after.last,/Extended saved message 349/);
    counts.longTurnWindowed=true;
  }
  counts.visibleTurns=12;
  await until(()=>evaluate('Boolean(document.querySelector(".next-chat-saved-file button"))'),'Saved task artifact');
  await evaluate('document.querySelector(".next-chat-saved-file button").click();true');
  await until(()=>evaluate('Boolean(document.querySelector(".next-artifact-dialog[open]") && document.querySelector(".next-artifact-content")?.textContent.includes("Fixture saved artifact body"))'),'Artifact preview');
  assert.equal(await evaluate('document.querySelector(".next-artifact-download")?.getAttribute("download")'),'fixture-report.txt');
  await evaluate('document.querySelector(".next-artifact-dialog .next-row button").click();true');
  counts.artifactPreview=true;
  assert.ok(await evaluate('document.querySelector(".next-chat-task-summary summary")?.textContent.includes("Task progress")'));
  counts.taskMilestones=true;
  if(process.env.BLACKICE_NEXT_HEAVY==='yes'){
    assert.equal(await evaluate('document.querySelector("#next-chat-input").value'),'Can type while loading');
    counts.heavyHistory=true;
  }
  if(process.env.BLACKICE_NEXT_SCREENSHOT_PATH){
    const image=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
    await writeFile(process.env.BLACKICE_NEXT_SCREENSHOT_PATH,Buffer.from(image.data,'base64'));
  }
  fixture.send({type:'agent.event',runId:'sample-run-49',nodeId:'agent',
    data:{type:'delta',delta:'Streamed text without rebuilding the transcript.'}});
  await until(()=>evaluate('document.querySelector("[data-live-output]")?.textContent.includes("Streamed text")'),'Live token paint');
  counts.livePaint=true;
  for(let n=0;n<2000;n++)fixture.send({type:'agent.event',runId:'sample-run-49',nodeId:'agent',data:{type:'delta',delta:'x'}});
  const inputBurstStart=Date.now();
  await evaluate('document.querySelector("#next-chat-input").value="Still typing during stream";document.querySelector("#next-chat-input").dispatchEvent(new Event("input",{bubbles:true}));true');
  counts.streamInputMs=Date.now()-inputBurstStart;
  assert.ok(counts.streamInputMs<1600,'Streaming should not block input interaction.');
  await until(()=>evaluate('document.querySelector("[data-live-output]")?.textContent.length >= 2000'),'Batched stream receipts');
  counts.streamBurst=true;
  await evaluate('document.querySelector(".next-tab[data-space=planning]").click(); true');
  await until(()=>evaluate('Boolean(document.querySelector("#next-planning-list article"))'),'Planning workspace');
  await evaluate('document.querySelector("#next-planning-list article button").click(); true');
  await until(()=>evaluate('Boolean(document.querySelector("#next-planning-detail textarea"))'),'Editable plan details');
  counts.planning=true;
  await exerciseVisualPlanning({evaluate,send,until,fixture,counts});
  await evaluate('document.querySelector(".next-tab[data-space=tasks]").click(); true');
  await until(()=>evaluate('Boolean(document.querySelector("#next-tasks-form"))'),'Tasks workspace');
  assert.equal(await evaluate('document.querySelector("#next-tasks-tab-board").getAttribute("aria-selected")'),'true');
  assert.equal(fixture.state.workflowIndexRequests,0,'The default work board must not load schedule workflow catalogs.');
  await evaluate('document.querySelector("#next-tasks-tab-schedules").click();document.querySelector("#next-tasks-create").open=true;true');
  await until(()=>fixture.state.workflowIndexRequests>=1,'Tasks workflow metadata loaded without graph catalog');
  assert.equal(fixture.state.workflowFullListRequests,0,'Tasks startup must not download all saved workflow graphs.');
  assert.equal(fixture.state.workflowDetailRequests.length,0,'Tasks must not fetch any full workflow before scheduling.');
  if(process.env.BLACKICE_NEXT_WORKFLOW_CATALOG_HEAVY==='yes'){
    await until(()=>evaluate('document.querySelectorAll("#next-tasks-form [name=workflow] option").length===80'),'Tasks saved workflow selector bounded at 80 options');
    await evaluate('document.querySelector("#next-tasks-workflow-more").click();true');
    await until(()=>evaluate('document.querySelectorAll("#next-tasks-form [name=workflow] option").length===160'),'Tasks workflow catalog pagination');
    await evaluate('(()=>{const search=document.querySelector("#next-tasks-workflow-search");search.value="Needle saved workflow 4599";search.dispatchEvent(new Event("input",{bubbles:true}));return true})()');
    await until(()=>evaluate('document.querySelectorAll("#next-tasks-form [name=workflow] option").length===1 && document.querySelector("#next-tasks-form [name=workflow]").value==="workflow-catalog-4599"'),'Tasks full-catalog metadata search');
    assert.equal(fixture.state.workflowDetailRequests.length,0,'Tasks search must not fetch full graph data.');
    await evaluate('(()=>{const search=document.querySelector("#next-tasks-workflow-search");search.value="";search.dispatchEvent(new Event("input",{bubbles:true}));return true})()');
    await until(()=>evaluate('document.querySelector("#next-tasks-form [name=workflow]").value==="workflow-catalog-4599" && document.querySelectorAll("#next-tasks-form [name=workflow] option").length===81'),'Tasks deep selection pinned');
    counts.tasksCatalogWindowed=true;
  }
  await until(()=>evaluate('Boolean(document.querySelector("#next-tasks-form [name=workflow] option[value=sample-workflow]"))'),'Tasks workflow choices hydrated before submitting the schedule');
  await evaluate('(()=>{const form=document.querySelector("#next-tasks-form");form.elements.workflow.value="sample-workflow";form.elements.name.value="Fixture scheduled review";form.elements.input.value="Review saved evidence";form.elements.cwd.value="C:\\\\fixture";form.elements.enabled.checked=false;form.requestSubmit();return true})()');
  await until(()=>fixture.state.scheduledWrites.length===1,'Tasks schedule full graph fetched only on explicit Save');
  const scheduled=fixture.state.scheduledWrites[0];
  assert.equal(scheduled.workflow.id,'sample-workflow');
  assert.equal(scheduled.workflow.nodes.length,3);
  assert.equal(scheduled.workflow.edges.length,2);
  assert.equal(scheduled.input,'Review saved evidence');
  assert.deepEqual(fixture.state.workflowDetailRequests,['sample-workflow']);
  assert.equal(fixture.state.workflowFullListRequests,0);
  counts.tasksScheduledWithSelectedGraph=true;
  counts.tasks=true;
  await evaluate('document.querySelector(".next-tab[data-space=browser]").click(); true');
  await until(()=>evaluate('Boolean(document.querySelector("#next-browser-inspect"))'),'Browser workspace');
  await until(()=>evaluate('Boolean(document.querySelector("#next-browser-image"))'),'Contained visual page');
  counts.browserVisual=true;
  await evaluate('(()=>{const image=document.querySelector("#next-browser-image");const bounds=image.getBoundingClientRect();image.dispatchEvent(new MouseEvent("click",{bubbles:true,clientX:bounds.left+bounds.width/2,clientY:bounds.top+bounds.height/2}));return true;})()');
  await until(()=>fixture.state.browserActions.some(item=>item.action==='click'),'Native contained page click');
  const click=fixture.state.browserActions.find(item=>item.action==='click');
  assert.equal(click.expectedUrl,'https://example.test/');
  assert.equal(click.expectedDocumentId,'fixture-tab:1');
  assert.ok(Number.isFinite(click.x)&&Number.isFinite(click.y));
  counts.browserClick=true;
  await until(()=>evaluate('Boolean(document.querySelector("#next-browser-image") && !document.querySelector("#next-browser-type-send").disabled)'),'Page refreshed after click');
  await evaluate('document.querySelector("#next-browser-type").value="Typed inside contained page";document.querySelector("#next-browser-type-form").requestSubmit();true');
  await until(()=>fixture.state.browserActions.some(item=>item.action==='type'),'Native contained page typing');
  assert.equal(fixture.state.browserActions.find(item=>item.action==='type').text,'Typed inside contained page');
  counts.browserType=true;
  await until(()=>evaluate('Boolean(document.querySelector("#next-browser-image") && !document.querySelector("#next-browser-type-send").disabled)'),'Page refreshed after typing');
  await evaluate('(()=>{const image=document.querySelector("#next-browser-image");const bounds=image.getBoundingClientRect();image.dispatchEvent(new WheelEvent("wheel",{bubbles:true,cancelable:true,clientX:bounds.left+bounds.width/2,clientY:bounds.top+bounds.height/2,deltaY:220,deltaMode:0}));return true;})()');
  await until(()=>fixture.state.browserActions.some(item=>item.action==='scroll'),'Contained browser wheel scroll');
  assert.equal(fixture.state.browserActions.find(item=>item.action==='scroll').expectedDocumentId,'fixture-tab:1');
  counts.browserScroll=true;
  await until(()=>evaluate('Boolean(document.querySelector("#next-browser-inspect") && !document.querySelector("#next-browser-inspect").disabled)'),'Browser read available');
  await evaluate('document.querySelector("#next-browser-inspect").click(); true');
  await until(()=>evaluate('document.querySelector("#next-browser-readout")?.textContent.includes("Fixture browser content")'),'Browser read');
  counts.browser=true;
  fixture.state.tabs[0].pendingInteraction={
    id:'browser_input_fixture_1',kind:'javascript_dialog',status:'pending',
    tabId:'fixture-tab',url:'https://example.test/',documentId:'fixture-tab:1',
    dialogType:'confirm',message:'Continue this contained page?',
  };
  await evaluate('document.querySelector("#next-browser-refresh").click(); true');
  await until(()=>evaluate('Boolean(document.querySelector("#next-browser-interaction:not([hidden]) button") && !document.querySelector("#next-browser-interaction button").disabled)'),'Contained browser native dialog');
  await evaluate('document.querySelector("#next-browser-interaction button").click(); true');
  await until(()=>fixture.state.browserActions.some(action=>action.action==='interaction'),'Contained dialog response');
  const decision=fixture.state.browserActions.find(action=>action.action==='interaction');
  assert.equal(decision.interactionId,'browser_input_fixture_1');
  assert.equal(decision.expectedDocumentId,'fixture-tab:1');
  assert.equal(decision.decision,'accept');
  counts.browserDialog=true;
  for(const [name,id] of [['back','next-browser-back'],['forward','next-browser-forward'],['reload','next-browser-reload']]){
    await until(()=>evaluate('Boolean(document.querySelector("#'+id+'") && !document.querySelector("#'+id+'").disabled)'),'Browser '+name+' control');
    await evaluate('document.querySelector("#'+id+'").click();true');
    await until(()=>fixture.state.browserActions.some(value=>value.action===name),'Contained browser '+name);
  }
  const focusedAddress=await evaluate('(()=>{document.dispatchEvent(new KeyboardEvent("keydown",{key:"l",ctrlKey:true,bubbles:true,cancelable:true}));return document.activeElement?.id;})()');
  assert.equal(focusedAddress,'next-browser-url','Ctrl+L must focus the visible address bar.');
  counts.browserConventionalNavigation=true;
  // Both frontend modes use real saved tabs. The capture fallback must never
  // replace + Tab with one shared local placeholder or navigate another ID.
  const fallbackSelected=()=>evaluate('document.querySelector("#next-browser-tabs [data-tab-id][aria-selected=true]")?.dataset.tabId');
  const fallbackIdle=label=>until(()=>evaluate('Boolean(document.querySelector("#next-browser-image")) && !document.querySelector("#next-browser-new").disabled && !document.querySelector("#next-browser-shot").disabled'),label);
  const fallbackAddress=value=>evaluate('(()=>{const field=document.querySelector("#next-browser-url");field.value='+JSON.stringify(value)+';field.dispatchEvent(new Event("input",{bubbles:true}));return true})()');
  const fallbackSelect=async(tabId,label)=>{
    const selector='#next-browser-tabs [data-tab-id="'+tabId+'"]';
    await until(()=>evaluate('document.querySelector('+JSON.stringify(selector)+')?.disabled===false'),label+' tab available');
    await evaluate('document.querySelector('+JSON.stringify(selector)+').click();true');await fallbackIdle(label);
    assert.equal(await fallbackSelected(),tabId);assert.equal(fixture.state.activeBrowserTab,tabId,'Explicit selection must be saved in the backend.');
  };
  const fallbackOpens=()=>fixture.state.browserActions.filter(action=>action.action==='open');
  const fallbackNavigations=()=>fixture.state.browserActions.filter(action=>action.action==='navigate');
  const fallbackSelections=()=>fixture.state.browserActions.filter(action=>action.action==='tab_select');
  await fallbackIdle('Browser ready before persistent blank tabs');
  const originalBrowserTab=await fallbackSelected(),originalAddressDraft='https://fixture.example/original-unsent';
  const opensBeforeBlank=fallbackOpens().length,navigationsBeforeBlank=fallbackNavigations().length,selectionsBeforeBlank=fallbackSelections().length;
  const knownBrowserIds=new Set(fixture.state.tabs.map(tab=>tab.tabId));
  await fallbackAddress(originalAddressDraft);
  const openFallbackBlank=async label=>{
    const before=fallbackOpens().length;
    await evaluate('document.querySelector("#next-browser-new").click();document.querySelector("#next-browser-new").click();true');
    await until(()=>fallbackOpens().length===before+1,label+' request');await fallbackIdle(label+' ready');
    const tabId=await fallbackSelected(),record=fixture.state.tabs.find(tab=>tab.tabId===tabId);
    assert.ok(tabId&&!knownBrowserIds.has(tabId),'Each + Tab must create its own saved ID.');knownBrowserIds.add(tabId);
    assert.equal(record?.url,'about:blank');assert.equal(record?.title,'New tab');
    assert.equal(await evaluate('document.querySelector("#next-browser-url").value'),'','A real blank tab has an empty address field.');
    assert.equal(await evaluate('document.querySelector("#next-browser-tabs [aria-selected=true]").textContent'),'New tab');
    assert.deepEqual(fallbackOpens().at(-1),{action:'open',browser:'relay',url:'about:blank'});
    return tabId;
  };
  const firstBlankTab=await openFallbackBlank('First persistent fallback blank');
  const firstBlankDraft='https://fixture.example/first-blank-unsent';await fallbackAddress(firstBlankDraft);
  await fallbackSelect(originalBrowserTab,'Original tab address draft restored');
  assert.equal(await evaluate('document.querySelector("#next-browser-url").value'),originalAddressDraft);
  await fallbackSelect(firstBlankTab,'First blank tab draft restored');
  assert.equal(await evaluate('document.querySelector("#next-browser-url").value'),firstBlankDraft);
  assert.equal(fallbackNavigations().length,navigationsBeforeBlank,'Selecting a tab never submits its address draft.');
  const secondBlankTab=await openFallbackBlank('Second independent fallback blank');
  assert.notEqual(secondBlankTab,firstBlankTab);
  assert.equal(fixture.state.tabs.filter(tab=>[firstBlankTab,secondBlankTab].includes(tab.tabId)&&tab.url==='about:blank').length,2);
  const fromBlankAddress='https://fixture.example/from-blank';await fallbackAddress(fromBlankAddress);
  await evaluate('document.querySelector("#next-browser-form").requestSubmit();true');
  await until(()=>fallbackNavigations().length===navigationsBeforeBlank+1,'Navigate the second real blank tab');await fallbackIdle('Navigated fallback blank view');
  assert.deepEqual(fallbackNavigations().at(-1),{action:'navigate',browser:'relay',tabId:secondBlankTab,url:fromBlankAddress});
  assert.equal(await fallbackSelected(),secondBlankTab);assert.equal(fallbackOpens().length,opensBeforeBlank+2,'Go must navigate the existing blank ID without creating another tab.');
  const closesBeforeBlank=fixture.state.browserActions.filter(action=>action.action==='close').length;
  await evaluate('document.querySelector('+JSON.stringify('#next-browser-tabs [data-close-tab="'+firstBlankTab+'"]')+').click();true');
  await until(()=>!fixture.state.tabs.some(tab=>tab.tabId===firstBlankTab),'Close only the first blank');await fallbackIdle('Surviving second tab after close');
  assert.equal(fixture.state.browserActions.filter(action=>action.action==='close').length,closesBeforeBlank+1);
  assert.deepEqual(fixture.state.browserActions.filter(action=>action.action==='close').at(-1),{action:'close',browser:'relay',tabId:firstBlankTab});
  assert.equal(await fallbackSelected(),secondBlankTab);assert.equal(fixture.state.activeBrowserTab,secondBlankTab);
  assert.equal(fixture.state.tabs.find(tab=>tab.tabId===secondBlankTab)?.url,fromBlankAddress);
  const secondBlankDraft='https://fixture.example/second-blank-unsent';await fallbackAddress(secondBlankDraft);
  await fallbackSelect(originalBrowserTab,'Original per-tab address preserved after independent close');
  assert.equal(await evaluate('document.querySelector("#next-browser-url").value'),originalAddressDraft);
  await fallbackSelect(secondBlankTab,'Second per-tab address preserved after selection');
  assert.equal(await evaluate('document.querySelector("#next-browser-url").value'),secondBlankDraft);
  for(const action of fallbackSelections().slice(selectionsBeforeBlank))assert.deepEqual(Object.keys(action).sort(),['action','browser','tabId'],'Tab selection must be a metadata operation without page input or navigation fields.');
  assert.deepEqual(fallbackSelections().slice(selectionsBeforeBlank).map(action=>action.tabId),[originalBrowserTab,firstBlankTab,originalBrowserTab,secondBlankTab]);
  await evaluate('document.querySelector(".next-tab[data-space=chat]").click();true');
  await until(()=>evaluate('document.querySelector(".next-tab[data-space=chat]").getAttribute("aria-selected")==="true"'),'Leave fallback with a tab address draft');
  await evaluate('document.querySelector(".next-tab[data-space=browser]").click();true');await fallbackIdle('Restore durable browser selection on reentry');
  assert.equal(await fallbackSelected(),secondBlankTab);assert.equal(await evaluate('document.querySelector("#next-browser-url").value'),secondBlankDraft);
  assert.equal(fallbackOpens().length,opensBeforeBlank+2);assert.equal(fallbackNavigations().length,navigationsBeforeBlank+1,'Reentry must preserve a draft without submitting it.');
  await evaluate('document.querySelector("#next-browser-close").click();true');
  await until(()=>!fixture.state.tabs.some(tab=>tab.tabId===secondBlankTab),'Close the second saved tab');await fallbackIdle('Return to original browser tab');
  assert.equal(await fallbackSelected(),originalBrowserTab);assert.equal(await evaluate('document.querySelector("#next-browser-url").value'),originalAddressDraft);
  assert.equal(fixture.state.tabs.some(tab=>[firstBlankTab,secondBlankTab].includes(tab.tabId)),false);
  counts.browserPersistentBlankTabs={independentIds:2,sameIdNavigation:true,closeOne:true,metadataSelection:true,perTabDrafts:true,workspaceDraft:true};
  // Verify the conventional tab strip and address bar remain usable at the
  // minimum 780×560 BLACKICE window size, even after Browser itself scrolls.
  await send('Emulation.setDeviceMetricsOverride',{width:780,height:560,deviceScaleFactor:1,mobile:false});
  const navAtMinimum=await evaluate('(()=>{const bar=document.querySelector("#next-browser-navigation"),address=document.querySelector("#next-browser-url"),tab=document.querySelector(".next-browser-tab"),r=address.getBoundingClientRect(),b=bar.getBoundingClientRect();return {barTop:b.top,barBottom:b.bottom,addressWidth:r.width,addressBottom:r.bottom,tabVisible:!!tab&&tab.getBoundingClientRect().bottom<innerHeight,hit:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===address};})()');
  assert.ok(navAtMinimum.addressWidth>=150&&navAtMinimum.addressBottom<=560&&navAtMinimum.tabVisible&&navAtMinimum.hit,
    'Normal browser navigation must be visible and hittable at 780×560.');
  await evaluate('document.querySelector("[data-workspace=browser] .next-panel").scrollTop=10000;true');
  await sleep(100);
  const scrolledNav=await evaluate('(()=>{const bar=document.querySelector("#next-browser-navigation"),address=document.querySelector("#next-browser-url"),r=address.getBoundingClientRect(),b=bar.getBoundingClientRect();return {barTop:b.top,addressBottom:r.bottom,hit:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===address};})()');
  assert.ok(scrolledNav.barTop>=0&&scrolledNav.addressBottom<=560&&scrolledNav.hit,
    'Address bar must remain visible and clickable when the contained browser scrolls.');
  await send('Emulation.clearDeviceMetricsOverride');
  counts.browserNavigationMinimumSize=true;
  if(process.env.BLACKICE_NEXT_BROWSER_SCREENSHOT_PATH){
    await until(()=>evaluate('Boolean(document.querySelector("#next-browser-image")) && !document.querySelector("#next-browser-shot").disabled'),'Browser visual screenshot ready');
    const capture=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
    await writeFile(process.env.BLACKICE_NEXT_BROWSER_SCREENSHOT_PATH,Buffer.from(capture.data,'base64'));
  }
  await evaluate('document.querySelector(".next-tab[data-space=activity]").click(); true');
  await until(()=>evaluate('Boolean(document.querySelector("#next-activity-runtime"))'),'Activity workspace');
  counts.activity=true;
  await until(()=>evaluate('Boolean(document.querySelector("#next-workflow-outline .next-workflow-node"))'),'Saved workflow graph');
  assert.equal(await evaluate('document.querySelectorAll("#next-workflow-connections .next-workflow-link").length'),2,'Saved workflow connections must be visible in V2.');
  assert.match(await evaluate('document.querySelector("#next-workflow-connections")?.textContent||""'),/input.*Agent.*output/);
  assert.ok(fixture.state.workflowIndexRequests>=1,'Activity must request only the workflow metadata index at startup');
  assert.equal(fixture.state.workflowFullListRequests,0,'Activity must not bulk-fetch full workflow graphs');
  assert.ok(fixture.state.workflowDetailRequests.includes('sample-workflow'),'Selected workflow should be fetched on demand');
  counts.workflowLazyLoaded=true;
  await exerciseActivityVisual({evaluate,until,fixture,counts});
  await until(()=>evaluate('document.querySelectorAll("#next-workflow-canvas [data-node]").length===3 && document.querySelectorAll("#next-workflow-canvas [data-edge-source]").length===2'),'Visual workflow canvas mounted');
  const canvasBeforeZoom=await evaluate('document.querySelector("#next-workflow-canvas").getAttribute("viewBox")');
  await evaluate('document.querySelector("#next-canvas-zoom-in").click();true');
  await until(()=>evaluate('document.querySelector("#next-canvas-zoom")?.textContent==="125%"'),'Canvas zoom control works');
  assert.notEqual(await evaluate('document.querySelector("#next-workflow-canvas").getAttribute("viewBox")'),canvasBeforeZoom);
  await evaluate('document.querySelector("#next-canvas-fit").click();true');
  await until(()=>evaluate('Number(document.querySelector("#next-canvas-zoom")?.textContent.replace("%",""))>0'),'Canvas fit-to-graph control works');
  counts.workflowCanvasRendered=true;
  counts.workflowInspection=true;
  if(process.env.BLACKICE_NEXT_WORKFLOW_CATALOG_HEAVY==='yes'){
    await until(()=>evaluate('document.querySelectorAll("#next-workflow-choice option").length===80'),'Bounded saved-workflow catalog at startup');
    assert.equal(fixture.state.workflows.length,process.env.BLACKICE_NEXT_GRAPH_HEAVY==='yes'?5002:5001);
    await evaluate('document.querySelector("#next-workflow-more").click();true');
    await until(()=>evaluate('document.querySelectorAll("#next-workflow-choice option").length===160'),'Incremental workflow catalog expansion');
    const searchAt=Date.now();
    await evaluate('(()=>{const search=document.querySelector("#next-workflow-search");search.value="Needle saved workflow 4599";search.dispatchEvent(new Event("input",{bubbles:true}));return true})()');
    await until(()=>evaluate('document.querySelectorAll("#next-workflow-choice option").length===1 && document.querySelector("#next-workflow-choice").value==="workflow-catalog-4599"'),'Full saved-workflow catalog search');
    counts.workflowCatalogSearchMs=Date.now()-searchAt;
    await until(()=>fixture.state.workflowDetailRequests.includes('workflow-catalog-4599'),'Deep selected workflow fetched on demand');
    assert.equal(fixture.state.workflowFullListRequests,0,'Searching a large catalog must not load full workflow data');
    await evaluate('(()=>{const search=document.querySelector("#next-workflow-search");search.value="";search.dispatchEvent(new Event("input",{bubbles:true}));return true})()');
    await until(()=>evaluate('document.querySelectorAll("#next-workflow-choice option").length===81 && document.querySelector("#next-workflow-choice").value==="workflow-catalog-4599"'),'Keep deep workflow selected outside first batch');
    assert.equal(fixture.state.workflows.length,process.env.BLACKICE_NEXT_GRAPH_HEAVY==='yes'?5002:5001,'Catalog expansion must not truncate saved workflow metadata');
    await evaluate('(()=>{const choice=document.querySelector("#next-workflow-choice");choice.value="sample-workflow";choice.dispatchEvent(new Event("change",{bubbles:true}));return true})()');
    await until(()=>evaluate('document.querySelector("#next-workflow-choice")?.value==="sample-workflow"'),'Return to original saved workflow');
    counts.workflowCatalogWindowed=true;
  }
  if(process.env.BLACKICE_NEXT_GRAPH_HEAVY==='yes'){
    await until(()=>evaluate('Boolean(document.querySelector("#next-workflow-choice option[value=large-fixture-graph]"))'),'Large synthetic workflow option');
    await evaluate('(()=>{const select=document.querySelector("#next-workflow-choice");select.value="large-fixture-graph";select.dispatchEvent(new Event("change",{bubbles:true}));return true})()');
    await until(()=>evaluate('document.querySelectorAll("#next-workflow-outline .next-workflow-node").length===80 && document.querySelectorAll("#next-workflow-connections .next-workflow-link").length===120'),'Bounded large DAG render');
    const workflowInputMs=await evaluate('(()=>{const input=document.querySelector("#next-workflow-prompt"),start=performance.now();for(let i=0;i<300;i++){input.value="Case instructions "+i;input.dispatchEvent(new Event("input",{bubbles:true}));}const ms=performance.now()-start;input.value="";input.dispatchEvent(new Event("input",{bubbles:true}));return Math.round(ms)})()');
    assert.ok(workflowInputMs<800,'Large workflow graph readiness must not block typing on every input event.');
    counts.workflowGraphInputBurstMs=workflowInputMs;
    assert.match(await evaluate('document.querySelector("#next-workflow-more-stages")?.textContent||""'),/1420 remaining/);
    assert.match(await evaluate('document.querySelector("#next-workflow-more-connections")?.textContent||""'),/1379 remaining/);
    await evaluate('document.querySelector("#next-workflow-more-stages").click();document.querySelector("#next-workflow-more-connections").click();true');
    await until(()=>evaluate('document.querySelectorAll("#next-workflow-outline .next-workflow-node").length===160 && document.querySelectorAll("#next-workflow-connections .next-workflow-link").length===240'),'Large DAG pagination');
    assert.equal(fixture.state.workflows.find(row=>row.id==='large-fixture-graph').nodes.length,1500,'Pagination must never truncate source workflow');
    assert.ok(await evaluate('document.querySelectorAll("#next-workflow-edit-node option").length<=80'),'Stage editor must not mount all 1,500 selectable options');
    await evaluate('(()=>{document.querySelector("#next-workflow-edit-details").open=true;const search=document.querySelector("#next-workflow-edit-stage-search");search.value="Stage 1498";search.dispatchEvent(new Event("input",{bubbles:true}));return true})()');
    await until(()=>evaluate('document.querySelectorAll("#next-workflow-edit-node option").length===1 && document.querySelector("#next-workflow-edit-node").value==="stage-1498"'),'Deep workflow stage search');
    assert.equal(await evaluate('document.querySelector("#next-workflow-edit-node-name").value'),'Stage 1498');
    await evaluate('(()=>{const search=document.querySelector("#next-workflow-edit-stage-search");search.value="";search.dispatchEvent(new Event("input",{bubbles:true}));return true})()');
    await until(()=>evaluate('document.querySelectorAll("#next-workflow-edit-node option").length===81'),'Deep selected stage remains pinned outside its first batch');
    await evaluate('(()=>{const select=document.querySelector("#next-workflow-choice");select.value="sample-workflow";select.dispatchEvent(new Event("change",{bubbles:true}));return true})()');
    await until(()=>evaluate('document.querySelectorAll("#next-workflow-outline .next-workflow-node").length===3 && document.querySelectorAll("#next-workflow-connections .next-workflow-link").length===2'),'Original workflow restored after large graph');
    await until(()=>evaluate('document.querySelectorAll("#next-workflow-canvas [data-node]").length>0'),'Large workflow visual canvas ready');
    assert.ok(await evaluate('document.querySelectorAll("#next-workflow-canvas [data-node]").length<=120'),'Large canvas must bound node SVG elements');
    assert.ok(await evaluate('document.querySelectorAll("#next-workflow-canvas [data-edge-source]").length<=220'),'Large canvas must bound connection SVG elements');
    await evaluate('document.querySelector("#next-canvas-fit").click();true');
    await until(()=>evaluate('document.querySelectorAll("#next-workflow-canvas [data-node]").length<=120'),'Canvas must remain bounded even after fit');
    counts.workflowCanvasVirtualized=true;
    counts.workflowGraphWindowed=true;
    await evaluate('(()=>{document.querySelector("#next-workflow-run-id").value="large-inspection-run";document.querySelector("#next-workflow-inspect").click();return true})()');
    await until(()=>evaluate('document.querySelector("#next-workflow-run-details")?.textContent.includes("large-inspection-run") && document.querySelectorAll("#next-workflow-run-details li.next-workflow-node").length===80'),'Bounded large workflow run inspection');
    assert.match(await evaluate('document.querySelector("#next-workflow-run-more")?.textContent||""'),/1420 remaining/);
    await evaluate('document.querySelector("#next-workflow-run-more").click();true');
    await until(()=>evaluate('document.querySelectorAll("#next-workflow-run-details li.next-workflow-node").length===160'),'Large workflow run status expansion');
    counts.workflowRunWindowed=true;
  }
  // V2 native saved-workflow editing must preserve IDs, graph edges and engine
  // metadata. Nothing is posted until an explicit Save, including navigation.
  await until(()=>evaluate('Boolean(document.querySelector("#next-workflow-edit-form") && document.querySelector("#next-workflow-edit-node option[value=agent]"))'),'Saved workflow editor ready');
  assert.equal(await evaluate('document.querySelector("#next-workflow-edit-save").disabled'),true,'Unchanged workflow must not enable an unnecessary save');
  const beforeWorkflow=structuredClone(fixture.state.workflows.find(row=>row.id==='sample-workflow'));
  const beforeWrites=fixture.state.postedWorkflows.length;
  await evaluate('(()=>{document.querySelector("#next-workflow-edit-details").open=true;const n=document.querySelector("#next-workflow-edit-name");n.value="Revised workflow";n.dispatchEvent(new Event("input",{bubbles:true}));const s=document.querySelector("#next-workflow-edit-node-name");s.value="Lead agent";s.dispatchEvent(new Event("input",{bubbles:true}));const p=document.querySelector("#next-workflow-edit-prompt");p.value="Analyze the case and report sources.";p.dispatchEvent(new Event("input",{bubbles:true}));return true})()');
  // The advanced editor changes provider/model options and workflow-level
  // settings without changing identities, connectivity or unknown fields.
  await evaluate('(()=>{document.querySelector("#next-workflow-edit-advanced").open=true;const edit=(id,value,event)=>{const field=document.querySelector(id);field.value=value;field.dispatchEvent(new Event(event||"change",{bubbles:true}));};edit("#next-workflow-edit-model","codex-test","input");edit("#next-workflow-edit-effort","high");edit("#next-workflow-edit-tier","default");edit("#next-workflow-edit-context","custom");edit("#next-workflow-edit-context-tokens","120000","input");const compact=document.querySelector("#next-workflow-edit-compact");compact.checked=false;compact.dispatchEvent(new Event("change",{bubbles:true}));edit("#next-workflow-edit-parallel","3","input");edit("#next-workflow-edit-planning","on");edit("#next-workflow-edit-detail","detailed");return true})()');
  assert.equal(await evaluate('document.querySelector("#next-workflow-edit-context-tokens").disabled'),false,'Custom context token input must enable only for custom preset.');
  const expectedAssignment={scope:'Investigate the supplied case and reconcile the primary sources.',
    inputs:['Original request','Saved fixture evidence'],result:'A checked assessment with source references.',
    doneWhen:'Material claims are supported and remaining uncertainties are identified.'};
  await evaluate('(()=>{document.querySelector("#next-workflow-edit-assignment-create").click();const values='+JSON.stringify({
    scope:expectedAssignment.scope,inputs:expectedAssignment.inputs.join('\n'),result:expectedAssignment.result,done:expectedAssignment.doneWhen,
  })+';for(const [name,value]of Object.entries(values)){const field=document.querySelector("#next-workflow-edit-assignment-"+name);field.value=value;field.dispatchEvent(new Event("input",{bubbles:true}));}return true})()');
  assert.equal(await evaluate('document.querySelector("#next-workflow-edit-assignment-fields").hidden'),false);
  assert.equal(fixture.state.postedWorkflows.length,beforeWrites,'Adding and editing worker assignments must remain local drafts.');
  assert.equal(fixture.state.postedWorkflows.length,beforeWrites,'Advanced settings must not auto-save.');
  // Editing controls must stay reachable inside the Activity scroll surface
  // at the minimum desktop window size and non-default display scaling.
  await send('Emulation.setDeviceMetricsOverride',{width:780,height:560,deviceScaleFactor:1.5,mobile:false});
  const editorAccess=await evaluate('(()=>{const field=document.querySelector("#next-workflow-edit-node-name");field.scrollIntoView({block:"center"});const r=field.getBoundingClientRect();return {width:r.width,top:r.top,bottom:r.bottom,hit:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===field,dpr:devicePixelRatio}})()');
  assert.ok(editorAccess.width>=150&&editorAccess.top>=0&&editorAccess.bottom<=560&&editorAccess.hit&&editorAccess.dpr===1.5,'Editor stage fields must remain accessible at 780×560 and 150% DPR');
  const advancedAccess=await evaluate('(()=>{const field=document.querySelector("#next-workflow-edit-model");field.scrollIntoView({block:"center"});const r=field.getBoundingClientRect();return {width:r.width,top:r.top,bottom:r.bottom,hit:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===field}})()');
  assert.ok(advancedAccess.width>=150&&advancedAccess.top>=0&&advancedAccess.bottom<=560&&advancedAccess.hit,'Model configuration must remain reachable at minimum window size.');
  const contextAccess=await evaluate('(()=>{const field=document.querySelector("#next-workflow-edit-context-tokens");field.scrollIntoView({block:"center"});const r=field.getBoundingClientRect();return {width:r.width,top:r.top,bottom:r.bottom,hit:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===field}})()');
  assert.ok(contextAccess.width>=150&&contextAccess.top>=0&&contextAccess.bottom<=560&&contextAccess.hit,'Custom context window configuration must remain reachable.');
  for(const name of ['scope','inputs','result','done']){
    const access=await evaluate('(()=>{const field=document.querySelector('+JSON.stringify('#next-workflow-edit-assignment-'+name)+');field.scrollIntoView({block:"center"});const r=field.getBoundingClientRect();return {width:r.width,top:r.top,bottom:r.bottom,hit:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===field,dpr:devicePixelRatio}})()');
    assert.ok(access.width>=150&&access.top>=0&&access.bottom<=560&&access.hit&&access.dpr===1.5,'Worker assignment '+name+' must be accessible at 780×560 and 150% DPR.');
  }
  counts.workflowAssignmentMinimumSize=true;
  await send('Emulation.clearDeviceMetricsOverride');
  counts.workflowEditorMinimumSize=true;
  assert.equal(fixture.state.postedWorkflows.length,beforeWrites,'Edits must remain drafts before Save');
  assert.equal(await evaluate('document.querySelector("#next-workflow-edit-save").disabled'),false,'An explicit edit must enable Save');
  await evaluate('document.querySelector("#next-workflow-edit-name").focus();true');
  await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
  await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
  await sleep(120);
  assert.equal(fixture.state.postedWorkflows.length,beforeWrites,'Pressing Enter while editing must not trigger an implicit workflow save');
  await evaluate('document.querySelector(".next-tab[data-space=settings]").click();true');
  await until(()=>evaluate('Boolean(document.querySelector("#next-settings-model"))'),'Settings before workflow draft restore');
  await evaluate('document.querySelector(".next-tab[data-space=activity]").click();true');
  await until(()=>evaluate('document.querySelector("#next-workflow-edit-name")?.value==="Revised workflow" && document.querySelector("#next-workflow-edit-prompt")?.value==="Analyze the case and report sources."'),'Unsaved workflow changes preserved across navigation');
  await until(()=>evaluate('document.querySelector("#next-workflow-choice")?.value==="sample-workflow" && document.querySelector("#next-workflow-edit-node option[value=agent]") && document.querySelector("#next-workflow-edit-save")?.disabled===false'),'Selected workflow details fully hydrated before Save');
  await until(()=>evaluate('document.querySelector("#next-workflow-edit-model")?.value==="codex-test" && document.querySelector("#next-workflow-edit-effort")?.value==="high" && document.querySelector("#next-workflow-edit-context-tokens")?.value==="120000" && document.querySelector("#next-workflow-edit-planning")?.value==="on"'),'Advanced settings draft retained across navigation');
  const assignmentValues=()=>evaluate('(()=>{const value=name=>document.querySelector("#next-workflow-edit-assignment-"+name).value;return {scope:value("scope"),inputs:value("inputs").split("\\n"),result:value("result"),doneWhen:value("done")}})()');
  assert.deepEqual(await assignmentValues(),expectedAssignment,'Every assignment field must survive the Settings roundtrip.');
  await evaluate('(()=>{const stage=document.querySelector("#next-workflow-edit-node");stage.value="input";stage.dispatchEvent(new Event("change",{bubbles:true}));return true})()');
  assert.equal(await evaluate('document.querySelector("#next-workflow-edit-agent-options").disabled'),true,'Agent-only settings must not be editable on task input nodes.');
  assert.equal(await evaluate('document.querySelector("#next-workflow-edit-assignment-group").disabled'),true,'Task input nodes cannot have worker assignment edits.');
  assert.equal(await evaluate('document.querySelector("#next-workflow-edit-assignment-fields").hidden'),true);
  await evaluate('(()=>{const stage=document.querySelector("#next-workflow-edit-node");stage.value="agent";stage.dispatchEvent(new Event("change",{bubbles:true}));return true})()');
  assert.equal(await evaluate('document.querySelector("#next-workflow-edit-agent-options").disabled'),false,'Agent settings restore on reselect.');
  assert.equal(await evaluate('document.querySelector("#next-workflow-edit-assignment-group").disabled'),false);
  assert.deepEqual(await assignmentValues(),expectedAssignment,'Switching stages must preserve all unsaved assignment values.');
  assert.equal(fixture.state.postedWorkflows.length,beforeWrites,'Navigating must not save a workflow');
  // Invalid values must show the editor's own bounded feedback rather than
  // silently suppressing form submit through browser constraint validation.
  await evaluate('(()=>{const name=document.querySelector("#next-workflow-edit-name"),form=document.querySelector("#next-workflow-edit-form");name.value="";name.dispatchEvent(new Event("input",{bubbles:true}));form.requestSubmit();return true})()');
  await until(()=>evaluate('document.querySelector("#next-workflow-edit-feedback")?.textContent.includes("workflow name")'),'Invalid draft receives explicit validation message');
  assert.equal(fixture.state.postedWorkflows.length,beforeWrites,'Invalid draft must not produce any workflow write.');
  await evaluate('(()=>{const name=document.querySelector("#next-workflow-edit-name");name.value="Revised workflow";name.dispatchEvent(new Event("input",{bubbles:true}));return true})()');
  await evaluate('(()=>{const tokens=document.querySelector("#next-workflow-edit-context-tokens");tokens.value="512";tokens.dispatchEvent(new Event("input",{bubbles:true}));document.querySelector("#next-workflow-edit-form").requestSubmit();return true})()');
  await until(()=>evaluate('document.querySelector("#next-workflow-edit-feedback")?.textContent.includes("Custom context window")'),'Invalid custom context rejected before save');
  assert.equal(fixture.state.postedWorkflows.length,beforeWrites,'Invalid context must not produce an HTTP write.');
  await evaluate('(()=>{const tokens=document.querySelector("#next-workflow-edit-context-tokens");tokens.value="120000";tokens.dispatchEvent(new Event("input",{bubbles:true}));return true})()');
  await evaluate('(()=>{const scope=document.querySelector("#next-workflow-edit-assignment-scope");scope.value=" ";scope.dispatchEvent(new Event("input",{bubbles:true}));document.querySelector("#next-workflow-edit-form").requestSubmit();return true})()');
  await until(()=>evaluate('document.querySelector("#next-workflow-edit-feedback")?.textContent.includes("Worker scope")'),'Incomplete assignment rejected before saving');
  assert.equal(fixture.state.postedWorkflows.length,beforeWrites,'Invalid assignment must never produce an HTTP write.');
  await evaluate('(()=>{const scope=document.querySelector("#next-workflow-edit-assignment-scope");scope.value='+JSON.stringify(expectedAssignment.scope)+';scope.dispatchEvent(new Event("input",{bubbles:true}));return true})()');
  await evaluate('(()=>{const form=document.querySelector("#next-workflow-edit-form");form.requestSubmit();form.requestSubmit();return true})()');
  await until(()=>fixture.state.postedWorkflows.length===beforeWrites+1,'Explicit workflow save');
  const saved=fixture.state.workflows.find(item=>item.id==='sample-workflow');
  assert.equal(saved.name,'Revised workflow');
  assert.equal(saved.nodes.find(item=>item.id==='agent').name,'Lead agent');
  assert.equal(saved.nodes.find(item=>item.id==='agent').prompt,'Analyze the case and report sources.');
  assert.deepEqual(saved.edges,beforeWorkflow.edges,'Workflow connection graph must be preserved');
  assert.deepEqual(saved.settings,{...beforeWorkflow.settings,
    maxParallel:3,planningMode:'on',planDetail:'detailed'},'Explicit workflow settings must persist without losing prior fields.');
  assert.equal(saved.nodes.find(item=>item.id==='agent').model,'codex-test');
  assert.equal(saved.nodes.find(item=>item.id==='agent').effort,'high');
  assert.equal(saved.nodes.find(item=>item.id==='agent').serviceTier,'default');
  assert.deepEqual(saved.nodes.find(item=>item.id==='agent').context,{
    preset:'custom',windowTokens:120000,autoCompact:false,
  });
  assert.deepEqual(saved.nodes.map(row=>row.id),beforeWorkflow.nodes.map(row=>row.id));
  assert.deepEqual(saved.nodes.find(item=>item.id==='agent').assignment,expectedAssignment,'Save must persist the exact four descriptive assignment fields.');
  assert.equal(Object.hasOwn(saved.nodes.find(item=>item.id==='agent').assignment,'canWrite'),false,'Adding an assignment must not create permission metadata.');
  await until(()=>evaluate('document.querySelector("#next-workflow-edit-feedback")?.textContent==="Workflow saved."'),'Workflow save confirmation');
  assert.equal(await evaluate('document.querySelector("#next-workflow-edit-save").disabled'),true,'Save must return to disabled after successful persistence');
  assert.match(await evaluate('document.querySelector("#next-workflow-connections")?.textContent||""'),/Lead agent/,'Updated stage name must be reflected in the connection overview.');
  counts.workflowEdited=true;
  counts.workflowAssignmentEdited=true;
  await evaluate('document.querySelector("#next-workflow-edit-assignment-remove").click();true');
  assert.equal(await evaluate('document.querySelector("#next-workflow-edit-assignment-fields").hidden'),true,'Removing an assignment stages its removal.');
  assert.equal(fixture.state.postedWorkflows.length,beforeWrites+1,'Staged removal must not save automatically.');
  assert.deepEqual(fixture.state.workflows.find(item=>item.id==='sample-workflow').nodes.find(item=>item.id==='agent').assignment,expectedAssignment,'The saved assignment remains intact before Save.');
  await evaluate('document.querySelector("#next-workflow-edit-discard").click();true');
  assert.deepEqual(await assignmentValues(),expectedAssignment,'Discard must restore the saved assignment after staged removal.');
  assert.equal(await evaluate('document.querySelector("#next-workflow-edit-assignment-fields").hidden'),false);
  assert.equal(await evaluate('document.querySelector("#next-workflow-edit-save").disabled'),true);
  assert.equal(fixture.state.postedWorkflows.length,beforeWrites+1,'Discard cannot mutate the saved workflow.');
  counts.workflowAssignmentRemovalDiscarded=true;
  // Simulate another client changing the graph. A stale editor must refuse to
  // overwrite that change and cannot attempt an automatic second write.
  const independent=fixture.state.workflows.find(item=>item.id==='sample-workflow');
  await evaluate('(()=>{const p=document.querySelector("#next-workflow-edit-prompt");p.value="Do not overwrite an independent change";p.dispatchEvent(new Event("input",{bubbles:true}));return true})()');
  independent.edges=[...independent.edges,{source:'input',target:'output',id:'independent-edge'}];
  // Refreshing unversioned catalog metadata must keep the active editor stable.
  // Revalidating the selected graph must not silently rebase unsaved changes.
  await evaluate('document.querySelector("#next-workflow-refresh").click();true');
  await until(()=>evaluate('document.querySelectorAll("#next-workflow-connections .next-workflow-link").length===3'),'Revalidated independent graph update while stage edit remains unsaved');
  assert.equal(await evaluate('document.querySelector("#next-workflow-edit-prompt").value'),'Do not overwrite an independent change');
  await evaluate('document.querySelector("#next-workflow-edit-form").requestSubmit();true');
  await until(()=>evaluate('document.querySelector("#next-workflow-edit-feedback")?.textContent.includes("changed since editing began")'),'Refresh must reject stale unsaved stage edits');
  assert.equal(fixture.state.postedWorkflows.length,beforeWrites+1,'Conflict must not issue a second POST');
  assert.equal(fixture.state.workflows.find(item=>item.id==='sample-workflow').edges.length,beforeWorkflow.edges.length+1);
  await evaluate('document.querySelector("#next-workflow-edit-discard").click();document.querySelector("#next-workflow-refresh").click();true');
  await until(()=>evaluate('document.querySelector("#next-workflow-edit-prompt")?.value==="Analyze the case and report sources."'),'Discard and refresh protected independent graph changes');
  await until(()=>evaluate('document.querySelectorAll("#next-workflow-connections .next-workflow-link").length===3'),'Independent connection visible after refresh');
  assert.match(await evaluate('document.querySelector("#next-workflow-connections")?.textContent||""'),/input.*output/);
  counts.workflowConflictBlocked=true;
  // Native V2 graph authoring: create a previously nonexistent workflow,
  // add a stage, construct a valid DAG, and verify no write until Save.
  const graphWrites=fixture.state.postedWorkflows.length;
  await evaluate('document.querySelector("#next-workflow-new").click();true');
  const newGraphId=await until(()=>evaluate('(()=>{const choice=document.querySelector("#next-workflow-choice");return choice?.value.startsWith("workflow_")&&document.querySelector("#next-workflow-graph-author")?.open?choice.value:null})()'),'Unsaved new workflow draft');
  assert.equal(fixture.state.postedWorkflows.length,graphWrites,'A new workflow must not be saved simply by opening the builder.');
  await send('Emulation.setDeviceMetricsOverride',{width:780,height:560,deviceScaleFactor:1.5,mobile:false});
  const graphAccess=await evaluate('(()=>{const field=document.querySelector("#next-graph-add");field.scrollIntoView({block:"center"});const r=field.getBoundingClientRect();return {width:r.width,top:r.top,bottom:r.bottom,hit:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===field,dpr:devicePixelRatio}})()');
  assert.ok(graphAccess.width>=90&&graphAccess.top>=0&&graphAccess.bottom<=560&&graphAccess.hit&&graphAccess.dpr===1.5,'Graph builder actions must remain accessible at 780×560 and 150% DPI.');
  const canvasAccess=await evaluate('(()=>{const element=document.querySelector("#next-workflow-canvas");element.scrollIntoView({block:"center"});const r=element.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return {width:r.width,height:r.height,top:r.top,bottom:r.bottom,dpr:devicePixelRatio,hittable:hit===element||hit?.closest?.("#next-workflow-canvas")===element}})()');
  assert.ok(canvasAccess.width>=320&&canvasAccess.height>=250&&canvasAccess.top>=0&&canvasAccess.bottom<=560&&canvasAccess.hittable,'Visual graph canvas must be accessible at 780×560 and 150% DPR.');
  await send('Emulation.clearDeviceMetricsOverride');
  counts.graphAuthorMinimumSize=true;
  assert.equal(await evaluate('document.querySelector("#next-workflow-start").disabled'),true,'An unsaved graph cannot run.');
  await evaluate('(()=>{document.querySelector("#next-graph-add-name").value="Researcher";document.querySelector("#next-graph-add-prompt").value="Collect primary evidence with citations.";document.querySelector("#next-graph-add").click();return true})()');
  await until(()=>evaluate('document.querySelectorAll("#next-workflow-outline .next-workflow-node").length===3'),'Added unsaved agent stage');
  const newStageId=await evaluate('([...document.querySelectorAll("#next-workflow-outline .next-workflow-stage-id")].map(node=>node.textContent).find(id=>id.startsWith("agent_"))||null)');
  assert.ok(newStageId,'New graph stage must have a unique visible identifier.');
  assert.equal(fixture.state.postedWorkflows.length,graphWrites);
  assert.equal(await evaluate('document.querySelector("#next-graph-readiness").dataset.ready'),'false','Disconnected stage cannot run.');
  await until(()=>evaluate('Boolean([...document.querySelectorAll("#next-workflow-canvas [data-node]")].find(n=>n.getAttribute("data-node")==='+JSON.stringify(newStageId)+'))'),'New stage visible in canvas');
  const canvasStartX=await evaluate('Number([...document.querySelectorAll("#next-workflow-canvas [data-node]")].find(n=>n.getAttribute("data-node")==='+JSON.stringify(newStageId)+')?.dataset.x)');
  await evaluate('(()=>{const stage=[...document.querySelectorAll("#next-workflow-canvas [data-node]")].find(n=>n.getAttribute("data-node")==='+JSON.stringify(newStageId)+');stage.focus();stage.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true}));return true})()');
  await until(()=>evaluate('document.querySelector("#next-workflow-edit-node")?.value==='+JSON.stringify(newStageId)),'Canvas stage selection opens the corresponding editor stage');
  await evaluate('(()=>{const stage=[...document.querySelectorAll("#next-workflow-canvas [data-node]")].find(n=>n.getAttribute("data-node")==='+JSON.stringify(newStageId)+');stage.focus();stage.dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowLeft",bubbles:true}));return true})()');
  await until(()=>evaluate('Number([...document.querySelectorAll("#next-workflow-canvas [data-node]")].find(n=>n.getAttribute("data-node")==='+JSON.stringify(newStageId)+')?.dataset.x)<'+JSON.stringify(canvasStartX)),'Canvas keyboard arrow moves draft stage');
  assert.equal(await evaluate('document.activeElement?.getAttribute("data-node")'),newStageId,'Canvas rerender must retain keyboard focus for repeated arrow movement.');
  assert.equal(await evaluate('document.querySelector("#next-workflow-edit-draft-lock")?.hidden'),false,'Unsaved graph should lock the separate stage metadata editor.');
  assert.equal(fixture.state.postedWorkflows.length,graphWrites,'Canvas keyboard movement must not auto-save.');
  const canvasDragStart=await evaluate('(()=>{const stage=[...document.querySelectorAll("#next-workflow-canvas [data-node]")].find(n=>n.getAttribute("data-node")==='+JSON.stringify(newStageId)+');stage.scrollIntoView({block:"center"});const r=stage.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2,position:Number(stage.dataset.x)}})()');
  await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:canvasDragStart.x,y:canvasDragStart.y,button:'none'});
  await send('Input.dispatchMouseEvent',{type:'mousePressed',x:canvasDragStart.x,y:canvasDragStart.y,button:'left',clickCount:1});
  await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:canvasDragStart.x-42,y:canvasDragStart.y+23,button:'left'});
  await send('Input.dispatchMouseEvent',{type:'mouseReleased',x:canvasDragStart.x-42,y:canvasDragStart.y+23,button:'left',clickCount:1});
  await until(()=>evaluate('Number([...document.querySelectorAll("#next-workflow-canvas [data-node]")].find(n=>n.getAttribute("data-node")==='+JSON.stringify(newStageId)+')?.dataset.x)<'+JSON.stringify(canvasDragStart.position-20)),'Native browser pointer drag updates unsaved stage placement');
  const expectedCanvasX=await evaluate('Number([...document.querySelectorAll("#next-workflow-canvas [data-node]")].find(n=>n.getAttribute("data-node")==='+JSON.stringify(newStageId)+')?.dataset.x)');
  assert.equal(fixture.state.postedWorkflows.length,graphWrites,'Pointer drag must not save before the user chooses Save graph.');
  counts.workflowCanvasStageMoved=true;
  await evaluate('(()=>{const canvas=document.querySelector("#next-workflow-canvas"),node=id=>[...canvas.querySelectorAll("[data-node]")].find(n=>n.getAttribute("data-node")===id),activate=id=>node(id).dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true})),link=()=>document.querySelector("#next-canvas-link").click();link();activate("input");activate('+JSON.stringify(newStageId)+');link();activate('+JSON.stringify(newStageId)+');activate("output");return true})()');
  await until(()=>evaluate('document.querySelectorAll("#next-workflow-canvas [data-edge-source]").length===3'),'Canvas keyboard connection mode added both edges');
  await evaluate('(()=>{const edge=document.querySelector("#next-workflow-canvas [data-edge-source=input][data-edge-target=output]");edge.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true}));return true})()');
  await until(()=>evaluate('document.querySelector("#next-canvas-unlink")?.disabled===false'),'Selected canvas connection is ready for unlink action');
  await evaluate('document.querySelector("#next-canvas-unlink").click();true');
  await until(()=>evaluate('document.querySelectorAll("#next-workflow-canvas [data-edge-source]").length===2'),'Canvas remove-connection action removed only selected edge');
  counts.workflowCanvasConnectionsEdited=true;
  await until(()=>evaluate('document.querySelector("#next-graph-readiness")?.dataset.ready==="true" && document.querySelectorAll("#next-workflow-connections .next-workflow-link").length===2'),'Completed unsaved workflow graph');
  await evaluate('document.querySelector(".next-tab[data-space=settings]").click();true');
  await until(()=>evaluate('Boolean(document.querySelector("#next-settings-model"))'),'Settings during new graph draft');
  await evaluate('document.querySelector(".next-tab[data-space=activity]").click();true');
  await until(()=>evaluate('document.querySelector("#next-workflow-choice")?.value==='+JSON.stringify(newGraphId)+' && document.querySelector("#next-graph-readiness")?.dataset.ready==="true"'),'New graph draft survives navigation');
  assert.equal(fixture.state.postedWorkflows.length,graphWrites,'Navigation must not persist a workflow draft.');
  await evaluate('document.querySelector("#next-graph-save").click();document.querySelector("#next-graph-save").click();true');
  await until(()=>fixture.state.postedWorkflows.length===graphWrites+1,'Explicit new graph saved exactly once');
  const persistedGraph=fixture.state.workflows.find(item=>item.id===newGraphId);
  assert.ok(persistedGraph,'New workflow must be available in the saved catalog.');
  assert.deepEqual(persistedGraph.nodes.map(row=>row.type),['input','output','agent']);
  assert.deepEqual(persistedGraph.edges.map(row=>[row.source,row.target]),[['input',newStageId],[newStageId,'output']]);
  assert.equal(persistedGraph.nodes.find(item=>item.id===newStageId).prompt,'Collect primary evidence with citations.');
  assert.equal(persistedGraph.nodes.find(item=>item.id===newStageId).x,expectedCanvasX,'Canvas stage placement must persist only after explicit Save graph.');
  await until(()=>evaluate('document.querySelector("#next-graph-feedback")?.textContent==="Workflow graph saved."'),'Graph save receipt shown');
  await evaluate('(()=>{const task=document.querySelector("#next-workflow-prompt");task.value="Run this research workflow";task.dispatchEvent(new Event("input",{bubbles:true}));return true})()');
  assert.equal(await evaluate('document.querySelector("#next-workflow-start").disabled'),false,'A saved connected workflow with explicit task instructions must be runnable.');
  counts.workflowGraphAuthored=true;
  // The independent backend graph can change while this editor is open.
  // A stale write must be rejected, not retried or merged silently.
  await evaluate('(()=>{document.querySelector("#next-graph-source").value="input";document.querySelector("#next-graph-target").value="output";document.querySelector("#next-graph-connect").click();return true})()');
  await until(()=>evaluate('document.querySelectorAll("#next-workflow-connections .next-workflow-link").length===3'),'Unsaved connection in the editor');
  persistedGraph.description='Independently updated by another client';
  await evaluate('document.querySelector("#next-graph-save").click();true');
  await until(()=>evaluate('document.querySelector("#next-graph-feedback")?.textContent.includes("changed since editing began")'),'Stale graph conflict blocked');
  assert.equal(fixture.state.postedWorkflows.length,graphWrites+1);
  assert.equal(fixture.state.workflows.find(item=>item.id===newGraphId).edges.length,2,'A stale write cannot replace the independent backend graph.');
  await evaluate('document.querySelector("#next-graph-discard").click();true');
  // Discarding a second, entirely unsaved new graph must remove it from the
  // local selector and leave previously saved work untouched.
  await evaluate('document.querySelector("#next-workflow-new").click();true');
  const unsavedGraphId=await until(()=>evaluate('(()=>{const id=document.querySelector("#next-workflow-choice")?.value;return id?.startsWith("workflow_")&&id!=='+JSON.stringify(newGraphId)+'?id:null})()'),'Second local new graph draft');
  await evaluate('(()=>{document.querySelector("#next-graph-add-name").value="Temporary stage";document.querySelector("#next-graph-add-prompt").value="Not saved";document.querySelector("#next-graph-add").click();return true})()');
  await until(()=>evaluate('document.querySelectorAll("#next-workflow-canvas [data-node]").length===3'),'Temporary stage drawn on new graph canvas');
  await evaluate('(()=>{const stage=[...document.querySelectorAll("#next-workflow-canvas [data-node]")].find(node=>node.dataset.node.startsWith("agent_"));stage.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true}));return true})()');
  await until(()=>evaluate('document.querySelector("#next-canvas-remove-node")?.disabled===false'),'Selected draft stage can be removed');
  await evaluate('document.querySelector("#next-canvas-remove-node").click();true');
  await until(()=>evaluate('document.querySelectorAll("#next-workflow-canvas [data-node]").length===2'),'Canvas stage removal returns to initial graph');
  assert.equal(fixture.state.postedWorkflows.length,graphWrites+1,'Removing an unsaved stage must not issue a write.');
  counts.workflowCanvasStageRemoved=true;
  await evaluate('document.querySelector("#next-graph-discard").click();true');
  await until(()=>evaluate('document.querySelector("#next-workflow-choice")?.value!=='+JSON.stringify(unsavedGraphId)),'Unsent new graph removed');
  assert.equal(fixture.state.postedWorkflows.length,graphWrites+1);
  await evaluate('(()=>{const selector=document.querySelector("#next-workflow-choice");selector.value="sample-workflow";selector.dispatchEvent(new Event("change",{bubbles:true}));return true})()');
  await until(()=>evaluate('document.querySelector("#next-workflow-choice")?.value==="sample-workflow"'),'Original saved workflow selected after graph authoring');
  counts.workflowGraphConflictBlocked=true;
  await exerciseTaskManagement({evaluate,send,until,fixture,counts});

  await evaluate('document.querySelector(".next-tab[data-space=settings]").click(); true');
  await until(()=>evaluate('Boolean(document.querySelector("#next-settings-model"))'),'Settings workspace');
  counts.settings=true;
  await until(()=>evaluate('Boolean(document.querySelector("#next-runtime-effort option[value=high]"))'),'Runtime preference choices');
  await evaluate('document.querySelector("#next-runtime-verbosity").value="detailed";document.querySelector("#next-runtime-settings-form").requestSubmit();document.querySelector("#next-execution-limit").value="3";document.querySelector("#next-execution-form").requestSubmit();true');
  await until(()=>fixture.state.settingsMutations.some(item=>item.path==='/api/runtime/settings'),'Runtime preferences saved');
  await until(()=>fixture.state.settingsMutations.some(item=>item.path==='/api/execution/settings'),'Rapid independent settings save');
  assert.equal(fixture.state.runtimeSettings.verbosity,'detailed');
  // The execution save was already submitted alongside the runtime save.
  assert.equal(fixture.state.settingsMutations.filter(item=>item.path==='/api/runtime/settings').length,1);
  assert.equal(fixture.state.settingsMutations.filter(item=>item.path==='/api/execution/settings').length,1);
  assert.equal(fixture.state.executionSettings.maxConcurrentRuns,3);
  counts.runtimeAndConcurrency=true;
  assert.equal(fixture.state.settingsPanelRequests.some(item=>/\/api\/(?:identity|providers|connections|codex)/.test(item)),false,
    'General Settings must not fetch inactive editors or catalogs.');
  assert.deepEqual(await evaluate('["default","codex","fixture::model"].map(value=>Boolean([...document.querySelector("#next-settings-model").options].find(option=>option.value===value)))'),[true,true,true]);
  await evaluate('(()=>{const model=document.querySelector("#next-settings-model");window.__settingsModelOption=[...model.options].find(option=>option.value==="codex");model.value="codex";model.dispatchEvent(new Event("change",{bubbles:true}));return true})()');
  fixture.state.status.execution.activeCount=17;fixture.send({type:'runtime.status',data:fixture.state.status});
  await until(()=>evaluate('document.querySelector("#next-settings-status").textContent.includes("17 active")'),'Settings receives newer runtime status');
  assert.equal(await evaluate('document.querySelector("#next-settings-model").value==="codex" && [...document.querySelector("#next-settings-model").options].includes(window.__settingsModelOption)'),true,
    'Status keeps the unsaved default-model choice and its native option node.');
  const beforeModelWrites=fixture.state.settingsMutations.filter(item=>item.path==='/api/models/default').length;
  await evaluate('document.querySelector("#next-settings-save-model").click();document.querySelector("#next-settings-save-model").click();true');
  await until(()=>fixture.state.settingsMutations.filter(item=>item.path==='/api/models/default').length===beforeModelWrites+1,'Default model saved once');
  await until(()=>evaluate('document.querySelector("#next-settings-save-model").disabled===false'),'Default model save settled');
  assert.equal(fixture.state.settingsMutations.filter(item=>item.path==='/api/models/default').at(-1).body.model,'codex');
  await evaluate('(()=>{const model=document.querySelector("#next-settings-model");model.value="fixture::model";model.dispatchEvent(new Event("change",{bubbles:true}));document.querySelector("#next-settings-save-model").click();return true})()');
  await until(()=>fixture.state.settingsMutations.filter(item=>item.path==='/api/models/default').length===beforeModelWrites+2,'Fixture default restored');
  await until(()=>evaluate('document.querySelector("#next-settings-save-model").disabled===false'),'Fixture default settled');
  fixture.state.status.execution.activeCount=1;fixture.send({type:'runtime.status',data:fixture.state.status});counts.settingsDefaults=true;
  await exerciseIdentitySettings({evaluate,send,until,fixture,counts});
  await exerciseProviderSettings({evaluate,send,until,fixture,counts});
  await exerciseConnectionSettings({evaluate,send,until,fixture,counts});
  await exerciseConnectionImportSettings({evaluate,send,until,fixture,counts});
  await evaluate('document.querySelector("#next-settings-section-general").click();true');
  await evaluate('document.querySelector(".next-tab[data-space=knowledge]").click();true');
  await until(()=>evaluate('document.querySelectorAll("[data-knowledge-id]").length===80'),'Bounded Knowledge library');
  assert.equal(fixture.state.knowledgeMutations.length,0,'Opening Knowledge cannot write saved entries.');
  await evaluate('(()=>{const field=document.querySelector("#next-knowledge-query");field.value="Saved fixture memory";field.dispatchEvent(new Event("input",{bubbles:true}));return true})()');
  await until(()=>evaluate('document.querySelectorAll("[data-knowledge-id]").length===1 && Boolean(document.querySelector("[data-knowledge-id=memory-fixture]"))'),'Full-library Knowledge search');
  await evaluate('document.querySelector("[data-knowledge-id=memory-fixture]").click();true');
  await until(()=>evaluate('document.querySelector("#next-knowledge-content")?.value==="Original memory content"'),'Knowledge detail loaded on demand');
  const knowledgeStore=await fixture.knowledge();
  assert.equal(await evaluate('document.querySelector("#next-knowledge-memory-type").value'),'fact');
  await evaluate('(()=>{const field=document.querySelector("#next-knowledge-content");field.value="Memory edited in V2";field.dispatchEvent(new Event("input",{bubbles:true}));document.querySelector(".next-tab[data-space=settings]").click();return true})()');
  await until(()=>evaluate('document.querySelector(".next-tab[data-space=settings]").getAttribute("aria-selected")==="true"'),'Leave Knowledge with unsaved draft');
  await evaluate('document.querySelector(".next-tab[data-space=knowledge]").click();true');
  fixture.send({type:'knowledge.updated',data:knowledgeStore.status()});
  await evaluate('document.querySelector("#next-knowledge-refresh").click();true');
  await until(()=>evaluate('document.querySelector("#next-knowledge-content")?.value==="Memory edited in V2"'),'Knowledge draft retained across navigation and refresh');
  assert.equal(knowledgeStore.get('memory-fixture').content,'Original memory content');
  await evaluate('document.querySelector("#next-knowledge-save").click();true');
  await until(()=>knowledgeStore.get('memory-fixture').revision===2,'Knowledge save persisted');
  assert.equal(knowledgeStore.get('memory-fixture').content,'Memory edited in V2');
  assert.deepEqual(knowledgeStore.get('memory-fixture').sources,['https://example.test/evidence']);
  assert.deepEqual(knowledgeStore.get('memory-fixture').relations,[{type:'supports',targetId:'memory-related'}]);
  await until(()=>evaluate('document.querySelector("#next-knowledge-history")?.disabled===false && document.querySelector("#next-knowledge-editor-info")?.textContent.includes("Saved revision 2")'),'Knowledge save settled');
  await evaluate('document.querySelector("#next-knowledge-history").click();true');
  await until(()=>evaluate(`Boolean(document.querySelector('[data-knowledge-revision="1"]'))`),'Knowledge revisions loaded');
  await evaluate(`document.querySelector('[data-knowledge-revision="1"]').click();true`);
  assert.equal(await evaluate('document.querySelector("#next-knowledge-revision-content").value'),'Original memory content');
  await evaluate('document.querySelector("#next-knowledge-restore").click();true');
  await until(()=>knowledgeStore.get('memory-fixture').revision===3,'Knowledge revision restored');
  await until(()=>evaluate('document.querySelector("#next-knowledge-content")?.value==="Original memory content"'),'Restored content displayed');
  await evaluate('(()=>{const field=document.querySelector("#next-knowledge-content");field.value="Keep this conflicting draft";field.dispatchEvent(new Event("input",{bubbles:true}));return true})()');
  await knowledgeStore.upsert({...knowledgeStore.get('memory-fixture'),content:'Changed by another writer',expectedRevision:3},{source:'user'});
  fixture.send({type:'knowledge.updated',data:knowledgeStore.status()});
  const beforeConflict=fixture.state.knowledgeMutations.length;
  await evaluate('document.querySelector("#next-knowledge-save").click();true');
  await until(()=>evaluate('document.querySelector("#next-knowledge-detail")?.textContent.includes("changed while you were reading")'),'Stale Knowledge save rejected');
  assert.equal(fixture.state.knowledgeMutations.length,beforeConflict);
  assert.equal(await evaluate('document.querySelector("#next-knowledge-content").value'),'Keep this conflicting draft');
  await evaluate('document.querySelector("#next-knowledge-discard").click();true');
  await until(()=>evaluate('document.querySelector("#next-knowledge-content")?.value==="Changed by another writer"'),'Explicit Knowledge discard reloads current revision');
  await evaluate('document.querySelector("#next-knowledge-delete").click();true');
  await until(()=>knowledgeStore.history('memory-fixture').deleted===true,'Knowledge soft deletion');
  await evaluate('(()=>{const field=document.querySelector("#next-knowledge-state");field.value="deleted";field.dispatchEvent(new Event("change",{bubbles:true}));return true})()');
  await until(()=>evaluate('Boolean(document.querySelector("[data-knowledge-id=memory-fixture]"))'),'Deleted Knowledge visible for recovery');
  await evaluate('document.querySelector("[data-knowledge-id=memory-fixture]").click();true');
  await until(()=>evaluate(`Boolean(document.querySelector('[data-knowledge-revision="4"]'))`),'Deleted Knowledge history available');
  await evaluate(`document.querySelector('[data-knowledge-revision="4"]').click();document.querySelector("#next-knowledge-restore").click();true`);
  await until(()=>!knowledgeStore.history('memory-fixture').deleted,'Deleted Knowledge restored');
  await evaluate('(()=>{const kind=document.querySelector("#next-knowledge-kind"),state=document.querySelector("#next-knowledge-state"),query=document.querySelector("#next-knowledge-query");kind.value="skill";kind.dispatchEvent(new Event("change",{bubbles:true}));state.value="active";state.dispatchEvent(new Event("change",{bubbles:true}));query.value="";query.dispatchEvent(new Event("input",{bubbles:true}));document.querySelector("#next-knowledge-new").click();return true})()');
  await evaluate('(()=>{for(const [id,value] of [["title","Created V2 skill"],["content","Use the browser to access email."]]){const field=document.querySelector("#next-knowledge-"+id);field.value=value;field.dispatchEvent(new Event("input",{bubbles:true}));}document.querySelector("#next-knowledge-save").click();return true})()');
  await until(()=>knowledgeStore.list({kind:'skill',query:'Created V2 skill'}).length===1,'New skill created in actual Knowledge store');
  await send('Emulation.setDeviceMetricsOverride',{width:780,height:560,deviceScaleFactor:1.5,mobile:false});
  assert.equal(await evaluate('document.querySelector("#next-knowledge-root").scrollWidth<=document.querySelector("#next-knowledge-root").clientWidth+1'),true,'Knowledge must fit the desktop minimum width.');
  if(process.env.BLACKICE_NEXT_KNOWLEDGE_SCREENSHOT_PATH){
    await evaluate('document.querySelector("#next-toast").replaceChildren();true');
    const capture=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
    await writeFile(process.env.BLACKICE_NEXT_KNOWLEDGE_SCREENSHOT_PATH,Buffer.from(capture.data,'base64'));
  }
  await send('Emulation.clearDeviceMetricsOverride');
  counts.knowledge={boundedList:80,createSkill:true,save:true,metadataKept:true,draftKept:true,conflict:true,revisionRestore:true,deletedRecovery:true};
  await exerciseKnowledgeManagement({evaluate,send,until,fixture,counts});
  await evaluate('document.querySelector(".next-tab[data-space=chat]").click(); true');
  await until(()=>evaluate('Boolean(document.querySelector("#next-chat-input"))'),'Chat return');
  assert.equal(await evaluate('document.querySelector("#next-chat-input").value'),'Still typing during stream','Unsaved chat draft must survive switching through five workspaces.');
  counts.draftKept=true;
  await evaluate('document.querySelector("#next-chat-new").click();document.querySelector("#next-chat-model").value="codex-test";document.querySelector("#next-chat-model").dispatchEvent(new Event("change",{bubbles:true}));true');
  await until(()=>evaluate('Boolean(document.querySelector("#next-chat-effort option[value=high]"))'),'Supported model reasoning choices');
  await evaluate('document.querySelector("#next-chat-effort").value="high";document.querySelector("#next-chat-effort").dispatchEvent(new Event("change",{bubbles:true}));document.querySelector("#next-chat-tier").value="fast";document.querySelector("#next-chat-tier").dispatchEvent(new Event("change",{bubbles:true}));true');
  assert.equal(await evaluate('document.querySelector("#next-chat-tier").value'),'fast');
  await evaluate('document.querySelector("#next-chat-input").value="Persist this draft";document.querySelector("#next-chat-input").dispatchEvent(new Event("input",{bubbles:true}));true');
  await sleep(400);
  await evaluate('document.documentElement.dataset.smokePreviousDocument="true"; true');
  await send('Page.reload');
  await until(()=>evaluate('document.documentElement.dataset.smokePreviousDocument !== "true" && document.readyState==="complete" && Boolean(document.querySelector("#next-chat-form")) && document.querySelector("#next-chat-input")?.value === "Persist this draft" && !document.querySelector("#next-chat-send").disabled'),'Draft survives shell reload');
  counts.draftReloaded=true;
  assert.deepEqual(await evaluate('(()=>({model:document.querySelector("#next-chat-model").value,effort:document.querySelector("#next-chat-effort").value,tier:document.querySelector("#next-chat-tier").value}))()'),{model:'codex-test',effort:'high',tier:'fast'});
  counts.modelOptionsPersisted=true;
  await evaluate('document.querySelector("#next-chat-input").value="Create a new task";document.querySelector("#next-chat-input").dispatchEvent(new Event("input",{bubbles:true}));document.querySelector("#next-chat-form").requestSubmit(); true');
  await until(()=>fixture.calls.some(call=>call==='POST /api/runs'),'Send task to current API');
  counts.send=true;
  const started=fixture.state.postedWorkflows.at(-1);
  const agent=started?.nodes?.find(node=>node.id==='agent');
  assert.equal(agent?.model,'codex-test');
  assert.equal(agent?.effort,'high');
  assert.equal(agent?.serviceTier,'fast');
  counts.reasoningAndSpeedSent=true;
  await evaluate('document.querySelector(".next-tab[data-space=activity]").click();true');
  await until(()=>evaluate('Boolean(document.querySelector("#next-activity-tab-workflows"))'),'Activity views mounted after reload');
  await evaluate('document.querySelector("#next-activity-tab-workflows").click();document.querySelector("#next-workflow-launch").open=true;true');
  await until(()=>evaluate('Boolean(document.querySelector("#next-workflow-outline .next-workflow-node"))'),'Workflow execution ready');
  // Chat may have just saved its own mission workflow. Explicitly choose the
  // saved fixture workflow instead of relying on an incidental list order.
  await evaluate('(()=>{const choice=document.querySelector("#next-workflow-choice");choice.value="sample-workflow";choice.dispatchEvent(new Event("change",{bubbles:true}));const prompt=document.querySelector("#next-workflow-prompt");prompt.value="Workflow acceptance run";prompt.dispatchEvent(new Event("input",{bubbles:true}));return true})()');
  await until(()=>evaluate('document.querySelector("#next-workflow-choice")?.value==="sample-workflow" && document.querySelector("#next-workflow-start")?.disabled===false'),'Selected saved workflow graph loaded on demand');
  await evaluate('document.querySelector("#next-workflow-form").requestSubmit();true');
  await until(()=>fixture.state.submittedRuns.length>=2,'Saved workflow submitted to unchanged API');
  assert.equal(fixture.state.submittedRuns.at(-1).workflow.id,'sample-workflow');
  assert.equal(fixture.state.submittedRuns.at(-1).input.task,'Workflow acceptance run');
  await until(()=>evaluate('document.querySelector("#next-workflow-run-details")?.textContent.includes("new-sample-run")'),'Workflow run controls');
  assert.equal(fixture.state.workflowFullListRequests,0,'All V2 workflow operations must avoid full graph-catalog startup fetches');
  counts.workflowRun=true;
  // Capture a reproducible screenshot for design QA without ever opening a GUI.
  await evaluate('document.querySelector(".next-tab[data-space=chat]").click(); true');
  const shot=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
  const location=join(dir,'next-screen.png');
  await writeFile(location,Buffer.from(shot.data,'base64'));
  console.log('PASS:',JSON.stringify(counts),'static_requests='+fixture.calls.length,
    'no_bulk_history=true','screen_bytes='+Buffer.from(shot.data,'base64').length);
  if(failures.length)console.warn('Renderer console issues:',failures.slice(0,5).join(' | '));
  assert.equal(failures.length,0,failures.join(' | '));
}catch(error){console.error('FAIL',error.stack||error);console.error('RECENT_REQUESTS',fixture.calls.slice(-35));console.error('RENDER_ERRORS',failures);try{console.error('STARTUP_STATE',await evaluate('({stage:document.querySelector("#next-stage")?.innerText?.slice(0,1300),fatal:document.querySelector("#next-fatal")?.innerText?.slice(0,700),toast:document.querySelector("#next-toast")?.innerText?.slice(0,700),html:document.querySelector("#next-stage")?.innerHTML?.slice(0,900)})'));}catch{}try{console.error('DOM_STATE',await evaluate('({space:document.querySelector(".next-tab[aria-selected=true]")?.dataset.space,browserText:document.querySelector("#next-browser-preview")?.textContent,browserError:document.querySelector("#next-browser-status")?.textContent})'));}catch{}process.exitCode=1;}
finally{
  try{await send('Browser.close');}catch{}
  try{ws?.close();}catch{}
  try{processHandle?.kill();}catch{}
  fixture.server.closeAllConnections();
  await new Promise(resolve=>fixture.server.close(resolve));
  await fixture.closeKnowledge();
  await sleep(180);
  await rm(dir,{recursive:true,force:true,maxRetries:3,retryDelay:100}).catch(()=>{});
}
