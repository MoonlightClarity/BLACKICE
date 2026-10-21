import {browserTreeModel,browserFolderDOMId,browserCapacityLabel,browserParentChoices,browserPersistenceMessage,browserSuspensionOutcome} from './browser-tree-model.mjs';
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function installBrowserTreeStyles(){if(typeof document==='undefined'||!document.head?.append||document.querySelector?.('#blackice-browser-tree-styles'))return;const link=document.createElement('link');link.id='blackice-browser-tree-styles';link.rel='stylesheet';link.href='/browser-tree.css';document.head.append(link);}

export function browserTabTreeMarkup(status,{selected,folderState=new Map(),newFolderDraft='',renameFolder=null,renameDraft='',placement=null,tabNotice='',escape=escapeHTML}={}){
 const tabs=Array.isArray(status.tabs)?status.tabs:[],managed=Array.isArray(status.folders),tree=browserTreeModel(status),capacity=browserCapacityLabel(status),persistence=browserPersistenceMessage(status);
 const row=tab=>`<div class="browser-tab-row${selected===tab.tabId?' selected':''}"><button class="browser-tab-select" data-browser-tab="${escape(tab.tabId)}"${selected===tab.tabId?' aria-current="page"':''}><strong>${escape(tab.title||(tab.suspended?'Saved page':'Untitled page'))}</strong><span>${escape(tab.url)}</span></button>${tab.suspended?'<span class="browser-tab-state">Saved</span>':managed&&(tab.browser==='relay'||tab.contained===true)?`<button class="button browser-tab-suspend" data-browser-suspend="${escape(tab.tabId)}" aria-label="Suspend ${escape(tab.title||'tab')}" title="Release this page’s memory and keep it in its folder">Suspend</button>`:''}${tab.canShow===false?'':`<button class="button" data-browser-show="${escape(tab.tabId)}">Open window</button>`}<button class="icon-button" data-browser-close="${escape(tab.tabId)}" aria-label="Close ${escape(tab.title||'tab')}">×</button></div>`;
 const branches=nodes=>`<ul class="browser-tab-tree">${nodes.map(tab=>`<li>${row(tab)}${tab.children.length?branches(tab.children):''}</li>`).join('')}</ul>`;
 if(!managed)return `<div class="browser-tab-list">${tabs.map(row).join('')||'<div class="browser-empty"><strong>No tabs yet</strong><p>Open a website above, or give an agent a web task.</p></div>'}</div>`;
 const current=tabs.find(tab=>tab.tabId===selected),selectedFolder=current?.folderId;
 const folders=tree.folders.map((folder,index)=>{
  const key=folder.id??'',open=folderState.has(key)?folderState.get(key):selectedFolder===folder.id||!selectedFolder&&index===0;
  const editing=folder.id!==null&&renameFolder===folder.id;
  return `<details id="${browserFolderDOMId(key)}" class="browser-tab-folder" data-browser-folder="${escape(key)}"${open?' open':''}><summary><span class="browser-folder-name">${escape(folder.name)}</span>${folder.kind==='task'?'<span class="browser-folder-kind">Task</span>':''}<span class="browser-folder-count">${folder.live} live · ${folder.saved} saved</span></summary>${folder.roots.length?branches(folder.roots):'<p class="field-help">No pages in this folder.</p>'}${folder.id===null?'':`<div class="browser-folder-actions"><button class="button" data-browser-folder-rename="${escape(folder.id)}">Rename folder</button><button class="button" data-browser-folder-close="${escape(folder.id)}" title="Close every page in this folder">Close folder</button></div>${editing?`<form id="browser-folder-rename-form" class="browser-folder-form"><label for="browser-folder-rename-name">Folder name</label><input id="browser-folder-rename-name" data-folder-id="${escape(folder.id)}" type="text" maxlength="200" required value="${escape(renameDraft)}"><button class="button" type="submit">Save name</button><button class="button" id="browser-folder-rename-cancel" type="button">Cancel</button></form>`:''}`}</details>`;
 }).join('');
 let organize='';
 if(current&&status.folders.length){
  const owner=tree.folders.find(folder=>folder.id===current.folderId),allowed=owner?.kind==='task'?status.folders.filter(folder=>folder.id===owner.id):status.folders.filter(folder=>folder.kind!=='task');
  const folderId=placement?.tabId===current.tabId&&allowed.some(folder=>folder.id===placement.folderId)?placement.folderId:current.folderId;
  const parentId=placement?.tabId===current.tabId?placement.parentTabId:current.parentTabId;
  organize=`<form id="browser-tab-placement-form" class="browser-tab-placement"><strong>Move selected page</strong><label>Folder<select id="browser-tab-folder">${allowed.map(folder=>`<option value="${escape(folder.id)}"${folder.id===folderId?' selected':''}>${escape(folder.name)}</option>`).join('')}</select></label><label>Parent page<select id="browser-tab-parent"><option value="">Top level</option>${browserParentChoices(status,current.tabId,folderId).map(tab=>`<option value="${escape(tab.tabId)}"${tab.tabId===parentId?' selected':''}>${escape(tab.title||'Untitled page')}</option>`).join('')}</select></label><button class="button" type="submit">Move page</button></form>`;
 }
 return `<section class="browser-tree-workspace" aria-label="Browser folders and page tree"><div class="browser-tree-heading"><strong>Folders &amp; pages</strong>${capacity?`<span>${escape(capacity)}</span>`:''}</div>${persistence?`<p class="browser-tree-save-error" role="alert">${escape(persistence)}</p>`:''}<p class="field-help">Task folders keep concurrent work separate. Suspend a page to release its memory while keeping it in its folder.</p>${tabNotice?`<p id="browser-tab-notice" class="field-help" role="status" aria-live="polite">${escape(tabNotice)}</p>`:''}<form id="browser-folder-create-form" class="browser-folder-form"><label class="sr-only" for="browser-folder-name">New folder name</label><input id="browser-folder-name" type="text" required maxlength="200" placeholder="New folder name" value="${escape(newFolderDraft)}"><button class="button" type="submit">Create folder</button></form><div class="browser-folder-list">${folders||'<p class="field-help">No folders yet.</p>'}</div>${organize}</section>`;
}

