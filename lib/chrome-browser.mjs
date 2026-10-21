import { browserURL } from './browser.mjs';
import { normalizeConnection } from './mcp.mjs';
import { CHROME_BROWSER_CONNECTION_ID, chromeBrowserArguments, isManagedChromeConnection, pinnedChromeMcpArguments } from './chrome-browser-policy.mjs';
export { CHROME_BROWSER_CONNECTION_ID, isManagedChromeConnection, isChromeBrowserConnection, chromeBackgroundArguments } from './chrome-browser-policy.mjs';

export const CHROME_SETUP_URL = 'chrome://inspect/#remote-debugging';
export const CHROME_CONNECT_DOCUMENTATION = 'https://developer.chrome.com/docs/devtools/agents/use-cases/auto-connect';
export const CHROME_BACKGROUND_INSTRUCTIONS = 'Use the connected Chrome session for existing sign-ins. Discover the current tool schemas first. Open task tabs with new_page background:true and omit isolatedContext so the actual signed-in profile is reused. Select existing task tabs with bringToFront:false. Do not foreground, resize, close, or navigate unrelated user tabs. Read the resulting page before claiming authentication. A connected MCP server or visible feed shell does not prove sign-in. Never copy session cookies between browsers.';
export const CHROME_BROWSER_INSTRUCTIONS = CHROME_BACKGROUND_INSTRUCTIONS;
const fail = (message, code = 'CHROME_CONNECTION_VALIDATION') => Object.assign(new Error(message), { code });
const verified = new WeakMap();

/** Produces configuration only. It never starts Chrome or writes settings. */
export function chromeAutoConnectConnection({ id = CHROME_BROWSER_CONNECTION_ID, channel = 'stable', command = 'npx', timeoutMs = 60000 } = {}) {
  return normalizeConnection({ id, name: 'Chrome · existing session', transport: 'stdio', enabled: true, command, args: chromeBrowserArguments(channel), timeoutMs });
}

/** An explicit background call for the discovered official MCP tool. */
export function chromeBackgroundOpen(url) { return { name: 'new_page', arguments: { url: browserURL(url), background: true } }; }

/** No I/O, probing, connection, or profile reads. Safe for status refreshes. */
export function chromeBrowserStatus({ connections } = {}) {
  const config = connections?.list?.().find(item => item.id === CHROME_BROWSER_CONNECTION_ID);
  const managed = isManagedChromeConnection(config), configured = !!config && managed;
  const enabled = configured && config.enabled !== false, serverConnected = enabled && config.connected === true;
  const check = connections && verified.get(connections);
  const currentClient = connections?.clients?.get?.(CHROME_BROWSER_CONNECTION_ID);
  const browserConnected = serverConnected && !!check && connections.chromeBrowserClient === check.client && (!connections.clients || currentClient === check.client);
  const state = config && !managed ? 'configuration-conflict' : configured && !enabled ? 'disabled' : browserConnected ? 'connected' : serverConnected ? 'server-connected' : 'disconnected';
  const reason = { 'configuration-conflict': 'Another tool uses the Chrome connection ID; its settings were preserved.', disabled: 'The Chrome connection is disabled.', connected: 'Connected to the existing Chrome session.', 'server-connected': 'Choose Connect to attach the existing Chrome session.', disconnected: 'Choose Connect to attach the existing Chrome session.' }[state];
  return { browser: 'chrome', mode: 'existing-session', connectionId: CHROME_BROWSER_CONNECTION_ID, available: browserConnected, configured, enabled, connected: browserConnected, serverConnected, browserConnected, state, reason, accountAuthenticated: 'unknown', minimumChromeMajor: 144, background: true, physicalInput: false, ...(browserConnected ? { verifiedAt: check.at } : {}), setup: { url: CHROME_SETUP_URL, documentation: CHROME_CONNECT_DOCUMENTATION, nativeConnectionPrompt: 'Chrome can ask again for each new debugging session.' } };
}

/** Only invoke from an explicit Connect action. It does not launch a browser. */
export async function registerChromeBrowser({ connections, signal, onDispatch } = {}) {
  if (!connections?.save || !connections?.connect || !connections?.call || !connections?.list) throw fail('Chrome needs Relay’s tool connection manager.');
  connections.chromeBrowserClient = null; verified.delete(connections);
  if (signal?.aborted) throw Object.assign(fail('Chrome connection cancelled.', 'ABORT_ERR'), { name: 'AbortError' });
  await connections.init?.();
  const existing = connections.list().find(config => config.id === CHROME_BROWSER_CONNECTION_ID);
  if (existing && !isManagedChromeConnection(existing)) throw fail('The Chrome connection ID is already used by another tool configuration. Its settings were preserved.', 'CHROME_CONNECTION_CONFLICT');
  if (existing?.enabled === false) throw fail('The existing Chrome connection is disabled. Its settings were preserved.', 'CHROME_CONNECTION_DISABLED');
  if (!existing) await connections.save(chromeAutoConnectConnection());
  else {
    const args = pinnedChromeMcpArguments(existing.args);
    if (JSON.stringify(args) !== JSON.stringify(existing.args)) await connections.save({ ...existing, args });
  }
  verified.delete(connections);
  try {
    const client = await connections.connect(CHROME_BROWSER_CONNECTION_ID, { signal });
    if (!client.tools?.some(tool => tool.name === 'list_pages')) throw fail('The Chrome tool server does not expose its expected browser tools.', 'CHROME_TOOL_CATALOG');
    // This read-only call triggers Chrome's own session request. Discard its
    // output: tab titles and URLs must not become persistent status metadata.
    const result = await connections.call(CHROME_BROWSER_CONNECTION_ID, 'list_pages', {}, { signal, browserSetup: true, ...(onDispatch ? { onDispatch } : {}) });
    if (result?.isError || !Array.isArray(result?.content) || !result.content.some(item => item.type === 'text' && typeof item.text === 'string' && item.text.trim())) throw fail('Chrome has not confirmed the browser connection.', 'CHROME_SETUP_REQUIRED');
    if (signal?.aborted) throw Object.assign(fail('Chrome connection cancelled.', 'ABORT_ERR'), { name: 'AbortError' });
    connections.chromeBrowserClient = client; verified.set(connections, { client, at: new Date().toISOString() });
    return chromeBrowserStatus({ connections });
  } catch (error) {
    connections.chromeBrowserClient = null; verified.delete(connections);
    if (signal?.aborted || error?.name === 'AbortError') throw Object.assign(fail('Chrome connection cancelled.', 'ABORT_ERR'), { name: 'AbortError' });
    if (error?.code === 'CHROME_TOOL_CATALOG') throw error;
    throw fail('Chrome is not connected yet. Keep Chrome 144 or newer open, enable remote debugging in Chrome, then allow its native connection request.', 'CHROME_SETUP_REQUIRED');
  }
}
