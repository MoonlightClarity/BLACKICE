import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {readFile,writeFile,mkdtemp,mkdir,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as sleep} from 'node:timers/promises';
const root=process.cwd(),out=path.join(root,'verification','planning-ui');
await mkdir(out,{recursive:true});
let html='<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/public/next/base.css"><link rel="stylesheet" href="/public/next/planning-browser.css"><style>html,body{margin:0;height:100%;overflow:hidden}#app{height:100vh;width:100%;min-width:0}</style></head><body><div id="app"></div><script type="module">'+"\nimport {createPlanningBrowser} from '/public/next/workspaces/planning-browser.mjs';\nimport {PLANNING_MODULE_TEMPLATES} from '/public/planning-browser-model.mjs';\nconst stages=['inference','feasibility','plan','think','respond'],kinds=['inference','viability','plan','think','respond'];\nconst title='Prepare a source-backed launch review for the product team';\nconst doc={id:'review',conversationId:'review-chat',title,objective:'Compare customer feedback and release evidence, identify open risks, and deliver a clear launch recommendation.',revision:12,edges:[],sources:[],responses:[],assignments:[],history:[],attempts:[{id:'attempt-plan',nodeId:'plan',status:'failed',model:'GPT-6-Luna',message:'The recorded planning response needs a corrected evidence field.'}],nodes:[{id:'cycle',kind:'cycle',title,prompt:'Complete a careful launch review.',parentId:null,revision:1,readiness:{state:'empty'}},...stages.map((stage,i)=>({id:stage,kind:kinds[i],cycleId:'cycle',parentId:'cycle',title:stage+' · '+title,prompt:'Complete the '+stage+' stage using the supplied source records.',revision:1,readiness:{state:i<2?'ready':i===2?'failed':'empty'},...(i<2?{response:{id:'response-'+stage,revision:1,values:{interpretation:'Review launch readiness using customer feedback and the release checklist.',userBenefit:'Make the launch decision easier without hiding unresolved risks.',desiredOutcomes:'A concise recommendation with sources and clear next steps.',delegatedWork:'Compare the supplied records and draft the review.',unwantedOutcomes:'Unverified claims or missing critical risks.',constraints:'Use the supplied records and retain uncertain findings.',route:'The feedback and release checklist are available in the supplied materials.'},grounding:[],openQuestions:[],challengeResponses:[]}}:{})}))],cycles:[{id:'cycle',title,objective:'Deliver a supported launch recommendation.',pipelineVersion:2,stageNodeIds:Object.fromEntries(stages.map(s=>[s,s])),depth:0,planningExecutionMode:'automatic',state:'failed',planRevision:1,planResponseId:null,summary:'The planning response needs attention before the next stage can run.'}]};\nlet live=false;const listeners=new Set();window.mutations=[];\nconst api=async(route,method='GET')=>{if(method!=='GET'){window.mutations.push({route,method});throw Error('Read-only preview');}if(route==='/api/planning-browser')return {conversations:[{id:'review-chat',title,status:live?'running':'failed',settled:!live,state:'active',source:'conversation',runId:'review-run'},{id:'notes-chat',title:'Summarize the customer interviews',status:'completed',settled:true,state:'active'},{id:'archive-chat',title:'Previous release retrospective',status:'completed',settled:true,state:'archived'}],requests:[{id:'review',conversationId:'review-chat',title,revision:12,summary:{running:live?1:0}},{id:'notes',conversationId:'notes-chat',title:'Summarize customer interviews',summary:{running:0}},{id:'archive',conversationId:'archive-chat',title:'Previous release retrospective',summary:{running:0}}],templates:PLANNING_MODULE_TEMPLATES,runtime:{defaultModel:'GPT-6-Luna'}};return structuredClone({...doc,attempts:doc.attempts.map(a=>({...a,status:live?'running':'failed'}))});};\nconst workspace=createPlanningBrowser({mount:document.querySelector('#app'),api,events:{subscribe:f=>{listeners.add(f);return()=>listeners.delete(f)}},getStatus:()=>({models:[{model:'GPT-6-Luna',name:'GPT-6-Luna'}],defaultModel:'GPT-6-Luna'})});workspace.enter();\nwindow.setPreviewRunning=value=>{live=value;for(const fn of listeners)fn({type:'planning.browser.updated',data:{requestId:'review'}});};\nwindow.previewWorkspace=workspace;\n"+'</script></body></html>';
// Use the real shipped shell and complete stylesheet cascade, not a CSS-only mock.
const production = await readFile(path.join(root,'public','next','index.html'),'utf8');
const styles = production.match(/<link[^>]+rel="stylesheet"[^>]*>/g).join('');
const topbar = production.match(/<header class="next-topbar">[\s\S]*?<\/header>/)[0]
  .replace('data-space="chat" role="tab" aria-selected="true"', 'data-space="chat" role="tab" aria-selected="false"')
  .replace('data-space="planning" role="tab" aria-selected="false"', 'data-space="planning" role="tab" aria-selected="true"')
  .replace(/(<span id="next-health"[^>]*>)[^<]*/, '$1UI preview');
