'use strict';
// Explicit first D0 qualification. This state can never be a scored campaign.
const fs=require('node:fs'),path=require('node:path');
const core=require('./controller.cjs'),api=require('./native-api.cjs'),evidence=require('./evidence.cjs');
const journal=require('./campaign-journal.cjs'),{decodeResult}=require('./campaign-driver.cjs');
const {digest,timestamp}=require('./run-conditions.cjs');
const {isCompletePolicyQualification}=require('./policy-observation.cjs');
const SCHEMA='blackice.minicpm.instruction-qualification.v1',PURPOSE='instruction-workflow-qualification';
const immutableNames=['METHOD.md','TASK.md','task.json','public-cases.json','test-public.cjs','test-support/grade-modules.cjs','test-support/module-worker.cjs'].sort();
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
function fail(code,message){throw Object.assign(Error(message),{code});}
function required(value,label){if(typeof value!=='string'||!value.trim())fail('QUALIFICATION_ARGUMENT','Required '+label);return value;}
function time(value){const at=value===undefined?new Date().toISOString():value;if(timestamp(at)===null)fail('QUALIFICATION_TIME','Canonical UTC ISO time required');return at;}
function read(file){const resolved=path.resolve(required(file,'file path'));return {path:resolved,bytes:fs.readFileSync(resolved)};}
function readJSON(file){return JSON.parse(read(file).bytes.toString('utf8'));}
function keep(file,kind,directory,parse=true){const raw=read(file),receipt=journal.saveEvidence(directory,kind,raw.bytes);return {...raw,evidence:receipt,...(parse?{value:JSON.parse(raw.bytes.toString('utf8'))}:{})};}

