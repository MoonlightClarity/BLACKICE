'use strict';
// Pure validation of observed delivery, not a judgment that the policy is benign.
// Native snapshot/capture provenance comes from the trusted collector. This module
// verifies its internal bindings; it cannot attest that arbitrary caller data is real.
const {SCHEMA,CAPTURE_SCHEMA,SOURCE_FILES,SKILLS,TOOLS,record,text,integer,positive,hash,sha,time,canonical,digest,without,issues}=require('./policy-contract.cjs');
const {PROMPT_COVERAGE_SCHEMA,assessPromptCoverage,validateStoredPromptCoverage}=require('./prompt-composition.cjs');
const {SOURCE_CANDIDATES,inspectPolicySourceVersions}=require('./policy-source-versions.cjs');
function sourceObservation(value){
 const i=issues(),v=record(value)?value:{};
 const now=time(v.now),at=time(v.at);
 if(now===null||at===null||!positive(v.maxEvidenceAgeMs))i.add('currentSources.time','explicit-observation-clock-required',null);
 else if(at>now||now-at>v.maxEvidenceAgeMs)i.add('currentSources.at','source-snapshot-not-fresh',v.at);
 const s=v.sourceIdentity;
 if(!record(s)||!text(s.appVersion)||!record(s.files)||SOURCE_FILES.some(f=>!hash(s.files[f]))||Object.values(s.files).some(v=>!hash(v))||!hash(s.sha256))
  i.add('currentSources.sourceIdentity','required-installed-source-identities-missing',null);
 else i.equal('currentSources.sourceIdentity.sha256',s.sha256,digest({appVersion:s.appVersion,files:s.files}));
 const sourceReview=inspectPolicySourceVersions(s?.files);
 i.missing.push(...sourceReview.missing.map(x=>({...x,field:'currentSources.sourceIdentity.'+x.field})));
 i.conflicts.push(...sourceReview.conflicts.map(x=>({...x,field:'currentSources.sourceIdentity.'+x.field})));
 for(const name of ['core','soul','user']){
  const item=v[name];
  if(!record(item)||typeof item.content!=='string'||!hash(item.sha256)||!integer(item.revision))i.add('currentSources.'+name,'source-content-revision-required',null);
  else i.equal('currentSources.'+name+'.sha256',item.sha256,sha(item.content));
  if(name!=='core'&&item?.truncated!==false)i.add('currentSources.'+name+'.truncated','untruncated-source-required',item?.truncated);
 }
 for(const id of Object.keys(SKILLS)){
  const item=v.skills?.[id];
  if(!record(item)||typeof item.content!=='string'||!hash(item.sha256)||!['user','bundled'].includes(item.source)||(item.source==='user'?!positive(item.revision):!text(item.revision)))
   i.add('currentSources.skills.'+id,'fixed-skill-source-required',null);
  else i.equal('currentSources.skills.'+id+'.sha256',item.sha256,sha(item.content));
 }
 if(v.workflow?.nodeId!=='agent'||typeof v.workflow.prompt!=='string')i.add('currentSources.workflow','fixed-workflow-source-required',null);
 if(!Array.isArray(v.tools)||v.tools.length!==2||v.tools.some((t,n)=>t?.type!=='function'||t.function?.name!==TOOLS[n]))
  i.add('currentSources.tools','exact-two-outgoing-tools-required',null);
 let snapshot=null,snapshotSha256=null;
 try{snapshot=structuredClone(without(v,['at','now','maxEvidenceAgeMs']));snapshotSha256=digest(snapshot);}
 catch{i.add('currentSources','invalid-json-sources',null);}
 return {...i,complete:!i.missing.length&&!i.conflicts.length,snapshot,snapshotSha256,at:v.at??null};
}
function descriptions(tool){
 const out=[];const visit=(v,field)=>{if(!v||typeof v!=='object')return;for(const[k,x]of Object.entries(v)){
  const f=field?field+'.'+k:k;if(k==='description'&&typeof x==='string'&&x)out.push(f+':\n'+x);else if(x&&typeof x==='object')visit(x,f);
 }};visit(tool,'');return out.join('\n\n');
}
function encodedDocument(prompt,prefix,i){
 const lines=typeof prompt==='string'?prompt.split('\n').filter(line=>line.startsWith(prefix)):[];
 if(lines.length!==1){i.add(prefix,'exact-identity-document-required',lines.length,1);return null;}
 try{const value=JSON.parse(lines[0].slice(prefix.length));if(!record(value))throw Error();return {line:lines[0],value};}
 catch{i.add(prefix,'invalid-identity-document',null);return null;}
}
function validRunBinding(b){
 return record(b)&&['runId','nodeId','threadId','turnId','requestId','model'].every(k=>text(b[k]))&&b.nodeId==='agent';
}

