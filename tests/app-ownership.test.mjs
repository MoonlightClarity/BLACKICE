import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import * as workspaceIntegrationModel from '../public/workspace-integrations.mjs';
import * as runState from '../public/run-state-model.mjs';
import * as missionModel from '../public/mission-model.mjs';
import * as reasoningModel from '../public/reasoning-model.mjs';
import * as taskTitleModel from '../public/task-title.mjs';
import * as repeatTaskModel from '../public/repeat-task-model.mjs';
import * as iconSymbolsModel from '../public/icon-symbols.mjs';
import * as conversationSearchModel from '../public/conversation-search.mjs';
import * as clipboardModel from '../public/clipboard.mjs';
import * as composerHelpersModel from '../public/composer-helpers.mjs';

const turn = () => new Promise(resolve => setImmediate(resolve));
const held = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const graph = id => ({ id, name: `Workflow ${id}`, nodes: [{ id: 'agent', type: 'agent', model: 'default' }], edges: [], settings: { cwd: 'C:\\fixture' } });
const run = (id, workflow = graph(id)) => ({ id, workflow, workflowId: workflow.id, status: 'running', settled: false, createdAt: '2026-10-16T12:00:00Z', updatedAt: '2026-10-16T12:00:00Z', nodes: { agent: { status: 'running', output: '' } }, events: [] });

// Exercise the actual classic-script handlers with network and rendering adapters.
// Startup is replaced solely to avoid mounting an unrelated full browser document.
async function fixture(api) {
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8'), calls = [];
  const modules = {
    '/composer-helpers.mjs': composerHelpersModel,
    '/editor-model.mjs': { WorkflowHistory: class { reset() {} record() {} }, diagnoseWorkflow:()=>[], fitWorkflow() {}, renderMarkdown: value => value },
    '/mission-model.mjs': missionModel, '/reasoning-model.mjs':reasoningModel, '/run-state-model.mjs': runState, '/context-ui.mjs': {}, '/task-state-ui.mjs': {}, '/svg-preview.mjs': {}, '/artifact-ui.mjs': {}, '/prompts-ui.mjs': {}, '/task-title.mjs':taskTitleModel, '/repeat-task-model.mjs':repeatTaskModel,
    '/clipboard.mjs': clipboardModel, '/conversation-search.mjs': conversationSearchModel, '/icon-symbols.mjs': iconSymbolsModel, '/workspace-integrations.mjs': workspaceIntegrationModel, '/api-client.mjs': { createApiClient: () => async (url, method, body) => { calls.push({ url, method, body }); return api(url, method, body); } },
    '/run-index-client.mjs':{createRunIndexClient:()=>({read:async()=>[],close(){},usingWorker:false})},
    '/renderer-scheduler.mjs':{createRenderThrottle:()=>({request(fn){fn();},cancel(){},flush(){}})},
    '/run-index-model.mjs':{reconcileRunIndex:(old,summary)=>summary},
  };
  const context = vm.createContext({ __modules: modules, __selection: { runId: 'original', forceNew: false }, structuredClone, crypto: webcrypto,
    document: { querySelector:()=>null }, localStorage: { setItem() {} }, requestAnimationFrame() {}, setTimeout: () => 1, clearTimeout() {}, queueMicrotask, console,
  });
  const adapted = source.replace(/const\s*(\{[^;]+?\})\s*=\s*await import\('([^']+)'\);/g, (_, names, name) => `const ${names}=__modules[${JSON.stringify(name)}];`)
    .replace(/\n  init\(\);\s*\n\}\)\(\);\s*$/, `
      renderAll=()=>{};renderHeader=()=>{};renderExecution=()=>{};renderDesktop=()=>{};renderStreamState=()=>{};renderGraph=()=>{};renderInspector=()=>{};
      refreshRuns=async()=>{};closeModal=()=>{state.modal=null;};toast=(message,error)=>{(globalThis.notices||=[]).push({message,error});};scheduleRunRefresh=id=>{(globalThis.runRefreshes||=[]).push(id);};
      missionUI={getSelection:()=>__selection,searchChats:(query,limit)=>(globalThis.commandChats||[]).filter(chat=>chat.title.toLowerCase().includes(query.toLowerCase())).slice(0,limit),update(){},openConversation:async id=>{(globalThis.openedConversations||=[]).push(id);},refreshHistory(){globalThis.historyRefreshes=(globalThis.historyRefreshes||0)+1;return Promise.resolve();}};
      globalThis.app={state,showRun,stubRunDialog(callback){showModal=(type,html)=>{state.modal=type;callback({type,html});};installFolderPicker=()=>{};},repeatMissionTask,stubRepeatSetup(callback){advancedUI={openSchedule:callback};},startMissionTask,queueMissionTask,captureMissionTask,continueMissionTask,retryRun,cancelRun,openRun,loadWorkflow,markDirty,showMission,showObserve,showConfigure,showWorkflow,handleEvent,runEventGenerations,submitWorkflowRun,commandCatalog,matchingCommands,executeCommand,showCommands,handleCommandKey,stubCommandActions(){for(const [id,set] of [['schedule',value=>showSchedule=value],['swarm',value=>showSwarm=value],['operations',value=>showOperations=value],['models-connections',value=>showConnections=value],['run-limits',value=>showRunLimits=value],['prompts',value=>showPrompts=value]])set(()=>{(globalThis.commandActions||=[]).push(id);state.modal=id;});}};
    })();`);
  await vm.runInContext(adapted, context);
  const app = context.app, original = run('original'); app.state.workflow = original.workflow; app.state.workflows = [original.workflow]; app.state.currentRun = original; app.state.runs = [original];
  return { ...app, calls, notices:()=>context.notices||[], runRefreshes:()=>context.runRefreshes||[], mountCommandList:({rows,query,active})=>{context.document.querySelectorAll=()=>rows;context.document.querySelector=()=>query;context.document.activeElement=active;return{focus:element=>{context.document.activeElement=element;},active:()=>context.document.activeElement};},commandActions:()=>context.commandActions||[],commandChats:value=>{context.commandChats=value;},readSelection:()=>context.__selection,historyRefreshes:()=>context.historyRefreshes||0, openedConversations:()=>context.openedConversations||[],mountRunForm:form=>{context.document.querySelector=selector=>selector==='#run-form'?form:null;app.state.modal='run';},selection: value => { context.__selection = value; } };
}

