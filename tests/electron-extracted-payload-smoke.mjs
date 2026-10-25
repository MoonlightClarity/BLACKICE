/** Verify the actual NSIS-extracted BLACKICE application without installing.
 * Runs packaged Electron headlessly with a disposable profile. It never
 * modifies a shared/installed profile or creates a top-level foreground window.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';

const dir=process.env.BLACKICE_EXTRACTED_APP;
if(!dir || !path.isAbsolute(dir)) throw Error('BLACKICE_EXTRACTED_APP must identify a disposable, extracted application folder.');
const exe=path.join(dir,'BLACKICE.exe');
const packaged=JSON.parse(await readFile(path.join(dir,'resources','app','package.json'),'utf8'));
const expectedVersion=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8')).version;
assert.equal(packaged.version,expectedVersion);
const profile=await mkdtemp(path.join(tmpdir(),'blackice-exact-installer-'));
let proc=null,closed=false,err=null,stderr='';
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.NODE_OPTIONS;
const poll=async(fn,label,max=35000)=>{
  const cutoff=Date.now()+max;
  let last=null;
  while(Date.now()<cutoff){
    if(proc?.exitCode!==null && proc?.exitCode!==undefined)throw Error('Packaged Electron exited before '+label+' with code '+proc.exitCode);
    try{const value=await fn();if(value)return value;}catch(e){last=e;}
    await sleep(160);
  }
  throw Error(label+' timed out'+(last?': '+last.message:''));
};
const run=(args)=>{
  const instance=spawn(exe,args,{cwd:dir,windowsHide:true,
    stdio:['ignore','pipe','pipe'],env});
  instance.stderr?.on('data',buffer=>{stderr=(stderr+String(buffer)).slice(-3500);});
  return instance;
};
const check=async (url,cookie,{method='GET',payload}={})=>{
  const res=await fetch(url,{method,credentials:'same-origin',
    headers:{...(cookie?{Cookie:cookie}:{}),...(payload?{'Content-Type':'application/json'}:{})},
    body:payload?JSON.stringify(payload):undefined,
    signal:AbortSignal.timeout(15000)});
  const body=await res.text();
  let data;try{data=JSON.parse(body);}catch{data=body;}
  return{status:res.status,headers:res.headers,data,body};
};
const started=Date.now();
try{
  await stat(exe);
  proc=run(['--headless','--profile-dir',profile]);
  const rt=await poll(async()=>{
    const content=await readFile(path.join(profile,'desktop-runtime.json'),'utf8');
    const value=JSON.parse(content);
    return value.url && value.pid===proc.pid ? value : null;
  },'runtime registration');
  assert.equal(rt.version,expectedVersion);
  assert.equal(rt.profileMode,'custom');
  assert.equal(rt.lifecycle?.mode,'headless');
  assert.equal(rt.lifecycle?.windowVisible,false);
  const ready=await poll(async()=>{
    const response=await check(rt.url+'/');
    return response.status===200?response:null;
  },'HTTP server readiness');
  assert.match(ready.body,/\/next\/app\.mjs/,'V2 must be the default served from the actual binary.');
  const cookie=(ready.headers.get('set-cookie')||'').split(';',1)[0];
  assert.ok(cookie.includes('='),'Same-profile session cookie required.');
  const old=await check(rt.url+'/legacy/',cookie);
  assert.equal(old.status,200);
  assert.match(old.body,/\/app\.js/,'Classic recovery route must still be available.');
  const asset=await check(rt.url+'/next/chat/reader-worker.mjs',cookie);
  assert.equal(asset.status,200);
  assert.match(asset.headers.get('content-type')||'',/javascript/);
  const health=await check(rt.url+'/api/status',cookie);
  assert.equal(health.status,200);
  const runtimeSettings=await check(rt.url+'/api/runtime/settings',cookie);
  const executionSettings=await check(rt.url+'/api/execution/settings',cookie);
  assert.equal(runtimeSettings.status,200);
  assert.equal(executionSettings.status,200);
  const browser=await check(rt.url+'/api/browser/status?view=contained',cookie);
  assert.equal(browser.status,200);
  const open=await check(rt.url+'/api/browser/action',cookie,{method:'POST',
    payload:{action:'open',browser:'relay',url:rt.url+'/next/'}});
  assert.equal(open.status,200,JSON.stringify(open.data).slice(0,400));
  assert.ok(open.data.tabId,'Contained native Chromium tab must have a session identity.');
  const observed=await poll(async()=>{
    const value=await check(rt.url+'/api/browser/status?view=contained',cookie);
    return value.status===200&&value.data.tabs?.some(tab=>tab.tabId===open.data.tabId)?value:null;
  },'contained browser status');
  const entry=observed.data.tabs.find(tab=>tab.tabId===open.data.tabId);
  assert.equal(entry.visible,false,'Contained tab must stay offscreen without foregrounding another app.');
  // Page reading is non-mutating; allow the first navigation to settle.
  const frame=await poll(async()=>{
    const result=await check(rt.url+'/api/browser/action',cookie,{method:'POST',
      payload:{action:'read',browser:'relay',tabId:open.data.tabId}});
    if(result.status!==200)return null;
    return result.data;
  },'contained browser rendering');
  assert.ok(frame?.frames?.length>0,'Native contained page must return readable frames.');
  // The installed binary's extracted source was verified separately against
  // the release manifest; no test-only renderer injection is permitted here.
  console.log('PASS_EXACT_NSIS_EXTRACTED_ELECTRON',JSON.stringify({
    version:rt.version,startupMs:Date.now()-started,headless:true,
    v2Default:true,legacyRecovery:true,workerDelivered:true,
    runtimeSettings:true,executionSettings:true,containedBrowser:true,
    nativeFrameCount:frame.frames.length,otherWindowsForegrounded:false,
    profileType:'disposable',installedProfileTouched:false,
  }));
}catch(e){err=e;console.error('FAIL_EXACT_NSIS_EXTRACTED_ELECTRON',e.stack||e);if(stderr)console.error('DISPOSABLE_STDERR',stderr.slice(-1000));}
finally{
  if(proc){
    try{
      const quit=run(['--quit','--profile-dir',profile]);
      await Promise.race([new Promise(resolve=>quit.once('exit',resolve)),sleep(5000)]);
      if(quit.exitCode===null)quit.kill();
    }catch{}
    await Promise.race([new Promise(resolve=>proc.once('exit',resolve)),sleep(12000)]);
    closed=proc.exitCode!==null;
    if(!closed){
      // Only the exact disposable child process is eligible for forced cleanup.
      const killer=spawn('taskkill.exe',['/PID',String(proc.pid),'/T','/F'],
        {stdio:'ignore',windowsHide:true});
      await new Promise(resolve=>killer.once('exit',resolve));
      await sleep(250);
      closed=proc.exitCode!==null;
    }
  }
  if(closed)await rm(profile,{recursive:true,force:true,maxRetries:3,retryDelay:300}).catch(()=>{});
  else console.error('Disposable profile not removed while process remains:',profile);
}
if(err)process.exitCode=1;
