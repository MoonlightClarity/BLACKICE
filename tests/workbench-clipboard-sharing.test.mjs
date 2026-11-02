import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkbenchClipboardSharing} from '../desktop/workbench-clipboard-sharing.mjs';
import {WorkbenchConsoleControl} from '../lib/workbench-console-control.mjs';
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve}};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function fixture(options={}){
  const f={time:1000,host:{hasText:true,fingerprint:'host-a'},guestSequence:7,guestHasText:true,transfers:[],states:0,hostReads:0,settings:[],finishes:[],statuses:[]};
  f.native={accepted:true,detached:true,connected:true,displayReady:true,inputOwner:'user',workbenchWindowHwnd:'101',childHwnd:'102',windowForeground:true,
    clipboard:{enabled:false,pendingPaste:0,pasteEpoch:2,copyRevision:0,copyAgeMs:-1}};
  f.control=new WorkbenchConsoleControl();f.user=await f.control.take();
  const transfer=async(request,{guard})=>{
    f.transfers.push(request.direction);await guard();if(options.transfer)await options.transfer(f,request);
    await guard();
    if(request.direction==='toGuest')f.guestSequence++;else f.host={hasText:true,fingerprint:'guest-'+f.guestSequence};
    return {copied:true,characters:7,guestSequence:f.guestSequence};
  };
  transfer.state=async(_request,{guard})=>{f.states++;await guard();if(options.state)await options.state(f);await guard();return {sequence:f.guestSequence,hasText:f.guestHasText,formats:f.guestHasText?['text/plain']:[]}};
  f.controller=new WorkbenchClipboardSharing({workbench:{consoleControl:f.control},transfer,
    getNativeStatus:async()=>structuredClone(f.native),setNativeClipboard:async enabled=>{f.settings.push(enabled);if(options.enable)await options.enable(f,enabled);f.native.clipboard.enabled=enabled},
    finishNativePaste:async request=>{f.finishes.push(request);if(options.finish)await options.finish(f,request);f.native.clipboard.pendingPaste=0},
    hostClipboardState:()=>{f.hostReads++;return {...f.host}},onStatus:value=>f.statuses.push(value),clock:()=>f.time});
  f.configure=()=>f.controller.configure({enabled:true,controlToken:f.user.controlToken});
  f.observe=()=>f.controller.observe(structuredClone(f.native));
  f.advance=ms=>{f.time+=ms;if(f.native.clipboard.copyAgeMs>=0)f.native.clipboard.copyAgeMs+=ms};
  return f;
}

test('sharing stays off without a current UI user token and never takes or cedes control',async()=>{
  const f=await fixture();await assert.rejects(f.controller.configure({enabled:true}),{code:'WORKBENCH_CONTROL_HELD_BY_USER'});
  await f.controller.configure({enabled:false});await f.observe();assert.equal(f.hostReads,0);assert.equal(f.states,0);assert.deepEqual(f.transfers,[]);
  await f.control.cede(f.user.controlToken);await f.controller.configure({enabled:true});await f.observe();
  assert.equal(f.hostReads,0);assert.equal(f.control.owner,'agent');assert.equal(f.controller.status().active,false);
});

test('first focused user window prefers host text, then unchanged sequence polling carries metadata only',async()=>{
  const f=await fixture();await f.configure();await f.observe();assert.deepEqual(f.transfers,['toGuest']);assert.deepEqual(f.settings,[true]);
  f.advance(500);await f.observe();assert.equal(f.states,2);assert.deepEqual(f.transfers,['toGuest']);
  const reads=f.hostReads;f.native.windowForeground=false;f.advance(500);await f.observe();
  assert.equal(f.hostReads,reads);assert.equal(f.states,2);assert.equal(f.controller.status().active,false);assert.equal(f.control.owner,'user');
});

test('host changes while away are preferred on return and guest-only changes export while focused',async()=>{
  const f=await fixture();await f.configure();await f.observe();
  f.native.windowForeground=false;f.host={hasText:true,fingerprint:'host-b'};f.advance(500);await f.observe();assert.deepEqual(f.transfers,['toGuest']);
  f.native.windowForeground=true;await f.observe();assert.deepEqual(f.transfers,['toGuest','toGuest']);
  f.guestSequence++;f.advance(500);await f.observe();assert.deepEqual(f.transfers,['toGuest','toGuest','fromGuest']);
});

