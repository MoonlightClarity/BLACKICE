import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { isShadowdancerRequest, parseShadowdancerRequest, runShadowdancerDirectory, ShadowdancerDirectory } from '../lib/shadowdancer-directory.mjs';

class ScriptedRuntime {
  constructor(answers) { this.answers=[...answers]; this.calls=[]; }
  async runAgent(options) {
    this.calls.push(options);
    if(!this.answers.length) throw new Error('Unexpected extra model call');
    return {output: typeof this.answers[0]==='string'?this.answers.shift():JSON.stringify(this.answers.shift()), threadId:'fresh_'+this.calls.length};
  }
}
async function fixture() { const cwd=await mkdtemp(path.join(os.tmpdir(),'blackice-shadowdancer-'));return {cwd,cleanup:()=>rm(cwd,{recursive:true,force:true})}; }
const part = (token, n) => String(token).padEnd(n, ' background context ');
const source = part('The marker code is ALPHA17.', 1150) + part('The marker code is BETA29.', 1100);
const summary = (item,code) => ({summary:'Found '+code,items:[{value:code,quote:'marker code is '+code}],uncertainty:'unverified model extraction'});
const integration = (answer, refs) => ({answer,used_refs:refs,integrated_findings:refs.map(ref=>({ref,claim:'linked'}))});
async function runPagedFixture(args) {
  const runner=new ShadowdancerDirectory(args);
  runner.sourceChunks=async text=>Array.from({length:Math.ceil(text.length/1150)},(_,i)=>text.slice(i*1150,(i+1)*1150));
  return runner.run(args.input);
}

test('opt-in command is explicit, and SOURCE is separated from user request', () => {
  assert.equal(isShadowdancerRequest('/directory List codes'),true);
  assert.equal(isShadowdancerRequest('@directory List codes'),true);
  assert.equal(isShadowdancerRequest('@shadowdancer List codes'),true);
  assert.equal(isShadowdancerRequest('ordinary chat'),false);
  const parsed=parseShadowdancerRequest('/directory List all codes\nSOURCE:\nPage one\nPage two');
  assert.equal(parsed.request,'List all codes');
  assert.equal(parsed.material,'Page one\nPage two');
});

test('two pages cannot silently drop the second source; turns and context summary are persisted', async t => {
  const x=await fixture();t.after(x.cleanup);
  const runtime=new ScriptedRuntime([
    summary('first','ALPHA17'),summary('second','BETA29'),
    integration('ALPHA17',['page:1']), // deliberately missing page 2
    integration('ALPHA17 and BETA29',['page:1','page:2'])
  ]);
  const received=[];
  const done=await runPagedFixture({
    cwd:x.cwd,conversationId:'chat001',runId:'run001',
    model:'remote::test',runtime,input:'/directory List all marker codes\nSOURCE:\n'+source,
    onProgress:x=>received.push(x)
  });
  assert.match(done.answer,/ALPHA17/);
  assert.match(done.answer,/BETA29/);
  assert.equal(done.stats.coverageFailures,1);
  assert.equal(done.stats.sourceRefs,2);
  assert.equal(done.stats.integrationGroups,1);
  assert.equal(runtime.calls.length,4);
  assert.equal(done.stats.resets,runtime.calls.length);
  for(const call of runtime.calls) {
    assert.equal(call.model,'remote::test');
    assert.equal(call.responseOnly,true);
    assert.equal(call.threadId,undefined);
    assert.equal(call.continuity,undefined);
    assert.equal(call.sandbox,'read-only');
  }
  assert.equal(new Set(runtime.calls.slice(0,2).map(c=>c.cwd)).size,2);
  assert.ok(runtime.calls[0].prompt.includes('ALPHA17'));
  assert.ok(!runtime.calls[0].prompt.includes('BETA29'));
  assert.ok(runtime.calls[1].prompt.includes('BETA29'));
  assert.ok(!runtime.calls[1].prompt.includes('ALPHA17'));
  const root=path.join(x.cwd,'.shadowdancer','chat001');
  const index=JSON.parse(await readFile(path.join(root,'conversation','context','turns.json'),'utf8'));
  assert.ok(index.some(x=>x.label==='request'));
  assert.equal(index.filter(x=>x.label==='page-extract').length,2);
  assert.ok(index.some(x=>x.label==='integration-review'));
  assert.ok(index.some(x=>x.label==='final'));
  const convo=JSON.parse(await readFile(path.join(root,'conversation','context','summary.json'),'utf8'));
  assert.equal(convo.integrationStatus,'coverage_checked_not_fact_verified');
  assert.equal(convo.lastAnswer,'ALPHA17 and BETA29');
  assert.equal(convo.totalTurns,index.length);
  assert.deepEqual(convo.resultRefs,['page:1','page:2']);
  const last=JSON.parse(await readFile(done.finalPath,'utf8'));
  assert.deepEqual(last.requiredTerms,['ALPHA17','BETA29']);
  assert.equal(last.status,'coverage_checked_not_fact_verified');
  assert.ok(received.length>=8);
});

test('explicit reference claim without required source fact cannot pass synthesis', async t => {
  const x=await fixture();t.after(x.cleanup);
  const runtime=new ScriptedRuntime([
    summary('first','ALPHA17'),summary('second','BETA29'),
    integration('ALPHA17',['page:1','page:2']),
    integration('ALPHA17',['page:1','page:2'])
  ]);
  await assert.rejects(
    runPagedFixture({
      cwd:x.cwd,conversationId:'chat002',runId:'run002',model:'remote::test',runtime,
      input:'/directory List all marker codes\nSOURCE:\n'+source,
    }),
    {code:'DIRECTORY_INTEGRATION_COVERAGE'}
  );
  assert.equal(runtime.calls.length,4);
});

