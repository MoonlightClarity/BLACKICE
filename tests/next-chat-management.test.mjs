import test from 'node:test';
import assert from 'node:assert/strict';
import {conversationManagementTarget,resolveConversationSelection,conversationActionState,conversationIndexWindow,filterSummaries} from '../public/next/chat/model.mjs';

const target=(id,state='active',extra={})=>conversationManagementTarget({id:'turn-'+id,rootId:id,runId:'latest-'+id,state,title:'Chat '+id,status:'completed',settled:true,...extra});
const selected=(...items)=>new Map(items.map(item=>[item.id,{runId:item.runId,state:item.state}]));
test('lifecycle target uses the family root and exact latest turn, retaining source records',()=>{
  const source={id:'old',taskId:'root',latestRunId:'latest',title:'Literal <title>',state:'archived',status:'completed'};
  assert.deepEqual(conversationManagementTarget(source),{id:'root',runId:'latest',title:'Literal <title>',state:'archived',working:false});
  assert.equal(source.id,'old');assert.equal(conversationActionState('delete'),'deleted');assert.equal(conversationActionState('restore'),'active');assert.equal(conversationActionState('archive'),'archived');assert.equal(conversationActionState('purge'),null);
});
test('archive and reversible Trash allow only the matching lifecycle state',()=>{
  const active=target('a'),archived=target('b','archived'),deleted=target('c','deleted'),lookup=id=>[active,archived,deleted].find(item=>item.id===id);
  assert.deepEqual(resolveConversationSelection(selected(active),lookup,'archive'),[active]);
  assert.deepEqual(resolveConversationSelection(selected(active,archived),lookup,'delete'),[active,archived]);
  assert.deepEqual(resolveConversationSelection(selected(archived,deleted),lookup,'restore'),[archived,deleted]);
  assert.throws(()=>resolveConversationSelection(selected(archived),lookup,'archive'),/Only active/);
  assert.throws(()=>resolveConversationSelection(selected(active),lookup,'restore'),/already active/);
  assert.throws(()=>resolveConversationSelection(selected(deleted),lookup,'delete'),/already in Trash/);
});
test('working, queued, waiting and unsettled families cannot enter Trash, but can be archived',()=>{
  for(const extra of [{status:'running'},{status:'queued'},{status:'waiting'},{status:'completed',settled:false}]){
    const item=target('live','active',extra);
    assert.throws(()=>resolveConversationSelection(selected(item),()=>item,'delete'),/Stop working chats/);
    assert.equal(resolveConversationSelection(selected(item),()=>item,'archive').length,1);
  }
  const family=conversationManagementTarget({id:'final',rootId:'family',runId:'final',status:'completed',settled:true},'active',[{id:'older',status:'running'}]);
  assert.equal(family.working,true,'a running family member matters even if the latest summary is settled');
});
test('stale, missing or moved targets reject the entire operation before any targets are returned',()=>{
  const a=target('a'),b=target('b'),snapshot=selected(a,b),original=JSON.stringify([...snapshot]);
  for(const changed of [null,{...b,runId:'new-turn'},{...b,state:'archived'}])assert.throws(()=>resolveConversationSelection(snapshot,id=>id==='a'?a:changed,'archive'),/selected chat changed/);
  assert.equal(JSON.stringify([...snapshot]),original,'validation must never mutate the person’s selection');
  assert.throws(()=>resolveConversationSelection(new Map(),()=>a,'archive'),/Select at least/);
  assert.throws(()=>resolveConversationSelection(snapshot,()=>a,'purge'),/Choose Archive/);
  const unknown=target('unknown','unknown');assert.throws(()=>resolveConversationSelection(selected(unknown),()=>unknown,'restore'),/saved state is unavailable/);
});
test('select-visible candidates stay bounded while search and pinned deep selection retain the complete catalog',()=>{
  const items=Array.from({length:20000},(_,i)=>({id:'r'+i,title:i===19999?'Deep needle':'Chat '+i}));
  const window=conversationIndexWindow(items,80,'r19999'),visible=[window.pinned,...window.shown];
  assert.equal(visible.length,81);assert.equal(new Set(visible.map(item=>item.id)).size,81);assert.equal(window.hidden,19920);
  assert.equal(filterSummaries(items,'needle')[0].id,'r19999');assert.equal(items.length,20000);
});
