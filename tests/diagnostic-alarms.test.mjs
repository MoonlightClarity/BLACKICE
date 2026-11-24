import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {HarnessEngine} from '../lib/engine.mjs';
import {toolResultEvent} from '../lib/tool-outcomes.mjs';
import {diagnosticAlarmCopy,latestDiagnosticAlarms,projectDiagnosticAlarms,recordDiagnosticAlarm} from '../public/next/chat/tool-failure.mjs';
import {projectFamily} from '../public/next/chat/reader-model.mjs';

test('alarm keeps only allowlisted identifiers and groups identical observed failures',()=>{
 const failure={type:'tool.result',tool:'relay_browser',action:'click',success:false,code:'BROWSER_REF_STALE',actionDispatched:false,message:'PRIVATE mail@example.test'};
 const first=recordDiagnosticAlarm(null,failure);
 const repeat=recordDiagnosticAlarm(first,failure);
 const unknown=recordDiagnosticAlarm(repeat,{...failure,actionDispatched:undefined});
 assert.equal(unknown.rows[0].count,1);
 assert.equal(unknown.rows[1].count,2);
 assert.match(diagnosticAlarmCopy(unknown.rows[0]).observed,/not confirmed/);
 assert.match(diagnosticAlarmCopy(unknown.rows[1]).observed,/No page input was dispatched/);
 assert.match(diagnosticAlarmCopy(unknown.rows[1]).explanation,/may have changed.*does not establish why/);
 for(const event of [{type:'skill_loaded'},{type:'tool.result',success:true},{...failure,code:'GOAL_DEADLINE_REACHED'}])
  assert.equal(recordDiagnosticAlarm(unknown,event),null);
 const malicious=recordDiagnosticAlarm(unknown,{...failure,tool:'MCP SECRET NAME',action:'SECRET',code:'SECRET',callId:'PRIVATE'});
 assert.deepEqual(malicious.rows[0],{tool:'Connected tool',action:null,code:null,knownNotDispatched:false,count:1});
 assert.doesNotMatch(JSON.stringify(malicious),/PRIVATE|SECRET|mail@example/);
 assert.equal(latestDiagnosticAlarms(malicious,repeat).revision,malicious.revision);
 assert.equal(projectDiagnosticAlarms({revision:1,rows:Array(20).fill({})}).rows.length,5);
 assert.equal(toolResultEvent({name:'relay_browser',arguments:{action:'click'}},{success:false,actionDispatched:false}).actionDispatched,false);
 assert.equal(toolResultEvent({name:'relay_browser',arguments:{action:'click'}},{success:false,contentItems:[{type:'inputText',text:'{"actionDispatched":false}'}]}).actionDispatched,undefined,'prose does not prove that input was absent');
});

const graph={name:'Alarm fixture',nodes:[{id:'input',type:'input'},{id:'agent',type:'agent',name:'Fixture',model:'fixture-model',prompt:'Use the fixture'},{id:'output',type:'output'}],edges:[{source:'input',target:'agent'},{source:'agent',target:'output'}],settings:{maxParallel:1,planningMode:'off'}};
test('Directory focus alarm preserves proven nondispatch for workspace calls without trusting prose',()=>{
 const call={name:'relay_workspace',arguments:{action:'run',command:'node --test'}};
 const rejection=toolResultEvent(call,{success:false,code:'DIRECTORY_FOCUS',actionDispatched:false,hostHandlerEntered:true,
  contentItems:[{type:'inputText',text:'This tool call did not run.'}]});
 assert.equal(rejection.actionDispatched,false);
 const alarm=recordDiagnosticAlarm(null,rejection);
 assert.deepEqual(alarm.rows[0],{tool:'relay_workspace',action:null,code:'DIRECTORY_FOCUS',knownNotDispatched:true,count:1});
 const unknown=recordDiagnosticAlarm(alarm,{...rejection,actionDispatched:undefined});
 assert.equal(unknown.rows[0].knownNotDispatched,false);
 assert.equal(unknown.rows[1].knownNotDispatched,true);
 const opaque=toolResultEvent(call,{success:false,code:'DIRECTORY_FOCUS',contentItems:[{type:'inputText',text:'{"actionDispatched":false}'}]});
 assert.equal(opaque.actionDispatched,undefined,'Returned prose is never proof of dispatch');
 assert.equal(recordDiagnosticAlarm(null,opaque).rows[0].knownNotDispatched,false);
});

