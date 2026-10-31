import test from 'node:test';
import assert from 'node:assert/strict';
import {HarnessEngine} from '../lib/engine.mjs';
import {TOKEN_USAGE_FIELDS,emptyTokenUsage,tokenUsageMeasurement} from '../public/token-usage.mjs';

// Exercise the real public snapshot boundary without starting a runtime,
// opening storage, or changing the source engine under review.
function snapshot(agentNodes,{status='completed'}={}){
  const nodes={input:{status:'completed',output:'Fixture request.'},...agentNodes,output:{status:'completed',output:'Fixture result.'}};
  const run={id:'usage-fixture',taskId:'usage-fixture',status,settled:true,input:'Fixture request.',output:'Fixture result.',nodes,workflow:{nodes:[{id:'input',type:'input'},...Object.keys(agentNodes).map(id=>({id,type:'agent'})),{id:'output',type:'output'}],edges:[]},events:[]};
  const before=structuredClone(run);
  const result=HarnessEngine.prototype.snapshot.call({executionStatus:()=>({availableSlots:null}),conversationBusy:()=>false},run);
  assert.deepEqual(run,before,'snapshot projection does not rewrite captured node usage');
  return result;
}
const node=(usage,extra={})=>({status:'completed',output:'Fixture result.',...(usage===undefined?{}:{usage}),...extra});
const numeric={inputTokens:10,outputTokens:3,totalTokens:13,cachedInputTokens:2,reasoningOutputTokens:1};

test('engine snapshots retain unreported usage instead of inventing measured zero',()=>{
  const result=snapshot({agent:node(tokenUsageMeasurement())});
  for(const field of TOKEN_USAGE_FIELDS){
    assert.equal(result.usage[field],null,field+' remains unreported');
    assert.equal(result.usage.availability[field],'unavailable');
  }
  assert.equal(result.usage.samples,1);
  assert.equal(result.status,'completed');
  assert.equal(result.progress.completed,3);
});

test('engine snapshots distinguish an explicitly reported zero from unavailable usage',()=>{
  const zero=tokenUsageMeasurement(Object.fromEntries(TOKEN_USAGE_FIELDS.map(field=>[field,0]))),result=snapshot({agent:node(zero)});
  for(const field of TOKEN_USAGE_FIELDS){
    assert.equal(result.usage[field],0);
    assert.equal(result.usage.availability[field],'reported');
  }
  assert.equal(result.usage.samples,1);
});

test('engine snapshots keep a known subtotal partial when another model response omitted usage',()=>{
  const known=tokenUsageMeasurement(numeric),missing=tokenUsageMeasurement();
  for(const usages of [[known,missing],[missing,known]]){
    const result=snapshot(Object.fromEntries(usages.map((usage,index)=>['agent-'+index,node(usage)])));
    for(const field of TOKEN_USAGE_FIELDS){
      assert.equal(result.usage[field],numeric[field]);
      assert.equal(result.usage.availability[field],'partial');
    }
    assert.equal(result.usage.samples,2);
  }
});

test('engine snapshots preserve multi-response sample counts and already-partial node totals',()=>{
  const partial={...tokenUsageMeasurement(numeric),samples:3,availability:Object.fromEntries(TOKEN_USAGE_FIELDS.map(field=>[field,'partial']))};
  const legacy={inputTokens:7,outputTokens:4,totalTokens:11,cachedInputTokens:0,reasoningOutputTokens:0};
  const result=snapshot({multi:node(partial),legacy:node(legacy)});
  assert.equal(result.usage.samples,4,'samples count model responses rather than workflow nodes');
  assert.equal(result.usage.totalTokens,24);
  assert.equal(result.usage.inputTokens,17);
  assert.equal(result.usage.outputTokens,7);
  for(const field of TOKEN_USAGE_FIELDS)assert.equal(result.usage.availability[field],'partial');
});

test('engine snapshots keep reused usage separate from fresh reported and unreported usage',()=>{
  const known=tokenUsageMeasurement(numeric),missing=tokenUsageMeasurement();
  const freshMissing=snapshot({fresh:node(missing),saved:node(known,{reused:true,reusedFromRunId:'previous-run'})});
  assert.equal(freshMissing.usage.totalTokens,null);
  assert.equal(freshMissing.usage.availability.totalTokens,'unavailable');
  assert.equal(freshMissing.usage.samples,1);
  assert.equal(freshMissing.reusedUsage.totalTokens,13);
  assert.equal(freshMissing.reusedUsage.availability.totalTokens,'reported');
  assert.equal(freshMissing.reusedUsage.samples,1);
  assert.equal(freshMissing.progress.reused,1);
  const reusedMissing=snapshot({fresh:node(known),saved:node(missing,{reused:true,reusedFromRunId:'previous-run'})});
  assert.equal(reusedMissing.usage.totalTokens,13);
  assert.equal(reusedMissing.usage.availability.totalTokens,'reported','unknown reused usage does not contaminate current-run totals');
  assert.equal(reusedMissing.usage.samples,1);
  assert.equal(reusedMissing.reusedUsage.totalTokens,null);
  assert.equal(reusedMissing.reusedUsage.availability.totalTokens,'unavailable');
  assert.equal(reusedMissing.reusedUsage.samples,1);
});

test('runs with no model usage records have no measured total or fabricated response samples',()=>{
  const result=snapshot({notStarted:node(undefined,{status:'skipped'}),empty:node(emptyTokenUsage(),{status:'skipped'})},{status:'failed'});
  assert.equal(result.usage.samples,0);
  assert.equal(result.usage.totalTokens,null);
  assert.equal(result.usage.availability.totalTokens,'unavailable');
  assert.equal(result.reusedUsage.samples,0);
  assert.equal(result.reusedUsage.totalTokens,null);
  assert.equal(result.reusedUsage.availability.totalTokens,'unavailable');
});

test('legacy numeric counters remain additive without billing reused nodes twice',()=>{
  const result=snapshot({first:node(numeric),second:node(numeric),saved:node(numeric,{reused:true})});
  for(const field of TOKEN_USAGE_FIELDS){
    assert.equal(result.usage[field],numeric[field]*2);
    assert.equal(result.reusedUsage[field],numeric[field]);
  }
});
