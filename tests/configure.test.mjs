import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { configureSummary,configureSteps,updateConfigureStep,renderConfigureView,initConfigureUI,executionSettingsFromDraft,historySettingsFromDraft } from '../public/configure-ui.mjs';

const workflow=()=>({id:'workflow-a',name:'Saved delivery workflow',nodes:[{id:'input',type:'input',name:'Task'},{id:'build',type:'agent',name:'Build',prompt:'BUILD_ONLY_INSTRUCTIONS',model:'cloud::fast',effort:'high',context:{preset:'900k'},x:340,y:60},{id:'review',type:'agent',name:'Review',prompt:'REVIEW_ONLY_INSTRUCTIONS',model:'default',desktop:false,x:640,y:60},{id:'output',type:'output',name:'Result'}],edges:[{id:'first',source:'input',target:'build'},{id:'second',source:'build',target:'review'},{id:'last',source:'review',target:'output'}],settings:{cwd:'C:\\work',maxParallel:3,context:{preset:'custom',windowTokens:200000}},metadata:{preserve:'user configuration'}});
const snapshot=()=>({status:{connected:true,authenticated:true,defaultModel:'cloud::fast',codex:{connected:false,authenticated:false},models:[{id:'cloud::fast',model:'cloud::fast',providerId:'cloud',displayName:'Fast cloud model',available:true}],cwd:'C:\\work',learning:{mode:'auto'},identity:{healthy:true},browser:{available:true}},workflow:workflow(),workflows:[workflow()],desktop:{enabled:true}});
const count=(html,part)=>html.split(part).length-1;

test('basics derive actual selected-model readiness and show only the small default working set',()=>{
  const current=snapshot(),summary=configureSummary(current);assert.equal(summary.ready,true);assert.match(summary.model.label,/Fast cloud model/);assert.equal(summary.workspace,'C:\\work');assert.equal(summary.desktop,'Connected');
  const html=renderConfigureView(current);assert.match(html,/Tell BLACKICE what you want to change/);assert.match(html,/Describe changes in chat/);assert.match(html,/Ready to chat/);for(const label of ['Default model','Working folder','Your agent'])assert.match(html,new RegExp(label));assert.equal(count(html,'class="configure-basic-row"'),3);assert.equal(count(html,'<textarea'),0);assert.equal(count(html,'<svg'),0);assert.equal(count(html,'<details'),10);assert.match(html,/class="response-context-advanced"/);assert.ok(!/<details[^>]*\sopen[\s>]/.test(html));assert.ok(!html.includes('BUILD_ONLY_INSTRUCTIONS'));assert.ok(!html.includes('REVIEW_ONLY_INSTRUCTIONS'));assert.ok(!html.includes('Deploy this workflow'));
  current.status.models[0].available=false;assert.equal(configureSummary(current).ready,false);assert.match(renderConfigureView(current),/Connect a model to begin/);assert.match(renderConfigureView(current),/>Connect a model<\/button>/);
  current.status.models[0].available=true;current.model='missing-chat-model';assert.equal(configureSummary(current).ready,true,'Basics shows the app default, independently of the current chat choice');
  current.status.defaultModelAvailable=false;assert.equal(configureSummary(current).ready,false,'explicit unavailable default remains unavailable');
});

test('workflow steps follow graph dependencies while preserving independent branch identity',()=>{
  const graph=workflow();graph.nodes=[graph.nodes[0],graph.nodes[2],graph.nodes[1],graph.nodes[3]];assert.deepEqual(configureSteps(graph).map(item=>item.id),['build','review']);assert.deepEqual(configureSteps(graph)[1].receivesFrom,['Build']);
  graph.edges=graph.edges.filter(edge=>edge.id!=='second');graph.edges.push({source:'input',target:'review'});const steps=configureSteps(graph);assert.deepEqual(new Set(steps.map(item=>item.id)),new Set(['build','review']));assert.ok(steps.every(item=>item.receivesFrom[0]==='Task'));assert.equal(graph.edges.some(edge=>edge.source==='build'&&edge.target==='review'),false,'presentation never invents an edge between parallel agents');
});

test('optional workflow view presents one selected step and opens its manual editor only on request',()=>{
  const current=snapshot(),summary=renderConfigureView(current,{view:'workflows',stepId:'review'});assert.match(summary,/Agent step 2 of 2/);assert.match(summary,/data-configure-step-id="review"/);assert.match(summary,/REVIEW_ONLY_INSTRUCTIONS/);assert.ok(!summary.includes('BUILD_ONLY_INSTRUCTIONS'));assert.equal(count(summary,'<textarea'),0);assert.match(summary,/>Open canvas<\/button>/);assert.match(summary,/>Edit this step<\/button>/);assert.match(summary,/Manual editing is optional/);assert.ok(!/<details[^>]*\sopen[\s>]/.test(summary));
  const edited=renderConfigureView(current,{view:'workflows',stepId:'review',editing:true,draft:current.workflow.nodes[2]});assert.equal(count(edited,'<textarea'),1);assert.match(edited,/REVIEW_ONLY_INSTRUCTIONS/);assert.ok(!edited.includes('BUILD_ONLY_INSTRUCTIONS'));assert.match(edited,/data-configure-draft="model"/);assert.match(edited,/>Save step<\/button>/);assert.equal(count(edited,'<form'),1);
});

