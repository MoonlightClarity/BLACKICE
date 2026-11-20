import test from 'node:test';
import assert from 'node:assert/strict';
import {TaskActionDirectory} from '../lib/task-action-directory.mjs';
const context={runId:'turn',nodeId:'agent'};
const code={code:'DIRECTORY_DONE_CHECKLIST'};
async function prepare(objective,doneChecks){
 const ledger=new TaskActionDirectory({taskId:'task',objective});
 const edit=(action,rest={})=>ledger.edit({action,id:'work',revision:ledger.read().revision,...rest},context);
 const call=(name='relay_browser',success=true,options=context)=>ledger.execute({name,arguments:{action:'read'}},async()=>({success}),options);
 await edit('plan',{actions:[{id:'work',objective,dependsOn:[],...(doneChecks?{doneChecks}:{})}]});
 await edit('focus');
 return {ledger,edit,call};
}
const scope=[{id:'scope',check:'Did we finish the stated search scope?',requestQuote:'Find up to two'},{id:'first',parentId:'scope',check:'Did we check the first source?'},{id:'second',parentId:'scope',check:'Did we check the independent second source?'}];
const yes=(id,receipt)=>({id,yes:true,receipt});
test('identical claimed zero results: reject a planned unchecked source; accept an actually checked scope',async()=>{
 const {ledger,edit,call}=await prepare('Find up to two active roles.',scope);
 const first=(await call()).receiptId;
 const finish=(results,receipts)=>edit('observe',{outcome:'objective-met',claim:'Zero eligible roles in the stated scope.',checkResults:results,receipts});
 await assert.rejects(finish([yes('first',first),{id:'second',yes:false}],[first]),code);
 await assert.rejects(finish([yes('scope',first)],[first]),code);
 assert.equal(ledger.finalStatus().ready,false);
 assert.equal(ledger.read().focus,'work');
 const second=(await call()).receiptId;
 await finish([yes('scope',second),yes('first',first),yes('second',second)],[first,second]);
 assert.equal(ledger.finalStatus().ready,true);
});
test('explicit capped discovery cannot close the original no-checklist path',async()=>{
 const {ledger,edit,call}=await prepare('Find up to two active jobs.');
 const {receiptId}=await call();
 const state=ledger.read();
 await assert.rejects(edit('observe',{claim:'Search coverage remains limited.',receipts:[receiptId],outcome:'objective-met'}),code);
 assert.deepEqual(ledger.read(),state);
 await edit('refine',{claim:'Record the agreed scope and remaining search work.',doneChecks:scope});
 assert.deepEqual(ledger.read().actions[0].doneChecks,scope);
});
test('an unmet leaf can be retired after considering alternatives; independently verified local work still completes',async()=>{
 const {ledger,edit,call}=await prepare('Export the requested spreadsheet.',[
  {id:'export',check:'Is the export usable?'},
  {id:'attachment',parentId:'export',check:'Was the file attached?'},
  {id:'content',parentId:'export',check:'Do both sheets open with the requested data?'},
 ]);
 const file=(await call('relay_workspace')).receiptId;
 await edit('observe',{outcome:'partial',claim:'File verified; attachment not sent.',receipts:[file],checkResults:[yes('content',file),{id:'attachment',yes:false}]});
 const revision={claim:'A shared link delivers the same file; attachment was my assumption.',dropCheckIds:['attachment'],
  doneChecks:[{id:'link',parentId:'export',check:'Was the usable file delivered via the link?'}]};
 const before=ledger.read();
 await assert.rejects(edit('refine',revision),code);
 assert.deepEqual(ledger.read(),before);
 await edit('refine',{...revision,alternatives:['Retrying the attachment route is unnecessary; an authorized link delivers the file.']});
 assert.deepEqual(ledger.read().actions[0].checklistRevisions[0].retired.map(x=>x.id),['attachment']);
 assert.equal(ledger.read().actions[0].notes[0].checkResults[1].yes,false);
 const link=(await call('relay_delivery')).receiptId;
 await edit('observe',{outcome:'objective-met',claim:'Both sheets verified and file delivered.',receipts:[file,link],checkResults:[yes('content',file),yes('link',link)]});
 assert.equal(ledger.finalStatus().ready,true);
});
test('new children invalidate direct assertions on their parent; invented, failed, and other-turn evidence is not Yes',async()=>{
 const {ledger,edit,call}=await prepare('Check the document.',[{id:'check',check:'Is the document correct?'}]);
 await edit('refine',{claim:'The document includes two required pieces.',doneChecks:[
  {id:'a',parentId:'check',check:'Is part A correct?'},
  {id:'b',parentId:'check',check:'Is part B correct?'}]});
 const good=(await call()).receiptId;
 const failed=(await call('relay_browser',false)).receiptId;
 const old=(await call('relay_browser',true,{...context,runId:'old'})).receiptId;
 const finish=(results,receipts)=>edit('observe',{outcome:'objective-met',claim:'Both pieces correct.',checkResults:results,receipts});
 await assert.rejects(finish([yes('check',good)],[good]),code);
 for(const bad of [failed,old,'made-up'])await assert.rejects(finish([yes('a',good),yes('b',bad)],[good,failed,old]),code);
 assert.equal(ledger.finalStatus().ready,false);
 await finish([yes('a',good),yes('b',good)],[good]);
 assert.equal(ledger.finalStatus().ready,true);
});
test('an exact request check survives route changes, needs outcome evidence, and ignores optional work',async()=>{
 const {ledger,edit,call}=await prepare('Deliver the report as an attachment.',[
  {id:'output',check:'Did the requested document reach the user?'},
  {id:'attach',parentId:'output',check:'Was the report delivered as an attachment?',requestQuote:'as an attachment'},
  {id:'first',parentId:'attach',check:'Did the first channel accept it?'},
  {id:'polish',parentId:'output',check:'Did we add a cover page?',advisory:true},
 ]);
 const first=(await call('relay_delivery',false)).receiptId;
 const before=ledger.read();
 for(const dropCheckIds of [['attach'],['output']])await assert.rejects(edit('refine',{
   claim:'First route failed.',alternatives:['A public link would be quicker.'],dropCheckIds,
 }),code);
 assert.deepEqual(ledger.read(),before);
 await edit('refine',{claim:'Use another permitted service that can deliver an attachment.',
  alternatives:['A link does not meet the attachment requirement.'],dropCheckIds:['first'],
  doneChecks:[{id:'alternate',parentId:'attach',check:'Did the alternate channel accept the attachment?'}]});
 const delivery=(await call('relay_delivery')).receiptId;
 await assert.rejects(edit('observe',{outcome:'objective-met',claim:'A route was attempted.',receipts:[first,delivery],
   checkResults:[yes('alternate',delivery)]}),code);
 await edit('observe',{outcome:'objective-met',claim:'The service confirmed attachment delivery.',
    receipts:[delivery],checkResults:[yes('alternate',delivery),yes('attach',delivery)]});
 const status=Object.fromEntries(ledger.read().actions[0].doneCheckStatus.map(item=>[item.id,item.yes]));
 assert.deepEqual(status,{output:true,attach:true,polish:false,alternate:true});
 assert.equal(ledger.finalStatus().ready,true);
});
test('invented request authority and removing a pending explicit requirement are rejected',async()=>{
 const ledger=new TaskActionDirectory({taskId:'task',objective:'Deliver both requested sheets.'});
 const plan=actions=>ledger.edit({action:'plan',revision:ledger.read().revision,actions},context);
 const item=(id,doneChecks)=>({id,objective:'Deliver result',dependsOn:[],doneChecks});
 await assert.rejects(plan([item('deliver',[{id:'signature',check:'Is it signed?',requestQuote:'signed'}])]),code);
 const actual={id:'sheets',check:'Do both sheets open?',requestQuote:'both requested sheets'};
 await plan([item('deliver',[actual])]);
 await assert.rejects(plan([item('different',[{id:'cover',check:'Is a cover page present?'}])]),code);
 await plan([item('deliver',[actual,{id:'cover',check:'Is a cover page present?',advisory:true}])]);
 assert.equal(ledger.read().actions[0].doneChecks.length,2);
});
test('a real stop leaves the explicit requirement unmet rather than retiring or completing it',async()=>{
 const {ledger,edit,call}=await prepare('Deliver as an attachment.',[
  {id:'attachment',check:'Was it sent as an attachment?',requestQuote:'as an attachment'}
 ]);
 const failure=(await call('relay_delivery',false)).receiptId;
 await edit('block',{blocker:'no-viable-route',claim:'The only permitted service rejected attachments.',receipts:[failure]});
 const action=ledger.read().actions[0];
 assert.equal(action.doneCheckStatus[0].yes,false);
 assert.equal(action.observation.blocker,'no-viable-route');
 assert.equal(ledger.finalStatus().reason,'blocked-paths');
});
