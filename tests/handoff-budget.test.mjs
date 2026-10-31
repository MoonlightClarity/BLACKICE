import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp,mkdir,rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { HarnessEngine } from '../lib/engine.mjs';
import { contextSnapshot,estimateContextTokens } from '../lib/context.mjs';

async function handoffFixture(t,{history,context,reportedWindow,priorContext,nextModel,nextContext,effort,nextEffort,defaultEffort,identityText=''}={}){
  const directory=await mkdtemp(path.join(os.tmpdir(),'relay-handoff-budget-')),cwd=path.join(directory,'workspace'),dataDir=path.join(directory,'data'),calls=[];await mkdir(cwd);
  class Runtime extends EventEmitter{
    status(){return{connected:true,authenticated:true,defaultModel:'budget-model',models:[{id:'budget-model',model:'budget-model',...(defaultEffort?{defaultReasoningEffort:defaultEffort}:{}),...(reportedWindow?{contextWindowTokens:reportedWindow,contextWindowSource:'provider-reported'}:{})}]};}
    async runAgent(options){calls.push(options);const index=calls.length,output=index===1?history:'Follow-up verified.',threadId=`handoff-private-${index}`;options.onEvent({type:'thread',model:options.model,effort:options.effort==='default'?defaultEffort:options.effort,threadId,codexHistory:'relay'});if(index===1&&priorContext)options.onEvent({type:'context',context:priorContext,threadId});options.onEvent({type:'message',itemId:`message-${index}`,text:output,phase:'final_answer',threadId});return{output,threadId,codexHistory:'relay'};}
    async close(){}
  }
  const runtime=new Runtime(),identity=identityText?{snapshot:async()=>({text:identityText,revisions:{soul:1,user:1},createdAt:'fixture'})}:undefined;
  const engine=new HarnessEngine({runtime,dataDir,defaultCwd:cwd,identity});engine.runtimeSettings={get:()=>({codexHistory:'relay'})};await engine.init();
  t.after(async()=>{await engine.close();assert.match(path.basename(directory),/^relay-handoff-budget-/);await rm(directory,{recursive:true,force:true});});
  const workflow={id:'handoff-budget',name:'Context budget',nodes:[{id:'input',type:'input'},{id:'agent',type:'agent',name:'Verifier',model:'budget-model',prompt:'Keep verified history and inspect current files before acting.',...(context?{context}:{}),...(effort?{effort}:{})},{id:'output',type:'output'}],edges:[{source:'input',target:'agent'},{source:'agent',target:'output'}],settings:{maxParallel:1,planningMode:'off'}};
  const first=engine.startRun({workflow,input:'ORIGINAL_OBJECTIVE: retain the recorded evidence.'});await engine.executions.get(first.id);const saved=engine.getRun(first.id);assert.equal(saved.status,'completed',saved.error);
  const next=engine.continueRun(first.id,{nodeId:'agent',message:'FOLLOWUP_OBJECTIVE: check the recorded middle evidence.',...(nextModel?{model:nextModel}:{}),...(nextContext!==undefined?{context:nextContext}:{}),...(nextEffort?{effort:nextEffort}:{})},{historyRuns:[saved]});await engine.executions.get(next.id);return{engine,calls,first:saved,next:engine.getRun(next.id)};
}

