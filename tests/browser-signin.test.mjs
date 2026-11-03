import test from 'node:test';
import assert from 'node:assert/strict';
import {BROWSER_SIGNIN_TOOL,BROWSER_SIGNIN_INSTRUCTIONS,normalizeBrowserSignIn,createBrowserSignInHandler,observedEmailAuthAlternative} from '../lib/browser-signin.mjs';
import {browserTaskIntent} from '../lib/tool-routing.mjs';

test('generic authorized job applications activate the browser sign-in fallback without an explicit URL', () => {
  assert.equal(browserTaskIntent('Find and apply to worthwhile remote jobs using my resume. Use the planning tool.'),true,
    'the original Mercor run must receive website sign-in guidance before reaching the LinkedIn overlay');
  assert.equal(browserTaskIntent('Complete my account sign in through the email option.'),true);
  assert.equal(browserTaskIntent('Continue my job applications without duplicating previous submissions.'),true);
  assert.equal(browserTaskIntent('Calculate inventory totals from the local CSV.'),false);
});

test('visible email sign-in options are recognized without mistaking newsletters or CAPTCHA for login', () => {
  const snapshot = name => ({tabId:'contained-login',frames:[{elements:[
    {role:'button',name:'Continue with LinkedIn',ref:'social',disabled:false},
    {role:'button',name,ref:'email-option',disabled:false},
  ]}]});
  for (const name of ['Continue with email','Sign in with email','Use email instead','Email login']) {
    assert.deepEqual(observedEmailAuthAlternative(snapshot(name)),
      {kind:'email-sign-in',tabId:'contained-login',label:name});
  }
  const emailForm={tabId:'contained-login',frames:[{elements:[
    {role:'textbox',name:'Email or phone',ref:'account-email',value:''},
    {role:'textbox',name:'Password',ref:'password',type:'password',value:''},
    {role:'button',name:'Sign in',ref:'submit-login'}
  ]}]};
  assert.deepEqual(observedEmailAuthAlternative(emailForm),
    {kind:'email-sign-in',tabId:'contained-login',label:'Email or phone'});
  emailForm.frames[0].elements[0].value='already-filled@example.test';
  assert.equal(observedEmailAuthAlternative(emailForm),null,
    'after an email was entered, a missing password may genuinely require user authentication');
  for (const name of ['Email marketing preferences','Get email updates','Verify Answers','Continue with Google'])
    assert.equal(observedEmailAuthAlternative(snapshot(name)),null);
  assert.equal(observedEmailAuthAlternative({tabId:'captcha',frames:[{elements:[
    {role:'button',name:'Continue with email',ref:'disabled-route',disabled:true},
    {role:'button',name:'Verify Answers',ref:'captcha-control'}
  ]}]}),null);
});

test('email-route preflight keeps the website usable instead of falsely recording a social sign-in blocker',async()=>{
  const reports=[];let inspected=0;
  const handler=createBrowserSignInHandler({browser:'relay',report:data=>reports.push(data),inspectEmailAlternative:async()=>{
    inspected++;return{kind:'email-sign-in',tabId:'contained-login',label:'Continue with email'};
  }});
  const call={name:'relay_browser_signin',arguments:{site:'https://www.linkedin.com/login',reason:'sign-in',evidence:'login-form'}};
  const result=await handler(call);
  assert.equal(result.success,true);
  const receipt=JSON.parse(result.contentItems[0].text);
  assert.equal(receipt.recorded,false);
  assert.equal(receipt.emailSignInAvailable,true);
  assert.equal(receipt.optionLabel,'Continue with email');
  assert.equal(reports.length,0,'do not pause the task while a real email alternative is available');
  assert.match(receipt.action,/verified account email/);
  assert.match(BROWSER_SIGNIN_INSTRUCTIONS,/verified saved resume/);
  assert.match(BROWSER_SIGNIN_INSTRUCTIONS,/without another routine approval prompt|instead of asking the user which email/);
  const verification=await handler({name:'relay_browser_signin',arguments:{site:'https://jobs.lever.co/',reason:'verification',evidence:'verification-page'}});
  assert.equal(verification.success,true);
  assert.equal(reports.length,1,'a CAPTCHA is not solved merely by an email-login alternative on another site');
  assert.equal(inspected,1,'a verification challenge does not trigger the social-login preflight');
});

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
