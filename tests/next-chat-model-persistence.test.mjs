import test from 'node:test';
import assert from 'node:assert/strict';
import { recordedChatModels, conversationModelEvidence, createConversationModelSelection, UNKNOWN_CHAT_MODEL, replyTarget, mergeChatRunUpdate } from '../public/next/chat/model.mjs';
import { projectFamily } from '../public/next/chat/reader-model.mjs';
import { chatOptionChoices, validateChatOptions } from '../public/next/chat/options-model.mjs';
import { submitChat } from '../public/next/chat/send.mjs';
const nemotron='kilo_free::nvidia/nemotron-3.5-super-vl:free',laguna='kilo_free::poolside/laguna-s-2.1:free';
const run=(id,model='default',resolvedModel,thread='thread-'+id)=>({
  id,taskId:'chat-'+id,status:'completed',settled:true,createdAt:'2026-10-31T08:00:00Z',
  workflow:{nodes:[{id:'agent',type:'agent',model}]},
  nodes:{agent:{status:'completed',threadId:thread,...(resolvedModel?{resolvedModel}:{})}},events:[],
});
const storage=()=>{const values=new Map();return {getItem:key=>values.get(key)||null,setItem:(key,value)=>values.set(key,value)};};

test('resolved model wins over workflow aliases and a later global default',()=>{
  const history=[run('nemotron','default',nemotron)],before=structuredClone(history);
  const selections=createConversationModelSelection({storage:storage()});
  assert.equal(selections.read('chat-nemotron',history).model,nemotron);
  assert.equal(selections.read('new').model,'default');
  assert.equal(chatOptionChoices({defaultModel:laguna,models:[{id:nemotron},{id:laguna}]},selections.read('chat-nemotron',history)).selected.model,nemotron);
  assert.deepEqual(history,before,'Reading must never rewrite old metadata.');
});
test('reader keeps matching thread identity while dropping unrelated raw evidence',()=>{
  const saved=run('old');
  saved.events=[
    {nodeId:'agent',data:{type:'thread',model:'gpt-6-luna'}},
    {nodeId:'other',data:{type:'thread',model:laguna}},
    {nodeId:'agent',data:{type:'tool.result',text:'raw-tool-secret'}},
  ];
  const before=structuredClone(saved),family=projectFamily({runs:[saved]});
  assert.equal(family.runs[0].events.length,0);
  assert.equal(conversationModelEvidence(family.runs).model,'gpt-6-luna');
  assert.equal(family.runs[0].nodes.agent.modelEvidence.source,'thread');
  assert.equal(family.runs[0].nodes.agent.resolvedModel,undefined,'Projection must not invent resolved metadata.');
  assert.doesNotMatch(JSON.stringify(family),/raw-tool-secret/);
  assert.deepEqual(saved,before);
});
test('an authoritative resolved model is stronger than stale thread/workflow fields',()=>{
  const saved=run('resolved',laguna,nemotron);
  saved.events=[{nodeId:'agent',data:{type:'thread',model:laguna}}];
  assert.equal(recordedChatModels(saved).agent.model,nemotron);
});
test('symbolic resolved models do not mask concrete thread evidence',()=>{
  const saved=run('symbolic','default','codex');
  saved.events=[{nodeId:'agent',data:{type:'thread',model:'gpt-6-luna'}}];
  assert.equal(conversationModelEvidence([saved]).model,'gpt-6-luna');
});
test('failed latest explicit model stays selected instead of an older successful model',()=>{
  const older=run('old',nemotron),failed=run('new',laguna);
  failed.status=failed.nodes.agent.status='failed';
  assert.equal(conversationModelEvidence([older,failed]).model,laguna);
});
test('missing historical evidence stays unknown rather than using the current default',()=>{
  const saved=run('ambiguous'),select=createConversationModelSelection();
  assert.equal(select.read('ambiguous',[saved]).model,UNKNOWN_CHAT_MODEL);
  const status={defaultModel:laguna,models:[{id:laguna}]},choice=chatOptionChoices(status,select.read('ambiguous',[saved]));
  assert.match(choice.models.find(m=>m.id===UNKNOWN_CHAT_MODEL).label,/Saved model unknown/);
  assert.throws(()=>validateChatOptions(status,select.read('ambiguous',[saved])),/no saved model evidence/);
});
test('only the same recorded thread may recover identity from earlier runs',()=>{
  const older=run('old','default',nemotron,'same-thread'),later=run('new');
  later.nodes.agent.resumeThreadId='same-thread';delete later.nodes.agent.threadId;
  assert.equal(conversationModelEvidence([older,later]).model,nemotron);
  later.nodes.agent.resumeThreadId='different-thread';
  assert.equal(conversationModelEvidence([older,later]),null);
});
test('unsent overrides survive reload and stay scoped to their chat',()=>{
  const disk=storage(),first=createConversationModelSelection({storage:disk});
  first.choose('A',laguna);first.choose('B','gpt-6-luna');first.choose('new',nemotron);
  const reloaded=createConversationModelSelection({storage:disk});
  assert.equal(reloaded.read('A',[run('a',nemotron)]).model,laguna);
  assert.equal(reloaded.read('B',[run('b',nemotron)]).model,'gpt-6-luna');
  assert.equal(reloaded.read('C',[run('c',nemotron)]).model,nemotron);
  assert.equal(reloaded.read('new').model,nemotron);
});
test('choosing Default in an existing chat pins that explicit override immediately',()=>{
  const select=createConversationModelSelection();
  select.choose('A','default',{defaultModel:laguna});
  assert.equal(select.read('A',[run('a',nemotron)]).model,laguna);
  assert.throws(()=>select.choose('A','default',{}),/Choose an available model/);
  assert.equal(select.read('A',[run('a',nemotron)]).model,laguna);
});
test('successful send consumes its override but preserves a newer pending selection',()=>{
  const select=createConversationModelSelection();
  select.choose('A',laguna);
  const submitted=select.read('A',[run('a',nemotron)]);
  select.choose('A',nemotron);
  assert.equal(select.consume(submitted),false);
  assert.equal(select.read('A').model,nemotron);
  assert.equal(select.consume(select.read('A')),true);
  assert.equal(select.read('A',[run('a',laguna)]).model,laguna);
  select.choose('new',nemotron);select.consume(select.read('new'));
  assert.equal(select.read('new').model,'default');
});
test('unavailable pinned identity remains visible and cannot silently dispatch a fallback',()=>{
  const selection=createConversationModelSelection().read('saved',[run('saved',nemotron)]);
  const status={defaultModel:laguna,models:[{id:laguna}]};
  const choices=chatOptionChoices(status,selection),model=choices.models.find(m=>m.id===nemotron);
  assert.equal(choices.selected.model,nemotron);assert.equal(model.disabled,true);assert.match(model.label,/unavailable/);
  assert.throws(()=>validateChatOptions(status,selection),/available model/);
});
test('continuation omission and legacy default preserve server model choice',async()=>{
  for(const model of [undefined,'default']){
    const calls=[];
    await submitChat({api:async(path,method,body)=>{calls.push({path,body});return {id:'next'};},runs:[run('saved',nemotron)],task:'Continue',model});
    assert.equal(calls.length,1);assert.match(calls[0].path,/saved\/continue$/);
    assert.equal(Object.hasOwn(calls[0].body,'model'),false);
  }
});
test('explicit concrete continuation overrides are sent exactly once',async()=>{
  const calls=[];
  await submitChat({api:async(path,method,body)=>{calls.push(body);return{id:'next'};},runs:[run('saved',nemotron)],task:'Continue',model:laguna});
  assert.equal(calls.length,1);assert.equal(calls[0].model,laguna);
});
test('new chat retains default admission semantics and failed sends preserve overrides',async()=>{
  const calls=[],select=createConversationModelSelection();select.choose('new',nemotron);
  await assert.rejects(submitChat({api:async(path,method,body)=>{calls.push(body);throw Error('Save failed');},runs:[],task:'New task',cwd:'C:/fixture',model:select.read('new').model}),/Save failed/);
  assert.equal(select.read('new').model,nemotron);
  const requests=[];
  await submitChat({api:async(path,method,body)=>{requests.push({path,body});return path==='/api/workflows'?body:{id:'new'};},runs:[],task:'New task',cwd:'C:/fixture'});
  assert.equal(requests[0].body.nodes.find(n=>n.type==='agent').model,'default');
});

