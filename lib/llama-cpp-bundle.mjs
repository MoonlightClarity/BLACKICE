import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execute = promisify(execFile);
export const LLAMA_BUNDLE_VERSION = 'v1.0.0 (b12359)';
export const defaultBundleRoot = () => typeof process.resourcesPath === 'string' ? path.join(process.resourcesPath, 'llama.cpp') : null;
export async function inspectLlamaBundle({root = defaultBundleRoot(), platform = process.platform, arch = process.arch, run = execute} = {}) {
  const unavailable = message => ({available:false,source:'unavailable',version:LLAMA_BUNDLE_VERSION,backend:null,message});
  if (platform !== 'win32' || arch !== 'x64') return unavailable('The bundled runtime is available for Windows x64. An existing local server or custom runtime can still be used.');
  if (!root) return unavailable('Bundled runtime unavailable in this development checkout. Prepare the pinned runtime or use a custom executable.');
  let manifest;
  try { manifest = JSON.parse(await fs.readFile(path.join(root,'manifest.json'),'utf8')); }
  catch { return unavailable('The bundled runtime is missing. Repair or reinstall BLACKICE; existing model files will not be changed.'); }
  if (manifest.version !== LLAMA_BUNDLE_VERSION || !Array.isArray(manifest.files) || !manifest.files.length) return unavailable('The bundled runtime manifest is invalid.');
  try {
    for (const file of manifest.files) {
      if (!/^(cpu|vulkan)\/[a-zA-Z0-9._-]+$/.test(file.path) || !/^[a-f0-9]{64}$/.test(file.sha256)) throw Error();
      const filename = path.join(root,file.path), info = await fs.lstat(filename);
      if (!info.isFile() || info.isSymbolicLink() || info.size !== file.size || createHash('sha256').update(await fs.readFile(filename)).digest('hex') !== file.sha256) throw Error();
    }
    for (const backend of ['cpu','vulkan']) if (!manifest.files.some(file=>file.path === backend+'/llama-server.exe')) throw Error();
  } catch { return unavailable('The bundled runtime failed its integrity check. Repair BLACKICE; model files and settings are untouched.'); }
  const cpu = path.join(root,'cpu','llama-server.exe'), vulkan = path.join(root,'vulkan','llama-server.exe');
  try {
    const probe = await run(vulkan,['--list-devices'],{cwd:path.dirname(vulkan),windowsHide:true,timeout:10000,maxBuffer:65536});
    if (/^\s*Vulkan\d+:\s+\S/m.test(probe.stdout || '')) return {available:true,source:'bundled',version:LLAMA_BUNDLE_VERSION,backend:'Vulkan',executablePath:vulkan,fallbackPath:cpu,message:'Bundled runtime ready. Compatible Vulkan GPU detected; CPU fallback is included.'};
  } catch { /* Driver absence/failure is ordinary: use the independent CPU build. */ }
  try { await run(cpu,['--version'],{cwd:path.dirname(cpu),windowsHide:true,timeout:10000,maxBuffer:65536}); }
  catch { return unavailable('The bundled CPU runtime cannot start on this computer. Use a compatible custom runtime or external server.'); }
  return {available:true,source:'bundled',version:LLAMA_BUNDLE_VERSION,backend:'CPU',executablePath:cpu,message:'Bundled runtime ready. CPU selected because no working Vulkan device was detected.'};
}
