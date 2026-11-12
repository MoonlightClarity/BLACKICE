import test from 'node:test';
import assert from 'node:assert/strict';
import {planningDOM} from './fixture-planning-dom.mjs';
import {createContextControls,createContextCompaction,contextModelInfo,contextBudgetPreview,validateContextOptions,conversationContext} from '../public/next/core/context-controls.mjs';
import {projectFamily} from '../public/next/chat/reader-model.mjs';
import {submitChat} from '../public/next/chat/send.mjs';
import {createChatWorkspace} from '../public/next/chat/chat.mjs';
import {createSettingsWorkspace} from '../public/next/workspaces/settings.mjs';
import {createWorkflowEditor} from '../public/next/workspaces/workflow-editor.mjs';

const tick=()=>new Promise(resolve=>setImmediate(resolve));
const until=async read=>{for(let i=0;i<100;i++){if(read())return;await tick();}throw Error('Context fixture did not settle.');};
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
const info=()=>({connected:true,authenticated:true,cwd:'C:\\fixture',defaultModel:'gpt-6-luna',defaultModelSelection:'gpt-6-luna',
  runtimeSettings:{defaultContext:{preset:'model',autoCompact:true}},models:[
    {id:'first::gpt-6-luna',model:'gpt-6-luna',displayName:'First endpoint',available:true,contextWindowTokens:64000,contextWindowSource:'provider-reported'},
    {id:'gpt-6-luna',model:'gpt-6-luna',displayName:'GPT-6 Luna',available:true,runtimeDefaultContextWindowTokens:272000,contextWindowTokens:272000,maxContextWindowTokens:872000,effectiveContextWindowPercent:95,contextWindowSource:'runtime-reported'},
    {id:'second::gpt-6-luna',model:'gpt-6-luna',displayName:'Second endpoint',available:true,contextWindowTokens:128000,contextWindowSource:'provider-reported'},
  ]});
const saved=(id,context={preset:'extended',autoCompact:true},extra={})=>({id,taskId:id,status:'completed',settled:true,input:'Saved question',
  workflow:{nodes:[{id:'agent',type:'agent',model:'gpt-6-luna',context}]},nodes:{agent:{status:'completed',threadId:'thread-'+id,resolvedModel:'gpt-6-luna',output:'Saved answer',contextStatus:{preset:context.preset,requestedWindowTokens:context.windowTokens??null,autoCompact:context.autoCompact,nativeConfiguredWindowTokens:872000,nativeObservedWindowTokens:828400,effectiveWindowTokens:828400,nativeWindowBasis:'runtime-usage',actualInputTokens:12000}}},...extra});

function controls(t,options={}){
  const dom=planningDOM(t),calls=[],changed=[];
  const control=createContextControls({mount:dom.mount,id:'fixture-context',api:async(...args)=>{calls.push(args);return{compacted:false,reason:'No older exchanges.'};},onChange:value=>changed.push(value),...options});
  t.after(()=>control.destroy());control.update({status:info(),model:'gpt-6-luna'});
  return {...dom,control,calls,changed};
}


const vibeSelection='mistral-vibe::fixture-reported-model';
const vibeInfo=()=>({...info(),subscriptionProviders:[{id:'mistral-vibe',type:'subscription-cli',available:true}],models:[...info().models,{
  id:vibeSelection,model:'fixture-reported-model',providerId:'mistral-vibe',providerType:'subscription-cli',displayName:'CLI-reported fixture model',
  available:true,contextWindowTokens:202144,contextWindowSource:'runtime-reported',
}]});

test('Vibe context uses only reported capacity and accepts Model default without API budget controls',()=>{
  const status=vibeInfo(),native=contextModelInfo(status,vibeSelection);
  assert.equal(native.native,true);assert.equal(native.automaticOnly,true);assert.equal(native.defaultWindow,202144);
  assert.equal(native.maxWindow,null);assert.equal(native.outputLimit,null);assert.equal(native.percent,null);
  assert.deepEqual(contextBudgetPreview({preset:'extended',compactAtTokens:20000},native),{window:202144,requested:null,usable:202144,estimated:false,capped:false});
  assert.deepEqual(validateContextOptions({},native),{preset:'model',windowTokens:null,autoCompact:true});
  assert.deepEqual(validateContextOptions({preset:'model',windowTokens:null,autoCompact:true},native),{preset:'model',windowTokens:null,autoCompact:true});
  for(const options of [{preset:'extended'},{preset:'custom',windowTokens:64000},{autoCompact:false},{compactAtTokens:64000},{outputReserveTokens:4096},{keepRecentTokens:4000}])
    assert.throws(()=>validateContextOptions(options,native),/Use native automatic context/);
  assert.equal(contextModelInfo({models:[]},vibeSelection).automaticOnly,true,'A saved native identity retains its restriction while catalog data is loading.');
  assert.equal(contextModelInfo({providers:[{id:'mistral-vibe'}],models:[]},vibeSelection).automaticOnly,false,'A grandfathered API provider keeps its exact namespace.');
  assert.equal(contextModelInfo({models:[{id:vibeSelection,providerId:'mistral-vibe',providerType:'openai-compatible'}]},vibeSelection).automaticOnly,false);
  assert.equal(status.defaultModel,'gpt-6-luna');
});

