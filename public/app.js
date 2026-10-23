/* BLACKICE. Runs are always requested explicitly and executed by the local server. */
(async () => {
  'use strict';
  const { WorkflowHistory, diagnoseWorkflow, fitWorkflow, runMetrics, renderMarkdown } = await import('/editor-model.mjs');
  const { createMissionWorkflow, missionModels, modelFailure } = await import('/mission-model.mjs');
  const { runtimeConnectionFeedback } = await import('/composer-helpers.mjs');
  const { reasoningChoices, reasoningLabel } = await import('/reasoning-model.mjs');
  const { runsWithCurrent, reduceRunCollection, adoptFetchedRun, mergeRunSnapshots, selectStartupRun, workspaceActivity } = await import('/run-state-model.mjs');
  const { renderContextFields, readContextFields, renderContextStatus } = await import('/context-ui.mjs');
  const {renderTaskState,bindTaskStateEvents}=await import('/task-state-ui.mjs');
  const { createApiClient } = await import('/api-client.mjs');
  const { writeClipboard, clipboardFailureMessage } = await import('/clipboard.mjs');
  const { createConversationSearch, searchMatchLabel } = await import('/conversation-search.mjs');
  const { safeSvgPreview } = await import('/svg-preview.mjs');
  const { initArtifactUI } = await import('/artifact-ui.mjs');
  const { initPromptsUI } = await import('/prompts-ui.mjs');
  const { taskTitle } = await import('/task-title.mjs');
  const { repeatTaskSeed } = await import('/repeat-task-model.mjs');
  const { workspaceIntegrations } = await import('/workspace-integrations.mjs');
  const editHistory = new WorkflowHistory();
  const $ = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => [...root.querySelectorAll(s)];
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const uid = prefix => `${prefix}_${crypto.randomUUID().slice(0, 12)}`;
  const { iconSymbols: paths, renderIcon: icon } = await import('/icon-symbols.mjs');
  const nodeIcon = type => ({input:'input',agent:'agent',approval:'shield',output:'output'}[type] || 'agent');
  const descriptions = {input:'The task that starts your workflow.',agent:'An autonomous agent with connected tools.',approval:'Pass the result to the next step.',output:'Collect the final workflow result.'};
  const labels = {input:'Workflow input',agent:'Agent',approval:'Checkpoint',output:'Workflow output'};
  const state = {
    workflow:null, workflows:[], runs:[], currentRun:null, selected:'planner', selectedEdge:null,
    status:{connected:false,authenticated:false}, statusLoaded:false, inspectorTab:'configure',
    executionTab:'trace', panelCollapsed:false, view:{x:30,y:60,scale:.85}, connection:null,
    dirty:false,saving:false,saveError:false,modal:null,space:false,drag:null,filter:'',initialFit:false,
    screen:'mission',desktop:{available:null,enabled:false},desktopWindows:[],desktopActions:[],desktopFrame:null,desktopError:'',desktopPending:false,
    traceFilter:null,streamState:'connecting',lastEventAt:null,retrying:false,paletteIndex:0,
    continuing:false,continueNodeId:null,continuationDrafts:{},continuationError:''
  };
  let saveTimer, savePromise, stream, modalPreviousFocus, resizeTimer, desktopTimer, desktopPollVersion=0, paletteSearch=null;
  let streamRetryTimer; const runRefreshTimers = new Map(), runEventGenerations = new Map();
  let viewIntent = 0, workflowEditRevision = 0, subviewIntent = 0;
  const workflowViews = new Map(); let viewWorkflowId = null;
  const beginSubview = () => ({ view: viewIntent, intent: ++subviewIntent });
  const ownsSubview = owner => owner.view === viewIntent && owner.intent === subviewIntent;
  const workspaceMode = screen => ({mission:'view',workflow:'workflow',configure:'configure',planning:'planning'}[screen] || 'observe');
  function focusWorkspaceMode(screen=state.screen){const previous=document.activeElement;requestAnimationFrame(()=>{if(state.screen!==screen||state.modal||document.activeElement!==previous)return;const target=screen==='workflow'?$('#canvas'):$(`#workspace-modes [role="tab"][data-mode="${workspaceMode(screen)}"]`);if(target){if(screen==='workflow')target.tabIndex=-1;target.focus({preventScroll:true});}});}
  function enterWorkspace(screen){
    viewIntent++;subviewIntent++;
    const hadSubview=Boolean(state.modal);if(hadSubview)closeModal({restoreFocus:false});
    const menu=$('.workspace-menu');if(menu)menu.open=false;
    state.screen=screen;state.space=false;desktopPollVersion++;clearTimeout(desktopTimer);renderDesktop();
    if(hadSubview)focusWorkspaceMode(screen);
  }
  function selectWorkspaceMode(mode){const show={view:showMission,observe:showObserve,workflow:showWorkflow,configure:showConfigure,planning:showPlanning}[mode];if(!show)return;show();focusWorkspaceMode();}
  function handleWorkspaceModeKey(event){
    const tab=event.target.closest('[role="tab"][data-mode]');if(!tab)return;
    const tabs=$$('#workspace-modes [role="tab"][data-mode]'),index=tabs.indexOf(tab);let target;
    if(event.key==='ArrowRight')target=tabs[(index+1)%tabs.length];else if(event.key==='ArrowLeft')target=tabs[(index-1+tabs.length)%tabs.length];else if(event.key==='Home')target=tabs[0];else if(event.key==='End')target=tabs.at(-1);else return;
    event.preventDefault();selectWorkspaceMode(target.dataset.mode);
  }
  const conversationSelection = () => { const selected = missionUI?.getSelection?.(); return selected ? JSON.stringify([selected.runId || null, Boolean(selected.forceNew)]) : null; };
  const captureViewOwnership = () => ({ intent: viewIntent, edits: workflowEditRevision, conversation: conversationSelection() });
  const beginViewOperation = () => { viewIntent++; return captureViewOwnership(); };
  const ownsView = owner => owner.intent === viewIntent && owner.edits === workflowEditRevision && owner.conversation === conversationSelection();
  const makeTemplate = (kind = 'software') => {
    const agent = (id,name,role,prompt,x,y,sandbox='danger-full-access') => ({id,type:'agent',name,role,prompt,x,y,model:'default',effort:'default',sandbox});
    let nodes, name, description;
    const input = {id:'input',type:'input',name:'Task input',x:40,y:75};
    const output = {id:'output',type:'output',name:'Final result',x:640,y:330};
    if(kind === 'review') {
      name='Review & refine'; description='Inspect a codebase, independently review findings, and prepare a focused report.';
      nodes=[input,agent('planner','Investigate','Researcher','Inspect the user request and relevant files. Establish the facts, identify constraints, and propose a concrete answer or plan. Use the workspace as evidence. Do not modify files.',340,75),agent('builder','Challenge findings','Reviewer','Independently inspect the upstream findings against the workspace and the original task. Identify factual errors, gaps, and risks. Do not modify files. Provide precise evidence and useful corrections.',640,75),agent('reviewer','Write the report','Editor','Synthesize the upstream investigation and review into a clear, concise final answer to the original task. Distinguish verified facts from assumptions. Include useful file references when available. Do not modify files.',340,330),output];
    } else {
      name='Software delivery'; description='A focused agent team that plans, implements, and reviews your task.';
      nodes=[input,agent('planner','Plan the work','Planner','Inspect the task and relevant workspace files. Produce a practical implementation plan with the problem, scope, concrete steps, and verification strategy. Do not modify files. Pass useful context and file paths to the next agent.',340,75),agent('builder','Build the solution','Builder','Implement the upstream plan for the original task. Inspect the workspace, make focused changes, and run relevant checks. Summarize the implementation, changed files, verification, and any limitations. Do not commit, push, deploy, or publish.',640,75,'danger-full-access'),agent('reviewer','Review & verify','Reviewer','Review the implementation against the original task and upstream plan. Inspect changed files and verify behavior with appropriate checks. Report any remaining issues with precise file references, then provide a concise final summary. Do not modify files.',340,330),output];
    }
    return {id:uid('workflow'),name,description,version:1,nodes,edges:nodes.slice(0,-1).map((n,i)=>({id:uid('edge'),source:n.id,target:nodes[i+1].id})),settings:{cwd:state.status.cwd || '',maxParallel:null}};
  };
  function normalizeWorkflow(workflow){const value=structuredClone(workflow);value.nodes.forEach(node=>{if(node.type==='approval'){node.name='Checkpoint';node.prompt='';}});return value;}
  const asArray = (data, key) => Array.isArray(data) ? data : (data?.[key] || []);
  const api = createApiClient();
  function rememberRunReceipt(incoming, generations) {
    if (!incoming?.id) return incoming;
    const existing = state.currentRun?.id === incoming.id ? state.currentRun : state.runs.find(run => run.id === incoming.id);
    const run = adoptFetchedRun(existing, incoming, { changedSinceRequest: generations ? (runEventGenerations.get(incoming.id) || 0) !== (generations.get(incoming.id) || 0) : false });
    state.runs = mergeRunSnapshots(state.runs, [run], { currentRun: state.currentRun });
    if (state.currentRun?.id === run.id) state.currentRun = state.runs.find(item => item.id === run.id) || run;
    return run;
  }
  const toastMessages=new Map();
  function dismissToast(message){const item=toastMessages.get(message);if(!item)return;clearTimeout(item.timer);item.element.remove();toastMessages.delete(message);}
  function toast(message,error=false){
    const text=String(message??'');
    if(!error)for(const[key,entry]of toastMessages)if(key!==text&&!entry.error)dismissToast(key);
    let item=toastMessages.get(text);
    if(!item){
      // Keep ordinary receipts from stacking over the current action or displacing errors.
      if(toastMessages.size>=3){const oldest=[...toastMessages].find(([,entry])=>!entry.error)||(error?[...toastMessages][0]:null);if(!oldest)return;dismissToast(oldest[0]);}
      const element=document.createElement('div');element.className=`toast${error?' error':''}`;element.textContent=text;$('#toast-root').append(element);item={element,error:Boolean(error),timer:null};toastMessages.set(text,item);
    }else{clearTimeout(item.timer);if(error&&!item.error){item.error=true;item.element.className='toast error';}}
    const timer=setTimeout(()=>{if(toastMessages.get(text)===item&&item.timer===timer)dismissToast(text);},4500);item.timer=timer;
  }
  const busy = () => ['queued','running','waiting'].includes(state.currentRun?.status);
  const selectedNode = () => state.workflow?.nodes.find(n=>n.id===state.selected);
  const nodeRun = id => state.currentRun?.workflowId===state.workflow?.id ? state.currentRun.nodes?.[id] : null;
  const graphIssues = () => diagnoseWorkflow(state.workflow);
  const graphErrors = () => graphIssues().filter(issue=>issue.level==='error');
  const duration = ms => ms==null?'—':ms<1000?'< 1s':ms<60000?`${Math.floor(ms/1000)}s`:`${Math.floor(ms/60000)}m ${Math.floor(ms/1000)%60}s`;
  const errorText = error => typeof error==='string'?error:error?.message||JSON.stringify(error);
  function downloadText(name,text,type='text/plain;charset=utf-8'){const url=URL.createObjectURL(new Blob([text],{type})),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  async function copyText(text){try{await writeClipboard(text);toast('Copied to clipboard.');}catch(error){toast(clipboardFailureMessage(error,'Copy is unavailable here. Select the response and copy it, or use Export.'),true);}}
  function restoreHistory(direction){const workflow=direction==='undo'?editHistory.undo():editHistory.redo();if(!workflow)return;state.workflow=workflow;state.connection=null;state.selectedEdge=null;if(!workflow.nodes.some(n=>n.id===state.selected))state.selected=null;markDirty(null,false);renderAll();}
  function historyControls(){for(const direction of ['undo','redo']){const el=$(`[data-action="${direction}"]`);if(el)el.disabled=direction==='undo'?!editHistory.canUndo:!editHistory.canRedo;}}
  let knowledgeUI,missionUI,learningUI,toolConnectionsUI,filePatchesUI,artifactUI,promptsUI,emailUI,taskMethodUI;
  const workingFolder=()=>state.screen==='mission'?missionUI?.getDraft().cwd||state.status.cwd:state.workflow?.settings?.cwd||state.status.cwd;
  async function showIdentity(){const owner=beginSubview();try{const{openIdentity}=await import('/identity-ui.mjs');if(!ownsSubview(owner))return;await openIdentity({api,showModal,closeModal,toast,escape,icon});}catch(e){if(owner.view===viewIntent)toast(e.message,true);}}
  async function showLearning(options={}){const owner=beginSubview();try{if(!learningUI){const{initLearningUI}=await import('/learning-ui.mjs');if(!ownsSubview(owner))return;learningUI=initLearningUI({api,showModal,closeModal,toast,escape,icon,getCwd:workingFolder,getRuns:()=>state.runs,onOpenRun:id=>openRun(id,'mission')});}if(ownsSubview(owner))await learningUI.open(options);}catch(e){if(owner.view===viewIntent)toast(e.message,true);}}
  async function showToolConnections(){const owner=beginSubview();try{if(!toolConnectionsUI){const{initToolConnectionsUI}=await import('/tool-connections-ui.mjs');if(!ownsSubview(owner))return;toolConnectionsUI=initToolConnectionsUI({api,showModal,closeModal,toast,escape,icon});}if(ownsSubview(owner))await toolConnectionsUI.open();}catch(e){if(owner.view===viewIntent)toast(e.message,true);}}
  function showAgentWorkspace(){
    const cards=workspaceIntegrations(state.status);
    showModal('agent-workspace',`<div class="agent-workspace-hero"><img src="/assets/relay-mark.svg" alt=""><div><h2>A workspace for background work.</h2><p>Plan the task, use connected tools, coordinate specialists and keep a record of the result.</p></div><button class="icon-button modal-close" data-action="close-modal" aria-label="Close dialog">${icon('close',17)}</button></div><div class="agent-workspace-grid priority-workspace-grid">${cards.map(card=>`<button class="agent-workspace-card priority-workspace-card" data-action="${card.action}"><span class="priority-workspace-icon">${icon(card.icon,26)}</span><span><strong>${card.title}</strong><small>${card.description}</small><em class="${card.ready?'available':'setup'}">${escape(card.state)}</em></span></button>`).join('')}</div><div class="agent-workspace-quick"><button class="button" data-action="swarm">${icon('agent',14)}Create a swarm</button><button class="button" data-action="identity">Identity &amp; preferences</button><button class="button" data-action="knowledge">Memory &amp; skills</button><button class="button" data-action="tool-connections">Connected tools</button></div>`,true);
    $('#modal-root .modal')?.classList.add('agent-workspace-modal');
  }
  function showContainedBrowser(){closeModal({restoreFocus:false});showObserve();observeUI?.selectSurface('browser');}
  function showTaskNotes(){return showPlanning({currentTask:true});}

  async function showEmailWorkspace(){const owner=beginSubview();try{if(!emailUI){const{initEmailUI}=await import('/email-ui.mjs');if(!ownsSubview(owner))return;emailUI=initEmailUI({api,showModal,closeModal,toast,escape,icon,onChanged:refreshStatus});}if(ownsSubview(owner))await emailUI.open();}catch(error){if(owner.view===viewIntent)toast(error.message,true);}}
  function showContextSettings(){showModal('context-settings',`${modalHeader('Advanced context capacity','BLACKICE manages routine context compaction automatically. Override a model budget only when necessary.','context')}<form id="mission-context-settings"><div class="agent-context-modal"><img src="/assets/context.svg" alt="">${renderContextFields(missionUI?.getDraft().context||{},{prefix:'mission-context-default'})}<p class="field-help">Changes apply to the next message. Current work keeps its saved settings.</p></div><div class="modal-footer"><button class="button" type="button" data-action="close-modal">Cancel</button><button class="button primary" type="submit">Save context budget</button></div></form>`);}
  async function compactContext(runId,nodeId){try{toast('Creating a continuity checkpoint…');await api(`/api/runs/${encodeURIComponent(runId)}/compact`,'POST',{nodeId});scheduleRunRefresh(runId);toast('Context compacted. The original conversation is retained.');}catch(e){toast(e.message,true);}}
  async function rateMission(runId,value){await api('/api/learning/feedback','POST',{runId,value});toast(value==='good'?'Feedback saved. BLACKICE will review what worked.':'Feedback saved. BLACKICE will review what needs work.');}

  async function showFilePatches(){const owner=beginSubview();try{if(!filePatchesUI){const{initFilePatchesUI}=await import('/file-patches-ui.mjs');if(!ownsSubview(owner))return;filePatchesUI=initFilePatchesUI({api,showModal,closeModal,toast,escape,icon,getCwd:workingFolder,onOpenRun:id=>openRun(id,'mission')});}if(ownsSubview(owner))await filePatchesUI.open();}catch(error){if(owner.view===viewIntent)toast(error.message,true);}}
  async function showKnowledge(){const owner=beginSubview();try{if(!knowledgeUI){const {initKnowledgeUI}=await import('/knowledge-ui.mjs');if(!ownsSubview(owner))return;knowledgeUI=initKnowledgeUI({api,showModal,closeModal,toast,escape,getCwd:()=>state.screen==='mission'?missionUI?.getDraft().cwd||state.status.cwd||'':state.workflow?.settings?.cwd||state.status.cwd||'',icon,onOpenRun:id=>openRun(id,'mission'),onOpenLearning:showLearning});}if(ownsSubview(owner))await knowledgeUI.open();}catch(error){if(owner.view===viewIntent)toast(`Could not open Knowledge: ${error.message}`,true);}}
  async function showConnections(){const owner=beginSubview();try{const {openConnections}=await import('/connections-ui.mjs');if(!ownsSubview(owner))return;await openConnections({api,toast,onChanged:refreshStatus,showModal,closeModal,escape,icon});}catch(error){if(owner.view===viewIntent)toast(`Could not open connections: ${error.message}`,true);}}
  async function showBrowserWorkspace(){const owner=beginSubview();try{const {openBrowserWorkspace}=await import('/browser-ui.mjs');if(!ownsSubview(owner))return;await openBrowserWorkspace({api,toast,showModal,closeModal,escape,icon});}catch(error){if(owner.view===viewIntent)toast(`Could not open browser workspace: ${error.message}`,true);}}
  let observeUI,advancedUI,configureUI,planningUI,planningMountPromise;
  function configureSnapshot(){return{...missionSnapshot(),workflow:state.workflow,workflows:state.workflows,workspace:missionUI?.getDraft().cwd||state.status.cwd,model:'default'};}
  async function showPrompts(options={}){try{showMission();promptsUI ||= initPromptsUI({api,showModal:({body,wide})=>showModal('prompts',body,wide),closeModal,toast,escape,icon,captureDraft:()=>missionUI.capturePromptDraft(),applyDraft:(capture,text)=>missionUI.applyPromptDraft(capture,text),undoDraft:token=>missionUI.undoPromptDraft(token)});return await promptsUI.open(options);}catch(error){toast(error.message,true);}}
  function showRunLimits(){closeModal();showConfigure();configureUI?.showRunLimits();}
  function showConfigure(){enterWorkspace('configure');configureUI?.update();}
  function showChatGPTConnectorSettings(){showConfigure();configureUI?.showConnector();}
  async function mountConfigure(){const{initConfigureUI}=await import('/configure-ui.mjs');configureUI=initConfigureUI({mount:$('#configure-workspace'),getSnapshot:configureSnapshot,api,onBackup:window.relayDesktop?.backupProfile?async()=>{if(state.dirty){await saveWorkflow();if(state.dirty||state.saveError)throw new Error("Save or export the unfinished workflow before backing up the saved profile.");}return window.relayDesktop.backupProfile();}:undefined,onRestore:window.relayDesktop?.restoreProfile?async()=>{if(state.dirty){await saveWorkflow();if(state.dirty||state.saveError)throw new Error("Save or export the unfinished workflow before restoring the profile.");}return window.relayDesktop.restoreProfile();}:undefined,onSupport:async()=>{const data=await api("/api/diagnostics/export");downloadText("BLACKICE-support.json",JSON.stringify(data,null,2),"application/json");return{exported:true};},onExecutionSettings:async()=>{await refreshStatus();missionUI?.update();},onRuntimeSettings:async()=>{await refreshStatus();missionUI?.update();},onChat:({workflowId,stepId}={})=>{showMission();const workflow=state.workflows.find(item=>item.id===workflowId);const step=workflow?.nodes.find(item=>item.id===stepId);missionUI?.prefill(workflow?`Update workflow "${workflow.name}" (ID: ${workflow.id})${step?`, step "${step.name}" (ID: ${step.id})`:""}: `:"");missionUI?.focus();},onConnections:showConnections,onEmail:showEmailWorkspace,onProjects:showProjects,onTaskNotes:showTaskNotes,onWorkspace:async current=>{if(window.relayDesktop?.pickFolder){const folder=await window.relayDesktop.pickFolder(current);if(folder){missionUI?.setWorkspace(folder);configureUI?.update();}}else showWorkspaceSettings();},onAgent:showAgentWorkspace,onLearning:showLearning,onBrowser:showContainedBrowser,onKnowledge:showKnowledge,onDesktop:showDesktop,onCanvas:async id=>{if(id&&id!==state.workflow?.id){const workflow=state.workflows.find(item=>item.id===id);if(workflow)await loadWorkflow(workflow);}showWorkflow();},onSwarm:showSwarm,onSchedule:showSchedule,onOperations:showOperations,onDeploy:showDeployOperation,onSelectWorkflow:async id=>{const workflow=state.workflows.find(item=>item.id===id);if(workflow)await loadWorkflow(workflow);configureUI?.update();},onUpdateWorkflow:async workflow=>{const saved=await api('/api/workflows','POST',workflow);await loadWorkflow(saved.workflow||saved);configureUI?.update();return saved;}});}
  function showWorkspaceSettings(){showModal('workspace-folder',`${modalHeader('Working folder','','folder')}<form id="workspace-folder-form"><label class="field-label" for="workspace-folder-path">Folder path</label><input id="workspace-folder-path" value="${escape(missionUI?.getDraft().cwd||state.status.cwd||'')}" required><div class="modal-footer"><button class="button primary" type="submit">Save folder</button></div></form>`);$('#workspace-folder-form').addEventListener('submit',event=>{event.preventDefault();missionUI?.setWorkspace($('#workspace-folder-path').value);closeModal();configureUI?.update();});}
  async function advanced(){if(!advancedUI){const{initAdvancedUI}=await import('/advanced-ui.mjs');advancedUI=initAdvancedUI({api,showModal,closeModal,toast,escape,icon,getWorkflow:async()=>{if(state.dirty)await saveWorkflow();if(state.saveError)throw new Error('Save the workflow before deploying it.');return structuredClone(state.workflow);},getCwd:()=>missionUI?.getDraft()?.cwd||state.status.cwd,getTaskDefaults:()=>missionUI?.getRequestDraft?.()||missionUI?.getDraft()||{cwd:state.status.cwd},getModels:()=>state.status.models||[],captureOwnership:captureViewOwnership,ownsOwnership:ownsView,onWorkflow:async(workflow,{isCurrent=()=>true,requestTask=false}={})=>{const ownership=captureViewOwnership(),data=await api('/api/workflows','POST',workflow),saved=data.workflow||data;state.workflows=[saved,...state.workflows.filter(item=>item.id!==saved.id)];if(!isCurrent())return false;if(!await loadWorkflow(saved,{ownership})||!isCurrent())return false;if(requestTask){showConfigure();configureUI?.showBasics();showRun({destination:'mission'});}else showWorkflow();return true;},onOpenRun:id=>openRun(id,'observe')});}return advancedUI;}
  async function showOperations(){const owner=beginSubview();try{const ui=await advanced();if(ownsSubview(owner))await ui.openOperations();}catch(error){if(owner.view===viewIntent)toast(error.message,true);}}
  async function showDeployOperation(){const owner=beginSubview();try{const ui=await advanced();if(ownsSubview(owner))await ui.deployWorkflow();}catch(error){if(owner.view===viewIntent)toast(error.message,true);}}
  async function showSchedule(seed){const owner=beginSubview();try{const ui=await advanced();if(ownsSubview(owner))await ui.openSchedule(seed);}catch(error){if(owner.view===viewIntent)toast(error.message,true);}}
  async function repeatMissionTask({runId}={}){
    const ownership=captureViewOwnership();
    try{
      const response=await api('/api/runs/'+encodeURIComponent(runId)),run=response.run||response;
      if(!ownsView(ownership))return;
      if(run.status!=='completed'||run.settled!==true)throw new Error('Wait for this task to finish before making it repeatable.');
      const steps=run.taskState?.steps||[];if(run.taskState?.planVersion===1?run.taskState.progress?.complete!==true:steps.some(step=>step.status!=='done'))throw new Error('Finish the remaining milestones before making this task repeatable.');
      const original=state.runs.find(item=>item.id===(run.taskId||run.id))||(run.taskId&&run.taskId!==run.id?await api('/api/runs/'+encodeURIComponent(run.taskId)):run);
      if(!ownsView(ownership))return;
      const seed=repeatTaskSeed(run,original.run||original);
      const ui=await advanced();if(!ownsView(ownership))return;
      await ui.openSchedule(seed);
    }catch(error){if(ownsView(ownership))toast(error.message,true);}
  }
  async function showSwarm(){const owner=beginSubview();try{const ui=await advanced();if(ownsSubview(owner))ui.openSwarm();}catch(error){if(owner.view===viewIntent)toast(error.message,true);}}
  function renderMode(){const mode=workspaceMode(state.screen),tabs=[...document.querySelectorAll('#workspace-modes [role="tab"][data-mode]')],selected=tabs.find(button=>button.dataset.mode===mode),tabStop=selected||tabs.find(button=>button.tabIndex===0)||tabs[0];for(const button of tabs){button.setAttribute('aria-selected',String(button===selected));button.tabIndex=button===tabStop?0:-1;}const actions=$('#configure-mode-actions');if(actions)actions.hidden=state.screen!=='workflow';observeUI?.update();configureUI?.update();}
  function showObserve(){enterWorkspace('observe');observeUI?.enter();}
  async function mountObserve(){const{initObserveUI}=await import('/observe-ui.mjs');const{createObserveSubscription}=await import('/observe-stream.mjs');observeUI=initObserveUI({mount:$('#observe-workspace'),getSnapshot:missionSnapshot,api,pickBrowserFiles:window.relayDesktop?.pickFiles?()=>window.relayDesktop.pickFiles():null,subscribe:(id,handlers)=>createObserveSubscription(id,handlers),onOpenRun:(id,view='mission')=>id?openRun(id,view):showMission(),onStop:cancelRun,onBrowser:showBrowserWorkspace,onChatGPTSettings:showChatGPTConnectorSettings,onDesktop:showDesktop,onOpenWorkflow:(id,nodeId)=>id?openRun(id,'workflow',{selectedNodeId:nodeId}):undefined,escape,icon});if(state.screen==='observe')observeUI.enter();}
  function rememberPlanReceipt(taskState){
    if(!taskState?.taskId)return;
    for(const run of state.runs)if((run.taskId||run.taskState?.taskId)===taskState.taskId&&(!run.taskState||run.taskState.revision<=taskState.revision))run.taskState=taskState;
    if((state.currentRun?.taskId||state.currentRun?.taskState?.taskId)===taskState.taskId&&(!state.currentRun.taskState||state.currentRun.taskState.revision<=taskState.revision))state.currentRun.taskState=taskState;
    missionUI?.update();observeUI?.update();
  }
  async function showPlanning(options={}){
    const selection=missionUI?.getSelection?.(),taskKey=missionUI?.getWorkbench?.().taskId;
    const runs=state.runs.filter(run=>(run.taskId||run.taskState?.taskId)===taskKey).sort((a,b)=>(b.taskState?.revision||0)-(a.taskState?.revision||0));
    const run=runs[0]||(!selection?.forceNew&&(state.runs.find(run=>run.id===selection?.runId)||state.currentRun));
    const seed=options.taskId||options.taskState?options:(options.currentTask||!planningUI)&&run?.taskState?{taskId:run.taskState.taskId,taskState:run.taskState,runId:run.id,runStatus:run.status}:{};
    enterWorkspace('planning');const owner=viewIntent;
    try{
      if(!planningUI){
        planningMountPromise ||= import('/planning-workspace-ui.mjs');
        const {initPlanningWorkspaceUI}=await planningMountPromise;if(owner!==viewIntent||state.screen!=='planning')return;
        planningUI ||= initPlanningWorkspaceUI({mount:$('#planning-workspace'),api,onArtifact:showArtifact,onSaved:rememberPlanReceipt,onError:error=>toast(error.message,true),onManagePlan:(action,taskId,runId)=>missionUI?.managePlan(action,taskId,runId),onOpenRun:async id=>{showMission();await missionUI?.openConversation(id);},onNewChat:()=>{showMission();$('#mission-workspace [data-mission-action="new-task"]')?.click();missionUI?.focus();}});
      }
      if(owner===viewIntent&&state.screen==='planning')await planningUI.enter(seed);
    }catch(error){planningMountPromise=null;if(owner===viewIntent)toast(`Could not open Planning: ${error.message}`,true);}
  }

  let projectsUI;
  async function showProjects(options={}){const owner=beginSubview();try{if(!projectsUI){const{initProjectsUI}=await import('/projects-ui.mjs');if(!ownsSubview(owner))return;projectsUI=initProjectsUI({api,showModal,closeModal,toast,escape,icon,getCwd:workingFolder,getModels:selected=>missionModels(state.status,selected),onOpenPlanning:showPlanning,onOpenRun:id=>missionUI?.openConversation(id),onDraftInChat:({prompt})=>{closeModal();showMission();const existing=missionUI?.getDraft()?.task||'';missionUI?.prefill(existing.trim()?existing+'\n\n'+prompt:prompt,{replace:true});missionUI?.focus();},onOpenCanvas:()=>{closeModal();showWorkflow();}});}if(ownsSubview(owner))await projectsUI.open(options);}catch(error){if(owner.view===viewIntent)toast(error.message,true);}}
  let inboxUI;
  async function showInbox(options={}) {
    const owner=beginSubview();
    try {
      if(state.dirty) await saveWorkflow();
      if(!ownsSubview(owner))return;
      if(state.saveError) throw new Error('Save your Studio changes before opening another task.');
      if(!inboxUI){const{initInboxUI}=await import('/inbox-ui.mjs');if(!ownsSubview(owner))return;inboxUI=initInboxUI({api,showModal,closeModal,toast,escape,icon,getCwd:workingFolder,getDraft:()=>missionInboxDraft(),onOpenRun:id=>missionUI?.openConversation(id),onRunStarted:adoptInboxRun,onOpenOperations:showOperations});}
      if(ownsSubview(owner))await inboxUI.open(options);
    } catch(error){if(owner.view===viewIntent)toast(error.message,true);}
  }
  function missionInboxDraft(config=missionUI?.getRequestDraft?.()||missionUI?.getDraft()||{}) {
    const task=String(config.task||'').trim();
    return {input:task,title:taskTitle(task,{max:80}),cwd:config.cwd||workingFolder(),workflow:createMissionWorkflow({...config,task,id:config.enqueueKey?`queue-${config.enqueueKey}`:uid('mission')}),attachmentIds:[...(config.attachmentIds||[])]};
  }
  async function queueMissionTask(config) { const item = await api('/api/inbox/queue','POST',{...missionInboxDraft(config),enqueueKey:config.enqueueKey}); await refreshStatus(); return item; }
  async function captureMissionTask(config) {
    const item=await api('/api/inbox','POST',missionInboxDraft(config));
    await refreshStatus();return item;
  }
  async function adoptInboxRun(run, { isCurrent = () => true } = {}) {
    const ownership=isCurrent()?beginViewOperation():null,generations=new Map(runEventGenerations);
    run=rememberRunReceipt(await api(`/api/runs/${encodeURIComponent(run.id)}`),generations);
    if(!ownership||!isCurrent()||!ownsView(ownership))return run;
    const graph=run.workflow;
    state.workflow=normalizeWorkflow(graph);editHistory.reset(state.workflow);
    const found=state.workflows.findIndex(item=>item.id===graph.id);if(found>=0)state.workflows[found]=graph;else state.workflows.unshift(graph);
    state.currentRun=run;state.runs=state.runs.filter(item=>item.id!==run.id);state.runs.unshift(run);
    state.selected=graph.nodes.find(node=>node.type==='agent')?.id||null;state.selectedEdge=null;state.traceFilter=null;state.dirty=false;state.executionTab='trace';state.panelCollapsed=false;
    closeModal();showMission();renderAll();await missionUI?.openConversation(run.id);refreshRuns();return run;
  }
  async function showArtifact({taskId,artifactId}) {
    artifactUI ||= initArtifactUI({api,showModal,closeModal,escape,icon,renderMarkdown,safeSvgPreview,captureOwnership:captureViewOwnership,ownsOwnership:ownsView,...(window.relayDesktop?.openArtifact?{openNative:value=>window.relayDesktop.openArtifact(value)}:{})});
    return artifactUI.open({taskId,artifactId});
  }

  function missionSnapshot(){return{status:state.status,desktop:state.desktop,statusLoaded:state.statusLoaded,runs:runsWithCurrent(state.runs,state.currentRun),currentRun:state.currentRun,streamState:state.streamState};}
  async function startMissionTask(config){
    const ownership=beginViewOperation(),generations=new Map(runEventGenerations);
    if(config.desktop&&!state.desktop.enabled)state.desktop=desktopStatus(await api('/api/desktop/attach','POST',{}));
    const workflow=createMissionWorkflow({...config,id:config.requestId?`mission_${config.requestId}`:uid('mission')}),saved=await api('/api/workflows','POST',workflow),graph=saved.workflow||saved;
    const response=await api('/api/runs','POST',{workflow:graph,input:{task:config.task,cwd:config.cwd,attachmentIds:config.attachmentIds||[],...(config.planDetail?{planDetail:config.planDetail}:{}),...(config.planningMode?{planningMode:config.planningMode}:{})},...(config.requestId?{requestId:config.requestId}:{})}),run=rememberRunReceipt(response.run||response,generations),savedGraph=normalizeWorkflow(run.workflow||graph);
    state.workflows=[savedGraph,...state.workflows.filter(item=>item.id!==savedGraph.id)];
    if(ownsView(ownership)){if(!state.dirty){state.workflow=savedGraph;editHistory.reset(state.workflow);state.selected='agent';state.selectedEdge=null;}state.currentRun=run;state.traceFilter=null;state.executionTab='trace';state.panelCollapsed=false;renderAll();}
    else renderStreamState();
    refreshRuns();return run;
  }
  async function continueMissionTask({runId,nodeId,message,attachmentIds,model,context,effort,planDetail,planningMode,requestId}){
    const ownership=beginViewOperation(),generations=new Map(runEventGenerations),response=await api(`/api/runs/${encodeURIComponent(runId)}/continue`,'POST',{nodeId,message,...(requestId?{requestId}:{}),...(model?{model}:{}),...(context!==undefined?{context}:{}),...(effort!==undefined?{effort}:{}),...(planDetail!==undefined?{planDetail}:{}),...(planningMode!==undefined?{planningMode}:{}),...(attachmentIds?{attachmentIds}:{})}),run=rememberRunReceipt(response.run||response,generations);
    if(ownsView(ownership)){state.currentRun=run;state.selected=nodeId;state.traceFilter=null;state.executionTab='trace';state.panelCollapsed=false;renderAll();}else renderStreamState();
    refreshRuns();return run;
  }
  async function mountMission(){const{initMissionUI}=await import('/mission-ui.mjs');missionUI=initMissionUI({mount:$('#mission-workspace'),getSnapshot:missionSnapshot,onStart:startMissionTask,onQueue:queueMissionTask,onStopAll:stopAllChats,onCapture:captureMissionTask,onInbox:showInbox,onArtifact:showArtifact,api,pickFiles:window.relayDesktop?.pickFiles?()=>window.relayDesktop.pickFiles():null,onOpenRun:id=>openRun(id,'mission',{selectConversation:false}),onContinue:continueMissionTask,onRetry:retryRun,onStop:cancelRun,onDirect:showDirection,onStudio:id=>id?openRun(id,'workflow'):showWorkflow(),onConnections:showConnections,onProjects:showProjects,onOpenPlanning:showPlanning,onRunLimits:showRunLimits,onPrompts:()=>showPrompts(),onSavePrompt:()=>showPrompts({saveCurrent:true}),onSchedule:showSchedule,onRepeatTask:repeatMissionTask,onSwarm:showSwarm,onAgent:showAgentWorkspace,onLearning:showLearning,onCompact:compactContext,onFeedback:rateMission,onBrowser:showBrowserWorkspace,onObserve:()=>{closeModal();showObserve();},onOpenBrowserOS:()=>api('/api/browseros/show','POST',{}),onKnowledge:showKnowledge,onDesktop:showDesktop,onCopy:copyText,pickFolder:window.relayDesktop?.pickFolder?value=>window.relayDesktop.pickFolder(value):null,escape,icon,toast});}
  function effortsFor(node){return reasoningChoices(state.status,node?.model||'default',node?.effort||'default').map(option=>option.value);}
  function shell(){
    $('#app').innerHTML=`
      <nav class="rail" aria-label="Main navigation">
        <button class="brand-mark" data-action="home" title="BLACKICE" aria-label="BLACKICE"><img src="/assets/relay-mark.svg" width="23" height="23" alt=""></button>
        <button class="rail-button active" data-action="library" title="Workflow builder" aria-label="Workflow builder">${icon('workflow',21)}</button>
        <button class="rail-button" data-action="desktop" title="Agent desktop" aria-label="Agent desktop">${icon('desktop',21)}<span class="rail-presence" id="desktop-presence" hidden></span></button>
        <button class="rail-button" data-action="history" title="Run history" aria-label="Run history">${icon('clock',20)}</button>
        <button class="rail-button" data-action="runtime" title="Codex runtime" aria-label="Codex runtime">${icon('terminal',21)}</button>
        <div class="rail-separator"></div><button class="rail-button" data-action="templates" title="Workflow templates" aria-label="Workflow templates">${icon('layers',20)}</button>
        <div class="rail-spacer"></div><button class="rail-button" data-action="shortcuts" title="Keyboard shortcuts" aria-label="Keyboard shortcuts">${icon('keyboard',19)}</button>
        <button class="rail-button" data-action="runtime" title="Runtime settings" aria-label="Runtime settings">${icon('settings',20)}</button>
        <div class="rail-avatar" title="Local workspace">L</div>
      </nav>
      <header class="topbar">
        <div class="crumb"><span class="product-name">BLACKICE</span><span class="desktop-app-badge"${window.relayDesktop?'':' hidden'}>DESKTOP</span>${icon('chevron',11)}</div>
        <div class="workflow-heading"><input id="workflow-name" aria-label="Workflow name" maxlength="100"><div class="save-state" id="save-state"></div></div>
        <div class="topbar-fill"></div><button class="runtime-pill" data-action="runtime" id="runtime-pill" aria-label="View model connections"></button>
        <div class="top-divider"></div><button class="button template-button" data-action="templates">${icon('layers',13)}<span class="button-text">Templates</span></button>
        <button class="button save-button" data-action="save" aria-label="Save workflow">${icon('save',13)} Save</button>
        <button class="button primary run-button" data-action="run" id="run-button">${icon('play',13)}<span class="button-text">Run workflow</span><span class="shortcut">⌘ ↵</span></button>
      </header>
      <aside class="library" aria-label="Node library">
        <div class="library-top"><div class="section-eyebrow">Your workspace</div><div class="workspace-picker"><select id="workflow-picker" aria-label="Select workflow"></select><button class="icon-button" data-action="new-workflow" aria-label="Create workflow" title="Create workflow">${icon('plus',16)}</button></div><hr class="library-divider"><div class="library-heading"><strong>Node library</strong><span class="badge">3 nodes</span></div><label class="search-field">${icon('search',13)}<input id="node-search" placeholder="Find a node…" aria-label="Search node library"></label></div>
        <div class="library-content"><div class="library-category">Building blocks</div><div id="node-library"></div><div class="template-group"><div class="library-category">Quick start</div><button class="template-link" data-action="template" data-kind="software">${icon('code',13)}<span>Software delivery</span>${icon('chevron',11)}</button><button class="template-link" data-action="template" data-kind="review">${icon('search',13)}<span>Review & refine</span>${icon('chevron',11)}</button></div><div class="template-group"><button class="template-link" data-action="import">${icon('upload',13)}<span>Import workflow</span></button><button class="template-link" data-action="export">${icon('download',13)}<span>Export workflow</span></button></div></div>
        <div class="library-note">${icon('terminal',16)}<div><strong>Local execution</strong><p id="workspace-path">Connecting to your Codex runtime…</p><div class="local-state" id="local-state"></div></div></div>
      </aside>
      <main class="main"><div id="canvas" class="canvas" tabindex="0" aria-label="Workflow canvas. Select nodes to configure. Drag nodes to move them."><div class="canvas-toolbar"><div class="canvas-label">${icon('workflow',13)}<strong>Workflow canvas</strong><span class="canvas-tag">EDIT MODE</span></div><div class="canvas-toolbar-actions"><button class="icon-button" data-action="workflow-settings" title="Workflow settings" aria-label="Workflow settings">${icon('settings',14)}</button><button class="icon-button" data-action="auto-layout" title="Arrange nodes" aria-label="Arrange nodes">${icon('grid',14)}</button><button class="icon-button" data-action="export" title="Export workflow" aria-label="Export workflow">${icon('download',14)}</button></div></div><div class="canvas-summary" id="canvas-summary"></div><div id="world" class="world"><svg id="edges" class="edges" aria-label="Workflow connections"></svg><div id="graph-nodes"></div></div><div id="connect-banner" class="connect-banner hidden"></div><div class="canvas-bottom"><div class="canvas-help">${icon('move',11)} Drag nodes to arrange <span>·</span> Scroll to pan</div><div class="zoom-controls"><button class="icon-button" data-action="zoom-out" aria-label="Zoom out" title="Zoom out">${icon('minus',13)}</button><button class="zoom-level" data-action="reset-zoom" id="zoom-level" aria-label="Reset zoom">100%</button><button class="icon-button" data-action="zoom-in" aria-label="Zoom in" title="Zoom in">${icon('plus',13)}</button><div style="height:15px;width:1px;background:#252525;margin:0 3px"></div><button class="icon-button" data-action="fit" aria-label="Fit workflow to canvas" title="Fit workflow">${icon('fit',14)}</button></div></div></div>
        <section class="execution" id="execution" aria-label="Workflow execution"><div class="execution-top"><div class="execution-title">${icon('terminal',14)}Execution<span id="execution-status" class="badge">Ready</span></div><div class="execution-tabs"><button class="execution-tab active" data-action="execution-tab" data-tab="trace">Trace</button><button class="execution-tab" data-action="execution-tab" data-tab="output">Output</button><button class="execution-tab" data-action="execution-tab" data-tab="history">History</button></div><div class="execution-fill"></div><span class="execution-run-label" id="execution-run-label"></span><button class="icon-button" id="stop-button" data-action="cancel" title="Stop current run" aria-label="Stop current run" hidden>${icon('stop',12)}</button><button class="icon-button" id="panel-toggle" data-action="toggle-panel" title="Collapse execution" aria-label="Collapse execution">${icon('down',14)}</button></div><div class="execution-body" id="execution-body"></div></section>
      </main>
      <aside class="inspector" id="inspector" aria-label="Node inspector"><div class="inspector-heading"><strong id="inspector-title">Node settings</strong><div style="display:flex;gap:4px"><button class="icon-button" data-action="duplicate" id="duplicate-node" title="Duplicate node" aria-label="Duplicate node">${icon('copy',13)}</button><button class="icon-button inspector-close" data-action="close-inspector" aria-label="Close inspector">${icon('close',14)}</button></div></div><div class="inspector-tabs"><button class="inspector-tab active" data-action="inspector-tab" data-tab="configure">Configure</button><button class="inspector-tab" data-action="inspector-tab" data-tab="activity">Activity</button></div><div class="inspector-body" id="inspector-body"></div><div class="inspector-footer" id="inspector-footer"></div></aside>`;
    $('#app').insertAdjacentHTML('beforeend',`<section class="desktop-workspace hidden" id="desktop-workspace" aria-label="Agent desktop">
      <div class="desktop-heading"><div><div class="section-eyebrow">CONNECTED ENVIRONMENT</div><h1>Desktop inspection <span class="badge">READ ONLY</span></h1><p>Inspect existing windows. Use the contained browser and dedicated text editor for background work.</p></div><div class="desktop-heading-actions"><button class="button primary" id="desktop-attach" data-action="attach-desktop">${icon('link',14)}Attach desktop</button><button class="button danger" id="desktop-detach" data-action="detach-desktop" title="Disconnect desktop (Ctrl+Alt+Esc)" hidden>${icon('stop',13)}Detach & stop</button></div></div>
      <div id="desktop-error" class="desktop-error hidden" role="status"></div>
      <div class="desktop-layout"><div class="desktop-preview-panel"><div class="desktop-panel-heading"><span class="desktop-live-label"><span id="desktop-status-dot" class="status-dot"></span><strong id="desktop-status-label">Desktop detached</strong></span><div class="desktop-preview-actions"><span id="desktop-frame-meta">Preview paused</span><button class="icon-button" data-action="refresh-desktop" title="Refresh desktop status" aria-label="Refresh desktop status">${icon('refresh',14)}</button><button class="icon-button" data-action="expand-desktop" id="desktop-expand" title="Expand desktop preview" aria-label="Expand desktop preview" disabled>${icon('fit',15)}</button></div></div>
      <div class="desktop-stage" id="desktop-stage"><img id="desktop-frame" class="hidden" alt="Live view of your attached Windows desktop"><div class="desktop-placeholder" id="desktop-placeholder"><div class="desktop-placeholder-visual"><span>${icon('desktop',38)}</span><i>${icon('agent',19)}</i></div><h2>Read existing Windows controls.</h2><p>Agents can inspect accessible windows. General Windows app input is unavailable.</p><button class="button primary large" id="desktop-empty-attach" data-action="attach-desktop">${icon('link',14)}Attach Windows desktop</button><small>Inspection requires accessible controls. Use the contained browser for web actions.</small></div></div>
      <div class="desktop-preview-footer"><span>${icon('eye',13)}<span id="desktop-preview-note">Screen capture starts when you attach.</span></span></div></div>
      <aside class="desktop-sidebar"><section class="desktop-card"><div class="desktop-card-heading"><h2>${icon('layers',15)}Open windows</h2><span class="badge" id="desktop-window-count">—</span></div><div id="desktop-windows" class="desktop-window-list"><div class="desktop-side-empty">Connect your desktop to see open windows.</div></div></section><section class="desktop-card desktop-activity-card"><div class="desktop-card-heading"><h2>${icon('clock',15)}Agent activity</h2><span class="badge" id="desktop-action-count">0</span></div><div id="desktop-actions" class="desktop-action-list"><div class="desktop-side-empty">Desktop observations and actions appear here as agents work.</div></div></section><div class="desktop-access-note">${icon('agent',17)}<div><strong>Built for desktop agents</strong><p>Inspect app controls, then use their supported actions. Coordinate input is unavailable.</p></div></div></aside></div>
      <div class="desktop-bottom"><span><span class="status-dot connected"></span>Windows accessibility · background app controls</span><button class="button subtle" data-action="workflow">${icon('workflow',13)}Back to workflow</button></div>
    </section>`);
    if(window.relayDesktop){document.body.classList.add('native-shell');document.body.insertAdjacentHTML('afterbegin','<div class="native-titlebar"><span>BLACKICE</span><span class="native-titlebar-context">Autonomous console</span></div>');}
    if(window.relayDesktop) $('.native-titlebar-context').textContent = `Autonomous console · ${window.relayDesktop.version}`;
    $('.canvas-toolbar-actions').insertAdjacentHTML('afterbegin',`<div class="editor-history-controls"><button class="icon-button" data-action="undo" aria-label="Undo edit" title="Undo (Ctrl+Z)" disabled>${icon('undo',14)}</button><button class="icon-button" data-action="redo" aria-label="Redo edit" title="Redo (Ctrl+Shift+Z)" disabled>${icon('redo',14)}</button></div>`);
    $('.topbar-fill').insertAdjacentHTML('beforebegin',`<button class="button command-trigger" data-action="commands" aria-label="Open command palette" title="Commands (Ctrl+K)">${icon('search',13)}<span>Commands</span><kbd>Ctrl K</kbd></button>`);
    $('.rail-button[data-action="history"]').insertAdjacentHTML('beforebegin',`<button class="rail-button" data-action="inbox" title="Saved tasks and queue" aria-label="Task inbox">${icon('inbox',20)}</button>`);
    $('.rail-button[data-action="runtime"]').insertAdjacentHTML('beforebegin',`<button class="rail-button" data-action="agent-workspace" title="Your agent" aria-label="Your agent">${icon('identity',20)}</button>`);
    $('.rail-button[data-action="history"]').insertAdjacentHTML('afterend',`<button class="rail-button" data-action="knowledge" title="Knowledge and skills" aria-label="Knowledge and skills">${icon('book',20)}</button>`);
    $('.brand-mark').insertAdjacentHTML('afterend',`<button class="rail-button active" data-action="mission" title="Mission — one task at a time" aria-label="Mission home">${icon('spark',21)}</button>`);
    $('.rail-button[data-action="library"]').title='Studio — advanced workflows';$('.rail-button[data-action="library"]').setAttribute('aria-label','Studio — advanced workflows');
    $('.library-content').insertAdjacentHTML('beforeend',`<div class="template-group"><div class="library-category">Connections</div><button class="template-link" data-action="models-connections">${icon('settings',13)}<span>Models & connections</span></button><button class="template-link" data-action="browser-workspace">${icon('grid',13)}<span>Browser workspace</span></button></div>`);
    $('#app').insertAdjacentHTML('beforeend','<section id="mission-workspace" class="mission-workspace" aria-label="Mission workspace"></section>');
    $('#run-button').setAttribute('aria-label','Run workflow');
    $('#execution').insertAdjacentHTML('afterbegin','<div id="execution-overview" class="execution-overview" hidden></div>');
    $('.execution-top').insertAdjacentHTML('beforeend','<span id="stream-state" class="stream-state" role="status" aria-live="polite"></span>');
    $('#app').insertAdjacentHTML('beforeend','<section id="observe-workspace" class="observe-workspace" aria-label="Observe agents" hidden></section>');
    $('#app').insertAdjacentHTML('beforeend','<section id="planning-workspace" class="planning-workspace" aria-label="Planning workspace" hidden></section>');
    $('#app').insertAdjacentHTML('beforeend','<section id="configure-workspace" class="configure-workspace" aria-label="BLACKICE setup" hidden></section>');
    $('#app').insertAdjacentHTML('beforebegin',`<header id="workspace-modes"><span class="workspace-mode-brand"><img src="/assets/relay-mark.svg" alt=""><span class="workspace-wordmark"><img src="/assets/blackice-wordmark.svg" alt="" aria-hidden="true" width="137" height="18"><span class="workspace-wordmark-label">BLACKICE</span></span><span class="workspace-brand-meta">BACKGROUND WORKSPACE</span></span><nav role="tablist" aria-label="Workspace mode"><button role="tab" data-mode="view" aria-selected="true" tabindex="0">${icon('agent',15)}<span class="workspace-tab-label">Chat</span></button><button role="tab" data-mode="observe" aria-selected="false" tabindex="-1">${icon('eye',15)}<span class="workspace-tab-label">Activity</span></button><button role="tab" data-mode="planning" aria-selected="false" tabindex="-1">${icon('plan',15)}<span class="workspace-tab-label">Planning</span></button><button role="tab" data-mode="configure" aria-selected="false" tabindex="-1">${icon('settings',15)}<span class="workspace-tab-label">Settings</span></button></nav><div id="configure-mode-actions" hidden><button data-action="projects">Saved swarms</button><button data-action="operations">Schedules</button><button data-action="deploy-operation">Schedule workflow</button></div><div class="workspace-mode-spacer"></div><button class="workspace-search" data-action="commands" aria-label="Search chats and commands" title="Search chats and commands · Ctrl+K">${icon('search',15)}</button><button class="workspace-models" data-action="models-connections" aria-label="Models and APIs" title="Models & APIs · Ctrl+M">${icon('connections',15)}<span>Models</span></button><button id="workspace-health" class="workspace-health" data-action="workspace-health" aria-live="polite"></button><details class="workspace-menu"><summary aria-label="Workspace menu">${icon('more',16)}</summary><div><span class="workspace-menu-label">Workspace</span><button data-action="projects">Swarms</button><button data-action="planning">Planning workspace</button><button data-action="operations">Schedules &amp; cronjobs</button><button data-action="inbox">Task inbox</button><button data-action="prompts">Prompt outlines</button><button data-action="file-patches">File changes</button><span class="workspace-menu-label">Connections &amp; tools</span><button data-action="models-connections">Models</button><button data-action="email">Email setup &amp; drafts</button><button data-action="browser-workspace">Browser</button><button data-action="agent-workspace">Agent workspace</button><button data-action="knowledge">Memory &amp; skills</button><span class="workspace-menu-label">Advanced</span><button data-action="workflow">Workflow canvas</button><button data-action="swarm">Create a swarm</button><button data-action="deploy-operation">Schedule this workflow</button><button data-action="run-limits">Time limits</button><button data-action="learning">Learning history</button><button data-action="shortcuts">Keyboard shortcuts</button></div></details></header>`);
    $('#workspace-modes').addEventListener('click',event=>{const mode=event.target.closest('[data-mode]')?.dataset.mode;if(mode)selectWorkspaceMode(mode);if(event.target.closest('[data-action]')){const menu=$('.workspace-menu');if(menu)menu.open=false;}});
    $('#workspace-modes').addEventListener('keydown',handleWorkspaceModeKey);
    mountObserve().catch(error=>toast(error.message,true));
    mountConfigure().catch(error=>toast(error.message,true));
    renderLibrary();
  }
  function renderLibrary(){
    $('#node-library').innerHTML=Object.keys(labels).filter(type=>type!=='approval').filter(type=>`${labels[type]} ${descriptions[type]}`.toLowerCase().includes(state.filter.toLowerCase())).map(type=>`<button class="library-node" data-action="add-node" data-type="${type}" title="Add ${labels[type].toLowerCase()}"><span class="node-icon ${type}">${icon(nodeIcon(type),16)}</span><span class="library-node-text"><strong>${labels[type]}</strong><span>${type==='agent'?'Think, build, and take action':type==='input'?'Define the starting point':'Deliver the final result'}</span></span><span class="library-add">+</span></button>`).join('') || '<p class="field-help">No matching nodes.</p>';
  }
  function renderHeader(){
    if(document.activeElement!==$('#workflow-name')) $('#workflow-name').value=state.workflow?.name || '';
    const choices=[...state.workflows];if(state.workflow&&!choices.some(w=>w.id===state.workflow.id))choices.unshift(state.workflow);
    $('#workflow-picker').innerHTML=choices.map(w=>`<option value="${escape(w.id)}"${w.id===state.workflow?.id?' selected':''}>${escape(w.name)}</option>`).join('');
    $('#save-state').innerHTML=`${icon(state.saveError?'info':state.saving?'refresh':'check',9)}${state.saveError?'Couldn’t save · retry':state.saving?'Saving changes…':state.dirty?'Unsaved changes':'All changes saved'}`;
    const ok=state.status.connected&&state.status.authenticated,connection=runtimeConnectionFeedback({statusLoaded:state.statusLoaded,status:state.status});
    const label=connection?.title||(!state.statusLoaded?'Connecting…':ok?'Models connected':state.status.connected?'Sign in required':'Runtime offline');
    $('#runtime-pill').innerHTML=`<span class="${connection?.busy?'connection-progress-spinner':`status-dot ${ok?'connected':state.statusLoaded?'error':''}`}" aria-hidden="true"></span><span class="runtime-label">${escape(label)}</span>${icon('down',10)}`;
    $('#runtime-pill').setAttribute('aria-busy',String(Boolean(connection?.busy)));$('#runtime-pill').title=connection?.detail||'';
    $('#workspace-path').textContent=state.workflow?.settings?.cwd||state.status.cwd||'Set a workspace before running.';
    $('#local-state').innerHTML=`<span class="status-dot ${ok?'connected':''}"></span>${escape(connection?.title||(ok?'Connected model runtime':state.statusLoaded?'Waiting for runtime':'Connecting'))}`;
    $('#run-button').innerHTML=busy()?`${icon('clock',13)}<span class="button-text">Run in progress</span>`:`${icon('play',13)}<span class="button-text">Run workflow</span><span class="shortcut">${navigator.platform?.toLowerCase().includes('mac')?'⌘':'Ctrl'} ↵</span>`;
    $('#run-button').disabled=busy();
    historyControls();renderStreamState();scheduleLiveViews();
  }
  function renderGraph(){
    if(!state.workflow)return;
    syncWorkflowView();
    const nodes=state.workflow.nodes,issues=graphIssues();
    $('#graph-nodes').innerHTML=nodes.map((node,i)=>{
      const run=nodeRun(node.id), type=['input','agent','approval','output'].includes(node.type)?node.type:'agent', status=run?.status;
      const desc=type==='agent' ? node.prompt : type==='approval' ? descriptions.approval : descriptions[type];
      const nodeIssues=issues.filter(issue=>issue.nodeId===node.id),reportedStatus=run?.reused?'reused':status==='queued'&&run.blockedBy?.length?'waiting':status;
      return `<article class="graph-node ${type}${state.selected===node.id?' selected':''}${nodeIssues.length?' has-issues':''}" style="transform:translate(${Number(node.x)||0}px,${Number(node.y)||0}px)" data-node="${escape(node.id)}" data-status="${escape(status||'idle')}" tabindex="0" role="group" aria-label="${escape(node.name)}, ${labels[type]||type}${status?', '+escape(status):''}${nodeIssues.length?', needs configuration':''}">
        ${i===0?'<span class="node-step">Start your workflow</span>':''}<div class="node-top"><span class="node-icon ${type}">${icon(nodeIcon(type),16)}</span><div class="node-headings"><strong>${escape(node.name)}</strong><span>${escape(type==='agent'?node.role||'Agent':labels[type])}</span></div><button class="node-menu" data-action="select-node" data-id="${escape(node.id)}" aria-label="Configure ${escape(node.name)}">${icon('more',14)}</button></div>
        <div class="node-body"><p class="node-description">${escape(desc)}</p><div class="node-footer"><span class="node-mini-pill">${type==='agent'?escape(node.desktop?'Windows app controls':node.model==='default'?'Codex · default model':node.model):type==='input'?'User-defined task':type==='approval'?'Checkpoint':'Final response'}</span><span class="node-status"${nodeIssues.length?` title="${escape(nodeIssues[0].message)}"`:''}><span class="status-dot"></span>${escape(reportedStatus?reportedStatus.charAt(0).toUpperCase()+reportedStatus.slice(1):nodeIssues.length?'Incomplete':type==='agent'?'Ready':'Configured')}</span></div></div>
        ${type!=='input'?`<button class="port in" data-port="in" data-node-id="${escape(node.id)}" aria-label="Connect to ${escape(node.name)} input" title="Connect to this node"></button>`:''}${type!=='output'?`<button class="port out${state.connection===node.id?' connecting':''}" data-port="out" data-node-id="${escape(node.id)}" aria-label="Connect from ${escape(node.name)} output" title="Start a connection"></button>`:''}</article>`;
    }).join('');
    renderEdges();applyView();
    $('.canvas-empty')?.remove();
    if(!nodes.length)$('#canvas').insertAdjacentHTML('beforeend',`<div class="canvas-empty"><span class="node-icon">${icon('workflow',26)}</span><h2>Build your next agent team.</h2><p>Start with a proven workflow, or connect your own steps.</p><div><button class="button primary" data-action="templates">${icon('layers',14)}Choose a template</button><button class="button" data-action="add-node" data-type="agent">${icon('plus',14)}Add an agent</button></div></div>`);
    const errors=issues.filter(issue=>issue.level==='error');
    $('#canvas-summary').innerHTML=`<span>${nodes.length} nodes · ${state.workflow.edges.length} connections</span>${nodes.length?`<button class="diagnostic-summary${errors.length?' has-issues':''}" data-action="diagnostics">${icon(errors.length?'info':'check',11)}${errors.length?`${errors.length} ${errors.length===1?'issue':'issues'} to resolve`:'Ready to run'}</button>`:''}`;
    historyControls();
    $('#canvas').classList.toggle('connecting',!!state.connection);
    $('#connect-banner').classList.toggle('hidden',!state.connection);
    $('#connect-banner').textContent=state.connection?'Select an input port to connect · Esc to cancel':'';
  }
  function edgePath(source,target){const sx=(Number(source.x)||0)+224,sy=(Number(source.y)||0)+74,tx=Number(target.x)||0,ty=(Number(target.y)||0)+74;if(tx>sx+20)return `M${sx},${sy} C${sx+(tx-sx)*.48},${sy} ${tx-(tx-sx)*.48},${ty} ${tx},${ty}`;if(Math.abs(ty-sy)>100){const mid=(sy+ty)/2;return `M${sx},${sy} C${sx+54},${sy} ${sx+54},${mid} ${sx+54},${mid} L${tx-45},${mid} C${tx-45},${mid} ${tx-45},${ty} ${tx},${ty}`;}return `M${sx},${sy} C${sx+100},${sy-150} ${tx-100},${ty-150} ${tx},${ty}`;}
  function renderEdges(){
    $('#edges').innerHTML=state.workflow.edges.map(e=>{const s=state.workflow.nodes.find(n=>n.id===e.source),t=state.workflow.nodes.find(n=>n.id===e.target);if(!s||!t)return '';const run=nodeRun(e.target);return `<g class="edge${state.selectedEdge===e.id?' selected':''}${run?.status==='running'?' active':''}${run?.status==='completed'?' completed':''}" data-edge="${escape(e.id)}"><path class="edge-line" d="${edgePath(s,t)}"/><path class="edge-hit" d="${edgePath(s,t)}" data-edge="${escape(e.id)}"/><path class="edge-arrow" d="M${Number(t.x)-4},${Number(t.y)+71} l4,3 -4,3"/></g>`;}).join('');
  }
  function syncWorkflowView(){
    const id=state.workflow?.id||null;if(id===viewWorkflowId)return;
    if(viewWorkflowId)workflowViews.set(viewWorkflowId,{...state.view,fitted:state.initialFit});
    viewWorkflowId=id;const saved=workflowViews.get(id);
    state.view=saved?{x:saved.x,y:saved.y,scale:saved.scale}:{x:30,y:60,scale:.85};state.initialFit=Boolean(saved?.fitted);
  }
  function ensureWorkflowView(){if(state.screen!=='workflow'||state.drag)return;syncWorkflowView();if(!state.initialFit)fit();else applyView();}
  function applyView(){const {x,y,scale}=state.view,canvas=$('#canvas');canvas.scrollTop=0;canvas.scrollLeft=0;$('#world').style.transform=`translate(${x}px,${y}px) scale(${scale})`;$('#zoom-level').textContent=`${Math.round(scale*100)}%`;canvas.style.backgroundPosition=`${x%22}px ${y%22}px`;}
  function fit(){const canvas=$('#canvas');if(!canvas||state.screen!=='workflow')return;const r=canvas.getBoundingClientRect();if(r.width<1||r.height<1)return;syncWorkflowView();const node=$('.graph-node');state.view=fitWorkflow(state.workflow?.nodes||[],{width:canvas.clientWidth,height:canvas.clientHeight},{width:node?.offsetWidth||224,height:node?.offsetHeight||145});state.initialFit=true;applyView();if(!state.workflow?.nodes.length){$('#world').style.transform='none';}}
  function zoom(factor,clientX,clientY){const rect=$('#canvas').getBoundingClientRect(),cx=clientX===undefined?rect.width/2:clientX-rect.left,cy=clientY===undefined?rect.height/2:clientY-rect.top,old=state.view.scale,next=Math.min(1.7,Math.max(.25,old*factor));state.view.x=cx-(cx-state.view.x)*next/old;state.view.y=cy-(cy-state.view.y)*next/old;state.view.scale=next;state.initialFit=true;applyView();}
  function renderInspector(){
    const node=selectedNode(),edge=state.workflow?.edges.find(e=>e.id===state.selectedEdge),body=$('#inspector-body'),desktopWorkflow=state.workflow?.nodes.some(n=>n.type==='agent'&&n.desktop===true);
    $('#inspector-title').textContent=edge?'Connection':node?{agent:'Agent configuration',input:'Task input',output:'Workflow output',approval:'Checkpoint'}[node.type]||'Node settings':'Workflow settings';$('#duplicate-node').hidden=!node;
    $$('.inspector-tab').forEach(el=>el.classList.toggle('active',el.dataset.tab===state.inspectorTab));
    $('#inspector-footer').innerHTML=node?`<span>${escape(node.type==='agent'?'Agent runtime':labels[node.type])}</span><button class="button subtle" data-action="delete-node">${icon('trash',11)}Delete node</button>`:edge?`<span>Directed connection</span><button class="button subtle" data-action="delete-edge">${icon('trash',11)}Remove</button>`:`<span>Saved locally</span><button class="button subtle" data-action="delete-workflow">${icon('trash',11)}Delete</button>`;
    const liveNode=node?.type==='agent'?nodeRun(node.id):null;if(liveNode?.status==='running'&&liveNode.threadId&&liveNode.turnId)$('#inspector-footer').insertAdjacentHTML('afterbegin',`<button class="button subtle" data-action="direct-agent" data-id="${escape(node.id)}">${icon('agent',12)}Direct agent</button>`);
    if(state.inspectorTab==='activity'){const run=node?nodeRun(node.id):state.currentRun;if(!run){body.innerHTML=`<div class="inspector-empty"><span class="node-icon">${icon('clock',18)}</span>No activity yet.<br>Run a workflow to see the agent output.</div>`;return;}body.innerHTML=`<div class="inspector-output-label">${escape(run.status||'Activity')}${run.threadId?` · ${escape(String(run.threadId).slice(0,12))}`:''}</div>${run.error?`<p class="error-text">${escape(typeof run.error==='string'?run.error:JSON.stringify(run.error))}</p>`:''}${run.capabilitiesNote?`<p class="mission-capabilities-note">${escape(run.capabilitiesNote)}</p>`:''}${node?.type==='agent'?renderContextStatus(run.contextStatus,{threadId:run.threadId,canCompact:run.codexHistory!=='relay'&&run.status==='completed'&&state.currentRun?.settled!==false,continuity:run.continuity,effort:run.resolvedEffort}):''}<pre class="inspector-output">${escape(run.output||'Waiting for agent output…')}</pre>${node?.type==='agent'&&['completed','failed','cancelled'].includes(run.status)&&run.threadId?`<button class="button" data-action="continue-node" data-id="${escape(node.id)}"${state.currentRun?.settled===false?' disabled':''}>${icon('agent',13)}Continue with this agent</button>`:''}`;return;}
    if(edge){const source=state.workflow.nodes.find(n=>n.id===edge.source),target=state.workflow.nodes.find(n=>n.id===edge.target);body.innerHTML=`<div class="selected-node-info"><span class="node-icon">${icon('link',17)}</span><div><strong>Agent handoff</strong><small>Upstream result → next step</small></div></div><label class="field"><span class="field-label">From</span><input readonly value="${escape(source?.name)}"></label><label class="field"><span class="field-label">To</span><input readonly value="${escape(target?.name)}"></label><p class="field-help">The upstream result becomes context for the next node.</p>`;return;}
    if(!node){body.innerHTML=`<div class="selected-node-info"><span class="node-icon">${icon('workflow',17)}</span><div><strong>Workflow configuration</strong><small>${state.workflow.nodes.length} steps</small></div></div><label class="field"><span class="field-label">Description</span><textarea data-workflow-field="description">${escape(state.workflow.description)}</textarea></label><label class="field"><span class="field-label">Workspace directory</span><input data-setting="cwd" id="settings-cwd" placeholder="Absolute path to your project" value="${escape(state.workflow.settings?.cwd||state.status.cwd||'')}"><span class="field-help">The local working directory for this workflow.</span></label>${window.relayDesktop?.pickFolder?`<button class="button folder-picker" type="button" data-action="pick-folder" data-input="settings-cwd">${icon('folder',13)}Choose folder</button>`:''}<label class="field"><span class="field-label">Parallel agents</span><input type="number" min="1" step="1" data-setting="maxParallel" placeholder="No app limit" value="${state.workflow.settings?.maxParallel==null?'':escape(state.workflow.settings.maxParallel)}"><span class="field-help">Leave blank for no app limit. Independent branches run together; connected steps wait for inputs.${desktopWorkflow?' Windows actions share the background control queue.':''}</span></label>${renderContextFields(state.workflow.settings?.context||{},{prefix:'workflow-context',title:'Default context budget'})}`;return;}
    const models=state.status.models||[],currentModel=node.model||'default',efforts=effortsFor(node);
    body.innerHTML=`<div class="selected-node-info"><span class="node-icon ${escape(node.type)}">${icon(nodeIcon(node.type),18)}</span><div><strong>${escape(labels[node.type])}</strong><small>${node.type==='agent'?'Reasoning and tool execution':node.type==='input'?'The task that starts your workflow':node.type==='output'?'Collected workflow result':'Pass the result to the next step'}</small></div></div><label class="field"><span class="field-label">Node name</span><input data-node-field="name" value="${escape(node.name)}" maxlength="100"></label>${node.type==='agent'?`<label class="field"><span class="field-label">Role <span class="optional">OPTIONAL</span></span><input data-node-field="role" value="${escape(node.role||'')}" placeholder="e.g. Researcher"></label><label class="field"><span class="field-label">Instructions ${icon('text',11)}</span><textarea data-node-field="prompt" placeholder="Describe this agent’s task…">${escape(node.prompt||'')}</textarea><span class="field-help">The original task and connected results are included automatically.</span></label><div class="inspector-section"><div class="inspector-section-title">Model configuration</div><label class="field"><span class="field-label">Model</span><select data-node-field="model"><option value="default"${currentModel==='default'?' selected':''}>Model default${state.status.defaultModel?` · ${escape(state.status.defaultModel)}`:''}</option>${models.map(m=>`<option value="${escape(m.id)}"${currentModel===m.id?' selected':''}>${escape(m.displayName||m.id)}</option>`).join('')}${currentModel!=='default'&&!models.some(m=>m.id===currentModel)?`<option value="${escape(currentModel)}" selected>${escape(currentModel)}</option>`:''}</select></label><label class="field"><span class="field-label">Reasoning effort</span><select data-node-field="effort">${efforts.map(e=>`<option value="${e}"${(node.effort||'medium')===e?' selected':''}>${escape(reasoningLabel(e))}</option>`).join('')}</select></label></div>`:`<p class="field-help">${node.type==='input'?'Enter the task when you start your run.':node.type==='output'?'Incoming results appear in the Output tab.':'This checkpoint passes its incoming result to the next step.'}</p>`}`;
    if(node.type==='agent')body.insertAdjacentHTML('beforeend',renderContextFields(node.context||state.workflow.settings?.context||{},{prefix:'node-context',title:node.context?'Agent context override':'Context · inherited until edited'}));
    renderDesktopTools();
  }
  function renderDesktopTools(){const node=selectedNode();if(node?.type!=='agent'||state.inspectorTab!=='configure')return;$('#inspector-body').insertAdjacentHTML('beforeend',`<div class="inspector-section desktop-tools-setting"><div class="inspector-section-title">Desktop tools</div><label class="desktop-access-toggle"><span class="desktop-access-icon">${icon('desktop',17)}</span><span><strong>Allow desktop inspection</strong><small>Inspect desktop state and app controls.</small></span><input type="checkbox" data-node-field="desktop" aria-label="Allow desktop inspection"${node.desktop?' checked':''}><i aria-hidden="true"></i></label><div class="desktop-session-status"><span class="status-dot${state.desktop.enabled?' connected':''}"></span>${state.desktop.enabled?'Windows desktop connected':'Desktop disconnected'}<button data-action="desktop">Open desktop ${icon('chevron',10)}</button></div></div>`);}


  function desktopStatus(data){return data?.status&&typeof data.status==='object'?data.status:data||{};}
  function updateSkipLink(){
    const target={mission:['#mission-task','Skip to task'],workflow:['#canvas','Skip to workflow'],observe:['#observe-workspace','Skip to activity'],configure:['#configure-workspace','Skip to settings'],planning:['#planning-workspace','Skip to Planning'],desktop:['#desktop-workspace','Skip to desktop']}[state.screen]||['#mission-task','Skip to task'];
    const skip=$('.skip-link');if(skip){skip.href=target[0];skip.textContent=target[1];}const destination=$(target[0]);if(destination&&state.screen!=='mission')destination.tabIndex=-1;
  }
  function renderDesktop(){
    if(!$('#desktop-workspace'))return;
    const desktop=state.desktop,enabled=!!desktop.enabled,pending=state.desktopPending;
    $('#app').classList.toggle('planning-view',state.screen==='planning');const planningMount=$('#planning-workspace');if(planningMount)planningMount.hidden=state.screen!=='planning';if(state.screen!=='planning')planningUI?.leave();
    $('#app').classList.toggle('configure-view',state.screen==='configure');const configureMount=$('#configure-workspace');if(configureMount)configureMount.hidden=state.screen!=='configure';if(state.screen!=='observe')observeUI?.leave();
    $('#app').classList.toggle('observe-view',state.screen==='observe');const observeMount=$('#observe-workspace');if(observeMount)observeMount.hidden=state.screen!=='observe';renderMode();
    $('#app').classList.toggle('desktop-view',state.screen==='desktop');$('#desktop-workspace').classList.toggle('hidden',state.screen!=='desktop');
    $('#app').classList.toggle('mission-view',state.screen==='mission');$('#mission-workspace').hidden=state.screen!=='mission';$$('.rail-button[data-action="mission"]').forEach(el=>el.classList.toggle('active',state.screen==='mission'));updateSkipLink();
    $$('.rail-button[data-action="library"]').forEach(el=>el.classList.toggle('active',state.screen==='workflow'));
    $$('.rail-button[data-action="desktop"]').forEach(el=>el.classList.toggle('active',state.screen==='desktop'));
    $('#desktop-presence').hidden=!enabled;
    const available=desktop.available!==false;
    for(const id of ['desktop-attach','desktop-empty-attach']){const button=$(`#${id}`);button.hidden=enabled;button.disabled=pending||!available;button.innerHTML=`${icon(pending?'refresh':'link',14)}${pending?'Connecting…':available?(id==='desktop-attach'?'Attach desktop':'Attach Windows desktop'):'Windows desktop unavailable'}`;}
    $('#desktop-detach').hidden=!enabled;$('#desktop-detach').disabled=pending;
    $('#desktop-status-dot').className=`status-dot${enabled?' connected':''}`;
    $('#desktop-status-label').textContent=enabled?(desktop.busy?'Desktop active':state.desktopFrame?'Live desktop':'Desktop connected'):available?'Desktop disconnected':'Desktop unavailable';
    $('#desktop-frame-meta').textContent=enabled&&state.desktopFrame?`${state.desktopFrame.width} × ${state.desktopFrame.height} · Live preview`:enabled?'Waiting for a frame…':'Preview paused';
    $('#desktop-preview-note').textContent=enabled?'Preview refreshes every 2 seconds. Actions use accessible app controls; some can open or focus app windows.':'Screen capture starts when you attach.';
    $('#desktop-expand').disabled=!enabled||!state.desktopFrame;
    const error=state.desktopError||desktop.error||desktop.lastError;$('#desktop-error').classList.toggle('hidden',!error);$('#desktop-error').textContent=typeof error==='string'?error:error?.message||'';
    const frame=$('#desktop-frame'),placeholder=$('#desktop-placeholder');frame.classList.toggle('hidden',!enabled||!state.desktopFrame);placeholder.classList.toggle('hidden',enabled&&!!state.desktopFrame);
    if(!enabled){state.desktopFrame=null;frame.removeAttribute('src');$('#desktop-full-frame')?.removeAttribute('src');}
    if(enabled&&state.desktopFrame){const url=`data:${state.desktopFrame.mimeType};base64,${state.desktopFrame.data}`;if(frame.src!==url)frame.src=url;const full=$('#desktop-full-frame');if(full&&full.src!==url)full.src=url;}
    $('#desktop-window-count').textContent=enabled?state.desktopWindows.length:'—';
    $('#desktop-windows').innerHTML=enabled&&state.desktopWindows.length?state.desktopWindows.map(w=>`<div class="desktop-window"><span class="desktop-window-icon">${icon('desktop',15)}</span><div><strong title="${escape(w.title)}">${escape(w.title||'Untitled window')}</strong><small>${escape(w.processName||w.process||`Process ${w.pid||'unknown'}`)}${w.foreground||w.active?' · Active':''}</small></div>${w.foreground||w.active?'<span class="status-dot connected"></span>':''}</div>`).join(''):`<div class="desktop-side-empty">${enabled?'No visible windows were reported.':'Connect your desktop to see open windows.'}</div>`;
    $('#desktop-action-count').textContent=state.desktopActions.length;
    $('#desktop-actions').innerHTML=state.desktopActions.length?[...state.desktopActions].reverse().map(a=>{const action=typeof a.action==='string'?a.action:a.action?.action||a.action?.type||a.type||'Desktop action';const label=action.replaceAll('_',' ').replaceAll('.',' · ');const detail=a.summary||a.reason||a.error||a.action?.text||a.action?.title||a.text||'';return `<div class="desktop-action"><span class="desktop-action-symbol${a.status==='failed'?' error':''}">${icon(a.status==='failed'?'info':label.includes('screenshot')?'eye':'pointer',14)}</span><div><strong>${escape(label.charAt(0).toUpperCase()+label.slice(1))}</strong>${detail?`<p>${escape(typeof detail==='string'?detail:JSON.stringify(detail))}</p>`:''}<small>${escape(formatTime(a.at))}${a.status?` · ${escape(a.status)}`:''}</small></div></div>`;}).join(''):'<div class="desktop-side-empty">Desktop observations and actions appear here as agents work.</div>';
  }
  function showWorkflow(){enterWorkspace('workflow');if(workflowRenderPending){workflowRenderPending=false;renderGraph();renderInspector();renderExecution();}requestAnimationFrame(ensureWorkflowView);}
  function showMission(){enterWorkspace('mission');missionUI?.update();}
  async function showDesktop(){enterWorkspace('desktop');await refreshDesktop(true);}
  async function refreshDesktop(poll=false){
    const version=++desktopPollVersion;clearTimeout(desktopTimer);
    try{
      const status=await api('/api/desktop/status');if(version!==desktopPollVersion)return;state.desktop=desktopStatus(status);state.desktopError='';renderDesktop();
      if(state.screen==='desktop'&&state.desktop.enabled){
        const results=await Promise.allSettled([api('/api/desktop/frame'),api('/api/desktop/windows')]);
        if(version!==desktopPollVersion||state.screen!=='desktop'||!state.desktop.enabled)return;
        if(results[0].status==='fulfilled'){const data=results[0].value,frame=data.image||data.frame;if(frame?.data&&['image/png','image/jpeg','image/webp'].includes(frame.mimeType))state.desktopFrame=frame;else state.desktopError=data.error?.message||data.error||'The desktop did not return an image.';}else state.desktopError=results[0].reason?.message||'Could not capture desktop.';
        if(results[1].status==='fulfilled')state.desktopWindows=asArray(results[1].value,'windows');renderDesktop();
      }
    }catch(error){if(version===desktopPollVersion){state.desktopError=error.message;renderDesktop();}}
    finally{if(version===desktopPollVersion&&state.screen==='desktop'&&state.desktop.enabled&&(poll||state.desktop.enabled))desktopTimer=setTimeout(()=>refreshDesktop(true),2000);}
  }
  async function changeDesktop(enabled){
    if(state.desktopPending)return;desktopPollVersion++;clearTimeout(desktopTimer);state.desktopPending=true;state.desktopError='';renderDesktop();
    try{state.desktop=desktopStatus(await api(`/api/desktop/${enabled?'attach':'detach'}`,'POST',{}));state.desktopFrame=null;state.desktopWindows=[];toast(enabled?'Windows desktop connected.':'Desktop disconnected. Agent control stopped.');}
    catch(error){state.desktopError=error.message;toast(error.message,true);}
    finally{state.desktopPending=false;renderDesktop();if(state.screen==='desktop'&&state.desktop.enabled)await refreshDesktop(true);}
  }
  function expandDesktop(){if(!state.desktopFrame||!state.desktop.enabled)return;showModal('desktop-preview',`${modalHeader('Windows desktop','Live view of the session attached to your agents.','desktop')}<div class="desktop-full-stage"><img id="desktop-full-frame" alt="Expanded live Windows desktop preview"></div><div class="modal-footer"><span class="footer-note">Ctrl + Alt + Esc detaches the desktop immediately.</span><button class="button danger" data-action="detach-desktop">${icon('stop',12)}Detach & stop</button><button class="button" data-action="close-modal">Close</button></div>`,true);$('#modal-root .modal').classList.add('desktop-preview-modal');renderDesktop();}

  const formatTime = at => at ? new Date(at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}) : '';
  const plainText=value=>typeof value==='string'?value:typeof value==='number'?String(value):'';
  function toolResultText(value){const text=plainText(value);if(!text)return '';try{const parsed=JSON.parse(text);return plainText(parsed?.text||parsed?.message||parsed?.summary)||'Structured result returned.';}catch{return text;}}
  function presentTraceEvent(event){
    const d=event.data||{},row={nodeId:event.nodeId,at:event.at,title:'',text:'',output:'',detailLabel:'',kind:'activity'};
    if(event.type==='node.updated'){if(!['running','completed','failed','cancelled','waiting','skipped'].includes(d.status))return null;row.title=d.reused?'Completed step reused':{running:'Step started',completed:'Step completed',failed:'Step failed',cancelled:'Step stopped',waiting:'Waiting for inputs',skipped:'Step skipped'}[d.status];row.text=plainText(d.error?.message||d.error);row.kind=d.status==='failed'?'error':'step';return row;}
    if(event.type==='run.updated'){if(!['running','completed','failed','cancelled'].includes(d.status))return null;row.title={running:'Workflow started',completed:'Workflow completed',failed:'Workflow failed',cancelled:'Workflow stopped'}[d.status];row.text=plainText(d.error?.message||d.error);return row;}
    if(event.type!=='agent.event')return null;
    if(d.type==='delta'||d.type==='message'){row.text=plainText(d.type==='delta'?d.delta:d.text);if(!row.text)return null;row.title=d.phase==='final_answer'?'Agent result':'Agent response';row.kind='response';row.itemId=d.itemId;row.append=d.type==='delta';return row;}
    if(d.type==='thread'){row.title='Connected to Codex';row.text=plainText(d.model);return row;}
    if(d.type==='steer'){row.title=d.accepted===false?'Direction was not accepted':'Direction delivered';row.text=plainText(d.text||d.message);row.kind=d.accepted===false?'error':'direction';return row;}
    if(d.type==='subagent'){
      if(!['running','completed','failed','cancelled','not-started'].includes(d.status))return null;
      row.title=({running:'Subagent started',completed:'Subagent completed',failed:'Subagent failed',cancelled:'Subagent stopped','not-started':'Subagent not started'})[d.status];
      row.text=[plainText(d.id),plainText(d.status==='running'?d.label:d.message),d.durationMs!=null?duration(d.durationMs):''].filter(Boolean).join(' · ');
      row.kind=d.status==='failed'?'error':'activity';return row;
    }
    if(d.type==='task.state'){row.title='Milestone progress saved';row.kind='knowledge';row.text=`${d.state?.progress?.done||0} of ${d.state?.progress?.total||0} saved steps complete${d.state?.progress?.current?' · '+plainText(d.state.progress.current.title):''}`;return row;}
    if(d.type==='knowledge'){
      if(d.status==='running')return null;
      const catalog={relay_memory:{search:'Searched memory',read:'Read memory',remember:'Saved memory',forget:'Deleted memory'},relay_skills:{search:'Searched skills',read:'Read skill',save:'Saved skill',remove:'Deleted skill'},relay_history:{search:'Searched past runs',read:'Read past run'}};
      row.title=catalog[d.tool]?.[d.action]||'Knowledge updated';row.kind=d.status==='failed'?'error':'knowledge';
      if(d.status==='failed'){row.title+=' · failed';row.text=plainText(d.message);return row;}
      const parts=[];if(d.title)parts.push(plainText(d.title));if(d.revision!=null)parts.push(`Revision ${plainText(d.revision)}`);if(d.count!=null)parts.push(`${d.count} ${d.tool==='relay_history'?'runs':'entries'} found`);row.text=parts.join(' · ');return row;
    }
    if(d.type==='error'){row.title=d.willRetry?'Retrying after a runtime error':'Runtime error';row.text=plainText(d.message);row.kind='error';return row;}
    if(d.type==='turn'){if(!['cancelling','interrupted','failed'].includes(d.status))return null;row.title=d.status==='cancelling'?'Stopping the agent':d.status==='interrupted'?'Agent stopped':'Agent failed';return row;}
    if(d.type==='plan'){row.title='Plan updated';row.text=[plainText(d.explanation),...(d.plan||[]).map((step,index)=>`${index+1}. ${plainText(step.step)}${step.status?` (${step.status==='in_progress'?'in progress':step.status})`:''}`)].filter(Boolean).join('\n');return row.text?row:null;}
    if(d.type==='diff'){if(!d.diff)return null;row.title='Workspace changes';row.text='The agent updated the working files.';row.output=plainText(d.diff);row.detailLabel='View changes';return row;}
    if(d.type==='toolOutput'){if(!d.delta)return null;row.title='Command output';row.output=plainText(d.delta);row.kind='command';row.itemId=d.itemId;row.append=true;row.detailLabel='View command output';return row;}
    if(d.type!=='item')return null;
    const item=d.item||{},completed=d.stage==='completed'||item.status==='completed';row.itemId=item.id;
    if(item.type==='agentMessage'){if(!item.text)return null;row.title=item.phase==='final_answer'?'Agent result':'Agent response';row.text=plainText(item.text);row.kind='response';return row;}
    if(item.type==='commandExecution'){row.title=completed?(item.exitCode!=null&&item.exitCode!==0?'Command failed':'Command completed'):'Running command';row.text=(item.commandActions||[]).map(action=>plainText(action.command||action.path)).filter(Boolean).join('\n')||plainText(item.command);row.output=plainText(item.aggregatedOutput||item.output);row.detailLabel=`Command output${item.exitCode!=null?` · exit ${item.exitCode}`:''}${item.durationMs!=null?` · ${duration(item.durationMs)}`:''}`;row.kind='command';return row;}
    if(item.type==='fileChange'){row.title=completed?'Files updated':'Updating files';row.text=(item.changes||[]).map(change=>`${plainText(change.path)}${change.kind?.type?` · ${plainText(change.kind.type)}`:''}`).filter(Boolean).join('\n');row.output=(item.changes||[]).map(change=>plainText(change.diff)).filter(Boolean).join('\n\n');row.detailLabel='View file changes';row.kind='files';return row;}
    if(['dynamicToolCall','mcpToolCall'].includes(item.type)){
      if(['relay_memory','relay_skills','relay_history','relay_task'].includes(item.tool))return null;
      const action=item.arguments?.action,desktop=item.tool==='relay_desktop',tool=desktop?'Windows desktop':plainText(item.tool||item.name)||'Connected tool';
      const actionName=desktop?({screenshot:'Observe screen',windows:'List open windows',inspect:'Inspect app controls',get_text:'Read control text',invoke:'Activate a control',set_value:'Set a field value',select:'Select an item',toggle:'Toggle a control',expand:'Expand a control',collapse:'Collapse a control',scroll_into_view:'Reveal a control',scroll:'Scroll an app control',wait:'Wait for an app'}[action]||plainText(action)):'';
      row.title=`${tool}${actionName?` / ${actionName}`:''}${completed?item.success===false?' failed':' completed':''}`;
      const content=item.contentItems||item.result?.content||[],texts=content.map(content=>plainText(content.text)).filter(Boolean);
      row.text=texts.map(toolResultText).join('\n')||(!completed?'Tool is running.':'');
      row.output=texts.some(text=>toolResultText(text)!==text)?texts.join('\n'):'';row.detailLabel='View tool result';row.kind='tool';return row;
    }
    if(item.type==='webSearch'){row.title=completed?'Web search completed':'Searching the web';row.text=plainText(item.query||item.action?.query);return row;}
    return null;
  }
  function traceRows(run){
    const events=[...(run.events||[])],transitionKeys=new Set(events.filter(event=>event.type==='node.updated').map(event=>`${event.nodeId}:${event.data?.status}`));
    for(const [nodeId,node] of Object.entries(run.nodes||{})){
      if(node.startedAt&&!node.reused&&!transitionKeys.has(`${nodeId}:running`))events.push({type:'node.updated',nodeId,at:node.startedAt,data:{status:'running'}});
      if(node.finishedAt&&['completed','failed','cancelled','skipped'].includes(node.status)&&!transitionKeys.has(`${nodeId}:${node.status}`))events.push({type:'node.updated',nodeId,at:node.reused?run.createdAt:node.finishedAt,data:{status:node.status,error:node.error,reused:node.reused}});
    }
    events.sort((a,b)=>Date.parse(a.at)-Date.parse(b.at));
    const rows=[],items=new Map();
    for(const event of events){if(state.traceFilter&&event.nodeId!==state.traceFilter)continue;const row=presentTraceEvent(event);if(!row)continue;const key=row.itemId?`${row.nodeId}:${row.kind}:${row.itemId}`:null,previous=key?items.get(key):null;
      if(previous){if(row.append){if(row.kind==='response')previous.text+=row.text;else previous.output+=row.output;}else{previous.title=row.title;previous.text=row.text||previous.text;previous.output=row.output||previous.output;previous.detailLabel=row.detailLabel||previous.detailLabel;}continue;}
      rows.push(row);if(key)items.set(key,row);
    }
    return rows.slice(-200);
  }
  function historyHTML(runs){return runs.length?runs.map(r=>`<button class="history-row" data-action="open-run" data-id="${escape(r.id)}"><span class="history-status ${escape(r.status)}"></span><span class="history-main"><strong>${escape(r.workflowName||'Workflow')}</strong><small>${escape((typeof r.input==='string'?r.input:r.input?.task)||'No task')} · ${escape(new Date(r.createdAt).toLocaleString([], {month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}))}</small></span><span class="badge">${escape(r.status)}</span>${icon('chevron',12)}</button>`).join(''):'<div class="modal-empty">Your runs will appear here.<br>Start a workflow to create your first run.</div>';}
  function renderExecution(){
    scheduleLiveViews();
    const viewKey=`${state.currentRun?.id||'empty'}:${state.executionTab}`,executionBody=$('#execution-body'),newView=executionBody.dataset.viewKey!==viewKey;
    const run=state.currentRun,body=$('#execution-body'),overview=$('#execution-overview');$('#execution').classList.toggle('collapsed',state.panelCollapsed);$('#execution-status').textContent=run?.status?run.status.charAt(0).toUpperCase()+run.status.slice(1):'Ready';$('#execution-status').className=`badge ${run?.status==='completed'?'green':busy()?'purple':''}`;
    $('#execution-run-label').textContent=run?`${String(run.id).slice(-8)}${run.retryOf?' · retry':''}`:'';$('#stop-button').hidden=!busy();$('#panel-toggle').innerHTML=icon(state.panelCollapsed?'up':'down',14);$('#panel-toggle').setAttribute('aria-label',state.panelCollapsed?'Expand execution':'Collapse execution');
    $$('.execution-tab').forEach(el=>el.classList.toggle('active',el.dataset.tab===state.executionTab));
    overview.hidden=!run||state.executionTab==='history';
    if(state.panelCollapsed)return;
    if(newView){executionBody.scrollTop=0;executionBody.dataset.viewKey=viewKey;}
    if(run&&state.executionTab!=='history'){
      const metrics=runMetrics(run),nodes=run.workflow?.nodes||state.workflow.nodes,canRetry=['failed','cancelled'].includes(run.status)&&run.settled===true&&run.canRetry!==false;
      overview.innerHTML=`${run.continuedFrom?`<div class="conversation-context">${icon('agent',12)}Continuing ${escape(nodes.find(node=>node.id===run.continuedFrom.nodeId)?.name||'this agent')}<span>Same conversation · ${escape(String(run.continuedFrom.threadId||'').slice(-8))}</span><button class="button subtle" data-action="open-run" data-id="${escape(run.parentRunId||run.continuedFrom.runId)}">Previous run ${icon('chevron',11)}</button></div>`:''}<div class="run-metrics"><span><strong>${metrics.completed}<span class="muted"> / ${metrics.total}</span></strong> steps complete</span><span>${icon('clock',11)}<strong class="run-duration">${duration(metrics.durationMs)}</strong></span>${metrics.hasUsage?`<span><strong>${metrics.totalTokens.toLocaleString()}</strong> tokens</span>`:''}${metrics.reused?`<span><strong>${metrics.reused}</strong> reused</span>`:''}${metrics.failed?`<span class="error-text"><strong>${metrics.failed}</strong> failed</span>`:''}<div class="execution-actions">${['failed','cancelled'].includes(run.status)?`<button class="button subtle" data-action="retry-run"${canRetry&&!state.retrying?'':' disabled'} title="${run.settled===true?'Reuse completed steps and retry the remaining work':'Waiting for the previous agents to finish stopping'}">${icon('refresh',12)}${state.retrying?'Retrying…':run.settled===true?'Retry remaining steps':'Stopping agents…'}</button>`:''}<button class="icon-button" data-action="copy-output" aria-label="Copy run output" title="Copy output">${icon('copy',12)}</button><button class="icon-button" data-action="export-run" aria-label="Export run with output and trace" title="Export run">${icon('download',12)}</button></div></div><div class="run-progress-track" role="progressbar" aria-label="Completed workflow steps" aria-valuemin="0" aria-valuemax="${metrics.total}" aria-valuenow="${metrics.completed}"><span class="run-progress-fill" style="width:${metrics.total?metrics.completed/metrics.total*100:0}%"></span></div>${state.executionTab==='trace'?`<div class="trace-filters" role="group" aria-label="Filter trace by node"><button class="trace-filter${state.traceFilter?'':' active'}" data-action="trace-filter" data-id="" aria-pressed="${!state.traceFilter}">All activity</button>${nodes.map(node=>{const activity=run.nodes?.[node.id],nodeElapsed=activity?.startedAt?duration((activity.finishedAt?Date.parse(activity.finishedAt):Date.now())-Date.parse(activity.startedAt)):null;return `<button class="trace-filter${state.traceFilter===node.id?' active':''}" data-action="trace-filter" data-id="${escape(node.id)}" aria-pressed="${state.traceFilter===node.id}" title="${escape(activity?.error?errorText(activity.error):activity?.blockedBy?.length?'Waiting for: '+activity.blockedBy.map(id=>nodes.find(n=>n.id===id)?.name||id).join(', '):node.name)}"><span class="status-dot ${escape(activity?.status||'')}"></span>${escape(node.name)}${activity?.reused?'<small>reused</small>':nodeElapsed?`<small>${nodeElapsed}</small>`:''}</button>`;}).join('')}</div>`:''}`;
      if(continuationAgents(run,'steer').length)$('.execution-actions',overview)?.insertAdjacentHTML('afterbegin',`<button class="button subtle" data-action="direct-agent">${icon('agent',12)}Direct agent</button>`);
    }
    if(state.executionTab==='history'){body.innerHTML=historyHTML(state.runs);return;}
    if(!run){body.innerHTML=`<div class="execution-empty"><span class="empty-execution-icon">${icon('terminal',19)}</span><div><strong>Your team's work, in real time.</strong><p>Run a workflow to follow each step, inspect the trace, and collect the result.</p><button class="button subtle" data-action="run">${icon('play',11)}Start a run</button></div></div>`;return;}
    if(state.executionTab==='output'){const text=runOutput(run);body.innerHTML=`${run.error?`<div class="notice error"><strong>${run.status==='cancelled'?'Run stopped':'Run needs attention'}</strong><p>${escape(errorText(run.error))}</p></div>`:''}${text?`<article class="output-document" aria-label="Agent result">${renderMarkdown(text)}</article>`:`<div class="execution-empty"><span class="empty-execution-icon">${icon(busy()?'clock':'output',19)}</span><div><strong>${busy()?'Your agents are working.':'No final output yet.'}</strong><p>${busy()?'Their result will appear here as each step finishes.':'Open the trace to inspect what happened.'}</p></div></div>`}${renderTaskState(run.taskState,{icon})}${continuationHTML(run)}`;return;}
    const nearBottom=newView||body.scrollHeight-body.scrollTop-body.clientHeight<60;
    const rows=traceRows(run);
    body.innerHTML=rows.length?rows.map(row=>{const node=(run.workflow?.nodes||state.workflow.nodes).find(n=>n.id===row.nodeId);return `<div class="event-row"><span class="event-time">${escape(formatTime(row.at))}</span><span class="event-symbol">${icon(row.kind==='error'?'info':row.kind==='step'?'check':row.kind==='knowledge'?'book':'bolt',12)}</span><div class="event-main"><strong>${node?`${escape(node.name)} <span class="muted">/</span> `:''}${escape(row.title)}</strong>${row.text?`<pre>${escape(row.text)}</pre>`:''}${row.output?`<details class="event-details"><summary>${escape(row.detailLabel||'View details')}</summary><pre>${escape(row.output)}</pre></details>`:''}</div></div>`;}).join(''):`<div class="execution-empty"><span class="empty-execution-icon">${icon('clock',19)}</span><div><strong>${busy()?'Waiting for this step…':'No trace events'}</strong><p>${state.traceFilter?'This step has no recorded activity. Choose All activity to see the whole run.':busy()?'Your workflow is connected to the local runtime.':'No activity was recorded for this run.'}</p></div></div>`;
    if(nearBottom)body.scrollTop=body.scrollHeight;
  }
  function runOutput(run=state.currentRun){return run?.output||Object.values(run?.nodes||{}).filter(n=>n.output).map(n=>n.output).at(-1)||'';}
  function continuationAgents(run,mode='continue'){return (run?.workflow?.nodes||state.workflow?.nodes||[]).filter(node=>{const activity=run?.nodes?.[node.id];return node.type==='agent'&&activity?.threadId&&(mode==='steer'?activity.status==='running'&&activity.turnId:['completed','failed','cancelled'].includes(activity.status));});}
  function continuationHTML(run,mode='continue'){
    const live=mode==='steer',agents=continuationAgents(run,mode);if(!agents.length||!live&&(busy()||run.settled===false||state.modal==='agent-direction'))return '';
    const selected=agents.find(node=>node.id===state.continueNodeId)||agents.find(node=>node.id===state.selected)||agents[0],draft=state.continuationDrafts[`${run.id}:${selected.id}:${mode}`]||'';state.continueNodeId=selected.id;
    return `<form id="continuation-form" class="conversation-composer" data-mode="${mode}" data-run-id="${escape(run.id)}"><div class="conversation-heading"><span>${icon('agent',15)}<strong>${live?`Direct ${escape(selected.name)} while it works`:'Continue with this agent'}</strong></span>${agents.length>1?`<select id="continuation-agent" class="conversation-agent-select" aria-label="${live?'Agent to direct':'Agent to continue'}"${state.continuing?' disabled':''}>${agents.map(node=>`<option value="${escape(node.id)}"${node.id===selected.id?' selected':''}>${escape(node.name)}</option>`).join('')}</select>`:`${live?'':`<span class="conversation-agent-name">${escape(selected.name)}</span>`}<input type="hidden" id="continuation-agent" value="${escape(selected.id)}">`}</div><div class="conversation-compose-row"><textarea id="continuation-message" class="conversation-input" name="message" rows="2" maxlength="20000" placeholder="${live?'Add context, adjust the approach, or change priorities…':'Ask a follow-up, refine the result, or give this agent the next task…'}" aria-label="${live?'Direction for the running agent':'Follow-up message'}" required${state.continuing?' disabled':''}>${escape(draft)}</textarea><button class="button primary" type="submit"${state.continuing?' disabled':''}>${icon(state.continuing?'clock':'up',14)}${state.continuing?'Sending…':live?'Send direction':'Continue agent'}</button></div><div class="conversation-meta"><span>${live?'Delivered into this active turn. Your current run keeps going.':`Same agent conversation · Previous context stays with ${escape(selected.name)}.`}</span><kbd>Ctrl ↵ to send</kbd></div>${state.continuationError?`<p class="conversation-error error-text" role="alert">${escape(state.continuationError)}</p>`:''}</form>`;
  }
  function showDirection(nodeId){if(!state.currentRun||!continuationAgents(state.currentRun,'steer').length){toast('No agent is accepting live direction right now.');return;}if(nodeId)state.continueNodeId=nodeId;state.continuationError='';showModal('agent-direction',`${modalHeader('Direct your agent','Send a message into the active agent turn.','agent')}<div class="modal-body">${continuationHTML(state.currentRun,'steer')}</div>`);requestAnimationFrame(()=>$('#continuation-message')?.focus({preventScroll:true}));}
  async function continueAgent(form){
    const run=state.currentRun,nodeId=$('#continuation-agent',form)?.value,message=$('#continuation-message',form)?.value.trim(),mode=form.dataset.mode||'continue',live=mode==='steer';
    if(!run||run.id!==form.dataset.runId||!nodeId||!message||state.continuing||!live&&busy())return;
    const draftKey=`${run.id}:${nodeId}:${mode}`;state.continuing=true;state.continuationError='';state.continuationDrafts[draftKey]=message;const controls=$$('textarea,select,button',form);controls.forEach(el=>el.disabled=true);const button=$('button[type="submit"]',form);if(button)button.textContent='Sending…';
    try{
      const data=await api(`/api/runs/${encodeURIComponent(run.id)}/${live?'steer':'continue'}`,'POST',{nodeId,message});
      if(live){if(data.accepted!==true)throw new Error('The agent did not accept this direction.');delete state.continuationDrafts[draftKey];closeModal();toast('Direction delivered. Your agent is continuing its work.');}
      else{state.currentRun=data.run||data;delete state.continuationDrafts[draftKey];state.continueNodeId=nodeId;state.selected=nodeId;state.selectedEdge=null;state.traceFilter=null;state.executionTab='trace';state.panelCollapsed=false;renderAll();refreshRuns();toast('Follow-up started in the same agent conversation.');}
    }catch(error){state.continuationError=error.message;if(live&&form.isConnected){let errorNode=$('.conversation-error',form);if(!errorNode){errorNode=document.createElement('p');errorNode.className='conversation-error error-text';errorNode.setAttribute('role','alert');form.append(errorNode);}errorNode.textContent=error.message;}toast(error.message,true);}
    finally{state.continuing=false;controls.forEach(el=>el.disabled=false);if(button?.isConnected)button.innerHTML=`${icon('up',14)}${live?'Send direction':'Continue agent'}`;renderExecution();}
  }
  function renderAll(){renderHeader();renderGraph();renderInspector();renderExecution();renderDesktop();missionUI?.update();}
  function markDirty(group=null,record=true){workflowEditRevision++;if(record)editHistory.record(state.workflow,group);state.dirty=true;state.saveError=false;renderHeader();clearTimeout(saveTimer);saveTimer=setTimeout(saveWorkflow,900);}
  async function saveWorkflow(){if(!state.workflow)return;if(state.saving){await savePromise;if(state.dirty&&!state.saveError)return saveWorkflow();return;}clearTimeout(saveTimer);state.saving=true;const snapshot=JSON.stringify(state.workflow);renderHeader();savePromise=(async()=>{try{const saved=await api('/api/workflows','POST',JSON.parse(snapshot));const w=saved.workflow||saved;const index=state.workflows.findIndex(x=>x.id===w.id);if(index>=0)state.workflows[index]=w;else state.workflows.unshift(w);state.dirty=JSON.stringify(state.workflow)!==snapshot;state.saveError=false;}catch(error){state.saveError=true;toast(`Workflow couldn’t be saved: ${error.message}`,true);}finally{state.saving=false;renderHeader();if(state.dirty&&!state.saveError)saveTimer=setTimeout(saveWorkflow,400);}})();return savePromise;}
  async function loadWorkflow(workflow,{preserveRun=false,ownership,isCurrent=()=>true}={}){const owner=ownership||(preserveRun?captureViewOwnership():beginViewOperation());if(state.dirty)await saveWorkflow();if(!ownsView(owner)||!isCurrent())return false;if(state.saveError)throw new Error('Save your Studio changes before opening another workflow.');state.workflow=normalizeWorkflow(workflow);editHistory.reset(state.workflow);try{localStorage.setItem('relay.workflow',state.workflow.id);}catch{}state.selected=state.workflow.nodes.find(n=>n.type==='agent')?.id||state.workflow.nodes[0]?.id||null;state.selectedEdge=null;state.connection=null;if(!preserveRun)state.currentRun=null;state.traceFilter=null;state.dirty=false;state.inspectorTab='configure';renderAll();requestAnimationFrame(ensureWorkflowView);return true;}
  async function refreshStatus(){try{state.status=await api('/api/status');}catch(error){state.status={connected:false,authenticated:false,error:error.message};}state.statusLoaded=true;if(state.workflow&&!state.workflow.settings?.cwd&&state.status.cwd){state.workflow.settings={...state.workflow.settings,cwd:state.status.cwd};markDirty();}renderHeader();if(state.modal==='runtime')showRuntime(true);}
  function selectNode(id){state.selected=id;state.selectedEdge=null;state.inspectorTab='configure';renderGraph();renderInspector();if(innerWidth<=850)$('#inspector').classList.add('mobile-visible');}
  function addNode(type){const id=uid(type);let x=40,y=75;for(let slot=0;slot<120;slot++){x=40+(slot%3)*300;y=75+Math.floor(slot/3)*235;if(!state.workflow.nodes.some(n=>Math.abs(n.x-x)<270&&Math.abs(n.y-y)<190))break;}const node={id,type,name:labels[type],x,y};if(type==='agent')Object.assign(node,{role:'Agent',prompt:'Complete your assigned part of the user task. Inspect the workspace and upstream context, then return a clear result.',model:'default',effort:'default',sandbox:'danger-full-access'});state.workflow.nodes.push(node);state.selected=id;state.selectedEdge=null;markDirty();renderGraph();renderInspector();fit();toast(`${labels[type]} added. Use the ports to connect it.`);}
  function deleteNode(){const node=selectedNode();if(!node)return;state.workflow.nodes=state.workflow.nodes.filter(n=>n.id!==node.id);state.workflow.edges=state.workflow.edges.filter(e=>e.source!==node.id&&e.target!==node.id);state.selected=null;markDirty();renderGraph();renderInspector();}
  function hasPath(from,to,visited=new Set()){if(from===to)return true;if(visited.has(from))return false;visited.add(from);return state.workflow.edges.filter(e=>e.source===from).some(e=>hasPath(e.target,to,visited));}
  function connectPort(port,id){if(port==='out'){state.connection=state.connection===id?null:id;renderGraph();return;}if(!state.connection){toast('Select an output port first, then an input port.');return;}const source=state.connection;if(source===id||hasPath(id,source)){toast('This connection would create a cycle.',true);return;}if(state.workflow.edges.some(e=>e.source===source&&e.target===id)){toast('These nodes are already connected.');state.connection=null;renderGraph();return;}state.workflow.edges.push({id:uid('edge'),source,target:id});state.connection=null;markDirty();renderGraph();toast('Nodes connected.');}
  function showModal(type,html,wide=false){const intent=++subviewIntent;if(type!=='commands')stopPaletteSearch();if(type!=='inbox')inboxUI?.cancel();if(type!=='artifact')artifactUI?.cancel();if(type!=='prompts')promptsUI?.cancel();if(type!=='projects')projectsUI?.cancel();if(type!=='email')emailUI?.cancel();if(!['swarm','operations','deployment','webhook'].includes(type))advancedUI?.cancel?.();if(!state.modal)modalPreviousFocus=document.activeElement;state.modal=type;$('#modal-root').innerHTML=`<div class="modal-backdrop"><section class="modal${wide?' wide':''}" role="dialog" aria-modal="true" tabindex="-1" aria-label="${escape(type==='prompts'?'Prompt templates':type==='task-methods'?'Reusable methods':type)}">${html}</section></div>`;const modal=$('#modal-root .modal'),heading=modal?.querySelector('.modal-header h2'),focusAtOpen=document.activeElement;if(heading?.textContent?.trim())modal.setAttribute('aria-label',heading.textContent.trim());requestAnimationFrame(()=>{if(intent!==subviewIntent||modal!==$('#modal-root .modal'))return;const focused=document.activeElement;if(focused!==focusAtOpen&&focused!==document.body&&focused?.isConnected)return;const first=$$('textarea, input:not([type="hidden"]), select, button:not([data-action="close-modal"])',modal).find(element=>!element.disabled&&!element.closest('[hidden],[inert]')&&element.getClientRects().length>0);(first||modal)?.focus({preventScroll:true});});}
  function closeModal({restoreFocus=true}={}){subviewIntent++;stopPaletteSearch();inboxUI?.cancel();artifactUI?.cancel();promptsUI?.cancel();emailUI?.cancel();projectsUI?.cancel();advancedUI?.cancel?.();const wasDirection=state.modal==='agent-direction',previous=modalPreviousFocus;state.modal=null;modalPreviousFocus=null;$('#modal-root').innerHTML='';if(restoreFocus&&previous?.isConnected!==false)previous?.focus({preventScroll:true});if(wasDirection)renderExecution();}
  const modalHeader = (title,subtitle,iconName='workflow') => `<div class="modal-header"><span class="node-icon">${icon(iconName,20)}</span><div class="modal-title"><h2>${title}</h2><p>${subtitle}</p></div><button class="icon-button modal-close" data-action="close-modal" aria-label="Close dialog">${icon('close',17)}</button></div>`;
  function rememberedTask(){try{return JSON.parse(localStorage.getItem(`relay.lastTask.${state.workflow.id}`)||'null')?.task||'';}catch{return '';}}
  function rememberTask(task,cwd){try{localStorage.setItem(`relay.lastTask.${state.workflow.id}`,JSON.stringify({task,cwd}));}catch{}}
  function issuesHTML(issues){return `<div class="workflow-diagnostics">${issues.map(issue=>`<button type="button" class="diagnostic-item ${issue.level}" data-action="diagnostic-node" data-id="${escape(issue.nodeId||'')}">${icon(issue.level==='error'?'info':'check',13)}<span>${escape(issue.message)}</span>${icon('chevron',12)}</button>`).join('')}</div>`;}
  function showDiagnostics(){const issues=graphIssues();showModal('diagnostics',`${modalHeader(issues.some(issue=>issue.level==='error')?'Finish connecting your workflow':'Your workflow is ready','Check your graph before running your team.','workflow')}<div class="modal-body">${issues.length?issuesHTML(issues):`<div class="notice success">${icon('check',16)}<strong>Every step connects from task input to result.</strong><p>Your graph has no configuration issues.</p></div>`}</div><div class="modal-footer"><button class="button" data-action="close-modal">Close</button>${issues.some(issue=>issue.level==='error')?'':`<button class="button primary" data-action="run">${icon('play',12)}Run workflow</button>`}</div>`);}
  function showRun({destination='workflow'}={}){if(busy()){state.panelCollapsed=false;renderExecution();return;}const unavailable=state.workflow.nodes.filter(node=>node.type==='agent'&&!missionModels(state.status,node.model||'default').some(model=>model.value===(node.model||'default')&&model.available)),connected=unavailable.length===0,issues=graphErrors();showModal('run',`${modalHeader('What should your team accomplish?','Your task flows through every connected agent.','play')}<form id="run-form" data-destination="${destination==='mission'?'mission':'workflow'}"><div class="modal-body">${!connected?`<div class="notice error"><strong>Connect your team's models</strong><p>${escape(unavailable.map(node=>node.name||node.model||'Default model').join(', '))}</p><button class="button subtle" data-action="models-connections" type="button">${icon('settings',12)}Models & APIs</button><button class="button subtle" data-action="refresh-run-runtime" type="button">${icon('refresh',12)}Check again</button></div>`:''}${issues.length?`<div class="notice error"><strong>${issues.length} workflow ${issues.length===1?'issue':'issues'} to resolve</strong>${issuesHTML(issues)}</div>`:''}<label class="field"><span class="field-label">Your task</span><textarea id="run-task" name="task" placeholder="Describe the result you want your agents to deliver…" required>${escape(rememberedTask())}</textarea><span class="field-help">Include the outcome, useful context, and how to verify success.</span></label><label class="field"><span class="field-label">Working folder</span><input id="run-cwd" name="cwd" placeholder="e.g. C:\\Projects\\my-project" value="${escape(state.workflow.settings?.cwd||state.status.cwd||'')}" required><span class="field-help">Choose an existing folder. Your agents work with its files and tools.</span></label>${state.workflow.nodes.some(n=>n.desktop)?`<div class="run-desktop-status"><span class="status-dot${state.desktop.enabled?' connected':''}"></span>${state.desktop.enabled?'Windows desktop connected':'This workflow uses your Windows desktop.'}</div>`:''}<div id="run-error" class="error-text" role="alert" style="margin-top:12px"></div></div><div class="modal-footer"><span class="footer-note">${state.workflow.nodes.filter(n=>n.type==='agent').length} ${state.workflow.nodes.filter(n=>n.type==='agent').length===1?'agent':'agents'} · ${escape(state.workflow.name)}</span><button class="button" type="button" data-action="close-modal">Cancel</button><button class="button primary" type="submit"${connected&&!issues.length?'':' disabled'}>${icon('play',12)}Start run</button></div></form>`);installFolderPicker();}
  async function submitWorkflowRun(form){
        const task=$('#run-task',form).value.trim(),cwd=$('#run-cwd',form).value.trim();if(!task||!cwd||graphErrors().length)return;
        let ownership;const workflowId=state.workflow.id,destination=form.dataset.destination==='mission'?'mission':'workflow',isCurrent=()=>ownership&&ownsView(ownership)&&form===$('#run-form')&&state.workflow?.id===workflowId,button=$('button[type=submit]',form),generations=new Map(runEventGenerations);if(button.disabled)return;button.disabled=true;button.textContent='Starting…';
        try{
          state.workflow.settings={...state.workflow.settings,cwd};markDirty('setting:cwd');ownership=captureViewOwnership();await saveWorkflow();if(!isCurrent())return;if(state.saveError)throw new Error('Save your workflow successfully before starting the run.');
          const response=await api('/api/runs','POST',{workflow:structuredClone(state.workflow),input:{task,cwd}}),run=rememberRunReceipt(response.run||response,generations);
          if(!isCurrent()){renderStreamState();refreshRuns();return;}
          state.currentRun=run;state.traceFilter=null;state.executionTab='trace';state.panelCollapsed=false;rememberTask(task,cwd);closeModal();
          if(destination==='mission')showMission();renderAll();toast(destination==='mission'?'Swarm started.':'Workflow started. Follow your agents in the trace.');refreshRuns();
          if(destination==='mission')await openRun(run.id,'mission');
        }catch(error){
          if(!isCurrent())return;const missingFolder=/directory|folder|ENOENT|cwd/i.test(error.message);$('#run-error',form).textContent=`${error.message}${missingFolder?' Choose an existing working folder, then start again.':''}`;if(missingFolder)$('#run-cwd',form).focus({preventScroll:true});button.disabled=false;button.innerHTML=`${icon('play',12)}Start run`;
        }finally{if(form===$('#run-form')){button.disabled=false;button.innerHTML=`${icon('play',12)}Start run`;}}
  }
  function installFolderPicker(){if(!window.relayDesktop?.pickFolder)return;const input=$('#run-cwd');if(input&&!$('#run-pick-folder'))input.insertAdjacentHTML('afterend',`<button class="button folder-picker" type="button" id="run-pick-folder" data-action="pick-folder" data-input="run-cwd">${icon('folder',13)}Choose folder</button>`);}

  function showRuntime(preserve=false){const s={...(state.status.codex||state.status),cwd:state.status.cwd},ok=s.connected&&s.authenticated;const html=`${modalHeader('Your Codex runtime','A direct connection to Codex on this machine.','terminal')}<div class="modal-body"><div class="notice ${ok?'success':'error'}"><strong>${ok?'Connected and ready':s.connected?'Sign-in needed':'Runtime is offline'}</strong><br>${escape(ok?'Your existing Codex credentials are used. API keys are not stored in this interface.':s.error||s.lastError||'Install Codex, sign in, and restart the BLACKICE server.')}</div><dl class="runtime-meta"><dt>Connection</dt><dd>${s.connected?'Connected':'Disconnected'}</dd><dt>Authentication</dt><dd>${s.authenticated?'Signed in':'Not authenticated'}</dd><dt>Version</dt><dd>${escape(s.version||'Unavailable')}</dd><dt>Default model</dt><dd>${escape(s.defaultModel||'Codex default')}</dd><dt>Workspace</dt><dd>${escape(s.cwd||'Not configured')}</dd><dt>Available models</dt><dd>${s.models?.length||0}</dd></dl>${!ok?`<div class="inspector-section"><div class="inspector-section-title">Connect locally</div><p class="field-help" style="font-size:11px">In a local terminal, install Codex if needed, then sign in:</p><pre class="runtime-command">npm install -g @openai/codex\ncodex login</pre><p class="field-help">If you just installed Codex, restart the BLACKICE server so it can find the command. Keep this app open from its local server address.</p></div>`:''}</div><div class="modal-footer"><button class="button" data-action="refresh-runtime">${icon('refresh',13)}Check connection</button><button class="button primary" data-action="close-modal">Done</button></div>`;if(preserve){$('#modal-root .modal').innerHTML=html;}else showModal('runtime',html);}
  function showTemplates(){showModal('templates',`${modalHeader('Start with a good team','Choose a workflow, then make it yours.','layers')}<div class="modal-body"><div class="template-cards">${[{kind:'software',name:'Software delivery',description:'A planner, builder, and reviewer take a coding task from idea to verified implementation.',icon:'code',badge:'3 agents'},{kind:'review',name:'Review & refine',description:'Investigate the workspace, challenge the findings, and write a clear final report.',icon:'search',badge:'3 agents'}].map(t=>`<button class="template-card" data-action="template" data-kind="${t.kind}"><span class="node-icon">${icon(t.icon,19)}</span><div><h3>${t.name}</h3><p>${t.description}</p><span class="badge">${t.badge}</span></div></button>`).join('')}</div></div><div class="modal-footer"><span class="footer-note">Creates a new workflow. Your current workflow stays saved.</span><button class="button" data-action="close-modal">Cancel</button></div>`);}
  function showHistory(){showModal('history',`${modalHeader('Run history','A local record of your agents’ work.','clock')}<div class="modal-body" id="history-modal-body">${historyHTML(state.runs)}</div><div class="modal-footer"><span class="footer-note">${state.runs.length} recorded runs</span><button class="button" data-action="close-modal">Close</button></div>`,true);}
  function showImport(){showModal('import',`${modalHeader('Import a workflow','Paste a BLACKICE workflow JSON or select a file.','upload')}<form id="import-form"><div class="modal-body"><label class="field"><span class="field-label">Workflow file</span><input type="file" id="import-file" accept=".json,application/json"></label><label class="field"><span class="field-label">Workflow JSON</span><textarea id="import-json" class="import-area" spellcheck="false" placeholder='{"version":1,"name":"My workflow","nodes":[],"edges":[]}' required></textarea></label><div id="import-error" class="error-text"></div></div><div class="modal-footer"><button class="button" type="button" data-action="close-modal">Cancel</button><button class="button primary" type="submit">Import workflow</button></div></form>`);}

  function stopPaletteSearch(){paletteSearch?.destroy();paletteSearch=null;}
  function paletteSearchController(){
    if(!paletteSearch)paletteSearch=createConversationSearch({api,limit:20,onChange:result=>{
      const input=$('#command-query');if(state.modal==='commands'&&input&&input.value.trim()===result.query)renderCommands(input.value);
    }});
    return paletteSearch;
  }
  function commandChats(query=''){
    const result=paletteSearch?.get(),searched=query.trim()&&result?.query===query.trim()&&(result.status==='ready'||result.conversations.length);
    const chats=searched?result.conversations:missionUI?.searchChats(query,query.trim()?20:5)||[];
    const items=chats.map(chat=>({id:`chat:${chat.latestRunId||chat.runId||chat.id}`,label:chat.title,detail:chat.state==='archived'?'Archived chat':'Chat',
      ...(searched?{match:chat.match,preview:`${searchMatchLabel(chat.match)} · ${chat.match.text}`,query:query.trim()}:{}),icon:'text',chat:true}));
    if(query.trim()&&result?.status==='error')items.push({id:'search-retry',label:'Retry message search',detail:'Chat titles and commands remain available',icon:'refresh',chat:true});
    if(searched&&result.hasMore)items.push({id:'search-all',label:'See all matching chats',detail:`${result.total} matches · Continue in the chat list`,icon:'search',chat:true,query:query.trim()});
    return items;
  }
  const commandCatalog=(query='')=>[
    ...commandChats(query),
    {id:'planning',label:'Planning workspace',detail:'Edit saved objectives, steps, dependencies and branches',keywords:'plan outline mind map steps readiness agent edit',icon:'plan'},
    {id:'projects',label:'Swarms',detail:'Saved team plans, shared work and acceptance checks',keywords:'project management capabilities expansion automation agentic loops review verify repair',icon:'workflow'},
    {id:'email',label:'Email setup & drafts',detail:'Background mailbox adapter and local message drafts',keywords:'mail email himalaya inbox draft',icon:'mail'},
    {id:'task-notes',label:'Task plans & notes',detail:'Open the current task outline, notes and evidence',keywords:'plan notes steps checkpoints',icon:'plan'},
    {id:'schedule',label:'Schedule a task',detail:'Choose a task and when it runs',keywords:'cron cronjob recurring automation timer',icon:'clock'},
    {id:'swarm',label:'Create a swarm',detail:'Several specialists, one result',keywords:'team parallel agents',icon:'agent'},
    {id:'operations',label:'Manage schedules & cronjobs',detail:'Saved schedules, upcoming tasks and job history',keywords:'cron cronjobs operations automation recurring',icon:'clock'},
    {id:'mission',label:'Go to conversation',detail:'Return to your current chat',keywords:'view chat',icon:'spark'},
    {id:'inbox',label:'Task inbox',detail:'Capture tasks, change their order, or run the queue',icon:'inbox'},
    {id:'agent-workspace',label:'Your agent',detail:'Identity, user profile, learning, context and connected tools',icon:'identity'},
    {id:'models-connections',label:'Models & APIs',detail:'Connect a provider or change your default model',keywords:'api key keys openrouter openai anthropic ollama custom endpoint local connection reasoning',icon:'settings',shortcut:'Ctrl M'},
    {id:'run-limits',label:'Time limits',detail:'Choose agent duration and API inactivity limits',keywords:'timeout deadline duration long running stalled run response limits',icon:'clock'},
    {id:'prompts',label:'Prompt outlines',detail:'Reusable prompt outlines for your next message',keywords:'prompt prompts template templates structure brief outline outlines method methods catalyst',icon:'text'},
    {id:'configure',label:'Settings',detail:'Working folder, concurrent tasks and app setup',keywords:'configure configuration preferences',icon:'settings'},
    {id:'browser-workspace',label:'Open browser workspace',detail:'The browser your agents can use',icon:'grid'},
    {id:'run',label:'Run Studio workflow',detail:'Give the current graph a task',icon:'play',shortcut:'Ctrl ↵',studio:true,disabled:busy()},
    {id:'save',label:'Save workflow',detail:'Save your current changes locally',icon:'save',shortcut:'Ctrl S',studio:true},
    {id:'new-workflow',label:'New workflow',detail:'Start with an empty canvas',icon:'plus',studio:true},
    {id:'templates',label:'Choose a workflow template',detail:'Software, review, and Windows desktop agents',icon:'layers',studio:true},
    {id:'desktop',label:'Open agent desktop',detail:'See the attached Windows session',icon:'desktop'},
    {id:'knowledge',label:'Memory & skills',detail:'Automatic saved context, sources and Undo',keywords:'memories remembered procedure patch restore',icon:'book'},
    {id:'learning',label:'Learning history',detail:'What BLACKICE learned and the evidence behind it',keywords:'automatic audit skill memory undo',icon:'learning'},
    {id:'file-patches',label:'File changes',detail:'Inspect targeted patches and undo a change',keywords:'patch patches code diff history undo restore',icon:'text'},
    {id:'history',label:'Browse run history',detail:'Open previous tasks and their results',icon:'clock'},
    {id:'fit',label:'Fit workflow to canvas',detail:'Bring every step into view',icon:'fit',shortcut:'F',studio:true},
    {id:'auto-layout',label:'Arrange workflow nodes',detail:'Organize your graph automatically',icon:'grid',studio:true},
    {id:'undo',label:'Undo last edit',detail:'Restore the previous graph state',icon:'undo',shortcut:'Ctrl Z',studio:true,disabled:!editHistory.canUndo},
    {id:'redo',label:'Redo edit',detail:'Restore an undone graph change',icon:'redo',shortcut:'Ctrl ⇧ Z',studio:true,disabled:!editHistory.canRedo},
    {id:'runtime',label:'Check Codex runtime',detail:'Connection, account, and available models',icon:'terminal'},
    {id:'diagnostics',label:'Check workflow',detail:'Find missing instructions or connections',icon:'check',studio:true},
    {id:'import',label:'Import workflow',detail:'Open a BLACKICE workflow JSON file',icon:'upload',studio:true},
    {id:'shortcuts',label:'Keyboard shortcuts',detail:'A little less clicking',keywords:'help hotkeys keyboard',icon:'keyboard'},
    ...state.workflows.map(workflow=>({id:`workflow:${workflow.id}`,label:workflow.name,detail:'Switch workflow',icon:'workflow',studio:true}))
  ];
  function matchingCommands(query=''){
    const text=query.trim().toLowerCase(),words=text.split(/\s+/),matches=commandCatalog(query).filter(command=>command.chat||((text||state.screen==='workflow'||!command.studio)&&words.every(word=>`${command.label} ${command.detail} ${command.keywords||''}`.toLowerCase().includes(word))));
    if(!text)return matches;
    const rank=command=>{const label=command.label.toLowerCase();return label===text?0:label.startsWith(text)?1:label.includes(text)?2:words.every(word=>label.includes(word))?3:4;};
    const commands=matches.filter(command=>!command.chat).map((command,index)=>({command,index,rank:rank(command)})).sort((left,right)=>left.rank-right.rank||left.index-right.index).map(entry=>entry.command);
    return [...matches.filter(command=>command.chat),...commands];
  }
  function renderCommands(query=''){
    const container=$('#command-results'),input=$('#command-query');if(!container||!input)return;
    const previous=state.paletteRenderedQuery===query?state.paletteCommands?.[state.paletteIndex]?.id:null;
    const focused=container.contains(document.activeElement)?document.activeElement.closest('[data-command]')?.dataset.command:null;
    const commands=matchingCommands(query);state.paletteCommands=commands;state.paletteRenderedQuery=query;
    const retained=previous?commands.findIndex(command=>command.id===previous):-1;
    state.paletteIndex=retained>=0?retained:Math.max(0,Math.min(state.paletteIndex,commands.length-1));
    if(commands[state.paletteIndex]?.disabled){const enabled=commands.findIndex(command=>!command.disabled);if(enabled>=0)state.paletteIndex=enabled;}
    container.innerHTML=commands.length?commands.map((command,index)=>`<button class="command-result${index===state.paletteIndex?' active':''}" id="command-option-${index}" role="option" aria-selected="${index===state.paletteIndex}" data-action="command-execute" data-command="${escape(command.id)}"${command.match?` data-search-run-id="${escape(command.match.runId)}"`:''}${command.disabled?' disabled':''}><span class="node-icon">${icon(command.icon,17)}</span><span class="command-result-copy"><strong>${escape(command.label)}</strong><small>${escape(command.detail)}</small>${command.preview?`<span class="command-match-preview">${escape(command.preview)}</span>`:''}</span>${command.shortcut?`<kbd class="command-shortcut">${escape(command.shortcut)}</kbd>`:icon('chevron',12)}</button>`).join(''):'<div class="modal-empty">No matching chats or commands.</div>';
    if(commands.length)input.setAttribute('aria-activedescendant',`command-option-${state.paletteIndex}`);else input.removeAttribute('aria-activedescendant');
    const notice=$('#command-search-status'),result=paletteSearch?.get();
    if(notice){notice.hidden=!query.trim();const text=!query.trim()?'':result?.status==='error'?`Message search unavailable. ${result.error}`:!result||['waiting','loading'].includes(result.status)?'Searching saved messages and file names…':`${result.total} matching ${result.total===1?'chat':'chats'}${result.truncated?' · Some saved history is unavailable.':''}`;if(notice.textContent!==text)notice.textContent=text;}
    if(focused){const next=$$('[data-command]',container).find(row=>row.dataset.command===focused);(next||input).focus({preventScroll:true});}
  }
  function showCommands(){
    if(state.modal&&state.modal!=='commands')return;stopPaletteSearch();state.paletteIndex=0;state.paletteRenderedQuery=null;
    showModal('commands',`<div class="command-palette"><div class="command-search">${icon('search',19)}<input id="command-query" placeholder="Search messages, files, or commands…" aria-label="Search chat messages, file names and commands" role="combobox" aria-expanded="true" aria-controls="command-results" aria-autocomplete="list" autocomplete="off" maxlength="200"><kbd>Esc</kbd></div><div id="command-search-status" class="command-search-status" role="status" aria-live="polite" hidden></div><div id="command-results" class="command-results" role="listbox" aria-label="Chats and commands"></div><div class="command-footer"><span>↑ ↓ to navigate</span><span>↵ to select</span><span>Ctrl K to open</span></div></div>`);
    $('#modal-root .modal').classList.add('command-modal');paletteSearchController();renderCommands();
  }
  function showShortcuts(){const studio=state.screen==='workflow',rows=[['Search chats & commands','Ctrl / ⌘ + K'],['Models & APIs','Ctrl / ⌘ + M'],...(studio?[['Run workflow','Ctrl / ⌘ + Enter'],['Save workflow','Ctrl / ⌘ + S'],['Undo edit','Ctrl / ⌘ + Z'],['Redo edit','Ctrl / ⌘ + Shift + Z'],['Fit workflow','F'],['Delete selection','Delete'],['Pan canvas','Space + drag'],['Zoom canvas','Ctrl / ⌘ + scroll']]:state.screen==='mission'?[['Send message from the composer','Ctrl / ⌘ + Enter'],['Chat actions','Right-click a chat']]:[]),['Close dialog','Esc'],['Stop desktop control','Ctrl + Alt + Esc']];showModal('shortcuts',`${modalHeader('Keyboard shortcuts','','keyboard')}<div class="modal-body"><div class="shortcut-grid">${rows.map(([label,keys])=>`<span>${escape(label)}</span><kbd>${escape(keys)}</kbd>`).join('')}</div></div><div class="modal-footer"><button class="button primary" data-action="close-modal">Done</button></div>`);}
  async function executeCommand(commandId){const command=(state.paletteCommands||commandCatalog()).find(item=>item.id===commandId);if(!command||command.disabled)return;if(commandId==='search-retry'){await paletteSearchController().retry();return;}closeModal();if(commandId==='search-all'){showMission();missionUI?.findChats(command.query);return;}if(commandId.startsWith('chat:')){if(command.match)await missionUI?.openSearchResult(command,command.query);else await missionUI?.openConversation(commandId.slice(5));return;}if(commandId.startsWith('workflow:')){const workflow=state.workflows.find(w=>w.id===commandId.slice(9));if(workflow){showWorkflow();await loadWorkflow(workflow);}return;}if(commandId==='planning')return showPlanning();if(commandId==='projects')return showProjects();if(commandId==='schedule')return showSchedule();if(commandId==='swarm')return showSwarm();if(commandId==='operations')return showOperations();if(commandId==='models-connections')return showConnections();if(commandId==='email')return showEmailWorkspace();if(commandId==='task-notes')return showTaskNotes();if(commandId==='configure')return showConfigure();if(commandId==='run-limits')return showRunLimits();if(commandId==='prompts')return showPrompts();if(commandId==='shortcuts')return showShortcuts();if(commandId==='mission')return showMission();if(commandId==='undo'||commandId==='redo'){restoreHistory(commandId);return;}if(commandId==='diagnostics')return showDiagnostics();if(commandId==='fit'){showWorkflow();requestAnimationFrame(fit);return;}const trigger=$(`[data-action="${commandId}"]`);trigger?.click();}
  function handleCommandKey(event){
    if(event.isComposing||event.keyCode===229||state.modal!=='commands'||!['ArrowDown','ArrowUp','Enter'].includes(event.key))return false;
    const focused=document.activeElement.closest('.command-result');
    if(event.key==='Enter'&&focused)return false;
    event.preventDefault();const rows=$$('.command-result'),enabled=rows.map((row,index)=>!row.disabled?index:null).filter(index=>index!==null);if(!enabled.length)return true;
    if(event.key==='Enter'){const row=rows[state.paletteIndex];if(row&&!row.disabled)row.click();return true;}
    const focusedIndex=rows.indexOf(focused);if(focusedIndex>=0)state.paletteIndex=focusedIndex;
    const position=enabled.indexOf(state.paletteIndex),next=(position+(event.key==='ArrowDown'?1:-1)+enabled.length)%enabled.length;state.paletteIndex=enabled[next];
    rows.forEach((row,index)=>{row.classList.toggle('active',index===state.paletteIndex);row.setAttribute('aria-selected',String(index===state.paletteIndex));});$('#command-query').setAttribute('aria-activedescendant',`command-option-${state.paletteIndex}`);rows[state.paletteIndex]?.scrollIntoView({block:'nearest'});if(focused)rows[state.paletteIndex]?.focus({preventScroll:true});return true;
  }
  async function retryRun(runId=state.currentRun?.id){const previous=state.currentRun?.id===runId?state.currentRun:state.runs.find(run=>run.id===runId);if(!previous||state.retrying||previous.settled!==true||!['failed','cancelled'].includes(previous.status))return;const ownership=beginViewOperation(),generations=new Map(runEventGenerations);state.retrying=true;renderExecution();try{const data=await api(`/api/runs/${encodeURIComponent(previous.id)}/retry`,'POST',{}),run=rememberRunReceipt(data.run||data,generations);if(ownsView(ownership)){state.currentRun=run;state.traceFilter=null;state.executionTab='trace';state.panelCollapsed=false;renderAll();}else renderStreamState();refreshRuns();toast('Retry started. Completed steps are reused.');return run;}catch(error){toast(error.message,true);scheduleRunRefresh(previous.id);}finally{state.retrying=false;renderExecution();}}

  async function openRun(id,view='workflow',{selectConversation=true,selectedNodeId}={}){
    if(view==='mission'&&selectConversation&&missionUI){await missionUI.openConversation(id);return state.runs.find(run=>run.id===id)||state.currentRun;}
    const ownership=beginViewOperation(),generations=new Map(runEventGenerations);
    try{const data=await api(`/api/runs/${encodeURIComponent(id)}`),run=rememberRunReceipt(data.run||data,generations),workflow=run.workflow||state.workflows.find(w=>w.id===run.workflowId);
      if(!ownsView(ownership))return run;
      if(!workflow)throw new Error('The saved workflow for this task could not be loaded.');
      if(!await loadWorkflow(workflow,{ownership})||!ownsView(ownership))return run;
      state.currentRun=state.runs.find(item=>item.id===id)||run;if(selectedNodeId&&workflow.nodes.some(node=>node.id===selectedNodeId)){state.selected=selectedNodeId;state.selectedEdge=null;state.inspectorTab='activity';}state.continuationError='';state.continueNodeId=null;state.traceFilter=null;state.executionTab='trace';state.panelCollapsed=false;
      if(view==='mission')showMission();else if(view==='observe')showObserve();else showWorkflow();closeModal();renderAll();return state.currentRun;
    }catch(error){if(ownsView(ownership)){toast(error.message,true);throw error;}return state.runs.find(run=>run.id===id);}
  }
  async function stopAllChats(){await api('/api/runs/stop-all','POST',{});await Promise.all([refreshRuns(),refreshStatus()]);toast('Stopping all chats. Queued starts are paused.');}
  async function cancelRun(runId=state.currentRun?.id,{throwOnError=false}={}){
    if(!runId)return;
    const generations=new Map(runEventGenerations);
    try{
      const data=await api(`/api/runs/${encodeURIComponent(runId)}/cancel`,'POST'),run=rememberRunReceipt(data.run||data,generations);
      renderStreamState();missionUI?.update();observeUI?.update();
      toast(run?.settled===true?(run.status==='cancelled'?'Stopped.':'This response has already finished.'):'Stop requested.');
      scheduleRunRefresh(runId);return run;
    }catch(error){scheduleRunRefresh(runId);if(throwOnError)throw error;toast(error.message,true);}
  }
  async function refreshRuns(){const generations=new Map(runEventGenerations);try{const incoming=asArray(await api('/api/runs'),'runs'),changedRunIds=new Set([...runEventGenerations].filter(([id,generation])=>generation!==(generations.get(id)||0)).map(([id])=>id));state.runs=mergeRunSnapshots(state.runs,incoming,{currentRun:state.currentRun,changedRunIds});if(state.currentRun?.id)state.currentRun=state.runs.find(run=>run.id===state.currentRun.id)||state.currentRun;for(const id of runEventGenerations.keys())if(!state.runs.some(run=>run.id===id))runEventGenerations.delete(id);missionUI?.update();if(state.executionTab==='history')renderExecution();if(state.modal==='history')$('#history-modal-body').innerHTML=historyHTML(state.runs);}catch{/* Next stream event will retry. */}}
  function scheduleRunRefresh(id){if(!id)return;clearTimeout(runRefreshTimers.get(id));runRefreshTimers.set(id,setTimeout(async()=>{runRefreshTimers.delete(id);const generation=runEventGenerations.get(id)||0;try{const data=await api(`/api/runs/${encodeURIComponent(id)}`),incoming=data.run||data,existing=state.currentRun?.id===id?state.currentRun:state.runs.find(run=>run.id===id),run=adoptFetchedRun(existing,incoming,{changedSinceRequest:(runEventGenerations.get(id)||0)!==generation});state.runs=mergeRunSnapshots(state.runs,[run],{currentRun:state.currentRun?.id===id?run:state.currentRun});if(state.currentRun?.id===id){state.currentRun=run;renderHeader();renderGraph();renderExecution();if(state.inspectorTab==='activity')renderInspector();}else renderStreamState();missionUI?.update();}catch{}},200));}
  // Widget failures must not stop canonical event state or other views.
  function protectUI(update) {
    try { const result = update(); if (result?.catch) result.catch(error => globalThis.blackiceUIResilience?.report(error)); }
    catch (error) { globalThis.blackiceUIResilience?.report(error); }
  }
  let liveViewFrame = false;
  let workflowRenderPending = false;
  const liveViewWork = new Set();
  function scheduleLiveViews(...views) {
    for (const view of views.length ? views : ['mission', 'observe']) liveViewWork.add(view);
    if (liveViewFrame) return;
    liveViewFrame = true;
    requestAnimationFrame(() => {
      liveViewFrame = false;
      const pending = new Set(liveViewWork); liveViewWork.clear();
      // Every receipt is reduced immediately. Expensive DOM work sees the latest
      // state once per frame, and hidden workspaces refresh when opened.
      if (pending.has('header')) protectUI(renderHeader);
      if (pending.has('desktop')) protectUI(renderDesktop);
      if (state.screen !== 'workflow' && ['graph', 'execution', 'inspector'].some(view => pending.has(view))) workflowRenderPending = true;
      if (state.screen === 'workflow') {
        if (pending.has('graph')) protectUI(renderGraph);
        if (pending.has('execution')) protectUI(renderExecution);
        if (pending.has('inspector')) protectUI(renderInspector);
      }
      if (pending.has('stream')) protectUI(renderStreamState);
      if (state.screen === 'mission' && pending.has('mission')) protectUI(() => missionUI?.update());
      if (state.screen === 'observe' && pending.has('observe')) protectUI(() => observeUI?.update());
    });
  }
  function handleEvent(event){let payload;try{payload=JSON.parse(event.data);}catch{return;}if(!payload||typeof payload!=='object'||Array.isArray(payload)||typeof payload.type!=='string'||payload.runId!==undefined&&typeof payload.runId!=='string')return;state.lastEventAt=Date.now();scheduleLiveViews();protectUI(()=>observeUI?.handleEvent(payload));protectUI(()=>planningUI?.handleEvent(payload));const {type,runId,nodeId,data,at}=payload;if(runId)runEventGenerations.set(runId,(runEventGenerations.get(runId)||0)+1);if(type==='observe.presentation'){const run=state.runs.find(item=>item.id===runId);if(run)run.observePresentation=data;if(state.currentRun?.id===runId)state.currentRun.observePresentation=data;return;}if(type==='workflows.updated'){if(!data||typeof data.id!=='string'||!Array.isArray(data.nodes)||!Array.isArray(data.edges))return;const idx=state.workflows.findIndex(item=>item.id===data.id);if(idx>=0)state.workflows[idx]=data;else state.workflows.push(data);if(!state.dirty&&state.workflow?.id===data.id)loadWorkflow(data,{preserveRun:true}).catch(error=>toast(error.message,true));protectUI(()=>configureUI?.update());return;}if(type==='desktop.updated'){state.desktop={...state.desktop,...desktopStatus(data)};if(!state.desktop.enabled){desktopPollVersion++;clearTimeout(desktopTimer);state.desktopFrame=null;state.desktopWindows=[];if(state.modal==='desktop-preview')closeModal();}scheduleLiveViews('desktop');return;}if(type==='desktop.action'){if(data?.source==='preview')return;state.desktopActions.push({...data,at:data?.at||at});state.desktopActions=state.desktopActions.slice(-100);scheduleLiveViews('desktop');return;}if(type==='runtime.status'){state.status={...state.status,...data};state.statusLoaded=true;scheduleLiveViews('header');return;}if(type==='run.updated'){const run=data?.run||data;if(run?.id){const previous=state.currentRun?.status;if(!state.currentRun||state.currentRun.id===run.id){state.currentRun=run;const stored=state.runs.findIndex(item=>item.id===run.id);if(stored>=0)state.runs[stored]=run;else state.runs.unshift(run);scheduleLiveViews('header');scheduleLiveViews('graph');scheduleLiveViews('execution');if(state.inspectorTab==='activity')scheduleLiveViews('inspector');if(run.status==='completed'&&previous!=='completed'){const task=typeof run.input==='string'?run.input:run.input?.task;if(task&&run.workflowId===state.workflow.id)rememberTask(task,run.input?.cwd);toast('Workflow completed. Your result is ready.');}if(run.status==='failed'&&previous!=='failed')toast(errorText(run.error||'The workflow failed. See the trace for details.'),true);}const idx=state.runs.findIndex(r=>r.id===run.id);if(idx>=0)state.runs[idx]=run;else state.runs.unshift(run);scheduleLiveViews('stream');if(!['queued','running','waiting'].includes(run.status)){scheduleLiveViews('execution');scheduleLiveViews('desktop');}return;}}
    if(type==='planning.updated'){if(data?.steps)rememberPlanReceipt(data);else for(const run of state.runs)if((run.taskId||run.taskState?.taskId)===data?.taskId)scheduleRunRefresh(run.id);return;}
    if(type==='remote-access.updated'){state.status.remoteAccess=data;protectUI(()=>configureUI?.update());return;}
    if(type==='desktop.lifecycle'){state.status.desktopLifecycle=data;protectUI(()=>configureUI?.update());return;}
    if(type==='runtime.settings'){state.status.runtimeSettings=data;protectUI(()=>configureUI?.update());return;}
    if(type==='conversations.changed'){missionUI?.refreshHistory()?.catch(error=>toast(error.message,true));return;}
    if(type==='execution.updated'){state.status.execution=data;scheduleLiveViews('stream');return;}
    if(['email.updated','learning.updated','connections.updated','identity.updated','attachments.updated','inbox.updated','operations.updated','conversations.updated','prompts.updated'].includes(type)){const previous=state.status[type.split('.')[0]];state.status[type.split('.')[0]]=data;if(type==='conversations.updated'&&(previous?.conversations!==data?.conversations||previous?.turns!==data?.turns))missionUI?.refreshHistory()?.catch(()=>{});return;}
    if(type==='knowledge.updated'){state.status.knowledge=data;return;}
    if(type==='storage.updated'){const failed=state.status.storage?.healthy===false;state.status.storage=data;if(data?.healthy===false)toast('History could not be saved. '+errorText(data.error||'Check the local data folder.'),true);else if(failed)toast('History storage recovered.');return;}
    if(runId){const reduced=reduceRunCollection(state,payload);state.runs=reduced.runs;state.currentRun=reduced.currentRun;if(state.currentRun?.id===runId){if(type==='node.updated')scheduleLiveViews('graph');scheduleLiveViews('execution');if(state.inspectorTab==='activity')scheduleLiveViews('inspector');}if(!reduced.known||type==='node.updated')scheduleRunRefresh(runId);}
  }
  function renderStreamState(){
    scheduleLiveViews();
    const health=$('#workspace-health');
    if(health){
      const disconnected=state.streamState!=='live',activity=workspaceActivity({runs:state.runs,currentRun:state.currentRun,execution:state.status.execution}),storage=state.status.storage?.healthy===false||state.status.conversations?.healthy===false;
      const failure=modelFailure(state.status),modelReady=missionModels(state.status).find(model=>model.value==='default')?.available&&!failure,connection=runtimeConnectionFeedback({statusLoaded:state.statusLoaded,status:state.status});
      const label=disconnected?(state.streamState==='connecting'?'Connecting to BLACKICE…':'Reconnecting to BLACKICE…'):storage?'History needs attention':connection?.title||activity?.label||(!modelReady?'Model needs attention':'Ready');
      if(health.textContent!==label)health.textContent=label;
      health.classList.toggle('attention',storage||!disconnected&&!connection?.busy&&(!modelReady||Boolean(connection)));
      health.dataset.connecting=String(disconnected||Boolean(connection?.busy));health.setAttribute('aria-live','polite');
      health.title=disconnected?'Live updates are connecting. Tasks may still be running.':storage?'Open Chats to inspect the history error.':connection?.detail||activity?.title||(!modelReady?failure?.message||state.status.defaultModelError||'Choose or connect your default model.':'Connected to this BLACKICE instance');
    }
    const el=$('#stream-state');if(!el)return;const live=state.streamState==='live';el.className=`stream-state ${live?'live':state.streamState==='connecting'?'connecting':'offline'}`;el.innerHTML=`<span class="status-dot${live?' connected':''}"></span>${live?'Live':state.streamState==='connecting'?'Connecting…':'Reconnecting…'}`;el.title=live?'Activity stream connected to the local BLACKICE server':'Updates may be delayed. BLACKICE reconnects automatically.';
  }
  function startStream(){clearTimeout(streamRetryTimer);stream?.close();state.streamState='connecting';renderStreamState();const current=new EventSource('/api/events');stream=current;current.onmessage=event=>{if(stream===current)handleEvent(event);};current.onopen=()=>{if(stream!==current)return;missionUI?.refreshHistory()?.catch(()=>{});state.streamState='live';renderStreamState();refreshRuns();refreshStatus();if(state.currentRun)scheduleRunRefresh(state.currentRun.id);if(state.screen==='desktop')refreshDesktop(true);};current.onerror=()=>{if(stream!==current)return;current.close();state.streamState='reconnecting';renderStreamState();streamRetryTimer=setTimeout(async()=>{try{const session=await fetch('/',{credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(5000)});await session.text();}catch{}if(stream===current)startStream();},3000);};}
  function handleGlobalKey(event){
    if(event.defaultPrevented)return;
    const active=document.activeElement,key=event.key.toLowerCase(),modified=event.ctrlKey||event.metaKey;
    if(modified&&event.key==='Enter'&&state.screen==='mission'&&!state.modal){
      if(!active||active!==$('#mission-task')||active.readOnly||active.disabled||active.closest?.('[hidden],[inert]')||event.shiftKey||event.altKey||event.isComposing||event.keyCode===229)return;
      event.preventDefault();missionUI?.submitFocused();return;
    }
    if(modified&&key==='s'&&state.screen==='mission'&&!state.modal){event.preventDefault();toast('Your Chat draft is saved automatically.');return;}
    if(modified&&key==='s'&&$('#knowledge-editor')){event.preventDefault();$('#knowledge-editor').requestSubmit();return;}
    if(modified&&event.key==='Enter'&&active?.id==='continuation-message'){event.preventDefault();active.closest('form')?.requestSubmit();return;}
    if(modified&&key==='m'){event.preventDefault();showConnections();return;}
    if(modified&&key==='k'){event.preventDefault();if(state.modal==='commands')closeModal();else showCommands();return;}
    if(handleCommandKey(event))return;
    if(event.key==='Tab'&&state.modal){
      const root=$('#modal-root'),focusable=$$('a[href],area[href],button,input:not([type="hidden"]),textarea,select,summary,[tabindex],[contenteditable="true"]',root).filter(element=>element.tabIndex>=0&&!element.disabled&&!element.closest('[hidden],[inert]')&&(element.getClientRects?element.getClientRects().length>0:element.offsetParent!==null));
      const first=focusable[0],last=focusable.at(-1),inside=root.contains?.(active)??focusable.includes(active);
      if(!first){event.preventDefault();$('.modal',root)?.focus({preventScroll:true});}
      else if(event.shiftKey&&(!inside||active===first)){event.preventDefault();last.focus({preventScroll:true});}
      else if(!event.shiftKey&&(!inside||active===last)){event.preventDefault();first.focus({preventScroll:true});}
      return;
    }
    if(event.ctrlKey&&event.altKey&&event.key==='Escape'&&state.desktop.enabled){event.preventDefault();changeDesktop(false);return;}
    if(event.key==='Escape'){if(state.modal)closeModal();else{const menu=$('.workspace-menu');if(menu)menu.open=false;if(state.screen==='workflow'){state.connection=null;$('#inspector').classList.remove('mobile-visible');$('.library').classList.remove('mobile-visible');renderGraph();}}return;}
    // A hidden workflow must never consume another workspace's editing keys.
    if(state.screen!=='workflow'||state.modal)return;
    const focusedPort=active?.closest?.('[data-port]');if(focusedPort&&(event.key==='Enter'||event.code==='Space')){event.preventDefault();const id=focusedPort.dataset.nodeId,port=focusedPort.dataset.port;connectPort(port,id);requestAnimationFrame(()=>$(`[data-port="${port}"][data-node-id="${CSS.escape(id)}"]`)?.focus({preventScroll:true}));return;}
    const editing=/INPUT|TEXTAREA|SELECT/.test(active?.tagName)||active?.isContentEditable;
    if(modified&&key==='s'){event.preventDefault();saveWorkflow();return;}
    if(modified&&event.key==='Enter'){event.preventDefault();if(!busy())showRun();return;}
    if(modified&&key==='z'&&(!editing||active.dataset.nodeField||active.dataset.workflowField||active.dataset.setting||active.id==='workflow-name')){event.preventDefault();restoreHistory(event.shiftKey?'redo':'undo');return;}
    if(modified&&key==='y'&&!editing){event.preventDefault();restoreHistory('redo');return;}
    if(editing||active?.closest?.('button,a[href],summary,[role="button"],[role="tab"]'))return;
    if(event.code==='Space'){state.space=true;event.preventDefault();}
    if(key==='f'){event.preventDefault();fit();}
    if(event.key==='Delete'||event.key==='Backspace'){event.preventDefault();if(state.selected)deleteNode();else if(state.selectedEdge){state.workflow.edges=state.workflow.edges.filter(edge=>edge.id!==state.selectedEdge);state.selectedEdge=null;markDirty();renderGraph();renderInspector();}}
    if(event.key==='Enter'){const node=active?.closest?.('[data-node]');if(node)selectNode(node.dataset.node);}
  }
  function bind(){
    bindTaskStateEvents(document.querySelector('#app'),{onArtifact:showArtifact,onError:error=>toast(error.message,true)});
    document.addEventListener('click',async event=>{
      const port=event.target.closest('[data-port]');if(port&&event.detail===0){connectPort(port.dataset.port,port.dataset.nodeId);return;}
      const button=event.target.closest('[data-action]');if(!button)return;const picker=event.target.closest('.coordination-picker');if(picker)picker.open=false;const {action,id,kind,type,tab}=button.dataset;
      if(action==='commands')return showCommands();if(action==='command-execute')return executeCommand(button.dataset.command);if(action==='undo'||action==='redo')return restoreHistory(action);if(action==='projects')return showProjects();
      if(action==='schedule')return showSchedule();if(action==='swarm')return showSwarm();if(action==='operations')return showOperations();if(action==='configure')return showConfigure();if(action==='run-limits')return showRunLimits();if(action==='prompts')return showPrompts();if(action==='deploy-operation')return showDeployOperation();
      if(action==='inbox')return showInbox();if(action==='agent-workspace')return showAgentWorkspace();if(action==='identity')return showIdentity();if(action==='learning')return showLearning();if(action==='tool-connections')return showToolConnections();if(action==='context-settings')return showContextSettings();if(action==='compact-context'){const node=Object.entries(state.currentRun?.nodes||{}).find(([,n])=>n.threadId===button.dataset.threadId);if(node)return compactContext(state.currentRun.id,node[0]);return;}
      if(action==='workspace-health'){if(state.streamState!=='live'){startStream();toast('Reconnecting to BLACKICE…');return;}const issue=state.status.storage?.healthy===false?state.status.storage:state.status.conversations?.healthy===false?state.status.conversations:null;if(issue){showModal('history-recovery',`${modalHeader('History needs attention','','info')}<div class="modal-body"><p class="error-text">${escape(issue.error||'History could not be saved or read.')}</p><p class="field-help">Keep BLACKICE open and check the saved data before starting the same task again.</p></div><div class="modal-footer"><button class="button" data-action="close-modal">Done</button></div>`);return;}if(!missionModels(state.status).find(model=>model.value==='default')?.available||modelFailure(state.status))return showConnections();toast(busy()?'Your agent is working.':'BLACKICE is connected and ready.');return;}
      if(action==='knowledge')return showKnowledge();if(action==='file-patches')return showFilePatches();
      if(action==='planning')return showPlanning();if(action==='mission')return showMission();if(action==='models-connections')return showConnections();if(action==='email')return showEmailWorkspace();if(action==='task-notes')return showTaskNotes();if(action==='contained-browser')return showContainedBrowser();if(action==='browser-workspace')return showBrowserWorkspace();
      if(action==='direct-agent')return showDirection(id);
      if(action==='continue-node'){state.continueNodeId=id;state.continuationError='';state.executionTab='output';state.panelCollapsed=false;renderExecution();const input=$('#continuation-message');input?.focus({preventScroll:true});$('#execution-body').scrollTop=$('#execution-body').scrollHeight;return;}
      if(action==='diagnostics')return showDiagnostics();if(action==='diagnostic-node'){closeModal();showWorkflow();if(id)selectNode(id);else{state.selected=null;state.selectedEdge=null;renderInspector();}return;}
      if(action==='retry-run')return retryRun();if(action==='trace-filter'){state.traceFilter=id||null;renderExecution();return;}if(action==='copy-output')return copyText(runOutput()||'No output was returned.');if(action==='export-run'){if(state.currentRun)downloadText(`relay-run-${state.currentRun.id}.json`,JSON.stringify(state.currentRun,null,2),'application/json');return;}
      if(action==='refresh-run-runtime'){const form=$('#run-form'),owner=captureViewOwnership(),destination=form?.dataset.destination||'workflow';await refreshStatus();if(form===$('#run-form')&&ownsView(owner))showRun({destination});return;}
      if(action==='close-modal')return closeModal();if(action==='runtime')return showRuntime();if(action==='refresh-runtime'){button.disabled=true;try{await api('/api/runtime/reconnect','POST');}catch(error){toast(error.message,true);}await refreshStatus();return;}
      if(action==='desktop')return showDesktop();if(action==='workflow')return selectWorkspaceMode('workflow');if(action==='attach-desktop')return changeDesktop(true);if(action==='detach-desktop'){if(state.modal==='desktop-preview')closeModal();return changeDesktop(false);}if(action==='refresh-desktop')return refreshDesktop(true);if(action==='expand-desktop')return expandDesktop();
      if(action==='pick-folder'&&window.relayDesktop?.pickFolder){try{const path=await window.relayDesktop.pickFolder($(`#${CSS.escape(button.dataset.input)}`)?.value);const value=typeof path==='string'?path:path?.path||path?.filePaths?.[0];if(value){const input=$(`#${CSS.escape(button.dataset.input)}`);if(input){input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}));}}}catch(error){toast(error.message,true);}return;}
      if(action==='home')return showMission();
      if(action==='library'){const wasDesktop=state.screen==='desktop';showWorkflow();if(innerWidth<=580) $('.library').classList.toggle('mobile-visible');else if(!wasDesktop){$('#node-search').focus();}return;}
      if(action==='history')return showHistory();if(action==='templates')return showTemplates();if(action==='run')return showRun();if(action==='cancel')return cancelRun();if(action==='save')return saveWorkflow();
      if(action==='template'){closeModal();await saveWorkflow();const template=makeTemplate(kind);showWorkflow();await loadWorkflow(template);state.dirty=true;await saveWorkflow();toast(`${template.name} workflow created.`);return;}
      if(action==='new-workflow'){await saveWorkflow();const workflow={id:uid('workflow'),name:'Untitled workflow',description:'',version:1,nodes:[],edges:[],settings:{cwd:state.status.cwd||'',maxParallel:null}};await loadWorkflow(workflow);markDirty();toast('New workflow created. Add a node to get started.');return;}
      if(action==='add-node')return addNode(type);if(action==='select-node')return selectNode(id);if(action==='close-inspector')return $('#inspector').classList.remove('mobile-visible');
      if(action==='workflow-settings'){state.selected=null;state.selectedEdge=null;state.inspectorTab='configure';renderGraph();renderInspector();$('#inspector').classList.add('mobile-visible');return;}
      if(action==='delete-node')return deleteNode();if(action==='delete-edge'){state.workflow.edges=state.workflow.edges.filter(e=>e.id!==state.selectedEdge);state.selectedEdge=null;markDirty();renderGraph();renderInspector();return;}
      if(action==='duplicate'){const n=selectedNode();if(n){const copy={...structuredClone(n),id:uid(n.type),name:`${n.name} copy`,x:n.x+30,y:n.y+175};state.workflow.nodes.push(copy);state.selected=copy.id;markDirty();renderGraph();renderInspector();}return;}
      if(action==='delete-workflow'){if(!confirm(`Delete “${state.workflow.name}”? Saved run history will remain.`))return;try{await api(`/api/workflows/${encodeURIComponent(state.workflow.id)}`,'DELETE');state.workflows=state.workflows.filter(w=>w.id!==state.workflow.id);state.dirty=false;await loadWorkflow(state.workflows[0]||makeTemplate());if(!state.workflows.length)markDirty();toast('Workflow deleted.');}catch(error){toast(error.message,true);}return;}
      if(action==='inspector-tab'){state.inspectorTab=tab;renderInspector();return;}if(action==='execution-tab'){state.executionTab=tab;state.panelCollapsed=false;renderExecution();return;}
      if(action==='toggle-panel'){state.panelCollapsed=!state.panelCollapsed;renderExecution();return;}if(action==='fit')return fit();if(action==='zoom-in')return zoom(1.15);if(action==='zoom-out')return zoom(1/1.15);if(action==='reset-zoom')return zoom(1/state.view.scale);
      if(action==='auto-layout'){state.workflow.nodes.forEach((n,i)=>{const row=Math.floor(i/3),col=row%2?2-(i%3):i%3;n.x=40+col*300;n.y=75+row*255;});markDirty();renderGraph();fit();return;}
      if(action==='export'){const blob=new Blob([JSON.stringify(state.workflow,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=`${state.workflow.name.replace(/[^a-z0-9_-]/gi,'-').toLowerCase()||'workflow'}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);return;}
      if(action==='import')return showImport();if(action==='open-run')return openRun(id);
      if(action==='shortcuts')return showShortcuts();
    });
    document.addEventListener('input',event=>{const el=event.target;if(el.dataset.contextOption&&el.closest('#inspector-body')){const fields=el.closest('[data-context-fields]');let value;try{value=readContextFields(fields);}catch{return;}if(fields.dataset.contextFields==='node-context'&&selectedNode())selectedNode().context=value;else state.workflow.settings={...state.workflow.settings,context:value};markDirty('context:'+fields.dataset.contextFields);return;}if(el.id==='continuation-message'){const form=el.closest('form'),nodeId=$('#continuation-agent',form)?.value;if(form&&nodeId)state.continuationDrafts[`${form.dataset.runId}:${nodeId}:${form.dataset.mode||'continue'}`]=el.value;return;}if(el.id==='command-query'){state.paletteIndex=0;void paletteSearchController().search(el.value);renderCommands(el.value);return;}if(el.id==='run-task'){rememberTask(el.value,$('#run-cwd')?.value);return;}if(el.id==='workflow-name'){state.workflow.name=el.value;markDirty('workflow:name');}if(el.id==='node-search'){state.filter=el.value;renderLibrary();}if(el.dataset.nodeField){const n=selectedNode();if(n){n[el.dataset.nodeField]=el.type==='checkbox'?el.checked:el.value;markDirty(`${n.id}:${el.dataset.nodeField}`);renderGraph();}}if(el.dataset.workflowField){state.workflow[el.dataset.workflowField]=el.value;markDirty(`workflow:${el.dataset.workflowField}`);}if(el.dataset.setting){state.workflow.settings={...state.workflow.settings,[el.dataset.setting]:el.dataset.setting==='maxParallel'?(el.value.trim()===''?null:Number(el.value)):el.value};markDirty(`setting:${el.dataset.setting}`);}});
    document.addEventListener('change',async event=>{try{const el=event.target;if(el.id==='continuation-agent'){state.continueNodeId=el.value;state.continuationError='';if(el.closest('form')?.dataset.mode==='steer')showDirection(el.value);else renderExecution();return;}if(el.id==='workflow-picker'){const w=state.workflows.find(w=>w.id===el.value);if(w)await loadWorkflow(w);}if(el.dataset.nodeField==='model'){const node=selectedNode(),efforts=effortsFor(node);if(node&&!efforts.includes(node.effort)){markDirty();}renderInspector();}if(el.id==='import-file'&&el.files[0]){const target=$('#import-json'),file=el.files[0],text=await file.text();if(target?.isConnected&&$('#import-json')===target&&el.files[0]===file)target.value=text;}}catch(error){toast(error.message||'Could not read the selected file.',true);}});
    document.addEventListener('submit',async event=>{
      if(event.target.id==='mission-context-settings'){event.preventDefault();try{missionUI?.setContext(readContextFields(event.target,'mission-context-default'));closeModal();toast('Context budget saved for the next message.');}catch(e){toast(e.message,true);}return;}
      if(event.target.id==='continuation-form'){event.preventDefault();await continueAgent(event.target);return;}
      if(event.target.id==='run-form'){event.preventDefault();await submitWorkflowRun(event.target);return;}
      if(event.target.id==='import-form'){event.preventDefault();const form=event.target,ownsImport=()=>form.isConnected&&$('#import-form')===form;try{const w=JSON.parse($('#import-json').value);if(!Array.isArray(w.nodes)||!Array.isArray(w.edges)||!w.name)throw new Error('Expected a workflow name, nodes array, and edges array.');if(w.nodes.some(n=>!n.id||!['input','agent','approval','output'].includes(n.type)))throw new Error('Every node needs a unique id and a supported type.');if(new Set(w.nodes.map(n=>n.id)).size!==w.nodes.length)throw new Error('Node ids must be unique.');if(w.edges.some(e=>!w.nodes.some(n=>n.id===e.source)||!w.nodes.some(n=>n.id===e.target)))throw new Error('A connection references a missing node.');w.id=uid('workflow');w.version=1;w.settings={cwd:state.status.cwd||'',maxParallel:null,...w.settings};w.nodes.forEach((n,i)=>{n.x=Number(n.x)||i*290;n.y=Number(n.y)||100;});w.edges.forEach(e=>e.id=e.id||uid('edge'));if(!await loadWorkflow(w,{isCurrent:ownsImport})||!ownsImport())return;closeModal();markDirty();toast('Workflow imported.');}catch(error){if(!ownsImport())return;const target=$('#import-error');if(target)target.textContent=`Couldn’t import: ${error.message}`;else toast(`Couldn’t import: ${error.message}`,true);}return;}
    });
    $('#canvas').addEventListener('pointerdown',event=>{
      const port=event.target.closest('[data-port]');if(port){event.preventDefault();connectPort(port.dataset.port,port.dataset.nodeId);return;}
      if(event.target.closest('button'))return;const edge=event.target.closest('[data-edge]');if(edge){state.selectedEdge=edge.dataset.edge;state.selected=null;renderGraph();renderInspector();return;}
      const nodeEl=event.target.closest('[data-node]'),canvas=$('#canvas');
      if(nodeEl&&!state.space&&event.button===0){const n=state.workflow.nodes.find(n=>n.id===nodeEl.dataset.node);state.selected=n.id;state.selectedEdge=null;renderGraph();renderInspector();state.drag={kind:'node',id:n.id,x:event.clientX,y:event.clientY,originX:n.x,originY:n.y,moved:false};$(`[data-node="${CSS.escape(n.id)}"]`).classList.add('dragging');}
      else{if(event.button!==0&&event.button!==1)return;state.drag={kind:'pan',x:event.clientX,y:event.clientY,originX:state.view.x,originY:state.view.y,moved:false};canvas.classList.add('panning');}
      canvas.setPointerCapture(event.pointerId);event.preventDefault();
    });
    $('#canvas').addEventListener('pointermove',event=>{const d=state.drag;if(!d)return;const dx=event.clientX-d.x,dy=event.clientY-d.y;if(Math.abs(dx)+Math.abs(dy)>3)d.moved=true;if(d.kind==='node'){const n=state.workflow.nodes.find(n=>n.id===d.id);n.x=Math.round(d.originX+dx/state.view.scale);n.y=Math.round(d.originY+dy/state.view.scale);const el=$(`[data-node="${CSS.escape(n.id)}"]`);if(el)el.style.transform=`translate(${n.x}px,${n.y}px)`;renderEdges();}else{state.view.x=d.originX+dx;state.view.y=d.originY+dy;applyView();}});
    const endDrag=event=>{const d=state.drag;if(!d)return;state.drag=null;$('#canvas').classList.remove('panning');if(d.kind==='node'){if(d.moved)markDirty();else if(innerWidth<=850)$('#inspector').classList.add('mobile-visible');renderGraph();}else if(!d.moved&&!state.space){state.selected=null;state.selectedEdge=null;state.connection=null;renderGraph();renderInspector();}try{$('#canvas').releasePointerCapture(event.pointerId);}catch{}};
    $('#canvas').addEventListener('pointerup',endDrag);$('#canvas').addEventListener('pointercancel',endDrag);
    $('#canvas').addEventListener('dblclick',event=>{const n=event.target.closest('[data-node]');if(n)selectNode(n.dataset.node);});
    $('#canvas').addEventListener('wheel',event=>{event.preventDefault();if(event.ctrlKey||event.metaKey)zoom(Math.exp(-event.deltaY*.002),event.clientX,event.clientY);else{state.view.x-=event.deltaX;state.view.y-=event.deltaY;applyView();}},{passive:false});
    document.addEventListener('keydown',handleGlobalKey);
    document.addEventListener('keyup',event=>{if(event.code==='Space')state.space=false;});window.addEventListener('blur',()=>state.space=false);
    window.addEventListener('resize',()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>{ensureWorkflowView();},200);});
    if(window.ResizeObserver)new ResizeObserver(()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>{ensureWorkflowView();},80);}).observe($('#canvas'));
    $('#canvas').addEventListener('scroll',()=>{if($('#canvas').scrollTop||$('#canvas').scrollLeft){$('#canvas').scrollTop=0;$('#canvas').scrollLeft=0;}},{passive:true});
    window.addEventListener('online',()=>{if(state.streamState!=='live')startStream();});
    setInterval(()=>{const elapsed=$('.run-duration');if(elapsed&&busy())elapsed.textContent=duration(runMetrics(state.currentRun).durationMs);},1000);
    window.addEventListener('beforeunload',()=>{if(state.dirty&&state.workflow)fetch('/api/workflows',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(state.workflow),keepalive:true});});
  }
  async function init(){shell();state.workflow=makeTemplate();await mountMission();editHistory.reset(state.workflow);renderAll();bind();requestAnimationFrame(fit);const results=await Promise.allSettled([api('/api/status'),api('/api/workflows'),api('/api/runs'),api('/api/desktop/status')]);if(results[0].status==='fulfilled'){state.status=results[0].value;state.statusLoaded=true;}else{state.statusLoaded=true;state.status.error='Could not reach the local BLACKICE server.';}if(results[1].status==='fulfilled')state.workflows=asArray(results[1].value,'workflows');if(results[2].status==='fulfilled')state.runs=asArray(results[2].value,'runs').sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));if(results[3].status==='fulfilled')state.desktop=desktopStatus(results[3].value);if(state.workflows.length){let remembered;try{remembered=localStorage.getItem('relay.workflow');}catch{}state.workflow=normalizeWorkflow(state.workflows.find(w=>w.id===remembered)||state.workflows[0]);state.selected=state.workflow.nodes.find(n=>n.type==='agent')?.id||null;}else{state.workflow.settings.cwd=state.status.cwd||'';state.dirty=true;saveWorkflow();}editHistory.reset(state.workflow);let returnRun;try{returnRun=localStorage.getItem('relay.mission.returnRun');}catch{}state.currentRun=selectStartupRun(state.runs,returnRun);if(state.currentRun?.status==='completed')state.executionTab='output';renderAll();requestAnimationFrame(fit);startStream();setInterval(refreshStatus,30000);globalThis.blackiceUIResilience?.ready();}
  init();
})();