test('pending Ctrl+V copies host text first and resumes exactly once under the original epoch',async()=>{
  const f=await fixture();await f.configure();f.native.clipboard.pendingPaste=3;await f.observe();
  assert.deepEqual(f.transfers,['toGuest']);assert.deepEqual(f.finishes,[{pasteId:3,epoch:2,paste:true}]);
  f.native.clipboard.pendingPaste=3;await f.observe();assert.equal(f.finishes.length,1);assert.equal(f.transfers.length,1);
});

test('an empty or unsupported host clipboard permits existing guest paste without clearing or transfer',async()=>{
  const f=await fixture();f.host={hasText:false,fingerprint:'host-image'};await f.configure();f.native.clipboard.pendingPaste=4;await f.observe();
  assert.deepEqual(f.transfers,[]);assert.deepEqual(f.finishes,[{pasteId:4,epoch:2,paste:true}]);assert.equal(f.host.fingerprint,'host-image');
});

test('copy failure, lost focus or changed paste intent cancel deferred paste and never replay it',async()=>{
  for(const mode of ['failure','blur','epoch','owner']){
    const f=await fixture({transfer:async state=>{
      if(mode==='failure')throw Object.assign(Error('Private text must not become status'),{code:'WORKBENCH_CLIPBOARD_UNCONFIRMED'});
      if(mode==='blur')state.native.windowForeground=false;
      if(mode==='epoch')state.native.clipboard.pasteEpoch++;
      if(mode==='owner')void state.control.cede(state.user.controlToken);
    }});
    await f.configure();f.native.clipboard.pendingPaste=5;await f.observe();
    assert.equal(f.finishes[0].paste,false);assert.equal(f.finishes.length,1);assert.equal(f.transfers.length,1);
    assert.equal(JSON.stringify(f.controller.status()).includes('Private text'),false);
  }
});

test('Ctrl+C followed by quick Alt+Tab waits for a new guest sequence then exports within its bounded intent',async()=>{
  const f=await fixture();await f.configure();await f.observe();const before=f.guestSequence;
  f.native.clipboard.copyRevision=1;f.native.clipboard.copyAgeMs=20;f.native.windowForeground=false;
  await f.observe();assert.equal(f.guestSequence,before);assert.deepEqual(f.transfers,['toGuest']);assert.equal(f.controller.status().reason,'waiting-for-new-copy');
  f.guestSequence++;f.advance(500);await f.observe();assert.deepEqual(f.transfers,['toGuest','fromGuest']);
  assert.equal(f.control.owner,'user');
});

test('a newer host copy after Ctrl+C or an expired copy intent cannot be overwritten after blur',async()=>{
  for(const mode of ['host','expired']){
    const f=await fixture();await f.configure();await f.observe();
    f.native.clipboard.copyRevision=1;f.native.clipboard.copyAgeMs=20;f.native.windowForeground=false;f.guestSequence++;
    if(mode==='host')f.host={hasText:true,fingerprint:'new-host-copy'};else f.native.clipboard.copyAgeMs=2001;
    f.advance(500);await f.observe();assert.deepEqual(f.transfers,['toGuest']);assert.notEqual(f.host.fingerprint,'guest-'+f.guestSequence);
  }
});

test('rapid observations coalesce behind one in-flight state read and paste is handled next',async()=>{
  const held=deferred();let first=true;
  const f=await fixture({state:async()=>{if(first){first=false;await held.promise}}});await f.configure();
  const running=f.observe();await tick();
  f.native.clipboard.pendingPaste=9;const queued=Array.from({length:20},()=>f.observe());assert.equal(f.states,1);
  held.resolve();await Promise.all([running,...queued]);assert.equal(f.finishes.length,1);assert.equal(f.finishes[0].pasteId,9);
  assert.ok(f.states<=2,'Only the priming read and one coalesced follow-up may run');
});

