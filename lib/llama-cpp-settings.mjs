import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DEFAULT_LLAMA_CPP_SETTINGS, validateLlamaCppSettings } from './llama-cpp-launch-config.mjs';

const conflict = () => Object.assign(new Error(
  'llama.cpp launch preferences changed elsewhere. Refresh before saving.'
), {status: 409, code: 'LOCAL_LLAMA_SETTINGS_REVISION'});

/** An independent store: preference edits never restart or touch a loaded model. */
export class LlamaCppSettingsStore {
  constructor({dataDir, file, fsImpl = fs} = {}) {
    if (!dataDir && !file) throw TypeError('A local data directory is required.');
    this.file = file || path.join(dataDir, 'llama-cpp-settings.json');
    this.fs = fsImpl;
    this.value = validateLlamaCppSettings(DEFAULT_LLAMA_CPP_SETTINGS);
    this.revision = 0;
    this.loaded = false;
    this.queue = Promise.resolve();
  }
  async init() {
    if (this.loaded) return this;
    try {
      const text = await this.fs.readFile(this.file, 'utf8');
      const saved = JSON.parse(text);
      if (saved?.version !== 1 || !Number.isSafeInteger(saved.revision) || saved.revision < 0)
        throw Error('Unsupported llama.cpp settings file version.');
      this.value = validateLlamaCppSettings(saved.settings);
      this.revision = saved.revision;
    } catch (cause) {
      if (cause.code !== 'ENOENT') throw Object.assign(
        new Error('Unable to read saved llama.cpp settings: ' + String(cause.message || cause)),
        {code: 'LOCAL_LLAMA_SETTINGS_UNREADABLE', status: 500});
    }
    this.loaded = true;
    return this;
  }
  snapshot() {
    if (!this.loaded) throw Error('Initialize llama.cpp settings before reading.');
    return {revision: this.revision, settings: structuredClone(this.value),
      recommended: structuredClone(DEFAULT_LLAMA_CPP_SETTINGS)};
  }
  async update({expectedRevision, settings} = {}) {
    if (!this.loaded) throw Error('Initialize llama.cpp settings before editing.');
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
      throw Object.assign(new Error('Supply the current settings revision.'), {status: 400, code: 'LOCAL_LLAMA_SETTINGS_REVISION'});
    const next = validateLlamaCppSettings(settings);
    const commit = async () => {
      if (expectedRevision !== this.revision) throw conflict();
      const nextRevision = this.revision + 1;
      await this.fs.mkdir(path.dirname(this.file), {recursive: true});
      const temp = this.file + '.' + randomUUID() + '.tmp';
      try {
        await this.fs.writeFile(temp, JSON.stringify({
          version: 1, revision: nextRevision, settings: next
        }, null, 2) + '\n', {encoding: 'utf8', flag: 'wx'});
        await this.fs.rename(temp, this.file);
      } finally {
        await this.fs.rm(temp, {force: true}).catch(() => {});
      }
      this.value = next;
      this.revision = nextRevision;
      return this.snapshot();
    };
    const operation = this.queue.then(commit);
    this.queue = operation.catch(() => {});
    return operation;
  }
}
