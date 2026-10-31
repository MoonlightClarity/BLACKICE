import test from 'node:test';
import assert from 'node:assert/strict';
import {planningDOM} from './fixture-planning-dom.mjs';
import {createContextControls,createContextCompaction,contextModelInfo,contextBudgetPreview,conversationContext} from '../public/next/core/context-controls.mjs';
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
  const command=async name=>{await dom.click('#next-chat-commands');await dom.click('#next-chat-command-'+name);await dom.$('#next-chat-form').dispatch('submit');await tick();};
  return {...dom,status,families,calls,workspace,open,command,storage,emit:event=>{for(const listener of listeners)listener(event);}};
}

test('Chat has no idle compression block and menu selection inserts Context without executing it',async t=>{
  const f=await chatFixture(t);await f.open('a');
  const panel=f.$('#next-chat-context-heading').parentElement;
  assert.equal(panel.hidden,true);assert.equal(f.$('#next-chat-context-compress'),null);
  assert.equal(f.$('#next-chat-context-feedback').textContent,'');
  await f.click('#next-chat-commands');
  assert.equal(f.$('#next-chat-command-menu').hidden,false);
  assert.deepEqual(f.$('#next-chat-command-menu').children.map(row=>row.children[0].textContent),['/compress','/context']);
  await f.click('#next-chat-command-context');
  assert.equal(f.$('#next-chat-input').value,'/context');assert.equal(panel.hidden,true);
  assert.equal(f.calls.some(call=>call.method!=='GET'),false,'Selecting a command performs no API mutation.');
  await f.$('#next-chat-form').dispatch('submit');
  assert.equal(panel.hidden,false);assert.equal(f.$('#next-chat-context-body').hidden,false);
  assert.equal(f.document.activeElement,f.$('#next-chat-context-preset'));
  await f.$('#next-chat-context-preset').dispatch('keydown',{key:'Escape'},true);
  assert.equal(panel.hidden,true);assert.equal(f.document.activeElement,f.$('#next-chat-input'));
  assert.equal(f.calls.some(call=>call.method!=='GET'),false);
});

test('command menu follows the actual composer geometry and stays inside a narrow viewport',async t=>{
  const f=await chatFixture(t),form=f.$('#next-chat-form'),area=form.parentElement;
  form.getBoundingClientRect=()=>({left:270,right:1484,top:1000,bottom:1140});
  area.getBoundingClientRect=()=>({left:250,right:1504,top:980,bottom:1160});
  window.innerWidth=1504;
  await f.click('#next-chat-commands');
  const menu=f.$('#next-chat-command-menu');assert.equal(menu.style.left,'20px');assert.equal(menu.style.bottom,'164px');
  assert.equal(250+parseFloat(menu.style.left),270,'Anchor to the real form, including theme width overrides.');
  await f.click('#next-chat-commands');
  form.getBoundingClientRect=()=>({left:270,right:480,top:1000,bottom:1140});
  area.getBoundingClientRect=()=>({left:250,right:500,top:980,bottom:1160});window.innerWidth=500;
  await f.click('#next-chat-commands');
  assert.ok(250+parseFloat(menu.style.left)+parseFloat(menu.style.width)<=492);
  assert.equal(f.calls.some(call=>call.method!=='GET'),false);
});

test('slash completion uses arrows, Tab and a separate Enter to execute, with IME and newline preserved',async t=>{
  const pending=deferred(),f=await chatFixture(t,{compress:()=>pending.promise});await f.open('a');
  const input=await f.input('#next-chat-input','/');
  await input.dispatch('keydown',{key:'ArrowDown'});
  assert.equal(input.getAttribute('aria-activedescendant'),'next-chat-command-context');
  const tab=await input.dispatch('keydown',{key:'Tab'});
  assert.equal(tab.defaultPrevented,true);assert.equal(input.value,'/context');assert.equal(f.$('#next-chat-context-body').hidden,true);
  await input.dispatch('keydown',{key:'Enter'});assert.equal(f.$('#next-chat-context-body').hidden,false);
  await f.click('#next-chat-context-toggle');
  await f.input('#next-chat-input','/CoM');
  for(const flags of [{isComposing:true},{shiftKey:true},{ctrlKey:true},{altKey:true}]){
    const event=await input.dispatch('keydown',{key:'Enter',...flags});assert.equal(event.defaultPrevented,false);
  }
  assert.equal(f.calls.some(call=>call.method!=='GET'),false);
  await input.dispatch('keydown',{key:'Enter'});
  assert.equal(input.value,'/compress');assert.equal(f.$('#next-chat-command-menu').hidden,true);
  assert.equal(f.calls.some(call=>call.method!=='GET'),false,'The first Enter selects completion only.');
  await input.dispatch('keydown',{key:'Enter'});await tick();
  assert.deepEqual(f.calls.filter(call=>call.method!=='GET').map(call=>call.route),['/api/runs/a/compact']);
  pending.resolve({compacted:false,reason:'No older exchanges.'});await tick();
});

