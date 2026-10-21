import test from 'node:test';
import { createRegisteredArtifactResolver } from '../public/conversation-model.mjs';
import assert from 'node:assert/strict';
import { WorkflowHistory, diagnoseWorkflow, fitWorkflow, runMetrics, renderMarkdown } from '../public/editor-model.mjs';

const workflow = () => ({ id: 'w', nodes: [{ id: 'i', type: 'input', name: 'Task', x: 40, y: 75 }, { id: 'a', type: 'agent', name: 'Builder', prompt: 'Do it', x: 340, y: 75 }, { id: 'o', type: 'output', name: 'Result', x: 640, y: 75 }], edges: [{ source: 'i', target: 'a' }, { source: 'a', target: 'o' }] });

test('undo restores the complete graph including removed connections and redo branches correctly', () => {
  const history = new WorkflowHistory(), w = workflow(); history.reset(w);
  w.nodes = w.nodes.filter(node => node.id !== 'a'); w.edges = []; history.record(w);
  assert.deepEqual(history.undo(), workflow()); assert.equal(history.canRedo, true);
  assert.deepEqual(history.redo(), w); history.undo();
  const other = workflow(); other.nodes[1].x = 500; history.record(other);
  assert.equal(history.canRedo, false); assert.deepEqual(history.undo(), workflow());
});

test('typing coalesces into a single edit without merging later structural changes', () => {
  const history = new WorkflowHistory(), w = workflow(); history.reset(w);
  w.nodes[1].name = 'B'; history.record(w, 'a:name', 1000); w.nodes[1].name = 'Build'; history.record(w, 'a:name', 1200);
  w.nodes[1].x = 800; history.record(w, null, 1250);
  assert.equal(history.undo().nodes[1].x, 340); assert.equal(history.undo().nodes[1].name, 'Builder');
});

test('diagnostics identify the exact agent missing instructions and both disconnected paths', () => {
  const w = workflow(); assert.deepEqual(diagnoseWorkflow(w), []);
  w.nodes[1].prompt = ' '; w.edges = [];
  const issues = diagnoseWorkflow(w);
  assert.ok(issues.some(issue => issue.code === 'missing-prompt' && issue.nodeId === 'a'));
  assert.ok(issues.some(issue => issue.code === 'unreachable-input' && issue.nodeId === 'a'));
  assert.ok(issues.some(issue => issue.code === 'unreachable-output' && issue.nodeId === 'i'));
});

test('diagnostics detect cycles and tolerate broken edges in imported drafts', () => {
  const w = workflow(); w.edges.push({ source: 'o', target: 'a' }, { source: 'gone', target: 'o' });
  const issues = diagnoseWorkflow(w);
  assert.ok(issues.some(issue => issue.code === 'cycle')); assert.ok(issues.some(issue => issue.code === 'missing-node'));
  assert.ok(issues.some(issue => issue.code === 'output-outgoing' && issue.nodeId === 'o'));
});

test('fit keeps node labels and ports inside usable canvas after narrow resize', () => {
  for (const viewport of [{ width: 906, height: 694 }, { width: 480, height: 250 }, { width: 260, height: 180 }]) {
    const w = workflow(); w.nodes[2].y = 330;
    const view = fitWorkflow(w.nodes, viewport);
    for (const node of w.nodes) {
      assert.ok(view.x + (node.x - 8) * view.scale >= 0);
      assert.ok(view.x + (node.x + 232) * view.scale <= viewport.width);
      assert.ok(view.y + (node.y - 27) * view.scale >= 0);
      assert.ok(view.y + (node.y + 153) * view.scale <= viewport.height);
    }
  }
});