// This allowlist describes inspected application code, not a caller assertion.
// Future composer revisions must be reviewed; unknown framing never becomes data.
/**
 * initialPayloadBytes must be exact captured UTF-8 Buffer/Uint8Array bytes.
 * runBinding: {runId,nodeId:'agent',threadId,turnId,requestId,model}, model unprefixed.
 * currentSources: {at,now,maxEvidenceAgeMs,sourceIdentity,core,soul,user,skills,workflow,tools}.
 * sourceIdentity: {appVersion,files:{fixed relative source paths:sha256,...},sha256};
 * its sha256 is canonical SHA({appVersion,files}). Additional source files remain included.
 * core/soul/user: {content,sha256,revision}; soul/user also truncated:false.
 * skills: both fixed library IDs -> {content,sha256,source:'user'|'bundled',revision}.
 * workflow:{nodeId:'agent',prompt}; tools: exact outgoing compatible definitions.
 * qualificationMetadata: {nativeRun,providerThread,sourceIdentity,transportCapture}.
 * transportCapture: {schema:CAPTURE_SCHEMA,kind:'exclusive-route'|'native-attempt',
 *  complete:true,droppedEvents:0,request:{at,method:'POST',path:'/v1/chat/completions',
 *  bodySha256,bodyBytes},response:{status:200,id?},binding:runBinding,
 *  runtime:{pid,processStartedAt,binarySha256,modelPath,modelSha256},
 *  exclusiveRoute?:{from,to,activeRunIds:[runId],matchingFirstRequestCount:1},
 *  nativeAttempt?:{httpAttemptId,serverRequestId,serverTaskId,slotId}}.
 * An exclusive-route binding qualifies observed policy delivery only. Full tracing
 * still requires native attempt/task identity plus independent coverage/parity gates.
 */