test('Vibe catalog context limits are labelled separately from an observed native working window',t=>{
  const f=controls(t),status=vibeInfo(),catalogModel=status.models.find(model=>model.id===vibeSelection);
  Object.assign(catalogModel,{displayName:'Catalog fixture model',contextWindowTokens:1048576,contextWindowSource:'account-catalog'});
  const native=contextModelInfo(status,vibeSelection);
  assert.equal(native.source,'account-catalog');
  assert.deepEqual(contextBudgetPreview({preset:'model'},native),{window:1048576,requested:null,usable:null,estimated:false,capped:false});
  f.control.update({status,model:vibeSelection});f.control.open();
  assert.match(f.$('#fixture-context-capacity').textContent,/Catalog context limit: 1,048,576 tokens/);
  assert.match(f.$('#fixture-context-capacity').textContent,/Native automatic management determines the working window/);
  assert.doesNotMatch(f.$('#fixture-context-capacity').textContent,/CLI-reported context/);
  assert.match(f.$('#fixture-context-summary').textContent,/catalog limit 1,048,576 tokens/);
  assert.deepEqual(f.control.read(),{preset:'model',windowTokens:null,autoCompact:true});
  assert.equal(f.$('#fixture-context-api-options').hidden,true);assert.equal(f.$('#fixture-context-native-reset').hidden,true);
  f.control.update({status:vibeInfo()});
  assert.match(f.$('#fixture-context-capacity').textContent,/CLI-reported context: 202,144 tokens/);
  assert.doesNotMatch(f.$('#fixture-context-summary').textContent,/catalog limit/);
  assert.equal(f.control.dirty,false);assert.equal(f.changed.length,0);assert.equal(f.calls.length,0);
  assert.equal(status.defaultModel,'gpt-6-luna');
});

test('Vibe context hides unsupported controls and guards compression by the saved conversation model',async t=>{
  const f=controls(t),status=vibeInfo();f.control.update({status,model:vibeSelection});f.control.open();
  assert.deepEqual(f.control.read(),{preset:'model',windowTokens:null,autoCompact:true});
  for(const suffix of ['budget-controls','api-options','auto-row','advanced','native-reset'])assert.equal(f.$('#fixture-context-'+suffix).hidden,true,suffix);
  assert.match(f.$('#fixture-context-capacity').textContent,/CLI-reported context: 202,144/);
  assert.doesNotMatch(f.$('#fixture-context-capacity').textContent,/Maximum/);
  assert.match(f.$('#fixture-context-budget-note').textContent,/manages context automatically.*saved history is preserved/);
  assert.equal(f.document.activeElement,f.$('#fixture-context-toggle'));
  const savedVibe={key:'vibe:agent',runId:'vibe',nodeId:'agent',model:vibeSelection,reason:''};
  f.control.update({model:'gpt-6-luna',target:savedVibe});
  assert.deepEqual(f.control.compress(),{accepted:false,reason:'Mistral Vibe Code manages context automatically. Manual compression and custom context settings are unavailable; saved history is preserved.'});
  assert.equal(f.calls.length,0,'No compaction request is sent for a saved Vibe thread.');
  f.control.update({model:vibeSelection,target:{key:'api:agent',runId:'api',nodeId:'agent',model:'first::gpt-6-luna',reason:''}});
  assert.equal(f.control.compress().accepted,true,'Selecting Vibe for the next response does not change the saved API target.');
  await tick();assert.equal(f.calls.length,1);assert.equal(f.calls[0][0],'/api/runs/api/compact');assert.equal(f.changed.length,0);
});

test('Vibe retains an unsupported draft until an explicit available reset, without changing model or defaults',async t=>{
  const f=controls(t),status=vibeInfo(),original={preset:'custom',windowTokens:140000,autoCompact:false,compactAtTokens:56000,keepRecentTokens:10000,outputReserveTokens:4096,headroomTokens:1024};
  f.control.select('draft-owner',original);f.control.update({status,model:vibeSelection});f.control.open();
  assert.equal(f.$('#fixture-context-preset').value,'custom');assert.equal(f.$('#fixture-context-window').value,'140000');
  assert.equal(f.$('#fixture-context-budget-controls').hidden,false);assert.equal(f.$('#fixture-context-preset').disabled,true);
  assert.equal(f.$('#fixture-context-native-reset').hidden,false);assert.equal(f.document.activeElement,f.$('#fixture-context-native-reset'));
  assert.match(f.$('#fixture-context-budget-note').textContent,/Unsupported draft retained: Preset: custom.*140,000.*Automatic compression: off.*56000.*10000/);
  assert.throws(()=>f.control.read(),/Use native automatic context/);assert.equal(f.control.dirty,false);assert.equal(f.changed.length,0);
  f.control.update({model:'gpt-6-luna'});assert.deepEqual(f.control.read(),original);
  f.control.update({model:vibeSelection,busy:true});await f.click('#fixture-context-native-reset');
  assert.equal(f.$('#fixture-context-window').value,'140000');assert.equal(f.changed.length,0);
  f.control.update({busy:false,readonly:true});await f.click('#fixture-context-native-reset');assert.equal(f.changed.length,0);
  f.control.update({readonly:false});await f.click('#fixture-context-native-reset');
  assert.deepEqual(f.control.read(),{preset:'model',windowTokens:null,autoCompact:true});
  assert.equal(f.control.dirty,true);assert.equal(f.changed.length,1);assert.equal(f.$('#fixture-context-native-reset').hidden,true);
  assert.equal(f.$('#fixture-context-api-options').hidden,true);
  assert.deepEqual(original,{preset:'custom',windowTokens:140000,autoCompact:false,compactAtTokens:56000,keepRecentTokens:10000,outputReserveTokens:4096,headroomTokens:1024});
  assert.equal(status.defaultModel,'gpt-6-luna');assert.equal(status.defaultModelSelection,'gpt-6-luna');
  assert.equal(contextModelInfo(status,vibeSelection).id,vibeSelection);
});

