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
import {PlanningBrowserStore} from '../lib/planning-browser.mjs';
import {ResponseCycleService} from '../lib/response-cycle.mjs';
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
 const harness=async(runtime,{archive=true,currentCycleCatalog=false}={})=>{const engine=new HarnessEngine({runtime,dataDir,defaultCwd:cwd});engine.runtimeSettings={get:()=>({codexHistory:'codex',runTimeoutMs:null,executionGuardrails:false})};await engine.init();owned.push(engine);let conversations;
  if(currentCycleCatalog){const planning=await new PlanningBrowserStore({dataDir}).init();owned.push(planning);engine.responseCycle=new ResponseCycleService({store:planning,engine,runner:{start:()=>assert.fail('Planning Off must not start a response worker.')}});owned.push(engine.responseCycle);}
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













test('provider facade forwards the explicit saved-history migration contract without selecting another model',async()=>{
 let received;const runtime=Object.create(ProviderRuntime.prototype);runtime.trackConfiguration=operation=>operation();runtime.codex={compactHistory:async value=>(received=value,{compacted:true,threadId:'fixture-persistent'})};
 const input={model:'historical-native',context:{preset:'extended',autoCompact:false},continuity:{text:'Saved native messages.'},timeoutMs:null};const receipt=await runtime.compactHistory(input);assert.equal(receipt.compacted,true);assert.equal(received,input);
});
