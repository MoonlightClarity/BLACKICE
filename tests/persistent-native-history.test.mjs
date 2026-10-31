import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {CodexRuntime} from '../lib/codex.mjs';
import {HarnessEngine} from '../lib/engine.mjs';
import {ConversationArchive} from '../lib/conversations.mjs';
import {ProviderRuntime} from '../lib/providers.mjs';
import {CONTROL_TOOL,CONTROL_SCHEMA_VERSION} from '../lib/control-tools.mjs';

const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};};
const until=async predicate=>{for(let n=0;n<1000;n++){const value=predicate();if(value)return value;await new Promise(resolve=>setTimeout(resolve,5));}assert.fail('Local protocol fixture did not settle.');};
const metadata={enabled:true,resolve:async rows=>({models:rows.map(row=>({...row,contextWindowTokens:272000,runtimeDefaultContextWindowTokens:272000,maxContextWindowTokens:872000,effectiveContextWindowPercent:95,contextWindowSource:'runtime-reported'})),candidates:[]})};
const fixture=fileURLToPath(new URL('./fixtures/persistent-history-app-server.mjs',import.meta.url));
async function environment(t){
 const directory=await mkdtemp(path.join(tmpdir(),'blackice-persistent-history-')),cwd=path.join(directory,'workspace'),dataDir=path.join(directory,'data'),store=path.join(directory,'native-store.json');await mkdir(cwd);
 const owned=[];t.after(async()=>{for(const resource of owned.reverse())await resource.close();await rm(directory,{recursive:true,force:true});});
 const native=async(args=[])=>{const runtime=new CodexRuntime({command:process.execPath,args:[fixture,'--store='+store,...args],cwd,nativeModelMetadata:metadata,requestTimeoutMs:1500,runTimeoutMs:5000}),requests=[],calls=[];
  const request=runtime._request.bind(runtime);runtime._request=async(method,params={},...rest)=>{requests.push({method,params:structuredClone(params)});return request(method,params,...rest);};
  const agent=runtime.runAgent.bind(runtime);runtime.runAgent=options=>{calls.push(options);return agent(options);};owned.push(runtime);await runtime.start();return{runtime,requests,calls};};
 const harness=async(runtime,{archive=true}={})=>{const engine=new HarnessEngine({runtime,dataDir,defaultCwd:cwd});engine.runtimeSettings={get:()=>({codexHistory:'codex',runTimeoutMs:null,executionGuardrails:false})};await engine.init();owned.push(engine);let conversations;
  if(archive){conversations=await new ConversationArchive({dataDir,engine}).init();engine.persistConversation=value=>conversations.capture(value);owned.push(conversations);}return{engine,conversations};};
 return{directory,cwd,dataDir,store,native,harness};
}
const graph=()=>({id:'legacy-history',name:'Saved conversation',nodes:[{id:'input',type:'input'},{id:'agent',type:'agent',name:'Agent',model:'fixture',effort:'high',prompt:'Continue the requested conversation.'},{id:'output',type:'output'}],edges:[{source:'input',target:'agent'},{source:'agent',target:'output'}],settings:{maxParallel:1,planningMode:'off'}});
function legacyRun(id,{parentRunId,threadId='expired-'+id,context={preset:'model',autoCompact:false},createdAt='2026-10-01T00:00:00.000Z'}={}){
 const workflow=graph();workflow.nodes[1].context=context;const taskId=parentRunId||id,output='ASSISTANT_'+id;
 return{id,taskId,parentRunId,workflowId:workflow.id,workflowName:workflow.name,workflow,input:'USER_'+id,cwd:null,status:'completed',settled:true,createdAt,finishedAt:createdAt,runtimeSettings:{codexHistory:'relay',runTimeoutMs:null},planningMode:'off',planningContractVersion:1,events:[{type:'agent.event',runId:id,nodeId:'agent',at:createdAt,data:{type:'message',text:output,phase:'final_answer'}},{type:'agent.event',runId:id,nodeId:'agent',at:createdAt,data:{type:'steer',text:'ACCEPTED_'+id,accepted:true}},{type:'agent.event',runId:id,nodeId:'agent',at:createdAt,data:{type:'steer',text:'REJECTED_'+id,accepted:false}}],output,
  nodes:{input:{status:'completed',output:'USER_'+id},agent:{status:'completed',output,threadId,codexHistory:'relay',resolvedModel:'fixture',resolvedEffort:'high',toolNames:['relay_workspace','relay_control'],controlSchemaVersion:8,contextStatus:{preset:'model',autoCompact:false,effectiveWindowTokens:258400},usage:{total:{inputTokens:999000,outputTokens:1000,totalTokens:1000000}}},output:{status:'completed',output}}};
}
async function seed(engine,cwd,runs){for(const run of runs){run.cwd=cwd;engine.runs.set(run.id,run);}await engine.persist();return runs.at(-1);}
const publicHistory=run=>({input:run.input,output:run.output,agentOutput:run.nodes.agent.output,events:run.events.map(({timelineOrder,...event})=>event)});
const sourceText='ORIGINAL_SAVED_GOAL\n'+'abc '.repeat(9000)+'\nMIDDLE_SAVED_EVIDENCE\n'+'xyz '.repeat(9000)+'\nLATEST_SAVED_RESULT';
const smallContext={preset:'custom',windowTokens:8192,outputReserveTokens:512,headroomTokens:256,autoCompact:false};

