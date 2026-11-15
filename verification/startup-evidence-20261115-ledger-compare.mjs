// Isolated *real ledger initialization* comparison, not a desktop launch.
// Input 1: absolute path to a clean, exact-main baseline direct-execution-jobs.mjs.
// Only a newly created temp profile is written; live BLACKICE is untouched.
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { DirectExecutionJobs as Candidate, directRequestDigest } from '../lib/direct-execution-jobs.mjs';

const baselineFile = process.argv[2] && path.resolve(process.argv[2]);
if (!baselineFile || !baselineFile.endsWith(path.join('lib', 'direct-execution-jobs.mjs')))
  throw Error('Supply the exact, clean baseline lib/direct-execution-jobs.mjs path');
const { DirectExecutionJobs: Baseline } = await import(pathToFileURL(baselineFile).href);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const clock = () => performance.now();
const round = n => Math.round(n * 1000) / 1000;
const median = array => {
  const values = [...array].sort((a, b) => a - b), mid = values.length >>> 1;
  return values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
};
const dataDir = await fs.mkdtemp(path.join(tmpdir(), 'blackice-ledger-startup-compare-'));
const ledgerDir = path.join(dataDir, 'direct-execution-jobs');
const ownerId = 'synthetic-grant', tool = 'blackice_workspace_read';
let failure;
try {
  // Authoritatively generate one version-1 receipt through the real save path,
  // then vary only its validated identity and synthetic completed result bytes.
  const original = new Candidate({ dataDir });
  await original.init();
  const { job } = await original.admit({
    ownerId, requestId: 'seed', tool,
    arguments: { action: 'read', path: 'seed' },
    client: { id: ownerId, label: 'synthetic-only', kind: 'chatgpt', scopes: ['read','files:read'] },
    requiredScopes: ['files:read'], mutating: false,
  });
  await original.update(job.id, () => ({
    status: 'succeeded', result: { success: true }, finishedAt: new Date().toISOString(),
  }));
  const template = JSON.parse(await fs.readFile(original.file(job.id), 'utf8'));
  await original.close();
  const expected = new Map();
  const seedBytes = await fs.readFile(path.join(ledgerDir, job.id + '.json'));
  expected.set(job.id, sha(seedBytes));
  const sizes = [
    ...Array.from({ length: 256 }, () => 16 * 1024),
    ...Array.from({ length: 24 }, () => 512 * 1024),
  ];
  for (let i = 0; i < sizes.length; i++) {
    const requestId = 'synthetic-' + i, id = 'direct_' + sha(ownerId + '\0' + requestId);
    const args = { action: 'read', path: 'résumé-' + i + '.txt' };
    const requestDigest = directRequestDigest({ tool, arguments: args });
    const body = 'Café 日本語 π 🌱 '.repeat(Math.ceil(sizes[i] / 21));
    const record = { ...template, id, requestId,
      arguments: args, requestDigest, storedRequestDigest: requestDigest,
      result: { success: true, contentItems: [{ type: 'inputText', text: body }] },
    };
    const bytes = Buffer.from(JSON.stringify(record), 'utf8');
    await fs.writeFile(path.join(ledgerDir, id + '.json'), bytes);
    expected.set(id, sha(bytes));
  }
  const expectedState = sha([...expected].sort(([a], [b]) => a.localeCompare(b))
    .map(([id, digest]) => id + ':' + digest).join('\n'));
  const sequence = ['baseline', 'candidate', 'candidate', 'baseline', 'baseline', 'candidate'];
  const trials = [];
  for (const [index, mode] of sequence.entries()) {
    let telemetry;
    const store = new (mode === 'baseline' ? Baseline : Candidate)({
      dataDir, onStartupDiagnostics: value => { telemetry = value; },
    });
    const processCpu = process.cpuUsage(), start = clock();
    let wallMs, cpuMs, indexed, unfinished, stateHash;
    try {
      await store.init();
      wallMs = round(clock() - start);
      const cpu = process.cpuUsage(processCpu);
      cpuMs = round((cpu.user + cpu.system) / 1000);
      indexed = store.records.size; unfinished = store.unfinished;
      stateHash = sha([...store.records].sort(([a], [b]) => a.localeCompare(b))
        .map(([id, record]) => id + ':' + record.receiptHash).join('\n'));
      if (indexed !== expected.size || unfinished !== 0 || stateHash !== expectedState ||
          telemetry?.outcome !== 'ready' || telemetry?.receipts !== expected.size ||
          store.startup.phase !== 'ready')
        throw Error('Initialization or exact source-data validation diverged');
    } finally { await store.close(); }
    trials.push({ index: index + 1, mode, wallMs, cpuMs, indexed, unfinished,
      stateHash, startupTelemetry: telemetry });
  }
  const medians = Object.fromEntries(['baseline','candidate'].map(mode => [mode, {
    wallMs: round(median(trials.filter(t => t.mode === mode).map(t => t.wallMs))),
    processCpuMs: round(median(trials.filter(t => t.mode === mode).map(t => t.cpuMs))),
    scanMs: round(median(trials.filter(t => t.mode === mode).map(t => t.startupTelemetry.scanMs))),
  }]));
  process.stdout.write(JSON.stringify({
    kind: 'synthetic-valid-direct-ledger-initialize', status: 'completed',
    at: new Date().toISOString(), baselineFile, baselineSha256: sha(await fs.readFile(baselineFile)),
    candidateSha256: sha(await fs.readFile(new URL('../lib/direct-execution-jobs.mjs', import.meta.url))),
    platform: process.platform, node: process.version, order: sequence,
    receipts: expected.size, expectedStateHash: expectedState, trials, medians,
    limits: 'Valid synthetic receipts only, not the real 64,351-receipt 1.25GB history. Real exclusive lease and full receipt validation/index/sort run, no incomplete recovery cases, no production admissions or installed app. Single process with changing OS cache and host load; independent review and whole startup required.',
  }, null, 2) + '\n');
} catch (error) {
  failure = error;
  process.stderr.write(String(error?.stack || error) + '\n');
} finally {
  // Remove only this invocation's synthetic temp profile; never touch user data.
  try { await fs.rm(dataDir, { recursive: true, force: true }); }
  catch (error) { failure ||= error; process.stderr.write('Temp fixture removal error: ' + error.message + '\n'); }
}
if (failure) process.exitCode = 1;
