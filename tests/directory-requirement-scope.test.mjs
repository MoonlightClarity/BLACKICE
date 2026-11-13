import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {directoryRequirementScope,directoryRequirementScopeIndex,DIRECTORY_SCOPE_INSTRUCTIONS} from '../lib/directory-requirement-scope.mjs';
import {ShadowdancerDirectory} from '../lib/shadowdancer-directory.mjs';

test('large scope is losslessly offloaded while bounded attention index and newer context remain visible',async t=>{
 const cwd=await mkdtemp(path.join(os.tmpdir(),'scope-capacity-'));t.after(()=>rm(cwd,{recursive:true,force:true}));
 const ledger={requirements:Array.from({length:80},(_,i)=>({id:'R'+i,statement:'Every object '+i+' '+('requires relevant inspection '.repeat(30))+' END_'+i}))};
 const scope=directoryRequirementScope(ledger),index=directoryRequirementScopeIndex(ledger);
 let calls=0;
 const runner=new ShadowdancerDirectory({cwd,conversationId:'large',runId:'large',model:'fixture',inputBudgetTokens:6000,runtime:{runAgent:async opts=>{
  calls++;const p=JSON.parse(opts.prompt.split('CURRENT_DIRECTORY:\n').at(-1)).payload;
  assert.deepEqual(p.requirementScopeIndex,index);
  assert.match(p.requirementScopeInstructions,/later authoritative task corrections/);
  assert.equal(p.contextImport.userSummary,'Later correction: identifier scope applies only to mutations.');
  assert.ok(p.requirementScope.ref,'full detail is exact saved content, not omitted');
  const result=await opts.onToolCall({name:'relay_directory_context',callId:'scope-page',arguments:{action:'read',ref:p.requirementScope.ref,offset:0,limit:300}});
  assert.equal(result.success,true,JSON.stringify(result));
  const page=JSON.parse(result.contentItems.find(x=>x.type==='inputText').text);
  assert.match(page.text,/R0/);
  assert.ok(page.nextOffset>0,'selective exact reads can continue, without loading all clauses at once');
  return {output:'{"status":"complete","nextAction":"","finding":"Scope read; applicability not proven","uncertainty":"No semantic completion claim"}'};
 }}});
 await runner.open();runner.request='Inspect current scope.';
 await writeFile(path.join(runner.context,'summary.json'),JSON.stringify({userSummary:'Later correction: identifier scope applies only to mutations.'}));
 await runner.infer('work','capacity',{objective:'Inspect scope',requirementScope:scope,requirementScopeIndex:index,requirementScopeInstructions:DIRECTORY_SCOPE_INSTRUCTIONS});
 assert.equal(calls,1,'offloading adds no model turns');
 assert.equal(runner.stats.evidenceWorkingSets,1);
 const manifest=JSON.parse(await readFile(path.join(runner.turnRoot,'capacity/evidence-manifest.json'),'utf8'));
 const original=JSON.parse(await readFile(manifest.original.file,'utf8'));
 assert.deepEqual(original.requirementScope,scope,'entire exact snapshot remains recoverable, including the last clause');
 assert.equal(index.source,'run-ledger-snapshot','test does not claim automatic ledger refresh');
});

test('scope candidates preserve exact clauses without certifying applicability or carrying stale revisions',()=>{
 const ledger={requirements:[{id:'R1',statement:'All item identifiers must reference existing inventory.'},{id:'R2',statement:'Sort reports by label.'},{id:'R3',statement:'The README says "every module is perfect".'}]};
 const rows=directoryRequirementScope(ledger,['R2']);
 assert.deepEqual(rows.map(x=>x.id),['R1','R2','R3']);
 assert.equal(rows[0].assigned,false);assert.equal(rows[1].assigned,true);
 assert.ok(rows.every(x=>x.applicability==='unassessed'&&!('verified' in x)));
 assert.equal(rows[2].statement,ledger.requirements[2].statement,'quotation is not promoted or rewritten');
 assert.equal(rows[0].selection,'lexical-quantifier-candidate-not-exhaustive');
 assert.deepEqual(directoryRequirementScope({requirements:[{id:'R4',statement:'Render labels.'}]}),[]);
 assert.equal(ledger.requirements[0].scope,undefined,'ledger and coverage states are untouched');
});