test('recursive planning creates separate module files, labels work turns and integrates them', async t => {
  const x=await fixture();t.after(x.cleanup);
  const runtime=new ScriptedRuntime([
    {atomic:false,steps:[{objective:'Compute 19 times 23'},{objective:'Verify 19 times 23 independently'}]},
    {atomic:true}, {atomic:true},
    {status:'complete',nextAction:'',finding:'19*23=437',candidate_answer:'437'},
    {status:'complete',nextAction:'',finding:'20*23-23=437',candidate_answer:'437'},
    integration('The value is 437 and it checks by an independent method.',['module:1.1','module:1.2'])
  ]);
  const done=await runShadowdancerDirectory({
    cwd:x.cwd,conversationId:'chat003',runId:'run003',model:'remote::test',runtime,
    input:'/directory Compute 19 times 23 and then verify the result',
  });
  assert.match(done.answer,/437/);
  const base=path.join(x.cwd,'.shadowdancer','chat003','runs','run003');
  assert.deepEqual((await readdir(path.join(base,'modules','1'))).sort().slice(0,2),['1.1','1.2']);
  const result1=JSON.parse(await readFile(path.join(base,'modules','1','1.1','result.json'),'utf8'));
  const result2=JSON.parse(await readFile(path.join(base,'modules','1','1.2','result.json'),'utf8'));
  assert.equal(result1.ref,'module:1.1');
  assert.equal(result2.ref,'module:1.2');
  assert.ok(runtime.calls.every(c=>!('threadId' in c)));
  assert.equal(done.stats.calls,6);
});


test('single named JavaScript function remains an atomic folder and survives source-code synthesis',async t=>{
  const x=await fixture();t.after(x.cleanup);
  const js='function normalizeTags(input){return [...new Set(input.map(s=>s.trim().toLowerCase()).filter(Boolean))];}';
  const runtime=new ScriptedRuntime([
    {status:'complete',nextAction:'',finding:'Implemented one callable',candidate_answer:js,uncertainty:''},
    integration(js,['module:1'])
  ]);
  const done=await runShadowdancerDirectory({
    cwd:x.cwd,conversationId:'coding-test',runId:'code-run',runtime,model:'remote::test',
    input:'/directory Implement exactly one JavaScript function named normalizeTags(input) that trims, lowercases and deduplicates strings. Return a fenced code block.',
  });
  assert.equal(runtime.calls.length,2,'One work phase and one mandatory integration phase');
  assert.match(done.answer,/function normalizeTags/);
  assert.ok(done.answer.includes('javascript'));
  assert.ok(done.stats.calls===2);
  const base=path.join(x.cwd,'.shadowdancer','coding-test','runs','code-run');
  const module=JSON.parse(await readFile(path.join(base,'modules','1','module.json'),'utf8'));
  assert.equal(module.adaptiveReason,'single_callable_contract');
  const final=JSON.parse(await readFile(done.finalPath,'utf8'));
  assert.deepEqual(final.referencedResults.map(x=>x.ref),['module:1']);
});
test('directory integration rejects prose in place of executable code',async t=>{
  const x=await fixture();t.after(x.cleanup);
  const js='function normalizeTags(input){return input;}';
  const runtime=new ScriptedRuntime([
    {status:'complete',nextAction:'',finding:'One function',candidate_answer:js},
    integration('This function normalizes the tags.',['module:1']),
    integration('Just trim and lowercase each string.',['module:1'])
  ]);
  await assert.rejects(runShadowdancerDirectory({
    cwd:x.cwd,conversationId:'code-fail',runId:'code-run',runtime,model:'remote::test',
    input:'/directory Implement exactly one JavaScript function named normalizeTags(input). Return executable code only.',
  }),{code:'DIRECTORY_INTEGRATION_COVERAGE'});
  assert.equal(runtime.calls.length,3);
});

test('multi-round synthesis uses disk files at every level and checks source coverage', async t => {
  const x=await fixture();t.after(x.cleanup);
  const chars=[['KAPPA1','A'],['LAMBDA2','B'],['MU3','C'],['NU4','D']];
  const body=chars.map(([code,pad])=>('Code '+code+'. '+pad.repeat(1130))).join('');
  // Ensure four page slices, the end of each chunk may land in next page.
  const chunks=[];for(let i=0;i<body.length;i+=1150)chunks.push(body.slice(i,i+1150));
  const answers=chunks.map((text,i)=>({
    summary:'Page '+(i+1)+' reviewed',items:chars.filter(([code])=>text.includes(code)).map(([code])=>({value:code,quote:code}))
  }));
  const allRefs=chunks.map((_,i)=>'page:'+(i+1));
  answers.push(integration('KAPPA1 LAMBDA2 MU3',[...allRefs.slice(0,3)]));
  if(chunks.length>3)answers.push(integration('NU4',[...allRefs.slice(3)]));
  answers.push(integration('KAPPA1 LAMBDA2 MU3 NU4',['integrated:1:1','integrated:1:2']));
  const runtime=new ScriptedRuntime(answers);
  const done=await runPagedFixture({
    limits:{groupSize:3},cwd:x.cwd,conversationId:'chat004',runId:'run004',model:'remote::test',runtime,
    input:'/directory List all codes\nSOURCE:\n'+body
  });
  assert.equal(done.stats.sourceRefs,chunks.length);
  assert.equal(done.stats.integrationGroups,3);
  assert.match(done.answer,/NU4/);
  assert.equal(runtime.calls.length,chunks.length+3);
});