test('Make repeatable resolves one original admitted recipe and ignores unsent composer overrides', async () => {
  const original={...run('root'),cwd:'C:\\original',input:'The full original task.',attachmentIds:['admitted-file']},completed={...run('followup'),status:'completed',settled:true,taskId:'root',cwd:'C:\\later',input:'A later narrow follow-up.',attachmentIds:['later-file'],taskState:{steps:[{status:'done'}]}};
  const f=await fixture(async url=>url==='/api/runs/followup'?completed:assert.fail('Unexpected API request '+url));f.state.runs=[original,completed];f.state.currentRun=completed;const seeds=[];f.stubRepeatSetup(seed=>seeds.push(seed));
  await f.repeatMissionTask({runId:'followup',task:'UNSENT',model:'UNSENT_MODEL',cwd:'C:\\unsent',attachmentIds:['UNSENT_FILE']});assert.equal(seeds.length,1);assert.equal(seeds[0].input,original.input);assert.equal(seeds[0].cwd,original.cwd);assert.deepEqual(seeds[0].workflow,original.workflow);assert.deepEqual(seeds[0].attachmentIds,original.attachmentIds);assert.equal(seeds[0].repeatTask,true);assert.equal(f.calls.filter(call=>call.method==='POST').length,0);
});

test('a delayed repeat setup cannot replace a view opened while its run was loading', async () => {
  const pending=held(),f=await fixture(()=>pending.promise),seeds=[];f.stubRepeatSetup(seed=>seeds.push(seed));const opening=f.repeatMissionTask({runId:'original'});await turn();f.showConfigure();pending.resolve({...run('original'),status:'completed',settled:true,cwd:'C:\\fixture',input:'Task'});await opening;assert.equal(seeds.length,0);assert.equal(f.state.screen,'configure');
});

