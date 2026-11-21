import {submitChat} from '../public/next/chat/send.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {EventEmitter} from 'node:events';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {ProviderRuntime} from '../lib/providers.mjs';
import {RuntimeSettingsStore} from '../lib/runtime-settings.mjs';
import {HarnessEngine} from '../lib/engine.mjs';
class Native extends EventEmitter{status(){return{connected:false,authenticated:false,models:[]};}async close(){}async runAgent(){throw Error('No native inference');}}
const outcomeMarker='BLACKICE ORDINARY TASK OUTCOME REVIEW';
function syntheticOutcomeAssessment(request,turn){
 const prompt=request.messages?.find(message=>typeof message.content==='string'&&message.content.includes(outcomeMarker))?.content;
 if(!prompt)return null;
 assert.ok(turn.workers.length,'assessment follows a worker request on this provider');
 const {snapshot}=JSON.parse(prompt.split('\nREVIEW DATA (JSON):\n').at(-1));
 assert.equal(snapshot.request,turn.task,'assessment retains the unchanged current request');
 assert.equal(request.model,turn.workers[0].model,'assessment uses the worker model');
 assert.equal(request.reasoning_effort,turn.workers[0].reasoning_effort,'assessment preserves worker effort');
 assert.equal(request.service_tier,turn.workers[0].service_tier,'assessment preserves worker service tier');
 assert.deepEqual(request.tools||[],[],'inline-evidence assessment has no action tools');
 turn.assessors.push(request);
 // This mock disposition tests transport, not model judgment or an external outcome.
 return {decision:'respond',summary:'Synthetic transport assessment; no real external outcome is verified.',
  remaining:[],nextAction:'',evidenceRefs:['user-request','candidate'],blockers:[]};
}
function assertTransport(turn,workers,assessors){
 assert.equal(turn.workers.length,workers,'exact worker and completion-check requests');
 assert.equal(turn.assessors.length,assessors,'exact read-only outcome assessment requests');
 assert.equal(turn.all.length,workers+assessors,'every provider request is accounted for');
 if(assessors){
  const prompt=turn.workers.at(-1).messages.findLast(message=>message.role==='user').content;
  const parts=prompt.split('\n\nCURRENT USER REQUEST (unchanged JSON string):\n');
  assert.equal(parts.length,2,'the extra worker request is the completion evidence check');
  assert.equal(JSON.parse(parts[1]),turn.task,'completion check retains the current request');
 }
}
test('retired detail from an old profile or reopened Chat never reaches real provider HTTP requests',async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'defaults-http-')),requests=[],turns=[];
 let currentTurn;
 const beginTurn=(label,task)=>{const turn={label,task,workers:[],assessors:[],all:[]};turns.push(turn);currentTurn=turn;return turn;};
 const server=http.createServer(async(req,res)=>{let raw='';for await(const part of req)raw+=part;res.setHeader('Content-Type','application/json');if(req.method==='GET'){res.end(JSON.stringify({data:[{id:'fixture',supported_parameters:['reasoning_effort'],supportedReasoningEfforts:['high']}]}));return;}
 const body=JSON.parse(raw);requests.push(body);currentTurn.all.push(body);
 const assessment=syntheticOutcomeAssessment(body,currentTurn);
 if(!assessment)currentTurn.workers.push(body);
 res.end(JSON.stringify({choices:[{message:{role:'assistant',content:assessment?JSON.stringify(assessment):'Synthetic transport receipt.'},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1}}));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const runtime=new ProviderRuntime({codex:new Native(),dataDir:dir,modelLimitResolver:{enrich:async(_c,m)=>m}});await runtime.store.init();
 await runtime.saveProvider({id:'fixture',type:'compatible',baseUrl:'http://127.0.0.1:'+server.address().port+'/v1',models:[{id:'fixture',contextWindowTokens:65536,maxOutputTokens:4096,supportedReasoningEfforts:['high']}]},{preserveDefault:true});
 const legacyPreferences=JSON.stringify({defaultEffort:'high',verbosity:'detailed',defaultServiceTier:'fast'});
 const settings=new RuntimeSettingsStore({dataDir:dir});await writeFile(settings.file,legacyPreferences);await settings.init();
 assert.equal(await readFile(settings.file,'utf8'),legacyPreferences,'Loading does not rewrite legacy preferences.');
 assert.equal(Object.hasOwn(settings.get(),'verbosity'),false);
 const engine=await new HarnessEngine({runtime,dataDir:path.join(dir,'engine'),defaultCwd:dir}).init();engine.runtimeSettings=settings;
 let chatEngine=engine;
 t.after(async()=>{await chatEngine.close();await runtime.close();await settings.close();server.closeAllConnections();await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});});
 const workflow={id:'defaults-http',name:'HTTP receipt',nodes:[{id:'in',type:'input'},{id:'agent',type:'agent',model:'fixture::fixture',prompt:'Return a transport receipt.'},{id:'out',type:'output'}],edges:[{source:'in',target:'agent'},{source:'agent',target:'out'}],settings:{maxParallel:1}};
 const customTurn=beginTurn('custom','No external actions.');
 const started=engine.startRun({workflow,input:customTurn.task,planningMode:'off'});
 let done;for(let i=0;i<1000;i++){done=engine.getRun(started.id);if(done.settled)break;await new Promise(r=>setTimeout(r,10));}
 const retired=/ANSWER DETAIL \d+\/10|Example for a hypothetical file-edit question|RESPONSE VERBOSITY DEFAULT|Provide a well-organized, thorough response|Be brief and direct/;
 assert.equal(done.status,'completed',done.error);assertTransport(customTurn,1,0);assert.equal(requests.length,1);assert.equal(customTurn.workers[0].reasoning_effort,'high');assert.equal(customTurn.workers[0].service_tier,undefined);assert.doesNotMatch(JSON.stringify(customTurn.workers[0].messages),retired);

 assert.equal(done.nodes.agent.output,'Synthetic transport receipt.');
 const writes=[];
 const api=async(route,method,body)=>{writes.push(body);return route==='/api/workflows'?body:route==='/api/runs'?chatEngine.startRun(body):chatEngine.continueRun(route.split('/')[3],body);};
 const wait=async id=>{for(let i=0;i<1000;i++){const run=chatEngine.getRun(id);if(run.settled)return run;await new Promise(r=>setTimeout(r,10));}throw Error('Chat did not settle');};
 const firstTurn=beginTurn('fresh-chat','Explicit Chat choices.');
 const chat=await submitChat({api,runs:[],task:firstTurn.task,model:'fixture::fixture',cwd:dir,effort:'default',serviceTier:'default',verbosity:10});
 const first=await wait(chat.run.id);assert.equal(first.status,'completed',first.error);
 assertTransport(firstTurn,2,1);
 for(const request of firstTurn.all){assert.equal(request.reasoning_effort,undefined);assert.equal(request.service_tier,undefined);}
 assert.doesNotMatch(JSON.stringify(firstTurn.all),retired);
 const oldRun=engine.runs.get(first.id);
 oldRun.workflow.nodes.find(n=>n.type==='agent').verbosity=10;
 oldRun.runtimeSettings.verbosity='concise';
 engine.markRunDirty(first.id);await engine.persist({checkpoint:true});
 await engine.close();
 chatEngine=await new HarnessEngine({runtime,dataDir:path.join(dir,'engine'),defaultCwd:dir}).init();chatEngine.runtimeSettings=settings;
 const reopened=chatEngine.getRun(first.id);
 assert.equal(reopened.workflow.nodes.find(n=>n.type==='agent').verbosity,10,'The reopened record really contains the old value.');
 assert.equal(reopened.runtimeSettings.verbosity,'concise');
 const followTurn=beginTurn('reopened-chat','Follow up with the same model.');
 const follow=await submitChat({api,runs:[reopened],task:followTurn.task,model:'fixture::fixture',cwd:dir,effort:'high',verbosity:2});
 const second=await wait(follow.run.id);assert.equal(second.status,'completed',second.error);
 assert.equal(second.taskId,reopened.taskId);
 assert.equal(Object.hasOwn(second.workflow.nodes.find(n=>n.type==='agent'),'verbosity'),false);
 assertTransport(followTurn,1,0);
 assert.equal(followTurn.workers[0].reasoning_effort,'high');
 assert.doesNotMatch(JSON.stringify(followTurn.all),retired);
 assert.doesNotMatch(JSON.stringify(writes),/"verbosity"/);
 assert.equal(requests.length,5,'four worker requests plus one isolated assessment');
 for(const request of requests){assert.equal(request.model,'fixture');assert.equal(request.service_tier,undefined);}
 assert.doesNotMatch(JSON.stringify(requests),retired,'retired detail never reaches any worker or assessor request');
 assert.doesNotMatch(JSON.stringify(requests),/"verbosity"/);
 for(const turn of turns)t.diagnostic(JSON.stringify({turn:turn.label,workers:turn.workers.length,assessors:turn.assessors.length,total:turn.all.length}));

});
