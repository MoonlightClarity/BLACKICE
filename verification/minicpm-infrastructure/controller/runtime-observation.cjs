'use strict';
// Pure projection of independently captured runtime evidence. This module never
// loads a model, reads a clock/file, changes settings, or fills a gap from defaults.
const crypto=require('node:crypto'),path=require('node:path');
const {normalizeContextPublication}=require('./context-publication-observation.cjs');
const OBSERVATION_SCHEMA='blackice.minicpm.runtime-observation.v1';
const STARTUP_SCHEMA='blackice.minicpm.runtime-startup.v1';
const HASH=/^[a-f0-9]{64}$/;
const own=(o,k)=>o!==null&&typeof o==='object'&&Object.hasOwn(o,k);
const record=o=>o!==null&&typeof o==='object'&&!Array.isArray(o);
const text=v=>typeof v==='string'&&v.trim().length>0;
const integer=v=>Number.isSafeInteger(v)&&v>=0;
const positive=v=>integer(v)&&v>0;
const finite=v=>typeof v==='number'&&Number.isFinite(v);
const hash=v=>typeof v==='string'&&HASH.test(v);
const absolute=v=>typeof v==='string'&&/^[A-Za-z]:[\\/]/.test(v)&&path.win32.isAbsolute(v);
const samePath=(a,b)=>absolute(a)&&absolute(b)&&path.win32.normalize(a).toLowerCase()===path.win32.normalize(b).toLowerCase();
const timestamp=v=>typeof v==='string'&&Number.isFinite(Date.parse(v))&&new Date(Date.parse(v)).toISOString()===v?Date.parse(v):null;
function canonical(v){
 if(v===null||typeof v==='boolean'||typeof v==='string')return JSON.stringify(v);
 if(finite(v))return JSON.stringify(v);
 if(Array.isArray(v))return '['+v.map(canonical).join(',')+']';
 if(record(v))return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';
 throw TypeError('Evidence must contain finite JSON values.');
}
const digest=v=>crypto.createHash('sha256').update(canonical(v)).digest('hex');
const RUNTIME_FIELDS={
 ctxSize:positive,parallel:positive,threads:positive,threadsBatch:positive,
 batch:positive,ubatch:positive,cacheK:text,cacheV:text,gpuLayers:integer,
 flashAttention:v=>typeof v==='boolean',
};
const SAMPLING_FIELDS={
 seed:v=>integer(v)&&v<4294967295,temperature:v=>finite(v)&&v>=0,
 topK:integer,topP:v=>finite(v)&&v>=0&&v<=1,minP:v=>finite(v)&&v>=0&&v<=1,
};
const SAMPLING_KEYS={seed:'seed',temperature:'temperature',topK:'top_k',topP:'top_p',minP:'min_p'};
/**
 * Input:
 * {now,maxEvidenceAgeMs,modelId,
 *  modelIdentity:{at,path,sha256},
 *  bundleIdentity:{at,path,binarySha256,build},
 *  processIdentity:{at,pid,startedAt,executablePath,binarySha256},
 *  configSnapshot:{at,revision,process:{owned,appliedRevision,pendingRestart,starting,stopping}},
 *  catalogResponse:{at,status,json:{data:[{id,status,meta?}]}},
 *  propsResponse:{at,status,json:{model_alias,model_path,build_info,is_sleeping,
 *    total_slots,default_generation_settings:{n_ctx,params},
 *    blackice_runtime:{startupId,pid,processStartedAt}}},
 *  startupReceipt:{schema,id,at,observedAt,pid,processStartedAt,modelId,modelPath,
 *    modelSha256,binarySha256,build,complete,droppedEvents,runtime,fieldSources}}.
 * startup.at is context initialization time; observedAt is the fresh host read.
 * fieldSources entries are {kind:'runtime-getter'|'runtime-internal'|'runtime-log',detail}.
 * Host file hashes may enrich the native receipt, but must be independently read
 * and tied to this exact process/context. Do not relabel launch requests as getters.
 * currentPublication binds preserved contextPrefix/startupArtifact references and
 * a second awake props response. The second argument must supply independently
 * read {contextPrefixBytes,startupArtifactBytes}; reference-only callers fail.
 * Returned conditions are only the model/runtime/sampling/config fragment; the
 * campaign requires independent source, instruction, tool, mode and context data.
 */