test('a late task admission is cataloged without replacing a workflow edited after the user changed modes', async () => {
  const pending = held();
  const f = await fixture(async (url, method, body) => url === '/api/workflows' ? body : pending.promise);
  const starting = f.startMissionTask({ task: 'Start this task', cwd: 'C:\\fixture', requestId: 'start-owned' }); await turn();
  f.showConfigure(); f.state.workflow.name = 'Keep my unsaved changes'; f.markDirty();
  const accepted = run('accepted'); pending.resolve(accepted); assert.strictEqual(await starting, accepted);
  assert.equal(f.state.workflow.name, 'Keep my unsaved changes'); assert.equal(f.state.dirty, true); assert.equal(f.state.currentRun.id, 'original'); assert.equal(f.state.screen, 'configure');
  assert.ok(f.state.runs.some(item => item.id === accepted.id));
});

test('time-limit search opens the specific optional settings without admitting or retrying work',async()=>{
  const f=await fixture(()=>({}));f.stubCommandActions();
  for(const query of ['time limits','deadline','timeout','inactivity'])assert.equal(f.matchingCommands(query)[0].id,'run-limits');
  await f.executeCommand('run-limits');assert.deepEqual([...f.commandActions()],['run-limits']);assert.equal(f.calls.length,0);assert.equal(f.state.currentRun.id,'original');
});

test('prompt outline command search opens optional authoring without sending or changing the active conversation',async()=>{
  const f=await fixture(()=>({}));f.stubCommandActions();
  for(const query of ['outline','prompt templates','catalyst'])assert.equal(f.matchingCommands(query)[0].id,'prompts');
  await f.executeCommand('prompts');assert.deepEqual([...f.commandActions()],['prompts']);assert.equal(f.calls.length,0);assert.equal(f.state.currentRun.id,'original');
});

test('ordinary task admission still selects its actual result when the initiating view owns it', async () => {
  const accepted = run('accepted');
  const f = await fixture(async (url, method, body) => url === '/api/workflows' ? body : accepted);
  assert.strictEqual(await f.startMissionTask({ task: 'An owned task', cwd: 'C:\\fixture', requestId: 'owned' }), accepted);
  assert.equal(f.state.currentRun.id, accepted.id); assert.equal(f.state.workflow.id, accepted.workflowId); assert.equal(f.state.dirty, false);
});

test('actual start and continue requests preserve the chosen mode and keep Auto depth unspecified', async () => {
  const accepted = run('planning-result'), f = await fixture((url, method, body) => url === '/api/workflows' ? body : accepted);
  await f.startMissionTask({ task: 'A scaled plan.', cwd: 'C:\\fixture', planningMode: 'auto', requestId: 'planning-start' });
  const start = f.calls.find(call => call.url === '/api/runs'); assert.equal(start.body.input.planningMode, 'auto'); assert.equal(start.body.workflow.settings.planningMode, 'on');
  assert.equal(Object.hasOwn(start.body.input, 'planDetail'), false); assert.equal(Object.hasOwn(start.body.workflow.settings, 'planDetail'), false);
  await f.continueMissionTask({ runId: 'planning-result', nodeId: 'agent', message: 'Now reply without an automatic outline.', planningMode: 'off', requestId: 'planning-continue' });
  const next = f.calls.find(call => call.url === '/api/runs/planning-result/continue'); assert.equal(next.body.planningMode, 'off'); assert.equal(next.body.requestId, 'planning-continue'); assert.equal(Object.hasOwn(next.body, 'planDetail'), false);
});

test('captured and queued tasks keep their planning mode in the persisted recipe', async () => {
  const f = await fixture((url, method) => method === 'POST' ? { id: 'saved-plan-task', status: 'queued' } : {});
  await f.captureMissionTask({ task: 'Save with planning off.', planningMode: 'off', cwd: 'C:\\fixture' });
  await f.queueMissionTask({ task: 'Queue with an expanded plan.', planningMode: 'maximal', enqueueKey: 'mode-receipt', cwd: 'C:\\fixture' });
  const captured = f.calls.find(call => call.url === '/api/inbox'), queued = f.calls.find(call => call.url === '/api/inbox/queue');
  assert.equal(captured.body.workflow.settings.planningMode, 'off'); assert.equal(queued.body.workflow.settings.planningMode, 'on'); assert.equal(queued.body.enqueueKey, 'mode-receipt');
  assert.equal(f.calls.filter(call => call.url === '/api/runs').length, 0);
});

