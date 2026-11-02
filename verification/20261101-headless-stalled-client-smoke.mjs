import assert from 'node:assert/strict';
import net from 'node:net';
import {spawn} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {WorkbenchHeadlessBroker} from '../lib/workbench-headless-broker.mjs';
const name='BLACKICE-Workbench-v1-test-stalled01';
const script=fileURLToPath(new URL('../scripts/workbench-headless-broker.ps1',import.meta.url));
const powershell=path.join(process.env.SystemRoot||'C:\\Windows',
  'System32','WindowsPowerShell','v1.0','powershell.exe');
const child=spawn(powershell,['-NoProfile','-NonInteractive','-WindowStyle','Hidden',
  '-ExecutionPolicy','Bypass','-File',script,'-PipeName',name,'-DiagnosticOnly'],
  {windowsHide:true,stdio:['ignore','pipe','pipe']});
let stderr='';
child.stderr.on('data',chunk=>{stderr=(stderr+chunk.toString()).slice(-2200)});
const broker=new WorkbenchHeadlessBroker({pipeName:name});
let stalled;
try{
  let connected=false;
  for(let i=0;i<60;i++){
    if(child.exitCode!==null)throw Error('Background diagnostic broker exited: '+stderr);
    try{const pong=await broker.call('ping',{},700);assert.equal(pong.diagnostic,true);connected=true;break}
    catch(e){if(e.code!=='WORKBENCH_BROKER_UNAVAILABLE')throw e;await delay(90)}
  }
  assert.ok(connected,'Broker never opened the named pipe: '+stderr);
  await delay(90);
  stalled=net.createConnection(broker.path);
  await Promise.race([new Promise((resolve,reject)=>{
    stalled.once('connect',resolve);stalled.once('error',reject);
  }),delay(2500).then(()=>{throw Error('Silent client never connected')})]);
  // A deliberately silent client would permanently deadlock the former
  // synchronous ReadLine implementation. The broker must recover by itself.
  await delay(3550);
  let recovered=false,tries=0;
  for(;tries<30;tries++){
    try{const pong=await broker.call('ping',{},800);
      assert.equal(pong.diagnostic,true);recovered=true;break;
    }catch(e){if(!['WORKBENCH_BROKER_UNAVAILABLE','WORKBENCH_BROKER_PROTOCOL'].includes(e.code))throw e;
      await delay(90)}
  }
  assert.ok(recovered,'Silent client blocked future requests: '+stderr);
  await delay(100);
  const state=await broker.status();
  assert.equal(state.available,false);
  assert.equal(state.code,'WORKBENCH_BROKER_UNAUTHORIZED');
  for(const [action,args] of [['type',['guest-only-text']],['click',[120,150,1]]]){
    let denied=false;
    for(let i=0;i<12;i++){
      await delay(90);
      try{await broker[action](...args);throw Error('Diagnostic broker unexpectedly accepted '+action)}
      catch(error){if(error.code==='WORKBENCH_BROKER_REJECTED'){denied=true;break}
        if(error.code!=='WORKBENCH_BROKER_UNAVAILABLE')throw error}
    }
    assert.ok(denied,'The diagnostic broker must refuse '+action+' in the guest.');
  }
  console.log(JSON.stringify({silentClientRecovered:true,isolatedDiagnostic:true,
    guestTextRejected:true,guestMouseRejected:true,vmMutations:0,foregroundActivation:false,
    waitMs:3550,recoveryAttempts:tries+1,sessionIsolated:state.available}));
}finally{
  stalled?.destroy();
  child.kill();
  await Promise.race([new Promise(resolve=>child.once('close',resolve)),delay(900)]);
}
