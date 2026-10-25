import test from 'node:test';
import assert from 'node:assert/strict';
import {nativePageBounds,nativeBrowserTabs,nativeBrowserSelection,createNativeBrowserSurface} from '../public/next/workspaces/browser-native.mjs';

const bounds={x:10,y:130,width:950,height:600};
const settle=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};

test('native page geometry uses viewport CSS coordinates and clips without covering browser chrome',()=>{
  assert.deepEqual(nativePageBounds({left:10.2,top:130.1,width:950.6,height:600.2},{width:1200,height:900}),{x:11,y:131,width:949,height:599});
  assert.deepEqual(nativePageBounds({left:-10,top:80,width:1100,height:800},{width:1000,height:700}),{x:0,y:80,width:1000,height:620});
  assert.equal(nativePageBounds({left:0,top:0,width:0,height:200},{width:1000,height:700}),null);
  assert.equal(nativePageBounds({left:1200,top:100,width:100,height:200},{width:1000,height:700}),null);
  assert.equal(nativePageBounds({left:0,top:NaN,width:100,height:200},{width:1000,height:700}),null);
});

test('native browser includes visible user and task tabs and follows current contained selection',()=>{
  const user={tabId:'user',browser:'relay',visible:true,url:'https://example.test'},
    task={tabId:'task',browser:'relay',visible:false,owner:{taskId:'task-owner'}},
    driver={tabId:'driver',contained:true,visible:true};
  const status={activeTab:'task',browsers:{relay:{activeTab:'user'}},tabs:[user,task,driver,
    {tabId:'external',browser:'firefox'},{tabId:'retired',browser:'relay',purpose:'chat-mode'},null]};
  assert.deepEqual(nativeBrowserTabs(status),[user,task,driver]);
  assert.equal(nativeBrowserSelection(status,'user'),'task');
  assert.equal(nativeBrowserSelection({...status,activeTab:'external'},'task'),'user');
  assert.equal(nativeBrowserSelection({tabs:[task]},'task'),'task');
  assert.equal(nativeBrowserSelection({tabs:[]},'task'),null);
});

test('native surface coalesces resize requests and never recaptures page pixels',async()=>{
  const calls=[],first=deferred();
  const surface=createNativeBrowserSurface({surface:request=>{calls.push(request);return calls.length===1?first.promise:Promise.resolve({attached:true,tabId:'a'});}});
  surface.show('a',bounds);
  surface.show('a',{...bounds,width:900});
  surface.show('a',{...bounds,width:850});
  assert.deepEqual(calls,[{action:'attach',tabId:'a',bounds}]);
  first.resolve({attached:true,tabId:'a'});await settle();
  assert.deepEqual(calls[1],{action:'bounds',bounds:{...bounds,width:850}});
  surface.show('a',{...bounds,width:850});await settle();assert.equal(calls.length,2);
  surface.focus();assert.equal(calls.at(-1).action,'focus');
  surface.destroy();assert.equal(calls.at(-1).action,'hide');
});

test('leaving hides immediately and cancels a queued tab switch before an earlier attachment settles',async()=>{
  const calls=[],first=deferred(),attached=[];
  const surface=createNativeBrowserSurface({surface:request=>{calls.push(request);return request.action==='attach'?first.promise:Promise.resolve({attached:false});},onAttached:tabId=>attached.push(tabId)});
  surface.show('a',bounds);surface.show('b',bounds);
  assert.equal(calls.at(-1).action,'hide','Switching revokes the previous pending attachment.');
  surface.hide();assert.equal(calls.at(-1).action,'hide','Leave sends hide without waiting for attach.');
  first.resolve({attached:true,tabId:'a'});await settle();
  assert.deepEqual(attached,[]);
  assert.equal(calls.filter(call=>call.action==='attach').length,1,'The obsolete b attachment must never be sent.');
  surface.destroy();
});

test('reentering the same tab after hide performs a fresh attach instead of stale bounds',async()=>{
  const calls=[],first=deferred(),attached=[];
  const surface=createNativeBrowserSurface({surface:request=>{calls.push(request);return calls.length===1?first.promise:Promise.resolve({attached:request.action!=='hide',tabId:'a'});},onAttached:tabId=>attached.push(tabId)});
  surface.show('a',bounds);surface.hide();surface.show('a',bounds);
  first.resolve({attached:false,tabId:'a'});await settle();
  assert.deepEqual(calls.map(call=>call.action),['attach','hide','attach']);
  assert.deepEqual(attached,['a']);surface.destroy();
});

test('the latest tab wins a pending switch and obsolete errors do not become visible failures',async()=>{
  const calls=[],first=deferred(),errors=[],attached=[];
  const surface=createNativeBrowserSurface({surface:request=>{calls.push(request);return calls.length===1?first.promise:Promise.resolve({attached:request.action!=='hide',tabId:request.tabId});},onError:error=>errors.push(error),onAttached:tabId=>attached.push(tabId)});
  surface.show('a',bounds);surface.show('b',bounds);surface.show('c',bounds);
  first.reject(Error('Obsolete a failure'));await settle();
  assert.deepEqual(calls.filter(call=>call.action==='attach').map(call=>call.tabId),['a','c']);
  assert.deepEqual(attached,['c']);assert.deepEqual(errors,[]);surface.destroy();
});

test('a different native page receipt cannot confirm the requested tab or receive focus',async()=>{
  const calls=[],errors=[],attached=[];
  const surface=createNativeBrowserSurface({surface:async request=>{calls.push(request);return{attached:true,tabId:'different'};},
    onError:error=>errors.push(error.message),onAttached:tabId=>attached.push(tabId)});
  surface.show('requested',bounds);await settle();surface.focus();
  assert.deepEqual(attached,[]);assert.equal(errors.length,1);
  assert.equal(calls.some(call=>call.action==='focus'),false);surface.destroy();
});

test('failed attach stays quiet on passive paints and explicit navigation retries the same tab and bounds',async()=>{
  const calls=[],errors=[],attached=[];let attempts=0;
  const surface=createNativeBrowserSurface({surface:async request=>{
    calls.push(request);
    if(request.action==='attach'&&++attempts===1)throw Error('Renderer is unavailable.');
    return{attached:request.action!=='hide',tabId:'recoverable'};
  },onError:error=>errors.push(error.message),onAttached:tabId=>attached.push(tabId)});
  surface.show('recoverable',bounds);await settle();
  assert.deepEqual(errors,['Renderer is unavailable.']);
  surface.show('recoverable',bounds);surface.show('recoverable',bounds);await settle();
  assert.equal(attempts,1,'Status and geometry paints must not create an automatic retry loop.');
  const resized={...bounds,width:800};surface.show('recoverable',resized);await settle();
  assert.equal(attempts,1,'An error notice or viewport resize must not replay the failed attachment.');
  surface.retry();await settle();
  assert.deepEqual(calls.map(call=>call.action),['attach','hide','attach']);
  assert.deepEqual(calls.at(-1),{action:'attach',tabId:'recoverable',bounds:resized});
  assert.deepEqual(attached,['recoverable']);surface.destroy();
});
