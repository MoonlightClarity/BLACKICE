import {text,stableId} from '../core/dom.mjs';
import {createConnectionImportSettings} from './settings-import.mjs';

const textMap=(raw,label)=>{
  if(!String(raw||'').trim())return undefined;
  let value;try{value=JSON.parse(raw);}catch{throw Error(label+' must be a JSON object with text values.');}
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length>100)
    throw Error(label+' must be an object with at most 100 entries.');
  for(const [key,item] of Object.entries(value)){
    if(!/^[A-Za-z_][A-Za-z0-9_-]{0,100}$/.test(key)||typeof item!=='string'||item.length>20000||item.includes('\0'))
      throw Error(label+' need valid names and text values of at most 20,000 characters.');
    if(label==='HTTP headers'&&(/[\r\n]/.test(item)||/^(host|content-length|mcp-session-id|mcp-protocol-version|connection|accept|content-type)$/i.test(key)))
      throw Error('Use single-line HTTP headers; transport-managed headers cannot be replaced.');
  }
  return value;
};
const destination=value=>JSON.stringify(value.transport==='http'
  ?['http',new URL(value.url).href]:['stdio',value.command,value.args||[],value.cwd||'']);
export function connectionSettingsDraft(entry={}) {
  return {id:entry.id||stableId('tools').slice(0,40),name:entry.name||'',transport:entry.transport||'stdio',
    enabled:entry.enabled!==false,timeout:String((entry.timeoutMs??30000)/1000),command:entry.command||'',
    args:(entry.args||[]).join('\n'),cwd:entry.cwd||'',url:entry.url||'',env:'',headers:''};
}
export function connectionSettingsSnapshot(entry) {
  if(!entry)return null;
  return JSON.stringify({id:entry.id,name:entry.name,transport:entry.transport,enabled:entry.enabled!==false,
    timeoutMs:entry.timeoutMs??30000,command:entry.command||'',args:entry.args||[],cwd:entry.cwd||'',url:entry.url||'',
    envKeys:[...(entry.envKeys||[])].sort(),headerNames:[...(entry.headerNames||[])].sort()});
}
export function connectionSettingsPayload(fields,previous=null) {
  const id=String(fields.id||'').trim(),name=String(fields.name||'').trim(),seconds=Number(fields.timeout);
  const timeoutMs=Math.round(seconds*1000);
  if(!/^[a-z][a-z0-9_-]{0,39}$/.test(id))throw Error('Use an ID of 1–40 lowercase letters, numbers, underscores or dashes, starting with a letter.');
  if(previous&&id!==previous.id)throw Error('A saved connection keeps its ID. Add a new connection to use another ID.');
  if(!name||name.length>120||name.includes('\0'))throw Error('Enter a connection name of 1–120 characters.');
  if(!Number.isFinite(seconds)||seconds<1||seconds>180||Math.abs(seconds*1000-timeoutMs)>0.000001)
    throw Error('Choose a timeout of 1–180 seconds, with at most three decimal places.');
  if(!['stdio','http'].includes(fields.transport))throw Error('Choose Local process or Streamable HTTP.');
  const value={id,name,transport:fields.transport,enabled:fields.enabled===true,timeoutMs};
  if(value.transport==='stdio'){
    value.command=String(fields.command||'').trim();
    if(!value.command||value.command.length>2000||value.command.includes('\0'))throw Error('Enter the executable that starts the MCP server.');
    const args=String(fields.args||'').replace(/\r\n?/g,'\n');value.args=args?args.split('\n'):[];
    if(value.args.at(-1)==='')value.args.pop();
    if(value.args.length>100||value.args.some(item=>item.length>10000||item.includes('\0')))throw Error('Use at most 100 arguments, each at most 10,000 characters.');
    value.cwd=String(fields.cwd||'').trim();
    if(value.cwd&&(value.cwd.includes('\0')||!/^(?:[A-Za-z]:[\\/]|\/|\\\\)/.test(value.cwd)))throw Error('Use an absolute working folder, or leave it blank.');
  }else{
    let url;try{url=new URL(String(fields.url||'').trim());}catch{throw Error('Enter the complete MCP HTTP endpoint.');}
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)
      throw Error('Use an HTTP or HTTPS endpoint without credentials, query or fragment. Put credentials in headers.');
    value.url=url.href;
  }
  for(const [field,label] of [['env','Environment variables'],['headers','HTTP headers']]){
    const parsed=textMap(fields[field],label);if(parsed!==undefined)value[field]=parsed;
  }
  if(previous&&destination(previous)!==destination(value)){
    for(const [field,names] of [['env','envKeys'],['headers','headerNames']])
      if(previous[names]?.length&&value[field]===undefined)
        throw Error('The server destination changed. Re-enter '+(field==='env'?'environment variables':'HTTP headers')+' or enter {} to clear them.');
  }
  return value;
}
export function connectionCatalogWindow(catalog={},limit=20) {
  const tools=Array.isArray(catalog.tools)?catalog.tools:[],size=Number.isFinite(limit)?Math.max(1,Math.min(40,Math.floor(limit))):20;
  return {shown:tools.slice(0,size),hidden:Math.max(0,Math.min(tools.length,40)-size),
    matches:Number.isFinite(catalog.matches)?catalog.matches:tools.length,
    truncated:catalog.truncated===true||tools.length>40};
}

