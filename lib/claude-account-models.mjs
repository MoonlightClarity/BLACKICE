import { execFile } from 'node:child_process';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';

async function executable() {
  const name = process.platform === 'win32' ? 'claude.exe' : 'claude';
  const dirs = [path.join(homedir(), '.local', 'bin'), ...(process.env.PATH || '').split(path.delimiter).filter(dir => path.isAbsolute(dir))];
  for (const dir of dirs) {
    const paths = [path.join(dir, name)];
    if (process.platform === 'win32') paths.push(path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', name));
    for (const candidate of paths) {
      try { await access(candidate); return candidate; }
      catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; }
    }
  }
  throw Error('Install Claude Code and sign in through its own login flow.');
}

function invoke(file, args, cwd, input = '') {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, { cwd, windowsHide: true, timeout: 15000, killSignal: 'SIGKILL', maxBuffer: 2 * 1024 * 1024 }, (error, stdout) => {
      if (error && !(args[0] === 'auth' && error.code === 1 && stdout.trim())) return reject(Error('Claude Code could not complete ' + (args[0] === 'auth' ? 'the account check.' : 'model discovery.')));
      resolve(stdout);
    });
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') reject(Error('Claude Code input failed.')); });
    child.stdin.end(input);
  });
}

export async function claudeAccountModels({ file, run = invoke } = {}) {
  file ??= await executable();
  const cwd = await mkdtemp(path.join(tmpdir(), 'blackice-claude-'));
  try {
    const status = JSON.parse(await run(file, ['auth', 'status', '--json'], cwd));
    if (status.loggedIn !== true || status.authMethod !== 'claude.ai') throw Error('Sign in to your Claude account through Claude Code, then refresh.');
    const request = { type: 'control_request', request_id: 'catalog', request: { subtype: 'initialize' } };
    const args = ['-p', '--verbose', '--input-format', 'stream-json', '--output-format', 'stream-json',
      '--no-session-persistence', '--strict-mcp-config', '--tools', ''];
    const output = await run(file, args, cwd, JSON.stringify(request) + '\n');
    const messages = output.trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
    const reply = messages.find(m => m.type === 'control_response' && m.response?.request_id === 'catalog')?.response;
    if (reply?.subtype !== 'success') throw Error('Claude Code did not return a successful model list.');
    const models = new Map();
    for (const row of reply.response?.models || []) {
      if (typeof row?.value === 'string' && row.value.trim()) models.set(row.value, {
        id: row.value, name: typeof row.displayName === 'string' && row.displayName.trim() ? row.displayName : row.value
      });
    }
    if (!models.size) throw Error('Claude Code returned no model choices.');
    return [...models.values()];
  } finally { await rm(cwd, { recursive: true, force: true, maxRetries: 3 }); }
}
