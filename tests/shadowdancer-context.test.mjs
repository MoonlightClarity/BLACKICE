import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {ShadowdancerDirectory} from '../lib/shadowdancer-directory.mjs';
import {listShadowdancerContext,readShadowdancerFile,editShadowdancerContext,contextAuditHistory} from '../lib/shadowdancer-context.mjs';

const note=(code)=>({summary:'Observed '+code,items:[{value:code,quote:'The marker code is '+code+'.'}]});
const integrated={answer:'ALPHA17 and BETA29',used_refs:['page:1','page:2']};

async function fixture(t){
  const cwd=await mkdtemp(path.join(os.tmpdir(),'blackice-context-audit-'));
  t.after(()=>rm(cwd,{recursive:true,force:true}));

  const conversationId='conversation-01',runId='run-01',root=path.join(cwd,'.blackice','directory',conversationId);
  const put=async(file,value)=>{const target=path.join(root,file);await mkdir(path.dirname(target),{recursive:true});await writeFile(target,JSON.stringify(value));};
  await put('conversation/context/summary.json',{conversationId,currentRun:runId,lastAnswer:'ALPHA17 and BETA29',totalTurns:8});
  const turns=Array.from({length:8},(_,i)=>({id:'turn-'+i,runId,label:i===7?'final':'source',excerpt:'Saved fixture'}));
  await put('conversation/context/turns.json',turns);
  for(const turn of turns)await put('runs/run-01/turns/'+turn.id+'.json',turn);
  for(const [page,code]of [['0001','ALPHA17'],['0002','BETA29']]){
   const content='The marker code is '+code+'.';
   await put('runs/run-01/sources/page-'+page+'/source.json',{content,sourceSha256:'original-'+page});
   await put('runs/run-01/sources/page-'+page+'/result.json',{...note(code),anchoredItems:[code]});
  }
  const finalPath=path.join(root,'runs/run-01/integration/final.json');await put('runs/run-01/integration/final.json',integrated);
  return {cwd,conversationId,runId,done:{finalPath},runtime:{calls:[]},ctx:(extra={})=>({cwd,conversationId,...extra})};
}

test('audit list shows provenance, field edits and replaceable generated context',async t=>{
  const f=await fixture(t);
  const list=await listShadowdancerContext(f.ctx());
  assert.equal(list.summary.lastAnswer,'ALPHA17 and BETA29');
  assert.ok(list.files.some(x=>x.file==='conversation/context/summary.json'&&x.editableFields.includes('userSummary')));
  assert.ok(list.files.some(x=>x.file==='runs/run-01/sources/page-0002/result.json'&&x.editableFields.includes('items')));
  assert.ok(list.files.some(x=>x.file==='runs/run-01/integration/final.json'&&x.replaceable&&x.deletable));
  assert.ok(list.files.some(x=>x.file.startsWith('runs/run-01/turns/')&&!x.editableFields.length));
  const before=await readShadowdancerFile(f.ctx({file:'conversation/context/summary.json'}));
  assert.equal(before.value.totalTurns,8); // Request, two page exchanges, integration exchange, final.
});

test('summary user notes edit persists revision snapshots and stales historic answer',async t=>{
  const f=await fixture(t);
  const file='conversation/context/summary.json';
  const old=await readShadowdancerFile(f.ctx({file}));
  const saved=await editShadowdancerContext(f.ctx({file,expectedHash:old.hash,
    changes:{userSummary:'Two marker codes are present',pinnedConstraints:['Include every distinct code']},
    reason:'Add explicit user-reviewed coverage context'}));
  assert.equal(saved.updated,true);assert.ok(saved.invalidatedRuns.includes(f.runId));
  const updated=await readShadowdancerFile(f.ctx({file}));
  assert.equal(updated.value.userSummary,'Two marker codes are present');
  assert.deepEqual(updated.value.pinnedConstraints,['Include every distinct code']);
  const history=await contextAuditHistory(f.ctx());
  assert.equal(history.total,1);
  assert.equal(history.items[0].beforeHash,old.hash);
  assert.equal(history.items[0].afterHash,saved.hash);
  const revisionRoot=path.join(f.cwd,'.blackice','directory',f.conversationId,'conversation','context','revisions',saved.editId);
  const snapshot=JSON.parse(await readFile(path.join(revisionRoot,'before.json'),'utf8'));
  assert.deepEqual(snapshot,old.value);
  const original=JSON.parse(await readFile(f.done.finalPath,'utf8'));
  assert.equal(original.answer,'ALPHA17 and BETA29','historical final must remain untouched');
  const overview=await listShadowdancerContext(f.ctx());
  assert.equal(overview.invalidation.staleRuns[f.runId].state,'stale');
  assert.equal(overview.invalidation.staleRuns[f.runId].editId,saved.editId);
  assert.equal(f.runtime.calls.length,0,'saved-record editing never starts provider calls');
});

