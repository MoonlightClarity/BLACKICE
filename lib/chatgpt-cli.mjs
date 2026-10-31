import { connectBrowserCLI } from './browser-cli.mjs';

const fail = message => Object.assign(new Error(message), { code: 'CHATGPT_CLI_ARGUMENTS' });
export const CHATGPT_CLI_HELP = `BLACKICE ChatGPT connection

  BLACKICE chatgpt status [--profile-dir=PATH]
  BLACKICE chatgpt prepare --confirm-public [--profile-dir=PATH]
  BLACKICE chatgpt check [--profile-dir=PATH]
  BLACKICE chatgpt approve --code=CODE --scope=NAME [--scope=NAME ...] [--profile-dir=PATH]
  BLACKICE chatgpt startup [--profile-dir=PATH]

Start BLACKICE and sign in to Tailscale first. Preparation publishes the
OAuth-protected HTTPS endpoint to the internet. Approve only after matching
CODE to the authorization page and reviewing its requested scopes. Status
shows the endpoint, pending requests, checks and verification prompt. A local
check does not prove a response reached ChatGPT. Commands return JSON.
`;
export function desktopChatGPTArgs(argv = process.argv, { packaged = true } = {}) {
  const args = argv.slice(packaged ? 1 : 2);
  return args[0] === 'chatgpt' ? args : null;
}
export function parseChatGPTArgs(argv) {
  const args = [...argv]; if (args[0] === 'chatgpt') args.shift();
  const command = args.shift() || 'help';
  if (['help', '--help', '-h'].includes(command)) return { command: 'help' };
  if (!['status', 'prepare', 'check', 'approve', 'startup'].includes(command)) throw fail('Use BLACKICE chatgpt --help.');
  const options = { command, scopes: [] };
  for (let i = 0; i < args.length; i++) {
    const match = args[i].match(/^--(profile-dir|confirm-public|code|scope)(?:=(.*))?$/s);
    if (!match) throw fail('Unsupported option. See chatgpt --help.');
    const key = match[1];
    if (key === 'confirm-public') {
      if (command !== 'prepare' || match[2] !== undefined || options.confirmPublic) throw fail('Use --confirm-public once with prepare.');
      options.confirmPublic = true; continue;
    }
    const value = match[2] ?? args[++i];
    if (!value || value.startsWith('--') || /[\x00-\x1f\x7f]/.test(value)) throw fail('An option needs a valid value.');
    if (key === 'scope') { if (command !== 'approve' || options.scopes.includes(value)) throw fail('Select each requested scope once.'); options.scopes.push(value); }
    else { if (options[key] || key === 'code' && command !== 'approve') throw fail('An option is unsupported or repeated.'); options[key] = value; }
  }
  if (command === 'prepare' && !options.confirmPublic) throw fail('Preparation publishes a public HTTPS endpoint. Pass --confirm-public to authorize it.');
  if (command === 'approve' && (!/^[A-F0-9]{8}$/.test(options.code || '') || !options.scopes.length)) throw fail('Supply the matching eight-character code and at least one --scope.');
  return options;
}
export async function executeChatGPTCLI(options, context = {}) {
  const { request } = await (context.connect || connectBrowserCLI)(options, { ...context, signal: context.signal || AbortSignal.timeout(60000) });
  const base = '/api/chatgpt-connector';
  if (options.command === 'status') return request(base);
  if (options.command === 'prepare') return request(base + '/prepare', { confirmPublic: true });
  if (options.command === 'check') return request(base + '/check-connection', {});
  if (options.command === 'startup') return request(base + '/enable-startup', {});
  if (options.command === 'approve') {
    const state = await request(base);
    const matches = (state.oauth?.requests || []).filter(item => item.displayCode === options.code);
    if (matches.length !== 1 || options.scopes.some(scope => !matches[0].scopes.includes(scope))) throw fail('The code or selected scopes do not match one pending request. Run status and review the authorization page.');
    return request(base + '/approve-access', { id: matches[0].id, scopes: options.scopes });
  }
  throw fail('Use BLACKICE chatgpt --help.');
}
export async function runChatGPTCLI(argv, context = {}) {
  const stdout = context.stdout || process.stdout, stderr = context.stderr || process.stderr;
  try {
    const options = parseChatGPTArgs(argv);
    if (options.command === 'help') { stdout.write(CHATGPT_CLI_HELP); return 0; }
    stdout.write(JSON.stringify(await executeChatGPTCLI(options, context)) + '\n'); return 0;
  } catch (error) {
    const message = error.code === 'BROWSER_CLI_UNCERTAIN'
      ? 'The request may have completed. Run chatgpt status and inspect the result before taking another action.'
      : error.message;
    stderr.write(JSON.stringify({ error: message, code: error.code || 'CHATGPT_CLI_FAILED' }) + '\n'); return 1;
  }
}
