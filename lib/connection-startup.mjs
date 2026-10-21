const failure = (message, code = 'CONNECTION_STARTUP_FAILED') => Object.assign(new Error(message), { code, status: 409 });
const copy = value => structuredClone(value);
const unavailable = detail => ({ ready: false, canEnable: false, detail });

/** Explicit, coalesced startup setup. Reading this manager never changes the OS. */
export class ConnectionStartup {
  constructor({ platform = process.platform, tailscale, blackice, now = Date.now, cacheMs = 30000 } = {}) {
    this.platform = platform; this.tailscale = tailscale; this.blackice = blackice; this.now = now; this.cacheMs = cacheMs;
    this.cached = null; this.cachedAt = 0; this.reading = null; this.pending = null;
  }
  get busy() { return Boolean(this.pending); }
  _view(state) { return { ...copy(state), busy: this.busy, canEnable: !this.busy && state.canEnable }; }
  async _read() {
    if (this.platform !== 'win32') return { available: false, ready: false, canEnable: false, checkedAt: new Date(this.now()).toISOString(), checks: [], detail: 'Automatic connection startup is currently available in the Windows desktop app.' };
    const [tailscale, blackice] = await Promise.all([
      Promise.resolve().then(() => this.tailscale.inspect()).catch(() => unavailable('Tailscale startup could not be checked. Refresh and try again.')),
      Promise.resolve().then(() => this.blackice.inspect()).catch(() => unavailable('BLACKICE sign-in startup could not be checked. Existing startup settings were left unchanged.')),
    ]);
    const checks = [
      { key: 'tailscale', label: 'Tailscale at Windows startup', ok: tailscale.ready === true, canEnable: tailscale.canEnable === true, detail: String(tailscale.detail || '') },
      { key: 'blackice', label: 'BLACKICE at Windows sign-in', ok: blackice.ready === true, canEnable: blackice.canEnable === true, detail: String(blackice.detail || '') },
    ];
    const repairable = checks.filter(check => !check.ok && check.canEnable);
    const actionLabel = repairable.length === 1 ? repairable[0].key === 'tailscale' ? 'Enable Tailscale at Windows startup' : 'Enable BLACKICE at Windows sign-in' : 'Enable automatic connection startup';
    return { available: true, ready: checks.every(check => check.ok), canEnable: repairable.length > 0, checkedAt: new Date(this.now()).toISOString(), checks, actionLabel, detail: 'Tailscale can stay connected before sign-in. BLACKICE starts in the background when you sign in to this Windows account and uses this same profile. Keep the computer awake for scheduled work.' };
  }
  async snapshot({ refresh = false } = {}) {
    if (this.busy) return this._view(this.cached || { available: this.platform === 'win32', ready: false, canEnable: false, checkedAt: null, checks: [], detail: 'Automatic startup is being checked. The current setup action is still running.' });
    if (!refresh && this.cached && this.now() - this.cachedAt < this.cacheMs) return this._view(this.cached);
    if (!this.reading) this.reading = this._read().then(state => { this.cached = state; this.cachedAt = this.now(); return state; }).finally(() => { this.reading = null; });
    return this._view(await this.reading);
  }
  enable() {
    if (this.pending) return this.pending;
    this.pending = Promise.resolve().then(async () => {
      // Refresh immediately before any change, even if the UI used a cached check.
      if (this.reading) await this.reading;
      let state = await this._read(); this.cached = state; this.cachedAt = this.now();
      if (state.ready) return state;
      if (!state.canEnable) throw failure('Automatic startup needs attention. Review the startup checks before trying again.', 'CONNECTION_STARTUP_UNAVAILABLE');
      const tailscaleCheck = state.checks.find(check => check.key === 'tailscale');
      if (!tailscaleCheck.ok && tailscaleCheck.canEnable) {
        await this.tailscale.enable();
        const checked = await this.tailscale.inspect();
        if (checked.ready !== true) throw failure('Tailscale did not confirm automatic service startup and unattended mode. BLACKICE sign-in startup was left unchanged.', 'CONNECTION_STARTUP_NOT_VERIFIED');
      }
      // Recheck after the native action: another local setup may have changed it.
      const blackice = await this.blackice.inspect();
      if (!blackice.ready && blackice.canEnable) {
        await this.blackice.enable();
        if ((await this.blackice.inspect()).ready !== true) throw failure('BLACKICE sign-in startup could not be verified. Review its startup check.', 'CONNECTION_STARTUP_NOT_VERIFIED');
      }
      state = await this._read(); this.cached = state; this.cachedAt = this.now();
      return state;
    }).catch(async error => {
      this.cached = await this._read(); this.cachedAt = this.now();
      // Native diagnostics are deliberately not returned: they can contain paths,
      // account names or CLI output. Only errors from our own narrow contract pass.
      if (String(error?.code || '').startsWith('CONNECTION_STARTUP_')) throw error;
      throw failure('Automatic startup was not fully verified. Some startup settings may have changed; review the refreshed checks.');
    }).finally(() => { this.pending = null; });
    return this.pending.then(state => this._view(state));
  }
}
