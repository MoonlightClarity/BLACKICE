import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {prepare,score} from '../scripts/representation-eval.mjs';

async function workspace(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'blackice-representation-eval-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));return path.join(dir,'fixture');}
async function writeObservations(root){for(const variant of ['baseline','candidate'])for(const [id,decision] of [['transferable','submit'],['positioning','submit'],['artifact-depth','submit'],['inference','submit'],['ordinary-agreement','submit'],['firm-constraint','hold'],['required-negative','submit'],['genuinely-unknown','hold']]){const dir=path.join(root,variant,id);const response=id==='positioning'?{primary:'community-energy policy',adjacent:'business analysis',artifact:'speaker-bio.txt',rationale:'A reason for human review.'}:id==='artifact-depth'?{artifact:'technical-record.txt',rationale:'A reason for human review.'}:'A response for human review.';await fs.writeFile(path.join(dir,'decision.json'),JSON.stringify({decision,response,reason:'A reason for human review.'}));await fs.writeFile(path.join(dir,'run.json'),JSON.stringify({runId:variant+'-'+id,model:'gpt-6-luna',effort:'max',planningMode:'on',sourceFingerprint:variant+'-fingerprint',status:'completed',settled:true,startedAt:'2026-10-28T00:00:00.000Z',finishedAt:'2026-10-28T00:00:20.000Z'}));}}

test('prepares separate matched local cases without invoking a model or overwriting an existing fixture',async t=>{
 const root=await workspace(t),result=await prepare(root);assert.equal(result.modelStarted,false);assert.equal(result.cases.length,8);assert.deepEqual(result.variants,['baseline','candidate']);
 for(const id of result.cases){const b=path.join(root,'baseline',id),c=path.join(root,'candidate',id);for(const name of await fs.readdir(b))assert.deepEqual(await fs.readFile(path.join(b,name)),await fs.readFile(path.join(c,name)));}
 await assert.rejects(prepare(root),{code:'EEXIST'});
});
test('objective checks preserve provenance and require semantic review rather than claiming behavior',async t=>{
 const root=await workspace(t);await prepare(root);await writeObservations(root);const result=await score(root);
 assert.equal(result.status,'semantic_review_needed');assert.equal(result.behavioralResult,'not_determined');assert.equal(result.entries.length,16);
 assert.ok(result.entries.every(x=>x.objective.status==='pass'&&x.semantic.status==='review_needed'&&x.elapsedMs===20000));
 assert.ok(result.entries.every(x=>x.provenance.trust==='supplied; independently verify against saved run'));
 assert.ok(result.pairs.every(x=>x.status==='matched_conditions_supplied'));
});
test('detects a background-as-target mistake and checks artifact fit in both directions',async t=>{
 const root=await workspace(t);await prepare(root);await writeObservations(root);
 const wrongDirection=path.join(root,'candidate','positioning','decision.json');
 await fs.writeFile(wrongDirection,JSON.stringify({decision:'submit',response:{primary:'management consulting',adjacent:'business analysis',artifact:'full-record.txt'},reason:'Incorrectly prioritized the historical field.'}));
 const wrongDepth=path.join(root,'candidate','artifact-depth','decision.json');
 await fs.writeFile(wrongDepth,JSON.stringify({decision:'submit',response:{artifact:'overview.txt'},reason:'Incorrectly used a summary despite the requested evidence.'}));
 const result=await score(root);const position=result.entries.find(x=>x.variant==='candidate'&&x.case==='positioning');const depth=result.entries.find(x=>x.variant==='candidate'&&x.case==='artifact-depth');
 assert.equal(position.objective.status,'fail');assert.ok(position.objective.issues.some(x=>x.includes('response.primary')));assert.ok(position.objective.issues.some(x=>x.includes('response.artifact')));
 assert.equal(depth.objective.status,'fail');assert.ok(depth.objective.issues.some(x=>x.includes('response.artifact')));
 assert.equal(position.semantic.status,'review_needed');assert.equal(depth.semantic.status,'review_needed');
});
test('does not present mismatched model or effort as a matched comparison',async t=>{
 const root=await workspace(t);await prepare(root);await writeObservations(root);const file=path.join(root,'candidate','inference','run.json'),value=JSON.parse(await fs.readFile(file,'utf8'));value.effort='low';await fs.writeFile(file,JSON.stringify(value));
 const result=await score(root);assert.equal(result.pairs.find(x=>x.case==='inference').status,'not_comparable');assert.equal(result.behavioralResult,'not_determined');
});
test('rejects changed fixtures, unsettled provenance, wrong decisions, and missing output',async t=>{
 const root=await workspace(t);await prepare(root);await writeObservations(root);
 await fs.chmod(path.join(root,'baseline','inference','record.txt'),0o644);await fs.writeFile(path.join(root,'baseline','inference','record.txt'),'changed');
 await fs.writeFile(path.join(root,'candidate','firm-constraint','decision.json'),JSON.stringify({decision:'submit',response:'go',reason:'wrong'}));
 await fs.writeFile(path.join(root,'candidate','transferable','run.json'),JSON.stringify({runId:'id',status:'running',settled:false}));
 await fs.rm(path.join(root,'baseline','genuinely-unknown','decision.json'));
 const result=await score(root);assert.equal(result.status,'objective_failed');
 for(const [variant,id] of [['baseline','inference'],['candidate','firm-constraint'],['candidate','transferable'],['baseline','genuinely-unknown']])assert.equal(result.entries.find(x=>x.variant===variant&&x.case===id).objective.status,'fail');
});
