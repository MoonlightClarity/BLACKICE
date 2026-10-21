#!/usr/bin/env node
// Opt-in acceptance check against the existing native Neo browser, never a new profile.
import {createServer} from 'node:http';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';
import {ConnectionManager,createConnectionToolHandler} from '../lib/mcp.mjs';
import {createSignedBrowserIntegration} from '../lib/signed-browser.mjs';

const USAGE='node scripts/verify-neo-background.mjs --live-neo [--capture] [--output-dir ABSOLUTE_FRESH_PATH]';
const MAIN_MS=120000,CALL_MS=12000,CAPTURE_MS=20000,CLEANUP_MS=25000,HARD_MS=150000;
class CheckError extends Error{constructor(code,message,stopped=false){super(message);this.code=code;this.stopped=stopped;}}
const ensure=(condition,code,message,stopped=false)=>{if(!condition)throw new CheckError(code,message,stopped);};
const safeError=error=>error instanceof CheckError?{code:error.code,message:error.message}:{code:'STEP_FAILED',message:'The browser check did not complete. Inspect the connection and this report before retrying.'};
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const id=value=>Number.isSafeInteger(value)&&value>=0;

// Neo may expose multiple session handles for one native tab after reconnect.
// Keep this function self-contained: the same checks run inside Neo's SDK below.
function normalizeNeoPages(pages){
  const reject=()=>{const error=new Error('Neo page aliases have incomplete or contradictory native identities.');error.code='NATIVE_ALIAS_CONFLICT';throw error;};
  const validId=value=>Number.isSafeInteger(value)&&value>=0;
  const group=value=>value===undefined||value===null||value===-1||value==='-1'?null:typeof value==='string'&&value.length&&value.trim()===value?value:validId(value)?String(value):reject();
  if(!Array.isArray(pages))reject();
  const tabs=new Map(),targets=new Map(),handles=new Map();
  for(const page of pages){
    if(!page||!validId(page.pageId)||!validId(page.tabId)||!validId(page.windowId)||typeof page.targetId!=='string'||!page.targetId.length||typeof page.url!=='string'||!['mine','user','other-agent'].includes(page.ownership))reject();
    const identity=JSON.stringify([page.tabId,page.windowId,page.targetId,page.url]),owner=page.ownerAgentId||null,groupId=group(page.groupId),previous=tabs.get(page.tabId);
    if(handles.has(page.pageId)&&handles.get(page.pageId)!==identity||targets.has(page.targetId)&&targets.get(page.targetId)!==identity)reject();
    handles.set(page.pageId,identity);targets.set(page.targetId,identity);
    if(previous){
      if(previous.identity!==identity||previous.owner&&owner&&previous.owner!==owner||previous.groupId!==null&&groupId!==null&&previous.groupId!==groupId)reject();
      previous.aliases.add(page.pageId);
      // Reclaim can leave an unowned alias next to the current owned handle.
      // Native identity remains strict; prefer the current connection's handle.
      if(page.ownership==='mine'&&previous.page.ownership!=='mine'||previous.page.ownership!=='mine'&&(owner&&!previous.owner||groupId!==null&&previous.groupId===null||groupId===previous.groupId&&page.pageId<previous.page.pageId)){previous.page=page;previous.groupId=groupId;}
      previous.owner ||= owner;
    }else tabs.set(page.tabId,{page,identity,owner,groupId,aliases:new Set([page.pageId])});
  }
  return [...tabs.values()].map(value=>({...value.page,aliasPageIds:[...value.aliases].sort((one,two)=>one-two)}));
}
const sameNativePage=(one,two)=>one.tabId===two.tabId&&one.windowId===two.windowId&&one.targetId===two.targetId&&one.url===two.url;

function parseOptions(){
  const args=process.argv.slice(2);if(args.includes('--help')){console.log(USAGE);return null;}
  let live=false,capture=false,output;
  for(let index=0;index<args.length;index++){
    if(args[index]==='--live-neo')live=true;
    else if(args[index]==='--capture')capture=true;
    else if(args[index]==='--output-dir'&&args[index+1]&&!output)output=args[++index];
    else throw new CheckError('INVALID_ARGUMENT',USAGE);
  }
  ensure(live,'OPT_IN_REQUIRED','No browser check was run. Explicit opt-in is required: '+USAGE);
  ensure(!output||path.isAbsolute(output),'OUTPUT_PATH','Use an absolute, previously nonexistent output directory.');
  return{capture,output:path.resolve(output||path.join('outputs','neo-background-'+new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID().slice(0,8)))};
}