for(const spelling of ['/compress','/COMPACT'])test('exact '+spelling+' is local, deduplicated and preserves files and the context draft',async t=>{
  const pending=deferred(),f=await chatFixture(t,{compress:()=>pending.promise,attachments:['file_kept']});await f.open('a');
  f.$('#next-chat-context-preset').value='custom';await f.$('#next-chat-context-preset').dispatch('change');await f.input('#next-chat-context-window','400000');
  const attachmentState=f.storage.get('blackice.next.attachments');
  await f.input('#next-chat-input',spelling);await f.$('#next-chat-form').dispatch('submit');await tick();
  await f.input('#next-chat-input',spelling);await f.$('#next-chat-form').dispatch('submit');await tick();
  const writes=f.calls.filter(call=>call.method!=='GET');
  assert.equal(writes.length,1);assert.equal(writes[0].route,'/api/runs/a/compact');assert.deepEqual(writes[0].body,{nodeId:'agent'});
  assert.equal(f.storage.get('blackice.next.attachments'),attachmentState);assert.equal(f.$('#next-chat-context-window').value,'400000');
  assert.equal(f.$('#next-chat-input').value,'');assert.equal(f.$('#next-chat-context-body').hidden,true);
  assert.equal(f.$('#next-chat-context-heading').hidden,true);assert.match(f.$('#next-chat-context-feedback').textContent,/Compressing/);
  pending.resolve({compacted:true,method:'codex-native'});await tick();await tick();
});

test('recognized commands with arguments return a local usage error without altering text or files',async t=>{
  const f=await chatFixture(t,{attachments:['file_kept']});await f.open('a');
  const attachmentState=f.storage.get('blackice.next.attachments');
  for(const text of ['/compress please','/COMPACT 900k','/context change model','/CtX\nshow it']){
    await f.input('#next-chat-input',text);await f.$('#next-chat-form').dispatch('submit');await tick();
    assert.match(f.$('#next-chat-hint').textContent,/Usage:.*no arguments/);
    assert.equal(f.$('#next-chat-input').value,text);assert.equal(f.storage.get('blackice.next.attachments'),attachmentState);
  }
  assert.equal(f.calls.some(call=>call.method!=='GET'),false);
});

test('Context is inspectable during active work while Compress never becomes a live model direction',async t=>{
  const f=await chatFixture(t),run=f.families.get('a').runs[0];
  run.status='running';run.settled=false;Object.assign(run.nodes.agent,{status:'running',turnId:'active-turn'});
  await f.open('a');await f.input('#next-chat-input','/CtX');await f.$('#next-chat-form').dispatch('submit');
  assert.equal(f.$('#next-chat-context-body').hidden,false);assert.equal(f.$('#next-chat-context-preset').value,'extended');
  await f.input('#next-chat-input','/compress');await f.$('#next-chat-form').dispatch('submit');await tick();
  assert.match(f.$('#next-chat-hint').textContent,/finish/);assert.equal(f.$('#next-chat-input').value,'/compress');
  assert.equal(f.calls.some(call=>call.method!=='GET'),false);
  await f.input('#next-chat-input','/workspace/a.txt is the file to inspect');await f.$('#next-chat-form').dispatch('submit');await tick();
  assert.equal(f.calls.find(call=>call.method==='POST').route,'/api/runs/a/steer');
  assert.equal(f.calls.find(call=>call.method==='POST').body.message,'/workspace/a.txt is the file to inspect');
});

test('unknown slash commands and path prose keep the ordinary continuation path',async t=>{
  const f=await chatFixture(t,{continueResponse:({families})=>families.get('a').runs[0]});await f.open('a');
  for(const text of ['/unknown','/home/user/report.md','/compress.txt','Please explain /compress']){
    await f.input('#next-chat-input',text);assert.equal(f.$('#next-chat-command-menu').hidden,true);
    const before=f.calls.filter(call=>call.method==='POST').length;
    await f.$('#next-chat-form').dispatch('submit');await until(()=>f.calls.filter(call=>call.method==='POST').length===before+1);await tick();
    const request=f.calls.filter(call=>call.method==='POST').at(-1);assert.equal(request.route,'/api/runs/a/continue');assert.equal(request.body.message,text);
  }
  assert.equal(f.calls.some(call=>call.route.endsWith('/compact')),false);
});

