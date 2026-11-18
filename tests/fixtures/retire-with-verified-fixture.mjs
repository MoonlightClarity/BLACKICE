import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Test-only bridge for legacy behavioral regressions: real independent export
// is verified BEFORE every retirement. This function is never used by app code.
export async function retireWithFixtureBackup(store, options = {}) {
  const destination = await fs.mkdtemp(path.join(tmpdir(), 'blackice-retire-verified-fixture-'));
  try {
    let complete = false;
    for (let iteration = 0; iteration < 64; iteration++) {
      const result = await store.exportReceiptBackup({ destination, maxRecords: 256 });
      if (result.phase === 'complete') { complete = true; break; }
    }
    if (!complete) throw Error('Bounded fixture export did not fully verify.');
    return await store.retirePackedDuplicates({ ...options, destination });
  } finally {
    await fs.rm(destination, { recursive: true, force: true });
  }
}
