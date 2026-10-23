import { missionModels } from './mission-model.mjs';
import {createResponseDefaults,renderResponseDefaults} from './response-defaults.mjs';
import {workspaceIntegrations} from './workspace-integrations.mjs';
import {mountRemoteAccess} from './remote-access-ui.mjs';
import {mountChatGPTConnector} from './chatgpt-connector-ui.mjs';
import {mountBrowserCredentials} from './browser-credentials-ui.mjs';

const clone=value=>structuredClone(value);
const escape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const allActions={chat:true,connections:true,email:true,projects:true,taskNotes:true,workspace:true,agent:true,learning:true,browser:true,knowledge:true,desktop:true,canvas:true,swarm:true,schedule:true,operations:true,deploy:true,edit:true,execution:true,history:true,runtime:true,backup:true,restore:true,support:true};
const fingerprint=workflow=>JSON.stringify(workflow);
const button=(action,label,kind='subtle',extra='')=>`<button type="button" class="configure-button ${kind}" data-configure="${action}"${extra}>${label}</button>`;

/** Current provider readiness, never inferred from the number of saved connections. */
export function configureSummary(snapshot={}){
  const status=snapshot.status||{},models=missionModels(status),value='default',known=models.find(model=>model.value===value),model=known||{value,label:value==='default'?'Default model':value,available:false};
  return{model,ready:Boolean(model.available),workspace:snapshot.workspace||snapshot.cwd||snapshot.workflow?.settings?.cwd||status.cwd||'',identity:status.identity?.healthy===false?'Needs attention':'Ready',learning:status.learning?.mode==='off'?'Off':status.learning?.mode==='manual'?'On request':'Automatic',desktop:(snapshot.desktop||status.desktop)?.enabled?'Connected':'Not connected',browser:status.browser?.available?'Ready':'Not connected'};
}

/** The actual graph decides order; parallel branches remain independent. */
export function configureSteps(workflow){
  const nodes=workflow?.nodes||[],byId=new Map(nodes.map(node=>[node.id,node])),degree=new Map(nodes.map(node=>[node.id,0])),outgoing=new Map(nodes.map(node=>[node.id,[]]));
  for(const edge of workflow?.edges||[])if(byId.has(edge.source)&&byId.has(edge.target)){degree.set(edge.target,degree.get(edge.target)+1);outgoing.get(edge.source).push(edge.target);}
  const queue=nodes.filter(node=>degree.get(node.id)===0).map(node=>node.id),ordered=[],seen=new Set();
  while(queue.length){const id=queue.shift();if(seen.has(id))continue;seen.add(id);ordered.push(byId.get(id));for(const next of outgoing.get(id)){degree.set(next,degree.get(next)-1);if(degree.get(next)===0)queue.push(next);}}
  for(const node of nodes)if(!seen.has(node.id))ordered.push(node);
  return ordered.filter(node=>node.type==='agent').map((node,index)=>({...clone(node),index,receivesFrom:(workflow.edges||[]).filter(edge=>edge.target===node.id).map(edge=>byId.get(edge.source)?.name||edge.source),sendsTo:(workflow.edges||[]).filter(edge=>edge.source===node.id).map(edge=>byId.get(edge.target)?.name||edge.target)}));
}

/** Focused edits preserve every unrelated node, connection and advanced setting. */
export function updateConfigureStep(workflow,nodeId,value){
  if(!workflow||!Array.isArray(workflow.nodes))throw new Error('Choose a saved workflow first.');const node=workflow.nodes.find(item=>item.id===nodeId&&item.type==='agent');if(!node)throw new Error('This agent step is no longer in the workflow.');
  const fields={};for(const[name,limit]of[['name',120],['prompt',40000],['model',400]])if(value[name]!==undefined){if(typeof value[name]!=='string'||!value[name].trim()||value[name].length>limit||value[name].includes('\0'))throw new Error(`${name==='prompt'?'Instructions':name==='name'?'Step name':'Model'} must be nonempty text of at most ${limit.toLocaleString()} characters.`);fields[name]=value[name].trim();}
  if(value.desktop!==undefined){if(typeof value.desktop!=='boolean')throw new Error('Desktop inspection must be on or off.');fields.desktop=value.desktop;}
  const updated=clone(workflow);Object.assign(updated.nodes.find(item=>item.id===nodeId),fields);return updated;
}

export function executionSettingsFromDraft(mode,limit){
  if(mode==='unlimited')return{maxConcurrentRuns:null};
  if(mode!=='limit'||!/^\d+$/.test(String(limit).trim())||!Number.isSafeInteger(Number(limit))||Number(limit)<1)throw new Error('Enter a positive whole number.');
  return{maxConcurrentRuns:Number(limit)};
}

function executionDetails(snapshot,state,actions){
  if(!actions.execution)return'';
  const execution=snapshot.status?.execution||{},draft=state.executionDraft,capacity=draft?draft.mode==='unlimited'?null:Number(draft.limit):execution.capacity,unlimited=execution.unlimited===true&&draft===undefined||capacity===null||capacity===undefined,mode=draft?.mode||(unlimited?'unlimited':'limit'),limit=draft?.limit??(unlimited?'':String(capacity)),busy=state.executionLoading||state.executionSaving;
  return`<details class="configure-disclosure configure-execution" data-configure-section="execution"${state.executionOpen?' open':''}><summary>Concurrent work<span>${unlimited?'No app limit':Number.isSafeInteger(capacity)&&capacity>0?`${escape(capacity)} at once`:'Choose a limit'}</span></summary><form id="configure-execution-editor"><div class="configure-execution-controls"><label><span class="sr-only">Concurrent work</span><select id="configure-execution-mode" data-configure-execution="mode" aria-label="Concurrent work"${busy?' disabled':''}><option value="unlimited"${mode==='unlimited'?' selected':''}>No app limit</option><option value="limit"${mode==='limit'?' selected':''}>Limit</option></select></label><label${mode==='unlimited'?' hidden':''}><span class="sr-only">Concurrent runs</span><input type="number" inputmode="numeric" min="1" step="1" id="configure-execution-limit" data-configure-execution="limit" aria-label="Concurrent runs" placeholder="Concurrent runs" value="${escape(limit)}"${busy||mode==='unlimited'?' disabled':''}></label><button class="configure-button" type="submit"${busy||!state.executionDirty?' disabled':''}>${state.executionSaving?'Saving…':'Save'}</button></div><p class="configure-execution-note">Chats, queued tasks and schedules share this setting. Active work keeps running.</p>${state.executionLoading?'<p class="configure-execution-receipt" role="status">Loading…</p>':state.executionError?`<p class="configure-execution-error" role="alert">${escape(state.executionError)}</p>${button('execution-reload','Reload settings','subtle')}`:state.executionReceipt?`<p class="configure-execution-receipt" role="status">${escape(state.executionReceipt)}</p>`:''}</form></details>`;
}

