import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';

const PLUGIN_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';
const MCP_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const json = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const own = (value, key) => Object.hasOwn(value, key);
const fail = message => { throw new Error(message); };

function parse(files, name) {
  if (!files.has(name)) fail(`The existing plugin is missing ${name}.`);
  let value;
  try { value = JSON.parse(files.get(name).toString('utf8')); }
  catch { fail(`${name} must contain valid JSON.`); }
  if (!object(value)) fail(`${name} must contain a JSON object.`);
  return value;
}

// Keep format-only additions such as legacy headers: {}. Conflicting endpoint,
// auth, scopes, or transport settings require an explicit source correction.
function combineDefinitions(portable, legacy, location) {
  if (isDeepStrictEqual(portable, legacy)) return structuredClone(portable);
  if (!object(portable) || !object(legacy)) fail(`Portable and legacy MCP configuration disagree at ${location}.`);
  return Object.fromEntries([...new Set([...Object.keys(portable), ...Object.keys(legacy)])].map(key => [key,
    !own(portable, key) ? structuredClone(legacy[key]) : !own(legacy, key) ? structuredClone(portable[key])
      : combineDefinitions(portable[key], legacy[key], `${location}.${key}`),
  ]));
}

function selectedServer(config, requestedName, appName, filename) {
  if (!object(config.mcpServers)) fail(`${filename} must declare mcpServers.`);
  const sourceName = own(config.mcpServers, requestedName) ? requestedName : appName;
  const definition = config.mcpServers[sourceName];
  if (!object(definition)) fail(`${filename} does not contain the selected direct MCP fallback.`);
  if (sourceName !== appName && own(config.mcpServers, appName)
      && !isDeepStrictEqual(definition, config.mcpServers[appName])) {
    fail(`${filename} already has a different MCP server named ${appName}.`);
  }
  return { sourceName, definition };
}

function alignServer(config, sourceName, appName, definition) {
  // The host selects the App route by declaration name. An identically named
  // direct MCP route remains available to clients without hosted App support.
  const entries = Object.entries(config.mcpServers).filter(([name]) => sourceName === appName || name !== appName);
  config.mcpServers = Object.fromEntries(entries.map(([name, value]) => name === sourceName
    ? [appName, structuredClone(definition)] : [name, value]));
}

/** Build package data only. No connection, permission, OAuth, or runtime state is touched. */
export function canonicalChatGPTPlugin(files, { appId, serverName = 'blackice-direct', version } = {}) {
  if (!(files instanceof Map)) fail('Supply the existing package as a map of relative paths to bytes.');
  const output = new Map([...files].map(([name, bytes]) => [name, Buffer.from(bytes)]));
  const plugin = parse(output, 'plugin.json'), legacy = parse(output, '.codex-plugin/plugin.json');
  const apps = parse(output, '.app.json'), portableMcp = parse(output, 'mcp.json'), legacyMcp = parse(output, '.mcp.json');
  if (plugin.$schema !== PLUGIN_SCHEMA || portableMcp.$schema !== MCP_SCHEMA) fail('Use the existing portable plugin and MCP schemas.');
  if (typeof plugin.name !== 'string' || !plugin.name || legacy.name !== plugin.name) fail('Portable and legacy plugin identities must match.');
  const openai = plugin.extensions?.['com.openai'];
  if (!object(openai) || openai.apps !== './.app.json' || legacy.apps !== './.app.json') fail('Both manifests must retain the existing .app.json binding.');
  if (legacy.mcpServers !== './.mcp.json') fail('The compatibility manifest must reference the existing .mcp.json.');
  if (!object(apps.apps)) fail('.app.json must declare the existing App binding.');
  const matches = Object.entries(apps.apps).filter(([, value]) => object(value) && (appId === undefined || value.id === appId));
  if (matches.length !== 1) fail('Select exactly one existing App ID; no App ID is created or replaced by this builder.');
  const [appName, app] = matches[0];
  if (typeof app.id !== 'string' || !/^(?:asdk_app_|connector_|templated_apps_)[A-Za-z0-9][A-Za-z0-9_-]*$/.test(app.id)) fail('The selected App binding must contain its verified App ID.');
  if (typeof serverName !== 'string' || !serverName) fail('Select the existing direct MCP server name.');
  const portable = selectedServer(portableMcp, serverName, appName, 'mcp.json');
  const compatibility = selectedServer(legacyMcp, serverName, appName, '.mcp.json');
  const server = combineDefinitions(portable.definition, compatibility.definition, 'selected server');
  if (!['streamable-http', 'sse'].includes(server.type) || typeof server.url !== 'string') fail('The existing fallback must use its remote MCP transport and URL.');
  let endpoint;
  try { endpoint = new URL(server.url); } catch { fail('The existing fallback endpoint is invalid.'); }
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.hash) fail('Use the verified HTTPS endpoint without embedded credentials or fragments.');
  if (server.auth !== undefined || server.server_url !== undefined) fail('Keep portable authentication under extensions.com.openai and use url.');
  const auth = server.extensions?.['com.openai']?.auth;
  if (!object(auth) || auth.type !== 'oauth' || auth.client?.mode !== 'cimd') fail('Preserve the existing OAuth/CIMD configuration.');
  for (const key of ['baseScopes', 'defaultScopes']) {
    if (!Array.isArray(auth[key]) || auth[key].some(scope => typeof scope !== 'string' || !scope.trim())) fail(`Preserve the existing OAuth ${key}.`);
  }
  alignServer(portableMcp, portable.sourceName, appName, server);
  alignServer(legacyMcp, compatibility.sourceName, appName, server);

  if (version !== undefined) {
    if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) fail('Supply a semantic plugin version.');
    plugin.version = version;
  }
  for (const key of ['name', 'version', 'description', 'author', 'homepage', 'repository', 'license', 'keywords']) {
    if (own(plugin, key)) legacy[key] = structuredClone(plugin[key]);
  }
  if (!object(openai.interface)) fail('Keep the existing portable plugin presentation.');
  // The portable manifest owns shared presentation; retain legacy-only fields.
  openai.interface = { ...(object(legacy.interface) ? legacy.interface : {}), ...openai.interface };
  legacy.interface = structuredClone(openai.interface);
  for (const [name, value] of [['plugin.json', plugin], ['.codex-plugin/plugin.json', legacy], ['mcp.json', portableMcp], ['.mcp.json', legacyMcp]]) output.set(name, json(value));
  return { files: output, receipt: {
    name: plugin.name, version: plugin.version, appId: app.id, appName, endpoint: server.url,
    directServerBefore: portable.sourceName, directServerAfter: appName,
    hostedAppIdentityChanged: false, directClientIdentityChanged: portable.sourceName !== appName,
    baseScopes: [...auth.baseScopes], defaultScopes: [...auth.defaultScopes],
  } };
}

