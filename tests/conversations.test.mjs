import test from 'node:test';import assert from 'node:assert/strict';import{EventEmitter}from'node:events';import{mkdtemp,rm,readFile,writeFile,readdir}from'node:fs/promises';import{promises as filesystem}from'node:fs';import{tmpdir}from'node:os';import path from'node:path';import{ConversationArchive}from'../lib/conversations.mjs';import{createMissionWorkflow}from'../public/mission-model.mjs';
const turn=(id,parentRunId=null)=>({id,taskId:'turn-0',parentRunId,createdAt:new Date(1700000000000+Number(id.split('-')[1])*1000).toISOString(),input:`Message ${id}`,workflow:createMissionWorkflow({id:'chat',task:'Hello'}),status:'completed',settled:true,nodes:{agent:{status:'completed',threadId:'real-thread',output:`Reply ${id}`}},output:`Reply ${id}`,events:[]});
class Engine extends EventEmitter{runs=new Map();listRuns(){return[...this.runs.values()];}getRun(id){if(!this.runs.has(id))throw Error('Run not found.');return structuredClone(this.runs.get(id));}}

test('conversation summaries retain live stopping leases and Trash waits for acknowledgement',async t=>{
 const dataDir=await mkdtemp(path.join(tmpdir(),'blackice-conversation-settlement-')),engine=new Engine(),archives=[];
 t.after(async()=>{for(const archive of archives)await archive.close();await rm(dataDir,{recursive:true,force:true});});
 const archive=await new ConversationArchive({dataDir,engine}).init();archives.push(archive);
 const run=turn('turn-0');run.status='cancelled';run.settled=false;run.nodes.agent.status='cancelled';engine.runs.set(run.id,run);await archive.capture(run);
 assert.equal(archive.list()[0].settled,false);assert.equal((await archive.get(run.id)).settled,false);
 await assert.rejects(archive.setState(run.id,'deleted'),error=>error.status===409&&/finish stopping/.test(error.message));
 assert.equal(archive.list('deleted').length,0);
 run.settled=true;await archive.capture(run);assert.equal(archive.list()[0].settled,true);await archive.close();
 const restored=await new ConversationArchive({dataDir,engine:new Engine()}).init();archives.push(restored);
 assert.equal(restored.list()[0].status,'cancelled');assert.equal(restored.list()[0].settled,true);
 await restored.setState(run.id,'deleted');assert.equal(restored.list('deleted')[0].settled,true);
});

test('an unowned unfinished cancellation recovers after restart without changing its recorded bytes or work',async t=>{
 const dataDir=await mkdtemp(path.join(tmpdir(),'blackice-conversation-restart-stop-')),engine=new Engine(),archives=[];
 t.after(async()=>{for(const archive of archives)await archive.close();await rm(dataDir,{recursive:true,force:true});});
 const archive=await new ConversationArchive({dataDir,engine}).init();archives.push(archive);
 const run=turn('turn-0');run.status='cancelled';run.settled=false;run.error='Recorded provider interruption';run.nodes.agent.status='cancelled';run.nodes.agent.output='Actual partial work';engine.runs.set(run.id,run);await archive.capture(run);await archive.close();
 const file=path.join(dataDir,'conversations',run.id+'.json'),before=await readFile(file);
 const restored=await new ConversationArchive({dataDir,engine:new Engine()}).init();archives.push(restored);
 assert.equal(restored.list()[0].status,'failed');assert.equal(restored.list()[0].settled,true);
 const recovered=await restored.get(run.id);assert.equal(recovered.status,'failed');assert.equal(recovered.settled,true);
 assert.match(recovered.error,/Recorded provider interruption/);assert.match(recovered.error,/restarted.*finished stopping/);
 assert.equal(recovered.nodes.agent.output,'Actual partial work');assert.equal(recovered.nodes.agent.threadId,'real-thread');
 assert.deepEqual(await readFile(file),before,'recovery must preserve the original unfinished receipt');
});

