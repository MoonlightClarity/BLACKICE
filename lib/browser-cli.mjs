import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { readAccessRuntime, inspectAccessRuntime, validateRuntimeOwnership } from './remote-access-cli.mjs';

const fail = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const terminal = new Set(['succeeded', 'failed', 'cancelled', 'interrupted', 'awaiting_input']);
export const BROWSER_CLI_HELP = `BLACKICE browser commands

  BLACKICE browser connections
  BLACKICE browser connect-chrome --request-id=ID
  BLACKICE browser tools --connection=ID [--query=TEXT]
  BLACKICE browser call --connection=ID --tool=NAME --arguments-file=PATH --request-id=ID
                       [--image-output=PATH]
  BLACKICE browser profiles
  BLACKICE browser import-profile --source=ID --request-id=ID
  BLACKICE browser connect-profile --import=ID --request-id=ID
  BLACKICE browser job --job-id=ID

Use --profile-dir=PATH to select the running BLACKICE profile.
The installed scripts/browser-cli.mjs also works with Electron's Node mode.
All commands return JSON. Calls use the same browser connections and durable
action receipts as ChatGPT and BLACKICE agents. No model is started.
Discover tools before calling them. A repeated request ID with identical input
reads the saved receipt; changed input requires a different ID.
Chrome's existing-session connection retains its real browser profile.
Profile import makes a separate copy, leaving the source untouched.
`;

export function desktopBrowserArgs(argv = process.argv, { packaged = true } = {}) {
  const args = argv.slice(packaged ? 1 : 2);
  return args[0] === 'browser' ? args : null;
}

export function parseBrowserArgs(argv) {
  if (!Array.isArray(argv) || argv.some(value => typeof value !== 'string')) throw fail('BROWSER_CLI_ARGUMENTS', 'Use BLACKICE browser --help.');
  const args = [...argv]; if (args[0] === 'browser') args.shift();
  const command = args.shift() || 'help';
  if (['help', '--help', '-h'].includes(command)) return { command: 'help' };
  const byCommand = {
    connections: [], 'connect-chrome': ['request-id'], tools: ['connection', 'query'],
    call: ['connection', 'tool', 'arguments-file', 'request-id', 'image-output'],
    profiles: [], 'import-profile': ['source', 'request-id'], 'connect-profile': ['import', 'request-id'], job: ['job-id'],
  };
  if (!Object.hasOwn(byCommand, command)) throw fail('BROWSER_CLI_ARGUMENTS', 'Choose a supported browser command. See browser --help.');
  const result = { command }, allowed = new Set([...byCommand[command], 'profile-dir', 'json']);
  for (let index = 0; index < args.length; index++) {
    const raw = args[index], match = raw.match(/^--([a-z-]+)(?:=(.*))?$/s);
    if (!match || !allowed.has(match[1]) || Object.hasOwn(result, match[1])) throw fail('BROWSER_CLI_ARGUMENTS', 'A browser option is unsupported or repeated. See browser --help.');
    const name = match[1];
    if (name === 'json') { if (match[2] !== undefined) throw fail('BROWSER_CLI_ARGUMENTS', 'Use --json without a value.'); result.json = true; continue; }
    const value = match[2] ?? args[++index];
    if (!value || value.startsWith('--') || /[\x00-\x1f\x7f]/.test(value)) throw fail('BROWSER_CLI_ARGUMENTS', `Supply a value for --${name}.`);
    result[name] = value;
  }
  const required = { 'connect-chrome': ['request-id'], tools: ['connection'], call: ['connection', 'tool', 'arguments-file', 'request-id'], 'import-profile': ['source', 'request-id'], 'connect-profile': ['import', 'request-id'], job: ['job-id'] }[command] || [];
  if (required.some(key => !result[key])) throw fail('BROWSER_CLI_ARGUMENTS', `The ${command} command requires ${required.map(key => '--' + key).join(', ')}.`);
  if (result['request-id'] && !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/.test(result['request-id'])) throw fail('BROWSER_CLI_ARGUMENTS', 'Use a stable request ID of at most 120 letters, digits, periods, colons, underscores, or hyphens.');
  if (result['job-id'] && !/^direct_[a-f0-9]{64}$/.test(result['job-id'])) throw fail('BROWSER_CLI_ARGUMENTS', 'Use the exact job ID returned by BLACKICE.');
  return result;
}

