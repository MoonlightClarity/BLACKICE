/** Workbench is a launcher and setup page. The native window owns the desktop. */
import {workbenchSetupGuideMarkup} from './workbench-guide.mjs';
export function createWorkbenchWorkspace({mount,api,notify=()=>{}}){
  // Cancel any legacy embedded media before replacing an older mounted view.
  for(const media of mount.querySelectorAll('img,video,iframe')){media.onload=null;media.onerror=null;media.removeAttribute('src');media.load?.();}
  mount.innerHTML=[
    '<div class="next-panel next-workbench" data-workbench-view="launcher-v2"><div class="next-panel-inner wb-launcher-page">',
    '<header class="next-panel-head"><div><h1>Workbench</h1><p>Your Windows desktop, connected to BLACKICE.</p></div><button id="wb-refresh" type="button">Refresh</button></header>',
    '<section class="next-card wb-launch-card" aria-labelledby="wb-launch-title">',
    '<div class="wb-launch-heading"><h2 id="wb-launch-title">Windows Workbench</h2><span id="wb-state" class="next-status-pill" role="status">Checking VM…</span></div>',
    '<p>Open Windows in its own window. Your apps, files, and guest session stay in the same VM.</p>',
    '<div class="next-row wb-launch-actions"><button id="wb-open-window" class="next-primary" type="button" disabled>Open Workbench</button><button id="wb-start" type="button" disabled hidden>Start VM</button></div>',
    '<p id="wb-window-status" class="next-help" role="status">Checking Workbench…</p>',
    '<p class="next-help wb-controls-note">Controls are in Workbench. Its toolbar has control, power, clipboard, and window sizing.</p>',
    '<p class="next-help">Closing that window hides it. Windows keeps running.</p></section>',
    '<section class="next-card wb-connection-card" aria-label="Connection status"><dl class="wb-connection-summary">',
    '<div><dt>Guest connection</dt><dd id="wb-guest-status">Checking…</dd></div>',
    '<div><dt>Shared workspace</dt><dd id="wb-files-status">Checking…</dd></div>',
    '<div><dt>Input control</dt><dd id="wb-owner-status">Checking…</dd></div></dl></section>',
    '<p id="wb-error" role="alert" class="next-card wb-feedback-error" hidden></p>',
    '<details id="wb-vm-settings" class="next-card wb-advanced-setup"><summary>Advanced setup</summary>',
    '<p class="next-help wb-setup-intro">Configure Windows, shared folders, and installed apps. Existing guest files and VM state are preserved.</p>',
    workbenchSetupGuideMarkup,
    '<section class="next-card"><h2>Setup readiness</h2><ul id="wb-blockers" class="wb-blockers"></ul>',
    '<details class="wb-host-details"><summary>Computer details</summary><dl id="wb-host" class="wb-details"></dl></details></section>',
    '<div class="wb-setup-grid"><section class="next-card"><h2>Windows installation</h2>',
    '<label class="next-label">Windows installation ISO<input id="wb-iso-path" class="next-field" placeholder="C:\\Users\\…\\Downloads\\Win11.iso" spellcheck="false"></label>',
    '<div class="next-row wb-field-actions"><button id="wb-save-iso" type="button">Save ISO path</button><button id="wb-find-iso" type="button">Find existing ISO</button></div>',
    '<p id="wb-media-status" class="next-help"></p><div id="wb-media-candidates" class="next-stack" aria-live="polite"></div>',
    '<div class="next-row"><button id="wb-provision" type="button" disabled>Provision Windows guest</button><a href="https://www.microsoft.com/software-download/windows11" target="_blank" rel="noopener noreferrer">Official ISO download</a></div></section>',
    '<section class="next-card"><h2>Shared folders</h2><div id="wb-folders" class="wb-folder-list"></div>',
    '<form id="wb-add-folder" class="wb-folder-form"><label class="next-label">Additional existing host folder<input class="next-field" id="wb-host-path" placeholder="C:\\Users\\…\\Documents" spellcheck="false" required></label>',
    '<label class="wb-checkbox"><input type="checkbox" id="wb-read-write" checked>Read and write</label><button type="submit">Add mapping</button></form></section></div>',
    '<section class="next-card"><h2>Guest connection</h2><p id="wb-guest-setup" class="next-help"></p>',
    '<div class="next-row"><button id="wb-prepare-agent" type="button">Prepare guest files</button><button id="wb-pair" type="button" disabled>Pair &amp; auto-repair</button></div><pre id="wb-setup-output" class="wb-setup-output" hidden></pre></section>',
    '<section class="next-card"><h2>Installed apps</h2><p class="next-help">Rescan and install missing guest apps without rebuilding Windows.</p>',
    '<div class="next-row"><button id="wb-apps-scan" type="button">Rescan &amp; discover installers</button><button id="wb-apps-rebatch" type="button" disabled>Rescan &amp; install missing</button>',
    '<button id="wb-apps-retry" type="button" disabled>Re-batch saved inventory</button><button id="wb-apps-review" type="button" disabled>Review installer matches</button></div>',
    '<p id="wb-apps-status" class="next-help" role="status">Open Advanced setup to inspect saved app inventory.</p><div id="wb-apps-runs" class="wb-apps-runs"></div><pre id="wb-apps-details" class="wb-setup-output" hidden></pre></section>',
    '</details></div></div>'
  ].join('');
  const names=['refresh','state','open-window','start','window-status','guest-status','files-status','owner-status','error','vm-settings','host','blockers',
    'iso-path','save-iso','find-iso','provision','media-status','media-candidates','folders','add-folder','host-path','read-write',
    'prepare-agent','pair','guest-setup','setup-output','apps-scan','apps-rebatch','apps-retry','apps-review','apps-status','apps-runs','apps-details'];
  const els=Object.fromEntries(names.map(name=>[name,mount.querySelector('#wb-'+name)]));
  const nativeBridge=typeof globalThis.relayDesktop?.vmSurface==='function'?request=>globalThis.relayDesktop.vmSurface(request):null;
  let active=false,destroyed=false,loading=false,pending=false,serial=0,generation=0,status=null,timer=null,nativeTimer=null;
  let nativeAvailable=false,nativeChecked=false,nativeBusy=false,nativeStatusBusy=false,nativeReceipt=null,nativeFailure=null;
  let appSync=null,appSyncBusy=false,appSyncRevision=0,mediaBusy=false,mediaDraftDirty=false;
  const make=(tag,text,cls)=>{const el=document.createElement(tag);if(text!=null)el.textContent=String(text);if(cls)el.className=cls;return el;};
  const current=value=>active&&!destroyed&&value===generation;
  const showError=error=>{if(destroyed)return;els.error.hidden=!error;els.error.textContent=error?String(error.message||error):'';if(error)notify('Workbench: '+els.error.textContent,true);};
  function lock(){
    els.refresh.disabled=loading||pending;
    els['open-window'].disabled=!active||pending||loading||nativeBusy||!nativeAvailable||!status?.canReadGuestConsole||status?.consoleControl?.owner==='none';
    els['open-window'].textContent=nativeBusy?'Opening Workbench…':nativeReceipt?.connected===true?'Show Workbench':'Open Workbench';
    els.start.hidden=status?.canStart!==true;els.start.disabled=!active||pending||loading||status?.canStart!==true;
    els['prepare-agent'].disabled=pending||loading||!status?.canPrepareAgent;els.pair.disabled=pending||loading||!status?.guest?.running||!status?.capability?.canManageVM||!status?.canReadGuestConsole;
    els.provision.disabled=pending||loading||!status?.canProvision;
    els['save-iso'].disabled=pending||loading||!status;els['find-iso'].disabled=pending||loading||mediaBusy;
    for(const button of els['media-candidates'].querySelectorAll('button'))button.disabled=pending||mediaBusy;
    els['iso-path'].disabled=pending;els['host-path'].disabled=pending;els['read-write'].disabled=pending;
    els['add-folder'].querySelector('button').disabled=pending||!status;
    for(const button of els.folders.querySelectorAll('button'))button.disabled=pending;
    els['apps-scan'].disabled=pending||appSyncBusy;
    els['apps-review'].disabled=pending||appSyncBusy||!appSync?.currentSnapshot?.recovery;
    const ready=Boolean(status?.canRunNativeApps&&status?.guest?.agent?.capabilities?.includes('batch_install'));
    els['apps-rebatch'].disabled=pending||appSyncBusy||!ready;els['apps-retry'].disabled=pending||appSyncBusy||!ready||!appSync?.currentSnapshot;
  }
  function paintWindow(){
    const guest=status?.guest;
    els.state.textContent=guest?.running?'Windows running':guest?.state==='Off'?'VM is off':guest?.exists?'VM '+guest.state:'Setup needed';
    els.state.dataset.state=guest?.running?'running':guest?.state==='Off'?'off':'waiting';
    let text=nativeBusy?'Opening Workbench…':nativeFailure;
    if(!text){
      if(status?.consoleControl?.owner==='none')text='Input is unavailable. Reopen BLACKICE to reconnect Workbench.';
      else if(!nativeBridge||nativeChecked&&!nativeAvailable)text='The separate Workbench window is unavailable on this installation.';
      else if(!guest?.running)text=guest?.state==='Off'?'Start the VM, then open Workbench.':'Complete Advanced setup to open Windows.';
      else if(nativeReceipt?.connected&&nativeReceipt.windowMinimized)text='Workbench is minimized. Show Workbench restores its window.';
      else if(nativeReceipt?.connected&&!nativeReceipt.windowVisible)text='Workbench is hidden. Show Workbench returns to the same session.';
      else if(nativeReceipt?.connected)text='Workbench is open in its own window.';
      else text='Ready to open in a separate window.';
    }
    els['window-status'].textContent=text;
    const owner=['agent','user'].includes(nativeReceipt?.inputOwner)?nativeReceipt.inputOwner:status?.consoleControl?.owner;
    els['owner-status'].textContent=owner==='user'?'You control Windows':owner==='agent'?'Agent controls Windows':'Input unavailable';
    lock();
  }
  function detail(label,value){els.host.append(make('dt',label),make('dd',value));}
  function paint(){
    if(!status||destroyed)return;const c=status.capability||{},guest=status.guest||{},agent=guest.agent||{},folders=status.config?.folders||[];
    els.host.replaceChildren();detail('Windows',c.edition||'Not detected');detail('Hyper-V',c.hyperVFeatureEnabled?'Enabled':'Unavailable');
    detail('VM management',c.canManageVM?'Available':'Unavailable');detail('Permissions',c.processElevated?'Administrator access':'Standard access');detail('VM service',c.vmServiceRunning?'Running':'Unavailable');
    if(!mediaDraftDirty)els['iso-path'].value=status.config?.mediaPath||'';
    els['media-status'].textContent=mediaDraftDirty?'ISO path has unsaved changes.':status.media?.valid?'Saved installation media validated.':status.media?.error||'Choose an existing Windows installation ISO.';
    els.folders.replaceChildren();
    for(const folder of folders){const row=make('div',null,'wb-folder'),info=make('div');info.append(make('strong',folder.hostPath));
      info.append(make('p',(folder.readWrite?'Read/write':'Read-only')+' · '+folder.expectedGuestUNC,'next-help'));
      info.append(make('small',folder.hostSharePrepared&&folder.guestMountVerified?'Guest mount verified':'Configuration saved · guest mount not verified','next-muted'));row.append(info);
      if(folder.id!=='workspace'){const remove=make('button','Remove mapping');remove.type='button';remove.addEventListener('click',()=>void updateConfig({folders:folders.filter(item=>item.id!==folder.id).map(({id,hostPath,shareName,readWrite})=>({id,hostPath,shareName,readWrite}))}));row.append(remove);}els.folders.append(row);}
    els.blockers.replaceChildren();for(const note of status.blockers?.length?status.blockers:['Guest prerequisites are ready.'])els.blockers.append(make('li',note));
    els['guest-status'].textContent=agent.paired?'Paired · session '+agent.guestSessionId:guest.running?'Pairing needed':'Windows not running';
    els['files-status'].textContent=agent.sharedReadWriteVerified?'Connected':folders.some(folder=>folder.guestMountVerified)?'Guest mount verified':'Setup needed';
    els['guest-setup'].textContent=agent.paired?'The interactive guest and shared workspace are paired.':
      'Select Pair & auto-repair. BLACKICE provisions the host share login, copies setup through Hyper-V, and maintains W: across login, resume and host-IP changes.';
    paintWindow();
  }
  function paintAppSync(){
    els['apps-runs'].replaceChildren();
    const snapshot=appSync?.currentSnapshot;
    const runs=appSync?.runs||[];
    els['apps-status'].textContent=snapshot?
      'Host inventory: '+snapshot.packageCount+' winget-recognized packages · '+
        (snapshot.recovery?.resolvedCount||0)+' additional exact-name matches · captured '+
        new Date(snapshot.createdAt).toLocaleString()+
        ' · '+(snapshot.unmatchedCount||0)+' originally unmatched entries · '+
        (snapshot.recovery?.status==='completed'?'catalog search completed':
          snapshot.recovery?.status==='running'?'catalog lookup in progress':'installer discovery not yet completed'):
      'No host app inventory captured yet. Select Rescan host apps; this does not install anything on the host.';
    if(snapshot?.unmatchedHostApps?.length){
      const missing=make('p','Unmatched host software (not automatically installed by winget): '+
        snapshot.unmatchedHostApps.slice(0,12).join(' · ')+
        (snapshot.unmatchedCount>12?' · '+(snapshot.unmatchedCount-12)+' more':''),'next-help');
      els['apps-runs'].append(missing);
    }
    if(snapshot?.warning){
      const note=make('p','Export warnings: '+snapshot.warning.slice(0,450),'next-help');
      els['apps-runs'].append(note);
    }
    if(!runs.length){
      els['apps-runs'].append(make('p','No guest app-install batches have been recorded.','next-muted'));
      lock();return;
    }
    for(const run of runs.slice(0,8)){
      const summary=Object.entries(run.counts||{}).map(([name,count])=>name+': '+count).join(' · ');
      const row=make('div',null,'wb-app-run');
      const label=make('div');
      label.append(make('strong',new Date(run.createdAt).toLocaleString()+' · '+run.status));
      label.append(make('p',(summary||'Guest results pending')+' · '+run.totalPackages+' packages','next-help'));
      const inspect=make('button','Inspect results');
      inspect.type='button';
      inspect.addEventListener('click',()=>void openAppBatch(run.runId));
      row.append(label,inspect);
      els['apps-runs'].append(row);
    }
    lock();
  }
  async function openAppBatch(runId){
    try{
      const result=await api('/api/workbench/app-sync/runs/'+runId,'GET');
      const issues=(result.packages||[]).filter(p=>!['already_present','installed'].includes(p.status));
      els['apps-details'].hidden=false;
      els['apps-details'].textContent=JSON.stringify({
        runId:result.runId,status:result.status,counts:result.counts,
        message:result.message||'',unresolvedPackages:issues.slice(0,35),
        totalUnresolved:issues.length,
        note:issues.length>35?'Further exceptions remain in the saved batch run record.':undefined
      },null,2).slice(0,9000);
    }catch(error){showError(error)}
  }
  async function loadAppSync(){
    const n=++appSyncRevision;
    try{
      const value=await api('/api/workbench/app-sync','GET');
      if(!destroyed&&n===appSyncRevision){
        appSync=value;paintAppSync();
        if(value.runs?.[0]&&['completed','partial','uncertain'].includes(value.runs[0].status))
          await openAppBatch(value.runs[0].runId);
      }
    }catch(error){
      if(!destroyed&&n===appSyncRevision)showError(error);
    }
  }
  async function openRecovery(){
    const id=appSync?.currentSnapshot?.snapshotId;
    if(!id)return;
    try{
      const result=await api('/api/workbench/app-sync/recovery/'+id,'GET');
      els['apps-details'].hidden=false;
      els['apps-details'].textContent=JSON.stringify({
        snapshotId:result.snapshotId,status:result.status,counts:result.counts,
        addedToGuestImport:result.added,issues:(result.decisions||[])
          .filter(row=>row.status!=='resolved_exact')
          .map(row=>({name:row.name,status:row.status,reason:row.reason,
            suggestions:(row.candidates||[]).slice(0,3)}))
      },null,2).slice(0,35000);
    }catch(error){showError(error)}
  }
  async function executeAppSync(operation){
    if(pending||appSyncBusy)return;
    appSyncBusy=true;showError(null);lock();
    try{
      const route=operation==='scan'?'/api/workbench/app-sync/export':
        operation==='retry'?'/api/workbench/app-sync/start':'/api/workbench/app-sync/rebatch';
      let outcome=await api(route,'POST',{}, {deadlineMs:240000});
      if(operation==='scan'&&outcome?.snapshotId){
        els['apps-status'].textContent='Searching installer sources for applications absent from winget export…';
        const recovery=await api('/api/workbench/app-sync/discover','POST',
          {snapshotId:outcome.snapshotId},{deadlineMs:240000});
        outcome={inventory:{snapshotId:outcome.snapshotId,packageCount:outcome.packageCount,
          unmatchedCount:outcome.unmatchedCount},
          discovery:{status:recovery.status,counts:recovery.counts,added:recovery.added,
            importCount:recovery.importCount}};
      }
      els['apps-details'].hidden=false;
      els['apps-details'].textContent=JSON.stringify(outcome,null,2).slice(0,8000);
      await loadAppSync();
    }catch(error){
      showError(error);
      // A request timing out does not mean the guest installation was rolled
      // back. Read the saved run identity; never automatically replay it.
      await loadAppSync();
    }finally{appSyncBusy=false;lock()}
  }

  async function refresh(){
    const n=++serial;loading=true;lock();
    try{const result=await api('/api/workbench','GET');if(!destroyed&&n===serial){status=result;showError(null);paint();}}
    catch(error){if(!destroyed&&n===serial)showError(error)}finally{if(n===serial){loading=false;if(!destroyed)lock();}}
  }
  async function mutate(route,body){
    if(pending||!active||!status)return null;pending=true;showError(null);lock();
    try{const value=await api(route,'POST',body);if(!destroyed){status=value;paint();}return value;}
    catch(error){if(!destroyed){showError(error);await refresh();}return null;}finally{pending=false;if(!destroyed)lock();}
  }
  async function updateConfig(change){if(!status)return null;return mutate('/api/workbench/config',{expectedRevision:status.config.revision,...change});}
  async function saveMediaPath(value){
    mediaDraftDirty=true;els['iso-path'].value=value;const result=await updateConfig({mediaPath:value});
    if(result?.config?.mediaPath===value&&els['iso-path'].value===value){mediaDraftDirty=false;paint();}
  }
  async function setupOperation(route){
    if(pending||!active)return;pending=true;showError(null);lock();
    try{const result=await api(route,'POST',{}, {deadlineMs:route.endsWith('/auto-pair')?105000:30000});if(!destroyed){els['setup-output'].hidden=false;els['setup-output'].textContent=JSON.stringify(result,null,2).slice(0,4200);await refresh();}}
    catch(error){showError(error)}finally{pending=false;if(!destroyed)lock();}
  }
  async function readNativeCapability(value){
    const capability=nativeBridge?await nativeBridge({action:'capability'}):null;if(!current(value))return;
    nativeChecked=true;nativeAvailable=capability?.available===true&&capability.accepted===true&&capability.fullAcceptance===false&&
      (capability.localPreview===true||capability.acceptanceScope==='local-preview')&&
      (capability.detachedWindow===true||capability.detached===true||capability.renderer==='freerdp-detached');paintWindow();
  }
  async function readNativeStatus(value=generation){
    if(!current(value)||nativeStatusBusy||nativeBusy||!nativeAvailable||!nativeBridge)return;nativeStatusBusy=true;
    try{const receipt=await nativeBridge({action:'status'});if(current(value)){nativeReceipt=receipt;nativeFailure=null;paintWindow();}}
    catch{if(current(value)){nativeFailure='Workbench status is unavailable. Refresh to try again.';paintWindow();}}
    finally{nativeStatusBusy=false;}
  }
  async function openWorkbench(){
    if(els['open-window'].disabled||!active||destroyed||nativeBusy)return;
    const value=generation;nativeBusy=true;nativeFailure=null;showError(null);paintWindow();
    try{const before=await nativeBridge({action:'status'});
      const receipt=before?.connected===true&&before.displayReady===true?await nativeBridge({action:'visible',visible:true}):await nativeBridge({action:'attach'});
      if(receipt?.detached!==true||receipt.connected!==true||receipt.displayReady!==true)throw Error('The separate Workbench window did not confirm its connection.');
      if(current(value)){nativeReceipt=receipt;nativeFailure=null;}
    }catch(error){if(current(value)){nativeFailure=String(error.message||error);showError(error);}}
    finally{nativeBusy=false;if(current(value))paintWindow();}
  }
  async function findMedia(){
    if(pending||mediaBusy||!active)return;mediaBusy=true;lock();els['media-candidates'].replaceChildren(make('p','Checking existing Windows installation media…','next-help'));
    try{const result=await api('/api/workbench/media','GET');if(destroyed)return;const candidates=result.candidates||[];els['media-candidates'].replaceChildren();
      if(!candidates.length)els['media-candidates'].append(make('p','No installation ISO found. Choose Microsoft’s official download or enter an existing path.','next-help'));
      else if(candidates.length===1){await saveMediaPath(candidates[0].path);els['media-candidates'].append(make('p',status?.media?.valid?'Existing ISO saved and validated.':'ISO found. Check the saved path and readiness.','next-help'));}
      else for(const item of candidates){const button=make('button','Use '+item.path+' · '+(item.size/(1024**3)).toFixed(2)+' GiB');button.type='button';button.addEventListener('click',()=>void saveMediaPath(item.path));els['media-candidates'].append(button);}
    }catch(error){showError(error)}finally{mediaBusy=false;if(!destroyed)lock();}
  }
  els.refresh.addEventListener('click',()=>void refresh());
  els['open-window'].addEventListener('click',()=>void openWorkbench());
  els.start.addEventListener('click',()=>{if(status?.canStart)void mutate('/api/workbench/start',{});});
  els['iso-path'].addEventListener('input',()=>{mediaDraftDirty=true;els['media-status'].textContent='ISO path has unsaved changes.';});
  els['save-iso'].addEventListener('click',()=>void saveMediaPath(els['iso-path'].value.trim()));
  els['find-iso'].addEventListener('click',()=>void findMedia());
  els.provision.addEventListener('click',()=>void mutate('/api/workbench/provision',{}));
  els['prepare-agent'].addEventListener('click',()=>void setupOperation('/api/workbench/prepare-agent'));
  els.pair.addEventListener('click',()=>void setupOperation('/api/workbench/auto-pair'));
  els['vm-settings'].addEventListener('toggle',()=>{if(active&&els['vm-settings'].open)void loadAppSync();});
  els['apps-scan'].addEventListener('click',()=>void executeAppSync('scan'));
  els['apps-rebatch'].addEventListener('click',()=>void executeAppSync('rebatch'));
  els['apps-retry'].addEventListener('click',()=>void executeAppSync('retry'));
  els['apps-review'].addEventListener('click',()=>void openRecovery());
  els['add-folder'].addEventListener('submit',event=>{event.preventDefault();if(!status)return;const hostPath=els['host-path'].value.trim();if(!hostPath)return;
    const name=hostPath.split(/[\\/]/).filter(Boolean).at(-1)||'Folder',slug=name.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,24)||'folder';
    let id=slug,index=2;while(status.config.folders.some(folder=>folder.id===id))id=slug+'-'+index++;
    const folders=status.config.folders.map(({id,hostPath,shareName,readWrite})=>({id,hostPath,shareName,readWrite}));
    folders.push({id,hostPath,shareName:'BLACKICE-'+id,readWrite:els['read-write'].checked});
    void updateConfig({folders}).then(result=>{if(result?.config?.folders.some(folder=>folder.id===id))els['host-path'].value='';});
  });
  return {
    enter(){if(active||destroyed)return;active=true;const value=++generation;lock();
      void refresh().then(async()=>{if(!current(value))return;await readNativeCapability(value);await readNativeStatus(value);}).catch(error=>{if(current(value))showError(error);});
      if(els['vm-settings'].open)void loadAppSync();
      nativeTimer=setInterval(()=>{if(active)void readNativeStatus();},1000);
      timer=setInterval(()=>{if(active&&!pending){void refresh();if(els['vm-settings'].open&&!appSyncBusy)void loadAppSync();}},15000);},
    leave(){active=false;++generation;clearInterval(timer);timer=null;clearInterval(nativeTimer);nativeTimer=null;},
    destroy(){this.leave();destroyed=true;++serial;++appSyncRevision;mount.replaceChildren();}
  };
}
