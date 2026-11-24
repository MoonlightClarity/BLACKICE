import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import os from 'node:os';
import path from 'node:path';

test('benchmark scorer does not silently pool incompatible Directory revisions with identical Engine and fixture hashes',async t=>{
 const folder=await mkdtemp(path.join(os.tmpdir(),'directory-source-fingerprint-'));
 t.after(()=>rm(folder,{recursive:true,force:true}));
 const shared={variant:'candidate',arm:'planning-directory',testId:'event-replay',
   model:'gpt-6-luna',harnessEngineSha256:'a'.repeat(64),
   workspaceToolSha256:'b'.repeat(64),benchmarkFixtureSha256:'c'.repeat(64),
   sourceRoot:'same-location',runStatus:'completed',trialValid:true,
   codingCorrect:true,hiddenGrade:{exitCode:0},toolCalls:[],startedAt:'2026-11-23T07:00:00Z'};
 await writeFile(path.join(folder,'before.json'),JSON.stringify({...shared,sourceManifestSha256:'d'.repeat(64)}));
 await writeFile(path.join(folder,'after.json'),JSON.stringify({...shared,sourceManifestSha256:'e'.repeat(64)}));
 const script=fileURLToPath(new URL('../scripts/score-directory-planning-benchmark.mjs',import.meta.url));
 const p=spawnSync(process.execPath,[script,'--root='+folder,'--model=gpt-6-luna','--case=event-replay'],
   {encoding:'utf8'});
 assert.equal(p.status,0,p.stderr);
 const result=JSON.parse(p.stdout);
 assert.equal(result.groups.length,2,'Pre-fix and post-fix trials must not be in the same score group.');
 assert.equal(result.groups.every(group=>group.arms['planning-directory'].valid===1),true);
 assert.equal(result.groups.every(group=>group.sameSourceFourArmComparisonReady===false),true);
 assert.deepEqual(new Set(result.groups.map(group=>group.source.sourceManifestSha256)),
   new Set(['d'.repeat(64),'e'.repeat(64)]));
});
