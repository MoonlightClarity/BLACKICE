import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isatty } from 'node:tty';
import { Socket } from 'node:net';
import { validatePairingOptions, validateRemoteScopes } from './remote-access-auth.mjs';

const executeFile = promisify(execFile);
const fail = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const validName = value => typeof value === 'string' && value.trim() && value.trim().length <= 80 && !/[\x00-\x1f\x7f]/.test(value);
const codePattern = /^(?:[A-F0-9]{4}-){7}[A-F0-9]{4}$/;
const tokenPattern = /^blackice_agent_[A-Za-z0-9_-]{43}$/;
const pathsFor = platform => platform === 'win32' ? path.win32 : path.posix;
const samePath = (a, b, platform) => typeof a === 'string' && typeof b === 'string' && (platform === 'win32' ? path.win32.resolve(a).toLowerCase() === path.win32.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b));

export const REMOTE_ACCESS_CLI_HELP = [
  'BLACKICE remote access',
  '',
  '  BLACKICE --access-code [--kind browser|agent] [--scope=NAME] [--json]',
  '  BLACKICE remote code [--kind browser|agent] [--scope=NAME] [--json]',
  '  BLACKICE remote pair --url=HTTPS_ORIGIN --code-stdin [--name=NAME] [--json]',
  '                      [--output CONNECTION.json]',
  '',
  'Host code commands use the running desktop or headless instance.',
  'Use --profile-dir ABSOLUTE_PATH to select an existing custom host profile.',
  'Remote access must already be enabled; these commands do not expose a server.',
  'Browser codes are the default. A paired agent can use all BLACKICE actions.',
  'The old --scope option is accepted for compatibility but does not restrict agent actions.',
  'Use --url= and --name= forms with the Windows executable.',
  'Codes work once and expire after five minutes. Connected agents have the same capabilities.',
  '',
  'Pipe the code into remote pair; it never accepts a code in command arguments.',
  '--json returns the agent credential once unless --output is also provided.',
  '--output uses an exclusive private file in your BLACKICE connections directory.',
  'Without --json, pairing saves a private connection automatically.',
  'The installed Electron Node-mode helper accepts these same remote commands.',
  '',
].join('\n');

/** Detect before profile initialization or single-instance activation. */
export function desktopRemoteAccessArgs(argv = process.argv, { packaged = true } = {}) {
  const args = argv.slice(packaged ? 1 : 2);
  if (args[0] === 'remote' || args.some(value => value === '--access-code' || value.startsWith('--access-code='))) return args;
  return null;
}

