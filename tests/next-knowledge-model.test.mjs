import test from 'node:test';
import assert from 'node:assert/strict';
import {KNOWLEDGE_PAGE_SIZE,knowledgeListPath,knowledgeWindow,knowledgeDraft,knowledgeDraftChanged,
  knowledgeSavePayload,knowledgeExpectedRevision,knowledgeHistoryRows,knowledgeRestorePayload,knowledgeRecoveryPayload,
  knowledgeAuthor} from '../public/next/workspaces/knowledge-model.mjs';

const memory=()=>({id:'knowledge-memory',kind:'memory',title:'Keep this',summary:'Saved summary',content:'Full content\n'.repeat(200),
  cwd:'C:\\project',revision:7,memoryType:'decision',sources:['local source <untrusted>'],
  relations:[{type:'informs',targetId:'deleted-target'}],provenance:{source:'user'}});

test('list requests ask for metadata only, use actual backend filters, and bound visible rows',()=>{
  const url=new URL(knowledgeListPath({kind:'memory',query:' a & b ',memoryType:'decision',cwd:' C:\\project ',deletedOnly:true}),'http://local');
  assert.equal(url.pathname,'/api/knowledge');assert.equal(url.searchParams.get('limit'),'300');
  assert.equal(url.searchParams.get('query'),'a & b');assert.equal(url.searchParams.get('memoryType'),'decision');
  assert.equal(url.searchParams.get('cwd'),'C:\\project');assert.equal(url.searchParams.get('deletedOnly'),'true');
  assert.equal(url.searchParams.has('includeGlobal'),false);
  assert.equal(new URL(knowledgeListPath({kind:'skill',memoryType:'fact'}),'http://local').searchParams.has('memoryType'),false);
  const values=Array.from({length:400},(_,id)=>({id}));
  assert.equal(knowledgeWindow(values).items.length,KNOWLEDGE_PAGE_SIZE);
  assert.equal(knowledgeWindow(values,160).items.length,160);assert.equal(knowledgeWindow(values).hasMore,true);
  assert.equal(knowledgeWindow(values,10000).items.length,300);assert.equal(knowledgeWindow(values,10000).hasMore,false);
});

test('an editable draft retains full content, stale revision and unavailable relationship metadata',()=>{
  const entry=memory(),draft=knowledgeDraft(entry);
  assert.equal(draft.values.content,entry.content);assert.equal(knowledgeDraftChanged(draft),false);
  draft.values.content+='Another paragraph';draft.values.cwd='';
  const payload=knowledgeSavePayload(draft);
  assert.equal(knowledgeDraftChanged(draft),true);assert.equal(payload.expectedRevision,7);assert.equal(payload.cwd,null);
  assert.deepEqual(payload.sources,entry.sources);assert.deepEqual(payload.relations,entry.relations);
  payload.relations[0].targetId='different';assert.equal(draft.entry.relations[0].targetId,'deleted-target');
  assert.equal(entry.content.endsWith('Another paragraph'),false);
  // A refresh of metadata cannot silently alter the revision attached to this draft.
  const refreshedMetadata={id:entry.id,revision:8};assert.notEqual(refreshedMetadata.revision,payload.expectedRevision);
  assert.equal(knowledgeSavePayload(draft).expectedRevision,7);
});

test('new skills have explicit creation payloads and use the skill content limit',()=>{
  const draft=knowledgeDraft(null,'skill');draft.values.title=' Skill ';draft.values.content='a'.repeat(40000);
  assert.equal(knowledgeSavePayload(draft).content.length,40000);
  assert.equal(knowledgeSavePayload(draft).title,'Skill');assert.equal('expectedRevision' in knowledgeSavePayload(draft),false);
  assert.equal('memoryType' in knowledgeSavePayload(draft),false);
  draft.values.content+='a';assert.throws(()=>knowledgeSavePayload(draft),/40,000/);
  const blank=knowledgeDraft();assert.throws(()=>knowledgeSavePayload(blank),/title/);
  blank.values.title='Memory';assert.throws(()=>knowledgeSavePayload(blank),/content/);
  blank.values.content='a'.repeat(8001);assert.throws(()=>knowledgeSavePayload(blank),/8,000/);
});

test('deleted entries and unreadable revisions cannot be implicitly saved or mutated',()=>{
  assert.throws(()=>knowledgeSavePayload(knowledgeDraft({...memory(),deleted:true})),/Restore/);
  for(const revision of [null,0,-1,1.5,'2'])assert.throws(()=>knowledgeExpectedRevision({revision}),/Reload/);
  assert.equal(knowledgeExpectedRevision(memory()),7);
});

test('history inspection is bounded and restore uses the history current revision',()=>{
  const history={currentRevision:12,history:Array.from({length:12},(_,i)=>({...memory(),revision:12-i,deleted:i===1}))};
  assert.equal(knowledgeHistoryRows(history).length,9);
  assert.deepEqual(knowledgeRestorePayload(history,11),{revision:11,expectedRevision:12});
  assert.equal(knowledgeHistoryRows(history)[1].deleted,true);
  assert.throws(()=>knowledgeRestorePayload(history,1),/retained revision/);
  assert.throws(()=>knowledgeRestorePayload({history:history.history},11),/Refresh history/);
  assert.equal(knowledgeHistoryRows({history:[{revision:0},{revision:2},null]}).length,1);
});

test('provenance distinguishes explicit user work, background learning and other agent work',()=>{
  assert.equal(knowledgeAuthor(memory()),'You');
  assert.equal(knowledgeAuthor({provenance:{source:'agent',nodeId:'learning-123'}}),'Learned');
  assert.equal(knowledgeAuthor({provenance:{source:'agent',nodeId:'task-123'}}),'Agent');
});

test('Trash recovery chooses the newest retained active revision and guards the current deleted revision',()=>{
  const history={currentRevision:12,deleted:true,history:[{...memory(),revision:12,deleted:true},{...memory(),revision:11,deleted:true},
    {...memory(),revision:9},{...memory(),revision:10,deleted:false},{...memory(),revision:8}]};
  assert.deepEqual(knowledgeRecoveryPayload(history),{revision:10,expectedRevision:12});
  assert.throws(()=>knowledgeRecoveryPayload({currentRevision:12,history:[{revision:12},{revision:11}]}),/already active/);
  assert.throws(()=>knowledgeRecoveryPayload({currentRevision:12,history:[{revision:12,deleted:true},{revision:11,deleted:true}]}),/No active revision/);
  assert.throws(()=>knowledgeRecoveryPayload({history:history.history}),/Refresh history/);
  assert.equal(history.history[0].deleted,true,'Projection cannot change saved or displayed metadata.');
});