test('native capacity, allowance estimate and route identity stay distinct across three endpoints',()=>{
  const status=info(),native=contextModelInfo(status,'gpt-6-luna');
  assert.equal(native.defaultWindow,272000);assert.equal(native.maxWindow,872000);
  assert.deepEqual(contextBudgetPreview({preset:'model'},native),{window:272000,requested:272000,usable:258400,estimated:true,capped:false});
  assert.equal(contextBudgetPreview({preset:'extended'},native).usable,828400);
  assert.equal(contextBudgetPreview({preset:'extended'},contextModelInfo(status,'first::gpt-6-luna')).window,64000);
  assert.equal(contextBudgetPreview({preset:'extended'},contextModelInfo(status,'second::gpt-6-luna')).window,128000);
  assert.equal(contextModelInfo(status,'default').id,'gpt-6-luna');
});

test('an explicit configured native default wins, while runtime usage does not replace the raw default',()=>{
  const status=info(),model=status.models[1];model.contextWindowTokens=128000;model.contextWindowSource='user-configured';
  assert.equal(contextModelInfo(status,'gpt-6-luna').defaultWindow,128000);
  model.contextWindowTokens=828400;model.contextWindowSource='runtime-reported';
  assert.equal(contextModelInfo(status,'gpt-6-luna').defaultWindow,272000);
});

test('opening and metadata refresh never save settings or create a dirty context draft',async t=>{
  const f=controls(t);f.control.select('chat-a',{preset:'extended',autoCompact:true});
  assert.match(f.$('#fixture-context-summary').textContent,/Extended.*872k/);
  assert.match(f.$('#fixture-context-budget-note').textContent,/Estimated usable context: 828,400/);
  for(const model of ['first::gpt-6-luna','second::gpt-6-luna','gpt-6-luna'])f.control.update({status:info(),model});
  assert.equal(f.control.read().preset,'extended');assert.equal(f.control.dirty,false);assert.equal(f.changed.length,0);assert.equal(f.calls.length,0);
  assert.match(f.$('#fixture-context-auto-help').textContent,/Codex manages automatic compaction/);
  assert.equal(f.$('#fixture-context-recent-label').hidden,true);
  assert.match(f.$('#fixture-context-trigger-label').textContent,/Requested Codex/);
});

test('partial custom input and focus survive metadata changes and clean reconciliation cannot overwrite edits',async t=>{
  const f=controls(t),preset=f.$('#fixture-context-preset');preset.value='custom';await preset.dispatch('change');
  await f.input('#fixture-context-window','');f.$('#fixture-context-window').focus();
  f.control.update({status:info(),model:'second::gpt-6-luna'});f.control.reconcile({preset:'extended',autoCompact:false});
  assert.equal(preset.value,'custom');assert.equal(f.$('#fixture-context-window').value,'');
  assert.equal(f.document.activeElement,f.$('#fixture-context-window'));assert.throws(()=>f.control.read(),/whole token count/);
  await f.input('#fixture-context-window','90000');assert.equal(f.control.read().windowTokens,90000);
  f.control.select('other-chat',{preset:'model',autoCompact:false});
  assert.equal(preset.value,'model');assert.equal(f.control.dirty,false);assert.equal(f.control.read().autoCompact,false);
});

test('legacy900k remains editable with an honest route cap and unknown maxima are not invented',async t=>{
  const f=controls(t);f.control.load({preset:'900k',autoCompact:false,outputReserveTokens:4096});
  assert.deepEqual(f.control.read(),{preset:'900k',windowTokens:900000,autoCompact:false,outputReserveTokens:4096});
  assert.match(f.$('#fixture-context-budget-note').textContent,/caps the budget at 872,000/);
  const unknown={models:[{id:'unknown-native',contextWindowTokens:272000}]};f.control.update({status:unknown,model:'unknown-native'});
  assert.equal(f.$('#fixture-context-preset').children.find(option=>option.value==='extended').disabled,true);
  f.control.load({preset:'extended'});assert.equal(f.control.read().preset,'extended');
  assert.match(f.$('#fixture-context-budget-note').textContent,/maximum is unavailable.*known default/);
  f.control.update({status:{models:[]},model:'unknown-native'});assert.throws(()=>f.control.read(),/known model capacity/);
});

