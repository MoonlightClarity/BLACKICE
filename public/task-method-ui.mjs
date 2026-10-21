const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const kindLabel = { action: 'Step', sequence: 'In order', parallel: 'In parallel', choice: 'Choose a path' };

export function methodOutlineRows(method) {
  const definitions = new Map((method?.steps || []).filter(object).map(step => [step.id, step]));
  const source = Array.isArray(method?.outline?.steps) ? method.outline.steps : (method?.steps || []).map(step => ({ ...step, kind: 'action', parentId: null, stepType: step.type, doneWhen: (step.checks || []).join('\n') }));
  const nodes = new Map();
  for (const node of source.slice(0, 200)) if (object(node) && typeof node.id === 'string' && !nodes.has(node.id)) nodes.set(node.id, node);
  const children = new Map(), roots = [];
  for (const node of nodes.values()) {
    if (node.parentId && nodes.has(node.parentId) && node.parentId !== node.id) { const group = children.get(node.parentId) || []; group.push(node); children.set(node.parentId, group); }
    else roots.push(node);
  }
  const rows = [], visited = new Set();
  const visit = (node, depth, number) => {
    if (visited.has(node.id)) return; visited.add(node.id);
    const definition = definitions.get(node.id);
    rows.push({ ...(definition ? { instructions: definition.instructions, inputs: definition.inputs, checks: definition.checks } : {}), ...node, depth: Math.min(depth, 8), number, kind: kindLabel[node.kind] ? node.kind : 'action' });
    (children.get(node.id) || []).forEach((child, index) => visit(child, depth + 1, number + '.' + (index + 1)));
  };
  roots.forEach((node, index) => visit(node, 0, String(index + 1)));
  for (const node of nodes.values()) if (!visited.has(node.id)) visit(node, 0, String(rows.length + 1));
  return rows;
}

export function methodDraftPrompt(method, existing = '') {
  if (!method || typeof method.id !== 'string' || !Number.isSafeInteger(method.revision)) throw Error('Open a saved method before using it.');
  const reference = JSON.stringify({ id: method.id, revision: method.revision, name: method.name });
  const direction = 'Use this saved BLACKICE method as the starting outline: ' + reference + '. Read its current definition with relay_task describe, using methodId and methodRevision. Adapt its steps, branches and checks to this request; keep the live task plan updated. Reassess choices and verify new results.';
  return String(existing).trim() ? String(existing) + '\n\n' + direction : direction + '\n\nTask: ';
}

export function renderMethodOutline(method) {
  const rows = methodOutlineRows(method), layout = method?.outline?.layout;
  const explanation = layout === 'choice' ? 'These branches are alternatives. The agent chooses a path for the current task using their conditions.' : layout === 'parallel' ? 'These branches can be worked independently, subject to their prerequisites.' : '';
  const root = ['sequence', 'parallel', 'choice'].includes(layout) ? '<div class="task-method-root-layout"><strong>' + kindLabel[layout] + '</strong>' + (explanation ? '<p>' + explanation + '</p>' : '') + '</div>' : '';
  return root + '<ol class="task-method-outline" aria-label="Reusable steps">' + rows.map(row => {
    const checks = [...new Set([row.doneWhen, ...(Array.isArray(row.checks) ? row.checks : [])].filter(Boolean))];
    return '<li style="--method-depth:' + row.depth + '"><span class="task-method-number">' + escape(row.number) + '</span><div><span class="task-method-kind">' + escape(kindLabel[row.kind]) + (row.stepType ? ' · ' + escape(row.stepType) : '') + '</span><strong>' + escape(row.title) + '</strong>' + (row.condition ? '<p class="task-method-condition">When ' + escape(row.condition) + '</p>' : '') + (row.instructions ? '<p class="task-method-step-instructions">' + escape(row.instructions) + '</p>' : '') + (row.inputs?.length ? '<details><summary>Inputs for this step</summary><ul>' + row.inputs.map(value => '<li>' + escape(value) + '</li>').join('') + '</ul></details>' : '') + (checks.length ? '<details><summary>Completion check' + (checks.length > 1 ? 's' : '') + '</summary><ul>' + checks.map(value => '<li>' + escape(value) + '</li>').join('') + '</ul></details>' : '') + (row.result ? '<p class="task-method-result">Result: ' + escape(row.result) + '</p>' : '') + (row.dependsOn?.length ? '<small>After ' + row.dependsOn.map(id => escape(rows.find(item => item.id === id)?.title || id)).join(', ') + '</small>' : '') + '</div></li>';
  }).join('') + '</ol>';
}