test('metrics exclude reused usage and never invent token usage or elapsed time', () => {
  const run = { createdAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T00:00:03Z', nodes: { a: { status: 'completed', reused: true, usage: { totalTokens: 900 } }, b: { status: 'failed', usage: { totalTokens: 40 } } } };
  assert.deepEqual(runMetrics(run), { completed: 1, total: 2, failed: 1, reused: 1, durationMs: 3000, totalTokens: 40, hasUsage: true });
  assert.equal(runMetrics({ nodes: {} }).hasUsage, false); assert.equal(runMetrics({ nodes: {} }).durationMs, null);
});

test('output formatting keeps agent HTML and executable links inert while preserving useful structure', () => {
  const output = renderMarkdown('# Result\n\n<script>alert(1)</script>\n\n- **Verified**\n- `npm test`\n\n[bad](javascript:alert%281%29) [good](https://example.com/a?q=1&b=2)\n\n```html\n<img src=x onerror=alert(1)>\n```');
  assert.ok(output.includes('<h2>Result</h2>')); assert.ok(output.includes('<ul><li><strong>Verified</strong>'));
  assert.ok(output.includes('&lt;script&gt;')); assert.ok(!output.includes('<script>'));
  assert.ok(!output.includes('href="javascript:')); assert.ok(output.includes('href="https://example.com/a?q=1&amp;b=2"'));
  assert.ok(!output.includes('<img')); assert.ok(output.includes('<code data-language="html">'));
});

test('conversation handoff links remain clickable inside bold text and support bold or code link labels', () => {
  const output = renderMarkdown('Nightboard is ready: **[http://127.0.0.1:4321/](http://127.0.0.1:4321/)**\n[**Play Nightboard**](http://127.0.0.1:4321/)\n[Open `Nightboard`](https://example.com/game?q=1&mode=local)');
  assert.match(output, /<strong><a href="http:\/\/127\.0\.0\.1:4321\/" target="_blank" rel="noopener noreferrer">http:\/\/127\.0\.0\.1:4321\/<\/a><\/strong>/);
  assert.match(output, /<a href="http:\/\/127\.0\.0\.1:4321\/"[^>]*><strong>Play Nightboard<\/strong><\/a>/);
  assert.match(output, /href="https:\/\/example\.com\/game\?q=1&amp;mode=local"[^>]*>Open <code>Nightboard<\/code><\/a>/);
  assert.ok(!output.includes('[http://127.0.0.1:4321/]'));
});

test('nested inline formatting preserves literal code, escaping and executable URL protections', () => {
  const output = renderMarkdown('`**[literal](https://example.com/)**`\n**`[also literal](https://example.com/)`**\n**[<img onerror=bad>](https://example.com/?a="bad")**\n[**<script>bad</script>**](https://example.com/)\n**[bad](javascript:alert%281%29)**\n[**bad**](data:text/html,hello)\n[**Local file**](C:/fixture/game/index.html)\n**&lt;img onerror=bad&gt;**');
  assert.match(output, /<code>\*\*\[literal\]\(https:\/\/example\.com\/\)\*\*<\/code>/);
  assert.match(output, /<strong><code>\[also literal\]\(https:\/\/example\.com\/\)<\/code><\/strong>/);
  assert.match(output, /href="https:\/\/example\.com\/\?a=&quot;bad&quot;"/); assert.ok(!output.includes('<img')); assert.ok(!output.includes('<script>'));
  assert.match(output, /<strong>&lt;script&gt;bad&lt;\/script&gt;<\/strong>/); assert.ok(!output.includes('href="javascript:')); assert.ok(!output.includes('href="data:'));
  assert.match(output, /class="local-file-label" title="C:\/fixture\/game\/index.html"><strong>Local file<\/strong><\/span>/); assert.ok(!output.includes('href="C:'));
  assert.match(output, /&amp;lt;img onerror=bad&amp;gt;/);
});

test('registered deliverables in agent replies open the existing artifact preview route', () => {
  const resolveArtifact = createRegisteredArtifactResolver({ cwd: 'C:\\Relay Work\\project', taskState: { taskId: 'real-task', artifacts: [{ id: 'artifact_svg', path: 'C:\\Relay Work\\project\\status.svg' }, { id: 'artifact_spaced', path: 'C:\\Relay Work\\project\\assets\\status (final).svg' }] } });
  const output = renderMarkdown('[status.svg](/C:/Relay%20Work/project/status.svg)\n[**Open SVG**](status.svg)\n[Open `saved [SVG]`](<C:\\Relay Work\\project\\assets\\status (final).svg>)\n[preview [SVG]](./status.svg)', { resolveArtifact });
  assert.equal((output.match(/data-task-artifact="artifact_svg"/g) || []).length, 3);
  assert.match(output, /href="\/api\/tasks\/real-task\/artifacts\/artifact_svg\/preview" data-task-artifact="artifact_svg" data-task-id="real-task">status\.svg<\/a>/);
  assert.match(output, /data-task-artifact="artifact_spaced"[^>]*>Open <code>saved \[SVG\]<\/code><\/a>/);
  assert.match(output, />preview \[SVG\]<\/a>/);
  assert.ok(!output.includes('href="C:')); assert.ok(!output.includes('local-file-label'));
});

test('large malformed link destinations remain literal while valid later links still render', () => {
  const malformed='[file](<'+ 'x'.repeat(9000) + '>)';
  const source=Array(16).fill(malformed).join(' ')+' [real](https://example.com/check)';
  const output=renderMarkdown(source);
  assert.equal((output.match(/<a /g)||[]).length,1);
  assert.ok(output.includes('[file](&lt;'));
  assert.match(output, /href="https:\/\/example.com\/check"/);
});

test('artifact resolution preserves escaping, literal code, HTTP links and inert unregistered local files', () => {
  const resolveArtifact = createRegisteredArtifactResolver({ id: 'task', cwd: '/workspace', taskState: { artifacts: [{ id: 'registered', path: '/workspace/status.svg' }] } });
  const output = renderMarkdown('[**<img onerror=bad>**](status.svg)\n`[literal](status.svg)`\n**[nested <script>](./status.svg)**\n[unknown](/workspace/unregistered.svg)\n[web](https://example.com/status.svg?q=1&b=2)\n[bad](javascript:alert(1))', { resolveArtifact });
  assert.equal((output.match(/data-task-artifact="registered"/g) || []).length, 2);
  assert.match(output, /<strong>&lt;img onerror=bad&gt;<\/strong><\/a>/); assert.match(output, /<code>\[literal\]\(status.svg\)<\/code>/);
  assert.match(output, /<strong><a [^>]*>nested &lt;script&gt;<\/a><\/strong>/);
  assert.match(output, /class="local-file-label" title="\/workspace\/unregistered.svg">unknown<\/span>/);
  assert.match(output, /href="https:\/\/example.com\/status.svg\?q=1&amp;b=2" target="_blank" rel="noopener noreferrer"/);
  assert.ok(!output.includes('<img')); assert.ok(!output.includes('<script>')); assert.ok(!output.includes('href="javascript:'));
  assert.equal(renderMarkdown('[file](./status.svg)', { resolveArtifact: () => ({ taskId: 'bad" onclick="x', artifactId: 'registered' }) }).includes('data-task-artifact'), false);
  assert.equal(renderMarkdown('[file](./status.svg)', { resolveArtifact: () => { throw new Error('missing'); } }).includes('data-task-artifact'), false);
});
