import test from 'node:test';
import assert from 'node:assert/strict';
import {searchRunActivity,activityQuery} from '../lib/run-activity-view.mjs';
const e=(type,extra={})=>({at:'2026-11-16T12:00:00Z',nodeId:'a',data:{type,...extra}});
const run={id:'r',cwd:'C:/fixture',taskId:'r',events:[e('message',{text:'Reading the saved result.',phase:'commentary'}),e('tool.result',{tool:'relay_browser',action:'click',success:true,arguments:'SECRET ARGUMENTS',result:'SECRET RESULT'}),e('item',{item:{type:'reasoning',text:'PRIVATE REASONING'}}),e('shadowdancer.step',{event:'action-returned',tool:'relay_browser',action:'click',receiptStatus:'success'}),e('unknown',{text:'PRIVATE UNKNOWN'})],eventRetention:{omittedEvents:23}};
test('public activity separates tool metadata and excludes private payloads and reasoning from search',()=>{
 const updates=searchRunActivity(run);assert.equal(updates.items.length,2);assert.equal(updates.coverage.omittedEvents,23);assert.match(updates.items[0].text,/does not verify task completion/);
 const tools=searchRunActivity(run,{view:'tools'});assert.equal(tools.items.length,1);assert.ok(!JSON.stringify(tools).includes('SECRET'));assert.equal(searchRunActivity(run,{q:'PRIVATE'}).items.length,0);assert.equal(searchRunActivity(run,{view:'tools',q:'SECRET'}).items.length,0);
});
test('search pagination is revision-bound and rejects unsupported or oversized queries',()=>{
 const first=searchRunActivity(run,{limit:1});assert.equal(first.nextOffset,1);assert.equal(searchRunActivity(run,{limit:1,offset:1,revision:first.revision}).items.length,1);
 assert.throws(()=>searchRunActivity({...run,events:[...run.events,e('message',{text:'New'})]},{revision:first.revision}),{code:'ACTIVITY_CHANGED'});
 for(const input of [{view:'reasoning'},{limit:100},{offset:-1},{q:'x'.repeat(201)}])assert.throws(()=>activityQuery(input),{code:'ACTIVITY_QUERY'});
});
test('activity opens at newest retained event, not oldest page',()=>{const result=searchRunActivity(run,{limit:1});assert.equal(result.items[0].id,'event:3');});

test('search checks complete retained public text before shortening returned preview',()=>{const result=searchRunActivity({id:'r',events:[e('message',{text:'a'.repeat(25000)+' LATE_MARKER'})]},{q:'LATE_MARKER'});assert.equal(result.totalMatches,1);assert.equal(result.items[0].text.length,24000);assert.equal(result.items[0].truncated,true);});
test('historical canonical work and synthesis commentary are excluded from public activity',async()=>{
 const records={id:'r',events:[e('message',{phase:'commentary',text:JSON.stringify({status:'incomplete',nextAction:'HIDDEN_MARKER',finding:'Evidence',candidate_answer:'',uncertainty:'Unknown'})}),e('message',{phase:'commentary',text:JSON.stringify({answer:'HIDDEN_SYNTHESIS',used_refs:[]})})]};
 assert.equal(searchRunActivity(records).totalMatches,0);assert.equal(searchRunActivity(records,{q:'HIDDEN'}).totalMatches,0);
});

test('incomplete provider payload is not searchable public content',()=>{const run={id:'r',events:[e('message',{phase:'commentary',incomplete:true,text:'{"status":"incomplete","finding":"PRIVATE_FRAGMENT'})]};assert.equal(searchRunActivity(run).totalMatches,0);assert.equal(searchRunActivity(run,{q:'PRIVATE_FRAGMENT'}).totalMatches,0);});
