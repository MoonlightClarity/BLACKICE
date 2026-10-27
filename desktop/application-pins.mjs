import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

function pins(value) {
  if (!Array.isArray(value) || value.length > 1000 || value.some(id => typeof id !== 'string' || !id.trim() || id.length > 200 || /[\u0000-\u001f\u007f]/.test(id))) {
    throw new Error('Pinned applications must be an ordered list of application IDs.');
  }
  if (new Set(value).size !== value.length) throw new Error('An application can only be pinned once.');
  return [...value];
}

/** Launcher preferences belong to the Windows profile, not a temporary HTTP
 * origin. Missing catalog entries retain their pins until the user removes them.
 */
export class ApplicationPins {
  constructor({ profileDir, io = fs } = {}) {
    if (!profileDir || !path.isAbsolute(profileDir)) throw new Error('Application pins require an absolute profile directory.');
    this.file = path.join(profileDir, 'data', 'application-launcher.json');
    this.io = io;
    this.tail = Promise.resolve();
  }
  async load() {
    let text;
    try {
      const info = await this.io.stat(this.file);
      if (!info.isFile() || info.size > 256 * 1024) throw new Error('The saved application pins are invalid.');
      text = await this.io.readFile(this.file, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return { appIds: [] };
      throw error;
    }
    let saved;
    try { saved = JSON.parse(text.replace(/^\uFEFF/, '')); }
    catch { throw new Error('The saved application pins could not be read. Your saved file was preserved.'); }
    if (saved?.version !== 1) throw new Error('The saved application pins use an unsupported format.');
    return { appIds: pins(saved.appIds) };
  }
  read() {
    const result = this.tail.catch(() => {}).then(() => this.load());
    this.tail = result;
    return result;
  }
  write(appIds) {
    let values;
    try { values = pins(appIds); } catch (error) { return Promise.reject(error); }
    const result = this.tail.catch(() => {}).then(async () => {
      // Do not silently replace an unreadable existing preference file.
      await this.load();
      await this.io.mkdir(path.dirname(this.file), { recursive: true });
      const temporary = this.file + '.' + randomUUID() + '.tmp';
      let handle;
      try {
        handle = await this.io.open(temporary, 'wx', 0o600);
        await handle.writeFile(JSON.stringify({ version: 1, appIds: values }) + '\n', 'utf8');
        await handle.sync(); await handle.close(); handle = null;
        await this.io.rename(temporary, this.file);
      } finally {
        await handle?.close().catch(() => {});
        await this.io.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
      }
      return { appIds: [...values] };
    });
    this.tail = result;
    return result;
  }
}
