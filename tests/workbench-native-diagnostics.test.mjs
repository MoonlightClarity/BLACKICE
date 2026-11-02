import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {WindowsWorkbench} from '../lib/windows-workbench.mjs';
import {createWorkbenchAgentToolHandler} from '../lib/workbench-agent-tools.mjs';
import {nativeConnectionDiagnostics,nativeConnectionAttempt,nativeCleanupReceipt,nativeAttemptAvailabilityMeaning} from '../lib/workbench-native-diagnostics.mjs';

const cleanup={confirmed:true,exited:true,started:true,forced:true,exitCode:7,signal:'SIGTERM'};
const attempt={status:'failed',code:'CONNECT_FAILED',acknowledged:true,uncertain:false,at:'2026-11-02T06:45:11.345Z',cleanup,
  diagnostics:{connected:false,coreError:131077,digestReady:true,certificateVerified:false,decodedFrames:0,nlaAuthRequests:1,deniedAuthRequests:0,
    connectionProgress:{state:'CONNECTION_STATE_NLA',tlsStarted:true,tlsFinished:false,readBytes:321,password:'private-token'},
    pixels:'private-pixels',path:'C:/private-path',username:'private-user'},rawStderr:'private-stderr',helperPath:'C:/private-helper'};

test('diagnostic allowlist strips sensitive and invalid fields with independent bounded state/counter checks',()=>{
  const result=nativeConnectionDiagnostics({...attempt.diagnostics,coreError:0x100000000,decodedFrames:-1,selectedProtocol:NaN,surface:{width:4097,height:600,sequence:1,bytes:'private-pixels'}});
  assert.equal(result.coreError,undefined);assert.equal(result.decodedFrames,undefined);assert.equal(result.selectedProtocol,undefined);assert.deepEqual(result.surface,{sequence:1,height:600});
  assert.equal(JSON.stringify(result).includes('private'),false);
  assert.deepEqual(nativeConnectionDiagnostics({connectionProgress:{state:'CONNECTION_STATE_PRIVATE_SECRET',readBytes:Infinity},authenticationServer:'private-host'}),null);
  assert.equal(nativeCleanupReceipt({...cleanup,confirmed:false}),null);
  assert.deepEqual(nativeCleanupReceipt({...cleanup,exitCode:Infinity,signal:'private-secret'}),{...cleanup,exitCode:null,signal:null});
});
test('explicit retry is a recommendation after acknowledged failure and confirmed exit, never an enforced task limit',()=>{
  const result=nativeConnectionAttempt(attempt);assert.equal(result.explicitRetryAllowed,true);assert.equal(result.retryRecommendation,'one-fresh-explicit-attempt');assert.equal(result.retryLimitEnforced,false);assert.equal(JSON.stringify(result).includes('private'),false);
  for(const changed of [{acknowledged:false},{uncertain:true},{cleanup:{...cleanup,confirmed:false,exited:false}},{code:'CONNECT_TIMEOUT'}])assert.equal(nativeConnectionAttempt({...attempt,...changed}).explicitRetryAllowed,false);
});
test('last connection attempt survives Windows status and model-tool error without paths, stderr or pixels',async t=>{
  const workbench=new WindowsWorkbench({dataDir:path.resolve('fixture-native-diagnostic'),probe:async()=>assert.fail('No live probe.')});
  await workbench.setGuestNativeConsoleAdapter({frame:async()=>assert.fail('No image needed.'),input:async()=>{},
    availability:async()=>({backendAttached:true,openAvailable:true,attached:false,connected:false,displayReady:false,windowVisible:false,uncertain:false,code:'WORKBENCH_NATIVE_NOT_ATTACHED',availabilityMeaning:nativeAttemptAvailabilityMeaning,lastConnectionAttempt:attempt}),
    open:async()=>{throw Object.assign(Error('Connection ended.'),{code:'CONNECT_FAILED',nativeConnectionAttempt:attempt});}});
  const status=await workbench.guestNativeConsoleStatus();assert.equal(status.availabilityMeaning,nativeAttemptAvailabilityMeaning);assert.equal(status.lastConnectionAttempt.cleanup.exitCode,7);assert.equal(JSON.stringify(status).includes('private'),false);
  const handler=createWorkbenchAgentToolHandler({workbench,scope:'native-diagnostic-fixture',jobs:{}});t.after(()=>handler.close());
  const result=await handler({name:'relay_workbench',callId:'actual-native-error',arguments:{action:'open_viewer'}}),value=JSON.parse(result.contentItems[0].text);
  assert.equal(result.success,false);assert.equal(result.code,'CONNECT_FAILED');assert.equal(value.nativeConnectionAttempt.diagnostics.coreError,131077);assert.equal(value.nativeConnectionAttempt.cleanup.confirmed,true);assert.equal(value.nativeConnectionAttempt.explicitRetryAllowed,true);assert.equal(value.nativeConnectionAttempt.retryLimitEnforced,false);
  assert.equal(JSON.stringify(result).includes('private'),false);assert.deepEqual(workbench.consoleControl.status(),{owner:'agent',revision:0});
});
test('a malformed last-attempt value is omitted from an otherwise valid open acknowledgement',async()=>{
  const workbench=new WindowsWorkbench({dataDir:path.resolve('fixture-native-diagnostic-success')});
  await workbench.setGuestNativeConsoleAdapter({frame:async()=>{},input:async()=>{},open:async()=>({accepted:true,detached:true,uncertain:false,connected:true,displayReady:true,opened:true,windowVisible:true,lastConnectionAttempt:{path:'private'}})});
  const receipt=await workbench.guestNativeConsoleOpen();assert.equal(receipt.lastConnectionAttempt,undefined);assert.equal(JSON.stringify(receipt).includes('private'),false);
});
