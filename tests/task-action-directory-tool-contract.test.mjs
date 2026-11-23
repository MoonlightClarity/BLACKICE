import test from 'node:test';
import assert from 'node:assert/strict';
import {ACTION_DIRECTORY_TOOL,TaskActionDirectory} from '../lib/task-action-directory.mjs';
import {createDirectoryToolContract} from '../lib/task-action-directory-tool-contract.mjs';
import {validDirectArguments} from '../lib/direct-execution-api.mjs';

const schema=ACTION_DIRECTORY_TOOL.inputSchema;
const action={id:'work',objective:'Save and check the fixture result.',dependsOn:[]};
const check={id:'saved',check:'Do the saved fixture bytes match?'};
const minima=[
 {action:'read'},
 {action:'plan',actions:[action]},
 {action:'focus',id:'work'},
 {action:'refine',id:'work',claim:'Add the saved-byte check.',doneChecks:[check]},
 {action:'refine',id:'work',claim:'Retire the optional route check.',dropCheckIds:['temporary'],alternatives:['The retained check verifies the result directly.']},
 {action:'note',id:'work',claim:'The fixture read returned.',receipts:['receipt-1']},
 {action:'observe',id:'work',claim:'The fixture result was checked.',receipts:['receipt-1'],outcome:'objective-met'},
 {action:'block',id:'work',claim:'The input is unavailable.',blocker:'prerequisite-unavailable',receipts:['receipt-1']},
 {action:'block',id:'work',claim:'The declared scope was checked.',blocker:'search-limit-reached',receipts:['receipt-1']},
 {action:'block',id:'work',claim:'The checked route is unavailable.',blocker:'no-viable-route'},
 {action:'block',id:'work',claim:'The earlier effect is unresolved.',blocker:'unresolved-effect'},
];
function setup(){
 const persisted=[];
 const ledger=new TaskActionDirectory({taskId:'task',objective:'Save and check the fixture result.',persist:async state=>persisted.push(structuredClone(state))});
 const model=(args,options={})=>ledger.handleModelTool(args,{runId:'run',nodeId:'agent',expectedActionRevision:ledger.read().actionRevision,...options});
 return {ledger,persisted,model};
}
async function prepared(extra={}){
 const f=setup();await f.model({action:'plan',actions:[{...action,...extra}]});await f.model({action:'focus',id:'work'});return f;
}
async function record(f,{success=true,unknown=false,locator='C:/fixture/source.txt'}={}){
 const call={name:'relay_workspace',arguments:{action:'read',path:locator}};
 const scope={runId:'run',nodeId:'agent',expectedActionRevision:f.ledger.read().actionRevision,observationOnly:!unknown};
 const dispatch=async()=>{if(unknown)throw Error('fixture transport outcome unknown');return {success,contentItems:[{type:'inputText',text:JSON.stringify({path:locator,content:'fixture'})}]};};
 if(unknown){await assert.rejects(f.ledger.execute(call,dispatch,scope),/fixture transport outcome unknown/);return f.ledger.read().receipts.at(-1).id;}
 return (await f.ledger.execute(call,dispatch,scope)).receiptId;
}
async function rejectsUnchanged(f,args,expected='DIRECTORY_TOOL_ARGUMENTS'){
 const before=f.ledger.read(),writes=f.persisted.length,encoded=structuredClone(args);
 await assert.rejects(f.model(args),error=>error.code===expected&&error.actionDispatched===false&&/No changes were made/.test(error.message));
 assert.deepEqual(f.ledger.read(),before);assert.equal(f.persisted.length,writes);assert.deepEqual(args,encoded);
}

