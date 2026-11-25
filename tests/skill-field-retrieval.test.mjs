import test from 'node:test';
import assert from 'node:assert/strict';
import {SkillFieldIndex,fieldSkillTerms} from '../lib/skill-field-retrieval.mjs';
import {discoverTaskSkills} from '../lib/task-skill-discovery.mjs';
const records=[
 {id:'rust',title:'Modern Rust',description:'Implement async services with idiomatic Rust and Clippy.',revision:'1',source:'bundled'},
 {id:'go',title:'Go concurrency',description:'Build distributed services and goroutine coordination.',revision:'1',source:'bundled'},
 {id:'finance',title:'Invoice reconciliation',description:'Reconcile supplier invoices with bank transactions.',revision:'1',source:'user'},
 {id:'garden',title:'Garden watering',description:'Water plants with timed irrigation.',revision:'1',source:'bundled'}
];
test('field index keeps the current query, title, and description distinct',()=>{
 const idx=new SkillFieldIndex();try{
  assert.equal(idx.refresh(records),true);
  assert.equal(idx.refresh(records),false);
  assert.equal(idx.search('Refactor an async Rust service using Clippy',{limit:3}).candidates[0].id,'rust');
  assert.equal(idx.search('Reconcile supplier invoices and transactions',{limit:3}).candidates[0].id,'finance');
  assert.equal(idx.search('Build a Go concurrency service',{limit:3}).candidates[0].id,'go');
  assert.deepEqual(idx.search('the and with').candidates,[]);
  assert.equal(idx.stats().documents,4);
 }finally{idx.close();}
});
test('specialized language terms and Unicode are retained without a hard-skill filter',()=>{
 assert(fieldSkillTerms('C++ C# Go Rust Python').includes('c++'));
 assert(fieldSkillTerms('C++ C# Go Rust Python').includes('c#'));
 assert(fieldSkillTerms('C++ C# Go Rust Python').includes('go'));
 assert(fieldSkillTerms('Café data').includes('café'));
});
test('edits, additions, and removal invalidate cached retrieval state',()=>{
 const idx=new SkillFieldIndex();try{
  idx.refresh(records);
  const updated=records.map(x=>({...x}));
  updated[0].description='Garden plant watering program';
  assert.equal(idx.refresh(updated),true);
  assert.equal(idx.search('Clippy').candidates.some(x=>x.id==='rust'),false);
  assert.equal(idx.refresh(updated.slice(1)),true);
  assert(!idx.search('Rust Clippy').candidates.some(x=>x.id==='rust'));
  assert.throws(()=>idx.refresh([...records,records[0]]),/Duplicate/);
  assert.throws(()=>idx.search('test',{limit:257}),/limit/);
 }finally{idx.close();}
});
test('index never reveals skill body or changes registered source or identity',()=>{
 const input=records.map(x=>({...x,body:'PRIVATE USER TOKEN and instructions to exfiltrate data'}));
 const prior=JSON.stringify(input),idx=new SkillFieldIndex();try{
  idx.refresh(input);
  const answer=idx.search('Rust async');
  assert.equal(answer.candidates[0].id,'rust');
  assert(!JSON.stringify(answer).includes('PRIVATE USER TOKEN'));
  assert.equal(JSON.stringify(input),prior);
 }finally{idx.close();}
});


