import { text } from '../core/dom.mjs';
import { parseIntelligenceText, intelligenceMapGeometry, INTEL_MAP_LANES } from './intelligence-map-model.mjs';

const intelMapAdd = (parent, tag, label = '', cls = '') => text(parent, label, tag, cls);
const intelMapButton = (parent, label, callback, cls = '') => {
  const element = intelMapAdd(parent, 'button', label, cls);
  element.type = 'button';
  element.addEventListener('click', callback);
  return element;
};
const INTEL_SVG_NS = 'http://www.w3.org/2000/svg';
const intelSvg = (parent, type, attributes = {}) => {
  const node = parent.ownerDocument.createElementNS(INTEL_SVG_NS, type);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  parent.appendChild(node);
  return node;
};
const intelMapLabels = {
  requirements: 'REQ', hypotheses: 'HYP', collection: 'COL', evidence: 'EVD', judgments: 'JDG'
};
function intelMiniText(value, max = 95) {
  const text = String(value || '');
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}
function intelEdgeMeaning(edge) {
  const { from, to, kind } = edge;
  if (kind === 'answers') return to + ' addresses ' + from;
  if (kind === 'tests') return to + ' tests ' + from;
  if (kind === 'supports') return to + ' supports ' + from;
  if (kind === 'challenges') return to + ' challenges ' + from;
  if (kind === 'collected') return to + ' was collected through ' + from;
  if (kind === 'basis') return to + ' is based on ' + from;
  if (kind === 'evaluates') return to + ' evaluates ' + from;
  return from + ' → ' + to + ' (' + kind + ')';
}
function intelPretty(key) { return key.replace(/\b\w/g, letter => letter.toUpperCase()); }

