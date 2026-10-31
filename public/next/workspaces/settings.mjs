import { connectionDefaultModels } from '../../connection-models.mjs';
import { createForceRestart } from './settings-restart.mjs';
import { createGroupedModelPicker } from '../core/model-picker.mjs';
import { createContextControls } from '../core/context-controls.mjs';

const REASONING=['default','none','minimal','low','medium','high','xhigh','max','ultra'];
const VERBOSITY=['concise','balanced','detailed'];
const positive=value=>Number.isSafeInteger(value)&&value>=1&&value<=1000;

export function createSettingsWorkspace({mount,api,events,getStatus,notify=()=>{}}) {
  mount.innerHTML=[
    '<div class="next-panel"><div class="next-panel-inner">',
    '<header class="next-panel-head"><div><h1>Settings</h1><p>Workspace preferences, identity, models and tool connections.</p></div>',
    '<button type="button" id="next-settings-refresh">Refresh</button></header>',
    '<nav class="next-settings-sections" role="tablist" aria-label="Settings sections">',
    ...[['general','General'],['identity','Identity'],['models','Models'],['connections','Tools'],['connector','ChatGPT connector']].map(([id,label])=>
      '<button type="button" id="next-settings-section-'+id+'" data-settings-section="'+id+'" role="tab" aria-controls="next-settings-'+id+'" aria-selected="'+(id==='general')+'" tabindex="'+(id==='general'?'0':'-1')+'">'+label+'</button>'),
    '</nav><div id="next-settings-general" role="tabpanel" aria-labelledby="next-settings-section-general">',
    '<section class="next-card"><h2>Local working folder</h2>',
    '<p class="next-help">Used for new conversations; existing tasks retain their original working directory.</p>',
    '<div class="next-row"><input class="next-field" style="flex:1;width:auto" id="next-settings-cwd" aria-label="Working directory">',
    '<button type="button" id="next-settings-choose">Choose…</button>',
    '<button type="button" class="next-primary" id="next-settings-save-cwd">Save</button></div></section>',
    '<section class="next-card"><h2>Default model</h2>',
    '<div class="next-row"><select id="next-settings-model" class="next-field" style="flex:1;width:auto"></select>',
    '<button type="button" class="next-primary" id="next-settings-save-model">Set default</button></div>',
    '<p id="next-settings-model-feedback" class="next-help" role="status"></p></section>',
    '<section class="next-card"><h2>Runtime preferences</h2>',
    '<p class="next-help">These settings are saved by BLACKICE, not just in this browser.</p>',
    '<form id="next-runtime-settings-form" class="next-stack">',
    '<div class="next-settings-grid">',
    '<label class="next-label">Default reasoning<select class="next-field" id="next-runtime-effort"></select></label>',
    '<label class="next-label">Default service speed<select class="next-field" id="next-runtime-tier">',
    '<option value="default">Standard</option><option value="fast">Fast</option></select></label>',
    '<label class="next-label">Answer detail<select class="next-field" id="next-runtime-verbosity">',
    '<option value="concise">Concise</option><option value="balanced">Balanced</option><option value="detailed">Detailed</option></select></label>',
    '<label class="next-label">Provider idle timeout (minutes)<input class="next-field" type="number" id="next-runtime-idle" min="1" max="1440"></label>',
    '<label class="next-label">Maximum task runtime (minutes)<input class="next-field" type="number" id="next-runtime-timeout" min="1" max="1440" placeholder="No limit"></label>',
    '<label class="next-label">Maximum parallel subagents<input class="next-field" type="number" id="next-runtime-max-subagents" min="1" max="8"></label>',
    '</div><label class="next-row"><input type="checkbox" id="next-runtime-subagents"> Enable subagents</label>',
    '<label class="next-row"><input type="checkbox" id="next-runtime-gmail" aria-describedby="next-runtime-gmail-help"> Use connected Gmail</label>',
    '<p class="next-help" id="next-runtime-gmail-help">Allow native agents to read your connected Gmail for authorized tasks, including email verification. This uses your existing connection.</p>',
    '<label class="next-row"><input type="checkbox" id="next-runtime-guardrails" aria-describedby="next-runtime-guardrails-help"> Guardrails</label>',
    '<p class="next-help" id="next-runtime-guardrails-help">Optional execution checkpoints before tools run. Off keeps planning advisory and actions direct within your granted access.</p>',
    '<div id="next-runtime-context"></div>',
    '<div class="next-row"><button type="submit" class="next-primary">Save runtime preferences</button>',
    '<span class="next-help" id="next-runtime-feedback" role="status"></span></div>',
    '</form></section>',
    '<section class="next-card"><h2>Execution concurrency</h2>',
    '<p class="next-help">Independent tasks can run concurrently. An empty limit means no BLACKICE application-imposed limit.</p>',
    '<form class="next-row" id="next-execution-form">',
    '<label class="next-label" style="min-width:220px">Maximum concurrent tasks<input class="next-field" type="number" id="next-execution-limit" min="1" placeholder="No application limit"></label>',
    '<button type="submit" class="next-primary">Save concurrency</button>',
    '<span class="next-help" role="status" id="next-execution-feedback"></span></form></section>',
    '<section class="next-card"><h2>Model runtime</h2>',
    '<p class="next-help">Manage saved model connections in the Models section.</p>',
    '<button type="button" id="next-settings-reconnect">Reconnect model runtime</button>',
    '<p id="next-settings-reconnect-feedback" class="next-help" role="status"></p></section>',
    '<section class="next-card" id="next-settings-restart-card" hidden><h2>Restart BLACKICE</h2>',
    '<p class="next-help">Force restart attempts to stop active work and browser activity and close private application sessions. It pauses scheduled and queued work. Unsaved session work may be lost. It can still fail if work cannot settle or storage cannot be saved. Resume schedules afterward.</p>',
    '<div class="next-row"><button type="button" id="next-settings-force-restart">Force restart</button>',
    '<button type="button" id="next-settings-check-restart" hidden>Check restart</button></div>',
    '<p id="next-settings-restart-feedback" class="next-help" role="status" aria-live="polite"></p></section>',
    '<section class="next-card"><h2>Runtime health</h2><p class="next-help" id="next-settings-status" role="status">Checking BLACKICE…</p></section>',
    '</div>',
    ...['identity','models','connections','connector'].map(id=>'<div id="next-settings-'+id+'" role="tabpanel" aria-labelledby="next-settings-section-'+id+'" hidden></div>'),
    '</div></div>',
  ].join('');
  const $=id=>mount.querySelector('#'+id);
  const f={
    cwd:$('next-settings-cwd'),choose:$('next-settings-choose'),saveCwd:$('next-settings-save-cwd'),
    model:$('next-settings-model'),saveModel:$('next-settings-save-model'),
    status:$('next-settings-status'),modelFeedback:$('next-settings-model-feedback'),reconnectFeedback:$('next-settings-reconnect-feedback'),
    refresh:$('next-settings-refresh'),reconnect:$('next-settings-reconnect'),
    restartCard:$('next-settings-restart-card'),forceRestart:$('next-settings-force-restart'),checkRestart:$('next-settings-check-restart'),restartFeedback:$('next-settings-restart-feedback'),
    runtime:$('next-runtime-settings-form'),effort:$('next-runtime-effort'),tier:$('next-runtime-tier'),
    verbosity:$('next-runtime-verbosity'),idle:$('next-runtime-idle'),timeout:$('next-runtime-timeout'),
    maxSubagents:$('next-runtime-max-subagents'),subagents:$('next-runtime-subagents'),gmail:$('next-runtime-gmail'),guardrails:$('next-runtime-guardrails'),
    runtimeFeedback:$('next-runtime-feedback'),execution:$('next-execution-form'),
    limit:$('next-execution-limit'),executionFeedback:$('next-execution-feedback'),
  };
  let active=false,destroyed=false,generation=0,status=getStatus?.()||{},section='general',sectionRevision=0,
    modelDirty=false,modelRevision=0,runtimeDirty=false,runtimeRevision=0,executionDirty=false,executionRevision=0,statusRead=0;
  const pending=new Set(),panels=new Map(),sectionButtons=[...mount.querySelectorAll('[data-settings-section]')];
  let runtimeSettings=status.runtimeSettings||{};
  const modelPicker=createGroupedModelPicker({select:f.model,label:'Default model'});
  const contextDefaults=createContextControls({mount:$('next-runtime-context'),id:'next-runtime-context',scope:'defaults'});
  const refreshModelPicker=()=>{const selected=f.model.value||status.defaultModelSelection||'default';modelPicker.update({models:connectionDefaultModels({...status,defaultModelSelection:selected}),status:{...status,runtimeSettings},selected});contextDefaults.update({status,model:selected});};
  function updateRuntimeSettings(value){
    if(!value||typeof value!=='object'||Array.isArray(value))return;
    runtimeSettings=value;status={...status,runtimeSettings};panels.get('models')?.instance?.updateRuntimeSettings?.(value);refreshModelPicker();
    if(!runtimeDirty)contextDefaults.reconcile(value.defaultContext);
  }
  let restartStorage; try { restartStorage = globalThis.localStorage; } catch {}
  const restart = createForceRestart({api, storage:restartStorage, onChange:value=>{
    f.forceRestart.disabled=!value.canStart; f.checkRestart.hidden=!value.record; f.checkRestart.disabled=!value.canCheck;
    f.restartFeedback.textContent=value.error||value.record?.message||'';
  }});
  const restartInitial=restart.state(); f.forceRestart.disabled=!restartInitial.canStart; f.checkRestart.hidden=!restartInitial.record; f.checkRestart.disabled=!restartInitial.canCheck; f.restartFeedback.textContent=restartInitial.record?.message||'';
  f.forceRestart.addEventListener('click',()=>void restart.start());
  f.checkRestart.addEventListener('click',()=>void restart.check());
  const loaders={
    identity:()=>import('./settings-identity.mjs').then(module=>module.createIdentitySettings),
    models:()=>import('./settings-providers.mjs').then(module=>module.createProviderSettings),
    connections:()=>import('./settings-connections.mjs').then(module=>module.createConnectionSettings),
    connector:()=>import('../../chatgpt-connector-ui.mjs').then(module=>({mount:panelMount,api:panelApi})=>{
      const child=panelMount.ownerDocument.createElement('div');
      let controller=null,entered=false,panelDestroyed=false;
      return {
        enter(){
          if(panelDestroyed||entered)return;
          entered=true;panelMount.append(child);
          const presence=getStatus?.()?.chatGPTConnector||status.chatGPTConnector;
          if(!controller)controller=module.mountChatGPTConnector({mount:child,api:panelApi,presence});
          else{controller.update(presence);void controller.refresh();}
        },
        // Detaching pauses the shared widget's polling while preserving choices.
        leave(){entered=false;child.remove();},
        destroy(){
          if(panelDestroyed)return;
          panelDestroyed=true;entered=false;child.remove();controller?.destroy();controller=null;
        },
      };
    }),
  };
  for(const level of REASONING) {
    const option=f.effort.ownerDocument.createElement('option');
    option.value=level;option.textContent=level==='default'?'Model default':level;
    f.effort.append(option);
  }
  async function refreshStatus(){
    const token=generation,read=++statusRead;
    try{const info=await api('/api/status');if(active&&token===generation&&read===statusRead)drawStatus(info);}
    catch(error){if(active&&token===generation&&read===statusRead)f.status.textContent=error.message;}
  }
  async function selectSection(name){
    if(destroyed||!['general',...Object.keys(loaders)].includes(name))return;
    if(section!==name)panels.get(section)?.instance?.leave?.();
    if(name!=='general')modelPicker.close({restoreFocus:false});
    section=name;const token=++sectionRevision;
    for(const button of sectionButtons){
      const selected=button.dataset.settingsSection===name;
      button.setAttribute('aria-selected',String(selected));button.tabIndex=selected?0:-1;
      $('next-settings-'+button.dataset.settingsSection).hidden=!selected;
    }
    f.refresh.hidden=name!=='general';
    if(!active)return;
    if(name==='general'){void load();return;}
    let panel=panels.get(name);
    if(!panel){panel={instance:null,loading:null};panels.set(name,panel);}
    if(!panel.instance){
      if(!panel.loading)panel.loading=loaders[name]().then(factory=>{
        if(destroyed)return;
        panel.instance=factory({mount:$('next-settings-'+name),api,events,notify,onChanged:()=>void refreshStatus(),getRuntimeSettings:()=>runtimeSettings,onRuntimeSettings:value=>{generation++;statusRead++;updateRuntimeSettings(value);}});
      }).catch(error=>{panels.delete(name);if(active&&section===name){$('next-settings-'+name).textContent='This section could not open. '+error.message;notify(error.message,true);}});
      await panel.loading;
    }
    if(active&&section===name&&token===sectionRevision)panel.instance?.enter?.();
  }
  sectionButtons.forEach((button,index)=>{
    button.addEventListener('click',()=>void selectSection(button.dataset.settingsSection));
    button.addEventListener('keydown',event=>{
      let next=index;
      if(event.key==='ArrowRight')next=(index+1)%sectionButtons.length;
      else if(event.key==='ArrowLeft')next=(index+sectionButtons.length-1)%sectionButtons.length;
      else if(event.key==='Home')next=0;
      else if(event.key==='End')next=sectionButtons.length-1;
      else return;
      event.preventDefault();sectionButtons[next].focus();void selectSection(sectionButtons[next].dataset.settingsSection);
    });
  });
  function drawStatus(info){
    status={...(info||{}),runtimeSettings:info?.runtimeSettings||runtimeSettings};runtimeSettings=status.runtimeSettings;panels.get('models')?.instance?.updateRuntimeSettings?.(runtimeSettings);
    f.restartCard.hidden=!(status.desktopLifecycle?.available===true && status.desktopLifecycle?.supportsRestart===true && status.desktopLifecycle?.localManagement===true);
    f.status.textContent='BLACKICE '+(status.version||'')+' · '+
      (status.connected===false?'Model connection unavailable':'Model connection available')+
      ' · '+(status.execution?.activeCount||0)+' active execution(s)';
    let cwd='';
    try{cwd=localStorage.getItem('blackice.next.cwd')||'';}catch{}
    if(!f.cwd.dataset.edited)f.cwd.value=cwd||status.cwd||'';
    const selected=modelDirty?f.model.value:status.defaultModelSelection||'default';
    const models=connectionDefaultModels({...status,defaultModelSelection:selected});
    const nodes=new Map([...f.model.children].map(option=>[option.value,option]));
    for(let index=0;index<models.length;index++){
      const item=models[index];let option=nodes.get(item.value);
      if(!option){option=f.model.ownerDocument.createElement('option');option.value=item.value;}
      if(option.textContent!==item.label)option.textContent=item.label;
      if(f.model.children[index]!==option)f.model.insertBefore(option,f.model.children[index]||null);
      nodes.delete(item.value);
    }
    for(const option of nodes.values())option.remove();
    if(f.model.value!==selected)f.model.value=selected;
    refreshModelPicker();
    if(!runtimeDirty)contextDefaults.reconcile(runtimeSettings.defaultContext);
  }
  function drawRuntime(config={}){
    updateRuntimeSettings(config);
    contextDefaults.load(config.defaultContext);
    f.effort.value=REASONING.includes(config.defaultEffort)?config.defaultEffort:'default';
    f.tier.value=config.defaultServiceTier==='fast'?'fast':'default';
    f.verbosity.value=VERBOSITY.includes(config.verbosity)?config.verbosity:'balanced';
    f.idle.value=Number.isFinite(config.providerIdleTimeoutMs)?String(config.providerIdleTimeoutMs/60000):'5';
    f.timeout.value=Number.isFinite(config.runTimeoutMs)?String(config.runTimeoutMs/60000):'';
    f.subagents.checked=config.subagentsEnabled===true;
    f.gmail.checked=config.connectedGmail===true;
    f.guardrails.checked=config.executionGuardrails===true;
    f.maxSubagents.value=String(Number.isSafeInteger(config.maxSubagents)?config.maxSubagents:3);
    f.runtimeFeedback.textContent='';
  }
  function drawExecution(config={}){
    f.limit.value=Number.isSafeInteger(config.maxConcurrentRuns)?String(config.maxConcurrentRuns):'';
    f.executionFeedback.textContent='';
  }
  async function load(){
    if(!active)return;
    const token=++generation,read=++statusRead;
    const results=await Promise.allSettled([
      api('/api/status'),
      api('/api/runtime/settings'),
      api('/api/execution/settings'),
    ]);
    if(!active||token!==generation)return;
    if(read===statusRead){
      if(results[0].status==='fulfilled')drawStatus(results[0].value);
      else f.status.textContent=results[0].reason?.message||'Runtime status unavailable.';
    }
    if(results[1].status==='fulfilled'){if(!runtimeDirty)drawRuntime(results[1].value);else updateRuntimeSettings(results[1].value);}
    else f.runtimeFeedback.textContent='Runtime preferences unavailable.';
    if(results[2].status==='fulfilled'){if(!executionDirty)drawExecution(results[2].value);}
    else f.executionFeedback.textContent='Execution preferences unavailable.';
  }
  // Each explicitly submitted settings mutation owns one operation. Queue
  // independent form submissions instead of dropping the second one while the
  // previous save is still awaiting the durable backend response.
  let mutationTail=Promise.resolve();
  function mutate(key,button,callback,feedback){
    if(pending.has(key))return;
    pending.add(key);button.disabled=true;
    const action=mutationTail.catch(()=>{}).then(async()=>{
      try{await callback();feedback.textContent='Saved.';notify('Settings saved.');}
      catch(error){feedback.textContent=error.message;notify(error.message,true);}
      finally{pending.delete(key);button.disabled=false;}
    });
    mutationTail=action;
    return action;
  }
  f.cwd.addEventListener('input',()=>{f.cwd.dataset.edited='true';});
  f.choose.addEventListener('click',async()=>{
    const picker=globalThis.window?.relayDesktop?.pickFolder;
    if(typeof picker!=='function'){notify('The folder picker requires BLACKICE Desktop.',true);return;}
    try{const chosen=await picker();if(chosen){f.cwd.value=chosen;f.cwd.dataset.edited='true';}}
    catch(error){notify(error.message,true);}
  });
  f.saveCwd.addEventListener('click',()=>{
    const dir=f.cwd.value.trim();
    if(!dir){notify('Choose a working folder.',true);return;}
    try{localStorage.setItem('blackice.next.cwd',dir);f.cwd.dataset.edited='';notify('Working folder saved locally.');}
    catch(error){notify(error.message,true);}
  });
  f.model.addEventListener('change',()=>{modelDirty=true;modelRevision++;refreshModelPicker();});
  f.saveModel.addEventListener('click',()=>{
    const model=f.model.value,revision=modelRevision;
    void mutate('model',f.saveModel,async()=>{
    if(!model)throw Error('Choose an available model.');
    const response=await api('/api/models/default','POST',{model});
    generation++;
    if(revision===modelRevision)modelDirty=false;
    drawStatus(response);
    },f.modelFeedback);
  });
  for(const form of [f.runtime,f.execution]){
    form.addEventListener('keydown',event=>{if(event.key==='Enter'&&!['TEXTAREA','BUTTON'].includes(event.target?.tagName))event.preventDefault();});
    for(const event of ['input','change'])form.addEventListener(event,()=>{
      if(form===f.runtime){runtimeDirty=true;runtimeRevision++;}else{executionDirty=true;executionRevision++;}
    });
  }
  f.runtime.addEventListener('submit',event=>{
    event.preventDefault();
    const idle=Number(f.idle.value),timeout=f.timeout.value?Number(f.timeout.value):null;
    const max=Number(f.maxSubagents.value);
    if(!Number.isFinite(idle)||idle<1||idle>1440||
      timeout!==null&&(!Number.isFinite(timeout)||timeout<1||timeout>1440)||
      !Number.isSafeInteger(max)||max<1||max>8){
      f.runtimeFeedback.textContent='Choose valid durations (1–1440 minutes) and 1–8 subagents.';
      return;
    }
    let defaultContext;
    try{defaultContext=contextDefaults.read();}catch(error){f.runtimeFeedback.textContent=error.message;return;}
    const value={
      defaultEffort:f.effort.value,defaultServiceTier:f.tier.value,
      verbosity:f.verbosity.value,providerIdleTimeoutMs:Math.round(idle*60000),
      runTimeoutMs:timeout===null?null:Math.round(timeout*60000),
      subagentsEnabled:f.subagents.checked,maxSubagents:max,connectedGmail:f.gmail.checked,executionGuardrails:f.guardrails.checked,
      defaultContext,
    };
    const revision=runtimeRevision;
    void mutate('runtime',f.runtime.querySelector('button[type="submit"]'),async()=>{
      const updated=await api('/api/runtime/settings','POST',value);
      generation++;
      if(revision===runtimeRevision){runtimeDirty=false;drawRuntime(updated);}else updateRuntimeSettings(updated);
    },f.runtimeFeedback);
  });
  f.execution.addEventListener('submit',event=>{
    event.preventDefault();
    const value=f.limit.value.trim(),limit=value?Number(value):null;
    if(limit!==null&&!positive(limit)){
      f.executionFeedback.textContent='Choose a positive limit (1–1000) or leave blank.';
      return;
    }
    const revision=executionRevision;
    void mutate('execution',f.execution.querySelector('button[type="submit"]'),async()=>{
      const saved=await api('/api/execution/settings','POST',{maxConcurrentRuns:limit});
      generation++;
      if(revision===executionRevision){executionDirty=false;drawExecution(saved);}
    },f.executionFeedback);
  });
  f.reconnect.addEventListener('click',()=>void mutate('reconnect',f.reconnect,async()=>{
    await api('/api/runtime/reconnect','POST',{});
    await load();
  },f.reconnectFeedback));
  f.refresh.addEventListener('click',()=>void load());
  return {
    enter(){if(destroyed||active)return;active=true;drawStatus(getStatus?.()||status);void selectSection(section);},
    leave(){modelPicker.close({restoreFocus:false});active=false;generation++;sectionRevision++;panels.get(section)?.instance?.leave?.();},
    updateStatus(value){if(active&&value&&typeof value==='object'&&!Array.isArray(value)){statusRead++;drawStatus(value);}},
    destroy(){this.leave();destroyed=true;contextDefaults.destroy();modelPicker.destroy();for(const panel of panels.values())panel.instance?.destroy?.();mount.innerHTML='';},
  };
}
