export const CHROME_BROWSER_CONNECTION_ID = 'chrome-live';
export const CHROME_BROWSER_CHANNELS = Object.freeze(['stable', 'beta', 'dev', 'canary']);
const fail = message => Object.assign(new Error(message), { code: 'CHROME_CONNECTION_VALIDATION' });

export function chromeBrowserArguments(channel = 'stable') {
  if (!CHROME_BROWSER_CHANNELS.includes(channel)) throw fail('Choose a supported Chrome channel.');
  return ['-y', 'chrome-devtools-mcp@latest', '--autoConnect', `--channel=${channel}`, '--no-usage-statistics', '--no-performance-crux'];
}

/** Exact managed signature; custom or conflicting servers remain untouched. */
export function isManagedChromeConnection(config) {
  if (config?.id !== CHROME_BROWSER_CONNECTION_ID || config.transport !== 'stdio' || !Array.isArray(config.args) || !/(?:^|[\\/])npx(?:\.cmd)?$/i.test(config.command || '')) return false;
  const channel = config.args.find(arg => typeof arg === 'string' && arg.startsWith('--channel='))?.slice('--channel='.length);
  if (!CHROME_BROWSER_CHANNELS.includes(channel)) return false;
  return JSON.stringify(config.args) === JSON.stringify(chromeBrowserArguments(channel));
}

/** Apply only after isManagedChromeConnection(config) succeeds at the gateway. */
export function chromeBackgroundArguments(name, args = {}) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw fail('Chrome tool arguments must be an object.');
  if (name === 'new_page') { const { isolatedContext, ...rest } = args; return { ...rest, background: true }; }
  if (name === 'select_page') return { ...args, bringToFront: false };
  return { ...args };
}
