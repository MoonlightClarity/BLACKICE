import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ShadowdancerDirectory, runShadowdancerDirectory } from '../lib/shadowdancer-directory.mjs';

async function fixture(task) {
  const cwd=await mkdtemp(path.join(os.tmpdir(),'blackice-directory-budget-'));
  try { return await task(cwd); } finally { await rm(cwd,{recursive:true,force:true}); }
}

test('recursive directory reserves leaf capacity and operational model-call budget',async()=>{
  await fixture(async cwd=>{
    const runtime={runAgent:async()=>({output:JSON.stringify({atomic:false,
      steps:Array.from({length:4},(_,i)=>({objective:'Work package '+(i+1),done_when:'Observable result'}))})})};
    const runner=new ShadowdancerDirectory({cwd,conversationId:'bounded_case',runId:'bounded_case',
      model:'fixture',runtime,canWrite:false,limits:{maxNodes:24,maxCalls:56,maxPlanningCalls:8,maxDepth:4}});
    await runner.open();
    await runner.plan('1','Carry out a broad request and verify completed outcomes');
    assert.ok(runner.work.length>=4,'Preserves executable work');
    assert.ok(runner.work.length<=24,'Never exceeds the leaf budget');
    assert.ok(runner.stats.planningCalls<=8,'Preserves execution calls');
    assert.equal(new Set(runner.work.map(x=>x.id)).size,runner.work.length,'Unique saved leaf IDs');
    const turns=JSON.parse(await readFile(path.join(cwd,'.blackice','directory','bounded_case',
      'conversation','context','turns.json'),'utf8'));
    assert.ok(turns.some(row=>row.label==='decomposition-budget'),'Records bounded decisions');
    assert.ok(turns.filter(row=>row.label==='decompose').length<=8,'No unbounded recursive provider loop');
  });
});

test('directory failure retains audit counts and the actual error',async()=>{
  await fixture(async cwd=>{
    const runtime={runAgent:async()=>{throw Object.assign(new Error('Injected provider failure'),{code:'TEST_PROVIDER_FAILURE'});}};
    await assert.rejects(runShadowdancerDirectory({cwd,conversationId:'failed_case',runId:'failed_case',
      model:'fixture',runtime,canWrite:false,input:'/directory Inspect the exact saved failure'}),
    /Injected provider failure/);
    const directory=path.join(cwd,'.blackice','directory','failed_case','conversation','context');
    const summary=JSON.parse(await readFile(path.join(directory,'summary.json'),'utf8'));
    const turns=JSON.parse(await readFile(path.join(directory,'turns.json'),'utf8'));
    assert.equal(summary.directoryStatus,'failed');
    assert.equal(summary.failure.code,'TEST_PROVIDER_FAILURE');
    assert.equal(summary.totalTurns,turns.length);
    assert.ok(summary.totalTurns>=2);
  });
});
