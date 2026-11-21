'use strict';
// Pure wrapper over the historical controller. Callers persist returned state before
// submitting a returned operation. This module never executes tools or providers.
// Use this wrapper throughout a fresh campaign; no legacy-state import/fallback.
// A campaign "complete" means valid settled evidence under unchanged conditions,
// not a passing coding task. Model correctness remains the independent grader's job.
const core=require('./controller.cjs'),api=require('./native-api.cjs'),path=require('node:path');
const conditions=require('./run-conditions.cjs'),evidence=require('./evidence.cjs');
const SCHEMA='blackice.minicpm.guarded-campaign.v1';
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const fail=message=>{throw new Error(message);};
function time(now){if(conditions.timestamp(now)===null)fail('An explicit UTC ISO observation time is required');}

const scaffoldFiles=['METHOD.md','TASK.md','task.json','public-cases.json','test-public.cjs','test-support/grade-modules.cjs','test-support/module-worker.cjs'].sort();
function scaffold(state){
 const cfg=state.controller.config,request=api.validateBenchmarkRequest(cfg.benchmark),raw=state.scaffoldReceiptText;
 if(typeof raw!=='string'||Buffer.byteLength(raw)>65536||api.sha(raw)!==request.scaffoldReceiptSha256)fail('Exact controller-owned scaffold receipt bytes required');
 const r=JSON.parse(raw),smoke=cfg.caseId==='D0';
 if(r?.schema!==(smoke?'blackice.minicpm.directory-smoke-scaffold.v1':'blackice.minicpm.agentic-scaffold.v1')||r.caseId!==cfg.caseId||smoke&&r.scored!==false||r.publicCaseCount!==2||api.windowsPath(r.workspace||'')!==api.windowsPath(cfg.workspace)||!r.immutableFiles||JSON.stringify(Object.keys(r.immutableFiles).sort())!==JSON.stringify(scaffoldFiles)||Object.values(r.immutableFiles).some(x=>!hash(x))||r.method?.path!=='METHOD.md'||r.method.sha256!==r.immutableFiles['METHOD.md']||r.method.sha256!==cfg.method.sha256||!r.initialSource||Object.keys(r.initialSource).length!==1||!hash(r.initialSource['src/index.cjs']))fail('Scaffold receipt does not bind this exact task/workspace/method');
 const rel=path.win32.relative(cfg.workspace,request.scaffoldReceiptPath);
 if(!rel||(!path.win32.isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+path.win32.sep)))fail('Controller receipt must be outside the model workspace');
 const name=smoke?'directorySmoke':r.artifactContract?.namedExport;
 if(typeof name!=='string'||!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name))fail('Scaffold named export missing');
 return {receipt:r,functionName:name};
}
function runConditionIssues(state,run){
 const cfg=state.controller.config,issues=[];
 try{api.assertOwned(run,cfg);}catch(error){issues.push(error.message);}
 if(run.chatPlanning!==state.manifest.shared.modes.chatPlanning||run.pastChats!==state.manifest.shared.modes.pastChats)issues.push('Admitted Chat Planning/Past Chats mode differs');
 const agents=Array.isArray(run.workflow?.nodes)?run.workflow.nodes.filter(node=>node?.type==='agent'):[];
 if(agents.length!==1||agents.some(node=>{const effective=node.context||run.workflow?.settings?.context;return !effective||conditions.digest(effective)!==conditions.digest(cfg.context);}))issues.push('Admitted effective agent context differs');
 const names=run.nodes?.agent?.toolNames;
 if(Array.isArray(names)&&names.length&&JSON.stringify([...names].sort())!==JSON.stringify(['relay_directory_action','relay_workspace']))issues.push('Admitted effective tool catalog differs');
 const profile=run.benchmark;
 if(!profile||typeof profile!=='object'||Array.isArray(profile)){issues.push('Normalized benchmark profile missing');return issues;}
 const {receipt,functionName}=scaffold(state);
 const expected={schema:'blackice.minicpm.benchmark-profile.v1',profile:'minicpm-code-v1',workspace:profile.workspace,caseId:cfg.caseId,publicCaseCount:2,command:'node test-public.cjs',scaffoldReceiptPath:profile.scaffoldReceiptPath,scaffoldReceiptSha256:cfg.benchmark.scaffoldReceiptSha256,immutableFiles:receipt.immutableFiles,limits:{maxModules:32,maxSourceBytes:200000,maxDepth:8,commandTimeoutMs:10000},isolation:'Enforced benchmark tool/API boundary with a restricted pure-function worker; not an operating-system sandbox.',functionName};
 const {contractSha256,...actual}=profile;
 if(typeof profile.workspace!=='string'||typeof profile.scaffoldReceiptPath!=='string'||conditions.digest(actual)!==conditions.digest(expected)||contractSha256!==conditions.digest(actual))issues.push('Normalized benchmark contract differs from frozen receipt');
 return issues;
}

