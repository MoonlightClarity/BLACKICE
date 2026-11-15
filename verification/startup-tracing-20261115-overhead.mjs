// Offline, synthetic-only comparison of .98 validated direct-ledger initialization
// with startup trace disabled/enabled. Never reads or writes the installed profile.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DirectExecutionJobs, directRequestDigest } from '../lib/direct-execution-jobs.mjs';
import { StartupCriticalTrace } from '../lib/startup-critical-trace.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const median = list => { const a = [...list].sort((x, y) => x - y), m = a.length >>> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
const round = value => Math.round(value * 1000) / 1000;
const root = await fs.mkdtemp(path.join(tmpdir(), 'blackice-trace-overhead-offline-'));
const directory = path.join(root, 'direct-execution-jobs');
const ownerId = 'synthetic-grant', tool = 'blackice_workspace_read';
const client = { id: ownerId, kind: 'chatgpt', label: 'synthetic', scopes: ['read', 'files:read'] };
let problem = null;
try {
  const first = new DirectExecutionJobs({ dataDir: root });
  const job = (await first.admit({ ownerId, requestId: 'seed', tool,
    arguments: { action: 'read', path: 'fixture' }, client,
    requiredScopes: ['files:read'], mutating: false })).job;
  await first.update(job.id, () => ({ status: 'succeeded', result: { success: true },
    finishedAt: new Date().toISOString() }));
  const template = JSON.parse(await fs.readFile(first.file(job.id), 'utf8'));
  await first.close();

  const expected = new Map([[job.id, sha(await fs.readFile(path.join(directory, job.id + '.json')))]]);
  const sizes = [...Array.from({ length: 260 }, () => 16 * 1024),
    ...Array.from({ length: 24 }, () => 384 * 1024)];
  for (let i = 0; i < sizes.length; i++) {
    const requestId = 'synthetic-' + i, id = 'direct_' + sha(ownerId + '\0' + requestId);
    const args = { action: 'read', path: 'synthetic/' + i }, requestDigest = directRequestDigest({ tool, arguments: args });
    const text = 'Café ▣ 日本語 ◌ '.repeat(Math.ceil(sizes[i] / 22));
    const record = { ...template, id, requestId, arguments: args, requestDigest,
      storedRequestDigest: requestDigest,
      result: { success: true, contentItems: [{ type: 'inputText', text }] } };
    const bytes = Buffer.from(JSON.stringify(record));
    await fs.writeFile(path.join(directory, id + '.json'), bytes);
    expected.set(id, sha(bytes));
  }
  const state = sha([...expected].sort(([a], [b]) => a.localeCompare(b)).map(([id, v]) => id + ':' + v).join('\n'));
  const order = ['baseline', 'traced', 'traced', 'baseline', 'baseline', 'traced'], attempts = [];
  for (const [index, mode] of order.entries()) {
    const trace = mode === 'traced' ? new StartupCriticalTrace({ dataDir: root, version: '2.39.98', startTimer: false }) : null;
    if (trace) await trace.start({ buildFiles: { directjobs: fileURLToPath(new URL('../lib/direct-execution-jobs.mjs', import.meta.url)) } });
    const store = new DirectExecutionJobs({ dataDir: root, startupTrace: trace, onStartupDiagnostics: () => {} });
    let telemetry;
    store.onStartupDiagnostics = value => { telemetry = value; };
    const cpu = process.cpuUsage(), start = performance.now();
    try {
      await store.init();
      const wallMs = performance.now() - start, cpuUsed = process.cpuUsage(cpu);
      const loadedState = sha([...store.records].sort(([a], [b]) => a.localeCompare(b)).map(([id, v]) => id + ':' + v.receiptHash).join('\n'));
      if (loadedState !== state || store.records.size !== expected.size || store.unfinished !== 0)
        throw Error('Exact loaded state differs from synthetic authoritative receipts');
      attempts.push({ attempt: index + 1, mode, wallMs: round(wallMs),
        processCpuMs: round((cpuUsed.user + cpuUsed.system) / 1000),
        receipts: store.records.size, bytes: telemetry?.bytes, stateHash: loadedState,
        stages: trace ? trace.snapshot().spans.filter(v => v.name.startsWith('ledger-')) : null,
        operations: trace ? Object.fromEntries(['stat','open','read','parse','validate','hash','index','close'].map(key =>
          [key, { started: trace.opMetrics[key].started, maxMs: trace.opMetrics[key].maxMs }])) : null });
    } finally {
      await store.close();
      if (trace) await trace.finish('ready');
    }
  }
  process.stdout.write(JSON.stringify({
    kind: 'blackice-23998-synthetic-trace-overhead', at: new Date().toISOString(),
    source: '0101d3f88cc7f3f139394a1c943b899511668a90',
    profile: 'newly-created-temporary-synthetic-only', version: '2.39.98',
    node: process.version, platform: process.platform, order, receipts: expected.size,
    expectedStateHash: state, attempts,
    medians: Object.fromEntries(['baseline','traced'].map(mode => [mode, {
      wallMs: round(median(attempts.filter(a => a.mode === mode).map(a => a.wallMs))),
      processCpuMs: round(median(attempts.filter(a => a.mode === mode).map(a => a.processCpuMs))),
    }])),
    limits: 'This is a synthetic 285-receipt full-validate ledger component, not a 66,848-receipt restored profile, desktop launch, physical disk diagnosis or whole-startup proof. Cold cache not established, OS/AV load uncontrolled, process CPU includes unrelated work.',
  }, null, 2) + '\n');
} catch (error) {
  problem = error; process.stderr.write(String(error?.stack || error) + '\n');
} finally {
  try { await fs.rm(root, { recursive: true, force: true }); }
  catch (error) { problem ||= error; process.stderr.write('Synthetic fixture cleanup failed: ' + error.message + '\n'); }
}
if (problem) process.exitCode = 1;
