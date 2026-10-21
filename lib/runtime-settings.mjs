import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { normalizeRunTimeout } from './run-timeout.mjs';
import { normalizeContextOptions } from './context.mjs';

const DEFAULTS = { codexHistory: 'relay', runTimeoutMs: null, providerIdleTimeoutMs: 300_000, defaultEffort: 'default', defaultContext: normalizeContextOptions(), verbosity: 'balanced', subagentsEnabled: false, maxSubagents: 3 };

export function validateRuntimeSettings(value) {
  const invalid = message => Object.assign(new Error(message), { status: 400, code: 'RUNTIME_SETTINGS_INVALID' });
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.keys(value).length || Object.keys(value).some(key => !Object.hasOwn(DEFAULTS, key))) throw invalid('Choose conversation defaults, history, or agent time limits.');
  const next = {};
  if (Object.hasOwn(value, 'codexHistory')) {
    if (!['relay', 'codex'].includes(value.codexHistory)) throw invalid('Choose codexHistory: relay or codex.');
    next.codexHistory = value.codexHistory;
  }
  for (const key of ['runTimeoutMs', 'providerIdleTimeoutMs']) if (Object.hasOwn(value, key)) {
    try { next[key] = normalizeRunTimeout(value[key]); } catch (cause) { throw invalid(cause.message); }
  }
  if (Object.hasOwn(value, 'defaultEffort')) {
    if (!['default','none','minimal','low','medium','high','xhigh','max','ultra'].includes(value.defaultEffort)) throw invalid('Choose a valid default reasoning effort, including model default, max, or ultra.');
    next.defaultEffort = value.defaultEffort;
  }
  if (Object.hasOwn(value, 'defaultContext')) {
    try { next.defaultContext = normalizeContextOptions(value.defaultContext); } catch (cause) { throw invalid(cause.message); }
  }
  if (Object.hasOwn(value, 'verbosity')) {
    if (!['concise', 'balanced', 'detailed'].includes(value.verbosity)) throw invalid('Choose concise, balanced, or detailed verbosity.');
    next.verbosity = value.verbosity;
  }
  if (Object.hasOwn(value, 'subagentsEnabled')) {
    if (typeof value.subagentsEnabled !== 'boolean') throw invalid('Subagents must be enabled or disabled.');
    next.subagentsEnabled = value.subagentsEnabled;
  }
  if (Object.hasOwn(value, 'maxSubagents')) {
    if (!Number.isSafeInteger(value.maxSubagents) || value.maxSubagents < 1 || value.maxSubagents > 8) throw invalid('Choose 1 to 8 parallel subagents.');
    next.maxSubagents = value.maxSubagents;
  }
  return next;
}

/** Application preferences are independent of model accounts and credentials. */
export class RuntimeSettingsStore extends EventEmitter {
  constructor({ dataDir }) {
    super(); this.dataDir = dataDir; this.file = path.join(dataDir, 'runtime-settings.json');
    this.value = structuredClone(DEFAULTS); this.tail = Promise.resolve(); this.closed = false;
  }
  async init() {
    await fs.mkdir(this.dataDir, { recursive: true });
    try { this.value = { ...DEFAULTS, ...validateRuntimeSettings(JSON.parse(await fs.readFile(this.file, 'utf8'))) }; }
    catch (error) { if (error.code !== 'ENOENT') throw new Error(`Cannot load runtime preferences: ${error.message}. The existing file was preserved.`); }
    return this;
  }
  get() { return structuredClone(this.value); }
  update(value) {
    let patch; try { patch = validateRuntimeSettings(value); } catch (error) { return Promise.reject(error); }
    const contextPatch=Object.hasOwn(value,'defaultContext')?structuredClone(value.defaultContext):null;
    const save = async () => {
      if (this.closed) throw Object.assign(new Error('Relay is closing. Reopen it before changing runtime preferences.'), { status: 503 });
      // Merge after the preceding durable save, so independent windows cannot
      // overwrite an unrelated preference with their older snapshot.
      const next = { ...this.value, ...patch };
      if(contextPatch)next.defaultContext=validateRuntimeSettings({defaultContext:{...this.value.defaultContext,...contextPatch}}).defaultContext;
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      try {
        const handle = await fs.open(temporary, 'wx', 0o600);
        try { await handle.writeFile(JSON.stringify(next, null, 2)); await handle.sync(); } finally { await handle.close(); }
        await fs.rename(temporary, this.file);
      } catch (error) {
        await fs.unlink(temporary).catch(() => {});
        throw Object.assign(new Error(`Runtime preferences were not saved: ${error.message}`), { status: 500, code: 'RUNTIME_SETTINGS_SAVE_FAILED' });
      }
      this.value = next; this.emit('updated', this.get()); return this.get();
    };
    const pending = this.tail.catch(() => {}).then(save); this.tail = pending; return pending;
  }
  async close() { this.closed = true; await this.tail.catch(() => {}); }
}
