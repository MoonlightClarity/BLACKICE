import {text} from '../core/dom.mjs';
import {PROVIDER_PRESETS,getProviderPreset,isOpenRouterProvider,modelLimitDetails,modelLimitReferences,modelLimitLookupSummary} from '../../provider-catalog.mjs';
import {createProviderModelSelection,providerHeadersForSave,codexModelAccessLabel,codexModelSourceLabel} from '../../connection-models.mjs';
import {MODEL_SORTS,groupModels,modelIsFree} from '../../model-browser.mjs';

const PAGE=80,LIST_PAGE=40,SEARCH_DELAY=180,NEW_DRAFT='__new_provider_draft__';
const copy=value=>structuredClone(value);
const presetFor=value=>getProviderPreset(value?.preset)||
  (isOpenRouterProvider(value)?getProviderPreset('openrouter'):null)||
  PROVIDER_PRESETS.find(item=>item.baseUrl&&item.baseUrl===value?.baseUrl)||getProviderPreset('compatible');
const capacityLines=models=>models.filter(model=>model.contextWindowTokens).map(model=>`${model.id} = ${model.contextWindowTokens}`).join('\n');
const newId=()=>`api_${globalThis.crypto?.randomUUID?.().replaceAll('-','').slice(0,12)||Math.random().toString(36).slice(2,14)}`;
const modelId=value=>typeof value==='string'&&value.trim()&&value.length<=256&&!/[\r\n\x00]/.test(value)&&!value.includes('::');
const nativeId=value=>typeof value==='string'&&value.length>0&&value.length<=400&&!/[\x00-\x20\x7f]/.test(value)&&!['codex','default'].includes(value)&&!value.includes('::');
const endpointPaths=(models,chat,type)=>({...(String(models||'').trim()?{models:String(models).trim()}:{}),...(type==='compatible'&&String(chat||'').trim()?{chatCompletions:String(chat).trim()}:{})});
const endpointSummary=provider=>[provider.endpoints?.models&&'Models: '+provider.endpoints.models,provider.type==='compatible'&&provider.endpoints?.chatCompletions&&'Chat Completions: '+provider.endpoints.chatCompletions].filter(Boolean).join(' · ');
const selectedIds=models=>JSON.stringify((models||[]).map(model=>model.id).sort());
const definition=provider=>JSON.stringify([provider.id,provider.name,provider.preset,provider.type,provider.baseUrl,provider.endpoints,provider.enabled,provider.maxTokens,provider.maxSteps,provider.hasApiKey,provider.hasHeaders,provider.headerNames,provider.updatedAt,
  (provider.models||[]).map(model=>[model.id,model.contextWindowSource==='user-configured'?model.contextWindowTokens:null,model.maxOutputTokensSource==='user-configured'?model.maxOutputTokens:null])]);