test('palette commands preserve an ordinary draft and attachments across execution, Escape and navigation',async t=>{
  const f=await chatFixture(t,{attachments:['file_kept']});await f.open('a');
  const original='Unsent question with exact details',attachmentState=f.storage.get('blackice.next.attachments');
  await f.input('#next-chat-input',original);await f.click('#next-chat-commands');await f.click('#next-chat-command-context');
  assert.equal(f.$('#next-chat-input').value,'/context');assert.equal(JSON.parse(f.storage.get('blackice.next.drafts')).a,original);
  await f.open('b');await f.input('#next-chat-input','B draft');await f.open('a');
  assert.equal(f.$('#next-chat-input').value,'/context');await f.$('#next-chat-form').dispatch('submit');
  assert.equal(f.$('#next-chat-input').value,original);assert.equal(f.storage.get('blackice.next.attachments'),attachmentState);
  await f.click('#next-chat-commands');await f.click('#next-chat-command-compress');
  await f.$('#next-chat-input').dispatch('keydown',{key:'Escape'});
  assert.equal(f.$('#next-chat-input').value,original);assert.equal(f.calls.some(call=>call.method!=='GET'),false);
  await f.open('b');assert.equal(f.$('#next-chat-input').value,'B draft');
});

test('menu insertion preserves unknown slash-word drafts on Escape and successful local command',async t=>{
  const f=await chatFixture(t);await f.open('a');
  for(const original of ['/notes','/help']){
    await f.input('#next-chat-input',original);assert.equal(f.$('#next-chat-command-menu').hidden,true);
    await f.click('#next-chat-commands');await f.click('#next-chat-command-compress');
    assert.equal(JSON.parse(f.storage.get('blackice.next.drafts')).a,original);
    await f.$('#next-chat-input').dispatch('keydown',{key:'Escape'});assert.equal(f.$('#next-chat-input').value,original);
    await f.command('context');assert.equal(f.$('#next-chat-input').value,original);
  }
  assert.equal(f.calls.some(call=>call.method!=='GET'),false);
});

for(const missingThread of [false,true])test('legacy native Chat '+(missingThread?'without a native ID':'with an expired native ID')+' can compress saved history without losing messages or drafts',async t=>{
  const compact=deferred(),f=await chatFixture(t,{compress:()=>compact.promise}),run=f.families.get('a').runs[0];
  run.workflow.settings={codexHistory:'relay'};run.nodes.agent.codexHistory='relay';
  if(missingThread)delete run.nodes.agent.threadId;else run.nodes.agent.threadId='expired-native-thread';
  const original={input:run.input,output:run.nodes.agent.output};
  await f.open('a');assert.equal(f.$('#next-chat-context-compress'),null);
  assert.doesNotMatch(f.$('#next-chat-context-feedback').textContent,/private|BLACKICE only|also show in Codex/i);
  await f.input('#next-chat-input','Unsent follow-up stays here');
  f.$('#next-chat-context-preset').value='custom';await f.$('#next-chat-context-preset').dispatch('change');await f.input('#next-chat-context-window','400000');
  await f.command('compress');await f.command('compress');
  const request=f.calls.find(call=>call.route.endsWith('/compact'));assert.deepEqual(request.body,{nodeId:'agent'});
  assert.equal(f.calls.filter(call=>call.route.endsWith('/compact')).length,1);assert.equal(f.$('#next-chat-send').disabled,true);
  f.emit({type:'agent.event',runId:'a',nodeId:'agent',data:{type:'context',context:{effectiveWindowTokens:828400,nativeWindowBasis:'metadata-percent'}}});
  assert.match(f.$('#next-chat-context-feedback').textContent,/Compressing/,'Preparing restored context is not completion.');
  Object.assign(run.nodes.agent,{threadId:'persistent-a',codexHistory:'codex',lastCompaction:{compacted:true,method:'codex-native',migrated:true,at:'2026-10-30T23:00:00Z'}});
  compact.resolve({compacted:true,method:'codex-native',migrated:true,threadId:'persistent-a',context:run.nodes.agent.contextStatus});
  await until(()=>/Context compressed by Codex/.test(f.$('#next-chat-context-feedback').textContent));await tick();await tick();
  assert.deepEqual({input:run.input,output:run.nodes.agent.output},original);
  assert.equal(f.$('#next-chat-input').value,'Unsent follow-up stays here');assert.equal(f.$('#next-chat-context-window').value,'400000');
  await f.open('b');await f.open('a');
  assert.equal(f.$('#next-chat-input').value,'Unsent follow-up stays here');assert.equal(f.$('#next-chat-context-window').value,'400000');
  assert.equal(f.$('#next-chat-context-compress'),null);
  assert.equal(f.calls.filter(call=>call.method!=='GET').length,1,'Migration uses only the explicit compression request.');
});