export function browserReadinessModel(signed = {}, {checking=false,unconfirmed=false}={}) {
  const background = signed.backgroundWindow;
  const linked = signed.browserConnected === true;
  const verified = !checking&&!unconfirmed&&signed.available === true && linked && background?.ready === true && background.policyVerified === true;
  return [
    {name:'Tool connection',state:signed.catalogConnected===true?'ready':signed.discovering?'pending':'offline',label:signed.catalogConnected===true?'Connected':signed.discovering?'Checking…':'Not connected'},
    {name:'Browser link',state:linked?'ready':'offline',label:linked?'Responding':'Not connected'},
    {name:'Native focus setting',state:checking?'pending':verified?'ready':background?.ready===false?'blocked':'pending',label:checking?'Checking…':verified?'Preference checked':background?.ready===false?'Needs attention':unconfirmed?'Unconfirmed':'Not checked',description:checking?'Checking Neo’s native focus preference. Results appear here when the check finishes.':verified?'Neo’s native focus preference passed the last check. Neo may still activate an external window; this is not containment.':background?.ready===false?'The native preference check did not pass. Use Activity’s contained browser for contained website work.':unconfirmed?'The latest native preference check could not be confirmed. Check background access again to get a fresh result.':'A tool connection alone does not confirm the native focus preference or prevent external window activation.',checkedAt:verified&&Number.isFinite(Date.parse(background.checkedAt))?background.checkedAt:null},
  ];
}
function readinessMarkup(signed,options,escape){return `<dl>${browserReadinessModel(signed,options).map(step=>`<div data-readiness="${step.state}"><dt>${step.name}</dt><dd><span class="browser-readiness-dot" aria-hidden="true"></span>${step.label}</dd>${step.description?`<p>${escape(step.description)}${step.checkedAt?` <time datetime="${escape(step.checkedAt)}">Checked ${escape(new Date(step.checkedAt).toLocaleTimeString())}.</time>`:''}</p>`:''}</div>`).join('')}</dl><p class="browser-background-note">Use Activity’s contained browser to work without native browser windows. Website sign-in is checked separately by the agent.</p>`;}

