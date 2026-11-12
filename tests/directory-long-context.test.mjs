import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {ShadowdancerDirectory,isExecutableFunctionCode,parseShadowdancerRequest} from '../lib/shadowdancer-directory.mjs';
import {estimateContextTokens} from '../lib/context.mjs';

const phase=options=>JSON.parse(options.prompt.split('CURRENT_DIRECTORY:\n').at(-1));
async function fixture(t){
  const cwd=await mkdtemp(path.join(os.tmpdir(),'directory-long-context-'));
  t.after(()=>rm(cwd,{recursive:true,force:true}));
  return cwd;
}
const result=value=>({output:JSON.stringify(value)});

test('full source, extracted values and final output survive former character caps',async t=>{
  const cwd=await fixture(t),request='List the exact source value. '+'requirement '.repeat(6000)+'REQUEST_TAIL';
  const value='VALUE_'+ 'v'.repeat(1500)+'_VALUE_TAIL',quote='QUOTE_'+ 'q'.repeat(1800)+'_QUOTE_TAIL';
  const material='SOURCE_START '+value+' '+quote+' body'.repeat(14000)+' SOURCE_TAIL';
  const answer=value+' answer'.repeat(6000)+' ANSWER_TAIL',summary='summary '.repeat(1000)+'SUMMARY_TAIL';
  const input='/directory '+request+'\nSOURCE:\n'+material;
  assert.deepEqual(parseShadowdancerRequest(input),{request,material});
  const calls=[];
  const runner=new ShadowdancerDirectory({cwd,conversationId:'long',runId:'long-run',model:'remote::fixture',runtime:{async runAgent(options){
    const view=phase(options);calls.push(view.label);
    assert.equal(view.payload.task,request);
    if(view.label==='page-extract'){
      assert.equal(view.payload.source.content,material);
      return result({summary,items:[{value,quote}],uncertainty:''});
    }
    const source=view.payload.records[0].content;
    assert.equal(source.summary,summary);assert.deepEqual(source.items,[{value,quote}]);
    assert.equal(source.originalSource.content,material);
    return result({answer,used_refs:view.payload.required_refs});
  }}});
  const done=await runner.run(input);
  assert.deepEqual(calls,['page-extract','integration']);
  assert.equal(done.answer,answer);assert.equal(done.stats.sourceRefs,1);
  const final=JSON.parse(await readFile(done.finalPath,'utf8'));
  assert.equal(final.answer,answer);
  const persisted=JSON.parse(await readFile(path.join(runner.context,'summary.json'),'utf8'));
  assert.equal(persisted.request,request);assert.equal(persisted.lastAnswer,answer);
  const output=JSON.parse(await readFile(path.join(runner.turnRoot,'integration/round-01/group-001/output.json'),'utf8'));
  assert.equal(output.raw,JSON.stringify({answer,used_refs:['page:1']}));
});

test('source partitions only at reported usable capacity including full prompt overhead',async t=>{
  const cwd=await fixture(t),developerInstructions='Developer instructions. '.repeat(40),authority='Current user authority. '.repeat(35);
  const inputBudgetTokens=3000,material=('Quoted "source" with 😀 and backslash \\\n').repeat(1000)+'SOURCE_END';
  const calls=[],seen=[];
  const runner=new ShadowdancerDirectory({cwd,conversationId:'capacity',runId:'capacity-run',model:'remote::fixture',
    developerInstructions,inputBudgetTokens,getAuthoritativeContext:()=>authority,
    runtime:{async runAgent(options){
      assert.ok(estimateContextTokens([[developerInstructions,options.prompt],options.dynamicTools||[]])<=inputBudgetTokens,'Uses actual serialized request capacity');
      const view=phase(options);calls.push(view.label);
      if(view.label==='page-extract'){seen.push(view.payload.source.content);return result({summary:'Full source partition inspected',items:[],uncertainty:''});}
      return result({answer:'Inspected the source records.',used_refs:view.payload.required_refs});
    }}});
  const done=await runner.run('/directory Inspect the supplied source.\nSOURCE:\n'+material);
  assert.ok(seen.length>1);assert.equal(seen.join(''),material);
  assert.ok(seen.every(part=>!/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(part)));
  const document=JSON.parse(await readFile(path.join(runner.turnRoot,'sources/document.json'),'utf8'));
  assert.equal(document.content,material);assert.equal(done.stats.sourceRefs,seen.length);
  assert.equal(calls.filter(label=>label==='integration').length,1,'Saved evidence is indexed on disk instead of forcing repeated synthesis to shrink it');
  assert.equal(done.stats.evidenceWorkingSets,1);
});