test('actual failed skill read emits alarm before run settles and keeps ordinary work unblocked',{timeout:10000},async t=>{
 const temp=await realpath(tmpdir()),root=await mkdtemp(path.join(temp,'blackice-alarm-'));
 let notify;
 const hit=new Promise(resolve=>{notify=resolve;});let finish;
 const pending=new Promise(resolve=>{finish=resolve;});
 const runtime=new class extends EventEmitter{
  status(){return{connected:true,authenticated:true,models:[{id:'fixture-model',supportsTools:true}]};}
  async runAgent(options){
   const call={name:'relay_skills',callId:'fixture-read-private',arguments:{action:'read',id:'library-private-missing'}};
   let failure;
   await assert.rejects(async()=>{try{await options.onToolCall(call);}catch(error){failure=error;throw error;}},{code:'SKILL_NOT_FOUND'});
   options.onEvent(toolResultEvent(call,{success:false,code:failure.code,message:'PRIVATE skill body'}));
   options.onEvent({type:'skill_loaded',skillId:'library-previous',title:'Earlier skill'});
   notify();await pending;
   return{output:'Worked independently after the failed read.'};
  }
 };
 const engine=await new HarnessEngine({runtime,dataDir:root,defaultCwd:root}).init();
 t.after(async()=>{finish();await engine.close();const resolved=await realpath(root);assert.equal(path.dirname(resolved),temp);assert.match(path.basename(resolved),/^blackice-alarm-/);await rm(resolved,{recursive:true,force:true});});
 const alarms=[];engine.on('event',event=>{if(event.type==='diagnostic.alarm')alarms.push(event);});
 const run=engine.startRun({workflow:graph,input:{task:'Open a missing skill then continue independently',directoryDiagnostics:'off'}});
 await hit;
 assert.equal(engine.getRun(run.id).settled,false);
 assert.equal(alarms.length,1);
 assert.equal(alarms[0].runId,run.id);
 assert.match(diagnosticAlarmCopy(alarms[0].data.rows[0]).title,/Skill load failed/);
 assert.doesNotMatch(JSON.stringify(alarms),/PRIVATE|library-private|fixture-read-private/);
 finish();await engine.executions.get(run.id);
 const completed=engine.getRun(run.id);
 assert.equal(completed.status,'completed',completed.error);
 assert.deepEqual(projectFamily({runs:[completed]}).runs[0].diagnosticAlarms,alarms[0].data);
});

test('workspace alarms report observed missing path or access code without retaining the path',()=>{
 const failure={type:'tool.result',tool:'relay_workspace',action:'read',success:false,message:'C:/Users/private/secret.pdf was not found'};
 for(const [code,expect] of [['ENOENT',/did not find/],['EACCES',/did not let/],['EPERM',/did not let/]]){
  const alarm=recordDiagnosticAlarm(null,{...failure,code});
  assert.equal(alarm.rows[0].code,code);
  assert.match(diagnosticAlarmCopy(alarm.rows[0]).observed,expect);
  assert.doesNotMatch(JSON.stringify(alarm),/private|secret\.pdf/);
 }
});

test('workspace gate alarms retain proven no-dispatch without inventing it for unknown outcomes',()=>{
 const failure={type:'tool.result',tool:'relay_workspace',action:'run',success:false,code:'DIRECTORY_FOCUS'};
 const unknown=recordDiagnosticAlarm(null,failure);
 const confirmed=recordDiagnosticAlarm(unknown,{...failure,actionDispatched:false});
 assert.equal(confirmed.rows.length,2,'proven no-dispatch and unknown effects must not coalesce');
 assert.equal(confirmed.rows[0].knownNotDispatched,true);
 assert.equal(confirmed.rows[1].knownNotDispatched,false);
 assert.deepEqual(projectDiagnosticAlarms(confirmed).rows,confirmed.rows);
 assert.match(diagnosticAlarmCopy(confirmed.rows[0]).observed,/before the tool ran/);
});

test('Agents alarms distinguish nonexistent actions from Directory rejecting dispatch',()=>{
 const event={type:'tool.result',tool:'relay_agents',action:'read',success:false};
 const gate=recordDiagnosticAlarm(null,{...event,code:'DIRECTORY_FOCUS'});
 const invalid=recordDiagnosticAlarm(gate,{...event,code:'NATIVE_AGENT_ACTION_INVALID'});
 assert.match(diagnosticAlarmCopy(invalid.rows[0]).observed,/does not exist/);
 assert.match(diagnosticAlarmCopy(invalid.rows[1]).observed,/before the tool ran/);
 assert.equal(invalid.rows.length,2);
});