function validateEndpointPaths(paths){for(const value of Object.values(paths)){if(value.length>2000||!value.startsWith('/')||value.startsWith('//')||/[?#\\\x00-\x20\x7f]/.test(value))throw Error('Endpoint paths must start with one / and contain no URL, query, fragment, backslash, or whitespace.');}return paths;}

/** Drafts and credentials live only in this component's memory. Reads never save. */
export function createProviderSettings({mount,api,events,notify=()=>{},onChanged=()=>{},getRuntimeSettings=()=>null,onRuntimeSettings=()=>{}}) {
  mount.innerHTML=`<section id="next-provider-root" class="next-providers" aria-label="Model connections">
    <header class="next-provider-heading"><div><h2>API connections</h2><p class="next-help">Choose Kilo Free or Pollinations Classic to start without an API key. Reopen a saved connection to add models.</p></div><div class="next-row"><button type="button" id="next-provider-refresh">Refresh connections</button><button type="button" id="next-provider-new">Add connection</button></div></header>
    <p id="next-provider-info" role="status" aria-live="polite"></p>
    <div class="next-provider-layout"><aside aria-label="Saved API connections"><label class="next-label">Find a connection<input id="next-provider-filter" class="next-field" type="search" maxlength="100"></label><ul id="next-provider-list" class="next-provider-list"></ul><button type="button" id="next-provider-more" hidden>Show more connections</button><details id="next-provider-hidden" class="next-provider-hidden" hidden><summary>Hidden providers <span id="next-provider-hidden-count"></span></summary><p class="next-help">Restore a provider to show it in model menus. Its saved connection and running conversations are retained.</p><ul id="next-provider-hidden-list" class="next-provider-list"></ul></details></aside>
    <section id="next-provider-editor" class="next-card" aria-label="Connection editor"><p id="next-provider-empty" class="next-help">Choose a connection or add one.</p>
    <form id="next-provider-form" class="next-stack" hidden autocomplete="off">
      <h3 id="next-provider-title">Connection</h3><p id="next-provider-stale" class="next-help" hidden>Saved settings changed. Your draft is kept; Reload saved settings replaces it.</p>
      <div class="next-row next-provider-manage-actions"><button type="button" id="next-provider-manage-models" class="next-primary">Manage models / Add models</button><button type="button" id="next-provider-limits-refresh">Refresh model limits</button><button type="button" id="next-provider-hide">Hide provider from model menus</button></div>
      <details id="next-provider-connection-details" class="next-provider-advanced"><summary>Connection settings · address, API key and limits</summary><div class="next-stack">
      <div class="next-provider-fields"><label class="next-label">Preset<select id="next-provider-preset" class="next-field"></select></label><label class="next-label">API protocol<select id="next-provider-protocol" class="next-field"><option value="compatible">OpenAI compatible</option><option value="openai">OpenAI</option><option value="anthropic">Anthropic</option></select></label><label class="next-label">Connection name<input id="next-provider-name" class="next-field" maxlength="100" required></label><label class="next-label">Connection ID<input id="next-provider-id" class="next-field" maxlength="40" spellcheck="false" required></label></div>
      <label class="next-label">API address<input id="next-provider-base-url" class="next-field" type="url" spellcheck="false" required></label>
      <details class="next-provider-advanced"><summary>Custom endpoint paths</summary><div class="next-stack"><p class="next-help">Optional paths on this API address’s origin. Blank uses standard paths relative to the API address.</p><label class="next-label">Model catalog path<input id="next-provider-models-path" class="next-field" maxlength="2000" spellcheck="false" placeholder="/models"></label><label class="next-label">Chat Completions path<input id="next-provider-chat-path" class="next-field" maxlength="2000" spellcheck="false" placeholder="/chat/completions"></label><p class="next-help">Chat Completions paths apply to the OpenAI compatible protocol.</p></div></details>
      <label class="next-label">API key<input id="next-provider-key" class="next-field" type="password" autocomplete="new-password" maxlength="20000" aria-describedby="next-provider-key-note"></label><p id="next-provider-key-note" class="next-help"></p><label class="next-row"><input id="next-provider-clear-key" type="checkbox">Remove saved API key</label>
      <details class="next-provider-advanced"><summary>Request headers and limits</summary><div class="next-stack"><p id="next-provider-header-note" class="next-help"></p><label class="next-label">Replacement request headers<textarea id="next-provider-headers" class="next-field" rows="3" spellcheck="false" autocomplete="off" placeholder="Header-Name: value"></textarea></label><p class="next-help">Blank keeps saved headers. Replacement headers replace the whole saved set.</p><label class="next-row"><input id="next-provider-clear-headers" type="checkbox">Remove saved headers</label><div class="next-provider-fields"><label class="next-label">Configured output budget<input id="next-provider-max-tokens" class="next-field" type="number" min="1" max="128000" step="1"></label><label class="next-label">Maximum tool steps<input id="next-provider-max-steps" class="next-field" type="number" min="1" step="1" placeholder="No application limit"></label></div><p class="next-help">The configured output budget applies per response, up to the model’s maximum output. Model limits and their sources are shown below.</p><label class="next-label">Model context capacities<textarea id="next-provider-capacities" class="next-field" rows="3" placeholder="model-id = 900000" spellcheck="false"></textarea></label><p class="next-help">BLACKICE looks up model limits when models are saved or refreshed. Enter a capacity only to override a retrieved value. Unlisted capacities are preserved. Use model-id = unknown to clear one.</p></div></details>
      <label class="next-row"><input id="next-provider-enabled" type="checkbox">Use this connection</label>
      </div></details>
      <section aria-label="Selected models"><div class="next-provider-group-heading"><h3>Selected models <span id="next-provider-model-count" class="next-help"></span></h3><div class="next-row"><button type="button" id="next-provider-selected-expand">Expand all</button><button type="button" id="next-provider-selected-collapse">Collapse all</button></div></div><div id="next-provider-models" class="next-provider-models"></div><div class="next-provider-inline"><label class="next-label">Exact model ID<input id="next-provider-manual-model" class="next-field" maxlength="256" spellcheck="false"></label><button type="button" id="next-provider-add-model">Add model ID</button></div></section>
      <details id="next-provider-catalog-panel" class="next-provider-catalog-panel"><summary>Add models from this connection</summary><div class="next-stack"><p class="next-help">Uses the saved API address and key. Save connection setting changes first. Search, sorting and filters apply to the entire catalog before pages are shown.</p><div class="next-provider-inline"><label class="next-label">Search all models<input id="next-provider-catalog-search" class="next-field" type="search" maxlength="256" placeholder="Name, provider or exact ID"></label><button type="button" id="next-provider-catalog-load">Search catalog</button></div><div class="next-provider-catalog-filters"><label class="next-label">Sort models<select id="next-provider-catalog-sort" class="next-field"></select></label><label class="next-label">Minimum context tokens<input id="next-provider-catalog-min-context" class="next-field" type="number" min="0" step="1" placeholder="Any context size"></label><label class="next-row"><input id="next-provider-catalog-free" type="checkbox">Free only</label><label class="next-row"><input id="next-provider-catalog-tools" type="checkbox">Tools</label><label class="next-row"><input id="next-provider-catalog-vision" type="checkbox">Vision input</label></div><div class="next-row"><button type="button" id="next-provider-catalog-expand">Expand all</button><button type="button" id="next-provider-catalog-collapse">Collapse all</button><button type="button" id="next-provider-catalog-clear">Clear filters</button></div><div id="next-provider-catalog" class="next-provider-models"></div><div class="next-row"><button type="button" id="next-provider-catalog-prev">Previous</button><span id="next-provider-catalog-page" class="next-help"></span><button type="button" id="next-provider-catalog-next">Next</button></div></div></details>
      <p id="next-provider-receipt" role="status" aria-live="polite"></p><p id="next-provider-error" role="alert"></p>
      <footer class="next-row"><button type="button" id="next-provider-save" class="next-primary">Save connection</button><button type="button" id="next-provider-test">Test saved connection</button><button type="button" id="next-provider-discard">Reload saved settings</button><button type="button" id="next-provider-delete">Remove connection</button></footer>
    </form></section></div>
    <details id="next-provider-codex" class="next-card next-provider-codex"><summary>Codex model IDs and checks</summary><button type="button" id="next-provider-codex-hide">Hide Codex from model menus</button><p class="next-help">Add an exact native Codex model ID, including one absent from the catalog. Codex decides whether it can serve each request.</p><div class="next-provider-inline"><label class="next-label">Exact Codex model ID<input id="next-provider-codex-id" class="next-field" maxlength="400" spellcheck="false" autocomplete="off"></label><button type="button" id="next-provider-codex-add">Add model ID</button><button type="button" id="next-provider-codex-check">Try model</button></div><p class="next-help">Try model sends one short text request and may use your account’s quota. It has a 45-second deadline. Its result describes that request and account.</p><div class="next-provider-inline"><label class="next-label">Find Codex models<input id="next-provider-codex-filter" class="next-field" type="search" maxlength="200"></label><button type="button" id="next-provider-codex-read">Refresh model list and limits</button></div><p id="next-provider-codex-status" class="next-help" role="status" aria-live="polite">Refresh the model list to retrieve native model limits and check status.</p><p id="next-provider-codex-error" role="alert"></p><ul id="next-provider-codex-list" class="next-provider-list"></ul><button type="button" id="next-provider-codex-more" hidden>Show more models</button></details>
  </section>`;
  const $=id=>mount.querySelector('#next-provider-'+id);
  const f=Object.fromEntries(['root','refresh','new','info','filter','list','more','hidden','hidden-count','hidden-list','manage-models','limits-refresh','hide','connection-details','selected-expand','selected-collapse','catalog-panel','catalog-sort','catalog-min-context','catalog-free','catalog-tools','catalog-vision','catalog-expand','catalog-collapse','catalog-clear','editor','empty','form','title','stale','preset','protocol','name','id','base-url','models-path','chat-path','key','key-note','clear-key','header-note','headers','clear-headers','max-tokens','max-steps','capacities','enabled','models','model-count','manual-model','add-model','catalog-search','catalog-load','catalog','catalog-prev','catalog-next','catalog-page','receipt','error','save','test','discard','delete','codex','codex-hide','codex-id','codex-add','codex-check','codex-filter','codex-read','codex-status','codex-error','codex-list','codex-more'].map(id=>[id,$(id)]));
  const drafts=new Map();
  let runtimeSettings=copy(getRuntimeSettings()||{});
  const hiddenProviders=()=>new Set(Array.isArray(runtimeSettings.hiddenModelProviders)?runtimeSettings.hiddenModelProviders:[]);
  let active=false,destroyed=false,selected=null,providers=[],listLimit=LIST_PAGE,listBusy=false,listSequence=0,listAbort,unsubscribe=null;
  let busy=false,catalogBusy=false,catalogSequence=0,catalogAbort,catalogTimer=null,loaded=false,stale=false,codex=null,codexLimit=LIST_PAGE,codexSequence=0,codexAbort,codexBusy=false,uncertainCheck=false;
  const current=()=>drafts.get(selected);
  const add=(parent,tag,value='',className='')=>text(parent,value,tag,className);
  const path=id=>'/api/providers/'+encodeURIComponent(id);
  const safeError=error=>{
    let message=String(error?.message||error||'This action could not complete.');
    for(const draft of drafts.values())for(const secret of [draft.key,...String(draft.headers||'').split('\n').map(line=>line.slice(line.indexOf(':')+1).trim())])if(secret)message=message.replaceAll(secret,'[redacted]');
    return message;
  };
  const status=(node,message,error=false)=>{node.textContent=message;node.dataset.error=String(error);};
  const settings=draft=>({preset:draft.preset,type:draft.type,name:draft.name.trim(),id:draft.id,baseUrl:draft.baseUrl.trim(),endpoints:endpointPaths(draft.modelsPath,draft.chatPath,draft.type),enabled:draft.enabled,maxTokens:draft.maxTokens,maxSteps:draft.maxSteps});
  const settingsChanged=draft=>!draft?.saved||Boolean(draft.key||draft.clearKey||draft.headers.trim()||draft.clearHeaders)||JSON.stringify(settings(draft))!==draft.baseline;
  const changed=draft=>settingsChanged(draft)||draft.capacities!==draft.originalCapacities||JSON.stringify(draft.selection.forSave())!==draft.originalModels;
  const userChanged=draft=>settingsChanged(draft)||draft.capacities!==draft.originalCapacities||Boolean(draft.manual.trim())||selectedIds(draft.selection.selected())!==selectedIds(draft.saved?.models);
  function makeDraft(provider){
    const value=provider||{id:newId(),name:'OpenRouter',preset:'openrouter',type:'compatible',baseUrl:getProviderPreset('openrouter').baseUrl,models:[],enabled:true,maxTokens:8192,maxSteps:null};
    const selection=createProviderModelSelection(value.models||[]),capacities=capacityLines(selection.selected());
    const draft={saved:provider?copy(provider):null,id:value.id,name:value.name,preset:presetFor(value).id,type:value.type,baseUrl:value.baseUrl,modelsPath:value.endpoints?.models||'',chatPath:value.endpoints?.chatCompletions||'',
      enabled:value.enabled!==false,maxTokens:String(value.maxTokens??8192),maxSteps:value.maxSteps==null?'':String(value.maxSteps),key:'',headers:'',clearKey:false,clearHeaders:false,
      selection,capacities,originalCapacities:capacities,originalModels:JSON.stringify(selection.forSave()),catalog:null,query:'',sort:'name',freeOnly:Boolean(presetFor(value).freeOnly),toolsOnly:false,visionOnly:false,minContextTokens:'',expanded:{selected:new Set(),catalog:new Set()},connectionDetailsOpen:!provider,catalogOpen:false,limitsNeedRetry:(value.models||[]).some(model=>['partial','unresolved','unavailable'].includes(model.modelLimitLookup?.status)),manual:'',receipt:'',error:''};
    draft.baseline=JSON.stringify(settings(draft));return draft;
  }
  function notifyChanged(){try{Promise.resolve(onChanged()).catch(()=>{if(active)status(f.info,'Model choices could not refresh; use Refresh connections.',true);});}catch{if(active)status(f.info,'Model choices could not refresh; use Refresh connections.',true);}}
  function controls(){
    const draft=current();
    for(const control of f.form.querySelectorAll('input,select,textarea,button'))control.disabled=busy;
    f.new.disabled=busy;f.refresh.disabled=busy||listBusy;f.filter.disabled=busy;f.more.disabled=busy;
    for(const button of [...f.list.querySelectorAll('button'),...f['hidden-list'].querySelectorAll('button')])button.disabled=busy;
    f['codex-hide'].disabled=busy;
    if(draft){
      f['chat-path'].disabled=busy||draft.type!=='compatible';
      f['catalog-free'].disabled=busy||getProviderPreset(draft.preset)?.freeOnly===true;
      f.id.disabled=busy||Boolean(draft.saved);f.save.disabled=busy||draft.conflict===true||!changed(draft);
      f.test.disabled=busy||draft.conflict===true||!draft.saved||changed(draft);f.delete.disabled=busy||draft.conflict===true||!draft.saved;
      f.discard.disabled=busy||listBusy;f.delete.hidden=!draft.saved;
      const canCatalog=Boolean(draft.saved)&&!draft.conflict&&!settingsChanged(draft)&&!busy&&!catalogBusy;
      f['manage-models'].disabled=!canCatalog;f['limits-refresh'].disabled=!canCatalog;f['limits-refresh'].textContent=draft.limitsNeedRetry?'Retry model limits':'Refresh model limits';f.hide.disabled=busy||!draft.saved;f.hide.hidden=!draft.saved;
      f.hide.textContent=hiddenProviders().has(draft.id)?'Restore provider to model menus':'Hide provider from model menus';
      f.save.textContent=draft.saved&&!settingsChanged(draft)?'Save selected models':'Save connection';
      f['catalog-load'].disabled=!canCatalog;f['catalog-prev'].disabled=!canCatalog||draft.catalogPending===true||!draft.catalog?.offset;
      f['catalog-next'].disabled=!canCatalog||draft.catalogPending===true||!draft.catalog?.hasMore;
      f.catalog.setAttribute('aria-busy',String(catalogBusy||draft.catalogPending===true));
    }
    for(const control of [f['codex-id'],f['codex-add'],f['codex-read'],f['codex-more']])control.disabled=busy||codexBusy;
    f['codex-check'].disabled=busy||codexBusy||uncertainCheck||!codex?.connected||!codex?.authenticated||codex?.modelCheckBlocked===true||codex?.modelCheck?.status==='checking';
    for(const button of f['codex-list'].querySelectorAll('button'))button.disabled=busy||codexBusy;
    f.root.setAttribute('aria-busy',String(busy));
  }
  function paintList(){
    f.list.replaceChildren();f['hidden-list'].replaceChildren();const query=f.filter.value.trim().toLowerCase(),hidden=hiddenProviders();
    const matching=providers.filter(item=>`${item.name} ${item.id} ${item.type}`.toLowerCase().includes(query)),visible=matching.filter(item=>!hidden.has(item.id)),hiddenMatches=matching.filter(item=>hidden.has(item.id));
    for(const provider of visible.slice(0,listLimit)){
      const row=add(f.list,'li','', 'next-provider-connection-row'),button=add(row,'button','', 'next-provider-list-item');button.type='button';button.dataset.providerId=provider.id;
      button.setAttribute('aria-pressed',String(selected===provider.id));add(button,'strong',provider.name);add(button,'span',provider.id,'next-help');
      add(button,'span',provider.enabled===false?'Disabled':provider.configured?'Enabled · configured':'Enabled · needs credentials','next-status-pill');
      add(button,'span',`${provider.models?.length||0} selected models`,'next-help');
      const endpoints=endpointSummary(provider);if(endpoints)add(button,'span',endpoints,'next-help');
      button.addEventListener('click',()=>{if(!busy)select(provider.id);});
      const actions=add(row,'div','', 'next-row next-provider-row-actions'),manage=add(actions,'button','Manage models');manage.type='button';manage.dataset.providerManage=provider.id;
      manage.addEventListener('click',()=>{if(!busy)select(provider.id,{focusCatalog:true});});
      const hide=add(actions,'button','Hide');hide.type='button';hide.dataset.providerHide=provider.id;hide.setAttribute('aria-label','Hide '+provider.name+' from model menus');hide.addEventListener('click',()=>void setProviderHidden(provider.id,true));
    }
    if(!visible.length)add(f.list,'li',hiddenMatches.length?'Matching connections are in Hidden providers below.':query?'No matching connections.':'No visible API connections.','next-help');
    const hiddenEntries=hiddenMatches.map(provider=>({id:provider.id,name:provider.name}));if(hidden.has('codex')&&(!query||'codex'.includes(query)))hiddenEntries.unshift({id:'codex',name:'Codex'});
    for(const provider of hiddenEntries){const row=add(f['hidden-list'],'li','', 'next-provider-hidden-row');add(row,'strong',provider.name);const restore=add(row,'button','Restore');restore.type='button';restore.dataset.providerRestore=provider.id;restore.setAttribute('aria-label','Restore '+provider.name+' to model menus');restore.addEventListener('click',()=>void setProviderHidden(provider.id,false));}
    f.hidden.hidden=!hiddenEntries.length;f['hidden-count'].textContent=String(hiddenEntries.length);f.codex.hidden=hidden.has('codex');
    f.more.hidden=visible.length<=listLimit;controls();
  }
  async function setProviderHidden(id,hide){
    if(!active||destroyed||busy)return;busy=true;cancelCatalog();status(f.info,hide?'Hiding provider from model menus…':'Restoring provider to model menus…');controls();
    try{
      const latest=await api('/api/runtime/settings','GET');if(destroyed)return;
      const ids=new Set(Array.isArray(latest.hiddenModelProviders)?latest.hiddenModelProviders:[]);hide?ids.add(id):ids.delete(id);
      const saved=await api('/api/runtime/settings','POST',{hiddenModelProviders:[...ids]});if(destroyed)return;
      runtimeSettings=copy(saved);onRuntimeSettings(saved);notifyChanged();status(f.info,hide?'Provider hidden from model menus. Restore it from Hidden providers.':'Provider restored to model menus.');
    }catch(error){if(!destroyed)status(f.info,safeError(error),true);}
    finally{busy=false;if(active&&!destroyed){paintList();controls();if(stale)void load();}}
  }
  function paintGroups(parent,models,draft,scope){
    const groups=groupModels(models,{providers:providers,defaultProviderId:draft.id,defaultLabel:draft.saved?.name||draft.name,mode:'publisher'});
    for(const group of groups){
      const details=add(parent,'details','', 'next-provider-model-group');details.dataset.modelGroup=group.id;details.dataset.groupScope=scope;details.open=draft.expanded[scope].has(group.id);
      const summary=add(details,'summary');add(summary,'strong',group.label);const total=scope==='catalog'?draft.catalog?.groups?.find(item=>item.id===group.id)?.total:null;add(summary,'span',total>group.models.length?`${group.models.length} of ${total} matches`:`${group.models.length} model${group.models.length===1?'':'s'}`,'next-help');
      details.addEventListener('toggle',()=>{details.open?draft.expanded[scope].add(group.id):draft.expanded[scope].delete(group.id);});
      const body=add(details,'div');for(const model of group.models)modelRow(body,model,draft.selection.selected().some(item=>item.id===model.id));
    }
  }
  function expandGroups(scope,expanded){const draft=current();if(!draft)return;const parent=scope==='selected'?f.models:f.catalog;for(const group of parent.querySelectorAll('details')){group.open=expanded;expanded?draft.expanded[scope].add(group.dataset.modelGroup):draft.expanded[scope].delete(group.dataset.modelGroup);}}
  function limitSources(parent,model){
    const references=modelLimitReferences(model);if(!references.length)return;
    const container=add(parent,'div','','next-provider-model-sources');
    for(const reference of references){const row=add(container,'small');add(row,'span','Source: ');
      if(reference.url){const link=add(row,'a',reference.label);link.setAttribute('href',reference.url);link.setAttribute('target','_blank');link.setAttribute('rel','noopener noreferrer');link.dataset.modelLimitSource=model.id||model.model||'';}
      else add(row,'span',reference.label+' · '+reference.path);
    }
  }
  function limitDetails(parent,model){
    for(const [label,value]of modelLimitDetails(model))add(parent,'small',label+': '+value);
    const lookup=modelLimitLookupSummary(model);if(lookup)add(parent,'small',lookup,'next-provider-model-lookup');
  }
  function modelRow(parent,model,chosen){
    const entry=add(parent,'div','','next-provider-model-entry'),label=add(entry,'label','', 'next-provider-model');
    const input=add(label,'input');input.type='checkbox';input.checked=chosen;input.dataset.providerModelId=model.id;
    const body=add(label,'span');add(body,'strong',model.displayName||model.id);add(body,'small',model.id);
    limitDetails(body,model);
    if(typeof model.supportsTools==='boolean')add(body,'small',model.supportsTools?'Provider reports tools':'Provider reports no tools');
    if(modelIsFree(model))add(body,'small',model.pricing?'Free · provider-reported pricing':'Free · provider-reported access');
    limitSources(entry,model);
    input.addEventListener('change',()=>{
      if(busy)return;const draft=current();try{draft.selection.toggle(model.id,input.checked);draft.error='';}catch(error){draft.error=safeError(error);}
      paintModels();feedback();controls();
    });
  }
  function paintModels(){
    const draft=current();if(!draft)return;
    f.models.replaceChildren();f.catalog.replaceChildren();const chosen=draft.selection.selected(),ids=new Set(chosen.map(item=>item.id));
    f['model-count'].textContent=`${chosen.length} / 200`;
    paintGroups(f.models,chosen,draft,'selected');
    if(!chosen.length)add(f.models,'p','No models selected. Add an exact ID or search the saved connection.','next-help');
    paintGroups(f.catalog,draft.selection.page(),draft,'catalog');
    if(!draft.selection.page().length)add(f.catalog,'p',draft.catalog?.available===false?'Provider catalog unavailable. Selected models are kept. Use Retry model limits to try again.':draft.catalog?'No models match these filters.':'Search the catalog to find models.','next-help');
    const page=draft.catalog;
    f['catalog-page'].textContent=draft.catalogPending?(page?'Updating results… previous results are shown until the new search completes.':'Searching the full catalog…'):page?.available===false?'Full provider catalog unavailable · selected IDs kept':page?`${page.total?`${page.offset+1}–${page.offset+page.returned} of ${page.total} matching models`:'No matches'} · whole catalog filtered · selections kept across pages`:'';
  }
  function feedback(){const draft=current();if(!draft)return;status(f.receipt,draft.receipt);status(f.error,draft.error,true);}
  function savedNotes(){
    const draft=current();if(!draft)return;const saved=draft.saved;
    f['key-note'].textContent=saved?.hasApiKey?'API key saved. Leave blank to keep it.':getProviderPreset(draft.preset)?.anonymous?'No API key is required for this free preset. Save the connection, then select its models.':'Leave blank to keep any saved key. Some local servers do not require one.';
    f.key.placeholder=saved?.hasApiKey?'Saved · leave blank to keep':getProviderPreset(draft.preset)?.anonymous?'No API key required':'API key';
    f['header-note'].textContent=saved?.hasHeaders?`Saved header names: ${(saved.headerNames||[]).join(', ')}. Values stay hidden.`:'No saved request headers.';
    f.stale.hidden=!draft.conflict;
    f.stale.textContent=draft.removed?'This connection was removed elsewhere. Your draft is kept. Reload saved settings closes this draft.':'Saved settings changed elsewhere. Your draft is kept. Reload saved settings before saving.';
    f.discard.textContent=saved?'Reload saved settings':'Reset new connection';
  }
  function paintEditor(){
    const draft=current();f.form.hidden=!draft;f.empty.hidden=Boolean(draft);if(!draft){controls();return;}
    f.title.textContent=draft.saved?'Edit '+draft.saved.name:'New connection';
    for(const [field,key]of Object.entries({preset:'preset',protocol:'type',name:'name',id:'id','base-url':'baseUrl','models-path':'modelsPath','chat-path':'chatPath',key:'key',headers:'headers','max-tokens':'maxTokens','max-steps':'maxSteps',capacities:'capacities','catalog-search':'query','manual-model':'manual'}))f[field].value=draft[key];
    f.enabled.checked=draft.enabled;f['clear-key'].checked=draft.clearKey;f['clear-headers'].checked=draft.clearHeaders;
    f['catalog-sort'].value=draft.sort;f['catalog-min-context'].value=draft.minContextTokens;f['catalog-free'].checked=draft.freeOnly;f['catalog-tools'].checked=draft.toolsOnly;f['catalog-vision'].checked=draft.visionOnly;
    f['connection-details'].open=draft.connectionDetailsOpen;f['catalog-panel'].open=draft.catalogOpen;
    savedNotes();paintModels();feedback();controls();
  }
  function select(id,{focusCatalog=false}={}){
    if(busy||destroyed)return;cancelCatalog();
    if(!drafts.has(id)){const value=providers.find(item=>item.id===id);if(!value)return;drafts.set(id,makeDraft(value));}
    selected=id;paintList();void manageModels({focus:focusCatalog});
  }
  function cancelCatalog(){
    if(catalogTimer!==null){clearTimeout(catalogTimer);catalogTimer=null;}
    if(catalogBusy&&current())current().receipt='Model lookup paused. Search or refresh again; selected IDs and edits are kept.';
    if(current())current().catalogPending=false;
    catalogSequence++;catalogAbort?.abort();catalogAbort=null;catalogBusy=false;
  }
  function keepBrowser(next,previous){
    for(const key of ['query','sort','freeOnly','toolsOnly','visionOnly','minContextTokens','expanded','connectionDetailsOpen','catalogOpen'])next[key]=previous[key];
    return next;
  }
  function applyProviders(result,{browse=true}={}){
    const values=(Array.isArray(result)?copy(result):[]).map(value=>{const known=providers.find(item=>item.id===value.id);return known&&Date.parse(known.updatedAt)>Date.parse(value.updatedAt)?copy(known):value;});providers=values;loaded=true;stale=false;
    let repaint=false,reload=false;
    for(const [key,draft]of drafts){
      if(!draft.saved)continue;const latest=values.find(item=>item.id===draft.saved.id);
      if(latest&&JSON.stringify(latest)===JSON.stringify(draft.saved))continue;
      if(latest&&definition(latest)===definition(draft.saved)){
        const uneditedCapacities=draft.capacities===draft.originalCapacities;
        draft.saved=copy(latest);draft.selection.mergeMetadata(latest.models||[]);
        draft.originalModels=JSON.stringify(createProviderModelSelection(latest.models||[]).forSave());
        draft.originalCapacities=capacityLines(latest.models||[]);if(uneditedCapacities)draft.capacities=draft.originalCapacities;
      }else if(userChanged(draft)){
        draft.conflict=true;draft.removed=!latest;
        if(key===selected)cancelCatalog();
      }else if(latest){
        const next=keepBrowser(makeDraft(latest),draft);drafts.set(key,next);
        if(key===selected){cancelCatalog();reload=browse&&next.catalogOpen;}
      }else{
        drafts.delete(key);if(key===selected){cancelCatalog();selected=null;}
      }
      if(key===selected||selected===null)repaint=true;
    }
    status(f.info,`${providers.length} saved connection${providers.length===1?'':'s'}.`);paintList();if(repaint)paintEditor();else savedNotes();
    if(reload)void catalog(0);
  }
  async function load(){
    if(!active||destroyed||listBusy||busy)return false;listBusy=true;const token=++listSequence,controller=new AbortController();listAbort=controller;
    status(f.info,'Loading connections…');controls();
    try{const result=await api('/api/providers','GET',undefined,{signal:controller.signal});
      if(!active||destroyed||token!==listSequence)return false;applyProviders(result);return true;
    }catch(error){if(active&&!destroyed&&token===listSequence)status(f.info,safeError(error),true);return false;}
    finally{if(token===listSequence){listBusy=false;listAbort=null;if(active)controls();}}
  }
  function payload(draft){
    const id=draft.id.trim(),name=draft.name.trim(),baseUrl=draft.baseUrl.trim();
    if(!/^[a-z][a-z0-9_-]{0,39}$/.test(id)||['codex','default','provider'].includes(id))throw Error('Use a connection ID starting with a lowercase letter, up to 40 letters, numbers, underscores or hyphens.');
    if(!draft.saved&&providers.some(item=>item.id===id))throw Error('That connection ID is already saved. Choose another ID.');
    if(!name||name.length>100)throw Error('Enter a connection name, up to 100 characters.');
    let url;try{url=new URL(baseUrl);}catch{throw Error('Enter the API HTTP or HTTPS address.');}
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.hash)throw Error('Use an HTTP or HTTPS address without credentials or a fragment.');
    const maxTokens=Number(draft.maxTokens),maxSteps=draft.maxSteps.trim()?Number(draft.maxSteps):null;
    if(!Number.isSafeInteger(maxTokens)||maxTokens<1||maxTokens>128000)throw Error('Maximum output tokens must be a whole number from 1 to 128,000.');
    if(maxSteps!==null&&(!Number.isSafeInteger(maxSteps)||maxSteps<1))throw Error('Maximum tool steps must be a positive whole number, or blank for no application limit.');
    const key=draft.key.trim();if(draft.clearKey&&key)throw Error('Enter a replacement API key or remove the saved key, not both.');
    const models=draft.selection.forSave(draft.capacities);if(models.some(model=>!modelId(model.id)))throw Error('Use exact model IDs up to 256 characters, without a provider prefix.');
    const headers=providerHeadersForSave(draft.headers,draft.clearHeaders);
    return {id,preset:draft.preset,type:draft.type,name,baseUrl,endpoints:validateEndpointPaths(endpointPaths(draft.modelsPath,draft.chatPath,draft.type)),models,enabled:draft.enabled,maxTokens,maxSteps,expectedUpdatedAt:draft.saved?.updatedAt??null,
      ...(key||draft.clearKey?{apiKey:draft.clearKey?'':key}:{}),...(headers===undefined?{}:{headers})};
  }
  async function mutate(action){
    const draft=current();if(!active||destroyed||busy||!draft)return;
    let value;try{if(draft.conflict)throw Error('Saved settings changed elsewhere. Reload saved settings before saving. Your draft is kept.');if(action==='save')value=payload(draft);else if(!draft.saved)return;else if(action==='test'&&changed(draft))throw Error('Save your changes before testing the connection.');}
    catch(error){draft.error=safeError(error);feedback();return;}
    let browseAfterSave=false;
    busy=true;cancelCatalog();listSequence++;listAbort?.abort();listBusy=false;draft.error='';draft.receipt=action==='delete'?'Removing connection…':action==='test'?'Testing saved connection…':'Saving connection…';feedback();controls();
    try{
      if(action==='save'){
        const saved=await api('/api/providers','POST',value);if(destroyed)return;
        const oldKey=selected,next=keepBrowser(makeDraft(saved),draft);browseAfterSave=!draft.saved;next.catalogOpen=draft.catalogOpen||browseAfterSave;next.receipt=saved.models?.length?'Connection saved. Selected models are available when this connection is configured and enabled.':'Connection saved with no selected models. Choose models below, then Save selected models.';
        drafts.delete(oldKey);draft.key='';draft.headers='';drafts.set(saved.id,next);selected=saved.id;
        providers=providers.filter(item=>item.id!==saved.id);providers.push(copy(saved));notifyChanged();notify('Connection saved.');
      }else if(action==='delete'){
        await api(path(draft.saved.id),'DELETE',{});if(destroyed)return;
        providers=providers.filter(item=>item.id!==draft.saved.id);drafts.delete(selected);draft.key='';draft.headers='';selected=null;notifyChanged();notify('Connection removed.');
      }else{
        const result=await api(path(draft.saved.id)+'/test','POST',{});if(destroyed)return;
        draft.receipt=result.credentialVerified===true?'API key verified; catalog reachable. Model access was not tested.':getProviderPreset(draft.preset)?.anonymous?'Free model catalog reachable. This preset requires no API key. Model access was not tested.':'Catalog reachable. API key and model access were not verified.';
      }
    }catch(error){if(!destroyed){if(error?.code==='PROVIDER_CHANGED'||error?.status===409){draft.conflict=true;stale=true;draft.error='Saved settings changed elsewhere. Your draft is kept. Reload saved settings before saving.';}else draft.error=safeError(error);draft.receipt=action==='test'?'Test did not complete. No model access was verified.':'The action did not complete successfully. Your draft is kept. Refresh connections to inspect saved state before retrying.';}}
    finally{busy=false;if(active&&!destroyed){paintList();paintEditor();if(stale)void load();if(browseAfterSave)void catalog(0);}}
  }
  function catalogOptions(draft){
    const minContextTokens=draft.minContextTokens.trim()?Number(draft.minContextTokens):0;
    if(!Number.isSafeInteger(minContextTokens)||minContextTokens<0)throw Error('Minimum context must be a nonnegative whole number.');
    return {query:draft.query.trim(),sort:draft.sort,freeOnly:draft.freeOnly||getProviderPreset(draft.preset)?.freeOnly===true,toolsOnly:draft.toolsOnly,visionOnly:draft.visionOnly,minContextTokens};
  }
  async function manageModels({focus=true}={}){
    const draft=current();if(!draft?.saved||busy)return;cancelCatalog();
    draft.query='';draft.sort='name';draft.freeOnly=Boolean(getProviderPreset(draft.preset)?.freeOnly);draft.toolsOnly=false;draft.visionOnly=false;draft.minContextTokens='';draft.catalog=null;draft.selection.setPage([]);draft.catalogOpen=true;
    paintEditor();if(focus)f['catalog-search'].focus();await catalog(0);
  }
  async function catalog(offset=0,{refresh=false}={}){
    if(catalogTimer!==null){clearTimeout(catalogTimer);catalogTimer=null;}
    const draft=current();if(!active||destroyed||busy||catalogBusy||!draft?.saved||draft.conflict||settingsChanged(draft))return;
    let options;try{options=catalogOptions(draft);}catch(error){draft.catalogPending=false;draft.error=safeError(error);paintModels();feedback();controls();return;}
    const fingerprint=JSON.stringify(options),key=selected,token=++catalogSequence,controller=new AbortController();catalogAbort=controller;catalogBusy=true;draft.catalogPending=true;draft.catalogOpen=true;f['catalog-panel'].open=true;draft.error='';draft.receipt=refresh?'Refreshing model limits…':'Loading model catalog…';paintModels();feedback();controls();
    try{const result=await api(path(draft.saved.id)+'/models','POST',{...options,offset,limit:PAGE,...(refresh?{refresh:true}:{})},{signal:controller.signal});
      if(!active||destroyed||token!==catalogSequence||key!==selected||fingerprint!==JSON.stringify(catalogOptions(draft)))return;
      const page=(result.models||[]).slice(0,PAGE);draft.selection.setPage(page);if(Array.isArray(result.selectedModels))draft.selection.mergeMetadata(result.selectedModels);draft.catalog={available:result.catalogAvailable!==false,offset:result.offset??offset,total:result.total??page.length,returned:page.length,hasMore:result.hasMore===true,groups:Array.isArray(result.groups)?result.groups:[]};
      const checked=[...draft.selection.selected(),...page];draft.limitsNeedRetry=!draft.catalog.available||checked.some(model=>['partial','unresolved','unavailable'].includes(model.modelLimitLookup?.status));
      draft.receipt=!draft.catalog.available?'Provider catalog unavailable. Lookup results for selected models are shown below. Current selections and edits are kept. Use Retry model limits to try again.':(refresh?'Model limits refreshed. Current selections and edits are kept.':'Catalog loaded using the saved connection. Existing selections are kept; Save selected models applies your changes.')+(draft.limitsNeedRetry?' Some limits were not found or lookup was unavailable. Use Retry model limits to try again.':'');
      draft.catalogPending=false;if(!draft.catalog.available&&result.catalogError)draft.error=safeError(result.catalogError);paintModels();feedback();if(refresh||Array.isArray(result.selectedModels))notifyChanged();
    }catch(error){if(active&&!destroyed&&token===catalogSequence&&key===selected){draft.error=safeError(error);draft.limitsNeedRetry=true;draft.receipt=refresh?'Model limits could not refresh. Your selected models and edits are kept. Use Retry model limits to try again.':'Catalog unavailable. Your selected models are kept. Use Retry model limits to try again.';feedback();}}
    finally{if(token===catalogSequence){catalogBusy=false;catalogAbort=null;draft.catalogPending=false;if(active&&!destroyed){paintModels();controls();}}}
  }
  function filtersChanged({immediate=false}={}){const draft=current();if(!draft)return;cancelCatalog();if(!draft.saved||draft.conflict||settingsChanged(draft)){paintModels();controls();return;}draft.catalogPending=true;draft.receipt='Updating model results…';draft.error='';paintModels();feedback();controls();catalogTimer=setTimeout(()=>{catalogTimer=null;void catalog(0);},immediate?0:SEARCH_DELAY);}
  async function reloadSaved(){
    if(busy||listBusy)return;const draft=current(),key=selected;if(!draft)return;cancelCatalog();
    if(draft.saved&&!await load())return;if(destroyed||selected!==key)return;
    const saved=draft.saved&&providers.find(item=>item.id===draft.saved.id);draft.key='';draft.headers='';
    if(draft.saved&&!saved){drafts.delete(key);selected=null;paintList();paintEditor();return;}
    const next=keepBrowser(makeDraft(saved),draft);drafts.set(key,next);paintList();paintEditor();if(saved&&next.catalogOpen)void catalog(0);
  }
  function checkReceipt(result){
    if(!result)return 'No model check recorded.';
    if(result.status==='checking')return `Checking ${result.model}… Read status for the saved result.`;
    const outcome=result.status==='accepted'?'Request completed':result.status==='interrupted'?'Request interrupted':'Request failed';
    return `${result.requestedModel||result.model||'Model'}: ${outcome}${result.checkedAt?' · '+result.checkedAt:''}. ${result.scope==='current-connection'?'Current account and connection.':'Earlier account or connection; this does not verify the current connection.'}${result.error?.message?' '+safeError(result.error):''} Future requests can have a different result.`;
  }
  function paintCodex(){
    f['codex-list'].replaceChildren();if(!codex){controls();return;}
    const native=new Map((codex.models||[]).map(model=>[model.model||model.id,model]));for(const model of codex.candidates||[])if(!native.has(model.model||model.id))native.set(model.model||model.id,{...model,source:model.source==='runtime-candidate'?'runtime-candidate':'documented',available:false});
    const query=f['codex-filter'].value.trim().toLowerCase(),matches=[...native.values()].filter(model=>`${model.id} ${model.model} ${model.displayName} ${codexModelSourceLabel(model)}`.toLowerCase().includes(query));
    for(const model of matches.slice(0,codexLimit)){
      const id=model.model||model.id,row=add(f['codex-list'],'li','', 'next-provider-codex-row'),body=add(row,'div');
      add(body,'strong',model.displayName||id);add(body,'small',id);add(body,'small',[codexModelSourceLabel(model),codexModelAccessLabel(model)].filter(Boolean).join(' · '));
      limitDetails(body,model);limitSources(body,model);
      if((codex.customModels||[]).includes(id)){const button=add(row,'button','Remove saved ID');button.type='button';button.dataset.codexRemove=id;button.addEventListener('click',()=>void codexAction('DELETE',id));}
    }
    if(!matches.length)add(f['codex-list'],'li','No matching native models.','next-help');
    f['codex-more'].hidden=matches.length<=codexLimit;
    controls();
  }
  async function readCodex(){
    if(!active||destroyed||codexBusy||busy)return;const token=++codexSequence,controller=new AbortController();codexAbort=controller;codexBusy=true;
    status(f['codex-error'],'');status(f['codex-status'],'Refreshing native model limits and check status…');controls();
    try{const result=await api('/api/codex/models?refresh=true','GET',undefined,{signal:controller.signal});
      if(!active||destroyed||token!==codexSequence)return;codex=result;uncertainCheck=false;
      status(f['codex-status'],`${result.connected&&result.authenticated?'Codex connected.':'Connect and sign in to Codex to try a model.'} ${checkReceipt(result.modelCheck)}${result.modelCheckBlocked?' Previous check cleanup is unresolved; restart BLACKICE before trying another model.':''}`);paintCodex();notifyChanged();
    }catch(error){if(active&&!destroyed&&token===codexSequence){status(f['codex-error'],safeError(error),true);status(f['codex-status'],'Model limits could not refresh. Previous results are kept. Use Refresh model list and limits to retry.');}}
    finally{if(token===codexSequence){codexBusy=false;codexAbort=null;if(active&&!destroyed)controls();}}
  }
  async function codexAction(action,selectedModel){
    if(!active||destroyed||busy||codexBusy)return;const model=(selectedModel??f['codex-id'].value).trim();
    if(!nativeId(model)){status(f['codex-error'],'Enter an exact native Codex model ID, without spaces or a provider prefix.',true);return;}
    if(action==='check'&&(uncertainCheck||!codex?.connected||!codex?.authenticated||codex?.modelCheckBlocked||codex?.modelCheck?.status==='checking'))return;
    busy=true;codexSequence++;codexAbort?.abort();codexBusy=false;status(f['codex-error'],'');status(f['codex-status'],action==='check'?`Checking ${model}… One bounded text request.`:action==='DELETE'?'Removing saved model ID…':'Saving model ID…');controls();
    try{
      const result=await api(action==='check'?'/api/codex/models/check':'/api/codex/models',action==='check'?'POST':action,{model},action==='check'?{deadlineMs:50000}:undefined);
      if(destroyed)return;codex=result;uncertainCheck=false;
      if(action==='POST'&&f['codex-id'].value.trim()===model)f['codex-id'].value='';
      status(f['codex-status'],action==='check'?checkReceipt(result.result):action==='DELETE'?'Saved ID removed. Advertised models remain listed.':'Model ID saved. '+modelLimitDetails((result.models||[]).find(item=>(item.model||item.id)===model)||{}).map(([label,value])=>label+': '+value).join(' · ')+'.');notifyChanged();
    }catch(error){if(!destroyed){if(action==='check')uncertainCheck=!error.status;status(f['codex-error'],safeError(error),true);status(f['codex-status'],action==='check'?'Check result unavailable. Read model and check status before trying again.':'The action did not complete successfully. Read status to inspect the saved IDs before retrying.');}}
    finally{busy=false;if(active&&!destroyed){paintCodex();controls();if(stale)void load();}}
  }
  for(const sort of MODEL_SORTS){const option=add(f['catalog-sort'],'option',sort.label);option.value=sort.id;}
  for(const preset of PROVIDER_PRESETS){const option=add(f.preset,'option',preset.name+(preset.anonymous?' · no API key':''));option.value=preset.id;}
  f.form.addEventListener('submit',event=>event.preventDefault());
  f.form.addEventListener('keydown',event=>{if(event.key==='Enter'&&event.target.tagName==='INPUT'&&event.target.type!=='checkbox')event.preventDefault();});
  for(const [field,key]of Object.entries({name:'name',id:'id','base-url':'baseUrl','models-path':'modelsPath','chat-path':'chatPath',key:'key',headers:'headers','max-tokens':'maxTokens','max-steps':'maxSteps',capacities:'capacities','manual-model':'manual'}))f[field].addEventListener('input',()=>{if(busy)return;const draft=current();if(draft){draft[key]=f[field].value;if(!['capacities','manual'].includes(key))cancelCatalog();feedback();controls();}});
  for(const [field,key]of Object.entries({enabled:'enabled','clear-key':'clearKey','clear-headers':'clearHeaders'}))f[field].addEventListener('change',()=>{if(busy)return;const draft=current();if(draft){draft[key]=f[field].checked;cancelCatalog();feedback();controls();}});
  f.preset.addEventListener('change',()=>{if(busy)return;const draft=current(),preset=getProviderPreset(f.preset.value);if(!draft||!preset)return;const previous=getProviderPreset(draft.preset);if(draft.name===previous?.name)draft.name=preset.name;draft.preset=preset.id;draft.type=preset.type;draft.baseUrl=preset.baseUrl;draft.modelsPath=preset.endpoints?.models||'';draft.chatPath=preset.endpoints?.chatCompletions||'';draft.freeOnly=preset.freeOnly===true;cancelCatalog();draft.catalog=null;draft.selection.setPage([]);paintEditor();});
  f.protocol.addEventListener('change',()=>{if(busy)return;const draft=current();if(!draft)return;draft.type=f.protocol.value;if(getProviderPreset(draft.preset)?.type!==draft.type){draft.preset='compatible';f.preset.value='compatible';}cancelCatalog();feedback();controls();});
  f['catalog-search'].addEventListener('input',()=>{const draft=current();if(draft){draft.query=f['catalog-search'].value;filtersChanged();}});
  f['catalog-search'].addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();void catalog(0);}});
  f['catalog-sort'].addEventListener('change',()=>{const draft=current();if(draft){draft.sort=f['catalog-sort'].value;filtersChanged({immediate:true});}});
  f['catalog-min-context'].addEventListener('input',()=>{const draft=current();if(draft){draft.minContextTokens=f['catalog-min-context'].value;filtersChanged();}});
  for(const [id,key]of [['catalog-free','freeOnly'],['catalog-tools','toolsOnly'],['catalog-vision','visionOnly']])f[id].addEventListener('change',()=>{const draft=current();if(draft){draft[key]=f[id].checked;filtersChanged({immediate:true});}});
  f['catalog-clear'].addEventListener('click',()=>{const draft=current();if(!draft||busy)return;draft.query='';draft.sort='name';draft.freeOnly=Boolean(getProviderPreset(draft.preset)?.freeOnly);draft.toolsOnly=false;draft.visionOnly=false;draft.minContextTokens='';filtersChanged({immediate:true});paintEditor();});
  f['manage-models'].addEventListener('click',()=>void manageModels());f['limits-refresh'].addEventListener('click',()=>void catalog(0,{refresh:true}));f.hide.addEventListener('click',()=>{const draft=current();if(draft?.saved)void setProviderHidden(draft.id,!hiddenProviders().has(draft.id));});
  f['codex-hide'].addEventListener('click',()=>void setProviderHidden('codex',true));
  f['connection-details'].addEventListener('toggle',()=>{const draft=current();if(draft)draft.connectionDetailsOpen=f['connection-details'].open;});
  f['catalog-panel'].addEventListener('toggle',()=>{const draft=current();if(draft)draft.catalogOpen=f['catalog-panel'].open;});
  for(const scope of ['selected','catalog']){f[scope+'-expand'].addEventListener('click',()=>expandGroups(scope,true));f[scope+'-collapse'].addEventListener('click',()=>expandGroups(scope,false));}
  f['add-model'].addEventListener('click',()=>{if(busy)return;const draft=current();if(!draft)return;try{if(!modelId(draft.manual))throw Error('Enter an exact model ID, up to 256 characters.');draft.selection.addManual(draft.manual);draft.manual='';f['manual-model'].value='';draft.error='';draft.receipt='Model ID added. Save selected models to look up its limits.';}catch(error){draft.error=safeError(error);}paintModels();feedback();controls();});
  f.new.addEventListener('click',()=>{if(busy)return;cancelCatalog();if(!drafts.has(NEW_DRAFT))drafts.set(NEW_DRAFT,makeDraft());selected=NEW_DRAFT;paintList();paintEditor();});
  f.discard.addEventListener('click',()=>void reloadSaved());
  f.save.addEventListener('click',()=>void mutate('save'));f.delete.addEventListener('click',()=>void mutate('delete'));f.test.addEventListener('click',()=>void mutate('test'));
  f['catalog-load'].addEventListener('click',()=>void catalog(0));f['catalog-prev'].addEventListener('click',()=>void catalog(Math.max(0,(current()?.catalog?.offset||0)-PAGE)));f['catalog-next'].addEventListener('click',()=>void catalog((current()?.catalog?.offset||0)+PAGE));
  f.filter.addEventListener('input',()=>{listLimit=LIST_PAGE;paintList();});f.more.addEventListener('click',()=>{listLimit+=LIST_PAGE;paintList();});f.refresh.addEventListener('click',()=>void load());
  f['codex-add'].addEventListener('click',()=>void codexAction('POST'));f['codex-check'].addEventListener('click',()=>void codexAction('check'));f['codex-read'].addEventListener('click',()=>void readCodex());
  f['codex-id'].addEventListener('keydown',event=>{if(event.key==='Enter')event.preventDefault();});f['codex-filter'].addEventListener('input',()=>{codexLimit=LIST_PAGE;paintCodex();});f['codex-more'].addEventListener('click',()=>{codexLimit+=LIST_PAGE;paintCodex();});
  const onEvent=event=>{if(!active||destroyed||!['runtime.status','provider.updated'].includes(event.type))return;
    const latest=event.data?.providers;if(Array.isArray(latest)&&JSON.stringify(latest)===JSON.stringify(providers))return;
    stale=true;if(busy)return;
    if(Array.isArray(latest)){listSequence++;listAbort?.abort();listAbort=null;listBusy=false;applyProviders(latest);}
    else if(!listBusy)void load();
  };
  return {
    updateRuntimeSettings(value){if(destroyed||!value||typeof value!=='object')return;runtimeSettings=copy(value);if(active)paintList();},
    enter(){if(destroyed||active)return;runtimeSettings=copy(getRuntimeSettings()||runtimeSettings);active=true;unsubscribe=events?.subscribe?.(onEvent)||null;paintList();paintEditor();paintCodex();if(!loaded||stale)void load();},
    leave(){active=false;unsubscribe?.();unsubscribe=null;stale=true;listSequence++;listAbort?.abort();listAbort=null;listBusy=false;cancelCatalog();if(codexBusy)status(f['codex-status'],'Status read paused. Refresh model list and limits to load the current result.');codexSequence++;codexAbort?.abort();codexAbort=null;codexBusy=false;},
    destroy(){this.leave();destroyed=true;for(const draft of drafts.values()){draft.key='';draft.headers='';}drafts.clear();f.key.value='';f.headers.value='';mount.replaceChildren();},
  };
}