export function historySettingsFromDraft(value){
  if(!['relay','codex'].includes(value))throw new Error('Choose where new Codex conversations appear.');
  return{codexHistory:value};
}

const runTimeUnits={seconds:1000n,minutes:60000n,hours:3600000n,days:86400000n};

/** Exact decimal arithmetic keeps every supported millisecond representable. */
export function runTimeSettingsFromDraft(mode,amount,unit){
  if(mode==='unlimited')return{runTimeoutMs:null};
  const text=String(amount??'').trim(),factor=Object.hasOwn(runTimeUnits,unit)?runTimeUnits[unit]:null;
  if(mode!=='limit'||!factor||!/^\d+(?:\.\d+)?$/.test(text))throw new Error('Enter a positive duration in seconds, minutes, hours or days.');
  const parts=text.split('.'),whole=parts[0].replace(/^0+/,'')||'0',fraction=(parts[1]||'').replace(/0+$/,'');
  // Every representable duration fits comfortably here after insignificant zeros.
  // Bound integer work before parsing pasted digits or constructing a power.
  if(whole.length+fraction.length>36)throw new Error('Choose a duration between one millisecond and the largest exact number this device supports.');
  const scale=10n**BigInt(fraction.length),scaled=BigInt(whole+fraction)*factor;
  if(scaled%scale!==0n)throw new Error('Use a duration that adds up to whole milliseconds.');
  const milliseconds=scaled/scale;
  if(milliseconds<1n||milliseconds>BigInt(Number.MAX_SAFE_INTEGER))throw new Error('Choose a duration between one millisecond and the largest exact number this device supports.');
  return{runTimeoutMs:Number(milliseconds)};
}

function runTimeDraft(value){
  if(value===null||value===undefined)return{mode:'unlimited',amount:'',unit:'minutes'};
  if(!Number.isSafeInteger(value)||value<1)throw new Error('BLACKICE returned an invalid run time limit. Reload settings.');
  const milliseconds=BigInt(value);
  for(const unit of ['days','hours','minutes','seconds'])if(milliseconds%runTimeUnits[unit]===0n)return{mode:'limit',amount:String(milliseconds/runTimeUnits[unit]),unit};
  return{mode:'limit',amount:`${milliseconds/1000n}.${String(milliseconds%1000n).padStart(3,'0').replace(/0+$/,'')}`,unit:'seconds'};
}

function runTimeDetails(snapshot,state){
  const drafts=state.runTimeDraft||{runTimeoutMs:runTimeDraft(snapshot.status?.runtimeSettings?.runTimeoutMs),providerIdleTimeoutMs:runTimeDraft(snapshot.status?.runtimeSettings?.providerIdleTimeoutMs===undefined?300000:snapshot.status.runtimeSettings.providerIdleTimeoutMs)},busy=state.runTimeLoading||state.runTimeSaving;
  const controls=(key,label,note)=>{const draft=drafts[key],data=`data-configure-runtime-key="${key}"`,id=`configure-${key}`;return`<div class="configure-runtime-setting"><label for="${id}">${label}</label><div class="configure-runtime-controls"><select id="${id}" data-configure-runtime="mode" ${data} aria-describedby="${id}-note"${busy?' disabled':''}><option value="unlimited"${draft.mode==='unlimited'?' selected':''}>No app limit</option><option value="limit"${draft.mode==='limit'?' selected':''}>Limit</option></select><div class="configure-runtime-duration"${draft.mode==='unlimited'?' hidden':''}><label><span class="sr-only">${label} duration</span><input type="text" inputmode="decimal" maxlength="64" data-configure-runtime="amount" ${data} aria-label="${label} duration" placeholder="Duration" value="${escape(draft.amount)}"${busy||draft.mode==='unlimited'?' disabled':''}></label><label><span class="sr-only">${label} unit</span><select data-configure-runtime="unit" ${data} aria-label="${label} unit"${busy||draft.mode==='unlimited'?' disabled':''}>${Object.keys(runTimeUnits).map(unit=>`<option value="${unit}"${draft.unit===unit?' selected':''}>${unit}</option>`).join('')}</select></label></div></div><p id="${id}-note" class="configure-runtime-note">${note}</p></div>`;};
  return`<section id="configure-run-limits" class="configure-runtime" aria-label="Run limits" tabindex="-1"><form id="configure-runtime-editor">${controls('runTimeoutMs','Agent time limit','Maximum time for each agent response, with any provider.')}${controls('providerIdleTimeoutMs','API inactivity timeout','Time without incoming data from an API. Streamed heartbeats count as activity.')}<div class="configure-runtime-save"><p class="configure-runtime-note">Applies to the next response. Active work keeps its saved limits.</p><button class="configure-button" type="submit"${busy||!state.runTimeDirty?' disabled':''}>${state.runTimeSaving?'Saving…':'Save'}</button></div>${state.runTimeLoading?'<p class="configure-runtime-receipt" role="status">Loading…</p>':state.runTimeError?`<p class="configure-runtime-error" role="alert">${escape(state.runTimeError)}</p>${state.runTimeDirty?'':button('runtime-reload','Reload settings','subtle')}`:state.runTimeReceipt?`<p class="configure-runtime-receipt" role="status">${escape(state.runTimeReceipt)}</p>`:''}</form></section>`;
}

function advancedSettings(snapshot,state,actions){
  if(!actions.runtime&&!actions.history&&!actions.execution)return'';
  return`<details class="configure-disclosure configure-preferences" data-configure-section="preferences"${state.preferencesOpen?' open':''}><summary>Advanced preferences<span>Limits &amp; history</span></summary>${executionDetails(snapshot,state,actions)}${actions.runtime?runTimeDetails(snapshot,state):''}${historyDetails(snapshot,state,actions)}</details>`;
}

function historyDetails(snapshot,state,actions){
  if(!actions.history)return'';
  const value=state.historyDraft??snapshot.status?.runtimeSettings?.codexHistory??'relay',busy=state.historyLoading||state.historySaving;
  return`<details class="configure-disclosure configure-history" data-configure-section="history"${state.historyOpen?' open':''}><summary>Conversation history<span>${value==='codex'?'BLACKICE + Codex':'BLACKICE only'}</span></summary><form id="configure-history-editor"><label for="configure-codex-history">New Codex conversations</label><div class="configure-history-controls"><select id="configure-codex-history" data-configure-history="codexHistory" aria-describedby="configure-history-note"${busy?' disabled':''}><option value="relay"${value!=='codex'?' selected':''}>Keep in BLACKICE only</option><option value="codex"${value==='codex'?' selected':''}>Also show in Codex</option></select><button class="configure-button" type="submit"${busy||!state.historyDirty?' disabled':''}>${state.historySaving?'Saving…':'Save'}</button></div><p id="configure-history-note" class="configure-history-note">BLACKICE saves chats locally with every provider. This changes where new Codex conversations appear; existing Codex entries stay as they are.</p><details class="configure-history-continuity"><summary>Continuity details</summary><p>BLACKICE-only follow-ups start from saved BLACKICE messages. The tool trace stays in BLACKICE; native session state does not carry over. Your selected provider still processes each request.</p></details>${state.historyLoading?'<p class="configure-history-receipt" role="status">Loading…</p>':state.historyError?`<p class="configure-history-error" role="alert">${escape(state.historyError)}</p>${button('history-reload','Reload settings','subtle')}`:state.historyReceipt?`<p class="configure-history-receipt" role="status">${escape(state.historyReceipt)}</p>`:''}</form></details>`;
}