test('a new chat runs independently of an unsaved workflow and preserves that editor draft',async()=>{
  const accepted=run('independent-chat'),f=await fixture((url,method,body)=>url==='/api/workflows'?body:accepted);
  f.state.dirty=true;f.state.saveError='An unrelated workflow could not be saved.';f.state.workflow.nodes[0].prompt='Unfinished editor draft';
  const before=structuredClone(f.state.workflow);
  assert.strictEqual(await f.startMissionTask({task:'Start a normal conversation.',cwd:'C:\\fixture',requestId:'independent-chat'}),accepted);
  assert.deepEqual(f.state.workflow,before);assert.equal(f.state.dirty,true);assert.equal(f.state.currentRun.id,accepted.id);assert.match(f.state.saveError,/unrelated/);
  assert.equal(f.calls.filter(call=>call.url==='/api/workflows').length,1);assert.equal(f.calls[0].body.id,'mission_independent-chat');
});

test('a delayed continuation returns its own receipt without adopting after New chat changes the selection', async () => {
  const pending = held(), f = await fixture(() => pending.promise);
  const continuing = f.continueMissionTask({ runId: 'original', nodeId: 'agent', message: 'Continue A' });
  f.selection({ runId: null, forceNew: true });
  const accepted = run('continuation'); pending.resolve(accepted);
  assert.strictEqual(await continuing, accepted); assert.equal(f.state.currentRun.id, 'original'); assert.ok(f.state.runs.some(item => item.id === accepted.id));
});

test('a delayed retry cannot replace a chat opened while it was being admitted', async () => {
  const pending = held(), f = await fixture(() => pending.promise);
  Object.assign(f.state.currentRun, { status: 'failed', settled: true });
  const retrying = f.retryRun('original');
  const other = run('other'); f.state.runs.push(other); f.state.currentRun = other; f.selection({ runId: other.id, forceNew: false }); f.showMission();
  const retried = run('retry-result'); pending.resolve(retried);
  assert.strictEqual(await retrying, retried); assert.equal(f.state.currentRun.id, other.id); assert.equal(f.state.retrying, false); assert.ok(f.state.runs.some(item => item.id === retried.id));
});

test('rapid Observe selections honor the last request even when the earlier HTTP response arrives last', async () => {
  const a = held(), b = held(), f = await fixture(url => url.endsWith('/a') ? a.promise : b.promise);
  const openingA = f.openRun('a', 'observe'), openingB = f.openRun('b', 'observe');
  const runB = run('b'); b.resolve(runB); await openingB;
  const runA = run('a'); a.resolve(runA); await openingA;
  assert.equal(f.state.currentRun.id, 'b'); assert.equal(f.state.workflow.id, 'b'); assert.equal(f.state.screen, 'observe'); assert.ok(f.state.runs.some(item => item.id === 'a'));
});

test('rapid workflow step inspection on the same run preserves the newest step after an older fetch finishes', async () => {
  const first=held(),latest=held();let requests=0;
  const workflow=graph('same-run');workflow.nodes.push({id:'newer-step',type:'agent',name:'Review the evidence',model:'default'});
  const actual=run('same-run',workflow);actual.nodes['newer-step']={status:'queued',output:''};
  const f=await fixture(()=>++requests===1?first.promise:latest.promise);
  const openingFirst=f.openRun(actual.id,'workflow',{selectedNodeId:'agent'}),openingLatest=f.openRun(actual.id,'workflow',{selectedNodeId:'newer-step'});
  latest.resolve(actual);await openingLatest;assert.equal(f.state.selected,'newer-step');assert.equal(f.state.inspectorTab,'activity');
  first.resolve(actual);await openingFirst;
  assert.equal(f.state.currentRun.id,actual.id);assert.equal(f.state.screen,'workflow');assert.equal(f.state.selected,'newer-step');assert.equal(f.state.inspectorTab,'activity');
});

