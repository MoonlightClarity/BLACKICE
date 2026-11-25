import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BROWSER_VERIFICATION_GUIDANCE, normalizeBrowserSignIn, browserBlockerInterruption, createBrowserSignInHandler } from '../lib/browser-signin.mjs';
import { HarnessEngine } from '../lib/engine.mjs';
import { createMissionWorkflow } from '../public/mission-model.mjs';

const verification = {
  origin: 'https://jobs.lever.co', hostname: 'jobs.lever.co',
  reason: 'verification', evidence: 'verification-page', status: 'awaiting-user'
};
const signIn = { ...verification, origin: 'https://accounts.example.org', hostname: 'accounts.example.org',
  reason: 'sign-in', evidence: 'login-form' };

function assertVerificationToolContract(tools) {
  const browser=tools.find(tool=>tool.name==='relay_browser');
  const signin=tools.find(tool=>tool.name==='relay_browser_signin');
  assert.ok(browser&&signin,'the native browser and reporting actions must be present');
  assert.ok(signin.description.includes(BROWSER_VERIFICATION_GUIDANCE),
    'the report tool contains the shared challenge-observation criteria');
  for(const expected of [
    /script, badge or hidden frame alone is not a visible challenge/,
    /When normal controls are enabled, continue through them/,
    /page displays a challenge or a site response requires verification, inspect that prerequisite/,
    /Report a blocker only when that prerequisite still prevents the next action/,
    /After a submit, inspect its result before submitting again/
  ]) assert.match(BROWSER_VERIFICATION_GUIDANCE,expected);
  assert.match(browser.description,/library-browser-captcha/);
  assert.match(browser.description,/model vision/);
  assert.match(browser.description,/no external CAPTCHA solver APIs/);
}

test('browser blocker reason must match observed evidence, not misclassify CAPTCHA as sign-in', () => {
  assert.equal(normalizeBrowserSignIn({site:'https://jobs.lever.co/apply',reason:'verification',evidence:'verification-page'}).reason, 'verification');
  assert.throws(() => normalizeBrowserSignIn({site:'https://jobs.lever.co',reason:'sign-in',evidence:'verification-page'}));
  assert.throws(() => normalizeBrowserSignIn({site:'https://jobs.lever.co',reason:'verification',evidence:'login-form'}));
  assert.throws(() => normalizeBrowserSignIn({site:'https://jobs.lever.co',reason:'permission',evidence:'verification-page'}));
});

test('a visible CAPTCHA does not disable ordinary contained-browser visual interaction', async () => {
  for (const action of ['tabs','snapshot','read','screenshot','downloads','transfer_ownership','take_ownership']) {
    assert.equal(browserBlockerInterruption(verification,{action,tabId:'tab-1'}),null,action);
  }
  const click=browserBlockerInterruption(verification,{action:'click',tabId:'tab-1'},{
    tabs:[{tabId:'tab-1',url:'https://jobs.lever.co/example/apply'}]
  });
  assert.equal(click,null,'vision-based native interaction must not be stopped by a model report');
  for(const action of ['fill','press','select','hover','scroll','wait','navigate','reload'])
    assert.equal(browserBlockerInterruption(verification,{action,tabId:'tab-1'}, {tabs:[{tabId:'tab-1',url:'https://jobs.lever.co/example/apply'}]}),null,action);
  assert.equal(browserBlockerInterruption(verification,{action:'open',url:'https://careers.example.org/jobs'}),null);
  assert.equal(browserBlockerInterruption(verification,{action:'snapshot',tabId:'tab-1'}),null);
  assert.equal(browserBlockerInterruption(verification,{action:'click',tabId:'tab-1'}),null);
});

test('genuine login still blocks site-modifying actions, with read-only inspection and handback allowed', () => {
  assert.match(browserBlockerInterruption(signIn,{action:'fill',tabId:'login-tab'}),/sign-in/i);
  assert.equal(browserBlockerInterruption(signIn,{action:'snapshot',tabId:'login-tab'}),null);
  assert.equal(browserBlockerInterruption(signIn,{action:'transfer_ownership',tabId:'login-tab'}),null);
  assert.equal(browserBlockerInterruption(signIn,{action:'open',url:'https://example.net/independent'}),null);
});

