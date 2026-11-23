// Source-bound paired MiniCPM long-read smoke: control vs experimental Directory harness.
// Uses same model, prompt, fixture, context and provider steps. All mutable effects
// stay in a unique temporary workspace/profile. This is exploratory, not a benchmark win-rate.
import {EventEmitter} from 'node:events';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const args=process.argv.slice(2),variant=args.find(x=>x.startsWith('--variant='))?.slice(10);
const revision=args.find(x=>x.startsWith('--revision='))?.slice(11)||'v1';
if(!['v1','v2'].includes(revision))throw Error('Expected --revision=v1 or v2.');
if(!['control','paging'].includes(variant))throw Error('Choose --variant=control or --variant=paging');
const candidateRoot=path.resolve(fileURLToPath(new URL('..',import.meta.url)));
const controlRoot='C:\\Users\\user\\Documents\\Codex\\BLACKICE-minicpm-post24075-fixes-20261122';
const sourceRoot=variant==='control'?controlRoot:candidateRoot;
const [{HarnessEngine},{ProviderRuntime},{createMissionWorkflow}]=await Promise.all([
  import(pathToFileURL(path.join(sourceRoot,'lib','engine.mjs')).href),
  import(pathToFileURL(path.join(sourceRoot,'lib','providers.mjs')).href),
  import(pathToFileURL(path.join(sourceRoot,'public','mission-model.mjs')).href)
]);
class NoNative extends EventEmitter{
  status(){return {connected:false,authenticated:false,models:[]};}
  async close(){}
  async runAgent(){throw Error('Native model fallback not permitted');}
}
const root=await mkdtemp(path.join(os.tmpdir(),'minicpm-directory-ab-'+variant+'-'));
const cwd=path.join(root,'workspace'),report=path.join(candidateRoot,'verification','minicpm-directory-ab-'+variant+'-'+revision+'-20261123.json');
const expected='CACHE_EPOCH_STALE_42';
const model='MiniCPM-V-4.7-1B-heretic-Q4_K_S',selection='local_llamacpp::'+model;
const lines=Array.from({length:300},(_,i)=>{
 const suffix=i===148?' ROOT_CAUSE_CODE: '+expected+' ; retry cache initialization':' ';
 return '['+String(i+1).padStart(4,'0')+'] '+('trace payload '+String(i%11)+' ').repeat(8)+suffix;
});
const log=lines.join('\n')+'\n';
let runtime,engine,runId,timeout=false,problem=null,reportData;
const toolInvocations=[];
const task=revision==='v2'
 ? 'Inspect the log at EXACT path '+JSON.stringify(path.join(cwd,'incident.log'))+'. First call relay_workspace with {action:"read",path:'+JSON.stringify(path.join(cwd,'incident.log'))+',startLine:1,lineCount:300}; do not search other paths. Find line starting ROOT_CAUSE_CODE: and report its exact code. If the tool returns an EXTERNAL CONTEXT RECORD, call relay_context_page search with needle "ROOT_CAUSE_CODE:" and then read at the resulting byte offset; do not infer a middle line from the preview. No writes or outside actions.'
 : 'Inspect incident.log in the current workspace. Find the line starting ROOT_CAUSE_CODE: and report its exact code. Use relay_workspace read with startLine 1 and lineCount 300 to see the full log. If the returned tool text is an EXTERNAL CONTEXT RECORD, use relay_context_page to search the reference for ROOT_CAUSE_CODE: and read the matching page before answering. Do not guess the code from the filename or preview. No writes or outside actions are needed.';