test('workflow step settings retain a saved native routing slug and explain hidden visibility without a disconnected duplicate',()=>{
  const current=snapshot();current.workflow.nodes[1].model='actual-slug';current.status.codex={connected:true,authenticated:true};current.status.models.push({id:'picker-alias',model:'actual-slug',displayName:'Friendly model',available:true,hidden:true});
  const before=structuredClone(current.workflow),summary=renderConfigureView(current,{view:'workflows',stepId:'build'}),edited=renderConfigureView(current,{view:'workflows',stepId:'build',editing:true,draft:current.workflow.nodes[1]});
  assert.match(summary,/Friendly model · Hidden by Codex/);assert.match(edited,/<option value="actual-slug" selected>Codex · Friendly model · Hidden by Codex<\/option>/);assert.equal(count(edited,'value="actual-slug"'),1);assert.doesNotMatch(edited,/value="picker-alias"/);assert.doesNotMatch(edited,/actual-slug · not connected/);assert.deepEqual(current.workflow,before);
});

test('step edits preserve graph structure, other agents, context budgets, positions and unknown saved fields',()=>{
  const original=workflow(),before=structuredClone(original),changed=updateConfigureStep(original,'build',{name:'Implement',prompt:'Verify the actual requested result.',model:'default',desktop:true});assert.deepEqual(original,before);assert.deepEqual(changed.edges,before.edges);assert.deepEqual(changed.nodes[2],before.nodes[2]);assert.deepEqual(changed.nodes[1].context,{preset:'900k'});assert.equal(changed.nodes[1].effort,'high');assert.equal(changed.nodes[1].x,340);assert.deepEqual(changed.metadata,before.metadata);assert.deepEqual(changed.settings.context,before.settings.context);assert.equal(changed.settings.maxParallel,3,'enabling desktop tools preserves the user workflow concurrency');assert.equal(changed.nodes[1].name,'Implement');assert.equal(changed.nodes[1].desktop,true);
  assert.throws(()=>updateConfigureStep(original,'missing',{prompt:'Text'}),/no longer/);assert.throws(()=>updateConfigureStep(original,'build',{prompt:'   '}),/Instructions/);assert.throws(()=>updateConfigureStep(original,'build',{desktop:'true'}),/on or off/);
});

test('saved names, instructions, errors and paths remain inert HTML in every configuration surface',()=>{
  const current=snapshot();current.workflow.name='<img src=x onerror=run()>';current.workflow.nodes[1].name='<script>execute()</script>';current.workflow.nodes[1].prompt='</textarea><script>promptInjection()</script>';current.status.cwd='<svg onload=run()>';current.workspace='<svg onload=run()>';
  const html=renderConfigureView(current,{view:'workflows',stepId:'build',editing:true,draft:current.workflow.nodes[1],error:'<img src=x onerror=error()>'});assert.ok(!html.includes('<script>'));assert.ok(!html.includes('<img'));assert.match(html,/&lt;\/textarea&gt;/);assert.match(html,/&lt;script&gt;promptInjection/);assert.match(html,/&lt;img src=x onerror=error/);
  const basics=renderConfigureView(current);assert.ok(!basics.includes('<svg'));assert.match(basics,/&lt;svg onload=run\(\)&gt;/);
});

class Mount{
  constructor(){this.markup='';this.htmlWrites=0;Object.defineProperty(this,'innerHTML',{get:()=>this.markup,set:value=>{this.markup=value;this.htmlWrites++;}});this.handlers=new Map();this.focused=0;this.classes=new Set();this.classList={add:key=>this.classes.add(key),remove:key=>this.classes.delete(key)};}
  addEventListener(type,handler){this.handlers.set(type,handler);}removeEventListener(type){this.handlers.delete(type);}contains(target){return target?.attached!==false;}querySelector(){return{focus:()=>{this.focused++;}};}
  async event(type,target){return this.handlers.get(type)?.({target,preventDefault(){}});}async click(action){const target={dataset:{configure:action},closest(){return this;}};return this.event('click',target);}async field(field,value,type='input'){return this.event(type,{dataset:{configureDraft:field},value,type:'text'});}async submit(){return this.event('submit',{id:'configure-step-editor'});}
}

test('manual edits keep drafts through app refresh and refuse to overwrite a workflow changed in chat',async()=>{
  const mount=new Mount();let current=snapshot(),saves=[];const ui=initConfigureUI({mount,getSnapshot:()=>current,onChat(){},onUpdateWorkflow:async(updated,metadata)=>{saves.push({updated,metadata});current={...current,workflow:updated};return updated;}});ui.showWorkflows({stepId:'build'});await mount.click('edit');await mount.field('prompt','User draft still unsaved');const draftHTML=mount.innerHTML;ui.update();assert.equal(mount.innerHTML,draftHTML,'status refresh cannot erase a focused draft');
  current={...current,workflow:structuredClone(current.workflow)};current.workflow.nodes[1].prompt='Agent updated this workflow in chat';await mount.submit();assert.equal(saves.length,0);assert.match(mount.innerHTML,/changed while you were editing/);assert.match(mount.innerHTML,/Reload current step/);assert.match(mount.innerHTML,/User draft still unsaved/);
  await mount.click('reload');assert.match(mount.innerHTML,/Agent updated this workflow in chat/);await mount.field('prompt','Reviewed and updated instructions.');await mount.submit();assert.equal(saves.length,1);assert.equal(saves[0].metadata.nodeId,'build');assert.equal(saves[0].metadata.reason,'manual-step-edit');assert.deepEqual(saves[0].updated.edges,workflow().edges);assert.equal(saves[0].updated.nodes[2].prompt,'REVIEW_ONLY_INSTRUCTIONS');assert.match(mount.innerHTML,/Step saved/);assert.equal(count(mount.innerHTML,'<textarea'),0);ui.destroy();assert.equal(mount.innerHTML,'');assert.equal(mount.handlers.size,0);
});

