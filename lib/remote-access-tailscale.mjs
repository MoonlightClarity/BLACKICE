import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const DEFAULT_PORT = 8443;
const validPort = port => [443, 8443].includes(port);
const fail = (message, code = 'REMOTE_TRANSPORT_ERROR', status = 503) => Object.assign(new Error(message), { code, status });
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const sorted = value => Array.isArray(value) ? value.map(sorted) : object(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value;
const same = (a, b) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
const portKey = (key, port = DEFAULT_PORT) => typeof key === 'string' && key.endsWith(':' + port);
const originFor = (hostname, port) => `https://${hostname}${port === 443 ? '' : ':' + port}`;

export async function runTailscale(args) {
  const executable = process.platform === 'win32' ? 'C:\\Program Files\\Tailscale\\tailscale.exe' : 'tailscale';
  try {
    const result = await execute(executable, args, { windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024, encoding: 'utf8' });
    return result.stdout;
  } catch (cause) {
    if (cause.code === 'ENOENT') throw fail('Install Tailscale on this computer to enable remote access.', 'REMOTE_TAILSCALE_MISSING');
    throw fail(cause.killed ? 'Tailscale did not finish in time. Remote access stays unavailable.' : 'Tailscale could not complete the requested operation. Check its connection and permissions on this computer.', 'REMOTE_TAILSCALE_COMMAND');
  }
}

function json(value) {
  try { const parsed = typeof value === 'string' ? JSON.parse(value) : value; if (!object(parsed)) throw Error(); return parsed; }
  catch { throw fail('Tailscale returned an unreadable configuration. No unrelated route was changed.', 'REMOTE_TAILSCALE_RESPONSE'); }
}

export function validateRemoteOwnership(value) {
  if (!object(value) || Object.keys(value).some(key => !['hostname', 'httpsPort', 'target', 'mode'].includes(key)) || !validPort(value.httpsPort) || !['private', 'public'].includes(value.mode) || !/^[a-z0-9][a-z0-9.-]*\.ts\.net$/.test(value.hostname || '')) throw fail('The saved remote route could not be verified.', 'REMOTE_OWNERSHIP_INVALID');
  let target;
  try { target = new URL(value.target); } catch { throw fail('The saved remote route could not be verified.', 'REMOTE_OWNERSHIP_INVALID'); }
  if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || !/^\d+$/.test(target.port) || Number(target.port) < 1024 || Number(target.port) > 65535 || target.origin !== value.target || target.pathname !== '/' || target.username || target.password || target.search || target.hash) throw fail('The saved remote route could not be verified.', 'REMOTE_OWNERSHIP_INVALID');
  return { hostname: value.hostname, httpsPort: value.httpsPort, target: target.origin, mode: value.mode };
}

function anyPortClaimed(config, port) {
  if (!object(config)) return false;
  return Object.hasOwn(config.TCP || {}, String(port)) || Object.keys(config.Web || {}).some(key => portKey(key, port)) || Object.keys(config.AllowFunnel || {}).some(key => portKey(key, port)) || Object.values(config.Foreground || {}).some(value => anyPortClaimed(value, port));
}

// Standard HTTPS may share other paths, but never another host, TCP listener,
// foreground listener, or an opaque handler configuration.
function shareable443(config, hostname = null) {
  if (Object.values(config.Foreground || {}).some(value => anyPortClaimed(value, 443))) return false;
  const hosts = Object.keys(config.Web || {}).filter(key => portKey(key, 443));
  if (!hosts.length) return !Object.hasOwn(config.TCP || {}, '443') && !Object.keys(config.AllowFunnel || {}).some(key => portKey(key, 443));
  if (hosts.length !== 1 || hostname && hosts[0] !== `${hostname}:443` || !same(config.TCP?.['443'], { HTTPS: true })) return false;
  const web = config.Web[hosts[0]];
  return object(web) && Object.keys(web).length === 1 && object(web.Handlers) && Object.keys(web.Handlers).length > 0 && !Object.keys(config.AllowFunnel || {}).some(key => portKey(key, 443) && key !== hosts[0]);
}

export function remotePortClaimed(config, httpsPort = DEFAULT_PORT) {
  if (!validPort(httpsPort)) throw fail('Use HTTPS port 443 or 8443.', 'REMOTE_OWNERSHIP_INVALID');
  if (!object(config)) return false;
  if (httpsPort === DEFAULT_PORT) return anyPortClaimed(config, httpsPort);
  return !shareable443(config) || Object.entries(config.Web || {}).some(([key, web]) => portKey(key, 443) && Object.hasOwn(web.Handlers, '/'));
}

export function ownsRemoteRoute(config, ownership) {
  if (!ownership) return false;
  let own; try { own = validateRemoteOwnership(ownership); } catch { return false; }
  const port = own.httpsPort, host = `${own.hostname}:${port}`;
  if (port === 443) {
    if (!shareable443(config, own.hostname) || !same(config.Web?.[host]?.Handlers?.['/'], { Proxy: own.target })) return false;
  } else {
    if (!same(config.TCP?.[port], { HTTPS: true }) || !same(config.Web?.[host], { Handlers: { '/': { Proxy: own.target } } })) return false;
    if (Object.keys(config.Web || {}).some(key => portKey(key, port) && key !== host) || Object.keys(config.AllowFunnel || {}).some(key => portKey(key, port) && key !== host) || Object.values(config.Foreground || {}).some(value => anyPortClaimed(value, port))) return false;
  }
  return own.mode === 'public' ? config.AllowFunnel?.[host] === true : !Object.hasOwn(config.AllowFunnel || {}, host) || config.AllowFunnel[host] === false;
}

