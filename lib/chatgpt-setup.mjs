import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { writeRemoteJson } from './remote-access-auth.mjs';

export const CHATGPT_SETUP_URL = 'https://chatgpt.com/plugins';
const fail = (message, status = 409) => Object.assign(new Error(message), { status, code: 'CHATGPT_SETUP_INCOMPLETE' });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, allowed) => object(value) && Object.keys(value).every(key => allowed.includes(key));
const time = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const noncePattern = /^blackice-connect-[a-f0-9-]{36}$/;
const fresh = serverUrl => ({ schema: 1, serverUrl, nonce: `blackice-connect-${randomUUID()}`, received: null, confirmedAt: null });
const prompt = nonce => `Use BLACKICE's blackice_direct_status tool with nonce "${nonce}". Return the exact nonce, app, mode, available, connectionId, grantedScopes, modelStarted and providerTurns from the actual tool result. If BLACKICE tools are unavailable, say so. Do not use another connector.`;

/** Optional onboarding evidence. Never stores OAuth credentials or replaces authorization. */
export class ChatGPTSetup {
  constructor({ dataDir, connector, remoteAccess, isClosing = () => false, fetchImpl = fetch, now = Date.now, timeoutMs = 10000 }) {
    Object.assign(this, { connector, remoteAccess, isClosing, fetchImpl, now, timeoutMs });
    this.file = path.join(dataDir, 'chatgpt-setup.json');
    this.value = null; this.error = ''; this.recoveryNotice = ''; this.diagnostics = null;
    this.tail = Promise.resolve(); this.closed = false; this.checking = null; this.controller = null;
  }
  async init() {
    try {
      const stat = await fs.stat(this.file);
      if (!stat.isFile() || stat.size > 16384) throw Error('Invalid setup history.');
      const value = JSON.parse(await fs.readFile(this.file, 'utf8'));
      const validUrl = typeof value?.serverUrl === 'string' && this.validEndpoint(value.serverUrl);
      const receipt = value?.received;
      if (!keys(value, ['schema', 'serverUrl', 'nonce', 'received', 'confirmedAt']) || value.schema !== 1 || !validUrl || !noncePattern.test(value.nonce || '') ||
        receipt !== null && (!keys(receipt, ['clientId', 'at', 'tool']) || typeof receipt.clientId !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(receipt.clientId) || !time(receipt.at) || receipt.tool !== 'blackice_direct_status') ||
        value.confirmedAt !== null && (!receipt || !time(value.confirmedAt))) throw Error('Invalid setup history.');
      this.value = value;
    } catch (error) {
      if (error.code !== 'ENOENT') {
        // This is disposable guidance, not an authorization store. Preserve damaged
        // history before regenerating it; never repair or replace OAuth state here.
        try {
          await fs.rename(this.file, `${this.file}.unreadable-${randomUUID()}`);
          this.recoveryNotice = 'The setup guide was reset after unreadable history was preserved. Existing ChatGPT permissions were kept.';
        } catch { this.error = 'Setup history could not be read or preserved. Check profile storage, then restart BLACKICE.'; }
      }
    }
    return this;
  }
  validEndpoint(value) {
    try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && url.pathname === '/mcp/chatgpt' && !url.search && !url.hash && value === url.origin + '/mcp/chatgpt'; }
    catch { return false; }
  }
  enqueue(operation) {
    if (this.closed || this.isClosing()) return Promise.reject(fail('BLACKICE is closing for maintenance.', 503));
    const next = this.tail.catch(() => {}).then(() => {
      if (this.closed || this.isClosing()) throw fail('BLACKICE is closing for maintenance.', 503);
      return operation();
    });
    this.tail = next; return next;
  }
  async save(value) {
    try { await writeRemoteJson(this.file, value); this.value = value; }
    catch { throw fail('The setup guide could not be saved. Check profile storage and try again.', 503); }
  }
  async observe(current) {
    if (this.error || !this.validEndpoint(current.endpoint)) return;
    let next = this.value;
    if (!next || next.serverUrl !== current.endpoint) { next = fresh(current.endpoint); this.diagnostics = null; }
    const grants = current.oauth?.grants || [];
    if (next.received && !grants.some(grant => grant.id === next.received.clientId)) next = fresh(current.endpoint);
    const receipt = current.lastAuthenticatedToolCall;
    if (!next.received && receipt?.tool === 'blackice_direct_status' && receipt.nonce === next.nonce && time(receipt.at) && grants.some(grant => grant.id === receipt.clientId)) {
      next = { ...next, received: { clientId: receipt.clientId, at: receipt.at, tool: receipt.tool } };
    }
    if (next !== this.value) await this.save(next);
  }
  async build() {
    const current = await this.connector.status(), remote = this.remoteAccess?.status() || {};
    if (!this.closed && !this.isClosing()) await this.observe(current);
    const owned = this.validEndpoint(current.endpoint) && typeof remote.url === 'string' && current.endpoint === remote.url + '/mcp/chatgpt';
    const checks = [
      { key: 'storage', label: 'BLACKICE storage', ok: current.available === true && current.oauth?.healthy !== false && !this.error, detail: this.error || current.error || 'Authorization and action storage must be available.' },
      { key: 'https', label: 'Public HTTPS', ok: remote.enabled === true && remote.mode === 'public' && remote.state === 'ready', detail: remote.error?.message || 'Keep Tailscale online and publish the authenticated HTTPS route.' },
      { key: 'address', label: 'This computer’s address', ok: owned, detail: 'The connector address must match BLACKICE’s own HTTPS route.' },
      { key: 'connector', label: 'ChatGPT access', ok: current.enabled === true && current.oauth?.ready === true, detail: 'Enable the ChatGPT connector on this computer.' },
    ];
    const ready = checks.every(check => check.ok), requests = current.oauth?.requests || [], grants = current.oauth?.grants || [];
    const verification = this.value && this.value.serverUrl === current.endpoint ? {
      nonce: this.value.nonce, prompt: prompt(this.value.nonce),
      ...(this.value.received ? { receivedAt: this.value.received.at, tool: this.value.received.tool, clientId: this.value.received.clientId } : {}),
      ...(this.value.confirmedAt ? { confirmedAt: this.value.confirmedAt } : {}),
    } : null;
    const diagnostics = ready && this.diagnostics?.serverUrl === current.endpoint ? this.diagnostics : null;
    return { ready, stage: !ready ? 'prepare' : requests.length ? 'approve' : verification?.confirmedAt ? 'confirmed' : verification?.receivedAt ? 'received' : grants.length ? 'test' : 'register',
      serverUrl: owned ? current.endpoint : null, chatGPTUrl: CHATGPT_SETUP_URL, checks,
      verification, verificationPrompt: verification?.prompt || null, diagnostics,
      ...(this.error ? { error: this.error } : {}), ...(this.recoveryNotice ? { recoveryNotice: this.recoveryNotice } : {}) };
  }
  snapshot() {
    // Ordinary local reads remain available during maintenance and shutdown.
    const next = this.tail.catch(() => {}).then(() => this.build()); this.tail = next; return next;
  }
  record(receipt) {
    if (receipt?.tool !== 'blackice_direct_status' || !this.value || receipt.nonce !== this.value.nonce) return Promise.resolve();
    return this.enqueue(async () => {
      const current = await this.connector.status();
      await this.observe({ ...current, lastAuthenticatedToolCall: receipt });
    });
  }
  async readJson(url, options, signal) {
    const response = await this.fetchImpl(url, { ...options, redirect: 'error', credentials: 'omit', signal });
    if (!response.ok || response.url && response.url !== url || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') || '') || Number(response.headers.get('content-length') || 0) > 65536) throw Error('Unexpected response.');
    const reader = response.body?.getReader(); if (!reader) throw Error('Missing response.');
    try {
      let size = 0; const chunks = [];
      while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > 65536) throw Error('Response too large.'); chunks.push(Buffer.from(value)); }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } finally { await reader.cancel().catch(() => {}); }
  }
  check() {
    if (this.checking) return this.checking;
    const pending = this.enqueue(async () => {
      const before = await this.build();
      if (!before.ready) throw fail('Prepare this computer before checking its public connection.');
      const endpoint = before.serverUrl, origin = new URL(endpoint).origin, controller = new AbortController(); this.controller = controller;
      const timer = setTimeout(() => controller.abort(), this.timeoutMs); timer.unref?.();
      const run = async (key, label, operation) => {
        try { if (!await operation()) throw Error(); return { key, label, ok: true, detail: 'Passed from this computer.' }; }
        catch { return { key, label, ok: false, detail: 'Could not verify this check. Keep BLACKICE and Tailscale running, then retry. Network or account policy may block access.' }; }
      };
      try {
        const headers = { Accept: 'application/json' };
        const checks = await Promise.all([
          run('resource', 'Public connector discovery', async () => {
            const value = await this.readJson(origin + '/.well-known/oauth-protected-resource/mcp/chatgpt', { headers }, controller.signal);
            return value.resource === endpoint && Array.isArray(value.authorization_servers) && value.authorization_servers.length === 1 && value.authorization_servers[0] === origin;
          }),
          run('oauth', 'OAuth and client discovery', async () => {
            const value = await this.readJson(origin + '/.well-known/oauth-authorization-server', { headers }, controller.signal);
            return value.issuer === origin && value.authorization_endpoint === origin + '/chatgpt/oauth/authorize' && value.token_endpoint === origin + '/chatgpt/oauth/token' && value.client_id_metadata_document_supported === true && value.code_challenge_methods_supported?.includes('S256') && value.token_endpoint_auth_methods_supported?.includes('none');
          }),
          run('tools', 'BLACKICE tools', async () => {
            const value = await this.readJson(endpoint, { method: 'POST', headers: { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', 'MCP-Protocol-Version': '2025-11-25' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'blackice-setup-catalog', method: 'tools/list', params: {} }) }, controller.signal);
            return value.id === 'blackice-setup-catalog' && value.result?.tools?.some(tool => tool.name === 'blackice_direct_status' && tool.securitySchemes?.some(scheme => scheme.type === 'oauth2' && scheme.scopes?.includes('read')));
          }),
        ]);
        const after = await this.build();
        if (!after.ready || after.serverUrl !== endpoint) throw fail('The BLACKICE address changed during the check. Prepare the connection again.');
        this.diagnostics = { serverUrl: endpoint, checkedAt: new Date(this.now()).toISOString(), ok: checks.every(check => check.ok), checks,
          limitation: 'These checks run from this computer. Only a matching result shown in ChatGPT confirms that conversation’s connection.' };
        return this.build();
      } finally { clearTimeout(timer); if (this.controller === controller) this.controller = null; }
    });
    this.checking = pending;
    const settled = () => { if (this.checking === pending) this.checking = null; };
    pending.then(settled, settled); return pending;
  }
  confirm(nonce) {
    return this.enqueue(async () => {
      const current = await this.build();
      if (!current.ready || typeof nonce !== 'string' || nonce !== current.verification?.nonce || !current.verification.receivedAt) throw fail('Run the matching BLACKICE status check in ChatGPT before confirming its result.');
      if (!this.value.confirmedAt) await this.save({ ...this.value, confirmedAt: new Date(this.now()).toISOString() });
      return this.build();
    });
  }
  async close() {
    this.closed = true; this.controller?.abort(); await this.tail.catch(() => {});
  }
}
