import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

const DEFAULTS = Object.freeze({ revision: 1, connectorName: 'BLACKICE Bridge', mode: 'mcp', enabled: false, port: 8791, publicMcpUrl: '', approvalMode: 'reuse' });
const KEYS = Object.keys(DEFAULTS);
const clone = value => structuredClone(value);
const digest = value => createHash('sha256').update(value).digest('hex');
const fail = (message, status = 400, code = 'CHATGPT_BRIDGE_SETTINGS_INVALID') => Object.assign(new Error(message), { status, code });
const plain = value => Boolean(value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)));
const fields = value => {
  if (!plain(value) || Object.keys(value).some(key => !KEYS.includes(key))) throw fail('Bridge settings accept only revision, connectorName, mode, enabled, port, publicMcpUrl, and approvalMode.');
};
const revisionOf = value => {
  if (!Number.isSafeInteger(value) || value < 1) throw fail('Read the bridge settings and send their positive integer revision before saving.');
  return value;
};
const nameOf = value => {
  if (typeof value !== 'string' || !value.trim() || value.length > 80 || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) throw fail('connectorName must be nonempty text of at most 80 characters without control characters.');
  return value.trim();
};
const urlOf = value => {
  if (typeof value !== 'string' || value.length > 2048 || /[\u0000-\u0020\u007f]/u.test(value)) throw fail('publicMcpUrl must be empty or an HTTPS URL of at most 2,048 characters ending exactly in /mcp.');
  if (value === '') return '';
  let url;
  try { url = new URL(value); } catch { throw fail('publicMcpUrl must be a valid HTTPS URL ending exactly in /mcp.'); }
  if (!/^https:\/\/[^/?#\\@]+\/mcp$/i.test(value) || url.protocol !== 'https:' || url.pathname !== '/mcp' || url.username || url.password || url.search || url.hash) throw fail('publicMcpUrl must use HTTPS and the exact /mcp path, with no credentials, query, or fragment.');
  return url.href;
};
const validate = (value, { allowLegacy = false } = {}) => {
  fields(value);
  if (KEYS.some(key => !Object.hasOwn(value, key) && !(allowLegacy && key === 'approvalMode'))) throw fail('The saved bridge settings are incomplete.');
  const approvalMode = allowLegacy && !Object.hasOwn(value, 'approvalMode') ? DEFAULTS.approvalMode : value.approvalMode;
  if (!['reuse', 'confirm'].includes(approvalMode)) throw fail('approvalMode must be reuse or confirm.');
  if (!['mcp', 'connector'].includes(value.mode)) throw fail('mode must be mcp or connector.');
  if (typeof value.enabled !== 'boolean') throw fail('enabled must be true or false.');
  if (!Number.isSafeInteger(value.port) || value.port < 1024 || value.port > 65535) throw fail('port must be an integer from 1024 to 65535.');
  return { revision: revisionOf(value.revision), connectorName: nameOf(value.connectorName), mode: value.mode, enabled: value.enabled, port: value.port, publicMcpUrl: urlOf(value.publicMcpUrl), approvalMode };
};

/** Installation-owned connection preferences; bearer credentials stay separate. */
export class ChatGPTBridgeSettings {
  constructor({ dataDir } = {}) {
    if (typeof dataDir !== 'string' || !dataDir.trim() || dataDir.includes('\0')) throw fail('A local bridge settings folder is required.');
    this.file = path.join(path.resolve(dataDir), 'chatgpt-bridge-settings.json');
    this.tokenFile = path.join(path.resolve(dataDir), 'chatgpt-bridge-token.txt');
    this.config = clone(DEFAULTS); this.diskHash = null; this.hasToken = false;
    this.initialized = false; this.closed = false; this.unavailable = false; this.lastError = null;
    this.writeChain = Promise.resolve();
  }

  init() {
    if (this.initialized) return Promise.resolve(this);
    if (this.initPromise) return this.initPromise;
    this.initPromise = (async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      try { const saved = await this.readSettings(); this.config = saved.config; this.diskHash = saved.hash; }
      catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
      try { await this.readToken(); this.hasToken = true; }
      catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
      this.initialized = true; return this;
    })().catch(cause => {
      this.config = clone(DEFAULTS); this.initialized = true; this.unavailable = true;
      this.lastError = `The bridge settings could not be loaded: ${cause.message} Existing files were preserved. Restore the settings or token file from a known good copy, then restart BLACKICE.`;
      return this;
    });
    return this.initPromise;
  }

  get() { return clone(this.config); }
  status() { return { healthy: this.initialized && !this.closed && !this.unavailable && !this.lastError, error: this.lastError, hasToken: this.hasToken }; }

  assertReady() {
    if (!this.initialized) throw fail('Bridge settings are still loading. Retry after startup finishes.', 503, 'CHATGPT_BRIDGE_SETTINGS_NOT_READY');
    if (this.unavailable) throw fail(this.lastError || 'Bridge settings need recovery before they can be changed.', 503, 'CHATGPT_BRIDGE_SETTINGS_STORAGE');
  }

  async readSettings() {
    if ((await fs.stat(this.file)).size > 16384) throw fail('The bridge settings file is too large.');
    const bytes = await fs.readFile(this.file);
    if (bytes.length > 16384) throw fail('The bridge settings file is too large.');
    let value;
    try { value = JSON.parse(bytes.toString('utf8')); } catch { throw fail('The saved bridge settings are not valid JSON.'); }
    return { config: validate(value, { allowLegacy: true }), hash: digest(bytes) };
  }

  async readToken() {
    if ((await fs.stat(this.tokenFile)).size > 512) throw fail('The saved bridge token is invalid. Restore its file before reconnecting.', 503, 'CHATGPT_BRIDGE_TOKEN_INVALID');
    const bytes = await fs.readFile(this.tokenFile);
    const value = bytes.toString('utf8');
    if (bytes.length > 512 || !/^[A-Za-z0-9_-]{32,256}(?:\r?\n)?$/.test(value)) throw fail('The saved bridge token is invalid. Restore its file before reconnecting.', 503, 'CHATGPT_BRIDGE_TOKEN_INVALID');
    return value.replace(/\r?\n$/, '');
  }

  enqueue(operation) {
    this.assertReady();
    if (this.closed) return Promise.reject(fail('Bridge settings are closed. Reopen BLACKICE before changing them.', 503, 'CHATGPT_BRIDGE_SETTINGS_CLOSED'));
    const pending = this.writeChain.catch(() => {}).then(() => { this.assertReady(); return operation(); });
    this.writeChain = pending; return pending;
  }

  async assertSettingsUnchanged() {
    try {
      let saved;
      try { saved = await this.readSettings(); }
      catch (cause) { if (cause.code === 'ENOENT' && this.diskHash === null) return; throw cause; }
      if (saved.hash !== this.diskHash) throw fail('Bridge settings changed outside this server. Restart BLACKICE to load them.', 409, 'CHATGPT_BRIDGE_SETTINGS_CONFLICT');
    } catch (cause) {
      this.unavailable = true; this.config = clone(DEFAULTS);
      this.lastError = `The bridge settings cannot be updated: ${cause.message} Existing files were preserved. Restore the file and restart BLACKICE.`;
      throw fail(this.lastError, cause.status || 503, cause.code === 'CHATGPT_BRIDGE_SETTINGS_CONFLICT' ? cause.code : 'CHATGPT_BRIDGE_SETTINGS_STORAGE');
    }
  }

  async update(value) {
    fields(value); const revision = revisionOf(value.revision);
    // Validate and copy authored values before an asynchronous operation can run.
    const patch = { ...value }; delete patch.revision;
    validate({ ...DEFAULTS, ...patch });
    return this.enqueue(async () => {
      await this.assertSettingsUnchanged();
      if (revision !== this.config.revision) throw fail('Bridge settings changed. Reload them and save using the current revision.', 409, 'CHATGPT_BRIDGE_SETTINGS_CONFLICT');
      const desired = validate({ ...this.config, ...patch });
      if (JSON.stringify(desired) === JSON.stringify(this.config)) return this.get();
      if (this.config.revision === Number.MAX_SAFE_INTEGER) throw fail('The bridge settings revision limit was reached. Back up the settings file and start fresh settings before editing.', 507, 'CHATGPT_BRIDGE_SETTINGS_STORAGE');
      const next = { ...desired, revision: this.config.revision + 1 };
      const serialized = JSON.stringify(next, null, 2), temporary = `${this.file}.${randomUUID()}.tmp`;
      try {
        const handle = await fs.open(temporary, 'wx', 0o600);
        try { await handle.writeFile(serialized); await handle.sync(); } finally { await handle.close(); }
        await fs.rename(temporary, this.file);
        this.config = next; this.diskHash = digest(serialized); this.lastError = null;
        return this.get();
      } catch (cause) {
        this.lastError = `Bridge settings could not be saved: ${cause.message} The previously saved configuration was kept. Restore storage access and retry.`;
        throw fail(this.lastError, 503, 'CHATGPT_BRIDGE_SETTINGS_STORAGE');
      } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
    });
  }

  async token() {
    return this.enqueue(async () => {
      try {
        try {
          const existing = await this.readToken(); this.hasToken = true; this.lastError = null; return existing;
        } catch (cause) {
          if (cause.code !== 'ENOENT') throw cause;
          if (this.hasToken) throw fail('The previously saved bridge token is missing. Restore its file before reconnecting.', 503, 'CHATGPT_BRIDGE_TOKEN_INVALID');
        }
        const token = randomBytes(32).toString('base64url'), temporary = `${this.tokenFile}.${randomUUID()}.tmp`;
        try {
          const handle = await fs.open(temporary, 'wx', 0o600);
          try { await handle.writeFile(`${token}\n`); await handle.sync(); } finally { await handle.close(); }
          // Publish the complete secret atomically without overwriting another
          // installer. An EEXIST winner is already fully written and readable.
          try { await fs.link(temporary, this.tokenFile); }
          catch (cause) { if (cause.code !== 'EEXIST') throw cause; }
          const saved = await this.readToken(); this.hasToken = true; this.lastError = null; return saved;
        } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
      } catch (cause) {
        if (cause.code === 'CHATGPT_BRIDGE_TOKEN_INVALID') { this.unavailable = true; this.hasToken = false; this.config = clone(DEFAULTS); }
        this.lastError = `The bridge token could not be loaded or created: ${cause.message} Existing token files were preserved. Restore the token file or storage access and restart BLACKICE before reconnecting.`;
        throw fail(this.lastError, 503, cause.code === 'CHATGPT_BRIDGE_TOKEN_INVALID' ? cause.code : 'CHATGPT_BRIDGE_SETTINGS_STORAGE');
      }
    });
  }

  async close() { this.closed = true; if (this.initPromise) await this.initPromise; await this.writeChain.catch(() => {}); }
}
