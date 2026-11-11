import { createLocalModelSettings } from './settings-local-models.mjs';

/** Native account settings stay separate from optional API connections. */
export function createSubscriptionModelSettings(props, createLegacy) {
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
    element('h2','','Codex subscription'),
    element('p','next-help','Use your Codex account for native Codex models. Existing conversations retain the model and provider that originally created them.')
  );
  const list=element('div','next-stack');
  list.setAttribute('aria-label','Codex account status');
  const feedback=element('p','next-help','Checking Codex connection…');
  feedback.setAttribute('role','status');
  list.append(feedback);
  header.append(list);

  const native=element('section','next-card next-stack');
  native.id='next-mistral-vibe';native.dataset.nativeProvider='mistral-vibe';native.setAttribute('tabindex','-1');
  const nativeTitle=element('h2','','Mistral Vibe Code');nativeTitle.id='next-mistral-vibe-title';
  native.setAttribute('aria-labelledby',nativeTitle.id);
  native.append(nativeTitle,element('p','next-help','Connect your Mistral account through Mistral Vibe Code. This native account connection is separate from Mistral API keys.'));
  const nativeStatus=element('p','next-help','Checking Mistral Vibe Code…');nativeStatus.id='next-mistral-vibe-status';nativeStatus.setAttribute('role','status');nativeStatus.setAttribute('aria-live','polite');
  const nativeVersion=element('p','next-help');nativeVersion.id='next-mistral-vibe-version';
  const nativeActions=element('div','next-row'),nativeLogin=button('next-mistral-vibe-login','Sign in to Mistral Vibe Code'),nativeRefresh=button('next-mistral-vibe-refresh','Refresh connection and models');
  nativeActions.append(nativeLogin,nativeRefresh);
  const nativeError=element('p','next-help');nativeError.id='next-mistral-vibe-error';nativeError.setAttribute('role','alert');
  const catalog=element('details'),catalogTitle=element('summary','','Models reported by Vibe Code'),catalogModels=element('ul','next-stack');
  catalog.id='next-mistral-vibe-catalog';catalogModels.id='next-mistral-vibe-models';catalog.append(catalogTitle,catalogModels);
  native.append(nativeStatus,nativeVersion,nativeActions,nativeError,catalog,
    element('p','next-help','Sign-in opens in BLACKICE’s browser. After signing in, refresh the connection to load its model catalog, then choose a model in Chat or General settings.'));

  const advanced=element('details','next-card');
  advanced.id='next-connect-another-endpoint';advanced.open=true;
  advanced.append(
    element('summary','','Optional API connections'),
    element('p','next-help','Use an API provider, a local model server, or a custom compatible endpoint when you choose. API setup is optional. Add credentials only when the provider requires them; your default and existing chats keep their selected models.'),
    element('p','next-help','Antigravity and Qwen Code native CLI integrations are retired. Their previously saved chats retain their original provider and model identity, but those native CLIs are no longer selectable.')
  );
  const legacyMount=element('div');
  advanced.append(legacyMount);
  const localMount=element('div');
  mount.append(header,native,localMount,advanced);
  const local=createLocalModelSettings({mount:localMount,api,onChanged:()=>props.onChanged?.()});
  const legacy=createLegacy({...props,mount:legacyMount});
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
  const toggle=()=>{
    if(!active||destroyed)return;
    if(advanced.open&&!expanded){expanded=true;legacy.enter?.();}
    else if(!advanced.open&&expanded){expanded=false;legacy.leave?.();}
  };
  advanced.addEventListener('toggle',toggle);
  render();
  return {
    enter(){if(destroyed||active)return;active=true;local.enter();render();void load();toggle();},
    leave(){active=false;revision++;local.leave();render();if(expanded){legacy.leave?.();expanded=false;}},
    updateStatus,
    focusProvider(id){if(id==='mistral-vibe'&&!destroyed&&active)native.focus({preventScroll:false});},
    updateRuntimeSettings(value){legacy.updateRuntimeSettings?.(value);},
    destroy(){if(destroyed)return;this.leave();destroyed=true;local.destroy();legacy.destroy?.();advanced.removeEventListener('toggle',toggle);mount.replaceChildren();}
  };
}
