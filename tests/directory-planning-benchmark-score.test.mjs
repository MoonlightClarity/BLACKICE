import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';

const script=fileURLToPath(new URL('../scripts/score-directory-planning-benchmark.mjs',import.meta.url));
const source={
 variant:'candidate',testId:'event-replay',model:'gpt-6-luna',sourceRoot:'same-frozen-source',
 harnessEngineSha256:'a'.repeat(64),workspaceToolSha256:'b'.repeat(64),
 benchmarkFixtureSha256:'c'.repeat(64),toolCalls:[{name:'relay_workspace'}],
 startedAt:'2026-11-23T11:00:00Z',
};
test('scorer separates planning+directory, ablations, complete results and infrastructure-invalid attempts',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'blackice-planning-directory-score-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const row=async(name,value)=>writeFile(path.join(root,name+'.json'),JSON.stringify({...source,...value}));
 await row('planning-directory',{arm:'planning-directory',trialValid:true,runStatus:'failed',workflowCompleted:false,
   codingCorrect:true,hiddenGrade:{exitCode:0},directoryIncomplete:true});
 await row('planning-only',{arm:'planning-only',trialValid:true,runStatus:'completed',workflowCompleted:true,
   codingCorrect:true,hiddenGrade:{exitCode:0},planningStages:['builtin-decomposition']});
 await row('directory-only',{arm:'directory-only',trialValid:true,runStatus:'completed',
   codingCorrect:false,hiddenGrade:{exitCode:1}});
 await row('neither-invalid',{arm:'neither',trialValid:false,runStatus:'failed',
   codingCorrect:false,hiddenGrade:{exitCode:1},infraError:'PROVIDER_TIMEOUT'});
 const result=spawnSync(process.execPath,[script,'--root='+root,'--case=event-replay','--model=gpt-6-luna'],{encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);
 const summary=JSON.parse(result.stdout);
 assert.equal(summary.groups.length,1);
 const group=summary.groups[0];
 assert.equal(group.sameSourceFourArmComparisonReady,false);
 assert.equal(group.arms['planning-directory'].codeOnlyPasses,1);
 assert.equal(group.arms['planning-directory'].fullSuccesses,0,
   'Passing hidden code checks does not convert a failed workflow into an end-to-end success.');
 assert.equal(group.arms['planning-only'].fullSuccesses,1);
 assert.equal(group.arms['directory-only'].fullSuccesses,0);
 assert.equal(group.arms.neither.valid,0);
 assert.equal(group.arms.neither.invalid.length,1);
 assert.match(group.claim,/Incomplete arm coverage/);
});
test('unknown benchmark arm fails fast instead of silently testing the wrong mode',()=>{
 const scriptPath=fileURLToPath(new URL('../scripts/benchmark-directory-live.mjs',import.meta.url));
 const out=spawnSync(process.execPath,[scriptPath,'--arm=old-planning-on'],{cwd:path.dirname(scriptPath),encoding:'utf8',timeout:10000});
 assert.notEqual(out.status,0);
 assert.match(out.stderr,/Choose planning-directory/);
});
