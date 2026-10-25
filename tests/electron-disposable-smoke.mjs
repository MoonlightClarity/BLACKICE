/**
 * Real packaged Electron runtime with a fresh, isolated BLACKICE profile.
 * Never opens a top-level app window, reads the user's default profile, or
 * touches the installed BLACKICE executable. Requires a staged candidate.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const project=fileURLToPath(new URL('../', import.meta.url));
const candidate=path.join(process.env.BLACKICE_DISPOSABLE_STAGE || path.join(project,'.build','electron-breakpoint-disposable'),'BLACKICE.exe');
const profile=await mkdtemp(path.join(project,'.build','electron-smoke-profile-'));
let electron=null;
let stopped=false;
let port=null;
let failure=null;
let stdout='',stderr='';
const pid=()=>electron?.pid ?? null;
const until=async(fn,label,ms=70000)=>{
  const end=Date.now()+ms;
  let last;
  while(Date.now()<end){
    if(electron && electron.exitCode!==null)throw Error('Disposable Electron exited before '+label+': '+electron.exitCode+' '+stderr.slice(-600));
    try{const result=await fn();if(result)return result;}catch(error){last=error;}
    await sleep(200);
  }
  throw Error(label+' timed out: '+(last?.message||''));
};
const launch=(args)=>{
  // ELECTRON_RUN_AS_NODE must be absent, not just empty: its presence switches
  // Electron into Node CLI mode, which rejects desktop lifecycle flags.
  const env={...process.env,BLACKICE_NATIVE_EVENT_TEST:'1'};delete env.ELECTRON_RUN_AS_NODE;
  const child=spawn(candidate,args,{cwd:path.dirname(candidate),shell:false,windowsHide:true,stdio:['ignore','pipe','pipe'],env});
  child.stdout?.on('data',b=>{stdout=(stdout+String(b)).slice(-6000);});
  child.stderr?.on('data',b=>{stderr=(stderr+String(b)).slice(-6000);});
  return child;
};
const get=async(url,cookie,init={})=>{
  const response=await fetch(url,{...init,headers:{...(cookie?{Cookie:cookie}:{}),...(init.headers||{})},
    signal:AbortSignal.timeout(17000),redirect:'error'});
  const body=await response.text();
  let data;
  try{data=JSON.parse(body);}catch{data=body;}
  return {status:response.status,headers:response.headers,data,body};
};
try{
  await stat(candidate);
  const heavyHistory = process.env.BLACKICE_DISPOSABLE_HEAVY === 'yes';
  let syntheticHistoryMB = 0;
  if (heavyHistory) {
    // Never reuse the user's saved runs: create a synthetic 30+ MB archive
    // inside a new temporary profile, then let the actual engine restore it.
    const longPayload = 'synthetic_tool_output_'.repeat(245);
    const runs = Array.from({length:60},(_,index) => {
      const id = 'synthetic-run-' + index;
      const updatedAt = new Date(Date.parse('2026-10-23T10:00:00Z') + index * 60000).toISOString();
      return {
        id, taskId:'synthetic-run-0',parentRunId:index ? 'synthetic-run-' + (index-1) : null,
        createdAt:updatedAt,updatedAt,finishedAt:updatedAt,
        input:'Synthetic user turn ' + index,status:'completed',settled:true,
        workflowName:'Synthetic long chat',
        workflow:{id:'synthetic-workflow',name:'Synthetic long chat',
          nodes:[{id:'agent',type:'agent',name:'BLACKICE'}],edges:[],settings:{planningMode:'off'}},
        nodes:{agent:{status:'completed',threadId:'synthetic-thread-' + index,
          output:'**Synthetic response ' + index + '**\nA completed test answer.'}},
        events:[
          ...Array.from({length:110},(_,j)=>({at:updatedAt,nodeId:'agent',
            data:{type:'tool.result',ordinal:j,payload:longPayload}})),
          {at:updatedAt,nodeId:'agent',
            data:{type:'message',itemId:'reply-' + index,text:'**Synthetic response ' + index + '**\nA completed test answer.'}},
        ],
      };
    });
    const encoded=JSON.stringify(runs);
    syntheticHistoryMB=Math.round(Buffer.byteLength(encoded)/1048576*100)/100;
    await mkdir(path.join(profile,'data'),{recursive:true});
    await writeFile(path.join(profile,'data','runs.json'),encoded);
  }
  electron=launch(['--headless','--profile-dir',profile]);
  const started=Date.now();
  const runtime=await until(async()=>{
    const raw=await readFile(path.join(profile,'desktop-runtime.json'),'utf8');
    const value=JSON.parse(raw);
    if(!value.url||!value.pid||value.pid!==pid())return null;
    return value;
  },'BLACKICE runtime startup');
  assert.equal(runtime.profileMode,'custom');
  assert.equal(runtime.lifecycle?.mode,'headless');
  assert.equal(runtime.lifecycle?.windowVisible,false,'The disposable build must not foreground any window.');
  const sourceVersion=JSON.parse(await readFile(path.join(project,'package.json'),'utf8')).version;
  assert.equal(runtime.version,sourceVersion);
  assert.ok((await stat(path.join(profile,'Crashpad'))).isDirectory(),
    'Crashpad must store dumps only under the disposable profile.');
  const crashpad=await until(async()=>{
    const diagnosticsRaw=await readFile(path.join(profile,'diagnostics','events.0.jsonl'),'utf8');
    const startupReceipts=diagnosticsRaw.split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line));
    return startupReceipts.find(item=>item.component==='electron-crashpad')||null;
  },'local-only Crashpad initialization receipt',8000);
  assert.equal(crashpad?.event,'local_enabled','Electron native crash reports must be active in the isolated profile.');
  assert.equal(crashpad?.uploadToServer,false,'The reporter must never upload process memory.');
  const homepage=await get(runtime.url+'/');
  assert.equal(homepage.status,200);
  const cookie=(homepage.headers.get('set-cookie')||'').split(';',1)[0];
  assert.ok(cookie.includes('='),'Main BLACKICE session must be active.');
  const next=await get(runtime.url+'/next/',cookie);
  assert.equal(next.status,200);
  assert.match(next.body,/\/next\/app\.mjs/);
  const status=await get(runtime.url+'/api/status',cookie);
  assert.equal(status.status,200);
  const browserStatus=await get(runtime.url+'/api/browser/status?view=contained',cookie);
  assert.equal(browserStatus.status,200);
  assert.equal(browserStatus.data.available,true,'Electron contained browser should be available.');
  let open=null;
  try {
    open=await get(runtime.url+'/api/browser/action',cookie,{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({action:'open',browser:'relay',url:runtime.url+'/next/'}),
    });
    assert.equal(open.status,200,'Offscreen tab should be created in the disposable profile.');
    assert.ok(open.data.tabId,'Offscreen tab needs a native browser identity.');
  }catch(error){
    throw Error('Disposable offscreen Electron browser failed: '+error.message+
      (open?.data?.error?' '+String(open.data.error):''));
  }
  const after=await get(runtime.url+'/api/browser/status?view=contained',cookie);
  assert.ok(after.data.tabs.some(tab=>tab.tabId===open.data.tabId));
  assert.equal(after.data.tabs.find(tab=>tab.tabId===open.data.tabId).visible,false);
  // Simulate the renderer-death event against a real hidden Electron BrowserWindow
  // without force-crashing a Windows process or showing a native error dialog.
  await writeFile(path.join(profile,'native-cleanup-trigger.txt'),'probe');
  const probe=await until(async()=>{
    const raw=await readFile(path.join(profile,'native-cleanup-result.json'),'utf8');
    return JSON.parse(raw);
  },'real native BrowserWindow deferred cleanup',10000);
  assert.ok(!probe.error,probe.error||'Cleanup probe error');
  assert.equal(probe.aliveInCallback,true,'Window must survive the native callback frame.');
  assert.equal(probe.detachedInCallback,true,'The tab must detach immediately.');
  assert.equal(probe.destroyedAfterCallback,true,'The hidden window must be released after the callback.');
  assert.equal(probe.tabPreserved,true,'Saved tab identity must survive.');
  assert.equal(probe.reason,'crashed');
  assert.equal(probe.pickerBridge,true,'Combined Electron must inject the file-picker bridge into a real contained page.');
  assert.equal(probe.pickerNoNodeExposure,true,'File picker bridge must not expose Node or host APIs.');
  assert.equal(probe.noNativeFocus,true,'The disposable host must not open a BLACKICE window.');
  await writeFile(path.join(profile,'hidden-renderer-trigger.txt'),'probe');
  const actualUI=await until(async()=>{
    const raw=await readFile(path.join(profile,'hidden-renderer-result.json'),'utf8');
    return JSON.parse(raw);
  },'actual hidden Electron V2 renderer',25000);
  assert.ok(!actualUI.error,actualUI.error||'Hidden renderer test failed');
  assert.equal(actualUI.initialized,true);
  assert.equal(actualUI.bootstrapGone,true);
  assert.equal(actualUI.readerMode,'worker');
  assert.ok(actualUI.chatHeight>=300,'Actual Chromium Chat viewport should fill its hidden window.');
  assert.deepEqual(actualUI.visited,['planning','tasks','browser','settings','activity']);
  assert.equal(actualUI.selectedSpace,'chat');
  assert.equal(actualUI.draftRetained,true,'Actual Electron workspace must retain drafts across tabs.');
  if (heavyHistory) {
    assert.ok(syntheticHistoryMB > 25, 'Synthetic saved history must exercise large transcript loading.');
    assert.equal(actualUI.historyTurnCount,12,'The Electron renderer must only mount the latest 12 turns.');
    assert.ok(actualUI.editorInputMs < 1500,'The composer must remain responsive while history is processed.');
  }
  assert.equal(actualUI.hiddenChat,true);
  assert.equal(actualUI.unfocused,true);
  assert.equal(actualUI.browserNavigationMinimum,true,
    'Address bar, tabs and navigation must remain usable at 780×560 in actual Electron.');
  const stillAlive=await get(runtime.url+'/api/status',cookie);
  assert.equal(stillAlive.status,200,'The host must survive synthetic renderer death and V2 workspace navigation.');
  console.log('PASS disposable Electron: '+JSON.stringify({
    version:runtime.version,headless:runtime.lifecycle.mode,windowVisible:false,
    readyMs:Date.now()-started,nativeBrowserTabs:after.data.tabs.length,
    nativeRendererHosted:true,rendererEventCleanup:true,localCrashDumps:true,
    pickerBridgeInjected:probe.pickerBridge,pickerNoNodeExposure:probe.pickerNoNodeExposure,
    crashDumpsUploaded:false,nextFrontendServed:true,
    actualElectronV2ChatMs:actualUI.initialMs, actualElectronWorkspaces:actualUI.visited.length,
    draftRetained:actualUI.draftRetained,foregroundTaken:false,
    browserNavigationMinimum:actualUI.browserNavigationMinimum,
    ...(heavyHistory?{syntheticHistoryMB,historyTurnCount:actualUI.historyTurnCount,
      editorInputMs:actualUI.editorInputMs,historyLoadMs:actualUI.historyLoadMs}:{}),pid:pid(),
  }));
} catch(error){
  failure=error;
  console.error('FAIL disposable Electron:',error.stack||error);
  if(stderr)console.error('DISPOSABLE_STDERR',stderr.slice(-1800));
} finally{
  if(electron){
    try{
      const closing=launch(['--quit','--profile-dir',profile]);
      await Promise.race([
        new Promise(resolve=>closing.once('exit',resolve)),sleep(5000),
      ]);
      if(!closing.killed&&closing.exitCode===null)closing.kill();
    }catch{}
    try{
      const end=Date.now()+14000;
      while(Date.now()<end&&electron.exitCode===null){await sleep(300);}
      if(electron.exitCode===null){
        console.error('Disposable shutdown exceeded grace; terminating only the test process tree.');
        const killer=spawn('taskkill.exe',['/PID',String(pid()),'/T','/F'],{windowsHide:true,stdio:'ignore'});
        await new Promise(resolve=>killer.once('close',resolve));
        await sleep(400);
      }
      stopped=electron.exitCode!==null;
    }catch(error){console.error('Disposable shutdown failed:',error.message);}
  }
  try{
    const file=path.join(profile,'diagnostics','events.0.jsonl');
    const raw=await readFile(file,'utf8');
    const events=raw.split(/\r?\n/).filter(Boolean).map(x=>{try{return JSON.parse(x);}catch{return null;}}).filter(Boolean);
    console.log('DISPOSABLE_DIAGNOSTICS '+JSON.stringify({
      nativeProcessExit:events.filter(x=>x.component==='electron-process'),
      recentErrors:events.filter(x=>x.level==='error').slice(-5).map(x=>({component:x.component,event:x.event,code:x.code})),
    }));
  }catch{}
  if(stopped){
    await rm(profile,{recursive:true,force:true,maxRetries:4,retryDelay:250}).catch(()=>{});
  }else console.error('Disposable profile left for inspection: '+profile);
}
if(failure)process.exitCode=1;