const defaultProfile = ({ platform = process.platform, env = process.env, home = os.homedir() } = {}) => platform === 'win32' ? path.win32.join(env.APPDATA || path.win32.join(home, 'AppData', 'Roaming'), 'Relay') : platform === 'darwin' ? path.join(home, 'Library', 'Application Support', 'Relay') : path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Relay');

async function fetchBounded(url, options, context, maximum = 2500000) {
  let response;
  try { response = await (context.fetchImpl || fetch)(url, { ...options, redirect: 'error', cache: 'no-store', signal: context.signal }); }
  catch { throw fail(options.method === 'POST' ? 'BROWSER_CLI_UNCERTAIN' : 'BROWSER_CLI_UNREACHABLE', options.method === 'POST' ? 'The browser command may have been admitted. Retry the identical command with the same request ID to read its receipt.' : 'The running BLACKICE instance could not be reached.'); }
  const chunks = []; let size = 0;
  if (response.body) for await (const chunk of response.body) { const bytes = Buffer.from(chunk); size += bytes.length; if (size > maximum) throw fail('BROWSER_CLI_RESPONSE', 'BLACKICE returned an oversized response. Inspect the existing job; do not repeat the action with a new ID.'); chunks.push(bytes); }
  return { response, text: Buffer.concat(chunks).toString('utf8') };
}

