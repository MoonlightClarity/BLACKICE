/** Local GGUF setup. Viewing settings never loads a model. */
export function createLlamaCppLaunchSettings({mount, advancedMount, api, onChanged=()=>{}, onDiscovered=()=>{}, pickFiles=globalThis.window?.relayDesktop?.pickLocalModelFile?()=>window.relayDesktop.pickLocalModelFile():null}={}) {
 const doc=mount.ownerDocument;
 const make=(tag,text='',css='')=>{const n=doc.createElement(tag);n.textContent=text;if(css)n.className=css;return n;};
 const label=(text,input)=>{const n=make('label',text,'next-label');n.append(input);return n;};
 const button=text=>{const n=make('button',text);n.setAttribute('type','button');return n;};
 const input=id=>{const n=make('input','','next-field');n.id=id;n.setAttribute('type','text');return n;};
 const quick=make('section','','next-stack next-llama-quick');

 const directory=make('section','','next-stack');directory.id='next-local-model-directory';
 const guide=make('ol','','next-help');guide.id='next-llama-model-guide';
 for(const text of ['Get a model: download a text-generation model in GGUF format from its publisher. Check its memory requirements and license first.','Choose the downloaded model file below. Keep it in a permanent folder; BLACKICE uses the original file rather than copying it.','Confirm the file to load it. Once loaded, choose it from the chat model selector.'])guide.append(make('li',text));
 const discovery=make('details','','next-stack');discovery.id='next-llama-discovery-help';
 discovery.append(make('summary','Find a model on Hugging Face'));
 const query=input('next-llama-model-query');query.setAttribute('type','search');query.placeholder='Model name or task, e.g. coding';query.maxLength=160;
 const find=make('a','Search Hugging Face');find.id='next-llama-model-catalog';find.setAttribute('target','_blank');find.setAttribute('rel','noopener noreferrer');
 const updateSearch=()=>{const u=new URL('https://huggingface.co/models');u.searchParams.set('library','gguf');u.searchParams.set('search',query.value.trim());find.setAttribute('href',u.href);};
 query.addEventListener('input',updateSearch);updateSearch();
 const prompt=make('textarea','','next-field');prompt.id='next-llama-model-prompt';prompt.rows=7;prompt.readOnly=true;
 const promptButton=button('Prepare model recommendation prompt');promptButton.id='next-llama-prepare-prompt';
 const prepare=()=>{prompt.value='Help me choose a local model for BLACKICE. My task/model interest: '+(query.value.trim()||'[describe the task]')+'. My computer: [OS, RAM, GPU and VRAM, or inspect if available]. Search Hugging Face for current model options. Recommend a good-enough choice for my hardware and task, distinguishing throughput from quality. BLACKICE bundles llama.cpp and directly loads GGUF files; confirm the model architecture works with the included engine. Give the publisher model-page link, exact file/quantization, approximate memory needs and download size. If another format is a better choice, explain the compatible external runtime/API needed; do not claim BLACKICE directly loads safetensors or PyTorch checkpoints. Do not download or launch anything yet.';};
 promptButton.addEventListener('click',prepare);prepare();
 discovery.append(label('Search by model or task',query),find,make('p','Search opens Hugging Face with the GGUF filter. Download a compatible model there, then choose its file below. No download or model call is started here.','next-help'),promptButton,label('Copy this prompt into any chat for help choosing',prompt));
 const help=make('details');help.append(make('summary','Choosing a model'),make('p','Models are not included with BLACKICE. Choose and download a compatible model separately.','next-help'),guide,discovery,make('p','Why GGUF? This file picker configures the bundled llama.cpp engine, which uses GGUF. BLACKICE is not limited to that engine: select Ollama or LM Studio in Runtime, or a compatible model API for other runtimes. A .safetensors or PyTorch file cannot be loaded by simply renaming it.','next-help'));
 const status=make('p','Checking runtime…','next-help');status.id='next-llama-runtime-status';status.setAttribute('role','status');
 const file=input('next-llama-model-file');file.placeholder='Choose your downloaded model file (.gguf)';
 const name=input('next-llama-model-name');name.placeholder='Name in BLACKICE';
 const browse=button('Load GGUF file…');browse.id='next-llama-model-browse';browse.hidden=!pickFiles;browse.className='next-primary';
 const start=button('Load from path');start.id='next-llama-model-start';start.className='next-primary';
 const reload=button('Refresh settings');reload.id='next-llama-config-refresh';
 const row=make('div','','next-row');row.append(start,reload);
 const feedback=make('p','','next-help');feedback.id='next-llama-default-feedback';feedback.setAttribute('role','status');feedback.setAttribute('aria-live','polite');
 const section=make('details','','next-provider-advanced');section.id='next-llama-launch-settings';
 section.append(make('summary','Advanced runtime & model settings'),make('p','Changes apply on the next BLACKICE-owned launch. Saving never restarts a server. External servers are never stopped.','next-help'));
 const definitions=[
 ['executablePath','Custom llama-server path (optional; blank uses bundled runtime)','text'],
 ['modelsDirectory','GGUF models directory (optional absolute path)','text'],
 ['sleepIdleSeconds','Model sleep after idle seconds','number'],
 ['shutdownIdleSeconds','Stop owned server after idle seconds (0 = disabled)','number'],
 ['modelsMax','Maximum loaded models','number'],
 ['memoryMarginMiB','Router GPU memory margin (MiB)','number'],
 ['fitTargetMiB','Model GPU fitting reserve (MiB)','number'],
 ['ctxSize','Context tokens (0 = model automatic)','number'],
 ['gpuLayers','GPU layers (auto, all, or a number)','text'],
 ['flashAttention','Flash Attention','select'],
 ['parallel','Parallel server slots','number'],
 ['cacheRamMiB','RAM prompt cache (MiB; 0 = off)','number'],
 ['poll','CPU polling percentage (0–100)','number']];
 const controls={};
 for(const [key,title,type] of definitions){
  const c=make(type==='select'?'select':'input','','next-field');c.id='next-llama-default-'+key;
  if(type==='select')for(const v of ['auto','on','off']){const o=make('option',v);o.setAttribute('value',v);c.append(o);}
  else c.setAttribute('type',type);
  controls[key]=c;(key==='modelsDirectory'?directory:section).append(label(key==='modelsDirectory'?'Custom models folder (blank uses default)':title,c));
 }
 const paths=make('textarea','','next-field');paths.id='next-llama-paths';paths.rows=4;
 const overrides=make('textarea','','next-field');overrides.id='next-llama-overrides';overrides.rows=4;
 const advanced=make('details','','next-provider-advanced');
 advanced.append(make('summary','Per-model configuration (JSON)'),label('Model file paths (JSON)',paths),label('Model-specific overrides (JSON)',overrides));
 const save=button('Save launch defaults'),reset=button('Restore recommended values');
 save.id='next-llama-default-save';reset.id='next-llama-default-reset';save.className='next-primary';
 const commands=make('div','','next-row');commands.append(save,reset);
 const preview=make('pre','','next-help');preview.id='next-llama-default-preview';
 const yarnSettings=make('details','','next-provider-advanced');yarnSettings.id='next-llama-yarn';
 const yarnId=input('next-llama-yarn-model');yarnId.maxLength=256;
 const yarnOriginal=input('next-llama-yarn-original'),yarnTarget=input('next-llama-yarn-target');
 for(const field of [yarnOriginal,yarnTarget]){field.setAttribute('type','number');field.min='128';field.max='262144';field.step='1';}
 const stageYaRN=button('Set YaRN'),clearYaRN=button('Clear YaRN');stageYaRN.id='next-llama-yarn-set';clearYaRN.id='next-llama-yarn-clear';
 const yarnActions=make('div','','next-row');yarnActions.append(stageYaRN,clearYaRN);
 yarnSettings.append(make('summary','YaRN context extension (per model)'),
  make('p','Optional. Use the exact local model ID and original context specified by its publisher. Larger contexts need more memory and may reduce quality. BLACKICE derives the scaling factor; the actual runtime context can differ.','next-help'),
  label('Local model ID',yarnId),label('Original context (tokens)',yarnOriginal),label('Target context (tokens)',yarnTarget),yarnActions);
 section.append(yarnSettings,advanced,commands,preview);
 function populateYaRN(){
  let config;try{config=read().modelOverrides?.[yarnId.value.trim()]?.yarn;}catch{}
  yarnOriginal.value=String(config?.originalContext??'');yarnTarget.value=String(config?.targetContext??'');
 }
 yarnId.addEventListener('change',populateYaRN);
 function stageYaRNChange(clear=false){
  if(pending||picking||refreshing||revision===null||!alive||!active)return;
  try{
   const id=yarnId.value.trim(),config=read();
   if(!id||id.length>256||/[=\\[\\]\\r\\n;#\\x00-\\x1f\\x7f]/.test(id)||['__proto__','constructor','prototype'].includes(id))throw Error('Enter the exact local model ID.');
   const existing=Object.hasOwn(config.modelOverrides,id)?{...config.modelOverrides[id]}:{};
   if(clear){
    if(!existing.yarn)throw Error('No YaRN override is configured for this model.');
    delete existing.yarn;yarnOriginal.value='';yarnTarget.value='';
   }else{
    const originalContext=Number(yarnOriginal.value),targetContext=Number(yarnTarget.value);
    if(!Number.isSafeInteger(originalContext)||!Number.isSafeInteger(targetContext)||originalContext<128||targetContext<=originalContext||targetContext>262144)
      throw Error('Enter whole contexts from 128 to 262,144 tokens, with target greater than original.');
    if(existing.ctxSize&&existing.ctxSize!==targetContext)throw Error('The model has a different explicit context override. Match it to the YaRN target or remove it in Per-model configuration.');
    existing.yarn={originalContext,targetContext};
   }
   if(Object.keys(existing).length)config.modelOverrides[id]=existing;else delete config.modelOverrides[id];
   overrides.value=JSON.stringify(config.modelOverrides,null,2);
   feedback.textContent=(clear?'YaRN removal staged.':'YaRN staged for '+id+'.')+' Choose Save launch defaults to apply on the next owned launch.';
  }catch(error){feedback.textContent=error.message;}
 }
 stageYaRN.addEventListener('click',()=>stageYaRNChange());
 clearYaRN.addEventListener('click',()=>stageYaRNChange(true));
 const saveDirectory=button('Save models folder');saveDirectory.id='next-local-directory-save';saveDirectory.addEventListener('click',async()=>{
 if(pending||picking||refreshing||revision===null||!alive||!active)return;
 const token=generation,draft=Object.fromEntries(definitions.map(([key])=>[key,controls[key].value]));
 const settings={...structuredClone(baseline),modelsDirectory:controls.modelsDirectory.value.trim()};pending=true;sync();
 try{const snapshot=await api('/api/local-models/config','POST',{expectedRevision:revision,settings});if(valid(token)){const latest=Object.fromEntries(definitions.map(([key])=>[key,controls[key].value])),latestPaths=paths.value,latestOverrides=overrides.value;draw(snapshot);for(const [key]of definitions)if(key!=='modelsDirectory'||latest[key]!==draft[key])controls[key].value=latest[key];paths.value=latestPaths;overrides.value=latestOverrides;feedback.textContent=pendingRestart?'Models folder saved. '+restartHint:'Models folder saved. No model was moved or loaded.';}}
 catch(error){if(valid(token))feedback.textContent=error.message||'Could not save models folder.';}
 finally{pending=false;if(alive)sync();}
 });
 const directoryStatus=make('p','','next-help');directoryStatus.id='next-local-directory-status';directoryStatus.setAttribute('role','status');
 const discoverModels=button('Discover folder models');discoverModels.id='next-local-directory-discover';
 const directoryCommands=make('div','','next-row');directoryCommands.append(saveDirectory,discoverModels);
 directory.append(directoryStatus,directoryCommands,make('p','Discovery refreshes the idle BLACKICE llama.cpp router. Changed settings require a restart; a restart or a changed model file can unload cached models. Discovery does not move, download or load models. Ollama and LM Studio keep their own storage.','next-help'));
 const manual=make('details','','next-provider-advanced');
 const manualControls=[status,directory,label('Model file',file),label('Model name',name),row,section,help];
 quick.append(browse,feedback);
 if(advancedMount)advancedMount.append(...manualControls);
 else {manual.append(make('summary','llama.cpp setup'),...manualControls);quick.append(manual);}
 mount.append(quick);
 let alive=true,active=false,pending=false,picking=false,refreshing=false,generation=0,revision=null,recommended=null,baseline=null,pendingRestart=false,discoveryDirectory=null;
 const restartHint='Saved settings take effect the next time the idle router starts or restarts. Active work is not interrupted.';
 const valid=token=>alive&&active&&token===generation;
 const sync=()=>{start.disabled=pending||picking||refreshing||revision===null||!file.value.trim()||!name.value.trim();browse.disabled=pending||picking||refreshing||revision===null;reload.disabled=pending||picking||refreshing;save.disabled=pending||picking||refreshing||revision===null;saveDirectory.disabled=save.disabled;stageYaRN.disabled=clearYaRN.disabled=save.disabled;discoverModels.disabled=save.disabled||!discoveryDirectory?.available||controls.modelsDirectory.value.trim()!==(baseline?.modelsDirectory||'');reset.disabled=pending||picking||refreshing;file.disabled=pending;name.disabled=pending;};
 controls.modelsDirectory.addEventListener('input',sync);
 discoverModels.addEventListener('click',async()=>{
  if(!alive||!active||discoverModels.disabled)return;
  const token=generation;pending=true;feedback.textContent='Discovering GGUF models.';sync();
  try{
   const result=await api('/api/local-models/discover','POST',{});
   if(!valid(token))return;
   await onDiscovered(result);
   if(valid(token))feedback.textContent=result.owned
    ? (result.models.length?'Found '+result.models.length+' local model'+(result.models.length===1?'':'s')+'. Choose a model below to load it.':'The router catalog is empty. Check the configured folder and refresh after adding weights.')
    : 'An existing llama.cpp server supplied the catalog. Its files and discovery settings are managed by that server.';
  }catch(error){if(valid(token))feedback.textContent=error.message||'Could not discover local models.';}
  finally{pending=false;if(alive)sync();}
 });
 const suggested=filename=>filename.split(/[\\/]/).pop().replace(/\.gguf$/i,'').replace(/[=[\];#:\x00-\x1f\x7f]/g,'-').slice(0,256);
 function fill(value){for(const [key]of definitions)controls[key].value=String(value[key]??'');paths.value=JSON.stringify(value.modelPaths||{},null,2);overrides.value=JSON.stringify(value.modelOverrides||{},null,2);}
 function draw(snapshot){
  pendingRestart=Boolean(snapshot.process?.pendingRestart);baseline=structuredClone(snapshot.settings||{});
  revision=snapshot.revision;recommended=snapshot.recommended;fill(snapshot.settings||{});populateYaRN();
  discoveryDirectory=snapshot.modelDirectory||null;
  controls.modelsDirectory.placeholder=snapshot.defaultModelsDirectory||'';
  directoryStatus.textContent=discoveryDirectory
   ? (discoveryDirectory.usingDefault?'Default models folder: ':'Configured models folder: ')+discoveryDirectory.path+(discoveryDirectory.error?' ('+discoveryDirectory.error+')':'')
   : 'Models folder unavailable.';
  const r=snapshot.runtime;
  status.textContent=r?(r.source==='bundled'?'Included llama.cpp runtime':r.source==='custom'?'Custom llama.cpp runtime':'Runtime unavailable')+(r.version?' · '+r.version:'')+(r.backend?' · '+r.backend:'')+(r.message?' — '+r.message:''):'Runtime status unavailable. Existing launch settings are preserved.';
  const args=snapshot.launchArgs||[];
  preview.textContent=args.length?'Effective next-launch arguments:\nllama-server '+args.join(' ')+'\nModel-specific settings are generated in a separate INI file.':'No launch preview is available.';
  feedback.textContent=snapshot.process?.pendingRestart?restartHint:'';
  sync();
 }
 function read(){
  const settings={};for(const [key,,type]of definitions){const v=controls[key].value.trim();settings[key]=type==='number'?Number(v):key==='gpuLayers'&&/^\d+$/.test(v)?Number(v):v;}
  try{settings.modelPaths=JSON.parse(paths.value||'{}');settings.modelOverrides=JSON.parse(overrides.value||'{}');}catch{throw Error('Model paths and overrides must be valid JSON objects.');}
  if(!settings.modelPaths||typeof settings.modelPaths!=='object'||Array.isArray(settings.modelPaths))throw Error('Model paths must be a JSON object.');
  return settings;
 }
 async function refresh({preserveDraft=false}={}){
  if(pending||picking||refreshing||!alive||!active)return;
  const token=++generation,previous=baseline?structuredClone(baseline):null;
  const captureDraft=()=>preserveDraft?{controls:Object.fromEntries(definitions.map(([k])=>[k,controls[k].value])),paths:paths.value,overrides:overrides.value}:null;
  refreshing=true;sync();
  try{
   const value=await api('/api/local-models/config');if(!valid(token))return;
   const raw=captureDraft();draw(value);
   if(raw&&previous){
    let kept=false;
    for(const [key]of definitions)if(raw.controls[key]!==String(previous[key]??'')){controls[key].value=raw.controls[key];kept=true;}
    for(const [key,control,text]of [['modelPaths',paths,raw.paths],['modelOverrides',overrides,raw.overrides]]){
     try{
      const draft=JSON.parse(text||'{}'),before=previous[key]||{},latest=value.settings?.[key]||{};
      if(JSON.stringify(draft)!==JSON.stringify(before)){
       const merged={...latest};
       for(const k of new Set([...Object.keys(before),...Object.keys(draft)]))
        if(JSON.stringify(draft[k])!==JSON.stringify(before[k])){if(Object.hasOwn(draft,k))merged[k]=draft[k];else delete merged[k];}
       control.value=JSON.stringify(merged,null,2);kept=true;
      }
     }catch{control.value=text;kept=true;}
    }
    if(kept)feedback.textContent='Latest revision loaded. Your unsaved edits are retained; review them before saving. Other saved model entries were merged.';
    else feedback.textContent='Latest revision loaded. Your selected model file and name are unchanged.'+(pendingRestart?' Saved changes still await an idle server.':'');
   }
  }catch(e){if(valid(token))feedback.textContent=e.message||'Could not read launcher settings.';}
  finally{if(token===generation)refreshing=false;if(alive)sync();}
 }
 reload.addEventListener('click',()=>void refresh({preserveDraft:true}));
 file.addEventListener('input',()=>{if(!name.value.trim())name.value=suggested(file.value);sync();});name.addEventListener('input',sync);
 browse.addEventListener('click',async()=>{
  if(pending||picking||refreshing||!active||!alive||!pickFiles)return;
  const token=generation;picking=true;sync();
  try{const result=await pickFiles();if(!valid(token))return;const chosen=Array.isArray(result)?result:result?.filePaths||[];if(!chosen.length)return;
   if(chosen.length!==1||!/\.gguf$/i.test(chosen[0]))throw Error('Choose one GGUF model file.');
   const available=baseline?.modelPaths||{};
   const samePath=(a,b)=>a===b;
   const stem=suggested(chosen[0]);
   let id=Object.keys(available).find(key=>samePath(available[key],chosen[0]))||stem;
   for(let n=2;Object.hasOwn(available,id)&&!samePath(available[id],chosen[0]);n++)id=stem.slice(0,248)+'-'+n;
   file.value=chosen[0];name.value=id;
   picking=false;
   await loadFile({useSavedSettings:true});
  }catch(e){if(valid(token))feedback.textContent=e.message||'Could not choose a model.';}finally{picking=false;if(alive)sync();}
 });
 async function loadFile({useSavedSettings=false}={}){
  if(pending||picking||refreshing||!alive||!active||revision===null)return;
  const filename=file.value.trim(),id=name.value.trim(),token=generation;
  if(!filename||!/\.gguf$/i.test(filename)||!id){feedback.textContent='Choose a GGUF file and a model name.';return;}
  pending=true;sync();let saved=false;
  try{
   const draft=useSavedSettings?{controls:Object.fromEntries(definitions.map(([k])=>[k,controls[k].value])),paths:paths.value,overrides:overrides.value,previous:structuredClone(baseline)}:null;
   const settings=useSavedSettings?structuredClone(baseline):read();
   settings.modelPaths??={};
   if(Object.hasOwn(settings.modelPaths,id)&&settings.modelPaths[id]!==filename)throw Error('That model name already points to another file. Choose a different name.');
   function drawWithDraft(snapshot){
    draw(snapshot);
    if(!draft)return;
    for(const [key]of definitions)if(draft.controls[key]!==String(draft.previous?.[key]??''))controls[key].value=draft.controls[key];
    for(const [key,control,raw]of [['modelPaths',paths,draft.paths],['modelOverrides',overrides,draft.overrides]]){
     const before=draft.previous?.[key]||{}, latest=snapshot.settings?.[key]||{};
     if(raw===JSON.stringify(before,null,2))continue;
     try {
      const edits=JSON.parse(raw), merged={...latest};
      for(const name of new Set([...Object.keys(before),...Object.keys(edits)]))
       if(JSON.stringify(edits[name])!==JSON.stringify(before[name])){if(Object.hasOwn(edits,name))merged[name]=edits[name];else delete merged[name];}
      control.value=JSON.stringify(merged,null,2);
     } catch { control.value=raw; }
    }
    populateYaRN();
   }
   if(!useSavedSettings||settings.modelPaths[id]!==filename){
    settings.modelPaths={...settings.modelPaths,[id]:filename};
    feedback.textContent='Saving model configuration.';
    const snapshot=await api('/api/local-models/config','POST',{expectedRevision:revision,settings});saved=true;
    if(!valid(token))return;drawWithDraft(snapshot);
   }
   feedback.textContent=pendingRestart?'Applying saved settings when the owned server is idle, then loading '+id+'…':'Starting local runtime and loading '+id+'…';
   const result=await api('/api/local-models/load','POST',{engine:'llamacpp',model:id});
   if(valid(token)) {
    await onChanged(result);
    // Refresh backend status after launch, including any GPU-to-CPU fallback.
    try {const latest=await api('/api/local-models/config');if(valid(token))drawWithDraft(latest);}catch{}
    if(valid(token))feedback.textContent='Loaded '+id+'. Ready in the BLACKICE model picker.'+(pendingRestart?' Newer settings remain pending; active work was not interrupted.':'');
   }
  }catch(e){if(valid(token))feedback.textContent=e.code==='LOCAL_LLAMA_RESTART_BUSY'?'Model settings saved. Current local work is still running and was not interrupted. Wait for it to finish, then load the model again.':(saved?'Model configuration saved; loading failed. ':'')+(e.message||'Could not load model.');}
  finally{pending=false;if(alive)sync();}
 }
 start.addEventListener('click',()=>loadFile());
 save.addEventListener('click',async()=>{
  if(pending||picking||refreshing||revision===null||!alive||!active)return;
  const token=generation;pending=true;sync();
  try{const snapshot=await api('/api/local-models/config','POST',{expectedRevision:revision,settings:read()});if(valid(token))draw(snapshot);}
  catch(e){if(valid(token))feedback.textContent=e.message||'Could not save launcher defaults.';}
  finally{pending=false;if(alive)sync();}
 });
 reset.addEventListener('click',()=>{
  if(!recommended||pending||picking||refreshing)return;
  try{const existing=read();fill({...recommended,executablePath:existing.executablePath,modelsDirectory:existing.modelsDirectory,modelPaths:existing.modelPaths,modelOverrides:existing.modelOverrides});
   feedback.textContent='Recommended performance values staged. Model files and custom runtime are preserved. Choose Save to persist.';
  }catch(e){feedback.textContent=e.message;}
 });
 sync();
 return {refresh:()=>refresh({preserveDraft:true}),enter(){if(active||!alive)return;active=true;void refresh({preserveDraft:baseline!==null});},leave(){active=false;generation++;refreshing=false;},destroy(){this.leave();alive=false;mount.replaceChildren();advancedMount?.replaceChildren();}};
}
