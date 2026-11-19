import test from 'node:test';import assert from 'node:assert/strict';import {validateWorkflow} from '../lib/engine.mjs';import {verbosityInstruction} from '../lib/subagents.mjs';import {CHAT_ANSWER_DETAIL_LEVELS,normalizeChatOptions} from '../public/next/chat/options-model.mjs';import {submitChat} from '../public/next/chat/send.mjs';import {createChatFrame} from '../public/next/chat/render.mjs';import {planningDOM} from './fixture-planning-dom.mjs';
test('Chat answer detail exposes Auto and exactly ten numeric choices, with no legacy tiers',t=>{
 const view=createChatFrame(planningDOM(t).mount);
 assert.deepEqual(Array.from(view.verbosity.querySelectorAll('option'),option=>option.getAttribute('value')),['auto',...CHAT_ANSWER_DETAIL_LEVELS.map(String)]);
});
test('Chat answer detail defaults locally to Auto and rejects malformed dispatch before any write',async()=>{
 assert.equal(normalizeChatOptions({}).verbosity,'auto');assert.equal(normalizeChatOptions({verbosity:'9'}).verbosity,9);
 let calls=0;
 for(const verbosity of ['unbounded',0,11,2.5,'4',{}])await assert.rejects(submitChat({api:()=>{calls++;},runs:[],task:'Test',cwd:process.cwd(),verbosity}),/answer detail/);
 assert.equal(calls,0);
});
test('every numeric level has its own guidance and example; Auto contributes nothing',()=>{
 assert.equal(verbosityInstruction('auto'),'');
 const examples=CHAT_ANSWER_DETAIL_LEVELS.map(level=>{
  const guidance=verbosityInstruction(level);
  assert.match(guidance,new RegExp(`ANSWER DETAIL ${level}/10`));
  assert.match(guidance,/current user request takes precedence/);
  return guidance.split('showing style only, not task facts): ')[1];
 });
 assert.ok(examples.every(Boolean));assert.equal(new Set(examples).size,10);
});
test('saved agent answer detail is validated without silently altering valid guidance',()=>{
 const workflow={id:'detail',name:'Detail',nodes:[{id:'in',type:'input'},{id:'agent',type:'agent',prompt:'Test',verbosity:7},{id:'out',type:'output'}],edges:[{source:'in',target:'agent'},{source:'agent',target:'out'}]};
 assert.equal(validateWorkflow(workflow).nodes[1].verbosity,7);
 assert.throws(()=>validateWorkflow({...workflow,nodes:[workflow.nodes[0],{...workflow.nodes[1],verbosity:{}}]}),{code:'INVALID_VERBOSITY'});
});

