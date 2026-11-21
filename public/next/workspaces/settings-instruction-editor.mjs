const ENDPOINT = '/api/instructions/core';
const signature = record => String(record?.revision) + ':' + String(record?.hash || '');
const message = error => String(error?.message || error || 'The instructions could not be updated.');
const make = (doc, tag, value = '', className = '') => {
  const element = doc.createElement(tag); element.textContent = value;
  if (className) element.className = className;
  return element;
};
const validRecord = record => {
  if (!record || typeof record.content !== 'string' || !Number.isSafeInteger(record.revision) || record.revision < 0 ||
    !/^[a-f0-9]{64}$/.test(record.hash || '') || !['initial-default', 'user'].includes(record.source)) {
    throw Error('BLACKICE returned an unreadable saved instruction record. Reload before saving.');
  }
  return record;
};
const date = value => value && Number.isFinite(new Date(value).valueOf()) ? new Date(value).toLocaleString() : 'Date unavailable';

/** Saved owner instructions and drafts are separate from immutable execution audits. */
export function createInstructionEditor({mount, api}) {
  const doc = mount.ownerDocument;
  mount.innerHTML = [
    '<div class="next-identity-heading"><h4>Saved instructions</h4>',
    '<button id="next-instructions-reload" type="button">Reload saved</button></div>',
    '<p class="next-help">Edit these instructions and press Save changes. Saved text stays with this profile across upgrades and applies to the next execution. Past execution snapshots stay unchanged.</p>',
    '<p id="next-instructions-saved" class="next-help"></p><p id="next-instructions-source" class="next-identity-path"></p>',
    '<div id="next-instructions-conflict" class="next-instruction-conflict" hidden>',
    '<p>A newer saved revision is available. Your draft is kept. Choose the text to continue editing.</p>',
    '<div class="next-instruction-controls"><button id="next-instructions-use-saved" type="button">Use saved version</button>',
    '<button id="next-instructions-keep-draft" type="button">Keep my draft</button></div></div>',
    '<form id="next-instructions-editor-form">',
    '<label class="next-label" for="next-instructions-text">Instruction text</label>',
    '<textarea id="next-instructions-text" class="next-field next-identity-content" rows="15" spellcheck="false"></textarea>',
    '<div class="next-identity-save-row"><p id="next-instructions-save-state" class="next-help" role="status"></p>',
    '<span id="next-instructions-count" class="next-help"></span>',
    '<button id="next-instructions-revert" type="button">Revert to saved</button>',
    '<button id="next-instructions-save" type="submit" class="next-primary">Save changes</button></div></form>',
    '<p id="next-instructions-notice" class="next-identity-notice" role="status" aria-live="polite"></p>',
    '<button id="next-instructions-recover" type="button" hidden>Recover previous draft</button>',
    '<details id="next-instructions-review" class="next-instruction-section" hidden><summary>Review changes</summary>',
    '<div class="next-instruction-comparison"><section><h4 id="next-instructions-before-title">Saved text</h4>',
    '<div id="next-instructions-before" class="next-instruction-text"></div></section>',
    '<section><h4>Draft to save</h4><div id="next-instructions-after" class="next-instruction-text"></div></section></div></details>',
    '<button id="next-instructions-history" type="button" aria-expanded="false" aria-controls="next-instructions-history-panel">Version history</button>',
    '<section id="next-instructions-history-panel" class="next-identity-history" aria-label="Saved instruction revisions" hidden>',
    '<p id="next-instructions-history-state" class="next-help" role="status"></p>',
    '<ol id="next-instructions-versions"></ol><button id="next-instructions-more" type="button" hidden>Show more revisions</button>',
    '<section id="next-instructions-version-preview" class="next-instruction-section" hidden>',
    '<h4 id="next-instructions-version-title"></h4><p id="next-instructions-version-source" class="next-help"></p>',
    '<div id="next-instructions-version-text" class="next-instruction-text"></div>',
    '<button id="next-instructions-use-version" type="button">Use this revision as draft</button></section></section>',
  ].join('');
  const ids = ['reload','saved','source','conflict','use-saved','keep-draft','editor-form','text','save-state','count',
    'revert','save','notice','recover','review','before-title','before','after','history','history-panel','history-state',
    'versions','more','version-preview','version-title','version-source','version-text','use-version'];
  const ui = Object.fromEntries(ids.map(id => [id, mount.querySelector('#next-instructions-' + id)]));
  let active = false, destroyed = false, current = null, draft = '', incoming = null, previous = null, busy = false, loading = false;
  let notice = '', noticeError = false, readToken = 0, readController = null;
  let history = null, historyOpen = false, historyLoading = false, historyError = '', visibleHistory = 10, historyToken = 0, historyController = null;
  let preview = null, previewLoading = false, previewError = '', previewToken = 0, previewController = null;
  const dirty = () => Boolean(current) && draft !== current.content;
  const setNotice = (text, error = false) => { notice = text; noticeError = error; };
  function invalidateReads() {
    readToken++; historyToken++; previewToken++;
    readController?.abort(); historyController?.abort(); previewController?.abort();
    readController = historyController = previewController = null;
    loading = historyLoading = previewLoading = false;
  }
  function renderHistory() {
    ui['history-panel'].hidden = !historyOpen;
    ui.history.setAttribute('aria-expanded', String(historyOpen));
    if (!historyOpen) return;
    ui.versions.replaceChildren();
    ui['history-state'].textContent = historyError || previewError || (historyLoading ? 'Loading saved revisions…' : previewLoading ?
      'Loading revision…' : history?.length ? 'Review a saved revision, then load it into your draft. Save changes creates a new revision.' : 'No saved revisions are available.');
    for (const version of (history || []).slice(0, visibleHistory)) {
      const row = make(doc, 'li', '', 'next-identity-version'), description = make(doc, 'div');
      description.append(make(doc, 'strong', 'Revision ' + version.revision + (version.revision === current?.revision ? ' · current' : '')),
        make(doc, 'small', date(version.updatedAt) + ' · ' + Number(version.characters ?? version.chars ?? 0).toLocaleString() + ' characters'));
      const button = make(doc, 'button', 'Review revision'); button.type = 'button';
      button.dataset.instructionRevision = String(version.revision); button.disabled = busy || previewLoading;
      button.addEventListener('click', () => void loadVersion(version.revision));
      row.append(description, button); ui.versions.append(row);
    }
    ui.more.hidden = !(history && visibleHistory < history.length); ui.more.disabled = busy || historyLoading;
    ui['version-preview'].hidden = !preview;
    if (preview) {
      ui['version-title'].textContent = 'Revision ' + preview.revision + ' · ' + preview.content.length.toLocaleString() + ' characters';
      ui['version-source'].textContent = (preview.source === 'user' ? 'User-saved instructions' : 'Initial saved instructions') + ' · ' + date(preview.updatedAt);
      ui['version-text'].textContent = preview.content || '(Empty instructions.)';
    }
    ui['use-version'].disabled = !preview || busy || loading || Boolean(incoming);
  }
  function render({history: paintHistory = true} = {}) {
    if (!active || destroyed) return;
    if (ui.text.value !== draft) ui.text.value = draft;
    ui.text.disabled = !current;
    ui.saved.textContent = current ? 'Saved revision ' + current.revision + ' · ' + date(current.updatedAt) : '';
    ui.source.textContent = current ? (current.source === 'user' ? 'User-saved instructions' : 'Initial saved instructions') +
      (current.path ? ' · ' + current.path : '') : '';
    ui.count.textContent = draft.length.toLocaleString() + ' characters';
    ui['save-state'].textContent = busy ? 'Saving…' : loading ? 'Loading saved instructions…' : !current ?
      'Instructions unavailable. Reload to try again.' : incoming ? 'Newer saved revision ' + incoming.revision + ' available.' :
      dirty() ? 'Unsaved changes. Your draft stays here when you switch settings or workspaces.' : 'Saved · revision ' + current.revision;
    ui.save.disabled = !current || busy || loading || Boolean(incoming) || (!dirty() && current.source !== 'initial-default');
    ui.revert.disabled = !current || busy || (!dirty() && !incoming);
    ui.reload.disabled = busy || loading;
    ui.history.disabled = !current || busy;
    ui.conflict.hidden = !incoming;
    ui['use-saved'].disabled = ui['keep-draft'].disabled = busy;
    ui.notice.textContent = notice; ui.notice.dataset.error = String(noticeError);
    ui.notice.setAttribute('role', noticeError ? 'alert' : 'status');
    ui.recover.hidden = previous === null; ui.recover.disabled = busy;
    ui.review.hidden = !current || (!dirty() && !incoming);
    const saved = incoming || current;
    if (saved) {
      ui['before-title'].textContent = 'Saved revision ' + saved.revision;
      ui.before.textContent = saved.content || '(Empty instructions.)';
      ui.after.textContent = draft || '(Empty instructions.)';
    }
    if (paintHistory) renderHistory();
  }
  function accept(record) {
    const next = validRecord(record);
    if (current && next.revision < current.revision || incoming && next.revision < incoming.revision) return;
    const changed = !current || signature(next) !== signature(current);
    if (current && changed && (dirty() || busy)) incoming = next;
    else {
      const keep = dirty(); current = next; incoming = null;
      if (!keep) draft = next.content;
    }
    if (changed) history = null;
    loading = false; render();
    if (changed && historyOpen) void loadHistory();
  }
  async function reload({explicit = false} = {}) {
    if (!active || destroyed || busy) return;
    const token = ++readToken; readController?.abort(); readController = new AbortController(); loading = true; render();
    try {
      const record = await api(ENDPOINT, 'GET', undefined, {signal:readController.signal});
      if (!active || destroyed || token !== readToken) return;
      accept(record); if (explicit) setNotice(incoming ? 'Newer saved text loaded. Your draft is kept.' : 'Saved instructions reloaded. Your draft is kept.');
    } catch (error) {
      if (active && !destroyed && token === readToken && error.name !== 'AbortError') setNotice(message(error), true);
    } finally { if (token === readToken) { loading = false; readController = null; render(); } }
  }
  async function loadHistory() {
    if (!active || destroyed || !current || busy) return;
    const token = ++historyToken; historyController?.abort(); historyController = new AbortController();
    historyLoading = true; historyError = ''; renderHistory();
    try {
      const versions = await api(ENDPOINT + '/versions', 'GET', undefined, {signal:historyController.signal});
      if (!active || destroyed || token !== historyToken) return;
      if (!Array.isArray(versions)) throw Error('BLACKICE returned an unreadable revision history.');
      history = versions.filter(item => Number.isSafeInteger(item?.revision) && item.revision >= 0).sort((a,b) => b.revision - a.revision);
    } catch (error) {
      if (active && !destroyed && token === historyToken && error.name !== 'AbortError') historyError = message(error);
    } finally { if (token === historyToken) { historyLoading = false; historyController = null; renderHistory(); } }
  }
  async function loadVersion(revision) {
    if (!active || destroyed || busy || !history?.some(item => item.revision === revision)) return;
    const token = ++previewToken; previewController?.abort(); previewController = new AbortController();
    previewLoading = true; previewError = ''; preview = null; renderHistory();
    try {
      const record = validRecord(await api(ENDPOINT + '/versions/' + revision, 'GET', undefined, {signal:previewController.signal}));
      if (!active || destroyed || token !== previewToken) return;
      if (record.revision !== revision) throw Error('The saved revision did not match the requested revision.');
      preview = record;
    } catch (error) {
      if (active && !destroyed && token === previewToken && error.name !== 'AbortError') previewError = message(error);
    } finally { if (token === previewToken) { previewLoading = false; previewController = null; renderHistory(); } }
  }
  async function save() {
    if (!active || destroyed || !current || busy || loading || incoming || (!dirty() && current.source !== 'initial-default')) return;
    const submitted = draft, baseline = current;
    invalidateReads(); busy = true; setNotice(''); render();
    let conflict = false;
    try {
      const saved = validRecord(await api(ENDPOINT, 'PUT', {content:submitted, expectedRevision:baseline.revision, expectedHash:baseline.hash}));
      if (destroyed) return;
      const newer = incoming && incoming.revision > saved.revision ? incoming : null;
      current = saved; incoming = newer; history = null;
      if (draft === submitted) draft = saved.content;
      setNotice('Instructions saved · revision ' + saved.revision + '. Applies to the next execution.');
    } catch (error) {
      if (!destroyed) { setNotice(message(error), true); conflict = error.status === 409; }
    } finally {
      busy = false;
      if (active && !destroyed) {
        render();
        if (conflict) void reload();
        if (historyOpen && !history) void loadHistory();
      }
    }
  }
  function useSaved() {
    if (!current || busy) return;
    if (dirty()) previous = draft;
    current = incoming || current; incoming = null; draft = current.content;
    setNotice('Saved instructions loaded.'); render();
  }
  ui.text.addEventListener('input', () => { draft = ui.text.value; render({history:false}); });
  ui['editor-form'].addEventListener('submit', event => { event.preventDefault(); void save(); });
  ui.reload.addEventListener('click', () => void reload({explicit:true}));
  ui.revert.addEventListener('click', useSaved); ui['use-saved'].addEventListener('click', useSaved);
  ui['keep-draft'].addEventListener('click', () => {
    if (!incoming || busy) return;
    current = incoming; incoming = null; setNotice('Your draft is kept. Save changes to update the current revision.'); render();
  });
  ui.recover.addEventListener('click', () => {
    if (previous === null || busy) return;
    const value = previous; previous = dirty() ? draft : null; draft = value;
    setNotice('Previous draft recovered. Save changes to keep it.'); render();
  });
  ui.history.addEventListener('click', () => { historyOpen = !historyOpen; renderHistory(); if (historyOpen && !history) void loadHistory(); });
  ui.more.addEventListener('click', () => { visibleHistory += 10; renderHistory(); });
  ui['use-version'].addEventListener('click', () => {
    if (!preview || busy || loading || incoming) return;
    if (dirty()) previous = draft;
    draft = preview.content; setNotice('Revision ' + preview.revision + ' loaded into your draft. Save changes to make it current.'); render();
    ui.text.focus();
  });
  return {
    enter() { if (active || destroyed) return; active = true; render(); void reload(); },
    leave() { active = false; invalidateReads(); },
    destroy() { this.leave(); destroyed = true; mount.replaceChildren(); },
  };
}
