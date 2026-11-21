'use strict';
// Pure validation of one current native context publication. No I/O or clock reads.
const crypto=require('node:crypto'),path=require('node:path');
const SCHEMA='blackice.minicpm.context-publication-observation.v1';
const INPUT_SCHEMA='blackice.minicpm.context-publication-input.v1';
const MAX_PREFIX_BYTES=268435456,MAX_STARTUP_BYTES=8388608,MAX_LINE_BYTES=16777216;
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const integer=v=>Number.isSafeInteger(v)&&v>=0;
const positive=v=>integer(v)&&v>0;
const text=v=>typeof v==='string'&&v.length>0;
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const bytes=v=>Buffer.isBuffer(v)?v:v instanceof Uint8Array?Buffer.from(v.buffer,v.byteOffset,v.byteLength):null;
const sha=v=>crypto.createHash('sha256').update(v).digest('hex');
const canonical=v=>Array.isArray(v)?v.map(canonical):object(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const equal=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
const absolute=v=>typeof v==='string'&&/^[A-Za-z]:[\\/]/.test(v)&&path.win32.isAbsolute(v);
const samePath=(a,b)=>absolute(a)&&absolute(b)&&path.win32.normalize(a).toLowerCase()===path.win32.normalize(b).toLowerCase();
const time=v=>typeof v==='string'&&Number.isFinite(Date.parse(v))&&new Date(Date.parse(v)).toISOString()===v?Date.parse(v):null;
const identity=v=>object(v)&&['dev','ino','birthtimeNs'].every(k=>typeof v[k]==='string'&&/^\d+$/.test(v[k]));
function normalizeContextPublication(input={},raw={}){
 input=object(input)?input:{};raw=object(raw)?raw:{};
 const result={schema:SCHEMA,complete:false,checkedAt:input.now??null,context:null,evidence:null,recordCount:0,missing:[],conflicts:[]};
 const issue=(field,code,observed=null,conflict=false)=>{(conflict?result.conflicts:result.missing).push({field,code,observed});return false;};
 const check=(ok,field,code,observed=null,conflict=false)=>ok||issue(field,code,observed,conflict);
 try{
  const now=time(input.now),age=input.maxEvidenceAgeMs,proof=input.currentPublication;
  if(!check(now!==null&&positive(age)&&age<=120000,'clock','bounded-current-context-clock-required'))return result;
  if(!check(object(proof)&&proof.schema===INPUT_SCHEMA,'currentPublication','independent-current-publication-required'))return result;
  const fresh=(name,value)=>{const t=time(value);return check(t!==null&&t<=now&&now-t<=age,name,'fresh-context-observation-required',value??null);};
  const first=input.propsResponse,last=proof.propsAfterResponse,source=proof.contextSource;
  const firstOK=first?.status===200&&object(first.json)&&first.json.blackice_runtime_state==='awake'&&first.json.is_sleeping===false;
  const lastOK=last?.status===200&&object(last.json)&&last.json.blackice_runtime_state==='awake'&&last.json.is_sleeping===false;
  check(firstOK,'props.before','explicit-awake-context-required');
  check(lastOK,'props.after','explicit-awake-context-required');
  for(const [name,value]of [['props.before.startedAt',first?.startedAt],['props.before.at',first?.at],['contextSource.startedAt',source?.startedAt],['contextSource.finishedAt',source?.finishedAt],['props.after.startedAt',last?.startedAt],['props.after.at',last?.at]])fresh(name,value);
  const clocks=[first?.startedAt,first?.at,source?.startedAt,source?.finishedAt,last?.startedAt,last?.at].map(time);
  check(clocks.every(t=>t!==null)&&clocks.every((t,n)=>n===0||t>=clocks[n-1]),'observationOrder','props-prefix-props-order-required',null,true);
  const native=first?.json?.blackice_runtime;
  if(!check(object(native)&&native.schema==='blackice.minicpm.runtime-startup.v1'&&native.complete===true&&native.droppedEvents===0&&text(native.id)&&native.id===native.startupId&&positive(native.pid)&&time(native.processStartedAt)!==null&&time(native.at)!==null,'props.before.runtime','complete-native-startup-required'))return result;
  check(equal(native,last?.json?.blackice_runtime),'props.after.runtime','current-publication-changed',null,true);
  check(native.pid===input.processIdentity?.pid&&native.processStartedAt===input.processIdentity?.startedAt,'runtime.process','publication-process-conflict',null,true);
  check(time(native.at)>=time(native.processStartedAt)&&time(native.at)<=time(first?.at),'runtime.at','publication-time-conflict',null,true);
  check(absolute(native.traceFile)&&native.traceFile.endsWith('.jsonl'),'runtime.traceFile','absolute-context-trace-required');
  const prefix=bytes(raw.contextPrefixBytes),startupBytes=bytes(raw.startupArtifactBytes);
  const validateArtifact=(name,ref,b,limit)=>{
   if(!check(absolute(ref?.path)&&positive(ref?.bytes)&&ref.bytes<=limit&&hash(ref?.sha256),name,'bounded-exact-artifact-reference-required'))return false;
   if(!check(b!==null,name,'independently-read-artifact-bytes-required'))return false;
   return check(b.length===ref.bytes&&b.length<=limit&&sha(b)===ref.sha256,name,'artifact-bytes-or-sha256-conflict',null,true);
  };
  const prefixOK=validateArtifact('contextPrefix',proof.contextPrefix,prefix,MAX_PREFIX_BYTES);
  const startupOK=validateArtifact('startupArtifact',proof.startupArtifact,startupBytes,MAX_STARTUP_BYTES);
  if(!prefixOK||!startupOK)return result;
  check(!samePath(proof.contextPrefix.path,native.traceFile),'contextPrefix.path','independent-prefix-copy-required');
  check(samePath(source?.path,native.traceFile)&&source?.highWaterMark===prefix.length,'contextSource','exact-source-and-high-water-required',null,true);
  check(identity(source?.before?.identity)&&identity(source?.after?.identity)&&equal(source.before.identity,source.after.identity),'contextSource.identity','context-file-identity-changed',null,true);
  check(source?.before?.bytes===prefix.length&&source?.after?.bytes===prefix.length,'contextSource.bytes','context-file-size-changed',null,true);
  check(source?.rereadSha256===proof.contextPrefix.sha256,'contextSource.rereadSha256','independent-source-reread-required',null,true);
  if(!check(prefix.length>0&&prefix[prefix.length-1]===10,'contextPrefix','complete-lf-prefix-required'))return result;
  let saved;
  try{saved=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(startupBytes));}
  catch{issue('startupArtifact','invalid-startup-json-or-utf8');return result;}
  check(equal(saved,native),'startupArtifact','native-artifact-props-conflict',null,true);
  const enriched=input.startupReceipt;
  if(object(enriched)){
   const rawEnriched=Object.fromEntries(Object.entries(enriched).filter(([key])=>!['observedAt','modelSha256','binarySha256'].includes(key)));
   check(equal(rawEnriched,native),'startupReceipt','enriched-native-receipt-conflict',null,true);
  }else issue('startupReceipt','enriched-startup-required');
  const startupSource=native.traceFile?.replace(/\.jsonl$/,'.startup.json');
  check(!samePath(proof.startupArtifact.path,startupSource),'startupArtifact.path','independent-startup-copy-required');
  let lineNumber=0,offset=0,previousProcessSequence=0,processId=null,start=null,publication=null,endCount=0;
  while(offset<prefix.length){
   const next=prefix.indexOf(10,offset),length=next-offset;
   if(next<0||length<=0||length>MAX_LINE_BYTES){issue('contextPrefix','invalid-or-overflowing-context-line',lineNumber+1);break;}
   let event;
   try{event=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(prefix.subarray(offset,next)));}
   catch{issue('contextPrefix','invalid-context-json-or-utf8',lineNumber+1);break;}
   lineNumber++;offset=next+1;
   if(!object(event)||event.schema!=='blackice.minicpm.live-trace.v1'||!text(event.event)||event.fileSequence!==lineNumber||!positive(event.processSequence)||event.processSequence<=previousProcessSequence||event.pid!==native.pid||event.processStartedAt!==native.processStartedAt||!text(event.processId)||!object(event.data)||event.data.startupId!==native.startupId){
    issue('contextPrefix','context-event-identity-or-sequence-conflict',lineNumber,true);break;
   }
   previousProcessSequence=event.processSequence;
   if(processId===null)processId=event.processId;
   if(processId!==event.processId){issue('contextPrefix','context-process-id-changed',lineNumber,true);break;}
   if(time(event.at)===null||time(event.at)<time(native.processStartedAt)||time(event.at)>time(source.finishedAt)){
    issue('contextPrefix','context-event-time-conflict',lineNumber,true);break;
   }
   if(event.event==='context_start'){
    if(start||lineNumber!==1)issue('contextPrefix','unique-first-context-start-required',lineNumber,true);
    start=event;
   }
   if(event.event==='runtime_startup'){
    if(publication)issue('contextPrefix','duplicate-runtime-publication',lineNumber,true);
    publication=event;
    const ref=event.data.receipt;
    check(samePath(ref?.path,startupSource)&&ref?.bytes===startupBytes.length&&ref?.sha256===sha(startupBytes),'runtime_startup.receipt','startup-publication-artifact-conflict',lineNumber,true);
    check(equal(event.data.runtime,native),'runtime_startup.runtime','startup-publication-props-conflict',lineNumber,true);
   }
   if(event.event==='context_end'){endCount++;issue('contextPrefix','current-context-already-ended',lineNumber,true);}
  }
  check(start!==null&&publication!==null&&publication.fileSequence>1&&start.fileSequence<publication.fileSequence,'contextPrefix','ordered-context-start-and-publication-required');
  if(start&&publication)check(time(start.at)<=time(native.at)&&time(native.at)<=time(publication.at)&&time(publication.at)<=time(first.at),'runtime_startup.at','publication-observation-order-conflict',null,true);
  const basename=String(native.pid)+'-'+processId+'.ctx-'+native.startupId+'.jsonl';
  check(path.win32.basename(native.traceFile||'')===basename,'contextPrefix.path','trace-header-filename-conflict',null,true);
  result.recordCount=lineNumber;
  result.context={startupId:native.startupId,pid:native.pid,processId,processStartedAt:native.processStartedAt,startSequence:start?.fileSequence??null,publicationSequence:publication?.fileSequence??null,lastFileSequence:lineNumber,lastProcessSequence:previousProcessSequence,contextEndCount:endCount};
  result.evidence={contextPrefix:structuredClone(proof.contextPrefix),startupArtifact:structuredClone(proof.startupArtifact),contextSource:structuredClone(source),propsBefore:{at:first?.at??null,canonicalSha256:sha(JSON.stringify(canonical(first)))},propsAfter:{at:last?.at??null,canonicalSha256:sha(JSON.stringify(canonical(last)))}};
  result.complete=result.missing.length===0&&result.conflicts.length===0&&offset===prefix.length;
 }catch(error){issue('currentPublication','invalid-current-publication-evidence',String(error?.message||error).slice(0,320));}
 return result;
}
module.exports={SCHEMA,INPUT_SCHEMA,MAX_PREFIX_BYTES,MAX_STARTUP_BYTES,normalizeContextPublication};