function checked(receipt){
 if(!receipt||typeof receipt.path!=='string'||!hash(receipt.sha256)||!Number.isSafeInteger(receipt.bytes)||receipt.bytes<0)fail('QUALIFICATION_EVIDENCE_CHANGED','A complete saved evidence reference is required');
 const raw=read(receipt.path);
 if(api.sha(raw.bytes)!==receipt.sha256||raw.bytes.length!==receipt.bytes)fail('QUALIFICATION_EVIDENCE_CHANGED','Preserved evidence changed: '+receipt.path);
 return raw.bytes;
}
function sameBytes(a,b){return !!a&&!!b&&a.sha256===b.sha256&&a.bytes===b.bytes;}
function failureInput(manifest,name){
 const matches=Array.isArray(manifest.inputFiles)?manifest.inputFiles.filter(x=>x.name===name):[];
 if(matches.length!==1)fail('QUALIFICATION_FAILURE_IDENTITY','Failed capture must retain one '+name+' input');
 return matches[0];
}
function failureFacts(state,refs,at){
 const c=state.controller,run=c.evidence?.run;
 if(c.pending||!run||!api.terminal(run.status)||run.settled!==true||!api.terminal(c.run?.status)||c.run?.settled!==true||!state.providerEvidence)fail('QUALIFICATION_UNSETTLED','Failure closure requires owned settled native evidence, no pending effect, and the exact attached transcript');
 api.assertOwnedIdentity(run,c.config,c.run.id);
 const binding=runBinding(state),observation=JSON.parse(checked(refs.observation)),manifest=JSON.parse(checked(refs.snapshot));
 if(observation.schema!=='blackice.minicpm.managed-route-observation.v1'||observation.complete!==false||observation.scorable!==false||observation.traceComparable!==false||!(observation.capture===null||observation.capture?.complete===false)||!Array.isArray(observation.missing)||!Array.isArray(observation.conflicts)||observation.missing.length+observation.conflicts.length===0)fail('QUALIFICATION_FAILURE_EVIDENCE','An explicitly incomplete managed-route observation with recorded failures is required');
 if(manifest.schema!=='blackice.minicpm.managed-route-snapshot.v1'||manifest.complete!==false||!sameBytes(manifest.result,refs.observation)||timestamp(manifest.startedAt)===null||timestamp(manifest.finishedAt)===null||Date.parse(manifest.startedAt)<Date.parse(run.createdAt)||Date.parse(manifest.finishedAt)<Date.parse(manifest.startedAt)||Date.parse(manifest.finishedAt)>Date.parse(at))fail('QUALIFICATION_FAILURE_EVIDENCE','Failed snapshot does not preserve this exact observation and historical collection window');
 const observedRun=JSON.parse(checked(refs.nativeRun)),observedBinding=JSON.parse(checked(refs.runBinding)),thread=JSON.parse(checked(refs.providerThread));
 if(!sameBytes(failureInput(manifest,'native-run'),refs.nativeRun)||digest(observedRun)!==digest(run)||!sameBytes(failureInput(manifest,'run-binding'),refs.runBinding)||digest(observedBinding)!==digest(binding)||!sameBytes(failureInput(manifest,'provider-thread'),refs.providerThread)||!sameBytes(refs.providerThread,state.providerEvidence)||thread.id!==binding.threadId||thread.model!==binding.model)fail('QUALIFICATION_FAILURE_IDENTITY','Failed snapshot inputs do not match the owned collected run and exact attached transcript');
 if(refs.payload){checked(refs.payload);if(!sameBytes(manifest.payloadCopy,refs.payload)||!sameBytes(observation.payload,refs.payload))fail('QUALIFICATION_FAILURE_IDENTITY','Failed payload bytes differ from the preserved observation and snapshot');}
 else if(manifest.payloadCopy||observation.payload)fail('QUALIFICATION_FAILURE_EVIDENCE','Retain the available exact payload as unqualified evidence');
 if(refs.observations)checked(refs.observations);
 return {binding,observation,manifest};
}
function validateFailureClosure(state){
 const closure=state.failureClosure,recorded=state.driverEvidence?.records?.some(x=>x.command==='finish-incomplete');
 if(!closure){if(state.failureClosureSha256||recorded)fail('QUALIFICATION_FAILURE_CLOSED','Terminal failure closure cannot be removed');return;}
 if(closure.schema!=='blackice.minicpm.qualification-failure.v1'||closure.complete!==false||closure.scorable!==false||closure.traceComparable!==false||closure.payloadBound!==false||closure.policyQualified!==false||state.phase!=='qualification-incomplete'||timestamp(closure.closedAt)===null||typeof closure.reason!=='string'||!closure.reason.trim()||closure.reason.length>4096||state.failureClosureSha256!==digest(closure)||state.payloadBinding!=null||state.payloadBindingSha256!=null||state.policyQualification!=null||state.policyQualificationSha256!=null||state.payloadEvidence!=null||state.captureEvidence!=null)fail('QUALIFICATION_FAILURE_CLOSED','A failed capture closure is terminal, unbound and unqualified');
 const facts=failureFacts(state,closure.evidence,closure.closedAt);
 if(digest(closure.runBinding)!==digest(facts.binding))fail('QUALIFICATION_FAILURE_IDENTITY','Saved failure closure run identity changed');
}