test('legacy relay input cannot create an ordinary ephemeral chat and its persistent thread resumes after runtime restart',async t=>{
 const env=await environment(t),first=await env.native(),result=await first.runtime.runAgent({cwd:env.cwd,prompt:'Local fixture only.',codexHistory:'relay'});
 assert.equal(result.codexHistory,'codex');assert.equal(first.requests.find(row=>row.method==='thread/start').params.ephemeral,undefined);
 await first.runtime.close();const second=await env.native();const resumed=await second.runtime.runAgent({cwd:env.cwd,prompt:'Resume the fixture.',threadId:result.threadId});
 assert.equal(resumed.threadId,result.threadId);assert.equal(second.requests.filter(row=>row.method==='thread/start').length,0);assert.equal(second.requests.filter(row=>row.method==='thread/resume').length,1);
});

test('manual history compression bypasses only the automatic toggle, awaits completion, and retains a durable checkpoint and exact tools',async t=>{
 const env=await environment(t),first=await env.native(),ack=deferred(),original=first.runtime._request.bind(first.runtime),tool={type:'function',name:'fixture_tool',description:'Fixture only.',inputSchema:{type:'object',properties:{}}};let settled=false;
 first.runtime._request=async(method,...args)=>{const result=await original(method,...args);if(method==='thread/compact/start')ack.resolve();return result;};
 const operation=first.runtime.compactHistory({cwd:env.cwd,model:'fixture',context:smallContext,dynamicTools:[tool],continuity:{text:sourceText},timeoutMs:null}).finally(()=>{settled=true;});
 await ack.promise;assert.equal(settled,false,'RPC acceptance must not be reported as completed compression');const receipt=await operation;
 assert.equal(receipt.compacted,true);assert.equal(receipt.migrated,true);assert.equal(receipt.context.autoCompact,false);assert.equal(first.requests.filter(row=>row.method==='turn/start').length,0);
 const starts=first.requests.filter(row=>row.method==='thread/start');assert.equal(starts.length,1);assert.notEqual(starts[0].params.ephemeral,true);assert.deepEqual(starts[0].params.dynamicTools,[tool]);
 const imports=first.requests.filter(row=>row.method==='thread/inject_items');assert.ok(imports.length>1);assert.equal(imports.map(row=>row.params.items[0].content[0].text.split('\n\n').slice(1).join('\n\n')).join(''),sourceText);
 await first.runtime.close();const second=await env.native(),resumed=await second.runtime.runAgent({cwd:env.cwd,threadId:receipt.threadId,prompt:'One actual fixture turn.',context:smallContext});
 const detail=JSON.parse(resumed.output);assert.deepEqual(detail.dynamicTools,[tool]);assert.match(detail.savedText,/ORIGINAL_SAVED_GOAL/);assert.match(detail.savedText,/LATEST_SAVED_RESULT/);assert.equal(detail.compactions,imports.length);
 assert.equal(second.requests.filter(row=>row.method==='thread/inject_items'||row.method==='thread/start').length,0);
});

