'use strict';
const {createHash}=require('node:crypto');
const path=require('node:path');
const PROFILE_SCHEMA='blackice.minicpm.runtime-parity-profile.v1';
const RUN_SCHEMA='blackice.minicpm.runtime-parity-run.v1';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const fail=(message,code='PARITY_INVALID')=>Object.assign(new Error(message),{code});
const insist=(condition,message,code)=>{if(!condition)throw fail(message,code);};
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const object=x=>x&&typeof x==='object'&&!Array.isArray(x);
function exactKeys(value,keys,label){insist(object(value),label+' must be an object.');insist(same(Object.keys(value).sort(),keys.slice().sort()),label+' has missing or unknown keys.');}
function validateProfile(p){
 exactKeys(p,['schema','modelAlias','runtime','sampling','requests','limits','trace'],'profile');
 insist(p.schema===PROFILE_SCHEMA,'Unknown parity profile schema.');
 insist(typeof p.modelAlias==='string'&&/^[a-z0-9_-]{1,64}$/.test(p.modelAlias),'Invalid model alias.');
 const required={ctxSize:262144,parallel:1,threads:6,threadsBatch:6,batch:2048,ubatch:512,gpuLayers:25,cacheK:'q8_0',cacheV:'q8_0',flashAttention:'on',jinja:true};
 exactKeys(p.runtime,Object.keys(required),'runtime');
 for(const [k,v] of Object.entries(required))insist(p.runtime[k]===v,'This parity contract requires runtime.'+k+' = '+v);
 const sampling={seed:1234,temperature:0.8,topK:40,topP:0.95,minP:0.05};
 exactKeys(p.sampling,Object.keys(sampling),'sampling');
 for(const [k,v] of Object.entries(sampling))insist(p.sampling[k]===v,'This parity contract requires sampling.'+k+' = '+v);
 exactKeys(p.requests,['completionPredict','toolPredict','answerPredict','cachePrompt','enableThinking'],'requests');
 for(const k of ['completionPredict','toolPredict','answerPredict'])insist(Number.isInteger(p.requests[k])&&p.requests[k]>=8&&p.requests[k]<=128,'Prediction bound must be 8..128.');
 insist(p.requests.cachePrompt===true&&p.requests.enableThinking===false,'This bounded transport parity profile requires caching and explicitly disabled thinking.');
 exactKeys(p.limits,['totalMs','startupMs','requestMs','cleanupMs','postHashMs','responseBytes','logBytes'],'limits');
 for(const [k,v] of Object.entries(p.limits))insist(Number.isSafeInteger(v)&&v>0,'Positive integer limit required: '+k);
 insist(p.limits.totalMs<=105000&&p.limits.totalMs>=30000,'Total deadline must be 30000..105000 ms.');
 insist(p.limits.cleanupMs>=5000&&p.limits.postHashMs>=5000&&p.limits.startupMs<p.limits.totalMs-p.limits.cleanupMs-p.limits.postHashMs,'Deadline reserves are invalid.');
 exactKeys(p.trace,['tensorSelection','maxBytes','logitVectorSteps'],'trace');
 insist(same(p.trace.tensorSelection,['attn_norm','attn_post_norm','ffn_out','l_out']),'Unexpected tensor selection.');
 insist(p.trace.maxBytes===268435456&&p.trace.logitVectorSteps===8,'Unexpected native trace bounds.');
 return structuredClone(p);
}
function buildArgv(profile,{model,port,slotDirectory}){
 const p=validateProfile(profile),r=p.runtime,s=p.sampling;
 insist(path.isAbsolute(model),'Absolute model path required.');insist(typeof slotDirectory==='string'&&path.isAbsolute(slotDirectory),'Absolute owned slot directory required for the erase endpoint.');insist(Number.isInteger(port)&&port>=1024&&port<=65535,'Explicit unprivileged port required.');
 return ['--model',model,'--host','127.0.0.1','--port',String(port),'--alias',p.modelAlias,'--ctx-size',String(r.ctxSize),
 '--parallel',String(r.parallel),'--threads',String(r.threads),'--threads-batch',String(r.threadsBatch),
 '--batch-size',String(r.batch),'--ubatch-size',String(r.ubatch),'--n-gpu-layers',String(r.gpuLayers),
 '--flash-attn',r.flashAttention,'--cache-type-k',r.cacheK,'--cache-type-v',r.cacheV,
 '--seed',String(s.seed),'--temp',String(s.temperature),'--top-k',String(s.topK),'--top-p',String(s.topP),'--min-p',String(s.minP),
 '--fit','off','--cache-ram','0','--slots','--slot-save-path',slotDirectory,'--jinja','--no-webui','--log-colors','off','--log-verbosity','4'];
}
function sampling(p){return {seed:p.sampling.seed,temperature:p.sampling.temperature,top_k:p.sampling.topK,top_p:p.sampling.topP,min_p:p.sampling.minP};}
function completionBody(p){return {prompt:'Choose the next word in this sequence: alpha, beta, gamma, ',grammar:'root ::= "alpha" | "beta" | "gamma" | "delta"',n_predict:p.requests.completionPredict,stream:false,return_tokens:true,cache_prompt:true,...sampling(p)};}
function toolBody(p){
 return {model:p.modelAlias,messages:[
 {role:'system',content:'Use the supplied tool exactly once. After its result, reply with the returned value only.'},
 {role:'user',content:'Call parity_echo with value parity-ok.'}],
 tools:[{type:'function',function:{name:'parity_echo',description:'Return the supplied value unchanged.',parameters:{type:'object',properties:{value:{type:'string',enum:['parity-ok']}},required:['value'],additionalProperties:false}}}],
 tool_choice:{type:'function',function:{name:'parity_echo'}},parallel_tool_calls:false,stream:true,stream_options:{include_usage:true},
 max_tokens:p.requests.toolPredict,cache_prompt:true,chat_template_kwargs:{enable_thinking:false},...sampling(p)};
}
function parseSSE(bytes){
 const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes),events=[];let done=0;
 for(const frame of text.split(/\r?\n\r?\n/)){
  if(!frame.trim())continue;
  const data=frame.split(/\r?\n/).filter(x=>x.startsWith('data:')).map(x=>x.slice(5).replace(/^ /,'')).join('\n');
  if(!data)continue;
  insist(done===0,'SSE data followed the terminal marker.','PARITY_PROTOCOL');
  if(data==='[DONE]'){done++;continue;}
  let value;try{value=JSON.parse(data);}catch{throw fail('Invalid SSE JSON.','PARITY_PROTOCOL');}
  insist(object(value)&&!value.error,'SSE returned an error or non-object.','PARITY_PROTOCOL');events.push(value);
 }
 insist(done===1,'SSE ended without one terminal marker.','PARITY_PROTOCOL');
 return events;
}
function collectChat(bytes){
 const events=parseSSE(bytes),ids=[],calls=new Map(),message={role:'assistant',content:''};let finishReason=null,usage=null;
 for(const event of events){
  if(event.id!==undefined){insist(typeof event.id==='string'&&event.id,'Missing stream response ID.');if(!ids.includes(event.id))ids.push(event.id);}
  if(event.usage)usage=event.usage;
  insist(event.choices===undefined||Array.isArray(event.choices),'Invalid choices.');
  for(const choice of event.choices||[]){
   insist(choice.index===0||choice.index===undefined,'Unexpected parallel choice.');
   if(choice.finish_reason!==null&&choice.finish_reason!==undefined){insist(finishReason===null||finishReason===choice.finish_reason,'Conflicting finish reasons.');finishReason=choice.finish_reason;}
   const d=choice.delta||{};
   for(const key of ['content','reasoning_content','reasoning']){
    if(d[key]!==undefined&&d[key]!==null){insist(typeof d[key]==='string','Non-text delta: '+key);message[key]=(message[key]||'')+d[key];}
   }
   if(d.reasoning_details!==undefined)throw fail('Unimplemented reasoning_details cannot silently be dropped.','PARITY_PROTOCOL');
   for(const piece of d.tool_calls||[]){
    insist(Number.isInteger(piece.index)&&piece.index>=0,'Missing tool-call index.');
    const c=calls.get(piece.index)||{id:'',type:'function',function:{name:'',arguments:''}};
    if(piece.id){insist(!c.id||c.id===piece.id,'Conflicting tool-call ID.');c.id=piece.id;}
    if(piece.type)insist(piece.type==='function','Unexpected tool type.');
    if(piece.function?.name)c.function.name+=piece.function.name;
    if(piece.function?.arguments)c.function.arguments+=piece.function.arguments;
    calls.set(piece.index,c);
   }
  }
 }
 insist(ids.length===1,'Expected one actual stream response ID.','PARITY_PROTOCOL');
 insist(typeof finishReason==='string'&&finishReason!=='length','Missing or truncated chat completion.','PARITY_TRUNCATED');
 if(calls.size)message.tool_calls=[...calls.entries()].sort((a,b)=>a[0]-b[0]).map(x=>x[1]);
 const cached=usage?.prompt_tokens_details?.cached_tokens;
 insist(Number.isSafeInteger(cached)&&cached>=0,'Chat cache reuse counter is missing.','PARITY_CACHE_UNKNOWN');
 return {events,responseId:ids[0],message,finishReason,usage,cachedPromptTokens:cached,streamTokenIds:{available:false,reason:'The stock compatible SSE stream does not expose native sampled token IDs.'}};
}
function executeTool(p,first){
 insist(first.finishReason==='tool_calls','First chat response did not complete a tool call.','PARITY_TOOL_CYCLE');
 const calls=first.message.tool_calls;insist(Array.isArray(calls)&&calls.length===1,'Exactly one tool call is required.','PARITY_TOOL_CYCLE');
 const call=calls[0];insist(typeof call.id==='string'&&call.id&&call.function.name==='parity_echo','Unexpected tool call.','PARITY_TOOL_CYCLE');
 let args;try{args=JSON.parse(call.function.arguments);}catch{throw fail('Tool arguments are not complete JSON.','PARITY_TOOL_CYCLE');}
 insist(object(args)&&same(Object.keys(args),['value'])&&args.value==='parity-ok','Tool arguments violate the public tool schema.','PARITY_TOOL_CYCLE');
 const alias='call_parity_echo_0',assistant=structuredClone(first.message);assistant.tool_calls[0].id=alias;
 const body=toolBody(p);body.messages.push(assistant,{role:'tool',tool_call_id:alias,content:args.value});body.tool_choice='none';body.max_tokens=p.requests.answerPredict;
 return {body,result:args.value,idMapping:{kind:'tool-call',observed:call.id,alias,requestPaths:['messages[2].tool_calls[0].id','messages[3].tool_call_id']}};
}
function validateAnswer(result){insist(result.finishReason==='stop'&&!result.message.tool_calls?.length&&typeof result.message.content==='string'&&/\S/.test(result.message.content),'Tool continuation has no complete final text or contains an additional tool call.','PARITY_TOOL_CYCLE');return {expectedAnswer:'parity-ok',observedAnswer:result.message.content,exactExpectedAnswer:result.message.content==='parity-ok',meaning:'Instruction-adherence observation; separate from transport collection and exact output parity.'};}
function validateCompletion(v){
 insist(object(v)&&typeof v.content==='string'&&v.content.length>0,'Empty native completion.');
 insist(Array.isArray(v.tokens)&&v.tokens.length>0&&v.tokens.every(x=>Number.isSafeInteger(x)&&x>=0),'Native token IDs are missing or empty.','PARITY_TOKENS_UNKNOWN');
 insist(v.stop===true&&v.truncated===false&&['eos','word'].includes(v.stop_type),'Native completion is truncated or has an unknown terminal.','PARITY_TRUNCATED');
 const total=v.tokens_evaluated,processed=v.timings?.prompt_n;
 insist(Number.isSafeInteger(total)&&total>0&&Number.isSafeInteger(processed)&&processed>=0&&processed<=total,'Native prompt counters are missing.','PARITY_CACHE_UNKNOWN');
 return {content:v.content,tokens:v.tokens,stopType:v.stop_type,promptTokens:total,processedPromptTokens:processed,cachedPromptTokens:total-processed,
 cacheCounterProvenance:'tokens_evaluated (task prompt length) minus timings.prompt_n (processed prompt tokens); tokens_cached is retained raw and is not a reuse count.'};
}
function assessRuntime({profile,props,slots,model,startupLog}){
 const p=validateProfile(profile),r=p.runtime,issues=[],fields={},sources={};
 const check=(name,actual,expected,source)=>{fields[name]=actual;sources[name]=source;if(actual!==expected)issues.push({field:name,actual,expected});};
 check('ctxSize',props?.default_generation_settings?.n_ctx,r.ctxSize,'GET /props default_generation_settings.n_ctx');
 check('parallel',props?.total_slots,r.parallel,'GET /props total_slots');
 check('vision',props?.modalities?.vision,false,'GET /props modalities.vision');
 check('video',props?.modalities?.video,false,'GET /props modalities.video');
 check('modelAlias',props?.model_alias,p.modelAlias,'GET /props model_alias');
 check('modelPath',typeof props?.model_path==='string'?path.resolve(props.model_path):null,path.resolve(model),'GET /props model_path');
 if(!Array.isArray(slots)||slots.length!==1||slots[0].n_ctx!==r.ctxSize||slots[0].is_processing!==false)issues.push({field:'slots',actual:slots,expected:'one idle slot at 262144'});
 const params=props?.default_generation_settings?.params||{};
 for(const [name,key] of [['seed','seed'],['temperature','temperature'],['topK','top_k'],['topP','top_p'],['minP','min_p']]){
  const actual=params[key],expected=p.sampling[name];fields[name]=actual;sources[name]='GET /props default_generation_settings.params.'+key;
  if(actual!==expected&&actual!==Math.fround(expected))issues.push({field:name,actual,expected});
 }
 const patterns={
 threads:/\bn_threads\s*=\s*(\d+)/g,threadsBatch:/\bn_threads_batch\s*=\s*(\d+)/g,
 batch:/\bn_batch\s*=\s*(\d+)/g,ubatch:/\bn_ubatch\s*=\s*(\d+)/g,
 logCtx:/\bn_ctx_seq\s*=\s*(\d+)/g,logParallel:/\bn_seq_max\s*=\s*(\d+)/g,
 gpuLayers:/offloaded\s+(\d+)\/\d+\s+layers to GPU/g,
 cacheK:/\bK \(([^)]+)\):/g,cacheV:/\bV \(([^)]+)\):/g,
 flashAttention:/\bflash_attn\s*=\s*(\w+)/g};
 const expected={threads:r.threads,threadsBatch:r.threadsBatch,batch:r.batch,ubatch:r.ubatch,logCtx:r.ctxSize,logParallel:r.parallel,gpuLayers:r.gpuLayers,cacheK:r.cacheK,cacheV:r.cacheV,flashAttention:'enabled'};
 for(const [key,rx] of Object.entries(patterns)){
  const values=[...startupLog.matchAll(rx)].map(x=>/^\d+$/.test(x[1])?Number(x[1]):x[1]),unique=[...new Set(values)];
  fields[key]=unique.length===1?unique[0]:null;sources[key]={kind:'native-startup-log',matches:values};
  if(unique.length!==1||unique[0]!==expected[key])issues.push({field:key,actual:unique,expected:expected[key]});
 }
 return {complete:issues.length===0,fields,sources,issues,samplerParameters:params,chatTemplateSha256:typeof props?.chat_template==='string'?sha(props.chat_template):null,buildInfo:props?.build_info??null};
}
function chatProjection(chat){
 const message=structuredClone(chat.message),mappings=[{kind:'response',observed:chat.responseId,alias:'response_0'}];
 for(const [i,call] of (message.tool_calls||[]).entries()){mappings.push({kind:'tool-call',observed:call.id,alias:'call_'+i});call.id='call_'+i;}
 return {value:{message,finishReason:chat.finishReason},mappings};
}
function validEnvironmentEvidence(value){
 const h=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v),map=v=>object(v)&&Object.keys(v).length>0&&Object.values(v).every(h);
 return object(value)&&h(value.baseSha256)&&h(value.actualSha256)&&map(value.baseVariableHashes)&&map(value.actualVariableHashes);
}
function validTraceSnapshot(run){
 try{return typeof run.traceConfigPath==='string'&&(path.isAbsolute(run.traceConfigPath)||path.win32.isAbsolute(run.traceConfigPath))&&
  typeof run.traceConfigBytesUTF8==='string'&&sha(run.traceConfigBytesUTF8)===run.traceConfigEvidence?.sha256&&
  same(JSON.parse(run.traceConfigBytesUTF8),run.traceConfig)&&run.traceConfig?.enabled===true&&
  run.traceConfigPublication?.complete===true&&run.traceConfigPublication.path===run.traceConfigPath&&
  run.traceConfigPublication.published?.path===run.traceConfigPath&&run.traceConfigPublication.published.sha256===run.traceConfigEvidence.sha256;
 }catch{return false;}
}
function compareRuns(left,right,mode){
 const differences=[],checks={};const check=(name,a,b)=>{const ok=same(a,b);checks[name]=ok;if(!ok)differences.push({field:name,left:a,right:b});};
 insist(left?.schema===RUN_SCHEMA&&right?.schema===RUN_SCHEMA,'Only saved parity runs can be compared.');
 insist(['original-rebuilt','baseline-instrumented','activation-toggle'].includes(mode),'Explicit comparison mode required.');
 if(left.complete!==true||right.complete!==true||left.collectionComplete!==true||right.collectionComplete!==true)return {schema:'blackice.minicpm.runtime-parity-comparison.v1',mode,complete:false,passed:false,status:'not-comparable',scorable:false,throughputClaim:false,reasons:[{side:'left',collectionComplete:left.collectionComplete===true,failures:left.failures||[]},{side:'right',collectionComplete:right.collectionComplete===true,failures:right.failures||[]}],differences:[],note:'An incomplete collection cannot establish output or numerical parity; absence of output is not labeled a model difference.'};
 check('runsComplete',left.complete&&right.complete,true);
 check('collectionComplete',left.collectionComplete===true&&right.collectionComplete===true,true);
 check('withinRunParityPassed',left.parityFindings?.passed===true&&right.parityFindings?.passed===true,true);
 check('modelHashesObserved',/^[a-f0-9]{64}$/.test(left.identity?.model?.after?.sha256||'')&&/^[a-f0-9]{64}$/.test(right.identity?.model?.after?.sha256||''),true);
 check('modelIdentity',left.identity?.model?.after?.sha256,right.identity?.model?.after?.sha256);
 const backend=x=>Array.isArray(x.loadedBackendModules)?x.loadedBackendModules.map(m=>({name:String(m.name).toLowerCase(),sha256:m.sha256})).sort((a,b)=>a.name.localeCompare(b.name)):null;
 const lb=backend(left),rb=backend(right);check('loadedMathBackendsObserved',Boolean(lb?.length&&rb?.length&&lb.every(x=>/^[a-f0-9]{64}$/.test(x.sha256||''))&&rb.every(x=>/^[a-f0-9]{64}$/.test(x.sha256||''))),true);check('loadedMathBackendHashes',lb,rb);
 check('profile',left.profile,right.profile);
 check('runtimeFields',left.runtime?.fields,right.runtime?.fields);
 check('samplerParameters',left.runtime?.samplerParameters,right.runtime?.samplerParameters);
 check('chatTemplateSha256',left.runtime?.chatTemplateSha256,right.runtime?.chatTemplateSha256);
 check('childEnvironmentSha256',left.childEnvironmentSha256,right.childEnvironmentSha256);
 let environmentEvidence=null;
 if(mode!=='original-rebuilt'){
  const a=left.childEnvironmentEvidence,b=right.childEnvironmentEvidence,observed=validEnvironmentEvidence(a)&&validEnvironmentEvidence(b);
  check('fullEnvironmentEvidenceObserved',observed,true);
  check('baseEnvironmentVariableHashes',a?.baseVariableHashes,b?.baseVariableHashes);
  check('baseEnvironmentPolicy',a?.policy,b?.policy);
  check('baseEnvironmentSourceSha256',a?.source?.sha256,b?.source?.sha256);
  const names=Array.from(new Set([...Object.keys(a?.actualVariableHashes||{}),...Object.keys(b?.actualVariableHashes||{})])).sort();
  const variableDifferences=names.filter(name=>a?.actualVariableHashes?.[name]!==b?.actualVariableHashes?.[name]).map(name=>({name,leftSha256:a?.actualVariableHashes?.[name]??null,rightSha256:b?.actualVariableHashes?.[name]??null}));
  environmentEvidence={leftFullSha256:a?.actualSha256??null,rightFullSha256:b?.actualSha256??null,rawEnvironmentEqual:observed&&a.actualSha256===b.actualSha256&&variableDifferences.length===0,
   variableDifferences,declaredTreatment:mode==='baseline-instrumented'?'The sole allowed environment change is addition of BLACKICE_TRACE_CONFIG bound to the captured shared config path. Full raw environments are intentionally reported as different.':null};
 }
 if(mode==='activation-toggle'){
  check('sameExecutable',left.identity?.executable?.before?.sha256,right.identity?.executable?.before?.sha256);
  check('variants',[left.variant,right.variant],['instrumented-off','instrumented-on']);
  check('nativeCaptureComplete',Boolean(left.native?.complete&&right.native?.complete),true);
  check('activationFlags',[left.traceConfig?.activationCaptureEnabled,right.traceConfig?.activationCaptureEnabled],[false,true]);
  check('traceSnapshotsBound',validTraceSnapshot(left)&&validTraceSnapshot(right),true);
  check('sharedTraceConfigPath',left.traceConfigPath,right.traceConfigPath);
  check('sharedTraceOutputDirectory',left.traceConfig?.outputDirectory,right.traceConfig?.outputDirectory);
  check('fullEnvironmentIdentical',environmentEvidence.rawEnvironmentEqual,true);
  const a=structuredClone(left.traceConfig),b=structuredClone(right.traceConfig);if(a)a.activationCaptureEnabled=false;if(b)b.activationCaptureEnabled=false;check('onlyActivationToggle',a,b);
  const expectedOff=JSON.stringify({...left.traceConfig,activationCaptureEnabled:false},null,2)+'\n';
  const expectedOn=JSON.stringify({...left.traceConfig,activationCaptureEnabled:true},null,2)+'\n';
  check('exactOffConfigBytes',left.traceConfigBytesUTF8,expectedOff);check('exactOnConfigBytes',right.traceConfigBytesUTF8,expectedOn);
  check('onPublicationPreimage',right.traceConfigPublication?.previous?.sha256,left.traceConfigEvidence?.sha256);
 }else if(mode==='baseline-instrumented'){
  check('variants',[left.variant,right.variant],['rebuilt-io-compat-baseline','instrumented-off']);
  check('metadataNativeCaptureComplete',right.native?.complete===true,true);
  check('metadataActivationDisabled',right.traceConfig?.activationCaptureEnabled,false);
  check('metadataTraceSnapshotBound',validTraceSnapshot(right),true);
  const allowed=environmentEvidence.variableDifferences,expected=typeof right.traceConfigPath==='string'?sha(right.traceConfigPath):null;
  check('onlyBoundTraceEnvironmentAddition',allowed.length===1&&allowed[0].name==='BLACKICE_TRACE_CONFIG'&&allowed[0].leftSha256===null&&allowed[0].rightSha256===expected,true);
  check('rawEnvironmentDifferenceDisclosed',environmentEvidence.rawEnvironmentEqual,false);
 }else{insist(mode==='original-rebuilt','Explicit comparison mode required.');check('variants',[left.variant,right.variant],['original',right.variant==='rebuilt-io-compat-baseline'?'rebuilt-io-compat-baseline':'rebuilt-baseline']);}
 const wire=[],identityMappings=[];
 for(const name of ['completion-cold','completion-cached','chat-cold-call','chat-cold-answer','chat-cached-call','chat-cached-answer']){
  const a=left.probes?.[name],b=right.probes?.[name];
  if(!a||!b){check(name+'.present',Boolean(a),Boolean(b));differences.push({field:name,error:'Missing probe'});continue;}
  check(name+'.requestBodySha256',a.request.bodySha256,b.request.bodySha256);
  wire.push({name,leftSha256:a.response.bodySha256,rightSha256:b.response.bodySha256,rawBytesEqual:a.response.bodySha256===b.response.bodySha256});
  if(name.startsWith('completion')){check(name+'.tokensObserved',Boolean(Array.isArray(a.result.tokens)&&a.result.tokens.length&&a.result.tokens.every(x=>Number.isSafeInteger(x)&&x>=0)&&Array.isArray(b.result.tokens)&&b.result.tokens.length&&b.result.tokens.every(x=>Number.isSafeInteger(x)&&x>=0)),true);check(name+'.tokens',a.result.tokens,b.result.tokens);check(name+'.content',a.result.content,b.result.content);check(name+'.stopType',a.result.stopType,b.result.stopType);}
  else{const ap=chatProjection(a.result),bp=chatProjection(b.result);check(name+'.output',ap.value,bp.value);identityMappings.push({name,left:ap.mappings,right:bp.mappings});}
  if(mode==='activation-toggle'){
   const at=left.native?.tasks?.[name],bt=right.native?.tasks?.[name];check(name+'.nativeComplete',Boolean(at?.complete&&bt?.complete),true);
   check(name+'.promptTokenIds',at?.promptTokenIds,bt?.promptTokenIds);check(name+'.acceptedTokenIds',at?.acceptedTokenIds,bt?.acceptedTokenIds);
   check(name+'.sampledTokenIds',at?.sampledTokenIds,bt?.sampledTokenIds);check(name+'.rawLogitHashes',at?.rawLogitHashes,bt?.rawLogitHashes);
  }
 }
 return {schema:'blackice.minicpm.runtime-parity-comparison.v1',mode,complete:true,passed:differences.length===0,scorable:false,throughputClaim:false,
 scope:mode==='activation-toggle'?'Exact payload, native prompt/accepted/sampled token and captured full-logit equality; activation toggle only.':mode==='baseline-instrumented'?'I/O-compatible baseline versus native metadata recording with activation capture disabled. Exact native /completion tokens and structured chat output; the explicitly bound trace-config environment addition is disclosed.':'Exact native /completion token arrays and exact structured chat content/reasoning/tool calls. Stock chat native IDs unavailable.',
 runtimeLabels:{left:left.label??null,right:right.label??null},runtimeVariants:{left:left.variant,right:right.variant},rebuiltSourceScope:right.variant==='rebuilt-io-compat-baseline'?'The rebuilt baseline includes the explicit CRT filename I/O compatibility repair; it is not described as an unmodified rebuild.':null,
 wire,identityMappings,environmentEvidence,checks,differences,
 metadataPolicy:'Raw response bytes and all metadata remain in each run. Wire hashes are reported separately; output projections do not compare created timestamps or timing durations. No message text or argument text is stripped.'};
}
module.exports={PROFILE_SCHEMA,RUN_SCHEMA,sha,fail,insist,same,validateProfile,buildArgv,completionBody,toolBody,parseSSE,collectChat,executeTool,validateAnswer,validateCompletion,assessRuntime,chatProjection,compareRuns};
