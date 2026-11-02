// Verify installed compiler bytes against .MTREE digests inside SHA-locked archives.
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execute = promisify(execFile);
const reject = message => { throw new Error(message); };

async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export function readMtreeChecksums(text) {
  if (!text.startsWith('#mtree\n') && !text.startsWith('#mtree\r\n')) reject('Invalid compiler mtree manifest.');
  const defaults = {}, entries = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const [name, ...properties] = line.split(/\s+/);
    if (name === '/unset') { for (const key of properties) delete defaults[key]; continue; }
    const fields = { ...defaults };
    for (const property of properties) {
      const separator = property.indexOf('=');
      if (separator >= 0) fields[property.slice(0, separator)] = property.slice(separator + 1);
    }
    if (name === '/set') { Object.assign(defaults, fields); continue; }
    const member = name.replace(/^\.\//, '').replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
    if (!member.startsWith('ucrt64/')) continue;
    if (member.includes('\\') || member.includes(':') || member.includes('\0') || member.split('/').some(part => !part || part === '.' || part === '..')) reject('Unsafe compiler mtree path.');
    if (fields.type === 'dir') continue;
    if (fields.type !== 'file') reject(`Unsupported compiler archive member type: ${member}`);
    if (!/^[a-f0-9]{64}$/.test(fields.sha256digest ?? '') || !/^\d+$/.test(fields.size ?? '')) reject(`Missing compiler archive checksum: ${member}`);
    entries.push({ path: member, sha256: fields.sha256digest, size: Number(fields.size) });
  }
  if (new Set(entries.map(entry => entry.path.toLowerCase())).size !== entries.length) reject('Duplicate compiler mtree path.');
  return entries;
}

export async function verifyCompiler({ buildRoot, lockPath, tarExecutable }) {
  const lock = JSON.parse(await fs.readFile(lockPath, 'utf8'));
  if (lock.schema !== 1 || lock.compiler?.name !== 'mingw-w64-ucrt-x86_64-gcc' || !lock.packageArtifacts?.length) reject('Invalid compiler lock.');
  const msysRoot = path.join(buildRoot, 'msys64'), results = [];
  let fileCount = 0;
  for (const artifact of lock.packageArtifacts) {
    if (!/^mingw-w64-ucrt-x86_64-[A-Za-z0-9_+.~-]+-any\.pkg\.tar\.zst$/.test(artifact.file) || !/^[a-f0-9]{64}$/i.test(artifact.sha256)) reject('Invalid compiler archive lock.');
    const archive = path.join(msysRoot, 'var/cache/pacman/pkg', artifact.file);
    if (await hashFile(archive) !== artifact.sha256.toLowerCase()) reject(`Compiler archive hash mismatch: ${artifact.file}`);
    const { stdout } = await execute(tarExecutable, ['-xOf', archive, '.MTREE'], { encoding: 'buffer', maxBuffer: 32 * 1024 * 1024, windowsHide: true, timeout: 120000 });
    const entries = readMtreeChecksums(gunzipSync(stdout).toString('utf8'));
    let next = 0;
    await Promise.all(Array.from({ length: 6 }, async () => {
      while (next < entries.length) {
        const entry = entries[next++], target = path.join(msysRoot, entry.path), stat = await fs.lstat(target);
        if (!stat.isFile() || stat.size !== entry.size || await hashFile(target) !== entry.sha256) reject(`Installed compiler file differs from pinned archive: ${entry.path}`);
      }
    }));
    fileCount += entries.length;
    results.push({ archive: artifact.file, sha256: artifact.sha256, filesVerified: entries.length });
  }
  return { verified: true, packages: results.length, filesVerified: fileCount, compiler: lock.compiler,
    executables: await Promise.all(['gcc.exe', 'g++.exe'].map(async name => ({ path: `msys64/ucrt64/bin/${name}`, sha256: await hashFile(path.join(msysRoot, 'ucrt64/bin', name)) }))),
    packageResults: results };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2) reject('Usage: node scripts/verify-workbench-compiler.mjs <build-root> <compiler-lock>');
  const windows = process.env.SystemRoot ?? process.env.WINDIR;
  const result = await verifyCompiler({ buildRoot: path.resolve(args[0]), lockPath: path.resolve(args[1]), tarExecutable: windows ? path.join(windows, 'System32/tar.exe') : 'tar' });
  const receipt = path.join(path.resolve(args[0]), 'compiler-verification.json');
  await fs.writeFile(receipt, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ verified: result.verified, packages: result.packages, filesVerified: result.filesVerified, receipt }, null, 2));
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) main().catch(error => { console.error(error.message); process.exitCode = 1; });
