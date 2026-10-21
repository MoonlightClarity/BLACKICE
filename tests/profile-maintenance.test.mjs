import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {prepareProfileMaintenance,runProfileMaintenance,awaitProfileMaintenance,registerMaintenanceHelper,cancelPreparedMaintenance,maintenancePaths,readMaintenanceReceipt} from '../lib/profile-maintenance.mjs';
const execute=promisify(execFile);
async function fixture(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'relay-maintenance-test-')),profile=path.join(root,'Relay'),backup=path.join(root,'point.relay-backup');await fs.mkdir(path.join(profile,'data'),{recursive:true});await fs.writeFile(path.join(profile,'data/chats.json'),'SAVED_ORIGINAL');t.after(async()=>{assert.equal(path.dirname(root),os.tmpdir());assert.match(path.basename(root),/^relay-maintenance-test-/);await fs.rm(root,{recursive:true,force:true});});return{root,profile,backup,prepare:async(mode='backup',extra={})=>{const prepared=await prepareProfileMaintenance({mode,profileDir:profile,backupDir:backup,appVersion:'2.12.0',parentPid:999999999,...extra});await registerMaintenanceHelper(prepared.requestFile,prepared.request.id,process.pid);return prepared;}};}

test('maintenance helper performs a real verified backup and restore, preserving the previous profile',async t=>{
  const f=await fixture(t),backup=await f.prepare();const saved=await runProfileMaintenance({requestFile:backup.requestFile,alive:()=>false});assert.equal(saved.status,'completed');assert.equal(saved.result.files,1);assert.ok(!saved.result.manifest,'receipt is a small summary, not a copy of every private path');
  await fs.writeFile(path.join(f.profile,'data/chats.json'),'NEWER_SAVED_PROFILE');const restore=await f.prepare('restore');const restored=await runProfileMaintenance({requestFile:restore.requestFile,alive:()=>false});assert.equal(restored.status,'completed');assert.equal(await fs.readFile(path.join(f.profile,'data/chats.json'),'utf8'),'SAVED_ORIGINAL');assert.equal(await fs.readFile(path.join(restored.result.previousProfileDir,'data/chats.json'),'utf8'),'NEWER_SAVED_PROFILE');assert.equal((await readMaintenanceReceipt(f.profile)).mode,'restore');
});

test('many simultaneous backup clicks reserve one complete request, without overwriting the winner',async t=>{
  const f=await fixture(t),outcomes=await Promise.allSettled(Array.from({length:20},()=>f.prepare()));const winners=outcomes.filter(result=>result.status==='fulfilled');assert.equal(winners.length,1);assert.ok(outcomes.filter(result=>result.status==='rejected').every(result=>result.reason.code==='MAINTENANCE_BUSY'));
  const winner=winners[0].value,request=JSON.parse(await fs.readFile(winner.requestFile,'utf8'));assert.equal(request.id,winner.request.id);await registerMaintenanceHelper(winner.requestFile,request.id,1234);assert.equal(JSON.parse(await fs.readFile(winner.requestFile,'utf8')).helperPid,1234);await cancelPreparedMaintenance(winner.requestFile,request.id);
});

test('startup waits for a live maintenance owner and never opens or replays its profile work',async t=>{
  const f=await fixture(t),prepared=await f.prepare();let recovered=0;await assert.rejects(awaitProfileMaintenance({profileDir:f.profile,alive:()=>true,timeoutMs:0,recover:async()=>{recovered++;}}),{code:'MAINTENANCE_BUSY'});assert.equal(recovered,0);assert.equal(await fs.readFile(path.join(f.profile,'data/chats.json'),'utf8'),'SAVED_ORIGINAL');await cancelPreparedMaintenance(prepared.requestFile,prepared.request.id);
});

test('a dead maintenance owner recovers its transaction and records interruption without replaying the action',async t=>{
  const f=await fixture(t);await f.prepare();let recovered=0;await awaitProfileMaintenance({profileDir:f.profile,alive:()=>false,recover:async()=>{recovered++;}});assert.equal(recovered,1);assert.equal((await readMaintenanceReceipt(f.profile)).code,'MAINTENANCE_INTERRUPTED');await assert.rejects(fs.access(f.backup));
});

test('a withdrawn helper request cannot run later when its original parent finally exits',async t=>{
  const f=await fixture(t),prepared=await f.prepare();let alive=true,calls=0;const result=await runProfileMaintenance({requestFile:prepared.requestFile,alive:()=>alive,sleep:async()=>{await cancelPreparedMaintenance(prepared.requestFile,prepared.request.id);alive=false;},create:async()=>{calls++;},recover:async()=>{calls++;}});assert.equal(result.status,'cancelled');assert.equal(calls,0);assert.equal(await readMaintenanceReceipt(f.profile),null);
});