test('partial history imports expose no replacement thread events and a retry imports the complete source',async t=>{
 const env=await environment(t),{runtime,requests}=await env.native(['--fail-import=2']),events=[],global=[];runtime.on('event',event=>global.push(event));
 await assert.rejects(runtime.compactHistory({cwd:env.cwd,context:smallContext,continuity:{text:sourceText},onEvent:event=>events.push(event)}),/original messages were kept/i);
 assert.deepEqual(events,[]);assert.deepEqual(global,[]);assert.equal(runtime.contexts.size,0);
 const retry=await runtime.compactHistory({cwd:env.cwd,context:smallContext,continuity:{text:sourceText}}),imports=requests.filter(row=>row.method==='thread/inject_items'&&row.params.threadId===retry.threadId);
 assert.equal(imports.map(row=>row.params.items[0].content[0].text.split('\n\n').slice(1).join('\n\n')).join(''),sourceText);assert.equal(requests.filter(row=>row.method==='turn/start').length,0);
});

test('Stop during an acknowledged history injection cannot admit the next compaction',async t=>{
 const env=await environment(t),{runtime,requests}=await env.native(),controller=new AbortController(),original=runtime._request.bind(runtime);
 runtime._request=async(method,...args)=>{const result=await original(method,...args);if(method==='thread/inject_items')controller.abort();return result;};
 await assert.rejects(runtime.compactHistory({cwd:env.cwd,context:smallContext,continuity:{text:'Saved history.'},signal:controller.signal}),error=>error.code==='ABORT_ERR'||error.name==='AbortError');
 assert.equal(requests.filter(row=>row.method==='thread/compact/start'||row.method==='turn/start').length,0);assert.equal(runtime.threads.size,0);
});

test('an unload error cannot discard a successfully completed persistent checkpoint',async t=>{
 const env=await environment(t),first=await env.native(['--fail-unsubscribe']),receipt=await first.runtime.compactHistory({cwd:env.cwd,context:smallContext,continuity:{text:'COMPLETED_CHECKPOINT'}});
 assert.equal(receipt.compacted,true);await first.runtime.close();const second=await env.native(),resumed=await second.runtime.runAgent({cwd:env.cwd,threadId:receipt.threadId,prompt:'Read fixture checkpoint.'});assert.match(JSON.parse(resumed.output).savedText,/COMPLETED_CHECKPOINT/);
});

test('manual legacy migration imports archived lineage without an old thread ID, persists its identity, and reuses exact tools after reopen',async t=>{
 const env=await environment(t),native=await env.native(),{engine,conversations}=await env.harness(native.runtime),first=legacyRun('legacy-first'),latest=legacyRun('legacy-latest',{parentRunId:first.id,threadId:undefined,createdAt:'2026-10-01T01:00:00.000Z'});delete latest.nodes.agent.threadId;
 await seed(engine,env.cwd,[first,latest]);await conversations.capture(first);await conversations.capture(latest);engine.runs.delete(first.id);
 const family=await conversations.family(latest.id),before=structuredClone(publicHistory(latest)),receipt=await engine.compactRun(latest.id,{nodeId:'agent'},{historyRuns:family.runs});
 assert.equal(receipt.compacted,true);assert.equal(receipt.migrated,true);assert.equal(latest.nodes.agent.codexHistory,'codex');assert.equal(latest.runtimeSettings.codexHistory,'relay','historical run snapshot remains unchanged');assert.deepEqual(publicHistory(latest),before);
 const manual=native.calls.find(value=>value.compactOnly);assert.equal(manual.timeoutMs,null);assert.equal(manual.context.autoCompact,false);assert.match(manual.continuity.text,/USER_legacy-first/);assert.match(manual.continuity.text,/ASSISTANT_legacy-first/);assert.match(manual.continuity.text,/ACCEPTED_legacy-first/);assert.doesNotMatch(manual.continuity.text,/REJECTED_/);
 const control=manual.dynamicTools.find(tool=>tool.name==='relay_control');assert.deepEqual(control,CONTROL_TOOL);assert.equal(latest.nodes.agent.controlSchemaVersion,CONTROL_SCHEMA_VERSION);
 assert.deepEqual(engine.threadUsageBaseline(receipt.threadId,latest.nodes.agent.usage.total),receipt.usage.total,'old ephemeral totals must not become the replacement baseline');
 const archived=await conversations.readFile(latest.id);assert.equal(archived.nodes.agent.threadId,receipt.threadId);assert.equal(archived.nodes.agent.codexHistory,'codex');assert.deepEqual(publicHistory(archived),before);
 engine.runs.delete(latest.id);await engine.persist();await conversations.close();await engine.close();await native.runtime.close();
 const restartedNative=await env.native(),reopened=await env.harness(restartedNative.runtime);const restored=await reopened.conversations.get(latest.id);assert.equal(restored.nodes.agent.threadId,receipt.threadId);reopened.engine.restoreArchivedRun(restored);
 const continued=reopened.engine.continueRun(restored.id,{nodeId:'agent',message:'Continue using the migrated checkpoint.'},{historyRuns:(await reopened.conversations.family(restored.id)).runs}),done=await until(()=>{const value=reopened.engine.getRun(continued.id);return value.settled&&value;});
 assert.equal(done.status,'completed',done.error);assert.equal(done.nodes.agent.threadId,receipt.threadId);assert.equal(done.modelHandoff,undefined);
 const detail=JSON.parse(done.nodes.agent.output);assert.deepEqual(detail.dynamicTools,manual.dynamicTools);assert.match(detail.savedText,/USER_legacy-first/);assert.equal(restartedNative.requests.filter(row=>row.method==='thread/start'||row.method==='thread/inject_items'||row.method==='thread/compact/start').length,0);
});