test('disable or close during a stalled operation prevents its late host commit and disables interception',async()=>{
  for(const operation of ['disable','close']){
    const held=deferred();let first=true;
    const f=await fixture({state:async()=>{if(first){first=false;await held.promise}}});await f.configure();const running=f.observe();await tick();
    if(operation==='close')await f.controller.close();else await f.controller.configure({enabled:false});
    held.resolve();await running;assert.deepEqual(f.transfers,[]);assert.equal(f.native.clipboard.enabled,false);assert.equal(f.controller.status().active,false);
  }
});

test('new helper identity and ownership revision invalidate pending work without reusing private tokens',async()=>{
  const f=await fixture();await f.configure();await f.observe();
  await f.control.take();f.advance(500);const before=f.hostReads;await f.observe();
  assert.equal(f.hostReads,before);assert.equal(f.native.clipboard.enabled,false);assert.equal(f.controller.status().active,false);
  assert.equal('controlToken' in f.controller.status(),false);assert.equal('fingerprint' in f.controller.status(),false);
});

test('a late native enable is followed by disable after close, configure off, or ownership loss',async()=>{
  for(const mode of ['close','disable','owner']){
    const held=deferred(),entered=deferred();let initial=true;
    const f=await fixture({enable:async(_state,enabled)=>{if(enabled&&initial){initial=false;entered.resolve();await held.promise}}});
    await f.configure();const running=f.observe();await entered.promise;
    let closing;
    if(mode==='close')closing=f.controller.close();
    else if(mode==='disable')closing=f.controller.configure({enabled:false});
    else await f.control.cede(f.user.controlToken);
    held.resolve();await Promise.all([running,closing]);
    assert.equal(f.native.clipboard.enabled,false);assert.equal(f.controller.status().active,false);assert.deepEqual(f.transfers,[]);
  }
});

test('the very first Ctrl+C after enabling has a pre-interception guest sequence and focused host baseline',async()=>{
  let first=true;
  const f=await fixture({enable:async(state,enabled)=>{if(enabled&&first){first=false;state.guestSequence++;
    state.native.clipboard.copyRevision=1;state.native.clipboard.copyAgeMs=10;state.native.windowForeground=false;}}});
  await f.configure();await f.observe();assert.deepEqual(f.transfers,['fromGuest']);assert.equal(f.controller.status().active,true);
});

test('a failed explicit guest copy is consumed rather than retried on subsequent status ticks',async()=>{
  const f=await fixture({transfer:async(_state,request)=>{if(request.direction==='fromGuest')throw Object.assign(Error('uncertain'),{code:'WORKBENCH_CLIPBOARD_UNCONFIRMED'})}});
  await f.configure();await f.observe();f.guestSequence++;f.native.clipboard.copyRevision=1;f.native.clipboard.copyAgeMs=10;
  await f.observe();f.advance(500);await f.observe();assert.deepEqual(f.transfers,['toGuest','fromGuest']);
});

test('a paste completion settling after disable or close cannot publish active sharing',async()=>{
  for(const mode of ['disable','close']){
    const held=deferred(),entered=deferred();
    const f=await fixture({finish:async()=>{entered.resolve();await held.promise}});await f.configure();
    f.native.clipboard.pendingPaste=22;const running=f.observe();await entered.promise;
    if(mode==='disable')await f.controller.configure({enabled:false});else await f.controller.close();
    held.resolve();await running;assert.equal(f.controller.status().enabled,false);assert.equal(f.controller.status().active,false);
    assert.notEqual(f.controller.status().reason,'sharing');
  }
});

test('automatic sharing preserves a zero guest sequence baseline and detects the first real copy',async()=>{
  const f=await fixture();f.guestSequence=0;f.host={hasText:false,fingerprint:'empty-host'};await f.configure();await f.observe();
  assert.deepEqual(f.transfers,[]);assert.equal(f.controller.guestSequence,0);
  f.guestSequence=1;f.native.clipboard.copyRevision=1;f.native.clipboard.copyAgeMs=10;f.advance(500);await f.observe();
  assert.deepEqual(f.transfers,['fromGuest']);
});