test('labeled actions invoke real app callbacks with the selected workflow and preserve an optional draft when returning to Basics',async()=>{
  const mount=new Mount(),current=snapshot(),calls=[];const ui=initConfigureUI({mount,getSnapshot:()=>current,onChat:context=>calls.push(['chat',context]),onConnections:()=>calls.push(['connections']),onWorkspace:folder=>calls.push(['workspace',folder]),onAgent:()=>calls.push(['agent']),onCanvas:id=>calls.push(['canvas',id]),onDeploy:graph=>calls.push(['deploy',graph.id]),onUpdateWorkflow:()=>{}});
  await mount.click('connections');await mount.click('workspace');await mount.click('agent');await mount.click('chat');assert.deepEqual(calls.slice(0,3),[['connections'],['workspace','C:\\work'],['agent']]);assert.deepEqual(calls[3][1],{},'basic setup returns to general chat without imposing a workflow');
  ui.showWorkflows({stepId:'review'});await mount.click('canvas');await mount.click('deploy');await mount.click('chat');assert.deepEqual(calls[4],['canvas','workflow-a']);assert.deepEqual(calls[5],['deploy','workflow-a']);assert.equal(calls[6][1].workflowId,'workflow-a');assert.equal(calls[6][1].stepId,'review');await mount.click('edit');await mount.field('prompt','Draft retained across Basics');ui.showBasics();assert.equal(count(mount.innerHTML,'class="configure-basic-row"'),3);ui.showWorkflows();assert.match(mount.innerHTML,/Draft retained across Basics/);ui.destroy();
});