test('actual runtime observation is shown separately from a smaller active working budget',t=>{
  const f=controls(t);f.control.update({target:{key:'a:agent',runId:'a',nodeId:'agent'},contextStatus:{nativeConfiguredWindowTokens:872000,nativeObservedWindowTokens:828400,effectiveWindowTokens:600000,nativeWindowBasis:'runtime-usage',actualInputTokens:24000}});
  const text=f.$('#fixture-context-saved').textContent;
  assert.match(text,/Saved configured window: 872,000/);assert.match(text,/Runtime-reported usable window: 828,400/);assert.match(text,/Active context budget: 600,000/);
  assert.equal(f.control.dirty,false);
});

test('an existing native compaction trigger stays visible and can be lowered after a budget change',async t=>{
  const f=controls(t);f.control.load({preset:'custom',windowTokens:120000,compactAtTokens:600000,autoCompact:false});
  assert.equal(f.$('#fixture-context-trigger').value,'600000');assert.equal(f.$('#fixture-context-trigger').disabled,false);
  assert.match(f.$('#fixture-context-budget-note').textContent,/saved trigger exceeds/);assert.throws(()=>f.control.read(),/compression trigger exceeds/);
  await f.input('#fixture-context-trigger','80000');assert.equal(f.control.read().compactAtTokens,80000);
  await f.input('#fixture-context-trigger','');assert.equal(Object.hasOwn(f.control.read(),'compactAtTokens'),false);
  assert.equal(f.control.read().autoCompact,false,'Changing the trigger does not pretend to disable native compaction.');
});

test('saved reserve overrides remain visible and clearing one repairs a smaller budget without changing the other',async t=>{
  const f=controls(t);f.control.select('a',{preset:'extended',outputReserveTokens:100000,headroomTokens:20000});
  const preset=f.$('#fixture-context-preset');preset.value='custom';await preset.dispatch('change');await f.input('#fixture-context-window','120000');
  assert.equal(f.$('#fixture-context-advanced').open,true);assert.equal(f.$('#fixture-context-reserve').value,'100000');assert.equal(f.$('#fixture-context-headroom').value,'20000');
  assert.throws(()=>f.control.read(),/Advanced budgets/);f.control.update({status:info(),model:'second::gpt-6-luna'});
  assert.equal(f.$('#fixture-context-reserve').value,'100000');assert.equal(f.$('#fixture-context-headroom').value,'20000');
  await f.input('#fixture-context-reserve','');assert.equal(Object.hasOwn(f.control.read(),'outputReserveTokens'),false);assert.equal(f.control.read().headroomTokens,20000);
  f.control.select('b',{preset:'model'});f.control.select('a',{preset:'extended'});assert.equal(f.$('#fixture-context-reserve').value,'');assert.equal(f.$('#fixture-context-headroom').value,'20000');
  await f.input('#fixture-context-headroom','');assert.equal(Object.hasOwn(f.control.read(),'headroomTokens'),false);
});

test('projection preserves saved context for failed runs and bounds compression statistics without summary text',()=>{
  const original=saved('failed',{preset:'custom',windowTokens:120000,autoCompact:false,headroomTokens:1024},{status:'failed'});
  original.nodes.agent.status='failed';original.workflow.nodes[0].codexHistory='relay';
  original.nodes.agent.lastCompaction={at:'2026-10-30T12:00:00Z',compacted:true,checkpoint:{beforeTokens:90000,afterTokens:12000,summary:'PRIVATE CHECKPOINT'.repeat(5000),transcriptPath:'private-path'}};
  const projected=projectFamily({runs:[original]}).runs[0],reopened=conversationContext([projected],{preset:'900k'});
  assert.deepEqual(reopened.context,{preset:'custom',windowTokens:120000,autoCompact:false,headroomTokens:1024});
  assert.equal(projected.nodes.agent.contextStatus.nativeObservedWindowTokens,828400);
  assert.equal(projected.nodes.agent.resolvedModel,'gpt-6-luna');assert.equal(projected.workflow.nodes[0].codexHistory,'relay');
  assert.equal(reopened.lastCompaction.checkpoint.beforeTokens,90000);
  assert.equal(JSON.stringify(projected).includes('PRIVATE CHECKPOINT'),false);assert.equal(JSON.stringify(projected).includes('private-path'),false);
  assert.deepEqual(projected.events,[]);assert.equal(projected.precomputedMessages.filter(row=>row.role==='assistant').length,1);
});

test('older recorded budgets are recovered without freezing calculated triggers or adopting newer global defaults',()=>{
  const run=saved('old');delete run.workflow.nodes[0].context;
  run.nodes.agent.contextStatus={preset:'custom',requestedWindowTokens:160000,autoCompact:false,compactAtTokens:111111,outputReserveTokens:8192};
  let value=conversationContext([projectFamily({runs:[run]}).runs[0]],{preset:'extended'});
  assert.deepEqual(value.context,{preset:'custom',windowTokens:160000,autoCompact:false});assert.equal(value.contextOrigin,'recorded');
  delete run.nodes.agent.contextStatus;value=conversationContext([run],{preset:'900k'});
  assert.deepEqual(value.context,{preset:'model',windowTokens:null,autoCompact:true});assert.equal(value.contextOrigin,'legacy');
  assert.equal(conversationContext([],{preset:'extended'}).context.preset,'extended');
});

