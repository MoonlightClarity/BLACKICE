import test from 'node:test';
import assert from 'node:assert/strict';
import {searchRunActivity,searchDirectoryOutputs,activityQuery} from '../lib/run-activity-view.mjs';
import {handleShadowdancerContextHttp} from '../lib/shadowdancer-context-http.mjs';
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
const files=['runs/r/modules/1/output.json','runs/r/modules/1/checkpoints/0001.json','runs/other/modules/1/output.json','runs/r/modules/1/authoritative-context.json','runs/r/modules/1/input.json','runs/r/modules/1/tools/0001.json'];
const list=async()=>({files:files.map(file=>({file,bytes:100,updatedAt:'2026-11-16T12:00:00Z'}))});
test('internal opt-in reads only selected run output/checkpoint schemas and retains source hash',async()=>{
 const reads=[];const read=async args=>{reads.push(args.file);return {hash:'saved-hash',value:{label:'work',parsed:{status:'incomplete',finding:'Saved special finding',nextAction:'Inspect evidence',candidate_answer:'',uncertainty:'Unverified',privateReasoning:'PRIVATE'},raw:'PRIVATE RAW',authoritativeContext:'PRIVATE CONTEXT'}};};
 const found=await searchDirectoryOutputs({runId:'r'},{q:'special'},{list,read});assert.equal(found.items.length,2);assert.equal(reads.length,2);assert.ok(reads.every(x=>!x.includes('other')));assert.ok(!JSON.stringify(found).includes('PRIVATE'));assert.equal(found.items[0].sourceHash,'saved-hash');
 assert.equal((await searchDirectoryOutputs({runId:'r'},{q:'PRIVATE'},{list,read})).items.length,0);
});
test('internal source-page search exposes continuation even when page has no matches',async()=>{
 const sources=Array.from({length:13},(_,i)=>({file:'runs/r/modules/'+i+'/output.json',bytes:10,updatedAt:'2026-11-16'}));
 const found=await searchDirectoryOutputs({runId:'r'},{q:'missing'},{list:async()=>({files:sources}),read:async()=>({value:{parsed:{status:'complete',finding:'other'}}})});
 assert.equal(found.items.length,0);assert.equal(found.nextOffset,10);assert.equal(found.coverage.scannedFiles,10);assert.equal(found.coverage.sourceFiles,13);
});
test('activity HTTP uses existing selected-conversation access and rejects foreign/trash scope',async()=>{
 const conversations={get:async()=>run,list:()=>[{id:'r',rootId:'r',state:'active'}]},responses=[];
 const invoke=url=>handleShadowdancerContextHttp({req:{method:'GET',url},res:{},pathname:'/api/shadowdancer/context/activity',host:'fixture',conversations,json:(_res,status,body)=>responses.push({status,body})});
 await invoke('/api/shadowdancer/context/activity?runId=r&view=tools');assert.equal(responses.at(-1).status,200);assert.equal(responses.at(-1).body.items.length,1);
 conversations.list=()=>[{id:'r',state:'trashed'}];await invoke('/api/shadowdancer/context/activity?runId=r');assert.equal(responses.at(-1).status,404);
 await invoke('/api/shadowdancer/context/activity?runId=r&q=a&q=b');assert.equal(responses.at(-1).status,400);
});

test('internal output ignores arbitrary labels and nested values and skips oversized files',async()=>{
 const reads=[];const result=await searchDirectoryOutputs({runId:'r'},{},{list:async()=>({files:[{file:'runs/r/modules/1/output.json',bytes:30},{file:'runs/r/modules/2/output.json',bytes:3000000}]}),read:async args=>{reads.push(args.file);return {value:{label:'PRIVATE LABEL',parsed:{status:'complete',finding:{privateReasoning:'PRIVATE NESTED'},nextAction:'Reported plan'}}};}});
 assert.equal(reads.length,1);assert.equal(result.coverage.unavailableFiles,1);assert.ok(!JSON.stringify(result).includes('PRIVATE'));assert.match(result.items[0].text,/Reported plan/);
});

test('activity opens at newest retained event, not oldest page',()=>{const result=searchRunActivity(run,{limit:1});assert.equal(result.items[0].id,'event:3');});

test('search checks complete retained public text before shortening returned preview',()=>{const result=searchRunActivity({id:'r',events:[e('message',{text:'a'.repeat(25000)+' LATE_MARKER'})]},{q:'LATE_MARKER'});assert.equal(result.totalMatches,1);assert.equal(result.items[0].text.length,24000);assert.equal(result.items[0].truncated,true);});
test('historical canonical work and synthesis commentary are internal only and source linked',async()=>{
 const records={id:'r',events:[e('message',{phase:'commentary',text:JSON.stringify({status:'incomplete',nextAction:'HIDDEN_MARKER',finding:'Evidence',candidate_answer:'',uncertainty:'Unknown'})}),e('message',{phase:'commentary',text:JSON.stringify({answer:'HIDDEN_SYNTHESIS',used_refs:[]})})]};
 assert.equal(searchRunActivity(records).totalMatches,0);assert.equal(searchRunActivity(records,{q:'HIDDEN'}).totalMatches,0);
 const result=await searchDirectoryOutputs({runId:'r'},{q:'HIDDEN'},{run:records,list:async()=>({files:[]}),read:async()=>{throw Error('not called');}});assert.equal(result.items.length,2);assert.ok(result.items.every(x=>x.sourceHash&&x.source.startsWith('retained event:')));
});

test('incomplete provider payload is metadata-only Internal and not searchable content',async()=>{const run={id:'r',events:[e('message',{phase:'commentary',incomplete:true,text:'{"status":"incomplete","finding":"PRIVATE_FRAGMENT'})]};assert.equal(searchRunActivity(run).totalMatches,0);const found=await searchDirectoryOutputs({runId:'r'},{},{run,list:async()=>({files:[]})});assert.equal(found.items.length,1);assert.ok(!JSON.stringify(found).includes('PRIVATE_FRAGMENT'));assert.equal((await searchDirectoryOutputs({runId:'r'},{q:'PRIVATE_FRAGMENT'},{run,list:async()=>({files:[]})})).items.length,0);});

test('historical internal reports remain searchable when saved Directory context is absent',async()=>{
 const records={id:'r',events:[e('message',{text:JSON.stringify({answer:'RETAINED_SYNTHESIS',used_refs:['saved-ref']})})]};
 const result=await searchDirectoryOutputs({runId:'r'},{q:'RETAINED'},{run:records,list:async()=>{throw Object.assign(Error('No saved context'),{code:'SHADOWDANCER_CONTEXT_NOT_FOUND'});},read:async()=>assert.fail('No file should be read')});
 assert.equal(searchRunActivity(records).totalMatches,0);
 assert.equal(result.items.length,1);assert.match(result.items[0].text,/RETAINED_SYNTHESIS/);
 assert.equal(result.items[0].source,'retained event:0');assert.ok(result.items[0].sourceHash);
 assert.equal(result.coverage.sourceFiles,1);assert.equal(result.coverage.unavailableFiles,0);assert.equal(result.nextOffset,null);
});

test('internal listing propagates errors other than missing Directory context',async()=>{
 for(const code of ['EACCES','SHADOWDANCER_SCOPE','SHADOWDANCER_CONTEXT_INVALID',undefined]){
  const error=Object.assign(Error('Listing failed'),code?{code}:{});
  await assert.rejects(searchDirectoryOutputs({runId:'r'},{},{list:async()=>{throw error;}}),actual=>actual===error);
 }
});