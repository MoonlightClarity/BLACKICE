'use strict';
// Constructors only. This file never calls a browser, a model, or the network.
const crypto = require('node:crypto');
const path = require('node:path');
const sha = value => crypto.createHash('sha256').update(typeof value === 'string' || value instanceof Uint8Array ? value : JSON.stringify(value)).digest('hex');
const terminal = status => ['completed', 'failed', 'cancelled'].includes(status);
const windowsPath = value => path.win32.normalize(value).toLowerCase();
function check(value, message) { if (!value) throw new Error(message); }
function int(value, min, max, field) { check(Number.isSafeInteger(value) && value >= min && value <= max, `Invalid ${field}`); }
function validateBenchmarkRequest(value) {
  check(value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')==='profile,scaffoldReceiptPath,scaffoldReceiptSha256','Invalid benchmark request fields');
  check(value.profile==='minicpm-code-v1'&&/^[a-f0-9]{64}$/.test(value.scaffoldReceiptSha256||''),'Invalid benchmark profile/receipt hash');
  check(typeof value.scaffoldReceiptPath==='string'&&/^[A-Za-z]:[\\/]/.test(value.scaffoldReceiptPath)&&path.win32.isAbsolute(value.scaffoldReceiptPath)&&!value.scaffoldReceiptPath.includes('\0'),'Absolute benchmark receipt path required');
  return structuredClone(value);
}
function validate(config) {
  check(config && typeof config === 'object', 'Configuration is required');
  for (const key of ['controllerId', 'requestId', 'workflowId']) check(/^[A-Za-z0-9_-]{1,80}$/.test(config[key] || ''), `Invalid ${key}`);
  check(/^(?:D0|L[1-7])$/.test(config.caseId || ''), 'Invalid caseId');
  check(typeof config.connectionId === 'string' && config.connectionId.length > 0, 'Bound connectionId required');
  check(/^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/.test(config.origin || ''), 'Observed local frontend origin required');
  check(typeof config.workspace === 'string' && path.win32.isAbsolute(config.workspace) && /^[A-Za-z]:[\\/]/.test(config.workspace), 'An absolute Windows workspace is required');
  check(typeof config.task === 'string' && config.task.trim() && config.task.length <= 50000, 'Invalid task');
  const deliveryMode=config.method?.deliveryMode||'inline';
  check(['inline','file-read'].includes(deliveryMode),'Unsupported method delivery mode');
  if(deliveryMode==='inline')check(typeof config.method?.text==='string'&&config.method.text.length>0&&config.method.sha256===sha(config.method.text),'Exact method packet text/SHA256 required');
  else {
    check(config.method.path==='METHOD.md'&&/^[0-9a-f]{64}$/.test(config.method.sha256||''),'Pinned METHOD.md path/SHA256 required');
    check(config.method.text===undefined||typeof config.method.text==='string'&&sha(config.method.text)===config.method.sha256,'Optional method text does not match pinned bytes');
  }
  check(typeof config.model === 'string' && /^[A-Za-z0-9_-]+::[^\s\0]+$/.test(config.model), 'Explicit model route required');
  const c = config.context;
  check(c?.preset === 'custom' && c.autoCompact === false, 'Explicit custom context and autoCompact:false required');
  int(c.windowTokens, 4096, 1000000, 'windowTokens');
  int(c.outputReserveTokens, 256, 128000, 'outputReserveTokens');
  int(c.headroomTokens, 128, 100000, 'headroomTokens');
  check(c.outputReserveTokens + c.headroomTokens < c.windowTokens, 'Invalid context reserve');
  const b = config.budgets;
  int(b?.wallMs, 1000, 3600000, 'wallMs');
  int(b?.settlementGraceMs, 1000, 600000, 'settlementGraceMs');
  int(b?.pollIntervalMs, 100, 30000, 'pollIntervalMs');
  int(b?.windowMs, 1000, 45000, 'windowMs');
  int(b?.fetchTimeoutMs, 100, 30000, 'fetchTimeoutMs');
  int(b?.maxReceiptPages, 1, 64, 'maxReceiptPages');
  check(b.pollIntervalMs <= b.windowMs, 'Poll interval exceeds polling window');
  for (const key of ['temperature', 'seed', 'top_p', 'topP', 'top_k', 'min_p', 'maxSteps', 'runTimeoutMs', 'directoryMode', 'directoryActions']) check(!Object.hasOwn(config, key), `Unsupported per-run field: ${key}`);
  check(Array.isArray(config.allowedCommands) && config.allowedCommands.every(x => typeof x === 'string' && x), 'Freeze allowedCommands explicitly');
  if(Object.hasOwn(config,'benchmark'))validateBenchmarkRequest(config.benchmark);
  return structuredClone(config);
}
// Ownership remains sufficient for cancelling/settling an admitted benchmark whose conditions drifted.
function assertOwnedIdentity(run, config, expectedId) {
  check(run && typeof run.id === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(run.id), 'Native run ID missing');
  check(!expectedId || run.id === expectedId, 'Run ownership mismatch');
  check(run.taskId === run.id && run.metadata?.clientRequestId === config.requestId, 'Native request/task ownership mismatch');
  check(windowsPath(run.cwd || '') === windowsPath(config.workspace), 'Run workspace mismatch');
  check(run.workflow?.id === config.workflowId && run.workflow?.nodes?.find(n => n.id === 'agent')?.model === config.model, 'Run workflow/model mismatch');
  check(run.parentRunId == null && run.retryOf == null, 'A scored arm must be a fresh run');
  return run;
}
// Strict evidence validation remains separate from the identity-only cleanup path.
function assertOwned(run,config,expectedId) {
  assertOwnedIdentity(run,config,expectedId);
  check(run.directoryActions==='on'&&run.directoryDiagnostics==='maximal'&&run.executionModes?.directoryMode==='off','Run Directory mode mismatch');
  if(config.benchmark){
    const expected=validateBenchmarkRequest(config.benchmark),actual=run.benchmark;
    check(actual?.schema==='blackice.minicpm.benchmark-profile.v1'&&actual.profile===expected.profile&&windowsPath(actual.workspace||'')===windowsPath(config.workspace)&&actual.caseId===config.caseId&&actual.publicCaseCount===2&&actual.command==='node test-public.cjs'&&windowsPath(actual.scaffoldReceiptPath||'')===windowsPath(expected.scaffoldReceiptPath)&&actual.scaffoldReceiptSha256===expected.scaffoldReceiptSha256&&/^[a-f0-9]{64}$/.test(actual.contractSha256||''),'Run benchmark profile mismatch');
  }
  return run;
}
const frontendHelpers = String.raw`
const normalPath=s=>String(s||'').replace(/\\/g,'/').replace(/\/+$/,'').toLowerCase();
const endStates=new Set(['completed','failed','cancelled']);
const own=r=>{if(!r||r.id!==expected.runId||r.taskId!==r.id||r.metadata?.clientRequestId!==config.requestId||normalPath(r.cwd)!==normalPath(config.workspace)||r.workflow?.id!==config.workflowId||r.workflow?.nodes?.find(n=>n.id==='agent')?.model!==config.model||(!config.benchmark&&(r.directoryActions!=='on'||r.directoryDiagnostics!=='maximal'||r.executionModes?.directoryMode!=='off'))||r.parentRunId||r.retryOf)throw Error('OWNED_RUN_IDENTITY_MISMATCH');return r;};
const get=async(route,method='GET',body)=>{const left=endAt-Date.now();if(left<=0)throw Error('CONTROLLER_WINDOW_EXHAUSTED');const response=await fetch(route,{method,credentials:'same-origin',cache:'no-store',headers:body===undefined?{}:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(Math.min(config.budgets.fetchTimeoutMs,left))});const text=await response.text();let value;try{value=JSON.parse(text);}catch{throw Error('NATIVE_API_NON_JSON_'+response.status);}if(!response.ok){const e=Error(value.error||'NATIVE_API_HTTP_'+response.status);e.status=response.status;e.code=value.code;throw e;}return value;};
`;
function operation(config, kind, index, body, extra = {}) {
  validate(config);
  const expression = `(async()=>{const config=${JSON.stringify(config)};const expected=${JSON.stringify(extra)};if(location.origin!==config.origin)throw Error('FRONTEND_ORIGIN_CHANGED');${body}})()`;
  const requestId = `${config.controllerId}_${kind}_${String(index).padStart(4, '0')}`;
  check(requestId.length <= 120, 'Direct request ID too long');
  const args={requestId, action:'evaluate', target:'frontend', expression};
  check(Buffer.byteLength(JSON.stringify({tool:'blackice_frontend',arguments:args}))<=128*1024,'Direct operation exceeds native 128 KiB request bound');
  return {kind, requestId, arguments:args, expressionSha256:sha(expression)};
}
function prepare(config, index) {
  return operation(config, 'prepare', index, `const m=await import('/mission-model.mjs');const workflow=m.createMissionWorkflow({id:config.workflowId,task:config.task,model:config.model,cwd:config.workspace,planningMode:'off',context:config.context});return {kind:'prepare',at:new Date().toISOString(),body:{requestId:config.requestId,workflow,input:{task:config.task,cwd:config.workspace,directoryMode:'off',directoryActions:'on',chatPlanning:'off',pastChats:'off',directoryDiagnostics:'maximal',planningMode:'off',...(config.benchmark?{benchmark:config.benchmark}:{})}}};`);
}
function start(config, index, authoredBody) {
  check(authoredBody?.requestId === config.requestId && authoredBody?.workflow?.id === config.workflowId, 'Prepared request identity missing');
  return operation(config, 'start', index, `const startedAt=new Date().toISOString();const endAt=Date.now()+config.budgets.fetchTimeoutMs;${frontendHelpers}const run=await get('/api/runs','POST',${JSON.stringify(authoredBody)});return {kind:'start',startedAt,finishedAt:new Date().toISOString(),run};`);
}
function observe(config, index, runId, deadlineAt, cleanupDeadlineAt) {
  check(/^[A-Za-z0-9_-]{1,100}$/.test(runId), 'Owned run ID required');
  check(Number.isFinite(Date.parse(deadlineAt)) && Number.isFinite(Date.parse(cleanupDeadlineAt)), 'Absolute deadlines required');
  return operation(config, 'observe', index, `const startedAt=new Date().toISOString();const endAt=Math.min(Date.now()+config.budgets.windowMs,Date.parse(expected.cleanupDeadlineAt));${frontendHelpers}
let run=null;const observations=[],cancellations=[];let error=null,pendingCancel=false,windowExhausted=false;
try{while(Date.now()<endAt){run=own(await get('/api/runs/'+encodeURIComponent(expected.runId)));observations.push({at:new Date().toISOString(),status:run.status,settled:run.settled});if(endStates.has(run.status)&&run.settled===true)break;
if(Date.now()>=Date.parse(expected.deadlineAt)&&['queued','running','waiting'].includes(run.status)){const requestedAt=new Date().toISOString();const cancellation={runId:run.id,requestedAt,respondedAt:null,latenessMs:Math.max(0,Date.parse(requestedAt)-Date.parse(expected.deadlineAt)),status:'unknown',settled:null};cancellations.push(cancellation);pendingCancel=true;const result=await get('/api/runs/'+encodeURIComponent(expected.runId)+'/cancel','POST',{});run=own(result);pendingCancel=false;Object.assign(cancellation,{respondedAt:new Date().toISOString(),status:run.status,settled:run.settled});if(endStates.has(run.status)&&run.settled===true)break;}
const left=endAt-Date.now();if(left<=0)break;await new Promise(resolve=>setTimeout(resolve,Math.min(config.budgets.pollIntervalMs,left)));}}
catch(e){windowExhausted=!pendingCancel&&run!==null&&Date.now()>=endAt&&(e.name==='TimeoutError'||e.message==='CONTROLLER_WINDOW_EXHAUSTED');if(!windowExhausted)error={message:String(e.message||e),code:e.code||null,status:e.status||null,unknownCancel:pendingCancel};}
return {kind:'observe',startedAt,finishedAt:new Date().toISOString(),run,observations,cancellations,error,windowExhausted,cleanupExpired:Date.now()>=Date.parse(expected.cleanupDeadlineAt)};`, {runId, deadlineAt, cleanupDeadlineAt});
}
function collect(config, index, runId) {
  return operation(config, 'collect', index, `const startedAt=new Date().toISOString();const endAt=Date.now()+config.budgets.windowMs;${frontendHelpers}
const run=own(await get('/api/runs/'+encodeURIComponent(expected.runId)));if(!endStates.has(run.status)||run.settled!==true)throw Error('RUN_NOT_SETTLED');const root='/api/conversations/'+encodeURIComponent(run.id);const query='?taskId='+encodeURIComponent(run.taskId);
const ledger=await get(root+'/action-directory'+query),machine=await get(root+'/receipts'+query+'&view=machine');const receiptPages={};
for(const view of ['context','tools','decisions']){const pages=[];let offset=0,revision;for(let i=0;i<config.budgets.maxReceiptPages;i++){const page=await get(root+'/receipts'+query+'&view='+view+'&offset='+offset+'&limit=50'+(revision?'&revision='+revision:''));pages.push(page);revision=page.revision;if(page.nextOffset===null){offset=null;break;}if(!Number.isSafeInteger(page.nextOffset)||page.nextOffset<=offset)throw Error('RECEIPT_CURSOR_INVALID');offset=page.nextOffset;}receiptPages[view]={pages,complete:offset===null};}
const confirmed=own(await get('/api/runs/'+encodeURIComponent(run.id)));if(!endStates.has(confirmed.status)||confirmed.settled!==true)throw Error('RUN_SETTLEMENT_CHANGED');return {kind:'collect',startedAt,finishedAt:new Date().toISOString(),run:confirmed,ledger,machine,receiptPages,providerThreadId:confirmed.nodes?.agent?.threadId||null};`, {runId});
}
function unwrapFrontend(value) {
  if (value?.inline === false && value.artifact?.complete === true) return {artifactRequired:value.artifact};
  if (value?.error || value?.exceptionDetails || value?.result?.exceptionDetails) throw new Error('Frontend execution failed: '+JSON.stringify(value.error || value.exceptionDetails || value.result.exceptionDetails));
  const result = value?.result?.result;
  check(result && Object.hasOwn(result, 'value'), 'Expected completed Runtime.evaluate by-value result');
  return result.value;
}
module.exports = {validate,validateBenchmarkRequest,sha,terminal,windowsPath,assertOwnedIdentity,assertOwned,prepare,start,observe,collect,unwrapFrontend};
