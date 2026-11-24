import { spawn } from 'node:child_process';
import { readFile, mkdtemp, rm, access } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';

const loginHint = 'Open Gemini CLI, sign in with Google, then refresh account models.';

async function command() {
  if (process.platform !== 'win32') return ['gemini', ['--acp']];
  for (const dir of (process.env.PATH || '').split(path.delimiter).filter(dir => path.isAbsolute(dir))) {
    const root = path.join(dir, 'node_modules', '@google', 'gemini-cli');
    try {
      const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
      if (pkg.name !== '@google/gemini-cli' || typeof pkg.bin?.gemini !== 'string') continue;
      const script = path.resolve(root, pkg.bin.gemini);
      if (!script.startsWith(root + path.sep)) continue;
      await access(script);
      return [process.execPath, [script, '--acp']];
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  throw Error('Install the official Gemini CLI and add its npm bin directory to PATH.');
}

export function queryGeminiSession(child, cwd, timeout = 25000) {
  return new Promise((resolve, reject) => {
    let stage = 1, buffer = '', done = false;
    const finish = (error, result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.stdin.end();
      child.kill();
      if (error) reject(error); else resolve(result);
    };
    const timer = setTimeout(() => finish(Error('Gemini CLI model discovery timed out.')), timeout);
    const send = (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: stage, method, params }) + '\n');
    child.on('error', err => finish(Error(err.code === 'ENOENT' ? 'Install Gemini CLI and add it to PATH.' : 'Gemini CLI could not start.')));
    child.stdin.on('error', () => finish(Error('Gemini CLI closed its input.')));
    child.on('close', () => finish(Error('Gemini CLI exited before returning account models.')));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (done) return;
      buffer += chunk;
      if (buffer.length > 1024 * 1024) return finish(Error('Gemini CLI response exceeded the model discovery limit.'));
      let end;
      while (!done && (end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end).trim();
        buffer = buffer.slice(end + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { return finish(Error('Invalid Gemini CLI protocol response.')); }
        if (msg?.method && msg.id != null) return finish(Error('Gemini CLI requested an unsupported client operation.'));
        if (msg?.id !== stage) continue;
        if (msg.error) return finish(Error(msg.error.code === -32000 ? loginHint : 'Gemini CLI rejected model discovery (' + msg.error.code + ').'));
        if (stage === 1) {
          if (msg.result?.protocolVersion !== 1) return finish(Error('Unsupported Gemini CLI protocol version.'));
          stage = 2;
          send('session/new', { cwd, mcpServers: [] });
        } else {
          const rows = msg.result?.models?.availableModels;
          const models = new Map();
          for (const row of Array.isArray(rows) ? rows : []) {
            if (typeof row?.modelId === 'string' && row.modelId.trim())
              models.set(row.modelId, { id: row.modelId, name: typeof row.name === 'string' && row.name.trim() ? row.name : row.modelId });
          }
          if (!models.size) return finish(Error('Gemini CLI returned no account model choices.'));
          finish(null, [...models.values()]);
        }
      }
    });
    send('initialize', { protocolVersion: 1, clientCapabilities: {} });
  });
}

export async function geminiAccountModels() {
  const [exe, args] = await command();
  let settings;
  try { settings = JSON.parse(await readFile(path.join(homedir(), '.gemini', 'settings.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw Error('Unable to read Gemini CLI authentication settings.'); }
  if (settings?.security?.auth?.selectedType !== 'oauth-personal') throw Error(loginHint);
  const cwd = await mkdtemp(path.join(tmpdir(), 'blackice-gemini-'));
  try {
    const child = spawn(exe, args, { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NO_BROWSER: 'true' } });
    const closed = new Promise(resolve => child.once('close', resolve));
    try { return await queryGeminiSession(child, cwd); }
    finally { await closed; }
  } finally { await rm(cwd, { recursive: true, force: true, maxRetries: 3 }); }
}
