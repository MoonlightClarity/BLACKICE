const size = bytes => {
  if (!Number.isFinite(bytes) || bytes < 0) return 'Unavailable';
  if (bytes < 1024) return bytes + ' B';
  const units = ['KiB','MiB','GiB','TiB'];
  let value = bytes, unit = -1;
  do { value /= 1024; unit++; } while (value >= 1024 && unit < units.length - 1);
  return value.toLocaleString(undefined, { maximumFractionDigits: 2 }) + ' ' + units[unit];
};

export function createStorageSettings({ mount, api, notify = () => {} }) {
  mount.innerHTML = [
    '<section class="next-card"><h2>Storage &amp; Data</h2>',
    '<p class="next-help">Inspect what BLACKICE has saved locally. Clearing data is permanent and happens on the next BLACKICE startup, before saved state is loaded. Nothing is deleted by selecting a checkbox.</p>',
    '<div class="next-row"><button type="button" id="storage-refresh">Measure disk usage</button>',
    '<span class="next-help" id="storage-total" role="status"></span></div>',
    '<div id="storage-categories" class="next-settings-grid"></div>',
    '<p class="next-help" id="storage-external"></p></section>',
    '<section class="next-card"><h2>Clear selected data</h2>',
    '<p class="next-help">Choose only the categories you want to remove. Clearing conversations does not automatically delete unrelated workspaces, and deleting action receipts also removes evidence used to avoid repeating previous operations.</p>',
    '<p class="next-help" id="storage-pending"></p>',
    '<label class="next-label" for="storage-confirm">Type DELETE SELECTED DATA to confirm</label>',
    '<input class="next-field" id="storage-confirm" autocomplete="off" spellcheck="false" placeholder="DELETE SELECTED DATA">',
    '<div class="next-row"><button type="button" class="next-primary" id="storage-schedule" disabled>Queue cleanup for next restart</button>',
    '<button type="button" id="storage-cancel" hidden>Cancel queued cleanup</button></div>',
    '<p id="storage-feedback" class="next-help" role="status" aria-live="polite"></p></section>',
    '<section class="next-card"><h2>Automatic temporary-data cleanup</h2>',
    '<label class="next-row"><input type="checkbox" id="storage-auto">',
    'Clear rebuildable temporary and diagnostic data when BLACKICE starts</label>',
    '<p class="next-help">Does not automatically delete chats, workspaces, action receipts, media, credentials, or the virtual machine.</p>',
    '<div class="next-row"><button type="button" id="storage-save-policy">Save cleanup preference</button>',
    '<span class="next-help" id="storage-policy-feedback" role="status"></span></div></section>',
    '<section class="next-card"><h2>Most recent cleanup</h2><p class="next-help" id="storage-report">No cleanup has been recorded.</p></section>'
  ].join('');
  const $ = id => mount.querySelector('#'+id);
  const refreshButton = $('storage-refresh'), list = $('storage-categories');
  const confirm = $('storage-confirm'), schedule = $('storage-schedule'), cancel = $('storage-cancel');
  const auto = $('storage-auto'), savePolicy = $('storage-save-policy');
  let active = false, destroyed = false, busy = false, snapshot = null, readSequence = 0;
  const selected = new Set();
  const updateControls = () => {
    const pending = Boolean(snapshot?.pending || snapshot?.pendingError);
    schedule.disabled = busy || pending || selected.size === 0 || confirm.value !== 'DELETE SELECTED DATA';
    cancel.hidden = !pending;
    cancel.disabled = busy;
    savePolicy.disabled = busy;
  };
  const note = (message, error = false) => {
    $('storage-feedback').textContent = message;
    if (error) notify(message,true);
  };
  async function refresh() {
    if (destroyed || !active) return;
    const read = ++readSequence;
    refreshButton.disabled = true;
    $('storage-total').textContent = 'Measuring saved files...';
    try {
      const result = await api('/api/storage/overview');
      if (!active || destroyed || read !== readSequence) return;
      snapshot = result;
      list.replaceChildren();
      let total = 0;
      for (const item of result.categories || []) {
        total += item.bytes || 0;
        const label = mount.ownerDocument.createElement('label');
        label.className = 'next-card';
        const row = mount.ownerDocument.createElement('div'); row.className = 'next-row';
        const input = mount.ownerDocument.createElement('input');
        input.setAttribute('type', 'checkbox'); input.value = item.id;
        input.disabled = !item.deletable || Boolean(result.pending || result.pendingError) || item.unsafe;
        input.checked = selected.has(item.id) && !input.disabled;
        if (!input.checked) selected.delete(item.id);
        input.addEventListener('change', () => {
          if (input.checked) selected.add(item.id); else selected.delete(item.id);
          updateControls();
        });
        const title = mount.ownerDocument.createElement('strong');
        title.textContent = item.title;
        const metric = mount.ownerDocument.createElement('span');
        metric.textContent = size(item.bytes) + ' · ' + Number(item.files).toLocaleString() + ' files';
        metric.className = 'next-help';
        if (item.deletable) row.append(input);
        row.append(title,metric); label.append(row);
        const help = mount.ownerDocument.createElement('p');
        help.className = 'next-help';
        help.textContent = item.detail + (!item.deletable ? ' (Read-only)' : item.unsafe ? ' (Contains links; cleanup disabled)' : '');
        label.append(help); list.append(label);
      }
      $('storage-total').textContent = size(total) + ' measured in managed categories';
      $('storage-external').textContent = result.externalWorkspace
        ? 'Custom working directory is excluded from destructive cleanup: ' + result.externalWorkspace
        : 'Only app-managed working directories are eligible; unrelated local folders are not touched.';
      $('storage-pending').textContent = result.pending
        ? result.pending.status==='queued'
          ? 'Queued for next startup: ' + result.pending.categories.join(', ') + '. Data is still present until BLACKICE restarts.'
          : 'Cleanup was interrupted (' + result.pending.status + '): ' + result.pending.categories.join(', ')
            + '. Some files may already be deleted. ' + (result.pending.error||'') + ' Cancel the request to prevent another attempt.'
        : result.pendingError ? 'Cleanup request needs repair: ' + result.pendingError + '. Cancel it to recover.'
        : 'No deletion is queued.';
      if (result.startupWarning) note('A queued startup cleanup could not finish: ' + result.startupWarning + '. The request remains available to cancel.',true);
      auto.checked = result.policy?.autoClearTemporaryOnStartup === true;
      $('storage-report').textContent = result.lastCleanup
        ? 'Completed ' + result.lastCleanup.completedAt + ' · ' + result.lastCleanup.categories.join(', ')
          + ' · ' + size(result.lastCleanup.bytesInspected)
        : 'No cleanup has been recorded.';
      updateControls();
    } catch(error) {
      if (active && !destroyed && read === readSequence) {
        $('storage-total').textContent = 'Storage scan failed.';
        note(error.message,true);
      }
    } finally {
      if (!destroyed && read === readSequence) refreshButton.disabled = false;
    }
  }
  confirm.addEventListener('input',updateControls);
  refreshButton.addEventListener('click',()=>void refresh());
  schedule.addEventListener('click',async () => {
    if(busy || !selected.size || confirm.value !== 'DELETE SELECTED DATA') return;
    busy = true; updateControls();
    const ids = [...selected];
    try {
      const saved = await api('/api/storage/cleanup','POST',{categories:ids,confirmation:confirm.value});
      selected.clear();confirm.value='';
      await refresh();
      note('Queued '+ saved.pending.categories.length +' categories for deletion at next startup. Restart BLACKICE to apply.');
      notify('Storage cleanup queued for the next restart.');
    } catch(error) { note(error.message,true); }
    finally { busy=false;updateControls(); }
  });
  cancel.addEventListener('click', async () => {
    if(busy)return;busy=true;updateControls();
    try {
      const outcome = await api('/api/storage/cleanup/cancel','POST',{});
      await refresh();
      note(outcome.partial
        ? 'Interrupted cleanup cancelled. Some files were already removed before the interruption; remaining data was not deleted.'
        : 'Queued deletion cancelled; no cleanup has run.');
    } catch(error){note(error.message,true);}
    finally {busy=false;updateControls();}
  });
  savePolicy.addEventListener('click',async()=>{
    if(busy)return;busy=true;updateControls();
    try {
      await api('/api/storage/policy','POST',{autoClearTemporaryOnStartup:auto.checked});
      $('storage-policy-feedback').textContent = 'Preference saved.';
      notify('Automatic cleanup preference saved.');
    }catch(error){$('storage-policy-feedback').textContent=error.message;notify(error.message,true);}
    finally{busy=false;updateControls();}
  });
  return {
    enter(){ if(destroyed || active)return;active=true;void refresh(); },
    leave(){active=false;readSequence++;},
    updateStatus(){},
    destroy(){this.leave();destroyed=true;mount.replaceChildren();}
  };
}
