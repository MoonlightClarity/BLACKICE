import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
export const passwordManagerURL = new URL('./password-manager/index.html', import.meta.url).href;
export const passwordManagerPreload = fileURLToPath(new URL('./password-manager/preload.cjs', import.meta.url));
const fail = message => Object.assign(new Error(message), { code: 'PASSWORD_MANAGER_UNAVAILABLE' });
const ownerKey = owner => JSON.stringify([owner?.taskId || null, owner?.nodeId || null]);
export function managerFillTarget(snapshot, credential) {
  if (new URL(snapshot.url).origin !== credential.origin) throw fail('This login belongs to another site. Open its site before using it.');
  const candidates = (snapshot.frames || []).filter(frame => {
    try { return new URL(frame.url).origin === credential.origin && frame.elements?.some(e => e.type === 'password' && !e.disabled); } catch { return false; }
  });
  if (candidates.length !== 1) throw fail('Choose the intended password fields with the browser credential tool; this page has no unique password form.');
  const elements = candidates[0].elements.filter(e => !e.disabled);
  const passwords = elements.filter(e => e.type === 'password');
  if (passwords.length > 2 || passwords.length === 2 && !/confirm|repeat|re-enter|again/i.test(passwords[1].name || '')) throw fail('Choose the intended password fields with the browser credential tool; several password fields are present.');
  const usernames = elements.filter(e => e.tag === 'input' && (e.type === 'email' || ['text',''].includes(e.type || '') && /\b(user(name)?|e-?mail|login)\b/i.test(e.name)));
  if (usernames.length > 1) throw fail('Choose the intended username field with the browser credential tool.');
  return { browser: 'relay', tabId: snapshot.tabId, expectedUrl: snapshot.url, expectedDocumentId: snapshot.documentId, origin: credential.origin,
    credentialId: credential.credentialId, revision: credential.revision, passwordRef: passwords[0].ref,
    ...(passwords[1] ? { confirmationRef: passwords[1].ref } : {}), ...(usernames[0] ? { usernameRef: usernames[0].ref } : {}) };
}
export class NativePasswordManager {
  constructor(driver, { vault, browser }) { this.driver = driver; this.vault = vault; this.browser = browser; this.contexts = new Set(); }
  status() { return { available: !!this.vault, name: 'BLACKICE Passwords', local: true }; }
  authorize(context) {
    const target = this.driver.tabs.get(context.targetId);
    const manager = context.managerId ? this.driver.tabs.get(context.managerId) : null;
    if (this.driver.closed || !this.contexts.has(context) || context.managerId && (!manager || ownerKey(manager.owner) !== context.ownerKey) || !target || target.purpose === 'chat-mode' || ownerKey(target.owner) !== context.ownerKey)
      throw fail('The target page changed ownership or closed. Open Passwords again from the intended page.');
    this.driver.ownerAdmission?.(context.owner);
    return target;
  }
  async open(target, owner) {
    for (const saved of this.contexts) if (saved.managerId && !this.driver.tabs.has(saved.managerId)) this.contexts.delete(saved);
    if (!this.vault) throw fail('The local password manager is unavailable. Ordinary browsing remains available.');
    if (target.passwordManagerContext) { this.authorize(target.passwordManagerContext); return target; }
    if (target.purpose === 'chat-mode') throw fail('Open Passwords from an ordinary browser page.');
    const context = { targetId: target.id, owner: owner || null, ownerKey: ownerKey(target.owner),
      ownerId: 'manager_' + createHash('sha256').update(ownerKey(owner)).digest('hex'), managerId: null };
    this.contexts.add(context);
    try {
      const tab = this.driver.newTab(passwordManagerURL, { owner, parentTabId: target.id, title: 'BLACKICE Passwords', passwordManagerContext: context });
      context.managerId = tab.id;
      await tab.loading;
      return tab;
    } catch (error) { this.contexts.delete(context); throw error; }
  }
  attach(tab, wc) {
    const context = tab.passwordManagerContext;
    if (!this.contexts.has(context)) throw fail('The password-manager page was not opened by this browser.');
    wc.ipc.handle('blackice:password-manager', async (event, request) => {
      try {
        if (tab.window?.webContents !== wc || event.senderFrame !== wc.mainFrame || event.senderFrame.url !== passwordManagerURL || wc.getURL() !== passwordManagerURL)
          throw fail('Password operations are available only in the local Passwords page.');
        this.authorize(context);
        return { ok: true, value: await this.perform(context, request) };
      } catch (error) {
        return { ok: false, code: typeof error.code === 'string' ? error.code : 'PASSWORD_MANAGER_FAILED',
          error: /^CREDENTIAL_|^PASSWORD_MANAGER_/.test(error.code || '') ? error.message : 'Password operation did not complete. Inspect the saved list before retrying.' };
      }
    });
    // Context belongs to the tab, not its disposable renderer. IPC is destroyed with the renderer.
  }
  async perform(context, request) {
    this.authorize(context);
    if (!request || typeof request !== 'object' || Array.isArray(request)) throw fail('Use a password-manager operation.');
    const { action, ...input } = request;
    const allowed = {
      status: ['origin'], generate: ['origin','username','label','length','requestId'],
      save: ['origin','username','label','password','credentialId','revision','requestId','expectedRevision'],
      fill: ['origin','credentialId','revision'],
    };
    if (!allowed[action] || Object.keys(input).some(key => !allowed[action].includes(key))) throw fail('Use only the declared password-manager fields.');
    const beforeCommit = async () => { this.authorize(context); };
    if (action === 'status') {
      const status = await this.vault.status();
      const target = this.authorize(context); let targetOrigin = '';
      try { const u = new URL(this.driver.tabURL(target)); if (u.protocol === 'https:') targetOrigin = u.origin; } catch {}
      const origin = input.origin || targetOrigin;
      return { available: status.available, healthy: status.healthy, vaultRevision: status.revision,
        targetTabId: target.id, targetOrigin, origin, entries: status.available && origin ? await this.vault.list({ origin }) : [] };
    }
    if (action === 'generate') return this.vault.generate(input, { ownerId: context.ownerId, beforeCommit });
    if (action === 'save') {
      const { expectedRevision, ...record } = input;
      return this.vault.save(record, { source: context.owner ? 'agent' : 'user', ownerId: context.ownerId, expectedRevision, beforeCommit });
    }
    const target = this.authorize(context);
    const entries = await this.vault.list({ origin: input.origin });
    const entry = entries.find(e => e.credentialId === input.credentialId && e.revision === input.revision);
    if (!entry) throw fail('The saved login changed. Refresh the saved list.');
    const snapshot = await this.browser.perform({ action: 'snapshot', browser: 'relay', tabId: target.id }, { source: context.owner ? 'agent' : 'user', ...(context.owner ? { owner: context.owner } : {}) });
    this.authorize(context);
    const args = managerFillTarget(snapshot, entry);
    const result = await this.browser.fillCredential(args, { vault: this.vault, source: 'agent', owner: context.owner, beforeDispatch: beforeCommit });
    return { ...result, message: 'Filled the target page. No form was submitted.' };
  }
}
