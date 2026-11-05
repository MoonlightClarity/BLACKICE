import http from 'node:http';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { toolResultEvent } from './tool-outcomes.mjs';

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_CALLS = 4096;
const MAX_SESSIONS = 512;
const MAX_IMAGE_CHARS = 24 * 1024 * 1024;
const protocolVersions = new Set(['2025-03-26', '2025-06-18']);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const failure = (message, code = 'VIBE_TOOL_BRIDGE') => Object.assign(new Error(message), { code });
const cancelled = () => Object.assign(failure('This Vibe tool session is closed.', 'ABORT_ERR'), { name: 'AbortError' });
const canonical = value => Array.isArray(value) ? value.map(canonical) : record(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 200 || Number.isSafeInteger(value);
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

function toolCatalog(tools) {
  if (!Array.isArray(tools)) throw failure('Dynamic tools must be an array.', 'VIBE_TOOL_SCHEMA');
  const entries = new Map(), identities = new Set();
  const add = (tool, namespace) => {
    if (!record(tool) || typeof tool.name !== 'string' || !tool.name.trim() || tool.name.length > 200 || /[\u0000-\u001f\u007f]/.test(tool.name))
      throw failure('A dynamic tool has an invalid name.', 'VIBE_TOOL_SCHEMA');
    if (namespace !== undefined && (typeof namespace !== 'string' || !namespace.trim() || namespace.length > 200 || /[\u0000-\u001f\u007f]/.test(namespace)))
      throw failure('A dynamic tool has an invalid namespace.', 'VIBE_TOOL_SCHEMA');
    const identity = JSON.stringify([namespace ?? null, tool.name]);
    if (identities.has(identity)) throw failure('Dynamic tools contain a duplicate identity.', 'VIBE_TOOL_SCHEMA');
    identities.add(identity);
    const schema = tool.inputSchema ?? tool.parameters ?? { type: 'object', properties: {} };
    if (!record(schema)) throw failure('A dynamic tool needs an object input schema.', 'VIBE_TOOL_SCHEMA');
    let inputSchema;
    try { inputSchema = JSON.parse(JSON.stringify(schema)); } catch { throw failure('A dynamic tool schema is not JSON serializable.', 'VIBE_TOOL_SCHEMA'); }
    const stem = [namespace, tool.name].filter(value => value !== undefined).join('__').replace(/[^A-Za-z0-9_]/g, '_').slice(0, 88);
    const remoteName = 'blackice_' + stem + '_' + createHash('sha256').update(identity).digest('hex').slice(0, 16);
    if (entries.has(remoteName)) throw failure('Dynamic tool names collide.', 'VIBE_TOOL_SCHEMA');
    entries.set(remoteName, { name: tool.name, ...(namespace === undefined ? {} : { namespace }),
      descriptor: { name: remoteName, description: typeof tool.description === 'string' ? tool.description : '', inputSchema } });
    if (entries.size > 512) throw failure('Too many dynamic tools for one Vibe session.', 'VIBE_TOOL_SCHEMA');
  };
  for (const tool of tools) {
    if (tool?.type === 'namespace') {
      if (!Array.isArray(tool.tools)) throw failure('A dynamic namespace needs a tool list.', 'VIBE_TOOL_SCHEMA');
      for (const nested of tool.tools) add(nested, tool.name);
    } else {
      if (tool?.type !== undefined && tool.type !== 'function') throw failure('Unsupported dynamic tool type.', 'VIBE_TOOL_SCHEMA');
      add(tool);
    }
  }
  return entries;
}

function mcpContent(items) {
  const content = [];
  for (const item of items || []) {
    if (item?.type === 'inputText' && typeof item.text === 'string') content.push({ type: 'text', text: item.text });
    else if (item?.type === 'inputImage' && typeof item.imageUrl === 'string') {
      const match = /^data:(image\/[A-Za-z0-9.+-]+);base64,([A-Za-z0-9+/]*={0,2})$/.exec(item.imageUrl);
      if (match && match[2].length <= MAX_IMAGE_CHARS) content.push({ type: 'image', mimeType: match[1], data: match[2] });
      else content.push({ type: 'text', text: '[The tool returned an image that cannot be sent inline to Vibe. No external image URL was fetched.]' });
    }
  }
  return content;
}
function safeEventItems(items) {
  return (items || []).flatMap(item => item?.type === 'inputText' && typeof item.text === 'string' ? [{ type: 'inputText', text: item.text }]
    : item?.type === 'inputImage' ? [{ type: 'inputText', text: '[Image returned to the agent]' }] : []);
}

/** One private, per-turn MCP endpoint. It has no ambient tools or provider calls. */
export async function createVibeToolBridge({ tools = [], onToolCall, signal, onEvent } = {}) {
  if (signal?.aborted) throw signal.reason || cancelled();
  const catalog = toolCatalog(tools);
  if (catalog.size && typeof onToolCall !== 'function') throw failure('Dynamic tools require their BLACKICE callback.', 'VIBE_TOOL_CALLBACK');
  const token = randomBytes(32).toString('base64url'), authorization = Buffer.from('Bearer ' + token);
  const pathname = '/blackice-vibe/' + randomUUID();
  const controller = new AbortController(), pending = new Set(), calls = new Map(), sessions = new Map();
  let accepting = true, closePromise, host;
  const emit = event => { try { onEvent?.(event); } catch { /* A UI listener cannot alter an admitted tool. */ } };
  const stopAdmission = () => { accepting = false; if (!controller.signal.aborted) controller.abort(signal?.reason || cancelled()); };
  signal?.addEventListener('abort', stopAdmission, { once: true });

  async function invoke(entry, args, callId, callController) {
    const call = { name: entry.name, ...(entry.namespace === undefined ? {} : { namespace: entry.namespace }), arguments: args, callId };
    const item = { type: 'dynamicToolCall', id: callId, name: entry.name, ...(entry.namespace === undefined ? {} : { namespace: entry.namespace }), arguments: args };
    emit({ type: 'item', stage: 'started', item: { ...item, status: 'inProgress' } });
    let result;
    try {
      if (callController.signal.aborted) throw callController.signal.reason || cancelled();
      result = await onToolCall(call, { signal: callController.signal });
      if (!record(result) || typeof result.success !== 'boolean' || !Array.isArray(result.contentItems) || !result.contentItems.every(item => record(item) && (item.type === 'inputText' && typeof item.text === 'string' || item.type === 'inputImage' && typeof item.imageUrl === 'string')))
        result = { success: false, code: 'VIBE_TOOL_RESULT_INVALID', contentItems: [{ type: 'inputText', text: 'The BLACKICE callback returned an invalid receipt. Observe current state before repeating any effect.' }] };
    } catch (cause) {
      result = { success: false, code: typeof cause?.code === 'string' ? cause.code : 'VIBE_TOOL_ERROR',
        contentItems: [{ type: 'inputText', text: String(cause?.message || 'The tool callback failed; verify current state before retrying.').slice(0, 8000) }] };
    }
    const receipt = toolResultEvent(call, result);
    emit({ type: 'item', stage: 'completed', item: { ...item, status: 'completed', success: receipt.success, contentItems: safeEventItems(result.contentItems) } });
    emit(receipt);
    return { content: mcpContent(result.contentItems), isError: !receipt.success };
  }

  function dispatch(message, session) {
    const id = message.id;
    if (message.method === 'tools/call') {
      const fingerprint = createHash('sha256').update(JSON.stringify(canonical(message))).digest('hex');
      // JSON-RPC IDs belong to one MCP session. Vibe opens a fresh HTTP
      // ClientSession per call, so its numeric IDs legitimately start over.
      const key = JSON.stringify([session.id, id]), previous = calls.get(key);
      if (previous) return previous.fingerprint === fingerprint ? previous.promise
        : Promise.resolve(rpcError(id, -32600, 'This request ID already belongs to a different tool call.'));
      if (!accepting) return Promise.resolve(rpcError(id, -32000, 'This tool session is closed.'));
      if (calls.size >= MAX_CALLS) return Promise.resolve(rpcError(id, -32000, 'This tool session reached its receipt limit.'));
      const entry = typeof message.params?.name === 'string' ? catalog.get(message.params.name) : null;
      const args = message.params?.arguments ?? {};
      if (!entry || !record(args)) return Promise.resolve(rpcError(id, -32602, 'Choose an advertised tool and object arguments.'));
      const callController = new AbortController();
      const abort = () => callController.abort(controller.signal.reason || session.controller.signal.reason || cancelled());
      controller.signal.addEventListener('abort', abort, { once: true });
      session.controller.signal.addEventListener('abort', abort, { once: true });
      const state = { fingerprint, controller: callController, promise: null };
      // Defer the callback until the identity and pending promise are registered.
      const promise = Promise.resolve().then(() => invoke(entry, args, 'vibe_tool_' + randomUUID(), callController))
        .then(result => ({ jsonrpc: '2.0', id, result }))
        .finally(() => { controller.signal.removeEventListener('abort', abort); session.controller.signal.removeEventListener('abort', abort); pending.delete(promise); });
      state.promise = promise; calls.set(key, state); pending.add(promise);
      return promise;
    }
    if (!accepting) return Promise.resolve(rpcError(id, -32000, 'This tool session is closed.'));
    if (message.method === 'initialize') return Promise.resolve({ jsonrpc: '2.0', id, result: {
      protocolVersion: protocolVersions.has(message.params?.protocolVersion) ? message.params.protocolVersion : '2025-06-18',
      capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'BLACKICE Vibe tools', version: '1.0.0' },
    } });
    if (message.method === 'tools/list') return Promise.resolve({ jsonrpc: '2.0', id, result: { tools: [...catalog.values()].map(entry => entry.descriptor) } });
    if (message.method === 'ping') return Promise.resolve({ jsonrpc: '2.0', id, result: {} });
    return Promise.resolve(rpcError(id, -32601, 'This MCP method is not supported.'));
  }

  const write = (res, status, value, headers = {}) => {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
    res.end(value === undefined ? undefined : JSON.stringify(value));
  };
  const server = http.createServer(async (req, res) => {
    try {
      if (req.headers.host !== host || req.url !== pathname) { write(res, 404, { error: 'Not found.' }); return; }
      if (req.headers.origin !== undefined && req.headers.origin !== 'http://' + host) { write(res, 403, { error: 'Origin denied.' }); return; }
      const supplied = typeof req.headers.authorization === 'string' ? Buffer.from(req.headers.authorization) : Buffer.alloc(0);
      if (supplied.length !== authorization.length || !timingSafeEqual(supplied, authorization)) { write(res, 401, { error: 'Authentication required.' }); return; }
      const sessionId = req.headers['mcp-session-id'];
      if (req.method === 'DELETE') {
        const session = typeof sessionId === 'string' ? sessions.get(sessionId) : null;
        if (!session) { write(res, sessionId ? 404 : 400, { error: 'A current MCP session is required.' }); return; }
        sessions.delete(sessionId);
        session.controller.abort(cancelled());
        write(res, 204); return;
      }
      if (req.method !== 'POST') { res.setHeader('Allow', 'POST, DELETE'); write(res, 405, { error: 'Use POST or DELETE.' }); return; }
      if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) { write(res, 415, { error: 'Use application/json.' }); return; }
      const chunks = []; let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > MAX_BODY_BYTES) { write(res, 413, { error: 'Request too large.' }); return; }
        chunks.push(chunk);
      }
      let message;
      try { message = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { write(res, 200, rpcError(null, -32700, 'Invalid JSON.')); return; }
      if (!record(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') { write(res, 200, rpcError(null, -32600, 'Invalid JSON-RPC request.')); return; }
      const hasId = Object.hasOwn(message, 'id');
      if (hasId && !validId(message.id)) { write(res, 200, rpcError(null, -32600, 'A bounded string or integer ID is required.')); return; }
      if (!hasId && !message.method.startsWith('notifications/')) { write(res, 400, { error: 'Requests need an ID.' }); return; }
      let session = typeof sessionId === 'string' ? sessions.get(sessionId) : null;
      if (message.method === 'initialize' && hasId && !sessionId) {
        if (!accepting) { write(res, 200, rpcError(message.id, -32000, 'This tool session is closed.')); return; }
        if (sessions.size >= MAX_SESSIONS) { write(res, 503, { error: 'This tool bridge reached its active MCP session limit.' }); return; }
        session = { id: randomUUID(), controller: new AbortController() };
        sessions.set(session.id, session);
      } else if (!session) {
        write(res, sessionId ? 404 : 400, { error: 'Initialize a current MCP session before using this tool bridge.' }); return;
      }
      if (!hasId) {
        if (message.method === 'notifications/cancelled' && validId(message.params?.requestId))
          calls.get(JSON.stringify([session.id, message.params.requestId]))?.controller.abort(cancelled());
        write(res, 202); return;
      }
      write(res, 200, await dispatch(message, session), message.method === 'initialize' ? { 'Mcp-Session-Id': session.id } : {});
    } catch {
      write(res, 500, { error: 'The tool request could not be completed. Recover its existing receipt before retrying.' });
    }
  });
  server.headersTimeout = 5000; server.requestTimeout = 15000; server.keepAliveTimeout = 1000;
  server.on('clientError', (_error, socket) => { if (!socket.destroyed) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); });
  try {
    await new Promise((resolve, reject) => {
      const startupError = cause => { server.off('listening', listening); reject(cause); };
      const listening = () => { server.off('error', startupError); resolve(); };
      server.once('error', startupError); server.once('listening', listening); server.listen(0, '127.0.0.1');
    });
  } catch (cause) { signal?.removeEventListener('abort', stopAdmission); stopAdmission(); server.close(); throw cause; }
  const address = server.address(); host = '127.0.0.1:' + address.port;
  const settle = async () => { while (pending.size) await Promise.allSettled([...pending]); };
  const close = () => closePromise ||= (async () => {
    signal?.removeEventListener('abort', stopAdmission); stopAdmission();
    const stopped = new Promise(resolve => server.close(resolve));
    server.closeIdleConnections();
    await settle();
    server.closeIdleConnections();
    await stopped;
    sessions.clear(); calls.clear();
  })();
  if (signal?.aborted) { await close(); throw signal.reason || cancelled(); }
  // Verified Vibe 3.1 naming: Core group mcp_<server>, legacy/display <server>_<remote>.
  const toolNames = new Set([...catalog.keys()].flatMap(name => ['mcp_blackice.' + name, 'blackice_' + name]));
  const toolBindings = [...catalog].map(([remoteName, entry]) => ({
    name: entry.name, ...(entry.namespace === undefined ? {} : { namespace: entry.namespace }),
    nativeName: 'mcp_blackice.' + remoteName,
  }));
  const instructions = toolBindings.length ? [
    'BLACKICE TOOLS IN MISTRAL VIBE',
    'BLACKICE instructions use host tool names such as relay_workspace. This native session exposes those tools under the exact MCP function names below. In run_typescript, call await tools.<nativeName>(arguments) using an object matching the advertised tool schema. Use search_tool_functions for that exact native function when you need its schema. Print or return the result so it is available as evidence.',
    'Use these mapped functions instead of inventing tools.relay_* aliases. Native file_system and shell functions may appear in Vibe search results but are disabled in this BLACKICE session; perform file, browser, command, and task operations through the attached BLACKICE functions.',
    ...toolBindings.map(({ nativeName, ...identity }) => JSON.stringify(identity) + ' => await tools.' + nativeName + '(arguments)'),
  ].join('\n') : '';
  return { server: { type: 'http', name: 'blackice', url: 'http://' + host + pathname, headers: [{ name: 'Authorization', value: 'Bearer ' + token }] }, toolNames, toolBindings, instructions, settle, close };
}