test('context applies to new workflows and continuations, but never changes an active direction',async()=>{
  const calls=[],api=async(route,method,body)=>{calls.push({route,body});return route==='/api/workflows'?body:route.endsWith('/steer')?{accepted:true}:{id:'created',status:'running'};};
  const context={preset:'extended',windowTokens:null,autoCompact:false};
  await submitChat({api,runs:[],task:'New',cwd:'C:\\fixture',model:'gpt-6-luna',context});
  assert.deepEqual(calls[0].body.settings.context,context);assert.deepEqual(calls[0].body.nodes.find(node=>node.type==='agent').context,context);
  assert.equal(calls[0].body.nodes.find(node=>node.type==='agent').model,'gpt-6-luna');
  calls.length=0;await submitChat({api,runs:[saved('previous')],task:'Next',context});
  assert.equal(calls[0].route,'/api/runs/previous/continue');assert.deepEqual(calls[0].body.context,context);
  context.autoCompact=true;assert.equal(calls[0].body.context.autoCompact,false,'Submitted payload owns its snapshot.');
  const active=saved('active');active.status='running';active.settled=false;Object.assign(active.nodes.agent,{status:'running',turnId:'turn-active'});
  calls.length=0;await submitChat({api,runs:[active],task:'Direction',context});
  assert.equal(calls[0].route,'/api/runs/active/steer');assert.equal(Object.hasOwn(calls[0].body,'context'),false);
});

test('manual eligibility accepts legacy native history while retaining settled and saved-context prerequisites',()=>{
  assert.match(conversationContext([]).reason,/Send a message/);
  const run=saved('a');assert.equal(conversationContext([run]).reason,'');
  run.settled=false;assert.match(conversationContext([run]).reason,/finish/);run.settled=true;
  delete run.nodes.agent.threadId;assert.equal(conversationContext([run]).reason,'','Saved native messages can create a resumable thread.');
  run.nodes.agent.resumeThreadId='resume-only';assert.equal(conversationContext([run]).reason,'');
  run.nodes.agent.threadId='thread';run.workflow.nodes[0].codexHistory='relay';assert.equal(conversationContext([run]).reason,'');
  delete run.workflow.nodes[0].codexHistory;run.nodes.agent.codexHistory='relay';
  const projected=projectFamily({runs:[run]}).runs[0];assert.equal(projected.nodes.agent.codexHistory,'relay');assert.equal(conversationContext([projected]).reason,'');
  delete projected.nodes.agent.threadId;assert.equal(conversationContext([projected]).reason,'','Saved native history can migrate without its expired thread ID.');
  delete projected.nodes.agent.resumeThreadId;assert.equal(conversationContext([projected]).reason,'');
  projected.nodes.agent.resolvedModel='first::model';assert.match(conversationContext([projected]).reason,/no saved model thread/,'API-provider threads keep their existing requirement.');
  projected.nodes.agent.resolvedModel='gpt-6-luna';projected.input='';projected.output='';projected.nodes.agent.output='';projected.precomputedMessages=[];
  assert.match(conversationContext([projected]).reason,/no saved messages/);
  projected.precomputedMessages=[{role:'assistant',text:'Recorded answer without a native thread identifier.'}];assert.equal(conversationContext([projected]).reason,'');
  projected.status='running';assert.match(conversationContext([projected]).reason,/finish/);
});

test('manual request waits for completion, deduplicates clicks, surfaces no-op and rejects an acceptance-only response',async()=>{
  const gate=deferred(),calls=[],completed=[];
  const action=createContextCompaction({api:async(...args)=>{calls.push(args);return gate.promise;},onComplete:(...args)=>completed.push(args)}),target={key:'a:agent',runId:'a',nodeId:'agent'};
  const first=action.start(target);void action.start(target);assert.equal(calls.length,1);assert.equal(action.state(target.key).pending,true);assert.equal(completed.length,0);
  gate.resolve({compacted:false,reason:'No complete older exchanges.'});await first;
  assert.equal(action.state(target.key).pending,false);assert.equal(action.state(target.key).message,'No complete older exchanges.');assert.equal(completed.length,1);
  const unconfirmed=createContextCompaction({api:async()=>({accepted:true})});await unconfirmed.start(target);
  assert.equal(unconfirmed.state(target.key).error,true);assert.match(unconfirmed.state(target.key).message,/did not confirm/);
});

test('a no-op compression attempt does not acquire a new last-compression timestamp',async t=>{
  const f=controls(t);f.control.update({target:{key:'a:agent',runId:'a',nodeId:'agent'},lastCompaction:{at:'2026-10-29T12:00:00Z',compacted:true,checkpoint:{beforeTokens:90000,afterTokens:12000}}});
  f.control.compress();await tick();
  assert.equal(f.$('#fixture-context-feedback').textContent,'No older exchanges.');
  assert.match(f.$('#fixture-context-saved').textContent,/Last compression: 2026-10-29 12:00:00 UTC/);
  f.control.update({lastCompaction:null});assert.doesNotMatch(f.$('#fixture-context-saved').textContent,/Last compression/);
});

