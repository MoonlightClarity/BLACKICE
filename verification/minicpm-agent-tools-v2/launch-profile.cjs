'use strict';
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const {createHash}=require('node:crypto'),{pathToFileURL}=require('node:url'),assert=require('node:assert/strict');
const config={
  "candidateRoot": "C:\\Users\\user\\Documents\\Codex\\BLACKICE-minicpm-agent-tools-20261122",
  "profileDir": "C:\\Users\\user\\Documents\\Codex\\BLACKICE-minicpm-resume-evidence-20261121\\postmerge-20261121\\quality-settings-01\\NQ1-native-qualification-01\\profile",
  "receiptDir": "C:\\Users\\user\\Documents\\Codex\\BLACKICE-minicpm-resume-evidence-20261121\\postmerge-20261121\\quality-settings-01\\NQ1-native-qualification-01\\receipts",
  "primaryProfile": "C:\\Users\\user\\AppData\\Roaming\\Relay",
  "preparationSha256": "5bc7b0006fada99b71d9e27077a8783148684bb0c744531c3a46ad136b37745f"
};
const sha=b=>createHash('sha256').update(b).digest('hex');
const same=(a,b)=>path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase();
const alive=pid=>{try{process.kill(pid,0);return true;}catch(e){if(e.code==='ESRCH')return false;throw e;}};
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function optional(file){try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}}
function saveNew(file,value){const b=Buffer.from(JSON.stringify(value,null,2)+'\n');fs.writeFileSync(file,b,{flag:'wx'});assert(fs.readFileSync(file).equals(b));return {path:file,bytes:b.length,sha256:sha(b)};}
async function main(){
  assert.equal(process.argv.length,2);
  const prepFile=path.join(config.receiptDir,'prepared.json'),prepBytes=fs.readFileSync(prepFile);
  assert.equal(sha(prepBytes),config.preparationSha256);const prep=JSON.parse(prepBytes);
  assert.equal(prep.status,'prepared');assert(same(prep.profileDir,config.profileDir));assert(same(prep.candidateRoot,config.candidateRoot));
  const runtimeFile=path.join(config.profileDir,'desktop-runtime.json');
  assert(!fs.existsSync(runtimeFile),'A candidate is still running; do not duplicate its launch.');
  const oldLaunchFile=path.join(config.receiptDir,'launch.json'),oldLaunchBytes=fs.readFileSync(oldLaunchFile);
  const oldLaunch=JSON.parse(oldLaunchBytes),oldLaunchHash=sha(oldLaunchBytes);
  const cleanup=JSON.parse(fs.readFileSync(path.join(config.receiptDir,'cleanup-attempt-01.cli.json'),'utf8'));
  assert.equal(cleanup.cli.exitCode,0);assert.equal(cleanup.pid,oldLaunch.process.pid);
  assert(!alive(oldLaunch.process.pid),'The earlier owned app must be fully closed.');
  for(const f of [path.join(config.receiptDir,'launch-intent-02.json'),path.join(config.receiptDir,'spawn-02.json')])
    assert(!fs.existsSync(f),'This attempt already has evidence; recover it instead of launching again.');
  const primaryFile=path.join(config.primaryProfile,'desktop-runtime.json'),primaryBefore=optional(primaryFile);
  assert(primaryBefore&&alive(primaryBefore.pid),'Primary app identity must be observed before isolated startup.');
  const {appFingerprint}=await import(pathToFileURL(path.join(config.candidateRoot,'scripts/release-check.mjs')).href);
  const fingerprint=await appFingerprint(config.candidateRoot);
  const sourceCommit=cp.execFileSync('git',['rev-parse','HEAD'],{cwd:config.candidateRoot,encoding:'utf8'}).trim();
  const args=[config.candidateRoot,'--profile-dir',config.profileDir,'--headless'];
  saveNew(path.join(config.receiptDir,'launch-intent-02.json'),{schema:'blackice.native-candidate-launch-intent.v1',
    createdAt:new Date().toISOString(),profileDir:config.profileDir,candidateRoot:config.candidateRoot,rawElectron:prep.rawElectron,args,
    appFingerprint:fingerprint,sourceCommit,primary:{pid:primaryBefore.pid,startedAt:primaryBefore.startedAt}});
  const nativeSource=path.join(config.candidateRoot,'desktop/native-app-launcher.cs');
  assert.equal(sha(fs.readFileSync(nativeSource)),'ff60a3dd015fea79332519d0c3388d3b8f0755197e1bc501c380f8140f653c24');
  const literal=value=>"'"+String(value).replaceAll("'","''")+"'";
  const payload={executable:prep.rawElectron,arguments:args,directory:config.candidateRoot};
  const ps="$ErrorActionPreference='Stop'; Add-Type -Path "+literal(nativeSource)+"; $nqLaunchInput=ConvertFrom-Json -InputObject "+literal(JSON.stringify(payload))+"; [BlackiceApplicationLauncher]::Executable([string]$nqLaunchInput.executable,[string[]]$nqLaunchInput.arguments,[string]$nqLaunchInput.directory) | ConvertTo-Json -Compress";
  const launched=cp.spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',ps],
    {cwd:config.candidateRoot,encoding:'utf8',timeout:30000,maxBuffer:256000,windowsHide:true});
  assert.equal(launched.status,0,'Native launcher failed: '+launched.stderr);
  const native=JSON.parse(launched.stdout.trim());assert.equal(native.launched,true);assert(Number.isSafeInteger(native.pid)&&native.pid>0);
  const child={pid:native.pid};
  saveNew(path.join(config.receiptDir,'spawn-02.json'),{...native,spawnedAt:new Date().toISOString(),executable:prep.rawElectron,args,
    appFingerprint:fingerprint,launcherSourceSha256:sha(fs.readFileSync(nativeSource)),inheritHandles:false});
  const end=Date.now()+55000;let runtime=null,ready=null;
  while(Date.now()<end){
    assert(alive(child.pid),'Owned candidate exited before readiness.');
    runtime=optional(runtimeFile);
    const diagnostics=path.join(config.profileDir,'diagnostics','events.0.jsonl');
    if(fs.existsSync(diagnostics)){
      const lines=fs.readFileSync(diagnostics,'utf8').trim().split(/\r?\n/);
      const events=lines.flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}});
      ready=events.findLast(event=>event.component==='desktop'&&event.event==='ready'&&runtime&&Date.parse(event.at)>=Date.parse(runtime.startedAt));
    }
    if(runtime&&ready)break;
    await sleep(250);
  }
  assert(runtime&&ready,'Owned candidate readiness deadline expired; inspect spawn receipt before recovery.');
  assert.equal(runtime.pid,child.pid);assert.equal(runtime.profileMode,'custom');assert(same(runtime.executable,prep.rawElectron));
  assert(runtime.capabilities?.electron===true&&runtime.capabilities?.nativeRestart===true);
  const origin=new URL(runtime.url);assert(['127.0.0.1','localhost','[::1]'].includes(origin.hostname));assert.equal(origin.protocol,'http:');
  const page=await fetch(runtime.url,{signal:AbortSignal.timeout(10000)});assert.equal(page.status,200);
  const cookie=page.headers.get('set-cookie')?.split(';',1)[0];assert(cookie,'Missing loopback session cookie');await page.arrayBuffer();
  const catalogDeadline=Date.now()+50000;let status;
  do{
    const response=await fetch(new URL('/api/status',runtime.url),{headers:{Cookie:cookie},signal:AbortSignal.timeout(15000)});
    assert.equal(response.status,200);status=await response.json();
    if(status.codex?.connected===true&&status.models?.some(model=>model.id==='gpt-6-luna'))break;
    await sleep(500);
  }while(Date.now()<catalogDeadline);
  const statusReceipt=saveNew(path.join(config.receiptDir,'startup-status-02.json'),status);
  assert(status.codex?.connected===true,'Native Codex connection did not become ready.');
  assert(status.models?.some(model=>model.id==='gpt-6-luna'),'Native Luna model was not in the actual catalog.');
  assert.equal(status.defaultModel,'gpt-6-luna');assert.equal(status.runtimeSettings.defaultContext.preset,'model');
  assert(status.runtimeSettings.defaultContext.windowTokens==null);assert.equal(status.runtimeSettings.defaultEffort,'default');
  assert.equal(status.providers.find(provider=>provider.id==='local_llamacpp').outputTokenPolicy,'provider-default');
  assert.equal(status.execution.activeCount,0);assert.equal(status.activeTurns,0);
  assert.equal(await appFingerprint(config.candidateRoot),fingerprint,'Candidate source changed during startup.');
  const primaryAfter=optional(primaryFile);assert(primaryAfter);assert.equal(primaryAfter.pid,primaryBefore.pid);assert.equal(primaryAfter.startedAt,primaryBefore.startedAt);assert(alive(primaryAfter.pid));
  const record={schema:'blackice.native-candidate-launch.v1',status:'ready',readyAt:new Date().toISOString(),
    profileDir:config.profileDir,candidateRoot:config.candidateRoot,rawElectron:prep.rawElectron,appFingerprint:fingerprint,sourceCommit,
    process:{pid:runtime.pid,startedAt:runtime.startedAt,executable:runtime.executable,url:runtime.url,version:runtime.version,profileMode:runtime.profileMode},
    capabilities:runtime.capabilities,diagnosticReady:ready,startupStatus:statusReceipt,
    primaryProcessUnchanged:true,modelInference:false,profileReusedAcrossTasks:true,contextIsolationEvidence:false};
  const attemptReceipt=saveNew(path.join(config.receiptDir,'launch-attempt-02.json'),record);
  assert.equal(sha(fs.readFileSync(oldLaunchFile)),oldLaunchHash,'Canonical launch binding changed.');
  saveNew(path.join(config.receiptDir,'launch-attempt-01.json'),oldLaunch);
  const canonicalBytes=Buffer.from(JSON.stringify(record,null,2)+'\n'),temporary=oldLaunchFile+'.attempt02.tmp';
  fs.writeFileSync(temporary,canonicalBytes,{flag:'wx'});assert.equal(sha(fs.readFileSync(oldLaunchFile)),oldLaunchHash);
  fs.renameSync(temporary,oldLaunchFile);assert(fs.readFileSync(oldLaunchFile).equals(canonicalBytes));
  const saved={path:oldLaunchFile,bytes:canonicalBytes.length,sha256:sha(canonicalBytes)};
  console.log(JSON.stringify({status:'ready',receipt:saved,process:record.process,appFingerprint:fingerprint,
    primaryProcessUnchanged:true,modelInference:false,startupStatus:statusReceipt}));
}
main().then(()=>new Promise(resolve=>process.stdout.write('',resolve))).then(()=>process.exit(0)).catch(error=>{
  const message=JSON.stringify({status:'launch-failed',name:error.name,code:error.code||null,message:error.message})+'\n';
  process.stderr.write(message,()=>process.exit(1));
});
