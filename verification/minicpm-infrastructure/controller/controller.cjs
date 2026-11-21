'use strict';
// A saved, externally driven state machine. No tool, network or inference calls.
const fs = require('node:fs');
const path = require('node:path');
const api = require('./native-api.cjs');
function fail(message) { throw new Error(message); }
// The guarded campaign separately records profile/mode drift while keeping owned cleanup available.
function owned(run,config,id){return config.benchmark?api.assertOwnedIdentity(run,config,id):api.assertOwned(run,config,id);}
function stamp(now) { const t = Date.parse(now); if (!Number.isFinite(t)) fail('A valid observation time is required'); return t; }
function createState(config, now = new Date().toISOString()) {
  config = api.validate(config); stamp(now);
  return {schema:'blackice.minicpm.directory-controller.v2',revision:0,createdAt:now,config,configSha256:api.sha(config),phase:'new',nextIndex:0,pending:null,history:[],run:null,evidence:null,blockers:[]};
}
function valid(state) {
  if (state?.schema !== 'blackice.minicpm.directory-controller.v2' || api.sha(state.config) !== state.configSha256) fail('Controller journal/config identity invalid');
  api.validate(state.config);
  return state;
}
function planNext(state, now = new Date().toISOString(), connectionId = state.config.connectionId) {
  valid(state); stamp(now);
  if (connectionId !== state.config.connectionId) return {type:'blocked',reason:'connection-changed',pending:state.pending};
  if (state.pending?.artifactRequired) return {type:'retrieve-complete-saved-artifact',artifact:state.pending.artifactRequired,operation:state.pending};
  if (state.pending) return {type:'recover-same-operation',operation:state.pending};
  if (state.phase === 'blocked') return {type:'blocked',reasons:state.blockers};
  let op;
  if (state.phase === 'new') op = api.prepare(state.config, state.nextIndex);
  else if (state.phase === 'prepared') op = api.start(state.config, state.nextIndex, state.authoredBody);
  else if (state.phase === 'running') {
    if (api.terminal(state.run?.status) && state.run?.settled === true) op = api.collect(state.config, state.nextIndex, state.run.id);
    else if (stamp(now) >= stamp(state.cleanupDeadlineAt)) return {type:'blocked',reason:'settlement-deadline-exceeded',run:state.run};
    else op = api.observe(state.config, state.nextIndex, state.run.id, state.deadlineAt, state.cleanupDeadlineAt);
  } else if (state.phase === 'needs-provider-transcript') return {type:'collect-owned-provider-transcript',runId:state.run.id,taskId:state.run.taskId,threadId:state.evidence.providerThreadId,workspace:state.config.workspace,model:state.config.model,note:'Read only the exact run-bound provider-threads JSON after settlement; validate and preserve its bytes/hash. No endpoint exposing its full payload was verified.'};
  else if (state.phase === 'complete') return {type:'complete'};
  else return {type:'blocked',reason:'unknown-controller-phase'};
  return {type:'submit',operation:{...op,createdAt:now,connectionId:state.config.connectionId,jobId:null,argumentsSha256:api.sha(op.arguments)}};
}
function commitOperation(state, planned) {
  valid(state);
  if (state.pending) fail('A pending action must be reconciled before another is created');
  if (planned.type !== 'submit') fail('Only an explicit planned submission can be committed');
  const next = structuredClone(state);
  next.pending = structuredClone(planned.operation); next.nextIndex++; next.revision++;
  // Caller must fsync this state before actually submitting these arguments.
  return next;
}
function recordSubmission(state, {jobId,connectionId,requestId}) {
  valid(state); const next=structuredClone(state),p=next.pending;
  if (!p || connectionId!==p.connectionId || requestId!==p.requestId || !/^direct_[a-f0-9]{64}$/.test(jobId||'')) fail('Durable job does not match the pending exact action');
  if (p.jobId && p.jobId!==jobId) fail('A pending operation cannot acquire a different job');
  p.jobId=jobId;next.revision++;return next;
}
function acceptResponse(state, {jobId,connectionId,jobStatus,jobSettled,value,evidence}, now=new Date().toISOString()) {
  valid(state);stamp(now);const next=structuredClone(state),p=next.pending;
  if(!p||p.jobId!==jobId||p.connectionId!==connectionId||api.sha(p.arguments)!==p.argumentsSha256)fail('Completion does not match exact pending job');
  if(jobSettled!==true||!['succeeded','completed','failed','cancelled','interrupted'].includes(jobStatus))fail('The durable frontend job has not settled');
  if(!evidence||typeof evidence.path!=='string'||!/^[a-f0-9]{64}$/.test(evidence.sha256||''))fail('Preserved raw response path/hash required before projection');
  if(value?.artifactRequired){next.pending.artifactRequired=value.artifactRequired;next.pending.artifactReceipt=evidence;next.revision++;return next;}
  next.history.push({...p,finishedAt:now,jobStatus,evidence});next.pending=null;next.revision++;
  const block=reason=>{next.phase='blocked';next.blockers.push({reason,operation:p.kind,jobId,at:now});return next;};
  if(!['succeeded','completed'].includes(jobStatus))return block('frontend-job-failed-or-cancelled; effects may remain unknown');
  if(value?.kind!==p.kind)return block('frontend-response-kind-mismatch');
  try {
    if(p.kind==='prepare'){
      const b=value.body;
      if(b?.requestId!==next.config.requestId||b?.workflow?.id!==next.config.workflowId||b?.workflow?.nodes?.find(n=>n.id==='agent')?.model!==next.config.model||b?.input?.task!==next.config.task||api.windowsPath(b?.input?.cwd||'')!==api.windowsPath(next.config.workspace)||b?.input?.directoryMode!=='off'||b?.input?.directoryActions!=='on'||b?.input?.directoryDiagnostics!=='maximal')fail('Prepared request does not match frozen task');
      next.authoredBody=b;next.authoredBodySha256=api.sha(b);next.phase='prepared';
    } else if(p.kind==='start'){
      if(api.sha(next.authoredBody)!==next.authoredBodySha256)fail('Authored start body changed');
      next.run=owned(value.run,next.config);
      const admitted=stamp(next.run.createdAt);next.deadlineAt=new Date(admitted+next.config.budgets.wallMs).toISOString();next.cleanupDeadlineAt=new Date(admitted+next.config.budgets.wallMs+next.config.budgets.settlementGraceMs).toISOString();next.phase='running';
    } else if(p.kind==='observe'){
      if(value.run)next.run=owned(value.run,next.config,next.run.id);
      next.windows||=[];next.windows.push({startedAt:value.startedAt,finishedAt:value.finishedAt,observations:value.observations,cancellations:value.cancellations,error:value.error||null});
      if(value.error)return block('polling-window-error; inspect owned native run before any new effect');
      if(value.cleanupExpired&&!(api.terminal(next.run.status)&&next.run.settled===true))return block('settlement-deadline-exceeded');
    } else if(p.kind==='collect'){
      next.run=owned(value.run,next.config,next.run.id);
      if(!api.terminal(next.run.status)||next.run.settled!==true)fail('Final native run not terminal and settled');
      next.evidence=value;next.phase='needs-provider-transcript';
    }
  }catch(error){return block(error.message);}
  return next;
}
function attachProjection(state, providerEvidence, projection) {
  valid(state);if(state.phase!=='needs-provider-transcript')fail('Final native evidence must be collected first');
  if(!providerEvidence||typeof providerEvidence.path!=='string'||!/^[a-f0-9]{64}$/.test(providerEvidence.sha256||''))fail('Exact provider evidence path/hash required');
  const next=structuredClone(state);next.providerEvidence=providerEvidence;next.projection=projection;
  const validProjection=projection?.validation?.valid===true&&projection?.receipt?.run?.terminal===true&&projection.receipt.run.settled===true&&projection.receipt.actions?.settled===true;
  next.phase=validProjection?'complete':'blocked';if(!validProjection)next.blockers.push({reason:'execution-evidence-unverified',issues:projection?.validation?.issues||['Missing validated projection']});next.revision++;return next;
}
function saveJournal(destination,state,{expectedRevision}={}) {
  valid(state);const dir=path.dirname(path.resolve(destination));fs.mkdirSync(dir,{recursive:true});
  if(fs.existsSync(destination)){const old=JSON.parse(fs.readFileSync(destination,'utf8'));if(expectedRevision===undefined||old.revision!==expectedRevision)fail('Journal revision conflict');}
  else if(expectedRevision!==undefined)fail('Expected journal does not exist');
  const bytes=Buffer.from(JSON.stringify(state,null,2)+'\n'),tmp=destination+'.'+process.pid+'.tmp';
  const fd=fs.openSync(tmp,'wx');try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  fs.renameSync(tmp,destination);const read=fs.readFileSync(destination);if(!read.equals(bytes))fail('Journal readback differs');
  return {path:path.resolve(destination),sha256:api.sha(read),bytes:read.length,revision:state.revision};
}
function saveEvidence(directory,kind,value) {
  const bytes=Buffer.from(JSON.stringify(value,null,2)+'\n'),digest=api.sha(bytes),destination=path.join(directory,`${kind}-${digest}.json`);
  fs.mkdirSync(directory,{recursive:true});try{fs.writeFileSync(destination,bytes,{flag:'wx'});}catch(e){if(e.code!=='EEXIST'||!fs.readFileSync(destination).equals(bytes))throw e;}
  return {path:path.resolve(destination),sha256:digest,bytes:bytes.length};
}
module.exports={createState,planNext,commitOperation,recordSubmission,acceptResponse,attachProjection,saveJournal,saveEvidence};