test('an explicit 900k window restores saved messages beyond the former 160k-character cutoff',async t=>{
  const history='FIRST_EVIDENCE\n'+'a'.repeat(210000)+'\nMIDDLE_HISTORY_EVIDENCE\n'+'b'.repeat(210000)+'\nLATEST_EVIDENCE',context={preset:'900k'};
  const{calls,next}=await handoffFixture(t,{history,context,reportedWindow:1000000});assert.equal(next.status,'completed',next.error);assert.equal(calls[1].threadId,undefined);assert.equal(calls[1].codexHistory,'codex');assert.match(calls[1].prompt,/MIDDLE_HISTORY_EVIDENCE/);assert.ok(calls[1].prompt.length>400000);
  const continuity=next.nodes.agent.continuity;assert.equal(continuity.truncated,false);assert.equal(continuity.effectiveWindowTokens,900000);assert.equal(continuity.windowSource,'provider-reported');assert.equal(continuity.sourceChars,continuity.retainedChars);assert.equal(continuity.omittedChars,0);assert.equal(continuity.method,'saved-messages');assert.equal(continuity.estimatedInputTokens,estimateContextTokens([[calls[1].developerInstructions,calls[1].prompt],calls[1].dynamicTools]));assert.ok(continuity.estimatedInputTokens<=continuity.inputBudgetTokens);
});

test('reported small capacity and complete prompt/tool overhead constrain continuity with an explicit receipt and omission marker',async t=>{
  const context={preset:'900k',outputReserveTokens:1024,headroomTokens:512},history='FIRST_EVIDENCE\n'+'x'.repeat(200000)+'\nMIDDLE_SHOULD_BE_OMITTED\n'+'z'.repeat(200000)+'\nLATEST_EVIDENCE';
  const{calls,next}=await handoffFixture(t,{history,context,reportedWindow:32768,identityText:'Additional saved identity instructions. '.repeat(300)});assert.equal(next.status,'completed',next.error);
  const options=calls[1],continuity=next.nodes.agent.continuity,limits=contextSnapshot({options:context,modelWindowTokens:32768,modelWindowSource:'provider-reported'});assert.equal(continuity.truncated,true);assert.equal(continuity.effectiveWindowTokens,32768);assert.equal(continuity.inputBudgetTokens,limits.inputBudgetTokens);assert.ok(continuity.omittedChars>0);assert.ok(continuity.retainedChars<continuity.sourceChars);assert.equal(continuity.sourceChars-continuity.retainedChars,continuity.omittedChars);assert.match(options.prompt,/Earlier saved conversation shortened to fit the selected model context/);assert.match(options.prompt,/ORIGINAL_OBJECTIVE/);assert.match(options.prompt,/LATEST_EVIDENCE/);assert.match(options.prompt,/FOLLOWUP_OBJECTIVE/);assert.doesNotMatch(options.prompt,/MIDDLE_SHOULD_BE_OMITTED/);
  const actualEstimate=estimateContextTokens([[options.developerInstructions,options.prompt],options.dynamicTools]);assert.equal(continuity.estimatedInputTokens,actualEstimate);assert.ok(actualEstimate<=limits.inputBudgetTokens);assert.ok(options.dynamicTools.length>0);assert.match(options.prompt,/Additional saved identity instructions/);
});

test('unreported model capacity uses the existing working budget instead of loading a requested 900k history by default',async t=>{
  const history='ARCHIVE_START\n'+'d'.repeat(450000)+'\nARCHIVE_END';const{calls,next}=await handoffFixture(t,{history});assert.equal(next.status,'completed',next.error);
  const continuity=next.nodes.agent.continuity;assert.equal(continuity.effectiveWindowTokens,128000);assert.equal(continuity.windowSource,'working-budget');assert.equal(continuity.truncated,true);assert.ok(calls[1].prompt.length<400000);assert.match(calls[1].prompt,/ARCHIVE_END/);assert.ok(continuity.estimatedInputTokens<=continuity.inputBudgetTokens);
});

test('UTF-8 history is fitted using token estimates rather than an ASCII character allowance',async t=>{
  const context={preset:'custom',windowTokens:32768,outputReserveTokens:1024,headroomTokens:512},history='UNICODE_START\n'+'漢'.repeat(50000)+'🙂'.repeat(40000)+'\nUNICODE_END';const{calls,next}=await handoffFixture(t,{history,context,reportedWindow:32768});assert.equal(next.status,'completed',next.error);
  const continuity=next.nodes.agent.continuity,estimate=estimateContextTokens([[calls[1].developerInstructions,calls[1].prompt],calls[1].dynamicTools]);assert.equal(continuity.truncated,true);assert.equal(continuity.estimatedInputTokens,estimate);assert.ok(estimate<=continuity.inputBudgetTokens);assert.match(calls[1].prompt,/UNICODE_START/);assert.match(calls[1].prompt,/UNICODE_END/);
});