test('held planning keeps model identity and accepts a follow-up through the original conversation',async()=>{
  const saved=run('held',nemotron);saved.status='blocked';saved.nodes.agent.status='skipped';saved.nodes.agent.viabilityHeld=true;saved.viability={awaitingInput:true};
  const compact=projectFamily({runs:[saved]}).runs;
  assert.equal(conversationModelEvidence(compact).model,nemotron);
  const calls=[];await submitChat({api:async(path,method,body)=>{calls.push({path,body});return{id:'resumed'};},runs:compact,task:'Here is the missing value'});
  assert.equal(calls.length,1);assert.equal(calls[0].path,'/api/runs/held/continue');assert.equal(calls[0].body.nodeId,'agent');
});

test('a blocked branched conversation targets held work before a completed independent worker',async()=>{
  const saved=run('held-branch',nemotron);
  saved.status='blocked';saved.viability={awaitingInput:true};
  saved.nodes.agent.status='skipped';saved.nodes.agent.viabilityHeld=true;
  saved.workflow.nodes.push({id:'independent',type:'agent',model:laguna});
  saved.nodes.independent={status:'completed',resolvedModel:laguna,threadId:'independent-thread'};
  const compact=projectFamily({runs:[saved]}).runs;
  assert.equal(replyTarget(compact).nodeId,'agent');
  assert.equal(conversationModelEvidence(compact).model,nemotron);
  const calls=[];
  await submitChat({api:async(path,method,body)=>{calls.push({path,body});return{id:'resumed'};},runs:compact,task:'Continue the held work',model:laguna});
  assert.equal(calls[0].body.nodeId,'agent');assert.equal(calls[0].body.model,laguna);
});
test('settled run updates retain projected model evidence and refresh planning state without raw traces',()=>{
  const saved=run('legacy');saved.status='failed';
  saved.events=[{nodeId:'agent',data:{type:'thread',model:'gpt-6-luna'}}];
  saved.responseCycle={state:'failed',requestId:'planning-request',cycleId:'cycle'};
  const projected=projectFamily({runs:[saved]}).runs[0],before=structuredClone(projected);
  const updated={id:saved.id,status:'completed',settled:true,workflow:saved.workflow,nodes:{agent:{status:'completed',threadId:saved.nodes.agent.threadId}},
    responseCycle:{state:'completed',requestId:'planning-request',cycleId:'cycle'},viability:{awaitingInput:false},output:'Checked final answer.'};
  const merged=mergeChatRunUpdate(projected,updated);
  assert.equal(conversationModelEvidence([merged]).model,'gpt-6-luna');
  assert.equal(merged.responseCycle.state,'completed');assert.equal(merged.viability,undefined);
  assert.equal(merged.output,'Checked final answer.');assert.equal(merged.events.length,0);
  assert.deepEqual(projected,before);
});
test('live authoritative identity replaces remembered identity and cannot leak between runs',()=>{
  const old=run('same');old.events=[{nodeId:'agent',data:{type:'thread',model:'gpt-6-luna'}}];
  const projected=projectFamily({runs:[old]}).runs[0];
  const fresh={id:old.id,status:'completed',settled:true,nodes:{agent:{status:'completed',threadId:'new-observed-thread'}},
    events:[{nodeId:'agent',data:{type:'thread',model:nemotron}},{nodeId:'agent',data:{type:'tool.result',text:'raw-payload-must-stay-out'}}]};
  const merged=mergeChatRunUpdate(projected,fresh);
  assert.equal(conversationModelEvidence([merged]).model,nemotron);
  assert.doesNotMatch(JSON.stringify(merged),/raw-payload-must-stay-out/);assert.equal(merged.events.length,0);
  assert.equal(mergeChatRunUpdate(projected,{...fresh,id:'unrelated'}),projected);
});