export function browserProfilesMarkup(state, escape = escapeHTML) {
  if (!state) return '';
  const sources = state.sources || [], imports = state.imports || [];
  return `<section class="connection-intro" aria-label="Imported browser profiles"><div><strong>Import a browser profile</strong><p>Make a separate copy of a Chrome, Edge, Brave, or Neo profile and use it with the same installed browser. Extensions, settings, history, and site storage stay together. The source profile is left unchanged.</p><p class="field-help">Close the source browser before copying. Windows or the website may reject copied sign-ins; connect the existing Chrome session above to keep its current session intact.</p></div>${sources.length ? `<form id="browser-profile-import-form"><label for="browser-profile-source">Source profile</label><select id="browser-profile-source">${sources.map(source => `<option value="${escape(source.id)}">${escape(source.name || source.browser)} · ${escape(source.profileName || source.profileDirectory)}</option>`).join('')}</select><button class="button" type="submit">Import profile</button></form>` : '<p class="field-help">No supported browser profiles were found on this computer.</p>'}${imports.length ? `<div class="browser-profile-imports">${imports.map(item => `<div class="connection-intro"><div><strong>${escape(item.name || item.source?.name || item.browser || 'Imported profile')} · ${escape(item.profileName || item.source?.profileName || item.profileDirectory || item.source?.profileDirectory || '')}</strong><p>Profile copied. Website sign-in is unverified.</p></div><button class="button" data-browser-profile-connect="${escape(item.id)}">Connect imported profile</button></div>`).join('')}</div>` : ''}</section>`;
}

