/** Codex subscription settings. Retired native CLIs are not selectable or probed. */
export function createSubscriptionModelSettings(props, createLegacy) {
  const {mount,api}=props,doc=mount.ownerDocument;
  const element=(tag,cls,value='')=>{
    const node=doc.createElement(tag);
    if(cls)node.className=cls;
    node.textContent=value;
    return node;
  };
  const header=element('section','next-card');
  header.append(
    element('h2','','Codex subscription'),
    element('p','next-help','BLACKICE uses Codex as its supported native subscription runtime. Choose an exact Codex model in General settings; existing conversations retain the model and provider that originally created them.')
  );
  const list=element('div','next-stack');
  list.setAttribute('aria-label','Codex account status');
  const feedback=element('p','next-help','Checking Codex connection…');
  feedback.setAttribute('role','status');
  list.append(feedback);
  header.append(list);
  const advanced=element('details','next-card');
  advanced.id='next-connect-another-endpoint';
  advanced.append(
    element('summary','','Connect another endpoint · unsupported (optional)'),
    element('p','next-help','Optional advanced integration: add any compatible API endpoint, URL, model ID and required credentials. BLACKICE does not officially support or guarantee third-party endpoint behavior, compatibility, availability or rate limits. It never silently switches to a paid API. Existing API connections and their conversations are preserved; you can still select explicitly configured endpoint models.'),
    element('p','next-help','Antigravity and Qwen Code native CLI integrations are retired. Their previously saved chats retain their original provider and model identity, but those native CLIs are no longer selectable.')
  );
  const legacyMount=element('div');
  advanced.append(legacyMount);
  mount.append(header,advanced);
  const legacy=createLegacy({...props,mount:legacyMount});
  let active=false,destroyed=false,revision=0,expanded=false;
  const render=status=>{
    if(destroyed)return;
    const codex=status?.codex||status||{};
    const ready=codex.connected===true&&codex.authenticated===true;
    feedback.textContent=ready
      ?'Connected · ChatGPT/Codex subscription · choose a Codex model in General.'
      :codex.connected
        ?'Codex CLI is connected but needs account authentication.'
        :'Codex is not connected. Sign in through the official Codex CLI, then reconnect.';
  };
  const load=async()=>{
    const token=++revision;
    try{
      const status=await api('/api/status');
      if(active&&!destroyed&&token===revision)render(status);
    }catch(error){
      if(active&&!destroyed&&token===revision)
        feedback.textContent=error?.message||'Codex account status is unavailable.';
    }
  };
  const toggle=()=>{
    if(!active||destroyed)return;
    if(advanced.open&&!expanded){expanded=true;legacy.enter?.()}
    else if(!advanced.open&&expanded){expanded=false;legacy.leave?.()}
  };
  advanced.addEventListener('toggle',toggle);
  return {
    enter(){if(destroyed||active)return;active=true;void load();toggle()},
    leave(){active=false;revision++;if(expanded){legacy.leave?.();expanded=false}},
    updateRuntimeSettings(value){legacy.updateRuntimeSettings?.(value)},
    destroy(){this.leave();destroyed=true;legacy.destroy?.();advanced.removeEventListener('toggle',toggle);mount.replaceChildren()}
  };
}
