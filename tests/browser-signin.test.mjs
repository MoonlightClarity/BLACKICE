import test from 'node:test';
import assert from 'node:assert/strict';
import {BROWSER_SIGNIN_TOOL,BROWSER_SIGNIN_INSTRUCTIONS,normalizeBrowserSignIn,createBrowserSignInHandler} from '../lib/browser-signin.mjs';

test('sign-in reports only a bounded public origin without carrying private URL data',()=>{
 assert.deepEqual(normalizeBrowserSignIn({site:'https://www.linkedin.com/feed/',reason:'sign-in',evidence:'login-redirect'}),
  {origin:'https://www.linkedin.com',hostname:'www.linkedin.com',reason:'sign-in',evidence:'login-redirect'});
 for(const site of ['http://linkedin.com','https://localhost/login','https://127.0.0.1','https://user:pass@linkedin.com','https://linkedin.com/?token=secret','https://linkedin.com/#secret','javascript:alert(1)','https://linkedin.com:8443/']){
  assert.throws(()=>normalizeBrowserSignIn({site,reason:'sign-in',evidence:'login-form'}));
 }
 assert.throws(()=>normalizeBrowserSignIn({site:'https://linkedin.com',reason:'inconvenient',evidence:'login-form'}));
 assert.throws(()=>normalizeBrowserSignIn({site:'https://linkedin.com',reason:'sign-in',evidence:'login-form',password:'secret'}));
 assert.match(BROWSER_SIGNIN_INSTRUCTIONS,/Use only the BLACKICE contained browser/);
 assert.match(BROWSER_SIGNIN_INSTRUCTIONS,/Account creation and routine email verification are workflow prerequisites/);
 assert.match(BROWSER_SIGNIN_INSTRUCTIONS,/Supply the public HTTPS site and observed evidence/);
 assert.match(BROWSER_SIGNIN_INSTRUCTIONS,/continue independent preparation/);
 assert.doesNotMatch(BROWSER_SIGNIN_INSTRUCTIONS,/native session remains available|use.*configured native Chrome/i);
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

test('contained sign-in reports preserve browser identity and continue independent work without native fallback',async()=>{
 const observed=[],handler=createBrowserSignInHandler({browser:'relay',report:data=>observed.push(data)}),call={name:BROWSER_SIGNIN_TOOL.name,arguments:{site:'https://linkedin.com/feed',reason:'sign-in',evidence:'login-form'}};
 const result=await handler(call);assert.equal(result.success,true);assert.deepEqual(observed,[{origin:'https://linkedin.com',hostname:'linkedin.com',reason:'sign-in',evidence:'login-form',browser:'relay'}]);
 const receipt=JSON.parse(result.contentItems[0].text);assert.equal(receipt.browser,'relay');assert.match(receipt.action,/contained profile is paused/);assert.match(receipt.action,/sign in inside Observe/);assert.match(receipt.action,/Complete independent preparation/);assert.match(receipt.action,/without connecting Chrome/);assert.match(receipt.action,/Inspect prior effects/);
 assert.equal((await handler({...call,arguments:{...call.arguments,browser:'neo'}})).success,false,'agent-supplied arguments cannot change the application-selected browser');assert.equal(observed.length,1);
 assert.throws(()=>createBrowserSignInHandler({browser:'unknown',report:()=>{}}),/known task browser/);
 const cancelled=new AbortController();cancelled.abort();assert.equal((await handler(call,{signal:cancelled.signal})).success,false);assert.equal(observed.length,1);
});
