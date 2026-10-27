/** Pure editor state helpers, shared by the browser and its regression tests. */
export class WorkflowHistory {
  constructor(limit = 80) { this.limit = limit; this.reset(null); }
  reset(value) { this.entries = value ? [JSON.stringify(value)] : []; this.index = this.entries.length - 1; this.group = null; this.changedAt = 0; }
  get canUndo() { return this.index > 0; }
  get canRedo() { return this.index < this.entries.length - 1; }
  record(value, group = null, now = Date.now()) {
    const snapshot = JSON.stringify(value);
    if (snapshot === this.entries[this.index]) return false;
    const merge = group && group === this.group && now - this.changedAt < 900 && this.index > 0 && !this.canRedo;
    this.entries = this.entries.slice(0, this.index + 1);
    if (merge) this.entries[this.index] = snapshot;
    else { this.entries.push(snapshot); this.index++; }
    if (this.entries.length > this.limit) { this.entries.shift(); this.index--; }
    this.group = group; this.changedAt = now;
    return true;
  }
  undo() { if (!this.canUndo) return null; this.group = null; return JSON.parse(this.entries[--this.index]); }
  redo() { if (!this.canRedo) return null; this.group = null; return JSON.parse(this.entries[++this.index]); }
}

export function diagnoseWorkflow(workflow) {
  const nodes = workflow?.nodes || [], edges = workflow?.edges || [], issues = [];
  const add = (code, message, nodeId = null, level = 'error') => issues.push({ code, message, nodeId, level });
  if (!nodes.length) { add('empty', 'Add a task input, an agent, and an output to begin.'); return issues; }
  if (nodes.length < 2) add('node-count', 'A workflow needs at least two connected nodes.');
  if (nodes.length > 40) add('node-limit', 'Use at most 40 nodes per workflow.');
  if (edges.length > 100) add('edge-limit', 'Use at most 100 connections.');
  const ids = new Set(), incoming = new Map(), outgoing = new Map();
  for (const node of nodes) {
    if (ids.has(node.id)) add('duplicate-id', `“${node.name || node.id}” has a duplicate node ID.`, node.id);
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(node.id || '')) add('invalid-id', `“${node.name || 'Node'}” has an invalid node ID.`, node.id);
    ids.add(node.id); incoming.set(node.id, []); outgoing.set(node.id, []);
    if (!['input', 'agent', 'output', 'approval'].includes(node.type)) add('invalid-type', `“${node.name || node.id}” has an unsupported node type.`, node.id);
    if (node.type === 'agent' && !String(node.prompt || '').trim()) add('missing-prompt', `Give “${node.name || 'Codex agent'}” instructions.`, node.id);
  }
  const pairs = new Set();
  for (const edge of edges) {
    if (!ids.has(edge.source) || !ids.has(edge.target)) { add('missing-node', 'A connection points to a node that no longer exists.'); continue; }
    const pair = `${edge.source}:${edge.target}`;
    if (pairs.has(pair)) add('duplicate-edge', 'Remove the duplicate connection.', edge.target);
    pairs.add(pair);
    if (edge.source === edge.target) add('self-edge', 'A node cannot connect to itself.', edge.source);
    incoming.get(edge.target).push(edge.source); outgoing.get(edge.source).push(edge.target);
  }
  const inputs = nodes.filter(node => node.type === 'input'), outputs = nodes.filter(node => node.type === 'output');
  if (inputs.length !== 1) add('input-count', inputs.length ? 'Keep exactly one task input.' : 'Add one task input.');
  if (!outputs.length) add('output-count', 'Add an output node to collect the result.');
  for (const input of inputs) if (incoming.get(input.id).length) add('input-incoming', 'The task input must be the starting point.', input.id);
  for (const output of outputs) if (outgoing.get(output.id).length) add('output-outgoing', 'An output must be the end of its branch.', output.id);
  const degree = new Map([...incoming].map(([id, dependencies]) => [id, dependencies.length]));
  const queue = [...degree].filter(([, count]) => !count).map(([id]) => id);
  let visited = 0;
  while (queue.length) { const id = queue.shift(); visited++; for (const target of outgoing.get(id)) { degree.set(target, degree.get(target) - 1); if (!degree.get(target)) queue.push(target); } }
  if (visited < ids.size) add('cycle', 'Remove the connection that creates a cycle.');
  const reachable = (starts, map) => { const seen = new Set(starts), queue = [...starts]; while (queue.length) for (const target of map.get(queue.shift()) || []) if (!seen.has(target)) { seen.add(target); queue.push(target); } return seen; };
  const fromInput = reachable(inputs.map(node => node.id), outgoing), toOutput = reachable(outputs.map(node => node.id), incoming);
  if (inputs.length === 1) for (const node of nodes) if (!fromInput.has(node.id)) add('unreachable-input', `Connect “${node.name || node.id}” to the task input.`, node.id);
  if (outputs.length) for (const node of nodes) if (!toOutput.has(node.id)) add('unreachable-output', `Connect “${node.name || node.id}” to an output.`, node.id);
  if (!nodes.some(node => node.type === 'agent')) add('no-agent', 'This workflow passes the task through without running a Codex agent.', null, 'warning');
  return issues;
}

