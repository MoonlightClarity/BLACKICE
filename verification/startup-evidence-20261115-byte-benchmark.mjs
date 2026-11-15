// Bounded, synthetic component comparison only. This never starts BLACKICE or
// reads the installed profile; it cannot establish end-to-end startup speed.
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const median = samples => {
  const sorted = [...samples].sort((a, b) => a - b);
  return (sorted[(sorted.length - 1) >>> 1] + sorted[sorted.length >>> 1]) / 2;
};
const round = value => Math.round(value * 1000) / 1000;
const root = await fs.mkdtemp(path.join(tmpdir(), 'blackice-startup-byte-probe-'));
let failure;
try {
  // Representative small receipts plus a tail of retained large results.
  // This mix is synthetic, NOT a measured live size distribution.
  const spec = [...Array.from({ length: 256 }, () => 16 * 1024),
    ...Array.from({ length: 24 }, () => 512 * 1024)];
  const files = [];
  for (let i = 0; i < spec.length; i++) {
    const text = 'body: Café 🌐 한국어 — '.repeat(Math.ceil(spec[i] / 29));
    const bytes = Buffer.from(JSON.stringify({
      version: 1, id: i, requestId: 'synthetic-' + i,
      result: { success: true, contentItems: [{ type: 'inputText', text }] },
    }), 'utf8');
    const file = path.join(root, 'direct_' + i + '.json');
    await fs.writeFile(file, bytes);
    files.push({ file, index: i, sha256: digest(bytes), bytes: bytes.length });
  }
  const modes = ['legacy', 'buffer', 'buffer', 'legacy', 'legacy', 'buffer'];
  const measurements = [];
  for (const [attemptIndex, mode] of modes.entries()) {
    const start = performance.now(), cpu = process.cpuUsage();
    let cursor = 0, validated = 0, bytes = 0;
    const processFile = async () => {
      while (cursor < files.length) {
        const fixture = files[cursor++];
        const info = await fs.lstat(fixture.file);
        if (!info.isFile() || info.isSymbolicLink() || info.size > 8 * 1024 * 1024)
          throw new Error('Synthetic receipt failed file safety check');
        const raw = mode === 'legacy' ? await fs.readFile(fixture.file, 'utf8')
          : await fs.readFile(fixture.file);
        const len = mode === 'legacy' ? Buffer.byteLength(raw) : raw.byteLength;
        const document = JSON.parse(mode === 'legacy' ? raw : raw.toString('utf8'));
        const sha256 = digest(raw);
        if (len !== fixture.bytes || sha256 !== fixture.sha256 ||
            document.requestId !== 'synthetic-' + fixture.index)
          throw new Error('Old/new output differs from authoritative synthetic bytes');
        bytes += len; validated++;
      }
    };
    await Promise.all(Array.from({ length: 8 }, processFile));
    const cpuElapsed = process.cpuUsage(cpu);
    measurements.push({
      attemptIndex: attemptIndex + 1, mode, records: validated, bytes,
      wallMs: round(performance.now() - start),
      processCpuMs: round((cpuElapsed.user + cpuElapsed.system) / 1000),
    });
  }
  const totals = {
    records: files.length, bytes: files.reduce((sum, f) => sum + f.bytes, 0),
    aggregateSha256: digest(files.map(f => f.sha256).join('\n')),
  };
  const medians = Object.fromEntries(['legacy', 'buffer'].map(mode => [mode, {
    wallMs: round(median(measurements.filter(m => m.mode === mode).map(m => m.wallMs))),
    processCpuMs: round(median(measurements.filter(m => m.mode === mode).map(m => m.processCpuMs))),
  }]));
  process.stdout.write(JSON.stringify({
    kind: 'synthetic-receipt-byte-read-component', status: 'completed',
    createdAt: new Date().toISOString(), node: process.version, platform: process.platform,
    concurrency: 8, modes, totals, measurements, medians,
    interpretation: 'Per-receipt lstat, readFile, UTF-8 decode, JSON.parse and SHA-256 only. No receipt schema validation, index/sort, exclusive lease, recovery, provider, UI, tool route, app initialization, or live profile. Warm-cache/load uncontrolled; CPU is whole-process; wall samples from one host.',
  }, null, 2) + '\n');
} catch (error) {
  failure = error;
  process.stderr.write(String(error?.stack || error) + '\n');
} finally {
  // Only this invocation's newly created throwaway fixture directory.
  try { await fs.rm(root, { recursive: true, force: true }); }
  catch (error) { failure ||= error; process.stderr.write('Temporary fixture cleanup failed: ' + error.message + '\n'); }
}
if (failure) process.exitCode = 1;
