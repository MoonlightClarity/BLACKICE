import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {HarnessEngine} from '../lib/engine.mjs';

test('a verified same-tab navigate after an undispatched stale click advances an already-noted Directory action once',async t=>{
 for(const matchingTab of [true,false])await t.test(matchingTab?'same tab':'unrelated tab',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'directory-stale-navigate-'));
  let tab,other,clicks=0;
  const url='https://example.test/index';
  const runtime=new EventEmitter();
  runtime.status=()=>({connected:true,authenticated:true,models:[{id:'fixture-model',supportsTools:true}]});
  const browser={
   status:()=>({available:true,contained:true,tabs:[tab,other].filter(Boolean)}),
   async perform(args,{owner}){
    if(args.action==='open'){
     tab={tabId:'fixture-tab',documentId:'fixture-document',url,owner};
     other={...tab,tabId:'other-tab'};
     return tab;
    }
    if(args.action==='click'){clicks++;throw Object.assign(Error('Stale control'),{code:'BROWSER_REF_STALE',actionDispatched:false});}
    if(args.action==='navigate')return {...(matchingTab?tab:other),documentId:'destination-document',url:args.url,frames:[]};
    if(args.action==='snapshot')return {...tab,frames:[{frameId:'main',elements:[{ref:'stale-ref',role:'button',name:'Fixture action'}]}]};
    throw Error('Unexpected browser operation');
   }
  };
  runtime.runAgent=async o=>{
   let n=0;const call=(name,arguments_)=>o.onToolCall({name,arguments:arguments_,callId:'stale-navigate-'+(++n)});
   const dir=(action,rest={})=>call('relay_directory_action',{action,id:'search',...rest});
   const review=()=>o.onBeforeFinal({output:'The requested result is not done.',signal:o.signal});
   const receipt=r=>{assert.equal(r.success,true);return r.contentItems.at(-1).text.match(/receipt-[0-9]+/)[0];};
   assert.equal((await call('relay_directory_action',{action:'plan',actions:[{id:'search',objective:'Read the fixture result',dependsOn:[]}]})).success,true);
   assert.equal((await dir('focus')).success,true);
   await call('relay_browser',{action:'open',url});
   assert.equal((await review()).continue,true);
   const snapshot=receipt(await call('relay_browser',{action:'snapshot',tabId:'fixture-tab'}));
   const partial=(id,claim)=>dir('observe',{outcome:'partial',claim,receipts:[id]});
   assert.equal((await partial(snapshot,'The index shows another source to check.')).success,true);
   assert.match((await review()).prompt,/You recorded a new finding/);
   const stale=await call('relay_browser',{action:'click',tabId:'fixture-tab',ref:'stale-ref',expectedDocumentId:'fixture-document',expectedUrl:url});
   assert.equal(stale.code,'BROWSER_REF_STALE');
   assert.equal(stale.actionDispatched,false);
   const navArgs={action:'navigate',tabId:matchingTab?'fixture-tab':'other-tab',url:'https://example.test/destination'};
    if(matchingTab){
      const observed=await call('relay_browser',{action:'snapshot',tabId:'fixture-tab'});
      assert.equal(observed.success,true,JSON.stringify(observed));
      navArgs.observationReceipt=JSON.parse(observed.contentItems[0].text).observationReceipt;
      assert.match(navArgs.observationReceipt,/^obs-[a-f0-9-]{36}$/);
    }
    const navigation=receipt(await call('relay_browser',navArgs));
   assert.equal((await partial(navigation,'A destination opened; its decisive evidence still needs inspection.')).success,true);
   if(matchingTab){
    const next=await review();
    assert.equal(next.continue,true);
    assert.match(next.prompt,/This read is not proof of any application or other external effect/);
   }
   await assert.rejects(review(),{code:'DIRECTORY_ACTION_UNFINISHED'});
   assert.equal(clicks,1,'stale browser input was not replayed');
   return {output:'Fixture only.'};
  };
  const engine=await new HarnessEngine({runtime,browser,dataDir:root,defaultCwd:root}).init();
  t.after(async()=>{await engine.close();await rm(root,{recursive:true,force:true});});
  const workflow={name:'Read source',nodes:[{id:'i',type:'input'},{id:'a',type:'agent',name:'Agent',model:'fixture-model',prompt:'Do task'},{id:'o',type:'output'}],edges:[{source:'i',target:'a'},{source:'a',target:'o'}],settings:{maxParallel:1,planningMode:'off'}};
  const run=engine.startRun({workflow,input:{task:'Read the fixture source.',directoryActions:'on'}});
  await engine.executions.get(run.id);
  const result=engine.getRun(run.id);
  assert.equal(result.status,'failed',result.error);
  assert.equal(clicks,1,result.error);
  assert.equal(result.nodes.a.directoryCheckpoint,'partial-source-notes');
 });
});
