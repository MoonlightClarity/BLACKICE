import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,mkdir,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {createHarnessServer} from '../server.mjs';
import {createRetrievalToolHandler} from '../lib/retrieval-tools.mjs';

const id='library-personal-context';
const payload=result=>JSON.parse(result.contentItems.find(item=>item.type==='inputText').text);

test('Personal Context is discoverable for personal and explicit continuing tasks, but not ordinary work',async()=>{
  const handler=createRetrievalToolHandler({cwd:process.cwd()});
  const invoke=async args=>payload(await handler({name:'relay_skills',arguments:args}));
  for(const query of ['personal context','Draft this note in my usual style.',
    'As we discussed, which checks should be run again today?',
    'Pick up where we left off with the tool we were evaluating.',
    'What did we decide about the Harbor release?']){
    const result=await invoke({action:'search',query});
    assert.equal(result.entries[0]?.id,id,query);
    assert.ok(result.entries.every(entry=>!('content' in entry)),'search returns metadata, not guidance bodies');
  }
  for(const query of ['Find three plausible analyst jobs.','Read the JSON file and count rows.','Can you see the cached formulas in this workbook?'])
    assert.ok(!(await invoke({action:'search',query})).entries.some(entry=>entry.id===id),query);
  const selected=(await invoke({action:'read',id})).entry.content;
  assert.match(selected,/^# Personal Context/);
  for(const phrase of [/"action":"read","kind":"user"/,/"action":"search","scope":"workspace"/,
    /"action":"read","scope":"workspace","id":/,/actual clock/,/Fresh request does not resume a Goal/i,/inspect fresh timing diagnostics/])
    assert.match(selected,phrase);
  assert.match(selected,/When Past Chats is Off[\s\S]*Do not recover previous chats through another tool/);
});

test('both Past Chats modes can load Personal Context and obtain fresh evidence without importing old scope',async t=>{
  const root=await realpath(tmpdir()),dir=await mkdtemp(path.join(root,'blackice-personal-context-test-'));
  const cwd=path.join(dir,'work');await mkdir(cwd);
  const current='FRESH EVIDENCE: Update takes 12 seconds; ordinary startup takes 2 seconds.';
  const stale='Earlier assistant reported ordinary startup also takes 12 seconds.';
  await writeFile(path.join(cwd,'Harbor-current-report.txt'),current);
  let app,oldId,mode='seed',audits=[];
  t.after(async()=>{
    await app?.close();
    const resolved=await realpath(dir);assert.equal(path.dirname(resolved),root);
    assert.match(path.basename(resolved),/^blackice-personal-context-test-/);
    await rm(resolved,{recursive:true,force:true});
  });
  class Runtime extends EventEmitter{
    status(){return {connected:true,authenticated:true,defaultModel:'context-fixture',activeTurns:0,isolatedHistory:true};}
    async start(){return this.status();}
    async close(){}
    async runAgent(options){
      if(mode==='seed')return {output:stale,threadId:'prior-thread'};
      const audit={mode,actions:[]};audits.push(audit);
      assert.equal(options.threadId,undefined);
      assert.doesNotMatch(options.prompt,/Earlier assistant reported|until 6 AM|Separate relevance from authority/);
      assert.doesNotMatch(options.developerInstructions,/Separate relevance from authority/,'no unconditional body injection');
      assert.equal(options.dynamicTools.some(tool=>tool.name==='relay_history'),mode==='on');
      const tool=async(name,args)=>{
        audit.actions.push(name+'.'+(args.action??'call'));
        const call={name,arguments:args,callId:mode+'-'+audit.actions.length};
        const result=await options.onToolCall(call);
        options.onToolResultDelivered?.({call,result});
        return result;
      };
      const matches=payload(await tool('relay_skills',{action:'search',query:'personal context',limit:3}));
      assert.equal(matches.entries[0].id,id);
      const method=payload(await tool('relay_skills',{action:'read',id}));
      assert.match(method.entry.content,/A blank profile is not a negative fact/);
      assert.match(method.entry.content,/inspect fresh timing diagnostics/);
      const profile=payload(await tool('relay_identity',{action:'read',kind:'user'}));
      assert.match(profile.content,/Clearly separate observed timings from estimates/);
      if(mode==='on'){
        const found=payload(await tool('relay_history',{action:'search',scope:'workspace',query:'Harbor release validation',limit:3}));
        assert.ok(found.results.some(item=>item.id===oldId));
        const prior=payload(await tool('relay_history',{action:'read',scope:'workspace',id:oldId,query:'validation',limit:3})).run;
        assert.match(prior.input,/until 6 AM/);
        assert.match(prior.output,/Earlier assistant reported ordinary startup also takes 12 seconds/);
      }else{
        const denied=await tool('relay_history',{action:'read',scope:'workspace',id:oldId});
        assert.equal(denied.success,false);
        assert.equal(denied.code,'PAST_CHATS_OFF');
      }
      const discovery=payload(await tool('relay_find_files',{query:'Harbor-current-report',path:cwd}));
      assert.equal(discovery.matches.length,1);
      const source=payload(await tool('relay_workspace',{action:'read',path:discovery.matches[0].path}));
      assert.match(source.content,/Update takes 12 seconds; ordinary startup takes 2 seconds/);
      return {output:'Current Harbor report: '+source.content,threadId:'fixture-'+mode};
    }
  }
  app=await createHarnessServer({runtime:new Runtime(),port:0,dataDir:path.join(dir,'data'),defaultCwd:cwd,remoteAccess:false});
  const priorUser=await app.identity.read('user');
  await app.identity.update({kind:'user',content:'# User profile\nClearly separate observed timings from estimates.',expectedRevision:priorUser.revision,expectedHash:priorUser.diskHash});
  const graph=id=>({id,name:'Fixture Chat',nodes:[{id:'input',type:'input'},{id:'agent',type:'agent',model:'context-fixture',prompt:'Complete the current task.'},{id:'out',type:'output'}],edges:[{source:'input',target:'agent'},{source:'agent',target:'out'}],settings:{planningMode:'off'}});
  const start=async (task,pastChats)=>{
    const request=app.engine.startRun({workflow:graph('context-'+mode),input:{task,cwd,pastChats,planningMode:'off',directoryMode:'off'}});
    for(let i=0;i<400;i++){
      const run=app.engine.getRun(request.id);
      if(run.settled){assert.equal(run.status,'completed',run.error);return run;}
      await delay(10);
    }
    assert.fail('Synthetic run did not settle.');
  };
  const seed=await start('Harbor release validation: measure it today only until 6 AM EST. Compare the update with ordinary startup.','off');
  oldId=seed.id;
  for(const setting of ['off','on']){
    mode=setting;
    const run=await start('Use my usual approach to diagnose Harbor from new timing measurements.',setting);
    assert.match(run.output,/FRESH EVIDENCE/);
    assert.doesNotMatch(run.output,/6 AM|Earlier assistant reported/);
    assert.deepEqual(run.skillLoadReceipts,[{type:'skill_loaded',skillId:id,title:'Personal Context'}]);
    assert.equal(run.goal,undefined);
  }
  assert.deepEqual(audits.map(audit=>audit.actions.slice(-2)),[
    ['relay_find_files.call','relay_workspace.read'],['relay_find_files.call','relay_workspace.read'],
  ]);
});