test('cancelling legacy native restoration keeps its operation pending and preserves both conversation drafts',async t=>{
  const compact=deferred(),cancel=deferred(),f=await chatFixture(t,{compress:()=>compact.promise,cancel:()=>cancel.promise}),run=f.families.get('a').runs[0];
  run.nodes.agent.codexHistory='relay';delete run.nodes.agent.threadId;const original={input:run.input,output:run.nodes.agent.output};
  await f.open('a');await f.input('#next-chat-input','A draft');
  await f.command('compress');await f.click('#next-chat-context-stop');await f.click('#next-chat-context-stop');
  assert.equal(f.calls.filter(call=>call.route.endsWith('/cancel')).length,1);assert.equal(f.calls.find(call=>call.route.endsWith('/cancel')).route,'/api/runs/a/cancel');
  await f.open('b');await f.input('#next-chat-context-window','123000');cancel.resolve({id:'a',status:'completed'});await tick();
  assert.equal(f.$('#next-chat-context-window').value,'123000');assert.doesNotMatch(f.$('#next-chat-context-feedback').textContent,/Stop|cancel/);
  await f.open('a');assert.equal(f.$('#next-chat-send').disabled,true);assert.match(f.$('#next-chat-context-feedback').textContent,/Waiting for compression to settle/);
  compact.reject(Object.assign(Error('Compression cancelled.'),{code:'ABORT_ERR'}));await until(()=>/Compression cancelled/.test(f.$('#next-chat-context-feedback').textContent));
  assert.equal(f.$('#next-chat-send').disabled,false);assert.equal(f.$('#next-chat-input').value,'A draft');assert.equal(f.$('#next-chat-context-compress'),null);
  assert.deepEqual({input:run.input,output:run.nodes.agent.output},original);
  await f.open('b');assert.equal(f.$('#next-chat-context-window').value,'123000');assert.equal(f.calls.filter(call=>call.method!=='GET').length,2);
});

for(const fails of [false,true])test('pending compression '+(fails?'error':'completion')+' stays with conversation A after switching to B',async t=>{
  const gate=deferred(),f=await chatFixture(t,{compress:()=>gate.promise});await f.open('a');
  assert.equal(f.$('#next-chat-context-preset').value,'extended');
  f.$('#next-chat-context-preset').value='custom';await f.$('#next-chat-context-preset').dispatch('change');await f.input('#next-chat-context-window','400000');
  await f.command('compress');await f.command('compress');
  assert.equal(f.calls.filter(call=>call.route.endsWith('/compact')).length,1);assert.equal(f.$('#next-chat-send').disabled,true);
  assert.deepEqual(f.calls.find(call=>call.route.endsWith('/compact')).body,{nodeId:'agent'},'Compression uses saved settings, not the next-turn draft.');
  f.emit({type:'agent.event',runId:'a',nodeId:'agent',data:{type:'context',context:{effectiveWindowTokens:828400,nativeWindowBasis:'runtime-usage'}}});
  assert.match(f.$('#next-chat-context-feedback').textContent,/Compressing/,'Context events do not mean completion.');
  await f.open('b');assert.equal(f.$('#next-chat-context-preset').value,'custom');assert.equal(f.$('#next-chat-context-window').value,'96000');
  await f.input('#next-chat-context-window','123000');f.workspace.updateStatus({...f.status,execution:{activeCount:4}});
  if(fails)gate.reject(Error('A compression failed.'));else gate.resolve({compacted:true,method:'codex-native',context:{effectiveWindowTokens:828400,nativeObservedWindowTokens:828400,nativeWindowBasis:'runtime-usage'}});
  await tick();await tick();
  assert.equal(f.workspace.getState().selected,'b');assert.equal(f.$('#next-chat-context-window').value,'123000');
  assert.doesNotMatch(f.$('#next-chat-context-feedback').textContent,/failed|compressed/);assert.equal(f.$('#next-chat-send').disabled,false);
  await f.open('a');assert.match(f.$('#next-chat-context-feedback').textContent,fails?/A compression failed/:/Context compressed by Codex/);
  assert.equal(f.$('#next-chat-context-preset').value,'custom');assert.equal(f.$('#next-chat-context-window').value,'400000');
  assert.equal(f.calls.filter(call=>call.method!=='GET').length,1,'Navigation, events and metadata do not persist settings.');
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
