import {submitChat} from '../public/next/chat/send.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {EventEmitter} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {ProviderRuntime} from '../lib/providers.mjs';
import {RuntimeSettingsStore} from '../lib/runtime-settings.mjs';
import {HarnessEngine} from '../lib/engine.mjs';
class Native extends EventEmitter{status(){return{connected:false,authenticated:false,models:[]};}async close(){}async runAgent(){throw Error('No native inference');}}
test('saved defaults traverse real engine and provider HTTP adapter, without claiming model compliance',async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'defaults-http-')),requests=[];
 const server=http.createServer(async(req,res)=>{let raw='';for await(const part of req)raw+=part;res.setHeader('Content-Type','application/json');if(req.method==='GET'){res.end(JSON.stringify({data:[{id:'fixture',supported_parameters:['reasoning_effort'],supportedReasoningEfforts:['high']}]}));return;}
 const body=JSON.parse(raw);requests.push(body);res.end(JSON.stringify({choices:[{message:{role:'assistant',content:'Synthetic transport receipt.'},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1}}));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const runtime=new ProviderRuntime({codex:new Native(),dataDir:dir,modelLimitResolver:{enrich:async(_c,m)=>m}});await runtime.store.init();
 await runtime.saveProvider({id:'fixture',type:'compatible',baseUrl:'http://127.0.0.1:'+server.address().port+'/v1',models:[{id:'fixture',contextWindowTokens:65536,maxOutputTokens:4096,supportedReasoningEfforts:['high']}]},{preserveDefault:true});
 const settings=await new RuntimeSettingsStore({dataDir:dir}).init();await settings.update({defaultEffort:'high',verbosity:'concise',defaultServiceTier:'fast'});
 const engine=await new HarnessEngine({runtime,dataDir:path.join(dir,'engine'),defaultCwd:dir}).init();engine.runtimeSettings=settings;
 t.after(async()=>{await engine.close();await runtime.close();await settings.close();server.closeAllConnections();await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});});
 const workflow={id:'defaults-http',name:'HTTP receipt',nodes:[{id:'in',type:'input'},{id:'agent',type:'agent',model:'fixture::fixture',prompt:'Return a transport receipt.'},{id:'out',type:'output'}],edges:[{source:'in',target:'agent'},{source:'agent',target:'out'}],settings:{maxParallel:1}};
 const started=engine.startRun({workflow,input:'No external actions.',planningMode:'off'});
 let done;for(let i=0;i<1000;i++){done=engine.getRun(started.id);if(done.settled)break;await new Promise(r=>setTimeout(r,10));}
 assert.equal(done.status,'completed',done.error);assert.equal(requests.length,1);assert.equal(requests[0].reasoning_effort,'high');assert.equal(requests[0].service_tier,undefined);assert.match(JSON.stringify(requests[0].messages),/Be brief and direct/);

 assert.equal(done.nodes.agent.output,'Synthetic transport receipt.');
 const api=async(route,method,body)=>route==='/api/workflows'?body:route==='/api/runs'?engine.startRun(body):engine.continueRun(route.split('/')[3],body);
 const wait=async id=>{for(let i=0;i<1000;i++){const run=engine.getRun(id);if(run.settled)return run;await new Promise(r=>setTimeout(r,10));}throw Error('Chat did not settle');};
 const chat=await submitChat({api,runs:[],task:'Explicit Chat choices.',model:'fixture::fixture',cwd:dir,effort:'default',serviceTier:'default',verbosity:'detailed'});
 const first=await wait(chat.run.id);assert.equal(first.status,'completed',first.error);
 assert.equal(requests[1].reasoning_effort,undefined);assert.equal(requests[1].service_tier,undefined);
 assert.match(JSON.stringify(requests[1].messages),/Provide a well-organized, thorough response/);
 assert.equal(first.workflow.nodes.find(n=>n.type==='agent').verbosity,'detailed');
 const follow=await submitChat({api,runs:[first],task:'A concise follow-up.',model:'fixture::fixture',cwd:dir,verbosity:'concise'});
 const second=await wait(follow.run.id);assert.equal(second.status,'completed',second.error);
 assert.equal(second.workflow.nodes.find(n=>n.type==='agent').verbosity,'concise');
 assert.match(JSON.stringify(requests.at(-1).messages),/Be brief and direct/);
 assert.equal(settings.get().verbosity,'concise','Chat does not mutate global defaults.');

});
