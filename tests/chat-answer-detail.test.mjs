import test from 'node:test';
import assert from 'node:assert/strict';
import {validateWorkflow} from '../lib/engine.mjs';
import {normalizeChatOptions} from '../public/next/chat/options-model.mjs';
import {submitChat} from '../public/next/chat/send.mjs';
import {createChatFrame} from '../public/next/chat/render.mjs';
import {planningDOM} from './fixture-planning-dom.mjs';

test('Chat retires answer detail without removing model, reasoning, or speed',t=>{
 const dom=planningDOM(t),view=createChatFrame(dom.mount);
 assert.equal(dom.$('#next-chat-verbosity'),null);
 for(const field of ['model','effort','tier'])assert.ok(view[field],field);
 assert.deepEqual(normalizeChatOptions({model:'chosen',effort:'high',serviceTier:'fast',verbosity:9}),
   {model:'chosen',effort:'high',serviceTier:'fast',planningMode:'off',planningExecutionMode:'automatic'});
});

test('Chat never emits stale answer detail in new work',async()=>{
 const writes=[];
 const api=async(route,method,body)=>{writes.push(body);return route==='/api/workflows'?{workflow:body}:{id:'run'};};
 await submitChat({api,runs:[],task:'Test',cwd:process.cwd(),verbosity:10});
 assert.equal(writes.length,2);
 assert.doesNotMatch(JSON.stringify(writes),/"verbosity"/);
});

test('saving a historical workflow ignores retired detail without changing the input graph',()=>{
 for(const verbosity of [10,'detailed','auto']){
  const workflow={id:'detail',name:'Detail',nodes:[{id:'in',type:'input'},{id:'agent',type:'agent',prompt:'Test',verbosity},{id:'out',type:'output'}],edges:[{source:'in',target:'agent'},{source:'agent',target:'out'}]};
  assert.equal(Object.hasOwn(validateWorkflow(workflow).nodes[1],'verbosity'),false);
  assert.equal(workflow.nodes[1].verbosity,verbosity);
 }
});