export function browserWorkspaceMarkup(status, { selected, separateOpen = false, chromeSetupOpen = false, signedOpen = false, downloadsOpen=false,addressValue='',checking=false,unconfirmed=false,importNotice='',folderState=new Map(),newFolderDraft='',renameFolder=null,renameDraft='',placement=null,tabNotice='', escape = escapeHTML } = {}) {
  const tabs = Array.isArray(status.tabs) ? status.tabs : [], downloads = status.downloads || [], signed = status.signedBrowser, chrome = status.chromeBrowser, firefox = status.browsers?.firefox?.firefox;
  const hasFirefoxPages = tabs.some(tab => tab.browser === 'firefox');
  const grouped = !!signed || !!status.sessionReuse || !!chrome, chromeConnected = chrome?.connected === true;
  const independent = status.available ? `<form id="browser-open-form" class="browser-address"><label class="sr-only" for="browser-url">Web address</label><input id="browser-url" type="url" value="${escape(addressValue)}" required placeholder="https://…" spellcheck="false"><button class="button primary" type="submit">${hasFirefoxPages ? 'Open BLACKICE tab' : 'Open tab'}</button></form><p class="field-help">${hasFirefoxPages ? 'Firefox pages keep Firefox sign-ins. BLACKICE pages use a separate profile.' : 'Separate sign-ins, saved on this computer. Use the contained browser controls in Activity to sign in.'}</p>${browserTabTreeMarkup(status,{selected,folderState,newFolderDraft,renameFolder,renameDraft,placement,tabNotice,escape})}${selected ? '<div class="connection-actions"><button class="button" id="browser-preview">Refresh preview</button><button class="button" id="browser-inspect">Read page</button></div><div id="browser-preview-content" class="browser-preview-content"></div>' : ''}<details id="browser-downloads" class="browser-downloads"${downloadsOpen ? ' open' : ''}><summary>Downloads (${downloads.length})</summary>${downloads.map(d => `<div><strong>${escape(d.name)}</strong><span>${escape(d.status)}${d.status === 'completed' ? ` · ${escape(d.path)}` : ''}</span></div>`).join('') || '<p class="field-help">Downloaded files appear here.</p>'}</details>` : '<div class="browser-empty"><h3>Open the desktop app</h3><p>The desktop app includes the separate browser and its saved sign-ins.</p></div>';
  const existingSection = chrome ? `<section class="connection-intro" aria-label="Chrome connection"><div><strong>Chrome · existing profile</strong><span>${chromeConnected ? 'Connected' : 'Not connected'}</span><p>Use the current Chrome profile with its existing sign-ins, extensions, settings, and site storage. BLACKICE agents and ChatGPT share this native browser connection.</p></div><footer class="connection-actions"><button class="button primary" id="browser-chrome-connect">${chromeConnected ? 'Reconnect Chrome' : 'Connect Chrome'}</button></footer><details id="browser-chrome-setup"${chromeSetupOpen ? ' open' : ''}><summary>Connection setup</summary><p>Enable remote debugging at <code>chrome://inspect/#remote-debugging</code>, then choose Allow in Chrome’s connection prompt.</p>${!chromeConnected && chrome.reason ? `<p>${escape(chrome.reason)}</p>` : ''}</details></section>` : grouped ? '<section class="connection-intro" aria-label="Existing browser"><div><strong>Existing browser</strong><span>Direct connection</span><p>Native browser connections keep their own sign-ins and are available to agents and ChatGPT.</p></div></section>' : '';
  const readiness = signed?.nativeIntegration ? `<div id="browser-readiness-content" class="browser-readiness" role="region" aria-label="Background browser readiness">${readinessMarkup(signed,{checking,unconfirmed},escape)}</div>` : '';
  const neoImport = status.neoImport, canImport = neoImport?.available === true && neoImport.localManagement !== false;
  const importHelp = neoImport ? `<p class="field-help">${neoImport.available ? neoImport.localManagement === false ? 'Open Neo import settings from BLACKICE on this computer.' : 'Import opens a native Neo window. Choose the source browser, profile, and data there. Imported data goes to Neo; Activity’s contained browser has its own sign-ins. Some sites require signing in again.' : escape(neoImport.reason || 'Open Neo once to use its native import dialog.')}</p>${importNotice ? `<p id="browser-import-notice" class="field-help" role="status">${escape(importNotice)}</p>` : ''}` : '';
  const signedSection = signed ? `<section class="connection-intro browser-neo-intro" aria-label="BrowserOS neo"><div><strong>BrowserOS neo</strong><span>${signed.available ? 'Connected' : signed.discovering ? 'Connecting…' : signed.browserConnected?'Needs attention':'Not connected'}</span><p>${signed.available ? 'Agents and ChatGPT can use Neo with its existing and imported sign-ins.' : escape(signed.reason || 'Connect Neo to use its native browser profile.')}</p>${signed.nativeIntegration ? '<small>Native browser · may foreground a window</small>' : ''}</div>${readiness}${importHelp}<footer class="connection-actions">${canImport ? `<button class="button" id="browser-neo-import"${neoImport.capabilities?.open === false ? ' disabled' : ''}>Import into Neo…</button>` : ''}<button class="button" id="browser-reconnect">Reconnect</button>${signed.nativeIntegration&&(signed.available||signed.browserConnected)?'<button class="button primary" id="browser-check-background">Check native preference</button>':''}${!signed.available && !signed.browserConnected && (signed.canStart || typeof signed.endpoint === 'string' && signed.endpoint.trim()) ? '<button class="button primary" id="browser-start">Start external browser</button>' : ''}</footer></section>` : '';
  const firefoxSection = firefox?.available ? `<section class="connection-intro" aria-label="Firefox connection"><div><strong>Firefox</strong><span>${firefox.connected ? 'Running in background' : 'Existing profile'}</span><p>${firefox.recoveryRequired ? escape(firefox.reason) : firefox.connected ? 'Disconnect to reopen Firefox normally.' : 'Manual session controls. Agent browser work uses the contained browser in Activity.'}</p></div>${firefox.running ? '<footer class="connection-actions"><button class="button" id="browser-firefox-disconnect">Disconnect Firefox</button></footer>' : ''}</section>` : '';
  const primary = `${existingSection}${browserProfilesMarkup(status.browserProfiles, escape)}${signedSection}${firefoxSection}`;
  return `<p id="browser-ui-progress" class="browser-progress" role="status" aria-live="polite" hidden></p>${status.recovery?.required?`<p class="error-text" role="alert">${escape(status.recovery.message)}</p>`:''}${primary}${grouped ? `<details id="browser-separate" class="browser-downloads"${separateOpen ? ' open' : ''}><summary>${hasFirefoxPages ? 'Pages' : 'Separate browser'}</summary>${independent}</details>` : independent}<p id="browser-ui-error" class="error-text" role="alert"></p><div class="modal-footer"><span class="field-help">${grouped ? 'Background browser access' : 'Independent browser · saved on this computer'}</span><button class="button" data-browser-done>Done</button></div>`;
}