test('leaving Activity during step inspection prevents a late receipt from selecting a node in Chat', async () => {
  const pending=held(),f=await fixture(()=>pending.promise),originalSelection=f.state.selected;
  const opening=f.openRun('original','workflow',{selectedNodeId:'agent'});f.showMission();pending.resolve(run('original'));await opening;
  assert.equal(f.state.screen,'mission');assert.equal(f.state.selected,originalSelection);assert.equal(f.state.inspectorTab,'configure');
});

test('a delegated child identifier cannot become a fabricated editable workflow node', async () => {
  const actual=run('parent'),f=await fixture(()=>actual);await f.openRun(actual.id,'workflow',{selectedNodeId:'delegate:5:agent:alpha'});
  assert.equal(f.state.currentRun.id,actual.id);assert.equal(f.state.screen,'workflow');assert.ok(f.state.workflow.nodes.some(node=>node.id===f.state.selected));assert.notEqual(f.state.selected,'delegate:5:agent:alpha');assert.equal(f.state.runs.length,2);
});

test('opening a chat cannot roll its live stream back to an older GET response', async () => {
  const pending = held(), f = await fixture(() => pending.promise), a = run('a'); f.state.runs.push(a);
  const opening = f.openRun('a', 'observe');
  f.handleEvent({ data: JSON.stringify({ type: 'agent.event', runId: 'a', nodeId: 'agent', at: '2026-10-16T12:00:01Z', data: { type: 'delta', itemId: 'message', delta: 'Newer actual stream.' } }) });
  pending.resolve(a); await opening;
  assert.equal(f.state.currentRun.id, 'a'); assert.equal(f.state.currentRun.nodes.agent.output, 'Newer actual stream.'); assert.equal(f.state.currentRun.events.length, 1);
});

test('an open request waiting for an autosave cannot overwrite a newer workflow edit or mode', async () => {
  const saving = held(), f = await fixture((url, method) => method === 'POST' ? saving.promise : run('a'));
  f.state.dirty = true; const opening = f.openRun('a', 'observe'); await turn();
  f.showConfigure(); f.state.workflow.name = 'A newer edit made during the save'; f.markDirty();
  saving.resolve(graph('original')); await opening;
  assert.equal(f.state.workflow.name, 'A newer edit made during the save'); assert.equal(f.state.screen, 'configure'); assert.equal(f.state.dirty, true); assert.equal(f.state.currentRun.id, 'original');
});

test('execution receipts refresh freed slot capacity independently of the slower full status request', async () => {
  const f = await fixture(() => ({})); f.state.status.execution = { capacity: 4, activeCount: 4, availableSlots: 0 };
  f.handleEvent({ data: JSON.stringify({ type: 'execution.updated', data: { capacity: 4, activeCount: 1, availableSlots: 3 } }) });
  assert.equal(f.state.status.execution.availableSlots, 3); assert.equal(f.state.status.execution.activeCount, 1); assert.equal(f.runEventGenerations.size, 0);
});

test('chat metadata events refresh the catalog while routine progress leaves drafts and catalogs alone',async()=>{
  const f=await fixture(()=>({}));
  f.state.status.conversations={turns:2,conversations:1};
  const send=(type,data)=>f.handleEvent({data:JSON.stringify({type,data})});
  send('conversations.updated',{turns:2,conversations:1,healthy:true});assert.equal(f.historyRefreshes(),0);
  send('conversations.changed',{rootId:'original',state:'archived',revision:1});assert.equal(f.historyRefreshes(),1);
  send('conversations.updated',{turns:3,conversations:1,healthy:true});assert.equal(f.historyRefreshes(),2);
  assert.equal(f.state.currentRun.id,'original');
});

test('the real continuation handler forwards explicit context and ultra without changing an unrelated view',async()=>{
  const accepted=run('reasoning-reply'),f=await fixture(()=>accepted);
  const context={preset:'900k'};
  await f.continueMissionTask({runId:'original',nodeId:'agent',message:'Use the saved context.',context,effort:'ultra',requestId:'exact-reasoning'});
  const request=f.calls.find(call=>call.url==='/api/runs/original/continue');
  assert.deepEqual(request.body.context,context);assert.equal(request.body.effort,'ultra');assert.equal(request.body.requestId,'exact-reasoning');
});