const externalURL = value => { try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null; } catch { return null; } };
const detailList = (title, values, className = '') => Array.isArray(values) && values.length ? '<section class="task-method-guidance ' + className + '"><h3>' + escape(title) + '</h3><ul>' + values.map(value => '<li>' + escape(value) + '</li>').join('') + '</ul></section>' : '';
export function renderMethodGuidance(method) {
  const catalog = method?.catalog || {}, provenance = method?.provenance;
  const references = (catalog.references || []).filter(reference => externalURL(reference.href));
  const source = provenance && externalURL(provenance.repository);
  return (catalog.whenToUse ? '<p class="task-method-fit">' + escape(catalog.whenToUse) + '</p>' : '') + detailList('Before you use this method', catalog.prerequisites, 'task-method-prerequisites') + detailList('Expected outputs', catalog.outputs) + detailList('Limits and situations to avoid', catalog.avoidWhen, 'task-method-limitations') + (references.length ? '<details class="task-method-references"><summary>Source references · ' + references.length + '</summary><ul>' + references.map(reference => '<li><a href="' + escape(externalURL(reference.href)) + '" target="_blank" rel="noopener noreferrer">' + escape(reference.label) + '</a></li>').join('') + '</ul></details>' : '') + (provenance ? '<aside class="task-method-attribution"><strong>' + escape(provenance.project || 'Attributed method source') + '</strong>' + (source ? ' · <a href="' + escape(source) + '" target="_blank" rel="noopener noreferrer">Original catalog</a>' : '') + (provenance.license ? ' · ' + escape(provenance.license) : '') + (provenance.commit ? '<p>Source revision ' + escape(provenance.commit) + '</p>' : '') + (provenance.adaptation ? '<p>' + escape(provenance.adaptation) + '</p>' : '') + '</aside>' : '');
}

/** Read or prepare reusable outlines. Every user action either inspects, drafts,
 * or saves an explicit method; this surface never starts an agent or project. */
