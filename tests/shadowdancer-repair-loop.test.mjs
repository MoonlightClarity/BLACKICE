import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {ShadowdancerDirectory} from '../lib/shadowdancer-directory.mjs';

async function fixture(t){
 const cwd=await mkdtemp(path.join(os.tmpdir(),'sd-repair-'));
 t.after(()=>rm(cwd,{recursive:true,force:true}));
 const repo=path.join(cwd,'repo');
 await mkdir(path.join(repo,'src'),{recursive:true});
 await mkdir(path.join(repo,'tests'),{recursive:true});
 await writeFile(path.join(repo,'package.json'),JSON.stringify({type:'module'}));
 await writeFile(path.join(repo,'src','logic.mjs'),'export function score(){return 0;}\n');
 await writeFile(path.join(repo,'tests','logic.test.mjs'),
   "import test from 'node:test';import assert from 'node:assert/strict';import {score} from '../src/logic.mjs';test('returns requested value 42',()=>assert.equal(score(),42));");
 return {cwd,repo};
}
function readPrompt(options){
 const text=options.prompt.split('CURRENT_DIRECTORY:\n')[1].split(/\nREPOSITORY (?:MODE|SYNTHESIS):/)[0];
 return JSON.parse(text);
}
const message=(repo)=>'/directory Update score implementation. Existing score() must return 42. Do not claim completion without a passing test.\nREPOSITORY_ROOT: '+repo+'\nVERIFIED NODE BINARY: '+process.execPath;