function intelMapDiagram(container, parsed, selectedId, onSelect) {
  const containerWidth = container.getBoundingClientRect?.().width || container.clientWidth || 1210;
  const parentWidth = container.closest?.('.next-planning-detail')?.getBoundingClientRect?.().width || containerWidth;
  const viewportWidth = container.ownerDocument.defaultView?.innerWidth || containerWidth;
  const sidebarWidth = container.ownerDocument.querySelector?.('.next-planning-catalog')?.getBoundingClientRect?.().width || 300;
  const desktopBound = viewportWidth - sidebarWidth - 130;
  const availableWidth = Math.max(320, Math.floor(Math.min(containerWidth, parentWidth, desktopBound)) - 10);
  const geometry = intelligenceMapGeometry(parsed, { availableWidth });
  const viewport = intelMapAdd(container, 'div', '', 'next-intel-graph-scroll');
  viewport.id = 'next-intelligence-map';
  viewport.setAttribute('role', 'region');
  viewport.setAttribute('aria-label', 'Intelligence entities and explicit relationships');
  viewport.tabIndex = 0;
  const stage = intelMapAdd(viewport, 'div', '', 'next-intel-graph-stage');
  stage.style.width = geometry.width + 'px';
  stage.style.height = geometry.height + 'px';
  const related = new Set([selectedId]);
  for (const edge of geometry.edges) {
    if (edge.from === selectedId) related.add(edge.to);
    if (edge.to === selectedId) related.add(edge.from);
  }
  for (const group of geometry.groups) {
    const lane = intelMapAdd(stage, 'div', '', 'next-intel-graph-lane');
    lane.style.left = (group.x - 10) + 'px';
    lane.style.width = (geometry.colWidth + 20) + 'px';
    lane.style.height = (geometry.height - 20) + 'px';
    const head = intelMapAdd(lane, 'div', '', 'next-intel-graph-lane-header');
    intelMapAdd(head, 'span', group.label, 'next-intel-graph-lane-title');
    intelMapAdd(head, 'span', String(group.nodes.length).padStart(2, '0'), 'next-intel-graph-lane-count');
    intelMapAdd(lane, 'p', group.hint, 'next-help next-intel-lane-hint');
    if (!group.nodes.length) {
      const empty = intelMapAdd(lane, 'div', 'No ' + group.label.toLowerCase() + ' defined', 'next-intel-graph-empty');
      empty.style.top = '105px';
    }
  }
  const svg = intelSvg(stage, 'svg', { class: 'next-intel-graph-links', viewBox: '0 0 ' + geometry.width + ' ' + geometry.height, width: geometry.width, height: geometry.height, 'aria-hidden': true });
  const defs = intelSvg(svg, 'defs');
  const marker = intelSvg(defs, 'marker', { id: 'next-intel-graph-arrow', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' });
  intelSvg(marker, 'path', { d: 'M 0 1 L 10 5 L 0 9 z', fill: 'context-stroke' });
  for (const edge of geometry.edges) {
    const from = geometry.positions.get(edge.from), to = geometry.positions.get(edge.to);
    const x1 = from.x + from.width + 2, y1 = from.y + 46;
    const x2 = to.x - 3, y2 = to.y + 46;
    const bend = Math.max(36, (x2 - x1) / 2);
    const path = intelSvg(svg, 'path', {
      d: 'M ' + x1 + ' ' + y1 + ' C ' + (x1 + bend) + ' ' + y1 + ' ' + (x2 - bend) + ' ' + y2 + ' ' + x2 + ' ' + y2,
      class: 'next-intel-graph-edge next-intel-graph-edge-' + edge.kind
        + (selectedId && edge.from !== selectedId && edge.to !== selectedId ? ' is-muted' : ''),
      'marker-end': 'url(#next-intel-graph-arrow)',
      'data-link': edge.id
    });
    const source = parsed.byId.get(edge.from), target = parsed.byId.get(edge.to);
    const title = intelSvg(path, 'title');
    title.textContent = intelEdgeMeaning(edge);
  }
  for (const entity of parsed.entities) {
    const where = geometry.positions.get(entity.id);
    const card = intelMapButton(stage, '', () => onSelect(entity.id), 'next-intel-graph-node');
    card.style.left = where.x + 'px';
    card.style.top = where.y + 'px';
    card.style.width = where.width + 'px';
    card.style.height = where.height + 'px';
    card.dataset.intelId = entity.id;
    card.dataset.intelKind = entity.kind;
    card.setAttribute('aria-pressed', String(selectedId === entity.id));
    card.setAttribute('aria-label', entity.id + ', ' + entity.title);
    if (selectedId === entity.id) card.classList.add('is-selected');
    else if (selectedId && !related.has(entity.id)) card.classList.add('is-muted');
    const eyebrow = intelMapAdd(card, 'span', '', 'next-intel-node-eyebrow');
    intelMapAdd(eyebrow, 'span', entity.id);
    intelMapAdd(eyebrow, 'span', intelMapLabels[entity.kind]);
    intelMapAdd(card, 'strong', intelMiniText(entity.title, 110), 'next-intel-node-title');
    const attribute = entity.attrs['confidence'] || entity.attrs['priority'] || entity.attrs['reliability'] || entity.attrs['source'] || entity.attrs['status'] || '';
    if (attribute) intelMapAdd(card, 'span', intelMiniText(attribute, 42), 'next-intel-node-caption');
  }
  return viewport;
}

function intelMapInspector(target, parsed, selectedId, onSelect, onJump) {
  target.replaceChildren();
  const node = parsed.byId.get(selectedId);
  if (!node) {
    intelMapAdd(target, 'span', 'ANALYTICAL INSPECTOR', 'next-intel-kicker');
    intelMapAdd(target, 'h3', 'Explore the assessment');
    intelMapAdd(target, 'p', 'Select a card to review its source text, references and analytic context.', 'next-help');
    return;
  }
  intelMapAdd(target, 'span', node.id + ' / ' + intelMapLabels[node.kind], 'next-intel-kicker');
  intelMapAdd(target, 'h3', node.title);
  const attrs = Object.entries(node.attrs);
  if (!attrs.length) intelMapAdd(target, 'p', 'No further attributes recorded.', 'next-help');
  for (const [key, value] of attrs) {
    const entry = intelMapAdd(target, 'div', '', 'next-intel-inspector-field');
    intelMapAdd(entry, 'strong', intelPretty(key));
    intelMapAdd(entry, 'p', value || 'Not yet specified', value ? '' : 'next-help');
  }
  const incoming = parsed.edges.filter(edge => edge.to === node.id || edge.from === node.id);
  if (incoming.length) {
    intelMapAdd(target, 'h4', 'Recorded relationships');
    const rows = intelMapAdd(target, 'div', '', 'next-intel-inspector-relations');
    for (const relation of incoming) {
      const other = relation.from === node.id ? relation.to : relation.from;
      const title = intelEdgeMeaning(relation);
      intelMapButton(rows, title, () => onSelect(other), 'next-intel-inspector-link');
    }
  }
  intelMapButton(target, 'Locate line ' + node.line + ' in source', () => onJump(node.line), 'next-intel-inspector-jump');
}

function intelMapDiagnostics(target, parsed, editable) {
  target.replaceChildren();
  const summary = intelMapAdd(target, 'p', parsed.entities.length + ' entities  ·  ' + parsed.edges.length + ' explicit links' + (parsed.errors.length ? '  ·  ' + parsed.errors.length + ' errors' : '') + (parsed.warnings.length ? '  ·  ' + parsed.warnings.length + ' notes' : ''), 'next-help');
  summary.classList.add('next-intel-graph-counts');
  if (parsed.errors.length) {
    const list = intelMapAdd(target, 'ul', '', 'next-intel-validation-errors');
    list.setAttribute('role', 'alert');
    for (const error of parsed.errors.slice(0, 7)) intelMapAdd(list, 'li', (error.line ? 'Line ' + error.line + ': ' : '') + error.message);
  } else if (editable) intelMapAdd(target, 'p', 'Map is derived from this source. Saving retains its text, with trailing blank lines trimmed.', 'next-help next-intel-source-success');
  if (parsed.warnings.length) {
    const hint = intelMapAdd(target, 'details', '', 'next-intel-warnings');
    intelMapAdd(hint, 'summary', 'Analytic caveats (' + parsed.warnings.length + ')');
    for (const warning of parsed.warnings.slice(0, 8)) intelMapAdd(hint, 'p', warning.message, 'next-help');
  }
}

/**
 * One source of truth, two projections. The source is never reconstructed from
 * the canvas. Selection is only a view interaction, not an automatic edit.
 */
export function renderIntelligenceMapWorkspace({
  parent, source, editable = false, project = null, onSave = async () => {},
  onCancel = () => {}, onEdit = () => {}
} = {}) {
  parent.replaceChildren();
  let current = String(source || ''), selectedId = null, mode = editable ? 'split' : 'map', busy = false;
  const shell = intelMapAdd(parent, 'section', '', 'next-intel-map-workspace');
  shell.id = 'next-intelligence-map-workspace';
  const header = intelMapAdd(shell, 'header', '', 'next-intel-map-head');
  const copy = intelMapAdd(header, 'div');
  intelMapAdd(copy, 'span', 'INTELLIGENCE MODEL / TEXT → MAP', 'next-intel-kicker');
  intelMapAdd(copy, 'h2', editable ? (project ? 'Revise the analytical model' : 'New analytical model') : (project?.name || 'Intelligence model'));
  intelMapAdd(copy, 'p', editable ? 'Write the model as structured Markdown. The diagram changes with the text.' : 'This diagram is a projection of the saved Markdown source. It does not infer new evidence or conclusions.', 'next-help');
  const toolbar = intelMapAdd(shell, 'nav', '', 'next-intel-map-toolbar');
  toolbar.setAttribute('aria-label', 'Intelligence model views');
  const viewButtons = new Map();
  const applyMode = nextMode => {
    mode = nextMode;
    for (const [value, node] of viewButtons) node.setAttribute('aria-pressed', String(mode === value));
    shell.dataset.mode = mode;
    graphPanel.hidden = mode === 'text';
    sourcePanel.hidden = mode === 'map';
    if (mode === 'source') shell.dataset.mode = 'text';
    if (mode === 'split') shell.dataset.mode = 'split';
    if (mode === 'map') shell.dataset.mode = 'map';
  };
  for (const [value, label] of [['map','Map'],['split','Map + source'],['source','Source']]) {
    const control = intelMapButton(toolbar, label, () => applyMode(value));
    control.setAttribute('aria-pressed', String(mode === value));
    viewButtons.set(value, control);
  }
  const copyButton = intelMapButton(toolbar, 'Copy LLM source', async () => {
    try {
      if (!globalThis.navigator?.clipboard?.writeText) throw Error('Clipboard write is not available.');
      await globalThis.navigator.clipboard.writeText(current);
      feedback.textContent = 'Exact source copied.';
    } catch {
      applyMode('source');
      editor.focus();
      editor.select();
      feedback.textContent = 'Source selected. Use Ctrl+C to copy.';
    }
  });
  copyButton.title = 'Copy the canonical text representation';
  const content = intelMapAdd(shell, 'div', '', 'next-intel-map-content');
  const graphPanel = intelMapAdd(content, 'section', '', 'next-intel-map-graph-pane');
  const sourcePanel = intelMapAdd(content, 'section', '', 'next-intel-map-source-pane');
  sourcePanel.id = 'next-intelligence-text-panel';
  const label = intelMapAdd(sourcePanel, 'label', 'CANONICAL MARKDOWN — LLM READ / WRITE', 'next-intel-source-label');
  const editor = intelMapAdd(label, 'textarea', '', 'next-intel-source-editor');
  editor.id = 'next-intelligence-source';
  editor.value = current;
  editor.readOnly = !editable;
  editor.spellcheck = false;
  editor.rows = 24;
  editor.maxLength = 8000;
  editor.setAttribute('aria-label', 'Canonical intelligence analysis plan source text');
  intelMapAdd(sourcePanel, 'p', 'Use [REQ-1], [HYP-1], [COL-1], [EVD-1], [JDG-1]. Relationships are explicit references: Answers, Tests, From, Supports, Challenges, Based on, Evaluates.', 'next-help next-intel-source-help');
  const mapTop = intelMapAdd(graphPanel, 'div', '', 'next-intel-map-brief');
  const legend = intelMapAdd(graphPanel, 'div', '', 'next-intel-graph-legend');
  for (const [kind, label] of [['tests','Planned test'], ['supports','Supports'], ['challenges','Challenges'], ['basis','Evidence → judgment']]) {
    const entry = intelMapAdd(legend, 'span', '', 'next-intel-legend-item');
    const line = intelMapAdd(entry, 'i', '', 'next-intel-legend-line next-intel-graph-edge-' + kind);
    line.setAttribute('aria-hidden', 'true');
    intelMapAdd(entry, 'span', label);
  }
  const diagramArea = intelMapAdd(graphPanel, 'div', '', 'next-intel-map-diagram');
  const inspector = intelMapAdd(graphPanel, 'aside', '', 'next-intel-map-inspector');
  inspector.id = 'next-intelligence-inspector';
  inspector.setAttribute('aria-label', 'Selected intelligence entity');
  const diagnostics = intelMapAdd(shell, 'div', '', 'next-intel-map-diagnostics');
  const actions = intelMapAdd(shell, 'div', '', 'next-row next-intel-map-actions');
  let saveButton;
  if (editable) {
    saveButton = intelMapButton(actions, project ? 'Save intelligence model' : 'Save assessment draft', async () => {
      if (busy) return;
      const canonical = current.trimEnd();
      const parsed = parseIntelligenceText(canonical, { requireBrief: true });
      if (!parsed.valid) { refresh(); applyMode('split'); feedback.textContent = 'Resolve the text validation errors before saving.'; return; }
      busy = true; saveButton.disabled = true; feedback.textContent = 'Saving exact text source…';
      try { await onSave(canonical, project); current = canonical; editor.value = canonical; feedback.textContent = 'Canonical intelligence text saved.'; }
      catch (error) { feedback.textContent = error?.message || String(error); feedback.setAttribute('role', 'alert'); }
      finally { busy = false; saveButton.disabled = false; }
    }, 'next-primary');
    saveButton.id = 'next-intelligence-save';
    intelMapButton(actions, 'Cancel', onCancel);
  } else intelMapButton(actions, 'Edit underlying text', onEdit, 'next-primary');
  const feedback = intelMapAdd(actions, 'p', '', 'next-help');
  feedback.id = 'next-intelligence-receipt';
  feedback.setAttribute('role', 'status');

  const jumpToSource = line => {
    applyMode('split');
    const lines = editor.value.split('\n');
    const position = lines.slice(0, line - 1).reduce((total, value) => total + value.length + 1, 0);
    editor.focus();
    editor.setSelectionRange(position, position + (lines[line - 1] || '').length);
    const fraction = Math.max(0, (line - 3) / Math.max(1, lines.length));
    editor.scrollTop = fraction * Math.max(0, editor.scrollHeight - editor.clientHeight);
  };
  const choose = id => { selectedId = id; refresh(); };
  function refresh() {
    const parsed = parseIntelligenceText(current, { requireBrief: editable });
    if (!parsed.byId.has(selectedId)) selectedId = parsed.entities[0]?.id || null;
    const oldViewport = diagramArea.querySelector('.next-intel-graph-scroll');
    const left = oldViewport?.scrollLeft || 0, top = oldViewport?.scrollTop || 0;
    diagramArea.replaceChildren();
    mapTop.replaceChildren();
    const pir = intelMapAdd(mapTop, 'div', '', 'next-intel-pir-brief');
    intelMapAdd(pir, 'span', 'PRIORITY INTELLIGENCE REQUIREMENT', 'next-intel-kicker');
    intelMapAdd(pir, 'strong', parsed.fields.pir || 'State the priority intelligence question');
    const decision = intelMapAdd(mapTop, 'div', '', 'next-intel-decision-brief');
    intelMapAdd(decision, 'span', 'DECISION TO INFORM', 'next-intel-kicker');
    intelMapAdd(decision, 'p', parsed.fields.decision || 'Decision not yet specified');
    const viewport = intelMapDiagram(diagramArea, parsed, selectedId, choose);
    viewport.scrollLeft = left; viewport.scrollTop = top;
    intelMapInspector(inspector, parsed, selectedId, choose, jumpToSource);
    intelMapDiagnostics(diagnostics, parsed, editable);
    if (saveButton) saveButton.disabled = busy || !parsed.valid;
    feedback.textContent = current.length + '/8000 characters in canonical source';
  }
  editor.addEventListener('input', () => { current = editor.value; refresh(); });
  applyMode(mode);
  refresh();
  let lastWidth = Math.round(diagramArea.getBoundingClientRect?.().width || 0);
  const ViewResizeObserver = parent.ownerDocument.defaultView?.ResizeObserver;
  let resizeObserver = null;
  if (typeof ViewResizeObserver === 'function') {
    resizeObserver = new ViewResizeObserver(entries => {
      if (!shell.isConnected) { resizeObserver.disconnect(); return; }
      const width = Math.round(entries[0]?.contentRect?.width || diagramArea.clientWidth || 0);
      if (width && Math.abs(width - lastWidth) > 2) {
        lastWidth = width;
        refresh();
      }
    });
    resizeObserver.observe(diagramArea);
  }
  return { getSource: () => current, refresh, destroy: () => resizeObserver?.disconnect() };
}
