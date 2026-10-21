import { executeConnectedBrowser } from './mcp.mjs';
import path from 'node:path';

const string = maxLength => ({ type: 'string', minLength: 1, maxLength });
const requestId = { ...string(120), pattern: '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$', description: 'Stable ID for this exact action under the current connector connectionId. Inspect the saved job after uncertainty; an identical same-ID retry does not execute twice.' };
const schema = (properties, required) => ({ type: 'object', properties: { requestId, ...properties }, required: ['requestId', ...required], additionalProperties: false });
const definition = (name, description, scope, requiredScopes, inputSchema, mutating) => ({ name, description, scope, requiredScopes, inputSchema, mutating, annotations: { readOnlyHint: !mutating, destructiveHint: mutating, idempotentHint: true, openWorldHint: true } });

/** The desktop agents and ChatGPT execute through the same discovered browser gateway. */
export function createDirectConnectedBrowserTools({ manager, execute = executeConnectedBrowser, connectChrome } = {}) {
  if (!manager) return [];
  return [
    {
      definition: definition('blackice_connected_browser_read', 'Discover connected native browsers and their actual tool schemas. Use connections first, then tools with a connectionId and optional query. Chrome, Neo, and imported profiles retain their own native browser sessions. This does not read the calling ChatGPT conversation or start a model.', 'browser:read', ['browser:read'], schema({ action: { enum: ['connections', 'tools'] }, connectionId: string(40), query: { type: 'string', maxLength: 256 } }, ['action']), false),
      execute: ({ requestId: _requestId, ...args }, { signal } = {}) => execute({ manager, ...args, signal, connectChrome }),
    },
    {
      definition: definition('blackice_connected_browser_action', 'Use a configured native browser through its discovered tools, or connect the existing Chrome session with connect_chrome. For call, provide connectionId, the discovered name, and arguments matching that tool schema. Existing sign-ins, extensions, and site storage belong to that native browser. Chrome may require its own connection prompt. Preserve unrelated tabs and the calling ChatGPT conversation. imageOutputPath optionally saves an exact returned image to a new absolute file. Inspect the page before claiming sign-in or a completed website action. No model is started.', 'browser:write', ['browser:write', 'files:read', 'files:write'], schema({ action: { enum: ['connect_chrome', 'call'] }, connectionId: string(40), name: string(200), arguments: { type: 'object', additionalProperties: true }, imageOutputPath: string(4096) }, ['action']), true),
      timeoutMs: 150000,
      // Keep arbitrary form input out of the durable request ledger. The full
      // input still participates in the idempotency digest and runs once.
      durableArguments: args => { const { arguments: input, ...metadata } = args; return { ...metadata, ...(input === undefined ? {} : { argumentsOmitted: true }) }; },
      execute: ({ requestId: _requestId, ...args }, { signal } = {}) => execute({ manager, ...args, signal, connectChrome }),
    },
  ];
}

const receipt = value => ({ success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(value) }] });

/** A refresh may replace only a previously generated connection for this import. */
function ownsProfileConnection(current, expected) {
  if (current.id !== expected.id || current.command !== expected.command || current.transport !== expected.transport || !Array.isArray(current.args)) return false;
  if (JSON.stringify(current.args) === JSON.stringify(expected.args)) return true;
  const prefix = '--userDataDir=', previous = current.args.filter(arg => arg.startsWith(prefix)), next = expected.args.filter(arg => arg.startsWith(prefix));
  if (previous.length !== 1 || next.length !== 1) return false;
  const previousPath = previous[0].slice(prefix.length), nextPath = next[0].slice(prefix.length), root = path.dirname(path.dirname(nextPath));
  const relative = path.relative(root, previousPath).split(path.sep).join('/');
  if (!new RegExp('^' + expected.id + '-[a-f0-9-]{36}/user-data$').test(relative)) return false;
  return JSON.stringify(current.args.map(arg => arg === previous[0] ? next[0] : arg)) === JSON.stringify(expected.args);
}

export function createDirectBrowserProfileTools({ profiles, manager, onChange = async () => {} } = {}) {
  if (!profiles || !manager) return [];
  return [
    {
      definition: definition('blackice_profile_list', 'List installed Chromium browser profiles and completed BLACKICE profile imports. Returns profile metadata and paths, never cookies or password values. Use the returned sourceId to import the complete selected profile, or connect Chrome to reuse its current live session.', 'files:read', ['files:read'], schema({}, []), false),
      execute: async () => receipt(await profiles.discover()),
    },
    {
      definition: definition('blackice_profile_import', 'Copy the selected Chromium profile and its root state into a separate BLACKICE profile for the same installed browser. Includes extensions and site storage; reports excluded runtime files. The source remains unchanged. A locked or changing source fails without replacing a completed import. Native encryption can prevent copied sign-ins from working; copying does not prove authentication. No model is started.', 'files:write', ['files:read', 'files:write'], schema({ sourceId: string(40) }, ['sourceId']), true),
      timeoutMs: null,
      execute: async ({ sourceId }, { signal } = {}) => { const result = await profiles.import({ sourceId, signal }); await onChange(); return receipt(result); },
    },
    {
      definition: definition('blackice_profile_connect', 'Connect a completed imported profile using its original installed browser executable. The same native browser connection becomes available to BLACKICE agents and ChatGPT. This launches the imported copy and leaves the original profile unchanged. A successful connection does not prove website sign-in; read the target site next.', 'browser:write', ['browser:write', 'commands:run'], schema({ importId: string(40) }, ['importId']), true),
      timeoutMs: 150000,
      execute: async ({ importId }, { signal } = {}) => {
        const config = await profiles.connection(importId);
        const current = manager.list().find(entry => entry.id === config.id);
        if (current?.enabled === false) throw Object.assign(new Error('This imported browser connection is disabled. Its configuration was preserved.'), { code: 'BROWSER_PROFILE_CONNECTION_DISABLED' });
        if (current && !ownsProfileConnection(current, config)) throw Object.assign(new Error('The import connection ID has a different tool configuration. Its settings were preserved.'), { code: 'BROWSER_PROFILE_CONNECTION_CONFLICT' });
        if (!current || ['command', 'transport'].some(key => current[key] !== config[key]) || JSON.stringify(current.args) !== JSON.stringify(config.args)) await manager.save(config);
        await manager.connect(config.id, { signal });
        const value = await manager.call(config.id, 'list_pages', {}, { signal });
        if (value?.isError) return { success: false, contentItems: [{ type: 'inputText', text: (value.content || []).filter(part => part.type === 'text' && typeof part.text === 'string').map(part => part.text).join('\n') || 'The native browser rejected the profile connection.' }] };
        if (!Array.isArray(value?.content) || !value.content.some(part => part.type === 'text' && typeof part.text === 'string' && part.text.trim())) throw Object.assign(new Error('The native browser did not confirm its page connection. The profile copy was preserved.'), { code: 'BROWSER_PROFILE_CONNECTION_UNVERIFIED' });
        await onChange();
        return receipt({ importId, connectionId: config.id, connected: true, accountAuthenticated: 'unknown', mode: 'imported-profile', inspectSiteBeforeClaimingSignIn: true });
      },
    },
  ];
}