test('failed verification reopens scoped repair, reruns tests, preserves audit and verified receipts',async t=>{
 const {cwd,repo}=await fixture(t),seen=[];
 const runtime={
  async runAgent(opts){
   const view=readPrompt(opts);
   seen.push(view.label);
   if(view.label==='decompose')return {output:JSON.stringify({atomic:true,reason:'One source edit'})};
   if(view.label==='work')return {output:JSON.stringify({finding:'Work attempted; score is not yet correct',candidate_answer:'Need host tests',uncertainty:'unverified'})};
   if(view.label==='repair'){
     const patch=await opts.onToolCall({name:'relay_workspace',arguments:{action:'patch',path:'src/logic.mjs',oldText:'return 0;',newText:'return 42;'}});
     assert.equal(patch.success,true,JSON.stringify(patch));
     return {output:JSON.stringify({finding:'Changed src/logic.mjs to return 42',candidate_answer:'Host must rerun tests'})};
   }
   if(view.label==='integration'){
     return {output:JSON.stringify({answer:'score now returns 42; host verification evidence is available',
       used_refs:['repair:1','verification:final']})};
   }
   throw Error('Unexpected phase '+view.label);
  }
 };
 const engine=new ShadowdancerDirectory({cwd,conversationId:'repair-chat',runId:'repair-run',model:'gpt-6-luna',runtime});
 const result=await engine.run(message(repo));
 assert.equal(result.stats.verificationStatus,'passed');
 assert.equal(result.stats.testsPassed,1);
 assert.equal(result.stats.testsFailed,0);
 assert.equal(result.stats.repairCycles,1);
 assert.equal(result.stats.calls,3);
 assert.deepEqual(seen,['decompose','work','repair']);
 assert.equal(result.stats.modelSynthesisCallsSkipped,1);
 assert.match(await readFile(path.join(repo,'src','logic.mjs'),'utf8'),/return 42/);
 const run=path.join(cwd,'.shadowdancer','repair-chat','runs','repair-run');
 const before=JSON.parse(await readFile(path.join(run,'verification','round-001.json'),'utf8'));
 const after=JSON.parse(await readFile(path.join(run,'verification','round-002.json'),'utf8'));
 assert.equal(before.status,'failed');assert.equal(after.status,'passed');
 assert.notEqual(before.sourceSha256,after.sourceSha256);
 const module=JSON.parse(await readFile(path.join(run,'modules','1','result.json'),'utf8'));
 assert.equal(module.status,'superseded_by_repair');
 assert.ok(module.supersededBy.includes('round-001'));
 const receipt=JSON.parse(await readFile(path.join(run,'verification','result.json'),'utf8'));
 assert.equal(receipt.ref,'verification:final');
 assert.equal(receipt.status,'passed');
 const final=JSON.parse(await readFile(result.finalPath,'utf8'));
 assert.deepEqual(final.referencedResults.map(x=>x.ref),['repair:1','verification:final']);
 assert.deepEqual(final.supersededResults.map(x=>x.ref),['module:1']);
 assert.equal(final.testsPassed,1);
 assert.ok(final.finalSourceSha256===after.sourceSha256);
 assert.ok(final.status.includes('requirements')||final.status==='test_evidence_covered');
});
test('repair that makes no progress stops and remains explicitly incomplete',async t=>{
 const {cwd,repo}=await fixture(t);
 const calls=[];
 const runtime={async runAgent(opts){
  const p=readPrompt(opts);calls.push(p.label);
  if(p.label==='decompose')return {output:JSON.stringify({atomic:true})};
  if(p.label==='work')return {output:JSON.stringify({finding:'Not repaired'})};
  if(p.label==='repair')return {output:JSON.stringify({finding:'No file changed'})};
  if(p.label==='integration')return {output:JSON.stringify({answer:'Everything is correct',used_refs:['module:1','repair:1','verification:final']})};
  throw Error('Unexpected '+p.label);
 }};
 const engine=new ShadowdancerDirectory({cwd,conversationId:'fail-chat',runId:'fail-run',model:'gpt-6-luna',runtime});
 const out=await engine.run(message(repo));
 assert.equal(out.stats.verificationStatus,'failed');
 assert.equal(out.stats.testsFailed,1);
 assert.equal(out.stats.repairCycles,1);
 const currentModule=JSON.parse(await readFile(path.join(cwd,'.shadowdancer','fail-chat','runs','fail-run','modules','1','result.json'),'utf8'));
 assert.notEqual(currentModule.status,'superseded_by_repair','a no-op cannot invalidate previous work');
 assert.match(out.answer,/Directory verification: failed/);
 const result=JSON.parse(await readFile(out.finalPath,'utf8'));
 assert.equal(result.status,'incomplete_or_unverified');
 assert.equal(result.testsFailed,1);
 assert.match(await readFile(path.join(repo,'src','logic.mjs'),'utf8'),/return 0/);
});
test('every large context page is saved and visited in fresh model calls, not silently sliced',async t=>{
 const cwd=await mkdtemp(path.join(os.tmpdir(),'sd-context-pages-'));t.after(()=>rm(cwd,{recursive:true,force:true}));
 const visits=[];
 const runtime={async runAgent(opts){
  const view=readPrompt(opts);visits.push(view.label);
  if(view.label==='context-page'){
   return {output:JSON.stringify({summary:'Page '+view.payload.page+' read',
     refs:['P'+view.payload.page]})};
  }
  if(view.label==='integration'){
   assert.equal(view.allPagesVisited,true);
   assert.equal(view.pages.length,4);
   assert.ok(view.pages.some(p=>p.summary==='Page 4 read'));
   return {output:JSON.stringify({answer:'All pages visited',used_refs:[]})};
  }
  throw Error('Unexpected phase');
 }};
 const engine=new ShadowdancerDirectory({cwd,conversationId:'pages',runId:'pages-run',model:'gpt-6-luna',runtime,limits:{maxContextPages:8}});
 await engine.open();
 const response=await engine.infer('integration','integration/index',{blob:'A'.repeat(16000),instructions:'Check every page'},{maxChars:9000});
 assert.ok(response.output.includes('All pages visited'));
 assert.equal(engine.stats.contextPages,4);
 assert.deepEqual(visits,['context-page','context-page','context-page','context-page','integration']);
 const original=JSON.parse(await readFile(path.join(cwd,'.shadowdancer','pages','runs','pages-run','integration','index','input.json'),'utf8'));
 assert.equal(original.payload.blob.length,16000);
 const pages=await readdir(path.join(cwd,'.shadowdancer','pages','runs','pages-run','integration','index','context-pages'));
 assert.equal(pages.length,4);
});
test('host source/test receipts suppress contradictory model narration but preserve it for audit',async t=>{
 const {cwd,repo}=await fixture(t);
 const backend={async runAgent(opts){
  const view=readPrompt(opts);
  if(view.label==='decompose')return {output:JSON.stringify({atomic:true})};
  if(view.label==='work'){
   const patch=await opts.onToolCall({name:'relay_workspace',arguments:{
     action:'patch',path:'src/logic.mjs',oldText:'return 0;',newText:'return 42;'
   }});
   assert.equal(patch.success,true);
   return {output:JSON.stringify({finding:'Fixed the source'})};
  }
  if(view.label==='integration')return {output:JSON.stringify({
    answer:'No repository changes were made. I could not run the tests.',
    used_refs:['module:1','verification:final'],
  })};
  throw Error('Unexpected phase '+view.label);
 }};
 const engine=new ShadowdancerDirectory({cwd,conversationId:'conflict-chat',runId:'conflict-run',model:'gpt-6-luna',runtime:backend});
 const result=await engine.run(message(repo));
 assert.equal(result.stats.verificationStatus,'passed');
 assert.match(result.answer,/Changed files within the recorded source inventory: src\/logic\.mjs/);
 assert.match(result.answer,/Host test receipt: passed \(1\/1 passed\)/);
 assert.doesNotMatch(result.answer,/No repository changes were made/);
 const final=JSON.parse(await readFile(result.finalPath,'utf8'));
 assert.equal(final.modelSynthesis,null);
 assert.equal(final.integrationAuthority,'host_source_reference_index');
 assert.equal(final.modelSynthesisVisibility,'not_generated');
 assert.deepEqual(final.contradictionFlags,[]);
 const index=JSON.parse(await readFile(path.join(cwd,'.shadowdancer','conflict-chat','runs','conflict-run','integration','host-index.json'),'utf8'));
 assert.deepEqual(index.used_refs,['module:1','verification:final']);
 assert.equal(index.references.length,2);
 assert.ok(index.references.every(x=>/^[a-f0-9]{64}$/.test(x.sha256)));
 const audit=JSON.parse(await readFile(path.join(cwd,'.shadowdancer','conflict-chat','runs','conflict-run','integration','repository-audit.json'),'utf8'));
 assert.deepEqual(audit.changedFiles,['src/logic.mjs']);
});
test('repository synthesis has no tools and unrecognized model test claims stay audit-only',async t=>{
 const {cwd,repo}=await fixture(t);
 const runtime={async runAgent(opts){
  const view=readPrompt(opts);
  if(view.label==='decompose')return {output:JSON.stringify({atomic:true})};
  if(view.label==='work'){
   const patch=await opts.onToolCall({name:'relay_workspace',arguments:{
    action:'patch',path:'src/logic.mjs',oldText:'return 0;',newText:'return 42;'
   }});
   assert.equal(patch.success,true,JSON.stringify(patch));
   return {output:JSON.stringify({finding:'Source updated'})};
  }
  if(view.label==='integration'){
   assert.equal(opts.sandbox,'read-only','synthesis must not inherit write sandbox');
   assert.equal(opts.onToolCall,undefined,'synthesis cannot invoke workspace operations');
   assert.equal(opts.dynamicTools,undefined,'synthesis receives saved receipts only');
   return {output:JSON.stringify({
    answer:'Node.js is not recognized; node --test exited with code 1. The host test command remains unavailable here.',
    used_refs:['module:1','verification:final'],
   })};
  }
  throw Error('Unexpected phase '+view.label);
 }};
 const engine=new ShadowdancerDirectory({cwd,conversationId:'narrative-chat',runId:'narrative-run',
  model:'gpt-6-luna',runtime});
 const result=await engine.run(message(repo));
 assert.equal(result.stats.verificationStatus,'passed');
 assert.match(result.answer,/Host test receipt: passed \(1\/1 passed\)/);
 assert.match(result.answer,/Changed files within the recorded source inventory: src\/logic\.mjs/);
 assert.doesNotMatch(result.answer,/not recognized|command remains unavailable|exited with code 1/i);
 const stored=JSON.parse(await readFile(result.finalPath,'utf8'));
 assert.equal(stored.modelSynthesis,null);
 assert.equal(stored.modelSynthesisVisibility,'not_generated');
 assert.equal(stored.integrationAuthority,'host_source_reference_index');
 assert.equal(stored.publicationAuthority,'host-verification-and-source-hashes');
 assert.equal(result.stats.modelSynthesisCallsSkipped,1);
 assert.equal(result.stats.calls,2);
 assert.deepEqual(stored.contradictionFlags,[]);
});

