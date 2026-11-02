import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {inflateSync} from 'node:zlib';
import {WorkbenchAgentJobs,workbenchFramePng} from '../lib/workbench-agent-tools.mjs';
import {WorkbenchConsoleControl} from '../lib/workbench-console-control.mjs';

const tick=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r});return {promise,resolve}};
const exists=async file=>{try{await fs.stat(file);return true}catch(error){if(error.code==='ENOENT')return false;throw error}};
async function fixture(t,{terminationProven=true}={}){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'blackice-vm-job-fence-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  await fs.mkdir(path.join(root,'.blackice-workbench'));
  const supervisor=path.join(root,'supervisor-fixture.ps1');await fs.writeFile(supervisor,'# fixed fixture; never executed');
  const control=new WorkbenchConsoleControl(),cancelObserved=deferred(),releaseTermination=deferred(),launches=[];
  const agent={online:true,paired:true,sharedReadWriteVerified:true,agentId:'a'.repeat(32),guestSessionId:2,heartbeatAt:new Date(10000).toISOString(),
    expectedGuestRoot:'W:\\',guestName:'FIXTURE-GUEST',capabilities:['launch','windows','capture']};
  const bridge={workspace:root,agentStatus:async()=>({...agent}),request:async(kind,args)=>{
    launches.push({kind,args});return {status:'completed',kind,agentId:agent.agentId,guestSessionId:2,result:{processId:123}};
  }};
  const workbench={consoleControl:control,bridge:()=>bridge,status:async()=>({backend:'hyper-v',vmName:'BLACKICE-Workbench',
    guest:{running:true},canRunNativeApps:true,capability:{hostName:'FIXTURE-HOST'},config:{folders:[{id:'workspace',hostPath:root,
      guestMountVerified:true,hostSharePrepared:true,readWrite:true}]}})};
  let time=10000,jobs,receiptWritten=false;
  const sleep=async milliseconds=>{
    time+=milliseconds;await tick();const entry=jobs.active;if(!entry?.meta)return;
    if(await exists(path.join(entry.folder,'cancel.json'))){
      cancelObserved.resolve();
      if(terminationProven&&!receiptWritten){
        await releaseTermination.promise;receiptWritten=true;
        const meta=entry.meta;
        await fs.writeFile(path.join(entry.folder,'result.json'),JSON.stringify({version:1,jobId:meta.jobId,scopeHash:meta.scopeHash,
          scriptSha256:meta.scriptSha256,agentId:meta.agentId,guestSessionId:meta.guestSessionId,status:'cancelled',exitCode:1,
          stdout:'',stderr:'',childrenStopped:true,finishedAt:new Date(time).toISOString()}));
      }
    }
  };
  jobs=new WorkbenchAgentJobs({workbench,clock:()=>time,sleep,hostName:()=> 'FIXTURE-HOST',supervisor,leaseKeeperFactory:()=>({ready:Promise.resolve(),error:null,stop:async()=>{}})});
  return {root,control,jobs,launches,cancelObserved,releaseTermination};
}
test('a queued human Take waits for the exact guest termination receipt before acknowledging USER',async t=>{
  const f=await fixture(t);const launched=await f.jobs.start('fixture-task',{requestId:'one',script:'Write-Output fixture',timeoutMs:30000});
  assert.equal(launched.status,'running');assert.equal(f.launches.length,1);const work=f.jobs.active.work;
  let taken=false;const taking=f.control.take().then(value=>{taken=true;return value});
  await f.cancelObserved.promise;await tick();assert.equal(taken,false);assert.equal(f.control.status().owner,'agent');
  f.releaseTermination.resolve();await work;const user=await taking;assert.equal(user.owner,'user');
  assert.equal(f.launches.length,1);assert.equal((await f.jobs.inspect('fixture-task',launched.jobId)).childrenStopped,true);
});
test('unknown guest termination revokes a queued Take instead of acknowledging USER or replaying launch',async t=>{
  const f=await fixture(t,{terminationProven:false});const launched=await f.jobs.start('fixture-task',{requestId:'one',script:'Write-Output fixture',timeoutMs:30000});
  const work=f.jobs.active.work,settled=assert.rejects(work,{code:'WORKBENCH_CONSOLE_CONTROL_UNAVAILABLE'});
  const taking=assert.rejects(f.control.take());await f.cancelObserved.promise;await Promise.all([settled,taking]);
  assert.equal(f.control.status().owner,'none');assert.equal(f.launches.length,1);
  assert.equal((await f.jobs.inspect('fixture-task',launched.jobId)).status,'uncertain');
});
test('decoded BMP image conversion preserves top-down and bottom-up RGB without host screenshot APIs',()=>{
  const frame=bottomUp=>{
    const bytes=Buffer.alloc(62);bytes.write('BM');bytes.writeUInt32LE(54,10);bytes.writeUInt32LE(40,14);
    bytes.writeInt32LE(1,18);bytes.writeInt32LE(bottomUp?2:-2,22);bytes.writeUInt16LE(1,26);bytes.writeUInt16LE(32,28);
    Buffer.from(bottomUp?[255,0,0,0,0,0,255,0]:[0,0,255,0,255,0,0,0]).copy(bytes,54);return {bytes,width:1,height:2};
  };
  const top=workbenchFramePng(frame(false)),bottom=workbenchFramePng(frame(true));assert.deepEqual(top,bottom);
  assert.deepEqual(top.subarray(0,8),Buffer.from([137,80,78,71,13,10,26,10]));
  const parts=[];for(let offset=8;offset<top.length;){const length=top.readUInt32BE(offset);if(top.toString('ascii',offset+4,offset+8)==='IDAT')parts.push(top.subarray(offset+8,offset+8+length));offset+=length+12;}
  assert.deepEqual(inflateSync(Buffer.concat(parts)),Buffer.from([0,255,0,0,0,0,0,255]));
  const malformed=frame(false);malformed.bytes.writeUInt32LE(16,30);assert.throws(()=>workbenchFramePng(malformed),{code:'WORKBENCH_AGENT_FRAME'});
});
