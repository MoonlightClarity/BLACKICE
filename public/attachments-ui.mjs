const MAX_BYTES = 10 * 1024 * 1024, MAX_FILES = 10, MAX_TASK_BYTES = 50 * 1024 * 1024, MAX_PENDING = 20;
const sizeLabel = size => size < 1024 ? `${size} B` : size < 1024 * 1024 ? `${Math.ceil(size / 1024)} KB` : `${(size / (1024 * 1024)).toFixed(1)} MB`;
function fileBase64(bytes) { if (typeof bytes.toBase64 === 'function') return bytes.toBase64(); const chunks = []; for (let offset = 0; offset < bytes.length; offset += 32768) chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 32768))); return btoa(chunks.join('')); }
const eventFile = file => file && typeof file.arrayBuffer === 'function';
/** Only event-provided File data is attached. Text, URLs and HTML remain ordinary paste data. */
export function pastedFiles(clipboard) {
  const files = Array.from(clipboard?.files || []).filter(eventFile);
  if (files.length) return files;
  return Array.from(clipboard?.items || []).filter(item => item.kind === 'file').map(item => item.getAsFile?.()).filter(eventFile);
}
export const pastedImageFiles = pastedFiles;

/** A compact, real-file attachment strip. The parent owns persisted draft IDs and Start readiness. */
export function initAttachmentsUI({ mount, api, getDraftKey, getIds = () => [], setIds = () => {}, onPendingChange = () => {}, canEdit = () => true, pickFiles, escape, icon, toast = () => {} }) {
  if (!mount) throw new Error('An attachment composer mount is required.');
  const state = { metadata: new Map(), pending: [], errors: [], destroyed: false, dragDepth: 0, request: 0, loading: false, epochs: new Map() };
  let chain = Promise.resolve();
  const scopedDrafts = typeof getDraftKey === 'function', key = () => scopedDrafts ? String(getDraftKey()) : 'current';
  const epoch = draftKey => state.epochs.get(draftKey) || 0;
  const ids = (draftKey = key()) => { const value = getIds(draftKey); return Array.isArray(value) ? [...new Set(value)] : []; };
  const pendingFiles = (draftKey = key()) => state.pending.filter(pending => pending.key === draftKey && pending.epoch === epoch(draftKey));
  // A keyed parent can safely commit into an inactive originating chat. Legacy
  // single-draft parents cannot distinguish that ownership, so keep their lock semantics.
  const valid = pending => !state.destroyed && pending.epoch === epoch(pending.key) && (scopedDrafts || canEdit());
  const editable = () => !state.destroyed && canEdit();
  const $ = selector => mount.querySelector(selector);
  const notifyPending = () => { const count = pendingFiles().length; onPendingChange(count > 0, count); };
  const report = (name, message, draftKey = key()) => { state.errors.push({ name, message, key: draftKey }); state.errors = state.errors.slice(-12); renderStatus(); };
  mount.classList.add('attachments-composer');
  mount.innerHTML = `<div class="attachments-composer-top"><button type="button" class="attachments-add" data-attachment-action="choose" title="Attach any file">${icon('plus', 13)}Attach files</button><span class="attachments-format-note">Drop files · Paste files</span><span class="attachments-count" aria-live="polite"></span></div><input class="attachments-file-input" type="file" multiple aria-label="Choose task files"><div class="attachments-file-list" aria-label="Files attached to the next task"></div><div class="attachments-transfer-status" role="status" aria-live="polite"></div><div class="attachments-error-list" role="alert"></div><div class="attachments-drop-overlay" aria-hidden="true">${icon('download', 23)}<strong>Drop files here</strong><span>Any file · 10 MiB per file</span></div>`;
  function renderList() {
    if (state.destroyed) return;
    const attached = ids();
    $('.attachments-count').textContent = attached.length ? `${attached.length} / ${MAX_FILES}` : '';
    $('.attachments-file-list').innerHTML = attached.map(id => {
      const entry = state.metadata.get(id), unavailable = !entry && !state.loading;
      const detail = entry?.kind === 'pdf' ? `PDF${Number.isSafeInteger(entry.pageCount) && entry.pageCount > 0 ? ` · ${entry.pageCount} ${entry.pageCount === 1 ? 'page' : 'pages'}` : ''} · ${sizeLabel(entry.size)}` : entry ? `${entry.kind === 'image' ? `${entry.width} × ${entry.height} · ` : entry.kind === 'file' ? 'File · ' : ''}${sizeLabel(entry.size)}` : '';
      const processingNote = entry?.processing?.status === 'unavailable' && typeof entry.processing.message === 'string' && entry.processing.message.trim() ? entry.processing.message : entry?.kind === 'file' ? 'Saved file. Direct reading is unavailable for this format.' : '';
      return `<div class="attachment-chip${unavailable ? ' unavailable' : ''}" data-attachment-id="${escape(id)}" title="${escape(entry ? `${entry.name}\n${entry.mime}\nSHA-256 ${entry.sha256}` : state.loading ? 'Loading saved file metadata…' : 'This saved attachment is unavailable. Remove it and attach the original again.')}" >${icon(entry?.kind === 'image' ? 'eye' : 'text', 15)}<span><strong>${escape(entry?.name || (state.loading ? 'Loading file…' : 'Unavailable file'))}</strong><small>${entry ? escape(detail) : unavailable ? 'Attach the original again' : 'Checking saved copy'}</small>${processingNote ? `<small class="attachment-processing-note" role="note">${escape(processingNote)}</small>` : ''}</span><button type="button" data-attachment-action="remove" data-id="${escape(id)}" aria-label="Remove ${escape(entry?.name || 'unavailable file')} from this task">${icon('close', 12)}</button></div>`;
    }).join('');
    refreshEditability();
    renderStatus();
  }
  function refreshEditability() {
    if (state.destroyed) return;
    const locked = !editable();
    $('.attachments-add').disabled = locked || ids().length + pendingFiles().length >= MAX_FILES;
    $('.attachments-file-input').disabled = locked;
    for (const button of mount.querySelectorAll('[data-attachment-action="remove"]')) button.disabled = locked;
    if (locked) clearDrag();
  }
  function renderStatus() {
    if (state.destroyed) return;
    const pending = pendingFiles();
    $('.attachments-transfer-status').innerHTML = pending.length ? `${icon('clock', 12)}<span>Saving ${pending.length === 1 ? escape(pending[0].name) : `${pending.length} files`}…</span>` : '';
    $('.attachments-error-list').innerHTML = state.errors.flatMap((error, index) => error.key === key() ? [`<div><p><strong>${escape(error.name)}</strong>${escape(error.message)}</p><button type="button" data-attachment-action="dismiss-error" data-index="${index}" aria-label="Dismiss attachment error">${icon('close', 11)}</button></div>`] : []).slice(-3).join('');
    mount.classList.toggle('has-attachments', ids().length > 0);
  }
  async function refresh() {
    const request = ++state.request; state.loading = true; renderList();
    try { const data = await api('/api/attachments'); if (state.destroyed || request !== state.request) return; const entries = Array.isArray(data) ? data : data.files || data.attachments || []; for (const entry of entries) state.metadata.set(entry.id, entry); }
    catch (cause) { if (!state.destroyed && request === state.request) report('Saved files', cause.message); }
    finally { if (!state.destroyed && request === state.request) { state.loading = false; renderList(); } }
  }
  function queue(items, upload) {
    if (!editable()) return Promise.resolve();
    const draftKey = key(), taskAvailable = MAX_FILES - ids(draftKey).length - pendingFiles(draftKey).length, transferAvailable = MAX_PENDING - state.pending.length, available = Math.min(taskAvailable, transferAvailable);
    if (items.length > available) report(transferAvailable < taskAvailable ? 'Transfers busy' : 'Attachment limit', transferAvailable < taskAvailable ? 'Wait for the current file transfers to finish before attaching more files.' : `A task can have up to ${MAX_FILES} files. ${Math.max(available, 0)} more can be attached.`);
    for (const item of items.slice(0, Math.max(available, 0))) {
      const pending = { name: typeof item === 'string' ? item.split(/[\\/]/).at(-1) : item.name || 'Pasted file', key: draftKey, epoch: epoch(draftKey) };
      state.pending.push(pending); notifyPending(); renderList();
      chain = chain.catch(() => {}).then(async () => {
        try {
          if (!valid(pending)) return;
          if (typeof item !== 'string' && item.size > MAX_BYTES) throw new Error('Each file can be at most 10 MiB. Choose a smaller file.');
          const existingBytes = ids(draftKey).reduce((sum, id) => sum + (state.metadata.get(id)?.size || 0), 0);
          if (typeof item !== 'string' && existingBytes + item.size > MAX_TASK_BYTES) throw new Error('Task files can total at most 50 MiB. Remove a file before attaching another.');
          const entry = await upload(item, pending);
          if (!entry || !valid(pending)) return;
          state.metadata.set(entry.id, entry);
          const next = ids(draftKey); if (!next.includes(entry.id)) { if (next.length >= MAX_FILES) throw new Error('This task already has 10 files. Remove one before attaching another.'); const total = next.reduce((sum, id) => sum + (state.metadata.get(id)?.size || 0), entry.size); if (total > MAX_TASK_BYTES) throw new Error('Task files can total at most 50 MiB. Remove a file before attaching another.'); next.push(entry.id); await setIds(next, draftKey); }
        } catch (cause) { if (valid(pending)) report(pending.name, cause.message, draftKey); }
        finally { state.pending = state.pending.filter(entry => entry !== pending); if (!state.destroyed) { notifyPending(); renderList(); } }
      });
    }
    return chain;
  }
  const addFiles = files => queue(Array.from(files || []).filter(file => typeof file?.arrayBuffer === 'function'), async (file, pending) => { const bytes = new Uint8Array(await file.arrayBuffer()); if (!valid(pending)) return; if (bytes.byteLength > MAX_BYTES) throw new Error('Each file can be at most 10 MiB.'); const extension = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[file.type]; const data = await api('/api/attachments/upload', 'POST', { name: file.name || (extension ? `pasted-image.${extension}` : 'pasted-file'), dataBase64: fileBase64(bytes) }); return data.attachment || data; });
  const addPaths = paths => queue(Array.from(paths || []).filter(path => typeof path === 'string'), async path => { const data = await api('/api/attachments/import', 'POST', { path }); return data.attachment || data; });
  async function click(event) {
    const button = event.target.closest('[data-attachment-action]'); if (!button || button.disabled) return;
    const action = button.dataset.attachmentAction;
    if (['choose', 'remove'].includes(action) && !editable()) return;
    if (action === 'choose') {
      const origin = { key: key(), epoch: epoch(key()) };
      if (pickFiles) { try { const result = await pickFiles(); if (!editable() || origin.key !== key() || !valid(origin)) return; const paths = Array.isArray(result) ? result : result?.filePaths || (result?.path ? [result.path] : []); if (paths.length) await addPaths(paths); } catch (cause) { if (editable() && origin.key === key() && valid(origin)) { report('Choose files', cause.message); toast(cause.message, true); } } }
      else { state.inputOrigin = origin; $('.attachments-file-input').click(); }
    }
    if (action === 'remove') { await setIds(ids().filter(id => id !== button.dataset.id), key()); renderList(); }
    if (action === 'dismiss-error') { state.errors.splice(Number(button.dataset.index), 1); renderStatus(); }
  }
  const change = event => { if (event.target === $('.attachments-file-input')) { if (editable() && (!state.inputOrigin || state.inputOrigin.key === key() && valid(state.inputOrigin))) addFiles(event.target.files); state.inputOrigin = undefined; event.target.value = ''; } };
  function paste(event) {
    // The composer also contains settings fields: ordinary paste there must never attach files.
    const target = event.target;
    if (target?.tagName !== 'TEXTAREA' && !target?.isContentEditable) return;
    const files = pastedFiles(event.clipboardData); if (!files.length) return;
    if (!event.clipboardData.getData?.('text/plain')) event.preventDefault();
    if (!editable() || target.readOnly || target.disabled) return;
    addFiles(files);
  }
  function clearDrag() { state.dragDepth = 0; mount.classList.remove('dragging-files'); dropTarget.classList.remove('dragging-attachments'); }
  const isFileDrag = event => [...(event.dataTransfer?.types || [])].includes('Files');
  const enter = event => { if (!isFileDrag(event)) return; event.preventDefault(); if (!editable()) { event.dataTransfer.dropEffect = 'none'; return; } state.dragDepth++; mount.classList.add('dragging-files'); dropTarget.classList.add('dragging-attachments'); };
  const over = event => { if (!isFileDrag(event)) return; event.preventDefault(); event.dataTransfer.dropEffect = editable() ? 'copy' : 'none'; };
  const leave = event => { if (!isFileDrag(event)) return; if (--state.dragDepth <= 0) clearDrag(); };
  const drop = event => { if (!isFileDrag(event)) return; event.preventDefault(); event.stopPropagation(); clearDrag(); if (editable()) addFiles(event.dataTransfer.files); };
  // The whole task composer is the target, so files do not have to land on a tiny chip strip.
  const dropTarget = mount.closest('form') || mount;
  mount.addEventListener('click', click); mount.addEventListener('change', change);
  dropTarget.addEventListener('dragenter', enter); dropTarget.addEventListener('dragover', over); dropTarget.addEventListener('dragleave', leave); dropTarget.addEventListener('drop', drop); dropTarget.addEventListener('paste', paste);
  refresh();
  return { refresh, refreshEditability, addFiles, addPaths, isPending: () => pendingFiles().length > 0, reset({ cancelPending = true } = {}) { clearDrag(); if (cancelPending) { const current = key(); state.epochs.set(current, epoch(current) + 1); state.errors = state.errors.filter(error => error.key !== current); } notifyPending(); renderList(); }, destroy() { clearDrag(); state.destroyed = true; state.request++; state.pending = []; mount.removeEventListener('click', click); mount.removeEventListener('change', change); dropTarget.removeEventListener('dragenter', enter); dropTarget.removeEventListener('dragover', over); dropTarget.removeEventListener('dragleave', leave); dropTarget.removeEventListener('drop', drop); dropTarget.removeEventListener('paste', paste); onPendingChange(false, 0); mount.innerHTML = ''; } };
}
