import http from 'node:http';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import { RemoteAvailabilityResponder } from './remote-availability.mjs';

// Started only by an already enabled BLACKICE route. No app relaunch, queue, or model exists here.
let responder, control, marker, markerPath, initializing = true, stopping, aborted = false, ownerWatch;
const send = value => { if (process.connected) process.send(value); };
const json = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };

async function stop() {
  if (stopping) return stopping;
  stopping = (async () => {
    await responder?.close();
    if (control) await new Promise(resolve => { control.close(resolve); control.closeAllConnections(); });
    if (markerPath && marker) {
      const current = await fs.readFile(markerPath, 'utf8').then(JSON.parse).catch(() => null);
      if (current?.id === marker.id) await fs.unlink(markerPath).catch(() => {});
    }
  })();
  return stopping;
}

async function handle(req, res) {
  const expected = `Bearer ${marker.token}`, supplied = req.headers.authorization;
  if (req.method !== 'POST' || req.url !== '/' || !['127.0.0.1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)
    || req.headers.host !== `127.0.0.1:${marker.controlPort}` || typeof supplied !== 'string'
    || Buffer.byteLength(supplied) !== Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) return json(res, 403, { error: 'Use this profile’s local availability controller.' });
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 1024 * 1024) return json(res, 413, { error: 'Control update is too large.' }); chunks.push(chunk); }
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (input.action === 'watch') {
    const generation = input.value?.generation;
    if (!Number.isSafeInteger(generation) || generation !== responder.generation) return json(res, 409, { id: marker.id, error: 'The application generation changed.' });
    const previous = ownerWatch; ownerWatch = res;
    previous?.destroy();
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Blackice-Availability-Id': marker.id });
    res.write(': connected\n\n');
    const heartbeat = setInterval(() => res.write(': alive\n\n'), 10000); heartbeat.unref();
    res.once('close', () => { clearInterval(heartbeat); if (ownerWatch === res) { ownerWatch = null; responder.disconnected(generation); } });
    return;
  }
  let state;
  if (input.action === 'ping') state = responder.status();
  else if (input.action === 'configure') state = responder.configure(input.value);
  else if (input.action === 'offline') state = responder.offline(input.value?.state);
  else if (input.action === 'stop') {
    res.once('finish', () => { void stop(); });
    json(res, 200, { id: marker.id, stopping: true });
    return;
  } else return json(res, 400, { id: marker.id, error: 'Unknown availability lifecycle action.' });
  return json(res, 200, { id: marker.id, pid: process.pid, port: responder.port, generation: responder.generation, lifetimeConnected: Boolean(ownerWatch), targetAttached: Boolean(responder.application.target), state });
}

process.once('message', async options => {
  try {
    if (typeof options?.dataDir !== 'string' || !path.isAbsolute(options.dataDir)) throw Error('A profile directory is required.');
    responder = new RemoteAvailabilityResponder(options);
    await responder.listen();
    if (aborted) throw Error('Availability startup was interrupted.');
    control = http.createServer((req, res) => { void handle(req, res).catch(error => json(res, error.status || 400, { id: marker?.id, error: error.message })); });
    control.requestTimeout = 10000; control.headersTimeout = 10000; control.keepAliveTimeout = 1000;
    await new Promise((resolve, reject) => { control.once('error', reject); control.listen(0, '127.0.0.1', resolve); });
    if (aborted) throw Error('Availability startup was interrupted.');
    marker = { schema: 1, id: randomUUID(), pid: process.pid, port: responder.port, controlPort: control.address().port, origin: options.origin, token: randomBytes(32).toString('base64url') };
    markerPath = path.join(options.dataDir, 'remote-availability.json');
    const temporary = markerPath + '.' + marker.id + '.tmp';
    await fs.writeFile(temporary, JSON.stringify(marker) + '\n', { flag: 'wx', mode: 0o600 });
    await fs.rename(temporary, markerPath);
    initializing = false; send({ marker });
  } catch (error) { send({ error: error.message }); await stop(); process.exitCode = 1; }
});
// A failed startup cannot leave a half-created listener after the app times out.
process.once('disconnect', () => { if (initializing) { aborted = true; void stop(); } });