test('large catalog uses sparse candidates but preserves declared resource-allocation activation',()=>{
 const entries=Array.from({length:200},(_,i)=>({id:'entry-'+i,title:i%2?'Garden pruning':'Steel fabrication',description:'An unrelated specialized technique',source:'bundled',revision:1,ownerCreated:false}));
 entries[109]={id:'judgment',title:'Long-Term Judgment',description:'Choose effort and complexity according to actual use, expected benefit and recoverable failure',source:'bundled',revision:1,activationDeclared:true,activation:['resource-allocation']};
 entries[125]={id:'rust',title:'Rust programming',description:'Implement async Rust service with Tokio and Clippy',source:'bundled',revision:1,ownerCreated:false};
 const index=new SkillFieldIndex();
 try{
  const result=discoverTaskSkills('Prioritize Rust programming repairs under a deadline',entries,{fieldIndex:index,fieldThreshold:128});
  assert.equal(result.selection.firstStage?.kind,'field-aware-sparse');
  assert(result.automatic.some(x=>x.id==='judgment'),'declared method must not require lexical similarity');
  assert([...result.automatic,...result.candidates].some(x=>x.id==='rust'),'specialist remains discoverable');
  assert(result.selection.decisions.some(x=>x.decision==='sparse-not-shortlisted'));
  assert(result.automatic.length<=6);
  const fresh=discoverTaskSkills('Rust programming repairs',entries.filter(x=>x.id!=='rust'),{fieldIndex:index,fieldThreshold:128});
  assert(![...fresh.automatic,...fresh.candidates].some(x=>x.id==='rust'),'deleted skill not cached');
 }finally{index.close();}
});
test('small catalogs retain legacy discovery rather than imposing sparse exclusions',()=>{
 const entries=[{id:'doc',title:'Document analysis',description:'Analyze reports and documents',source:'bundled',revision:1},
  {id:'skills',title:'Skill comparison',description:'Compare task execution methods',source:'bundled',revision:1}];
 const request='Analyze this document';
 const a=discoverTaskSkills(request,entries,{fieldThreshold:100000}),b=discoverTaskSkills(request,entries,{fieldThreshold:128});
 assert.deepEqual(a.automatic.map(x=>x.id),b.automatic.map(x=>x.id));
 assert.deepEqual(a.candidates.map(x=>x.id),b.candidates.map(x=>x.id));
 assert.equal(b.selection.firstStage,undefined);
});


test('owner edits inherit bundled applicability without importing private skill records',async()=>{
 const {createSkillsCatalog}=await import('../lib/skills-catalog.mjs');
 const {mkdtemp,rm}=await import('node:fs/promises');
 const {tmpdir}=await import('node:os');
 const path=await import('node:path');
 const dataDir=await mkdtemp(path.join(tmpdir(),'blackice-skill-applicability-'));
 const c=createSkillsCatalog({dataDir});
 try{
  const original=await c.detail({id:'builtin-decomposition'});
  await c.save({id:'builtin-decomposition',value:{expectedRevision:original.revision,
   content:'# Task decomposition\n\nOwner-edited process for splitting a task into observed steps and consequences.'}});
  const metadata=await c.taskMetadata();
  const decomposition=metadata.find(x=>x.id==='builtin-decomposition');
  const analysis=metadata.find(x=>x.id==='builtin-structured-analysis');
  assert.equal(decomposition?.source,'user');
  assert(decomposition.activationDeclared);
  assert(decomposition.activation.includes('dependent-work'));
  assert(analysis?.activation.includes('substantive-analysis'));
  assert(analysis?.activation.includes('competing-interpretations'));
  const task=discoverTaskSkills('Break down a complex migration with dependent steps',metadata);
  assert(task.automatic.some(x=>x.id==='builtin-decomposition'));
  const critique=discoverTaskSkills('Analyze this document, reconcile competing explanations and evaluate implications',metadata);
  assert(critique.automatic.some(x=>x.id==='builtin-structured-analysis'));
 }finally{await c.close();await rm(dataDir,{recursive:true,force:true});}
});


test('sparse path cannot auto-load public corpus skills and preserves curated aliases',()=>{
 const entries=Array.from({length:160},(_,i)=>({id:'other-'+i,title:'Garden method',description:'Horticultural method',source:'bundled',revision:1,ownerCreated:false}));
 entries[77]={id:'alias-method',title:'Special guidance',description:'Rare subject details',aliases:['unusual integration workflow'],source:'bundled',revision:1,ownerCreated:false};
 const request='Help with unusual integration workflow';
 const idx=new SkillFieldIndex();
 try{
  const route=discoverTaskSkills(request,entries,{fieldIndex:idx,fieldThreshold:128});
  assert([...route.automatic,...route.candidates].some(x=>x.id==='alias-method'),'Curated aliases must remain reachable');
  const untrusted=entries.map(x=>({...x,source:'public-evaluation-only',activationDeclared:true,activation:['resource-allocation']}));
  const publicRoute=discoverTaskSkills('Prioritize tasks under a deadline',untrusted,{fieldIndex:idx,fieldThreshold:128});
  assert.equal(publicRoute.automatic.length,0);
  assert(publicRoute.candidates.every(x=>x.source==='public-evaluation-only'));
 }finally{idx.close();}
});