async function readDirectory(directory) {
  const files = new Map();
  async function visit(relative = '') {
    for (const entry of (await fs.readdir(path.join(directory, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = path.posix.join(relative, entry.name);
      if (entry.isSymbolicLink()) fail(`Plugin packages cannot contain symbolic links: ${name}`);
      if (entry.isDirectory()) await visit(name);
      else if (entry.isFile()) files.set(name, await fs.readFile(path.join(directory, name)));
      else fail(`Unsupported plugin file type: ${name}`);
    }
  }
  await visit();
  return files;
}

export async function buildChatGPTPlugin({ source, output, ...options }) {
  if (typeof source !== 'string' || typeof output !== 'string') fail('Supply source and output directories.');
  const sourceRoot = await fs.realpath(source), outputRoot = path.resolve(output);
  const relative = path.relative(sourceRoot, outputRoot);
  if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) fail('Write the generated package outside its existing source directory.');
  const built = canonicalChatGPTPlugin(await readDirectory(sourceRoot), options);
  await fs.mkdir(outputRoot); // Never replace a prior output or edit the source.
  try {
    for (const [name, bytes] of built.files) {
      await fs.mkdir(path.dirname(path.join(outputRoot, name)), { recursive: true });
      await fs.writeFile(path.join(outputRoot, name), bytes, { flag: 'wx' });
    }
  } catch (error) {
    await fs.rm(outputRoot, { recursive: true, force: true });
    throw error;
  }
  return { ...built.receipt, output: outputRoot, files: [...built.files].map(([name, bytes]) => ({ path: name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })) };
}

async function main(args) {
  const options = {};
  const names = new Map([['--source', 'source'], ['--output', 'output'], ['--app-id', 'appId'], ['--server', 'serverName'], ['--version', 'version']]);
  if (args.length === 1 && args[0] === '--help') {
    console.log('Usage: node scripts/build-chatgpt-plugin.mjs --source EXISTING_PACKAGE --output NEW_DIRECTORY [--app-id EXISTING_APP_ID] [--server EXISTING_MCP_NAME] [--version VERSION]');
    return;
  }
  for (let index = 0; index < args.length; index += 2) {
    const key = names.get(args[index]), value = args[index + 1];
    if (!key || !value || value.startsWith('--') || own(options, key)) fail('Use --help for supported builder arguments.');
    options[key] = value;
  }
  console.log(JSON.stringify(await buildChatGPTPlugin(options), null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