export function parseRemoteAccessArgs(argv, { platform = process.platform } = {}) {
  if (!Array.isArray(argv) || argv.some(value => typeof value !== 'string')) throw fail('ACCESS_ARGUMENTS', 'Use BLACKICE remote --help.');
  const args = [...argv];
  if (args[0] === 'remote') args.shift();
  const alias = args.indexOf('--access-code');
  if (alias >= 0) { args.splice(alias, 1); args.unshift('code'); }
  if (!args.length || args.length === 1 && ['--help', '-h', 'help'].includes(args[0])) return { command: 'help' };
  const command = args.shift();
  if (!['code', 'pair'].includes(command)) throw fail('ACCESS_ARGUMENTS', 'Use BLACKICE remote code or BLACKICE remote pair. See remote --help.');
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) return { command: 'help' };
  const options = { command, json: false }, scopes = [], seen = new Set();
  const allowed = command === 'code' ? ['--json', '--kind', '--scope', '--profile', '--profile-dir'] : ['--json', '--url', '--code-stdin', '--name', '--output'];
  for (let index = 0; index < args.length; index++) {
    const raw = args[index], separator = raw.indexOf('='), flag = separator < 0 ? raw : raw.slice(0, separator);
    if (!allowed.includes(flag)) throw fail('ACCESS_ARGUMENTS', 'An access command option is unsupported. See remote --help.');
    const key = flag === '--profile' ? '--profile-dir' : flag;
    if (key !== '--scope' && seen.has(key)) throw fail('ACCESS_ARGUMENTS', 'Choose each access command option only once.');
    seen.add(key);
    if (['--json', '--code-stdin'].includes(flag)) {
      if (separator >= 0) throw fail('ACCESS_ARGUMENTS', 'Use --json and --code-stdin without a value.');
      options[flag === '--json' ? 'json' : 'codeStdin'] = true; continue;
    }
    const value = separator < 0 ? args[++index] : raw.slice(separator + 1);
    if (!value || value.startsWith('--') || /[\x00-\x1f\x7f]/.test(value)) throw fail('ACCESS_ARGUMENTS', 'An access command option needs a valid value. See remote --help.');
    if (flag === '--scope') scopes.push(value);
    else options[key.slice(2).replace('-dir', 'Dir')] = value;
  }
  if (command === 'code') {
    try { Object.assign(options, validatePairingOptions({ ...(options.kind ? { kind: options.kind } : {}), ...(scopes.length ? { scopes } : {}) })); }
    catch { throw fail('ACCESS_ARGUMENTS', 'Use browser or agent pairing. Per-action permissions are not configurable.'); }
    if (options.profileDir) options.profileDir = localDirectory(options.profileDir, platform);
  } else {
    if (!options.url || !options.codeStdin) throw fail('ACCESS_ARGUMENTS', 'Pair with --url=HTTPS_ORIGIN --code-stdin. Pipe the code into standard input.');
    options.url = exactHttpsOrigin(options.url);
    options.name = options.name ?? 'Paired agent';
    if (!validName(options.name)) throw fail('ACCESS_ARGUMENTS', 'Use an agent name of 1 to 80 characters.');
    options.name = options.name.trim();
    if (options.output && !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,74}\.json$/.test(options.output)) throw fail('ACCESS_OUTPUT_NAME', 'Use --output with a connection filename such as my-agent.json. BLACKICE stores it in your private connections directory.');
  }
  return options;
}

function localDirectory(value, platform) {
  const paths = pathsFor(platform);
  if (typeof value !== 'string' || value.trim() !== value || /[\x00-\x1f\x7f]/.test(value) || !paths.isAbsolute(value) || platform === 'win32' && (!/^[a-z]:[\\/]/i.test(value) || /^[\\/]{2}/.test(value))) throw fail('ACCESS_PROFILE', 'Use an absolute local BLACKICE profile directory.');
  const normalized = paths.normalize(value);
  if (normalized === paths.parse(normalized).root) throw fail('ACCESS_PROFILE', 'Use a BLACKICE profile directory inside a local drive.');
  return normalized;
}

function exactHttpsOrigin(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash || !url.hostname || ![url.origin, url.origin + '/'].includes(value)) throw Error();
    return url.origin;
  } catch { throw fail('ACCESS_URL', 'Use the exact BLACKICE HTTPS address without a path, code, username, or password.'); }
}

async function ordinaryDirectory(directory) {
  for (let current = directory; ; current = path.dirname(current)) {
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw fail('ACCESS_PROFILE', 'BLACKICE access files require an ordinary local directory without symbolic links.');
    if (current === path.dirname(current)) break;
  }
}

export async function readAccessRuntime(profile, { platform = process.platform, expectedExecutable } = {}) {
  let handle;
  try {
    await ordinaryDirectory(profile);
    const file = path.join(profile, 'desktop-runtime.json'), before = await fs.lstat(file);
    if (before.isSymbolicLink() || !before.isFile() || before.size > 16384) throw Error();
    handle = await fs.open(file, 'r');
    const stat = await handle.stat();
    if (stat.dev !== before.dev || stat.ino !== before.ino || !stat.isFile() || stat.size > 16384) throw Error();
    const value = JSON.parse(await handle.readFile('utf8')), url = new URL(value.url);
    if (!Number.isSafeInteger(value.pid) || value.pid <= 0 || !pathsFor(platform).isAbsolute(value.executable || '') || !Number.isFinite(Date.parse(value.startedAt)) || typeof value.version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(value.version) || value.capabilities?.electron !== true || !['custom', 'default'].includes(value.profileMode) || url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || Number(url.port) < 1024 || url.username || url.password || url.pathname !== '/' || url.search || url.hash || ![url.origin, url.origin + '/'].includes(value.url)) throw Error();
    if (expectedExecutable && !samePath(value.executable, expectedExecutable, platform)) throw Error();
    return { pid: value.pid, executable: value.executable, startedAt: value.startedAt, version: value.version, profileMode: value.profileMode, url: url.origin, profile };
  } catch (cause) {
    if (cause.code === 'ENOENT') throw fail('ACCESS_HOST_NOT_RUNNING', 'BLACKICE is not running in this profile. Start the desktop or headless app, then run the command again.');
    throw fail('ACCESS_RUNTIME_INVALID', 'The running BLACKICE profile could not be verified. Start the intended BLACKICE instance and try again.');
  } finally { await handle?.close(); }
}

