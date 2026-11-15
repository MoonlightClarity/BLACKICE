// Disposable, isolated browser-preview harness. Never touches the installed profile.
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHarnessServer } from '../server.mjs';

class PreviewRuntime extends EventEmitter {
  status() { return { connected: true, authenticated: true, defaultModel: 'preview-fixture', activeTurns: 0 }; }
  async start() { return this.status(); }
  async runAgent() { throw Error('Preview harness must never run a model.'); }
  async close() {}
}
const dir = await mkdtemp(path.join(os.tmpdir(), 'swarm-render-preview-'));
const workspace = path.join(dir, 'workspace');
await mkdir(workspace);
const app = await createHarnessServer({ runtime: new PreviewRuntime(), port: Number(process.env.SWARM_PREVIEW_PORT || 43981),
  dataDir: path.join(dir, 'data'), defaultCwd: workspace, remoteAccess: null });
const address = await app.listen({ waitForRemote: false });
console.log('SWARM_PREVIEW_READY ' + address);
let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  await app.close();
  await rm(dir, { recursive: true, force: true });
};
process.once('SIGINT', () => { void close().finally(() => process.exit()); });
process.once('SIGTERM', () => { void close().finally(() => process.exit()); });
