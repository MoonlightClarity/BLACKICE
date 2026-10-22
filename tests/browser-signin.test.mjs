import test from 'node:test';
import assert from 'node:assert/strict';
import {BROWSER_SIGNIN_TOOL,BROWSER_SIGNIN_INSTRUCTIONS,normalizeBrowserSignIn,createBrowserSignInHandler,browserSignInDenial} from '../lib/browser-signin.mjs';
import {browserOwnerKey} from '../lib/browser.mjs';

test('sign-in reports only a bounded public origin without carrying private URL data',()=>{
 assert.deepEqual(normalizeBrowserSignIn({site:'https://www.linkedin.com/feed/',reason:'sign-in',evidence:'login-redirect'}),
  {origin:'https://www.linkedin.com',hostname:'www.linkedin.com',reason:'sign-in',evidence:'login-redirect'});
 for(const site of ['http://linkedin.com','https://localhost/login','https://127.0.0.1','https://user:pass@linkedin.com','https://linkedin.com/?token=secret','https://linkedin.com/#secret','javascript:alert(1)','https://linkedin.com:8443/']){
  assert.throws(()=>normalizeBrowserSignIn({site,reason:'sign-in',evidence:'login-form'}));
 }
 assert.throws(()=>normalizeBrowserSignIn({site:'https://linkedin.com',reason:'inconvenient',evidence:'login-form'}));
 assert.throws(()=>normalizeBrowserSignIn({site:'https://linkedin.com',reason:'sign-in',evidence:'login-form',password:'secret'}));
 assert.match(BROWSER_SIGNIN_INSTRUCTIONS,/Each profile has independent authentication/);
 assert.match(BROWSER_SIGNIN_INSTRUCTIONS,/If the task still requires human interaction, finish the turn/);
 assert.match(BROWSER_SIGNIN_INSTRUCTIONS,/Supply the public HTTPS site and observed evidence/);
 assert.match(BROWSER_SIGNIN_INSTRUCTIONS,/Contained sign-in uses Observe/);
 assert.match(BROWSER_SIGNIN_INSTRUCTIONS,/inspecting and closing that page, navigating elsewhere, and working on other sites or configured native sessions/);
 assert.doesNotMatch(BROWSER_SIGNIN_INSTRUCTIONS,/Native browser task interaction is unavailable/);
});
test('agent report stores a blocker but cannot focus a window, auto-login or retry a task',async()=>{
 const observed=[];const handler=createBrowserSignInHandler({report:data=>observed.push(data)});
 const result=await handler({name:BROWSER_SIGNIN_TOOL.name,arguments:{site:'https://linkedin.com/feed',reason:'sign-in',evidence:'login-form'}});
 assert.equal(result.success,true);
 assert.equal(observed.length,1);
 assert.equal(observed[0].hostname,'linkedin.com');
 assert.deepEqual(Object.keys(observed[0]).sort(),['evidence','hostname','origin','reason']);
 assert.match(result.contentItems[0].text,/selected Neo profile needs human interaction/);
 assert.equal((await handler({name:BROWSER_SIGNIN_TOOL.name,arguments:{site:'https://localhost',reason:'sign-in',evidence:'login-form'}})).success,false);
 assert.equal(observed.length,1);
 const abort=new AbortController();abort.abort();
 assert.equal((await createBrowserSignInHandler({signal:abort.signal,report:()=>{throw Error('Should not run')}})({name:BROWSER_SIGNIN_TOOL.name,arguments:{site:'https://linkedin.com',reason:'sign-in',evidence:'login-form'}})).success,false);
});

test('contained sign-in reports preserve browser identity and leave independent native sessions available',async()=>{
 const observed=[],handler=createBrowserSignInHandler({browser:'relay',report:data=>observed.push(data)}),call={name:BROWSER_SIGNIN_TOOL.name,arguments:{site:'https://linkedin.com/feed',reason:'sign-in',evidence:'login-form'}};
 const result=await handler(call);assert.equal(result.success,true);assert.deepEqual(observed,[{origin:'https://linkedin.com',hostname:'linkedin.com',reason:'sign-in',evidence:'login-form',browser:'relay'}]);
 const receipt=JSON.parse(result.contentItems[0].text);assert.equal(receipt.browser,'relay');assert.match(receipt.action,/Input on the reported site is paused/);assert.match(receipt.action,/sign in inside Observe/);assert.match(receipt.action,/independently authorized native session remain available/);assert.match(receipt.action,/Inspect prior effects/);
 assert.equal((await handler({...call,arguments:{...call.arguments,browser:'neo'}})).success,false,'agent-supplied arguments cannot change the application-selected browser');assert.equal(observed.length,1);
 assert.throws(()=>createBrowserSignInHandler({browser:'unknown',report:()=>{}}),/known task browser/);
 const cancelled=new AbortController();cancelled.abort();assert.equal((await handler(call,{signal:cancelled.signal})).success,false);assert.equal(observed.length,1);
});

test('reported prerequisites follow the actual owned target origin, not the whole browser',()=>{
 const owner={taskId:'task',runId:'run',nodeId:'worker'},blocker={status:'awaiting-user',browser:'relay',origin:'https://linkedin.com'};
 const status={tabs:[
  {tabId:'blocked',url:'https://linkedin.com/login',owner},
  {tabId:'other',url:'https://example.com/',owner},
  {tabId:'foreign',url:'https://linkedin.com/login',owner:{...owner,taskId:'foreign'}},
 ],ownerActiveTabs:{[browserOwnerKey(owner)]:'blocked'}};
 const check=args=>browserSignInDenial({name:'relay_browser',arguments:args},blocker,status,owner);
 for(const action of ['click','fill','type','select','press','upload']){
  const denied=check({action,tabId:'blocked'});assert.equal(denied.code,'BROWSER_SIGNIN_REQUIRED',action);
  assert.equal(check({action,tabId:'other'}),null,action);
 }
 assert.equal(check({action:'click'}).code,'BROWSER_SIGNIN_REQUIRED','default selection must resolve the actual owned page');
 for(const action of ['read','snapshot','screenshot','hover','scroll','wait','navigate','reload','back','forward','close','interaction'])assert.equal(check({action,tabId:'blocked'}),null,action);
 for(const action of ['tabs','downloads','open'])assert.equal(check({action}),null,action);
 assert.equal(check({action:'click',tabId:'foreign'}),null,'the browser must return its precise ownership error');
 assert.equal(check({action:'click',tabId:'missing'}),null,'the browser must return its precise stale-target error');
 status.tabs[0].url='https://example.org/';assert.equal(check({action:'click',tabId:'blocked'}),null);
 const credential=args=>browserSignInDenial({name:'relay_credentials',arguments:args},blocker,status,owner);
 assert.equal(credential({action:'generate',origin:'https://linkedin.com'}).code,'BROWSER_SIGNIN_REQUIRED');
 assert.equal(credential({action:'fill',origin:'https://linkedin.com'}).code,'BROWSER_SIGNIN_REQUIRED');
 assert.equal(credential({action:'list',origin:'https://linkedin.com'}),null);
 assert.equal(credential({action:'generate',origin:'https://example.com'}),null);
 assert.equal(browserSignInDenial({name:'relay_browser',arguments:{action:'click',tabId:'blocked'}},{...blocker,status:'resolved'},status,owner),null);
});