test('failed offline work records only a fixed code, preserves the live profile and releases its reservation',async t=>{
  const f=await fixture(t),prepared=await f.prepare();const failed=await runProfileMaintenance({requestFile:prepared.requestFile,alive:()=>false,recover:async()=>{},create:async()=>{throw Object.assign(Error('PRIVATE_KEY_AND_CHAT_TEXT'),{code:'ENOSPC'});}});assert.equal(failed.status,'failed');assert.equal(failed.code,'ENOSPC');assert.doesNotMatch(JSON.stringify(failed),/PRIVATE/);assert.equal(await fs.readFile(path.join(f.profile,'data/chats.json'),'utf8'),'SAVED_ORIGINAL');assert.equal(await fs.readFile(path.join(f.root,'.Relay.maintenance-result.json'),'utf8'),JSON.stringify(failed));
});

test('the packaged helper program runs offline work and relaunches only its supplied local executable',async t=>{
  const f=await fixture(t),prepared=await f.prepare(),launched=path.join(f.root,'relaunch.txt'),launcher=path.join(f.root,'launcher.mjs');await fs.writeFile(launcher,"import{writeFile}from'node:fs/promises';await writeFile(process.argv[2],'RELAUNCHED');");
  const helper=new URL('../desktop/maintenance-helper.mjs',import.meta.url),registered=path.join(f.root,'registered'),bootstrap=path.join(f.root,'bootstrap.mjs');
  await fs.writeFile(bootstrap,`import{access}from'node:fs/promises';let ready=false;for(let i=0;i<1000;i++){try{await access(${JSON.stringify(registered)});ready=true;break;}catch{}await new Promise(r=>setTimeout(r,10));}if(!ready)process.exit(2);process.argv.splice(1,1,${JSON.stringify(helper.pathname.replace(/^\/([A-Za-z]:)/,'$1'))});await import(${JSON.stringify(helper.href)});`);
  let child;const completion=new Promise((resolve,reject)=>{child=execFile(process.env.RELAY_MAINTENANCE_EXECUTABLE||process.execPath,[bootstrap,prepared.requestFile,process.execPath,launcher,launched],{windowsHide:true,timeout:30000,env:{...process.env,ELECTRON_RUN_AS_NODE:'1'}},error=>error?reject(error):resolve());});
  await registerMaintenanceHelper(prepared.requestFile,prepared.request.id,child.pid);await fs.writeFile(registered,'REGISTERED');await completion;
  const end=Date.now()+5000;while(Date.now()<end){try{if(await fs.readFile(launched,'utf8')==='RELAUNCHED')break;}catch{}await new Promise(resolve=>setTimeout(resolve,10));}assert.equal(await fs.readFile(launched,'utf8'),'RELAUNCHED');assert.equal((await readMaintenanceReceipt(f.profile)).status,'completed');
});

test('a parent crash before helper registration cannot admit an unregistered or different helper',async t=>{
  const f=await fixture(t),prepared=await f.prepare();let calls=0;
  for(const helperPid of [null,123456789]){const request=JSON.parse(await fs.readFile(prepared.requestFile,'utf8'));await fs.writeFile(prepared.requestFile,JSON.stringify({...request,helperPid}));const result=await runProfileMaintenance({requestFile:prepared.requestFile,alive:()=>false,create:async()=>{calls++;},recover:async()=>{calls++;}});assert.equal(result.status,'cancelled');}
  assert.equal(calls,0);await cancelPreparedMaintenance(prepared.requestFile,prepared.request.id);
});

test('profile ancestry, an active-work guard and malformed maintenance requests fail before any profile change',async t=>{
  const f=await fixture(t);await assert.rejects(f.prepare('backup',{backupDir:path.join(f.profile,'backup')}),{code:'INVALID_BACKUP_PATH'});await assert.rejects(f.prepare('backup',{assertIdle:async()=>{throw Error('Active work');}}),/Active work/);
  const paths=maintenancePaths(f.profile);await fs.writeFile(paths.request,'{"version":1}');await assert.rejects(awaitProfileMaintenance({profileDir:f.profile,alive:()=>false}),{code:'INVALID_MAINTENANCE_REQUEST'});assert.equal(await fs.readFile(path.join(f.profile,'data/chats.json'),'utf8'),'SAVED_ORIGINAL');
});
