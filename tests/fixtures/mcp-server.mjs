// A real, local MCP stdio server for protocol integration tests and benign end-to-end proof.
import readline from 'node:readline';
import { appendFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
const send = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
const result = (id, value) => send({ id, result: value });
const content = text => ({ content: [{ type: 'text', text: String(text) }] });
const schema = properties => ({ type: 'object', properties, additionalProperties: false });
const tools = [
  { name: 'add', description: 'Add two numbers locally.', inputSchema: schema({ a: { type: 'number' }, b: { type: 'number' } }) },
  { name: 'echo', description: 'Return the supplied text.', inputSchema: schema({ text: { type: 'string' } }) },
  { name: 'write_file', description: 'Write exact UTF-8 content to an absolute local test file.', inputSchema: schema({ path: { type: 'string' }, content: { type: 'string' } }) },
  { name: 'wait', description: 'Wait until disconnected; used to verify cancellation.', inputSchema: schema({ spawnChild: { type: 'boolean' } }) },
  { name: 'environment', description: 'Read the configured test value.', inputSchema: schema({}) },
  { name: 'ping_then_echo', description: 'Exercise server-to-client ping.', inputSchema: schema({ text: { type: 'string' } }) },
];
let initialized = false; const pings = new Map();
const log = value => process.env.RELAY_MCP_LOG ? appendFile(process.env.RELAY_MCP_LOG, JSON.stringify(value) + '\n') : Promise.resolve();
let queue = Promise.resolve();
readline.createInterface({ input: process.stdin }).on('line', line => { queue = queue.then(() => handle(line)); });
async function handle(line) {
  try {
    const message = JSON.parse(line), { id, method, params = {} } = message;
    await log({ method, id, pid: process.pid });
    if (!method) { const pending = pings.get(id); if (pending) { pings.delete(id); result(pending.id, content(pending.text)); } return; }
    if (method === 'notifications/initialized') { initialized = true; return; }
    if (method === 'notifications/cancelled') return;
    if (method === 'initialize') return result(id, { protocolVersion: '2025-06-18', serverInfo: { name: 'Relay integration fixture', version: '1' }, capabilities: { tools: { listChanged: true } } });
    if (!initialized) return send({ id, error: { code: -32000, message: 'Initialize first.' } });
    if (method === 'ping') return result(id, {});
    if (method === 'tools/list') return result(id, params.cursor ? { tools: tools.slice(2) } : { tools: tools.slice(0, 2), nextCursor: 'second-page' });
    if (method !== 'tools/call') return send({ id, error: { code: -32601, message: 'Unknown method.' } });
    const args = params.arguments || {};
    if (params.name === 'add') return result(id, content(Number(args.a) + Number(args.b)));
    if (params.name === 'echo') return result(id, content(args.text));
    if (params.name === 'environment') return result(id, content(process.env.RELAY_MCP_SECRET || 'not configured'));
    if (params.name === 'write_file') { await writeFile(args.path, args.content, 'utf8'); return result(id, content('Wrote ' + args.path)); }
    if (params.name === 'wait') {
      if (args.spawnChild) { const worker = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: 'ignore' }); await log({ workerPid: worker.pid }); }
      return;
    }
    if (params.name === 'ping_then_echo') { const ping = 'server-ping-' + id; pings.set(ping, { id, text: args.text }); return send({ id: ping, method: 'ping', params: {} }); }
    send({ id, error: { code: -32602, message: 'Unknown tool.' } });
  } catch (error) { send({ id: null, error: { code: -32603, message: error.message } }); }
}
