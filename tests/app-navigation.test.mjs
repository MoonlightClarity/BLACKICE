import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import * as workspaceIntegrationModel from '../public/workspace-integrations.mjs';
import * as runStateModel from '../public/run-state-model.mjs';
import * as conversationSearchModel from '../public/conversation-search.mjs';

const held=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};};
const turn=()=>new Promise(resolve=>setImmediate(resolve));

// Run the real app navigation and modal handlers. Only unrelated page rendering,
// startup, network, and imported configuration surfaces use adapters.
async function fixture({pauseModule,apiResponse,desktop=true}={}){
  const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
  const primaryNav=/<nav role="tablist" aria-label="Workspace mode">([\s\S]*?)<\/nav>/.exec(source)?.[1];assert.ok(primaryNav,'the real primary navigation is present');
  const modes=[...primaryNav.matchAll(/<button\b[^>]*data-mode="([^"]+)"/g)].map(match=>match[1]);
  const clickRegistration=/    document.addEventListener\('click',async event=>\{[\s\S]*?\n    \}\);/.exec(source)?.[0];assert.ok(clickRegistration,'the real delegated action handler is present');
  const listeners=new Map();
  const timers=new Map();let clock=0,timerId=0;
  const toastRoot={children:[],append(node){node.parentNode=this;this.children.push(node);}};
  const frames=[],mount={innerHTML:''},menu={open:true},tabs=modes.map(mode=>({dataset:{mode},attributes:{},tabIndex:0,isConnected:true,setAttribute(name,value){this.attributes[name]=value;},focus(){document.activeElement=this;},closest(){return this;}})),actions={hidden:true};
  const effects=[],skip={},destinations=Object.fromEntries(['mission-task','observe-workspace','planning-workspace','configure-workspace','desktop-workspace'].map(id=>[id,{id}])),canvas={id:'canvas',scrollTop:0,scrollLeft:0,clientWidth:900,clientHeight:600,style:{},focus(options){document.activeElement=this;this.focusOptions=options;},getBoundingClientRect(){return{width:this.clientWidth,height:this.clientHeight};}},world={style:{}},zoom={};let focusables=[];
  mount.querySelectorAll=()=>focusables;mount.querySelector=selector=>selector==='.modal'?modal:null;
  let modal=null;const document={addEventListener(name,handler){listeners.set(name,handler);},activeElement:{tagName:'BODY',dataset:{},isConnected:true,closest(){return null;},focus(){document.activeElement=this;}},createElement(tag){return{tagName:tag.toUpperCase(),className:'',textContent:'',remove(){const parent=this.parentNode;if(parent){parent.children.splice(parent.children.indexOf(this),1);this.parentNode=null;}},focus(){document.activeElement=this;}};},querySelector(selector){if(selector==='#toast-root')return toastRoot;if(selector==='.skip-link')return skip;if(selector==='#canvas')return canvas;if(selector==='#world')return world;if(selector==='#zoom-level')return zoom;if(destinations[selector.slice(1)])return destinations[selector.slice(1)];if(selector==='#modal-root')return mount;if(selector==='#modal-root .modal')return modal;if(selector==='.workspace-menu')return menu;if(selector==='#configure-mode-actions')return actions;const mode=/\[data-mode="([^"]+)"\]/.exec(selector)?.[1];return mode?tabs.find(tab=>tab.dataset.mode===mode):null;},querySelectorAll(selector){return selector.includes('#workspace-modes')?tabs:[];}};
  document.body=document.activeElement;
  Object.defineProperty(mount,'innerHTML',{get(){return this.value||'';},set(value){
    if(modal){modal.isConnected=false;for(const control of modal.querySelectorAll())control.isConnected=false;}this.value=value;
    const controls=[...value.matchAll(/<(textarea|input|select|button)\b([^>]*)>/gi)].map(([,tag,attributes])=>({
      tagName:tag.toUpperCase(),isConnected:true,disabled:/\bdisabled\b/.test(attributes),hidden:/\bhidden\b/.test(attributes),isClose:/data-action="close-modal"/.test(attributes),
      closest(){return this.hidden?this:null;},getClientRects(){return this.hidden?[]:[{}];},focus(options){document.activeElement=this;this.focusOptions=options;}
    }));
    modal=value?{tagName:'SECTION',tabIndex:-1,isConnected:true,querySelector(){return null;},querySelectorAll(){return controls.filter(control=>!control.isClose);},focus(options){document.activeElement=this;this.focusOptions=options;}}:null;
  }});
  let planningCallbacks,inboxCallbacks,configureCallbacks,observeCallbacks;const observedEntries=[];
  const opened=[],cancelled=[],messages=[],draft={task:'Keep my unsent task',model:'chosen-model',cwd:'C:\\fixture'},settingsDraft={runFor:'36',unit:'hours'};
  const ui=(key)=>({async open(){opened.push(key);context.app.showModal(key,`<div>${key}</div>`);},cancel(){cancelled.push(key);}});
  const modules={
    '/conversation-search.mjs':conversationSearchModel,
    '/configure-ui.mjs':{initConfigureUI:callbacks=>{configureCallbacks=callbacks;return{update(){},showConnector(){effects.push('connector-settings');}};}},
    '/observe-ui.mjs':{initObserveUI:callbacks=>{observeCallbacks=callbacks;return{update(){},enter(options){observedEntries.push(options);}};}},
    '/observe-stream.mjs':{createObserveSubscription:()=>()=>{}},
    '/editor-model.mjs':{WorkflowHistory:class{},diagnoseWorkflow:()=>[],fitWorkflow(){effects.push('fit');return{x:80,y:45,scale:.75};},renderMarkdown:value=>value},
    '/mission-model.mjs':{},'/reasoning-model.mjs':{},'/run-state-model.mjs':runStateModel,'/context-ui.mjs':{},'/task-state-ui.mjs':{},'/svg-preview.mjs':{},'/artifact-ui.mjs':{},'/prompts-ui.mjs':{},'/task-title.mjs':{},'/repeat-task-model.mjs':{},'/workspace-integrations.mjs': workspaceIntegrationModel, '/api-client.mjs':{createApiClient:()=>apiResponse||(async()=>({}))},
    '/planning-workspace-ui.mjs':{initPlanningWorkspaceUI:callbacks=>{planningCallbacks=callbacks;return{async enter(seed){opened.push('planning');effects.push({planningSeed:seed});},leave(){},handleEvent(){}};}},
    '/email-ui.mjs':{initEmailUI:()=>ui('email')},'/learning-ui.mjs':{initLearningUI:()=>ui('learning')},'/identity-ui.mjs':{openIdentity:()=>ui('identity').open()},'/tool-connections-ui.mjs':{initToolConnectionsUI:()=>ui('tool-connections')},'/file-patches-ui.mjs':{initFilePatchesUI:()=>ui('file-patches')},'/knowledge-ui.mjs':{initKnowledgeUI:()=>ui('knowledge')},'/connections-ui.mjs':{openConnections:()=>ui('connections').open()},'/browser-ui.mjs':{openBrowserWorkspace:()=>ui('browser').open()},'/projects-ui.mjs':{initProjectsUI:()=>ui('projects')},'/inbox-ui.mjs':{initInboxUI:callbacks=>{inboxCallbacks=callbacks;return ui('inbox');}},'/advanced-ui.mjs':{initAdvancedUI:()=>({openOperations:()=>ui('operations').open(),openSchedule:()=>ui('schedule').open(),openSwarm:()=>ui('swarm').open(),deployWorkflow:()=>ui('deployment').open()})},
  };
  const pending=pauseModule?held():null;
  const context=vm.createContext({document,window:{relayDesktop:desktop?{}:undefined},structuredClone,crypto:webcrypto,requestAnimationFrame:fn=>frames.push(fn),clearTimeout(id){timers.delete(id);},setTimeout(callback,milliseconds){const id=++timerId;timers.set(id,{callback,at:clock+milliseconds});return id;},console,__effects:effects,__draft:draft,__settingsDraft:settingsDraft,__messages:messages,__load:async name=>{if(name===pauseModule)await pending.promise;return modules[name]||{};}});
  const adapted=source.replace(/import\('([^']+)'\)/g,(_,name)=>`__load(${JSON.stringify(name)})`).replace(/\n  init\(\);\s*\n\}\)\(\);\s*$/,()=>`
    const renderToast=toast;
    renderDesktop=()=>renderMode();renderHeader=()=>{};renderGraph=()=>{};renderInspector=()=>{};markDirty=()=>{state.dirty=true;};saveWorkflow=()=>__effects.push('save');showRun=()=>__effects.push('run');restoreHistory=direction=>__effects.push(direction);toast=(message,error)=>__messages.push({message,error});
    missionUI={getDraft:()=>__draft,getSelection:()=>null,capturePromptDraft:()=>({...__draft}),applyPromptDraft(capture,text){if(capture.task!==__draft.task)return{applied:false};__draft.task=text;return{applied:true};},focus(){document.activeElement=document.querySelector('#mission-task');__effects.push('chat-focus:'+state.screen);},update(){},submitFocused(){__effects.push('chat-submit');}};configureUI={update(){},draft:__settingsDraft};observeUI={update(){},enter(){}};
    ${clickRegistration}
    globalThis.app={state,mountConfigure,mountObserve,showChatGPTConnectorSettings,toast:renderToast,handleGlobalKey,updateSkipLink,syncWorkflowView,ensureWorkflowView,applyView,fit,showModal,closeModal,showPlanning,showTaskNotes,showMission,showObserve,showConfigure,showWorkflow,selectWorkspaceMode,handleWorkspaceModeKey,renderMode,showLearning,showEmailWorkspace,showIdentity,showToolConnections,showFilePatches,showKnowledge,showConnections,showBrowserWorkspace,showProjects,showInbox,showOperations,showSchedule,showSwarm,showDeployOperation};
  })();`);
  await vm.runInContext(adapted,context);
  const app=context.app;app.state.workflow={id:'draft',name:'Unfinished workflow',nodes:[],edges:[],settings:{cwd:'C:\\fixture'}};app.state.dirty=false;
  return{...app,configureCallbacks:()=>configureCallbacks,observeCallbacks:()=>observeCallbacks,observedEntries,planningCallbacks:()=>planningCallbacks,inboxCallbacks:()=>inboxCallbacks,modal:()=>modal,activateAction(action){const button={tagName:'BUTTON',dataset:{action},isConnected:true,closest(selector){return selector==='[data-action]'?this:null;}};document.activeElement=button;return listeners.get('click')({target:button,detail:0});},toastRoot,pendingTimers:()=>timers.size,advance(milliseconds){const target=clock+milliseconds;for(;;){const next=[...timers].filter(([,item])=>item.at<=target).sort((a,b)=>a[1].at-b[1].at||a[0]-b[0])[0];if(!next)break;clock=next[1].at;timers.delete(next[0]);next[1].callback();}clock=target;},tabs,actions,menu,mount,document,skip,destinations,canvas,world,effects,setFocusables(items){focusables=items;},key(key,options={}){const event={key,code:key===' '?'Space':key,preventDefault(){this.defaultPrevented=true;},...options};app.handleGlobalKey(event);return event;},opened,cancelled,messages,draft,settingsDraft,release:()=>pending?.resolve(),flush(){while(frames.length)frames.shift()();}};
}

test('repeating a toast reuses one message, resets its lifetime and preserves focus',async()=>{
  const f=await fixture(),focused=f.document.activeElement;
  f.toast('Handoff copied.');const element=f.toastRoot.children[0];f.advance(4400);
  f.toast('Handoff copied.');assert.equal(f.toastRoot.children.length,1);assert.equal(f.toastRoot.children[0],element);assert.equal(f.pendingTimers(),1);assert.equal(f.document.activeElement,focused);
  f.advance(4500-1);assert.equal(f.toastRoot.children[0],element,'the original timer cannot dismiss the repeated message early');
  f.advance(1);assert.equal(f.toastRoot.children.length,0);assert.equal(f.pendingTimers(),0);assert.equal(f.document.activeElement,focused);
});

test('the latest ordinary receipt replaces older success messages while errors retain priority and timers are cleaned',async()=>{
  const f=await fixture(),messages=()=>f.toastRoot.children.map(node=>node.textContent);
  const focused=f.document.activeElement;
  f.toast('First receipt');const first=f.toastRoot.children[0];f.toast('Settings could not be saved',true);const error=f.toastRoot.children[1];f.toast('Second receipt');
  assert.deepEqual(messages(),['Settings could not be saved','Second receipt']);assert.equal(first.parentNode,null,'the superseded receipt is removed');assert.equal(f.pendingTimers(),2,'replacement also clears the old timer');
  f.toast('Newest receipt');assert.deepEqual(messages(),['Settings could not be saved','Newest receipt']);assert.equal(f.toastRoot.children[0],error,'a success does not replace or recreate an existing error');assert.equal(f.pendingTimers(),2);assert.equal(f.document.activeElement,focused);
  f.toast('Connection failed',true);f.toast('Task failed',true);assert.deepEqual(messages(),['Settings could not be saved','Connection failed','Task failed']);
  f.toast('Handoff copied.');assert.equal(f.toastRoot.children.length,3,'a routine receipt does not displace three current errors');assert.equal(f.pendingTimers(),3);
  f.toast('Settings could not be saved');assert.equal(f.toastRoot.children[0].className,'toast error','a repeated ordinary receipt cannot downgrade an error');assert.equal(f.pendingTimers(),3);
  f.advance(4500);assert.equal(f.toastRoot.children.length,0);assert.equal(f.pendingTimers(),0);
});

test('Settings subconfiguration exits to Chat without mutating unsent conversation or Studio edits',async()=>{
  const f=await fixture();f.showConfigure();await f.showLearning();f.state.dirty=true;f.state.workflow.name='Keep my unfinished workflow';
  f.selectWorkspaceMode('view');f.flush();
  assert.equal(f.state.screen,'mission');assert.equal(f.state.modal,null);assert.equal(f.mount.innerHTML,'');assert.equal(f.menu.open,false);
  assert.equal(f.draft.task,'Keep my unsent task');assert.equal(f.draft.model,'chosen-model');assert.equal(f.state.workflow.name,'Keep my unfinished workflow');assert.equal(f.state.dirty,true);assert.equal(f.settingsDraft.runFor,'36');assert.equal(f.document.activeElement.dataset.mode,'view');
});

test('selecting the already active Chat tab still dismisses its open subconfiguration',async()=>{
  const f=await fixture();await f.showLearning();assert.equal(f.state.screen,'mission');f.selectWorkspaceMode('view');f.flush();assert.equal(f.state.modal,null);assert.equal(f.mount.innerHTML,'');assert.equal(f.tabs[0].attributes['aria-selected'],'true');
});

test('the advanced menu focuses its canvas and retains a reachable primary tab without selecting it',async()=>{
  const f=await fixture();f.selectWorkspaceMode('configure');f.flush();await f.activateAction('workflow');f.flush();
  assert.equal(f.state.screen,'workflow');assert.equal(f.actions.hidden,false);assert.deepEqual(f.tabs.map(tab=>tab.dataset.mode),['view','observe','planning','configure']);assert.ok(f.tabs.every(tab=>tab.attributes['aria-selected']==='false'));
  assert.deepEqual(f.tabs.map(tab=>tab.tabIndex),[-1,-1,-1,0],'the last primary tab remains reachable while the separate canvas is open');assert.equal(f.document.activeElement,f.canvas);assert.equal(f.canvas.tabIndex,-1);assert.equal(f.canvas.focusOptions.preventScroll,true);
  f.renderMode();assert.deepEqual(f.tabs.map(tab=>tab.tabIndex),[-1,-1,-1,0],'status renders retain the same single tab stop');
  f.updateSkipLink();assert.equal(f.skip.href,'#canvas');assert.equal(f.menu.open,false);
  f.selectWorkspaceMode('view');f.flush();assert.equal(f.state.screen,'mission');assert.equal(f.actions.hidden,true);assert.deepEqual(f.tabs.map(tab=>tab.tabIndex),[0,-1,-1,-1]);assert.equal(f.document.activeElement.dataset.mode,'view');
});

test('the advanced canvas restores the first primary tab when no previous tab stop exists',async()=>{
  const f=await fixture();for(const tab of f.tabs)tab.tabIndex=-1;await f.activateAction('workflow');f.flush();
  assert.deepEqual(f.tabs.map(tab=>tab.tabIndex),[0,-1,-1,-1]);assert.ok(f.tabs.every(tab=>tab.attributes['aria-selected']==='false'));assert.equal(f.document.activeElement,f.canvas);
  let prevented=false;f.handleWorkspaceModeKey({target:f.tabs[0],key:'ArrowRight',preventDefault(){prevented=true;}});f.flush();
  assert.equal(prevented,true);assert.equal(f.state.screen,'observe');assert.deepEqual(f.tabs.map(tab=>tab.tabIndex),[-1,0,-1,-1]);assert.equal(f.document.activeElement,f.tabs[1]);
});

test('a deferred canvas focus cannot replace a newer focused field or workspace',async()=>{
  const f=await fixture();await f.activateAction('workflow');const field={tagName:'INPUT'};f.document.activeElement=field;f.flush();
  assert.equal(f.state.screen,'workflow');assert.equal(f.document.activeElement,field);assert.equal(f.canvas.focusOptions,undefined);
  await f.activateAction('workflow');f.selectWorkspaceMode('configure');f.flush();
  assert.equal(f.state.screen,'configure');assert.equal(f.document.activeElement,f.tabs[3]);assert.equal(f.canvas.focusOptions,undefined);
});

test('a loading or error-only dialog takes focus and restores its opener when closed',async()=>{
  const f=await fixture();f.showConfigure();const opener=f.document.activeElement;
  f.showModal('task-methods','<p role="status">Reading your method…</p><button data-action="close-modal">Close</button>');f.flush();
  assert.equal(f.document.activeElement,f.modal());assert.equal(f.modal().tabIndex,-1);assert.equal(f.modal().focusOptions.preventScroll,true);
  f.showModal('task-methods','<p role="alert">The method is unavailable.</p><button disabled>Retrying…</button><button data-action="close-modal">Close</button>');f.flush();
  assert.equal(f.document.activeElement,f.modal(),'disabled controls do not leave focus behind the modal');
  f.closeModal();assert.equal(f.document.activeElement,opener);assert.equal(f.state.screen,'configure');
});

test('modal opening prefers a usable field and skips hidden and disabled controls',async()=>{
  const f=await fixture();f.showModal('task-methods','<input type="hidden"><input disabled><textarea></textarea>');f.flush();
  assert.equal(f.document.activeElement.tagName,'TEXTAREA');assert.equal(f.document.activeElement.focusOptions.preventScroll,true);
});

test('deferred modal autofocus cannot redirect text from a field the user already selected',async()=>{
  const f=await fixture();f.showModal('deployment','<textarea name="input"></textarea><input name="expression">');
  const [task,expression]=f.modal().querySelectorAll();task.value='Keep the scheduled task';expression.value='0 9 * * *';
  expression.focus();expression.selectionStart=0;expression.selectionEnd=expression.value.length;
  f.flush();
  assert.equal(f.document.activeElement,expression,'the delayed opening frame must preserve the selected cron field');
  assert.equal(expression.selectionStart,0);assert.equal(expression.selectionEnd,'0 9 * * *'.length);
  f.document.activeElement.value='0 9 * * MON-FRI';
  assert.equal(expression.value,'0 9 * * MON-FRI');assert.equal(task.value,'Keep the scheduled task','typing must not leak into the first field');
});

test('deferred modal autofocus preserves a newly focused connected control outside the dialog',async()=>{
  const f=await fixture();f.showModal('deployment','<textarea></textarea>');
  const outside={tagName:'INPUT',isConnected:true,value:'Find a task',focus(){f.document.activeElement=this;}};
  outside.focus();f.flush();
  assert.equal(f.document.activeElement,outside,'focus ownership also applies to controls outside the modal');
  f.document.activeElement.value='Find another task';assert.equal(outside.value,'Find another task');
  assert.equal(f.modal().querySelectorAll()[0].focusOptions,undefined);
});

test('modal initial autofocus still moves from an unchanged connected opener to its first usable field',async()=>{
  const f=await fixture();f.tabs[3].focus();const opener=f.document.activeElement;
  f.showModal('deployment','<textarea></textarea><input>');assert.equal(f.document.activeElement,opener);f.flush();
  assert.equal(f.document.activeElement,f.modal().querySelectorAll()[0]);assert.equal(f.document.activeElement.focusOptions.preventScroll,true);
});

test('modal initial autofocus remains available after a temporary focus target is removed',async()=>{
  for(const background of ['body','detached']){
    const f=await fixture();f.tabs[3].focus();f.showModal('deployment','<textarea></textarea>');
    f.document.activeElement=background==='body'?f.document.body:{tagName:'INPUT',isConnected:false};f.flush();
    assert.equal(f.document.activeElement,f.modal().querySelectorAll()[0],`${background} does not own a live control`);
  }
});

for(const origin of ['configure','workflow'])test(`Planning opens from ${origin} without submitting work or changing retained drafts`,async()=>{
  const f=await fixture();if(origin==='configure')f.showConfigure();else f.showWorkflow();f.flush();
  f.state.dirty=true;const before=structuredClone(f.draft),taskState={taskId:'saved-task',revision:4,goal:'Retained objective',steps:[]};f.state.currentRun={id:'saved-run',taskId:'saved-task',status:'running',taskState};f.state.runs=[f.state.currentRun];
  await f.showPlanning();f.flush();assert.equal(f.state.screen,'planning');assert.equal(f.state.modal,null);assert.equal(f.effects.find(item=>item.planningSeed)?.planningSeed.taskState,taskState);
  f.planningCallbacks().onSaved({...taskState,revision:5,goal:'Human correction'});assert.equal(f.state.currentRun.taskState.revision,5);assert.equal(f.state.currentRun.status,'running');assert.equal(f.state.dirty,true);
  f.selectWorkspaceMode('view');f.flush();assert.deepEqual(f.draft,before);assert.equal(f.settingsDraft.runFor,'36');assert.equal(f.document.activeElement.dataset.mode,'view');assert.ok(!f.effects.includes('chat-submit'));assert.ok(!f.effects.includes('run'));
});

test('an old modal focus callback cannot focus a removed dialog after navigation',async()=>{
  const f=await fixture();f.showModal('learning','<input>');f.selectWorkspaceMode('observe');f.flush();assert.equal(f.state.modal,null);assert.equal(f.document.activeElement.dataset.mode,'observe');
});

for(const[name,module]of [['showPlanning','planning-workspace-ui'],['showEmailWorkspace','email-ui'],['showLearning','learning-ui'],['showIdentity','identity-ui'],['showToolConnections','tool-connections-ui'],['showFilePatches','file-patches-ui'],['showKnowledge','knowledge-ui'],['showConnections','connections-ui'],['showBrowserWorkspace','browser-ui'],['showProjects','projects-ui'],['showInbox','inbox-ui'],['showOperations','advanced-ui'],['showSchedule','advanced-ui'],['showSwarm','advanced-ui'],['showDeployOperation','advanced-ui']])test(`a delayed ${name} import cannot reopen over a newly selected workspace`,async()=>{
  const f=await fixture({pauseModule:`/${module}.mjs`});f.showConfigure();const opening=f[name]();await turn();f.selectWorkspaceMode('view');f.release();await opening;f.flush();assert.equal(f.state.screen,'mission');assert.equal(f.state.modal,null);assert.equal(f.mount.innerHTML,'');assert.deepEqual(f.opened,[]);assert.deepEqual(f.messages,[]);
});

test('a newer subconfiguration wins over an older lazy import',async()=>{
  const f=await fixture({pauseModule:'/learning-ui.mjs'});const opening=f.showLearning();await turn();await f.showBrowserWorkspace();f.release();await opening;assert.deepEqual(f.opened,['browser']);assert.equal(f.state.modal,'browser');
});

test('closing while a subconfiguration module loads cancels that opening',async()=>{
  const f=await fixture({pauseModule:'/learning-ui.mjs'});const opening=f.showLearning();await turn();f.closeModal();f.release();await opening;assert.equal(f.state.modal,null);assert.deepEqual(f.opened,[]);
});

test('workspace tab arrow keys wrap and Home/End activate a single reachable tab',async()=>{
  const f=await fixture();let prevented=0;const key=(mode,key)=>{f.handleWorkspaceModeKey({target:f.tabs.find(tab=>tab.dataset.mode===mode),key,preventDefault(){prevented++;}});f.flush();};
  key('view','ArrowLeft');assert.equal(f.state.screen,'configure');key('configure','ArrowRight');assert.equal(f.state.screen,'mission');key('view','End');assert.equal(f.state.screen,'configure');key('configure','Home');assert.equal(f.state.screen,'mission');assert.equal(prevented,4);assert.deepEqual(f.tabs.map(tab=>tab.tabIndex),[0,-1,-1,-1]);
});

test('leaving Email cancels its pending requests while preserving the original chat draft',async()=>{
  const f=await fixture();await f.showEmailWorkspace();assert.equal(f.state.modal,'email');f.selectWorkspaceMode('view');f.flush();assert.equal(f.state.modal,null);assert.deepEqual(f.cancelled,['email']);assert.equal(f.draft.task,'Keep my unsent task');assert.equal(f.document.activeElement.dataset.mode,'view');
});


test('workflow editing shortcuts cannot change a hidden workflow or consume modal editing keys',async()=>{
  const f=await fixture();f.state.workflow.nodes=[{id:'keep',type:'agent',name:'Keep this node'}];f.state.selected='keep';
  for(const screen of ['mission','observe','planning','configure','desktop']){
    f.state.screen=screen;
    for(const key of ['Delete','Backspace','f',' '])assert.equal(f.key(key).defaultPrevented,undefined,`${screen}: ${key}`);
    if(screen!=='mission')for(const key of ['s','Enter','z','y'])assert.equal(f.key(key,{ctrlKey:true}).defaultPrevented,undefined,`${screen}: Ctrl+${key}`);
  }
  f.state.screen='workflow';f.state.modal='Projects & capabilities';
  for(const key of ['Delete','s','Enter','z'])assert.equal(f.key(key,{ctrlKey:key!=='Delete'}).defaultPrevented,undefined);
  assert.equal(f.state.workflow.nodes[0].id,'keep');assert.equal(f.state.dirty,false);assert.deepEqual(f.effects,[]);
});

test('workflow shortcuts still save, run, undo and remove the selected node in Workflows',async()=>{
  const f=await fixture();f.state.screen='workflow';f.state.workflow.nodes=[{id:'remove',type:'agent',name:'Remove this node'}];f.state.selected='remove';
  for(const key of ['s','Enter','z','y'])assert.equal(f.key(key,{ctrlKey:true}).defaultPrevented,true);
  assert.deepEqual(f.effects,['save','run','undo','redo']);assert.equal(f.key('Delete').defaultPrevented,true);assert.equal(f.state.workflow.nodes.length,0);assert.equal(f.state.dirty,true);
});

test('native control keys and already handled events remain available within Workflows',async()=>{
  const f=await fixture();f.state.screen='workflow';const button={tagName:'BUTTON',dataset:{},closest:selector=>selector.startsWith('button,')?button:null};f.document.activeElement=button;
  assert.equal(f.key(' ').defaultPrevented,undefined);assert.equal(f.state.space,false);assert.equal(f.key('f').defaultPrevented,undefined);
  assert.equal(f.key('s',{ctrlKey:true,defaultPrevented:true}).defaultPrevented,true);assert.deepEqual(f.effects,[]);
  f.state.screen='mission';f.key('Enter',{ctrlKey:true});assert.deepEqual(f.effects,[],'an unrelated focused button cannot submit the Chat draft');
});

test('Chat send shortcuts act only on the editable message composer, never search, rename or settings',async()=>{
  const f=await fixture();f.state.screen='mission';
  for(const modified of [{ctrlKey:true},{metaKey:true}]){
    for(const [id,tagName]of [['conversation-search','INPUT'],['conversation-name','INPUT'],['mission-cwd','INPUT'],['mission-effort','SELECT'],['mission-model','SELECT'],['conversation-plan-tab','BUTTON']]){
      f.document.activeElement={id,tagName,dataset:{},closest(){return null;}};
      assert.equal(f.key('Enter',modified).defaultPrevented,undefined,`${id} keeps its native keyboard behavior`);assert.deepEqual(f.effects,[]);
    }
  }
  assert.equal(f.draft.task,'Keep my unsent task');const composer=f.destinations['mission-task'];f.document.activeElement=composer;
  f.key('Enter',{ctrlKey:true});f.key('Enter',{metaKey:true});assert.deepEqual(f.effects,['chat-submit','chat-submit']);
});

test('Chat send shortcuts preserve composition, line breaks, read-only state and already handled events',async()=>{
  const f=await fixture(),composer=f.destinations['mission-task'];f.state.screen='mission';f.document.activeElement=composer;
  for(const options of [{isComposing:true},{keyCode:229},{shiftKey:true},{altKey:true},{defaultPrevented:true}]){
    const event=f.key('Enter',{ctrlKey:true,...options});assert.equal(event.defaultPrevented,options.defaultPrevented);assert.deepEqual(f.effects,[]);
  }
  for(const property of ['readOnly','disabled']){composer[property]=true;assert.equal(f.key('Enter',{metaKey:true}).defaultPrevented,undefined);composer[property]=false;}
  composer.closest=()=>({hidden:true});assert.equal(f.key('Enter',{ctrlKey:true}).defaultPrevented,undefined);composer.closest=()=>null;
  f.state.modal='Existing dialog';assert.equal(f.key('Enter',{ctrlKey:true}).defaultPrevented,undefined);assert.deepEqual(f.effects,[]);assert.equal(f.draft.task,'Keep my unsent task');
});

test('each workspace skip link targets its visible focusable content',async()=>{
  const f=await fixture();for(const [screen,id]of [['mission','mission-task'],['observe','observe-workspace'],['configure','configure-workspace'],['workflow','canvas'],['desktop','desktop-workspace']]){
    f.state.screen=screen;f.updateSkipLink();assert.equal(f.skip.href,'#'+id);if(screen!=='mission')assert.equal((id==='canvas'?f.canvas:f.destinations[id]).tabIndex,-1);
  }
});

test('a deferred workspace tab focus cannot steal the newer skip-target focus',async()=>{
  const f=await fixture();f.selectWorkspaceMode('configure');f.updateSkipLink();
  const target=f.destinations['configure-workspace'];assert.equal(f.skip.href,'#configure-workspace');assert.equal(target.tabIndex,-1);
  // Native fragment navigation has already focused the requested Settings target.
  f.document.activeElement=target;f.flush();
  assert.equal(f.state.screen,'configure');assert.equal(f.document.activeElement,target);
});

test('modal keyboard loop includes summaries and focusable regions and excludes hidden controls',async()=>{
  const f=await fixture();f.state.modal='Projects & capabilities';
  const node=(tagName,extra={})=>({tagName,tabIndex:0,disabled:false,closest:()=>null,getClientRects:()=>[{}],focus(){f.document.activeElement=this;},...extra});
  const first=node('BUTTON'),summary=node('SUMMARY'),last=node('DIV'),hidden=node('BUTTON',{getClientRects:()=>[]}),disabled=node('BUTTON',{disabled:true}),negative=node('DIV',{tabIndex:-1});
  f.setFocusables([first,summary,last,hidden,disabled,negative]);f.document.activeElement=last;assert.equal(f.key('Tab').defaultPrevented,true);assert.equal(f.document.activeElement,first);
  assert.equal(f.key('Tab',{shiftKey:true}).defaultPrevented,true);assert.equal(f.document.activeElement,last);
  f.document.activeElement=summary;assert.equal(f.key('Tab').defaultPrevented,undefined);assert.equal(f.document.activeElement,summary);
  f.mount.contains=()=>true;f.document.activeElement={tabIndex:-1,dataset:{},closest:()=>null};assert.equal(f.key('Tab').defaultPrevented,undefined,'a task card focused by the map can Tab naturally into its visible summary');
});

test('workflow navigation and resize keep manual views and fit each new workflow once',async()=>{
  const f=await fixture();f.showWorkflow();f.flush();assert.deepEqual(f.effects,['fit']);
  f.state.view={x:-310,y:180,scale:1.25};f.showMission();f.showWorkflow();f.flush();assert.deepEqual({...f.state.view},{x:-310,y:180,scale:1.25});
  f.canvas.clientWidth=600;f.ensureWorkflowView();assert.deepEqual({...f.state.view},{x:-310,y:180,scale:1.25});assert.deepEqual(f.effects,['fit']);
  f.state.workflow={...f.state.workflow,id:'second'};f.ensureWorkflowView();assert.deepEqual(f.effects,['fit','fit']);f.state.view={x:15,y:-50,scale:.6};
  f.state.workflow={...f.state.workflow,id:'draft'};f.ensureWorkflowView();assert.deepEqual({...f.state.view},{x:-310,y:180,scale:1.25});
  f.state.workflow={...f.state.workflow,id:'second'};f.ensureWorkflowView();assert.deepEqual({...f.state.view},{x:15,y:-50,scale:.6});
  f.fit();assert.deepEqual({...f.state.view},{x:80,y:45,scale:.75});assert.deepEqual(f.effects,['fit','fit','fit']);
});



for(const staleBeforeFetch of [false,true])test(`an Inbox run receipt cannot replace the current workspace when abandoned ${staleBeforeFetch?'before':'during'} hydration`,async()=>{
  const pending=held(),requests=[],f=await fixture({apiResponse:async url=>{requests.push(url);return pending.promise;}});
  await f.showInbox();f.flush();let current=true;
  const receipt={id:'inbox-started-run',status:'running',events:[],nodes:{},workflow:{id:'saved-task-workflow',name:'Saved task',nodes:[],edges:[]},output:'Actual started task receipt'};
  if(staleBeforeFetch){f.closeModal();f.showConfigure();f.flush();current=false;}
  const opened=f.inboxCallbacks().onRunStarted({id:receipt.id},{isCurrent:()=>current});
  await turn();
  if(!staleBeforeFetch){f.closeModal();f.showConfigure();f.flush();current=false;}
  f.state.dirty=true;f.state.workflow.name='Keep this newer workflow';f.draft.task='Keep this other unsent message';
  const focused=f.document.activeElement,selected=f.state.currentRun;pending.resolve(receipt);const result=await opened;f.flush();
  assert.deepEqual(requests,['/api/runs/inbox-started-run']);assert.equal(result.id,receipt.id);
  assert.equal(f.state.runs.find(run=>run.id===receipt.id)?.output,receipt.output,'the actual run receipt remains discoverable');
  assert.equal(f.state.screen,'configure');assert.equal(f.state.modal,null);assert.equal(f.state.currentRun,selected);
  assert.equal(f.state.workflow.name,'Keep this newer workflow');assert.equal(f.state.dirty,true);
  assert.equal(f.draft.task,'Keep this other unsent message');assert.equal(f.document.activeElement,focused);
  assert.ok(f.cancelled.includes('inbox'),'closing the modal cancels its UI ownership');
});

for(const desktop of [true,false])test(`Settings on ${desktop?'desktop':'web'} cannot trigger Chat Mode setup or change the current work`,async()=>{
  const calls=[],f=await fixture({desktop,apiResponse:async(...args)=>{calls.push(args);return {};}});
  await f.mountConfigure();await f.mountObserve();f.showConfigure();
  const draft={...f.draft},focused=f.document.activeElement;
  assert.equal(Object.hasOwn(f.configureCallbacks(),'onOpenChatGPT'),false);
  assert.deepEqual(calls,[]);assert.deepEqual(f.observedEntries,[]);
  assert.equal(f.state.screen,'configure');assert.equal(f.state.currentRun,null);
  assert.deepEqual(f.draft,draft);assert.deepEqual(f.effects,[]);assert.equal(f.document.activeElement,focused);
});


test('generic Planning navigation retains its selected plan while explicit links choose a plan',async()=>{
  const f=await fixture();await f.showPlanning({taskId:'chosen-plan'});await f.showOperations();await f.showPlanning();
  const seeds=f.effects.filter(item=>item.planningSeed).map(item=>item.planningSeed);
  assert.equal(seeds[0].taskId,'chosen-plan');
  assert.deepEqual(Object.keys(seeds.at(-1)),[],'returning from schedules must not replace the selected plan with the current chat');
  await f.showPlanning({taskId:'linked-plan'});assert.equal(f.effects.filter(item=>item.planningSeed).at(-1).planningSeed.taskId,'linked-plan');
  assert.equal(f.draft.task,'Keep my unsent task');assert.ok(!f.effects.includes('chat-submit'));assert.ok(!f.effects.includes('run'));
});

test('current-task notes explicitly follow the selected chat after another plan was open',async()=>{
  const f=await fixture();await f.showPlanning({taskId:'plan-A'});
  f.state.currentRun={id:'run-B',taskState:{taskId:'plan-B',revision:2,steps:[]},status:'completed'};
  await f.showTaskNotes();
  const seed=f.effects.filter(item=>item.planningSeed).at(-1).planningSeed;
  assert.equal(seed.taskId,'plan-B');assert.equal(seed.runId,'run-B');
  assert.equal(f.draft.task,'Keep my unsent task');assert.ok(!f.effects.includes('run'));
});

test('shared coordination destinations preserve unsent work and use existing navigation ownership',async()=>{
  const f=await fixture();f.state.dirty=true;const draft=structuredClone(f.draft);
  for(const action of ['projects','operations','planning'])await f.activateAction(action);
  assert.deepEqual(f.opened,['projects','operations','planning']);assert.deepEqual(f.draft,draft);assert.equal(f.state.dirty,true);
  assert.equal(f.state.screen,'planning');assert.equal(f.state.modal,null);assert.ok(!f.effects.includes('chat-submit'));assert.ok(!f.effects.includes('run'));
});

test('connection settings remains reachable without opening a ChatGPT tab or submitting work',async()=>{
  const calls=[],f=await fixture({apiResponse:async(...args)=>{calls.push(args);return {};}});
  await f.mountConfigure();await f.mountObserve();f.showObserve();const draft={...f.draft},entries=structuredClone(f.observedEntries);
  f.observeCallbacks().onChatGPTSettings();
  assert.equal(f.state.screen,'configure');assert.deepEqual(f.effects,['connector-settings']);
  assert.deepEqual(f.draft,draft);assert.equal(f.state.currentRun,null);
  assert.deepEqual(calls,[]);assert.deepEqual(structuredClone(f.observedEntries),entries);
});

test('the application exposes no reverse ChatGPT setup action while preserving connection settings', async () => {
  const calls = [], f = await fixture({ apiResponse: async (...args) => { calls.push(args); return {}; } });
  await f.mountConfigure(); await f.mountObserve();
  assert.equal(Object.hasOwn(f, 'setupChatMode'), false);
  assert.equal(Object.hasOwn(f.configureCallbacks(), 'onOpenChatGPT'), false);
  f.observeCallbacks().onChatGPTSettings();
  assert.equal(f.state.screen, 'configure'); assert.deepEqual(f.effects, ['connector-settings']);
  assert.deepEqual(calls, []); assert.deepEqual(f.observedEntries, []);
  assert.equal(f.draft.model, 'chosen-model'); assert.equal(f.state.currentRun, null);
});