function workflowRunForm(destination='mission'){
  const fields={'#run-task':{value:'Complete the explicit swarm task'},'#run-cwd':{value:'C:\\chosen-folder',focus(){}},'#run-error':{textContent:''},'button[type=submit]':{disabled:false,textContent:'Start run',innerHTML:''}};
  return{dataset:{destination},querySelector:selector=>fields[selector],fields};
}

test('the actual swarm submit accepts its own working-folder save and opens the accepted conversation',async()=>{
  const accepted=run('swarm-result',graph('original')),f=await fixture((url,method,body)=>url==='/api/workflows'?body:accepted),form=workflowRunForm();f.showConfigure();f.mountRunForm(form);
  await f.submitWorkflowRun(form);
  const starts=f.calls.filter(call=>call.url==='/api/runs');assert.equal(starts.length,1,'the form own markDirty/save does not invalidate admission');assert.equal(starts[0].body.input.cwd,'C:\\chosen-folder');assert.equal(starts[0].body.workflow.settings.cwd,'C:\\chosen-folder');assert.equal(f.state.currentRun.id,'swarm-result');assert.equal(f.state.screen,'mission');assert.deepEqual([...f.openedConversations()],['swarm-result']);assert.equal(f.state.modal,null);
});

test('a newer workflow edit during the swarm form save prevents admission without leaving its form stuck',async()=>{
  const saving=held(),f=await fixture(()=>saving.promise),form=workflowRunForm();f.showConfigure();f.mountRunForm(form);const pending=f.submitWorkflowRun(form);await turn();
  f.state.workflow.name='Newer edit during save';f.markDirty();saving.resolve(f.calls[0].body);await pending;
  assert.equal(f.calls.filter(call=>call.url==='/api/runs').length,0);assert.equal(f.state.workflow.name,'Newer edit during save');assert.equal(f.state.dirty,true);assert.equal(f.state.modal,'run');assert.equal(form.fields['button[type=submit]'].disabled,false);assert.equal(f.openedConversations().length,0);
});

test('a delayed swarm admission is cataloged after navigation without replacing the newer view or submitting twice',async()=>{
  const starting=held(),f=await fixture((url,method,body)=>url==='/api/workflows'?body:starting.promise),form=workflowRunForm();f.showConfigure();f.mountRunForm(form);const pending=f.submitWorkflowRun(form);await turn();await f.submitWorkflowRun(form);assert.equal(f.calls.filter(call=>call.url==='/api/runs').length,1);
  f.showObserve();const accepted=run('background-swarm',graph('original'));starting.resolve(accepted);await pending;
  assert.equal(f.state.screen,'observe');assert.equal(f.state.currentRun.id,'original');assert.ok(f.state.runs.some(item=>item.id==='background-swarm'));assert.equal(f.openedConversations().length,0);
});

test('the ordinary canvas submit retains its workflow destination',async()=>{
  const accepted=run('canvas-result',graph('original')),f=await fixture((url,method,body)=>url==='/api/workflows'?body:accepted),form=workflowRunForm('workflow');f.showWorkflow();f.mountRunForm(form);await f.submitWorkflowRun(form);assert.equal(f.state.screen,'workflow');assert.equal(f.state.currentRun.id,'canvas-result');assert.equal(f.openedConversations().length,0);
});

test('global commands find schedule, swarm and provider setup using everyday search terms',async()=>{
  const f=await fixture(()=>({})),ids=query=>[...f.matchingCommands(query)].map(command=>command.id);
  assert.ok(ids('cron').includes('schedule'));assert.ok(ids('cronjobs').includes('operations'));assert.ok(ids('team').includes('swarm'));
  for(const query of ['API key','OpenRouter','default model','custom endpoint'])assert.ok(ids(query).includes('models-connections'),query);
  assert.ok(ids('preferences').includes('configure'));assert.ok(ids('keyboard').includes('shortcuts'));
  assert.equal(f.calls.length,0,'searching commands does not make requests');
});

test('the initial conversation command list omits canvas tools while a specific search still finds them',async()=>{
  const f=await fixture(()=>({}));
  assert.equal(f.matchingCommands().some(command=>command.studio),false);
  assert.ok(f.matchingCommands('fit').some(command=>command.id==='fit'));
  f.showWorkflow();assert.ok(f.matchingCommands().some(command=>command.id==='fit'));
});

