import { TailscaleRemoteTransport } from '../../lib/remote-access-tailscale.mjs';

/** Deterministic CLI fixture; auth, gateway and ownership checks remain production code. */
export function createRemoteTransportFixture({ hostname = 'blackice-fixture.tailtest.ts.net', online = true, config } = {}) {
  let current = structuredClone(config || { TCP: { '443': { HTTPS: true } }, Web: { [`${hostname}:443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:8787' }, '/vision': { Proxy: 'http://127.0.0.1:8790' } } } }, AllowFunnel: { [`${hostname}:443`]: true } });
  const calls = [];
  const run = async args => {
    calls.push([...args]);
    if (JSON.stringify(args) === JSON.stringify(['status', '--json'])) return JSON.stringify({ BackendState: online ? 'Running' : 'Stopped', Self: { DNSName: hostname + '.', Online: online } });
    if (JSON.stringify(args) === JSON.stringify(['serve', 'status', '--json'])) return JSON.stringify(current);
    const port = args.includes('--https=443') ? 443 : args.includes('--https=8443') ? 8443 : null, host = `${hostname}:${port}`;
    const rootPath = args.includes('--set-path=/');
    const enableArgs = port === 443 ? ['--bg', '--https=443', '--set-path=/'] : ['--bg', '--https=8443'];
    if (['serve', 'funnel'].includes(args[0]) && JSON.stringify(args.slice(1, -1)) === JSON.stringify(enableArgs) && /^http:\/\/127\.0\.0\.1:\d+$/.test(args.at(-1) || '')) {
      current.TCP ||= {}; current.Web ||= {}; current.AllowFunnel ||= {};
      current.TCP[port] = { HTTPS: true }; current.Web[host] ||= { Handlers: {} }; current.Web[host].Handlers['/'] = { Proxy: args.at(-1) };
      if (args[0] === 'funnel') current.AllowFunnel[host] = true; else delete current.AllowFunnel[host];
      return '';
    }
    const disableArgs = port === 443 ? ['--https=443', '--set-path=/', 'off'] : ['--https=8443', 'off'];
    if (['serve', 'funnel'].includes(args[0]) && JSON.stringify(args.slice(1)) === JSON.stringify(disableArgs)) {
      if (rootPath) delete current.Web?.[host]?.Handlers?.['/'];
      if (!rootPath || !Object.keys(current.Web?.[host]?.Handlers || {}).length) { delete current.TCP?.[port]; delete current.Web?.[host]; delete current.AllowFunnel?.[host]; }
      for (const name of ['TCP', 'Web', 'AllowFunnel']) if (current[name] && !Object.keys(current[name]).length) delete current[name];
      return '';
    }
    throw new Error('Unexpected Tailscale fixture command.');
  };
  return { transport: new TailscaleRemoteTransport({ run }), run, calls, hostname, get config() { return structuredClone(current); }, setConfig(value) { current = structuredClone(value); }, setOnline(value) { online = value; } };
}
