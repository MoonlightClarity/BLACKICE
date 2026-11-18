import test from 'node:test';
import assert from 'node:assert/strict';
import {planningDOM} from './fixture-planning-dom.mjs';
import {createChatFrame} from '../public/next/chat/render.mjs';
import {normalizeChatOptions,savedChatExecutionMode} from '../public/next/chat/options-model.mjs';
import {submitChat} from '../public/next/chat/send.mjs';
import {displayChatRequest} from '../public/next/chat/model.mjs';
test('past synthetic requests never become attributed to the human after Autonomy removal',()=>{
 assert.equal(displayChatRequest({input:'Synthetic instruction',autonomy:{automatic:true}}),'');
 assert.equal(displayChatRequest({input:'Actual user request'}),'Actual user request');
});
import {scheduleChatOptionsMarkup} from '../public/next/workspaces/schedule-inspection-model.mjs';
test('chat exposes core task controls without hidden module or Directory controls',t=>{
 const dom=planningDOM(t),view=createChatFrame(dom.mount);
 for(const id of ['next-chat-plan','next-chat-directory-mode','next-chat-ontology-inline','next-chat-ontology-modules','next-chat-ontology-default','next-chat-autonomy-toggle','next-chat-autonomy-settings','next-chat-autonomy-dialog'])assert.equal(dom.$('#'+id),null,id);
 for(const field of ['model','effort','tier','goalToggle','send','stop','input','attachments'])assert.ok(view[field],field);
 assert.doesNotMatch(scheduleChatOptionsMarkup(),/name="planningMode"|>Modules<|value="ontology"/);
});
test('old saved selections cannot reactivate modules or Directory and no-execution intent stays intact',()=>{
 const options=normalizeChatOptions({model:'fixture',planningMode:'ontology',planningOntology:{modules:{verification:true}},directoryMode:'on',subagentsMode:'off',planningExecutionMode:'plan_only'});
 assert.deepEqual(options,{model:'fixture',effort:'default',serviceTier:'default',verbosity:'balanced',planningMode:'off',planningExecutionMode:'plan_only'});
 assert.equal(savedChatExecutionMode({workflow:{settings:{planningExecutionMode:'plan_only'}}}),'plan_only');
});
test('new send discards supplied module and Directory policies without changing the requested model or goal',async()=>{
 const calls=[],goal={objective:'Finish task'};
 const api=async(route,method,body)=>{calls.push({route,body});return route==='/api/workflows'?{workflow:body}:{id:'new',status:'running'};};
 await submitChat({api,runs:[],task:'Do useful work',cwd:'C:/fixture',model:'fixture',effort:'high',planningMode:'ontology',planningOntology:{modules:{verification:true}},directoryMode:'on',goal});
 assert.equal(calls.length,2);const input=calls[1].body.input;
 assert.equal(input.planningMode,'off');assert.equal(input.planningOntology,undefined);assert.equal(input.directoryMode,undefined);
 assert.deepEqual(input.goal,goal);assert.equal(calls[0].body.nodes.find(n=>n.type==='agent').model,'fixture');
});
test('retired plan-only input never becomes an executing send',async()=>{
 await assert.rejects(submitChat({api:()=>assert.fail('must not write'),runs:[],task:'x',cwd:'C:/fixture',planningExecutionMode:'plan_only'}),{code:'PLANNING_EXECUTION_MODE_RETIRED'});
});