export function fitWorkflow(nodes, viewport, nodeSize = { width: 224, height: 145 }) {
  if (!nodes?.length || viewport.width <= 0 || viewport.height <= 0) return { x: 30, y: 110, scale: 1 };
  const left = 38, right = 38, top = Math.min(112, viewport.height * .28), bottom = Math.min(64, viewport.height * .19);
  const minX = Math.min(...nodes.map(node => Number(node.x) || 0)) - 8;
  const minY = Math.min(...nodes.map(node => Number(node.y) || 0)) - 27;
  const maxX = Math.max(...nodes.map(node => (Number(node.x) || 0) + nodeSize.width)) + 8;
  const maxY = Math.max(...nodes.map(node => (Number(node.y) || 0) + nodeSize.height)) + 8;
  const width = maxX - minX, height = maxY - minY;
  const availableWidth = Math.max(1, viewport.width - left - right), availableHeight = Math.max(1, viewport.height - top - bottom);
  const scale = Math.min(1.05, availableWidth / width, availableHeight / height);
  return { scale, x: left + (availableWidth - width * scale) / 2 - minX * scale, y: top + (availableHeight - height * scale) / 2 - minY * scale };
}

export function runMetrics(run, now = Date.now()) {
  const nodes = Object.values(run?.nodes || {}), start = Date.parse(run?.startedAt || run?.createdAt);
  const finish = run?.finishedAt ? Date.parse(run.finishedAt) : now;
  const usage = run?.usage || nodes.filter(node => !node.reused).reduce((sum, node) => {
    if (node.usage) { sum.totalTokens += Number(node.usage.totalTokens) || 0; sum.reported = true; }
    return sum;
  }, { totalTokens: 0, reported: false });
  return {
    completed: nodes.filter(node => node.status === 'completed').length,
    total: nodes.length,
    failed: nodes.filter(node => node.status === 'failed').length,
    reused: nodes.filter(node => node.reused).length,
    durationMs: Number.isFinite(start) && Number.isFinite(finish) ? Math.max(0, finish - start) : null,
    totalTokens: Number(usage.totalTokens) || 0,
    hasUsage: Boolean(usage.reported || nodes.some(node => node.usage) || Number(usage.totalTokens) > 0)
  };
}

const html = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
function linkToken(value, start) {
  let bracket = 1, end = start + 1;
  for (; end < value.length && end - start < 4000; end++) {
    if (value[end] === '\n') return null;
    if (value[end] === '[' && ++bracket > 8) return null;
    if (value[end] === ']' && --bracket === 0) break;
  }
  if (bracket || value[end + 1] !== '(') return null;
  const label = value.slice(start + 1, end), begin = end + 2;
  if (value[begin] === '<') {
    const offset = value.slice(begin + 1, begin + 8001).indexOf('>');
    const closing = offset < 0 ? -1 : begin + 1 + offset;
    if (closing < 0 || closing - begin > 8000 || value[closing + 1] !== ')' || /[\r\n]/.test(value.slice(begin, closing))) return null;
    return { label, href: value.slice(begin + 1, closing), end: closing + 2 };
  }
  let parens = 1;
  for (end = begin; end < value.length && end - begin < 8000; end++) {
    if (/\s/.test(value[end])) return null;
    if (value[end] === '(' && ++parens > 8) return null;
    if (value[end] === ')' && --parens === 0) return { label, href: value.slice(begin, end), end: end + 1 };
  }
  return null;
}
function inlineMarkdown(value, { links = true, depth = 0, resolveArtifact } = {}) {
  if (depth >= 8) return html(value);
  let out = '', cursor = 0;
  for (let index = 0; index < value.length; index++) {
    let token, kind, end;
    if (value[index] === '`' && (end = value.indexOf('`', index + 1)) > index + 1 && !value.slice(index, end).includes('\n')) { kind = 'code'; token = { end: end + 1 }; }
    else if (value.startsWith('**', index) && (end = value.indexOf('**', index + 2)) > index + 2 && !value.slice(index, end).includes('\n')) { kind = 'strong'; token = { end: end + 2 }; }
    else if (links && value[index] === '[') { kind = 'link'; token = linkToken(value, index); }
    if (!token) continue;
    out += html(value.slice(cursor, index)); const source = value.slice(index, token.end);
    if (kind === 'code') out += `<code>${html(source.slice(1, -1))}</code>`;
    else if (kind === 'strong') out += `<strong>${inlineMarkdown(source.slice(2, -2), { links, depth: depth + 1, resolveArtifact })}</strong>`;
    else {
      const { label, href } = token; let safe = false;
      try { safe = ['http:', 'https:'].includes(new URL(href).protocol); } catch {}
      const local = /^(?:[a-z]:[\\/]|\/|file:|\.{1,2}\/)/i.test(href), relative = !/^[a-z][a-z0-9+.-]*:/i.test(href);
      let artifact;
      if (!safe && (local || relative) && typeof resolveArtifact === 'function') { try { artifact = resolveArtifact(href); } catch {} }
      const registered = artifact && ['taskId', 'artifactId'].every(key => typeof artifact[key] === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(artifact[key]));
      const formattedLabel = () => inlineMarkdown(label, { links: false, depth: depth + 1 });
      out += safe ? `<a href="${html(href)}" target="_blank" rel="noopener noreferrer">${formattedLabel()}</a>`
        : registered ? `<a href="/api/tasks/${encodeURIComponent(artifact.taskId)}/artifacts/${encodeURIComponent(artifact.artifactId)}/preview" data-task-artifact="${html(artifact.artifactId)}" data-task-id="${html(artifact.taskId)}">${formattedLabel()}</a>`
          : local ? `<span class="local-file-label" title="${html(href)}">${formattedLabel()}</span>` : html(source);
    }
    cursor = token.end; index = token.end - 1;
  }
  return out + html(value.slice(cursor));
}