function row(label,value,action,actionLabel,available){return`<div class="configure-basic-row"><div><span class="configure-label">${escape(label)}</span><strong${label==='Working folder'?' class="configure-path"':''}>${escape(value)}</strong></div>${available?button(action,actionLabel):''}</div>`;}
function recoveryDetails(snapshot,state,actions){
  if(!actions.backup&&!actions.restore&&!actions.support)return'';
  const active=Number(snapshot.status?.execution?.activeCount)>0,busy=state.recoveryBusy,receipt=state.recoveryReceipt||(snapshot.status?.maintenance?.status==='completed'?`${snapshot.status.maintenance.mode==='backup'?'Backup':'Restore'} completed.`:snapshot.status?.maintenance?.status==='failed'?'Profile maintenance did not complete. Export a support file for details.':''),disabled=busy||active?' disabled':'';
  return`<details class="configure-disclosure" data-configure-section="recovery"${state.recoveryOpen?' open':''}><summary>Recovery & support</summary><div class="configure-link-list">${actions.backup?button('backup','Back up & restart','subtle',disabled):''}${actions.restore?button('restore','Restore & restart','subtle',disabled):''}${actions.support?button('support',busy?'Working…':'Export support file','subtle',busy?' disabled':''):''}</div>${actions.backup||actions.restore?`<p class="configure-optional-note">${active?'Finish or stop active work first.':'Backup and restore restart BLACKICE. The previous profile is preserved during restore.'}</p><details><summary>Backup contents</summary><p>Saved chats, files, identity, settings, browser data and BLACKICE’s built-in workspace. Other project folders stay separate. Keep the backup private. Encrypted keys and sign-ins may need re-entry on another Windows account or computer.</p></details>`:''}${receipt?`<p role="status">${escape(receipt)}</p>`:''}${snapshot.status?.maintenance?.requiresReauthentication?'<p>Reconnect API keys and browser sign-ins that require authentication.</p>':''}<p class="configure-optional-note">Support files contain diagnostic codes and state counts. Chat text, credentials and file paths are excluded.</p></details>`;
}
function toolDetails(summary,state,actions){const links=[['agent','Your agent','Identity and preferences'],['learning','Learning',summary.learning],['knowledge','Memory & skills','Saved knowledge'],['desktop','Desktop inspection',summary.desktop]].filter(([key])=>actions[key]&&key!=='agent');return links.length?`<details class="configure-disclosure" data-configure-section="tools"${state.toolsOpen?' open':''}><summary>Agent tools<span>Optional</span></summary><div class="configure-link-list">${links.map(([key,title,meta])=>`<button type="button" data-configure="${key}"><span>${escape(title)}</span><small>${escape(meta)}</small><span aria-hidden="true">→</span></button>`).join('')}</div></details>`:'';}

function workspaceActions(snapshot,actions,state={}){
  const actionFor={browser:'browser',email:'email',planning:'taskNotes',swarm:'projects',schedules:'operations'};
  const entries=workspaceIntegrations(snapshot.status).map(entry=>({...entry,action:actionFor[entry.id]})).filter(entry=>actions[entry.action]);
  if(!entries.length)return'';
  return `<details class="configure-disclosure configure-workspace-integrations" data-configure-section="workspace"${state.workspaceOpen?' open':''}><summary>Background workspace</summary><div class="configure-link-list">${entries.map(entry=>`<button type="button" data-configure="${entry.action}"><span>${escape(entry.title)}</span><small>${escape(entry.state)}</small><span aria-hidden="true">→</span></button>`).join('')}</div></details>`;
}

function integrationPanels(snapshot,state,actions){
  const status=snapshot.status||{};
  const entries=[
    ['connector','ChatGPT connector','configure-connector-mount',state.connectorStatus||(status.chatGPTConnector?.enabled?'On':'Off')],
    ['credentials','Password manager','configure-credentials-mount','Local'],
    ['remote','Remote access','configure-remote-mount',status.remoteAccess?.enabled?'On':'Off'],
  ].filter(([key])=>actions[key]);
  return entries.map(([key,title,id,summary])=>`<details class="configure-disclosure configure-integration" data-configure-section="${key}"${state[key+'Open']?' open':''}><summary>${title}<span data-configure-status="${key}"${key==='connector'?' role="status" aria-live="polite" data-attention="'+Boolean(state.connectorAttention)+'"':''}>${escape(summary)}</span></summary><div id="${id}"></div></details>`).join('');
}

function automationActions(actions){
  const entries=[['schedule','Schedule a task','Set a task and when it runs'],['swarm','Create a swarm','Several specialists, one result']].filter(([key])=>actions[key]);
  if(!entries.length&&!actions.operations)return'';
  return`<section class="configure-automation" aria-label="Schedules and swarms"><div class="configure-automation-heading"><h2>Schedules & swarms</h2>${actions.operations?button('operations','Manage schedules'):''}</div><div class="configure-automation-actions">${entries.map(([key,title,note])=>`<button type="button" data-configure="${key}"><span><strong>${title}</strong><small>${note}</small></span><span aria-hidden="true">→</span></button>`).join('')}</div></section>`;
}