test('manual migration cancellation holds the conversation lock and preserves old node context and messages',async t=>{
 const env=await environment(t),native=await env.native(['--hold-compact']),{engine}=await env.harness(native.runtime),run=await seed(engine,env.cwd,[legacyRun('legacy-cancel')]),before=structuredClone(run.nodes.agent),history=structuredClone(publicHistory(run));
 const operation=engine.compactRun(run.id,{nodeId:'agent'});await until(()=>native.requests.some(row=>row.method==='thread/compact/start'));
 assert.equal(engine.conversationBusy(run),true);assert.throws(()=>engine.continueRun(run.id,{nodeId:'agent',message:'Do not start while compression is pending.'}),{code:'CHAT_BUSY'});
 engine.cancelRun(run.id);assert.equal(engine.conversationBusy(run),true);await assert.rejects(operation,error=>error.code==='ABORT_ERR'||error.name==='AbortError');
 assert.equal(engine.conversationBusy(run),false);assert.deepEqual(run.nodes.agent,before);assert.deepEqual(publicHistory(run),history);assert.equal(native.requests.filter(row=>row.method==='turn/start').length,0);
});

for(const failedStore of ['engine','archive'])test(`completed migration survives a ${failedStore} save failure and restart without reimporting`,async t=>{
 const env=await environment(t),native=await env.native(),{engine,conversations}=await env.harness(native.runtime),run=await seed(engine,env.cwd,[legacyRun('legacy-save-'+failedStore)]);await conversations.capture(run);const before=structuredClone(run.nodes.agent),history=structuredClone(publicHistory(run));
 const original=failedStore==='engine'?engine.persist.bind(engine):engine.persistConversation;let fail=true;
 if(failedStore==='engine')engine.persist=(...args)=>{if(fail){fail=false;return Promise.reject(Error('Fixture disk failure.'));}return original(...args);};
 else engine.persistConversation=value=>{if(fail){fail=false;return Promise.reject(Error('Fixture archive failure.'));}return original(value);};
 await assert.rejects(engine.compactRun(run.id,{nodeId:'agent'}),{code:'CONTEXT_MIGRATION_SAVE_FAILED'});assert.deepEqual(run.nodes.agent,before);assert.deepEqual(publicHistory(run),history);
 const journal=JSON.parse(await readFile(engine.nativeHistoryMigrationFile(run.id,'agent'),'utf8'));assert.equal(journal.value.receipt.compacted,true);const threadId=journal.value.receipt.threadId;
 if(failedStore==='engine')engine.persist=original;else engine.persistConversation=original;
 await conversations.close();await engine.close();await native.runtime.close();
 const nextNative=await env.native(),next=await env.harness(nextNative.runtime),receipt=await next.engine.compactRun(run.id,{nodeId:'agent'},{historyRuns:(await next.conversations.family(run.id)).runs});
 assert.equal(receipt.threadId,threadId);assert.equal(nextNative.requests.filter(row=>row.method==='thread/start'||row.method==='thread/inject_items'||row.method==='thread/compact/start').length,0);assert.equal((await next.conversations.readFile(run.id)).nodes.agent.threadId,threadId);assert.deepEqual(publicHistory(next.engine.getRun(run.id)),history);
});