try{
 await mkdir(cwd);
 await writeFile(path.join(cwd,'incident.log'),log);
 runtime=await new ProviderRuntime({codex:new NoNative(),dataDir:path.join(root,'provider'),
   modelLimitResolver:{enrich:async(_config,models)=>models}}).init();
 await runtime.saveProvider({id:'local_llamacpp',type:'compatible',preset:'llamacpp',
   baseUrl:'http://127.0.0.1:8080/v1',
   models:[{id:model,contextWindowTokens:262144,maxOutputTokens:4096,supportsTools:true}],
   maxSteps:revision==='v2'?10:8},{preserveDefault:true});
 const originalRun=runtime.runAgent.bind(runtime);
 runtime.runAgent=options=>originalRun({...options,
   ...(options.onToolCall?{onToolCall:async (...callArgs)=>{
     const [call]=callArgs;
     let parsed={};try{parsed=typeof call.arguments==='string'?JSON.parse(call.arguments):call.arguments||{};}catch{}
     const output=await options.onToolCall(...callArgs);
     let pointer=false,partialText=false;
     try{const first=JSON.parse(output.contentItems?.find(x=>x.type==='inputText')?.text||'null');
       pointer=first?.externalContext===true;
       partialText=JSON.stringify(first||{}).includes(expected);
     }catch{}
     toolInvocations.push({tool:call.name,action:parsed.action||'call',
       path:typeof parsed.path==='string'?parsed.path.slice(0,240):null,
       success:output?.success,code:output?.code||null,
       externalContext:pointer,markerVisible:partialText});
     return output;
   }}:{})
 });
 engine=await new HarnessEngine({runtime,dataDir:path.join(root,'engine'),defaultCwd:cwd}).init();
 const workflow=createMissionWorkflow({
   task,model:selection,cwd,
   id:'chatgpt_mission_'+randomUUID().replaceAll('-',''),planningMode:'off',
   context:{preset:'custom',windowTokens:65536,autoCompact:false,
     outputReserveTokens:4096,headroomTokens:4096}
 });
 const start=engine.startRun({workflow,input:{task,cwd,directoryActions:'off',
   chatPlanning:'off',pastChats:'off',directoryMode:'off'}});
 runId=start.id;
 let timer;
 try{
  await Promise.race([engine.executions.get(runId),new Promise((_,reject)=>{
    timer=setTimeout(()=>reject(Error('AB_BOUNDED_TIMEOUT')),85000);
  })]);
 }catch(error){problem=error.message;timeout=problem==='AB_BOUNDED_TIMEOUT';
   if(timeout)engine.cancelRun(runId);
 }finally{clearTimeout(timer);}
 const run=engine.getRun(runId),node=run?.nodes?.agent||{};
 const events=(run.events||[]).map(x=>x.data||x);
 const tools=events.filter(x=>x.type==='item'&&x.item?.type==='dynamicToolCall'&&x.stage==='completed')
   .map(x=>({tool:x.item?.tool,action:x.item?.action,status:x.item?.status,success:x.item?.success}));
 const providerThread=node.threadId?path.join(root,'provider','provider-threads',node.threadId+'.json'):null;
 let lastAssistant=[],traceIssue;
 if(providerThread)try{
  const thread=JSON.parse(await readFile(providerThread,'utf8'));
  lastAssistant=thread.messages.filter(row=>row.role==='assistant'&&typeof row.content==='string')
    .map(row=>row.content.slice(0,700)).slice(-4);
 }catch(error){traceIssue=error.message;}
 const output=String(node.output||run.output||'');
 const finalEvidence=output||lastAssistant.at(-1)||'';
 const pageCalls=tools.filter(row=>row.tool==='relay_context_page').length;
 const originalHash=createHash('sha256').update(log).digest('hex');
 reportData={variant,revision,sourceRoot,model:selection,runId,runStatus:run.status,
   errorCode:node.errorCode||run.errorCode||null,error:run.error||problem,
   outcomeAssessment:node.outcomeAssessment||null,toolSummary:node.toolSummary||null,
   toolCount:toolInvocations.length,tools:toolInvocations,pageCalls:toolInvocations.filter(x=>x.tool==='relay_context_page').length,task,sourceSha256:originalHash,
   output:output.slice(0,1400),assistantHistory:lastAssistant,
   independentCodeMatch:finalEvidence.includes(expected),
   fullSuccess:run.status==='completed'&&finalEvidence.includes(expected),
   timeout,traceIssue,
   finishedAt:new Date().toISOString()};
 await writeFile(report,JSON.stringify(reportData,null,2)+'\n',{flag:'wx'});
 console.log('MINICPM_DIRECTORY_AB '+JSON.stringify({variant,status:reportData.runStatus,
   fullSuccess:reportData.fullSuccess,match:reportData.independentCodeMatch,
   errorCode:reportData.errorCode,toolCount:reportData.toolCount,
   pageCalls:reportData.pageCalls,review:reportData.outcomeAssessment,output:reportData.output.slice(0,600),
   lastAssistant:lastAssistant.at(-1),report}));
}catch(error){
 console.error('MINICPM_DIRECTORY_AB_ERROR '+JSON.stringify({variant,code:error.code||null,message:error.message}));
 process.exitCode=9;
}finally{
 if(engine)await engine.close().catch(()=>{});
 if(runtime)await runtime.close().catch(()=>{});
 await rm(root,{recursive:true,force:true}).catch(()=>{});
}
