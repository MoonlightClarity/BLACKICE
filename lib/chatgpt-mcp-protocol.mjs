import { CHATGPT_OAUTH_SCOPES } from './chatgpt-oauth.mjs';

export const CHATGPT_MCP_PATH = '/mcp/chatgpt';
export const CHATGPT_PROTOCOLS = Object.freeze(['2026-07-28', '2025-11-25', '2025-06-18']);
export const CHATGPT_SCOPES = CHATGPT_OAUTH_SCOPES;
export const MCP_META = 'io.modelcontextprotocol/';

export const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const connectorError = (message, status = 400, code = 'CHATGPT_REQUEST_INVALID') =>
  Object.assign(new Error(message), { status, code });
const protocolError = (message, rpcCode, status = 400, data) =>
  Object.assign(connectorError(message, status), { rpcCode, ...(data ? { data } : {}) });

export function sendJSON(res, status, value) {
  if (res.destroyed) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

export function sendRPCError(res, request, error) {
  const id = typeof request?.id === 'string' || Number.isSafeInteger(request?.id) ? request.id : null;
  return sendJSON(res, error.status || 400, {
    jsonrpc: '2.0', id,
    error: {
      code: error.rpcCode ?? (error.code === 'CHATGPT_JSON_INVALID' ? -32700 : -32600),
      message: error.message,
      ...(error.data ? { data: error.data } : {}),
    },
  });
}

export function sendRPCResult(res, request, modern, serverInfo, result) {
  return sendJSON(res, 200, {
    jsonrpc: '2.0', id: request.id,
    result: modern ? {
      ...result,
      resultType: 'complete',
      _meta: { ...result._meta, [MCP_META + 'serverInfo']: serverInfo },
    } : result,
  });
}

export async function readMCPBody(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) {
    throw connectorError('Send application/json.', 415);
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > 512 * 1024) throw connectorError('The connector request exceeds 512 KiB.', 413);
    chunks.push(bytes);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw connectorError('Invalid JSON.', 400, 'CHATGPT_JSON_INVALID'); }
}

/** Decode only the wire contract. Grants and action admission have no turn/session state here. */
export function decodeMCPRequest(request, headers) {
  if (!isObject(request) || request.jsonrpc !== '2.0' || typeof request.method !== 'string'
    || request.method.length > 128
    || Object.keys(request).some(key => !['jsonrpc', 'id', 'method', 'params'].includes(key))
    || request.params !== undefined && !isObject(request.params)
    || Object.hasOwn(request, 'id') && typeof request.id !== 'string' && !Number.isSafeInteger(request.id)) {
    throw protocolError('Send one JSON-RPC request or notification.', -32600);
  }
  const params = request.params || {};
  const meta = params._meta;
  const protocolHeader = headers['mcp-protocol-version'];
  const modern = Boolean(isObject(meta) && Object.hasOwn(meta, MCP_META + 'protocolVersion')
    || protocolHeader === CHATGPT_PROTOCOLS[0]);
  if (modern) {
    const version = meta?.[MCP_META + 'protocolVersion'];
    if (version !== CHATGPT_PROTOCOLS[0] || protocolHeader !== version
      || !isObject(meta?.[MCP_META + 'clientCapabilities'])) {
      throw protocolError('Use matching supported per-request protocol metadata and headers.', -32022, 400, { supported: CHATGPT_PROTOCOLS });
    }
    const headerName = headers['mcp-name'];
    let decodedName = headerName;
    if (typeof headerName === 'string' && headerName.startsWith('=?base64?') && headerName.endsWith('?=')) {
      const encoded = headerName.slice(9, -2);
      decodedName = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)
        ? Buffer.from(encoded, 'base64').toString('utf8') : undefined;
    }
    if (headers['mcp-method'] !== request.method || request.method === 'tools/call' && decodedName !== params.name) {
      throw protocolError('MCP routing headers must match the request.', -32020);
    }
  } else if (request.method !== 'initialize' && protocolHeader && !CHATGPT_PROTOCOLS.slice(1).includes(protocolHeader)) {
    throw protocolError('Unsupported MCP protocol version.', -32022, 400, { supported: CHATGPT_PROTOCOLS });
  }
  return { params, modern, notification: !Object.hasOwn(request, 'id') };
}

export function invalidParams(message) { return protocolError(message, -32602); }
export function methodNotFound(modern) { return protocolError('Method not found.', -32601, modern ? 404 : 200); }

export function toolErrorValue(error) {
  return {
    error: error.message || 'The BLACKICE action could not be completed.',
    code: error.code || 'CHATGPT_ACTION_FAILED',
    ...(Number.isSafeInteger(error.currentRevision) ? { currentRevision: error.currentRevision } : {}),
    ...(error.scope ? { requiredScope: error.scope } : {}),
    ...(Array.isArray(error.requiredScopes)
      ? { requiredScopes: error.requiredScopes.filter(scope => CHATGPT_SCOPES.includes(scope)) } : {}),
  };
}

export function toolResult(value, isError = false, meta) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
    ...(meta ? { _meta: meta } : {}),
    isError,
  };
}
