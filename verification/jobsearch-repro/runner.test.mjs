import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import vm from 'node:vm';
import { TrialRunner, PROMPTS, parseCLI, sha256, decodeFrontendResult, admissionRequest, productFileEvidence } from './runner.mjs';
import { ordinaryChatWorkflow } from '../../public/chat-turn-defaults.mjs';
import { executionModesFrom } from '../../lib/conversation-execution-modes.mjs';

const RUN='11111111-1111-4111-8111-111111111111';
const OTHER='22222222-2222-4222-8222-222222222222';
const ordinary='Find one suitable job using my existing résumé and preferences. Apply through the employer’s site and verify that the application was received.';
async function fixture(t, options={}) {
  const root=await fs.mkdtemp(path.join(tmpdir(),'blackice-runner-offline-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const config={profile:path.join(root,'profile'),executable:path.join(root,'BLACKICE.exe'),out:path.join(root,'attempt'),
    appDir:path.join(root,'app'),model:'gpt-6.2-astra',effort:'high',jobs:options.jobs || 1,profileCondition:'fresh',providerAccount:'reused'};
  const calls=[], jobs=new Map(), idempotency=new Map(), timers=new Map();
  const state={run:null,posts:0,source:'frozen',lostResponse:options.lostResponse,missingRun:options.missingRun,subscription:null,
    failReadyCheckOnce:options.failReadyCheckOnce,loseBindOnce:options.loseBindOnce,bindRequests:0};
  let serial=0, timerSerial=0;
  class EventSource {
    constructor(url) {
      assert.equal(url,'/api/events'); state.subscription=this;
      queueMicrotask(()=> options.openFailure ? this.onerror() : (calls.push('observer-open'),this.onopen()));
    }
    close(){this.closed=true;}
  }
  const event=data=>({type:'agent.event',runId:RUN,nodeId:'agent',at:new Date().toISOString(),data});
  state.emit=data=>state.subscription.onmessage({data:JSON.stringify(event(data))});
  const context=vm.createContext({window:{},EventSource,TextEncoder,structuredClone,
    setTimeout(fn,ms){const id=++timerSerial;timers.set(id,{fn,ms});return id;},clearTimeout(id){timers.delete(id);},
    fetch:async route=>{
      if(route==='/api/runs') return {ok:true,json:async()=>state.missingRun?[]:[state.run].filter(Boolean)};
      if(route==='/api/runs/'+RUN) return {ok:Boolean(state.run),status:state.run?200:404,json:async()=>state.run};
      if(route==='/api/runs/'+RUN+'/instructions') return {ok:true,json:async()=>({runId:RUN,nodes:[{audit:{core:'delivered instructions'}}]})};
      throw Error('Unexpected fake renderer request: '+route);
    }});
  state.stopObserver=()=>context.window.__blackiceJobSearchEvidence.finish('time-limit');
  const request=async(route,body)=>{
    if(route==='/api/status') return {app:'relay-agent-harness',desktopApp:true,cwd:path.join(root,'original-documents'),
      connected:true,authenticated:true,account:{id:'provider-account',token:'never-archive-account-token'},runtimeSettings:{executionGuardrails:false},
      conversations:{conversations:0},execution:{activeCount:0}};
    if(route==='/api/identity') return {soul:{revision:1,content:'fresh default'},user:{revision:1,content:'unfilled template'}};
    if(route==='/api/instructions') return {core:{revision:1,content:'current core'}};
    if(route==='/api/skills') return {entries:[{id:'library-job-search',title:'Job search',source:'bundled',revision:1}]};
    if(route==='/api/skills/library-job-search') return {id:'library-job-search',source:'bundled',revision:1,content:'general method'};
    if(route==='/api/development/frontend') {
      if(body.requestId.includes('.readycheck-') && state.failReadyCheckOnce){state.failReadyCheckOnce=false;throw Error('Interrupted before fresh readiness read');}
      if(body.requestId.endsWith('.bind'))state.bindRequests++;
      const previous=idempotency.get(body.requestId);
      if(previous){assert.deepEqual(body,previous.arguments);return {jobId:previous.id};}
      const id='direct_'+(++serial).toString(16).padStart(64,'0'), job={id,arguments:structuredClone(body),settled:false};
      jobs.set(id,job);idempotency.set(body.requestId,job);
      job.pending=Promise.resolve().then(()=>vm.runInContext(body.expression,context)).then(value=>{
        job.value=value;job.success=true;job.settled=true;
      },error=>{job.error=error;job.success=false;job.settled=true;});
      if(body.requestId.endsWith('.bind') && state.loseBindOnce){state.loseBindOnce=false;throw Error('Lost bind response');}
      return {jobId:id};
    }
    if(route.startsWith('/api/development/frontend/jobs/')){
      const id=route.split('/').at(-1).split('?')[0],job=jobs.get(id);
      await Promise.resolve();
      return {jobId:id,settled:job.settled,status:job.settled?'succeeded':'running',result:{success:job.success}};
    }
    if(route==='/api/runs' && body){
      calls.push('admit');state.posts++;state.payload=structuredClone(body);
      assert.equal(context.window.__blackiceJobSearchEvidence.readiness,'ready');
      assert.equal(await fs.readFile(path.join(config.out,'admission.json'),'utf8').then(JSON.parse).then(x=>x.requestId),body.requestId);
      state.run={id:RUN,status:'running',settled:false,workflowId:body.workflow.id,workflow:body.workflow,input:body.input.task,
        metadata:{clientRequestId:body.requestId},planningMode:body.input.planningMode,chatPlanning:body.input.chatPlanning,directoryActions:body.input.directoryActions,
        executionModes:executionModesFrom(body.input),attachmentIds:[],nodes:{},
        events:[{type:'reasoning',text:'never-archive-private-reasoning'}]};
      state.emit({type:'message',itemId:'public-1',phase:'commentary',text:'Searching employer vacancies.'});
      state.emit({type:'message',itemId:'private-1',phase:'analysis',text:'never-archive-private-reasoning'});
      if(state.lostResponse){state.lostResponse=false;throw Object.assign(Error('Lost admission response'),{code:'ETIMEDOUT'});}
      return state.run;
    }
    throw Error('Unexpected fake native route: '+route);
  };
  const dependencies={connect:async()=>({request,runtime:{pid:123,startedAt:'2026-11-21T00:00:00Z',url:'http://127.0.0.1:42000',version:'2.40.72',profileMode:'custom',cookie:'never-archive-session-cookie'}}),
    sources:async()=>({commit:'fixture',fingerprint:state.source,files:{}}),pause:async()=>Promise.resolve(),
    readResult:async(id,requestId)=>{const job=jobs.get(id);assert.equal(job.arguments.requestId,requestId);await job.pending;
      if(!job.success)throw job.error;
      if(options.wrongCapture && requestId.endsWith('.stop'))return {...job.value,runId:OTHER};
      return job.value;}};
  const runner=new TrialRunner(config,dependencies);
  return {root,config,calls,state,jobs,runner,dependencies,read:name=>fs.readFile(path.join(config.out,name),'utf8').then(JSON.parse)};
}

test('exact ordinary task, explicit modes, readiness-before-admission, and public capture archive',async t=>{
  const f=await fixture(t);await f.runner.preflight();const started=await f.runner.start();
  assert.equal(started.runId,RUN);assert.deepEqual(f.calls,['observer-open','admit']);
  assert.equal(f.state.payload.input.task,ordinary);assert.deepEqual(Object.keys(f.state.payload.input).sort(),['chatPlanning','cwd','directoryActions','directoryMode','planningMode','task']);
  assert.equal(f.state.payload.input.planningMode,'off');assert.equal(f.state.payload.input.directoryMode,'off');
  assert.equal(f.state.payload.workflow.nodes.find(n=>n.type==='agent').model,'gpt-6.2-astra');
  assert.equal(f.state.payload.workflow.nodes.find(n=>n.type==='agent').effort,'high');
  assert.equal(f.state.posts,1);
  await assert.rejects(f.runner.collect(),error=>error.code==='RUN_NOT_SETTLED');
  f.state.run.status='completed';f.state.run.settled=true;
  const result=await f.runner.collect(), capture=await f.read('capture.json');
  const bytes=await fs.readFile(result.capture.file);
  assert.equal(sha256(bytes),result.capture.sha256);assert.equal(bytes.length,result.capture.bytes);
  assert.equal(capture.runId,RUN);assert.equal(capture.events.length,1);assert.equal(capture.captureComplete,true);
  assert.equal(capture.openedAtUTC,started.readiness.openedAtUTC);
  const manifest=await f.read('manifest.json');assert.equal(manifest.entryPoint,'native-local-chat-api');assert.equal(manifest.prompt,ordinary);
  assert.match(manifest.scoring,/Manual evidence review/);assert.equal(Object.hasOwn(result,'success'),false);
  const combined=(await Promise.all((await fs.readdir(f.config.out)).filter(n=>n.endsWith('.json')).map(n=>fs.readFile(path.join(f.config.out,n),'utf8')))).join('\n');
  assert.doesNotMatch(combined,/never-archive-private-reasoning|never-archive-account-token|never-archive-session-cookie/);
  await f.runner.collect();assert.equal(f.state.posts,1);
  await fs.appendFile(result.capture.file,' ');
  await assert.rejects(f.runner.collect(),error=>error.code==='ARCHIVE_CHANGED');
});

test('two-job variant changes only the ordinary task and retains no Goal or attachment packet',async t=>{
  const f=await fixture(t,{jobs:2});await f.runner.preflight();await f.runner.start();
  assert.equal(f.state.payload.input.task,'Find two suitable jobs using my existing résumé and preferences. Apply through the employers’ sites and verify that both applications were received.');
  assert.equal(f.state.payload.input.task,PROMPTS[2]);
  assert.equal(Object.hasOwn(f.state.payload.input,'goal'),false);assert.equal(Object.hasOwn(f.state.payload.input,'attachmentIds'),false);
  assert.equal(Object.hasOwn(f.state.payload.input,'context'),false);
});

test('lost admission response is reconciled by exact request identity without another POST',async t=>{
  const f=await fixture(t,{lostResponse:true});await f.runner.preflight();
  await assert.rejects(f.runner.start(),error=>error.code==='ADMISSION_UNKNOWN');
  assert.equal((await f.read('journal.json')).state,'admission_unknown');assert.equal(f.state.posts,1);
  const recovered=await new TrialRunner(f.config,f.dependencies).start();
  assert.equal(recovered.runId,RUN);assert.equal(f.state.posts,1);
  const journal=await f.read('journal.json');assert.equal(journal.runId,RUN);
  f.state.run.settled=true;f.state.run.status='completed';await f.runner.collect();assert.equal(f.state.posts,1);
});

test('absence from inspection never licenses re-admission after an uncertain response',async t=>{
  const f=await fixture(t,{lostResponse:true,missingRun:true});await f.runner.preflight();
  await assert.rejects(f.runner.start(),error=>error.code==='ADMISSION_UNKNOWN');
  const inspected=await f.runner.start();assert.equal(inspected.state,'admission_unknown');assert.equal(inspected.runId,null);
  assert.match(inspected.warning,/not proof of non-admission/);assert.equal(f.state.posts,1);
});

test('a failed readiness action never creates an admission intent or model request',async t=>{
  const f=await fixture(t,{openFailure:true});await f.runner.preflight();
  await assert.rejects(f.runner.start(),error=>error.code==='FRONTEND_FAILED');
  assert.equal(f.state.posts,0);
  await assert.rejects(fs.access(path.join(f.config.out,'admission.json')),error=>error.code==='ENOENT');
});

test('configuration and source drift are refused before admission',async t=>{
  const f=await fixture(t);await f.runner.preflight();
  await assert.rejects(new TrialRunner({...f.config,effort:'low'},f.dependencies).start(),error=>error.code==='CONFIG_MISMATCH');
  f.state.source='changed';
  await assert.rejects(f.runner.start(),error=>error.code==='PREFLIGHT_CHANGED');assert.equal(f.state.posts,0);
  assert.throws(()=>parseCLI(['start','--profile',f.config.profile,'--executable',f.config.executable,'--out',f.config.out,'--model','default','--effort','high']),/explicit model/);
});

test('exclusive admission intent prevents two simultaneous starts from producing two runs',async t=>{
  const f=await fixture(t);await f.runner.preflight();
  const outcomes=await Promise.allSettled([new TrialRunner(f.config,f.dependencies).start(),new TrialRunner(f.config,f.dependencies).start()]);
  assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);assert.equal(outcomes.filter(x=>x.status==='rejected').length,1);
  assert.equal(f.state.posts,1);
});

