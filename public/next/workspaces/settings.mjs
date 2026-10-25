import { connectionDefaultModels } from '../../connection-models.mjs';

const REASONING=['default','none','minimal','low','medium','high','xhigh','max','ultra'];
const VERBOSITY=['concise','balanced','detailed'];
const positive=value=>Number.isSafeInteger(value)&&value>=1&&value<=1000;

export function createSettingsWorkspace({mount,api,events,getStatus,notify=()=>{}}) {
  mount.innerHTML=[
    '<div class="next-panel"><div class="next-panel-inner">',
    '<header class="next-panel-head"><div><h1>Settings</h1><p>Workspace preferences, identity, models and tool connections.</p></div>',
    '<button type="button" id="next-settings-refresh">Refresh</button></header>',
    '<nav class="next-settings-sections" role="tablist" aria-label="Settings sections">',
    ...[['general','General'],['identity','Identity'],['models','Models'],['connections','Tools']].map(([id,label])=>
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
    '<section class="next-card"><h2>Classic interface fallback</h2><p class="next-help">Use the previous frontend for features not yet migrated. Your saved data and backend remain the same.</p>',
    '<a href="/legacy/" class="next-primary next-artifact-download">Open classic interface</a></section>',
    '<section class="next-card"><h2>Runtime health</h2><p class="next-help" id="next-settings-status" role="status">Checking BLACKICE…</p></section>',
    '</div>',
    ...['identity','models','connections'].map(id=>'<div id="next-settings-'+id+'" role="tabpanel" aria-labelledby="next-settings-section-'+id+'" hidden></div>'),
    '</div></div>',
  ].join('');
  const $=id=>mount.querySelector('#'+id);
  const f={
    cwd:$('next-settings-cwd'),choose:$('next-settings-choose'),saveCwd:$('next-settings-save-cwd'),
    model:$('next-settings-model'),saveModel:$('next-settings-save-model'),
    status:$('next-settings-status'),modelFeedback:$('next-settings-model-feedback'),reconnectFeedback:$('next-settings-reconnect-feedback'),
    refresh:$('next-settings-refresh'),reconnect:$('next-settings-reconnect'),
    runtime:$('next-runtime-settings-form'),effort:$('next-runtime-effort'),tier:$('next-runtime-tier'),
    verbosity:$('next-runtime-verbosity'),idle:$('next-runtime-idle'),timeout:$('next-runtime-timeout'),
    maxSubagents:$('next-runtime-max-subagents'),subagents:$('next-runtime-subagents'),
    runtimeFeedback:$('next-runtime-feedback'),execution:$('next-execution-form'),
    limit:$('next-execution-limit'),executionFeedback:$('next-execution-feedback'),
  };
  let active=false,destroyed=false,generation=0,status=getStatus?.()||{},section='general',sectionRevision=0,
    modelDirty=false,modelRevision=0,runtimeDirty=false,runtimeRevision=0,executionDirty=false,executionRevision=0,statusRead=0;
  const pending=new Set(),panels=new Map(),sectionButtons=[...mount.querySelectorAll('[data-settings-section]')];
  const loaders={
    identity:()=>import('./settings-identity.mjs').then(module=>module.createIdentitySettings),
    models:()=>import('./settings-providers.mjs').then(module=>module.createProviderSettings),
    connections:()=>import('./settings-connections.mjs').then(module=>module.createConnectionSettings),
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
        panel.instance=factory({mount:$('next-settings-'+name),api,events,notify,onChanged:()=>void refreshStatus()});
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
    status=info||{};
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
  }
  function drawRuntime(config={}){
    f.effort.value=REASONING.includes(config.defaultEffort)?config.defaultEffort:'default';
    f.tier.value=config.defaultServiceTier==='fast'?'fast':'default';
    f.verbosity.value=VERBOSITY.includes(config.verbosity)?config.verbosity:'balanced';
    f.idle.value=Number.isFinite(config.providerIdleTimeoutMs)?String(config.providerIdleTimeoutMs/60000):'5';
    f.timeout.value=Number.isFinite(config.runTimeoutMs)?String(config.runTimeoutMs/60000):'';
    f.subagents.checked=config.subagentsEnabled===true;
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
    if(results[1].status==='fulfilled'){if(!runtimeDirty)drawRuntime(results[1].value);}
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
  f.model.addEventListener('change',()=>{modelDirty=true;modelRevision++;});
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
    const value={
      defaultEffort:f.effort.value,defaultServiceTier:f.tier.value,
      verbosity:f.verbosity.value,providerIdleTimeoutMs:Math.round(idle*60000),
      runTimeoutMs:timeout===null?null:Math.round(timeout*60000),
      subagentsEnabled:f.subagents.checked,maxSubagents:max,
    };
    const revision=runtimeRevision;
    void mutate('runtime',f.runtime.querySelector('button[type="submit"]'),async()=>{
      const updated=await api('/api/runtime/settings','POST',value);
      generation++;
      if(revision===runtimeRevision){runtimeDirty=false;drawRuntime(updated);}
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
    leave(){active=false;generation++;sectionRevision++;panels.get(section)?.instance?.leave?.();},
    updateStatus(value){if(active&&value&&typeof value==='object'&&!Array.isArray(value)){statusRead++;drawStatus(value);}},
    destroy(){this.leave();destroyed=true;for(const panel of panels.values())panel.instance?.destroy?.();mount.innerHTML='';},
  };
}
