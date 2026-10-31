const copy = value => structuredClone(value);
const known = value => typeof value === 'number' && Number.isInteger(value) && value >= 0;
const blocked = policy => policy?.exists === true && (policy.kind !== 'DWord' || policy.value !== 0);
const noPolicy = policy => policy?.exists === false || policy?.exists === true && policy.kind === 'DWord' && policy.value === 0;
const fail = (message, code) => Object.assign(new Error(message), { status: 409, code });
const ACTION = 'Prevent idle interruptions';

export function idleInterruptionState(raw, now = Date.now()) {
  if (raw?.schemaVersion !== 1 || !raw.power || !raw.screenSaver) throw fail('Windows interruption settings could not be read.', 'IDLE_INTERRUPTION_READ_FAILED');
  const checks = [];
  const powerCheck = (key, label, keys) => {
    const values = keys.flatMap(name => ['ac','dc'].map(mode => ({ value: raw.power[name]?.[mode], policy: raw.power[name]?.[`${mode}Policy`] })));
    const ok = values.every(item => known(item.value) && item.value === 0 && noPolicy(item.policy));
    const managed = values.some(item => blocked(item.policy));
    const canEnable = values.some(item => known(item.value) && item.value !== 0 && noPolicy(item.policy));
    checks.push({ key, label, ok, managed, canEnable, detail: ok ? 'Off on power and battery.' : managed ? 'Windows policy controls one or more of these settings; those values will be preserved.' : values.some(item => !known(item.value)) ? 'Some Windows values could not be verified.' : 'Setup can turn this off on power and battery.' });
  };
  powerCheck('sleep', 'Automatic sleep and hibernate timers', ['sleep','unattended','hibernate']);
  powerCheck('display', 'Display turns off while idle', ['display']);
  const hibernateManaged = ['ac','dc'].some(mode => blocked(raw.power.hibernate?.[`${mode}Policy`]));
  checks.push({ key: 'hibernation', label: 'System hibernation', ok: raw.hibernationEnabled === false, managed: raw.hibernationEnabled !== false && hibernateManaged, canEnable: raw.hibernationEnabled === true && !hibernateManaged, detail: raw.hibernationEnabled === false ? 'Disabled. Windows Fast Startup is also unavailable while hibernation is off.' : hibernateManaged ? 'Windows policy requires a hibernate timer; hibernation will be preserved.' : raw.hibernationEnabled === true ? 'Setup can disable hibernation and Windows Fast Startup. Windows administrator approval may be needed.' : 'The Windows hibernation state could not be verified.' });
  if (raw.lidPresent === true) powerCheck('lid', 'Sleep when the lid closes', ['lid']);
  else checks.push({ key: 'lid', label: 'Sleep when the lid closes', ok: raw.lidPresent === false, managed: false, canEnable: false, detail: raw.lidPresent === false ? 'No lid switch reported by Windows.' : 'The lid switch could not be checked.' });
  powerCheck('wakeSignIn', 'Sign-in after waking', ['wake']);
  const policies = Object.values(raw.screenSaver.policies || {});
  const screenPoliciesKnown = policies.length === 6 && policies.every(policy => typeof policy?.exists === 'boolean');
  const screenManaged = policies.some(policy => policy?.exists === true && String(policy.value) !== '0');
  const screenKnown = raw.screenSaver.active === 0 || raw.screenSaver.active === 1;
  const dynamic = raw.dynamicLock;
  const dynamicKnown = dynamic?.exists === false || dynamic?.kind === 'DWord' && [0,1].includes(dynamic.value);
  const dynamicOff = dynamic?.exists === false || dynamicKnown && dynamic.value === 0;
  const inactivity = raw.inactivity;
  const inactivityOff = inactivity?.exists === false || inactivity?.kind === 'DWord' && inactivity.value === 0;
  const localInactivityNeeded = inactivity?.exists === true && inactivity.kind === 'DWord' && known(inactivity.value) && inactivity.value > 0;
  const inactivityExternallyManaged = localInactivityNeeded && raw.inactivitySource?.external === true;
  const localInactivityCanEnable = localInactivityNeeded && raw.inactivitySource?.external !== true;
  const restartRequired = typeof raw.restartRequired === 'boolean' ? raw.restartRequired : null;
  const mdmLockOff = raw.mdmLock?.exists === false || raw.mdmLock?.kind === 'DWord' && raw.mdmLock.value === 0;
  const mdmInactivityOff = raw.mdmInactivity?.exists === false || raw.mdmInactivity?.kind === 'DWord' && raw.mdmInactivity.value === 0;
  const presenceOff = raw.presence?.known === true && raw.presence.lock === false && raw.presence.dim === false;
  const idleManaged = inactivityExternallyManaged || blocked(raw.mdmLock) || blocked(raw.mdmInactivity) || raw.screenSaver.active !== 0 && screenManaged || !presenceOff && raw.presencePolicy === true;
  const idleOk = raw.screenSaver.active === 0 && screenPoliciesKnown && dynamicOff && presenceOff && inactivityOff && mdmLockOff && mdmInactivityOff && raw.restartRequired === false;
  const idleCanEnable = localInactivityCanEnable || screenKnown && screenPoliciesKnown && raw.screenSaver.active !== 0 && !screenManaged || dynamicKnown && !dynamicOff || raw.presence?.known === true && !presenceOff && raw.presencePolicy === false;
  const remaining = [];
  if (!screenPoliciesKnown) remaining.push('unverified screen-saver policy');
  if (raw.screenSaver.active !== 0) remaining.push(screenKnown ? 'screen saver' : 'unverified screen saver');
  if (!dynamicOff) remaining.push(dynamicKnown ? 'Dynamic Lock' : 'unverified Dynamic Lock');
  if (!presenceOff) remaining.push(raw.presence?.known ? 'presence sensing' : 'unverified presence sensing');
  if (!presenceOff && typeof raw.presencePolicy !== 'boolean') remaining.push('unverified presence policy');
  if (!inactivityOff) remaining.push(inactivityExternallyManaged ? raw.inactivitySource?.reason === 'last-administrative-rsop' ? 'inactivity limit (external enforcement verified by the last administrator check)' : 'externally enforced inactivity limit' : localInactivityNeeded ? raw.inactivitySource?.external === false ? 'local inactivity limit (setup can disable it)' : 'inactivity limit (setup can check its policy source)' : 'unverified Windows inactivity limit');
  if (!mdmLockOff || !mdmInactivityOff) remaining.push('Windows device-management inactivity policy');
  if (restartRequired) remaining.push('Windows restart needed to apply the saved local inactivity change');
  else if (raw.restartRequired !== false) remaining.push('unverified restart status for a prior inactivity change');
  checks.push({ key: 'idleLock', label: 'Locking when idle or away', ok: idleOk, managed: idleManaged, canEnable: Boolean(idleCanEnable), detail: idleOk ? 'Screen-saver, Dynamic Lock, presence locking and Windows inactivity locking are off.' : `Remaining checks: ${remaining.join(', ')}.${idleManaged ? ' Windows policy values will be preserved.' : ''}` });
  const ready = checks.every(check => check.ok);
  const canEnable = checks.some(check => !check.ok && check.canEnable);
  return { available: true, ready, state: ready ? 'enabled' : checks.some(check => !check.ok && check.managed) ? 'managed' : checks.some(check => check.ok || check.canEnable) ? 'partial' : 'unknown', canEnable, busy: false, restartRequired, checkedAt: new Date(now).toISOString(), checks, actionLabel: ACTION, windowsPromptMayAppear: canEnable && (localInactivityCanEnable || checks.some(check => ['sleep','display','hibernation','lid','wakeSignIn'].includes(check.key) && check.canEnable)), detail: ready ? 'This computer is configured to stay available when idle. Manual locking and your account password still work.' : restartRequired ? 'The local inactivity limit is disabled in settings. Windows needs a restart to apply that change; setup will not restart it for you.' : 'Setup can prevent automatic sleep, display-off and idle locking. Manual locking and your account password stay available.' };
}

