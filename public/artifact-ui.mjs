/** An owned preview: closing it or opening another surface invalidates late reads. */
export function initArtifactUI({ api, showModal, closeModal, escape, icon, renderMarkdown, safeSvgPreview, openNative,
  captureOwnership = () => null, ownsOwnership = () => true } = {}) {
  let generation = 0, active;
  const cancel = () => { generation++; active?.abort(); active = null; };
  async function open({ taskId, artifactId }) {
    cancel(); const token = generation, owner = captureOwnership(), controller = new AbortController(); active = controller;
    const prefix = `/api/tasks/${encodeURIComponent(taskId)}/artifacts/${encodeURIComponent(artifactId)}`;
    showModal('artifact', `<div class="modal-header"><span class="modal-heading-icon">${icon('artifact',20)}</span><div class="modal-title"><h2 id="artifact-title">Opening file…</h2><p id="artifact-subtitle">Checking the saved file.</p></div><button id="artifact-close" class="icon-button modal-close" data-action="close-modal" aria-label="Close file preview">${icon('close',17)}</button></div><div id="artifact-view" class="artifact-view" aria-live="polite"><p role="status">Reading file…</p></div><div class="modal-footer"><button class="button" data-action="close-modal">Done</button><span id="artifact-actions" class="artifact-actions"></span></div>`, true);
    const view = document.getElementById('artifact-view'), title = document.getElementById('artifact-title'), subtitle = document.getElementById('artifact-subtitle'), actions = document.getElementById('artifact-actions');
    document.querySelector('#modal-root .modal')?.classList.add('artifact-modal');
    document.getElementById('artifact-close')?.focus?.({ preventScroll: true });
    const current = () => token === generation && !controller.signal.aborted && view?.isConnected && document.getElementById('artifact-view') === view;
    const owned = () => { if (!current()) return false; if (!ownsOwnership(owner)) { closeModal(); return false; } return true; };
    async function load() {
      if (!owned()) return false;
      view.innerHTML = '<p role="status">Reading file…</p>'; actions.innerHTML = '';
      try {
        const value = await api(`${prefix}/preview`, { signal: controller.signal }), file = value.artifact;
        if (!owned()) return false;
        if (!file || typeof file.fileName !== 'string') throw new Error('BLACKICE returned an unreadable file preview.');
        const text = value.content ?? value.text ?? '', svgImage = file.fileName.toLowerCase().endsWith('.svg') ? safeSvgPreview(text) : null;
        const body = svgImage ? `<img class="artifact-image" src="${escape(svgImage)}" alt="${escape(file.title)}"><details class="artifact-svg-source"><summary>SVG source</summary><pre class="artifact-text">${escape(text)}</pre></details>`
          : value.previewKind === 'image' ? `<img class="artifact-image" src="${escape(value.imageUrl)}" alt="${escape(file.title)}">`
          : value.previewKind === 'text' ? file.fileName.toLowerCase().endsWith('.md') ? `<article class="output-document artifact-markdown">${renderMarkdown(text)}</article>` : `<pre class="artifact-text">${escape(text)}</pre>`
          : `<div class="artifact-download-note">${icon('artifact',34)}<p>${escape(value.message || 'Open or download this file to use it in its application.')}</p></div>`;
        title.textContent = file.title || file.fileName; subtitle.textContent = `${file.fileName} · ${Number(file.size || 0).toLocaleString()} bytes`;
        view.innerHTML = `${body}<details class="artifact-file-details"><summary>File details</summary><div class="artifact-file-meta"><small>${escape(file.path)}</small><small>SHA-256: ${escape(file.sha256 || value.sha256 || '')}</small><span>Saved file bytes checked before preview.</span></div></details>`;
        actions.innerHTML = `${openNative ? '<button class="button" id="artifact-open-native">Open file</button>' : ''}<a class="button primary" href="${prefix}/content" download="${escape(file.fileName)}">${icon('download',14)}Download</a>`;
        const native = document.getElementById('artifact-open-native');
        if (native) native.onclick = async () => {
          if (!owned() || native.disabled) return; native.disabled = true;
          try { await openNative({ taskId, artifactId }); }
          catch (error) { if (owned()) { let message = document.getElementById('artifact-open-error'); if (!message) { view.insertAdjacentHTML('beforeend','<p id="artifact-open-error" role="alert"></p>'); message = document.getElementById('artifact-open-error'); } message.textContent = error.message; } }
          finally { if (current()) native.disabled = false; }
        };
        return true;
      } catch (error) {
        if (!owned()) return false;
        title.textContent = 'File preview'; subtitle.textContent = 'The saved file could not be opened.';
        view.innerHTML = `<p role="alert" class="conversation-error">${escape(error.message)}</p><button class="button" id="artifact-retry">Try again</button>`;
        const retry = document.getElementById('artifact-retry'); if (retry) retry.onclick = () => { if (retry.disabled) return; retry.disabled = true; return load(); };
        return false;
      }
    }
    return load();
  }
  return { open, cancel };
}
