'use strict';
// Pure condition validation. No filesystem, provider, process, tool, or clock reads.
// Manifest: {schema,maxEvidenceAgeMs,shared,arms:{original:{path,sha256},edited:{path,sha256}}}.
// Evidence: {schema,at,connectionId,manifestSha256,phase,arm,model,conditions};
// at is the earliest measurement used by the envelope. Continuation evidence binds
// runId/requestId and cannot predate admission. Final evidence also binds the initial
// adapter payloadSha256 and cannot predate settled collection or payload capture.
// Snapshots do not claim continuous observation between their measurement times.
// Full payload digests bind one run; shared instruction/tool policy digests compare arms.
const crypto=require('node:crypto'),path=require('node:path');
const MANIFEST_SCHEMA='blackice.minicpm.run-manifest.v1';
const EVIDENCE_SCHEMA='blackice.minicpm.condition-evidence.v1';
const HASH=/^[a-f0-9]{64}$/;
const record=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const text=v=>typeof v==='string'&&v.trim().length>0;
const integer=v=>Number.isSafeInteger(v)&&v>=0;
const positive=v=>integer(v)&&v>0;
const finite=v=>typeof v==='number'&&Number.isFinite(v);
const boolean=v=>typeof v==='boolean';
const hash=v=>typeof v==='string'&&HASH.test(v);
const absolute=v=>typeof v==='string'&&/^[A-Za-z]:[\\/]/.test(v)&&path.win32.isAbsolute(v);
const sameTools=v=>Array.isArray(v)&&v.length===2&&new Set(v).size===2&&v.includes('relay_workspace')&&v.includes('relay_directory_action');
const toolList=v=>Array.isArray(v)&&v.every(text)&&new Set(v).size===v.length;
const FIELDS=[
 ['source.appVersion',text],['source.sha256',hash],['source.stable',v=>v===true],
 ['instructions.coreSha256',hash],['instructions.selectedPolicySha256',hash],
 ['instructions.auditStage',v=>v==='adapter-prepared'],['instructions.auditStatus',v=>v==='accepted'],
 ['tools.names',toolList],['tools.schemaSha256',hash],
 ['modes.directoryActions',v=>['on','off'].includes(v),'on'],
 ['modes.directoryMode',v=>['on','off'].includes(v),'off'],
 ['modes.chatPlanning',v=>['on','off'].includes(v),'off'],
 ['modes.pastChats',v=>['on','off'].includes(v),'off'],
 ['context.windowTokens',positive],['context.autoCompact',boolean,false],
 ['context.outputReserveTokens',positive],['context.headroomTokens',integer],
 ['provider.maxTokens',positive],['provider.maxSteps',v=>v===null||positive(v)],
 ['runtime.loaded',v=>v===true],['runtime.binarySha256',hash],['runtime.build',text],
 ['runtime.ctxSize',positive],['runtime.cacheK',text],['runtime.cacheV',text],
 ['runtime.parallel',positive],['runtime.threads',positive],['runtime.threadsBatch',positive],
 ['runtime.batch',positive],['runtime.ubatch',positive],['runtime.gpuLayers',integer],
 ['runtime.flashAttention',boolean],
 ['sampling.seed',v=>integer(v)&&v<4294967295],
 ['sampling.temperature',v=>finite(v)&&v>=0],['sampling.topK',integer],
 ['sampling.topP',v=>finite(v)&&v>=0&&v<=1],['sampling.minP',v=>finite(v)&&v>=0&&v<=1],
 ['config.savedRevision',integer],['config.appliedRevision',integer],['config.pendingRestart',boolean,false]
];
const REQUIRED_PATHS=Object.freeze(FIELDS.map(([name])=>name));
function fail(message){throw new Error(message);}
function get(object,field){
 let value=object;for(const key of field.split('.')){if(!record(value)||!Object.hasOwn(value,key))return {present:false,value:undefined};value=value[key];}
 return {present:true,value};
}
function canonical(value){
 if(value===null||typeof value==='boolean'||typeof value==='string')return JSON.stringify(value);
 if(finite(value))return JSON.stringify(value);
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 if(record(value))return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';
 fail('Condition data must be finite JSON values');
}
const digest=value=>crypto.createHash('sha256').update(canonical(value)).digest('hex');
function leafPaths(value,prefix=''){
 if(!record(value))return [prefix];
 const keys=Object.keys(value);if(!keys.length)return [prefix];
 return keys.flatMap(k=>leafPaths(value[k],prefix?prefix+'.'+k:k));
}
function exactKeys(value,keys,label){
 if(!record(value)||JSON.stringify(Object.keys(value).sort())!==JSON.stringify([...keys].sort()))fail(label+' has missing or unsupported fields');
}
function timestamp(value){
 if(typeof value!=='string')return null;
 const n=Date.parse(value);return Number.isFinite(n)&&new Date(n).toISOString()===value?n:null;
}
function validateManifest(manifest){
 exactKeys(manifest,['schema','maxEvidenceAgeMs','shared','arms'],'Manifest');
 if(manifest.schema!==MANIFEST_SCHEMA||!positive(manifest.maxEvidenceAgeMs))fail('Invalid manifest schema or explicit evidence age');
 const leaves=leafPaths(manifest.shared).sort();
 if(JSON.stringify(leaves)!==JSON.stringify([...REQUIRED_PATHS].sort()))fail('Manifest shared conditions must contain every fixed required path and no optional substitutes');
 for(const [field,valid,fixed]of FIELDS){
  const observed=get(manifest.shared,field);
  if(!observed.present||!valid(observed.value)||(fixed!==undefined&&observed.value!==fixed))fail('Invalid manifest condition: '+field);
 }
 if(!sameTools(manifest.shared.tools.names))fail('Manifest must freeze exactly relay_workspace and relay_directory_action');
 if(manifest.shared.context.outputReserveTokens+manifest.shared.context.headroomTokens>=manifest.shared.context.windowTokens)fail('Manifest context reserve exceeds context');
 if(manifest.shared.config.savedRevision!==manifest.shared.config.appliedRevision)fail('Manifest requires saved configuration to be applied');
 for(const field of ['runtime.cacheK','runtime.cacheV','runtime.build','source.appVersion'])if(['auto','unknown','unloaded'].includes(get(manifest.shared,field).value.toLowerCase()))fail('Manifest requires resolved '+field);
 exactKeys(manifest.arms,['original','edited'],'Manifest arms');
 for(const arm of ['original','edited']){
  exactKeys(manifest.arms[arm],['path','sha256'],'Model arm '+arm);
  if(!absolute(manifest.arms[arm].path)||!hash(manifest.arms[arm].sha256))fail('Invalid GGUF identity for '+arm);
 }
 canonical(manifest);return structuredClone(manifest);
}
function manifestSha256(manifest){return digest(validateManifest(manifest));}
function assessConditions(manifest,evidence,binding){
 validateManifest(manifest);
 if(!record(binding)||!['admission','continuation','final'].includes(binding.phase)||!Object.hasOwn(manifest.arms,binding.arm)||!text(binding.connectionId)||!text(binding.model)||timestamp(binding.now)===null)fail('Explicit phase, arm, connection, model and observation time are required');
 if(binding.phase!=='admission'&&(!text(binding.runId)||!text(binding.requestId)||timestamp(binding.notBeforeAt)===null))fail('Run conditions require independent run/request and observation-time binding');
 if(binding.phase==='final'&&!hash(binding.payloadSha256))fail('Final conditions require independent payload binding');
 const manifestHash=manifestSha256(manifest),reasons=[];
 const add=(field,code,status,expected,observed,present=true)=>reasons.push({field,code,status,expected,observed:present?observed:null,present});
 const equal=(field,expected,valid=text,container=evidence,compare=(a,b)=>canonical(a)===canonical(b))=>{
  const actual=get(container,field);
  if(!actual.present||!valid(actual.value))add(field,'missing-or-unknown','unknown',expected,actual.value,actual.present);
  else if(!compare(actual.value,expected))add(field,'different','drifted',expected,actual.value);
 };
 equal('schema',EVIDENCE_SCHEMA);equal('connectionId',binding.connectionId);
 equal('manifestSha256',manifestHash,hash);equal('phase',binding.phase);
 equal('arm',binding.arm);equal('model',binding.model);
 const at=get(evidence,'at'),observedAt=timestamp(at.value),now=timestamp(binding.now);
 if(!at.present||observedAt===null)add('at','missing-or-invalid-time','unknown','UTC ISO timestamp',at.value,at.present);
 else if(observedAt>now)add('at','future-evidence','unknown','not after '+binding.now,at.value);
 else if(now-observedAt>manifest.maxEvidenceAgeMs)add('at','stale-evidence','unknown','age <= '+manifest.maxEvidenceAgeMs+' ms',at.value);
 if(binding.phase!=='admission'&&observedAt!==null&&observedAt<timestamp(binding.notBeforeAt))add('at',binding.phase==='final'?'before-settled-observation':'before-run-admission','unknown','at or after '+binding.notBeforeAt,at.value);
 if(binding.phase!=='admission'){equal('runId',binding.runId);equal('requestId',binding.requestId);}
 if(binding.phase==='final')equal('payloadSha256',binding.payloadSha256,hash);
 const envelopeValid=reasons.length===0;
 for(const [field,valid]of FIELDS){
  const expected=get(manifest.shared,field).value,actual=get(evidence?.conditions,field);
  const unresolved=typeof actual.value==='string'&&['auto','unknown','unloaded'].includes(actual.value.toLowerCase());
  if(!actual.present||!valid(actual.value)||unresolved)add('conditions.'+field,'missing-or-unknown','unknown',expected,actual.value,actual.present);
  else if(canonical(actual.value)!==canonical(expected))add('conditions.'+field,'different','drifted',expected,actual.value);
 }
 const model=manifest.arms[binding.arm];
 equal('model.path',model.path,absolute,evidence?.conditions,(a,b)=>path.win32.normalize(a).toLowerCase()===path.win32.normalize(b).toLowerCase());
 equal('model.sha256',model.sha256,hash,evidence?.conditions);
 const status=reasons.some(x=>x.status==='drifted')?'drifted':reasons.length?'unknown':'matching';
 return {status,matching:status==='matching',envelopeValid,phase:binding.phase,manifestSha256:manifestHash,checkedAt:binding.now,evidenceAt:observedAt===null?null:at.value,requiredConditionCount:REQUIRED_PATHS.length+2,reasons};
}
module.exports={MANIFEST_SCHEMA,EVIDENCE_SCHEMA,REQUIRED_PATHS,validateManifest,manifestSha256,assessConditions,digest,timestamp};