/** Small intentionally limited Markdown renderer: raw HTML, images and executable URLs stay inert. */
export function renderMarkdown(value, { resolveArtifact } = {}) {
  const inline = text => inlineMarkdown(text, { resolveArtifact });
  const indentation = line => (line.match(/^[ \t]*/)?.[0] || '').replaceAll('\t', '    ').length;
  const stripIndent = (line, columns) => {
    let index = 0, width = 0;
    while (index < line.length && width < columns && /[ \t]/.test(line[index])) width += line[index++] === '\t' ? 4 : 1;
    return line.slice(index);
  };
  const marker = line => {
    const match = line.match(/^([ \t]*)(?:(\d{1,9})([.)])|([-+*]))([ \t]+)(.*)$/);
    if (!match) return null;
    const indent = indentation(match[1]), type = match[2] === undefined ? 'ul' : 'ol';
    return { indent, type, delimiter: type === 'ol' ? match[3] : '', start: Number(match[2] || 1),
      content: match[6], contentIndent: indent + (match[2]?.length || 0) + 1 + indentation(match[5]) };
  };
  const heading = line => line.match(/^[ \t]{0,3}(#{1,4})\s+(.+)$/);
  const fence = line => line.match(/^[ \t]*\x60{3}([\w-]*)/);
  function renderLines(lines, depth = 0) {
    if (depth >= 24) return '<p>' + lines.map(inline).join('<br>') + '</p>';
    const result = []; let paragraph = [], index = 0;
    const flush = () => { if (paragraph.length) { result.push('<p>' + paragraph.map(inline).join('<br>') + '</p>'); paragraph = []; } };
    while (index < lines.length) {
      const line = lines[index], opening = fence(line), title = heading(line), first = marker(line);
      if (!line.trim()) { flush(); index++; continue; }
      if (opening) {
        flush(); const code = []; index++;
        while (index < lines.length && !/^[ \t]*\x60{3,}\s*$/.test(lines[index])) code.push(lines[index++]);
        if (index < lines.length) index++;
        result.push('<pre><code' + (opening[1] ? ' data-language="' + html(opening[1]) + '"' : '') + '>' + html(code.join('\n')) + '</code></pre>');
      } else if (title) {
        flush(); const level = title[1].length + 1;
        result.push('<h' + level + '>' + inline(title[2]) + '</h' + level + '>'); index++;
      } else if (first) {
        flush(); const items = []; let loose = false;
        const sibling = item => item && item.indent === first.indent && item.type === first.type && item.delimiter === first.delimiter;
        while (index < lines.length && sibling(marker(lines[index]))) {
          const current = marker(lines[index++]), body = [current.content];
          while (index < lines.length) {
            const next = lines[index], nextMarker = marker(next);
            if (!next.trim()) {
              let lookahead = index;
              while (lookahead < lines.length && !lines[lookahead].trim()) lookahead++;
              if (lookahead === lines.length) { index = lookahead; break; }
              if (sibling(marker(lines[lookahead]))) { loose = true; index = lookahead; break; }
              if (indentation(lines[lookahead]) > first.indent) {
                loose = true; body.push(''); index = lookahead; continue;
              }
              break;
            }
            if (nextMarker && nextMarker.indent <= first.indent) break;
            if (indentation(next) > first.indent) { body.push(stripIndent(next, current.contentIndent)); index++; continue; }
            // Wrapped paragraphs may continue without indentation. Blank lines,
            // headings, fences and sibling markers end that continuation.
            if (heading(next) || fence(next)) break;
            body.push(next); index++;
          }
          items.push(body);
        }
        const content = items.map(body => {
          let rendered = renderLines(body, depth + 1);
          if (!loose) rendered = rendered.replace(/^<p>([\s\S]*?)<\/p>/, '$1');
          return '<li>' + rendered + '</li>';
        }).join('');
        result.push('<' + first.type + (first.type === 'ol' && first.start !== 1 ? ' start="' + first.start + '"' : '') + '>' + content + '</' + first.type + '>');
      } else { paragraph.push(line); index++; }
    }
    flush(); return result.join('');
  }
  return renderLines(String(value ?? '').replace(/\r\n?/g, '\n').split('\n'));
}