test('conversation survives recent-run eviction, restart, and continuation from an archived parent',async t=>{
 const dataDir=await mkdtemp(path.join(tmpdir(),'relay-conversations-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));const engine=new Engine(),archive=await new ConversationArchive({dataDir,engine}).init();
 for(let i=0;i<105;i++){const run=turn(`turn-${i}`,i?`turn-${i-1}`:null);engine.runs.set(run.id,run);if(engine.runs.size>100)engine.runs.delete(engine.runs.keys().next().value);await archive.capture(run);}
 assert.equal(engine.runs.size,100);assert.equal((await archive.family('turn-104')).runs.length,105);assert.equal((await archive.get('turn-0')).nodes.agent.threadId,'real-thread');await archive.close();
 const restoredEngine=new Engine(),restored=await new ConversationArchive({dataDir,engine:restoredEngine}).init();const family=await restored.family('turn-104');assert.equal(family.runs.length,105);assert.equal(family.runs[0].output,'Reply turn-0');assert.equal(family.truncated,false);const next=turn('turn-105','turn-104');restoredEngine.runs.set(next.id,next);await restored.capture(next);assert.equal((await restored.family(next.id)).runs.length,106);await restored.close();
});
test('archived interrupted turn is readable and resumable without reporting unfinished work completed',async t=>{
 const dataDir=await mkdtemp(path.join(tmpdir(),'relay-conversation-stop-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));const engine=new Engine(),archive=await new ConversationArchive({dataDir,engine}).init(),run=turn('turn-0');run.status='running';run.nodes.agent.status='running';run.nodes.agent.output='Actual partial response';await archive.capture(run);await archive.close();const restored=await new ConversationArchive({dataDir,engine:new Engine()}).init(),read=await restored.get(run.id);assert.equal(read.status,'failed');assert.equal(read.nodes.agent.status,'cancelled');assert.equal(read.nodes.agent.output,'Actual partial response');assert.equal(read.nodes.agent.threadId,'real-thread');await assert.rejects(restored.get('../anything'),/not found/i);await restored.close();
});

test('Archive, Trash and Restore apply to the whole family and survive restart plus late snapshots',async t=>{
 const dataDir=await mkdtemp(path.join(tmpdir(),'relay-conversation-states-')),archives=[];t.after(async()=>{for(const archive of archives)await archive.close();assert.match(path.basename(dataDir),/^relay-conversation-states-/);await rm(dataDir,{recursive:true,force:true});});
 const engine=new Engine(),archive=await new ConversationArchive({dataDir,engine}).init();archives.push(archive);
 const first=turn('turn-0'),second=turn('turn-1',first.id);engine.runs.set(first.id,first);engine.runs.set(second.id,second);await archive.capture(first);await archive.capture(second);const original=await archive.get(first.id);
 assert.equal(archive.list().length,1);await archive.setState(second.id,'archived');assert.equal(archive.list().length,0);assert.equal(archive.list('archived')[0].taskId,first.taskId);assert.equal((await archive.family(first.id)).state,'archived');
 const late=turn('turn-2',second.id);engine.runs.set(late.id,late);await archive.capture(late);assert.equal(archive.list().length,0,'a late/new family snapshot must not reactivate an archived chat');assert.equal(archive.list('archived')[0].latestRunId,late.id);
 await archive.setState(first.id,'deleted');assert.equal(archive.list('archived').length,0);assert.equal(archive.list('deleted').length,1);assert.equal((await archive.family(late.id)).runs.length,3);assert.deepEqual(await archive.get(first.id),original,'state changes preserve the original run and its saved thread');await archive.close();
 const restored=await new ConversationArchive({dataDir,engine:new Engine()}).init();archives.push(restored);assert.equal(restored.list().length,0);assert.equal(restored.list('deleted').length,1);assert.equal((await restored.family(second.id)).state,'deleted');
 await restored.setState(late.id,'active');assert.equal(restored.list().length,1);assert.equal(restored.list('deleted').length,0);assert.deepEqual((await restored.family(second.id)).runs.map(run=>run.id),[first.id,second.id,late.id]);await restored.close();
 const again=await new ConversationArchive({dataDir,engine:new Engine()}).init();archives.push(again);assert.equal(again.list()[0].state,'active');assert.equal((await again.get(first.id)).nodes.agent.threadId,'real-thread');
});

test('Trash refuses an active family even when invoked through a completed older turn',async t=>{
 const dataDir=await mkdtemp(path.join(tmpdir(),'relay-conversation-active-'));const engine=new Engine(),archive=await new ConversationArchive({dataDir,engine}).init();t.after(async()=>{await archive.close();assert.match(path.basename(dataDir),/^relay-conversation-active-/);await rm(dataDir,{recursive:true,force:true});});
 const first=turn('turn-0'),second=turn('turn-1',first.id);second.status='running';second.settled=false;second.nodes.agent.status='running';engine.runs.set(first.id,first);engine.runs.set(second.id,second);await archive.capture(first);await archive.capture(second);
 await assert.rejects(archive.setState(first.id,'deleted'),error=>error.status===409);assert.equal(archive.list().length,1);assert.equal(archive.list('deleted').length,0);
 second.status='cancelled';second.settled=true;second.nodes.agent.status='cancelled';await archive.capture(second);await archive.setState(first.id,'deleted');assert.equal(archive.list('deleted').length,1);assert.equal((await archive.family(second.id)).state,'deleted');
 await assert.rejects(archive.setState(first.id,'purged'),/Invalid conversation state/);await assert.rejects(archive.setState('missing','active'),/not found/i);
});

test('custom conversation names survive later turns, Archive, Trash, Restore and restart',async t=>{
 const dataDir=await mkdtemp(path.join(tmpdir(),'relay-conversation-rename-')),archives=[];t.after(async()=>{for(const archive of archives)await archive.close();await rm(dataDir,{recursive:true,force:true});});
 const engine=new Engine(),archive=await new ConversationArchive({dataDir,engine}).init();archives.push(archive);
 const first=turn('turn-0'),second=turn('turn-1',first.id);await archive.capture(first);await archive.capture(second);
 const named=await archive.rename(second.id,'  Release checklist  ');assert.equal(named.rootId,first.id);assert.equal(named.title,'Release checklist');assert.equal(archive.list()[0].title,'Release checklist');assert.equal((await archive.family(second.id)).title,'Release checklist');
 for(const state of ['archived','deleted','active']){await archive.setState(first.id,state);assert.equal(archive.list(state)[0].title,'Release checklist');assert.equal((await archive.family(first.id)).title,'Release checklist');}
 const third=turn('turn-2',second.id);await archive.capture(third);assert.equal(archive.list()[0].title,'Release checklist');
 for(const title of ['', '   ', 'x'.repeat(121),null, 'bad\0title'])await assert.rejects(archive.rename(first.id,title),{code:'CONVERSATION_TITLE_INVALID'});
 await archive.close();const restored=await new ConversationArchive({dataDir,engine:new Engine()}).init();archives.push(restored);
 assert.equal(restored.list()[0].title,'Release checklist');assert.equal((await restored.family(third.id)).title,'Release checklist');assert.equal((await restored.get(first.id)).input,first.input);
 await Promise.all([restored.rename(first.id,'Final checklist'),restored.setState(third.id,'archived')]);assert.equal(restored.list('archived')[0].title,'Final checklist');
});

test('damaged conversation organization recovers its last valid backup and preserves the damaged bytes',async t=>{
 const dataDir=await mkdtemp(path.join(tmpdir(),'relay-conversation-recovery-')),archives=[];t.after(async()=>{for(const archive of archives)await archive.close();await rm(dataDir,{recursive:true,force:true});});
 const archive=await new ConversationArchive({dataDir,engine:new Engine()}).init();archives.push(archive);await archive.capture(turn('turn-0'));
 await archive.rename('turn-0','Important saved chat');await archive.setState('turn-0','archived');await archive.setState('turn-0','deleted');await archive.close();
 const damaged='{damaged organization';await writeFile(archive.stateFile,damaged);
 const recovered=await new ConversationArchive({dataDir,engine:new Engine()}).init();archives.push(recovered);
 assert.equal(recovered.status().recovered,true);assert.equal(recovered.status().healthy,true);assert.equal(recovered.status().recoveryRequired,false);
 assert.equal(recovered.list('archived')[0].title,'Important saved chat');assert.equal((await recovered.family('turn-0')).state,'archived');
 const preserved=(await readdir(dataDir)).find(file=>file.startsWith('conversation-state.json.corrupt-'));assert.ok(preserved);assert.equal(await readFile(path.join(dataDir,preserved),'utf8'),damaged);
 assert.equal(JSON.parse(await readFile(archive.stateFile,'utf8'))['turn-0'].title,'Important saved chat');
 await recovered.setState('turn-0','active');assert.equal(recovered.list()[0].title,'Important saved chat');
});

test('unrecoverable conversation organization leaves chats readable without resurrecting Trash or overwriting damaged files',async t=>{
 const dataDir=await mkdtemp(path.join(tmpdir(),'relay-conversation-damaged-')),archives=[];t.after(async()=>{for(const archive of archives)await archive.close();await rm(dataDir,{recursive:true,force:true});});
 const saved=await new ConversationArchive({dataDir,engine:new Engine()}).init();archives.push(saved);await saved.capture(turn('turn-0'));await saved.close();
 const primary='42',backup='{broken backup';await writeFile(saved.stateFile,primary);await writeFile(saved.stateFile+'.bak',backup);
 const restored=await new ConversationArchive({dataDir,engine:new Engine()}).init();archives.push(restored);
 assert.equal(restored.status().healthy,false);assert.equal(restored.status().recoveryRequired,true);assert.match(restored.status().error,/Saved chats are preserved/);
 assert.equal((await restored.get('turn-0')).output,'Reply turn-0');assert.equal((await restored.family('turn-0')).state,'unknown');assert.equal(restored.list('all')[0].state,'unknown');
 for(const state of ['active','archived','deleted'])assert.throws(()=>restored.list(state),{code:'CONVERSATION_STATE_DAMAGED'});
 await assert.rejects(restored.setState('turn-0','active'),{code:'CONVERSATION_STATE_DAMAGED'});await assert.rejects(restored.rename('turn-0','Do not overwrite'),{code:'CONVERSATION_STATE_DAMAGED'});
 assert.equal(await readFile(saved.stateFile,'utf8'),primary);assert.equal(await readFile(saved.stateFile+'.bak','utf8'),backup);
 await restored.capture(turn('turn-1','turn-0'));assert.equal((await restored.family('turn-1')).runs.length,2);assert.equal(await readFile(saved.stateFile,'utf8'),primary);
});

test('failed organization writes preserve the committed state, clean temporary files and recover on retry',async t=>{
 const dataDir=await mkdtemp(path.join(tmpdir(),'relay-conversation-write-failure-'));let failRename=false;
 const stateFile=path.join(dataDir,'conversation-state.json'),io={...filesystem,rename:async(source,target)=>{if(failRename&&target===stateFile)throw Object.assign(Error('Simulated disk failure'),{code:'ENOSPC'});return filesystem.rename(source,target);}};
 const archive=await new ConversationArchive({dataDir,engine:new Engine(),io}).init();t.after(async()=>{failRename=false;await archive.close();await rm(dataDir,{recursive:true,force:true});});
 await archive.capture(turn('turn-0'));await archive.rename('turn-0','Committed name');const before=await readFile(stateFile,'utf8');failRename=true;
 await assert.rejects(archive.setState('turn-0','deleted'),{code:'CONVERSATION_SAVE_FAILED'});
 assert.equal(await readFile(stateFile,'utf8'),before);assert.equal(archive.list()[0].title,'Committed name');assert.equal((await archive.family('turn-0')).state,'active');assert.equal(archive.status().healthy,false);
 assert.ok((await readdir(dataDir)).every(file=>!file.endsWith('.tmp')));
 failRename=false;await archive.setState('turn-0','archived');assert.equal(archive.list('archived')[0].title,'Committed name');assert.equal(archive.status().healthy,true);
});

test('a failed turn save does not block startup and later successful capture clears its failure state',async t=>{
 const dataDir=await mkdtemp(path.join(tmpdir(),'relay-conversation-turn-failure-')),engine=new Engine();engine.runs.set('turn-0',turn('turn-0'));let failRename=true;
 const io={...filesystem,rename:async(source,target)=>{if(failRename&&target.endsWith(path.join('conversations','turn-0.json')))throw Object.assign(Error('Simulated disk failure'),{code:'ENOSPC'});return filesystem.rename(source,target);}};
 const archive=await new ConversationArchive({dataDir,engine,io}).init();t.after(async()=>{failRename=false;await archive.close();await rm(dataDir,{recursive:true,force:true});});
 assert.equal(archive.status().healthy,false);assert.equal((await archive.get('turn-0')).output,'Reply turn-0');assert.ok((await readdir(archive.directory)).every(file=>!file.endsWith('.tmp')));
 failRename=false;await archive.capture(engine.getRun('turn-0'));assert.equal(archive.status().healthy,true);assert.equal(archive.list()[0].title,'Message turn-0');
});

test('committed metadata changes publish ordered family receipts independently from streamed archive captures',async t=>{
 const dataDir=await mkdtemp(path.join(tmpdir(),'relay-conversation-metadata-')),engine=new Engine(),archive=await new ConversationArchive({dataDir,engine}).init(),archives=[archive];
 t.after(async()=>{for(const item of archives)await item.close();assert.match(path.basename(dataDir),/^relay-conversation-metadata-/);await rm(dataDir,{recursive:true,force:true});});
 const receipts=[],committed=[];archive.on('metadata.updated',receipt=>{receipts.push(receipt);committed.push({state:archive.states[receipt.rootId].state,title:archive.states[receipt.rootId].title,revision:archive.status().metadataRevision});});
 const first=turn('turn-0'),second=turn('turn-1',first.id);engine.runs.set(first.id,first);engine.runs.set(second.id,second);await archive.capture(first);await archive.capture(second);
 for(const type of ['delta','message','steer']){second.events.push({at:new Date().toISOString(),runId:second.id,nodeId:'agent',data:{type,text:`Actual ${type}`,delta:'Streaming progress'}});engine.emit('event',{type:'agent.event',runId:second.id,nodeId:'agent',data:{type,text:`Actual ${type}`}});await archive.capture(second);}
 assert.equal(archive.status().metadataRevision,0);assert.deepEqual(receipts,[]);
 const results=await Promise.all([archive.rename(second.id,'Shared current title'),archive.setState(first.id,'archived')]);
 assert.deepEqual(receipts,results);assert.deepEqual(receipts.map(item=>item.revision),[1,2]);assert.deepEqual(receipts.map(item=>item.rootId),[first.id,first.id]);
 assert.deepEqual(committed,[{state:'active',title:'Shared current title',revision:1},{state:'archived',title:'Shared current title',revision:2}]);
 for(const receipt of receipts){assert.equal(receipt.title,'Shared current title');assert.equal(Number.isFinite(Date.parse(receipt.updatedAt)),true);}
 assert.equal(archive.list('archived')[0].title,'Shared current title');
 const deleted=await archive.setState(second.id,'deleted'),restored=await archive.setState(first.id,'active');assert.equal(deleted.revision,3);assert.equal(restored.revision,4);assert.equal(receipts.length,4);
 await archive.capture(second);assert.equal(receipts.length,4);assert.equal(archive.status().metadataRevision,4);await archive.close();
 const reopened=await new ConversationArchive({dataDir,engine:new Engine()}).init();archives.push(reopened);assert.equal(reopened.status().metadataRevision,0);assert.equal(reopened.list()[0].title,'Shared current title');assert.equal(reopened.list()[0].state,'active');
 const next=await reopened.rename(first.id,'Title after reopening');assert.equal(next.revision,1);
});

test('failed metadata saves emit no change receipt or revision and later commits publish the actual retained state',async t=>{
 const dataDir=await mkdtemp(path.join(tmpdir(),'relay-conversation-metadata-failure-')),stateFile=path.join(dataDir,'conversation-state.json');let failRename=false;
 const io={...filesystem,rename:async(source,target)=>{if(failRename&&target===stateFile)throw Object.assign(Error('Simulated metadata disk failure'),{code:'ENOSPC'});return filesystem.rename(source,target);}};
 const archive=await new ConversationArchive({dataDir,engine:new Engine(),io}).init(),receipts=[];t.after(async()=>{failRename=false;await archive.close();assert.match(path.basename(dataDir),/^relay-conversation-metadata-failure-/);await rm(dataDir,{recursive:true,force:true});});
 archive.on('metadata.updated',receipt=>receipts.push(receipt));await archive.capture(turn('turn-0'));const named=await archive.rename('turn-0','Committed shared title');assert.equal(named.revision,1);const before=await readFile(stateFile,'utf8');
 failRename=true;await assert.rejects(archive.setState('turn-0','deleted'),{code:'CONVERSATION_SAVE_FAILED'});await assert.rejects(archive.rename('turn-0','Uncommitted title'),{code:'CONVERSATION_SAVE_FAILED'});
 assert.equal(receipts.length,1);assert.equal(archive.status().metadataRevision,1);assert.equal(await readFile(stateFile,'utf8'),before);assert.equal(archive.list()[0].title,'Committed shared title');
 failRename=false;const archived=await archive.setState('turn-0','archived');assert.deepEqual(archived,{rootId:'turn-0',state:'archived',title:'Committed shared title',updatedAt:archived.updatedAt,revision:2});assert.deepEqual(receipts.at(-1),archived);assert.equal(archive.status().metadataRevision,2);
});
