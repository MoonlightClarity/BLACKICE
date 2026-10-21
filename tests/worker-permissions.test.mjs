import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, writeFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HarnessEngine } from '../lib/engine.mjs';
import { createMissionWorkflow } from '../public/mission-model.mjs';
import { readOnlyToolDenial } from '../lib/worker-permissions.mjs';
import { connectorBrowserOwner } from '../lib/connector-browser-owner.mjs';

const data = result => JSON.parse(result.contentItems.find(item => item.type === 'inputText').text);
const call = (options, name, args) => options.onToolCall({ name, arguments: args });

async function harness(t, execute) {
  const root = await mkdtemp(path.join(tmpdir(), 'blackice-worker-scope-'));
  const cwd = path.join(root, 'work'); await mkdir(cwd); await writeFile(path.join(cwd, 'evidence.txt'), 'verified evidence');
  const effects = { emailDrafts: 0, connections: 0, browserInputs: 0 }, tabs = [], owners = [], releases = [];
  const browser = {
    status: () => ({ available: true, contained: true, tabs, folders: [] }),
    async perform(args, { owner }) {
      if (args.action === 'tabs') return { tabs };
      if (args.action === 'open') {
        assert.ok(owner?.taskId && owner?.runId && owner?.nodeId);
        const tab = { tabId: 'owned-' + tabs.length, browser: 'relay', owner: { ...owner }, url: args.url, title: 'Fixture source' };
        tabs.push(tab); owners.push(owner); return { ...tab, text: 'Observed source evidence' };
      }
      if (args.action === 'read') return { ...tabs.find(tab => tab.tabId === args.tabId), text: 'Observed source evidence' };
      effects.browserInputs++; throw Error('A read-only worker dispatched browser input.');
    },
    async releaseOwner(owner) { releases.push(owner); return { suspended: tabs.filter(tab => tab.owner.taskId === owner.taskId && tab.owner.nodeId === owner.nodeId).map(tab => tab.tabId), retained: [] }; },
  };
  const connections = { list: () => [], tools: async () => [], call: async () => { effects.connections++; throw Error('External tool should not run.'); }, redact: String };
  const email = { status: () => ({ available: true }), draft: async () => { effects.emailDrafts++; throw Error('Draft should not be written.'); } };
  class Runtime extends EventEmitter {
    status() { return { connected: true, authenticated: true, defaultModel: 'fixture', models: [{ id: 'fixture', supportsTools: true }] }; }
    async runAgent(options) { return execute(options, context); }
    async close() {}
  }
  const engine = new HarnessEngine({ runtime: new Runtime(), browser, email, connections, dataDir: root, defaultCwd: cwd });
  engine.runtimeSettings = { get: () => ({ subagentsEnabled: true, maxSubagents: 3 }) };
  await engine.init();
  const workflow = createMissionWorkflow({ id: 'worker-scope-fixture', task: 'Inspect research evidence', model: 'fixture', cwd, planningMode: 'off' });
  const context = { engine, workflow, cwd, effects, tabs, owners, releases };
  t.after(async () => { await engine.close(); assert.match(path.basename(root), /^blackice-worker-scope-/); await rm(root, { recursive: true, force: true }); });
  context.run = async input => { const run = engine.startRun({ workflow, input }); await engine.executions.get(run.id); const saved = engine.getRun(run.id); assert.equal(saved.status, 'completed', saved.error); return saved; };
  return context;
}