/** Exclude only owned configuration; retain every unrelated path and listener. */
export function unrelatedRemoteConfig(config, ownership = null) {
  const value = structuredClone(config), own = ownership ? validateRemoteOwnership(ownership) : null, port = own?.httpsPort || DEFAULT_PORT;
  if (port === 443) {
    const host = `${own.hostname}:443`, web = value.Web?.[host];
    if (object(web?.Handlers)) delete web.Handlers['/'];
    // TCP/Funnel settings belong to remaining handlers until the last is gone.
    if (!Object.keys(web?.Handlers || {}).length) {
      if (object(value.Web)) delete value.Web[host];
      if (object(value.TCP)) delete value.TCP['443'];
      if (object(value.AllowFunnel)) delete value.AllowFunnel[host];
    }
  } else {
    if (object(value.TCP)) delete value.TCP[port];
    for (const name of ['Web', 'AllowFunnel']) if (object(value[name])) for (const key of Object.keys(value[name])) if (portKey(key, port)) delete value[name][key];
  }
  for (const name of ['TCP', 'Web', 'AllowFunnel']) if (object(value[name]) && !Object.keys(value[name]).length) delete value[name];
  return value;
}

export class TailscaleRemoteTransport {
  constructor({ run = runTailscale } = {}) { this.run = run; }
  async inspect({ httpsPort = DEFAULT_PORT } = {}) {
    if (!validPort(httpsPort)) throw fail('Use HTTPS port 443 or 8443.', 'REMOTE_OWNERSHIP_INVALID');
    const status = json(await this.run(['status', '--json']));
    const config = json(await this.run(['serve', 'status', '--json']));
    const dnsName = typeof status.Self?.DNSName === 'string' ? status.Self.DNSName.replace(/\.$/, '').toLowerCase() : null;
    if (dnsName && !/^[a-z0-9][a-z0-9.-]*\.ts\.net$/.test(dnsName)) throw fail('Tailscale did not return a usable HTTPS hostname.', 'REMOTE_TAILSCALE_HOST');
    return { config, status: { kind: 'tailscale', available: true, online: status.BackendState === 'Running' && status.Self?.Online === true, dnsName, httpsPort, private: true, publicOption: true } };
  }
  async enable({ target, mode = 'private', ownership = null, httpsPort = DEFAULT_PORT } = {}) {
    const before = await this.inspect({ httpsPort });
    if (!before.status.online || !before.status.dnsName) throw fail('Connect Tailscale on this computer before enabling remote access.', 'REMOTE_TAILSCALE_OFFLINE');
    const next = validateRemoteOwnership({ hostname: before.status.dnsName, httpsPort, target, mode });
    if (httpsPort === 443 && !shareable443(before.config, next.hostname) || remotePortClaimed(before.config, httpsPort) && (!ownership || ownership.httpsPort !== httpsPort || !ownsRemoteRoute(before.config, ownership))) throw fail(`Tailscale HTTPS port ${httpsPort} has an unowned or changed root route. BLACKICE left it unchanged.`, 'REMOTE_PORT_IN_USE', 409);
    const host = `${next.hostname}:${httpsPort}`, otherHandlers = Object.keys(before.config.Web?.[host]?.Handlers || {}).some(path => path !== '/');
    if (httpsPort === 443 && otherHandlers && (before.config.AllowFunnel?.[host] === true) !== (mode === 'public')) throw fail('Other HTTPS paths require their existing public or private exposure. BLACKICE left them unchanged.', 'REMOTE_PORT_IN_USE', 409);
    if (!ownsRemoteRoute(before.config, next)) await this.run([mode === 'public' ? 'funnel' : 'serve', '--bg', `--https=${httpsPort}`, ...(httpsPort === 443 ? ['--set-path=/'] : []), target]);
    const after = await this.inspect({ httpsPort });
    if (!after.status.online || after.status.dnsName !== next.hostname || !ownsRemoteRoute(after.config, next) || !same(unrelatedRemoteConfig(before.config, next), unrelatedRemoteConfig(after.config, next))) throw fail('The new HTTPS route did not match its expected configuration. BLACKICE has suspended remote access.', 'REMOTE_ROUTE_VERIFICATION');
    return { ownership: next, status: { ...after.status, private: mode === 'private' }, origin: originFor(next.hostname, httpsPort) };
  }
  async disable(ownership) {
    const own = validateRemoteOwnership(ownership);
    const before = await this.inspect({ httpsPort: own.httpsPort });
    if (!remotePortClaimed(before.config, own.httpsPort)) return { removed: false, status: before.status };
    if (!ownsRemoteRoute(before.config, own)) throw fail('The HTTPS route has changed since BLACKICE created it. BLACKICE left the current route unchanged.', 'REMOTE_ROUTE_CHANGED', 409);
    await this.run([own.mode === 'public' ? 'funnel' : 'serve', `--https=${own.httpsPort}`, ...(own.httpsPort === 443 ? ['--set-path=/'] : []), 'off']);
    const after = await this.inspect({ httpsPort: own.httpsPort });
    if (remotePortClaimed(after.config, own.httpsPort) || !same(unrelatedRemoteConfig(before.config, own), unrelatedRemoteConfig(after.config, own))) throw fail('Tailscale could not confirm that only the BLACKICE route was removed.', 'REMOTE_ROUTE_VERIFICATION');
    return { removed: true, status: after.status };
  }
}