test('a confirmed same-model capacity survives a missing catalog entry and restores the actual default window',async t=>{
  const history='EARLY_EVIDENCE\n'+'a'.repeat(80000)+'\nCONFIRMED_WINDOW_MIDDLE\n'+'b'.repeat(370000)+'\nLATEST_EVIDENCE',priorContext={windowSource:'provider-reported',modelWindowTokens:258400,effectiveWindowTokens:258400};
  const{next,calls}=await handoffFixture(t,{history,priorContext});assert.equal(next.status,'completed',next.error);
  assert.equal(next.modelHandoff.reportedModel,'budget-model');assert.equal(next.modelHandoff.reportedModelWindowTokens,258400);assert.equal(next.nodes.agent.continuity.effectiveWindowTokens,258400);assert.equal(next.nodes.agent.continuity.windowSource,'provider-reported');assert.equal(next.nodes.agent.continuity.truncated,false);assert.match(calls[1].prompt,/CONFIRMED_WINDOW_MIDDLE/);
});

test('a requested 900k continuation respects a confirmed same-model 258400-token window when catalog metadata is absent',async t=>{
  const context={preset:'900k'},priorContext={windowSource:'provider-reported',modelWindowTokens:258400,effectiveWindowTokens:258400},history='LONG_START\n'+'x'.repeat(450000)+'y'.repeat(450000)+'\nLONG_END';
  const{next,calls}=await handoffFixture(t,{history,context,priorContext});assert.equal(next.status,'completed',next.error);
  const continuity=next.nodes.agent.continuity,limits=contextSnapshot({options:context,modelWindowTokens:258400,modelWindowSource:'provider-reported'});assert.equal(continuity.effectiveWindowTokens,258400);assert.equal(continuity.inputBudgetTokens,limits.inputBudgetTokens);assert.equal(continuity.truncated,true);assert.equal(continuity.windowSource,'provider-reported');assert.ok(estimateContextTokens([[calls[1].developerInstructions,calls[1].prompt],calls[1].dynamicTools])<=limits.inputBudgetTokens);assert.match(calls[1].prompt,/LONG_END/);
});

test('a current smaller reported model capacity takes precedence over an earlier confirmed capacity',async t=>{
  const context={preset:'900k'},priorContext={windowSource:'provider-reported',modelWindowTokens:258400},history='Known history. '.repeat(10000);
  const{next}=await handoffFixture(t,{history,context,priorContext,reportedWindow:32768});assert.equal(next.status,'completed',next.error);assert.equal(next.modelHandoff.reportedModelWindowTokens,258400);assert.equal(next.nodes.agent.continuity.effectiveWindowTokens,32768);assert.equal(next.nodes.agent.continuity.truncated,true);
});

test('changing models never inherits the previous model confirmed capacity',async t=>{
  const priorContext={windowSource:'provider-reported',modelWindowTokens:258400},history='Different-model history. '.repeat(20000);
  const{next,calls}=await handoffFixture(t,{history,priorContext,nextModel:'another-model'});assert.equal(next.status,'completed',next.error);assert.equal(calls[1].model,'another-model');assert.equal(next.modelHandoff.reportedModelWindowTokens,undefined);assert.equal(next.nodes.agent.continuity.effectiveWindowTokens,128000);assert.equal(next.nodes.agent.continuity.windowSource,'working-budget');
});

