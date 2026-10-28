import { randomUUID } from 'node:crypto';
import { connectBrowserCLI } from './browser-cli.mjs';
import { DESKTOP_RESTART_ORIGIN_ENV } from './desktop-restart-origin.mjs';
import { windowsProcessIdentity } from './desktop-hard-restart.mjs';

const fail = (code, message) => Object.assign(new Error(message), { code });
const requests = new Map([['--restart', 'restart'], ['--restart-status', 'status'], ['--cancel-restart', 'cancel']]);
const recoverableFailures = new Set(['DESKTOP_RESTART_STORAGE_UNAVAILABLE', 'DESKTOP_RESTART_HISTORY_FULL', 'DESKTOP_RESTART_BUSY', 'DESKTOP_RESTART_CLOSING', 'DESKTOP_RESTART_BROWSER_BUSY', 'DESKTOP_RESTART_BROWSER_STATE', 'DESKTOP_RESTART_STORAGE', 'DESKTOP_RESTART_DRAIN_TIMEOUT', 'DESKTOP_RESTART_NOT_PREPARED', 'DESKTOP_RESTART_PREPARE_FAILED', 'DESKTOP_RESTART_RELEASE_FAILED', 'DESKTOP_RESTART_ARM_FAILED']);
export const DESKTOP_RESTART_HELP = `BLACKICE native restart

  BLACKICE --restart [--force] [--emergency] --request-id=ID [--profile-dir=PATH]
  BLACKICE --restart-status --request-id=ID [--profile-dir=PATH]
  BLACKICE --cancel-restart --request-id=ID [--profile-dir=PATH]

The native JSON reply acknowledges durable scheduling, not completed restart.
After reconnecting, inspect the same native request. Emergency claims are not
available through --restart-status and may not be saved; reconnect and inspect
BLACKICE to confirm the replacement before taking further action. Retry an
uncertain request with the same ID; never choose a new ID to recover a lost acknowledgement.
A direct command automatically binds its own origin. It must exit successfully
before BLACKICE can arm relaunch. Emergency recovery must be invoked by an
independent local command, because a frozen app cannot reauthorize that origin.
Other unfinished work still blocks restart.
--force first tries the native restart and can fall back to an external emergency
restart if the process cannot respond or preparation fails. --emergency directly
uses the fallback when the native path is stuck. It may interrupt unsaved work;
action outcomes and replacement startup can be uncertain. If the running instance has not published a
runtime record, its profile and process identity are checked against Windows;
its mode is inferred from launch arguments and may have changed since launch.

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
    if (argument === '--force') {
      if (options.force) throw fail('DESKTOP_RESTART_ARGUMENTS', 'Choose --force only once.');
      options.force = true; continue;
    }
    if (argument === '--emergency') {
      if (options.emergency) throw fail('DESKTOP_RESTART_ARGUMENTS', 'Choose --emergency only once.');
      options.emergency = true; continue;
    }
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
  if (options.force && (options.action !== 'restart' || options.legacy)) throw fail('DESKTOP_RESTART_ARGUMENTS', 'Use --force only with the native --restart action.');
  if (options.emergency && (!options.force || options.action !== 'restart' || options.legacy)) throw fail('DESKTOP_RESTART_ARGUMENTS', 'Use --emergency only with --restart --force.');
  if (options['request-id'] && !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/.test(options['request-id'])) throw fail('DESKTOP_RESTART_ARGUMENTS', 'Use a stable request ID of at most 120 letters, digits, periods, colons, underscores, or hyphens.');
  if (options.action !== 'restart' && !options['request-id'] && !options.help) throw fail('DESKTOP_RESTART_ARGUMENTS', 'Inspect or cancel the exact saved restart request ID.');
  if (!options.legacy && !options.help) options['request-id'] ||= `native-restart-${randomUUID()}`;
  return options;
}

async function executeNativeRestartCLI(options, context = {}) {
  const signal = context.signal || AbortSignal.timeout(options.force ? 50000 : 20000);
  const { request, runtime } = await (context.connect || connectBrowserCLI)(options, { ...context, signal });
  if (options.legacy) {
    if (typeof context.legacyHandoff !== 'function') throw fail('DESKTOP_RESTART_LEGACY_UNAVAILABLE', 'The compatibility handoff requires the actual BLACKICE Electron executable.');
    await context.legacyHandoff(runtime);
    return { protocol: 'legacy-single-instance', acknowledged: false, status: 'forwarded', primary: { pid: runtime.pid, startedAt: runtime.startedAt }, message: 'The old primary received only a native restart intent. Verify its durable restart receipt and replacement process; do not infer success from this exit code.' };
  }
  const token = (context.env || process.env)[DESKTOP_RESTART_ORIGIN_ENV];
  if (token !== undefined && (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token))) throw fail('DESKTOP_RESTART_ORIGIN_INVALID', 'The inherited native restart origin is invalid.');
  const input = { requestId: options['request-id'], ...(options.force ? { force: true } : {}), ...(token === undefined ? {} : { originToken: token }) };
  const route = '/api/desktop/restart' + (options.action === 'restart' ? '' : '/' + options.action);
  await context.onRestartConnection?.({ request, runtime });
  let result;
  try { result = await request(route, input); }
  catch (error) {
    if (options.action === 'restart' && error.code === 'BROWSER_CLI_UNCERTAIN') throw fail('DESKTOP_RESTART_ACK_UNCERTAIN', 'Scheduling may have been admitted. Inspect or retry the identical restart request ID after reconnecting.');
    throw error;
  }
  if (result?.protocol !== 1 || result.acknowledged !== true || result.receipt?.requestId !== input.requestId || !['scheduled', 'restarting', 'completed', 'failed', 'cancelled', 'interrupted'].includes(result.receipt.status) || result.receipt.durable !== true) throw fail('DESKTOP_RESTART_ACK_UNCERTAIN', 'The native restart acknowledgement could not be verified. Inspect the same request ID before continuing.');
  if (options.action === 'restart' && (result.receipt.force !== undefined && typeof result.receipt.force !== 'boolean' || Boolean(result.receipt.force) !== Boolean(options.force))) throw fail('DESKTOP_RESTART_ACK_UNCERTAIN', 'The saved restart force choice differs. Inspect the same request ID before continuing.');
  return result;
}

export async function executeDesktopRestartCLI(options, context = {}) {
  const fallback = context.forceFallback;
  const ownedOrigin = (context.env || process.env)[DESKTOP_RESTART_ORIGIN_ENV] !== undefined;
  const canFallback = typeof fallback === 'function' && !ownedOrigin;
  if (options.emergency) {
    if (ownedOrigin) throw fail('DESKTOP_RESTART_HARD_ORIGIN', 'Emergency restart requires an independent local command because the originating connection cannot be reauthorized while BLACKICE is unresponsive.');
    if (typeof fallback !== 'function') throw fail('DESKTOP_RESTART_HARD_UNAVAILABLE', 'Emergency restart is unavailable in this command.');
    return fallback(options, context);
  }
  let connection, originalIdentity;
  const originalStillMatches = async () => {
    if (!originalIdentity) return false;
    let current;
    try { current = await (context.getForceIdentity || windowsProcessIdentity)(originalIdentity.pid); } catch { }
    return Boolean(current && current.pid === originalIdentity.pid && current.created === originalIdentity.created && typeof current.image === 'string' && typeof originalIdentity.image === 'string' && current.image.toLowerCase() === originalIdentity.image.toLowerCase());
  };
  try {
    const result = await executeNativeRestartCLI(options, { ...context, onRestartConnection: async value => {
      connection = value;
      if (options.force && canFallback) {
        try { originalIdentity = await (context.getForceIdentity || windowsProcessIdentity)(value.runtime.pid); } catch { /* Native restart remains available. */ }
      }
    } });
    if (options.action === 'restart' && options.force && result.receipt?.status === 'failed' && canFallback) {
      if (!recoverableFailures.has(result.receipt.error?.code)) return result;
      if (!await originalStillMatches()) return { ...result, followup: 'The original process identity changed or could not be verified; inspect BLACKICE before retrying.' };
      return fallback(options, { ...context, expectedIdentity: originalIdentity });
    }
    if (options.action === 'restart' && options.force && result.receipt?.status === 'scheduled' && ownedOrigin) return { ...result, followup: 'Native restart is scheduled. If it remains stuck, run --restart --force --emergency with the same request ID as an independent local command.' };
    if (options.action === 'restart' && options.force && result.receipt?.status === 'scheduled' && canFallback) {
      // A command originating inside BLACKICE must exit before native handoff.
      // Waiting here would prevent the very restart we are trying to observe.
      const waitMs = context.forceWaitMs ?? 35000;
      if (waitMs <= 0) return result;
      if (!originalIdentity) return { ...result, followup: 'Native restart was scheduled; its replacement has not been confirmed.' };
      const escalateOriginal = async () => {
        if (!await originalStillMatches()) return { ...result, followup: 'The original process has exited or changed; inspect BLACKICE to confirm the replacement.' };
        return fallback(options, { ...context, expectedIdentity: originalIdentity });
      };
      const deadline = Date.now() + waitMs;
      while (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, Math.min(context.forcePollMs ?? 500, Math.max(1, deadline - Date.now()))));
        try {
          const observed = await connection.request('/api/desktop/restart/status', { requestId: options['request-id'] });
          if (observed?.receipt?.requestId !== options['request-id'] || observed?.receipt?.durable !== true) continue;
          if (observed.receipt.status === 'failed') return recoverableFailures.has(observed.receipt.error?.code) ? escalateOriginal() : observed;
          if (['completed', 'cancelled', 'interrupted'].includes(observed.receipt.status)) return observed;
        } catch (error) {
          if (error.status === 401 || error.status === 403 || ['DESKTOP_RESTART_ORIGIN_UNAUTHORIZED', 'DESKTOP_RESTART_ORIGIN_INVALID', 'DESKTOP_RESTART_CANCELLED'].includes(error.code)) throw error;
          // The primary may be closing; identity is rechecked before fallback.
        }
      }
      return escalateOriginal();
    }
    return result;
  } catch (error) {
    if (error.status === 401 || error.status === 403 || error.code === 'BROWSER_CLI_REJECTED' && error.status !== 404 && error.status !== 501) throw error;
    if (options.action === 'restart' && options.force && canFallback && ['BROWSER_CLI_UNREACHABLE', 'BROWSER_CLI_UNCERTAIN', 'BROWSER_CLI_REJECTED', 'BROWSER_CLI_RUNTIME', 'BROWSER_CLI_SESSION', 'DESKTOP_RESTART_ACK_UNCERTAIN', 'ACCESS_HOST_NOT_RUNNING', 'ACCESS_RUNTIME_INVALID', 'ACCESS_RUNTIME_OWNERSHIP', 'DESKTOP_RESTART_UNAVAILABLE', 'DESKTOP_RESTART_STORAGE_UNAVAILABLE'].includes(error.code)) {
      if (connection) {
        if (!await originalStillMatches()) throw fail('DESKTOP_RESTART_ACK_UNCERTAIN', 'The native restart outcome or original process identity is uncertain. Inspect BLACKICE before retrying.');
        return fallback(options, { ...context, expectedIdentity: originalIdentity });
      }
      return fallback(options, context);
    }
    if (options.action === 'restart' && options.force && ownedOrigin && error && typeof error === 'object') error.message += ' Emergency recovery requires an independent local command.';
    throw error;
  }
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