/** Pure view renderer keeps defaults small and makes progressive disclosure testable. */
export function renderConfigureView(snapshot={},state={},actions=allActions){
  const summary=configureSummary(snapshot),workflow=state.workflow||snapshot.workflow,workflows=snapshot.workflows||[],steps=configureSteps(workflow),step=steps.find(item=>item.id===state.stepId)||steps[0],workflowsView=state.view==='workflows';
  const header=`<header class="configure-heading"><div><h1>${workflowsView?'Workflow settings':'Settings'}</h1><p class="configure-subtitle">${workflowsView?'Review the steps in a saved workflow.':'Your models, workspace, and agent preferences.'}</p></div><nav class="configure-nav" aria-label="Configuration"><button type="button" data-configure="basics" aria-current="${workflowsView?'false':'page'}">Preferences</button><button type="button" data-configure="workflows" aria-current="${workflowsView?'page':'false'}">Workflow settings</button></nav></header>`;
  const chat=actions.chat?`<div class="configure-chat-prompt">${button('chat','Describe changes in chat')}</div>`:'';
  const status=state.error?`<p class="configure-message error" role="alert">${escape(state.error)}</p>`:state.receipt?`<p class="configure-message" role="status">${escape(state.receipt)}</p>`:'';
  if(!workflowsView)return`<div class="configure-page">${header}${status}<section class="configure-basics" aria-label="Everyday settings"><div class="configure-section-heading"><h2>Your workspace</h2><span class="configure-readiness${summary.ready?' ready':''}">${summary.ready?'Ready to chat':'Connect a model to begin'}</span></div>${row('Default model',summary.model.label,'connections',summary.ready?'Models & connections':'Connect a model',actions.connections)}${row('Working folder',summary.workspace||'Choose where the agent works','workspace','Choose folder',actions.workspace)}${row('Your agent',summary.identity==='Ready'?'Identity & preferences':summary.identity,'agent','Edit agent',actions.agent)}${actions.runtime?renderResponseDefaults(snapshot.status,state.responseDefaults):''}</section>${integrationPanels(snapshot,state,actions)}${workspaceActions(snapshot,actions,state)}${toolDetails(summary,state,actions)}${advancedSettings(snapshot,state,actions)}${recoveryDetails(snapshot,state,actions)}${chat}<details class="configure-disclosure configure-about" data-configure-section="about"${state.aboutOpen?' open':''}><summary>About BLACKICE${snapshot.status?.version?` · ${escape(snapshot.status.version)}`:''}</summary><p class="configure-build">${escape(snapshot.status?.version?`BLACKICE ${snapshot.status.version}`:'BLACKICE')}${snapshot.status?.desktopApp?' · Desktop':''}${snapshot.status?.installPath?`<br>${escape(snapshot.status.installPath)}`:''}</p><p>BLACKICE is provided AS IS, without warranty. Use at your own risk. You are responsible for requested actions and their effects on your computer, files and connected services.</p></details></div>`;
  let body;
  if(!workflow)body=`<section class="configure-empty"><h2>No workflow selected.</h2><p>Describe the work in chat. BLACKICE can build the steps.</p>${actions.chat?button('chat','Return to chat','primary'):''}</section>`;
  else{
    const currentIndex=step?.index??0,disabled=state.saving||state.editing?' disabled':'',savedOptions=[...new Map([workflow,...workflows].filter(Boolean).map(item=>[item.id,item])).values()];
    const selector=`<div class="configure-workflow-bar"><label><span class="configure-label">Saved workflow</span><select data-configure-field="workflow" aria-label="Saved workflow"${disabled}>${savedOptions.map(item=>`<option value="${escape(item.id)}"${item.id===workflow.id?' selected':''}>${escape(item.name||'Untitled workflow')}</option>`).join('')}</select></label>${actions.canvas?button('canvas','Open canvas','subtle',state.saving?' disabled':''):''}</div>`;
    let stepBody;
    if(!step)stepBody='<div class="configure-empty"><h2>No agent steps yet.</h2><p>Ask BLACKICE to build the workflow in chat.</p></div>';
    else if(state.editing){
      const draft=state.draft||step,models=missionModels(snapshot.status||{},draft.model),known=models.some(model=>model.value===draft.model),choices=known?models:[...models,{value:draft.model,label:`${draft.model} · not connected`,available:false}];
      stepBody=`<form class="configure-step-editor" id="configure-step-editor"><label><span>Step name</span><input data-configure-draft="name" required maxlength="120" value="${escape(draft.name)}"${state.saving?' disabled':''}></label><label><span>Instructions</span><textarea data-configure-draft="prompt" required maxlength="40000" rows="7"${state.saving?' disabled':''}>${escape(draft.prompt)}</textarea></label><label><span>Model</span><select data-configure-draft="model"${state.saving?' disabled':''}>${choices.map(model=>`<option value="${escape(model.value)}"${model.value===draft.model?' selected':''}${!model.available&&model.value!==draft.model?' disabled':''}>${escape(model.label)}${!model.available&&model.value!==draft.model?' · not connected':''}</option>`).join('')}</select></label><details class="configure-disclosure configure-step-options"><summary>Step options</summary><label class="configure-checkbox"><input type="checkbox" data-configure-draft="desktop"${draft.desktop?' checked':''}${state.saving?' disabled':''}>Enable Windows accessibility automation</label></details><div class="configure-editor-actions">${state.conflict?button('reload','Reload current step','subtle',state.saving?' disabled':''):''}${button('cancel-edit','Cancel','subtle',state.saving?' disabled':'')}<button class="configure-button primary" type="submit"${state.saving?' disabled':''}>${state.saving?'Saving…':'Save step'}</button></div></form>`;
    }else{
      const models=missionModels(snapshot.status||{},step.model||'default'),model=models.find(item=>item.value===(step.model||'default')),preview=String(step.prompt||'').split('\n').filter(Boolean)[0]?.slice(0,180)||'No instructions saved.';
      stepBody=`<div class="configure-step-summary"><h2 tabindex="-1" data-configure-focus>${escape(step.name||'Agent step')}</h2><p>${escape(preview)}${String(step.prompt||'').length>preview.length?'…':''}</p><div class="configure-step-model"><span class="configure-label">Model</span><span>${escape(model?.label||step.model||'Default model')}</span></div>${actions.edit?button('edit','Edit this step'):''}<details class="configure-disclosure" data-configure-section="instructions"${state.instructionsOpen?' open':''}><summary>Instructions & connections</summary><pre class="configure-instructions">${escape(step.prompt||'No instructions saved.')}</pre><dl class="configure-connections"><dt>Receives from</dt><dd>${escape(step.receivesFrom.join(', ')||'No connection')}</dd><dt>Passes to</dt><dd>${escape(step.sendsTo.join(', ')||'No connection')}</dd></dl></details></div>`;
    }
    const stepNav=step?`<div class="configure-step-navigation"><label><span class="configure-label">Agent step ${currentIndex+1} of ${steps.length}</span><select data-configure-field="step" aria-label="Agent step"${disabled}>${steps.map(item=>`<option value="${escape(item.id)}"${item.id===step.id?' selected':''}>${item.index+1}. ${escape(item.name||'Agent step')}</option>`).join('')}</select></label><div>${button('previous','Previous','subtle',disabled||currentIndex===0?' disabled':'')}${button('next','Next','subtle',disabled||currentIndex===steps.length-1?' disabled':'')}</div></div>`:'';
    body=`<section class="configure-workflow" aria-label="Selected workflow">${selector}<p class="configure-optional-note">Manual editing is optional. Chat can make these changes for you.</p>${stepNav}<div class="configure-one-step" data-configure-step-id="${escape(step?.id||'')}">${stepBody}</div></section>`;
  }
  const advanced=[['deploy','Schedule this workflow']].filter(([key])=>actions[key]&&workflow);
  return`<div class="configure-page">${header}${status}${body}${automationActions(actions)}${advanced.length?`<details class="configure-disclosure" data-configure-section="advanced"${state.advancedOpen?' open':''}><summary>More workflow tools<span>Optional</span></summary><div class="configure-link-list">${advanced.map(([key,title])=>`<button type="button" data-configure="${key}"><span>${escape(title)}</span><span aria-hidden="true">→</span></button>`).join('')}</div></details>`:''}${chat}</div>`;
}