function chatDOM(t){
  const dom=planningDOM(t),prototype=Object.getPrototypeOf(dom.mount),append=prototype.append,type=Object.getOwnPropertyDescriptor(prototype,'type');
  Object.defineProperties(prototype,{childNodes:{get(){return this.children;}},lastChild:{get(){return this.children.at(-1)||null;}},type:{get:type.get,set(value){this.setAttribute('type',value);}}});
  prototype.append=function(...items){for(const item of items)append.call(this,...(item.tagName==='#FRAGMENT'?[...item.children]:[item]));};
  prototype.replaceChildren=function(...items){for(const child of [...this.children])child.remove();this.rawText='';this.append(...items);};
  prototype.showModal=function(){this.open=true;};prototype.close=function(){this.open=false;};prototype.scrollIntoView=function(){};
  dom.document.createDocumentFragment=()=>dom.element('#fragment');
  return dom;
}

async function chatFixture(t,{compress,continueResponse,cancel,attachments=[]}={}){
  const dom=chatDOM(t),status=info(),families=new Map(['a','b'].map(id=>[id,{rootId:id,state:'active',runs:[saved(id,id==='a'?{preset:'extended',autoCompact:true}:{preset:'custom',windowTokens:96000,autoCompact:false})]}])),calls=[],listeners=new Set(),storage=new Map();
  if(attachments.length)storage.set('blackice.next.attachments',JSON.stringify({a:attachments}));
  const oldWorker=globalThis.Worker,oldStorage=globalThis.localStorage;
  globalThis.localStorage={getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,String(value)),removeItem:key=>storage.delete(key)};
  globalThis.Worker=class{
    handlers=new Map();cancelled=new Set();
    addEventListener(type,handler){this.handlers.set(type,handler);}
    postMessage(message){if(message.type==='cancel'){this.cancelled.add(message.id);return;}queueMicrotask(()=>{if(!this.cancelled.has(message.id))this.handlers.get('message')?.({data:{id:message.id,ok:true,family:projectFamily(structuredClone(families.get(message.runId)))}});});}
    terminate(){}
  };
  const api=async(route,method='GET',body)=>{calls.push({route,method,body});
    if(route.startsWith('/api/conversations?'))return{conversations:[]};if(route==='/api/attachments')return[];
    if(route==='/api/status')return status;if(route.endsWith('/compact'))return compress(route,body);
    if(route.endsWith('/cancel')&&cancel)return cancel(route,body);
    if(route.endsWith('/continue')&&continueResponse)return continueResponse({route,body,families});
    if(route.endsWith('/steer'))return{accepted:true,delivery:'delivered'};
    throw Error('Unexpected fixture request '+route);
  };
  const workspace=createChatWorkspace({mount:dom.mount,api,events:{subscribe:listener=>{listeners.add(listener);return()=>listeners.delete(listener);}},getStatus:()=>status});
  t.after(()=>{workspace.destroy();if(oldWorker===undefined)delete globalThis.Worker;else globalThis.Worker=oldWorker;if(oldStorage===undefined)delete globalThis.localStorage;else globalThis.localStorage=oldStorage;});
  workspace.enter();await tick();
  const open=async id=>{workspace.openConversationId(id);await until(()=>workspace.getState().selected===id&&workspace.getState().runCount===1);};
  return {...dom,status,families,calls,workspace,open,storage,emit:event=>{for(const listener of listeners)listener(event);}};
}

test('Chat removes the manual command palette and sends former commands as ordinary text',async t=>{
  const f=await chatFixture(t,{continueResponse:({families})=>families.get('a').runs[0]});await f.open('a');
  assert.equal(f.$('#next-chat-commands'),null);assert.equal(f.$('#next-chat-command-menu'),null);
  for(const text of ['/context','/ctx','/compress','/compact','/COMPACT','/context change model','/unknown','/home/user/report.md','Please explain /compress']){
    await f.input('#next-chat-input',text);
    const before=f.calls.filter(call=>call.method==='POST').length;
    await f.$('#next-chat-form').dispatch('submit');await until(()=>f.calls.filter(call=>call.method==='POST').length===before+1);await tick();
    const request=f.calls.filter(call=>call.method==='POST').at(-1);assert.equal(request.route,'/api/runs/a/continue');assert.equal(request.body.message,text);
    assert.equal(request.body.context.autoCompact,true);
  }
  assert.equal(f.calls.some(call=>call.route.endsWith('/compact')),false);
});

