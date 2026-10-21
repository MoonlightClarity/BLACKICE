// Synthetic history only; never opens or changes the installed user profile.
// Run each mode in a fresh process for comparable retained-heap measurements:
// node --expose-gc scripts/benchmark-persistence.mjs before 26397007 8
// node --expose-gc scripts/benchmark-persistence.mjs after 26397007 8
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { AtomicJsonSnapshots, CoalescingWriter } from '../lib/coalescing-persistence.mjs';

const mode = process.argv[2], targetBytes = Number(process.argv[3] || 26397007), burst = Number(process.argv[4] || 8);
if (!['before', 'after'].includes(mode) || !Number.isSafeInteger(targetBytes) || targetBytes < 10000 || !Number.isSafeInteger(burst) || burst < 1 || burst > 100) throw new Error('Use before|after, target archive bytes, and 1..100 requests.');
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'blackice-persistence-benchmark-'));
const payload = 'x'.repeat(Math.max(1, Math.floor(targetBytes / 100) - 160));
const state = Array.from({ length: 100 }, (_, id) => ({ id: `run-${id}`, nodes: {}, events: [{ type: 'message', text: payload }], status: 'completed', revision: 0 }));
const counters = { snapshots: 0, serializedBytes: 0, fileWrites: 0, backupCopies: 0, historyReads: 0 };
let heapPeak = process.memoryUsage().heapUsed, rssPeak = process.memoryUsage().rss;
const sample = () => { const memory = process.memoryUsage(); heapPeak = Math.max(heapPeak, memory.heapUsed); rssPeak = Math.max(rssPeak, memory.rss); };
const snapshot = () => {
  const value = JSON.stringify(state, null, 2);
  counters.snapshots++; counters.serializedBytes += Buffer.byteLength(value); sample();
  return value;
};
let chain = Promise.resolve();
const legacy = () => {
  const text = snapshot();
  const write = async () => {
    const destination = path.join(directory, 'runs.json'), temporary = `${destination}.tmp`;
    try {
      const previous = await fs.readFile(destination, 'utf8'); counters.historyReads++;
      if (Array.isArray(JSON.parse(previous))) {
        await fs.writeFile(`${destination}.bak.tmp`, previous, { mode: 0o600 }); counters.fileWrites++;
        await fs.rename(`${destination}.bak.tmp`, `${destination}.bak`);
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const handle = await fs.open(temporary, 'w', 0o600);
    try { await handle.writeFile(text); counters.fileWrites++; await handle.sync(); } finally { await handle.close(); }
    await fs.rename(temporary, destination); sample();
  };
  return chain = chain.catch(() => {}).then(write);
};
const io = { ...fs,
  readFile: async (...args) => { counters.historyReads++; return fs.readFile(...args); },
  copyFile: async (...args) => { counters.backupCopies++; return fs.copyFile(...args); },
  open: async (...args) => { if (args[1] === 'wx') counters.fileWrites++; return fs.open(...args); },
};
const snapshots = new AtomicJsonSnapshots(directory, { io });
const coalesced = new CoalescingWriter(async () => { await snapshots.write('runs.json', snapshot()); sample(); });
const request = mode === 'before' ? legacy : () => coalesced.request();
try {
  const initial = JSON.stringify(state, null, 2);
  const snapshotBytes = Buffer.byteLength(initial);
  await fs.writeFile(path.join(directory, 'runs.json'), initial);
  global.gc?.();
  const initialHeap = process.memoryUsage().heapUsed;
  heapPeak = initialHeap; rssPeak = process.memoryUsage().rss;
  const cpuStart = process.cpuUsage(), start = performance.now();
  let responsivenessMs = null;
  const responsive = new Promise(resolve => setImmediate(() => { responsivenessMs = performance.now() - start; resolve(); }));
  const requests = [];
  for (let index = 0; index < burst; index++) { state.at(-1).revision = index + 1; requests.push(request()); }
  const enqueueMs = performance.now() - start;
  sample();
  await Promise.all(requests); await responsive;
  const wallMs = performance.now() - start, cpu = process.cpuUsage(cpuStart);
  const saved = JSON.parse(await fs.readFile(path.join(directory, 'runs.json'), 'utf8'));
  if (saved.at(-1).revision !== burst) throw new Error('Benchmark failed to retain the latest requested revision.');
  process.stdout.write(JSON.stringify({ mode, snapshotBytes, burst, ...counters, enqueueMs, responsivenessMs, wallMs, cpuMs: (cpu.user + cpu.system) / 1000, initialHeapBytes: initialHeap, peakHeapBytes: heapPeak, peakRssBytes: rssPeak, finalRevision: saved.at(-1).revision }) + '\n');
} finally { await fs.rm(directory, { recursive: true, force: true }); }
