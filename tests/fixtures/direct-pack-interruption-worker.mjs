import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DirectExecutionJobs } from '../../lib/direct-execution-jobs.mjs';
import { loadPinnedLegacyReader } from './pinned-legacy-reader.mjs';

const [mode, dataDir, destination] = process.argv.slice(2);
if (!['stage-link','retire-unlink','export-link','restore-link','old-refusal'].includes(mode) ||
    !path.isAbsolute(dataDir))
  throw new Error('A disposable, explicit local fixture is required.');
const marker = 'direct_' + '0'.repeat(64) + '.json';
const jobsDir = path.join(dataDir, 'direct-execution-jobs');
const signalAndHold = async () => {
  process.stdout.write('KILL_POINT ' + mode + '\n');
  setInterval(() => {}, 1000); // Keep this disposable child alive until parent kills it.
  await new Promise(() => {});
};
async function run() {
  if (mode === 'old-refusal') {
    const source = await loadPinnedLegacyReader();
    const previous = new source.DirectExecutionJobs({ dataDir });
    try {
      await previous.init();
      await previous.close();
      process.stdout.write('OLD_ACCEPTED\n');
    } catch (error) {
      process.stdout.write('OLD_REFUSED ' + error.code + '\n');
      await previous.close().catch(() => {});
    }
    return;
  }
  const store = new DirectExecutionJobs({ dataDir });
  await store.init();
  const io = store.io;
  store.io = { ...io,
    link: async (from, to) => {
      await io.link(from, to);
      if (mode === 'stage-link' && to.endsWith('.bin') ||
          mode === 'export-link' && typeof destination === 'string' &&
            to.startsWith(path.join(destination, 'direct-execution-jobs') + path.sep) &&
            /^direct_[a-f0-9]{64}\.json$/.test(path.basename(to)) ||
          mode === 'restore-link' && to.startsWith(jobsDir + path.sep) &&
            /^direct_[a-f0-9]{64}\.json$/.test(path.basename(to)) && path.basename(to) !== marker)
        await signalAndHold();
    },
    unlink: async file => {
      await io.unlink(file);
      if (mode === 'retire-unlink' && file.startsWith(jobsDir + path.sep) &&
          /^direct_[a-f0-9]{64}\.json$/.test(path.basename(file)) &&
          path.basename(file) !== marker) await signalAndHold();
    },
  };
  if (mode === 'stage-link') await store.packTerminalReceipts({ maxRecords: 2 });
  if (mode === 'retire-unlink') await store.retirePackedDuplicates({ maxRecords: 2, destination });
  if (mode === 'export-link') await store.exportLegacyReceipts({ destination, maxRecords: 2 });
  if (mode === 'restore-link') await store.restoreLegacyReceipts({ destination, maxRecords: 2 });
  await store.close();
  process.stdout.write('UNEXPECTED_COMPLETION ' + mode + '\n');
}
run().catch(error => {
  process.stderr.write('FIXTURE_ERROR ' + error.code + ' ' + error.message + '\n');
  process.exitCode = 2;
});