test('two repair rounds supersede older failed findings before mandatory final synthesis',async t=>{
 const {cwd,repo}=await fixture(t);
 let attempted=0;
 const runtime={async runAgent(opts){
  const v=readPrompt(opts);
  if(v.label==='decompose')return {output:JSON.stringify({atomic:true})};
  if(v.label==='work')return {output:JSON.stringify({finding:'Code not yet corrected'})};
  if(v.label==='repair'){
   attempted++;
   const was=attempted===1?'return 0;':'return 41;';
   const next=attempted===1?'return 41;':'return 42;';
   const patch=await opts.onToolCall({name:'relay_workspace',arguments:{
     action:'patch',path:'src/logic.mjs',oldText:was,newText:next
   }});
   assert.equal(patch.success,true,JSON.stringify(patch));
   return {output:JSON.stringify({finding:'Patched score to '+(attempted===1?41:42)})};
  }
  if(v.label==='integration'){
   assert.deepEqual(v.payload.required_refs,['repair:2','verification:final']);
   return {output:JSON.stringify({answer:'The current code returns 42',
     used_refs:['repair:2','verification:final']})};
  }
  throw Error('Unexpected '+v.label);
 }};
 const reasoner=new ShadowdancerDirectory({cwd,conversationId:'two-repairs',runId:'two-run',
   model:'gpt-6-luna',runtime,limits:{maxRepairCycles:2}});
 const result=await reasoner.run(message(repo));
 assert.equal(result.stats.repairCycles,2);
 assert.equal(result.stats.testsPassed,1);
 assert.equal(result.stats.verificationStatus,'passed');
 assert.equal(attempted,2);
 const root=path.join(cwd,'.shadowdancer','two-repairs','runs','two-run');
 const first=JSON.parse(await readFile(path.join(root,'repair','round-001','result.json'),'utf8'));
 assert.equal(first.status,'superseded_by_repair');
 assert.ok(first.supersededBy.includes('round-002'));
 const final=JSON.parse(await readFile(result.finalPath,'utf8'));
 assert.deepEqual(final.referencedResults.map(x=>x.ref),['repair:2','verification:final']);
 assert.deepEqual(final.supersededResults.map(x=>x.ref),['module:1','repair:1']);
 for(let i=1;i<=3;i++){
   const file='round-'+String(i).padStart(3,'0')+'.json';
   assert.equal(JSON.parse(await readFile(path.join(root,'verification',file),'utf8')).tests,1);
 }
});
test('changing existing tests to force a pass is detected and cannot certify completion',async t=>{
 const {cwd,repo}=await fixture(t);
 const runtime={async runAgent(opts){
  const v=readPrompt(opts);
  if(v.label==='decompose')return {output:JSON.stringify({atomic:true})};
  if(v.label==='work'){
   const patch=await opts.onToolCall({name:'relay_workspace',arguments:{
     action:'patch',path:'tests/logic.test.mjs',
     oldText:'assert.equal(score(),42)',newText:'assert.equal(score(),0)'
   }});
   assert.equal(patch.success,true,JSON.stringify(patch));
   return {output:JSON.stringify({finding:'Changed test expectation only'})};
  }
  if(v.label==='integration'){
   return {output:JSON.stringify({answer:'Everything passes',used_refs:['module:1','verification:final']})};
  }
  throw Error('Unexpected '+v.label);
 }};
 const controller=new ShadowdancerDirectory({cwd,conversationId:'tamper-chat',runId:'tamper-run',
   model:'gpt-6-luna',runtime});
 const result=await controller.run(message(repo));
 assert.equal(result.stats.verificationStatus,'passed');
 assert.equal(result.stats.testsPassed,1);
 assert.equal(result.stats.testIntegrity,'preexisting_tests_modified');
 assert.match(result.answer,/pre-existing tests changed or were removed/);
 assert.deepEqual(result.repositoryAudit.changedFiles,['tests/logic.test.mjs']);
 const run=path.join(cwd,'.shadowdancer','tamper-chat','runs','tamper-run');
 const integrity=JSON.parse(await readFile(path.join(run,'verification','test-integrity.json'),'utf8'));
 assert.equal(integrity.compromised,true);
 assert.deepEqual(integrity.mutatedExisting,['tests/logic.test.mjs']);
 const published=JSON.parse(await readFile(result.finalPath,'utf8'));
 assert.equal(published.status,'preexisting_tests_modified');
 assert.equal(published.testIntegrityStatus,'preexisting_tests_modified');
});
test('an explicit repository coverage map is checked against the real test receipt',async t=>{
 const {cwd,repo}=await fixture(t);
 await writeFile(path.join(repo,'tests','requirement-coverage.json'),JSON.stringify({
   version:1,mappings:[{
     requirementId:'R002',testFile:'tests/logic.test.mjs',
     case:'returns requested value 42',rationale:'The function is observed returning 42'
   }]
 }));
 const runtime={async runAgent(opts){
   const v=readPrompt(opts);
   if(v.label==='decompose')return {output:JSON.stringify({atomic:true})};
   if(v.label==='work'){
     const changed=await opts.onToolCall({name:'relay_workspace',arguments:{
       action:'patch',path:'src/logic.mjs',oldText:'return 0;',newText:'return 42;'
     }});
     assert.equal(changed.success,true);
     return {output:JSON.stringify({finding:'Updated score implementation'})};
   }
   if(v.label==='integration')return {output:JSON.stringify({
     answer:'Score returns 42',used_refs:['module:1','verification:final']
   })};
   throw Error('Unexpected '+v.label);
 }};
 const engine=new ShadowdancerDirectory({cwd,conversationId:'coverage-chat',runId:'coverage-run',
   model:'gpt-6-luna',runtime});
 const done=await engine.run(message(repo));
 assert.equal(done.stats.verificationStatus,'passed');
 assert.equal(done.stats.coverageStatus,'validated');
 assert.equal(done.stats.explicitlyTestCovered,1);
 assert.equal(done.stats.coverageRejections,0);
 const root=path.join(cwd,'.shadowdancer','coverage-chat','runs','coverage-run');
 const ledger=JSON.parse(await readFile(path.join(root,'verification','requirements-ledger.json'),'utf8'));
 assert.equal(ledger.requirements.find(x=>x.id==='R002').state,'test-covered');
 const actual=JSON.parse(await readFile(path.join(root,'verification','coverage-evidence.json'),'utf8'));
 assert.equal(actual.accepted.length,1);
 assert.equal(actual.accepted[0].case,'returns requested value 42');
 const receipt=JSON.parse(await readFile(path.join(root,'verification','round-001.json'),'utf8'));
 assert.equal(actual.accepted[0].testFileSha256,receipt.testSourceFiles[0].sha256);
 const final=JSON.parse(await readFile(done.finalPath,'utf8'));
 assert.equal(final.testIntegrityStatus,'baseline_preserved');
 assert.ok(final.unknownRequirements>0);
});
test('a context exceeding the page limit fails closed and preserves full input',async t=>{
 const cwd=await mkdtemp(path.join(os.tmpdir(),'sd-overflow-'));t.after(()=>rm(cwd,{recursive:true,force:true}));
 let calls=0;const runtime={async runAgent(){calls++;return {output:'{}'}}};
 const engine=new ShadowdancerDirectory({cwd,conversationId:'limits',runId:'limits-run',model:'gpt-6-luna',runtime,limits:{maxContextPages:2}});
 await engine.open();
 await assert.rejects(()=>engine.infer('integration','part',{blob:'z'.repeat(20000)},{maxChars:4000}),{code:'DIRECTORY_CONTEXT_PAGE_LIMIT'});
 assert.equal(calls,0);
 const input=JSON.parse(await readFile(path.join(cwd,'.shadowdancer','limits','runs','limits-run','part','input.json'),'utf8'));
 assert.equal(input.payload.blob.length,20000);
});