test('an unlinked read-only delegate can inspect evidence but no mutation reaches its gateway', async t => {
  const f = await harness(t, async (options, context) => {
    if (options.prompt.startsWith('You are a short-lived')) {
      assert.equal(options.sandbox, 'read-only');
      const read = await call(options, 'relay_workspace', { action: 'read', path: 'evidence.txt' });
      assert.equal(read.success, true); assert.match(read.contentItems[0].text, /verified evidence/);
      const requests = [
        ['relay_workspace', { action: 'write', path: 'forbidden.txt', text: 'forbidden' }],
        ['relay_workspace', { action: 'run', command: 'echo forbidden' }],
        ['relay_email', { action: 'draft', requestId: 'forbidden', to: ['nobody@example.test'], subject: 'No', body: 'No' }],
        ['relay_connections', { action: 'call', connectionId: 'fixture', name: 'write', arguments: {} }],
        ['relay_browser', { action: 'fill', tabId: 'unowned', ref: 'field', text: 'forbidden' }],
        ['relay_credentials', { action: 'generate', origin: 'https://example.test', requestId: 'forbidden' }],
      ];
      for (const [name, args] of requests) {
        const result = await call(options, name, args); assert.equal(result.success, false); assert.equal(result.code, 'TASK_PLAN_READ_ONLY'); assert.equal(data(result).actionDispatched, false);
      }
      const opened = await call(options, 'relay_browser', { action: 'open', url: 'https://example.test/research' });
      assert.equal(opened.success, true, opened.contentItems[0].text);
      const observed = await call(options, 'relay_browser', { action: 'read', tabId: data(opened).tabId });
      assert.equal(observed.success, true);
      return { output: 'Evidence inspected; all write attempts refused.' };
    }
    const definition = options.dynamicTools.find(tool => tool.name === 'relay_delegate');
    assert.equal(definition.inputSchema.properties.tasks.items.properties.canWrite.type, 'boolean');
    const delegated = await call(options, 'relay_delegate', { tasks: [{ id: 'review', prompt: 'Inspect evidence only', canWrite: false }] });
    assert.equal(delegated.success, true, delegated.contentItems[0].text); assert.equal(data(delegated).allCompleted, true);
    return { output: 'Review completed.' };
  });
  const saved = await f.run('Review research without changing files.');
  assert.equal(saved.nodes.agent.subagentSchemaVersion, 3);
  assert.deepEqual(f.effects, { emailDrafts: 0, connections: 0, browserInputs: 0 });
  await assert.rejects(access(path.join(f.cwd, 'forbidden.txt')), { code: 'ENOENT' });
  assert.equal(f.owners.length, 1);
  assert.notEqual(f.owners[0].nodeId, 'agent');
  assert.equal(f.owners[0].taskId, saved.id);
  assert.ok(f.releases.some(owner => owner.nodeId === f.owners[0].nodeId && owner.runId === saved.id));
});

test('simultaneous root runs get distinct trusted browser owners and cleanup receipts', async t => {
  let arrived = 0, release; const ready = new Promise(resolve => { release = resolve; });
  const f = await harness(t, async (options, context) => {
    const opened = await call(options, 'relay_browser', { action: 'open', url: 'https://example.test/source' });
    assert.equal(opened.success, true, opened.contentItems[0].text);
    if (++arrived === 2) release(); await ready;
    const mine = data(opened).tabId, other = context.tabs.find(tab => tab.tabId !== mine);
    const denied = await call(options, 'relay_browser', { action: 'read', tabId: other.tabId });
    assert.equal(denied.success, false); assert.equal(data(denied).code, 'BROWSER_TAB_OWNERSHIP');
    const read = await call(options, 'relay_browser', { action: 'read', tabId: mine }); assert.equal(read.success, true);
    return { output: 'Only the assigned source was read.' };
  });
  const runs = await Promise.all([f.run('Research source A'), f.run('Research source B')]);
  assert.equal(new Set(f.owners.map(owner => owner.taskId)).size, 2);
  assert.deepEqual(new Set(f.releases.map(owner => owner.runId)), new Set(runs.map(run => run.id)));
  assert.ok(f.releases.every(owner => owner.nodeId === 'agent'));
});

test('connector ownership is stable within a grant and isolated between grants', () => {
  assert.deepEqual(connectorBrowserOwner('grant-a'), connectorBrowserOwner('grant-a'));
  assert.notEqual(connectorBrowserOwner('grant-a').taskId, connectorBrowserOwner('grant-b').taskId);
  assert.equal(connectorBrowserOwner('grant-a').allowUserTabs, true);
  assert.throws(() => connectorBrowserOwner(''));
});

test('a read-only policy rejects unrecognized tools and malformed arguments without changing writable behavior', () => {
  assert.equal(readOnlyToolDenial({ name: 'relay_workspace', arguments: '{bad' }, false).code, 'TASK_PLAN_READ_ONLY');
  assert.equal(readOnlyToolDenial({ name: 'unregistered_writer', arguments: {} }, false).code, 'TASK_PLAN_READ_ONLY');
  assert.equal(readOnlyToolDenial({ name: 'relay_workspace', arguments: { action: 'write' } }, true), null);
  assert.equal(readOnlyToolDenial({ name: 'relay_email', arguments: { action: 'read' } }, false), null);
  assert.equal(readOnlyToolDenial({ name: 'relay_connections', arguments: { action: 'call', readOnlyHint: true } }, false).code, 'TASK_PLAN_READ_ONLY');
});