html = html.replace(/<link[^>]+rel="stylesheet"[^>]*>/g, '').replace('<style>', styles + '<style>');
html = html.replace('<div id="app"></div>', '<div class="next-shell">' + topbar + '<main class="next-content" id="next-stage"><section class="next-space"><div id="app"></div></section></main></div>');
html = html.replace('#app{height:100vh;', '#app{height:100%;');
const mime={'.mjs':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.woff2':'font/woff2','.ttf':'font/ttf','.png':'image/png'};
const server=createServer(async(req,res)=>{try{if(req.url==='/ui'){res.setHeader('Content-Type','text/html');res.end(html);return;}const requested=decodeURIComponent(new URL(req.url,'http://localhost').pathname);const file=path.resolve(root,'.'+(requested.startsWith('/public/')?requested:'/public'+requested));if(!file.startsWith(root+path.sep)||!file.includes(path.sep+'public'+path.sep)){res.writeHead(404);res.end();return;}res.setHeader('Content-Type',mime[path.extname(file)]||'application/octet-stream');res.end(await readFile(file));}catch{res.writeHead(404);res.end();}});
let child,ws,nextId=1;const pending=new Map(),errors=[],checks=[];
const until=async(fn,label)=>{const end=Date.now()+15000;let last;while(Date.now()<end){try{const x=await fn();if(x)return x;}catch(e){last=e;}await sleep(75);}throw Error(label+' timed out '+(last?.message||''));};
const send=(method,params={})=>new Promise((resolve,reject)=>{const id=nextId++,timer=setTimeout(()=>{pending.delete(id);reject(Error(method+' timed out'));},10000);pending.set(id,{resolve:r=>{clearTimeout(timer);resolve(r)},reject:e=>{clearTimeout(timer);reject(e)}});ws.send(JSON.stringify({id,method,params}));});
const evaluate=async expression=>{const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value;};
const click=selector=>evaluate('document.querySelector('+JSON.stringify(selector)+').click();true');
const filter=value=>evaluate('(()=>{const e=document.querySelector("#pb-conversation-view");e.value='+JSON.stringify(value)+';e.dispatchEvent(new Event("change",{bubbles:true}));return true;})()');
const shot=async(name,width,height)=>{await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});await sleep(150);const bounds=await evaluate('({width:innerWidth,scroll:document.documentElement.scrollWidth,body:document.body.scrollWidth})');assert.ok(bounds.scroll<=width+1&&bounds.body<=width+1,JSON.stringify(bounds));const navigation=await evaluate('(()=>{const box=document.querySelector(".next-tabs").getBoundingClientRect();return {top:box.top,bottom:box.bottom};})()');assert.ok(navigation.top>=0&&navigation.bottom<=65,"Workspace navigation must remain fully visible: "+JSON.stringify(navigation));const r=await send('Page.captureScreenshot',{format:'jpeg',quality:80,captureBeyondViewport:false});await writeFile(path.join(out,name+'.jpg'),Buffer.from(r.data,'base64'));await writeFile(path.join(out,name+'.base64'),r.data);checks.push({name,width,height,bounds});};