test('capture from another run is not archived as this attempt',async t=>{
  const f=await fixture(t,{wrongCapture:true});await f.runner.preflight();await f.runner.start();
  f.state.run.settled=true;f.state.run.status='completed';
  await assert.rejects(f.runner.collect(),error=>error.code==='CAPTURE_MISMATCH');
  await assert.rejects(fs.access(path.join(f.config.out,'capture.json')),error=>error.code==='ENOENT');
});

test('native frontend artifact decoding verifies exact bytes and extracts only the evaluation value',async t=>{
  const root=await fs.mkdtemp(path.join(tmpdir(),'blackice-runner-artifact-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const publicValue={runId:RUN,events:[{data:{text:'public result'}}]};
  const raw={success:true,contentItems:[{type:'inputText',text:JSON.stringify({target:'frontend',result:{result:{type:'object',value:publicValue}}})}]};
  assert.deepEqual(await decodeFrontendResult(raw,undefined,root),publicValue);
  const bytes=Buffer.from(JSON.stringify(raw)),artifactPath=path.join(root,'artifact.json');
  const wrapped={success:true,contentItems:[{type:'inputText',text:JSON.stringify({inline:false,artifact:{complete:true,path:artifactPath,bytes:bytes.length,sha256:sha256(bytes)}})}]};
  assert.deepEqual(await decodeFrontendResult(wrapped,async()=>bytes,root),publicValue);
  await assert.rejects(decodeFrontendResult(wrapped,async()=>Buffer.concat([bytes,Buffer.from(' ')]),root),error=>error.code==='ARTIFACT_CHANGED');
  const outside=JSON.parse(wrapped.contentItems[0].text);outside.artifact.path=path.join(path.dirname(root),'unowned.json');
  await assert.rejects(decodeFrontendResult({success:true,contentItems:[{type:'inputText',text:JSON.stringify(outside)}]},async()=>bytes,root),error=>error.code==='ARTIFACT_INVALID');
});

test('admission uses the actual native ordinary-Chat classifier and explicit separate mode controls',()=>{
  const payload=admissionRequest({attemptId:RUN,prompt:ordinary,config:{model:'gpt-6.2-astra',effort:'high'}},path.resolve('fixture-workspace'));
  assert.equal(ordinaryChatWorkflow(payload.workflow),true);
  assert.equal(payload.requestId,'jobsearch_'+RUN);
  assert.equal(payload.workflow.id,'mission_chat_'+RUN);
  assert.equal(payload.input.chatPlanning,'off');
  assert.equal(payload.input.directoryActions,'off');
  assert.equal(executionModesFrom(payload.input).directoryMode,'off');
});

test('stored manifest configuration is hash-checked before selecting the model',async t=>{
  const f=await fixture(t);await f.runner.preflight();
  const manifest=await f.read('manifest.json');manifest.config.model='different-model';
  await fs.writeFile(path.join(f.config.out,'manifest.json'),JSON.stringify(manifest));
  await assert.rejects(f.runner.start(),error=>error.code==='CONFIG_MISMATCH');assert.equal(f.state.posts,0);
});

test('cached opening receipt cannot admit after the actual observer stopped',async t=>{
  const f=await fixture(t,{failReadyCheckOnce:true});await f.runner.preflight();
  await assert.rejects(f.runner.start(),/Interrupted before fresh readiness read/);
  f.state.stopObserver();
  await assert.rejects(f.runner.start(),error=>error.code==='OBSERVER_NOT_READY');
  assert.equal(f.state.posts,0);
  await assert.rejects(fs.access(path.join(f.config.out,'admission.json')),error=>error.code==='ENOENT');
});

test('lost bind response is recovered through its original durable operation',async t=>{
  const f=await fixture(t,{loseBindOnce:true});await f.runner.preflight();
  await assert.rejects(f.runner.start(),/Lost bind response/);
  assert.equal((await f.read('journal.json')).runId,RUN);assert.equal(f.state.posts,1);
  const inspected=await f.runner.inspect();
  assert.equal(inspected.runId,RUN);assert.equal(f.state.bindRequests,2);assert.equal(f.state.posts,1);
  assert.ok((await f.read('journal.json')).operations.bind.jobId);
});

test('effective native mode drift prevents treating the run as the requested configuration',async t=>{
  const f=await fixture(t);await f.runner.preflight();await f.runner.start();
  f.state.run.chatPlanning='on';
  await assert.rejects(f.runner.inspect(),error=>error.code==='RUN_MISMATCH');assert.equal(f.state.posts,1);
});

test('an identical capture written before journal interruption is recovered without replacement',async t=>{
  const f=await fixture(t);await f.runner.preflight();await f.runner.start();
  f.state.run.settled=true;f.state.run.status='completed';const first=await f.runner.collect();
  const journal=await f.read('journal.json');delete journal.capture;journal.state='run-settled';
  await fs.writeFile(path.join(f.config.out,'journal.json'),JSON.stringify(journal));
  const recovered=await new TrialRunner(f.config,f.dependencies).collect();
  assert.equal(recovered.capture.sha256,first.capture.sha256);assert.equal(recovered.capture.reusedIdentical,true);
  assert.equal(f.state.posts,1);
});

const packageFixture = () => ({
  source:{name:'relay-agent-harness',version:'2.40.72',main:'desktop/main.mjs',type:'module',
    engines:{node:'>=22.23.5'},dependencies:{'runtime-library':'1.0.0'},
    scripts:{start:'node server.mjs'},devDependencies:{'electron-builder':'26.15.3'}},
  installed:{name:'relay-agent-harness',version:'2.40.72',main:'desktop/main.mjs',type:'module',
    engines:{node:'>=22.23.5'},dependencies:{'runtime-library':'1.0.0'}},
});
const packageBytes = value => Buffer.from(JSON.stringify(value,null,2)+'\n');

test('normal packaged manifest is accepted while both raw identities remain frozen',()=>{
  const {source,installed}=packageFixture(), candidate=packageBytes(source), packaged=packageBytes(installed);
  const receipt=productFileEvidence('package.json',candidate,packaged);
  assert.equal(receipt.candidate,sha256(candidate));assert.equal(receipt.installed,sha256(packaged));
  assert.notEqual(receipt.candidate,receipt.installed);
  assert.equal(receipt.comparison,'electron-builder-main-package');
  assert.deepEqual(receipt.removedCandidateFields,['scripts','devDependencies']);
  assert.equal(receipt.expectedPackageSha256,receipt.installedPackageSha256);
  source.scripts.start='node different-development-entry.mjs';
  const changed=productFileEvidence('package.json',packageBytes(source),packaged);
  assert.notEqual(changed.candidate,receipt.candidate);
  assert.notEqual(sha256(JSON.stringify(changed)),sha256(JSON.stringify(receipt)));
});

test('packaged manifest rejects retained-field, version, dependency, and unexpected-field drift',()=>{
  const {source,installed}=packageFixture(), candidate=packageBytes(source);
  for (const changed of [
    {...installed,version:'2.40.73'}, {...installed,main:'different.mjs'},
    {...installed,name:'another-product'}, {...installed,engines:{node:'>=24'}},
    {...installed,dependencies:{'runtime-library':'2.0.0'}},
    {...installed,unexpectedRuntimeField:true}, {...installed,devDependencies:{hidden:'1.0.0'}},
  ]) assert.throws(()=>productFileEvidence('package.json',candidate,packageBytes(changed)),error=>error.code==='SOURCE_MISMATCH');
  for (const invalid of ['not json','1','2','null','[]'])
    assert.throws(()=>productFileEvidence('package.json',candidate,Buffer.from(invalid)),error=>error.code==='SOURCE_MISMATCH');
});

test('actual product modules still require strict byte equality',()=>{
  const original=Buffer.from('export const value = 1;\n');
  const same=productFileEvidence('lib/chat-execution-review.mjs',original,Buffer.from(original));
  assert.equal(same.candidate,same.installed);
  assert.throws(()=>productFileEvidence('lib/chat-execution-review.mjs',original,Buffer.from('export const value=1;\n')),
    error=>error.code==='SOURCE_MISMATCH');
});
