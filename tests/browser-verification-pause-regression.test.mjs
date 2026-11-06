import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { normalizeBrowserSignIn, browserBlockerInterruption, createBrowserSignInHandler } from '../lib/browser-signin.mjs';
import { HarnessEngine } from '../lib/engine.mjs';
import { createMissionWorkflow } from '../public/mission-model.mjs';

const verification = {
  origin: 'https://jobs.lever.co', hostname: 'jobs.lever.co',
  reason: 'verification', evidence: 'verification-page', status: 'awaiting-user'
};
const signIn = { ...verification, origin: 'https://accounts.example.org', hostname: 'accounts.example.org',
  reason: 'sign-in', evidence: 'login-form' };

test('browser blocker reason must match observed evidence, not misclassify CAPTCHA as sign-in', () => {
  assert.equal(normalizeBrowserSignIn({site:'https://jobs.lever.co/apply',reason:'verification',evidence:'verification-page'}).reason, 'verification');
  assert.throws(() => normalizeBrowserSignIn({site:'https://jobs.lever.co',reason:'sign-in',evidence:'verification-page'}));
  assert.throws(() => normalizeBrowserSignIn({site:'https://jobs.lever.co',reason:'verification',evidence:'login-form'}));
  assert.throws(() => normalizeBrowserSignIn({site:'https://jobs.lever.co',reason:'permission',evidence:'verification-page'}));
});

test('recorded CAPTCHA does not block reading current evidence or handing back ownership', async () => {
  for (const action of ['tabs','snapshot','read','screenshot','downloads','transfer_ownership','take_ownership']) {
    assert.equal(browserBlockerInterruption(verification,{action,tabId:'tab-1'}),null,action);
  }
  const click=browserBlockerInterruption(verification,{action:'click',tabId:'tab-1'},{
    tabs:[{tabId:'tab-1',url:'https://jobs.lever.co/example/apply'}]
  });
  assert.match(click,/verification/i);
  assert.doesNotMatch(click,/sign-in was reported/i);
  assert.equal(browserBlockerInterruption(verification,{action:'open',url:'https://careers.example.org/jobs'}),null);
  assert.equal(browserBlockerInterruption(verification,{action:'snapshot',tabId:'tab-1'}),null);
  assert.match(browserBlockerInterruption(verification,{action:'click',tabId:'tab-1'}),/verification/i);
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
  assert.equal(reports.length,1);
});

test('completed run with unresolved verification retains the browser scope for agent continuation',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'blackice-verification-pause-'));
  const cwd=path.join(root,'workspace'),dataDir=path.join(root,'data'); await mkdir(cwd);
  const calls=[], releases=[];
  const browser={
    status:()=>({available:true,contained:true,tabs:[]}),
    perform:async args=>{calls.push(args.action);if(args.action!=='tabs')throw Error('Site-changing action must not dispatch');return{tabs:[],contained:true};},
    releaseOwner:async(owner,options)=>{releases.push({owner,options});return{retained:[],released:[]};},
    close:async()=>{}
  };
  class Runtime extends EventEmitter {
    status(){return{connected:true,authenticated:true,defaultModel:'test',models:[{id:'test',model:'test',available:true}]};}
    async runAgent(options){
      const report=await options.onToolCall({name:'relay_browser_signin',arguments:{
        site:'https://jobs.lever.co',reason:'verification',evidence:'verification-page'
      }});
      assert.equal(report.success,true);
      const read=await options.onToolCall({name:'relay_browser',arguments:{action:'tabs'}});
      assert.equal(read.success,true,'read-only tabs must not be blocked by verification');
      const write=await options.onToolCall({name:'relay_browser',arguments:{
        action:'click',tabId:'tab-1',ref:'submit-button',expectedUrl:'https://jobs.lever.co/example/apply',expectedDocumentId:'tab-1:5'
      }});
      assert.equal(write.success,false);
      assert.match(write.contentItems[0].text,/verification/i);
      return{output:'Existing one-click submit is unconfirmed; verification remains.'};
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
  assert.deepEqual(calls,['tabs']);
  assert.equal(releases.length,1);
  assert.equal(releases[0].options.status,'paused', 'a reported blocker preserves the agent-owned page instead of handing it off');
  assert.equal(run.browserSignIn.reason,'verification');
});
