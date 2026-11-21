import { executeConnectedBrowser } from './mcp.mjs';
import { pinnedChromeMcpArguments } from './chrome-browser-policy.mjs';

const string = maxLength => ({ type: 'string', minLength: 1, maxLength });
const requestId = { ...string(120), pattern: '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$', description: 'Stable ID for this exact action under the current connector connectionId. Inspect the saved job after uncertainty; an identical same-ID retry does not execute twice.' };
const schema = (properties, required) => ({ type: 'object', properties: { requestId, ...properties }, required: ['requestId', ...required], additionalProperties: false });
const definition = (name, description, scope, requiredScopes, inputSchema, mutating) => ({ name, description, scope, requiredScopes, inputSchema, mutating, annotations: { readOnlyHint: !mutating, destructiveHint: mutating, idempotentHint: true, openWorldHint: true } });

/** The desktop agents and ChatGPT execute through the same discovered browser gateway. */
export function createDirectConnectedBrowserTools({ manager, execute = executeConnectedBrowser, connectChrome } = {}) {
  if (!manager) return [];
  return [
    {
      definition: definition('blackice_connected_browser_read', "Inspect configured browser connections. action:\"connections\" lists them; action:\"tools\" with connectionId returns that connection's current tool schemas, optionally filtered by query. Use those returned schemas for calls; each browser keeps its own sign-ins and storage. This action does not start a model.", 'browser:read', ['browser:read'], schema({ action: { enum: ['connections', 'tools'] }, connectionId: string(40), query: { type: 'string', maxLength: 256 } }, ['action']), false),
      execute: ({ requestId: _requestId, ...args }, { signal } = {}) => execute({ manager, ...args, signal, connectChrome }),
    },
    {
      definition: definition('blackice_connected_browser_action', "Call a configured browser's tool. First read its current schemas with blackice_connected_browser_read. For action:\"call\", supply connectionId, the returned tool name and arguments matching that schema. imageOutputPath optionally saves a returned image to a new absolute path.\naction:\"connect_chrome\" connects the existing Chrome session; Chrome may show its own connection prompt. Inspect the resulting page state to confirm the website action.", 'browser:write', ['browser:write', 'files:read', 'files:write'], schema({ action: { enum: ['connect_chrome', 'call'] }, connectionId: string(40), name: string(200), arguments: { type: 'object', additionalProperties: true }, imageOutputPath: string(4096) }, ['action']), true),
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
async function ownsProfileConnection(current, expected, profiles) {
  if (current.id !== expected.id || current.command !== expected.command || current.transport !== expected.transport || !Array.isArray(current.args)) return false;
  if (JSON.stringify(current.args) === JSON.stringify(expected.args)) return true;
  const args = pinnedChromeMcpArguments(current.args);
  if (JSON.stringify(args) === JSON.stringify(expected.args)) return true;
  const prefix = '--userDataDir=', previous = args.filter(arg => arg.startsWith(prefix)), next = expected.args.filter(arg => arg.startsWith(prefix));
  if (previous.length !== 1 || next.length !== 1) return false;
  const previousPath = previous[0].slice(prefix.length);
  if (typeof profiles.ownsSnapshot !== 'function' || !await profiles.ownsSnapshot(expected.id, previousPath)) return false;
  return JSON.stringify(args.map(arg => arg === previous[0] ? next[0] : arg)) === JSON.stringify(expected.args);
}

export function createDirectBrowserProfileTools({ profiles, manager, onChange = async () => {} } = {}) {
  if (!profiles || !manager) return [];
  return [
    {
      definition: definition('blackice_profile_list', "List installed Chromium profiles and completed BLACKICE imports. Returns profile metadata, sourceIds and paths, without cookie/password values. Use a sourceId with blackice_profile_import; use an importId with blackice_profile_connect.", 'files:read', ['files:read'], schema({}, []), false),
      execute: async () => receipt(await profiles.discover()),
    },
    {
      definition: definition('blackice_profile_import', "Copy sourceId from blackice_profile_list into a separate BLACKICE profile for the same installed browser, including extensions and site storage. The source is unchanged. The result lists excluded runtime files; a locked or changing source fails without replacing a completed import. Copied sign-ins may be unusable because of native encryption; inspect the target site after connecting.", 'files:write', ['files:read', 'files:write'], schema({ sourceId: string(40) }, ['sourceId']), true),
      timeoutMs: null,
      execute: async ({ sourceId }, { signal } = {}) => { const result = await profiles.import({ sourceId, signal }); await onChange(); return receipt(result); },
    },
    {
      definition: definition('blackice_profile_connect', "Launch a completed importId with its original browser executable and expose its connection to BLACKICE tools. The original profile remains unchanged. Returns connectionId; inspect the target site to check its saved sign-in.", 'browser:write', ['browser:write', 'commands:run'], schema({ importId: string(40) }, ['importId']), true),
      timeoutMs: 150000,
      execute: async ({ importId }, { signal } = {}) => {
        const config = await profiles.connection(importId);
        const current = manager.list().find(entry => entry.id === config.id);
        if (current?.enabled === false) throw Object.assign(new Error('This imported browser connection is disabled. Its configuration was preserved.'), { code: 'BROWSER_PROFILE_CONNECTION_DISABLED' });
        if (current && !await ownsProfileConnection(current, config, profiles)) throw Object.assign(new Error('The import connection ID has a different tool configuration. Its settings were preserved.'), { code: 'BROWSER_PROFILE_CONNECTION_CONFLICT' });
        const changed = !current || ['command', 'transport'].some(key => current[key] !== config[key]) || JSON.stringify(current.args) !== JSON.stringify(config.args);
        if (changed && current?.connected) throw Object.assign(new Error('The imported browser is connected. Finish active work and disconnect it before updating its managed configuration.'), { code: 'BROWSER_PROFILE_CONNECTION_ACTIVE' });
        if (changed) await manager.save(config);
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