async function main({output,capture:requestCapture}){
  await mkdir(path.dirname(output),{recursive:true});
  try{await mkdir(output);}catch(error){throw new CheckError('OUTPUT_EXISTS','The output directory must be fresh; no existing files were changed.');}
  const token=randomUUID(),rootPath='/blackice-neo-check/'+token+'/',nonce=randomUUID().replaceAll('-','');
  const report={product:'BLACKICE',test:'Opt-in native Neo background acceptance',startedAt:new Date().toISOString(),outcome:'running',checks:[],observations:[],calls:[],capture:{requested:requestCapture,status:'not-tested',reason:requestCapture?'The requested capture stage has not been reached.':'Image capture was not requested; default acceptance verifies DOM, the local action, and reconnect.'},limits:['Window checks are before/after observations, not a universal no-focus guarantee.','Image capture is a separate --capture opt-in using a bounded JPEG preview at quality 70 and a 20-second deadline. A capture not requested is not tested; a requested capture failure cannot pass acceptance.','Only an existing normal, inactive browser is admitted; no browser startup, window activation, resizing, minimizing, restoring, or explicit window closure is performed.','Existing tabs are inspected only for preservation; their URLs and titles are omitted from this report.','No external website, account, or publication is used.'],cleanup:{closedOwnTabs:[],leftOwnTabs:[]}};
  const hardTimer=setTimeout(()=>{report.outcome='failed';report.error={code:'HARD_DEADLINE',message:'The 150-second process deadline was reached. Inspect recorded own tabs before cleanup; existing windows were not deliberately changed.'};report.finishedAt=new Date().toISOString();try{writeFileSync(path.join(output,'result.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});}catch{}console.error('Neo acceptance stopped at its process deadline.');process.exit(1);},HARD_MS);
  const mainSignal=AbortSignal.timeout(MAIN_MS);let cleanupSignal,cleaning=false,manager,integration,server,scratch,connectionId,baseline,stage='setup';
  const own=new Map(),attemptedOwnURLs=new Set(),local={count:0,receivedToken:null};let captureFailed=false;
  const check=(name,details={})=>report.checks.push({name,passed:true,at:new Date().toISOString(),...details});
  async function bounded(label,operation,budget=CALL_MS){
    const signal=AbortSignal.any([cleaning?cleanupSignal:mainSignal,AbortSignal.timeout(budget)]),started=Date.now();
    let listener;
    try{
      const admitted=()=>ensure(!signal.aborted,'CALL_DEADLINE','The bounded '+label+' step was cancelled or exceeded its deadline.');admitted();
      return await Promise.race([Promise.resolve().then(()=>{admitted();return operation(signal);}),new Promise((_,reject)=>{listener=()=>reject(new CheckError('CALL_DEADLINE','The bounded '+label+' step was cancelled or exceeded its deadline.'));signal.addEventListener('abort',listener,{once:true});if(signal.aborted)listener();})]);
    }finally{if(listener)signal.removeEventListener('abort',listener);report.calls.push({operation:label,elapsedMs:Date.now()-started});}
  }
  function tool(name,args){
    const found=manager.clients.get(connectionId)?.tools.find(item=>item.name===name);
    ensure(found?.inputSchema?.type==='object','UNSUPPORTED_CATALOG','The current Neo catalog does not support a required tool.',true);
    const schema=found.inputSchema;
    for(const required of schema.required||[])ensure(Object.hasOwn(args,required),'UNSUPPORTED_SCHEMA','A required Neo tool input is not supported by this acceptance script.',true);
    for(const [key,value]of Object.entries(args)){
      const property=schema.properties?.[key];ensure(property,'UNSUPPORTED_SCHEMA','A required Neo tool field is absent from the returned schema.',true);
      if(property.enum)ensure(property.enum.includes(value),'UNSUPPORTED_SCHEMA','A required Neo operation is absent from the returned schema.',true);
      const types=Array.isArray(property.type)?property.type:[property.type];
      if(property.type)ensure(types.some(type=>type==='integer'?Number.isInteger(value):type==='number'?typeof value==='number':type==='object'?object(value):type==='array'?Array.isArray(value):type==='null'?value===null:typeof value===type),'UNSUPPORTED_SCHEMA','A required Neo tool input has changed type.',true);
    }
    return found;
  }
  async function call(name,args){
    tool(name,args);
    const result=await bounded(name,signal=>manager.call(connectionId,name,args,{signal}));
    ensure(object(result)&&result.isError!==true,'MCP_TOOL_FAILED','Neo reported a tool error. No possibly completed action will be retried.');return result;
  }
  function runValue(result){
    let envelope=result.structuredContent;
    if(!object(envelope))for(const item of result.content||[])if(item.type==='text'&&typeof item.text==='string'&&item.text.length<2000000)try{const parsed=JSON.parse(item.text);if(object(parsed)){envelope=parsed;break;}}catch{}
    ensure(envelope?.ok===true,'MCP_RUN_FAILED','Neo could not complete the bounded SDK step. No possibly completed action will be retried.');return envelope.value;
  }
  async function run(code){
    const args={code};if(manager.clients.get(connectionId)?.tools.find(item=>item.name==='run')?.inputSchema?.properties?.timeout)args.timeout=10000;
    return runValue(await call('run',args));
  }
  function checkSdk(){
    const description=tool('run',{code:''}).description||'';
    for(const documented of ['browser.pages.list()','browser.page(id)','windows(opts)','page.snapshot(','page.read(','page.click(','waitForText('])ensure(description.includes(documented),'UNSUPPORTED_SDK','The returned Neo SDK documentation does not establish every required operation.',true);
    tool('tabs',{action:'list'});tool('tabs',{action:'new',url:'http://127.0.0.1/'});tool('tabs',{action:'close',page:0});
    if(requestCapture)tool('screenshot',{page:0,fullPage:false,format:'jpeg',quality:70,size:{width:1024,height:768}});
  }
  async function inventory(){
    const value=await run("return {pages:await browser.pages.list(),inventory:await browser.windows({action:'list'})};");
    ensure(Array.isArray(value?.pages)&&Array.isArray(value.inventory?.windows),'UNKNOWN_INVENTORY','Native browser window or tab inventory is unavailable.',true);
    const windows=value.inventory.windows;let pages;try{pages=normalizeNeoPages(value.pages);}catch{throw new CheckError('NATIVE_ALIAS_CONFLICT','Neo page aliases have incomplete or contradictory native identity, URL, ownership, or group metadata. The browser was left untouched.',true);}
    ensure(windows.length>0&&windows.every(window=>id(window.windowId)&&window.isActive===false&&window.bounds?.windowState==='normal'),'UNSAFE_WINDOW','The check requires existing normal, inactive Neo windows. Active, minimized, or unknown windows were left untouched.',true);
    ensure(new Set(windows.map(window=>window.windowId)).size===windows.length,'UNKNOWN_INVENTORY','The native window inventory has duplicate identities.',true);
    ensure(pages.every(page=>windows.some(window=>window.windowId===page.windowId)),'UNKNOWN_TAB_WINDOW','A page cannot be mapped to an observed native window; the browser was left untouched.',true);
    ensure(windows.every(window=>pages.some(page=>page.windowId===window.windowId)),'UNKNOWN_WINDOW_TABS','An existing window has no observable page; the browser was left untouched.',true);
    return{pages,windows,pageHandleCount:value.pages.length};
  }
  const windowState=window=>({windowId:window.windowId,isActive:window.isActive,bounds:Object.fromEntries(['windowState','left','top','x','y','width','height'].filter(key=>window.bounds?.[key]!==undefined).map(key=>[key,window.bounds[key]]))});
  async function observe(name){
    const value=await inventory();
    if(baseline){
      ensure(baseline.windows.every(window=>JSON.stringify(windowState(window))===JSON.stringify(windowState(value.windows.find(item=>item.windowId===window.windowId)||{}))),'EXISTING_WINDOW_CHANGED','An existing window’s observed state changed. The check stopped without changing it back.');
      ensure(baseline.pages.every(page=>value.pages.some(current=>sameNativePage(page,current))),'EXISTING_TAB_CHANGED','An existing tab disappeared or changed native identity, window, or URL. The check stopped without changing it back.');
    }
    report.observations.push({stage:name,at:new Date().toISOString(),windows:value.windows.map(windowState),tabCount:value.pages.length,pageHandleCount:value.pageHandleCount,existingTabsPreserved:baseline?true:null});return value;
  }
  function remember(value,url){
    const prior=own.get(url),matches=value.pages.filter(page=>page.url===url&&(!prior||sameNativePage(prior,page)));
    ensure(matches.length===1&&matches[0].ownership==='mine','OWN_TAB_MISSING','The script-created local page is not uniquely owned by this MCP session.');
    const page=matches[0];
    own.set(url,{url,pageId:page.pageId,tabId:page.tabId,windowId:page.windowId,targetId:page.targetId,groupId:page.groupId,aliasPageIds:page.aliasPageIds});return page;
  }
  const pageForCode=url=>{const expected=own.get(url);ensure(expected,'OWN_TAB_MISSING','No native identity was recorded for this local page.');return `const normalizeNeoPages=${normalizeNeoPages.toString()};const sameNativePage=${sameNativePage.toString()};const expected=${JSON.stringify(expected)};const matches=normalizeNeoPages(await browser.pages.list()).filter(item=>sameNativePage(item,expected)&&item.ownership==='mine');if(matches.length!==1)throw Error('Own local page missing');const page=browser.page(matches[0].pageId);`;};
  async function nativeCheck(name){
    const value=await bounded(name,signal=>integration.refresh({signal,startIfNeeded:true}));
    ensure(value.available&&value.backgroundWindow?.ready===true&&value.backgroundWindow.policyVerified===true&&value.backgroundWindow.created===false,'FOCUS_POLICY_CHECK','The native never-steal-focus check did not pass for the existing browser.',true);
    check(name,{policyVerified:true,createdWindow:false,checkedAt:value.backgroundWindow.checkedAt});
  }
  try{
    scratch=await mkdtemp(path.join(tmpdir(),'blackice-neo-acceptance-'));manager=new ConnectionManager({dataDir:scratch});integration=createSignedBrowserIntegration({connections:manager});
    server=createServer((request,response)=>{void(async()=>{
      const url=new URL(request.url,'http://127.0.0.1');
      if(request.headers.host!==server.address().address+':'+server.address().port||!url.pathname.startsWith(rootPath)){response.writeHead(404).end();return;}
      response.setHeader('Cache-Control','no-store');response.setHeader('Referrer-Policy','no-referrer');
      if(request.method==='POST'&&url.pathname===rootPath+'record'){
        let body='';for await(const chunk of request){body+=chunk;if(body.length>1024){response.writeHead(413).end();return;}}
        let payload;try{payload=JSON.parse(body);}catch{response.writeHead(400).end();return;}
        if(payload.token!==token||local.count!==0){response.writeHead(409).end();return;}local.count++;local.receivedToken=payload.token;
        response.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify({count:local.count,receipt:token}));return;
      }
      if(request.method!=='GET'||![rootPath,rootPath+'reconnected'].includes(url.pathname)){response.writeHead(404).end();return;}
      response.setHeader('Content-Security-Policy',`default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'`);
      response.writeHead(200,{'Content-Type':'text/html; charset=utf-8'}).end(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>BLACKICE local background check</title><style>html{color-scheme:dark;background:#050c14;color:#d6e8f0;font-family:monospace}body{margin:0;min-height:100vh;display:grid;place-items:center;background:radial-gradient(ellipse at 25% 10%,#1b3a4c88,transparent 65%)}main{margin:25px;padding:28px;max-width:720px;border:1px solid #426479;background:#0b1b29;box-shadow:inset 0 1px #c0e8ff33}h1{letter-spacing:.19em;font-size:30px}small{color:#91b3c8;letter-spacing:.1em}p{line-height:1.8;overflow-wrap:anywhere}svg{width:100%;height:88px}button{padding:13px 20px;background:#173b4b;border:1px solid #91bacb;color:#e0f4fa;font:inherit;cursor:pointer}button:disabled{opacity:.65;cursor:default}output{display:block;margin-top:20px;color:#b0dcc9;font-size:20px}#receipt{color:#9bbdce;font-size:12px}</style><main><small>LOCAL ACCEPTANCE CHECK</small><h1>BLACKICE</h1><svg viewBox="0 0 640 88" role="img" aria-label="Faceted dark ice"><path d="M0 86 64 8 159 45 235 0 302 56 409 10 503 48 640 0V88Z" fill="#183c50"/><path d="m64 8 45 78 50-41 76-45-17 86M302 56 409 10l-28 76m122-38 26 38 111-86" fill="none" stroke="#719db04d"/><path d="m0 86 159-41 143 11 201-8 137-48" fill="none" stroke="#95c9d44d"/></svg><p>Token: ${token}</p><p>One local button click must produce a server-backed receipt. This page contains no external website or account action.</p><button type="button" id="record"${local.count?' disabled':''}>Record local check</button><output id="counter" aria-live="polite">Recorded: ${local.count}</output><p id="receipt">${local.count?'Receipt: '+token:'No receipt yet.'}</p></main><script nonce="${nonce}">document.querySelector('#record').addEventListener('click',async event=>{event.currentTarget.disabled=true;try{const response=await fetch(${JSON.stringify(rootPath+'record')},{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:${JSON.stringify(token)}})});if(!response.ok)throw Error('Local record failed');const value=await response.json();document.querySelector('#counter').textContent='Recorded: '+value.count;document.querySelector('#receipt').textContent='Receipt: '+value.receipt;}catch{document.querySelector('#receipt').textContent='Local record failed; do not click again.';}});</script></html>`);
    })().catch(()=>{if(!response.headersSent)response.writeHead(500);response.end();});});
    server.on('clientError',(_error,socket)=>socket.destroy());server.on('error',()=>{});
    await bounded('local-server',()=>new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);}));
    const localURL=`http://127.0.0.1:${server.address().port}${rootPath}`,reconnectedURL=localURL+'reconnected';report.localTest={url:localURL,reconnectUrl:reconnectedURL};
    stage='passive discovery';const passive=await bounded(stage,signal=>integration.refresh({signal}));
    ensure(passive.available&&passive.catalogKind==='neo-run','NEO_UNAVAILABLE','The existing Neo browser is not connected. Start Neo separately and inspect its cockpit; no fallback browser was opened.',true);connectionId=passive.connectionId;
    checkSdk();await call('tabs',{action:'list'});baseline=await observe('before');
    report.baseline={windowCount:baseline.windows.length,tabCount:baseline.pages.length,tabs:baseline.pages.map(page=>({pageId:page.pageId,aliasPageIds:page.aliasPageIds,windowId:page.windowId,tabId:page.tabId,targetId:page.targetId}))};check(stage,{catalogConnected:passive.catalogConnected===true,browserConnected:true});
    await call('name_session',{name:'BLACKICE '+token.slice(0,8),category:'testing-and-qa',summary:'Verify local background browser actions and reconnect safely'});
    stage='native focus policy';await nativeCheck(stage);await observe('after native check');
    stage='owned local page';await observe('before opening local page');attemptedOwnURLs.add(localURL);await call('tabs',{action:'new',url:localURL});let current=await observe('after opening local page'),page=remember(current,localURL);
    const groupId=typeof page.groupId==='string'?page.groupId:Number.isSafeInteger(page.groupId)&&page.groupId>=0?String(page.groupId):null;
    ensure(groupId,'GROUP_ID_MISSING','Neo did not report the script’s own tab group; no reconnection or unrelated tab action was attempted.');tool('tabs',{action:'new',url:reconnectedURL,groupId});report.ownedGroupId=groupId;check(stage,{pageId:page.pageId});
    stage='snapshot and read';const before=await run(pageForCode(localURL)+"if(!(await page.waitForText('Record local check',{timeout:5000})).matched)throw Error('Local page missing');return {snapshot:await page.snapshot({mode:'interactive',depth:6}),read:await page.read()};");
    ensure(typeof before?.snapshot?.text==='string'&&typeof before.read==='string'&&before.read.includes(token)&&before.read.includes('Recorded: 0'),'LOCAL_PAGE_READ','The own local page did not show its unique token and initial counter.');
    await writeFile(path.join(output,'local-before.txt'),before.snapshot.text+'\n\n'+before.read,{flag:'wx',mode:0o600});check(stage,{initialCount:0});
    stage='one local button click';await observe('before local button click');const acted=await run(pageForCode(localURL)+String.raw`const snapshot=await page.snapshot({mode:'interactive',depth:6});const lines=snapshot.text.split('\n').filter(line=>/button/i.test(line)&&line.includes('Record local check'));if(lines.length!==1)throw Error('Local button ambiguous');const ref=/\bref=(e\d+)\b/.exec(lines[0])?.[1];if(!ref)throw Error('Local button reference missing');await page.click(ref);if(!(await page.waitForText(${JSON.stringify('Receipt: '+token)},{timeout:5000})).matched)throw Error('Server receipt missing');return {read:await page.read(),snapshot:await page.snapshot({mode:'interactive',depth:6})};`);
    ensure(local.count===1&&local.receivedToken===token&&typeof acted?.read==='string'&&acted.read.includes('Recorded: 1')&&acted.read.includes('Receipt: '+token),'LOCAL_ACTION_UNVERIFIED','The single local click was not verified by both the page and the local server.');
    await writeFile(path.join(output,'local-after.txt'),acted.snapshot.text+'\n\n'+acted.read,{flag:'wx',mode:0o600});check(stage,{serverCount:1,tokenMatched:true});current=await observe('after local button click');page=remember(current,localURL);
    if(requestCapture){
      stage='guarded bounded screenshot';
      try{
        const gateway=createConnectionToolHandler({manager}),capture=await bounded(stage,signal=>gateway({name:'relay_connections',arguments:{action:'call',connectionId,name:'screenshot',arguments:{page:page.pageId,fullPage:false,format:'jpeg',quality:70,size:{width:1024,height:768}},imageOutputPath:path.join(output,'background-check.jpg')}},{signal}),CAPTURE_MS);
        ensure(capture?.success===true,'SCREENSHOT_REFUSED','The guarded bounded capture did not complete. '+(capture?.contentItems||[]).filter(item=>item.type==='inputText').map(item=>item.text).join(' ').slice(0,1600)+' No screenshot bypass or repeated click was attempted.');
        let saved;for(const item of capture.contentItems||[])if(item.type==='inputText')try{const parsed=JSON.parse(item.text);if(parsed.savedImage)saved=parsed.savedImage;}catch{}
        ensure(saved?.mimeType==='image/jpeg'&&saved.bytes>0&&saved.width>0&&saved.width<=1920&&saved.height>0&&saved.height<=1200,'SCREENSHOT_MISSING','The guarded capture returned no checked JPEG preview within the accepted pixel bounds.');const bytes=await readFile(path.join(output,'background-check.jpg'));ensure(createHash('sha256').update(bytes).digest('hex')===saved.sha256,'SCREENSHOT_MISMATCH','Saved JPEG bytes did not match their checked receipt.');
        report.screenshot={file:'background-check.jpg',mimeType:'image/jpeg',quality:70,bytes:saved.bytes,sha256:saved.sha256,width:saved.width,height:saved.height,requestedSize:{width:1024,height:768}};
        report.capture={requested:true,status:'passed',...report.screenshot};check(stage,report.screenshot);
      }catch(error){captureFailed=true;report.capture={requested:true,status:'failed',error:safeError(error)};report.error={stage,...safeError(error)};report.checks.push({name:stage,passed:false,at:new Date().toISOString(),error:safeError(error)});}
      // Gather native state and reconnect evidence even after a failed capture.
      // The local button is never clicked again, and capture failure stays failed.
      await observe('after requested capture');
    }
    stage='own MCP reconnect';await bounded('disconnect own MCP session',()=>manager.disconnect(connectionId));
    const restored=await bounded('passive reconnect',signal=>integration.refresh({signal}));ensure(restored.available,'RECONNECT_FAILED','The own MCP connection did not recover; the local action was not repeated.');checkSdk();await call('tabs',{action:'list'});
    await call('name_session',{name:'BLACKICE '+token.slice(0,8),category:'testing-and-qa',summary:'Continue the same local background acceptance check'});await observe('after reconnect, before reclaim');await nativeCheck('reconnected native focus policy');
    attemptedOwnURLs.add(reconnectedURL);await call('tabs',{action:'new',url:reconnectedURL,groupId});current=await observe('after own group reclaim');remember(current,reconnectedURL);remember(current,localURL);
    const retained=await run(pageForCode(localURL)+'return await page.read();');ensure(typeof retained==='string'&&retained.includes('Recorded: 1')&&retained.includes('Receipt: '+token)&&local.count===1,'RECONNECT_EVIDENCE','The original local receipt did not survive reconnection. No click was retried.');check(stage,{sameReceipt:true,serverCount:1});
    report.outcome=captureFailed?'failed':'passed';
  }catch(error){report.outcome=captureFailed?'failed':error.stopped?'stopped':'failed';report.error={stage,...safeError(error)};}
  finally{
    cleaning=true;cleanupSignal=AbortSignal.timeout(CLEANUP_MS);
    try{
      if(integration)await bounded('retire integration',()=>integration.close(),4000);
      if(attemptedOwnURLs.size&&manager?.clients.get(connectionId)?.connected){
        const found=await observe('cleanup inventory');for(const url of attemptedOwnURLs)if(!own.has(url)&&found.pages.some(page=>page.url===url&&page.ownership==='mine'))remember(found,url);
        for(const record of [...own.values()].reverse()){
          const current=await observe('before own-tab cleanup'),matches=current.pages.filter(page=>sameNativePage(page,record));
          if(!matches.length)continue;ensure(matches.length===1&&matches[0].ownership==='mine','CLEANUP_OWNERSHIP','A recorded local tab is no longer uniquely owned; it was left open.');
          if(baseline.windows.some(window=>window.windowId===record.windowId))ensure(baseline.pages.some(original=>original.windowId===record.windowId&&current.pages.some(page=>sameNativePage(original,page))),'CLEANUP_LAST_TAB','Closing this local tab could close a pre-existing window; it was left open.');
          await call('tabs',{action:'close',page:matches[0].pageId});report.cleanup.closedOwnTabs.push(matches[0].pageId);
        }
        const after=await observe('after own-tab cleanup');report.cleanup.leftOwnTabs=after.pages.filter(page=>[...own.values()].some(record=>sameNativePage(record,page))).map(page=>page.pageId);ensure(!report.cleanup.leftOwnTabs.length,'CLEANUP_PENDING','A script-created local tab remains open.');
      }else if(attemptedOwnURLs.size){report.cleanup.leftOwnTabs=[...own.values()].map(page=>page.pageId);report.cleanup.possibleOwnURLs=[...attemptedOwnURLs];if(report.outcome==='passed')report.outcome='failed';}
    }catch(error){report.cleanup.error=safeError(error);report.cleanup.leftOwnTabs=[...own.values()].filter(page=>!report.cleanup.closedOwnTabs.includes(page.pageId)).map(page=>page.pageId);report.cleanup.possibleOwnURLs=[...attemptedOwnURLs];if(report.outcome==='passed')report.outcome='failed';}
    try{if(manager)await bounded('close scratch MCP client',()=>manager.close(),4000);}catch(error){report.cleanup.connectionError=safeError(error);if(report.outcome==='passed')report.outcome='failed';}
    report.localServer={acceptedClicks:local.count,receiptTokenMatched:local.receivedToken===token};
    if(server){server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));}
    if(scratch){const resolved=path.resolve(scratch);if(path.dirname(resolved)===path.resolve(tmpdir())&&path.basename(resolved).startsWith('blackice-neo-acceptance-'))await rm(resolved,{recursive:true,force:true}).catch(()=>{});}
    report.finishedAt=new Date().toISOString();try{await writeFile(path.join(output,'result.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});}finally{clearTimeout(hardTimer);}
  }
  console.log(JSON.stringify({outcome:report.outcome,result:path.join(output,'result.json'),capture:{requested:report.capture.requested,status:report.capture.status},...(report.error?{error:report.error}:{}),passedChecks:report.checks.filter(item=>item.passed).length,failedChecks:report.checks.filter(item=>!item.passed).length}));
  process.exitCode=report.outcome==='passed'?0:report.outcome==='stopped'?2:1;
}

try{const options=parseOptions();if(options)await main(options);}catch(error){console.error(safeError(error).message);process.exitCode=1;}
