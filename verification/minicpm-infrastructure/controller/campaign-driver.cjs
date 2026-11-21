'use strict';
// External-effect driver: this module persists requests, never executes them.
// The caller submits only returned operations through BLACKICE's direct tools.
const fs=require('node:fs'),path=require('node:path');
const campaign=require('./campaign-controller.cjs'),journal=require('./campaign-journal.cjs'),api=require('./native-api.cjs');
const conditions=require('./run-conditions.cjs');
function fail(code,message,evidence){const e=Error(message);e.code=code;if(evidence)e.evidence=evidence;throw e;}
function required(value,name){if(typeof value!=='string'||!value.trim())fail('DRIVER_ARGUMENT','Required '+name);return value;}
function nowOf(value){const now=value===undefined?new Date().toISOString():value;if(conditions.timestamp(now)===null)fail('DRIVER_TIME','Explicit time must be canonical UTC ISO');return now;}
function read(file){const absolute=path.resolve(required(file,'file path')),bytes=fs.readFileSync(absolute);return {path:absolute,bytes};}
function json(file){return JSON.parse(read(file).bytes.toString('utf8'));}
function keep(file,kind,directory,parse=true){
 const raw=read(file),evidence=journal.saveEvidence(directory,kind,raw.bytes);
 try{return {evidence,bytes:raw.bytes,value:parse?JSON.parse(raw.bytes.toString('utf8')):undefined};}
 catch(e){fail('DRIVER_INPUT_JSON','Saved '+kind+' is not valid JSON: '+e.message,evidence);}
}
function jobOf(value){return value?.structuredContent||value;}
function jobIdentity(job,pending){
 if(job?.jobId!==pending.jobId||job?.requestId!==pending.requestId||job?.tool!=='blackice_frontend'||job?.action!=='evaluate')fail('DRIVER_JOB_IDENTITY','Receipt does not identify the exact pending frontend action');
}
function pagesOf(options){
 if(options.result!==undefined&&options.resultPages!==undefined)fail('DRIVER_ARGUMENT','Choose result or resultPages, not both');
 const paths=options.result!==undefined?[options.result]:Array.isArray(options.resultPages)?options.resultPages:json(required(options.resultPages,'resultPages file'));
 if(!Array.isArray(paths)||paths.length<1||paths.some(p=>typeof p!=='string'||!p))fail('DRIVER_ARGUMENT','resultPages must identify a nonempty ordered file list');
 return paths;
}
function decodeResult(state,options,directory){
 const pending=state.controller.pending;
 if(!pending?.jobId)fail('DRIVER_PENDING_JOB','Record the exact durable job admission before accepting its result');
 const pages=pagesOf(options).map(file=>keep(file,'native-result-page',directory)),jobs=pages.map(p=>jobOf(p.value)),job=jobs[0];
 for(const j of jobs)jobIdentity(j,pending);
 if(job.settled!==true||!['succeeded','completed','failed','cancelled','interrupted'].includes(job.status))return {pending:true,job,receipts:pages.map(p=>p.evidence)};
 const stable=j=>JSON.stringify([j.jobId,j.requestId,j.tool,j.action,j.status,j.settled,j.revision,j.updatedAt??null,j.result?.success??null,j.result?.text?.totalCharacters??null]);
 if(jobs.some(j=>stable(j)!==stable(job)))fail('DRIVER_PAGE_IDENTITY','Paged receipts changed identity, revision or terminal result');
 let text=null,value,artifactEvidence=null;
 if(['succeeded','completed'].includes(job.status)){
  if(job.result?.success!==true)fail('DRIVER_RESULT_FAILED','Settled frontend result reports failure',pages[0].evidence);
  const total=job.result?.text?.totalCharacters;if(!Number.isSafeInteger(total)||total<0)fail('DRIVER_PAGE_COVERAGE','Result totalCharacters is missing');
  const chunks=[];let offset=0;
  for(let i=0;i<jobs.length;i++){
   const part=jobs[i].result?.text;
   if(!part||typeof part.text!=='string'||part.offset!==offset)fail('DRIVER_PAGE_COVERAGE','Result pages overlap, have a gap, or do not begin at offset zero');
   chunks.push(part.text);offset+=part.text.length;
   if(offset>total||part.nextOffset!==(offset===total?null:offset))fail('DRIVER_PAGE_COVERAGE','Result page cursor/length is inconsistent');
   if(offset===total&&i!==jobs.length-1)fail('DRIVER_PAGE_COVERAGE','Result includes pages after its terminal cursor');
  }
  if(offset!==total)fail('DRIVER_PAGE_INCOMPLETE','Retrieve remaining saved job result pages; do not repeat the operation');
  text=chunks.join('');
  let frontend;try{frontend=JSON.parse(text);}catch(e){fail('DRIVER_RESULT_JSON','Complete result text is not JSON',pages[0].evidence);}
  if(options.artifact!==undefined){
   const expected=pending.artifactRequired;
   if(expected?.complete!==true)fail('DRIVER_ARTIFACT_UNRECORDED','First accept the exact artifact receipt into the pending campaign');
   const saved=keep(options.artifact,'frontend-artifact',directory,false);artifactEvidence=saved.evidence;
   if(saved.bytes.length!==expected.bytes||api.sha(saved.bytes)!==expected.sha256)fail('DRIVER_ARTIFACT_IDENTITY','Saved frontend artifact hash or byte count differs',saved.evidence);
   const full=JSON.parse(saved.bytes.toString('utf8')),texts=full.contentItems?.filter(x=>x.type==='inputText');
   if(full.success!==true||texts?.length!==1||typeof texts[0].text!=='string')fail('DRIVER_ARTIFACT_FAILED','Complete frontend artifact has no single successful text result',saved.evidence);
   frontend=JSON.parse(texts[0].text);
  }
  value=api.unwrapFrontend(frontend);
 }
 const envelope=journal.saveEvidence(directory,'accepted-job-evidence',{
  schema:'blackice.minicpm.driver-job-evidence.v1',jobId:job.jobId,requestId:job.requestId,tool:job.tool,action:job.action,revision:job.revision,status:job.status,settled:job.settled,
  pages:pages.map(p=>p.evidence),resultTextSha256:text===null?null:api.sha(text),artifact:artifactEvidence
 });
 return {job,value,evidence:envelope,receipts:[...pages.map(p=>p.evidence),...(artifactEvidence?[artifactEvidence]:[]),envelope]};
}
function inside(root,candidate){const rel=path.relative(path.resolve(root),path.resolve(candidate));return rel===''||(!path.isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+path.sep));}
function evidenceDirectory(file,options,state){
 const directory=path.resolve(options.evidenceDir||path.join(path.dirname(file),'evidence'));
 if(inside(state.controller.config.workspace,file)||inside(state.controller.config.workspace,directory))fail('DRIVER_EVIDENCE_LOCATION','Campaign journal and evidence must be outside the model workspace');
 return directory;
}
function status(state,receipt){return {ok:!['blocked','disqualified'].includes(state.phase),phase:state.phase,campaignComplete:state.phase==='complete',controllerPhase:state.controller.phase,revision:state.revision,manifestSha256:state.manifestSha256,run:state.controller.run?{id:state.controller.run.id,status:state.controller.run.status,settled:state.controller.run.settled}:null,pending:state.controller.pending?{kind:state.controller.pending.kind,requestId:state.controller.pending.requestId,jobId:state.controller.pending.jobId,connectionId:state.controller.pending.connectionId,argumentsSha256:state.controller.pending.argumentsSha256}:null,drifted:state.drifted,journal:receipt};}
function addEvidence(state,command,at,receipts){
 if(!receipts.length)return state;
 const next=structuredClone(state);next.driverEvidence||={schema:'blackice.minicpm.driver-evidence.v1',records:[]};
 if(next.driverEvidence.schema!=='blackice.minicpm.driver-evidence.v1'||!Array.isArray(next.driverEvidence.records))fail('DRIVER_EVIDENCE_SCHEMA','Saved driver evidence index is malformed');
 next.driverEvidence.records.push({command,at,receipts});return next;
}
function execute(command,options={}){
 const file=path.resolve(required(options.journal,'journal')),connectionId=required(options.connection,'current connection'),now=nowOf(options.now);
 if(command==='init'){
  const config=json(required(options.config,'config')),manifest=json(required(options.manifest,'manifest'));
  if(config.connectionId!==connectionId)fail('DRIVER_CONNECTION','Configuration belongs to another connection');
  const scaffoldReceiptText=read(required(options.scaffold,'scaffold receipt')).bytes.toString('utf8');
  let state=campaign.createCampaign({config,manifest,arm:required(options.arm,'arm'),scaffoldReceiptText},now);
  const directory=evidenceDirectory(file,options,state),receipts=[keep(options.config,'initial-config',directory).evidence,keep(options.manifest,'initial-manifest',directory).evidence,keep(options.scaffold,'initial-scaffold',directory,false).evidence];
  state=addEvidence(state,command,now,receipts);const saved=journal.create(file,state);
  return {...status(state,saved),type:'campaign-created'};
 }
 const loaded=journal.load(file),state=loaded.state;
 if(connectionId!==state.binding.connectionId)fail('DRIVER_CONNECTION','Current connection differs; reconcile the original grant and owned work before any mutation');
 const directory=evidenceDirectory(file,options,state);
 if(command==='status')return {...status(state,loaded.receipt),type:'campaign-status'};
 if(state.phase==='complete'){
  if(command!=='next')fail('DRIVER_COMPLETE','A completed campaign is immutable');
  return {...status(state,loaded.receipt),type:'complete'};
 }
 let next=state,result,receipts=[];
 const observation=()=>{if(options.conditions===undefined)return undefined;const r=keep(options.conditions,'condition-observation',directory);receipts.push(r.evidence);return r.value;};
 if(command==='next'){
  const evidence=observation(),opts={now,connectionId,evidence},planned=campaign.planNext(state,opts);
  if(planned.type==='submit'){
   next=campaign.commitOperation(state,planned,opts);result={...planned,operation:{tool:'blackice_frontend',...planned.operation}};
  }else if(planned.type==='recover-same-operation'&&planned.operation.jobId){
   result={type:'recover-pending-job',tool:'blackice_get_job',arguments:{jobId:planned.operation.jobId,offset:0,limit:50000},pending:status(state,loaded.receipt).pending};
  }else if(planned.type==='recover-same-operation'){
   result={...planned,operation:{tool:'blackice_frontend',...planned.operation},recovery:'Resubmit only these identical saved arguments and request ID on this same connection.'};
  }else result=planned;
 }else if(command==='record-submission'){
  const raw=keep(required(options.admission,'admission'),'native-admission',directory),job=jobOf(raw.value),pending=state.controller.pending;receipts.push(raw.evidence);
  if(!pending||job?.requestId!==pending.requestId||job?.tool!=='blackice_frontend'||job?.action!=='evaluate')fail('DRIVER_JOB_IDENTITY','Admission does not identify the pending exact frontend operation');
  next=campaign.recordSubmission(state,{jobId:job.jobId,requestId:job.requestId,connectionId});result={type:'submission-recorded',jobId:job.jobId};
 }else if(command==='accept'){
  const decoded=decodeResult(state,options,directory);receipts.push(...decoded.receipts);
  if(decoded.pending)result={type:'job-not-settled',jobId:decoded.job.jobId,status:decoded.job.status,settled:decoded.job.settled};
  else{
   next=campaign.acceptResponse(state,{jobId:decoded.job.jobId,connectionId,jobStatus:decoded.job.status,jobSettled:decoded.job.settled,value:decoded.value,evidence:decoded.evidence},now);
   result={type:next.controller.pending?.artifactRequired?'retrieve-complete-saved-artifact':'response-accepted',...(next.controller.pending?.artifactRequired?{artifact:next.controller.pending.artifactRequired}:{})};
  }
 }else if(command==='record-conditions'){
  next=campaign.recordConditions(state,{now,connectionId,evidence:observation()});result={type:'conditions-recorded',assessment:next.conditionHistory.at(-1).assessment};
 }else if(command==='bind-payload'){
  const binding=keep(required(options.payloadBinding,'payloadBinding'),'payload-binding',directory),payload=keep(required(options.payload,'exact initial adapter payload'),'initial-payload',directory,false);receipts.push(binding.evidence,payload.evidence);
  if(binding.value.payloadSha256!==payload.evidence.sha256)fail('DRIVER_PAYLOAD_IDENTITY','Initial payload bytes differ from the supplied binding');
  next=campaign.bindPayload(state,binding.value,{now,connectionId});result={type:'payload-bound',payload:payload.evidence};
 }else if(command==='attach-transcript'){
  const raw=keep(required(options.providerThread,'providerThread'),'provider-transcript',directory,false);receipts.push(raw.evidence);
  next=campaign.attachTranscript(state,{providerEvidence:raw.evidence,providerText:raw.bytes.toString('utf8')});result={type:'transcript-attached',validation:next.controller.projection?.validation};
 }else if(command==='finalize'){
  next=campaign.finalize(state,{now,connectionId,evidence:observation()});result={type:next.phase==='complete'?'campaign-finalized':'final-conditions-unverified',assessment:next.finalRecord.assessment};
 }else fail('DRIVER_COMMAND','Unknown driver command: '+command);
 let saved=loaded.receipt;
 if(next!==state||receipts.length){
  next=addEvidence(next,command,now,receipts);
  if(next.revision<=state.revision)next.revision=state.revision+1;
  saved=journal.save(file,next,{expected:loaded.receipt});
 }
 // No operation is exposed before the whole state was saved and read back.
 return {...status(next,saved),...result,ok:['blocked','job-not-settled','final-conditions-unverified'].includes(result.type)?false:status(next,saved).ok};
}
module.exports={execute,decodeResult};