function runBinding(state){
 const run=state.controller.run;if(!run)fail('No admitted owned run');
 api.assertOwnedIdentity(run,state.controller.config);
 return {runId:run.id,requestId:state.binding.requestId,model:state.binding.model,manifestSha256:state.manifestSha256,connectionId:state.binding.connectionId,arm:state.binding.arm};
}
function assessmentBinding(state,phase,now,connectionId){
 const b={phase,now,connectionId,arm:state.binding.arm,model:state.binding.model};
 if(phase==='final'){
  const settled=conditions.timestamp(state.settledCollectionAt),captured=conditions.timestamp(state.payloadBinding?.at);
  if(settled===null||captured===null)fail('Final conditions lack a settled observation or payload capture time');
  Object.assign(b,runBinding(state),{phase,now,connectionId,payloadSha256:state.payloadBinding.payloadSha256,notBeforeAt:new Date(Math.max(settled,captured)).toISOString()});
 }
 return b;
}
function valid(state){
 if(state?.schema!==SCHEMA||state.manifestSha256!==conditions.manifestSha256(state.manifest))fail('Campaign manifest identity invalid');
 if(state.bindingSha256!==conditions.digest(state.binding))fail('Campaign binding identity invalid');
 const c=state.controller?.config,b=state.binding;
 if(!c||state.controller.configSha256!==api.sha(c)||b.requestId!==c.requestId||b.model!==c.model||b.workflowId!==c.workflowId||b.connectionId!==c.connectionId||!Object.hasOwn(state.manifest.arms,b.arm))fail('Campaign/controller binding mismatch');
 api.validate(c);
 if(!c.benchmark||b.benchmarkRequestSha256!==conditions.digest(c.benchmark))fail('Campaign requires its bound benchmark profile request');
 scaffold(state);
 for(const key of ['windowTokens','autoCompact','outputReserveTokens','headroomTokens'])if(c.context[key]!==state.manifest.shared.context[key])fail('Requested context differs from manifest: '+key);
 if(state.payloadBinding){
  if(state.payloadBindingSha256!==conditions.digest(state.payloadBinding))fail('Provider payload binding changed');
  const expected=runBinding(state);for(const [key,value]of Object.entries(expected))if(state.payloadBinding[key]!==value)fail('Provider payload binding mismatch: '+key);
 }
 if(state.projectionSha256&&state.projectionSha256!==conditions.digest(state.controller.projection))fail('Saved execution projection changed');
 if(state.phase==='complete'){
  if(state.controller.phase!=='complete'||state.drifted||!state.payloadBinding||!state.finalRecord||!state.projectionSha256)fail('Campaign completion lacks bound evidence');
  const checked=conditions.assessConditions(state.manifest,state.finalRecord.evidence,assessmentBinding(state,'final',state.finalRecord.checkedAt,state.binding.connectionId));
  if(checked.status!=='matching'||state.finalRecord.assessment.status!=='matching')fail('Campaign completion conditions are not matching');
 }
 return state;
}
function withCore(state,controller){const next=structuredClone(state);next.controller=controller;next.revision++;return next;}
function createCampaign({config,manifest,arm,scaffoldReceiptText},now){
 time(now);const frozen=conditions.validateManifest(manifest);
 if(!Object.hasOwn(frozen.arms,arm))fail('Choose a declared model arm');
 if(!config?.benchmark)fail('Fresh campaigns require the native benchmark profile');
 const controller=core.createState(config,now);
 const binding={arm,model:controller.config.model,requestId:controller.config.requestId,workflowId:controller.config.workflowId,connectionId:controller.config.connectionId,benchmarkRequestSha256:conditions.digest(controller.config.benchmark)};
 const state={schema:SCHEMA,revision:0,createdAt:now,manifest:frozen,manifestSha256:conditions.manifestSha256(frozen),binding,bindingSha256:conditions.digest(binding),controller,scaffoldReceiptText,settledCollectionAt:null,runConditionFailures:[],phase:'active',admission:null,payloadBinding:null,payloadBindingSha256:null,projectionSha256:null,finalRecord:null,conditionHistory:[],drifted:false};
 return valid(state);
}
// Record every externally collected continuation snapshot before the next operation.
// Missing/stale/foreign evidence is retained as rejected/unknown; it never blocks
// cleanup or serves as proof of a condition change. Accepted drift is permanent.
function continuationAssessment(state,{now,connectionId,evidence:observation}={}){
 const expected=runBinding(state);
 if(connectionId!==state.binding.connectionId)return {status:'unknown',matching:false,envelopeValid:false,phase:'continuation',manifestSha256:state.manifestSha256,checkedAt:now,evidenceAt:null,reasons:[{field:'connectionId',code:'connection-changed-or-unverified',status:'unknown',expected:state.binding.connectionId,observed:connectionId??null,present:connectionId!==undefined}]};
 const assessment=conditions.assessConditions(state.manifest,observation,{...expected,phase:'continuation',now,notBeforeAt:state.controller.run.createdAt});
 return assessment.envelopeValid?assessment:{...assessment,status:'unknown',matching:false};
}
function recordConditions(state,options={}){
 valid(state);time(options.now);
 if(state.phase==='complete')fail('A completed campaign record is immutable');
 const assessment=continuationAssessment(state,options),next=structuredClone(state);
 let evidenceSha256=null;try{if(options.evidence!==undefined)evidenceSha256=conditions.digest(options.evidence);}catch{}
 next.revision++;next.conditionHistory.push({phase:'continuation',at:options.now,accepted:assessment.envelopeValid,evidenceSha256,assessment});
 if(assessment.envelopeValid&&assessment.status==='drifted'){
  next.drifted=true;next.runConditionFailures.push({at:options.now,operation:'conditions',runId:next.controller.run.id,issues:assessment.reasons.filter(x=>x.status==='drifted').map(x=>x.field+' differs'),assessment});
 }
 return valid(next);
}
function planNext(state,{now,connectionId,evidence:observation}={}){
 valid(state);time(now);
 if(connectionId!==state.binding.connectionId)return {type:'blocked',reason:'connection-changed-or-unverified',pending:state.controller.pending};
 if(state.controller.phase==='prepared'&&!state.controller.pending&&(!state.controller.authoredBody||api.sha(state.controller.authoredBody)!==state.controller.authoredBodySha256||!preparedMatches(state)))return {type:'blocked',reason:'prepared-request-integrity-or-condition-mismatch'};
 // Recovery and owned-run observation/collection retain the old operation identity.
 // Changed runtime conditions must never prevent cleanup of work already admitted.
 const planned=core.planNext(state.controller,now,connectionId);
 if(planned.type==='complete'){
  if(state.phase==='complete')return {type:'complete',manifestSha256:state.manifestSha256,runId:state.controller.run.id};
  if(state.drifted)return {type:'blocked',reason:'campaign-condition-drift',assessment:state.finalRecord?.assessment};
  return {type:'collect-final-conditions',binding:runBinding(state),payloadBound:!!state.payloadBinding};
 }
 const continuation=state.controller.run&&observation!==undefined?continuationAssessment(state,{now,connectionId,evidence:observation}):null;
 if(planned.type==='submit'&&planned.operation.kind==='observe'&&(state.runConditionFailures.length||continuation?.envelopeValid&&continuation.status==='drifted')){
  const op=api.observe(state.controller.config,state.controller.nextIndex,state.controller.run.id,now,state.controller.cleanupDeadlineAt);
  return {type:'submit',operation:{...op,createdAt:now,connectionId,jobId:null,argumentsSha256:api.sha(op.arguments)}};
 }
 if(planned.type!=='submit'||planned.operation.kind!=='start')return planned;
 const assessment=conditions.assessConditions(state.manifest,observation,assessmentBinding(state,'admission',now,connectionId));
 if(assessment.status!=='matching')return {type:'blocked',reason:'admission-conditions-'+assessment.status,assessment};
 return {...planned,conditionGate:{manifestSha256:state.manifestSha256,bindingSha256:state.bindingSha256,evidenceSha256:conditions.digest(observation),assessment}};
}
function commitOperation(state,planned,options){
 valid(state);
 const current=planNext(state,options);
 if(current.type!=='submit'||planned?.type!=='submit')fail('No currently permitted campaign operation to commit');
 const a=planned.operation,b=current.operation;
 if(a?.kind!==b.kind||a.requestId!==b.requestId||a.connectionId!==b.connectionId||api.sha(a.arguments)!==api.sha(b.arguments)||a.argumentsSha256!==api.sha(a.arguments))fail('Planned operation changed or no longer identifies the next action');
 let next=withCore(state,core.commitOperation(state.controller,current));
 if(state.controller.run&&['observe','collect'].includes(b.kind))next=recordConditions(next,options);
 if(b.kind==='start'){
  next.admission={manifestSha256:state.manifestSha256,bindingSha256:state.bindingSha256,operationArgumentsSha256:b.argumentsSha256,checkedAt:options.now,evidence:structuredClone(options.evidence),assessment:current.conditionGate.assessment};
  next.conditionHistory.push({phase:'admission',at:options.now,assessment:current.conditionGate.assessment,evidenceSha256:current.conditionGate.evidenceSha256});
 }
 return next;
}
function recordSubmission(state,submission){valid(state);return withCore(state,core.recordSubmission(state.controller,submission));}
function preparedMatches(state){
 const body=state.controller.authoredBody,cfg=state.controller.config,s=body?.workflow?.settings,input=body?.input,agent=body?.workflow?.nodes?.find(n=>n.id==='agent');
 return !!(s?.context&&input?.benchmark&&agent&&body.requestId===cfg.requestId&&body.workflow.id===cfg.workflowId&&agent.model===cfg.model&&body.workflow.nodes.filter(n=>n.type==='agent').length===1&&input.task===cfg.task&&api.windowsPath(input.cwd||'')===api.windowsPath(cfg.workspace)&&api.windowsPath(s.cwd||'')===api.windowsPath(cfg.workspace)&&s.planningMode==='off'&&conditions.digest(s.context)===conditions.digest(cfg.context)&&(!agent.context||conditions.digest(agent.context)===conditions.digest(cfg.context))&&input.directoryActions===state.manifest.shared.modes.directoryActions&&input.directoryMode===state.manifest.shared.modes.directoryMode&&input.directoryDiagnostics==='maximal'&&input.chatPlanning===state.manifest.shared.modes.chatPlanning&&input.pastChats===state.manifest.shared.modes.pastChats&&input.planningMode==='off'&&conditions.digest(input.benchmark)===conditions.digest(cfg.benchmark));
}
function acceptResponse(state,response,now){
 valid(state);time(now);
 const kind=state.controller.pending?.kind;
 if(kind==='start'){
  const gate=state.admission;
  if(!gate||gate.manifestSha256!==state.manifestSha256||gate.bindingSha256!==state.bindingSha256||gate.operationArgumentsSha256!==state.controller.pending.argumentsSha256)fail('Start lacks its committed admission evidence');
  const checked=conditions.assessConditions(state.manifest,gate.evidence,assessmentBinding(state,'admission',gate.checkedAt,state.binding.connectionId));
  if(checked.status!=='matching')fail('Committed admission evidence is invalid');
 }
 const next=withCore(state,core.acceptResponse(state.controller,response,now));
 if(kind==='prepare'&&next.controller.phase==='prepared'&&!preparedMatches(next)){
  next.controller.phase='blocked';next.controller.blockers.push({reason:'prepared-context-or-mode-mismatch',operation:'prepare',at:now});
 }
 if(kind==='collect'&&next.controller.phase==='needs-provider-transcript')next.settledCollectionAt=now;
 if(next.controller.run&&['start','observe','collect'].includes(kind)){
  const issues=runConditionIssues(next,next.controller.run);
  if(issues.length){next.drifted=true;next.runConditionFailures.push({at:now,operation:kind,runId:next.controller.run.id,issues});}
 }
 if(next.controller.phase==='blocked')next.phase='blocked';
 return next;
}
function bindPayload(state,binding,{now,connectionId}={}){
 valid(state);time(now);
 if(connectionId!==state.binding.connectionId)fail('Payload capture belongs to another connection');
 const expected=runBinding(state);
 for(const [key,value]of Object.entries(expected))if(binding?.[key]!==value)fail('Payload capture binding mismatch: '+key);
 if(!hash(binding?.payloadSha256)||conditions.timestamp(binding?.at)===null||conditions.timestamp(binding.at)>conditions.timestamp(now)||conditions.timestamp(binding.at)<Date.parse(state.controller.run.createdAt))fail('Invalid initial adapter payload identity/time');
 if(state.payloadBinding){
  if(conditions.digest(binding)!==state.payloadBindingSha256)fail('An initial provider payload cannot be rebound');
  return structuredClone(state);
 }
 const next=structuredClone(state);next.payloadBinding=structuredClone(binding);next.payloadBindingSha256=conditions.digest(binding);next.revision++;return next;
}
function attachTranscript(state,{providerEvidence,providerText}){
 valid(state);
 if(state.controller.phase!=='needs-provider-transcript')fail('Collect settled native evidence before attaching its transcript');
 if(typeof providerText!=='string'||!hash(providerEvidence?.sha256)||api.sha(providerText)!==providerEvidence.sha256)fail('Full provider transcript bytes do not match their preserved evidence hash');
 const providerThread=JSON.parse(providerText);
 // Do not accept a caller-supplied valid/complete flag as a projection.
 const projection=evidence.projectEvidence({config:state.controller.config,bundle:state.controller.evidence,providerThread,provenance:[providerEvidence]});
 const next=withCore(state,core.attachProjection(state.controller,providerEvidence,projection));
 next.projectionSha256=conditions.digest(projection);
 next.phase=next.controller.phase==='complete'?'awaiting-final-conditions':'blocked';
 return next;
}
function finalize(state,{now,connectionId,evidence:observation}={}){
 valid(state);time(now);
 if(state.phase==='complete')fail('A completed campaign record is immutable');
 if(state.controller.phase!=='complete'||!state.projectionSha256)fail('Validated settled execution evidence is required before final conditions');
 let assessment;
 if(!state.payloadBinding||conditions.timestamp(state.settledCollectionAt)===null)assessment={status:'unknown',matching:false,phase:'final',manifestSha256:state.manifestSha256,checkedAt:now,evidenceAt:null,reasons:[{field:'payloadBinding',code:'missing-run-payload-or-settlement-binding',status:'unknown',expected:'initial adapter payload digest tied to the admitted run',observed:null,present:false}]};
 else assessment=conditions.assessConditions(state.manifest,observation,assessmentBinding(state,'final',now,connectionId));
 const next=structuredClone(state);next.revision++;next.drifted=state.drifted||assessment.status==='drifted';
 if(state.drifted&&assessment.status==='matching')assessment={...assessment,status:'drifted',matching:false,reasons:[{field:'campaign',code:'earlier-condition-drift',status:'drifted',expected:'no recorded condition drift',observed:'earlier observed run conditions drifted',present:true}]};
 next.conditionHistory.push({phase:'final',at:now,assessment});
 next.finalRecord={checkedAt:now,evidence:observation===undefined?null:structuredClone(observation),assessment};
 next.phase=assessment.status==='matching'&&!next.drifted?'complete':next.drifted?'disqualified':'awaiting-final-conditions';
 return valid(next);
}
module.exports={SCHEMA,createCampaign,planNext,commitOperation,recordSubmission,acceptResponse,recordConditions,bindPayload,attachTranscript,finalize};