test('verification receipt names verification rather than asking for an unrelated sign-in', async () => {
  const reports=[];
  const handler=createBrowserSignInHandler({browser:'relay',report:d=>reports.push(d)});
  const response=await handler({name:'relay_browser_signin',arguments:{
    site:'https://jobs.lever.co',reason:'verification',evidence:'verification-page'
  }});
  assert.equal(response.success,true);
  const receipt=JSON.parse(response.contentItems[0].text);
  assert.equal(receipt.reason,'verification');
  assert.match(receipt.action,/verification/i);
  assert.doesNotMatch(receipt.action,/sign in inside Observe/i);
  assert.equal(reports.length,0,'a verification report must not impose a hard blocker');
  assert.equal(receipt.recorded,false);
  assert.match(receipt.action,/library-browser-captcha/);
  assert.match(receipt.action,/model’s own vision/);
  assert.match(receipt.action,/Do not use external CAPTCHA solver APIs/i);
});

test('reported CAPTCHA remains a visual browser task and does not force a human-only handback',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'blackice-verification-pause-'));
  const cwd=path.join(root,'workspace'),dataDir=path.join(root,'data'); await mkdir(cwd);
  const calls=[], releases=[], tabs=[];
  const browser={
    status:()=>({available:true,contained:true,tabs}),
    perform:async (args,{owner}={})=>{
      calls.push(args.action);
      if(args.action==='tabs')return{tabs,contained:true};
      if(args.action==='open'){
        const tab={tabId:'fixture-new-tab',url:args.url,owner,documentId:'fixture-new-tab:1'};
        tabs.push(tab);
        return{...tab,frames:[]};
      }
      throw Error('Unexpected site input');
    },
    releaseOwner:async(owner,options)=>{releases.push({owner,options});return{retained:[],released:[]};},
    close:async()=>{}
  };
  class Runtime extends EventEmitter {
    status(){return{connected:true,authenticated:true,defaultModel:'test',models:[{id:'test',model:'test',available:true}]};}
    async runAgent(options){
      assertVerificationToolContract(options.dynamicTools);
      const report=await options.onToolCall({name:'relay_browser_signin',arguments:{
        site:'https://jobs.lever.co',reason:'verification',evidence:'verification-page'
      }});
      assert.equal(report.success,true);
      assert.equal(JSON.parse(report.contentItems[0].text).recorded,false);
      const read=await options.onToolCall({name:'relay_browser',arguments:{action:'tabs'}});
      assert.equal(read.success,true,'read-only tabs must not be blocked by verification');
      const action=await options.onToolCall({name:'relay_browser',arguments:{action:'open',browser:'relay',url:'https://jobs.lever.co/example/apply'}});
      assert.equal(action.success,true,'a model report cannot disable normal browser operations: '+JSON.stringify(action));
      return{output:'Synthetic visual challenge is unresolved; page inspection and normal browser actions remain possible.'};
    }
  }
  const engine=new HarnessEngine({runtime:new Runtime(),dataDir,defaultCwd:cwd,browser});
  await engine.init();t.after(async()=>{await engine.close();await rm(root,{recursive:true,force:true});});
  const task='Inspect a pending Jobgether application verification at https://jobs.lever.co without repeating Submit.';
  const flow=createMissionWorkflow({task,model:'test',cwd,id:'verification-fixture',planningMode:'off'});
  const started=engine.startRun({workflow:flow,input:task});
  let run;
  for(let i=0;i<100;i++){run=engine.getRun(started.id);if(run?.settled)break;await new Promise(r=>setTimeout(r,15));}
  assert.equal(run?.status,'completed',run?.error);
  assert.deepEqual(calls,['tabs','open']);
  assert.equal(releases.length,1);
  assert.equal(releases[0].options.status,'completed');
  assert.equal(run.browserSignIn,undefined,'a visual challenge does not itself create a human-only runtime state');
});
