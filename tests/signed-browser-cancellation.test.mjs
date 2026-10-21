import test from 'node:test';
import assert from 'node:assert/strict';
import {createSignedBrowserIntegration} from '../lib/signed-browser.mjs';

const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};};
const connected={available:true,browserConnected:true,catalogKind:'neo-run',connectionId:'browseros-neo'};

test('cancelling one chat leaves another chat’s shared browser readiness and focus check alive',async t=>{
  const gate=deferred(),first=new AbortController();let probes=0,preparations=0,underlying;
  const integration=createSignedBrowserIntegration({registerImpl:async({signal})=>{probes++;underlying=signal;await gate.promise;return connected;},prepareWindowImpl:async()=>{preparations++;return{ready:true,policyVerified:true,created:false};}});
  t.after(()=>integration.close());
  const cancelled=integration.refresh({signal:first.signal,startIfNeeded:true});
  const surviving=integration.refresh({startIfNeeded:true});
  first.abort();assert.equal((await cancelled).available,false);assert.equal(underlying.aborted,false);
  gate.resolve();const result=await surviving;
  assert.equal(result.available,true);assert.equal(probes,1);assert.equal(preparations,1);assert.equal(result.backgroundWindow.policyVerified,true);
  assert.ok(Number.isFinite(Date.parse(result.backgroundWindow.checkedAt)));
});

test('a cancelled web request cannot promote a surviving passive settings check into browser startup',async t=>{
  const gate=deferred(),web=new AbortController();let starts=0,preparations=0;
  const integration=createSignedBrowserIntegration({registerImpl:async()=>{await gate.promise;return{available:false,reason:'Not running.'};},startBrowser:async()=>{starts++;return{started:true};},prepareWindowImpl:async()=>{preparations++;return{ready:true};}});
  t.after(()=>integration.close());
  const passive=integration.refresh();const cancelled=integration.refresh({signal:web.signal,startIfNeeded:true});web.abort();
  assert.equal((await cancelled).available,false);gate.resolve();assert.equal((await passive).available,false);
  assert.equal(starts,0);assert.equal(preparations,0);
});

test('cancelling the final waiter aborts discovery before startup and a subsequent call can reconnect',async t=>{
  const began=deferred(),release=deferred(),controller=new AbortController();let probes=0,starts=0,underlying;
  const integration=createSignedBrowserIntegration({registerImpl:async({signal})=>{probes++;underlying=signal;if(probes===1){began.resolve();await release.promise;return{available:false};}return connected;},startBrowser:async()=>{starts++;return{started:true};},prepareWindowImpl:async()=>({ready:true,policyVerified:true,created:false})});
  t.after(()=>integration.close());
  const first=integration.refresh({signal:controller.signal,startIfNeeded:true});await began.promise;controller.abort();assert.equal((await first).available,false);assert.equal(underlying.aborted,true);
  const second=integration.refresh({startIfNeeded:true});release.resolve();assert.equal((await second).available,true);assert.equal(probes,2);assert.equal(starts,0);
});

test('a caller can begin a new refresh immediately after awaiting its previous result',async t=>{
  let probes=0;
  const integration=createSignedBrowserIntegration({registerImpl:async()=>{probes++;return connected;},prepareWindowImpl:async()=>({ready:true,policyVerified:true,created:false})});t.after(()=>integration.close());
  for(let attempt=0;attempt<4;attempt++)assert.equal((await integration.refresh({startIfNeeded:true})).available,true);
  assert.equal(probes,4);
});

test('closing the integration cancels every active waiter and admits no later startup',async()=>{
  const began=deferred();let starts=0;
  const integration=createSignedBrowserIntegration({registerImpl:async({signal})=>{began.resolve();return new Promise(resolve=>signal.addEventListener('abort',()=>resolve({available:false}),{once:true}));},startBrowser:async()=>{starts++;}});
  const first=integration.refresh({startIfNeeded:true}),second=integration.refresh();await began.promise;await integration.close();
  for(const value of await Promise.all([first,second,integration.refresh({startIfNeeded:true})])){assert.equal(value.available,false);assert.match(value.reason,/cancelled/);}
  assert.equal(starts,0);
});

