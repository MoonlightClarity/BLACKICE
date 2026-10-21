/**
 * Opt-in acceptance check using the authenticated native model, real control
 * tools, real scheduler/inbox and a separate worker in an isolated profile.
 * Usage: node scripts/verify-operations-runtime.mjs --live [--output-dir ABSOLUTE_FRESH_PATH]
 */
import {EventEmitter} from 'node:events';
import {mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID,randomInt} from 'node:crypto';
import {CodexRuntime} from '../lib/codex.mjs';
import {createHarnessServer} from '../server.mjs';

const args=process.argv.slice(2),directoryIndex=args.indexOf('--output-dir'),requestedDirectory=directoryIndex<0?null:args[directoryIndex+1];
if(!args.includes('--live')||args.some((arg,index)=>!['--live','--output-dir'].includes(arg)&&!(directoryIndex>=0&&index===directoryIndex+1))||directoryIndex>=0&&(!requestedDirectory||!path.isAbsolute(requestedDirectory))){
 console.error('This opt-in check uses real signed-in model calls. Usage: node scripts/verify-operations-runtime.mjs --live [--output-dir ABSOLUTE_FRESH_PATH]');process.exit(2);
}
// A requested directory must be new: old proof files cannot satisfy this run.
const outputDir=requestedDirectory||await mkdtemp(path.join(tmpdir(),'blackice-operations-live-'));
if(requestedDirectory)await mkdir(outputDir,{recursive:false});
const cwd=path.join(outputDir,'workspace'),dataDir=path.join(outputDir,'profile'),receiptFile=path.join(outputDir,'operations-live-receipt.json');await mkdir(cwd,{recursive:true});
const model='gpt-6.1-sol',seed={token:randomUUID(),first:randomInt(10,1000),second:randomInt(10,1000)},idempotencyKey='operations-live-'+randomUUID(),payloadInput='One isolated operation acceptance request.';
await writeFile(path.join(cwd,'seed.json'),JSON.stringify(seed));
const receipt={schema:1,live:true,model,startedAt:new Date().toISOString(),outputDir,cwd,dataDir,seed,idempotencyKey,passed:false,checks:{},calls:[],phases:[]};
class NoDesktop extends EventEmitter{status(){return{available:false,enabled:false};}async setEnabled(){return this.status();}}
const check=(name,passed)=>{receipt.checks[name]=Boolean(passed);if(!passed)throw Error('Live operations acceptance failed: '+name);};
let app,runtime,url,cookie,phase='initial',controllerId,deploymentId,jobId,receiptTail=Promise.resolve();
const saveReceipt=()=>receiptTail=receiptTail.catch(()=>{}).then(()=>writeFile(receiptFile,JSON.stringify(receipt,null,2)));
const progress=async(event,detail={})=>{const value={event,phase,at:new Date().toISOString(),...detail};receipt.phases.push(value);console.log(JSON.stringify(value));await saveReceipt();};
const parseResult=response=>{try{return JSON.parse(response.contentItems?.find(item=>item.type==='inputText')?.text);}catch{return null;}};
function newRuntime(){
 const native=new CodexRuntime({cwd,runTimeoutMs:180000,requestTimeoutMs:30000}),runAgent=native.runAgent.bind(native);
 native.runAgent=async options=>{
  const call={phase,model:options.model,startedAt:new Date().toISOString(),tools:[],nativeItems:[],events:[]};receipt.calls.push(call);await progress('model-start',{call:receipt.calls.length,model:options.model});
  try{
   const result=await runAgent({...options,onToolCall:async(tool,context)=>{
    let arguments_;try{arguments_=typeof tool.arguments==='string'?JSON.parse(tool.arguments):tool.arguments;}catch{arguments_=null;}
    const record={name:tool.name,arguments:arguments_,startedAt:new Date().toISOString()};call.tools.push(record);
    // Never permit this acceptance fixture to accidentally enable recurrence.
    if(tool.name==='relay_control'&&arguments_?.action==='deployment_save'&&(arguments_.deployment?.enabled!==false||arguments_.deployment?.limits?.maxIterations!==1||arguments_.deployment?.retry?.maxAttempts!==0||arguments_.deployment?.cwd!==cwd))throw Error('The live fixture must remain disabled, one-job bounded, and isolated.');
    const response=await options.onToolCall(tool,context);record.success=response.success;record.result=parseResult(response);record.finishedAt=new Date().toISOString();await progress('model-tool',{call:receipt.calls.indexOf(call)+1,name:tool.name,action:arguments_?.action,success:record.success});return response;
   },onEvent:event=>{
    if(event.type==='item'&&event.item?.type!=='reasoning')call.nativeItems.push({id:event.item?.id,type:event.item?.type,stage:event.stage});
    if(['thread','tool.result'].includes(event.type))call.events.push(event);options.onEvent?.(event);
   }});
   Object.assign(call,{finishedAt:new Date().toISOString(),output:result.output,threadId:result.threadId,usage:result.usage});await progress('model-finished',{call:receipt.calls.indexOf(call)+1});return result;
  }catch(error){call.error={message:error.message,code:error.code};call.finishedAt=new Date().toISOString();await saveReceipt();throw error;}
 };
 return native;
}
async function open(){
 runtime=newRuntime();const status=await runtime.start();receipt.runtime={connected:status.connected,authenticated:status.authenticated,version:status.version,defaultModel:status.defaultModel};check('authenticatedRuntime',status.connected&&status.authenticated);check('requestedModelAvailable',status.models.some(item=>(item.model||item.id)===model));
 app=await createHarnessServer({port:0,dataDir,defaultCwd:cwd,runtime,desktop:new NoDesktop(),autoAttachDesktop:false,signedBrowser:false,maxConcurrentRuns:1,showBrowserOS:async()=>({shown:false,focused:false,started:false})});
 await app.learning.updateSettings({mode:'manual'});await app.runtimeSettings.update({subagentsEnabled:false,defaultEffort:'low',runTimeoutMs:180000,verbosity:'concise'});url=await app.listen();const home=await fetch(url,{signal:AbortSignal.timeout(15000)});cookie=home.headers.get('set-cookie')?.split(';',1)[0];await home.arrayBuffer();check('isolatedServerSession',Boolean(cookie));
}
async function request(route,method='GET',value){
 const response=await fetch(new URL(route,url),{method,headers:{Cookie:cookie,...(value===undefined?{}:{'Content-Type':'application/json',Origin:url})},...(value===undefined?{}:{body:JSON.stringify(value)}),signal:AbortSignal.timeout(15000)}),data=await response.json();return{status:response.status,data};
}
async function api(route,method='GET',value){const result=await request(route,method,value);if(result.status<200||result.status>=300)throw Error(`${method} ${route}: ${result.status} ${result.data.error||JSON.stringify(result.data)}`);return result.data;}
async function until(test,label,timeout=200000){const deadline=Date.now()+timeout;while(Date.now()<deadline){const value=await test();if(value)return value;await new Promise(resolve=>setTimeout(resolve,250));}throw Error('Timed out waiting for '+label);}
const isTaskPlanning=tool=>tool.name==='relay_task'&&['read','describe','plan','step','checkpoint'].includes(tool.arguments?.action);
const workerInput='Use relay_task read/describe/plan/step/checkpoint for the default task outline and relay_workspace read and write for the requested files. Read actual seed.json from this working folder. Write proof.json with token exactly from seed.token, sum equal to seed.first + seed.second, and ready true. Then read actual proof.json again and check its token, sum and ready fields against seed.json. Do not use shell commands, native file changes, browser, desktop, email, relay_control, subagents or external services. Modify only proof.json. Finish with a concise report of the actual checked result.';
const workerWorkflow={id:'operations-worker-'+randomUUID(),name:'Live operation proof worker',nodes:[{id:'input',type:'input',name:'Request'},{id:'agent',type:'agent',name:'Operations proof worker',model,desktop:false,effort:'low',prompt:workerInput},{id:'output',type:'output',name:'Checked result'}],edges:[{source:'input',target:'agent'},{source:'agent',target:'output'}],settings:{cwd,maxParallel:1}};
const definition={name:'Live disabled cron acceptance '+randomUUID().slice(0,8),input:workerInput,cwd,workflow:workerWorkflow,attachmentIds:[],enabled:false,overlap:'queue',trigger:{type:'cron',expression:'0 9 * * 1-5',timezone:'America/New_York'},limits:{maxIterations:1,runForSeconds:null,endAt:null},retry:{maxAttempts:0,backoffSeconds:30}};
try{
 await saveReceipt();await open();await progress('server-ready');
 const controllerWorkflow={id:'operations-controller-'+randomUUID(),name:'Live operation controller',nodes:[{id:'input',type:'input',name:'Request'},{id:'agent',type:'agent',name:'Operations controller',model,desktop:false,effort:'low',prompt:'Keep the default task outline with relay_task read/describe/plan/step/checkpoint and configure the requested bounded operation through relay_control. Follow the exact requested sequence and finish immediately after queueing. Do not perform the worker task or wait for it.'},{id:'output',type:'output',name:'Admission receipt'}],edges:[{source:'input',target:'agent'},{source:'agent',target:'output'}],settings:{cwd,maxParallel:1}};
 const task=`This is an isolated live acceptance test. Use relay_task read/describe/plan/step/checkpoint for the default task outline and relay_control for the requested operation. Do not use native commands, file tools, browsers, desktop, subagents or HTTP endpoints. Call schedule_preview first with trigger ${JSON.stringify(definition.trigger)} and count 3, and inspect the returned upcoming dates. Then call deployment_save exactly ONCE with this exact deployment object: ${JSON.stringify(definition)}. Keep enabled FALSE: the cron must remain disabled. Inspect the returned deployment ID. Finally call deployment_run exactly ONCE using that returned ID, idempotencyKey ${JSON.stringify(idempotencyKey)}, and input ${JSON.stringify(payloadInput)}. After the queued job receipt, immediately end your turn with the deployment ID and job ID. Do NOT wait, poll, inspect jobs, resume operations, or do the worker task: the worker needs this same single agent slot after you finish.`;
 const controller=await api('/api/runs','POST',{workflow:controllerWorkflow,input:{cwd,task}});controllerId=controller.id;receipt.controllerRunId=controllerId;
 await until(()=>app.engine.getRun(controllerId).settled===true,'controller settlement');receipt.controller=app.engine.getRun(controllerId);check('controllerCompleted',receipt.controller.status==='completed');
 const controlCall=receipt.calls[0],controls=controlCall.tools.filter(tool=>tool.name==='relay_control'),previews=controls.filter(tool=>tool.arguments?.action==='schedule_preview'),saves=controls.filter(tool=>tool.arguments?.action==='deployment_save'),starts=controls.filter(tool=>tool.arguments?.action==='deployment_run');
 check('controllerUsedOnlyControlAndPlanningTools',controlCall.tools.every(tool=>tool.success===true&&(tool.name==='relay_control'||isTaskPlanning(tool))));check('previewSaveRunSequence',previews.length===1&&saves.length===1&&starts.length===1&&controls.indexOf(previews[0])<controls.indexOf(saves[0])&&controls.indexOf(saves[0])<controls.indexOf(starts[0]));
 check('actualCronPreviewReturned',previews[0].result?.occurrences?.length===3&&previews[0].result.trigger.expression==='0 9 * * 1-5'&&previews[0].result.trigger.timezone==='America/New_York');
 deploymentId=saves[0].result?.id;jobId=starts[0].result?.id;receipt.deploymentId=deploymentId;receipt.jobId=jobId;check('toolReturnedAdmissionReceipts',Boolean(deploymentId&&jobId)&&starts[0].arguments.id===deploymentId&&starts[0].arguments.idempotencyKey===idempotencyKey&&starts[0].arguments.input===payloadInput);
 await progress('controller-queued',{deploymentId,jobId});await until(()=>['completed','failed','cancelled','interrupted'].includes(app.operations.getJob(jobId).status),'worker settlement');
 const job=app.operations.getJob(jobId),deployment=app.operations.getDeployment(deploymentId);receipt.job=job;receipt.deployment=deployment;check('oneCompletedJobAndAttempt',job.status==='completed'&&job.attempts.length===1&&app.operations.snapshot().jobs.length===1);check('disabledCronAndFiniteLimitPreserved',deployment.enabled===false&&deployment.nextAt===null&&deployment.trigger.type==='cron'&&deployment.trigger.expression==='0 9 * * 1-5'&&deployment.trigger.timezone==='America/New_York'&&deployment.limits.maxIterations===1&&deployment.retry.maxAttempts===0&&deployment.admittedJobs===1&&deployment.limitStatus.reached===true);
 receipt.worker=app.engine.getRun(job.attempts[0].runId);check('actualWorkerCompleted',receipt.worker.status==='completed'&&receipt.worker.settled===true);
 check('twoModelCallsWithOneSlot',receipt.calls.length===2&&receipt.calls.every(call=>call.model===model)&&app.engine.executionStatus().capacity===1&&Date.parse(receipt.calls[1].startedAt)>=Date.parse(controlCall.finishedAt)&&receipt.calls[1].threadId!==controlCall.threadId);
 const workerCall=receipt.calls[1],workerTools=workerCall.tools,seedRead=workerTools.findIndex(tool=>tool.name==='relay_workspace'&&tool.arguments?.action==='read'&&path.basename(tool.arguments.path||'')==='seed.json'&&tool.success),proofWrite=workerTools.findIndex(tool=>tool.name==='relay_workspace'&&tool.arguments?.action==='write'&&path.basename(tool.arguments.path||'')==='proof.json'&&tool.success),proofRead=workerTools.findIndex((tool,index)=>index>proofWrite&&tool.name==='relay_workspace'&&tool.arguments?.action==='read'&&path.basename(tool.arguments.path||'')==='proof.json'&&tool.success);
 check('workerUsedActualReadWriteRead',seedRead>=0&&proofWrite>seedRead&&proofRead>proofWrite&&workerTools.every(tool=>tool.success===true&&(tool.name==='relay_workspace'&&['read','write'].includes(tool.arguments?.action)||isTaskPlanning(tool))));
 check('noNativeCommandsOrFileEdits',receipt.calls.every(call=>call.nativeItems.every(item=>!['commandExecution','fileChange','mcpToolCall','webSearch'].includes(item.type))));
 const proof=JSON.parse(await readFile(path.join(cwd,'proof.json'),'utf8'));receipt.proof=proof;check('randomFileTokenAndCalculationMatch',proof.token===seed.token&&proof.sum===seed.first+seed.second&&proof.ready===true);
 const replay=await api(`/api/operations/deployments/${deploymentId}/trigger`,'POST',{idempotencyKey,payload:{input:payloadInput}});check('identicalDeliveryReturnsOriginalJob',replay.id===jobId&&replay.attempts.length===1&&app.operations.snapshot().jobs.length===1);
 const rejected=await request(`/api/operations/deployments/${deploymentId}/trigger`,'POST',{idempotencyKey:idempotencyKey+'-new',payload:{input:payloadInput}});receipt.limitRejection=rejected;check('newDeliveryRejectedByLifetimeLimit',rejected.status===409&&/Stopped after 1/.test(rejected.data.error||''));
 await app.operations.poll();check('receiptReplayStartsNoModelCalls',receipt.calls.length===2&&app.operations.getJob(jobId).attempts.length===1);const beforeRestart=app.operations.getJob(jobId);await progress('verified-before-restart');
 await app.close();app=null;runtime=null;phase='restart';await open();const restored=await api('/api/operations');receipt.restart={status:restored.status,job:app.operations.getJob(jobId),deployment:app.operations.getDeployment(deploymentId)};
 check('restartPausesOperations',restored.status.paused===true);check('restartPreservesCompletedReceipt',JSON.stringify(receipt.restart.job)===JSON.stringify(beforeRestart)&&restored.jobs.length===1&&receipt.restart.deployment.enabled===false);
 const restoredReplay=await api(`/api/operations/deployments/${deploymentId}/trigger`,'POST',{idempotencyKey,payload:{input:payloadInput}});await app.operations.poll();check('restartReplayReturnsOriginalWithoutExecution',restoredReplay.id===jobId&&app.operations.getJob(jobId).attempts.length===1&&receipt.calls.length===2&&app.engine.executions.size===0);
 receipt.passed=true;await progress('acceptance-passed');
}catch(error){receipt.error={message:error.message,code:error.code};process.exitCode=1;if(app){receipt.failureSnapshot=app.operations.snapshot();for(const id of app.engine.executions.keys())app.engine.cancelRun(id);await app.operations.pause('Live acceptance failed; inspect isolated receipts before any retry.').catch(()=>{});}}
finally{
 if(app)await app.close().catch(error=>{receipt.closeError=error.message;receipt.passed=false;process.exitCode=1;});else await runtime?.close().catch(()=>{});
 receipt.finishedAt=new Date().toISOString();await saveReceipt();console.log(JSON.stringify({event:'receipt',passed:receipt.passed,path:receiptFile,error:receipt.error}));
}