test('optimistic hash rejects stale edits and concurrent lost updates',async t=>{
  const f=await fixture(t);const file='conversation/context/summary.json';
  const old=await readShadowdancerFile(f.ctx({file}));
  const changes={userSummary:'First edit'};
  const first=await editShadowdancerContext(f.ctx({file,expectedHash:old.hash,changes,reason:'First'}));
  assert.equal(first.updated,true);
  await assert.rejects(editShadowdancerContext(f.ctx({file,expectedHash:old.hash,changes:{userSummary:'Overwrite'},reason:'Old version'})),{code:'SHADOWDANCER_REVISION_CONFLICT',status:409});
  const current=await readShadowdancerFile(f.ctx({file}));
  const outcomes=await Promise.allSettled([
    editShadowdancerContext(f.ctx({file,expectedHash:current.hash,changes:{userSummary:'A'},reason:'Write A'})),
    editShadowdancerContext(f.ctx({file,expectedHash:current.hash,changes:{userSummary:'B'},reason:'Write B'}))
  ]);
  assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);
  assert.equal(outcomes.filter(x=>x.status==='rejected'&&x.reason.code==='SHADOWDANCER_REVISION_CONFLICT').length,1);
  assert.equal((await contextAuditHistory(f.ctx())).total,2);
});

test('source corrections recalculate digest and preserve extracted output as stale history',async t=>{
  const f=await fixture(t);
  const file='runs/run-01/sources/page-0002/source.json';
  const old=await readShadowdancerFile(f.ctx({file}));
  const corrected=old.value.content.replace('BETA29','BETA30');
  const saved=await editShadowdancerContext(f.ctx({file,expectedHash:old.hash,changes:{content:corrected},reason:'Correct the source transcription'}));
  const revised=await readShadowdancerFile(f.ctx({file}));
  assert.match(revised.value.content,/BETA30/);
  assert.notEqual(old.value.sourceSha256,revised.value.sourceSha256);
  assert.deepEqual(saved.invalidatedRuns,['run-01']);
  const historical=await readShadowdancerFile(f.ctx({file:'runs/run-01/sources/page-0002/result.json'}));
  assert.equal(historical.value.anchoredItems[0],'BETA29');
  const stale=(await listShadowdancerContext(f.ctx())).invalidation.staleRuns['run-01'];
  assert.equal(stale.sourceFile,file);
});

test('generated context requires full replacement and typed page edits remain source-anchored',async t=>{
  const f=await fixture(t);
  const final='runs/run-01/integration/final.json';
  const existing=await readShadowdancerFile(f.ctx({file:final}));
  await assert.rejects(editShadowdancerContext(f.ctx({file:final,expectedHash:existing.hash,changes:{answer:'fabricated'},reason:'Attempt'})),{code:'SHADOWDANCER_EDIT_FIELDS'});
  const page='runs/run-01/sources/page-0002/result.json';
  const current=await readShadowdancerFile(f.ctx({file:page}));
  await assert.rejects(editShadowdancerContext(f.ctx({file:page,expectedHash:current.hash,changes:{items:[{value:'FAKE99',quote:'Invented'}]},reason:'Unsupported edit'})),{code:'SHADOWDANCER_SOURCE_SUPPORT'});
  await assert.rejects(readShadowdancerFile(f.ctx({file:'../private.json'})),{code:'SHADOWDANCER_PATH'});
  const history=await contextAuditHistory(f.ctx());
  assert.equal(history.total,0);
});

test('editing is blocked if the original run is active',async t=>{
  const f=await fixture(t);
  const file='conversation/context/summary.json',read=await readShadowdancerFile(f.ctx({file}));
  await assert.rejects(editShadowdancerContext(f.ctx({file,expectedHash:read.hash,changes:{userSummary:'something'},reason:'Edit during run',isActive:()=>true})),{code:'SHADOWDANCER_RUN_ACTIVE',status:409});
});


test('user-edited saved context cannot reenter retired execution',async t=>{
 const f=await fixture(t),file='conversation/context/summary.json',prior=await readShadowdancerFile(f.ctx({file}));
 await editShadowdancerContext(f.ctx({file,expectedHash:prior.hash,changes:{userSummary:'Owner correction'},reason:'Fixture'}));
 assert.throws(()=>new ShadowdancerDirectory({cwd:f.cwd,conversationId:f.conversationId,runtime:{runAgent(){assert.fail('No provider');}}}),{code:'DIRECTORY_RETIRED'});
 assert.equal((await readShadowdancerFile(f.ctx({file}))).value.userSummary,'Owner correction');
});
