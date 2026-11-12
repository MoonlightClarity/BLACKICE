const size = bytes => {
  if (!Number.isFinite(bytes) || bytes < 0) return 'Unavailable';
  if (bytes < 1024) return bytes + ' B';
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes, unit = -1;
  do { value /= 1024; unit++; } while (value >= 1024 && unit < units.length - 1);
  return value.toLocaleString(undefined, { maximumFractionDigits: 2 }) + ' ' + units[unit];
};

// Settings supplies public-facing copy without changing storage category IDs or
// the deletion boundaries shared by the API and startup cleanup.
const categories = {
  conversations: { title: 'Chats & activity', detail: 'Conversations and saved task runs.', removal: 'Deletes saved conversations and task history.' },
  context: { title: 'Knowledge & plans', detail: 'Saved knowledge, learned preferences, and planning records.', removal: 'Deletes saved knowledge and planning records. App and planning preferences remain.' },
  workspaces: { title: 'Projects & schedules', detail: 'Project records, schedules, workflows, and inbox items.', removal: 'Deletes project and scheduling records. Workspace files remain.' },
  workspaceFiles: { title: 'Workspace files', detail: 'Documents, code, and other files in BLACKICE-managed workspaces.', removal: 'Permanently deletes files in BLACKICE-managed workspaces, including documents and source code.' },
  actions: { title: 'Action history & undo', detail: 'Saved action results and file-change undo records.', removal: 'Deletes undo records and information BLACKICE uses to recognize previous actions.' },
  media: { title: 'Attachments & downloads', detail: 'Files, downloads, and recordings saved through BLACKICE.', removal: 'Deletes saved attachments, downloads, and recordings. Keep a separate copy of files you need.' },
  browserCredentials: { title: 'Saved passwords', detail: 'Passwords saved in BLACKICE.', removal: 'Deletes passwords saved in BLACKICE. Website sessions and browser profiles remain.' },
  browser: { title: 'Browser data', detail: 'Browser profiles, signed-in sessions, and website storage. Usage is shown here; browser data cannot be cleared from this screen.' },
  runtimeSettings: { title: 'App settings', detail: 'Saved app preferences and planning configuration. These are kept during cleanup.', secondary: true },
  temporary: { title: 'Temporary files', detail: 'Temporary diagnostics and troubleshooting captures.', removal: 'Deletes temporary diagnostics and troubleshooting captures. BLACKICE creates new ones when needed.' },
  vm: { title: 'Files from earlier versions', detail: 'Files retained from an earlier BLACKICE feature. They may contain saved work and cannot be cleared from this screen.', secondary: true },
  browserCache: { title: 'Browser cache', detail: 'Cached files used to display BLACKICE. Usage is shown here; this cache cannot be cleared from this screen.', secondary: true }
};
const describe = item => categories[item.id] || { title: item.title, detail: item.detail, removal: item.detail };
const hasData = item => item.bytes > 0 || item.files > 0 || item.unsafe;
const timestamp = value => {
  const date = new Date(value);
  return value && Number.isFinite(date.getTime())
    ? date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : null;
};
const unavailable = item => item.unsafe ? 'Cleanup unavailable: contains linked or unsupported files.' : '';