test('a caller waiting for an aborted probe to retire can cancel without waiting for its transport',async t=>{
  const gate=deferred(),first=new AbortController(),second=new AbortController();let probes=0;
  const integration=createSignedBrowserIntegration({registerImpl:async()=>{probes++;await gate.promise;return connected;}});t.after(()=>integration.close());
  const initial=integration.refresh({signal:first.signal});first.abort();await initial;
  const waiting=integration.refresh({signal:second.signal,startIfNeeded:true});second.abort();
  const deadline=new Promise(resolve=>setTimeout(()=>resolve('timeout'),100));
  const result=await Promise.race([waiting,deadline]);
  gate.resolve();assert.notEqual(result,'timeout');assert.equal(result.available,false);assert.equal(probes,1);
});

test('closing between a successful probe and waiter settlement cannot advertise browser availability',async()=>{
  const integration=createSignedBrowserIntegration({registerImpl:async()=>connected});
  const pending=integration.refresh();let closing;queueMicrotask(()=>{closing=integration.close();});
  assert.equal((await pending).available,false);await closing;
  assert.equal(integration.status().available,false);assert.equal(integration.status().browserConnected,false);
  assert.equal((await integration.refresh()).available,false);
});

for(const phase of ['startup','preparation'])test(`a passive settings waiter cannot retain cancelled ${phase} permission`,async t=>{
  const began=deferred(),release=deferred(),web=new AbortController();let permission,effects=0;
  const operation=async({signal})=>{permission=signal;began.resolve();await release.promise;if(!signal.aborted)effects++;return phase==='startup'?{started:!signal.aborted}:{ready:!signal.aborted,policyVerified:true,created:!signal.aborted};};
  const integration=createSignedBrowserIntegration({registerImpl:async()=>phase==='startup'?{available:false}:connected,startBrowser:operation,prepareWindowImpl:operation});t.after(()=>integration.close());
  const passive=integration.refresh(),started=integration.refresh({signal:web.signal,startIfNeeded:true});await began.promise;web.abort();assert.equal((await started).available,false);assert.equal(permission.aborted,true);
  release.resolve();assert.equal((await passive).available,false);assert.equal(effects,0);
});

test('a web requester joining after passive preparation was skipped must receive a fresh focus check',async t=>{
  let probes=0,preparations=0,late;
  const integration=createSignedBrowserIntegration({registerImpl:async()=>{if(++probes===1)queueMicrotask(()=>queueMicrotask(()=>{late=integration.refresh({startIfNeeded:true});}));return connected;},prepareWindowImpl:async()=>{preparations++;return{ready:true,policyVerified:true,created:false};}});t.after(()=>integration.close());
  assert.equal((await integration.refresh()).available,true);
  const result=await late;
  assert.equal(result.available,true);assert.equal(result.backgroundWindow.policyVerified,true);assert.equal(preparations,1);assert.equal(probes,2);
});

test('a replacement web task waits for cancelled preparation to retire before its own check',async t=>{
  const began=deferred(),release=deferred(),first=new AbortController();let probes=0,preparations=0;
  const integration=createSignedBrowserIntegration({registerImpl:async()=>{probes++;return connected;},prepareWindowImpl:async({signal})=>{preparations++;if(preparations===1){began.resolve();await release.promise;}return{ready:!signal.aborted,policyVerified:!signal.aborted,created:false};}});t.after(()=>integration.close());
  const passive=integration.refresh(),cancelled=integration.refresh({signal:first.signal,startIfNeeded:true});await began.promise;first.abort();await cancelled;
  const replacement=integration.refresh({startIfNeeded:true});release.resolve();assert.equal((await passive).available,false);
  const result=await replacement;assert.equal(result.available,true);assert.equal(result.backgroundWindow.policyVerified,true);assert.equal(probes,2);assert.equal(preparations,2);
});
