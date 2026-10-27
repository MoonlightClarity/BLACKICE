import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const AGENT_TOKEN = /^blackice_agent_[A-Za-z0-9_-]{43}$/;
const HASH = /^[a-f0-9]{64}$/;
export const REMOTE_SCOPES = Object.freeze(['read', 'tasks:write', 'planning:write']);
const DAY = 86400000;
const digest = value => createHash('sha256').update(value).digest('hex');
const equalHash = (first, second) => HASH.test(first || '') && HASH.test(second || '') && timingSafeEqual(Buffer.from(first, 'hex'), Buffer.from(second, 'hex'));
const error = (message, code, status = 400) => Object.assign(new Error(message), { code, status });
const publicDevice = ({ id, kind, label, scopes, createdAt, lastSeenAt, expiresAt }) => ({ id, kind, label, scopes: [...scopes], createdAt, lastSeenAt, expiresAt });
const validTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const validLabel = value => typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 80 && !/[\x00-\x1f\x7f]/.test(value);
export function validateRemoteScopes(scopes) {
  if (!Array.isArray(scopes) || !scopes.length || scopes.length > REMOTE_SCOPES.length || new Set(scopes).size !== scopes.length || scopes.some(scope => !REMOTE_SCOPES.includes(scope))) throw error('Choose one or more supported agent permissions.', 'REMOTE_SCOPES_INVALID');
  return REMOTE_SCOPES.filter(scope => scopes.includes(scope));
}
export function validatePairingOptions(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['kind', 'scopes'].includes(key))) throw error('Choose the pairing client type and its permissions.', 'REMOTE_PAIRING_OPTIONS');
  const kind = value.kind === undefined ? 'browser' : value.kind;
  if (!['browser', 'agent'].includes(kind)) throw error('Choose browser or agent pairing.', 'REMOTE_PAIRING_OPTIONS');
  // Scope input is tolerated for older pairing clients but cannot restrict a
  // newly connected agent: all paired identities have the same capabilities.
  return { kind, scopes: [...REMOTE_SCOPES] };
}

export async function writeRemoteJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await fs.open(temporary, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(value, null, 2) + '\n'); await handle.sync(); } finally { await handle.close(); }
    await fs.rename(temporary, file);
  } catch (cause) { await fs.rm(temporary, { force: true }).catch(() => {}); throw cause; }
}