export function createStorageSettings({ mount, api, notify = () => {} }) {
  mount.innerHTML = [
    '<section class="next-card storage-overview">',
    '<div class="storage-heading"><div><h2>Storage &amp; Data</h2>',
    '<p class="next-help">See how much space BLACKICE uses and manage saved data on this computer.</p></div>',
    '<button type="button" id="storage-refresh">Refresh usage</button></div>',
    '<div class="storage-summary"><div><span class="storage-caption">Measured app storage</span>',
    '<strong id="storage-total">Measuring…</strong><span class="next-help" id="storage-measured"></span></div>',
    '<div><span class="storage-caption">Temporary files</span><strong id="storage-temporary-total">—</strong>',
    '<span id="storage-temporary-state" class="next-help">Measuring temporary files…</span>',
    '<button type="button" id="storage-review-temporary" disabled>Review temporary cleanup</button></div></div>',
    '<p class="next-help" id="storage-scan-status" role="status" aria-live="polite"></p>',
    '<div id="storage-pending-notice" class="storage-notice" hidden><strong id="storage-pending-title"></strong>',
    '<p class="next-help" id="storage-pending"></p><button type="button" id="storage-cancel" hidden>Cancel scheduled cleanup</button></div>',
    '<p id="storage-feedback" class="next-help" role="status" aria-live="polite"></p></section>',
    '<section class="next-card"><h3>Your saved data</h3><div id="storage-usage" class="storage-usage-list"></div>',
    '<p id="storage-empty" class="next-help storage-empty" hidden>Saved chats and files will appear here as you use BLACKICE.</p>',
    '<p class="next-help">Usage covers the app-managed categories shown here.</p>',
    '<details id="storage-details" class="storage-details"><summary>Other app data &amp; technical details</summary>',
    '<div id="storage-system" class="storage-usage-list"></div><p class="next-help" id="storage-count"></p>',
    '<p class="next-help" id="storage-external"></p></details></section>',
    '<section class="next-card storage-cleanup"><h3>Automatic cleanup</h3>',
    '<div class="storage-policy"><label class="storage-checkbox-row"><input type="checkbox" id="storage-auto">',
    '<span>Automatically clear temporary files when BLACKICE starts</span></label>',
    '<p class="next-help">Applies to temporary diagnostics and troubleshooting files. Your chats, workspace files, action history, passwords, and browser data stay saved.</p>',
    '<div class="next-row"><button type="button" id="storage-save-policy">Save preference</button>',
    '<span class="next-help" id="storage-policy-feedback" role="status"></span></div></div></section>',
    '<details class="next-card storage-delete" id="storage-delete"><summary>Delete saved data</summary>',
    '<div class="storage-delete-body"><p class="next-help">Choose whole categories to remove. Their contents will be permanently deleted on the next startup of BLACKICE. You can cancel a scheduled cleanup before it starts.</p>',
    '<div id="storage-categories" class="storage-removal-list"></div>',
    '<p id="storage-selection" class="next-help storage-selection" role="status" aria-live="polite">No categories selected.</p>',
    '<label class="next-label" for="storage-confirm">Type DELETE SELECTED DATA to confirm</label>',
    '<input class="next-field" id="storage-confirm" autocomplete="off" spellcheck="false" placeholder="DELETE SELECTED DATA" aria-describedby="storage-selection">',
    '<div class="next-row"><button type="button" class="next-primary" id="storage-schedule" disabled>Schedule deletion on next startup</button></div>',
    '</div></details>',
    '<details class="next-card storage-details"><summary>Cleanup history</summary>',
    '<p class="next-help" id="storage-report">No cleanup has been recorded.</p></details>'
  ].join('');
  const $ = id => mount.querySelector('#' + id);
  const refreshButton = $('storage-refresh'), list = $('storage-categories');
  const confirm = $('storage-confirm'), schedule = $('storage-schedule'), cancel = $('storage-cancel');
  const auto = $('storage-auto'), savePolicy = $('storage-save-policy'), reviewTemporary = $('storage-review-temporary');
  let active = false, destroyed = false, busy = false, loading = false, scanFailed = false;
  let snapshot = null, readSequence = 0, lifecycle = 0, overviewRead = null;
  const selected = new Set();
  const names = ids => (ids || []).map(id => categories[id]?.title || snapshot?.categories?.find(item => item.id === id)?.title || id).join(', ');
  const element = (tag, className, text) => {
    const node = mount.ownerDocument.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const updateControls = () => {
    if (destroyed) return;
    const ready = active && Boolean(snapshot) && !loading && !scanFailed;
    const pending = Boolean(snapshot?.pending || snapshot?.pendingError);
    const temporary = snapshot?.categories?.find(item => item.id === 'temporary');
    schedule.disabled = busy || !ready || pending || !selected.size || confirm.value !== 'DELETE SELECTED DATA';
    cancel.hidden = !pending;
    cancel.disabled = busy || loading || !active;
    savePolicy.disabled = auto.disabled = busy || !ready;
    confirm.disabled = busy || !ready || pending;
    refreshButton.disabled = busy || loading || !active;
    reviewTemporary.disabled = busy || !ready || pending || !temporary?.deletable || temporary.unsafe || !hasData(temporary);
    for (const input of list.querySelectorAll('input')) {
      const item = snapshot?.categories?.find(value => value.id === input.value);
      input.disabled = busy || !ready || pending || !item?.deletable || item.unsafe;
    }
    const chosen = (snapshot?.categories || []).filter(item => selected.has(item.id));
    $('storage-selection').textContent = chosen.length
      ? chosen.length + (chosen.length === 1 ? ' category' : ' categories') + ' selected · ' + size(chosen.reduce((sum, item) => sum + item.bytes, 0)) + ' measured. Removes: ' + names(chosen.map(item => item.id)) + '.'
      : 'No categories selected.';
  };
  const note = (message, error = false) => {
    if (destroyed || !active) return;
    $('storage-feedback').textContent = message;
    $('storage-feedback').dataset.state = error ? 'error' : 'info';
    if (error) notify(message, true);
  };
  const usageRow = item => {
    const copy = describe(item), row = element('div', 'storage-usage-row'), text = element('div');
    row.dataset.category = item.id;
    text.append(element('strong', '', copy.title), element('p', 'next-help', copy.detail));
    if (item.unsafe) text.append(element('span', 'storage-status', unavailable(item)));
    row.append(text, element('span', 'storage-size', size(item.bytes)));
    return row;
  };
  function render(result) {
    const items = result.categories || [], visible = items.filter(hasData);
    const primary = visible.filter(item => item.id !== 'temporary' && !describe(item).secondary);
    const secondary = visible.filter(item => describe(item).secondary);
    const total = items.reduce((sum, item) => sum + (item.bytes || 0), 0);
    const temporary = items.find(item => item.id === 'temporary');
    $('storage-usage').replaceChildren(...primary.map(usageRow));
    $('storage-system').replaceChildren(...secondary.map(usageRow));
    $('storage-empty').hidden = primary.length > 0;
    $('storage-total').textContent = size(total);
    $('storage-temporary-total').textContent = temporary ? size(temporary.bytes) : 'Unavailable';
    $('storage-measured').textContent = timestamp(result.at) ? 'Measured ' + timestamp(result.at) : 'Latest measurement';
    $('storage-count').textContent = items.reduce((sum, item) => sum + (item.files || 0), 0).toLocaleString() + ' files measured. Linked files are excluded from the measurement.';
    $('storage-external').textContent = result.externalWorkspace
      ? 'Custom workspace: ' + result.externalWorkspace + '. Cleanup applies only to app-managed folders.'
      : 'Cleanup applies to BLACKICE-managed data. Other folders on your computer are kept.';
    $('storage-temporary-state').textContent = !temporary ? 'Temporary-file usage is unavailable.'
      : temporary.unsafe ? unavailable(temporary)
      : hasData(temporary) ? 'Diagnostics and troubleshooting files. Cleanup runs on the next startup.'
      : 'No temporary files to clear.';
    list.replaceChildren();
    const removable = visible.filter(item => item.deletable);
    for (const id of selected) if (!removable.some(item => item.id === id && !item.unsafe) || result.pending || result.pendingError) selected.delete(id);
    for (const item of removable) {
      const copy = describe(item), label = element('label', 'storage-removal-row');
      const input = element('input'); input.setAttribute('type', 'checkbox'); input.value = item.id;
      input.checked = selected.has(item.id);
      input.setAttribute('aria-label', 'Delete ' + copy.title);
      input.addEventListener('change', () => {
        if (input.disabled) return;
        if (input.checked) selected.add(item.id); else selected.delete(item.id);
        confirm.value = '';
        updateControls();
      });
      const text = element('span', 'storage-removal-copy');
      text.append(element('strong', '', copy.title), element('span', 'next-help', copy.removal));
      if (item.unsafe) text.append(element('span', 'storage-status', unavailable(item)));
      label.append(input, text, element('span', 'storage-size', size(item.bytes)));
      list.append(label);
    }
    if (!removable.length) list.append(element('p', 'next-help storage-empty', 'There is no saved data available to delete.'));
    const pending = result.pending, attention = result.pendingError || pending && pending.status !== 'queued';
    $('storage-pending-notice').hidden = !pending && !result.pendingError && !result.startupWarning;
    $('storage-pending-title').textContent = attention || result.startupWarning ? 'Cleanup needs attention' : 'Cleanup scheduled';
    $('storage-pending').textContent = pending
      ? pending.status === 'queued'
        ? names(pending.categories) + '. Runs on the next startup of BLACKICE. Your data is still present.'
        : names(pending.categories) + '. Cleanup was interrupted. Some files may already have been deleted. Cancel this request before scheduling another cleanup.'
      : result.pendingError ? 'The saved cleanup request needs repair. Cancel it before scheduling another cleanup.' : '';
    if (result.startupWarning) $('storage-pending').textContent += ' The last startup could not complete cleanup: ' + result.startupWarning;
    auto.checked = result.policy?.autoClearTemporaryOnStartup === true;
    $('storage-policy-feedback').textContent = '';
    const report = result.lastCleanup;
    $('storage-report').textContent = report
      ? 'Completed ' + (timestamp(report.completedAt) || 'at an unavailable time') + ' · ' + names(report.categories) + '. ' + size(report.bytesInspected) + ' measured before cleanup.'
      : 'No cleanup has been recorded.';
    updateControls();
  }
  async function refresh() {
    if (destroyed || !active) return;
    const read = ++readSequence;
    loading = true;
    updateControls();
    $('storage-scan-status').textContent = snapshot ? 'Refreshing usage… Previous measurement shown.' : 'Measuring saved files… Large workspaces can take a minute.';
    try {
      // A scan walks files on disk and continues on the server if this panel is
      // left. Reuse that read on reentry instead of starting overlapping scans.
      overviewRead ||= api('/api/storage/overview', 'GET', undefined, { deadlineMs: 180000 })
        .finally(() => { overviewRead = null; });
      const result = await overviewRead;
      if (!active || destroyed || read !== readSequence) return;
      snapshot = result;
      scanFailed = false;
      render(result);
      $('storage-scan-status').textContent = '';
      if ($('storage-feedback').dataset.state === 'error') {
        $('storage-feedback').textContent = '';
        $('storage-feedback').dataset.state = 'info';
      }
    } catch (error) {
      if (active && !destroyed && read === readSequence) {
        scanFailed = true;
        if (!snapshot) {
          $('storage-total').textContent = 'Unavailable';
          $('storage-temporary-total').textContent = 'Unavailable';
          $('storage-temporary-state').textContent = 'Refresh usage to measure temporary files.';
        }
        $('storage-scan-status').textContent = 'Storage scan failed. ' + (snapshot ? 'Previous measurement shown. ' : '') + 'Refresh usage to try again.';
        note(error.message, true);
      }
    } finally {
      if (!destroyed && read === readSequence) { loading = false; updateControls(); }
    }
  }
  confirm.addEventListener('input', updateControls);
  refreshButton.addEventListener('click', () => { if (!busy && !loading) void refresh(); });
  reviewTemporary.addEventListener('click', () => {
    if (reviewTemporary.disabled) return;
    selected.clear(); selected.add('temporary'); confirm.value = '';
    for (const input of list.querySelectorAll('input')) input.checked = input.value === 'temporary';
    $('storage-delete').open = true;
    updateControls();
    $('storage-delete').scrollIntoView?.({ block: 'start' });
    Array.from(list.querySelectorAll('input')).find(input => input.value === 'temporary')?.focus();
  });
  schedule.addEventListener('click', async () => {
    if (schedule.disabled || destroyed || !active || busy) return;
    busy = true; updateControls();
    const ids = [...selected], view = lifecycle;
    try {
      const saved = await api('/api/storage/cleanup', 'POST', { categories: ids, confirmation: confirm.value });
      if (destroyed || !active || view !== lifecycle) return;
      selected.clear(); confirm.value = '';
      snapshot = { ...snapshot, pending: saved.pending, pendingError: null, startupWarning: null };
      render(snapshot);
      await refresh();
      if (destroyed || !active || view !== lifecycle) return;
      note('Scheduled ' + names(saved.pending.categories) + ' for deletion on the next startup. No data has been deleted yet.');
      notify('Storage cleanup scheduled for the next startup.');
    } catch (error) { if (!destroyed && active && view === lifecycle) { scanFailed = true; note(error.message, true); } }
    finally {
      busy = false;
      if (!destroyed && active && view !== lifecycle) await refresh();
      updateControls();
    }
  });
  cancel.addEventListener('click', async () => {
    if (cancel.disabled || destroyed || !active || busy) return;
    busy = true; updateControls();
    const view = lifecycle;
    try {
      const outcome = await api('/api/storage/cleanup/cancel', 'POST', {});
      if (destroyed || !active || view !== lifecycle) return;
      snapshot = { ...snapshot, pending: null, pendingError: null, startupWarning: null };
      render(snapshot);
      await refresh();
      if (destroyed || !active || view !== lifecycle) return;
      note(outcome.partial
        ? 'Cleanup cancelled. Some files may already have been removed; cancellation cannot restore them.'
        : outcome.cancelled ? 'Scheduled cleanup cancelled before startup.' : 'No scheduled cleanup remains.');
    } catch (error) { if (!destroyed && active && view === lifecycle) note(error.message, true); }
    finally {
      busy = false;
      if (!destroyed && active && view !== lifecycle) await refresh();
      updateControls();
    }
  });
  auto.addEventListener('change', () => { $('storage-policy-feedback').textContent = 'Unsaved change.'; });
  savePolicy.addEventListener('click', async () => {
    if (savePolicy.disabled || destroyed || !active || busy) return;
    busy = true; updateControls();
    const view = lifecycle, enabled = auto.checked;
    try {
      await api('/api/storage/policy', 'POST', { autoClearTemporaryOnStartup: enabled });
      if (destroyed || !active || view !== lifecycle) return;
      snapshot.policy = { autoClearTemporaryOnStartup: enabled };
      $('storage-policy-feedback').textContent = enabled ? 'Saved. Temporary files will be cleared at startup.' : 'Saved. Automatic cleanup is off.';
      notify('Automatic cleanup preference saved.');
    } catch (error) {
      if (!destroyed && active && view === lifecycle) { $('storage-policy-feedback').textContent = error.message; notify(error.message, true); }
    } finally {
      busy = false;
      if (!destroyed && active && view !== lifecycle) await refresh();
      updateControls();
    }
  });
  return {
    enter() { if (destroyed || active) return; active = true; lifecycle++; void refresh(); },
    leave() {
      if (destroyed) return;
      active = false; lifecycle++; readSequence++; loading = false;
      selected.clear(); confirm.value = ''; snapshot = null; scanFailed = false;
      $('storage-delete').open = false;
      $('storage-feedback').textContent = ''; $('storage-policy-feedback').textContent = '';
      updateControls();
    },
    updateStatus() {},
    destroy() { this.leave(); destroyed = true; mount.replaceChildren(); }
  };
}