/** Establish the app's normal local session, without reading any stored key. */
export async function connectBrowserCLI(options, context = {}) {
  const platform = context.platform || process.platform, paths = platform === 'win32' ? path.win32 : path;
  const profile = options['profile-dir'] || context.defaultProfile || defaultProfile(context);
  if (!paths.isAbsolute(profile)) throw fail('BROWSER_CLI_PROFILE', 'Choose an absolute BLACKICE profile directory.');
  const runtime = await readAccessRuntime(profile, { platform, expectedExecutable: context.expectedExecutable });
  const inspect = context.inspectRuntime || inspectAccessRuntime;
  validateRuntimeOwnership(runtime, await inspect(runtime, context), platform);
  const headers = { Origin: runtime.url, Accept: 'application/json' };
  const page = await fetchBounded(runtime.url + '/', { headers: { ...headers, Accept: 'text/html' } }, context);
  if (!page.response.ok) throw fail('BROWSER_CLI_SESSION', 'BLACKICE could not establish its normal local session.');
  const cookies = page.response.headers.getSetCookie?.() || [page.response.headers.get('set-cookie') || ''];
  const prefix = `relay_session_${new URL(runtime.url).port}=`, matches = cookies.filter(value => value.startsWith(prefix));
  const cookie = matches.length === 1 ? matches[0].split(';')[0] : '';
  if (!new RegExp('^' + prefix + '[a-f0-9]{64}$').test(cookie)) throw fail('BROWSER_CLI_SESSION', 'BLACKICE did not issue its normal local session.');
  headers.Cookie = cookie;
  async function request(route, value) {
    const output = await fetchBounded(runtime.url + route, { method: value === undefined ? 'GET' : 'POST', headers: { ...headers, ...(value === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) }, context);
    let result; try { result = JSON.parse(output.text); } catch { throw fail('BROWSER_CLI_RESPONSE', 'BLACKICE returned an invalid response. Inspect the existing job before repeating the action.'); }
    if (!output.response.ok) throw fail(typeof result.code === 'string' ? result.code : 'BROWSER_CLI_REJECTED', typeof result.error === 'string' ? result.error : 'BLACKICE rejected the browser command.');
    return result;
  }
  const status = await request('/api/status');
  if (status.app !== 'relay-agent-harness' || status.version !== runtime.version || status.desktopApp !== true || status.remoteAccess?.client !== 'local') throw fail('BROWSER_CLI_RUNTIME', 'The local session does not match the selected BLACKICE desktop instance.');
  const latest = await readAccessRuntime(profile, { platform, expectedExecutable: context.expectedExecutable });
  if (JSON.stringify(latest) !== JSON.stringify(runtime)) throw fail('BROWSER_CLI_RUNTIME', 'BLACKICE restarted while the command connected. Retry the same request ID.');
  validateRuntimeOwnership(latest, await inspect(latest, context), platform);
  return { request, runtime };
}

export async function browserCLIRequest(options, context = {}) {
  const { command } = options, requestId = options['request-id'] || `browser-cli-${randomUUID()}`;
  if (command === 'job') return { jobId: options['job-id'] };
  if (command === 'connections') return { tool: 'blackice_connected_browser_read', arguments: { requestId, action: 'connections' } };
  if (command === 'tools') return { tool: 'blackice_connected_browser_read', arguments: { requestId, action: 'tools', connectionId: options.connection, ...(options.query ? { query: options.query } : {}) } };
  if (command === 'connect-chrome') return { tool: 'blackice_connected_browser_action', arguments: { requestId, action: 'connect_chrome' } };
  if (command === 'profiles') return { tool: 'blackice_profile_list', arguments: { requestId } };
  if (command === 'import-profile') return { tool: 'blackice_profile_import', arguments: { requestId, sourceId: options.source } };
  if (command === 'connect-profile') return { tool: 'blackice_profile_connect', arguments: { requestId, importId: options.import } };
  if (command === 'call') {
    const file = path.resolve(options['arguments-file']), info = await fs.stat(file);
    if (!info.isFile() || info.size > 100000) throw fail('BROWSER_CLI_INPUT', 'Use a JSON arguments file of at most 100,000 bytes.');
    let args; try { args = JSON.parse(await fs.readFile(file, 'utf8')); } catch { throw fail('BROWSER_CLI_INPUT', 'The arguments file must contain a JSON object.'); }
    if (!plain(args)) throw fail('BROWSER_CLI_INPUT', 'The arguments file must contain a JSON object.');
    return { tool: 'blackice_connected_browser_action', arguments: { requestId, action: 'call', connectionId: options.connection, name: options.tool, arguments: args, ...(options['image-output'] ? { imageOutputPath: path.resolve(options['image-output']) } : {}) } };
  }
  throw fail('BROWSER_CLI_ARGUMENTS', 'Choose a supported browser command.');
}

export async function executeBrowserCLI(options, context = {}) {
  const input = await browserCLIRequest(options, context);
  const { request } = await (context.connect || connectBrowserCLI)(options, context);
  let job = input.jobId ? await request('/api/browser/commands/' + input.jobId) : await request('/api/browser/commands', input);
  const deadline = Date.now() + (context.waitMs ?? 85000);
  while (options.command !== 'job' && !terminal.has(job.status) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, context.pollMs ?? 200));
    job = await request('/api/browser/commands/' + job.jobId);
  }
  if (job.result?.text?.nextOffset != null) {
    let text = job.result.text.text, offset = job.result.text.nextOffset;
    while (offset != null) {
      const page = await request('/api/browser/commands/' + job.jobId + '?offset=' + offset);
      if (page.revision !== job.revision || page.result?.text?.offset !== offset) throw fail('BROWSER_CLI_RESULT_CHANGED', 'The browser job changed while reading its result. Inspect the same job again.');
      text += page.result.text.text; offset = page.result.text.nextOffset;
    }
    job = { ...job, result: { ...job.result, text: { ...job.result.text, text, limit: text.length, nextOffset: null } } };
  }
  return job;
}

export async function runBrowserCLI(argv, context = {}) {
  const stdout = context.stdout || process.stdout, stderr = context.stderr || process.stderr;
  try {
    const options = parseBrowserArgs(argv);
    if (options.command === 'help') { stdout.write(BROWSER_CLI_HELP); return 0; }
    const result = await executeBrowserCLI(options, context); stdout.write(JSON.stringify(result) + '\n');
    return ['failed', 'cancelled', 'interrupted'].includes(result.status) ? 1 : 0;
  } catch (error) { stderr.write(JSON.stringify({ error: error.message, code: error.code || 'BROWSER_CLI_FAILED' }) + '\n'); return 1; }
}
