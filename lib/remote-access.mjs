import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { RemoteSessionStore, writeRemoteJson } from './remote-access-auth.mjs';
import { RemoteAccessGateway, validateLoopbackTarget, forwardedIdentityPath } from './remote-access-gateway.mjs';
import { TailscaleRemoteTransport, ownsRemoteRoute, validateRemoteOwnership, remotePortClaimed } from './remote-access-tailscale.mjs';

const fail = (message, code = 'REMOTE_UNAVAILABLE', status = 503) => Object.assign(new Error(message), { code, status });
const validHttpsPort = value => value === 443 || value === 8443;
const remoteOrigin = (hostname, httpsPort) => `https://${hostname}${httpsPort === 443 ? '' : ':' + httpsPort}`;
const initialConfig = httpsPort => ({ schema: 1, enabled: false, mode: 'private', publicApproved: false, httpsPort, gatewayPort: 0, ownership: null });
const safeError = cause => ({ code: /^[A-Z_]{3,80}$/.test(cause?.code || '') ? cause.code : 'REMOTE_UNAVAILABLE', message: cause?.code === 'EADDRINUSE' ? 'The saved remote gateway port is in use. BLACKICE kept remote access closed.' : cause?.code?.startsWith('REMOTE_') ? cause.message : 'Remote access could not start. The local BLACKICE application is still available.' });

function validateConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['schema', 'enabled', 'mode', 'publicApproved', 'httpsPort', 'gatewayPort', 'ownership'].includes(key)) || value.schema !== 1 || typeof value.enabled !== 'boolean' || !['private', 'public'].includes(value.mode) || typeof value.publicApproved !== 'boolean' || !Number.isInteger(value.gatewayPort) || value.gatewayPort !== 0 && (value.gatewayPort < 1024 || value.gatewayPort > 65535) || value.enabled && value.mode === 'public' && !value.publicApproved) throw fail('Remote access settings could not be read. The original file was preserved.', 'REMOTE_CONFIG_UNREADABLE');
  if (!Object.hasOwn(value, 'httpsPort')) value.httpsPort = value.ownership?.httpsPort ?? 8443;
  if (!validHttpsPort(value.httpsPort)) throw fail('The saved HTTPS port is not supported.', 'REMOTE_CONFIG_UNREADABLE');
  if (value.ownership !== null) {
    const own = validateRemoteOwnership(value.ownership);
    if (Number(new URL(own.target).port) !== value.gatewayPort || own.mode !== value.mode || own.httpsPort !== value.httpsPort) throw fail('The saved remote route and gateway do not match.', 'REMOTE_CONFIG_UNREADABLE');
    value.ownership = own;
  }
  if (value.enabled && (!value.ownership || !value.gatewayPort)) throw fail('The saved remote route is incomplete.', 'REMOTE_CONFIG_UNREADABLE');
  return value;
}

