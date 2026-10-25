import {text} from '../core/dom.mjs';
import {PROVIDER_PRESETS,getProviderPreset,isOpenRouterProvider} from '../../provider-catalog.mjs';
import {createProviderModelSelection,providerHeadersForSave,codexModelAccessLabel,codexModelSourceLabel} from '../../connection-models.mjs';

const PAGE=80,LIST_PAGE=40,NEW_DRAFT='__new_provider_draft__';
const copy=value=>structuredClone(value);
const presetFor=value=>getProviderPreset(value?.preset)||
  (isOpenRouterProvider(value)?getProviderPreset('openrouter'):null)||
  PROVIDER_PRESETS.find(item=>item.baseUrl&&item.baseUrl===value?.baseUrl)||getProviderPreset('compatible');
const capacityLines=models=>models.filter(model=>model.contextWindowTokens).map(model=>`${model.id} = ${model.contextWindowTokens}`).join('\n');
const newId=()=>`api_${globalThis.crypto?.randomUUID?.().replaceAll('-','').slice(0,12)||Math.random().toString(36).slice(2,14)}`;
const modelId=value=>typeof value==='string'&&value.trim()&&value.length<=256&&!/[\r\n\x00]/.test(value)&&!value.includes('::');
const nativeId=value=>typeof value==='string'&&value.length>0&&value.length<=400&&!/[\x00-\x20\x7f]/.test(value)&&!['codex','default'].includes(value)&&!value.includes('::');

