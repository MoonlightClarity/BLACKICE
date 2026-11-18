import test from 'node:test';
import assert from 'node:assert/strict';

import os from 'node:os';
import {directoryKnowledgeAdmission,directoryContextConfiguration} from '../lib/directory-conversation-scope.mjs';
import {contextSnapshot,normalizeContextOptions} from '../lib/context.mjs';

import {LearningStore} from '../lib/learning.mjs';

test('Directory uses the supported native maximum and defers unknown capacities to the provider',()=>{
  const model={id:'native',contextWindowTokens:272000,runtimeDefaultContextWindowTokens:272000,maxContextWindowTokens:872000,effectiveContextWindowPercent:95,contextWindowSource:'runtime-reported'};
  const selected=directoryContextConfiguration({model});
  assert.equal(selected.options.preset,'extended');
  assert.equal(selected.inputBudgetTokens,872000*.95-8192-8192);
  assert.equal(selected.options.compactAtTokens,selected.inputBudgetTokens,'default compaction must not discard the upper fifth of usable context');
  assert.ok(selected.knownCapacity);
  const explicit=directoryContextConfiguration({model,context:{preset:'custom',windowTokens:96000}});
  assert.equal(explicit.options.windowTokens,96000,'an intentional conversation override remains available');
  const unresolved=directoryContextConfiguration();
  assert.equal(unresolved.knownCapacity,false);
  assert.equal(unresolved.inputBudgetTokens,Infinity);
  const snapshot=contextSnapshot({options:unresolved.options,messages:['x'.repeat(600000)]});
  assert.equal(snapshot.effectiveWindowTokens,null);
  assert.equal(snapshot.windowSource,'unresolved');
  assert.ok(snapshot.estimatedInputTokens<snapshot.inputBudgetTokens,'unknown long-context models have no invented 128K ceiling');
  assert.equal(snapshot.compactAtTokens,Infinity);
  assert.equal(normalizeContextOptions({preset:'custom',windowTokens:8000000}).windowTokens,8000000);
});

test('Directory automatic knowledge follows conversation lineage rather than shared workspace',()=>{
  const run={id:'current',taskId:'first',directoryUserHistory:[{runId:'archived-parent'}]};
  const admit=directoryKnowledgeAdmission({run,runs:[{id:'first'},{id:'previous',taskId:'first'},{id:'foreign',taskId:'other'}]});
  for(const runId of ['first','previous','current','archived-parent'])assert.equal(admit({provenance:{runId}}),true);
  assert.equal(admit({provenance:{runId:'foreign'}}),false);
  assert.equal(admit({provenance:{source:'user'}}),false,'an unscoped workspace note is not a conversation import');
  assert.equal(admit({provenance:{runId:'first'},evidenceRunIds:['foreign']}),false,'a blended note must be explicitly imported');
});

test('conversation admission happens before retained-learning selection fills the context',()=>{
  const store=new LearningStore({dataDir:os.tmpdir(),runtime:{},getRun:()=>null,knowledge:{get:id=>({title:id,summary:id,content:id,revision:1,provenance:{source:'user',runId:id==='current-note'?'current':'other'}})}});
  store.settings={mode:'manual'};
  store.lessons=Array.from({length:16},(_,i)=>({id:'lesson-'+i,knowledgeId:i===0?'current-note':'foreign-'+i,kind:'fact',cwd:os.tmpdir(),status:'active',updatedAt:new Date(i*1000).toISOString(),provenance:{source:'user',runId:i===0?'current':'other'},evidence:[{runId:i===0?'current':'other'}]}));
  const result=store.getContext(os.tmpdir(),{admit:directoryKnowledgeAdmission({run:{id:'current'}})});
  assert.deepEqual(result.facts.map(row=>row.knowledgeId),['current-note']);
});