function normalizePolicyQualification(input={}){
 input=record(input)?input:{};
 const i=issues(),sources=sourceObservation(input.currentSources),a=input.audit,b=input.runBinding,m=input.qualificationMetadata||{};
 i.missing.push(...sources.missing);i.conflicts.push(...sources.conflicts);
 let bytes=null,payload=null,payloadSha256=null,toolSchemaSha256=null,stablePolicy=null,selectedPolicySha256=null;
 if(!(Buffer.isBuffer(input.initialPayloadBytes)||input.initialPayloadBytes instanceof Uint8Array))i.add('initialPayloadBytes','exact-raw-bytes-required',null);
 else try{
  bytes=Buffer.from(input.initialPayloadBytes);payloadSha256=sha(bytes);
  const decoded=new TextDecoder('utf-8',{fatal:true}).decode(bytes);payload=JSON.parse(decoded);
  if(!record(payload))throw Error('Object required');
 }catch{i.add('initialPayloadBytes','invalid-utf8-or-json',null);}
 const bindingOK=validRunBinding(b);
 if(!bindingOK)i.add('runBinding','complete-native-binding-required',null);
 const run=m.nativeRun,node=run?.nodes?.[b?.nodeId],thread=m.providerThread;
 const beforeNative=i.missing.length+i.conflicts.length;
 if(!record(run)||!record(node)||!record(thread))i.add('qualificationMetadata','native-run-and-provider-thread-required',null);
 if(bindingOK){
  for(const[field,x,y]of [
   ['nativeRun.id',run?.id,b.runId],['nativeRun.taskId',run?.taskId,b.runId],['nativeRun.requestId',run?.metadata?.clientRequestId,b.requestId],
   ['nativeRun.threadId',node?.threadId,b.threadId],['nativeRun.turnId',node?.turnId,b.turnId],['providerThread.id',thread?.id,b.threadId],
   ['providerThread.model',thread?.model,b.model],['payload.model',payload?.model,b.model],
   ['nativeRun.resolvedModel',node?.resolvedModel,'local_llamacpp::'+b.model],
  ])i.equal(field,x,y);
 }
 if(run?.parentRunId||run?.retryOf)i.add('nativeRun','fresh-run-required',null);
 if(thread?.providerId!=='local_llamacpp'||thread?.providerType!=='compatible')i.add('providerThread','actual-local-compatible-provider-required',{providerId:thread?.providerId??null,providerType:thread?.providerType??null});
 if(!Array.isArray(thread?.compactions)||thread.compactions.length)i.add('providerThread.compactions','uncompacted-first-input-required',null);
 i.equal('nativeRun.instructionAudit',node?.instructionAudit,a);
 const wf=Array.isArray(run?.workflow?.nodes)?run.workflow.nodes.filter(x=>x.id===b?.nodeId&&x.type==='agent'):[];
 if(wf.length!==1)i.add('nativeRun.workflow','one-agent-node-required',wf.length,1);
 else{
  i.equal('nativeRun.workflow.model',wf[0].model,'local_llamacpp::'+b?.model);
  i.equal('nativeRun.workflow.prompt',wf[0].prompt,input.currentSources?.workflow?.prompt);
 }
 i.equal('sourceIdentity',m.sourceIdentity,input.currentSources?.sourceIdentity);
 const nativeOK=i.missing.length+i.conflicts.length===beforeNative&&bindingOK;
 const auditAccepted=record(a)&&a.version===1&&a.adapter==='compatible'&&a.captureStage==='adapter-prepared'&&a.delivery==='accepted'&&a.tools?.status==='accepted'&&time(a.acceptedAt)!==null&&time(a.capturedAt)!==null&&time(a.capturedAt)<=time(a.acceptedAt);
 if(!auditAccepted)i.add('audit','actual-accepted-adapter-audit-required',null);
 if(time(a?.acceptedAt)!==null&&time(input.currentSources?.now)!==null&&time(a.acceptedAt)>time(input.currentSources.now))i.add('audit.acceptedAt','future-acceptance',a.acceptedAt);
 const beforeWire=i.missing.length+i.conflicts.length;
 const messages=payload?.messages;
 if(!Array.isArray(messages)||messages.length!==2||messages[0]?.role!=='system'||messages[1]?.role!=='user'||typeof messages[0].content!=='string'||typeof messages[1].content!=='string')
  i.add('payload.messages','fresh-system-and-user-messages-required',null);
 const system=messages?.[0]?.content,prompt=messages?.[1]?.content;
 i.equal('payload.system',system,thread?.developerInstructions);
 if(thread?.messages?.[0]?.role!=='user')i.add('providerThread.messages','first-user-message-required',null);
 i.equal('payload.firstUser',prompt,thread?.messages?.[0]?.content);
 if(!text(run?.input)||typeof prompt!=='string'||!prompt.includes(run.input))i.add('nativeRun.input','original-task-not-in-initial-input',null);
 const sections=Array.isArray(a?.sections)?a.sections:[];
 if(!sections.length)i.add('audit.sections','complete-section-list-required',null);
 const ids=new Set();let cursor=0;
 const soulDoc=encodedDocument(prompt,'SOUL_DOCUMENT=',i),userDoc=encodedDocument(prompt,'USER_PROFILE_DATA=',i);
 for(const s of sections){
  if(!record(s)||!text(s.id)||ids.has(s.id)){i.add('audit.sections','invalid-or-duplicate-section-id',s?.id);continue;}
  ids.add(s.id);
  if(typeof s.text!=='string'||!hash(s.sha256)||s.characters!==s.text?.length){i.add('audit.sections.'+s.id,'section-text-hash-size-required',null);continue;}
  i.equal('audit.sections.'+s.id+'.sha256',s.sha256,sha(s.text));
  if(s.status!=='accepted')i.add('audit.sections.'+s.id+'.status','section-not-accepted',s.status);
  if(!text(s.source)||!text(s.role)||!text(s.layer))i.add('audit.sections.'+s.id,'section-source-role-layer-required',null);
  if(s.layer==='prompt'){
   let needle=s.text;
   if(s.id==='soul'){
    needle=soulDoc?.line;
    i.equal('audit.soul.content',s.text,soulDoc?.value?.content);
    i.equal('audit.soul.wireSha256',s.wireSha256,needle===undefined?undefined:sha(needle));
    i.equal('audit.soul.wireCharacters',s.wireCharacters,needle?.length);
   }
   const index=typeof needle==='string'&&typeof prompt==='string'?prompt.indexOf(needle,cursor):-1;
   if(index<0)i.add('audit.sections.'+s.id,'section-not-in-ordered-first-input',null);
   else cursor=index+needle.length;
  }else if(!['developer','tool-definition'].includes(s.layer))i.add('audit.sections.'+s.id,'unsupported-initial-section-layer',s.layer);
 }
 for(const[id,source,layer]of [['benchmark-capability','lib/benchmark-workspace.mjs','developer'],['identity-context','lib/identity.mjs','prompt']]){
  const s=sections.find(s=>s?.id===id);if(!s||s.source!==source||s.layer!==layer||!text(s.text))i.add('audit.'+id,'missing-fixed-source-section',null);
 }
 for(const[label,prefix]of [['background','\nBACKGROUND WORKSPACE\n'],['directory','Explicit Action Directory is ON. Its action coordination requirement overrides the ordinary Planning Off exemption for this selected task only.\n']]){
  const matched=sections.filter(s=>s?.source==='lib/engine.mjs'&&s.layer==='prompt'&&typeof s.text==='string'&&s.text.startsWith(prefix));
  if(matched.length!==1)i.add('audit.'+label,'one-fixed-runtime-instruction-required',matched.length,1);
 }
 const dev=sections.filter(s=>s?.layer==='developer').map(s=>s.text).join('');
 i.equal('audit.developer.text',dev,system);
 if(typeof system==='string'){
  i.equal('audit.developer.sha256',a?.developer?.sha256,sha(system));
  i.equal('audit.developer.characters',a?.developer?.characters,system.length);
 }
 const actualTools=payload?.tools;
 if(!Array.isArray(actualTools)||actualTools.length!==2||actualTools.some((t,n)=>t?.type!=='function'||t.function?.name!==TOOLS[n]))i.add('payload.tools','exact-two-benchmark-tools-required',null);
 else{
  toolSchemaSha256=sha(JSON.stringify(actualTools));
  i.equal('audit.tools.sha256',a?.tools?.sha256,toolSchemaSha256);
  i.equal('audit.tools.names',a?.tools?.names,TOOLS);
  i.equal('audit.tools.count',a?.tools?.count,2);
  i.equal('currentSources.tools.wireSha256',Array.isArray(input.currentSources?.tools)?sha(JSON.stringify(input.currentSources.tools)):undefined,toolSchemaSha256);
  const td=sections.filter(s=>s?.layer==='tool-definition');
  if(td.length!==2)i.add('audit.toolDefinitions','exact-two-tool-sections-required',td.length,2);
  for(let n=0;n<actualTools.length;n++){
   const name=TOOLS[n],s=sections.find(s=>s?.id==='tool-definition-'+name+'-'+n),wire=JSON.stringify(actualTools[n]);
   if(!s){i.add('audit.toolDefinitions.'+name,'missing-fixed-tool-section',null);continue;}
   i.equal('audit.toolDefinitions.'+name+'.wireSha256',s.wireSha256,sha(wire));
   i.equal('audit.toolDefinitions.'+name+'.wireCharacters',s.wireCharacters,wire.length);
   i.equal('audit.toolDefinitions.'+name+'.text',s.text,descriptions(actualTools[n]));
   i.equal('audit.toolDefinitions.'+name+'.providerField',s.providerField,'tools['+n+']');
   i.equal('audit.toolDefinitions.'+name+'.source',s.source,'lib/providers.mjs: outgoing request');
  }
 }
 const fixed=(id,source,content,revision,sourceHash)=>{
  const found=sections.filter(s=>s?.id===id);
  if(found.length!==1){i.add('audit.'+id,'missing-fixed-source-section',found.length,1);return;}
  const s=found[0];i.equal('audit.'+id+'.source',s.source,source);i.equal('audit.'+id+'.text',s.text,content);
  if(revision!==undefined)i.equal('audit.'+id+'.revision',s.revision,revision);
  if(sourceHash!==undefined)i.equal('audit.'+id+'.sourceHash',s.sourceHash,sourceHash);
 };
 const cs=input.currentSources||{};
 fixed('core','Config / Instructions',cs.core?.content,cs.core?.revision,cs.core?.sha256);
 fixed('soul','SOUL.md',cs.soul?.content,cs.soul?.revision,cs.soul?.sha256);
 fixed('workflow-instructions','workflow node agent',cs.workflow?.prompt);
 for(const id of Object.keys(SKILLS)){
  const s=cs.skills?.[id],owner=s?.source==='user',origin=owner?'owner-edited':'bundled',rev=owner?'local revision ':'packaged revision ';
  const block='\n\n'+SKILLS[id]+' ('+origin+' execution method)\nSource: '+rev+s?.revision+'.\n'+s?.content+'\n';
  fixed('skill-'+id,(owner?'Owner skill: ':'Bundled skill: ')+id,block,s?.revision);
 }
 for(const[name,doc]of [['soul',soulDoc],['user',userDoc]]){
  i.equal(name+'.document.content',doc?.value?.content,cs[name]?.content);
  i.equal(name+'.document.revision',doc?.value?.revision,cs[name]?.revision);
  i.equal(name+'.document.hash',doc?.value?.hash,cs[name]?.sha256);
  i.equal(name+'.document.truncated',doc?.value?.truncated,false);
 }
 const contexts=Array.isArray(a?.contextSources)?a.contextSources:[];
 const users=contexts.filter(s=>s?.id==='user-profile');
 if(users.length!==1)i.add('audit.contextSources','one-user-profile-source-required',users.length,1);
 else{
  i.equal('audit.user.sha256',users[0].sha256,cs.user?.sha256);i.equal('audit.user.revision',users[0].revision,cs.user?.revision);
  i.equal('audit.user.characters',users[0].characters,cs.user?.content?.length);i.equal('audit.user.truncated',users[0].truncated,false);
 }
 const coverageProof=assessPromptCoverage({prompt,developer:system,sections,currentSources:cs,run,binding:b,sourceComplete:sources.complete});
 i.missing.push(...coverageProof.missing);i.conflicts.push(...coverageProof.conflicts);
 const promptCoverage=coverageProof.coverage,promptCoverageSha256=digest(promptCoverage);
 const wireOK=i.missing.length+i.conflicts.length===beforeWire;
 const capture=m.transportCapture;
 const beforeCapture=i.missing.length+i.conflicts.length;
 let bindingTier=null;
 if(capture?.schema!==CAPTURE_SCHEMA||capture.complete!==true||capture.droppedEvents!==0||!['exclusive-route','native-attempt'].includes(capture.kind))
  i.add('transportCapture','complete-native-capture-required',null);
 else bindingTier=capture.kind;
 i.equal('transportCapture.binding',capture?.binding,b);
 i.equal('transportCapture.bodySha256',capture?.request?.bodySha256,payloadSha256);
 i.equal('transportCapture.bodyBytes',capture?.request?.bodyBytes,bytes?.length);
 if(capture?.request?.method!=='POST'||capture?.request?.path!=='/v1/chat/completions'||capture?.response?.status!==200)i.add('transportCapture','accepted-compatible-request-required',null);
 const sent=time(capture?.request?.at),created=time(run?.createdAt),accepted=time(a?.acceptedAt);
 if(sent===null||created===null||accepted===null||sent<created||sent>accepted)i.add('transportCapture.request.at','native-request-time-not-bound',capture?.request?.at);
 const rt=capture?.runtime;
 if(!positive(rt?.pid)||time(rt?.processStartedAt)===null||!hash(rt?.binarySha256)||!hash(rt?.modelSha256)||typeof rt?.modelPath!=='string'||!/^[A-Za-z]:[\\/]/.test(rt.modelPath))
  i.add('transportCapture.runtime','observed-runtime-model-identity-required',null);
 else if(time(rt.processStartedAt)>sent)i.add('transportCapture.runtime','runtime-starts-after-request',null);
 if(bindingTier==='exclusive-route'){
  const ex=capture.exclusiveRoute;
  i.equal('transportCapture.exclusiveRoute.activeRunIds',ex?.activeRunIds,bindingOK?[b.runId]:undefined);
  if(ex?.matchingFirstRequestCount!==1||time(ex?.from)===null||time(ex?.to)===null||time(ex.from)>sent||time(ex.to)<accepted)
   i.add('transportCapture.exclusiveRoute','unique-exclusive-first-request-required',null);
 }else if(bindingTier==='native-attempt'){
  const n=capture.nativeAttempt;
  if(!text(n?.httpAttemptId)||!text(n?.serverRequestId)||!integer(n?.serverTaskId)||!integer(n?.slotId)||!text(capture.response?.id))
   i.add('transportCapture.nativeAttempt','exact-native-attempt-response-binding-required',null);
 }
 const captureOK=i.missing.length+i.conflicts.length===beforeCapture&&bindingTier!==null;
 try{
  stablePolicy={composer:coverageProof.descriptor,composerSha256:promptCoverage.composerSha256,
   unaccountedPromptSpans:promptCoverage.prompt.unmatched,missingPromptSpans:promptCoverage.prompt.missingExpected,
   unaccountedDeveloperSpans:promptCoverage.developer.unmatched,missingDeveloperSpans:promptCoverage.developer.missingExpected,
   sections:sections.map(s=>record(s)?without(s,['status','capturedAt','acceptedAt']):structuredClone(s)),
   developer:structuredClone(a?.developer??null),tools:without(a?.tools,['status']),contextSources:structuredClone(contexts),
   requestControls:without(payload,['model','messages','tools']),sourceSnapshotSha256:sources.snapshotSha256};
  selectedPolicySha256=digest(stablePolicy);
 }catch{i.add('stablePolicy','invalid-policy-json',null);}
 const complete=!i.missing.length&&!i.conflicts.length;
 let auditSha256=null,transportCaptureSha256=null;try{auditSha256=digest(a);transportCaptureSha256=digest(capture);}catch{}
 return {schema:SCHEMA,complete,auditSha256,transportCaptureSha256,promptCoverage,promptCoverageSha256,deliveryObserved:auditAccepted&&nativeOK&&wireOK&&captureOK,
  bindingTier,traceBindingComplete:complete&&bindingTier==='native-attempt',
  // No policy helper can certify activation coverage, runtime parity, or a score.
  traceComparable:false,scorable:false,policyReviewRequired:true,
  binding:bindingOK?structuredClone(b):null,acceptedAt:a?.acceptedAt??null,
  sourceObservation:{at:input.currentSources?.at??null,now:input.currentSources?.now??null,maxEvidenceAgeMs:input.currentSources?.maxEvidenceAgeMs??null},
  payloadSha256,payloadBytes:bytes?.length??null,selectedPolicySha256,toolSchemaSha256,
  stablePolicy,sourceSnapshot:sources.snapshot,sourceSnapshotSha256:sources.snapshotSha256,
  missing:i.missing,conflicts:i.conflicts};
}

