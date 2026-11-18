import { createLocalModelSettings } from './settings-local-models.mjs';

/** Native account settings stay separate from optional API connections. */
export function createSubscriptionModelSettings(props, createProvider) {
  const {mount,api}=props,doc=mount.ownerDocument;
  const element=(tag,cls,value='')=>{
    const node=doc.createElement(tag);
    if(cls)node.className=cls;
    node.textContent=value;
    return node;
  };
  const button=(id,label)=>{
    const node=element('button','',label);node.id=id;node.setAttribute('type','button');return node;
  };
  const header=element('section','next-card');
  header.append(
    element('h2','','Codex models & account'),
    element('p','next-help','Use your Codex account for native Codex models. Existing conversations retain the model and provider that originally created them.')
  );
  const list=element('div','next-stack');
  list.setAttribute('aria-label','Codex account status');
  const feedback=element('p','next-help','Checking Codex connection…');
  feedback.setAttribute('role','status');
  list.append(feedback);
  header.append(list);

  const native=element('details','next-card next-stack');
  native.id='next-mistral-vibe';native.dataset.nativeProvider='mistral-vibe';native.setAttribute('tabindex','-1');
  const nativeTitle=element('summary','','Optional Mistral account');nativeTitle.id='next-mistral-vibe-title';
  native.setAttribute('aria-labelledby',nativeTitle.id);
  native.append(nativeTitle,element('p','next-help','Connect through Mistral Vibe Code if you use it. Installation, sign-in and a compatible model are required. This is separate from Mistral API keys.'));
  const nativeStatus=element('p','next-help','Checking Mistral Vibe Code…');nativeStatus.id='next-mistral-vibe-status';nativeStatus.setAttribute('role','status');nativeStatus.setAttribute('aria-live','polite');
  const nativeVersion=element('p','next-help');nativeVersion.id='next-mistral-vibe-version';
  const nativeActions=element('div','next-row'),nativeLogin=button('next-mistral-vibe-login','Sign in to Mistral Vibe Code'),nativeRefresh=button('next-mistral-vibe-refresh','Refresh connection and models');
  nativeActions.append(nativeLogin,nativeRefresh);
  const nativeError=element('p','next-help');nativeError.id='next-mistral-vibe-error';nativeError.setAttribute('role','alert');
  const catalogNotice=element('p','next-help');catalogNotice.id='next-mistral-vibe-catalog-notice';catalogNotice.setAttribute('role','status');
  const catalog=element('details'),catalogTitle=element('summary','','Models reported by Vibe Code'),catalogModels=element('ul','next-stack');
  catalog.id='next-mistral-vibe-catalog';catalogModels.id='next-mistral-vibe-models';catalog.append(catalogTitle,catalogModels);
  native.append(nativeStatus,nativeVersion,nativeActions,nativeError,catalogNotice,catalog,
    element('p','next-help','Sign-in opens in BLACKICE’s browser. After signing in, refresh the connection to load its model catalog, then choose a model in Chat or General settings.'));

  const advanced=element('section','next-card');
  advanced.id='next-connect-another-endpoint';
  advanced.setAttribute('aria-label','API connections');
  const providerMount=element('div');
  advanced.append(providerMount);
  const localMount=element('div');
  const tabs=element('nav','next-settings-sections');tabs.setAttribute('role','tablist');tabs.setAttribute('aria-label','Model configuration');
  const modelPanels=new Map(),tabButtons=new Map();let modelSection='accounts';
  for(const [id,title]of [['accounts','Accounts'],['local','Local models'],['catalog','Catalog'],['api','Add API']]){const tab=button('next-models-tab-'+id,title);tab.setAttribute('role','tab');tab.setAttribute('aria-controls','next-models-panel-'+id);const panel=element('div','');panel.id='next-models-panel-'+id;panel.setAttribute('role','tabpanel');panel.setAttribute('aria-labelledby',tab.id);modelPanels.set(id,panel);tabButtons.set(id,tab);tabs.append(tab);}
  modelPanels.get('accounts').append(header,native);modelPanels.get('local').append(localMount);modelPanels.get('api').append(advanced);mount.append(tabs,...modelPanels.values());
  const local=createLocalModelSettings({mount:localMount,api,onChanged:()=>props.onChanged?.()});
  const providers=createProvider({...props,mount:providerMount});
  const directory=providerMount.querySelector('#next-provider-directory-root');if(directory){modelPanels.get('catalog').append(directory);const disclosure=directory.querySelector('details');if(disclosure)disclosure.open=true;}
  modelPanels.get('catalog').addEventListener('click',event=>{if(event.target.closest?.('[data-directory-choose]'))selectModelSection('api');});
  function selectModelSection(id){if(!modelPanels.has(id)||destroyed)return;modelSection=id;for(const [key,panel]of modelPanels){panel.hidden=key!==id;const tab=tabButtons.get(key);tab.setAttribute('aria-selected',String(key===id));tab.tabIndex=key===id?0:-1;}if(!active)return;providers.setCodexActive?.(id==='accounts');if(id==='local')local.enter();else local.leave();if(['catalog','api'].includes(id)){if(!expanded){expanded=true;providers.enter?.();}}else if(expanded){expanded=false;providers.leave?.();}}
  for(const [id,tab]of tabButtons){tab.addEventListener('click',()=>selectModelSection(id));tab.addEventListener('keydown',event=>{const ids=[...tabButtons.keys()],i=ids.indexOf(id);let next;if(event.key==='ArrowRight')next=(i+1)%ids.length;else if(event.key==='ArrowLeft')next=(i+ids.length-1)%ids.length;else if(event.key==='Home')next=0;else if(event.key==='End')next=ids.length-1;else return;event.preventDefault();selectModelSection(ids[next]);tabButtons.get(ids[next]).focus();});}
  // Keep native Codex controls with its account, not among API connections.
  const codexControls=providerMount.querySelector('#next-provider-codex');
  if(codexControls)header.append(codexControls);
  let active=false,destroyed=false,revision=0,expanded=false,currentStatus=null,busy=null,operationError='';
  const provider=()=>currentStatus?.subscriptionProviders?.find(item=>item?.id==='mistral-vibe'&&item?.type==='subscription-cli');
  const modelId=model=>typeof model==='string'?model:typeof model?.id==='string'?model.id:typeof model?.modelId==='string'?model.modelId:typeof model?.model==='string'?model.model:'';
  const render=()=>{
    if(destroyed)return;
    const codex=currentStatus?.codex||currentStatus||{},ready=codex.connected===true&&codex.authenticated===true;
    feedback.textContent=currentStatus===null?'Checking Codex connection…':ready
      ?'Connected · ChatGPT/Codex subscription · choose a Codex model in General.'
      :codex.connected?'Codex CLI is connected but needs account authentication.'
      :'Codex is not connected. Sign in through the official Codex CLI, then reconnect.';
    const value=provider(),models=(Array.isArray(value?.models)?value.models:[]).filter(model=>modelId(model)),loginPending=['starting','waiting'].includes(value?.loginState);
    nativeLogin.textContent=value?.authenticated?'Sign in again':'Sign in to Mistral Vibe Code';
    nativeLogin.disabled=!active||Boolean(busy)||value?.installed!==true||loginPending;
    nativeRefresh.disabled=!active||Boolean(busy);
    nativeVersion.textContent=value?.cliVersion?'CLI version '+String(value.cliVersion).slice(0,80):'';
    nativeVersion.hidden=!value?.cliVersion;
    nativeStatus.textContent=busy==='login'?'Opening Mistral sign-in in BLACKICE’s browser…'
      :busy==='refresh'?'Refreshing Mistral Vibe Code and its model catalog…'
      :!value?(currentStatus===null?'Checking Mistral Vibe Code…':'Mistral Vibe Code status is unavailable. Refresh to check this runtime.')
      :value.installed!==true?'Mistral Vibe Code is not installed. Install the official CLI, then refresh.'
      :value.loginState==='starting'?'Opening Mistral sign-in in BLACKICE’s browser…'
      :value.loginState==='waiting'?'Complete sign-in in BLACKICE’s browser, then refresh this connection.'
      :value.authenticated!==true?'Sign in to your Mistral account to connect Mistral Vibe Code.'
      :value.available===true&&models.length?`Ready · ${models.length} model${models.length===1?'':'s'} reported by Vibe Code.`
      :value.connected!==true?'Signed in · the Mistral Vibe Code connection is not ready. Refresh to reconnect.'
      :'Signed in · no model catalog is available yet. Refresh to load it.';
    const problem=operationError||value?.lastError||'';nativeError.textContent=String(problem).slice(0,1200);nativeError.hidden=!problem;
    catalogNotice.textContent=String(value?.catalogNotice||'').slice(0,1600);catalogNotice.hidden=!value?.catalogNotice;
    while(catalogModels.children.length)catalogModels.children[0].remove();
    for(const model of models.slice(0,80)){
      const id=modelId(model),name=typeof model==='object'&&(model.displayName||model.name);
      catalogModels.append(element('li','',name&&name!==id?name+' · '+id:id));
    }
    if(models.length>80)catalogModels.append(element('li','next-help',`${models.length-80} more models are available in the model picker.`));
    catalog.hidden=!models.length;
  };
  const updateStatus=value=>{
    if(destroyed||!value||typeof value!=='object'||Array.isArray(value))return;
    revision++;currentStatus=value;
    if(provider()?.available===true)operationError='';
    render();
  };
  const load=async()=>{
    const token=++revision;
    try{
      const value=await api('/api/status');
      if(active&&!destroyed&&token===revision){currentStatus=value;operationError='';render();}
    }catch(error){
      if(active&&!destroyed&&token===revision){operationError=error?.message||'Account status is unavailable.';render();}
    }
  };
  const run=async action=>{
    const value=provider();
    if(!active||destroyed||busy||action==='login'&&(value?.installed!==true||['starting','waiting'].includes(value?.loginState)))return;
    const token=++revision;busy=action;operationError='';render();
    try{
      const result=await api('/api/subscriptions/mistral-vibe/'+action,'POST',{});
      if(active&&!destroyed&&token===revision){
        if(!result?.status||typeof result.status!=='object'||Array.isArray(result.status))throw Error('Mistral Vibe Code did not return its connection status.');
        updateStatus(result.status);props.onStatus?.(result.status);
      }
    }catch(error){
      if(active&&!destroyed&&token===revision)operationError=error?.message||'Mistral Vibe Code could not complete this action.';
    }finally{busy=null;if(active&&!destroyed)render();}
  };
  nativeLogin.addEventListener('click',()=>run('login'));
  nativeRefresh.addEventListener('click',()=>run('refresh'));
  render();selectModelSection(modelSection);
  return {
    enter(){if(destroyed||active)return;active=true;selectModelSection(modelSection);render();void load();},
    leave(){active=false;providers.setCodexActive?.(false);revision++;local.leave();render();if(expanded){providers.leave?.();expanded=false;}},
    updateStatus,
    focusProvider(id){if(id==='mistral-vibe'&&!destroyed&&active){selectModelSection('accounts');native.open=true;native.focus({preventScroll:false});}},
    updateRuntimeSettings(value){providers.updateRuntimeSettings?.(value);},
    destroy(){if(destroyed)return;this.leave();destroyed=true;local.destroy();providers.destroy?.();mount.replaceChildren();}
  };
}