export async function openBrowserWorkspace({ api, toast, showModal, closeModal, escape: esc }) {
  installBrowserTreeStyles();
  const request = api; api = (path, options) => options ? request(path, options.method, options.body) : request(path);
  const escape = esc || escapeHTML;
  const $ = selector => document.querySelector(selector);
  let status, selected, busy = false, refreshRevision = 0, addressDraft='',pendingAction=null,checkUnconfirmed=false,unconfirmedAt=null,importNotice='',newFolderDraft='',renameFolder=null,renameDraft='',placement=null,tabNotice='';
  async function browserCommand(tool, args) {
    const requestId = 'browser-ui-' + globalThis.crypto.randomUUID();
    let job = await api('/api/browser/commands', { method: 'POST', body: { tool, arguments: { requestId, ...args } } });
    while (['queued', 'running', 'cancelling'].includes(job.status)) {
      await new Promise(resolve => setTimeout(resolve, 500));
      job = await api('/api/browser/commands/' + job.jobId);
    }
    if (job.status !== 'succeeded') throw new Error(job.error?.message || job.interaction?.message || job.result?.text?.text || 'The browser command did not complete. Inspect its saved receipt before retrying.');
    return job;
  }
  const folderState=new Map();
  showModal('browser-workspace', `<div class="modal-header"><div class="modal-title"><h2>Browser workspace</h2><p>Manage browser connections and browser data.</p></div><button class="icon-button" data-action="close-modal" aria-label="Close browser workspace">×</button></div><div id="browser-workspace-view">Loading browser…</div>`, true);
  $('#modal-root .modal')?.classList.add('browser-workspace-modal');
  const mount = $('#browser-workspace-view'), alive = () => mount && $('#browser-workspace-view') === mount;
  const nativeVerified=signed=>signed?.available===true&&signed.browserConnected===true&&signed.backgroundWindow?.ready===true&&signed.backgroundWindow.policyVerified===true;
  function rememberFocus(element=document.activeElement){
    if(!element||!mount?.contains?.(element))return null;
    if(element.id?.startsWith('browser-'))return{kind:'id',value:element.id,start:element.selectionStart,end:element.selectionEnd,direction:element.selectionDirection};
    for(const key of ['browserTab','browserShow','browserClose','browserSuspend','browserFolderRename','browserFolderClose'])if(element.dataset?.[key]!==undefined)return{kind:key,value:element.dataset[key]};
    const details=element.tagName==='SUMMARY'?element.closest?.('details'):null;return details?.id?{kind:'summary',value:details.id}:null;
  }
  function restoreFocus(saved){
    if(!saved||!alive())return;let target;
    if(saved.kind==='id'){target=$('#'+saved.value);if(!target&&['browser-start','browser-check-background'].includes(saved.value))target=$('#browser-check-background')||$('#browser-start')||$('#browser-reconnect');}
    else if(saved.kind==='summary')target=$('#'+saved.value)?.querySelector?.('summary');
    else target=[...document.querySelectorAll('[data-'+saved.kind.replace(/[A-Z]/g,letter=>'-'+letter.toLowerCase())+']')].find(element=>element.dataset[saved.kind]===saved.value);
    if(!target&&saved.kind==='browserSuspend')target=[...document.querySelectorAll('[data-browser-tab]')].find(element=>element.dataset.browserTab===saved.value);
    target?.focus?.({preventScroll:true});
    if(saved.kind==='id'&&Number.isInteger(saved.start))try{target?.setSelectionRange?.(saved.start,saved.end,saved.direction);}catch{}
  }
  function syncPending(){
    if(!alive())return;mount.setAttribute?.('aria-busy',String(busy));
    const progress=$('#browser-ui-progress');if(progress){progress.hidden=!pendingAction&&!checkUnconfirmed;progress.textContent=pendingAction?.message||(checkUnconfirmed?'Background access is unconfirmed. Check it again to get a fresh result.':'');progress.setAttribute?.('data-state',pendingAction?'pending':'unconfirmed');}
    for(const control of document.querySelectorAll('#browser-workspace-view button'))if(control.dataset?.browserDone===undefined&&control.dataset?.browserTab===undefined)control.disabled=busy||control.id==='browser-neo-import'&&status?.neoImport?.capabilities?.open===false;
    for(const id of ['browser-tab-folder','browser-tab-parent','browser-folder-rename-name']){const control=$('#'+id);if(control)control.disabled=busy;}
    const readiness=$('#browser-readiness-content');if(readiness&&status?.signedBrowser?.nativeIntegration)readiness.innerHTML=readinessMarkup(status.signedBrowser,{checking:pendingAction?.kind==='background',unconfirmed:checkUnconfirmed},escape);
  }
  async function refresh(observedStatus) {
    if(!alive())return false;
    const revision = ++refreshRevision, next = observedStatus||await api('/api/browser/status'); if (!alive() || revision !== refreshRevision) return;
    if(checkUnconfirmed&&nativeVerified(next.signedBrowser)&&Number.isFinite(Date.parse(next.signedBrowser.backgroundWindow.checkedAt))&&Date.parse(next.signedBrowser.backgroundWindow.checkedAt)>Date.parse(unconfirmedAt||'1970-01-01'))checkUnconfirmed=false;
    status = next;
    const tabs = Array.isArray(status.tabs) ? status.tabs : [], separateOpen = $('#browser-separate')?.open || false, chromeSetupOpen = $('#browser-chrome-setup')?.open || false, signedOpen = $('#browser-neo')?.open || false,downloadsOpen=$('#browser-downloads')?.open||false,focused=rememberFocus(),scrollTop=mount.scrollTop||0,scrollLeft=mount.scrollLeft||0;
    if($('#browser-url')?.value!==undefined)addressDraft=$('#browser-url').value;
    if($('#browser-folder-name')?.value!==undefined)newFolderDraft=$('#browser-folder-name').value;
    if($('#browser-folder-rename-name')?.value!==undefined&&$('#browser-folder-rename-name')?.dataset?.folderId===renameFolder)renameDraft=$('#browser-folder-rename-name').value;
    for(const folder of document.querySelectorAll('[data-browser-folder]'))folderState.set(folder.dataset.browserFolder,folder.open===true);
    selected = tabs.some(t => t.tabId === selected) ? selected : status.activeTab || tabs[0]?.tabId;
    mount.innerHTML = browserWorkspaceMarkup(status, { selected, separateOpen, chromeSetupOpen, signedOpen,downloadsOpen,addressValue:addressDraft,checking:pendingAction?.kind==='background',unconfirmed:checkUnconfirmed,importNotice,folderState,newFolderDraft,renameFolder,renameDraft,placement,tabNotice, escape });
    const createFolder=$('#browser-folder-create-form');
    if(createFolder)createFolder.onsubmit=event=>{event.preventDefault();return act(async()=>{const name=$('#browser-folder-name')?.value?.trim();if(!name)return;const result=await api('/api/browser/action',{method:'POST',body:{action:'folder_create',name}});if(!alive())return;if($('#browser-folder-name')?.value?.trim()===name){newFolderDraft='';$('#browser-folder-name').value='';}const folderId=result.folder?.id||result.id;if(folderId)folderState.set(folderId,true);await refresh();},createFolder.querySelector?.('button'),'Creating…','folder');};
    document.querySelectorAll('[data-browser-folder-rename]').forEach(button=>button.onclick=()=>{if(busy||!alive())return;renameFolder=button.dataset.browserFolderRename;renameDraft=status.folders.find(folder=>folder.id===renameFolder)?.name||'';refresh(status).then(()=>{if(alive())$('#browser-folder-rename-name')?.focus?.({preventScroll:true});});});
    const renameForm=$('#browser-folder-rename-form');
    if(renameForm)renameForm.onsubmit=event=>{event.preventDefault();return act(async()=>{const folderId=renameFolder,name=$('#browser-folder-rename-name')?.value?.trim();if(!name)return;await api('/api/browser/action',{method:'POST',body:{action:'folder_rename',folderId,name}});if(!alive())return;renameFolder=null;await refresh();},renameForm.querySelector?.('button'),'Saving…','folder');};
    const cancelRename=$('#browser-folder-rename-cancel');if(cancelRename)cancelRename.onclick=()=>{renameFolder=null;return refresh(status);};
    document.querySelectorAll('[data-browser-folder-close]').forEach(button=>button.onclick=()=>act(async()=>{await api('/api/browser/action',{method:'POST',body:{action:'folder_close',folderId:button.dataset.browserFolderClose}});await refresh();},button,'Closing…','folder'));
    const placementForm=$('#browser-tab-placement-form'),folderSelect=$('#browser-tab-folder');
    if(folderSelect)folderSelect.onchange=()=>{placement={tabId:selected,folderId:folderSelect.value,parentTabId:null};return refresh(status);};
    if(placementForm)placementForm.onsubmit=event=>{event.preventDefault();return act(async()=>{const tabId=selected,folderId=$('#browser-tab-folder')?.value,parentTabId=$('#browser-tab-parent')?.value||null;await api('/api/browser/action',{method:'POST',body:{action:'tab_move',tabId,folderId,parentTabId}});if(!alive())return;placement=null;await refresh();},placementForm.querySelector?.('button'),'Moving…','folder');};
    const reconnect = $('#browser-reconnect'), start = $('#browser-start'), checkBackground = $('#browser-check-background'), chromeConnect = $('#browser-chrome-connect'), form = $('#browser-open-form');
    const profileForm = $('#browser-profile-import-form');
    if (profileForm) profileForm.onsubmit = event => { event.preventDefault(); const sourceId = $('#browser-profile-source')?.value; if (!sourceId) return; return act(async () => { await browserCommand('blackice_profile_import', { sourceId }); await refresh(); }, profileForm.querySelector?.('button'), 'Copying profile…', 'profile'); };
    document.querySelectorAll('[data-browser-profile-connect]').forEach(button => button.onclick = () => act(async () => { await browserCommand('blackice_profile_connect', { importId: button.dataset.browserProfileConnect }); await refresh(); }, button, 'Connecting profile…', 'profile-connect'));
    if (chromeConnect) chromeConnect.onclick = () => act(async () => { await api('/api/browser/chrome/connect', { method: 'POST', body: {} }); if (!alive()) return; await refresh(); if (alive() && status.chromeBrowser?.connected !== true && $('#browser-chrome-setup')) $('#browser-chrome-setup').open = true; }, chromeConnect, 'Connecting…','chrome');
    const importNeo = $('#browser-neo-import');
    if (importNeo) importNeo.onclick = () => act(async () => {
      const receipt = await api('/api/browser/neo/import', { method: 'POST', body: {} });
      if (!alive()) return;
      if (receipt?.requested !== true || receipt.destination !== 'neo' || receipt.importCompleted !== false) throw new Error('Neo did not confirm the import-settings request. Check its window before trying again.');
      importNotice = 'Neo import settings were requested. Review and run any import in Neo. BLACKICE has not verified an import.';
      await refresh();
    }, importNeo, 'Opening Neo…', 'import');
    const disconnectFirefox = $('#browser-firefox-disconnect');
    if (disconnectFirefox) disconnectFirefox.onclick = () => act(async () => { await api('/api/browser/firefox/disconnect', { method: 'POST', body: {} }); await refresh(); }, disconnectFirefox, 'Saving Firefox…','firefox');
    if (reconnect) reconnect.onclick = () => act(async () => { await api('/api/browser/reconnect', { method: 'POST', body: {} }); await refresh(); }, reconnect, 'Connecting…','reconnect');
    async function checkBackgroundAccess() {
      unconfirmedAt=status?.signedBrowser?.backgroundWindow?.checkedAt||null;checkUnconfirmed=true;syncPending();let failure,result;
      try{result=await api('/api/browser/start',{method:'POST',body:{}});}catch(error){failure=error;}
      if(!alive())return;
      if(nativeVerified(result?.signedBrowser)){checkUnconfirmed=false;await refresh(result);}
      try{const refreshed=await refresh();if(!failure&&refreshed&&nativeVerified(status.signedBrowser))checkUnconfirmed=false;}catch(error){failure=failure?new Error(String(failure.message||'The background check did not complete.')+' Current status could not be refreshed.'):error;}
      if(failure)throw failure;
    }
    if (start) start.onclick = () => act(checkBackgroundAccess, start, 'Starting…','background');
    if (checkBackground) checkBackground.onclick = () => act(checkBackgroundAccess, checkBackground, 'Checking…','background');
    if (form) form.onsubmit = async event => { event.preventDefault(); await act(async () => {const url=$('#browser-url')?.value||'';const result = await api('/api/browser/action', { method: 'POST', body: { action: 'open', url } });if(!alive())return;if($('#browser-url')?.value===url){addressDraft='';$('#browser-url').value='';}selected = result.tabId; await refresh(); },form.querySelector?.('button'),'Opening…','open'); };
    $('[data-browser-done]').onclick = closeModal;
    document.querySelectorAll('[data-browser-tab]').forEach(b => b.onclick = () => {if(!alive())return; selected = b.dataset.browserTab; refresh().catch(e => {if(alive()&&$('#browser-ui-error'))$('#browser-ui-error').textContent=e.message;}); });
    document.querySelectorAll('[data-browser-show]').forEach(b => b.onclick = () => act(() => api('/api/browser/show', { method: 'POST', body: { tabId: b.dataset.browserShow } }),b,'Opening…','show'));
    document.querySelectorAll('[data-browser-close]').forEach(b => b.onclick = () => act(async () => { await api('/api/browser/action', { method: 'POST', body: { action: 'close', tabId: b.dataset.browserClose } }); await refresh(); },b,'Closing…','close'));
    document.querySelectorAll('[data-browser-suspend]').forEach(button=>button.onclick=()=>act(async()=>{
      const tabId=button.dataset.browserSuspend;let result,failure;
      try{result=await api('/api/browser/action',{method:'POST',body:{action:'suspend',browser:'relay',tabId}});}catch(error){failure=error;}
      await refresh();if(!alive())return;if(failure)throw failure;
      tabNotice=browserSuspensionOutcome({...status,...(result?.receipt?{receipt:result.receipt}:{})},tabId).message;
      await refresh(status);
    },button,'Suspending…','suspend'));
    if (selected && status.available) {
      $('#browser-preview').onclick = () => act(async () => { const tabId = selected, value = await api('/api/browser/action', { method: 'POST', body: { action: 'screenshot', tabId } }); if (!alive() || selected !== tabId) return; const target = $('#browser-preview-content'); if (target) { target.replaceChildren(); const img = document.createElement('img'); img.src = value.imageUrl; img.alt = 'Current agent browser page'; target.append(img); } },$('#browser-preview'),'Capturing…','preview');
      $('#browser-inspect').onclick = () => act(async () => { const tabId = selected, value = await api('/api/browser/action', { method: 'POST', body: { action: 'read', tabId } }); if (!alive() || selected !== tabId) return; const target = $('#browser-preview-content'); if (target) { target.replaceChildren(); const pre = document.createElement('pre'); pre.textContent = value.frames.map(f => `${f.title}\n${f.url}\n\n${f.text}`).join('\n\n'); target.append(pre); } },$('#browser-inspect'),'Reading…','read');
    }
    syncPending();mount.scrollTop=scrollTop;mount.scrollLeft=scrollLeft;restoreFocus(focused);return true;
  }
  async function act(fn, button, workingLabel,kind='action') {
    if (!alive()||busy) return;const origin=button===document.activeElement?rememberFocus(button):null;busy = true;
    const messages={folder:'Updating browser folders…',import:'Opening Neo import settings…',profile:'Copying the selected browser profile…','profile-connect':'Connecting the imported browser profile…',background:'Checking background access…',reconnect:'Reconnecting browser tools…',chrome:'Connecting Chrome…',firefox:'Saving Firefox session…',open:'Opening page…',show:'Opening the selected window…',close:'Closing selected page…',suspend:'Suspending selected page…',preview:'Capturing page preview…',read:'Reading page…'};
    pendingAction={kind,message:(messages[kind]||'Working…')+' You can switch workspaces while this finishes.'};const label = button?.textContent;
    if (button) { button.disabled = true; button.textContent = workingLabel || label; }
    syncPending();try { tabNotice='';if($('#browser-tab-notice'))$('#browser-tab-notice').textContent='';if (alive() && $('#browser-ui-error')) $('#browser-ui-error').textContent = ''; await fn(); }
    catch (e) { if (alive() && $('#browser-ui-error')) $('#browser-ui-error').textContent = e.message; }
    finally { busy = false;pendingAction=null; if (button?.isConnected) { button.disabled = false; button.textContent = label; }syncPending();const active=document.activeElement;if(origin&&alive()&&(!active||active===document.body||active===mount||active===button||active.isConnected===false))restoreFocus(origin); }
  }
  try { await refresh(); } catch (e) { if (alive()) mount.textContent = e.message; }
}
