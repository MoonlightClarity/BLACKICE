import { promises as fs } from 'node:fs';
import path from 'node:path';
import { validateRetainedContractJournal, retainedContractEffectConflict } from './planning-contract-runtime.mjs';
import { hasUnresolvedLegacyDispatch } from './planning-sequence.mjs';

const caches = new WeakMap();
const unavailable = () => Object.assign(new Error('Retained operation history cannot be checked safely. No consequential action was dispatched; ordinary inspection remains available.'), {
  code: 'TASK_CONTRACT_JOURNAL_UNAVAILABLE', status: 409, actionDispatched: false
});
const signature = stat => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
const statFile = async file => {
  const stat = await fs.lstat(file, { bigint: true });
  if (!stat.isFile() || stat.size > 8n * 1024n * 1024n) throw unavailable();
  return stat;
};

/** Complete retained profile coverage, cached by file identity and content stats.
 * No task payload, ownership information, or receipt is exposed by this fence.
 * It never writes, migrates, reconciles, or truncates a retired journal.
 */
export async function assertNoRetainedEffectConflict(store, taskId, descriptor, call = {}) {
  if (descriptor.effect === 'observe') return;
  try {
    const directory = path.dirname(store.file(taskId));
    let cache = caches.get(store);
    if (!cache) caches.set(store, cache = new Map());
    const inventory = async () => (await fs.readdir(directory)).filter(name => name.endsWith('.json.sequence')).sort();
    for (let scan = 0; scan < 2; scan++) {
      const names = await inventory(), checked = new Map();
      const present = new Set(names);
      // A previously observed journal disappearing is not evidence of absence.
      if ([...cache.keys()].some(name => !present.has(name))) throw unavailable();
      let denial = null;
      for (let offset = 0; offset < names.length; offset += 32) {
        const journals = await Promise.all(names.slice(offset, offset + 32).map(async name => {
          const owner = name.slice(0, -'.json.sequence'.length), file = path.join(directory, name);
          if (path.resolve(store.file(owner) + '.sequence') !== path.resolve(file)) throw unavailable();
          for (let attempt = 0; attempt < 2; attempt++) {
            const before = signature(await statFile(file)), cached = cache.get(name);
            if (cached?.signature === before) { checked.set(name, before); return cached.value; }
            const value = JSON.parse(await fs.readFile(file, 'utf8'));
            let retained;
            if (value.version === 3) retained = { journal: validateRetainedContractJournal(value, owner) };
            else if ([1, 2].includes(value.version))
              retained = { unbound: await hasUnresolvedLegacyDispatch(file, owner) };
            else throw unavailable();
            if (signature(await statFile(file)) !== before) continue;
            cache.set(name, { signature: before, value: retained });
            checked.set(name, before);
            return retained;
          }
          throw unavailable();
        }));
        for (const value of journals) {
          if (value.unbound) throw unavailable();
          denial ||= value.journal && retainedContractEffectConflict(value.journal, descriptor, call);
        }
      }
      // Parsing later batches must not hide a changed early file. Validate the
      // complete inventory again, and refuse a continuously changing history.
      let stable = JSON.stringify(await inventory()) === JSON.stringify(names);
      for (let offset = 0; stable && offset < names.length; offset += 32) {
        const current = await Promise.all(names.slice(offset, offset + 32).map(async name =>
          signature(await statFile(path.join(directory, name))) === checked.get(name)));
        stable = current.every(Boolean);
      }
      if (!stable) continue;
      if (denial) throw Object.assign(new Error('A retained operation prevents this overlapping action. No action was dispatched. Inspect and reconcile the original receipt; unrelated work remains available.'), {
        code: denial, status: 409, actionDispatched: false
      });
      return;
    }
    throw unavailable();
  } catch (error) {
    if (['TASK_CONTRACT_EFFECT_UNCERTAIN', 'TASK_CONTRACT_EFFECT_CONFIRMED', 'TASK_CONTRACT_RESOURCE_BUSY'].includes(error.code)) throw error;
    throw unavailable();
  }
}
