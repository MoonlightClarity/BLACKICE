import { readFileSync } from 'node:fs';
import { mkdir, readFile, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/** Hermes-style profile .env credentials; this does not read or copy Hermes files. */
export const providerDiskKeyName = id => {
  if (typeof id !== 'string' || !/^[a-z][a-z0-9_-]{0,39}$/.test(id)) throw new Error('Invalid provider id.');
  return `BLACKICE_PROVIDER_${id.toUpperCase()}_API_KEY`;
};
export const providerDiskFile = dataDir => path.join(dataDir, '.env');
const alias = Object.freeze({
  openrouter: 'OPENROUTER_API_KEY', openrouter_free: 'OPENROUTER_API_KEY',
  openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY',
  huggingface: 'HF_TOKEN', deepinfra: 'DEEPINFRA_API_KEY',
});
const validKey = value => typeof value === 'string' && value.trim().length > 0
  && value.length <= 20000 && !/[\r\n\x00]/.test(value);

export function parseProviderEnv(text) {
  const values = new Map();
  for (const line of String(text).replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    let raw = match[2], value;
    if (raw.startsWith('"')) {
      const quoted = /^("(?:[^"\\]|\\.)*")\s*(?:#.*)?$/.exec(raw);
      if (!quoted) continue;
      try { value = JSON.parse(quoted[1]); } catch { continue; }
    } else if (raw.startsWith("'")) {
      const quoted = /^'([^']*)'\s*(?:#.*)?$/.exec(raw);
      if (!quoted) continue;
      value = quoted[1];
    } else value = raw.replace(/\s+#.*$/, '').trim();
    if (typeof value === 'string') values.set(match[1], value);
  }
  return values;
}

/** Disk takes precedence over inherited process values, like Hermes' profile override. */
export function resolveProviderDiskKey(dataDir, id, { environment = process.env } = {}) {
  const variable = providerDiskKeyName(id), variables = [variable, ...(alias[id] ? [alias[id]] : [])];
  let values = new Map();
  try {
    const file = providerDiskFile(dataDir), stat = readFileSync(file);
    if (stat.byteLength <= 1024 * 1024) values = parseProviderEnv(stat.toString('utf8'));
  } catch (cause) { if (cause?.code !== 'ENOENT' && cause?.code !== 'ENOTDIR') return { value: '', source: 'unavailable', variable }; }
  for (const name of variables) {
    if (validKey(values.get(name))) return { value: values.get(name), source: 'file', variable: name };
  }
  for (const name of variables) {
    if (validKey(environment?.[name])) return { value: environment[name], source: 'environment', variable: name };
  }
  return { value: '', source: 'none', variable };
}

/** Host-only write: the caller supplies a value in memory, never in a tool argument. */
export async function writeProviderDiskKey(dataDir, id, value) {
  const variable = providerDiskKeyName(id);
  if (!validKey(value)) throw new Error('Use a nonempty single-line API key.');
  const file = providerDiskFile(dataDir);
  await mkdir(dataDir, { recursive: true });
  let previous = '';
  try {
    previous = await readFile(file, 'utf8');
    if (Buffer.byteLength(previous, 'utf8') > 1024 * 1024) throw new Error('Profile .env is too large to update.');
  } catch (cause) { if (cause?.code !== 'ENOENT') throw cause; }
  const entries = previous.split(/\r?\n/).filter(line => !new RegExp(`^\\s*(?:export\\s+)?${variable}\\s*=`).test(line));
  while (entries.length && !entries.at(-1)) entries.pop();
  entries.push(`${variable}=${JSON.stringify(value)}`);
  const next = entries.join('\n') + '\n', tmp = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await open(tmp, 'wx', 0o600);
    try { await handle.writeFile(next); await handle.sync(); } finally { await handle.close(); }
    await rename(tmp, file);
  } finally { await rm(tmp, { force: true }).catch(() => {}); }
  return { file, variable };
}
