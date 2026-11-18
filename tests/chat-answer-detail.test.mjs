import test from 'node:test';import assert from 'node:assert/strict';import {validateWorkflow} from '../lib/engine.mjs';import {normalizeChatOptions} from '../public/next/chat/options-model.mjs';import {submitChat} from '../public/next/chat/send.mjs';
test('Chat answer detail defaults locally to Balanced and rejects malformed dispatch before any write',async()=>{
 assert.equal(normalizeChatOptions({}).verbosity,'balanced');assert.equal(normalizeChatOptions({verbosity:'detailed'}).verbosity,'detailed');
 let calls=0;await assert.rejects(submitChat({api:()=>{calls++;},runs:[],task:'Test',cwd:process.cwd(),verbosity:'unbounded'}),/answer detail/);assert.equal(calls,0);
});
test('saved agent answer detail is validated without silently altering valid guidance',()=>{
 const workflow={id:'detail',name:'Detail',nodes:[{id:'in',type:'input'},{id:'agent',type:'agent',prompt:'Test',verbosity:'detailed'},{id:'out',type:'output'}],edges:[{source:'in',target:'agent'},{source:'agent',target:'out'}]};
 assert.equal(validateWorkflow(workflow).nodes[1].verbosity,'detailed');
 assert.throws(()=>validateWorkflow({...workflow,nodes:[workflow.nodes[0],{...workflow.nodes[1],verbosity:{}}]}),{code:'INVALID_VERBOSITY'});
});