test('unconfirmed settings and malformed context metadata cannot become a reported handoff capacity',async t=>{
  for(const priorContext of [{windowSource:'user-configured',modelWindowTokens:258400,effectiveWindowTokens:900000},{windowSource:'provider-reported',modelWindowTokens:'258400'},{windowSource:'provider-reported',modelWindowTokens:0}]){
    const{next}=await handoffFixture(t,{history:'Actual saved message.',priorContext});assert.equal(next.status,'completed',next.error);assert.equal(next.modelHandoff.reportedModelWindowTokens,undefined);assert.equal(next.nodes.agent.continuity.effectiveWindowTokens,128000);assert.equal(next.nodes.agent.continuity.windowSource,'working-budget');
  }
});

test('a native working window is reused when requested context and actual reasoning still match',async t=>{
  const context={preset:'900k'},priorContext={nativeCompaction:true,windowSource:'provider-reported',requestedWindowTokens:900000,modelWindowTokens:828400},history='STABLE_NATIVE_START\n'+'x'.repeat(450000)+'\nSTABLE_NATIVE_END';
  const{first,next}=await handoffFixture(t,{history,context,priorContext,effort:'default',nextEffort:'low',defaultEffort:'low'});
  assert.equal(first.nodes.agent.resolvedEffort,'low');assert.equal(next.status,'completed',next.error);assert.equal(next.modelHandoff.reportedModelWindowTokens,828400);assert.equal(next.nodes.agent.continuity.effectiveWindowTokens,828400);assert.equal(next.nodes.agent.continuity.windowSource,'provider-reported');assert.equal(next.nodes.agent.continuity.truncated,false);
});

test('editing native context or reasoning discards the old working window instead of treating it as a model maximum',async t=>{
  const cases=[
    {context:{preset:'model'},nextContext:{preset:'900k'},effort:'ultra',nextEffort:'ultra',expected:900000,source:'user-configured'},
    {context:{preset:'900k'},nextContext:{preset:'900k'},effort:'ultra',nextEffort:'default',expected:900000,source:'user-configured'},
    {context:{preset:'model'},effort:'ultra',nextEffort:'default',expected:128000,source:'working-budget'},
  ];
  for(const value of cases){
    const priorContext={nativeCompaction:true,windowSource:'provider-reported',modelWindowTokens:475000},history='CHANGED_NATIVE_START\n'+'x'.repeat(400000)+'\nCHANGED_NATIVE_END';
    const{next,calls}=await handoffFixture(t,{history,priorContext,defaultEffort:'low',...value});
    assert.equal(next.status,'completed',next.error);assert.equal(next.modelHandoff.reportedModelWindowTokens,undefined);assert.equal(next.nodes.agent.continuity.effectiveWindowTokens,value.expected);assert.equal(next.nodes.agent.continuity.windowSource,value.source);assert.match(calls[1].prompt,/CHANGED_NATIVE_END/);
  }
});

test('a real catalog capacity still bounds new native context and reasoning settings after an obsolete working window is discarded',async t=>{
  const priorContext={nativeCompaction:true,windowSource:'provider-reported',modelWindowTokens:475000},history='CATALOG_LIMIT_START\n'+'x'.repeat(200000)+'\nCATALOG_LIMIT_END';
  const{next,calls}=await handoffFixture(t,{history,context:{preset:'model'},nextContext:{preset:'900k'},effort:'ultra',nextEffort:'default',defaultEffort:'low',priorContext,reportedWindow:32768});
  assert.equal(next.status,'completed',next.error);assert.equal(next.modelHandoff.reportedModelWindowTokens,undefined);assert.equal(next.nodes.agent.continuity.effectiveWindowTokens,32768);assert.equal(next.nodes.agent.continuity.windowSource,'provider-reported');assert.equal(next.nodes.agent.continuity.truncated,true);assert.ok(estimateContextTokens([[calls[1].developerInstructions,calls[1].prompt],calls[1].dynamicTools])<=next.nodes.agent.continuity.inputBudgetTokens);assert.match(calls[1].prompt,/CATALOG_LIMIT_END/);
});