test('Chat upgrades saved disabled compaction for the next response while preserving budget and old run',async t=>{
  const f=await chatFixture(t,{continueResponse:({families})=>families.get('b').runs[0]});await f.open('b');
  const old=structuredClone(f.families.get('b'));
  assert.equal(f.$('#next-chat-context-auto').checked,true);
  assert.equal(f.$('#next-chat-context-auto-row').hidden,true);
  await f.input('#next-chat-input','Continue normally');await f.$('#next-chat-form').dispatch('submit');
  await until(()=>f.calls.some(call=>call.route.endsWith('/continue')));
  const sent=f.calls.find(call=>call.route.endsWith('/continue')).body.context;
  assert.equal(sent.autoCompact,true);assert.equal(sent.preset,'custom');assert.equal(sent.windowTokens,96000);
  assert.deepEqual(f.families.get('b'),old,'Historical run is not rewritten');
  assert.equal(f.calls.some(call=>call.route.endsWith('/compact')),false,'No manual request needed');
});
test('real Chat first-open restores saved context and unsent per-chat edits survive selection and runtime status',async t=>{
  const f=await chatFixture(t,{compress:async()=>({compacted:false})});await f.open('a');
  const preset=f.$('#next-chat-context-preset');preset.value='custom';await preset.dispatch('change');await f.input('#next-chat-context-window','400000');
  f.emit({type:'runtime.status',data:{...f.status,runtimeSettings:{defaultContext:{preset:'900k',autoCompact:false}}}});
  assert.equal(preset.value,'custom');assert.equal(f.$('#next-chat-context-window').value,'400000');
  await f.open('b');assert.equal(preset.value,'custom');assert.equal(f.$('#next-chat-context-window').value,'96000');
  await f.open('a');assert.equal(preset.value,'custom');assert.equal(f.$('#next-chat-context-window').value,'400000');
  assert.equal(f.calls.filter(call=>call.method!=='GET').length,0);
});

test('successful submission commits a context draft while later per-chat edits remain isolated',async t=>{
  const f=controls(t);f.control.select('a',{preset:'extended'});
  const preset=f.$('#fixture-context-preset');preset.value='custom';await preset.dispatch('change');await f.input('#fixture-context-window','150000');
  const revision=f.control.revision,submitted=f.control.read();
  f.control.select('b',{preset:'model'});f.control.select('a',{preset:'extended'});assert.equal(f.control.read().windowTokens,150000);
  assert.equal(f.control.commit('a',submitted,revision),false,'A newer restored/edit revision is not cleared by an old receipt.');
  assert.equal(f.control.commit('a',submitted,f.control.revision),true);assert.equal(f.control.dirty,false);
  f.control.select('b',{preset:'model'});f.control.select('a',{preset:'extended'});assert.equal(f.control.read().preset,'extended','After commit the next visit takes the saved server context.');
});

test('actual Chat submission commits the next-turn context and subsequent clean reopen reads backend context',async t=>{
  const f=await chatFixture(t,{continueResponse:({body,families})=>{
    const next=saved('a-next',body.context,{taskId:'a'});families.set('a-next',{rootId:'a',state:'active',runs:[next]});return next;
  }});await f.open('a');
  const preset=f.$('#next-chat-context-preset');preset.value='custom';await preset.dispatch('change');await f.input('#next-chat-context-window','400000');
  await f.input('#next-chat-input','Continue with this budget');await f.$('#next-chat-form').dispatch('submit');
  await until(()=>f.$('#next-chat-hint').textContent==='Message sent. BLACKICE is working.');
  const sent=f.calls.find(call=>call.route==='/api/runs/a/continue');assert.equal(sent.body.context.windowTokens,400000);assert.equal(Object.hasOwn(sent.body,'model'),false,'Ordinary continuation keeps the saved run model without an override.');
  assert.equal(preset.value,'custom');assert.doesNotMatch(f.$('#next-chat-context-summary').textContent,/next response/);
  f.families.get('a-next').runs[0].workflow.nodes[0].context={preset:'extended',autoCompact:true};
  await f.open('b');await f.open('a');assert.equal(preset.value,'extended','Committed draft no longer shadows a newer backend context.');
  assert.equal(f.calls.filter(call=>call.method!=='GET').length,1);
});

test('successful live direction leaves the next-response context draft intact',async t=>{
  const f=await chatFixture(t),active=f.families.get('a').runs[0];active.status='running';active.settled=false;Object.assign(active.nodes.agent,{status:'running',turnId:'turn-a'});
  await f.open('a');const preset=f.$('#next-chat-context-preset');preset.value='custom';await preset.dispatch('change');await f.input('#next-chat-context-window','400000');
  await f.input('#next-chat-input','Additional direction');await f.$('#next-chat-form').dispatch('submit');await until(()=>f.$('#next-chat-hint').textContent==='Direction delivered.');
  assert.equal(f.calls.find(call=>call.route.endsWith('/steer')).body.context,undefined);assert.match(f.$('#next-chat-context-summary').textContent,/next response/);
  await f.open('b');await f.open('a');assert.equal(preset.value,'custom');assert.equal(f.$('#next-chat-context-window').value,'400000');
  assert.equal(f.calls.filter(call=>call.method!=='GET').length,1);
});

