import { promises as fs } from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { processPresence } from './remote-availability.mjs';

const fail = message => Object.assign(Error(message), { code: 'REMOTE_AVAILABILITY_UNAVAILABLE', status: 503 });
const markerName = 'remote-availability.json';
const validPort = port => Number.isSafeInteger(port) && port >= 1024 && port <= 65535;

function validMarker(value, origin) {
  return value?.schema === 1 && value.origin === origin && typeof value.id === 'string'
    && /^[A-Za-z0-9_-]{43}$/.test(value.token || '') && validPort(value.port) && validPort(value.controlPort)
    && Number.isSafeInteger(value.pid) && value.pid > 0;
}

/** The local control port is separate from the HTTPS proxy; it is never a Tailscale target. */
export function availabilityControl(marker, action, value, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify({ action, value }));
    const req = http.request({ hostname: '127.0.0.1', port: marker.controlPort, method: 'POST', path: '/',
      headers: { Authorization: `Bearer ${marker.token}`, 'Content-Type': 'application/json', 'Content-Length': body.length }, agent: false }, res => {
      let size = 0; const chunks = [];
      res.on('data', chunk => { size += chunk.length; if (size > 65536) res.destroy(fail('The availability control response was too large.')); else chunks.push(chunk); });
      res.on('error', reject);
      res.on('end', () => {
        try {
          const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (res.statusCode !== 200 || result.id !== marker.id) throw fail(result.error || 'The saved availability listener did not match.');
          resolve(result);
        } catch (error) { reject(error); }
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(fail('The availability listener did not answer.')));
    req.on('error', reject); req.end(body);
  });
}

/** Retains one small transport process per profile, without starting a model or the application. */
export class RemoteAvailabilityHost {
  constructor({ dataDir, origin, port = 0, executable = process.execPath,
    worker = fileURLToPath(new URL('./remote-availability-worker.mjs', import.meta.url)), spawnProcess = spawn } = {}) {
    Object.assign(this, { dataDir, origin, port, executable, worker, spawnProcess });
    this.markerPath = path.join(dataDir, markerName); this.marker = null; this.startPromise = null; this.watchRequest = null;
  }

  async start() {
    if (this.startPromise) {
      const pending = this.startPromise, origin = await pending;
      if (this.startPromise !== pending) return this.start();
      if (this.marker && processPresence(this.marker.pid) !== false) return origin;
      this.marker = null; this.startPromise = null;
    }
    this.startPromise = this.ensure().catch(error => { this.startPromise = null; throw error; });
    return this.startPromise;
  }

  async ensure() {
    let saved;
    try { saved = JSON.parse(await fs.readFile(this.markerPath, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw fail('The saved availability listener could not be read.'); }
    if (saved) {
      if (!validMarker(saved, this.origin) || this.port && saved.port !== this.port) throw fail('The saved availability listener does not match this owned route.');
      if (processPresence(saved.pid) !== false) {
        const result = await availabilityControl(saved, 'ping');
        if (result.port !== saved.port || result.pid !== saved.pid) throw fail('The availability listener identity changed.');
        this.marker = saved; this.port = saved.port;
        return `http://127.0.0.1:${this.port}`;
      }
    }
    await fs.mkdir(this.dataDir, { recursive: true });
    const child = this.spawnProcess(this.executable, [this.worker], {
      detached: true, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    const ready = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { finish(); reject(fail('The availability listener did not start. Open BLACKICE to inspect remote access.')); }, 10000);
      const finish = () => { clearTimeout(timer); child.off('error', onError); child.off('exit', onExit); child.off('message', onMessage); };
      const onError = () => { finish(); reject(fail('The availability listener process could not start.')); };
      const onExit = () => { finish(); reject(fail('The availability listener exited before it was ready.')); };
      const onMessage = value => {
        if (value?.error) { finish(); reject(fail(value.error)); }
        else if (validMarker(value?.marker, this.origin)) { finish(); resolve(value.marker); }
      };
      child.on('error', onError); child.on('exit', onExit); child.on('message', onMessage);
      child.send({ dataDir: this.dataDir, origin: this.origin, port: this.port });
    }).finally(() => { if (child.connected) child.disconnect(); child.unref(); });
    this.marker = ready; this.port = ready.port;
    return `http://127.0.0.1:${this.port}`;
  }

  async attach(application) {
    const origin = await this.start();
    const configured = await availabilityControl(this.marker, 'configure', application);
    await this.watch(configured.generation);
    return origin;
  }

  watch(generation) {
    const marker = this.marker;
    return new Promise((resolve, reject) => {
      const body = Buffer.from(JSON.stringify({ action: 'watch', value: { generation } }));
      const req = http.request({ hostname: '127.0.0.1', port: marker.controlPort, method: 'POST', path: '/', headers: { Authorization: `Bearer ${marker.token}`, 'Content-Type': 'application/json', 'Content-Length': body.length }, agent: false }, res => {
        if (res.statusCode !== 200 || res.headers['x-blackice-availability-id'] !== marker.id) { res.destroy(); reject(fail('The application lifetime connection was rejected.')); return; }
        const previous = this.watchRequest; this.watchRequest = req;
        previous?.destroy(); req.setTimeout(0); res.on('error', () => {}); res.resume(); resolve();
      });
      req.setTimeout(5000, () => req.destroy(fail('The application lifetime connection did not answer.')));
      req.on('error', error => { if (this.watchRequest === req) this.watchRequest = null; reject(error); });
      req.end(body);
    });
  }

  async offline(state = 'closing') {
    if (this.marker) await availabilityControl(this.marker, 'offline', { state });
    this.watchRequest?.destroy(); this.watchRequest = null;
  }

  async stop() {
    this.watchRequest?.destroy(); this.watchRequest = null;
    if (!this.marker) {
      try { const value = JSON.parse(await fs.readFile(this.markerPath, 'utf8')); if (validMarker(value, this.origin)) this.marker = value; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (this.marker) {
      const stopped = this.marker;
      const forgetDead = async () => {
        const current = await fs.readFile(this.markerPath, 'utf8').then(JSON.parse).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
        if (current?.id === stopped.id) await fs.unlink(this.markerPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
      };
      if (processPresence(stopped.pid) === false) {
        await forgetDead(); this.marker = null; this.startPromise = null; return;
      }
      try { await availabilityControl(stopped, 'stop'); }
      catch (error) {
        if (processPresence(stopped.pid) !== false) throw error;
        await forgetDead(); this.marker = null; this.startPromise = null; return;
      }
      for (let attempt = 0; attempt < 100; attempt++) {
        const current = await fs.readFile(this.markerPath, 'utf8').then(JSON.parse).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
        if (current?.id !== stopped.id) break;
        if (attempt === 99) throw fail('The availability listener has not finished stopping.');
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
    this.marker = null; this.startPromise = null;
  }
}
