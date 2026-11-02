import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {WorkbenchHeadlessBroker} from '../lib/workbench-headless-broker.mjs';
const ps=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
const script=fileURLToPath(new URL('../scripts/workbench-headless-broker.ps1',import.meta.url));
const name='BLACKICE-Workbench-v1-test-smoke01';
const child=spawn(ps,['-NoProfile','-NonInteractive','-WindowStyle','Hidden','-ExecutionPolicy','Bypass',
  '-File',script,'-PipeName',name,'-DiagnosticOnly'],
  {windowsHide:true,stdio:['ignore','pipe','pipe']});
let stderr='';
child.stderr.on('data',chunk=>stderr=(stderr+chunk.toString('utf8')).slice(-2500));
const broker=new WorkbenchHeadlessBroker({pipeName:name});
try{
  let ping,attempts=0;
  for(;attempts<50;attempts++){
    if(child.exitCode!==null)throw Error('The diagnostic broker exited: '+stderr);
    try{ping=await broker.call('ping',{},700);break}
    catch(e){if(e.code!=='WORKBENCH_BROKER_UNAVAILABLE')throw e;await delay(90)}
  }
  assert.ok(ping,'Diagnostic named-pipe broker did not open: '+stderr);
  assert.equal(ping.broker,'BLACKICE-Workbench');
  assert.equal(ping.diagnostic,true);
  await delay(120); // the single-instance pipe server must re-arm after each connection
  const status=await broker.status();
  assert.equal(status.available,false);
  assert.equal(status.code,'WORKBENCH_BROKER_UNAUTHORIZED');
  await assert.rejects(broker.key('ENTER'),{code:'WORKBENCH_BROKER_REJECTED'});
  await assert.rejects(broker.stop(),{code:'WORKBENCH_BROKER_REJECTED'});
  console.log(JSON.stringify({transport:'verified',namedPipe:broker.path,ping,unauthorizedStatus:status,
    guestKeyRejected:true,vmStopRejected:true,spawnHidden:true,hostElevationRequested:false,childPid:child.pid,
    attempts:attempts+1}));
}finally{
  child.kill();
  await Promise.race([new Promise(resolve=>child.once('close',resolve)),delay(1000)]);
}
