import test from 'node:test';
import assert from 'node:assert/strict';
import {createResponseDefaults,renderResponseDefaults} from '../public/response-defaults.mjs';
const initial={defaultEffort:'default',defaultContext:{preset:'model',windowTokens:null,autoCompact:true,headroomTokens:2000},codexHistory:'relay'};
const target=(key,value)=>({dataset:{responseDefault:key},value});
test('response defaults save only dirty fields and preserve advanced context preferences',async()=>{
 const calls=[];let current=structuredClone(initial),saved;
 const editor=createResponseDefaults({getSettings:()=>current,api:async(url,method,patch)=>{calls.push({url,method,patch});if(patch)current={...current,...patch};return structuredClone(current);},onSaved:value=>{saved=value;}});
 await editor.setOpen(true);editor.input(target('defaultEffort','ultra'));await editor.save();assert.deepEqual(calls[1].patch,{defaultEffort:'ultra'});assert.equal(saved.codexHistory,'relay');
 editor.input(target('preset','900k'));editor.input({dataset:{responseDefault:'autoCompact'},checked:false});await editor.save();assert.deepEqual(calls[2].patch,{defaultContext:{preset:'900k',windowTokens:900000,autoCompact:false}});assert.equal(editor.state.dirty,false);assert.equal(editor.state.receipt,'Defaults saved.');
});
test('invalid context input never reaches API and a failed save keeps the draft editable',async()=>{
 let requests=0;const editor=createResponseDefaults({getSettings:()=>initial,api:async()=>{requests++;throw Error('Endpoint offline');}});
 editor.input(target('preset','custom'));editor.input(target('windowTokens','4095'));await editor.save();assert.equal(requests,0);assert.match(editor.state.error,/4,096/);
 editor.input(target('windowTokens','900000'));await editor.save();assert.equal(requests,1);assert.equal(editor.state.dirty,true);assert.equal(editor.state.saving,false);assert.equal(editor.state.draft.defaultContext.windowTokens,'900000');assert.equal(editor.state.error,'Endpoint offline');
});
test('closing defaults prevents late responses from mutating the destroyed editor',async()=>{
 let resolve,changes=0;const editor=createResponseDefaults({getSettings:()=>initial,api:()=>new Promise(done=>{resolve=done;}),onChange:()=>changes++});
 const pending=editor.setOpen(true);assert.equal(editor.state.loading,true);editor.close();const before=changes;resolve({defaultEffort:'ultra'});await pending;assert.equal(changes,before);assert.equal(editor.state.draft,null);
});
test('rerendered open disclosures do not reload saved defaults indefinitely',async()=>{
 let requests=0;const editor=createResponseDefaults({getSettings:()=>initial,api:async()=>{requests++;return initial;}});
 await editor.setOpen(true);await editor.setOpen(true);await editor.setOpen(true);assert.equal(requests,1);assert.equal(editor.state.loading,false);
 editor.setOpen(false);await editor.setOpen(true);assert.equal(requests,2);
});
test('toggling compression sends only that preference and retains concurrently changed context',async()=>{
 let current=structuredClone(initial),patch;const editor=createResponseDefaults({getSettings:()=>current,api:async(url,method,value)=>{if(value){patch=value;current={...current,defaultContext:{...current.defaultContext,...value.defaultContext}};}return structuredClone(current);}});
 await editor.setOpen(true);current.defaultContext={preset:'900k',windowTokens:900000,autoCompact:true,headroomTokens:3000};
 editor.input({dataset:{responseDefault:'autoCompact'},checked:false});await editor.save();assert.deepEqual(patch,{defaultContext:{autoCompact:false}});assert.deepEqual(editor.state.draft.defaultContext,{preset:'900k',windowTokens:900000,autoCompact:false,headroomTokens:3000});
});
test('defaults retain unsupported selected effort and explain effective model capacity compactly',()=>{
 const html=renderResponseDefaults({defaultModel:'text',models:[{id:'text',supportedReasoningEfforts:['low']}]},{draft:{defaultEffort:'ultra',defaultContext:{preset:'900k',windowTokens:900000,autoCompact:true}},dirty:true});
 assert.match(html,/value="ultra" selected/);assert.match(html,/doesn't increase a model's supported capacity/);assert.match(html,/routine context compaction automatically/);assert.match(html,/Save preferences/);
});

test('verbosity and optional subagent concurrency save only changed preferences',async()=>{
 let current=structuredClone(initial),patch;
 const editor=createResponseDefaults({getSettings:()=>current,api:async(url,method,value)=>{if(value){patch=value;current={...current,...value};}return structuredClone(current);}});
 await editor.setOpen(true);
 const before=renderResponseDefaults({runtimeSettings:current},editor.state);
 assert.match(before,/Response length/);assert.match(before,/Allow on-demand subagents/);assert.match(before,/Parallel workers/);
 editor.input(target('verbosity','detailed'));
 editor.input({dataset:{responseDefault:'subagentsEnabled'},checked:true});
 editor.input(target('maxSubagents','4'));
 await editor.save();
 assert.deepEqual(patch,{verbosity:'detailed',subagentsEnabled:true,maxSubagents:4});
 assert.equal(editor.state.draft.verbosity,'detailed');
 assert.equal(editor.state.draft.maxSubagents,4);
 assert.equal(editor.state.draft.subagentsEnabled,true);
 const enabled=renderResponseDefaults({runtimeSettings:current},editor.state);
 assert.match(enabled,/value="4" selected/);
 assert.match(enabled,/4 parallel agents/);
});