/** Native Settings connection management. Reads never replace an active draft;
 * each mutation and catalog connection starts from one explicit button action. */
export function createConnectionSettings({mount,api,events,notify=()=>{},onChanged=()=>{}}) {
  mount.innerHTML=[
    '<section id="next-connections-root" class="next-connection-settings" aria-label="Tool connections">',
    '<header class="next-section-actions"><div><h2>Tool connections</h2><p class="next-help">Connect local and remote MCP servers for your agents.</p></div>',
    '<div class="next-row"><button type="button" id="next-connections-refresh">Refresh</button><button type="button" id="next-connections-new">Add server</button></div></header>',
    '<p id="next-connections-feedback" role="status" class="next-help"></p>',
    '<div class="next-connections-layout"><div id="next-connections-list" class="next-connections-list" aria-label="Saved tool servers"></div>',
    '<section class="next-connections-editor"><h3 id="next-connections-heading">Add a tool server</h3>',
    '<p id="next-connections-status" class="next-help" role="status"></p><p id="next-connections-stale" class="next-help" hidden></p>',
    '<form id="next-connections-form" class="next-stack" autocomplete="off" novalidate>',
    '<div class="next-connections-fields"><label class="next-label">Connection ID<input id="next-connections-id" class="next-field" maxlength="40"></label>',
    '<label class="next-label">Name<input id="next-connections-name" class="next-field" maxlength="120"></label>',
    '<label class="next-label">Connection type<select id="next-connections-transport" class="next-field"><option value="stdio">Local process · stdio</option><option value="http">Streamable HTTP</option></select></label>',
    '<label class="next-label">Timeout · seconds<input id="next-connections-timeout" class="next-field" type="number" min="1" max="180" step="0.001"></label></div>',
    '<div id="next-connections-local" class="next-stack"><label class="next-label">Executable<input id="next-connections-command" class="next-field" maxlength="2000" spellcheck="false" placeholder="node, python, npx, or a full path"></label>',
    '<label class="next-label">Arguments · one per line<textarea id="next-connections-args" class="next-field" rows="4" spellcheck="false"></textarea></label>',
    '<p class="next-help">Each line is one argument. Keep paths with spaces on one line, without shell quotes.</p>',
    '<label class="next-label">Working folder · optional<input id="next-connections-cwd" class="next-field" spellcheck="false"></label></div>',
    '<div id="next-connections-http" hidden><label class="next-label">MCP endpoint<input id="next-connections-url" class="next-field" type="url" spellcheck="false" placeholder="https://server.example/mcp"></label></div>',
    '<details class="next-connections-credentials"><summary>Credentials and environment</summary><p class="next-help">Blank keeps saved values. Enter {} to clear a group; entering an object replaces it. Changing the server destination requires entering or clearing its saved credentials.</p>',
    '<p id="next-connections-secret-names" class="next-help"></p>',
    '<label class="next-label">Environment variables · JSON<textarea id="next-connections-env" class="next-field" rows="3" maxlength="200000" spellcheck="false" autocomplete="off"></textarea></label>',
    '<label class="next-label">HTTP headers · JSON<textarea id="next-connections-headers" class="next-field" rows="3" maxlength="200000" spellcheck="false" autocomplete="off"></textarea></label></details>',
    '<label class="next-connections-enabled"><input type="checkbox" id="next-connections-enabled"> Enabled</label>',
    '<div class="next-row"><button id="next-connections-save" type="submit" class="next-primary">Save</button>',
    '<button id="next-connections-reload" type="button">Reload saved settings</button></div></form>',
    '<div class="next-row next-connections-actions"><button id="next-connections-connect" type="button">Connect</button>',
    '<button id="next-connections-disconnect" type="button">Disconnect</button><button id="next-connections-remove" type="button">Remove server</button></div>',
    '<section class="next-connections-catalog-section" aria-label="Tool catalog"><h3>Tool catalog</h3>',
    '<div class="next-row"><input id="next-connections-query" class="next-field" type="search" maxlength="256" placeholder="Tool name or purpose" aria-label="Search tool catalog">',
    '<button id="next-connections-catalog-read" type="button">Read / search catalog</button></div>',
    '<p class="next-help">Reading the catalog connects this saved server and lists its tools. It never runs a tool.</p>',
    '<p id="next-connections-catalog-note" role="status" class="next-help"></p><div id="next-connections-catalog"></div>',
    '<button id="next-connections-catalog-more" type="button" hidden>Show more returned tools</button></section>',
    '</section></div><details id="next-connections-import" class="next-card" style="margin-top:18px"><summary>Import tool configuration</summary><div id="next-connections-import-panel" style="margin-top:12px"></div></details></section>',
  ].join('');
  const $=name=>mount.querySelector('#next-connections-'+name);
  const ids=['root','list','new','refresh','form','heading','status','feedback','stale','local','http','secret-names',
    'save','reload','connect','disconnect','remove','query','catalog-read','catalog','catalog-note','catalog-more'];
  const ui=Object.fromEntries(ids.map(id=>[id,$(id)])),fields=['id','name','transport','enabled','timeout','command','args','cwd','url','env','headers'];
  const inputs=Object.fromEntries(fields.map(id=>[id,$(id)])),drafts=new Map();
  let active=false,destroyed=false,selected='new',entries=[],busy=false,loading=false,readSequence=0,generation=0,
    unsubscribe=null,eventTimer=null,catalog=null,catalogOwner=null,catalogLimit=20,importBusy=false,importChanged=false,importPanel=null;
  const current=()=>drafts.get(selected),saved=()=>entries.find(entry=>entry.id===selected)||null;
  const dirty=()=>{const draft=current();return Boolean(draft&&(!draft.entry||JSON.stringify(draft.fields)!==JSON.stringify(connectionSettingsDraft(draft.entry))));};
  const say=(message,error=false)=>{ui.feedback.textContent=String(message||'');ui.feedback.dataset.error=String(error);if(error&&active)notify(message,true);};
  const path=id=>'/api/connections/'+encodeURIComponent(id);
  function remember(entry=null){
    const key=entry?.id||'new';
    if(!drafts.has(key))drafts.set(key,{entry,base:connectionSettingsSnapshot(entry),fields:connectionSettingsDraft(entry||{})});
    return drafts.get(key);
  }
  function controls(){
    importPanel?.setBlocked(busy);
    const locked=busy||importBusy;
    const entry=saved(),hasSaved=Boolean(current()?.entry),running=Boolean(entry?.busy),changed=dirty();
    for(const field of Object.values(inputs))field.disabled=locked;
    inputs.id.disabled=locked||hasSaved;
    ui.save.disabled=locked||running||!current()||hasSaved&&!changed;
    ui.reload.disabled=locked||!hasSaved;
    ui.connect.disabled=locked||!entry||entry.enabled===false||entry.connected===true||running||changed;
    ui.disconnect.disabled=locked||!entry||!entry.connected||running;
    ui.remove.disabled=locked||!hasSaved||running;
    ui['catalog-read'].disabled=locked||!entry||entry.enabled===false||changed;
    ui.query.disabled=locked;ui.new.disabled=locked;ui.refresh.disabled=locked||loading;
    for(const button of ui.list.querySelectorAll('button'))button.disabled=locked;
    ui.local.hidden=inputs.transport.value!=='stdio';ui.http.hidden=inputs.transport.value!=='http';
    const base=current()?.entry;
    const stale=base&&(!entry||current().base!==connectionSettingsSnapshot(entry));
    ui.stale.hidden=!stale;ui.stale.textContent=stale?'Saved settings changed elsewhere. Your draft is retained; reload saved settings to review them.':'';
    ui.status.textContent=!base?'New connection · not saved':!entry?'This connection was removed elsewhere.':
      (entry.enabled===false?'Disabled':entry.connected?'Connected':'Disconnected')+(entry.busy?' · '+entry.busy+' active tools':'')+
      (entry.error?' · Connection error: '+entry.error:'')+(changed?' · Unsaved settings':'');
  }
  function drawList(){
    ui.list.replaceChildren();
    if(!entries.length)text(ui.list,'No tool servers saved.','p','next-help');
    for(const entry of entries.slice(0,40)){
      const button=text(ui.list,'','button','next-connections-entry');button.type='button';button.dataset.connectionId=entry.id;
      button.setAttribute('aria-current',String(selected===entry.id));
      text(button,entry.name||entry.id,'strong');
      text(button,entry.enabled===false?'Disabled':entry.connected?'Connected':entry.error?'Connection error':'Disconnected','span');
      button.addEventListener('click',()=>open(entry));
    }
  }
  function paintFields(){
    const draft=current();if(!draft)return;
    for(const [id,node] of Object.entries(inputs))if(id==='enabled')node.checked=draft.fields[id];else node.value=draft.fields[id];
    ui.heading.textContent=draft.entry?'Configure '+(draft.entry.name||draft.entry.id):'Add a tool server';
    const entry=draft.entry;
    ui['secret-names'].textContent=[entry?.envKeys?.length?'Environment names: '+entry.envKeys.join(', '):'',
      entry?.headerNames?.length?'Header names: '+entry.headerNames.join(', '):''].filter(Boolean).join(' · ');
    controls();
  }
  function drawCatalog(){
    ui.catalog.replaceChildren();ui['catalog-more'].hidden=true;
    if(!catalog||catalogOwner!==selected){ui['catalog-note'].textContent='Choose Read / search catalog to load this server’s tools.';return;}
    const view=connectionCatalogWindow(catalog,catalogLimit);
    ui['catalog-note'].textContent=view.shown.length+' of '+view.matches+' matching tools'+(view.truncated?' · Narrow your search to load remaining tools.':'');
    for(const tool of view.shown){
      const card=text(ui.catalog,'','article','next-connections-tool');
      text(card,String(tool.title||tool.annotations?.title||tool.name||'Tool').slice(0,400),'h4');
      text(card,String(tool.name||'').slice(0,400),'code');
      if(tool.description)text(card,String(tool.description).slice(0,3000),'p');
      const details=text(card,'','details');text(details,'Input schema','summary');
      const schema=JSON.stringify(tool.inputSchema||{},null,2);text(details,schema.slice(0,12000)+(schema.length>12000?'\nSchema preview shortened.':''),'pre');
    }
    if(!view.shown.length)text(ui.catalog,'No tools matched. Try a shorter name or another description.','p','next-help');
    ui['catalog-more'].hidden=!view.hidden;
  }
  function open(entry=null){
    if(busy||importBusy)return;remember(entry);selected=entry?.id||'new';catalog=null;catalogOwner=null;catalogLimit=20;
    ui.query.value='';drawList();paintFields();drawCatalog();say('');
  }
  async function load(){
    if(!active||destroyed||importBusy)return false;const token=generation,sequence=++readSequence;loading=true;controls();
    try{
      const result=await api('/api/connections');
      if(!active||token!==generation||sequence!==readSequence)return false;
      entries=Array.isArray(result)?result:Array.isArray(result?.connections)?result.connections:[];
      drawList();controls();return true;
    }catch(error){if(active&&token===generation&&sequence===readSequence)say('Could not read tool servers: '+error.message,true);return false;}
    finally{if(sequence===readSequence){loading=false;controls();}}
  }
  async function operate(kind){
    if(!active||busy||importBusy||destroyed)return;
    const key=selected,draft=current(),entry=saved();if(!draft)return;
    let payload;
    try{
      if(kind==='save')payload=connectionSettingsPayload(draft.fields,draft.entry);
      else if(!entry)throw Error('Save this connection first.');
      if(['connect','catalog'].includes(kind)&&dirty())throw Error('Save or reload the current draft before connecting.');
    }catch(error){say(error.message,true);return;}
    busy=true;readSequence++;controls();say(kind==='save'?'Saving connection settings…':kind==='catalog'?'Connecting and reading the tool catalog…':'Working…');
    try{
      if(kind==='save'){
        const fresh=await api('/api/connections'),list=Array.isArray(fresh)?fresh:fresh?.connections||[],latest=list.find(item=>item.id===payload.id);
        if(destroyed)return;
        if(draft.entry&&connectionSettingsSnapshot(latest)!==draft.base)throw Error('Saved settings changed since editing began. Reload them before saving.');
        if(!draft.entry&&latest)throw Error('This connection ID already exists. Open that connection or choose another ID.');
        const result=await api('/api/connections','POST',payload);
        if(destroyed)return;
        if(!result||result.id!==payload.id||typeof result.name!=='string'||!['stdio','http'].includes(result.transport))throw Error('Save was not confirmed. Refresh the server list before another explicit save.');
        drafts.delete(key);drafts.set(result.id,{entry:result,base:connectionSettingsSnapshot(result),fields:connectionSettingsDraft(result)});
        selected=result.id;entries=[result,...entries.filter(item=>item.id!==result.id)];
        catalog=null;catalogOwner=null;paintFields();drawList();drawCatalog();say('Connection settings saved. '+(result.connected?'Connected.':'Not connected.'));
      }else if(kind==='catalog'){
        const query=ui.query.value.trim();
        const result=await api(path(entry.id)+'/tools?query='+encodeURIComponent(query));
        if(destroyed)return;
        if(selected===key){catalog=result;catalogOwner=key;catalogLimit=20;drawCatalog();}
        say('Tool catalog read. No tool was run.');
      }else if(kind==='remove'){
        const result=await api(path(entry.id),'DELETE',{});
        if(destroyed)return;
        if(result?.removed!==true)throw Error('Removal was not confirmed. Refresh before another explicit request.');
        drafts.delete(key);entries=entries.filter(item=>item.id!==key);selected='new';remember();paintFields();drawList();catalog=null;drawCatalog();say('Connection removed.');
      }else{
        const result=await api(path(entry.id)+'/'+kind,'POST',{});
        if(destroyed)return;
        if(kind==='connect'&&result?.connected!==true)throw Error('The server did not confirm a live connection.');
        if(kind==='disconnect'&&result?.disconnected!==true)throw Error('Disconnection was not confirmed.');
        say(kind==='connect'?'Connection established.':'Connection disconnected.');
      }
      onChanged();
      if(active)await load();
    }catch(error){if(!destroyed){say((kind==='save'?'Settings were not confirmed saved. ':kind==='connect'?'Connection failed. ':kind==='catalog'?'Catalog read failed. ':'Action was not confirmed. ')+error.message,true);if(active)await load();}}
    finally{busy=false;if(!destroyed)controls();}
  }
  for(const [field,node] of Object.entries(inputs))node.addEventListener(field==='enabled'||field==='transport'?'change':'input',()=>{
    const draft=current();if(!draft||busy||importBusy)return;draft.fields[field]=field==='enabled'?node.checked:node.value;controls();
  });
  ui.form.addEventListener('keydown',event=>{if(event.key==='Enter'&&event.target!==ui.save&&event.target?.tagName!=='TEXTAREA')event.preventDefault();});
  ui.form.addEventListener('submit',event=>{event.preventDefault();void operate('save');});
  ui.new.addEventListener('click',()=>open());ui.refresh.addEventListener('click',()=>void load());
  ui.reload.addEventListener('click',()=>{
    const entry=saved();if(busy||importBusy||!entry)return;drafts.delete(selected);remember(entry);paintFields();say('Saved settings reloaded.');
  });
  for(const kind of ['connect','disconnect','remove'])ui[kind].addEventListener('click',()=>void operate(kind));
  ui['catalog-read'].addEventListener('click',()=>void operate('catalog'));
  ui['catalog-more'].addEventListener('click',()=>{catalogLimit+=20;drawCatalog();});
  const onEvent=event=>{
    if(!active||!['connections.updated','connections.status'].includes(event?.type))return;
    clearTimeout(eventTimer);eventTimer=setTimeout(()=>{eventTimer=null;void load();},150);
  };
  importPanel=createConnectionImportSettings({mount:$('import-panel'),api,onReload:()=>load(),
    onBusyChange(value){importBusy=value;if(value){readSequence++;loading=false;}if(!destroyed)controls();},
    onChanged(){if(active){void load();onChanged();}else importChanged=true;}});
  remember();paintFields();drawList();drawCatalog();
  return {
    enter(){if(active||destroyed)return;active=true;generation++;importPanel.enter();unsubscribe=events?.subscribe?.(onEvent);void load();if(importChanged){importChanged=false;onChanged();}},
    leave(){active=false;generation++;readSequence++;loading=false;importPanel?.leave();unsubscribe?.();unsubscribe=null;clearTimeout(eventTimer);eventTimer=null;},
    destroy(){this.leave();destroyed=true;importPanel?.destroy();drafts.clear();mount.replaceChildren();},
  };
}