test('Stop compression stays scoped to the original operation and a cancel acknowledgement does not end pending',async t=>{
  const compact=deferred(),cancel=deferred(),calls=[];
  const f=controls(t,{api:async(route,method,body)=>{calls.push({route,method,body});return route.endsWith('/cancel')?cancel.promise:compact.promise;}});
  const a={key:'a:agent',runId:'a',nodeId:'agent'},b={key:'b:agent',runId:'b',nodeId:'agent'};
  f.control.select('a',{preset:'extended'});f.control.update({target:a});f.control.compress();
  assert.equal(f.$('#fixture-context-stop').hidden,false);await f.click('#fixture-context-stop');await f.click('#fixture-context-stop');
  assert.equal(calls.filter(call=>call.route.endsWith('/cancel')).length,1);assert.equal(calls[1].route,'/api/runs/a/cancel');
  f.control.select('b',{preset:'custom',windowTokens:64000});f.control.update({target:b});cancel.resolve({status:'cancelled'});await tick();
  assert.equal(f.control.operation(a.key).pending,true);assert.equal(f.control.operation(a.key).cancelRequested,true);assert.equal(f.$('#fixture-context-stop').hidden,true);
  assert.equal(f.control.read().windowTokens,64000);assert.doesNotMatch(f.$('#fixture-context-feedback').textContent,/Stop|cancel/);
  f.control.select('a',{preset:'extended'});f.control.update({target:a});assert.equal(f.control.isCompacting(),true);assert.match(f.$('#fixture-context-feedback').textContent,/Waiting for compression to settle/);
  compact.reject(Error('Compression cancelled.'));await tick();assert.equal(f.control.operation(a.key).pending,false);assert.match(f.$('#fixture-context-feedback').textContent,/Compression cancelled/);
});

test('saved default context round-trips only on explicit runtime Save and keeps unrelated preferences',async t=>{
  const dom=planningDOM(t),status=info(),calls=[],runtime={defaultEffort:'high',defaultServiceTier:'default',verbosity:'balanced',providerIdleTimeoutMs:300000,runTimeoutMs:null,maxSubagents:3,subagentsEnabled:false,connectedGmail:true,executionGuardrails:false,defaultContext:{preset:'900k',autoCompact:false,headroomTokens:2048}};
  const api=async(route,method='GET',body)=>{calls.push({route,method,body});if(route==='/api/status')return{...status,runtimeSettings:structuredClone(runtime)};if(route==='/api/runtime/settings'){if(method==='POST')Object.assign(runtime,structuredClone(body));return structuredClone(runtime);}if(route==='/api/execution/settings')return{maxConcurrentRuns:null};throw Error('Unexpected default-context fixture route');};
  const workspace=createSettingsWorkspace({mount:dom.mount,api,getStatus:()=>status,events:{subscribe:()=>()=>{}}});t.after(()=>workspace.destroy());workspace.enter();
  await until(()=>dom.$('#next-runtime-context-preset').value==='900k');
  assert.equal(dom.$('#next-runtime-context-body').hidden,true,'Settings context starts collapsed.');
  const preset=dom.$('#next-runtime-context-preset');preset.value='extended';await preset.dispatch('change',{},true);
  workspace.updateStatus({...status,runtimeSettings:{...runtime,defaultContext:{preset:'model'}}});assert.equal(preset.value,'extended');
  const enter=await dom.$('#next-runtime-context-window').dispatch('keydown',{key:'Enter'},true);assert.equal(enter.defaultPrevented,true);
  assert.equal(calls.filter(call=>call.method!=='GET').length,0);
  await dom.$('#next-runtime-settings-form').dispatch('submit');await until(()=>dom.$('#next-runtime-feedback').textContent==='Saved.');
  const writes=calls.filter(call=>call.method==='POST');assert.equal(writes.length,1);
  assert.deepEqual(writes[0].body.defaultContext,{preset:'extended',windowTokens:null,autoCompact:false,headroomTokens:2048});
  assert.equal(writes[0].body.connectedGmail,true);assert.equal(writes[0].body.defaultEffort,'high');
  workspace.leave();workspace.enter();await tick();await tick();assert.equal(preset.value,'extended');
  assert.equal(calls.filter(call=>call.method!=='GET').length,1);
});

test('a chat workflow with Extended context can reopen, edit and save through the workflow editor',async t=>{
  const dom=chatDOM(t),calls=[];
  let stored={id:'workflow-context',name:'Saved chat workflow',settings:{context:{preset:'extended',autoCompact:true},untouched:'keep'},nodes:[{id:'agent',type:'agent',name:'Agent',prompt:'Continue work',model:'gpt-6-luna',context:{preset:'extended',windowTokens:null,autoCompact:true,headroomTokens:2048},tools:['keep-tool']}],edges:[]};
  const editor=createWorkflowEditor({mount:dom.mount,api:async(route,method='GET',body)=>{calls.push({route,method,body});if(method==='GET')return structuredClone(stored);stored=structuredClone(body);return stored;}});
  t.after(()=>editor.destroy());editor.show(structuredClone(stored));
  const preset=dom.$('#next-workflow-edit-context');assert.equal(preset.value,'extended');assert.equal(preset.children.find(option=>option.value==='extended')?.textContent,'Extended (model’s supported maximum)');
  const compact=dom.$('#next-workflow-edit-compact');compact.checked=false;await compact.dispatch('change');
  assert.equal(calls.length,0);await dom.$('#next-workflow-edit-form').dispatch('submit');await until(()=>dom.$('#next-workflow-edit-feedback').textContent==='Workflow saved.');
  assert.deepEqual(stored.nodes[0].context,{preset:'extended',windowTokens:null,autoCompact:false,headroomTokens:2048});
  assert.deepEqual(stored.nodes[0].tools,['keep-tool']);assert.equal(stored.settings.untouched,'keep');assert.equal(preset.value,'extended');
});
