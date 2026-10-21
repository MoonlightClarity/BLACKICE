import { normalizeConnection } from './mcp.mjs';

const LIMIT = 512000;
const fail = message => Object.assign(new Error(message), { status: 400, code: 'INVALID_CONNECTION_IMPORT' });
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function secrets(value, kind) {
  if (value === undefined) return undefined;
  if (!plain(value) || Object.keys(value).length > 100) throw fail(`${kind === 'env' ? 'Environment variables' : 'Headers'} must be an object with at most 100 entries.`);
  const result = {};
  for (const [key, text] of Object.entries(value)) {
    if (key === '__proto__' || !/^[A-Za-z_][A-Za-z0-9_-]{0,100}$/.test(key) || typeof text !== 'string' || text.length > 20000 || text.includes('\0')) throw fail('Credential names and values must be valid text.');
    if (kind === 'headers' && (/\r|\n/.test(text) || /^(host|content-length|mcp-session-id|mcp-protocol-version|connection|accept|content-type)$/i.test(key))) throw fail('A header is invalid or managed by the MCP transport.');
    result[key] = text;
  }
  return result;
}
function slug(value) {
  let result = String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!result) result = 'tools'; if (!/^[a-z]/.test(result)) result = `tools-${result}`;
  return result.slice(0, 40).replace(/-+$/g, '') || 'tools';
}
function uniqueId(name, used) {
  const base = slug(name); let id = base, suffix = 2;
  while (used.has(id)) { const ending = `-${suffix++}`; id = base.slice(0, 40 - ending.length) + ending; }
  used.add(id); return id;
}

/** Parse common MCP configuration into new connections. Candidates contain secrets: server use only. */
export function parseConnectionImport(configuration, { existingIds = [], maxConnections = 40 } = {}) {
  let value = configuration;
  if (typeof value === 'string') {
    if (!value.trim() || value.length > LIMIT) throw fail('Paste a JSON configuration of at most 512,000 characters.');
    try { value = JSON.parse(value); } catch { throw fail('This configuration is not valid JSON. Check its braces, commas, and quoted text.'); }
  } else { let serialized; try { serialized = JSON.stringify(value); } catch { throw fail('Provide a plain JSON configuration.'); } if (!serialized || serialized.length > LIMIT) throw fail('Provide a JSON configuration of at most 512,000 characters.'); }
  if (!plain(value)) throw fail('Configuration must be a JSON object with mcpServers or connections.');
  if (value.mcpServers !== undefined && value.connections !== undefined) throw fail('Import one format at a time: mcpServers or connections.');
  let inputs;
  if (value.mcpServers !== undefined) {
    if (!plain(value.mcpServers)) throw fail('mcpServers must be an object mapping server names to configurations.');
    inputs = Object.entries(value.mcpServers).map(([name, config]) => ({ name, config }));
  } else if (Array.isArray(value.connections)) inputs = value.connections.map((config, index) => ({ name: config?.name || config?.id || `Server ${index + 1}`, config }));
  else throw fail('Expected {"mcpServers":{...}} or {"connections":[...]}.');
  const used = new Set(existingIds), existingCount = used.size;
  if (!Number.isSafeInteger(maxConnections) || maxConnections < 1 || maxConnections > 40) throw fail('Connection import capacity must be from 1 to 40.');
  if (!inputs.length) throw fail('This configuration contains no tool servers.');
  if (inputs.length + existingCount > maxConnections) throw fail(`Relay supports ${maxConnections} connections. This import has ${inputs.length}; ${Math.max(0, maxConnections - existingCount)} more fit.`);
  const candidates = [], preview = [], warnings = [];
  for (const { name: fallbackName, config } of inputs) {
    if (!plain(config)) throw fail('Each tool server configuration must be an object.');
    const name = config.name ?? fallbackName;
    if (typeof name !== 'string' || !name.trim() || name.length > 120) throw fail('Each imported server needs a name of 1–120 characters.');
    try {
      const declared = config.transport ?? config.type;
      if (declared !== undefined && typeof declared !== 'string') throw fail('Transport must be stdio or Streamable HTTP.');
      if (declared && /sse/i.test(declared)) throw fail('Legacy SSE transport is not supported. Use a Streamable HTTP MCP endpoint.');
      if (declared && !['stdio', 'http', 'streamable-http', 'streamableHttp'].includes(declared)) throw fail('Unsupported transport. Use stdio or Streamable HTTP.');
      if (config.oauth !== undefined || config.oauth2 !== undefined || config.auth !== undefined || config.authentication !== undefined) throw fail('OAuth and embedded authentication settings are not supported. Use explicit HTTP headers or local environment variables.');
      if (config.url && config.command) throw fail('Choose either a local command or an HTTP endpoint, not both.');
      const transport = declared === 'stdio' ? 'stdio' : declared ? 'http' : config.url ? 'http' : 'stdio';
      if (transport === 'http' && config.command) throw fail('An HTTP connection needs a URL, not a command.');
      if (transport === 'stdio' && config.url) throw fail('A stdio connection needs a command, not a URL.');
      if (transport === 'http' && /\/sse\/?(?:[?#]|$)/i.test(String(config.url || ''))) throw fail('This appears to be a legacy SSE endpoint. Supply the server’s Streamable HTTP endpoint instead.');
      const id = uniqueId(config.id || name, used);
      const normalized = normalizeConnection({ ...config, id, name: name.trim(), transport, enabled: config.enabled === undefined ? config.disabled !== true : config.enabled === true });
      const env = secrets(config.env, 'env'), headers = secrets(config.headers, 'headers');
      candidates.push({ ...normalized, ...(env !== undefined ? { env } : {}), ...(headers !== undefined ? { headers } : {}) });
      preview.push({ ...normalized, args: undefined, argumentCount: normalized.args?.length || 0, envKeys: Object.keys(env || {}), headerNames: Object.keys(headers || {}), credentialsProvided: Boolean(Object.keys(env || {}).length + Object.keys(headers || {}).length) });
      if (config.secret !== undefined || config.envKeys?.length && !env || config.headerNames?.length && !headers) warnings.push(`${name}: saved or encrypted credentials were not imported. Enter the required values in Relay.`);
      if (config.autoStart === true) warnings.push(`${name}: this connection will start on demand when its tools are used.`);
    } catch (cause) { throw fail(`${name}: ${cause.message}`); }
  }
  return { candidates, preview, warnings };
}

export const CONNECTION_IMPORT_LIMIT = LIMIT;