export function initTaskMethodUI({ api, showModal, closeModal, toast, icon, captureDraft, applyDraft, onEditLibrary, captureOwnership = () => null, ownsOwnership = () => true }) {
  let draftCapture, ownership, epoch = 0, browsing = { query: '', domain: '', phase: '', output: '', offset: 0 }, returnMethodId = null;
  const begin = () => { draftCapture = captureDraft(); ownership = captureOwnership(); epoch++; };
  const active = (frame, token) => frame.isConnected && token === epoch && ownsOwnership(ownership);
  const frame = (title, subtitle, body, footer = '') => {
    showModal('task-methods', '<section id="blackice-task-methods" class="task-method-workspace"><header class="task-method-header"><span class="task-method-emblem" aria-hidden="true">' + icon('plan', 25) + '</span><div><span class="task-method-eyebrow">METHODS / REUSABLE OUTLINES</span><h2>' + escape(title) + '</h2><p>' + escape(subtitle) + '</p></div><button type="button" class="icon-button modal-close" data-action="close-modal" aria-label="Close methods">' + icon('close', 18) + '</button></header><div class="task-method-body">' + body + '</div><p class="task-method-error" role="alert" hidden></p>' + (footer ? '<footer class="task-method-footer">' + footer + '</footer>' : '') + '</section>', true);
    const target = document.querySelector('#blackice-task-methods'); target.closest('.modal')?.classList.add('task-method-modal'); return target;
  };
  const error = (target, cause) => { const line = target.querySelector('.task-method-error'); line.hidden = false; line.textContent = cause?.message || String(cause); };
  const use = (target, method) => {
    try {
      if (!ownsOwnership(ownership)) throw Error('The task changed. Reopen this method from the task you want to guide.');
      const result = applyDraft(draftCapture, methodDraftPrompt(method, draftCapture?.task || ''));
      if (!result?.applied) throw Error(result?.error || 'Your message changed. Reopen the method to apply it to the current draft.');
      closeModal(); toast('Method added to your message. Describe the outcome and send when ready.');
    } catch (cause) { error(target, cause); }
  };
  const detail = (method, reference) => {
    const newer = Number.isSafeInteger(reference?.revision) && reference.revision !== method.revision;
    const metadata = '<div class="task-method-tags"><span>' + escape(method.catalog?.domain || method.taskType || 'general') + '</span><span>' + (method.origin === 'builtin' ? 'Built in' : 'Your method') + '</span><span>Revision ' + method.revision + '</span>' + (method.outline ? '<span>Branching outline</span>' : '') + (method.catalog?.effort ? '<span>' + escape(method.catalog.effort) + ' effort</span>' : '') + '</div>';
    const inputs = method.inputs?.length ? '<details class="task-method-inputs"><summary>Suggested inputs · ' + method.inputs.length + '</summary><ul>' + method.inputs.map(input => '<li><strong>' + escape(input.label) + '</strong><p>' + escape(input.description) + '</p></li>').join('') + '</ul></details>' : '';
    const target = frame(method.name, method.description || 'A reusable starting point. The agent adapts it to each task.', metadata + (newer ? '<p class="task-method-version-note">This task referenced revision ' + reference.revision + '. The library now contains revision ' + method.revision + '; the task’s saved plan remains its original record.</p>' : '') + renderMethodGuidance(method) + inputs + renderMethodOutline(method), '<button type="button" class="button subtle" data-method-action="back">All methods</button><span>Adapt the procedure to your task.</span><button type="button" class="button primary" data-method-action="use">Use in my message ' + icon('chevron', 14) + '</button>');
    const token = epoch;
    target.querySelector('[data-method-action="back"]').addEventListener('click', () => { if (active(target, token)) return library(false); });
    target.querySelector('[data-method-action="use"]').addEventListener('click', () => use(target, method));
    return target;
  };
  async function library(fresh = true) {
    if (fresh) { begin(); browsing = { query: '', domain: '', phase: '', output: '', offset: 0 }; returnMethodId = null; }
    const token = ++epoch, target = frame('An approach for the work ahead.', 'Search by task, method, input or outcome. Your agent can choose and adapt these automatically; browsing is optional.', '<form class="task-method-discovery"><label class="task-method-search">' + icon('search', 17) + '<input type="search" aria-label="Search methods" placeholder="What are you trying to work out?" maxlength="500" value="' + escape(browsing.query) + '"></label><div class="task-method-filters">' + [['domain','Domain'],['phase','Task stage'],['output','Output']].map(([key,title]) => '<label><span>' + title + '</span><select data-method-filter="' + key + '" aria-label="' + title + '"><option value="">All ' + title.toLowerCase() + 's</option></select></label>').join('') + '</div></form><div class="task-method-results-header"><p class="task-method-results-count" role="status" aria-live="polite">Loading methods…</p><div class="task-method-pagination"><button type="button" class="button subtle" data-method-page="previous" disabled>Previous</button><button type="button" class="button subtle" data-method-page="next" disabled>Next</button></div></div><div class="task-method-cards" aria-label="Methods" aria-busy="true"></div>', onEditLibrary ? '<button type="button" class="button subtle" data-method-action="edit">Edit methods &amp; types</button><span>Local catalog · complete procedures load on demand.</span>' : '');
    let sequence = 0, timer, response, pending = false;
    const searchInput = target.querySelector('input[type="search"]'), cards = target.querySelector('.task-method-cards'), count = target.querySelector('.task-method-results-count');
    const filters = [...target.querySelectorAll('[data-method-filter]')], previous = target.querySelector('[data-method-page="previous"]'), next = target.querySelector('[data-method-page="next"]');
    if (onEditLibrary) target.querySelector('[data-method-action="edit"]').addEventListener('click', () => { if (active(target, token)) { clearTimeout(timer); onEditLibrary(); } });
    const load = async (restoreFocus = false, allowRestart = true) => {
      clearTimeout(timer); if (!active(target, token)) return;
      const request = ++sequence, params = new URLSearchParams({ compact: 'true', limit: '20', query: browsing.query });
      for (const key of ['domain','phase','output']) if (browsing[key]) params.set(key, browsing[key]);
      if (browsing.offset) { params.set('offset', String(browsing.offset)); params.set('catalogRevision', browsing.catalogRevision); }
      pending = true; previous.disabled = next.disabled = true; cards.setAttribute('aria-busy', 'true'); cards.innerHTML = ''; count.textContent = 'Searching methods…'; target.querySelector('.task-method-error').hidden = true;
      try {
        const result = await api('/api/methods?' + params.toString());
        if (!active(target, token) || request !== sequence) return;
        if (!Array.isArray(result.methods) || !Number.isSafeInteger(result.total) || !Number.isSafeInteger(result.totalMethods) || typeof result.catalogRevision !== 'string') throw Error('The method catalog did not return a complete search page.');
        response = result; browsing.catalogRevision = result.catalogRevision; browsing.offset = result.offset;
        for (const select of filters) {
          const key = select.dataset.methodFilter, values = result.facets?.[key === 'domain' ? 'domains' : key === 'phase' ? 'phases' : 'outputs'] || [];
          const selected = browsing[key], entries = values.map(value => '<option value="' + escape(value.id) + '"' + (value.id === selected ? ' selected' : '') + '>' + escape(value.label) + ' (' + value.count + ')</option>').join('');
          select.innerHTML = '<option value="">All ' + (key === 'phase' ? 'task stages' : key + 's') + '</option>' + entries; select.value = selected;
        }
        count.textContent = result.total ? (result.offset + 1) + '–' + (result.offset + result.methods.length) + ' of ' + result.total + ' matches · ' + result.totalMethods + ' methods' : 'No matches · ' + result.totalMethods + ' methods available';
        cards.innerHTML = result.methods.length ? result.methods.map(method => '<button type="button" class="task-method-card" data-method-id="' + escape(method.id) + '"><span class="task-method-card-type">' + escape(method.catalog?.domain || method.taskType || 'general') + ' <span>' + (method.origin === 'builtin' ? 'Built in' : 'Custom') + '</span></span><strong>' + escape(method.name) + '</strong><p>' + escape(method.description) + '</p><span class="task-method-card-foot">' + method.stepCount + ' steps' + (method.outlineNodeCount ? ' · branching' : '') + (method.catalog?.outputs?.length ? ' · ' + escape(method.catalog.outputs.slice(0,2).join(', ')) : '') + icon('chevron', 15) + '</span></button>').join('') : '<p class="task-method-none">Try a broader task, another output, or clear a filter. Your agent can also build an approach when no catalog entry fits.</p>';
        previous.disabled = !result.offset; next.disabled = result.nextOffset === null;
        if (restoreFocus) { const card = [...cards.querySelectorAll('[data-method-id]')].find(item => item.dataset.methodId === returnMethodId) || cards.querySelector('[data-method-id]'); (card || searchInput).focus({ preventScroll: true }); }
      } catch (cause) {
        if (!active(target, token) || request !== sequence) return;
        if (allowRestart && browsing.offset && cause?.code === 'METHOD_CATALOG_CONFLICT') { browsing.offset = 0; delete browsing.catalogRevision; return load(restoreFocus, false); }
        response = null; count.textContent = 'Methods could not be loaded. Your message is preserved.'; error(target, cause);
        cards.innerHTML = '<button type="button" class="button subtle" data-method-retry>Retry this search</button>'; cards.querySelector('[data-method-retry]').addEventListener('click', () => load(false));
      } finally { if (active(target, token) && request === sequence) { pending = false; cards.setAttribute('aria-busy', 'false'); } }
    };
    const changed = () => {
      if (!active(target, token)) return false;
      clearTimeout(timer); browsing = { query: searchInput.value.trim(), domain: filters.find(select => select.dataset.methodFilter === 'domain').value || '', phase: filters.find(select => select.dataset.methodFilter === 'phase').value || '', output: filters.find(select => select.dataset.methodFilter === 'output').value || '', offset: 0 };
      returnMethodId = null; sequence++; response = null; pending = true; cards.innerHTML = ''; cards.setAttribute('aria-busy', 'true'); count.textContent = 'Searching methods…'; previous.disabled = next.disabled = true; return true;
    };
    searchInput.addEventListener('input', () => { if (changed()) timer = setTimeout(() => load(false), 180); });
    for (const select of filters) select.addEventListener('change', () => { if (changed()) return load(false); });
    target.querySelector('form').addEventListener('submit', event => { event.preventDefault(); if (changed()) return load(false); });
    previous.addEventListener('click', () => { if (!active(target, token) || pending || !response?.offset) return; browsing.offset = Math.max(0, response.offset - response.limit); return load(true); });
    next.addEventListener('click', () => { if (!active(target, token) || pending || response?.nextOffset == null) return; browsing.offset = response.nextOffset; return load(true); });
    cards.addEventListener('click', event => { const button = event.target.closest('[data-method-id]'); if (!button || pending || !active(target, token)) return; const method = response?.methods.find(item => item.id === button.dataset.methodId); if (method) { clearTimeout(timer); returnMethodId = method.id; return loadMethod(method); } });
    return load(!fresh && Boolean(returnMethodId));
  }
  async function loadMethod(reference) {
    const token = ++epoch, target = frame('Opening method', 'Loading the complete procedure and source context.', '<p role="status">Reading your method…</p>', '<button type="button" class="button subtle" data-method-action="back">Back to methods</button>');
    target.querySelector('[data-method-action="back"]').addEventListener('click', () => { if (active(target, token)) return library(false); });
    try { const method = await api('/api/methods/' + encodeURIComponent(reference.id)); if (active(target, token)) detail(method, reference); }
    catch (cause) { if (active(target, token)) error(target, cause); }
  }
  async function openMethod(reference) { begin(); returnMethodId = null; return loadMethod(reference); }
  async function saveTaskMethod({ taskState }) {
    begin(); const token = epoch, taskId = taskState?.taskId, expectedRevision = taskState?.revision;
    const target = frame('Keep this approach.', 'Turn the current task outline into a method you and your agent can reuse.', '<p role="status">Preparing a reusable outline…</p>');
    try {
      if (!taskId || !Number.isSafeInteger(expectedRevision)) throw Error('Wait for the task’s first saved outline.');
      const receipt = await api('/api/tasks/' + encodeURIComponent(taskId) + '/method-draft', 'POST', { expectedRevision });
      if (!active(target, token)) return;
      const method = receipt.method;
      if (!method?.outline || receipt.taskRevision !== expectedRevision) throw Error('The task outline changed while the method was being prepared. Reopen Save as method.');
      const edit = frame('Keep this approach.', 'The steps, branches and checks are copied. Prior results, file evidence and completed choices stay with the original task.', '<form id="task-method-save-form"><div class="task-method-fields"><label><span>Method name</span><input name="name" maxlength="160" required value="' + escape(method.name) + '"></label><label><span>When to use it</span><textarea name="description" maxlength="2000" rows="2">' + escape(method.description) + '</textarea></label></div><details class="task-method-blueprint" open><summary>Review the reusable outline</summary>' + renderMethodOutline(method) + '</details></form>', '<span>From task revision ' + expectedRevision + ' · ' + escape(method.taskType) + '</span><button type="submit" form="task-method-save-form" class="button primary">Save method ' + icon('check', 15) + '</button>');
      let pending = null, saving = false;
      edit.querySelector('form').addEventListener('input', () => { if (!saving) pending = null; });
      edit.querySelector('form').addEventListener('submit', async event => {
        event.preventDefault(); if (saving || !active(edit, token)) return;
        const form = event.currentTarget, name = form.elements.namedItem('name').value.trim(), description = form.elements.namedItem('description').value.trim();
        if (!name) { form.elements.namedItem('name').focus(); return; }
        pending ||= { expectedRevision, name, description }; saving = true;
        const button = edit.querySelector('button[type="submit"]'); button.disabled = true; button.textContent = 'Saving…';
        for (const field of form.querySelectorAll('input,textarea')) field.disabled = true;
        try {
          const saved = await api('/api/tasks/' + encodeURIComponent(taskId) + '/method', 'POST', pending);
          if (!active(edit, token)) return;
          if (!saved?.method?.id) throw Error('The save response was incomplete. Retry to check the same saved method.');
          browsing = { query: saved.method.name, domain: '', phase: '', output: '', offset: 0 }; returnMethodId = saved.method.id; detail(saved.method); toast('Method saved. Its next use starts with fresh results.');
        } catch (cause) { if (active(edit, token)) { error(edit, cause); button.textContent = 'Retry save'; } }
        finally { saving = false; if (edit.isConnected) { button.disabled = false; for (const field of form.querySelectorAll('input,textarea')) field.disabled = false; } }
      });
      edit.querySelector('input').focus({ preventScroll: true });
    } catch (cause) { if (active(target, token)) error(target, cause); }
  }
  return { openLibrary: library, openMethod, saveTaskMethod };
}