function normalizeRuntimeObservation(input,raw={}){
 input=record(input)?input:{};
 const missing=[],conflicts=[],provenance={observations:{},fields:{}},times=[];
 const conditions={
  model:{path:null,sha256:null},
  runtime:{loaded:null,binarySha256:null,build:null,...Object.fromEntries(Object.keys(RUNTIME_FIELDS).map(k=>[k,null]))},
  sampling:Object.fromEntries(Object.keys(SAMPLING_FIELDS).map(k=>[k,null])),
  config:{savedRevision:null,appliedRevision:null,pendingRestart:null},
 };
 const issue=(field,code,observed,expected,conflict=false)=>{
  (conflict?conflicts:missing).push({field,code,observed:observed===undefined?null:observed,...(expected===undefined?{}:{expected})});
  return false;
 };
 const now=timestamp(input.now),age=input.maxEvidenceAgeMs;
 const clock=now!==null&&positive(age);
 if(!clock)issue('clock','explicit-clock-and-age-required',{now:input.now??null,maxEvidenceAgeMs:age??null});
 const stamp=(name,value,key='at',fresh=true)=>{
  if(!record(value))return issue(name,'missing-observation',value);
  const at=timestamp(value[key]);
  if(at===null)return issue(name+'.'+key,'invalid-timestamp',value[key]);
  let valid=true;
  if(!clock)valid=false;
  else if(at>now)valid=issue(name+'.'+key,'future-observation',value[key],input.now);
  else if(fresh&&now-at>age)valid=issue(name+'.'+key,'stale-observation',value[key],'age <= '+age+' ms');
  try{provenance.observations[name]={at:value[key],canonicalSha256:digest(value)};}
  catch(error){valid=issue(name,'non-json-evidence',error.message);}
  if(valid&&fresh)times.push(at);
  return valid;
 };
 const set=(group,key,value,sources)=>{
  conditions[group][key]=value;
  provenance.fields[group+'.'+key]=sources.map(source=>({observation:source,at:provenance.observations[source]?.at??null}));
 };
 const match=(field,a,b,valid=text,eq=(x,y)=>x===y)=>{
  if(!valid(a)||!valid(b))return issue(field,'missing-or-invalid-identity',{observed:a??null,expected:b??null});
  return eq(a,b)||issue(field,'identity-conflict',a,b,true);
 };
 const model=input.modelIdentity,bundle=input.bundleIdentity,proc=input.processIdentity,config=input.configSnapshot;
 let modelOK=stamp('modelIdentity',model),bundleOK=stamp('bundleIdentity',bundle),procOK=stamp('processIdentity',proc),configOK=stamp('configSnapshot',config);
 if(!text(input.modelId))issue('modelId','missing-model-id',input.modelId);
 if(!absolute(model?.path)||!hash(model?.sha256))modelOK=issue('modelIdentity','invalid-file-identity',model);
 if(!absolute(bundle?.path)||!hash(bundle?.binarySha256)||!text(bundle?.build)||['auto','unknown'].includes(bundle?.build?.toLowerCase()))bundleOK=issue('bundleIdentity','invalid-binary-identity',bundle);
 const started=timestamp(proc?.startedAt);
 if(!positive(proc?.pid)||started===null||!absolute(proc?.executablePath)||!hash(proc?.binarySha256))procOK=issue('processIdentity','invalid-process-identity',proc);
 if(procOK&&started>timestamp(proc.at))procOK=issue('processIdentity.startedAt','process-start-after-observation',proc.startedAt,proc.at,true);
 if(procOK&&bundleOK){
  const sameExe=match('processIdentity.executablePath',proc.executablePath,bundle.path,absolute,samePath);
  const sameBinary=match('processIdentity.binarySha256',proc.binarySha256,bundle.binarySha256,hash);
  procOK=sameExe&&sameBinary;
 }
 if(configOK){
  if(!integer(config.revision))issue('config.savedRevision','missing-or-invalid',config.revision);else set('config','savedRevision',config.revision,['configSnapshot']);
  const s=config.process;
  if(!record(s)||s.owned!==true||s.starting!==false||s.stopping!==false)configOK=issue('config.process','owned-stable-process-required',s);
  if(!integer(s?.appliedRevision))configOK=issue('config.appliedRevision','missing-or-invalid',s?.appliedRevision);else set('config','appliedRevision',s.appliedRevision,['configSnapshot']);
  if(typeof s?.pendingRestart!=='boolean')configOK=issue('config.pendingRestart','missing-or-invalid',s?.pendingRestart);else set('config','pendingRestart',s.pendingRestart,['configSnapshot']);
  if(s?.pendingRestart===true)configOK=issue('config.pendingRestart','restart-pending',true,false,true);
  if(integer(config.revision)&&integer(s?.appliedRevision)&&config.revision!==s.appliedRevision)configOK=issue('config.appliedRevision','revision-conflict',s.appliedRevision,config.revision,true);
 }
 const cat=input.catalogResponse,props=input.propsResponse;
 let catOK=stamp('catalogResponse',cat),propsOK=stamp('propsResponse',props);
 if(cat?.status!==200||!Array.isArray(cat?.json?.data))catOK=issue('catalogResponse','successful-catalog-required',cat?.status);
 if(props?.status!==200||!record(props?.json))propsOK=issue('propsResponse','successful-model-props-required',props?.status);
 const rows=catOK?cat.json.data.filter(row=>row?.id===input.modelId):[];
 if(catOK&&rows.length!==1)catOK=issue('catalogResponse.model','exact-single-model-required',rows.length,1);
 const row=rows[0],status=typeof row?.status==='string'?row.status:row?.status?.value;
 if(catOK&&status!=='loaded')catOK=issue('runtime.loaded','model-not-loaded',status,'loaded');
 const p=props?.json;
 if(propsOK){
  if(p.role==='router')propsOK=issue('propsResponse','router-dummy-props',p.role);
  const alias=match('propsResponse.model_alias',p.model_alias,input.modelId);
  const file=match('propsResponse.model_path',p.model_path,model?.path,absolute,samePath);
  const build=match('propsResponse.build_info',p.build_info,bundle?.build);
  if(p.is_sleeping!==false)propsOK=issue('runtime.loaded','sleep-state-unresolved',p.is_sleeping,false);
  propsOK=propsOK&&alias&&file&&build;
 }
 const sr=input.startupReceipt;
 let startupOK=stamp('startupReceipt',sr,'observedAt');
 const nativeAt=timestamp(sr?.at);
 if(sr?.schema!==STARTUP_SCHEMA||!text(sr?.id)||sr?.complete!==true||sr?.droppedEvents!==0)
  startupOK=issue('startupReceipt','complete-startup-receipt-required',{schema:sr?.schema??null,id:sr?.id??null,complete:sr?.complete??null,droppedEvents:sr?.droppedEvents??null});
 if(nativeAt===null||started===null||nativeAt<started||nativeAt>timestamp(sr?.observedAt)||nativeAt>timestamp(props?.at))
  startupOK=issue('startupReceipt.at','context-time-not-bound',sr?.at);
 if(startupOK){
  const checks=[
   match('startupReceipt.pid',sr.pid,proc?.pid,positive),
   match('startupReceipt.processStartedAt',sr.processStartedAt,proc?.startedAt,v=>timestamp(v)!==null),
   match('startupReceipt.modelId',sr.modelId,input.modelId),
   match('startupReceipt.modelPath',sr.modelPath,model?.path,absolute,samePath),
   match('startupReceipt.modelSha256',sr.modelSha256,model?.sha256,hash),
   match('startupReceipt.binarySha256',sr.binarySha256,bundle?.binarySha256,hash),
   match('startupReceipt.build',sr.build,bundle?.build),
   match('propsResponse.blackice_runtime.startupId',p?.blackice_runtime?.startupId,sr.id),
   match('propsResponse.blackice_runtime.pid',p?.blackice_runtime?.pid,sr.pid,positive),
   match('propsResponse.blackice_runtime.processStartedAt',p?.blackice_runtime?.processStartedAt,sr.processStartedAt,v=>timestamp(v)!==null),
  ];
  startupOK=checks.every(Boolean);
 }
 const publication=normalizeContextPublication(input,raw);
 provenance.currentPublication=publication;
 missing.push(...publication.missing.map(row=>({...row,field:'currentPublication.'+row.field})));
 conflicts.push(...publication.conflicts.map(row=>({...row,field:'currentPublication.'+row.field})));
 if(publication.complete)times.push(timestamp(input.currentPublication.contextSource.startedAt),timestamp(input.currentPublication.propsAfterResponse.at));
 const bound=modelOK&&bundleOK&&procOK&&catOK&&propsOK&&startupOK&&publication.complete;
 if(bound){
  set('model','path',model.path,['modelIdentity','startupReceipt','propsResponse']);
  set('model','sha256',model.sha256,['modelIdentity','startupReceipt']);
  set('runtime','loaded',true,['catalogResponse','propsResponse','processIdentity','startupReceipt']);
  set('runtime','binarySha256',bundle.binarySha256,['bundleIdentity','processIdentity','startupReceipt']);
  set('runtime','build',p.build_info,['propsResponse','startupReceipt','bundleIdentity']);
 }
 for(const[key,valid]of Object.entries(RUNTIME_FIELDS)){
  const value=sr?.runtime?.[key],source=sr?.fieldSources?.[key];
  let ok=bound;
  if(!valid(value)||typeof value==='string'&&['auto','unknown','unloaded'].includes(value.toLowerCase()))
   ok=issue('runtime.'+key,'missing-effective-value',value);
  if(!record(source)||!['runtime-getter','runtime-internal','runtime-log'].includes(source.kind)||!text(source.detail))
   ok=issue('runtime.'+key,'missing-runtime-provenance',source);
  if(key==='ctxSize'&&bound){
   if(!positive(p.default_generation_settings?.n_ctx))ok=issue('runtime.ctxSize','missing-model-props-context',p.default_generation_settings?.n_ctx);
   else if(value!==p.default_generation_settings.n_ctx)ok=issue('runtime.ctxSize','context-conflict',value,p.default_generation_settings.n_ctx,true);
   if(positive(row?.meta?.n_ctx)&&value!==row.meta.n_ctx)ok=issue('runtime.ctxSize','catalog-context-conflict',value,row.meta.n_ctx,true);
  }
  if(key==='parallel'&&bound){
   if(!positive(p.total_slots))ok=issue('runtime.parallel','missing-model-props-slots',p.total_slots);
   else if(value!==p.total_slots)ok=issue('runtime.parallel','slot-conflict',value,p.total_slots,true);
  }
  if(ok){set('runtime',key,value,['startupReceipt',...(['ctxSize','parallel'].includes(key)?['propsResponse']:[])]);
   provenance.fields['runtime.'+key][0].method={kind:source.kind,detail:source.detail};}
 }
 for(const[key,valid]of Object.entries(SAMPLING_FIELDS)){
  const value=p?.default_generation_settings?.params?.[SAMPLING_KEYS[key]];
  if(!valid(value))issue('sampling.'+key,key==='seed'&&[-1,4294967295].includes(value)?'random-seed':'missing-effective-value',value);
  else if(bound)set('sampling',key,value,['propsResponse']);
 }
 // A failed identity prevents unbound data from accidentally looking complete.
 if(!bound)issue('runtime.binding','model-process-context-binding-incomplete',null);
 if(!configOK)issue('config.binding','configuration-not-applied',null);
 const complete=missing.length===0&&conflicts.length===0;
 return {schema:OBSERVATION_SCHEMA,at:times.length?new Date(Math.min(...times)).toISOString():null,
  checkedAt:clock?input.now:null,conditions,provenance,missing,conflicts,complete};
}
module.exports={OBSERVATION_SCHEMA,STARTUP_SCHEMA,normalizeRuntimeObservation};