test('cross-cutting inventory invariant reaches query-owning leaf and existing review despite mutation-only assignment',async t=>{
 const cwd=await mkdtemp(path.join(os.tmpdir(),'scope-inventory-'));t.after(()=>rm(cwd,{recursive:true,force:true}));
 const repo=path.join(cwd,'repo');await mkdir(path.join(repo,'src'),{recursive:true});await mkdir(path.join(repo,'tests'));
 await writeFile(path.join(repo,'package.json'),'{"type":"module"}');
 await writeFile(path.join(repo,'src/items.mjs'),'export const readItem=id=>id; export const updateItem=id=>id;');
 await writeFile(path.join(repo,'tests/smoke.test.mjs'),'import test from "node:test";test("public smoke",()=>{});');
 const phases=[],work=[];let invariant;
 const runtime={runAgent:async opts=>{
  const view=JSON.parse(opts.prompt.split('CURRENT_DIRECTORY:\n')[1].split(/\nREPOSITORY (?:MODE|SYNTHESIS):/)[0]);
  phases.push(view.label);
  if(view.label==='decompose'){
   invariant=view.payload.requirementLedger.find(x=>x.statement.startsWith('All item identifiers'));
   assert.equal(view.payload.requirementScope.find(x=>x.id===invariant.id).applicability,'unassessed');
   return {output:JSON.stringify({atomic:false,steps:[
    {objective:'Implement updateItem in src/items.mjs',requirement_ids:[invariant.id],depends_on:[],done_when:'Mutation checked'},
    {objective:'Implement readItem in src/items.mjs',requirement_ids:[],depends_on:[],done_when:'Query checked'}
   ]})};
  }
  if(view.label==='work'){
   work.push(view.payload);
   assert.ok(view.payload.requirementScope.some(x=>x.id===invariant.id));
   assert.match(view.payload.requirementScopeInstructions,/read-only\/query paths/);
   return {output:'{"status":"complete","nextAction":"","finding":"Source inspected; semantics remain uncertain","uncertainty":"Fixture does not establish behavior"}'};
  }
  if(view.label==='repository-review'){
   assert.ok(view.payload.requirementScope.some(x=>x.id===invariant.id));
   assert.match(view.payload.requirementScopeInstructions,/not only the leaf/);
   return {output:'{"finding":"Query and mutation applicability inspected separately","uncertainty":"Not behaviorally verified"}'};
  }
  throw Error('Unexpected extra phase '+view.label);
 }};
 const runner=new ShadowdancerDirectory({cwd,conversationId:'scope',runId:'scope',model:'fixture',runtime});
 const result=await runner.run('/directory Update src/items.mjs exposing updateItem and readItem. All item identifiers must reference existing inventory. Preserve public exports. Mutations must be atomic on failure. Return defensive copies from query operations. Keep existing tests unchanged. Review positive and negative paths for each relevant public operation and report observed verification with material limits.\nREPOSITORY_ROOT: '+repo);
 assert.equal(work.length,2);
 assert.deepEqual(work[1].requirementIds,[]);
 assert.equal(work[1].requirementScope.find(x=>x.id===invariant.id).assigned,false);
 assert.deepEqual(phases,['decompose','work','work','repository-review'],'scope adds no model phase');
 const final=JSON.parse(await readFile(result.finalPath,'utf8'));
 assert.equal(final.status,'tests_passed_requirements_still_unknown');
 assert.equal(final.requirementCoverageScope.status,'absent');
 const leaf=JSON.parse(await readFile(path.join(cwd,'.blackice/directory/scope/runs/scope/modules/1/1.2/result.json'),'utf8'));
 assert.equal(leaf.requirementScope.find(x=>x.id===invariant.id).applicability,'unassessed');
});