/** Drafts and credentials live only in this component's memory. Reads never save. */
export function createProviderSettings({mount,api,events,notify=()=>{},onChanged=()=>{}}) {
  mount.innerHTML=`<section id="next-provider-root" class="next-providers" aria-label="Model connections">
    <header class="next-provider-heading"><div><h2>API connections</h2><p class="next-help">Choose the models available to your agents.</p></div><div class="next-row"><button type="button" id="next-provider-refresh">Refresh connections</button><button type="button" id="next-provider-new">Add connection</button></div></header>
    <p id="next-provider-info" role="status" aria-live="polite"></p>
    <div class="next-provider-layout"><aside aria-label="Saved API connections"><label class="next-label">Find a connection<input id="next-provider-filter" class="next-field" type="search" maxlength="100"></label><ul id="next-provider-list" class="next-provider-list"></ul><button type="button" id="next-provider-more" hidden>Show more connections</button></aside>
    <section id="next-provider-editor" class="next-card" aria-label="Connection editor"><p id="next-provider-empty" class="next-help">Choose a connection or add one.</p>
    <form id="next-provider-form" class="next-stack" hidden autocomplete="off">
      <h3 id="next-provider-title">Connection</h3><p id="next-provider-stale" class="next-help" hidden>Saved settings changed. Your draft is kept; Reload saved settings replaces it.</p>
      <div class="next-provider-fields"><label class="next-label">Preset<select id="next-provider-preset" class="next-field"></select></label><label class="next-label">API protocol<select id="next-provider-protocol" class="next-field"><option value="compatible">OpenAI compatible</option><option value="openai">OpenAI</option><option value="anthropic">Anthropic</option></select></label><label class="next-label">Connection name<input id="next-provider-name" class="next-field" maxlength="100" required></label><label class="next-label">Connection ID<input id="next-provider-id" class="next-field" maxlength="40" spellcheck="false" required></label></div>
      <label class="next-label">API address<input id="next-provider-base-url" class="next-field" type="url" spellcheck="false" required></label>
      <label class="next-label">API key<input id="next-provider-key" class="next-field" type="password" autocomplete="new-password" maxlength="20000" aria-describedby="next-provider-key-note"></label><p id="next-provider-key-note" class="next-help"></p><label class="next-row"><input id="next-provider-clear-key" type="checkbox">Remove saved API key</label>
      <details class="next-provider-advanced"><summary>Request headers and limits</summary><div class="next-stack"><p id="next-provider-header-note" class="next-help"></p><label class="next-label">Replacement request headers<textarea id="next-provider-headers" class="next-field" rows="3" spellcheck="false" autocomplete="off" placeholder="Header-Name: value"></textarea></label><p class="next-help">Blank keeps saved headers. Replacement headers replace the whole saved set.</p><label class="next-row"><input id="next-provider-clear-headers" type="checkbox">Remove saved headers</label><div class="next-provider-fields"><label class="next-label">Maximum output tokens<input id="next-provider-max-tokens" class="next-field" type="number" min="1" max="128000" step="1"></label><label class="next-label">Maximum tool steps<input id="next-provider-max-steps" class="next-field" type="number" min="1" step="1" placeholder="No application limit"></label></div><label class="next-label">Model context capacities<textarea id="next-provider-capacities" class="next-field" rows="3" placeholder="model-id = 900000" spellcheck="false"></textarea></label><p class="next-help">Unlisted capacities are preserved. Use model-id = unknown to clear one.</p></div></details>
      <label class="next-row"><input id="next-provider-enabled" type="checkbox">Use this connection</label>
      <section aria-label="Selected models"><h3>Selected models <span id="next-provider-model-count" class="next-help"></span></h3><div id="next-provider-models" class="next-provider-models"></div><div class="next-provider-inline"><label class="next-label">Exact model ID<input id="next-provider-manual-model" class="next-field" maxlength="256" spellcheck="false"></label><button type="button" id="next-provider-add-model">Add model ID</button></div></section>
      <section aria-label="Provider model catalog"><h3>Find models</h3><p class="next-help">Catalog searches and Test use saved settings. Save address or credential changes first.</p><div class="next-provider-inline"><label class="next-label">Search catalog<input id="next-provider-catalog-search" class="next-field" type="search" maxlength="256" placeholder="Name or exact ID"></label><button type="button" id="next-provider-catalog-load">Search saved connection</button></div><div id="next-provider-catalog" class="next-provider-models"></div><div class="next-row"><button type="button" id="next-provider-catalog-prev">Previous</button><span id="next-provider-catalog-page" class="next-help"></span><button type="button" id="next-provider-catalog-next">Next</button></div></section>
      <p id="next-provider-receipt" role="status" aria-live="polite"></p><p id="next-provider-error" role="alert"></p>
      <footer class="next-row"><button type="button" id="next-provider-save" class="next-primary">Save connection</button><button type="button" id="next-provider-test">Test saved connection</button><button type="button" id="next-provider-discard">Reload saved settings</button><button type="button" id="next-provider-delete">Remove connection</button></footer>
    </form></section></div>
    <details id="next-provider-codex" class="next-card next-provider-codex"><summary>Codex model IDs and checks</summary><p class="next-help">Add an exact native Codex model ID, including one absent from the catalog. Codex decides whether it can serve each request.</p><div class="next-provider-inline"><label class="next-label">Exact Codex model ID<input id="next-provider-codex-id" class="next-field" maxlength="400" spellcheck="false" autocomplete="off"></label><button type="button" id="next-provider-codex-add">Add model ID</button><button type="button" id="next-provider-codex-check">Try model</button></div><p class="next-help">Try model sends one short text request and may use your account’s quota. It has a 45-second deadline. Its result describes that request and account.</p><div class="next-provider-inline"><label class="next-label">Find Codex models<input id="next-provider-codex-filter" class="next-field" type="search" maxlength="200"></label><button type="button" id="next-provider-codex-read">Read model and check status</button></div><p id="next-provider-codex-status" class="next-help" role="status" aria-live="polite">Read status to load the native model catalog.</p><p id="next-provider-codex-error" role="alert"></p><ul id="next-provider-codex-list" class="next-provider-list"></ul><button type="button" id="next-provider-codex-more" hidden>Show more models</button></details>
  </section>`;
  const $=id=>mount.querySelector('#next-provider-'+id);
  const f=Object.fromEntries(['root','refresh','new','info','filter','list','more','editor','empty','form','title','stale','preset','protocol','name','id','base-url','key','key-note','clear-key','header-note','headers','clear-headers','max-tokens','max-steps','capacities','enabled','models','model-count','manual-model','add-model','catalog-search','catalog-load','catalog','catalog-prev','catalog-next','catalog-page','receipt','error','save','test','discard','delete','codex','codex-id','codex-add','codex-check','codex-filter','codex-read','codex-status','codex-error','codex-list','codex-more'].map(id=>[id,$(id)]));
  const drafts=new Map();
  let active=false,destroyed=false,selected=null,providers=[],listLimit=LIST_PAGE,listBusy=false,listSequence=0,listAbort,unsubscribe=null;
  let busy=false,catalogBusy=false,catalogSequence=0,catalogAbort,loaded=false,stale=false,codex=null,codexLimit=LIST_PAGE,codexSequence=0,codexAbort,codexBusy=false,uncertainCheck=false;
  const current=()=>drafts.get(selected);
  const add=(parent,tag,value='',className='')=>text(parent,value,tag,className);
  const path=id=>'/api/providers/'+encodeURIComponent(id);
  const safeError=error=>{
    let message=String(error?.message||error||'This action could not complete.');
    for(const draft of drafts.values())for(const secret of [draft.key,...String(draft.headers||'').split('\n').map(line=>line.slice(line.indexOf(':')+1).trim())])if(secret)message=message.replaceAll(secret,'[redacted]');
    return message;
  };
  const status=(node,message,error=false)=>{node.textContent=message;node.dataset.error=String(error);};
  const settings=draft=>({preset:draft.preset,type:draft.type,name:draft.name.trim(),id:draft.id,baseUrl:draft.baseUrl.trim(),enabled:draft.enabled,maxTokens:draft.maxTokens,maxSteps:draft.maxSteps});
  const settingsChanged=draft=>!draft?.saved||Boolean(draft.key||draft.clearKey||draft.headers.trim()||draft.clearHeaders)||JSON.stringify(settings(draft))!==draft.baseline;
  const changed=draft=>settingsChanged(draft)||draft.capacities!==draft.originalCapacities||JSON.stringify(draft.selection.forSave())!==draft.originalModels;
  function makeDraft(provider){
    const value=provider||{id:newId(),name:'OpenRouter',preset:'openrouter',type:'compatible',baseUrl:getProviderPreset('openrouter').baseUrl,models:[],enabled:true,maxTokens:8192,maxSteps:null};
    const selection=createProviderModelSelection(value.models||[]),capacities=capacityLines(selection.selected());
    const draft={saved:provider?copy(provider):null,id:value.id,name:value.name,preset:presetFor(value).id,type:value.type,baseUrl:value.baseUrl,
      enabled:value.enabled!==false,maxTokens:String(value.maxTokens??8192),maxSteps:value.maxSteps==null?'':String(value.maxSteps),key:'',headers:'',clearKey:false,clearHeaders:false,
      selection,capacities,originalCapacities:capacities,originalModels:JSON.stringify(selection.forSave()),catalog:null,query:'',manual:'',receipt:'',error:''};
    draft.baseline=JSON.stringify(settings(draft));return draft;
  }
  function notifyChanged(){try{Promise.resolve(onChanged()).catch(()=>{if(active)status(f.info,'Saved. Model choices could not refresh; use Refresh connections.',true);});}catch{if(active)status(f.info,'Saved. Model choices could not refresh; use Refresh connections.',true);}}
  function controls(){
    const draft=current();
    for(const control of f.form.querySelectorAll('input,select,textarea,button'))control.disabled=busy;
    f.new.disabled=busy;f.refresh.disabled=busy||listBusy;f.filter.disabled=busy;f.more.disabled=busy;
    for(const button of f.list.querySelectorAll('button'))button.disabled=busy;
    if(draft){
      f.id.disabled=busy||Boolean(draft.saved);f.save.disabled=busy||!changed(draft);
      f.test.disabled=busy||!draft.saved||changed(draft);f.delete.disabled=busy||!draft.saved;
      f.discard.disabled=busy;f.delete.hidden=!draft.saved;
      const canCatalog=Boolean(draft.saved)&&!settingsChanged(draft)&&!busy&&!catalogBusy;
      f['catalog-load'].disabled=!canCatalog;f['catalog-prev'].disabled=!canCatalog||!draft.catalog?.offset;
      f['catalog-next'].disabled=!canCatalog||!draft.catalog?.hasMore;
      f.catalog.setAttribute('aria-busy',String(catalogBusy));
    }
    for(const control of [f['codex-id'],f['codex-add'],f['codex-read'],f['codex-more']])control.disabled=busy||codexBusy;
    f['codex-check'].disabled=busy||codexBusy||uncertainCheck||!codex?.connected||!codex?.authenticated||codex?.modelCheckBlocked===true||codex?.modelCheck?.status==='checking';
    for(const button of f['codex-list'].querySelectorAll('button'))button.disabled=busy||codexBusy;
    f.root.setAttribute('aria-busy',String(busy));
  }
  function paintList(){
    f.list.replaceChildren();const query=f.filter.value.trim().toLowerCase();
    const matching=providers.filter(item=>`${item.name} ${item.id} ${item.type}`.toLowerCase().includes(query));
    for(const provider of matching.slice(0,listLimit)){
      const row=add(f.list,'li'),button=add(row,'button','', 'next-provider-list-item');button.type='button';button.dataset.providerId=provider.id;
      button.setAttribute('aria-pressed',String(selected===provider.id));add(button,'strong',provider.name);add(button,'span',provider.id,'next-help');
      add(button,'span',provider.enabled===false?'Disabled':provider.configured?'Enabled · configured':'Enabled · needs credentials','next-status-pill');
      add(button,'span',`${provider.models?.length||0} selected models`,'next-help');
      button.addEventListener('click',()=>{if(!busy)select(provider.id);});
    }
    if(!matching.length)add(f.list,'li',query?'No matching connections.':'No API connections saved.','next-help');
    f.more.hidden=matching.length<=listLimit;controls();
  }
  function modelRow(parent,model,chosen){
    const label=add(parent,'label','', 'next-provider-model');
    const input=add(label,'input');input.type='checkbox';input.checked=chosen;input.dataset.providerModelId=model.id;
    const body=add(label,'span');add(body,'strong',model.displayName||model.id);add(body,'small',model.id);
    const details=[model.contextWindowTokens?`${model.contextWindowTokens.toLocaleString()} context tokens`:'Context capacity not reported',
      model.supportsTools===false?'Provider reports no tools':model.supportsTools===true?'Provider reports tools':''];
    add(body,'small',details.filter(Boolean).join(' · '));
    input.addEventListener('change',()=>{
      if(busy)return;const draft=current();try{draft.selection.toggle(model.id,input.checked);draft.error='';}catch(error){draft.error=safeError(error);}
      paintModels();feedback();controls();
    });
  }
  function paintModels(){
    const draft=current();if(!draft)return;
    f.models.replaceChildren();f.catalog.replaceChildren();const chosen=draft.selection.selected(),ids=new Set(chosen.map(item=>item.id));
    f['model-count'].textContent=`${chosen.length} / 200`;
    for(const model of chosen)modelRow(f.models,model,true);
    if(!chosen.length)add(f.models,'p','No models selected. Add an exact ID or search the saved connection.','next-help');
    for(const model of draft.selection.page().filter(item=>!ids.has(item.id)))modelRow(f.catalog,model,false);
    if(!draft.selection.page().some(item=>!ids.has(item.id)))add(f.catalog,'p',draft.catalog?'No other models on this page.':'Search to load a page of models.','next-help');
    const page=draft.catalog;
    f['catalog-page'].textContent=page?`${page.total?`${page.offset+1}–${page.offset+page.returned} of ${page.total}`:'No matches'} · selections kept across pages`:'';
  }
  function feedback(){const draft=current();if(!draft)return;status(f.receipt,draft.receipt);status(f.error,draft.error,true);}
  function savedNotes(){
    const draft=current();if(!draft)return;const saved=draft.saved;
    f['key-note'].textContent=saved?.hasApiKey?'API key saved. Leave blank to keep it.':'Leave blank to keep any saved key. Some local servers do not require one.';
    f.key.placeholder=saved?.hasApiKey?'Saved · leave blank to keep':'API key';
    f['header-note'].textContent=saved?.hasHeaders?`Saved header names: ${(saved.headerNames||[]).join(', ')}. Values stay hidden.`:'No saved request headers.';
    const latest=providers.find(item=>item.id===draft.id);
    f.stale.hidden=!saved||Boolean(latest&&JSON.stringify(latest)===JSON.stringify(saved));
    f.discard.textContent=saved?'Reload saved settings':'Reset new connection';
  }
  function paintEditor(){
    const draft=current();f.form.hidden=!draft;f.empty.hidden=Boolean(draft);if(!draft){controls();return;}
    f.title.textContent=draft.saved?'Edit '+draft.saved.name:'New connection';
    for(const [field,key]of Object.entries({preset:'preset',protocol:'type',name:'name',id:'id','base-url':'baseUrl',key:'key',headers:'headers','max-tokens':'maxTokens','max-steps':'maxSteps',capacities:'capacities','catalog-search':'query','manual-model':'manual'}))f[field].value=draft[key];
    f.enabled.checked=draft.enabled;f['clear-key'].checked=draft.clearKey;f['clear-headers'].checked=draft.clearHeaders;
    savedNotes();paintModels();feedback();controls();
  }
  function select(id){
    if(busy||destroyed)return;cancelCatalog();
    if(!drafts.has(id)){const value=providers.find(item=>item.id===id);if(!value)return;drafts.set(id,makeDraft(value));}
    selected=id;paintList();paintEditor();
  }
  function cancelCatalog(){
    if(catalogBusy&&current()?.receipt==='Loading model catalog…')current().receipt='Catalog search paused. Search again to load models; selected IDs are kept.';
    catalogSequence++;catalogAbort?.abort();catalogAbort=null;catalogBusy=false;
  }
  async function load(){
    if(!active||destroyed||listBusy||busy)return;listBusy=true;const token=++listSequence,controller=new AbortController();listAbort=controller;
    status(f.info,'Loading connections…');controls();
    try{const result=await api('/api/providers','GET',undefined,{signal:controller.signal});
      if(!active||destroyed||token!==listSequence)return;providers=Array.isArray(result)?result:[];loaded=true;stale=false;
      status(f.info,`${providers.length} saved connection${providers.length===1?'':'s'}.`);paintList();savedNotes();
    }catch(error){if(active&&!destroyed&&token===listSequence)status(f.info,safeError(error),true);}
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
    return {id,preset:draft.preset,type:draft.type,name,baseUrl,models,enabled:draft.enabled,maxTokens,maxSteps,
      ...(key||draft.clearKey?{apiKey:draft.clearKey?'':key}:{}),...(headers===undefined?{}:{headers})};
  }
  async function mutate(action){
    const draft=current();if(!active||destroyed||busy||!draft)return;
    let value;try{if(action==='save')value=payload(draft);else if(!draft.saved)return;else if(action==='test'&&changed(draft))throw Error('Save your changes before testing the connection.');}
    catch(error){draft.error=safeError(error);feedback();return;}
    busy=true;cancelCatalog();listSequence++;listAbort?.abort();listBusy=false;draft.error='';draft.receipt=action==='delete'?'Removing connection…':action==='test'?'Testing saved connection…':'Saving connection…';feedback();controls();
    try{
      if(action==='save'){
        const saved=await api('/api/providers','POST',value);if(destroyed)return;
        const oldKey=selected,next=makeDraft(saved);next.receipt='Connection saved. Selected models are available when this connection is configured and enabled.';
        drafts.delete(oldKey);draft.key='';draft.headers='';drafts.set(saved.id,next);selected=saved.id;
        providers=providers.filter(item=>item.id!==saved.id);providers.push(copy(saved));notifyChanged();notify('Connection saved.');
      }else if(action==='delete'){
        await api(path(draft.saved.id),'DELETE',{});if(destroyed)return;
        providers=providers.filter(item=>item.id!==draft.saved.id);drafts.delete(selected);draft.key='';draft.headers='';selected=null;notifyChanged();notify('Connection removed.');
      }else{
        const result=await api(path(draft.saved.id)+'/test','POST',{});if(destroyed)return;
        draft.receipt=result.credentialVerified===true?'API key verified; catalog reachable. Model access was not tested.':'Catalog reachable. API key and model access were not verified.';
      }
    }catch(error){if(!destroyed){draft.error=safeError(error);draft.receipt=action==='test'?'Test did not complete. No model access was verified.':'The action did not complete successfully. Your draft is kept. Refresh connections to inspect saved state before retrying.';}}
    finally{busy=false;if(active&&!destroyed){paintList();paintEditor();}}
  }
  async function catalog(offset=0){
    const draft=current();if(!active||destroyed||busy||catalogBusy||!draft?.saved||settingsChanged(draft))return;
    const key=selected,query=draft.query.trim(),token=++catalogSequence,controller=new AbortController();catalogAbort=controller;catalogBusy=true;draft.error='';draft.receipt='Loading model catalog…';feedback();controls();
    try{const result=await api(path(draft.saved.id)+'/models','POST',{query,offset,limit:PAGE},{signal:controller.signal});
      if(!active||destroyed||token!==catalogSequence||key!==selected||query!==draft.query.trim())return;
      const page=(result.models||[]).slice(0,PAGE);draft.selection.setPage(page);draft.catalog={offset:result.offset??offset,total:result.total??page.length,returned:page.length,hasMore:result.hasMore===true};
      draft.receipt='Catalog loaded. Selected models are kept across searches and pages; Save connection applies your selection.';paintModels();feedback();
    }catch(error){if(active&&!destroyed&&token===catalogSequence&&key===selected){draft.error=safeError(error);draft.receipt='Catalog unavailable. Your selected models are kept.';feedback();}}
    finally{if(token===catalogSequence){catalogBusy=false;catalogAbort=null;if(active&&!destroyed)controls();}}
  }
  function checkReceipt(result){
    if(!result)return 'No model check recorded.';
    if(result.status==='checking')return `Checking ${result.model}… Read status for the saved result.`;
    const outcome=result.status==='accepted'?'Request completed':result.status==='interrupted'?'Request interrupted':'Request failed';
    return `${result.requestedModel||result.model||'Model'}: ${outcome}${result.checkedAt?' · '+result.checkedAt:''}. ${result.scope==='current-connection'?'Current account and connection.':'Earlier account or connection; this does not verify the current connection.'}${result.error?.message?' '+safeError(result.error):''} Future requests can have a different result.`;
  }
  function paintCodex(){
    f['codex-list'].replaceChildren();if(!codex){controls();return;}
    const query=f['codex-filter'].value.trim().toLowerCase(),matches=(codex.models||[]).filter(model=>`${model.id} ${model.model} ${model.displayName}`.toLowerCase().includes(query));
    for(const model of matches.slice(0,codexLimit)){
      const id=model.model||model.id,row=add(f['codex-list'],'li','', 'next-provider-codex-row'),body=add(row,'div');
      add(body,'strong',model.displayName||id);add(body,'small',id);add(body,'small',[codexModelSourceLabel(model),codexModelAccessLabel(model)].filter(Boolean).join(' · '));
      if((codex.customModels||[]).includes(id)){const button=add(row,'button','Remove saved ID');button.type='button';button.dataset.codexRemove=id;button.addEventListener('click',()=>void codexAction('DELETE',id));}
    }
    if(!matches.length)add(f['codex-list'],'li','No matching native models.','next-help');
    f['codex-more'].hidden=matches.length<=codexLimit;
    controls();
  }
  async function readCodex(){
    if(!active||destroyed||codexBusy||busy)return;const token=++codexSequence,controller=new AbortController();codexAbort=controller;codexBusy=true;
    status(f['codex-error'],'');status(f['codex-status'],'Reading native model and check status…');controls();
    try{const result=await api('/api/codex/models','GET',undefined,{signal:controller.signal});
      if(!active||destroyed||token!==codexSequence)return;codex=result;uncertainCheck=false;
      status(f['codex-status'],`${result.connected&&result.authenticated?'Codex connected.':'Connect and sign in to Codex to try a model.'} ${checkReceipt(result.modelCheck)}${result.modelCheckBlocked?' Previous check cleanup is unresolved; restart BLACKICE before trying another model.':''}`);paintCodex();
    }catch(error){if(active&&!destroyed&&token===codexSequence)status(f['codex-error'],safeError(error),true);}
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
      status(f['codex-status'],action==='check'?checkReceipt(result.result):action==='DELETE'?'Saved ID removed. Advertised models remain listed.':'Model ID saved. Choose it for a task or as the default model.');notifyChanged();
    }catch(error){if(!destroyed){if(action==='check')uncertainCheck=!error.status;status(f['codex-error'],safeError(error),true);status(f['codex-status'],action==='check'?'Check result unavailable. Read model and check status before trying again.':'The action did not complete successfully. Read status to inspect the saved IDs before retrying.');}}
    finally{busy=false;if(active&&!destroyed){paintCodex();controls();}}
  }
  for(const preset of PROVIDER_PRESETS){const option=add(f.preset,'option',preset.name);option.value=preset.id;}
  f.form.addEventListener('submit',event=>event.preventDefault());
  f.form.addEventListener('keydown',event=>{if(event.key==='Enter'&&event.target.tagName==='INPUT'&&event.target.type!=='checkbox')event.preventDefault();});
  for(const [field,key]of Object.entries({name:'name',id:'id','base-url':'baseUrl',key:'key',headers:'headers','max-tokens':'maxTokens','max-steps':'maxSteps',capacities:'capacities','manual-model':'manual'}))f[field].addEventListener('input',()=>{if(busy)return;const draft=current();if(draft){draft[key]=f[field].value;if(!['capacities','manual'].includes(key))cancelCatalog();feedback();controls();}});
  for(const [field,key]of Object.entries({enabled:'enabled','clear-key':'clearKey','clear-headers':'clearHeaders'}))f[field].addEventListener('change',()=>{if(busy)return;const draft=current();if(draft){draft[key]=f[field].checked;cancelCatalog();feedback();controls();}});
  f.preset.addEventListener('change',()=>{if(busy)return;const draft=current(),preset=getProviderPreset(f.preset.value);if(!draft||!preset)return;const previous=getProviderPreset(draft.preset);if(draft.name===previous?.name)draft.name=preset.name;draft.preset=preset.id;draft.type=preset.type;draft.baseUrl=preset.baseUrl;cancelCatalog();draft.catalog=null;draft.selection.setPage([]);paintEditor();});
  f.protocol.addEventListener('change',()=>{if(busy)return;const draft=current();if(!draft)return;draft.type=f.protocol.value;if(getProviderPreset(draft.preset)?.type!==draft.type){draft.preset='compatible';f.preset.value='compatible';}cancelCatalog();feedback();controls();});
  f['catalog-search'].addEventListener('input',()=>{const draft=current();if(draft){draft.query=f['catalog-search'].value;cancelCatalog();feedback();controls();}});
  f['add-model'].addEventListener('click',()=>{if(busy)return;const draft=current();if(!draft)return;try{if(!modelId(draft.manual))throw Error('Enter an exact model ID, up to 256 characters.');draft.selection.addManual(draft.manual);draft.manual='';f['manual-model'].value='';draft.error='';}catch(error){draft.error=safeError(error);}paintModels();feedback();controls();});
  f.new.addEventListener('click',()=>{if(busy)return;cancelCatalog();if(!drafts.has(NEW_DRAFT))drafts.set(NEW_DRAFT,makeDraft());selected=NEW_DRAFT;paintList();paintEditor();});
  f.discard.addEventListener('click',()=>{if(busy)return;const draft=current();if(!draft)return;const saved=draft.saved&&providers.find(item=>item.id===draft.saved.id);draft.key='';draft.headers='';drafts.set(selected,makeDraft(saved));cancelCatalog();paintEditor();});
  f.save.addEventListener('click',()=>void mutate('save'));f.delete.addEventListener('click',()=>void mutate('delete'));f.test.addEventListener('click',()=>void mutate('test'));
  f['catalog-load'].addEventListener('click',()=>void catalog(0));f['catalog-prev'].addEventListener('click',()=>void catalog(Math.max(0,(current()?.catalog?.offset||0)-PAGE)));f['catalog-next'].addEventListener('click',()=>void catalog((current()?.catalog?.offset||0)+PAGE));
  f.filter.addEventListener('input',()=>{listLimit=LIST_PAGE;paintList();});f.more.addEventListener('click',()=>{listLimit+=LIST_PAGE;paintList();});f.refresh.addEventListener('click',()=>void load());
  f['codex-add'].addEventListener('click',()=>void codexAction('POST'));f['codex-check'].addEventListener('click',()=>void codexAction('check'));f['codex-read'].addEventListener('click',()=>void readCodex());
  f['codex-id'].addEventListener('keydown',event=>{if(event.key==='Enter')event.preventDefault();});f['codex-filter'].addEventListener('input',()=>{codexLimit=LIST_PAGE;paintCodex();});f['codex-more'].addEventListener('click',()=>{codexLimit+=LIST_PAGE;paintCodex();});
  const onEvent=event=>{if(event.type==='runtime.status'||event.type==='provider.updated'){stale=true;if(active&&!busy&&!listBusy)status(f.info,'Connections may have changed. Refresh connections to load saved settings. Drafts are kept.');}};
  return {
    enter(){if(destroyed||active)return;active=true;unsubscribe=events?.subscribe?.(onEvent)||null;paintList();paintEditor();paintCodex();if(!loaded||stale)void load();},
    leave(){active=false;unsubscribe?.();unsubscribe=null;stale=true;listSequence++;listAbort?.abort();listAbort=null;listBusy=false;cancelCatalog();if(codexBusy)status(f['codex-status'],'Status read paused. Read model and check status to load the current result.');codexSequence++;codexAbort?.abort();codexAbort=null;codexBusy=false;},
    destroy(){this.leave();destroyed=true;for(const draft of drafts.values()){draft.key='';draft.headers='';}drafts.clear();f.key.value='';f.headers.value='';mount.replaceChildren();},
  };
}
