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

  const advanced=element('section','next-card');
  advanced.id='next-connect-another-endpoint';
  advanced.setAttribute('aria-label','API connections');
  const providerMount=element('div');
  advanced.append(providerMount);
  const localMount=element('div');
  const tabs=element('nav','next-settings-sections');tabs.setAttribute('role','tablist');tabs.setAttribute('aria-label','Model configuration');
  const modelPanels=new Map(),tabButtons=new Map();let modelSection='accounts';
  for(const [id,title]of [['accounts','Accounts'],['local','Local models'],['api','Add API']]){const tab=button('next-models-tab-'+id,title);tab.setAttribute('role','tab');tab.setAttribute('aria-controls','next-models-panel-'+id);const panel=element('div','');panel.id='next-models-panel-'+id;panel.setAttribute('role','tabpanel');panel.setAttribute('aria-labelledby',tab.id);modelPanels.set(id,panel);tabButtons.set(id,tab);tabs.append(tab);}
  modelPanels.get('accounts').append(header);modelPanels.get('local').append(localMount);modelPanels.get('api').append(advanced);mount.append(tabs,...modelPanels.values());
  const local=createLocalModelSettings({mount:localMount,api,onChanged:()=>props.onChanged?.()});
  const providers=createProvider({...props,mount:providerMount});
  function selectModelSection(id){if(!modelPanels.has(id)||destroyed)return;modelSection=id;for(const [key,panel]of modelPanels){panel.hidden=key!==id;const tab=tabButtons.get(key);tab.setAttribute('aria-selected',String(key===id));tab.tabIndex=key===id?0:-1;}if(!active)return;providers.setCodexActive?.(id==='accounts');if(id==='local')local.enter();else local.leave();if(id==='api'){if(!expanded){expanded=true;providers.enter?.();}}else if(expanded){expanded=false;providers.leave?.();}}
  for(const [id,tab]of tabButtons){tab.addEventListener('click',()=>selectModelSection(id));tab.addEventListener('keydown',event=>{const ids=[...tabButtons.keys()],i=ids.indexOf(id);let next;if(event.key==='ArrowRight')next=(i+1)%ids.length;else if(event.key==='ArrowLeft')next=(i+ids.length-1)%ids.length;else if(event.key==='Home')next=0;else if(event.key==='End')next=ids.length-1;else return;event.preventDefault();selectModelSection(ids[next]);tabButtons.get(ids[next]).focus();});}
  // Keep native Codex controls with its account, not among API connections.
  const codexControls=providerMount.querySelector('#next-provider-codex');
  if(codexControls)header.append(codexControls);
  let active=false,destroyed=false,revision=0,expanded=false,currentStatus=null,operationError='';
  const render=()=>{
    if(destroyed)return;
    const codex=currentStatus?.codex||currentStatus||{},ready=codex.connected===true&&codex.authenticated===true;
    feedback.textContent=currentStatus===null?'Checking Codex connection…':ready
      ?'Connected · ChatGPT/Codex subscription · choose a Codex model in General.'
      :codex.connected?'Codex CLI is connected but needs account authentication.'
      :'Codex is not connected. Sign in through the official Codex CLI, then reconnect.';
    if(operationError)feedback.textContent=operationError;
  };
  const updateStatus=value=>{
    if(destroyed||!value||typeof value!=='object'||Array.isArray(value))return;
    revision++;currentStatus=value;
    operationError='';
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
  render();selectModelSection(modelSection);
  return {
    enter(){if(destroyed||active)return;active=true;selectModelSection(modelSection);render();void load();},
    leave(){active=false;providers.setCodexActive?.(false);revision++;local.leave();render();if(expanded){providers.leave?.();expanded=false;}},
    updateStatus,
    focusProvider(id){if(destroyed||!active)return;if(id==='local'){selectModelSection('local');return;}},
    updateRuntimeSettings(value){providers.updateRuntimeSettings?.(value);},
    destroy(){if(destroyed)return;this.leave();destroyed=true;local.destroy();providers.destroy?.();mount.replaceChildren();}
  };
}
