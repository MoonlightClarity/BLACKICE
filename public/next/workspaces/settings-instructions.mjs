import {renderInstructionAudit, instructionAuditText} from './instruction-audit.mjs';
import {createInstructionEditor} from './settings-instruction-editor.mjs';

const make = (doc, tag, value = '', className = '') => {
  const node = doc.createElement(tag); node.textContent = value;
  if (className) node.className = className;
  return node;
};
const validAudit = value => value?.version === 1 && Array.isArray(value.sections);

/** Config's saved owner instructions and exact execution snapshots. */
export function createInstructionSettings({mount, api, onSelectFile}) {
  const doc = mount.ownerDocument;
  const heading = make(doc, 'h3', 'Instructions');
  const description = make(doc, 'p',
    'SOUL.md controls behavior, USER.md holds your profile, and selected skills supply task procedures. Edit the shared instructions below; saved changes apply to the next execution.', 'next-help');
  const sourceLinks = make(doc, 'div', '', 'next-instruction-controls');
  for (const [kind, label] of [['soul', 'Edit SOUL.md'], ['user', 'Edit USER.md']]) {
    const button = make(doc, 'button', label); button.type = 'button';
    button.addEventListener('click', () => onSelectFile?.(kind)); sourceLinks.append(button);
  }
  const current = make(doc, 'section', '', 'next-instruction-editor');
  current.id = 'next-instructions-core';
  const editor = createInstructionEditor({mount:current, api});
  const label = make(doc, 'h3', 'Captured executions');
  const explanation = make(doc, 'p',
    'Inspect the instructions captured for a particular execution, including their source and layer. Later edits do not rewrite a saved snapshot.', 'next-help');
  const form = make(doc, 'form', '', 'next-instruction-controls'), recent = make(doc, 'select'), runInput = make(doc, 'input');
  form.id = 'next-instructions-audit-form';
  recent.id = 'next-instructions-recent'; recent.className = 'next-field'; recent.setAttribute('aria-label', 'Recent execution');
  runInput.id = 'next-instructions-run-id'; runInput.className = 'next-field'; runInput.type = 'text'; runInput.placeholder = 'Turn ID';
  runInput.setAttribute('aria-label', 'Execution turn ID'); runInput.maxLength = 120;
  const inspect = make(doc, 'button', 'Inspect'), refresh = make(doc, 'button', 'Refresh');
  inspect.type = 'submit'; refresh.type = 'button';
  form.append(recent, runInput, inspect, refresh);
  const nodeControls = make(doc, 'div', '', 'next-instruction-controls'), choose = make(doc, 'select'), download = make(doc, 'button', 'Download readable audit');
  choose.id = 'next-instructions-node'; choose.className = 'next-field'; choose.setAttribute('aria-label', 'Execution node');
  download.id = 'next-instructions-download'; download.type = 'button'; download.disabled = true;
  choose.hidden = true; nodeControls.append(choose, download);
  const status = make(doc, 'p', '', 'next-help'), content = make(doc, 'div', '', 'next-instruction-content');
  status.id = 'next-instructions-status'; status.setAttribute('role', 'status');
  content.id = 'next-instructions-content';
  mount.replaceChildren(heading, description, sourceLinks, current, label, explanation, form, nodeControls, status, content);
  let active = false, destroyed = false, indexRead = 0, auditRead = 0, indexController = null, auditController = null, record = null;
  function invalidate() {
    indexRead++; auditRead++; indexController?.abort(); auditController?.abort();
    indexController = auditController = null;
  }
  function paint() {
    const node = record?.nodes?.find(row => row.nodeId === choose.value);
    if (!validAudit(node?.audit)) {
      const pending = ['queued', 'running', 'waiting'].includes(record?.status);
      content.replaceChildren(make(doc, 'p', pending ? 'No instruction snapshot has been captured for this execution yet.' :
        'This turn has no saved instruction snapshot. Current files cannot reconstruct what the model received.', 'next-help'));
      return;
    }
    renderInstructionAudit(content, node.audit);
  }
  async function loadAudit() {
    const id = runInput.value.trim();
    if (!active || destroyed || !id) return;
    const token = ++auditRead, previousNode = choose.value;
    auditController?.abort(); auditController = new AbortController(); record = null;
    content.replaceChildren(); download.disabled = true; choose.hidden = true;
    status.textContent = 'Reading captured instructions…';
    try {
      const result = await api('/api/runs/' + encodeURIComponent(id) + '/instructions', 'GET', undefined, {signal:auditController.signal});
      if (!active || destroyed || token !== auditRead || runInput.value.trim() !== id) return;
      if (result?.runId !== id || !Array.isArray(result.nodes)) throw Error('Instruction audit scope mismatch.');
      record = result; choose.replaceChildren();
      for (const node of result.nodes) {
        const option = make(doc, 'option', (node.name || node.nodeId) + (validAudit(node.audit) ? '' : ' · Not captured'));
        option.value = node.nodeId; choose.append(option);
      }
      choose.hidden = result.nodes.length < 2;
      choose.value = result.nodes.some(node => node.nodeId === previousNode) ? previousNode :
        result.nodes.findLast(node => validAudit(node.audit))?.nodeId || result.nodes[0]?.nodeId || '';
      const available = result.nodes.filter(node => validAudit(node.audit)).length;
      download.disabled = !available;
      status.textContent = available ? available + (available === 1 ? ' execution snapshot captured.' : ' execution snapshots captured.') : '';
      paint();
    } catch (error) {
      if (active && !destroyed && token === auditRead && error.name !== 'AbortError') status.textContent = error.message || 'Could not read the instruction audit.';
    }
  }
  async function loadIndex() {
    if (!active || destroyed) return;
    const token = ++indexRead, selected = runInput.value.trim();
    indexController?.abort(); indexController = new AbortController();
    status.textContent = 'Reading instruction configuration…';
    try {
      const result = await api('/api/instructions', 'GET', undefined, {signal:indexController.signal});
      if (!active || destroyed || token !== indexRead) return;
      if (!Array.isArray(result?.runs)) throw Error('BLACKICE returned an unreadable instruction index.');
      recent.replaceChildren();
      for (const run of result.runs) {
        const name = [run.createdAt ? new Date(run.createdAt).toLocaleString() : '', run.title || run.id, run.captured === true ? 'captured' : run.captured === false ? 'no snapshot' : 'inspect snapshot'].filter(Boolean).join(' · ');
        const option = make(doc, 'option', name); option.value = run.id; recent.append(option);
      }
      recent.disabled = !result.runs.length;
      const id = selected || result.runs.find(run => run.captured)?.id || result.runs[0]?.id || '';
      if (runInput.value.trim() === selected) runInput.value = id;
      recent.value = result.runs.some(run => run.id === runInput.value.trim()) ? runInput.value.trim() : '';
      if (runInput.value.trim()) await loadAudit();
      else { status.textContent = 'No executions are available yet. A new execution will capture its active instruction sources.'; content.replaceChildren(); }
    } catch (error) {
      if (active && !destroyed && token === indexRead && error.name !== 'AbortError') { status.textContent = error.message || 'Could not read instruction configuration.'; }
    }
  }
  form.addEventListener('submit', event => { event.preventDefault(); void loadAudit(); });
  recent.addEventListener('change', () => { runInput.value = recent.value; void loadAudit(); });
  runInput.addEventListener('input', () => {
    auditRead++; auditController?.abort(); record = null; download.disabled = true; content.replaceChildren(); choose.hidden = true;
  });
  refresh.addEventListener('click', () => void loadIndex());
  choose.addEventListener('change', paint);
  download.addEventListener('click', () => {
    if (!record || download.disabled || !active || destroyed) return;
    const urlApi = doc.defaultView?.URL || globalThis.URL, BlobType = doc.defaultView?.Blob || globalThis.Blob;
    const url = urlApi.createObjectURL(new BlobType([instructionAuditText(record)], {type:'text/plain;charset=utf-8'}));
    const link = make(doc, 'a'); link.href = url; link.download = 'blackice-instructions-' + record.runId + '.txt'; mount.append(link);
    try { link.click(); status.textContent = 'Readable audit download started.'; }
    finally { link.remove(); setTimeout(() => urlApi.revokeObjectURL(url), 1000); }
  });
  return {
    enter() { if (active || destroyed) return; active = true; editor.enter(); void loadIndex(); },
    leave() { active = false; invalidate(); editor.leave(); },
    destroy() { this.leave(); destroyed = true; editor.destroy(); mount.replaceChildren(); },
  };
}