test('complete work dependencies, tool receipts and user context survive fresh phases',async t=>{
  const cwd=await fixture(t),objective='Inspect the complete first outcome. '+'o'.repeat(2500)+'OBJECTIVE_TAIL';
  const doneWhen='Observe '+ 'd'.repeat(1600)+'DONE_TAIL',finding='f'.repeat(4000)+'FINDING_TAIL';
  const candidate='c'.repeat(24000)+'CANDIDATE_TAIL',uncertainty='u'.repeat(1200)+'UNCERTAINTY_TAIL';
  const argumentsText=JSON.stringify({action:'read',path:'p'.repeat(5000)+'PATH_TAIL'}),receiptText='r'.repeat(10000)+'RECEIPT_TAIL';
  const userSummary='s'.repeat(3000)+'SUMMARY_TAIL',pinnedConstraints=Array.from({length:31},(_,i)=>'PIN'+i+'_'+ 'k'.repeat(800));
  const request='Complete the requested two outcomes. '+'j'.repeat(2000)+'REQUEST_TAIL',calls=[];
  const runner=new ShadowdancerDirectory({cwd,conversationId:'dependencies',runId:'dependency-run',model:'fixture',
    baseTools:[{name:'relay_workspace',inputSchema:{type:'object',properties:{action:{type:'string',enum:['read']}}}}],
    dispatchTool:async call=>{assert.equal(call.arguments,argumentsText);return {success:true,contentItems:[{type:'inputText',text:receiptText}]};},
    runtime:{async runAgent(options){
      const view=phase(options),payload=view.payload;calls.push(view.label);
      assert.equal(payload.contextImport.userSummary,userSummary);assert.deepEqual(payload.contextImport.pinnedConstraints,pinnedConstraints);
      if(view.label==='decompose'){
        if(payload.depth===1){assert.equal(payload.objective,request);return result({atomic:false,steps:[{objective,done_when:doneWhen},{objective:'Consume the exact first outcome',done_when:'Exact dependency checked',depends_on:['1']}]});}
        if(payload.objective===objective)assert.ok(payload.objective.endsWith('OBJECTIVE_TAIL'));
        return result({atomic:true});
      }
      if(view.label==='work'){
        if(payload.objective===objective){
          assert.equal(payload.doneWhen,doneWhen);
          await options.onToolCall({name:'relay_workspace',callId:'read-full',arguments:argumentsText});
          return result({status:'complete',nextAction:'',finding,candidate_answer:candidate,uncertainty});
        }
        assert.equal(payload.imports[0].finding,finding);assert.equal(payload.imports[0].candidate_answer,candidate);assert.equal(payload.imports[0].uncertainty,uncertainty);
        assert.equal(payload.hostEvidence[0].arguments,argumentsText);assert.equal(payload.hostEvidence[0].result.contentItems[0].text,receiptText);
        return result({status:'complete',nextAction:'',finding:'Dependency checked',candidate_answer:'Checked',uncertainty:''});
      }
      const first=payload.records.find(row=>row.ref==='module:1.1').content;
      assert.equal(first.candidate_answer,candidate);assert.equal(first.hostEvidence[0].result.contentItems[0].text,receiptText);
      return result({answer:candidate,used_refs:payload.required_refs});
    }}});
  await runner.open();
  await writeFile(path.join(runner.context,'summary.json'),JSON.stringify({userSummary,pinnedConstraints}));
  const done=await runner.run('/directory '+request);
  assert.equal(done.answer,candidate);assert.equal(calls.filter(label=>label==='integration').length,1);
  const executable='function largeResult(){return '+JSON.stringify('z'.repeat(30000))+';}';
  assert.equal(isExecutableFunctionCode(executable,'largeResult'),true);
});