/** The main application remains loopback-only. Credentials and forwarding authority stay in this process. */
export class RemoteAccessManager extends EventEmitter {
  constructor({ dataDir, sessions, transport, gatewayFactory, connector, defaultHttpsPort = 443, now = Date.now } = {}) {
    super(); this.file = path.join(dataDir, 'remote-access.json'); this.now = now;
    if (!validHttpsPort(defaultHttpsPort)) throw Error('Use standard HTTPS or the legacy HTTPS port.');
    this.sessions = sessions || new RemoteSessionStore({ dataDir, now }); this.transport = transport || new TailscaleRemoteTransport();
    this.gatewayFactory = gatewayFactory || (options => new RemoteAccessGateway(options)); this.connector = connector || null;
    this.config = initialConfig(defaultHttpsPort); this.gateway = null; this.target = null; this.sessionCookie = null;
    this.available = true; this.state = 'disabled'; this.error = null; this.closed = false; this.initialized = false;
    this.transportStatus = { kind: 'tailscale', available: false, online: false, dnsName: null, httpsPort: defaultHttpsPort, private: true, publicOption: true };
    this.tail = Promise.resolve(); this.forwarding = new Map(); this.closePromise = null;
    this.sessions.on('updated', () => this.updated());
    this.sessions.on('revoked', ids => { for (const [key, entry] of this.forwarding) if (ids.includes(entry.id)) this.forwarding.delete(key); });
  }
  async init() {
    if (this.initialized) return this; this.initialized = true;
    try {
      try { const stat = await fs.stat(this.file); if (stat.size > 16384) throw Error(); this.config = validateConfig(JSON.parse(await fs.readFile(this.file, 'utf8'))); }
      catch (cause) { if (cause.code !== 'ENOENT') throw fail('Remote access settings could not be read. The original file was preserved.', 'REMOTE_CONFIG_UNREADABLE'); }
      await this.sessions.init();
    } catch (cause) { this.available = false; this.state = 'error'; this.error = safeError(cause); }
    return this;
  }
  status() {
    const own = this.config.ownership;
    const httpsPort = own?.httpsPort ?? this.config.httpsPort;
    const url = own ? remoteOrigin(own.hostname, httpsPort) : this.transportStatus.dnsName ? remoteOrigin(this.transportStatus.dnsName, httpsPort) : null;
    return { available: this.available, configuredEnabled: this.config.enabled, enabled: this.state === 'ready' && this.gateway?.accepting === true && this.gateway?.listening === true, state: this.state, mode: this.config.mode, url,
      endpoints: url ? { mcp: url + '/mcp', api: url + '/api/agent' } : null,
      transport: { ...this.transportStatus, httpsPort, private: this.config.mode === 'private' }, gateway: { listening: Boolean(this.gateway?.listening), accepting: Boolean(this.gateway?.accepting && this.state === 'ready'), port: this.gateway?.port || this.config.gatewayPort || null, loopback: true },
      ...this.sessions.status(), error: this.error, client: 'local', localManagement: true };
  }
  connectorDiscovery() { return this.gateway?.connectorDiscovery?.() || []; }
  updated() { this.emit('updated', this.status()); }
  attachConnector(connector) {
    if (!connector || typeof connector.matches !== 'function' || typeof connector.handle !== 'function' || typeof connector.setOrigin !== 'function') throw Error('Attach a complete ChatGPT connector.');
    this.connector = connector;
    if (this.gateway) { connector.setOrigin(this.gateway.publicUrl.origin); this.gateway.connector = connector; }
  }
  enqueue(operation) {
    const next = this.tail.catch(() => {}).then(() => { this.requireOpen(); return operation(); }); this.tail = next; return next;
  }
  requireOpen() { if (this.closed) throw fail('Remote access is closing.', 'REMOTE_CLOSED'); if (!this.available) throw fail(this.error?.message || 'Remote access is unavailable.', this.error?.code || 'REMOTE_UNAVAILABLE'); }
  async save(value) { await writeRemoteJson(this.file, value); this.config = value; }
  async attach({ origin, sessionCookie } = {}) {
    // Never propagate remote startup failures into the local application's listen().
    try {
      this.requireOpen(); this.target = validateLoopbackTarget(origin, sessionCookie); this.sessionCookie = sessionCookie;
      if (this.config.enabled) await this.enqueue(() => this.start({ mode: this.config.mode, confirmPublic: this.config.publicApproved, resume: true }));
      else if (this.config.ownership) await this.enqueue(async () => { await this.removeRoute(); await this.save({ ...this.config, ownership: null }); });
    } catch (cause) { this.state = 'error'; this.error = safeError(cause); this.updated(); }
    return this.status();
  }
  refresh() {
    return this.enqueue(async () => {
      try {
        const result = await this.transport.inspect({ httpsPort: this.config.httpsPort }); this.transportStatus = result.status;
        if (this.state === 'ready' && (!result.status.online || !ownsRemoteRoute(result.config, this.config.ownership))) {
          this.gateway?.suspend(); this.forwarding.clear(); throw fail('The HTTPS route is offline or has changed. Remote access is suspended until you enable it again.', 'REMOTE_ROUTE_CHANGED');
        }
        if (this.state !== 'error') this.error = null;
      } catch (cause) { if (this.state === 'ready') this.gateway?.suspend(); this.state = 'error'; this.error = safeError(cause); }
      this.updated(); return this.status();
    });
  }
  enable(options = {}) {
    return this.enqueue(() => this.start(options));
  }
  async start({ mode = 'private', confirmPublic = false, resume = false, httpsPort = this.config.httpsPort } = {}) {
    if (!['private', 'public'].includes(mode) || typeof confirmPublic !== 'boolean') throw fail('Choose Private or Public remote access.', 'REMOTE_MODE_INVALID', 400);
    if (!validHttpsPort(httpsPort)) throw fail('Choose standard HTTPS or the legacy HTTPS port.', 'REMOTE_PORT_INVALID', 400);
    if (mode === 'public' && confirmPublic !== true) throw fail('Choose Enable public access on this computer to publish the authenticated endpoint.', 'REMOTE_PUBLIC_CONFIRMATION', 400);
    if (!this.target) throw fail('The local BLACKICE server is not ready.', 'REMOTE_LOCAL_NOT_READY');
    if (this.state === 'ready' && this.config.mode === mode && this.config.httpsPort === httpsPort) return this.status();
    this.state = 'starting'; this.error = null; this.updated();
    let intendedOwnership = null;
    try {
      // Switching exposure modes is an explicit remove-and-create transaction.
      // This avoids recording public ownership while a still-private route remains after a crash.
      if (this.config.ownership && (!resume || this.config.mode !== mode || this.config.httpsPort !== httpsPort)) {
        await this.removeRoute(); await this.save({ ...this.config, enabled: false, ownership: null, httpsPort });
      } else if (this.gateway) { this.gateway.suspend(); await this.gateway.close(); this.gateway = null; }
      const inspected = await this.transport.inspect({ httpsPort }); this.transportStatus = inspected.status;
      if (!inspected.status.online || !inspected.status.dnsName) throw fail('Connect Tailscale on this computer before enabling remote access.', 'REMOTE_TAILSCALE_OFFLINE');
      if (remotePortClaimed(inspected.config, httpsPort) && !ownsRemoteRoute(inspected.config, this.config.ownership)) throw fail(`Tailscale HTTPS port ${httpsPort} is already used by another or changed route. BLACKICE left it unchanged.`, 'REMOTE_PORT_IN_USE', 409);
      const origin = remoteOrigin(inspected.status.dnsName, httpsPort);
      this.connector?.setOrigin(origin);
      const oldOwnership = this.config.ownership;
      this.requireOpen();
      this.gateway = this.gatewayFactory({ origin, mode, targetOrigin: this.target.origin, sessionCookie: this.sessionCookie, sessions: this.sessions, connector: this.connector, port: this.config.gatewayPort, now: this.now, forwardCredential: value => this.forwardCredential(value) });
      const gatewayOrigin = await this.gateway.listen();
      intendedOwnership = validateRemoteOwnership({ hostname: inspected.status.dnsName, httpsPort, target: gatewayOrigin, mode });
      await this.save({ schema: 1, enabled: true, mode, publicApproved: mode === 'public', httpsPort, gatewayPort: this.gateway.port, ownership: intendedOwnership });
      this.requireOpen();
      const result = await this.transport.enable({ target: gatewayOrigin, mode, ownership: oldOwnership, httpsPort });
      this.requireOpen(); this.transportStatus = result.status; this.state = 'ready'; this.error = null; this.updated(); return this.status();
    } catch (cause) {
      this.gateway?.suspend(); this.forwarding.clear();
      // A failed readback never authorizes deleting an unknown route. Keep a denial
      // listener on the owned port if targeted route removal cannot be verified.
      if (intendedOwnership || this.config.ownership) {
        try { await this.removeRoute(intendedOwnership || this.config.ownership); await this.save({ ...this.config, enabled: false, ownership: null }); }
        catch { await this.save({ ...this.config, enabled: false }).catch(() => {}); }
      } else { await this.gateway?.close().catch(() => {}); this.gateway = null; }
      this.state = 'error'; this.error = safeError(cause); this.updated(); throw fail(this.error.message, this.error.code, cause.status || 503);
    }
  }
  async removeRoute(ownership = this.config.ownership) {
    this.gateway?.suspend(); this.forwarding.clear();
    if (ownership) { const result = await this.transport.disable(ownership); this.transportStatus = result.status; }
    await this.gateway?.close(); this.gateway = null;
  }
  disable() {
    // Revoke network admission immediately, before any CLI or durable write.
    this.gateway?.suspend(); this.forwarding.clear(); this.sessions.cancelPairing();
    return this.enqueue(async () => {
      await this.save({ ...this.config, enabled: false });
      await this.sessions.revokeAll();
      await this.connector?.setEnabled(false);
      try { await this.removeRoute(); await this.save({ ...this.config, ownership: null }); this.state = 'disabled'; this.error = null; }
      catch (cause) { this.state = 'error'; this.error = safeError(cause); }
      this.updated(); return this.status();
    });
  }
  pair(options = {}) {
    this.requireReady(); const result = this.sessions.issuePairing(options), status = this.status();
    return { ...result, ...(result.kind === 'browser' ? { pairUrl: status.url + '/#code=' + encodeURIComponent(result.code) } : { redeemUrl: status.url + '/remote/agent/pair' }), status };
  }
  async createAgent(options) {
    this.requireReady(); const result = await this.sessions.createAgent(options); return { ...result, status: this.status() };
  }
  async revoke(id) { this.requireOpen(); await this.sessions.revoke(id); return this.status(); }
  requireReady() { this.requireOpen(); if (this.state !== 'ready' || !this.gateway?.accepting) throw fail('Enable remote access before pairing a browser or creating an agent credential.', 'REMOTE_NOT_ENABLED', 409); }
  forwardCredential({ method, path: requestPath, client }) {
    this.requireReady();
    const actual = this.sessions.getClient(client?.id);
    if (!actual || actual.kind !== client.kind || !forwardedIdentityPath(new URL(requestPath, this.target).pathname, method, actual.kind)) throw fail('The remote client is no longer authorized.', 'REMOTE_CREDENTIAL_REQUIRED', 401);
    const now = this.now(); for (const [key, entry] of this.forwarding) if (entry.expiresAt <= now) this.forwarding.delete(key);
    if (this.forwarding.size >= 512) throw fail('The remote agent interface is busy.', 'REMOTE_FORWARD_LIMIT');
    const token = randomBytes(32).toString('base64url');
    this.forwarding.set(token, { id: actual.id, method, path: requestPath, expiresAt: now + 15000 }); return token;
  }
  authorizeForward(req) {
    const token = req.headers?.['x-blackice-forward'];
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const entry = this.forwarding.get(token); this.forwarding.delete(token);
    if (this.closed || this.state !== 'ready' || !this.gateway?.accepting || !entry || entry.expiresAt <= this.now() || entry.method !== req.method || entry.path !== req.url || req.headers.host !== this.target?.host || req.headers.origin !== this.target?.origin || req.headers['x-blackice-remote'] !== '1' || !['127.0.0.1', '::ffff:127.0.0.1'].includes(req.socket?.remoteAddress)) return null;
    const client = this.sessions.getClient(entry.id); return client ? { id: client.id, kind: client.kind, label: client.label, scopes: [...client.scopes], expiresAt: client.expiresAt } : null;
  }
  close() {
    if (this.closePromise) return this.closePromise;
    this.closed = true; this.gateway?.suspend(); this.forwarding.clear(); this.sessions.cancelPairing();
    this.closePromise = (async () => {
      await this.tail.catch(() => {});
      try { await this.removeRoute(); }
      catch (cause) { this.error = safeError(cause); }
      finally { await this.gateway?.close().catch(() => {}); this.gateway = null; await this.sessions.close(); this.sessionCookie = null; this.state = 'disabled'; }
    })(); return this.closePromise;
  }
}
