import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {ConversationArchive} from '../lib/conversations.mjs';
import {retainToolFailureHistory,projectToolFailureHistory,archivedToolFailureHistory,diagnosticAlarmCopy,recordDiagnosticAlarm} from '../public/next/chat/tool-failure.mjs';
import {projectFamily} from '../public/next/chat/reader-model.mjs';

const event=(n,tool,action,code,key,extra={})=>({runId:'turn-fixture',nodeId:'agent',at:new Date(Date.UTC(2026,10,26,15,0,n)).toISOString(),
 data:{type:'tool.result',tool,action,success:false,code,operationKey:key,message:'SECRET_NOT_FOR_CHAT',...extra}});
test('all failures remain distinct chronological receipts and matching success only resolves its own operation',()=>{
 const key='a'.repeat(64),other='b'.repeat(64);
 let state;
 state=retainToolFailureHistory(state,event(1,'relay_workspace','run','WORKSPACE_COMMAND_EXIT_NONZERO',key,{commandExecution:{source:'native-workspace-process-close',exitCode:1}}));
 state=retainToolFailureHistory(state,event(2,'relay_browser','click','BROWSER_REF_STALE',other,{actionDispatched:false}));
 state=retainToolFailureHistory(state,event(3,'relay_workspace','run','WORKSPACE_COMMAND_EXIT_NONZERO',key,{commandExecution:{source:'native-workspace-process-close',exitCode:1}}));
 assert.equal(state.total,3);assert.equal(state.receipts.length,3);
 assert.deepEqual(state.receipts.map(r=>r.code),['WORKSPACE_COMMAND_EXIT_NONZERO','BROWSER_REF_STALE','WORKSPACE_COMMAND_EXIT_NONZERO']);
 assert.deepEqual(state.receipts.map(r=>r.sequence),[1,2,3]);
 assert.equal(state.receipts[0].exitCode,1);
 assert.equal(state.receipts[1].actionDispatched,false);
 state=retainToolFailureHistory(state,{...event(4,'relay_workspace','run',null,key),nodeId:'other',data:{type:'tool.result',tool:'relay_workspace',action:'run',success:true,operationKey:key}});
 assert.equal(state.receipts[0].recovered,false);
 state=retainToolFailureHistory(state,{...event(5,'relay_workspace','run',null,key),data:{type:'tool.result',tool:'relay_workspace',action:'run',success:true,operationKey:key}});
 assert.deepEqual(state.receipts.map(r=>r.recovered),[true,false,true]);
 assert.equal(state.total,3);
 const safe=projectToolFailureHistory(state);
 assert.equal(safe.total,3);assert.deepEqual(safe.receipts.map(r=>r.recovered),[true,false,true]);
 assert.equal(safe.receipts[0].at,'2026-11-26T15:00:01.000Z');
 assert.equal(safe.receipts[0].exitCode,1);
 assert.equal(safe.receipts[1].actionDispatched,false);
 assert.ok(!JSON.stringify(safe).includes(key));assert.ok(!JSON.stringify(safe).includes('SECRET'));
});
test('bounded history records omissions without pretending older failures vanished',()=>{
 let state;
 for(let n=0;n<134;n++)state=retainToolFailureHistory(state,event(n%59,'relay_browser','click','BROWSER_REF_STALE',String(n).padStart(64,'0')));
 assert.equal(state.total,134);assert.equal(state.omitted,6);assert.equal(state.receipts.length,128);
 assert.equal(state.receipts[0].sequence,7);
 const safe=archivedToolFailureHistory(state);
 assert.equal(safe.total,134);assert.equal(safe.omitted,6);
 assert.ok(safe.receipts.every(row=>!Object.hasOwn(row,'operationKey')));
});
test('archived Chat retains separate safe failure receipts even after raw tool events are curated',async t=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'blackice-failure-history-'));
 t.after(async()=>{await archive.close();await rm(directory,{recursive:true,force:true})});
 class Fake extends EventEmitter{runs=new Map();listRuns(){return [...this.runs.values()]}getRun(id){return structuredClone(this.runs.get(id))}}
 const engine=new Fake(),archive=await new ConversationArchive({dataDir:directory,engine}).init();

 const key='d'.repeat(64),secret='PRIVATE-RAW-RESULT-do-not-archive';
 const failed=event(1,'relay_workspace','run','WORKSPACE_COMMAND_EXIT_NONZERO',key,{message:secret,commandExecution:{source:'native-workspace-process-close',exitCode:1}});
 const other=event(2,'relay_browser','upload','BROWSER_REF_STALE','e'.repeat(64),{message:secret});
 const run={id:'turn-fixture',taskId:'turn-fixture',createdAt:'2026-11-26T15:00:00Z',input:'Test',status:'completed',settled:true,output:'No secret',
   workflow:{name:'Chat',nodes:[{id:'agent',type:'agent'}]},nodes:{agent:{status:'completed'}},events:[failed,other]};
 run.toolFailureHistory=retainToolFailureHistory(retainToolFailureHistory(undefined,failed),other);
 engine.runs.set(run.id,run);
 await archive.capture(run);
 const raw=await readFile(path.join(directory,'conversations',run.id+'.json'),'utf8');
 assert.ok(!raw.includes(secret));assert.ok(!raw.includes(key));assert.ok(!raw.includes('"tool.result"'));
 const saved=JSON.parse(raw);
 assert.equal(saved.toolFailureHistory.total,2);
 assert.equal(saved.toolFailureHistory.receipts[0].exitCode,1);
 assert.equal(saved.toolFailureHistory.receipts[1].code,'BROWSER_REF_STALE');
 assert.equal(saved.toolFailureHistory.receipts[0].at,'2026-11-26T15:00:01.000Z');
 const shown=projectFamily(await archive.family(run.id)).runs[0];
 assert.equal(shown.toolFailureHistory.total,2);
 assert.equal(shown.toolFailureHistory.receipts.length,2);
});
test('workspace nonzero exit is diagnosed as a shell-command failure, not an unexplained adapter outage',()=>{
 const alarm=recordDiagnosticAlarm(null,{type:'tool.result',tool:'relay_workspace',action:'run',success:false,code:'WORKSPACE_COMMAND_EXIT_NONZERO'});
 assert.equal(alarm.rows[0].code,'WORKSPACE_COMMAND_EXIT_NONZERO');
 const copy=diagnosticAlarmCopy(alarm.rows[0]);
 assert.match(copy.observed,/shell command exited/);
 assert.match(copy.explanation,/stderr/);
 assert.doesNotMatch(copy.explanation,/Root cause is not yet known/);
});

test('duplicate host delivery of one failed call does not inflate the receipt count',()=>{
 const e=event(6,'relay_workspace','run','WORKSPACE_COMMAND_EXIT_NONZERO','f'.repeat(64));
 e.data.callId='same-call-id';e.data.status='failed';
 const once=retainToolFailureHistory(undefined,e);
 assert.equal(retainToolFailureHistory(once,e),once);
 const different={...e,data:{...e.data,callId:'different-call-id'}};
 assert.equal(retainToolFailureHistory(once,different).total,2);
});
