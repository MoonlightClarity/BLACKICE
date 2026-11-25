import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,readFile,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {HarnessEngine} from '../lib/engine.mjs';
import {ConversationArchive} from '../lib/conversations.mjs';
import {createSkillsCatalog} from '../lib/skills-catalog.mjs';
import {readBundledSkill} from '../lib/skill-library.mjs';

class EmptyEngine extends EventEmitter {
  runs=new Map();
  listRuns(){return [];}
  getRun(){throw Error('Live run unavailable.');}
}

test('skill receipt requires delivery of a body read in the same turn and survives archive reopen',async t=>{
  const root=await realpath(tmpdir()),dir=await mkdtemp(path.join(root,'blackice-skill-receipt-'));
  const engineDir=path.join(dir,'engine'),archiveDir=path.join(dir,'archive'),archives=[];
  let engine;
  t.after(async()=>{
    for(const item of archives) await item.close();
    await engine?.close();
    const resolved=await realpath(dir);
    assert.equal(path.dirname(resolved),root);
    assert.match(path.basename(resolved),/^blackice-skill-receipt-/);
    await rm(resolved,{recursive:true,force:true});
  });
  const id='library-what-makes-done',title='What Makes Done';
  const [completionSkill,antiCompletionSkill]=await Promise.all([readBundledSkill(id),readBundledSkill('library-anti-completion-bias')]);
  const antiCompletion={type:'skill_context_submitted',skillId:'library-anti-completion-bias',title:'Anti-Completion Bias',source:'bundled',sourceRevision:antiCompletionSkill.provenance.revision,contentMode:'brief'};
  const automatic={type:'skill_context_submitted',skillId:id,title,source:'bundled',sourceRevision:completionSkill.provenance.revision,contentMode:'brief'};
  const read={name:'relay_skills',arguments:{action:'read',id},callId:'read-1'};
  const search={...read,callId:'search-1',arguments:{action:'search',query:'word'}};
  const invalid={...read,callId:'invalid',arguments:{action:'read',id:'no-such-skill'}};
  const before=()=>assert.deepEqual([...engine.runs.values()][0].skillLoadReceipts,[automatic,antiCompletion]);
  // The UI's catalog detail endpoint uses the same reader independently.
  const catalogEntry=await createSkillsCatalog({dataDir:engineDir}).detail({id});
  const catalogBody=catalogEntry.content;
  assert.ok(catalogBody.trim());
  class Runtime extends EventEmitter{
    defaultModel='offline-fixture';
    status(){return {connected:true,authenticated:true,defaultModel:this.defaultModel};}
    async runAgent({prompt,onPromptAccepted,onToolCall,onToolResultDelivered}){
      assert.equal([...engine.runs.values()][0].skillLoadReceipts,undefined);
      onPromptAccepted('An unrelated prompt');
      assert.equal([...engine.runs.values()][0].skillLoadReceipts,undefined);
      assert.ok(prompt.includes('Define done by the actual requested result'));
      assert.ok(!prompt.includes(catalogBody),'automatic brief does not inject the full skill');
      onPromptAccepted(prompt);onPromptAccepted(prompt);
      before();
      const metadata=await onToolCall(search);
      onToolResultDelivered({call:search,result:metadata});
      await assert.rejects(onToolCall(invalid));
      onToolResultDelivered({call:invalid,result:{success:false,contentItems:[]}});
      before();
      const result=await onToolCall(read);
      assert.equal(JSON.parse(result.contentItems[0].text).entry.content,catalogBody);
      before();
      onToolResultDelivered({call:{...read,callId:'previous-turn'},result});
      onToolResultDelivered({call:read,result:{...result,success:false}});
      onToolResultDelivered({call:read,result:{contentItems:[{type:'inputText',text:JSON.stringify({entry:{id,title}})}]}});
      before();
      // Compatible and OpenAI wire formats may omit an explicit success flag.
      onToolResultDelivered({call:{...read,arguments:JSON.stringify(read.arguments)},result:{contentItems:result.contentItems}});
      onToolResultDelivered({call:read,result});
      const rerun={...read,callId:'read-2'};
      onToolResultDelivered({call:rerun,result:await onToolCall(rerun)});
      return {output:'A visible response.',threadId:'synthetic-skill-receipt'};
    }
  }
  engine=await new HarnessEngine({runtime:new Runtime(),dataDir:engineDir,defaultCwd:dir}).init();
  const archive=await new ConversationArchive({dataDir:archiveDir,engine}).init();archives.push(archive);
  const workflow={id:'skill-receipt-fixture',name:'Chat',nodes:[{id:'in',type:'input'},{id:'agent',type:'agent',model:'offline-fixture',prompt:'Offline fixture.'},{id:'out',type:'output'}],
    edges:[{source:'in',target:'agent'},{source:'agent',target:'out'}],settings:{planningMode:'off',maxParallel:1}};
  const started=engine.startRun({workflow,input:{task:'Review this synthetic Word outline.',planningMode:'off',directoryMode:'off'}});
  let run;
  for(let i=0;i<500;i++){run=engine.runs.get(started.id);if(run?.settled)break;await delay(10);}
  assert.equal(run?.settled,true);
  assert.equal(run.status,'completed',run.error);
  const receipt={type:'skill_loaded',skillId:id,title};
  assert.deepEqual(run.skillLoadReceipts,[automatic,antiCompletion,receipt]);
  const evidence=run.events.filter(e=>e.data?.type==='skill_loaded');
  assert.equal(evidence.length,1);
  assert.deepEqual(evidence[0].data,receipt);
  assert.equal(evidence[0].runId,started.id);
  assert.equal(evidence[0].nodeId,'agent');
  run.events=run.events.filter(e=>!['skill_loaded','skill_context_submitted'].includes(e.data?.type));
  await archive.capture(engine.getRun(started.id));await archive.close();
  const raw=await readFile(path.join(archiveDir,'conversations',started.id+'.json'),'utf8');
  const persisted=JSON.parse(raw),capturedAudit=persisted.nodes.agent.instructionAudit;
  assert.ok(capturedAudit.sections.some(section=>section.id==='skill-'+id && section.text.includes('Define done by the actual requested result')),'the audit retains the exact projected skill and its identity');
  const metadataOnly=JSON.stringify(persisted,(key,value)=>key==='instructionAudit'?undefined:value);
  assert.ok(!metadataOnly.includes(JSON.stringify(catalogBody).slice(1,-1)),'skill receipt metadata and ordinary archived fields do not duplicate the skill body');
  assert.deepEqual(persisted.skillLoadReceipts,[automatic,antiCompletion,receipt]);
  const reopened=await new ConversationArchive({dataDir:archiveDir,engine:new EmptyEngine()}).init();archives.push(reopened);
  const saved=(await reopened.family(started.id)).runs[0];
  assert.deepEqual(saved.skillLoadReceipts,[automatic,antiCompletion,receipt]);
  assert.deepEqual(saved.nodes.agent.instructionAudit,capturedAudit,'archive reopen preserves the captured instruction snapshot');
});