/** Device credentials are random bearer tokens. Only their SHA-256 hashes reach disk. */
export class RemoteSessionStore extends EventEmitter {
  constructor({ dataDir, now = Date.now, sessionLifetimeMs = 30 * DAY, pairingLifetimeMs = 5 * 60000 } = {}) {
    super(); this.file = path.join(dataDir, 'remote-access-devices.json'); this.now = now;
    this.sessionLifetimeMs = sessionLifetimeMs; this.pairingLifetimeMs = pairingLifetimeMs;
    this.devices = []; this.pairing = null; this.tail = Promise.resolve(); this.closed = false;
  }
  async init() {
    try {
      const stat = await fs.stat(this.file); if (stat.size > 65536) throw Error('Oversized device record.');
      const value = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (value?.schema !== 1 || !Array.isArray(value.devices) || value.devices.length > 20 || Object.keys(value).some(key => !['schema', 'devices'].includes(key))) throw Error('Invalid device record.');
      const ids = new Set(), hashes = new Set();
      for (const device of value.devices) {
        if (!device || Object.keys(device).some(key => !['id', 'kind', 'hash', 'label', 'scopes', 'createdAt', 'lastSeenAt', 'expiresAt'].includes(key)) || !/^[a-f0-9-]{36}$/.test(device.id || '') || !HASH.test(device.hash || '') || !validLabel(device.label) || device.label.length > 80 || ![device.createdAt, device.lastSeenAt, device.expiresAt].every(validTime) || Date.parse(device.expiresAt) <= Date.parse(device.createdAt) || ids.has(device.id) || hashes.has(device.hash)) throw Error('Invalid device record.');
        // Older records only described paired browsers. Never infer an agent credential.
        if (device.kind === undefined && device.scopes === undefined) { device.kind = 'browser'; device.scopes = [...REMOTE_SCOPES]; }
        if (!['browser', 'agent'].includes(device.kind)) throw Error('Invalid client kind.');
        device.scopes = validateRemoteScopes(device.scopes);
        if (device.kind === 'browser' && device.scopes.length !== REMOTE_SCOPES.length) throw Error('Invalid browser permissions.');
        ids.add(device.id); hashes.add(device.hash);
      }
      this.devices = value.devices.filter(device => Date.parse(device.expiresAt) > this.now());
    } catch (cause) { if (cause.code !== 'ENOENT') throw error('Remote device records could not be read. The original file was preserved.', 'REMOTE_DEVICES_UNREADABLE', 503); }
    return this;
  }
  status() {
    const now = this.now();
    return { devices: this.devices.filter(device => Date.parse(device.expiresAt) > now).map(publicDevice), pairing: { active: Boolean(this.pairing && this.pairing.expiresAt > now && this.pairing.sessionExpiresAt > now && this.pairing.attempts < 8), ...(this.pairing && this.pairing.expiresAt > now ? { expiresAt: new Date(this.pairing.expiresAt).toISOString(), kind: this.pairing.kind, scopes: [...this.pairing.scopes], sessionExpiresAt: new Date(this.pairing.sessionExpiresAt).toISOString() } : {}) } };
  }
  issuePairing(options = {}) {
    if (this.closed) throw error('Remote access is closing.', 'REMOTE_CLOSED', 503);
    const { kind, scopes } = validatePairingOptions(options);
    if (this.status().devices.length >= 20) throw error('Remove a paired device before adding another.', 'REMOTE_DEVICE_LIMIT', 409);
    const secret = randomBytes(16).toString('hex').toUpperCase(), now = this.now();
    this.pairing = { hash: digest(secret), kind, scopes, expiresAt: Math.min(now + this.pairingLifetimeMs, now + this.sessionLifetimeMs), sessionExpiresAt: now + this.sessionLifetimeMs, attempts: 0 };
    this.emit('updated', this.status());
    return { code: secret.match(/.{4}/g).join('-'), kind, scopes: [...scopes], expiresAt: new Date(this.pairing.expiresAt).toISOString(), sessionExpiresAt: new Date(this.pairing.sessionExpiresAt).toISOString() };
  }
  cancelPairing() { this.pairing = null; this.emit('updated', this.status()); }
  enqueue(operation) {
    const next = this.tail.catch(() => {}).then(() => { if (this.closed) throw error('Remote access is closing.', 'REMOTE_CLOSED', 503); return operation(); });
    this.tail = next; return next;
  }
  pair(code, label = 'Paired browser') { return this.redeemPairing(code, label, 'browser'); }
  pairAgent(code, label = 'Paired agent') { return this.redeemPairing(code, label, 'agent'); }
  redeemPairing(code, label, kind) {
    return this.enqueue(async () => {
      const pairing = this.pairing, normalized = typeof code === 'string' && code.length <= 80 ? code.replace(/[\s-]/g, '').toUpperCase() : '';
      if (!pairing || pairing.expiresAt <= this.now() || pairing.sessionExpiresAt <= this.now() || pairing.attempts >= 8) throw error('The pairing code is invalid or expired for this client type. Create a matching code in BLACKICE on the host computer.', 'REMOTE_PAIRING_INVALID', 401);
      pairing.attempts++;
      if (pairing.kind !== kind || !/^[A-F0-9]{32}$/.test(normalized) || !equalHash(digest(normalized), pairing.hash)) throw error('The pairing code is invalid or expired for this client type. Create a matching code in BLACKICE on the host computer.', 'REMOTE_PAIRING_INVALID', 401);
      if (!validLabel(label)) throw error('Use a device name of 1 to 80 characters.', 'REMOTE_DEVICE_NAME');
      this.pairing = null; // Consume before the asynchronous durable write; concurrent use cannot win twice.
      return this.issueDevice({ kind: pairing.kind, label, scopes: pairing.scopes, expiresAt: pairing.sessionExpiresAt });
    });
  }
  createAgent({ label } = {}) {
    if (!validLabel(label)) return Promise.reject(error('Use an agent name of 1 to 80 characters.', 'REMOTE_DEVICE_NAME'));
    return this.enqueue(() => this.issueDevice({ kind: 'agent', label, scopes: [...REMOTE_SCOPES] }));
  }
  async issueDevice({ kind, label, scopes, expiresAt = this.now() + this.sessionLifetimeMs }) {
    const token = (kind === 'agent' ? 'blackice_agent_' : '') + randomBytes(32).toString('base64url'), now = this.now(), timestamp = new Date(now).toISOString();
    if (!Number.isFinite(expiresAt) || expiresAt <= now) throw error('The pairing grant has expired. Create a new code on the host computer.', 'REMOTE_PAIRING_INVALID', 401);
    const device = { id: randomUUID(), kind, hash: digest(token), label: label.trim(), scopes: [...scopes], createdAt: timestamp, lastSeenAt: timestamp, expiresAt: new Date(expiresAt).toISOString() };
    const next = [...this.devices.filter(item => Date.parse(item.expiresAt) > now), device];
    if (next.length > 20) throw error('Remove a paired device or agent before adding another.', 'REMOTE_DEVICE_LIMIT', 409);
    await writeRemoteJson(this.file, { schema: 1, devices: next }); this.devices = next;
    this.emit('updated', this.status()); return { token, device: publicDevice(device) };
  }
  authenticate(token, kind = 'browser') {
    if (this.closed || !['browser', 'agent'].includes(kind) || !(kind === 'agent' ? AGENT_TOKEN : TOKEN).test(token || '')) return null;
    const hash = digest(token), now = this.now();
    const device = this.devices.find(item => item.kind === kind && Date.parse(item.expiresAt) > now && equalHash(item.hash, hash));
    if (!device) return null;
    device.lastSeenAt = new Date(now).toISOString(); return publicDevice(device);
  }
  getClient(id) {
    const device = !this.closed && this.devices.find(item => item.id === id && Date.parse(item.expiresAt) > this.now());
    return device ? publicDevice(device) : null;
  }
  revoke(id) {
    if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) return Promise.reject(error('Choose a paired device.', 'REMOTE_DEVICE_INVALID'));
    return this.enqueue(async () => {
      if (!this.devices.some(device => device.id === id)) throw error('The paired device was not found.', 'REMOTE_DEVICE_NOT_FOUND', 404);
      const next = this.devices.filter(device => device.id !== id);
      await writeRemoteJson(this.file, { schema: 1, devices: next }); this.devices = next;
      this.emit('revoked', [id]); this.emit('updated', this.status()); return this.status();
    });
  }
  revokeAll() {
    this.pairing = null;
    return this.enqueue(async () => {
      const ids = this.devices.map(device => device.id);
      await writeRemoteJson(this.file, { schema: 1, devices: [] }); this.devices = [];
      this.emit('revoked', ids); this.emit('updated', this.status()); return this.status();
    });
  }
  async close() { if (this.closed) return; this.closed = true; this.pairing = null; await this.tail.catch(() => {}); }
}