export function initConfigureUI({mount,getSnapshot,api,onChat,onConnections,onEmail,onProjects,onTaskNotes,onWorkspace,onAgent,onLearning,onBrowser,onKnowledge,onDesktop,onCanvas,onSwarm,onSchedule,onOperations,onDeploy,onSelectWorkflow,onUpdateWorkflow,onExecutionSettings,onRuntimeSettings,onBackup,onRestore,onSupport,mountRemote=mountRemoteAccess,mountConnector=mountChatGPTConnector,mountCredentials=mountBrowserCredentials}){
  if(!mount||typeof getSnapshot!=='function')throw new Error('Configure needs a mount and current app state.');
  const callbacks={chat:onChat,connections:onConnections,email:onEmail,projects:onProjects,taskNotes:onTaskNotes,workspace:onWorkspace,agent:onAgent,learning:onLearning,browser:onBrowser,knowledge:onKnowledge,desktop:onDesktop,canvas:onCanvas,swarm:onSwarm,schedule:onSchedule,operations:onOperations,deploy:onDeploy,backup:onBackup,restore:onRestore,support:onSupport};
  const actions=Object.fromEntries(Object.entries(callbacks).map(([key,value])=>[key,typeof value==='function']));actions.edit=typeof onUpdateWorkflow==='function'||typeof api==='function';actions.execution=typeof api==='function';actions.history=typeof api==='function';actions.runtime=typeof api==='function';
  const state={connectorOpen:false,credentialsOpen:false,remoteOpen:false,workspaceOpen:false,connectorStatus:'',connectorAttention:false,connectorAttentionKey:'',recoveryOpen:false,recoveryBusy:false,recoveryReceipt:'',view:'basics',workflowId:null,stepId:null,editing:false,draft:null,base:null,saving:false,error:'',receipt:'',conflict:false,toolsOpen:false,aboutOpen:false,advancedOpen:false,instructionsOpen:false,override:null,overrideBase:null,executionOpen:false,executionDraft:undefined,executionDirty:false,executionLoading:false,executionSaving:false,executionError:'',executionReceipt:'',historyOpen:false,historyDraft:undefined,historyDirty:false,historyLoading:false,historySaving:false,historyError:'',historyReceipt:'',preferencesOpen:false,runTimeDraft:undefined,runTimeDirty:false,runTimeLoading:false,runTimeSaving:false,runTimeError:'',runTimeReceipt:''};let destroyed=false,executionRequest=0,executionRevision=0,historyRequest=0,historyRevision=0,runTimeRequest=0,runTimeRevision=0,renderedMarkup;const runTimeDirtyKeys=new Set();
  let remoteUI=null,remoteMount=null,connectorUI=null,connectorMount=null,credentialsUI=null,credentialsMount=null;
  function syncConnectorStatus(value,unavailable=false){
    if(destroyed)return;
    const requests=Array.isArray(value?.oauth?.requests)?value.oauth.requests:[],jobs=Array.isArray(value?.pending?.jobs)?value.pending.jobs:[];
    const count=requests.length+jobs.length,key=[...requests.map(item=>'request:'+item.id),...jobs.map(item=>'job:'+item.jobId)].sort().join('|');
    state.connectorAttention=Boolean(count||unavailable||value?.error||value?.oauth?.error||value?.setup?.error);
    state.connectorStatus=count?count+' waiting':state.connectorAttention?'Needs attention':value?.oauth?.grants?.length&&value.enabled?'Connected':value?.enabled?'On':'Off';
    if(count&&key!==state.connectorAttentionKey)state.connectorOpen=true;
    state.connectorAttentionKey=key;
    const panel=mount.querySelector('[data-configure-section="connector"]'),badge=mount.querySelector('[data-configure-status="connector"]');
    if(panel&&panel.open!==state.connectorOpen)panel.open=state.connectorOpen;
    if(badge){badge.textContent=state.connectorStatus;badge.dataset.attention=String(state.connectorAttention);}
  }
  const connectorApi=async(...args)=>{
    const statusRequest=args[0]==='/api/chatgpt-connector'&&(args[1]||'GET')==='GET';
    try{const value=await api(...args);if(statusRequest)syncConnectorStatus(value);return value;}
    catch(error){if(statusRequest)syncConnectorStatus(null,true);throw error;}
  };
  function showIntegration(key){
    if(!['connector','credentials','remote'].includes(key))return;
    state.view='basics';state[key+'Open']=true;render();
    const panel=mount.querySelector('[data-configure-section="'+key+'"]'),heading=panel?.querySelector('h2')||panel?.querySelector('summary');
    panel?.scrollIntoView?.({block:'start'});heading?.setAttribute('tabindex','-1');heading?.focus({preventScroll:true});
  }
  const responseDefaults=createResponseDefaults({getSettings:()=>getSnapshot().status?.runtimeSettings||{},api,onChange:()=>{state.responseDefaults=responseDefaults.state;render();},onSaved:onRuntimeSettings});state.responseDefaults=responseDefaults.state;
  mount.classList.add('configure-workspace');
  function current(snapshot=getSnapshot()){
    const candidates=snapshot.workflows||[],live=(snapshot.workflow?.id===state.workflowId?snapshot.workflow:candidates.find(item=>item.id===state.workflowId))||snapshot.workflow||candidates[0]||null;
    if(state.override?.id===live?.id){if(fingerprint(live)===state.overrideBase)return state.override;state.override=null;state.overrideBase=null;}return live;
  }
  function selected(){const steps=configureSteps(current());return steps.find(item=>item.id===state.stepId)||steps[0];}
  function captureFocus(){
    const active=mount.ownerDocument?.activeElement||(typeof document==='object'?document.activeElement:null);if(!active||!mount.contains(active))return null;
    const data=active.dataset||{},safe=value=>/^[\w-]+$/.test(value||''),section=active.closest?.('[data-configure-section]')?.dataset?.configureSection,sectionSelector=safe(section)?`[data-configure-section="${section}"] > summary`:null;let selector;
    if(/^configure-[\w-]+$/.test(active.id||''))selector=`#${active.id}`;
    else if(safe(data.configureRuntime)&&safe(data.configureRuntimeKey))selector=`[data-configure-runtime="${data.configureRuntime}"][data-configure-runtime-key="${data.configureRuntimeKey}"]`;
    else if(active.tagName==='SUMMARY')selector=sectionSelector;
    else for(const [key,attribute]of [['configure','data-configure'],['configureField','data-configure-field'],['configureDraft','data-configure-draft']])if(safe(data[key])){selector=`[${attribute}="${data[key]}"]`;break;}
    if(!selector&&active.type==='submit'){const form=active.closest?.('form');if(/^configure-[\w-]+$/.test(form?.id||''))selector=`#${form.id} [type="submit"]`;}
    if(!selector)return null;
    return{selector,index:mount.querySelectorAll?[...mount.querySelectorAll(selector)].indexOf(active):0,sectionSelector,selection:typeof active.selectionStart==='number'?{start:active.selectionStart,end:active.selectionEnd,direction:active.selectionDirection}:null};
  }
  function restoreFocus(saved){
    if(!saved)return;const restored=mount.querySelectorAll?mount.querySelectorAll(saved.selector)[saved.index]:mount.querySelector(saved.selector);
    const target=restored&&!restored.disabled&&!restored.closest?.('[hidden]')?restored:(saved.sectionSelector&&mount.querySelector(saved.sectionSelector))||mount.querySelector('.configure-nav [aria-current="page"]');target?.focus({preventScroll:true});
    if(target===restored&&saved.selection)try{restored?.setSelectionRange?.(saved.selection.start,saved.selection.end,saved.selection.direction);}catch{/* Some input types do not support selection ranges. */}
  }
  function render(){if(destroyed||credentialsUI?.isInteracting?.())return;const snapshot=getSnapshot(),workflow=current(snapshot),steps=configureSteps(workflow);actions.remote=Boolean(snapshot.status?.remoteAccess||snapshot.status?.desktopLifecycle);actions.connector=Boolean(snapshot.status?.chatGPTConnector);actions.credentials=Boolean(snapshot.status?.browserCredentials);if(!steps.some(step=>step.id===state.stepId))state.stepId=steps[0]?.id||null;const markup=renderConfigureView({...snapshot,workflow},{...state,workflow},actions);if(markup===renderedMarkup)return;
    const focus=captureFocus(),remoteFocus=remoteMount?.contains(document.activeElement)?document.activeElement:null;const connectorFocus=connectorMount?.contains(document.activeElement)?document.activeElement:null;const credentialsFocus=credentialsMount?.contains(document.activeElement)?document.activeElement:null;credentialsMount?.remove();connectorMount?.remove();remoteMount?.remove();renderedMarkup=markup;mount.innerHTML=markup;const placeholder=mount.querySelector('#configure-remote-mount');if(actions.remote&&placeholder){if(remoteMount)placeholder.replaceWith(remoteMount);else remoteMount=placeholder;if(!remoteUI)remoteUI=mountRemote({mount:remoteMount,api,status:snapshot.status.remoteAccess,desktop:snapshot.status.desktopLifecycle,onBackground:()=>api('/api/desktop/background','POST',{}),onShow:()=>api('/api/desktop/show','POST',{})});else remoteUI.update({status:snapshot.status.remoteAccess,desktop:snapshot.status.desktopLifecycle});}const connectorPlaceholder=mount.querySelector('#configure-connector-mount');if(actions.connector&&connectorPlaceholder){if(connectorMount)connectorPlaceholder.replaceWith(connectorMount);else connectorMount=connectorPlaceholder;if(!connectorUI)connectorUI=mountConnector({mount:connectorMount,api:connectorApi,presence:snapshot.status.chatGPTConnector});else connectorUI.update(snapshot.status.chatGPTConnector);}const credentialsPlaceholder=mount.querySelector('#configure-credentials-mount');if(actions.credentials&&credentialsPlaceholder){if(credentialsMount)credentialsPlaceholder.replaceWith(credentialsMount);else credentialsMount=credentialsPlaceholder;if(!credentialsUI)credentialsUI=mountCredentials({mount:credentialsMount,api,presence:snapshot.status.browserCredentials,onIdle:render});else credentialsUI.update(snapshot.status.browserCredentials);}restoreFocus(focus);if(credentialsFocus?.isConnected)credentialsFocus.focus({preventScroll:true});if(connectorFocus?.isConnected)connectorFocus.focus({preventScroll:true});if(remoteFocus?.isConnected)remoteFocus.focus({preventScroll:true});
  }
  function ownsEditorFocus(){const active=typeof document==='object'?document.activeElement:null;return Boolean(active&&mount.contains(active)&&active.closest?.('#configure-execution-editor, #configure-history-editor, #configure-runtime-editor, #configure-step-editor, #configure-response-defaults'));}
  function resetEditor(){state.editing=false;state.draft=null;state.base=null;state.conflict=false;state.error='';}
  function adoptExecution(settings){const limit=settings?.maxConcurrentRuns;if(limit!==null&&(!Number.isSafeInteger(limit)||limit<1))throw new Error('BLACKICE returned an invalid concurrency setting. Reload settings.');state.executionDraft={mode:limit===null?'unlimited':'limit',limit:limit===null?'':String(limit)};state.executionDirty=false;}
  async function loadExecution(){
    if(!actions.execution||state.executionLoading||state.executionSaving)return;
    const request=++executionRequest,revision=executionRevision;state.executionLoading=true;state.executionError='';state.executionReceipt='';render();
    try{const settings=await api('/api/execution/settings');if(destroyed||request!==executionRequest||revision!==executionRevision)return;adoptExecution(settings);}
    catch(cause){if(!destroyed&&request===executionRequest&&revision===executionRevision)state.executionError=cause.message;}
    finally{if(!destroyed&&request===executionRequest){state.executionLoading=false;if(state.view==='basics')render();}}
  }
  function executionInput(target){
    const field=target.dataset.configureExecution;if(!field||state.executionLoading||state.executionSaving)return false;
    if(!state.executionDraft){const capacity=getSnapshot().status?.execution?.capacity;state.executionDraft={mode:capacity==null?'unlimited':'limit',limit:capacity==null?'':String(capacity)};}
    if(field==='mode'&&!['unlimited','limit'].includes(target.value)||!['mode','limit'].includes(field))return true;
    state.executionDraft[field]=target.value;state.executionDirty=true;state.executionError='';state.executionReceipt='';executionRevision++;
    if(field==='mode')render();else{const save=mount.querySelector('#configure-execution-editor button[type="submit"]');if(save)save.disabled=false;}return true;
  }
  async function saveExecution(){
    if(!actions.execution||state.executionLoading||state.executionSaving||!state.executionDirty)return;
    let settings;try{settings=executionSettingsFromDraft(state.executionDraft?.mode,state.executionDraft?.limit);}catch(cause){state.executionError=cause.message;render();return;}
    const request=++executionRequest,revision=executionRevision;state.executionSaving=true;state.executionError='';state.executionReceipt='';render();
    try{const saved=await api('/api/execution/settings','POST',settings);if(destroyed||request!==executionRequest||revision!==executionRevision)return;adoptExecution(saved);state.executionReceipt='Saved. Active work keeps running.';try{await onExecutionSettings?.(saved);}catch(cause){if(!destroyed&&request===executionRequest)state.executionError=`Saved, but status could not refresh: ${cause.message}`;}}
    catch(cause){if(!destroyed&&request===executionRequest&&revision===executionRevision)state.executionError=cause.message;}
    finally{if(!destroyed&&request===executionRequest){state.executionSaving=false;if(state.view==='basics')render();}}
  }
  function adoptHistorySettings(settings){state.historyDraft=historySettingsFromDraft(settings?.codexHistory).codexHistory;state.historyDirty=false;}
  async function loadHistorySettings(){
    if(!actions.history||state.historyLoading||state.historySaving)return;
    const request=++historyRequest,revision=historyRevision;state.historyLoading=true;state.historyError='';state.historyReceipt='';render();
    try{const settings=await api('/api/runtime/settings');if(destroyed||request!==historyRequest||revision!==historyRevision)return;adoptHistorySettings(settings);}
    catch(cause){if(!destroyed&&request===historyRequest&&revision===historyRevision)state.historyError=cause.message;}
    finally{if(!destroyed&&request===historyRequest){state.historyLoading=false;if(state.view==='basics')render();}}
  }
  function historyInput(target){
    if(!target.dataset.configureHistory)return false;
    if(state.historyLoading||state.historySaving)return true;
    if(target.dataset.configureHistory!=='codexHistory'||!['relay','codex'].includes(target.value))return true;
    state.historyDraft=target.value;state.historyDirty=true;state.historyError='';state.historyReceipt='';historyRevision++;
    const save=mount.querySelector('#configure-history-editor button[type="submit"]');if(save)save.disabled=false;return true;
  }
  async function saveHistorySettings(){
    if(!actions.history||state.historyLoading||state.historySaving||!state.historyDirty)return;
    let settings;try{settings=historySettingsFromDraft(state.historyDraft);}catch(cause){state.historyError=cause.message;render();return;}
    const request=++historyRequest,revision=historyRevision;state.historySaving=true;state.historyError='';state.historyReceipt='';render();
    try{const saved=await api('/api/runtime/settings','POST',settings);if(destroyed||request!==historyRequest||revision!==historyRevision)return;adoptHistorySettings(saved);state.historyReceipt='Saved for new Codex conversations.';try{await onRuntimeSettings?.(saved);}catch(cause){if(!destroyed&&request===historyRequest)state.historyError=`Saved, but status could not refresh: ${cause.message}`;}}
    catch(cause){if(!destroyed&&request===historyRequest&&revision===historyRevision)state.historyError=cause.message;}
    finally{if(!destroyed&&request===historyRequest){state.historySaving=false;if(state.view==='basics')render();}}
  }
  function adoptRunTimeSettings(settings){
    for(const key of ['runTimeoutMs','providerIdleTimeoutMs'])if(settings?.[key]!==null&&(!Number.isSafeInteger(settings?.[key])||settings[key]<1))throw new Error('BLACKICE returned invalid run limits. Reload settings.');
    state.runTimeDraft={runTimeoutMs:runTimeDraft(settings.runTimeoutMs),providerIdleTimeoutMs:runTimeDraft(settings.providerIdleTimeoutMs)};state.runTimeDirty=false;runTimeDirtyKeys.clear();
  }
  async function loadRunTimeSettings(){
    if(!actions.runtime||state.runTimeLoading||state.runTimeSaving||state.runTimeDirty)return;
    const request=++runTimeRequest,revision=runTimeRevision;state.runTimeLoading=true;state.runTimeError='';state.runTimeReceipt='';render();
    try{const settings=await api('/api/runtime/settings');if(destroyed||request!==runTimeRequest||revision!==runTimeRevision)return;adoptRunTimeSettings(settings);}
    catch(cause){if(!destroyed&&request===runTimeRequest&&revision===runTimeRevision)state.runTimeError=cause.message;}
    finally{if(!destroyed&&request===runTimeRequest){state.runTimeLoading=false;if(state.view==='basics')render();}}
  }
  function runTimeInput(target){
    const field=target.dataset.configureRuntime;if(!field)return false;
    if(state.runTimeLoading||state.runTimeSaving)return true;
    const key=target.dataset.configureRuntimeKey;
    if(!['runTimeoutMs','providerIdleTimeoutMs'].includes(key)||!['mode','amount','unit'].includes(field)||field==='mode'&&!['unlimited','limit'].includes(target.value)||field==='unit'&&!Object.hasOwn(runTimeUnits,target.value))return true;
    if(!state.runTimeDraft){const settings=getSnapshot().status?.runtimeSettings||{};state.runTimeDraft={runTimeoutMs:runTimeDraft(settings.runTimeoutMs),providerIdleTimeoutMs:runTimeDraft(settings.providerIdleTimeoutMs===undefined?300000:settings.providerIdleTimeoutMs)};}
    state.runTimeDraft[key][field]=target.value;runTimeDirtyKeys.add(key);state.runTimeDirty=true;state.runTimeError='';state.runTimeReceipt='';runTimeRevision++;
    if(field==='mode')render();else{const save=mount.querySelector('#configure-runtime-editor button[type="submit"]');if(save)save.disabled=false;}return true;
  }
  async function saveRunTimeSettings(){
    if(!actions.runtime||state.runTimeLoading||state.runTimeSaving||!state.runTimeDirty)return;
    let settings;try{settings=Object.fromEntries([...runTimeDirtyKeys].map(key=>{const draft=state.runTimeDraft[key];return[key,runTimeSettingsFromDraft(draft.mode,draft.amount,draft.unit).runTimeoutMs];}));}catch(cause){state.runTimeError=cause.message;render();return;}
    const request=++runTimeRequest,revision=runTimeRevision;state.runTimeSaving=true;state.runTimeError='';state.runTimeReceipt='';render();
    try{const saved=await api('/api/runtime/settings','POST',settings);if(destroyed||request!==runTimeRequest||revision!==runTimeRevision)return;adoptRunTimeSettings(saved);state.runTimeReceipt='Saved for the next response.';try{await onRuntimeSettings?.(saved);}catch(cause){if(!destroyed&&request===runTimeRequest)state.runTimeError=`Saved, but status could not refresh: ${cause.message}`;}}
    catch(cause){if(!destroyed&&request===runTimeRequest&&revision===runTimeRevision)state.runTimeError=cause.message;}
    finally{if(!destroyed&&request===runTimeRequest){state.runTimeSaving=false;if(state.view==='basics')render();}}
  }
  async function click(event){const target=event.target.closest?.('[data-configure]');if(!target||!mount.contains(target)||state.saving)return;const action=target.dataset.configure;if(action==='defaults-reload'){await responseDefaults.reload();return;}
    if(['backup','restore','support'].includes(action)){if(state.recoveryBusy)return;const callback=callbacks[action];if(!callback)return;state.recoveryBusy=true;state.error='';state.recoveryReceipt='';render();try{const result=await callback();if(!destroyed)state.recoveryReceipt=result?.cancelled?'':action==='support'?'Support file exported.':'BLACKICE is restarting to complete the profile change.';}catch(cause){if(!destroyed)state.error=cause.message;}finally{if(!destroyed){state.recoveryBusy=false;render();}}return;}if(action==='execution-reload'){await loadExecution();return;}
    if(action==='history-reload'){await loadHistorySettings();return;}
    if(action==='runtime-reload'){await loadRunTimeSettings();return;}
    if(action==='basics'){state.view='basics';render();return;}if(action==='workflows'){state.view='workflows';render();return;}
    if(action==='edit'||action==='reload'){const step=selected();if(!step)return;state.editing=true;state.draft=clone(step);state.base=fingerprint(current());state.conflict=false;state.error='';state.receipt='';render();mount.querySelector('[data-configure-draft="name"]')?.focus({preventScroll:true});return;}
    if(action==='cancel-edit'){resetEditor();render();return;}if(action==='previous'||action==='next'){if(state.editing)return;const steps=configureSteps(current()),index=steps.findIndex(step=>step.id===state.stepId),next=steps[index+(action==='next'?1:-1)];if(next){state.stepId=next.id;state.instructionsOpen=false;state.receipt='';render();}return;}
    const callback=callbacks[action];if(!callback)return;try{if(action==='workspace')await callback(configureSummary(getSnapshot()).workspace);else if(action==='canvas')await callback(current()?.id);else if(action==='deploy')await callback(clone(current()));else if(action==='chat')await callback(state.view==='workflows'?{workflowId:current()?.id,stepId:state.stepId}:{});else await callback();render();}catch(cause){state.error=cause.message;render();}
  }
  async function change(event){const target=event.target;if(responseDefaults.input(target)||executionInput(target)||historyInput(target)||runTimeInput(target))return;if(target.dataset.configureDraft&&state.draft){state.draft[target.dataset.configureDraft]=target.type==='checkbox'?target.checked:target.value;return;}if(state.saving||state.editing)return;
    if(target.dataset.configureField==='step'){state.stepId=target.value;state.instructionsOpen=false;state.receipt='';render();}
    if(target.dataset.configureField==='workflow'){try{await onSelectWorkflow?.(target.value);state.workflowId=target.value;state.stepId=null;state.receipt='';state.error='';render();}catch(cause){state.error=cause.message;render();}}
  }
  function input(event){const target=event.target;if(responseDefaults.input(target)||executionInput(target)||historyInput(target)||runTimeInput(target))return;if(target.dataset.configureDraft&&state.draft)state.draft[target.dataset.configureDraft]=target.type==='checkbox'?target.checked:target.value;}
  function toggle(event){if(!mount.contains(event.target))return;const key=event.target.dataset?.configureSection,wasOpen=state[`${key}Open`];if(key==='response-defaults'){responseDefaults.setOpen(event.target.open);return;}if(['tools','about','advanced','instructions','execution','history','recovery','preferences','workspace','connector','credentials','remote'].includes(key))state[`${key}Open`]=event.target.open;if(key==='execution'&&!wasOpen&&event.target.open&&!state.executionDirty)return loadExecution();if(key==='history'&&!wasOpen&&event.target.open&&!state.historyDirty)return loadHistorySettings();if(key==='preferences'&&!wasOpen&&event.target.open&&!state.runTimeDirty)return loadRunTimeSettings();}
  async function submit(event){if(event.target.id==='configure-response-defaults'){event.preventDefault();await responseDefaults.save();return;}if(event.target.id==='configure-runtime-editor'){event.preventDefault();await saveRunTimeSettings();return;}if(event.target.id==='configure-history-editor'){event.preventDefault();await saveHistorySettings();return;}if(event.target.id==='configure-execution-editor'){event.preventDefault();await saveExecution();return;}if(event.target.id!=='configure-step-editor')return;event.preventDefault();if(state.saving)return;const live=current();if(fingerprint(live)!==state.base){state.conflict=true;state.error='This workflow changed while you were editing. Reload the current step before saving.';render();return;}
    let updated;try{updated=updateConfigureStep(live,state.stepId,state.draft);}catch(cause){state.error=cause.message;render();return;}state.saving=true;state.error='';render();
    try{const response=onUpdateWorkflow?await onUpdateWorkflow(updated,{nodeId:state.stepId,reason:'manual-step-edit'}):await api('/api/workflows','POST',updated),saved=response?.workflow||response?.nodes&&response||updated;state.override=saved;state.overrideBase=fingerprint(live);resetEditor();state.receipt='Step saved.';}catch(cause){state.error=cause.message;}finally{state.saving=false;render();if(!state.editing)mount.querySelector('[data-configure-focus]')?.focus({preventScroll:true});}
  }
  mount.addEventListener('click',click);mount.addEventListener('change',change);mount.addEventListener('input',input);mount.addEventListener('toggle',toggle,true);mount.addEventListener('submit',submit);render();
  return{update(){const snapshot=getSnapshot();credentialsUI?.update(snapshot.status?.browserCredentials);connectorUI?.update(snapshot.status?.chatGPTConnector);remoteUI?.update({status:snapshot.status?.remoteAccess,desktop:snapshot.status?.desktopLifecycle});if((!state.editing||state.view==='basics')&&!state.saving&&!(state.executionOpen&&state.executionDirty)&&!(state.historyOpen&&state.historyDirty)&&!(state.preferencesOpen&&state.runTimeDirty)&&!responseDefaults.state.dirty&&!responseDefaults.state.saving&&!ownsEditorFocus())render();},showBasics(){state.view='basics';render();},showConnector(){showIntegration('connector');},showCredentials(){showIntegration('credentials');},showRemote(){showIntegration('remote');},showRunLimits(){state.view='basics';state.preferencesOpen=true;render();const loading=loadRunTimeSettings();mount.querySelector(state.runTimeLoading?'#configure-run-limits':'#configure-runTimeoutMs')?.focus({preventScroll:false});return loading;},showWorkflows({workflowId,stepId}={}){if(state.editing&&(workflowId&&workflowId!==current()?.id||stepId&&stepId!==state.stepId))return;state.view='workflows';if(workflowId)state.workflowId=workflowId;if(stepId)state.stepId=stepId;render();},destroy(){credentialsUI?.destroy();credentialsUI=null;credentialsMount=null;connectorUI?.destroy();connectorUI=null;connectorMount=null;remoteUI?.destroy();remoteUI=null;remoteMount=null;responseDefaults.close();destroyed=true;executionRequest++;historyRequest++;runTimeRequest++;mount.removeEventListener('click',click);mount.removeEventListener('change',change);mount.removeEventListener('input',input);mount.removeEventListener('toggle',toggle,true);mount.removeEventListener('submit',submit);mount.innerHTML='';mount.classList.remove('configure-workspace');}};
}