test('published variants retain the existing action enum and accept each genuine minimal shape',()=>{
 assert.deepEqual(schema.properties.action.enum,['read','plan','focus','refine','note','observe','block']);
 for(const args of minima)assert.equal(validDirectArguments(args,schema),true,JSON.stringify(args));
 assert.equal(schema.oneOf.length,10);
});
test('actual model handler performs read, plan, focus and both valid refinement variants',async()=>{
 const f=setup();const initial=f.ledger.read();assert.deepEqual(await f.model(minima[0]),initial);assert.equal(f.persisted.length,0);
 await f.model(minima[1]);await f.model(minima[2]);await f.model(minima[3]);
 assert.deepEqual(f.ledger.read().actions[0].doneChecks,[check]);
 const g=await prepared({doneChecks:[check,{id:'temporary',check:'Is the optional route available?',advisory:true}]});
 await g.model(minima[4]);assert.deepEqual(g.ledger.read().actions[0].doneChecks,[check]);
 assert.deepEqual(g.ledger.read().actions[0].checklistRevisions[0].retired.map(x=>x.id),['temporary']);
});
test('actual model handler records note, partial progress and a receipt-backed completed action',async()=>{
 const f=await prepared(),r1=await record(f);
 await f.model({...minima[5],receipts:[r1]});assert.equal(f.ledger.read().actions[0].state,'active');
 const r2=await record(f);await f.model({...minima[6],outcome:'partial',receipts:[r2]});
 assert.equal(f.ledger.read().actions[0].state,'active');assert.equal(f.ledger.read().actions[0].notes.length,2);
 const r3=await record(f);await f.model({...minima[6],receipts:[r3]});
 assert.equal(f.ledger.read().actions[0].state,'observed');assert.equal(f.ledger.read().focus,null);
});
test('actual model handler supports each blocker using the evidence its branch consumes',async()=>{
 const missing=await prepared(),failed=await record(missing,{success:false});
 await missing.model({...minima[7],receipts:[failed]});assert.equal(missing.ledger.read().actions[0].state,'blocked');
 const finite=await prepared({searchScope:[{tool:'relay_workspace',locator:'C:/fixture/source.txt'}]}),read=await record(finite);
 await finite.model({...minima[8],receipts:[read]});assert.equal(finite.ledger.read().actions[0].state,'blocked');
 const unavailable=await prepared(),unavailableReceipt=await record(unavailable,{success:false});
  await unavailable.model({...minima[9],receipts:[unavailableReceipt]});
  assert.equal(unavailable.ledger.read().actions[0].state,'blocked');
 const unknown=await prepared(),unresolved=await record(unknown,{unknown:true});
 await unknown.model(minima[10]);assert.deepEqual(unknown.ledger.read().actions[0].observation.receipts,[unresolved]);
});
test('model boundary rejects irrelevant fields before any revision or persistence change',async()=>{
 const cases=[
 [{action:'read',revision:0},'revision'],
 [{...minima[1],id:'ignored'},'id'],
 [{...minima[2],actions:[action]},'actions'],
 [{...minima[3],receipts:[]},'receipts'],
 [{...minima[5],outcome:'partial'},'outcome'],
 [{...minima[6],blocker:'no-viable-route'},'blocker'],
 [{...minima[9],outcome:'partial'},'outcome'],
 [{...minima[10],receipts:[]},'receipts'],
 [{...minima[1],actions:[{...action,ignored:'not copied'}]},'ignored'],
 ];
 for(const [args,key]of cases){
  const f=setup();assert.equal(validDirectArguments(args,schema),false,JSON.stringify(args));
  await assert.rejects(f.model(args),error=>error.code==='DIRECTORY_TOOL_ARGUMENTS'&&error.message.includes(JSON.stringify(key)));
  assert.equal(f.ledger.read().revision,0);assert.equal(f.persisted.length,0);
 }
});
test('every required branch field is rejected by schema and model boundary when absent',async()=>{
 for(const complete of minima){
  const matching=schema.oneOf.filter(variant=>validDirectArguments(complete,variant));
  assert.equal(matching.length,1);
  for(const key of matching[0].required){
   const args=structuredClone(complete);delete args[key];
   assert.equal(validDirectArguments(args,schema),false,complete.action+'.'+key);
   const f=setup();await rejectsUnchanged(f,args,key==='action'?'DIRECTORY_TOOL_ACTION':'DIRECTORY_TOOL_ARGUMENTS');
  }
 }
});
test('malformed or inherited action discriminators cannot be coerced into a supported action',async()=>{
 for(const value of [null,[],['read'],['run'],{},0,true,undefined]){
  const f=setup(),args={action:value};await rejectsUnchanged(f,args,'DIRECTORY_TOOL_ACTION');
 }
 for(const args of [null,[],{},'read']){
  const f=setup();await rejectsUnchanged(f,args,'DIRECTORY_TOOL_ACTION');
 }
 const f=setup(),inherited=Object.create({action:'read'}),before=f.ledger.read();
 await assert.rejects(f.model(inherited),{code:'DIRECTORY_TOOL_ACTION'});assert.deepEqual(f.ledger.read(),before);assert.equal(f.persisted.length,0);
});
test('declared scalar, array and nested-object constraints reject without mutation',async()=>{
 const bad=[
  {...minima[1],actions:[]},{...minima[1],actions:[{...action,dependsOn:'work'}]},
  {...minima[1],actions:[{...action,qualifying:{minQualifyingCount:1,requiredChecks:['same','same']}}]},
  {...minima[2],id:null},{...minima[2],revision:-1},
  {...minima[3],doneChecks:[{...check,advisory:'true'}]},
  {...minima[3],doneChecks:[{...check,unknown:1}]},
  {...minima[4],alternatives:[]},{...minima[4],dropCheckIds:[]},
  {...minima[5],receipts:[]},{...minima[6],outcome:'done'},
  {...minima[7],receipts:[]},{...minima[9],blocker:'unknown'},
 ];
 for(const args of bad){assert.equal(validDirectArguments(args,schema),false,JSON.stringify(args));await rejectsUnchanged(setup(),args);}
});
test('candidate rows cannot be silently ignored on a nonqualifying action, but a real qualifying observation is retained',async()=>{
 const plain=await prepared(),receipt=await record(plain);
 await rejectsUnchanged(plain,{...minima[6],receipts:[receipt],candidateRows:[]});
 const f=await prepared({qualifying:{minQualifyingCount:1,requiredChecks:['supported']}}),source=await record(f);
 const rows=[{id:'candidate',sourceReceipt:source,checks:[{id:'supported',status:'verified'}]}];
 await f.model({...minima[6],receipts:[source],candidateRows:rows});
 assert.deepEqual(f.ledger.read().actions[0].observation.qualification.candidateRows,rows);
});
test('model boundary keeps host revision binding and leaves the existing human/internal handle and edit APIs intact',async()=>{
 const f=setup();await f.model({...minima[1],revision:999});
 assert.equal(f.ledger.read().actionRevision,1,'Host revision, not the optional echo, controls model edits.');
 const before=f.ledger.read();await assert.rejects(f.model(minima[2],{expectedActionRevision:0}),{code:'DIRECTORY_CHANGED'});assert.deepEqual(f.ledger.read(),before);
 assert.deepEqual(await f.ledger.handle({action:'read',ignoredLegacyField:'retained old API'}),before);
 await f.ledger.edit({action:'planningChoice',revision:f.ledger.read().revision,moduleId:'module',focus:'work',reason:'Internal planning choice.',sourceRefs:[]});
 assert.equal(f.ledger.read().planningChoice.moduleId,'module');
 await rejectsUnchanged(f,{action:'planningChoice',moduleId:'module',focus:'work',reason:'Not a model tool action.',sourceRefs:[]},'DIRECTORY_TOOL_ACTION');
 await f.ledger.handle({action:'block',id:'work',claim:'Human changed the direction.',revision:f.ledger.read().revision,ignoredLegacyField:true},{authority:'human'});
 assert.equal(f.ledger.read().actions[0].state,'blocked');assert.equal(f.ledger.read().actions[0].observation.authority,'human');
});
test('unknown schema fields or unsupported schema keywords cannot silently disappear from a future contract',()=>{
 const extra=structuredClone(ACTION_DIRECTORY_TOOL);extra.inputSchema.properties.future={type:'string'};
 assert.throws(()=>createDirectoryToolContract(extra),{code:'DIRECTORY_TOOL_SCHEMA'});
 const unsupported=structuredClone(ACTION_DIRECTORY_TOOL);unsupported.inputSchema.properties.id.format='custom';
 assert.throws(()=>createDirectoryToolContract(unsupported),{code:'DIRECTORY_TOOL_SCHEMA'});
});