test('command actions open task setup directly without a matching page button or admitting work',async()=>{
  const f=await fixture(()=>({})),selection=f.readSelection(),workflow=structuredClone(f.state.workflow);f.stubCommandActions();
  for(const id of ['schedule','swarm','operations','models-connections']){f.state.modal='commands';await f.executeCommand(id);assert.equal(f.state.modal,id);assert.equal(f.readSelection(),selection);assert.deepEqual(f.state.workflow,workflow);}
  assert.deepEqual([...f.commandActions()],['schedule','swarm','operations','models-connections']);assert.equal(f.calls.length,0);assert.equal(f.openedConversations().length,0);
});

test('chat command search opens the exact result while unrelated commands cannot execute from stale results',async()=>{
  const f=await fixture(()=>({}));f.commandChats([{runId:'chosen',title:'Release checklist',state:'archived'},{runId:'other',title:'Chess project',state:'active'}]);
  f.state.paletteCommands=f.matchingCommands('release');assert.equal(f.state.paletteCommands[0].id,'chat:chosen');
  await f.executeCommand('schedule');assert.equal(f.state.modal,null);assert.equal(f.openedConversations().length,0);
  await f.executeCommand('chat:chosen');assert.deepEqual([...f.openedConversations()],['chosen']);
});

test('opening command search cannot replace an unfinished settings or schedule dialog',async()=>{
  const f=await fixture(()=>({}));for(const modal of ['deployment','swarm','connections']){f.state.modal=modal;f.showCommands();assert.equal(f.state.modal,modal);}
  assert.equal(f.calls.length,0);
});

test('palette keyboard activation respects a tabbed result and arrows follow its focused row',async()=>{
  const f=await fixture(()=>({}));let clicked=-1,prevented=0,controls;
  const rows=[0,1,2].map(index=>({disabled:index===1,closest:()=>rows[index],classList:{toggle(){}},setAttribute(){},scrollIntoView(){},click(){clicked=index;},focus(){controls.focus(this);}}));
  const query={closest:()=>null,setAttribute(){}};controls=f.mountCommandList({rows,query,active:rows[2]});f.state.modal='commands';f.state.paletteIndex=0;
  assert.equal(f.handleCommandKey({key:'Enter',preventDefault(){prevented++;}}),false,'native focused button handles Enter itself');assert.equal(clicked,-1);assert.equal(prevented,0);
  f.handleCommandKey({key:'ArrowDown',preventDefault(){prevented++;}});assert.equal(f.state.paletteIndex,0);assert.equal(controls.active(),rows[0]);
  f.handleCommandKey({key:'ArrowDown',preventDefault(){prevented++;}});assert.equal(f.state.paletteIndex,2,'disabled rows are skipped');assert.equal(controls.active(),rows[2]);
  controls.focus(query);f.handleCommandKey({key:'Enter',preventDefault(){prevented++;}});assert.equal(clicked,2,'Enter in search uses its highlighted result');
});

test('command search ranks titles before descriptive matches and preserves chat relevance and stable ties',async()=>{
  const f=await fixture(()=>({})),ids=query=>[...f.matchingCommands(query)].map(command=>command.id);
  assert.equal(ids('learning')[0],'learning');assert.ok(ids('learning').indexOf('learning')<ids('learning').indexOf('agent-workspace'));
  assert.equal(ids('api')[0],'models-connections');assert.deepEqual(ids('cron'),['operations','schedule'],'the named cronjobs manager outranks a task-creation keyword match');
  assert.equal(ids('file changes')[0],'file-patches');assert.equal(ids('history')[0],'learning','title substring outranks a description-only match');
  for(const query of ['learning','api','cron'])assert.equal(f.matchingCommands(query).some(command=>command.studio),false,query);
  assert.equal(f.matchingCommands().some(command=>command.studio),false);
  f.commandChats([{runId:'most-relevant',title:'Learning release notes',state:'active'},{runId:'next-relevant',title:'Learning checklist',state:'archived'}]);
  assert.deepEqual(ids('learning').filter(id=>id.startsWith('chat:')),['chat:most-relevant','chat:next-relevant']);
  f.state.paletteCommands=f.matchingCommands('checklist');await f.executeCommand('chat:next-relevant');assert.deepEqual([...f.openedConversations()],['next-relevant']);
});