/** Reads never mutate Windows. Only the explicit local setup action calls apply. */
export class IdleInterruptions {
  constructor({ platform = process.platform, inspect, apply, now = Date.now, cacheMs = 15000 } = {}) {
    this.platform = platform; this.inspect = inspect; this.apply = apply; this.now = now; this.cacheMs = cacheMs;
    this.cached = null; this.cachedAt = 0; this.reading = null; this.pending = null; this.lastResult = null; this.backupPath = null;
  }
  get busy() { return Boolean(this.pending); }
  _view(state) { return { ...copy(state), busy: this.busy, canEnable: !this.busy && state.canEnable, ...(this.lastResult ? { lastResult: copy(this.lastResult) } : {}), ...(this.backupPath ? { backupPath: this.backupPath } : {}) }; }
  _unavailable(detail, state = 'unknown') { return { available: this.platform === 'win32', ready: false, state, canEnable: false, checks: [], checkedAt: new Date(this.now()).toISOString(), actionLabel: ACTION, windowsPromptMayAppear: false, detail }; }
  async _read() {
    if (this.platform !== 'win32' || !this.inspect) return this._unavailable('Open BLACKICE desktop on Windows to prevent idle interruptions.', 'unavailable');
    try { return idleInterruptionState(await this.inspect(), this.now()); }
    catch { return this._unavailable('Windows interruption settings could not be verified. Check status again or review Windows Settings.'); }
  }
  async snapshot({ refresh = false } = {}) {
    if (this.busy) return this._view(this.cached || this._unavailable('Checking Windows interruption settings.'));
    if (!refresh && this.cached && this.now() - this.cachedAt < this.cacheMs) return this._view(this.cached);
    if (!this.reading) this.reading = this._read().then(value => { this.cached = value; this.cachedAt = this.now(); return value; }).finally(() => { this.reading = null; });
    return this._view(await this.reading);
  }
  enable() {
    if (this.pending) return this.pending;
    this.pending = Promise.resolve().then(async () => {
      if (this.reading) await this.reading;
      this.cached = await this._read(); this.cachedAt = this.now();
      if (this.cached.ready) { this.lastResult = { outcome: 'enabled', message: 'Already enabled. No Windows settings were changed.' }; return; }
      if (!this.cached.canEnable || typeof this.apply !== 'function') throw fail('Review the Windows checks before trying setup again.', 'IDLE_INTERRUPTION_UNAVAILABLE');
      let result;
      try { result = await this.apply(); }
      catch { result = { failed: true }; }
      if (typeof result?.backupPath === 'string') this.backupPath = result.backupPath;
      // Verification, rather than process exit, is the authority for readiness.
      this.cached = await this._read(); this.cachedAt = this.now();
      this.lastResult = this.cached.ready ? { outcome: 'enabled', message: 'Idle interruption prevention is enabled.' }
        : result?.cancelled ? { outcome: 'cancelled', message: 'Windows administrator approval was cancelled. Some settings may have changed; review the checks.' }
        : result?.failed ? { outcome: 'failed', message: result?.planChanged ? 'The power plan changed during setup. Check status and try again.' : result?.sourceUnknown ? 'Windows could not verify whether the inactivity limit is externally enforced. That setting was left unchanged.' : 'Setup could not verify every change. Review the remaining checks.' }
        : { outcome: 'partial', message: this.cached.restartRequired ? 'The local inactivity change was saved. Windows needs a restart before it can be verified active.' : result?.externalManaged ? 'Windows verified external management of the inactivity limit. That setting was preserved.' : 'Some interruption settings remain. Review the checks below.' };
    }).finally(() => { this.pending = null; });
    this.pending = this.pending.then(() => this._view(this.cached));
    return this.pending;
  }
}
