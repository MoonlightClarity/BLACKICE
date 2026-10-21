import { EventEmitter } from 'node:events';
import { discoverFirefoxProfile, startFirefoxSession } from '../lib/firefox-session.mjs';
import { createFirefoxDriver, closeOwnedFirefoxSession } from './firefox-driver.mjs';

const fail = message => new Error(message);

// Owns only the Firefox process it starts, using Firefox's normal profile lock.
// Status is metadata-only. No credential stores are read or copied.
export class LazyFirefoxDriver extends EventEmitter {
  constructor({ discover = discoverFirefoxProfile, start = startFirefoxSession, createDriver = createFirefoxDriver, closeSession = closeOwnedFirefoxSession } = {}) {
    super(); this.discover = discover; this.start = start; this.createDriver = createDriver; this.closeSession = closeSession;
    this.profile = { available: false, reason: 'Firefox has not been checked.' }; this.closed = false;
  }
  async init() { this.profile = await this.discover(); return this; }
  status() {
    const current = this.driver?.status() || { tabs: [], downloads: [], activeTab: null };
    const running = this.launched?.running ?? !!this.launched?.started;
    return { ...current, firefox: { available: this.profile.available, connected: this.driver?.connected === true && !this.driver.closed, running, recoveryRequired: running && Boolean(this.recoveryError || this.launched?.recoveryRequired), mode: 'existing-profile-in-place', profileName: this.profile.profileName, reason: this.recoveryError || (this.driver ? 'Firefox is running in the background. Disconnect to reopen it normally.' : running ? this.launched.reason : this.profile.reason), physicalInput: false, authentication: 'browser-owned' } };
  }
  async ensure(signal) {
    if (this.closed || this.disconnecting || this.closing) throw fail('Firefox workspace is closing. Wait before opening another page.');
    if (this.driver?.connected === true && !this.driver.closed) return this.driver;
    this.connecting ||= (async () => {
      let launched = this.releasedLaunch !== this.launched && (this.launched?.running ?? this.launched?.started) ? this.launched : null;
      if (launched && !launched.ready) await launched.waitForReady?.({signal});
      if (!launched) { launched = await this.start({ port: 0, signal }); this.launched = launched; }
      if (!launched.started || !launched.ready || !launched.endpoint) { this.recoveryError = launched.reason; throw fail(launched.reason || 'Firefox did not become ready.'); }
      let driver;
      try { driver = await this.createDriver({ endpoint: launched.endpoint, signal, profileName: launched.profileName, profileSource: launched.profileSource, onClose: async () => {
        const exit = await launched.stop?.(); if (exit && !exit.closed) throw fail('Firefox has not confirmed its profile was saved and closed.');
        if (exit?.closed) this.releasedLaunch = launched;
      } }); } catch (error) { this.recoveryError = 'Firefox connection did not complete. Disconnect to release its profile, or retry Open to reconnect.'; this.emit('changed'); throw error; }
      driver.on?.('changed', () => this.emit('changed')); this.driver = driver;
      if (signal?.aborted || this.disconnecting || this.closing) { await driver.close(); this.driver = null; this.launched = null; throw fail('Firefox startup was cancelled.'); }
      this.recoveryError = null; this.emit('changed'); return driver;
    })().finally(() => { this.connecting = null; });
    return this.connecting;
  }
  async perform(args, { signal } = {}) {
    if (args.action === 'tabs' || args.action === 'downloads') return this.status();
    if (this.driver?.connected !== true && args.action !== 'open') throw fail('Open a URL with browser:"firefox" before using Firefox controls.');
    return (await this.ensure(signal)).perform(args, { signal });
  }
  show() { throw fail('This Firefox session stays in the background. Disconnect it before opening Firefox normally.'); }
  disconnect() {
    if (this.disconnecting) return this.disconnecting;
    this.disconnecting = (async () => {
      if (this.connecting) { try { await this.connecting; } catch {} }
      const driver = this.driver;
      if (driver && !driver.closed) await driver.close();
      if (this.releasedLaunch !== this.launched && (this.launched?.running ?? this.launched?.started)) {
        const exit = await this.launched.stop?.({ closeBrowser: this.closeSession });
        if (!exit?.closed) throw fail(exit?.reason || 'Firefox has not confirmed a clean exit. Its profile remains in use. Retry Disconnect.');
      }
      this.driver = null; this.launched = null; this.recoveryError = null; this.emit('changed'); return this.status();
    })().catch(error => { this.recoveryError = error.message; this.emit('changed'); throw error; }).finally(() => { this.disconnecting = null; });
    return this.disconnecting;
  }
  close() { if (this.closed) return Promise.resolve(); if (this.closing) return this.closing; this.closing = this.disconnect().then(() => { this.closed = true; }).finally(() => { this.closing = null; }); return this.closing; }
}
