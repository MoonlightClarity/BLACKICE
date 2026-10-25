import {text} from '../core/dom.mjs';

const SOURCE_LIMIT=512000,PREVIEW_LIMIT=40;

/** Preview contains server metadata only. Configuration remains in memory until
 * an explicit import receipt clears it; it is never placed in browser storage. */
export function createConnectionImportSettings({mount,api,onChanged=()=>{},onReload=async()=>true,onBusyChange=()=>{}}){
  mount.innerHTML=`<section id="next-settings-import-root" class="next-stack" aria-label="Import tool configuration">
    <p class="next-help">Paste an existing mcpServers object or a BLACKICE connections array. Import adds new servers and keeps existing ones. It does not connect a server or start a local process.</p>
    <form id="next-settings-import-form" class="next-stack" autocomplete="off"><label class="next-label">Configuration JSON<textarea id="next-settings-import-source" class="next-field" rows="9" maxlength="512000" spellcheck="false" autocomplete="off" placeholder='{"mcpServers":{"my-server":{"command":"node","args":["server.mjs"]}}}'></textarea></label>
    <div class="next-row"><button id="next-settings-import-file-choose" type="button">Choose JSON file</button><span class="next-help">Up to 512,000 characters. Preview omits credential values and command arguments.</span><input id="next-settings-import-file" type="file" accept=".json,application/json,text/plain" hidden></div>
    <div class="next-row"><button id="next-settings-import-read" type="button">Read configuration</button><button id="next-settings-import-apply" type="button" class="next-primary">Import servers</button><button id="next-settings-import-reload" type="button">Refresh saved servers</button><button id="next-settings-import-clear" type="button">Clear configuration</button></div></form>
    <p id="next-settings-import-status" class="next-help" role="status" aria-live="polite">Read configuration to preview the servers.</p><p id="next-settings-import-error" class="next-help" role="alert"></p>
    <div id="next-settings-import-preview" class="next-stack" aria-label="Servers to import" style="max-height:360px;overflow:auto;overflow-wrap:anywhere"></div>
    <p class="next-help">Local processes and Streamable HTTP are supported. Legacy SSE and embedded OAuth configuration are unavailable in this importer.</p></section>`;
  const $=name=>mount.querySelector('#next-settings-import-'+name),ui=Object.fromEntries(['root','form','source','file-choose','file','read','apply','reload','clear','status','error','preview'].map(name=>[name,$(name)]));
  let active=false,destroyed=false,blocked=false,operation=null,generation=0,revision=0,readSequence=0,fileSequence=0,controller=null;
  let source='',preview=null,previewRevision=-1,warnings=[],mustRefresh=false,fileReading=false,message='Read configuration to preview the servers.',error='';
  const add=(parent,tag,value='',className='')=>text(parent,value,tag,className);
  function redact(cause){
    let value=String(cause?.message||cause||'The configuration action could not complete.');
    try{
      const config=JSON.parse(source),entries=Object.values(config.mcpServers||config.connections||{});
      for(const entry of entries)for(const map of [entry?.env,entry?.headers])for(const secret of Object.values(map||{}))if(typeof secret==='string'&&secret)value=value.replaceAll(secret,'[redacted]');
    }catch{}
    return value;
  }
  function controls(){
    const locked=blocked||Boolean(operation);
    for(const node of [ui.read,ui.apply,ui.reload,ui.clear,ui['file-choose'],ui.file])node.disabled=locked;
    ui.source.disabled=blocked||operation==='apply';
    ui.apply.disabled=locked||mustRefresh||fileReading||!preview?.length||previewRevision!==revision;
    ui.read.disabled=locked||mustRefresh||fileReading||!source.trim();ui.clear.disabled=locked||!source;
    ui.root.setAttribute('aria-busy',String(Boolean(operation)||fileReading));
  }
  function feedback(){ui.status.textContent=message;ui.error.textContent=error;ui.error.dataset.error=String(Boolean(error));controls();}
  function paintPreview(){
    ui.preview.replaceChildren();
    for(const entry of (preview||[]).slice(0,PREVIEW_LIMIT)){
      const card=add(ui.preview,'article','', 'next-card');add(card,'strong',String(entry.name||'Tool server').slice(0,120));
      add(card,'p',(entry.transport==='http'?'Streamable HTTP':'Local process · stdio')+(entry.enabled===false?' · disabled':''),'next-help');
      add(card,'code',String(entry.url||entry.command||'').slice(0,20000));
      add(card,'p',`New ID: ${String(entry.id||'').slice(0,40)} · ${entry.transport==='stdio'?`${Math.max(0,Number(entry.argumentCount)||0)} arguments · `:''}${Array.isArray(entry.envKeys)?entry.envKeys.length:0} environment values · ${Array.isArray(entry.headerNames)?entry.headerNames.length:0} headers`,'next-help');
    }
    for(const warning of warnings.slice(0,PREVIEW_LIMIT))add(ui.preview,'p',String(warning).slice(0,1000),'next-help');
  }
  function invalidate(){preview=null;previewRevision=-1;warnings=[];paintPreview();}
  function change(value){
    source=String(value);revision++;fileSequence++;fileReading=false;readSequence++;controller?.abort();controller=null;
    if(operation==='read')operation=null;
    invalidate();error='';message=mustRefresh?'Import completion was not confirmed. Refresh saved servers before reading another preview.':'Configuration changed. Read it to update the preview.';feedback();
  }
  async function read(){
    if(!active||destroyed||blocked||operation||mustRefresh||fileReading)return;
    if(!source.trim()||source.length>SOURCE_LIMIT){error='Paste a JSON configuration of at most 512,000 characters.';feedback();return;}
    const token=++readSequence,session=generation,sourceRevision=revision,submitted=source,abort=new AbortController();controller=abort;operation='read';error='';message='Reading configuration…';feedback();
    try{
      const result=await api('/api/connections/import','POST',{configuration:submitted,apply:false},{signal:abort.signal});
      if(!active||destroyed||session!==generation||token!==readSequence||sourceRevision!==revision)return;
      if(!Array.isArray(result?.preview)||!result.preview.length||result.preview.length>PREVIEW_LIMIT)throw Error('The server did not return a usable import preview.');
      preview=result.preview;previewRevision=sourceRevision;warnings=Array.isArray(result.warnings)?result.warnings:[];
      message=`${preview.length} new ${preview.length===1?'server':'servers'} ready to import. Existing servers stay as they are.`;paintPreview();
    }catch(cause){if(active&&!destroyed&&session===generation&&token===readSequence){invalidate();error=redact(cause);message='Fix the configuration, then read it again.';}}
    finally{if(token===readSequence){operation=null;controller=null;if(!destroyed)feedback();}}
  }
  async function apply(){
    if(!active||destroyed||blocked||operation||mustRefresh||fileReading||!preview?.length||previewRevision!==revision)return;
    const submitted=source,expected=preview.length;operation='apply';fileSequence++;readSequence++;error='';message='Saving new tool servers…';onBusyChange(true);feedback();let changed=false;
    try{
      const result=await api('/api/connections/import','POST',{configuration:submitted,apply:true});
      if(destroyed)return;
      if(!Array.isArray(result?.imported)||result.imported.length!==expected)throw Error('The server did not confirm every imported connection.');
      const count=result.imported.length;source='';revision++;ui.source.value='';ui.file.value='';mustRefresh=false;invalidate();warnings=Array.isArray(result.warnings)?result.warnings:[];paintPreview();
      message=`${count} tool ${count===1?'server':'servers'} imported. No connection was started.`;changed=true;
    }catch(cause){if(!destroyed){error=redact(cause);invalidate();mustRefresh=true;changed=true;
      message='No completion receipt. Some servers may have been saved. Refresh saved servers, remove already saved entries from this configuration, then read it again.';}}
    finally{operation=null;onBusyChange(false);if(!destroyed){feedback();if(changed)onChanged();}}
  }
  async function reload(){
    if(!active||destroyed||blocked||operation)return;operation='reload';error='';message='Refreshing saved servers…';feedback();
    try{
      if(await onReload()===false)throw Error('Saved servers could not be refreshed. Try Refresh saved servers again.');
      if(destroyed)return;mustRefresh=false;invalidate();message=source?'Saved servers refreshed. Remove already saved entries from the configuration, then Read configuration for a fresh preview.':'Saved servers refreshed.';
    }catch(cause){if(!destroyed){error=redact(cause);message='Saved servers could not be refreshed. The configuration is kept.';}}
    finally{operation=null;if(!destroyed)feedback();}
  }
  async function fileChanged(){
    const file=ui.file.files?.[0];if(!file||blocked||operation==='apply')return;
    ui.file.value='';readSequence++;controller?.abort();controller=null;if(operation==='read')operation=null;revision++;invalidate();
    const token=++fileSequence,session=generation,sourceRevision=revision;fileReading=true;error='';message='Reading selected file…';feedback();
    try{
      if(file.size>2*1024*1024)throw Error('Choose a configuration with at most 512,000 characters.');
      const value=await file.text();if(!active||destroyed||token!==fileSequence||session!==generation||sourceRevision!==revision)return;
      if(value.length>SOURCE_LIMIT)throw Error('Choose a configuration with at most 512,000 characters.');
      ui.file.value='';ui.source.value=value;change(value);await read();
    }catch(cause){if(active&&!destroyed&&token===fileSequence&&session===generation){error=redact(cause);message='The selected file could not be read. Your configuration is kept.';feedback();}}
    finally{if(token===fileSequence){fileReading=false;ui.file.value='';if(!destroyed)feedback();}}
  }
  ui.source.addEventListener('input',()=>{if(operation!=='apply'&&!blocked)change(ui.source.value);});
  ui.form.addEventListener('submit',event=>event.preventDefault());
  ui.form.addEventListener('keydown',event=>{if(event.key==='Enter'&&event.target.tagName!=='TEXTAREA'&&event.target.tagName!=='BUTTON')event.preventDefault();});
  ui.read.addEventListener('click',()=>void read());ui.apply.addEventListener('click',()=>void apply());ui.reload.addEventListener('click',()=>void reload());
  ui.clear.addEventListener('click',()=>{if(operation||blocked)return;ui.source.value='';ui.file.value='';change('');message=mustRefresh?'Configuration cleared. Refresh saved servers to inspect the previous import result.':'Configuration cleared.';feedback();});
  ui['file-choose'].addEventListener('click',()=>{if(!blocked&&!operation)ui.file.click();});ui.file.addEventListener('change',()=>void fileChanged());
  feedback();
  return {
    enter(){if(destroyed||active)return;active=true;generation++;feedback();},
    leave(){active=false;generation++;readSequence++;fileSequence++;controller?.abort();controller=null;if(operation==='read'||fileReading){if(operation==='read')operation=null;fileReading=false;message='Configuration read paused. Read configuration to load a fresh preview.';}},
    setBlocked(value){blocked=Boolean(value);controls();},
    destroy(){this.leave();destroyed=true;source='';preview=null;warnings=[];ui.source.value='';ui.file.value='';mount.replaceChildren();},
  };
}
