import { randomUUID } from 'node:crypto';
import { connectBrowserCLI } from './browser-cli.mjs';
import { DESKTOP_RESTART_ORIGIN_ENV } from './desktop-restart-origin.mjs';

const fail = (code, message) => Object.assign(new Error(message), { code });
const requests = new Map([['--restart', 'restart'], ['--restart-status', 'status'], ['--cancel-restart', 'cancel']]);
export const DESKTOP_RESTART_HELP = `BLACKICE native restart

  BLACKICE --restart --request-id=ID [--profile-dir=PATH]
  BLACKICE --restart-status --request-id=ID [--profile-dir=PATH]
  BLACKICE --cancel-restart --request-id=ID [--profile-dir=PATH]

The JSON reply acknowledges durable scheduling, not completed restart.
After reconnecting, inspect the same request. Retry an uncertain request with
the same ID; never choose a new ID to recover a lost acknowledgement.
A direct command automatically binds its own origin. It must exit successfully
before BLACKICE can arm relaunch. Other unfinished work still blocks restart.

One-time compatibility bootstrap for an older running primary only:
  BLACKICE --restart --legacy-native-handoff [--profile-dir=PATH]
This uses Electron's original single-instance forwarding and has no scheduling
acknowledgement or caller request ID. Inspect the native receipt and process
identity afterward. It is never an automatic fallback or proof of the fixed path.
`;

export function desktopRestartArgs(argv = process.argv, { packaged = true } = {}) {
  const args = argv.slice(packaged ? 1 : 2);
  return args.some(value => /^--(?:restart|restart-status|cancel-restart)(?:=|$)/.test(value)) ? args : null;
}

export function parseDesktopRestartArgs(argv) {
  if (!Array.isArray(argv) || argv.some(value => typeof value !== 'string')) throw fail('DESKTOP_RESTART_ARGUMENTS', 'Use --restart --request-id=ID.');
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (requests.has(argument)) {
      if (options.action) throw fail('DESKTOP_RESTART_ARGUMENTS', 'Choose one native restart action.');
      options.action = requests.get(argument); continue;
    }
    if (argument === '--help' || argument === '-h') { options.help = true; continue; }
    if (argument === '--legacy-native-handoff') {
      if (options.legacy) throw fail('DESKTOP_RESTART_ARGUMENTS', 'Choose the legacy native handoff only once.');
      options.legacy = true; continue;
    }
    const match = argument.match(/^--(request-id|profile-dir|profile)(?:=(.*))?$/s);
    if (!match) throw fail('DESKTOP_RESTART_ARGUMENTS', 'Use the documented native restart options without a launch-mode change.');
    const key = match[1] === 'profile' ? 'profile-dir' : match[1];
    const value = match[2] ?? argv[++index];
    if (Object.hasOwn(options, key) || typeof value !== 'string' || !value || value.startsWith('--') || value.trim() !== value || /[\x00-\x1f\x7f]/.test(value)) throw fail('DESKTOP_RESTART_ARGUMENTS', 'Supply each native restart option once with a valid value.');
    options[key] = value;
  }
  if (!options.action || options.legacy && (options.action !== 'restart' || options['request-id'])) throw fail('DESKTOP_RESTART_ARGUMENTS', 'The legacy handoff accepts --restart only and cannot promise a caller request ID.');
  if (options['request-id'] && !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/.test(options['request-id'])) throw fail('DESKTOP_RESTART_ARGUMENTS', 'Use a stable request ID of at most 120 letters, digits, periods, colons, underscores, or hyphens.');
  if (options.action !== 'restart' && !options['request-id'] && !options.help) throw fail('DESKTOP_RESTART_ARGUMENTS', 'Inspect or cancel the exact saved restart request ID.');
  if (!options.legacy && !options.help) options['request-id'] ||= `native-restart-${randomUUID()}`;
  return options;
}

export async function executeDesktopRestartCLI(options, context = {}) {
  const signal = context.signal || AbortSignal.timeout(20000);
  const { request, runtime } = await (context.connect || connectBrowserCLI)(options, { ...context, signal });
  if (options.legacy) {
    if (typeof context.legacyHandoff !== 'function') throw fail('DESKTOP_RESTART_LEGACY_UNAVAILABLE', 'The compatibility handoff requires the actual BLACKICE Electron executable.');
    await context.legacyHandoff(runtime);
    return { protocol: 'legacy-single-instance', acknowledged: false, status: 'forwarded', primary: { pid: runtime.pid, startedAt: runtime.startedAt }, message: 'The old primary received only a native restart intent. Verify its durable restart receipt and replacement process; do not infer success from this exit code.' };
  }
  const token = (context.env || process.env)[DESKTOP_RESTART_ORIGIN_ENV];
  if (token !== undefined && (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token))) throw fail('DESKTOP_RESTART_ORIGIN_INVALID', 'The inherited native restart origin is invalid.');
  const input = { requestId: options['request-id'], ...(token === undefined ? {} : { originToken: token }) };
  const route = '/api/desktop/restart' + (options.action === 'restart' ? '' : '/' + options.action);
  let result;
  try { result = await request(route, input); }
  catch (error) {
    if (options.action === 'restart' && error.code === 'BROWSER_CLI_UNCERTAIN') throw fail('DESKTOP_RESTART_ACK_UNCERTAIN', 'Scheduling may have been admitted. Inspect or retry the identical restart request ID after reconnecting.');
    throw error;
  }
  if (result?.protocol !== 1 || result.acknowledged !== true || result.receipt?.requestId !== input.requestId || !['scheduled', 'restarting', 'completed', 'failed', 'cancelled', 'interrupted'].includes(result.receipt.status) || result.receipt.durable !== true) throw fail('DESKTOP_RESTART_ACK_UNCERTAIN', 'The native restart acknowledgement could not be verified. Inspect the same request ID before continuing.');
  return result;
}

export async function runDesktopRestartCLI(argv, context = {}) {
  const stdout = context.stdout || process.stdout, stderr = context.stderr || process.stderr;
  let options;
  try {
    options = parseDesktopRestartArgs(argv);
    if (options.help) { stdout.write(DESKTOP_RESTART_HELP); return 0; }
    const result = await executeDesktopRestartCLI(options, context);
    stdout.write(JSON.stringify(result) + '\n');
    return options.action === 'cancel' && result.cancellationRequested || !['failed', 'cancelled', 'interrupted'].includes(result.receipt?.status) ? 0 : 1;
  } catch (error) {
    stderr.write(JSON.stringify({ error: error.message, code: error.code || 'DESKTOP_RESTART_CLI_FAILED', ...(options?.['request-id'] ? { requestId: options['request-id'] } : {}) }) + '\n');
    return 1;
  }
}