const OWNER_SCRIPT = [
  '$ErrorActionPreference="Stop"',
  '$taskPid=[int]$env:BLACKICE_ACCESS_PID; $taskPort=[int]$env:BLACKICE_ACCESS_PORT',
  '$taskProcess=Get-Process -Id $taskPid -ErrorAction Stop',
  '$taskListeners=@(Get-NetTCPConnection -State Listen -LocalPort $taskPort -ErrorAction Stop | ForEach-Object { @{address=$_.LocalAddress;pid=[int]$_.OwningProcess} })',
  '@{pid=[int]$taskProcess.Id;executable=$taskProcess.Path;startedAt=$taskProcess.StartTime.ToUniversalTime().ToString("o");listeners=$taskListeners}|ConvertTo-Json -Depth 4 -Compress',
].join(';');

export async function inspectAccessRuntime(runtime, { platform = process.platform, env = process.env, signal } = {}) {
  if (platform !== 'win32') throw fail('ACCESS_HOST_PLATFORM', 'Host instance discovery is currently supported by the Windows BLACKICE app. Agent code redemption works independently with remote pair.');
  try {
    const result = await executeFile(path.win32.join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', OWNER_SCRIPT], { windowsHide: true, shell: false, timeout: 10000, maxBuffer: 16384, signal, env: { ...env, BLACKICE_ACCESS_PID: String(runtime.pid), BLACKICE_ACCESS_PORT: new URL(runtime.url).port } });
    return JSON.parse(result.stdout.replace(/^\uFEFF/, '').trim());
  } catch { throw fail('ACCESS_HOST_NOT_RUNNING', 'The running BLACKICE process and its local listener could not be verified. Start BLACKICE in the selected profile and try again.'); }
}

export function validateRuntimeOwnership(runtime, observed, platform = process.platform) {
  if (!plain(observed) || observed.pid !== runtime.pid || !samePath(observed.executable, runtime.executable, platform) || !Number.isFinite(Date.parse(observed.startedAt)) || Math.abs(Date.parse(observed.startedAt) - Date.parse(runtime.startedAt)) > 5000 || !Array.isArray(observed.listeners) || !observed.listeners.length || observed.listeners.some(listener => listener.pid !== runtime.pid || !['127.0.0.1', '::1'].includes(listener.address))) throw fail('ACCESS_RUNTIME_OWNERSHIP', 'The BLACKICE runtime record does not match the process owning its local listener. No code was requested.');
}

async function responseText(response, limit = 65536) {
  const chunks = []; let length = 0;
  if (response.body) for await (const chunk of response.body) {
    const data = Buffer.from(chunk); length += data.length;
    if (length > limit) throw fail('ACCESS_RESPONSE_INVALID', 'The access service returned an invalid response.');
    chunks.push(data);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const serviceErrors = {
  REMOTE_PAIRING_INVALID: 'The code is invalid, expired, already used, or intended for a browser. Ask the host for a fresh agent code.',
  REMOTE_NOT_ENABLED: 'Remote access is not enabled. Enable it in BLACKICE Settings → Remote access on the host, then create a code.',
  REMOTE_DEVICE_LIMIT: 'The host has reached its paired client limit. Remove an unused client in BLACKICE Settings → Remote access.',
  REMOTE_DEVICE_NAME: 'Use an agent name of 1 to 80 characters.',
  REMOTE_CLOSED: 'BLACKICE is closing. Start it again before creating or redeeming a code.',
};

async function request(url, { method = 'GET', headers = {}, value, html = false } = {}, { fetchImpl = fetch, signal } = {}) {
  let response, contents;
  try {
    response = await fetchImpl(url, { method, headers: { Accept: html ? 'text/html' : 'application/json', ...headers, ...(value === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(value === undefined ? {} : { body: JSON.stringify(value) }), signal, redirect: 'error', cache: 'no-store' });
    contents = await responseText(response, html ? 2 * 1024 * 1024 : 65536);
  } catch {
    throw method === 'POST' ? fail('ACCESS_REQUEST_UNCERTAIN', 'The pairing request did not return a complete response. It may have succeeded; BLACKICE did not retry or issue another code.', { uncertain: true }) : fail('ACCESS_HOST_UNREACHABLE', 'The BLACKICE access service could not be reached. Check that the intended instance is running.');
  }
  let result;
  try { result = html ? contents : JSON.parse(contents); } catch { throw fail('ACCESS_RESPONSE_INVALID', 'The access service returned an invalid response.', { uncertain: method === 'POST' }); }
  if (!response.ok) {
    const message = plain(result) && serviceErrors[result.code];
    throw fail(message ? result.code : 'ACCESS_REQUEST_REJECTED', message || (response.status === 429 ? 'Too many pairing attempts. Wait a minute, then ask the host for a fresh code.' : response.status === 401 ? 'The code is invalid, expired, already used, or intended for a different client type.' : response.status === 503 ? 'Remote access is unavailable on the host. Start BLACKICE and enable remote access before pairing.' : 'BLACKICE rejected the access request. Check the address and the intended client type.'), { status: response.status });
  }
  if (!html && !plain(result)) throw fail('ACCESS_RESPONSE_INVALID', 'The access service returned an invalid response.', { uncertain: method === 'POST' });
  return { response, result };
}

function defaultProfileDirectory({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  if (platform === 'win32') {
    if (!env.APPDATA) throw fail('ACCESS_PROFILE', 'The Windows application-data directory is unavailable. Use --profile-dir with the running BLACKICE profile.');
    return path.win32.join(env.APPDATA, 'Relay');
  }
  return platform === 'darwin' ? path.join(home, 'Library', 'Application Support', 'Relay') : path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Relay');
}

/** Authenticate through the same local session route as the desktop UI. */
export async function createAccessCode(options, context = {}) {
  const platform = context.platform || process.platform;
  const profile = localDirectory(options.profileDir || context.defaultProfile || defaultProfileDirectory(context), platform);
  const runtime = await readAccessRuntime(profile, { platform, expectedExecutable: context.expectedExecutable });
  const inspect = context.inspectRuntime || inspectAccessRuntime;
  validateRuntimeOwnership(runtime, await inspect(runtime, context), platform);
  const headers = { Origin: runtime.url };
  const health = (await request(runtime.url + '/health', { headers }, context)).result;
  if (health.app !== 'relay-agent-harness' || health.ok !== true) throw fail('ACCESS_RUNTIME_INVALID', 'The local listener is not the expected BLACKICE instance.');
  const page = await request(runtime.url + '/', { headers, html: true }, context);
  const cookies = page.response.headers.getSetCookie?.() || [page.response.headers.get('set-cookie') || ''];
  const prefix = 'relay_session_' + new URL(runtime.url).port + '=';
  const matching = cookies.filter(cookie => cookie.startsWith(prefix));
  const cookie = matching.length === 1 ? matching[0].split(';')[0] : '';
  if (!new RegExp('^' + prefix + '[a-f0-9]{64}$').test(cookie)) throw fail('ACCESS_LOCAL_SESSION', 'BLACKICE did not establish its normal local session. No code was requested.');
  headers.Cookie = cookie;
  const status = (await request(runtime.url + '/api/status', { headers }, context)).result;
  if (status.app !== 'relay-agent-harness' || status.version !== runtime.version || status.desktopApp !== true || !samePath(status.installPath, pathsFor(platform).dirname(runtime.executable), platform) || status.remoteAccess?.client !== 'local' || status.remoteAccess?.localManagement !== true || status.desktopLifecycle?.available !== true || status.desktopLifecycle?.localManagement !== true || !['window', 'background', 'headless'].includes(status.desktopLifecycle?.mode)) throw fail('ACCESS_RUNTIME_INVALID', 'The local session does not match the selected BLACKICE desktop or headless instance.');
  if (status.remoteAccess.enabled !== true || status.remoteAccess.state !== 'ready') throw fail('REMOTE_NOT_ENABLED', serviceErrors.REMOTE_NOT_ENABLED);
  const url = exactHttpsOrigin(status.remoteAccess.url), latest = await readAccessRuntime(profile, { platform, expectedExecutable: context.expectedExecutable });
  if (JSON.stringify(latest) !== JSON.stringify(runtime)) throw fail('ACCESS_RUNTIME_CHANGED', 'BLACKICE restarted while the command was connecting. Run the code command again.');
  validateRuntimeOwnership(latest, await inspect(latest, context), platform);
  const optionsValue = options.kind === 'agent' ? { kind: 'agent', scopes: [...options.scopes] } : { kind: 'browser' };
  const { result } = await request(runtime.url + '/api/remote-access/pair', { method: 'POST', headers, value: optionsValue }, context);
  const now = (context.now || Date.now)();
  if (!codePattern.test(result.code || '') || result.kind !== options.kind || JSON.stringify(result.scopes) !== JSON.stringify(options.scopes) || !Number.isFinite(Date.parse(result.expiresAt)) || Date.parse(result.expiresAt) <= now || Date.parse(result.expiresAt) > now + 301000 || !Number.isFinite(Date.parse(result.sessionExpiresAt)) || Date.parse(result.sessionExpiresAt) < Date.parse(result.expiresAt) || Date.parse(result.sessionExpiresAt) > now + 30 * 86400000 + 1000 || result.status?.url !== url || result.status.enabled !== true || options.kind === 'agent' && result.redeemUrl !== url + '/remote/agent/pair' || options.kind === 'browser' && result.pairUrl !== url + '/#code=' + encodeURIComponent(result.code)) throw fail('ACCESS_RESPONSE_INVALID', 'BLACKICE returned an unexpected pairing receipt. The request was not retried.', { uncertain: true });
  return { ok: true, command: 'code', kind: result.kind, url, code: result.code, expiresAt: result.expiresAt, sessionExpiresAt: result.sessionExpiresAt, scopes: [...result.scopes], ...(result.kind === 'browser' ? { pairUrl: result.pairUrl } : { redeemUrl: result.redeemUrl }), host: { pid: runtime.pid, version: runtime.version, mode: status.desktopLifecycle.mode } };
}

export async function readAccessCode(stream, { signal } = {}) {
  if (stream.isTTY) throw fail('ACCESS_CODE_STDIN', 'Pipe the pairing code into standard input. The command does not accept a code in arguments or echo typed codes.');
  return new Promise((resolve, reject) => {
    const chunks = []; let length = 0, settled = false;
    const cleanup = () => { stream.off('data', data); stream.off('end', end); stream.off('error', error); signal?.removeEventListener('abort', abort); stream.pause(); };
    const finish = (cause, value) => { if (settled) return; settled = true; cleanup(); cause ? reject(cause) : resolve(value); };
    const error = () => finish(fail('ACCESS_CODE_STDIN', 'The pairing code could not be read from standard input.'));
    const abort = () => finish(fail('ACCESS_CODE_STDIN', 'Reading the pairing code timed out. Pipe one code into the command.'));
    const data = chunk => { const value = Buffer.from(chunk); length += value.length; if (length > 128) finish(fail('ACCESS_CODE_STDIN', 'Pipe exactly one pairing code into standard input.')); else chunks.push(value); };
    const end = () => {
      const normalized = Buffer.concat(chunks).toString('utf8').replace(/[\s-]/g, '').toUpperCase();
      if (!/^[A-F0-9]{32}$/.test(normalized)) finish(fail('ACCESS_CODE_STDIN', 'Pipe exactly one valid pairing code into standard input.'));
      else finish(null, normalized.match(/.{4}/g).join('-'));
    };
    stream.on('data', data); stream.once('end', end); stream.once('error', error);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort(); else stream.resume();
  });
}

export async function redeemAccessCode(options, code, context = {}) {
  const url = exactHttpsOrigin(options.url);
  if (!codePattern.test(code || '') || !validName(options.name)) throw fail('ACCESS_ARGUMENTS', 'Use one pairing code and an agent name of 1 to 80 characters.');
  const { result } = await request(url + '/remote/agent/pair', { method: 'POST', headers: { Origin: url }, value: { code, label: options.name } }, context);
  let scopes; try { scopes = validateRemoteScopes(result.device?.scopes); } catch {}
  const now = (context.now || Date.now)(), device = result.device;
  if (result.paired !== true || result.kind !== 'agent' || !tokenPattern.test(result.token || '') || !plain(device) || device.kind !== 'agent' || !/^[a-f0-9-]{36}$/.test(device.id || '') || device.label !== options.name || !scopes || JSON.stringify(scopes) !== JSON.stringify(device.scopes) || !Number.isFinite(Date.parse(device.createdAt)) || !Number.isFinite(Date.parse(device.expiresAt)) || Date.parse(device.expiresAt) <= now || Date.parse(device.expiresAt) <= Date.parse(device.createdAt) || Date.parse(device.expiresAt) > now + 30 * 86400000 + 1000 || result.url !== url || result.endpoints?.mcp !== url + '/mcp' || result.endpoints?.api !== url + '/api/agent') throw fail('ACCESS_RESPONSE_INVALID', 'The host returned an unexpected agent credential. The code may have been consumed; the request was not retried.', { uncertain: true });
  return { ok: true, command: 'pair', kind: 'agent', url, token: result.token, device: { id: device.id, kind: device.kind, label: device.label, scopes, createdAt: device.createdAt, lastSeenAt: device.lastSeenAt, expiresAt: device.expiresAt }, endpoints: { mcp: result.endpoints.mcp, api: result.endpoints.api } };
}

// Use the ACL module bundled with this Windows PowerShell host. Inherited
// module paths may otherwise resolve an incompatible PowerShell edition.
const PRIVATE_ACL_SCRIPT = [
  '$ErrorActionPreference="Stop";$taskPath=$env:BLACKICE_ACCESS_FILE',
  'Import-Module -Name (Join-Path $PSHOME "Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1") -ErrorAction Stop',
  '$taskItem=Get-Item -LiteralPath $taskPath -Force -ErrorAction Stop',
  'if(($taskItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw "Redirected access path"}',
  '$taskSid=[Security.Principal.WindowsIdentity]::GetCurrent().User',
  'function Test-TaskPrivateAcl($taskCheck){$taskRules=@($taskCheck.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]));return ($taskCheck.AreAccessRulesProtected -and $taskCheck.GetOwner([Security.Principal.SecurityIdentifier]).Value -eq $taskSid.Value -and $taskRules.Count -eq 1 -and $taskRules[0].IdentityReference.Value -eq $taskSid.Value -and $taskRules[0].AccessControlType -eq "Allow" -and $taskRules[0].FileSystemRights -eq [Security.AccessControl.FileSystemRights]::FullControl)}',
  'if(Test-TaskPrivateAcl (Get-Acl -LiteralPath $taskPath)){Write-Output "private";exit 0}',
  'if($taskItem.PSIsContainer){$taskAcl=New-Object Security.AccessControl.DirectorySecurity;$taskRule=New-Object Security.AccessControl.FileSystemAccessRule($taskSid,"FullControl","ContainerInherit,ObjectInherit","None","Allow")}else{$taskAcl=New-Object Security.AccessControl.FileSecurity;$taskRule=New-Object Security.AccessControl.FileSystemAccessRule($taskSid,"FullControl","Allow")}',
  '$taskAcl.SetAccessRuleProtection($true,$false);$taskAcl.SetOwner($taskSid);$taskAcl.AddAccessRule($taskRule);Set-Acl -LiteralPath $taskPath -AclObject $taskAcl',
  'if(-not (Test-TaskPrivateAcl (Get-Acl -LiteralPath $taskPath))){throw "Access file permissions were not private"}',
  'Write-Output "private"',
].join(';');

export async function secureAccessPath(file, { platform = process.platform, env = process.env, signal } = {}) {
  if (platform !== 'win32') {
    const stat = await fs.lstat(file), mode = stat.isDirectory() ? 0o700 : 0o600;
    if (stat.isSymbolicLink() || !stat.isDirectory() && !stat.isFile()) throw fail('ACCESS_OUTPUT_PRIVATE', 'The connection could not be reserved privately. No code was redeemed.');
    await fs.chmod(file, mode);
    if (((await fs.stat(file)).mode & 0o777) !== mode) throw fail('ACCESS_OUTPUT_PRIVATE', 'The connection file permissions could not be verified. No code was redeemed.');
    return;
  }
  try {
    const result = await executeFile(path.win32.join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', PRIVATE_ACL_SCRIPT], { windowsHide: true, shell: false, timeout: 10000, maxBuffer: 8192, signal, env: { ...env, BLACKICE_ACCESS_FILE: file } });
    if (result.stdout.trim() !== 'private') throw Error();
  } catch { throw fail('ACCESS_OUTPUT_PRIVATE', 'The connection could not be reserved with private permissions. No code was redeemed.'); }
}

function connectionsDirectory(context) {
  const platform = context.platform || process.platform, env = context.env || process.env, home = context.home || os.homedir();
  if (platform === 'win32') {
    if (!env.APPDATA) throw fail('ACCESS_OUTPUT_PRIVATE', 'The private Windows application-data directory is unavailable. Use --json to return the credential once.');
    return path.win32.join(env.APPDATA, 'BLACKICE', 'connections');
  }
  return platform === 'darwin' ? path.join(home, 'Library', 'Application Support', 'BLACKICE', 'connections') : path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'blackice', 'connections');
}

async function reserveConnection(name, context) {
  const directory = connectionsDirectory(context), file = path.join(directory, name);
  // Only this bounded per-user connection store is a credential destination.
  // Check existing ancestors before creating a directory or changing permissions.
  for (let current = directory; ; current = path.dirname(current)) {
    try { const stat = await fs.lstat(current); if (stat.isSymbolicLink() || !stat.isDirectory()) throw fail('ACCESS_OUTPUT_PRIVATE', 'The private connections directory is redirected or unavailable.'); }
    catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
    if (current === path.dirname(current)) break;
  }
  try {
    await fs.lstat(file);
    throw fail('ACCESS_OUTPUT_EXISTS', 'That connection file already exists. Choose a different --output filename; no code was redeemed.');
  } catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await ordinaryDirectory(directory);
  await secureAccessPath(directory, context);
  let handle;
  try { handle = await fs.open(file, 'wx', 0o600); }
  catch (cause) {
    let exists = cause.code === 'EEXIST';
    // Windows may report EACCES when exclusive creation finds an existing file.
    // Checking after the failed exclusive open never opens or replaces that file.
    if (!exists) try { await fs.lstat(file); exists = true; } catch {}
    throw fail(exists ? 'ACCESS_OUTPUT_EXISTS' : 'ACCESS_OUTPUT_PRIVATE', exists ? 'That connection file already exists. Choose a different --output filename; no code was redeemed.' : 'The connection file could not be reserved. No code was redeemed.');
  }
  const opened = await handle.stat();
  const cleanup = async () => {
    await handle.close().catch(() => {});
    try { const current = await fs.lstat(file); if (!current.isSymbolicLink() && current.dev === opened.dev && current.ino === opened.ino) await fs.unlink(file); } catch {}
  };
  try { await secureAccessPath(file, context); }
  catch (cause) { await cleanup(); throw cause; }
  return {
    file, cleanup,
    async save(receipt) {
      const current = await fs.lstat(file);
      if (current.isSymbolicLink() || current.dev !== opened.dev || current.ino !== opened.ino) throw fail('ACCESS_OUTPUT_CHANGED', 'The reserved connection file changed. The code was redeemed, but its credential was not saved.', { uncertain: true });
      await handle.writeFile(JSON.stringify({ schema: 1, product: 'BLACKICE', ...receipt }, null, 2) + '\n');
      await handle.sync(); await handle.close();
    },
  };
}

function readableReceipt(receipt) {
  if (receipt.command === 'code') return [
    'BLACKICE ' + receipt.kind + ' access code',
    'Address: ' + receipt.url,
    'Code: ' + receipt.code,
    'Code expires: ' + receipt.expiresAt,
    'Connection: authenticated; agent capabilities are unrestricted',
    'Session expires: ' + receipt.sessionExpiresAt,
    ...(receipt.pairUrl ? ['Pairing link: ' + receipt.pairUrl] : ['An agent can redeem this code with remote pair --url=' + receipt.url + ' --code-stdin --json.']),
    '',
  ].join('\n');
  return ['Paired with BLACKICE at ' + receipt.url, 'Agent: ' + receipt.device.label, 'Connection: authenticated; agent capabilities are unrestricted', 'Expires: ' + receipt.device.expiresAt, 'Connection saved: ' + receipt.connectionFile, 'MCP: ' + receipt.endpoints.mcp, 'Agent API: ' + receipt.endpoints.api, ''].join('\n');
}

const write = (stream, value) => new Promise((resolve, reject) => { stream.write(value, error => error ? reject(error) : resolve()); });

export async function runRemoteAccessCLI(argv, context = {}) {
  const stdout = context.stdout || process.stdout, stderr = context.stderr || process.stderr;
  const signal = context.signal || AbortSignal.timeout(30000), operation = { ...context, signal };
  let options, reserved;
  try {
    options = parseRemoteAccessArgs(argv, context);
    if (options.command === 'help') { await write(stdout, REMOTE_ACCESS_CLI_HELP); return 0; }
    let receipt;
    if (options.command === 'code') receipt = await createAccessCode(options, operation);
    else {
      const filename = options.output || (!options.json ? 'agent-' + randomUUID() + '.json' : null);
      if (filename) reserved = await reserveConnection(filename, operation);
      // Electron's Windows browser process exposes an empty process.stdin
      // even when descriptor 0 owns a valid inherited pipe. Only this native
      // pairing command owns this pipe. A Socket cancels pending reads; an
      // fs stream can strand a blocking Windows read after its signal aborts.
      const nativeInput = !context.stdin && process.platform === 'win32' && process.type === 'browser';
      if (nativeInput && isatty(0)) throw fail('ACCESS_CODE_STDIN', 'Pipe the pairing code into standard input. The command does not accept a code in arguments or echo typed codes.');
      const input = nativeInput ? new Socket({ fd: 0, readable: true, writable: false }) : context.stdin || process.stdin;
      const closed = nativeInput ? new Promise(resolve => input.once('close', resolve)) : null;
      const closingError = () => {}; // readAccessCode handles active errors; keep teardown errors handled until close.
      if (nativeInput) input.on('error', closingError);
      let code;
      try {
        code = await readAccessCode(input, operation);
      } finally {
        if (nativeInput) { input.destroy(); await closed; input.off('error', closingError); }
      }
      receipt = await redeemAccessCode(options, code, operation);
      if (reserved) {
        try { await reserved.save(receipt); } catch { throw fail('ACCESS_CREDENTIAL_SAVE_FAILED', 'The code was redeemed but the private connection could not be saved. The request was not retried.', { uncertain: true }); }
        const { token: _token, ...safe } = receipt;
        receipt = { ...safe, credentialSaved: true, connectionFile: reserved.file };
        reserved = null;
      }
    }
    await write(stdout, options.json ? JSON.stringify(receipt) + '\n' : readableReceipt(receipt));
    return 0;
  } catch (cause) {
    await reserved?.cleanup();
    const known = /^(?:ACCESS|REMOTE)_[A-Z_]+$/.test(cause.code || '');
    const error = { code: known ? cause.code : 'ACCESS_FAILED', message: known ? cause.message : 'BLACKICE could not complete the access command.', ...(cause.uncertain ? { uncertain: true } : {}) };
    await write(options?.json || argv.includes('--json') ? stdout : stderr, options?.json || argv.includes('--json') ? JSON.stringify({ ok: false, error }) + '\n' : error.message + '\n');
    return 1;
  }
}