test('continuation can finish adopting a completed migration receipt before one task turn without duplicate handoff',async t=>{
 const env=await environment(t),native=await env.native(),{engine,conversations}=await env.harness(native.runtime),run=await seed(engine,env.cwd,[legacyRun('legacy-continue-recovery')]);await conversations.capture(run);const persist=engine.persist.bind(engine);let fail=true;engine.persist=(...args)=>{if(fail){fail=false;return Promise.reject(Error('Fixture save failed.'));}return persist(...args);};
 await assert.rejects(engine.compactRun(run.id,{nodeId:'agent'}),{code:'CONTEXT_MIGRATION_SAVE_FAILED'});engine.persist=persist;const journal=await engine.readNativeHistoryMigration(run.id,'agent'),before=native.requests.length;
 const next=engine.continueRun(run.id,{nodeId:'agent',message:'Continue after the recovered save.'},{historyRuns:(await conversations.family(run.id)).runs}),done=await until(()=>{const value=engine.getRun(next.id);return value.settled&&value;});
 assert.equal(done.status,'completed',done.error);assert.equal(done.nodes.agent.threadId,journal.receipt.threadId);assert.equal(done.modelHandoff,undefined);assert.equal(native.requests.slice(before).filter(row=>row.method==='thread/start'||row.method==='thread/inject_items'||row.method==='thread/compact/start').length,0);assert.equal(native.requests.slice(before).filter(row=>row.method==='turn/start').length,1);
});

test('a newer admitted or completed conversation turn prevents stale full-history migration',async t=>{
 const env=await environment(t),native=await env.native(),{engine}=await env.harness(native.runtime),run=await seed(engine,env.cwd,[legacyRun('legacy-race')]),stale=[structuredClone(run)];
 const newer=legacyRun('legacy-race-next',{parentRunId:run.id,createdAt:'2026-10-01T01:00:00.000Z'});newer.cwd=env.cwd;newer.status='running';newer.settled=false;engine.runs.set(newer.id,newer);
 await assert.rejects(engine.compactRun(run.id,{nodeId:'agent'},{historyRuns:stale}),{code:'CHAT_BUSY'});newer.status='completed';newer.settled=true;
 await assert.rejects(engine.compactRun(run.id,{nodeId:'agent'},{historyRuns:stale}),{code:'CHAT_CHANGED'});assert.equal(native.requests.filter(row=>row.method==='thread/start').length,0);
});

test('tampered completed-migration receipts are not adopted or repeated as new model work',async t=>{
 const env=await environment(t),native=await env.native(),{engine}=await env.harness(native.runtime),run=await seed(engine,env.cwd,[legacyRun('legacy-tamper')]),file=engine.nativeHistoryMigrationFile(run.id,'agent');await mkdir(path.dirname(file),{recursive:true});await writeFile(file,JSON.stringify({value:{version:1,runId:run.id,nodeId:'agent',fingerprint:'0'.repeat(64),receipt:{compacted:true,threadId:'not-authorized'},patch:{threadId:'not-authorized',codexHistory:'codex'}},sha256:'0'.repeat(64)}));
 await assert.rejects(engine.compactRun(run.id,{nodeId:'agent'}),{code:'CONTEXT_MIGRATION_RECEIPT'});assert.match(run.nodes.agent.threadId,/^expired-/);assert.equal(native.requests.filter(row=>row.method==='thread/start').length,0);
});

test('provider facade forwards the explicit saved-history migration contract without selecting another model',async()=>{
 let received;const runtime=Object.create(ProviderRuntime.prototype);runtime.trackConfiguration=operation=>operation();runtime.codex={compactHistory:async value=>(received=value,{compacted:true,threadId:'fixture-persistent'})};
 const input={model:'historical-native',context:{preset:'extended',autoCompact:false},continuity:{text:'Saved native messages.'},timeoutMs:null};const receipt=await runtime.compactHistory(input);assert.equal(receipt.compacted,true);assert.equal(received,input);
});