// Structural and retained-source consistency only. Original normalization binds
// the exact payload/capture; this predicate cannot authenticate caller-rewritten
// native facts or payload SHA values without their preserved evidence artifacts.
function qualificationShape(q){
 if(q?.schema!==SCHEMA||q.complete!==true||q.deliveryObserved!==true||!validRunBinding(q.binding)||time(q.acceptedAt)===null||!hash(q.payloadSha256)||!positive(q.payloadBytes)||!hash(q.auditSha256)||!hash(q.transportCaptureSha256)||!hash(q.toolSchemaSha256))return false;
 if(q.scorable!==false||q.traceComparable!==false||q.policyReviewRequired!==true||!Array.isArray(q.missing)||q.missing.length||!Array.isArray(q.conflicts)||q.conflicts.length)return false;
 try{
  const sources=sourceObservation({...q.sourceSnapshot,...q.sourceObservation});
  if(!sources.complete||sources.snapshotSha256!==q.sourceSnapshotSha256||q.stablePolicy?.composerSha256!==q.promptCoverage?.composerSha256)return false;
  if(!validateStoredPromptCoverage({coverage:q.promptCoverage,coverageSha256:q.promptCoverageSha256,
   descriptor:q.stablePolicy.composer,sections:q.stablePolicy.sections,sourceSnapshot:q.sourceSnapshot,binding:q.binding}))return false;
  return q.selectedPolicySha256===digest(q.stablePolicy)&&q.sourceSnapshotSha256===digest(q.sourceSnapshot)&&q.stablePolicy.sourceSnapshotSha256===q.sourceSnapshotSha256&&q.stablePolicy.tools.sha256===q.toolSchemaSha256;
 }catch{return false;}
}
function comparePolicyQualification(prior,current){
 const i=issues();
 if(!qualificationShape(prior))i.add('prior','complete-prior-qualification-required',null);
 if(!qualificationShape(current))i.add('current','complete-current-qualification-required',null);
 i.equal('selectedPolicySha256',current?.selectedPolicySha256,prior?.selectedPolicySha256);
 i.equal('toolSchemaSha256',current?.toolSchemaSha256,prior?.toolSchemaSha256);
 i.equal('sourceSnapshotSha256',current?.sourceSnapshotSha256,prior?.sourceSnapshotSha256);
 return {matching:!i.missing.length&&!i.conflicts.length,missing:i.missing,conflicts:i.conflicts,
  priorRunId:prior?.binding?.runId??null,currentRunId:current?.binding?.runId??null,
  payloadsIndependentlyBound:qualificationShape(prior)&&qualificationShape(current)};
}
function assessCurrentPolicySources(prior,currentSources){
 const i=issues(),current=sourceObservation(currentSources);
 i.missing.push(...current.missing);i.conflicts.push(...current.conflicts);
 if(!qualificationShape(prior))i.add('prior','complete-prior-qualification-required',null);
 i.equal('sourceSnapshotSha256',current.snapshotSha256,prior?.sourceSnapshotSha256);
 return {matching:!i.missing.length&&!i.conflicts.length,kind:'prior-qualified-policy-current-sources',
  currentRunAccepted:false,priorAcceptedRunId:prior?.binding?.runId??null,priorAcceptedAt:prior?.acceptedAt??null,
  observedAt:current.at,selectedPolicySha256:prior?.selectedPolicySha256??null,missing:i.missing,conflicts:i.conflicts};
}
module.exports={SCHEMA,CAPTURE_SCHEMA,SOURCE_FILES,SOURCE_CANDIDATES,inspectPolicySourceVersions,PROMPT_COVERAGE_SCHEMA,isCompletePolicyQualification:qualificationShape,normalizePolicyQualification,comparePolicyQualification,assessCurrentPolicySources};