const themeChecks={};
const addThemeReferences=()=>evaluate('(()=>{const refs=document.createElement("div");refs.id="theme-references";refs.style.cssText="position:fixed;left:-10000px;top:0;width:220px;pointer-events:none";refs.innerHTML=\'<button id="theme-button">Control</button><button id="theme-primary" class="next-primary">Primary</button><select id="theme-select"><option>Saved</option></select><div id="theme-sidebar" class="next-chat-sidebar"></div><div id="theme-header" class="next-chat-head"></div><div id="theme-card" class="next-card"></div><button id="theme-selected" class="next-conversation" aria-current="true"><strong class="next-conversation-title">Selected</strong><small class="next-conversation-meta">Saved</small></button>\';document.body.append(refs);return true})()');
const readPalette=()=>evaluate('(()=>{const read=q=>{const e=document.querySelector(q);if(!e)return null;const c=getComputedStyle(e);return {background:c.backgroundColor,image:c.backgroundImage,color:c.color,border:c.borderTopColor}};return {primary:read(".pb-primary"),primaryReference:read("#theme-primary"),button:read(".pb-header button"),buttonReference:read("#theme-button"),field:read(".pb-rail .pb-input"),fieldReference:read("#theme-select"),sidebar:read(".pb-rail"),sidebarReference:read("#theme-sidebar"),header:read(".pb-header"),headerReference:read("#theme-header"),card:read(".pb-overview-finding"),cardReference:read("#theme-card"),selected:read(".pb-conversation[aria-current=true]"),selectedReference:read("#theme-selected"),selectedReferenceMeta:read("#theme-selected .next-conversation-meta"),selectedMeta:read(".pb-conversation[aria-current=true] small"),selectedPill:read(".pb-conversation[aria-current=true] .pb-pill"),pill:read(".pb-pill"),muted:read(".pb-progress-copy small"),progress:read(".pb-progress-step"),theme:getComputedStyle(document.querySelector(".planning-browser")).getPropertyValue("--planning-theme-version").trim()}})()');
const rgb=value=>(value.match(/[\d.]+/g)||[]).map(Number);
const luminance=value=>{const c=rgb(value).slice(0,3).map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);return c[0]*.2126+c[1]*.7152+c[2]*.0722};
const ratio=(a,b)=>{const x=luminance(a),y=luminance(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05)};
let themeDocument;
const forcePseudo=async(selector,pseudoClasses)=>{themeDocument ||= await send('DOM.getDocument');const node=await send('DOM.querySelector',{nodeId:themeDocument.root.nodeId,selector});await send('CSS.forcePseudoState',{nodeId:node.nodeId,forcedPseudoClasses:pseudoClasses});};
const normalPalette=async()=>{
 await addThemeReferences();const p=await readPalette();assert.equal(p.theme,'1');
 for(const key of ['primary','button'])for(const property of ['background','image','color','border'])assert.equal(p[key][property],p[key+'Reference'][property],key+' shared '+property);
 for(const key of ['sidebar','header','card','selected'])assert.equal(p[key].image,p[key+'Reference'].image,key+' shared surface');
 for(const property of ['background','color'])assert.equal(p.field[property],p.fieldReference[property],'native field '+property);
 const primaryStops=p.primary.image.match(/rgba?\([^)]+\)/g);assert.ok(primaryStops?.length>=2);
 const contrast={primary:Math.min(...primaryStops.map(stop=>ratio(p.primary.color,stop))),muted:ratio(p.muted.color,p.progress.background),pill:ratio(p.pill.color,p.pill.background)};
 for(const [name,value]of Object.entries(contrast))assert.ok(value>=4.5,name+' contrast '+value);
 themeChecks.normal={palette:p,contrast};
 await send('DOM.enable');await send('CSS.enable');
 await forcePseudo('.pb-primary',['hover']);await forcePseudo('#theme-primary',['hover']);const hover=await readPalette();for(const property of ['background','image','color','border'])assert.equal(hover.primary[property],hover.primaryReference[property],'primary hover '+property);await forcePseudo('.pb-primary',[]);await forcePseudo('#theme-primary',[]);
 await forcePseudo('.pb-conversation[aria-current=true]',['hover']);const selectionHover=await readPalette();assert.equal(selectionHover.selected.image,p.selected.image,'Selected navigation keeps its material on hover.');await forcePseudo('.pb-conversation[aria-current=true]',[]);themeChecks.hover=true;
 const inherited=await evaluate('(()=>{const r=document.documentElement;const before=r.getAttribute("style");r.style.setProperty("--panel","rgb(31, 32, 33)");r.style.setProperty("--muted","rgb(220, 220, 220)");r.style.setProperty("--next-primary-background","rgb(210, 180, 140)");r.style.setProperty("--next-primary-foreground","rgb(12, 13, 14)");const result={panel:getComputedStyle(document.querySelector(".pb-progress-step")).backgroundColor,muted:getComputedStyle(document.querySelector(".pb-progress-copy small")).color,primary:getComputedStyle(document.querySelector(".pb-primary")).backgroundColor,primaryText:getComputedStyle(document.querySelector(".pb-primary")).color};if(before===null)r.removeAttribute("style");else r.setAttribute("style",before);return result})()');
 assert.deepEqual(inherited,{panel:'rgb(31, 32, 33)',muted:'rgb(220, 220, 220)',primary:'rgb(210, 180, 140)',primaryText:'rgb(12, 13, 14)'});themeChecks.tokenInheritance=true;
};
const accessiblePalettes=async()=>{
 await click('button[data-page=overview]');
 await send('Emulation.setEmulatedMedia',{features:[{name:'prefers-contrast',value:'more'},{name:'prefers-reduced-transparency',value:'reduce'}]});
 const opaque=await readPalette();for(const key of ['sidebar','header','card','selected'])assert.equal(opaque[key].image,'none',key+' opaque mode');themeChecks.opaque=true;await shot('09-overview-high-contrast',1440,900);
 for(const scheme of ['light','dark']){
  await send('Emulation.setEmulatedMedia',{features:[{name:'forced-colors',value:'active'},{name:'prefers-color-scheme',value:scheme}]});
  const p=await readPalette();for(const property of ['background','image','color','border'])assert.equal(p.primary[property],p.primaryReference[property],'forced '+scheme+' primary '+property);
  assert.equal(p.sidebar.background,p.sidebarReference.background,'forced sidebar');assert.equal(p.header.background,p.headerReference.background,'forced header');assert.equal(p.card.background,p.cardReference.background,'forced card');
  assert.equal(p.selected.background,p.selectedReference.background,'forced selected background');assert.equal(p.selected.color,p.selectedReference.color,'forced selected foreground');assert.equal(p.selectedMeta.color,p.selected.color,'selected metadata contrast in '+scheme);assert.equal(p.selectedReferenceMeta.color,p.selectedReference.color,'shared selected metadata contrast in '+scheme);assert.ok(ratio(p.selectedPill.color,p.selectedPill.background)>=4.5,'selected status pill contrast in '+scheme);
  themeChecks['forced-'+scheme]=p;await shot('10-overview-forced-'+scheme,1440,900);
 }
 await click('[data-overview-node=plan]');await shot('11-step-forced-dark',1440,900);
 await click('[data-view=graph]');await shot('12-graph-forced-dark',1440,900);
 await click('button[data-page=overview]');await click('.pb-more>summary');await shot('13-menu-forced-dark',390,900);
 await send('Emulation.setEmulatedMedia',{features:[]});await send('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
 await click('.pb-more>summary');
};

const directory=await mkdtemp(path.join(tmpdir(),'blackice-planning-ui-'));
try{
await new Promise(r=>server.listen(0,'127.0.0.1',r));const profile=path.join(directory,'edge');await mkdir(profile);
const url='http://127.0.0.1:'+server.address().port+'/ui';
child=spawn(process.env.BLACKICE_TEST_BROWSER||'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--disable-extensions','--disable-background-networking','--disable-sync','--remote-allow-origins=*','--remote-debugging-port=0','--user-data-dir='+profile,'--window-size=1440,1000',url],{stdio:['ignore','ignore','pipe'],windowsHide:true});child.stderr.on('data',()=>{});
const port=await until(async()=>Number((await readFile(path.join(profile,'DevToolsActivePort'),'utf8')).split(/\r?\n/)[0]),'headless browser');
const target=await until(async()=>(await(await fetch('http://127.0.0.1:'+port+'/json/list')).json()).find(x=>x.type==='page'&&x.url===url),'page');
await new Promise((resolve,reject)=>{ws=new WebSocket(target.webSocketDebuggerUrl);ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});ws.addEventListener('message',event=>{const p=JSON.parse(event.data);if(p.id&&pending.has(p.id)){const j=pending.get(p.id);pending.delete(p.id);p.error?j.reject(Error(p.error.message)):j.resolve(p.result);}if(p.method==='Runtime.exceptionThrown')errors.push(p.params.exceptionDetails?.text||'Page exception');});});
await send('Runtime.enable');await send('Page.enable');
await until(()=>evaluate('Boolean(document.querySelector(".pb-overview"))'),'read-first planning overview');
assert.equal(await evaluate('Boolean(document.querySelector(".pb-inspector"))'),false,'Default overview does not render the technical editor.');
assert.equal(await evaluate('document.querySelectorAll(".pb-progress-step").length'),5);
assert.equal(await evaluate('document.querySelector(".pb-intent-panel").open'),false);
await normalPalette();
await shot('01-overview-desktop',1440,900);
await shot('02-overview-tablet',1024,900);
await shot('03-overview-mobile',390,900);
assert.equal(await evaluate('getComputedStyle(document.querySelector(".pb-rail")).display'),'none','Mobile starts with the selected request, not a tall conversation carousel.');
await click('.pb-list-toggle');assert.equal(await evaluate('getComputedStyle(document.querySelector(".pb-rail")).display'),'flex');
await shot('04-mobile-conversations',390,900);await click('.pb-list-toggle');
await shot('05-overview-small-mobile',320,900);
await send('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
await click('[data-overview-node=plan]');
assert.equal(await evaluate('document.querySelector(".pb-request-panel").dataset.page'),'steps');
assert.equal(await evaluate('document.activeElement===document.querySelector(".pb-inspector h3")'),true,'Opening a step moves focus to its heading.');
assert.equal(await evaluate('document.querySelector(".pb-cycle-settings").open'),false,'Model controls are optional while inspecting a stage.');
await shot('06-step-desktop',1440,900);
await shot('07-step-mobile',390,900);
assert.equal(await evaluate('getComputedStyle(document.querySelector(".pb-canvas")).overflowY'),'visible','Mobile list and inspector share one scroll surface.');
await send('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
await click('button[data-page=overview]');assert.equal(await evaluate('Boolean(document.querySelector(".pb-overview"))'),true);
await click('button[data-page=steps]');
await filter('running');assert.equal(await evaluate('document.querySelectorAll(".pb-conversation").length'),0);
assert.equal(await evaluate('document.querySelector(".pb-activity-summary").textContent'),'No work running');
await evaluate('window.setPreviewRunning(true)');
await until(()=>evaluate('document.querySelectorAll(".pb-conversation").length===1&&document.querySelector(".pb-activity-summary").textContent==="1 running"'),'running filter');
await evaluate('window.setPreviewRunning(false)');
await until(()=>evaluate('document.querySelectorAll(".pb-conversation").length===0'),'settled filter');await filter('active');
await click('[data-view=graph]');assert.equal(await evaluate('Boolean(document.querySelector(".pb-graph-node"))'),true);
await click('.pb-more>summary');await click('[data-view=xml]');assert.equal(await evaluate('Boolean(document.querySelector(".pb-program-xml"))'),true);
await shot('08-advanced-xml',1440,900);await click('[data-view=outline]');
await click('[data-action=new-request]');assert.equal(await evaluate('document.querySelector(".pb-create").hidden'),false);
await evaluate('[...document.querySelectorAll(".pb-create button")].find(e=>e.textContent==="Cancel").click();true');
assert.equal(await evaluate('document.querySelector(".pb-create").hidden'),true);
await accessiblePalettes();
const layout=await evaluate('({sheets:document.styleSheets.length,version:getComputedStyle(document.querySelector(".planning-browser")).getPropertyValue("--planning-navigation-version").trim(),top:document.querySelector(".planning-browser").getBoundingClientRect().top})');
assert.equal(layout.version,'3');assert.ok(layout.sheets>=20,'The full shipped CSS stack is loaded.');
assert.equal(layout.top,64,'Planning has no decorative dead space above its content.');
assert.deepEqual(await evaluate('window.mutations'),[]);assert.deepEqual(errors,[]);
await writeFile(path.join(out,'report.json'),JSON.stringify({checks,errors,layout,themeChecks,readOnly:true,syntheticData:true,filterTransitions:true,views:true,cancel:true},null,2));
console.log('PASS '+JSON.stringify({checks,errors,layout,themeModes:Object.keys(themeChecks),readOnly:true}));
}catch(e){console.error(e.stack||e);process.exitCode=1;}
finally{try{await send('Browser.close')}catch{}try{ws?.close()}catch{}await sleep(200);server.closeAllConnections();await new Promise(r=>server.close(r));await rm(directory,{recursive:true,force:true,maxRetries:10,retryDelay:300}).catch(()=>{});}
