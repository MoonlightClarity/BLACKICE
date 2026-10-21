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

/** Recognize the official adapter without confusing a copied profile with live Chrome. */
export function isChromeBrowserConnection(config) {
  if (config?.transport !== 'stdio' || !Array.isArray(config.args)) return false;
  if (/(?:^|[\\/])chrome-devtools-mcp(?:\.cmd)?$/i.test(config.command || '')) return true;
  return /(?:^|[\\/])npx(?:\.cmd)?$/i.test(config.command || '') &&
    config.args.some(arg => typeof arg === 'string' && /^chrome-devtools-mcp(?:@[^\s]+)?$/.test(arg));
}

/** Preserve the selected native profile and keep routine tab operations in the background. */
export function chromeBackgroundArguments(name, args = {}) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw fail('Chrome tool arguments must be an object.');
  if (name === 'new_page') { const { isolatedContext, ...rest } = args; return { ...rest, background: true }; }
  if (name === 'select_page') return { ...args, bringToFront: false };
  return { ...args };
}