test('workflow run readiness accepts saved native catalog IDs and routing slugs without changing either choice',async()=>{
  const f=await fixture(()=>assert.fail('Readiness must not issue an API request.')),dialogs=[];f.stubRunDialog(dialog=>dialogs.push(dialog));
  f.state.currentRun=null;f.state.runs=[];
  f.state.status={defaultModel:'visible-model',defaultModelAvailable:true,codex:{connected:true,authenticated:true},models:[{id:'visible-model',available:true},{id:'picker-alias',model:'actual-slug',displayName:'Friendly hidden',available:true,hidden:true},{id:'api::ready',providerId:'api',available:true}]};
  f.state.workflow.nodes=[{id:'one',type:'agent',name:'Alias selected',model:'picker-alias'},{id:'two',type:'agent',name:'Routing slug selected',model:'actual-slug'},{id:'three',type:'agent',name:'API selected',model:'api::ready'}];
  const selected=f.state.workflow.nodes.map(node=>node.model);f.showRun();assert.equal(dialogs.at(-1).type,'run');assert.doesNotMatch(dialogs.at(-1).html,/Connect your team's models/);assert.match(dialogs.at(-1).html,/type="submit">/);
  f.state.status.codex.connected=false;f.showRun();assert.match(dialogs.at(-1).html,/Connect your team's models/);assert.match(dialogs.at(-1).html,/Alias selected, Routing slug selected/);assert.match(dialogs.at(-1).html,/type="submit" disabled/);
  assert.deepEqual(f.state.workflow.nodes.map(node=>node.model),selected);assert.equal(f.calls.length,0);
});


test('Stop failures propagate to conversation callers and refresh status without a success toast', async () => {
  const failure = Object.assign(new Error('The Stop request timed out.'), { uncertain: true });
  const f = await fixture(async () => { throw failure; });
  await assert.rejects(f.cancelRun('original', { throwOnError: true }), error => error === failure);
  assert.equal(f.state.currentRun.status, 'running'); assert.equal(f.notices().length, 0); assert.deepEqual([...f.runRefreshes()], ['original']);
  await f.cancelRun('original');
  assert.equal(f.notices().length, 1); assert.equal(f.notices()[0].message, failure.message); assert.equal(f.notices()[0].error, true);
  assert.equal(f.calls.length, 2, 'only explicitly requested Stop attempts may issue a mutation');
});

test('an accepted Stop receipt remains stopping until settlement is actually confirmed', async () => {
  const cancelled = { ...run('original'), status: 'cancelled', settled: false };
  const f = await fixture(async () => cancelled), receipt = await f.cancelRun('original', { throwOnError: true });
  assert.equal(receipt.status, 'cancelled'); assert.equal(receipt.settled, false); assert.equal(f.state.currentRun.settled, false);
  assert.equal(f.notices()[0].message, 'Stop requested.'); assert.deepEqual([...f.runRefreshes()], ['original']);
  assert.deepEqual(f.calls.map(call => [call.url, call.method]), [['/api/runs/original/cancel', 'POST']]);
});

test('a late Stop receipt preserves newer settled evidence and cannot switch a parallel conversation', async () => {
  const pending = held(), f = await fixture(() => pending.promise), original = f.state.currentRun, stopping = f.cancelRun(original.id, { throwOnError: true });
  await turn();
  const other = run('other-conversation'), settled = { ...original, status: 'cancelled', settled: true, nodes: { agent: { status: 'cancelled', output: 'Latest saved work' } } };
  f.state.runs.push(other); f.state.currentRun = other;
  f.handleEvent({ data: JSON.stringify({ type: 'run.updated', runId: original.id, data: settled }) });
  pending.resolve({ ...original, status: 'cancelled', settled: false }); const receipt = await stopping;
  assert.equal(f.state.currentRun.id, other.id); assert.equal(receipt.settled, true); assert.equal(receipt.nodes.agent.output, 'Latest saved work');
  assert.equal(f.state.runs.find(item => item.id === original.id).settled, true); assert.equal(f.notices()[0].message, 'Stopped.');
});