function bindingOf(config){return {caseId:'D0',requestId:config.requestId,workflowId:config.workflowId,model:config.model,connectionId:config.connectionId,workspace:api.windowsPath(config.workspace),benchmarkRequestSha256:digest(config.benchmark)};}
function scaffold(state){
 const cfg=state.controller.config,raw=state.scaffoldReceiptText;
 if(typeof raw!=='string'||Buffer.byteLength(raw)>65536||api.sha(raw)!==cfg.benchmark.scaffoldReceiptSha256)fail('QUALIFICATION_SCAFFOLD','Exact scaffold bytes are required');
 const r=JSON.parse(raw),rel=path.win32.relative(cfg.workspace,cfg.benchmark.scaffoldReceiptPath);
 if(!rel||(!path.win32.isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+path.win32.sep)))fail('QUALIFICATION_SCAFFOLD','Scaffold receipt must remain outside model workspace');
 if(r.schema!=='blackice.minicpm.directory-smoke-scaffold.v1'||r.caseId!=='D0'||r.scored!==false||r.publicCaseCount!==2||api.windowsPath(r.workspace||'')!==api.windowsPath(cfg.workspace)||!r.immutableFiles||JSON.stringify(Object.keys(r.immutableFiles).sort())!==JSON.stringify(immutableNames)||Object.values(r.immutableFiles).some(x=>!hash(x))||r.method?.path!=='METHOD.md'||r.method.sha256!==cfg.method.sha256||r.immutableFiles['METHOD.md']!==cfg.method.sha256||!r.initialSource||Object.keys(r.initialSource).length!==1||!hash(r.initialSource['src/index.cjs']))fail('QUALIFICATION_SCAFFOLD','Only the frozen unscored D0 scaffold is allowed');
 return r;
}
function validate(state){
 if(state?.schema!==SCHEMA||state.scorable!==false||state.purpose!==PURPOSE||state.policyReviewRequired!==true||timestamp(state.createdAt)===null)fail('QUALIFICATION_SCHEMA','Only explicitly unscored instruction/workflow qualification is allowed');
 const c=state.controller,cfg=api.validate(c?.config);
 if(cfg.caseId!=='D0'||!cfg.benchmark||JSON.stringify(cfg.allowedCommands)!==JSON.stringify(['node test-public.cjs']))fail('QUALIFICATION_SCOPE','Qualification is restricted to D0 and its fixed benchmark profile');
 if(state.bindingSha256!==digest(state.binding)||digest(state.binding)!==digest(bindingOf(cfg)))fail('QUALIFICATION_IDENTITY','Qualification/controller binding differs');
 core.planNext(c,state.createdAt,state.binding.connectionId);scaffold(state);validateFailureClosure(state);
 if(state.payloadBinding&&state.payloadBindingSha256!==digest(state.payloadBinding))fail('QUALIFICATION_IDENTITY','Saved initial payload binding changed');
 if(state.policyQualification&&state.policyQualificationSha256!==digest(state.policyQualification))fail('QUALIFICATION_IDENTITY','Saved policy assessment changed');
 if(state.phase==='complete'&&(state.runConditionFailures.length||!state.payloadBinding||!state.providerEvidence||!isCompletePolicyQualification(state.policyQualification)||c.projection?.validation?.valid!==true||!api.terminal(c.run?.status)||c.run?.settled!==true))fail('QUALIFICATION_INCOMPLETE','Qualification completion lacks settled observed evidence');
 return state;
}
const store=journal.createJournalStore({schema:SCHEMA,validateState:validate,identityOf:s=>digest([s.schema,s.createdAt,s.scorable,s.purpose,s.policyReviewRequired,s.bindingSha256,s.scaffoldReceiptText,s.controller.configSha256])});
function create({config,scaffoldReceiptText},now){
 const controller=core.createState(config,now),binding=bindingOf(controller.config);
 const state={schema:SCHEMA,revision:0,createdAt:now,scorable:false,purpose:PURPOSE,policyReviewRequired:true,binding,bindingSha256:digest(binding),scaffoldReceiptText,controller,phase:'active',runConditionFailures:[],payloadBinding:null,payloadBindingSha256:null,providerEvidence:null,policyQualification:null,policyQualificationSha256:null};
 return validate(state);
}
function preparedIssues(state){
 const c=state.controller,cfg=c.config,b=c.authoredBody,s=b?.workflow?.settings,i=b?.input,agents=b?.workflow?.nodes?.filter(n=>n.type==='agent');
 return !b||api.sha(b)!==c.authoredBodySha256||b.requestId!==cfg.requestId||b.workflow.id!==cfg.workflowId||agents?.length!==1||agents[0].id!=='agent'||agents[0].model!==cfg.model||digest(agents[0].context||s?.context)!==digest(cfg.context)||api.windowsPath(s?.cwd||'')!==api.windowsPath(cfg.workspace)||s?.planningMode!=='off'||i?.task!==cfg.task||api.windowsPath(i?.cwd||'')!==api.windowsPath(cfg.workspace)||i?.directoryActions!=='on'||i?.directoryMode!=='off'||i?.directoryDiagnostics!=='maximal'||i?.chatPlanning!=='off'||i?.pastChats!=='off'||i?.planningMode!=='off'||digest(i?.benchmark)!==digest(cfg.benchmark)||!i?.benchmarkBudget||typeof i.benchmarkBudget!=='object'||Array.isArray(i.benchmarkBudget)||Object.keys(i.benchmarkBudget).join(',')!=='wallMs'||i.benchmarkBudget.wallMs!==cfg.budgets.wallMs;
}
function runIssues(state,run){
 const cfg=state.controller.config,issues=[];
 try{api.assertOwned(run,cfg);}catch(e){issues.push(e.message);}
 const agents=run.workflow?.nodes?.filter(n=>n.type==='agent')||[];
 const effective=agents[0]?.context||run.workflow?.settings?.context;
 if(agents.length!==1||agents[0].id!=='agent'||!effective||digest(effective)!==digest(cfg.context))issues.push('Effective context differs');
 if(run.chatPlanning!=='off'||run.pastChats!=='off')issues.push('Chat Planning or Past Chats differs');
 const p=run.benchmark,r=scaffold(state);
 if(p){
  const expected={schema:'blackice.minicpm.benchmark-profile.v1',profile:'minicpm-code-v1',workspace:p.workspace,caseId:'D0',publicCaseCount:2,command:'node test-public.cjs',scaffoldReceiptPath:p.scaffoldReceiptPath,scaffoldReceiptSha256:cfg.benchmark.scaffoldReceiptSha256,immutableFiles:r.immutableFiles,limits:{maxModules:32,maxSourceBytes:200000,maxDepth:8,commandTimeoutMs:10000},isolation:'Enforced benchmark tool/API boundary with a restricted pure-function worker; not an operating-system sandbox.',functionName:'directorySmoke'}, {contractSha256,...actual}=p;
  if(digest(actual)!==digest(expected)||contractSha256!==digest(actual))issues.push('Normalized profile differs from frozen scaffold');
 }
 return issues;
}
function runBinding(state){
 const run=state.controller.run;if(!run)fail('QUALIFICATION_RUN','No owned native run has been admitted');
 api.assertOwnedIdentity(run,state.controller.config);
 const node=run.nodes?.agent,b={runId:run.id,nodeId:'agent',threadId:node?.threadId,turnId:node?.turnId,requestId:state.binding.requestId,model:state.binding.model.slice(state.binding.model.indexOf('::')+2)};
 if(Object.values(b).some(v=>typeof v!=='string'||!v))fail('QUALIFICATION_RUN','Native thread and turn identities have not yet been observed');
 return b;
}
function inside(root,file){const r=path.relative(path.resolve(root),path.resolve(file));return r===''||(!path.isAbsolute(r)&&r!=='..'&&!r.startsWith('..'+path.sep));}
function evidenceDir(state,file,options){
 const directory=path.resolve(options.evidenceDir||path.join(path.dirname(file),'evidence'));
 if(inside(state.controller.config.workspace,file)||inside(state.controller.config.workspace,directory))fail('QUALIFICATION_EVIDENCE_LOCATION','Keep qualification journal/evidence outside the model workspace');
 return directory;
}
function summary(state,receipt){
 const run=state.controller.run,audit=run?.nodes?.agent?.instructionAudit;
 return {ok:!['blocked','qualification-incomplete'].includes(state.phase),schema:SCHEMA,scorable:false,purpose:PURPOSE,policyReviewRequired:true,qualificationComplete:state.phase==='complete',failureClosed:!!state.failureClosure,phase:state.phase,controllerPhase:state.controller.phase,revision:state.revision,run:run?{id:run.id,status:run.status,settled:run.settled,threadId:run.nodes?.agent?.threadId||null,turnId:run.nodes?.agent?.turnId||null}:null,pending:state.controller.pending?{kind:state.controller.pending.kind,requestId:state.controller.pending.requestId,jobId:state.controller.pending.jobId,connectionId:state.controller.pending.connectionId,argumentsSha256:state.controller.pending.argumentsSha256}:null,payloadBound:!!state.payloadBinding,instructionAudit:audit?{captureStage:audit.captureStage,delivery:audit.delivery,developerSha256:audit.developer?.sha256,toolStatus:audit.tools?.status,toolSha256:audit.tools?.sha256}:null,journal:receipt};
}
function withCore(state,controller){const next=structuredClone(state);next.controller=controller;next.revision++;return next;}
function appendEvidence(state,command,at,receipts){
 const next=structuredClone(state);next.driverEvidence||={schema:'blackice.minicpm.driver-evidence.v1',records:[]};next.driverEvidence.records.push({command,at,receipts});return next;
}
function execute(command,options={}){
 const file=path.resolve(required(options.journal,'journal')),connectionId=required(options.connection,'current connection'),now=time(options.now);
 if(Object.hasOwn(options,'scorable')||Object.hasOwn(options,'manifest')||Object.hasOwn(options,'arm'))fail('QUALIFICATION_SCOPE','Scoring, arms and guarded manifests are unavailable in qualification mode');
 if(command==='init'){
  const config=readJSON(required(options.config,'config'));if(config.connectionId!==connectionId)fail('QUALIFICATION_CONNECTION','Configuration connection differs');
  let state=create({config,scaffoldReceiptText:read(required(options.scaffold,'scaffold')).bytes.toString('utf8')},now);
  const directory=evidenceDir(state,file,options),receipts=[keep(options.config,'qualification-config',directory).evidence,keep(options.scaffold,'qualification-scaffold',directory,false).evidence];
  if(options.observations!==undefined)receipts.push(keep(options.observations,'qualification-initial-observations',directory).evidence);
  state=appendEvidence(state,command,now,receipts);return {...summary(state,store.create(file,state)),type:'qualification-created'};
 }
 const loaded=store.load(file),state=loaded.state;
 if(connectionId!==state.binding.connectionId)fail('QUALIFICATION_CONNECTION','Current connection differs; reconcile original owned work before changing identity');
 const directory=evidenceDir(state,file,options);
 if(command==='status')return {...summary(state,loaded.receipt),type:'qualification-status'};
 if(state.failureClosure){if(command!=='next')fail('QUALIFICATION_FAILURE_CLOSED','Failed qualification is terminal and cannot be promoted');return {...summary(state,loaded.receipt),type:'qualification-incomplete',failureClosure:state.failureClosure};}
 if(state.phase==='complete'){if(command!=='next')fail('QUALIFICATION_COMPLETE','Completed qualification is immutable');return {...summary(state,loaded.receipt),type:'qualification-complete'};}
 let next=state,result,receipts=[];
 if(command==='next'){
  if(state.controller.phase==='prepared'&&!state.controller.pending&&preparedIssues(state))fail('QUALIFICATION_PREPARED','Prepared request no longer matches fixed qualification modes/context');
  let planned=core.planNext(state.controller,now,connectionId);
  if(planned.type==='submit'&&planned.operation.kind==='observe'&&state.runConditionFailures.length){
   const op=api.observe(state.controller.config,state.controller.nextIndex,state.controller.run.id,now,state.controller.cleanupDeadlineAt);
   planned={type:'submit',operation:{...op,createdAt:now,connectionId,jobId:null,argumentsSha256:api.sha(op.arguments)}};
  }
  if(planned.type==='submit'){next=withCore(state,core.commitOperation(state.controller,planned));result={...planned,operation:{tool:'blackice_frontend',...planned.operation}};}
  else if(planned.type==='recover-same-operation'&&planned.operation.jobId)result={type:'recover-pending-job',tool:'blackice_get_job',arguments:{jobId:planned.operation.jobId,offset:0,limit:50000}};
  else if(planned.type==='recover-same-operation')result={...planned,operation:{tool:'blackice_frontend',...planned.operation}};
  else if(planned.type==='complete')result={type:'collect-qualification-evidence',payloadBound:!!state.payloadBinding,providerTranscriptAttached:!!state.providerEvidence};
  else result=planned;
 }else if(command==='record-submission'){
  const raw=keep(required(options.admission,'admission'),'native-admission',directory),job=raw.value?.structuredContent||raw.value,p=state.controller.pending;receipts.push(raw.evidence);
  if(!p||job.requestId!==p.requestId||job.tool!=='blackice_frontend'||job.action!=='evaluate')fail('QUALIFICATION_JOB_IDENTITY','Admission does not match the exact pending frontend action');
  next=withCore(state,core.recordSubmission(state.controller,{jobId:job.jobId,requestId:job.requestId,connectionId}));result={type:'submission-recorded',jobId:job.jobId};
 }else if(command==='accept'){
  const decoded=decodeResult(state,options,directory);receipts.push(...decoded.receipts);
  if(decoded.pending)result={type:'job-not-settled',status:decoded.job.status,settled:decoded.job.settled,jobId:decoded.job.jobId};
  else{
   const kind=state.controller.pending.kind;
   next=withCore(state,core.acceptResponse(state.controller,{jobId:decoded.job.jobId,connectionId,jobStatus:decoded.job.status,jobSettled:decoded.job.settled,value:decoded.value,evidence:decoded.evidence},now));
   if(kind==='prepare'&&next.controller.phase==='prepared'&&preparedIssues(next)){next.controller.phase='blocked';next.controller.blockers.push({reason:'qualification-prepared-request-mismatch',at:now});}
   if(next.controller.run&&['start','observe','collect'].includes(kind)){
    const issues=runIssues(next,next.controller.run);if(issues.length)next.runConditionFailures.push({at:now,kind,issues});
   }
   if(next.controller.phase==='blocked')next.phase='blocked';
   result={type:next.controller.pending?.artifactRequired?'retrieve-complete-saved-artifact':'response-accepted',...(next.controller.pending?.artifactRequired?{artifact:next.controller.pending.artifactRequired}:{})};
  }
 }else if(command==='bind-payload'){
  const payload=keep(required(options.payload,'exact initial payload'),'initial-payload',directory,false),capture=keep(required(options.capture,'transport capture'),'transport-capture',directory);receipts.push(payload.evidence,capture.evidence);
  const binding=runBinding(state),actual=capture.value;
  if(actual.request?.bodySha256!==payload.evidence.sha256||actual.request?.bodyBytes!==payload.bytes.length||Object.entries(binding).some(([k,v])=>actual.binding?.[k]!==v))fail('QUALIFICATION_PAYLOAD','Payload bytes/capture do not identify this exact observed native run');
  const bound={...binding,payloadSha256:payload.evidence.sha256,captureSha256:capture.evidence.sha256,at:actual.request.at};
  if(timestamp(bound.at)===null||Date.parse(bound.at)<Date.parse(state.controller.run.createdAt)||Date.parse(bound.at)>Date.parse(now))fail('QUALIFICATION_PAYLOAD','Payload capture time is outside the observed run');
  if(state.payloadBinding&&digest(state.payloadBinding)!==digest(bound))fail('QUALIFICATION_PAYLOAD','Initial payload cannot be rebound');
  next=structuredClone(state);next.revision++;next.payloadBinding=bound;next.payloadBindingSha256=digest(bound);next.payloadEvidence=payload.evidence;next.captureEvidence=capture.evidence;result={type:'payload-bound',payload:payload.evidence};
 }else if(command==='attach-transcript'){
  const raw=keep(required(options.providerThread,'provider transcript'),'provider-transcript',directory,false);receipts.push(raw.evidence);
  const projection=evidence.projectEvidence({config:state.controller.config,bundle:state.controller.evidence,providerThread:JSON.parse(raw.bytes.toString('utf8')),provenance:[...state.controller.history.map(x=>x.evidence),raw.evidence]});
  next=withCore(state,core.attachProjection(state.controller,raw.evidence,projection));next.providerEvidence=raw.evidence;next.phase=next.controller.phase==='complete'?'awaiting-policy-qualification':'blocked';result={type:'transcript-attached',validation:projection.validation};
 }else if(command==='finish-incomplete'){
  const run=state.controller.evidence?.run;
  if(state.controller.pending||!run||!api.terminal(run.status)||run.settled!==true||!state.providerEvidence)fail('QUALIFICATION_UNSETTLED','Collect settled native evidence and attach the exact transcript before failure closure');
  if(state.payloadBinding||state.policyQualification||state.payloadEvidence||state.captureEvidence)fail('QUALIFICATION_FAILURE_BOUND','Failure closure cannot erase an existing payload binding or policy assessment');
  const reason=required(options.reason,'failure reason');if(reason.length>4096)fail('QUALIFICATION_ARGUMENT','Failure reason exceeds 4096 characters');
  const observation=keep(required(options.failureObservation,'failed observation'),'failed-route-observation',directory),snapshot=keep(required(options.snapshotManifest,'snapshot manifest'),'failed-route-snapshot',directory);
  const retain=(ref,kind)=>{checked(ref);const copy=keep(ref.path,kind,directory,false);if(!sameBytes(copy.evidence,ref))fail('QUALIFICATION_EVIDENCE_CHANGED','Evidence changed while retaining '+kind);return copy.evidence;};
  const refs={observation:observation.evidence,snapshot:snapshot.evidence,nativeRun:retain(failureInput(snapshot.value,'native-run'),'failed-route-native-run'),runBinding:retain(failureInput(snapshot.value,'run-binding'),'failed-route-run-binding'),providerThread:state.providerEvidence,payload:null};
  const payloadPath=options.payload??snapshot.value.payloadCopy?.path;
  if(payloadPath)refs.payload=keep(payloadPath,'unqualified-initial-payload',directory,false).evidence;
  if(options.observations!==undefined)refs.observations=keep(options.observations,'failure-context',directory,false).evidence;
  const facts=failureFacts(state,refs,now);receipts.push(...Object.values(refs).filter(Boolean));
  next=structuredClone(state);next.revision++;next.phase='qualification-incomplete';
  next.payloadBinding=null;next.payloadBindingSha256=null;next.policyQualification=null;next.policyQualificationSha256=null;
  next.failureClosure={schema:'blackice.minicpm.qualification-failure.v1',closedAt:now,complete:false,scorable:false,traceComparable:false,payloadBound:false,policyQualified:false,reason,runBinding:facts.binding,evidence:refs};
  next.failureClosureSha256=digest(next.failureClosure);
  result={type:'qualification-incomplete',failureClosure:next.failureClosure,workflowEvidenceValid:state.controller.projection?.validation?.valid===true,agentCompleted:state.controller.projection?.receipt?.completion?.agentCompleted===true};
 }else if(command==='finish'){
  const run=state.controller.evidence?.run;
  if(!run||!api.terminal(run.status)||run.settled!==true||!state.providerEvidence||!state.payloadEvidence||!state.captureEvidence)fail('QUALIFICATION_UNSETTLED','Collect settled native evidence, exact transcript and payload before qualification');
  const input=keep(required(options.policyInput,'policy qualification input'),'policy-input',directory);receipts.push(input.evidence);
  const check=r=>{const raw=read(r.path);if(api.sha(raw.bytes)!==r.sha256||raw.bytes.length!==r.bytes)fail('QUALIFICATION_EVIDENCE_CHANGED','Preserved evidence changed: '+r.path);return raw.bytes;};
  const payload=check(state.payloadEvidence),capture=JSON.parse(check(state.captureEvidence)),thread=JSON.parse(check(state.providerEvidence));
  const {normalizePolicyQualification}=require('./policy-observation.cjs');
  const policy=normalizePolicyQualification({audit:run.nodes?.agent?.instructionAudit,initialPayloadBytes:payload,runBinding:runBinding(state),currentSources:input.value.currentSources,qualificationMetadata:{...input.value.qualificationMetadata,nativeRun:run,providerThread:thread,transportCapture:capture}});
  next=structuredClone(state);next.revision++;next.policyQualification=policy;next.policyQualificationSha256=digest(policy);next.phase=policy.complete===true&&state.controller.projection?.validation?.valid===true&&!state.runConditionFailures.length?'complete':'qualification-incomplete';
  result={type:next.phase==='complete'?'qualification-complete':'qualification-incomplete',policyQualification:policy,workflowEvidenceValid:state.controller.projection?.validation?.valid===true,agentCompleted:state.controller.projection?.receipt?.completion?.agentCompleted===true};
 }else fail('QUALIFICATION_COMMAND','Unknown qualification command: '+command);
 let saved=loaded.receipt;
 if(next!==state||receipts.length){next=appendEvidence(next,command,now,receipts);if(next.revision<=state.revision)next.revision=state.revision+1;saved=store.save(file,next,{expected:loaded.receipt});}
 return {...summary(next,saved),...result,ok:['blocked','job-not-settled','qualification-incomplete'].includes(result.type)?false:summary(next,saved).ok};
}
module.exports={SCHEMA,PURPOSE,validate,create,store,runBinding,execute};