test('configuration styling keeps gradient surfaces readable, labels visible and controls free of animation',async()=>{
  const css=(await readFile(new URL('../public/configure.css',import.meta.url),'utf8')).replace(/\/\*[\s\S]*?\*\//g,'');
  const backgrounds=[...css.matchAll(/(?<![\w-])background(?:-color|-image)?\s*:\s*([^;}]+)/g)].map(match=>match[1].replace(/\s*!important\s*$/,'').trim());
  assert.ok(backgrounds.length>5,'the actual configuration surfaces are checked');
  const gradients=backgrounds.filter(value=>/^(?:linear|radial|conic)-gradient\(/.test(value));
  assert.ok(gradients.length>0,'configuration retains an authored gradient reading surface');
  for(const value of backgrounds)assert.ok(/^(?:none|transparent)$/.test(value)||gradients.includes(value),`authored flat configuration surface: ${value}`);
  const rgba=hex=>{
    let value=hex.slice(1);if(value.length<5)value=[...value].map(char=>char+char).join('');
    if(value.length===6)value+='ff';
    return value.match(/../g).map(channel=>parseInt(channel,16)/255);
  };
  const stops=[];
  for(const gradient of gradients){
    const colors=[...gradient.matchAll(/#[\da-f]{8}\b|#[\da-f]{6}\b|#[\da-f]{4}\b|#[\da-f]{3}\b/gi)].map(match=>rgba(match[0]));
    assert.ok(new Set(colors.map(color=>color.join(','))).size>=2,`a gradient must have distinct color stops: ${gradient}`);
    stops.push(...colors);
  }
  const rules=[...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(match=>({selectors:match[1].trim().split(','),body:match[2]}));
  const labels=rules.filter(rule=>rule.selectors.some(selector=>/\.configure-label\b|\blabel\b/.test(selector)&&!selector.includes('[hidden]')));
  assert.ok(labels.length>0);
  for(const rule of labels)assert.doesNotMatch(rule.body,/(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse)|opacity\s*:\s*0(?:\.0+)?(?![\d.])|font-size\s*:\s*0(?:\.0+)?(?![\d.]))/,`visible labels must remain readable: ${rule.selectors.join(',')}`);
  const luminance=rgb=>rgb.slice(0,3).reduce((sum,value,index)=>sum+[.2126,.7152,.0722][index]*(value<=.04045?value/12.92:((value+.055)/1.055)**2.4),0);
  for(const selector of ['.configure-workspace','.configure-label']){
    const colors=rules.filter(rule=>rule.selectors.includes(selector)).flatMap(rule=>[...rule.body.matchAll(/(?<![\w-])color\s*:\s*(#[\da-f]+)\b/gi)].map(match=>match[1]));
    assert.ok(colors.length>0,`${selector} has an explicit readable foreground`);
    const ink=luminance(rgba(colors.at(-1)));
    // White is the lightest possible backing beneath these translucent stops;
    // this checks the source palette without claiming a full browser audit.
    for(const color of stops){
      const surface=luminance(color.slice(0,3).map(channel=>channel*color[3]+1-color[3]));
      assert.ok(ink>surface&&(ink+.05)/(surface+.05)>=4.5,`${selector} keeps text contrast across the gradient`);
    }
  }
  assert.ok(!/animation|transition\s*:/.test(css));assert.match(css,/font-size:14px/);assert.match(css,/:focus-visible/);assert.match(css,/@media\(max-width:500px\)/);
});

test('schedules and swarms are discoverable from Basics and dispatch independently of the selected workflow',async()=>{
  const current=snapshot(),html=renderConfigureView(current);for(const label of ['Schedule a task','Create a swarm','Manage schedules'])assert.match(html,new RegExp(label));assert.ok(html.indexOf('Working folder')<html.indexOf('Schedule a task'));assert.ok(html.indexOf('Concurrent work')<html.indexOf('Schedule a task'));assert.match(html,/<section class="configure-automation"/,'automation remains a visible section below everyday preferences');
  const mount=new Mount(),calls=[],ui=initConfigureUI({mount,getSnapshot:()=>current,onSchedule:(...args)=>calls.push(['schedule',args]),onSwarm:(...args)=>calls.push(['swarm',args]),onOperations:(...args)=>calls.push(['operations',args])});await mount.click('schedule');await mount.click('swarm');await mount.click('operations');assert.deepEqual(calls,[['schedule',[]],['swarm',[]],['operations',[]]]);assert.equal(current.workflow.id,'workflow-a');ui.destroy();
  const disconnected=renderConfigureView(current,{},{});assert.doesNotMatch(disconnected,/Schedule a task|Create a swarm|Manage schedules/);
});

const executionEvent=(mount,field,value,type='input')=>mount.event(type,{dataset:{configureExecution:field},value});
const executionToggle=(mount,open=true)=>mount.event('toggle',{dataset:{configureSection:'execution'},open});
const executionSubmit=mount=>mount.event('submit',{id:'configure-execution-editor'});

test('concurrency accepts no app limit or a positive user-selected number without a product ceiling',()=>{
  assert.deepEqual(executionSettingsFromDraft('unlimited',''),{maxConcurrentRuns:null});
  for(const limit of [1,4,33,128,100000])assert.deepEqual(executionSettingsFromDraft('limit',String(limit)),{maxConcurrentRuns:limit});
  for(const limit of ['',0,-1,1.2,'1e3','NaN','9007199254740992'])assert.throws(()=>executionSettingsFromDraft('limit',limit),/positive whole number/);
  const html=renderConfigureView(snapshot());assert.match(html,/Concurrent work/);assert.match(html,/No app limit/);assert.doesNotMatch(html,/data-configure-execution="limit"[^>]*\smax=/);assert.match(html,/Active work keeps running/);
});

test('concurrency loads only on demand, saves real settings and keeps unsaved input across status refreshes',async()=>{
  const mount=new Mount(),current=snapshot(),calls=[],saved=[];current.status.execution={capacity:null,unlimited:true,activeCount:40};
  const ui=initConfigureUI({mount,getSnapshot:()=>current,api:async(url,method,body)=>{calls.push({url,method,body});return method?body:{maxConcurrentRuns:null};},onExecutionSettings:value=>saved.push(value)});
  assert.equal(calls.length,0,'ordinary setup must not request optional settings');assert.match(mount.innerHTML,/No app limit/);
  await executionToggle(mount);assert.deepEqual(calls,[{url:'/api/execution/settings',method:undefined,body:undefined}]);
  await executionEvent(mount,'mode','limit','change');await executionEvent(mount,'limit','128');const before=mount.innerHTML;ui.update();assert.equal(mount.innerHTML,before,'background status cannot replace a focused settings draft');
  await executionSubmit(mount);assert.deepEqual(calls.at(-1),{url:'/api/execution/settings',method:'POST',body:{maxConcurrentRuns:128}});assert.deepEqual(saved,[{maxConcurrentRuns:128}]);assert.match(mount.innerHTML,/128 at once/);assert.match(mount.innerHTML,/Saved\. Active work keeps running/);
  await executionEvent(mount,'mode','unlimited','change');await executionSubmit(mount);assert.deepEqual(calls.at(-1).body,{maxConcurrentRuns:null});assert.match(mount.innerHTML,/No app limit/);ui.destroy();
});

test('a rejected concurrency save preserves the draft and never reports success or stops other work',async()=>{
  const mount=new Mount(),calls=[],saved=[];let attempt=0;
  const ui=initConfigureUI({mount,getSnapshot:snapshot,api:async(url,method,body)=>{calls.push({url,method,body});if(!method)return{maxConcurrentRuns:128};if(++attempt===1)throw new Error('Cannot save right now.');return body;},onExecutionSettings:value=>saved.push(value)});
  await executionToggle(mount);await executionEvent(mount,'limit','256');await executionSubmit(mount);assert.match(mount.innerHTML,/Cannot save right now/);assert.match(mount.innerHTML,/value="256"/);assert.equal(saved.length,0);
  await executionSubmit(mount);assert.deepEqual(saved,[{maxConcurrentRuns:256}]);assert.equal(calls.filter(call=>call.method).length,2);assert.ok(calls.every(call=>call.url==='/api/execution/settings'));ui.destroy();
});

test('loading and saving concurrency are exclusive, and a delayed response cannot resurrect a destroyed view',async()=>{
  const mount=new Mount(),calls=[],saved=[];let releaseRead,releaseSave;
  const ui=initConfigureUI({mount,getSnapshot:snapshot,api:(url,method,body)=>{calls.push({url,method,body});return new Promise(resolve=>{if(method)releaseSave=resolve;else releaseRead=resolve;});},onExecutionSettings:value=>saved.push(value)});
  const loading=executionToggle(mount);await executionToggle(mount);await executionSubmit(mount);assert.equal(calls.length,1);releaseRead({maxConcurrentRuns:null});await loading;
  await executionEvent(mount,'mode','limit','change');await executionEvent(mount,'limit','65');const saving=executionSubmit(mount);await executionSubmit(mount);await executionEvent(mount,'limit','99');assert.equal(calls.length,2);assert.deepEqual(calls[1].body,{maxConcurrentRuns:65});
  ui.destroy();releaseSave({maxConcurrentRuns:65});await saving;assert.equal(mount.innerHTML,'');assert.deepEqual(saved,[]);
});

test('settings errors stay inside Concurrent work and do not overwrite a workflow editor in another view',async()=>{
  const mount=new Mount();let rejectRead;
  const ui=initConfigureUI({mount,getSnapshot:snapshot,api:()=>new Promise((resolve,reject)=>{rejectRead=reject;})});
  const loading=executionToggle(mount);ui.showWorkflows({stepId:'build'});await mount.click('edit');await mount.field('prompt','Keep this workflow draft');const before=mount.innerHTML;rejectRead(new Error('Execution settings are unavailable.'));await loading;
  assert.equal(mount.innerHTML,before,'a response for the hidden settings panel cannot rerender the focused workflow editor');assert.doesNotMatch(mount.innerHTML,/Execution settings are unavailable/);ui.showBasics();assert.match(mount.innerHTML,/Execution settings are unavailable/);ui.showWorkflows();assert.match(mount.innerHTML,/Keep this workflow draft/);ui.destroy();
});

test('unrelated live status updates keep existing Configure controls attached',async()=>{
  const mount=new Mount(),current=snapshot(),ui=initConfigureUI({mount,getSnapshot:()=>current,api:async()=>({maxConcurrentRuns:null})});
  const initial=mount.htmlWrites;for(let index=0;index<100;index++){current.status.execution={capacity:null,unlimited:true,activeCount:index};current.status.lastEvent=`run-${index}`;ui.update();}assert.equal(mount.htmlWrites,initial,'identical configuration output must retain the actual DOM nodes');
  await executionToggle(mount);const loaded=mount.htmlWrites;for(let index=0;index<100;index++){current.status.execution.activeCount=index;ui.update();}assert.equal(mount.htmlWrites,loaded,'opening optional settings must remain stable while other chats stream');ui.destroy();
});

test('detached details toggle events cannot close a replacement disclosure or create repeated settings reads',async()=>{
  const mount=new Mount(),calls=[],ui=initConfigureUI({mount,getSnapshot:snapshot,api:async url=>{calls.push(url);return{maxConcurrentRuns:null};}});
  await executionToggle(mount);assert.equal(calls.length,1);const loaded=mount.htmlWrites;
  for(let index=0;index<20;index++){
    await mount.event('toggle',{dataset:{configureSection:'execution'},open:false,attached:false});
    await executionToggle(mount,true);ui.update();
  }
  assert.equal(calls.length,1,'queued toggle events from replaced nodes cannot restart GET/render cycles');assert.equal(mount.htmlWrites,loaded);assert.match(mount.innerHTML,/data-configure-section="execution" open/);
  await executionToggle(mount,false);await executionToggle(mount,true);assert.equal(calls.length,2,'a real close and reopen still refreshes settings on demand');ui.destroy();
});

test('an unchanged execution editor keeps keyboard focus during background model and status changes',async t=>{
  const previous={present:Object.hasOwn(globalThis,'document'),value:globalThis.document};t.after(()=>{if(previous.present)globalThis.document=previous.value;else delete globalThis.document;});
  const mount=new Mount(),current=snapshot(),ui=initConfigureUI({mount,getSnapshot:()=>current,api:async()=>({maxConcurrentRuns:8})});await executionToggle(mount);
  const active={attached:true,closest:selector=>selector.includes('#configure-execution-editor')?{}:null};globalThis.document={activeElement:active};const before=mount.htmlWrites;
  current.status.models[0].displayName='A renamed default model';ui.update();assert.equal(mount.htmlWrites,before,'focusing a field protects it even before the first input event');assert.strictEqual(globalThis.document.activeElement,active);
  globalThis.document.activeElement=null;ui.update();assert.equal(mount.htmlWrites,before+1);assert.match(mount.innerHTML,/A renamed default model/);ui.update();assert.equal(mount.htmlWrites,before+1);ui.destroy();
});

const historyToggle=(mount,open=true)=>mount.event('toggle',{dataset:{configureSection:'history'},open});
const historyChoice=(mount,value)=>mount.event('change',{dataset:{configureHistory:'codexHistory'},value});
const historySubmit=mount=>mount.event('submit',{id:'configure-history-editor'});

test('history visibility is optional and explains provider independence, existing entries and native continuity',()=>{
  assert.deepEqual(historySettingsFromDraft('relay'),{codexHistory:'relay'});assert.deepEqual(historySettingsFromDraft('codex'),{codexHistory:'codex'});
  for(const value of ['',null,'private','public',true])assert.throws(()=>historySettingsFromDraft(value),/where new Codex conversations appear/);
  const current=snapshot(),html=renderConfigureView(current);assert.match(html,/Conversation history<span>BLACKICE only/);assert.match(html,/option value="relay" selected>Keep in BLACKICE only/);assert.match(html,/Also show in Codex/);assert.match(html,/BLACKICE saves chats locally with every provider/);assert.match(html,/existing Codex entries stay as they are/);assert.match(html,/follow-ups start from saved BLACKICE messages/);assert.match(html,/provider still processes each request/);const historyMarkup=html.match(/data-configure-section="history"[^>]*>[\s\S]*?<\/form><\/details>/)?.[0];assert.ok(historyMarkup);assert.doesNotMatch(historyMarkup,/private|anonymous|delete.*Codex/i);assert.ok(!/<details[^>]*\sopen[\s>]/.test(html));
  current.status.runtimeSettings={codexHistory:'codex'};assert.match(renderConfigureView(current),/Conversation history<span>BLACKICE \+ Codex/);assert.match(renderConfigureView(current),/option value="codex" selected/);
});

test('history preferences load on demand and save independently of model selection and concurrency',async()=>{
  const mount=new Mount(),current=snapshot(),calls=[],saved=[];
  const ui=initConfigureUI({mount,getSnapshot:()=>current,api:async(url,method,body)=>{calls.push({url,method,body});return method?body:{codexHistory:'relay'};},onRuntimeSettings:value=>saved.push(value)});
  assert.equal(calls.length,0);await historyToggle(mount);assert.deepEqual(calls,[{url:'/api/runtime/settings',method:undefined,body:undefined}]);
  await historyChoice(mount,'codex');const before=mount.htmlWrites;current.status.models[0].displayName='Streaming provider update';ui.update();assert.equal(mount.htmlWrites,before,'an unsaved choice survives unrelated model status');
  await historySubmit(mount);assert.deepEqual(calls.at(-1),{url:'/api/runtime/settings',method:'POST',body:{codexHistory:'codex'}});assert.deepEqual(saved,[{codexHistory:'codex'}]);assert.match(mount.innerHTML,/Saved for new Codex conversations/);assert.match(mount.innerHTML,/Conversation history<span>BLACKICE \+ Codex/);assert.equal(current.status.defaultModel,'cloud::fast');assert.ok(calls.every(call=>call.url==='/api/runtime/settings'));
  await historyChoice(mount,'relay');await historySubmit(mount);assert.deepEqual(calls.at(-1).body,{codexHistory:'relay'});ui.destroy();
});

test('a failed history save preserves the user choice and reports no success',async()=>{
  const mount=new Mount(),saved=[];let attempts=0;
  const ui=initConfigureUI({mount,getSnapshot:snapshot,api:async(url,method,body)=>{if(!method)return{codexHistory:'codex'};if(++attempts===1)throw new Error('Preferences are unavailable.');return body;},onRuntimeSettings:value=>saved.push(value)});
  await historyToggle(mount);await historyChoice(mount,'relay');await historySubmit(mount);assert.match(mount.innerHTML,/Preferences are unavailable/);assert.match(mount.innerHTML,/option value="relay" selected/);assert.doesNotMatch(mount.innerHTML,/Saved for new Codex/);assert.equal(saved.length,0);
  await historySubmit(mount);assert.deepEqual(saved,[{codexHistory:'relay'}]);ui.destroy();
});

test('history operations are exclusive, reject invalid server settings and cannot revive a destroyed view',async()=>{
  const mount=new Mount(),calls=[],saved=[];let resolveRead,resolveSave;
  const ui=initConfigureUI({mount,getSnapshot:snapshot,api:(url,method,body)=>{calls.push({url,method,body});return new Promise(resolve=>{if(method)resolveSave=resolve;else resolveRead=resolve;});},onRuntimeSettings:value=>saved.push(value)});
  const loading=historyToggle(mount);await historyToggle(mount);await historyChoice(mount,'codex');await historySubmit(mount);assert.equal(calls.length,1);resolveRead({codexHistory:'unknown'});await loading;assert.match(mount.innerHTML,/Choose where new Codex conversations appear/);assert.equal(saved.length,0);
  const reloading=mount.click('history-reload');resolveRead({codexHistory:'relay'});await reloading;await historyChoice(mount,'codex');const saving=historySubmit(mount);await historySubmit(mount);await historyChoice(mount,'relay');assert.equal(calls.length,3);assert.deepEqual(calls.at(-1).body,{codexHistory:'codex'});
  ui.destroy();resolveSave({codexHistory:'codex'});await saving;assert.equal(mount.innerHTML,'');assert.deepEqual(saved,[]);
});

test('a hidden history response preserves a workflow editor and detached toggles cannot reload settings',async()=>{
  const mount=new Mount(),calls=[];let rejectRead;
  const ui=initConfigureUI({mount,getSnapshot:snapshot,api:url=>{calls.push(url);return new Promise((resolve,reject)=>{rejectRead=reject;});}});
  const loading=historyToggle(mount);ui.showWorkflows({stepId:'build'});await mount.click('edit');await mount.field('prompt','Keep this workflow draft');const before=mount.htmlWrites;rejectRead(new Error('History preferences could not load.'));await loading;assert.equal(mount.htmlWrites,before);assert.doesNotMatch(mount.innerHTML,/History preferences could not load/);ui.showBasics();assert.match(mount.innerHTML,/History preferences could not load/);
  await mount.event('toggle',{dataset:{configureSection:'history'},open:false,attached:false});await historyToggle(mount);assert.equal(calls.length,1);ui.showWorkflows();assert.match(mount.innerHTML,/Keep this workflow draft/);ui.destroy();
});

test('history fields retain keyboard focus before input during live model and status updates',async t=>{
  const previous={present:Object.hasOwn(globalThis,'document'),value:globalThis.document};t.after(()=>{if(previous.present)globalThis.document=previous.value;else delete globalThis.document;});
  const mount=new Mount(),current=snapshot(),ui=initConfigureUI({mount,getSnapshot:()=>current,api:async()=>({codexHistory:'relay'})});await historyToggle(mount);
  const active={attached:true,closest:selector=>selector.includes('#configure-history-editor')?{}:null};globalThis.document={activeElement:active};const before=mount.htmlWrites;current.status.models[0].displayName='Another model';current.status.execution={activeCount:900};ui.update();assert.equal(mount.htmlWrites,before);assert.strictEqual(globalThis.document.activeElement,active);
  globalThis.document.activeElement=null;ui.update();assert.equal(mount.htmlWrites,before+1);ui.destroy();
});

const recoveryToggle=(mount,open=true)=>mount.event('toggle',{dataset:{configureSection:'recovery'},open});
const recoveryButton=(markup,action)=>markup.match(new RegExp(`<button\\b[^>]*data-configure="${action}"[^>]*>`))?.[0];

test('Recovery & support stays optional and native actions appear only when real callbacks exist',async()=>{
  const mount=new Mount(),calls=[],apiCalls=[];
  const ui=initConfigureUI({mount,getSnapshot:snapshot,api:async(...args)=>apiCalls.push(args),onSupport:async(...args)=>{calls.push(args);return{downloaded:true};}});
  assert.match(mount.innerHTML,/Recovery & support/);assert.doesNotMatch(mount.innerHTML,/data-configure-section="recovery" open/);
  assert.ok(recoveryButton(mount.innerHTML,'support'));assert.equal(recoveryButton(mount.innerHTML,'backup'),undefined);assert.equal(recoveryButton(mount.innerHTML,'restore'),undefined);assert.doesNotMatch(mount.innerHTML,/Backup contents/);
  await recoveryToggle(mount);ui.update();assert.match(mount.innerHTML,/data-configure-section="recovery" open/);assert.equal(apiCalls.length,0,'opening disclosure must not start maintenance or contact providers');
  await mount.click('backup');await mount.click('restore');assert.equal(calls.length,0,'absent native callbacks cannot be invoked through synthetic stale controls');
  await mount.click('support');assert.deepEqual(calls,[[]]);assert.match(mount.innerHTML,/Support file exported\./);ui.destroy();
  const noActions=new Mount(),plain=initConfigureUI({mount:noActions,getSnapshot:snapshot});assert.doesNotMatch(noActions.innerHTML,/Recovery & support/);plain.destroy();
});

test('native recovery callbacks dispatch the selected action once with no caller-supplied arguments',async()=>{
  const mount=new Mount(),calls=[];
  const ui=initConfigureUI({mount,getSnapshot:snapshot,onBackup:async(...args)=>{calls.push(['backup',args]);return{scheduled:true};},onRestore:async(...args)=>{calls.push(['restore',args]);return{scheduled:true};},onSupport:async(...args)=>{calls.push(['support',args]);return{downloaded:true};}});
  assert.match(mount.innerHTML,/Backup contents/);assert.match(mount.innerHTML,/Other project folders stay separate/);assert.match(mount.innerHTML,/Encrypted keys and sign-ins may need re-entry/);
  await mount.click('backup');assert.match(mount.innerHTML,/BLACKICE is restarting to complete the profile change/);
  await mount.click('restore');assert.match(mount.innerHTML,/BLACKICE is restarting to complete the profile change/);
  await mount.click('support');assert.match(mount.innerHTML,/Support file exported/);assert.doesNotMatch(mount.innerHTML,/BLACKICE is restarting to complete the profile change/);
  assert.deepEqual(calls,[['backup',[]],['restore',[]],['support',[]]]);ui.destroy();
});

test('active work disables native maintenance controls while keeping support export available',async()=>{
  const current=snapshot();current.status.execution={activeCount:2};const mount=new Mount();let exports=0;
  const ui=initConfigureUI({mount,getSnapshot:()=>current,onBackup:async()=>({scheduled:true}),onRestore:async()=>({scheduled:true}),onSupport:async()=>{exports++;return{downloaded:true};}});
  assert.match(recoveryButton(mount.innerHTML,'backup'),/\sdisabled\b/);assert.match(recoveryButton(mount.innerHTML,'restore'),/\sdisabled\b/);assert.doesNotMatch(recoveryButton(mount.innerHTML,'support'),/\sdisabled\b/);
  assert.match(mount.innerHTML,/Finish or stop active work first/);await mount.click('support');assert.equal(exports,1);
  current.status.execution.activeCount=0;ui.update();assert.doesNotMatch(recoveryButton(mount.innerHTML,'backup'),/\sdisabled\b/);assert.doesNotMatch(recoveryButton(mount.innerHTML,'restore'),/\sdisabled\b/);ui.destroy();
});

test('impatient recovery clicks share one pending callback across backup, restore and support actions',async()=>{
  const mount=new Mount(),calls=[];let release;
  const ui=initConfigureUI({mount,getSnapshot:snapshot,onBackup:()=>{calls.push('backup');return new Promise(resolve=>{release=resolve;});},onRestore:async()=>{calls.push('restore');return{scheduled:true};},onSupport:async()=>{calls.push('support');return{downloaded:true};}});
  const pending=mount.click('backup');await mount.click('backup');await mount.click('restore');await mount.click('support');assert.deepEqual(calls,['backup']);
  for(const action of ['backup','restore','support'])assert.match(recoveryButton(mount.innerHTML,action),/\sdisabled\b/);assert.match(mount.innerHTML,/Working…/);
  release({scheduled:true});await pending;await mount.click('support');assert.deepEqual(calls,['backup','support']);assert.match(mount.innerHTML,/Support file exported/);ui.destroy();
});

test('cancelling a picker produces no success receipt and allows another requested action',async()=>{
  const mount=new Mount(),calls=[];
  const ui=initConfigureUI({mount,getSnapshot:snapshot,onBackup:async()=>{calls.push('backup');return{cancelled:true};},onRestore:async()=>{calls.push('restore');return{cancelled:true};},onSupport:async()=>{calls.push('support');return{cancelled:true};}});
  for(const action of ['backup','restore','support']){await mount.click(action);assert.doesNotMatch(mount.innerHTML,/Support file exported|BLACKICE is restarting to complete/);assert.doesNotMatch(recoveryButton(mount.innerHTML,action),/\sdisabled\b/);}
  assert.deepEqual(calls,['backup','restore','support']);ui.destroy();
});

test('recovery errors and receipts render as inert text and a failed callback remains retryable',async()=>{
  const mount=new Mount();let attempts=0;
  const ui=initConfigureUI({mount,getSnapshot:snapshot,onBackup:async()=>{if(++attempts===1)throw new Error('<img src=x onerror=privatePayload()>');return{scheduled:true};}});
  await mount.click('backup');assert.match(mount.innerHTML,/&lt;img src=x onerror=privatePayload\(\)&gt;/);assert.doesNotMatch(mount.innerHTML,/<img/);assert.doesNotMatch(mount.innerHTML,/BLACKICE is restarting/);
  await mount.click('backup');assert.equal(attempts,2);assert.match(mount.innerHTML,/BLACKICE is restarting/);assert.doesNotMatch(mount.innerHTML,/privatePayload/);ui.destroy();
  const rendered=renderConfigureView(snapshot(),{recoveryOpen:true,recoveryReceipt:'<svg onload=receiptPayload()>'});assert.match(rendered,/&lt;svg onload=receiptPayload\(\)&gt;/);assert.doesNotMatch(rendered,/<svg/);
});

for(const outcome of ['success','failure'])test(`a pending recovery ${outcome} cannot rewrite a destroyed Configure view`,async()=>{
  const mount=new Mount();let resolve,reject,calls=0;
  const ui=initConfigureUI({mount,getSnapshot:snapshot,onSupport:()=>{calls++;return new Promise((done,fail)=>{resolve=done;reject=fail;});}});
  const pending=mount.click('support');ui.destroy();const writes=mount.htmlWrites;
  if(outcome==='success')resolve({downloaded:true});else reject(new Error('Late support failure'));
  await pending;assert.equal(calls,1);assert.equal(mount.innerHTML,'');assert.equal(mount.htmlWrites,writes);assert.equal(mount.handlers.size,0);
});

test('Settings exposes background workflows and cannot dispatch a retired Bridge callback', async () => {
  const mount = new Mount(), calls = [];
  const ui = initConfigureUI({ mount, getSnapshot: snapshot,
    onConnections: () => calls.push('models'), onChatGPTBridge: () => calls.push('bridge'), onChat: () => calls.push('chat'),
    onBrowser: () => calls.push('browser'), onEmail: () => calls.push('email'), onTaskNotes: () => calls.push('notes'),
    onProjects: () => calls.push('projects'), onOperations: () => calls.push('operations') });
  const html = mount.innerHTML;
  assert.ok(html.indexOf('Default model') < html.indexOf('Prefer to describe a change'));
  assert.ok(html.indexOf('Working folder') < html.indexOf('Prefer to describe a change'));
  for (const label of ['Background browser', 'Email', 'Planning', 'Swarm projects', 'Schedules &amp; jobs']) assert.ok(html.includes(label), label);
  assert.ok(html.indexOf('Background workspace') < html.indexOf('Agent tools') || !html.includes('Agent tools'));
  assert.match(html, /Contained browser unavailable/); assert.match(html, /Setup required/);
  assert.doesNotMatch(html, /chatgptBridge|ChatGPT bridge|manual bridge|manual handoff/i);
  await mount.click('chatgptBridge'); assert.deepEqual(calls, [], 'stale controls cannot call the removed integration');
  for (const action of ['browser', 'email', 'taskNotes', 'projects', 'operations', 'connections']) await mount.click(action);
  assert.deepEqual(calls, ['browser', 'email', 'notes', 'projects', 'operations', 'models']); ui.destroy();
  const noCallbacks = renderConfigureView(snapshot(), {}, { connections: true, chatgptBridge: true });
  assert.doesNotMatch(noCallbacks, /data-configure="(?:chatgptBridge|email|taskNotes|projects)"/);
});

test('changing the concurrent-work mode restores the same labeled control after rendering', async t => {
  const previous = globalThis.document; t.after(() => { if (previous === undefined) delete globalThis.document; else globalThis.document = previous; });
  const mount = new Mount(), ui = initConfigureUI({ mount, getSnapshot: snapshot, api: async () => ({ maxConcurrentRuns: null }) });
  await executionToggle(mount);
  const replacement = { id: 'configure-execution-mode' }, queried = [];
  mount.querySelector = selector => { queried.push(selector); return { focus() { globalThis.document.activeElement = replacement; } }; };
  const old = { id: 'configure-execution-mode', dataset: { configureExecution: 'mode' }, value: 'limit', attached: true };
  globalThis.document = { activeElement: old }; await mount.event('change', old);
  assert.ok(queried.includes('#configure-execution-mode')); assert.equal(globalThis.document.activeElement, replacement);
  assert.match(mount.innerHTML, /id="configure-execution-limit"/); ui.destroy();
});
