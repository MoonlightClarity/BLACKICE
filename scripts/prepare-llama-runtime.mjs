import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  LLAMA_RUNTIME_PIN, LLAMA_RUNTIME_REPAIR_PIN, LLAMA_PATCH_NAMES,
  validateLlamaRepairPin, verifyLlamaRepairManifest, llamaBundleManifest, verifyLlamaFileTree, createLlamaBundleVerifier,
} from '../lib/llama-cpp-bundle.mjs';
export { LLAMA_RUNTIME_PIN };
const execute = promisify(execFile);
const source = path.resolve(fileURLToPath(new URL('..',import.meta.url)));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = message => Object.assign(Error(message),{code:'LLAMA_RUNTIME_PREPARATION'});
const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
async function readPinned(filename, expected) {
  const stat = await fs.lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== expected.size) throw fail('A required runtime input is missing, linked, or has the wrong size.');
  const bytes = await fs.readFile(filename);
  if (hash(bytes) !== expected.sha256) throw fail('A required runtime input failed its checksum.');
  return bytes;
}
async function extractArchive(archive,target) {
  const quote = value => "'"+value.replaceAll("'","''")+"'";
  // Preflight every ZIP entry before extraction. Even fixture archives cannot escape.
  const script = [
    'Add-Type -AssemblyName System.IO.Compression.FileSystem',
    '$z=[System.IO.Compression.ZipFile]::OpenRead('+quote(archive)+')',
    'try {',
    '$names=New-Object "System.Collections.Generic.HashSet[string]" ([System.StringComparer]::OrdinalIgnoreCase)',
    'foreach($e in $z.Entries) {',
    'if($e.FullName -ne $e.Name -or $e.Name -notmatch "^[A-Za-z0-9][A-Za-z0-9._-]*$" -or $e.Name.EndsWith(".") -or $e.Name -match "^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\\.|$)" -or -not $names.Add($e.Name)) {throw "Unexpected or duplicate archive path"}',
    '}',
    'foreach($e in $z.Entries) {[System.IO.Compression.ZipFileExtensions]::ExtractToFile($e,[System.IO.Path]::Combine('+quote(target)+',$e.Name),$false)}',
    '} finally {$z.Dispose()}',
  ].join('; ');
  await execute('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,timeout:60000,maxBuffer:65536});
}
async function repairInputs(repairBundle,pin,sourceRoot) {
  if (typeof repairBundle !== 'string' || !repairBundle.trim()) throw fail('Supply the accepted repairBundle directory (or BLACKICE_LLAMA_REPAIR_BUNDLE for the packaging command).');
  const root = path.resolve(repairBundle), info = await fs.lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) throw fail('The repair bundle must be an ordinary directory.');
  const bytes = await readPinned(path.join(root,'manifest.json'),pin.buildManifest);
  verifyLlamaRepairManifest(bytes,pin);
  await verifyLlamaFileTree(root,pin.repairFiles,{manifestBytes:bytes});
  const patchBytes = new Map();
  for (const patch of pin.patches) patchBytes.set(patch.name,await readPinned(path.join(sourceRoot,'verification','minicpm-agent-tools-v2',patch.name),patch));
  const license = await readPinned(path.join(sourceRoot,'desktop','llama.cpp-LICENSE'),pin.files.find(file=>file.path === 'LICENSE'));
  const executable = await readPinned(path.join(root,'bin','llama-server.exe'),pin.executable);
  return {root,patchBytes,license,executable};
}
function createPreparer(repairPin,{sourceRoot=source,platform=process.platform,arch=process.arch,extract=extractArchive,rename=fs.rename}={}) {
  return async function prepare({destination,cache,repairBundle,fetchImpl=fetch}={}) {
    if (platform !== 'win32' || arch !== 'x64') throw fail('Bundled runtime packaging currently supports Windows x64 only.');
    const pin = validateLlamaRepairPin(repairPin), manifest = llamaBundleManifest(pin);
    if (typeof destination !== 'string' || !destination.trim() || typeof cache !== 'string' || !cache.trim()) throw fail('Supply dedicated destination and cache directories.');
    const target = path.resolve(destination), parent = path.dirname(target), cacheRoot = path.resolve(cache);
    if (parent === target) throw fail('The runtime destination cannot be a filesystem root.');
    const inputs = await repairInputs(repairBundle,pin,sourceRoot);
    const contains = (outer,inner) => {const relative=path.relative(outer,inner);return !relative || !relative.startsWith('..'+path.sep) && relative !== '..' && !path.isAbsolute(relative);};
    if ([inputs.root,cacheRoot,path.resolve(sourceRoot)].some(input=>contains(target,input))) throw fail('The runtime destination must not contain its source inputs.');
    const previousInfo = await fs.lstat(target).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
    if (previousInfo && (!previousInfo.isDirectory() || previousInfo.isSymbolicLink())) throw fail('The existing runtime destination must be an ordinary directory.');
    // No destination staging or deletion occurs until all repair inputs are verified.
    await fs.mkdir(cacheRoot,{recursive:true});
    const cacheInfo = await fs.lstat(cacheRoot);
    if (!cacheInfo.isDirectory() || cacheInfo.isSymbolicLink()) throw fail('The archive cache must be an ordinary directory.');
    const archives = new Map();
    for (const backend of ['cpu','vulkan']) {
      const asset = pin.archives[backend], archive = path.join(cacheRoot,asset.name);
      const archiveInfo = await fs.lstat(archive).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
      if (archiveInfo && (!archiveInfo.isFile() || archiveInfo.isSymbolicLink())) throw fail('The cached archive must be an ordinary file.');
      let bytes = archiveInfo ? await fs.readFile(archive) : null;
      if (!bytes || bytes.length !== asset.size || hash(bytes) !== asset.sha256) {
        const response = await fetchImpl('https://github.com/ggml-org/llama.cpp/releases/download/b12359/'+asset.name,{signal:AbortSignal.timeout(180000)});
        if (!response.ok) throw fail('Official llama.cpp runtime download failed: '+response.status);
        bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length !== asset.size || hash(bytes) !== asset.sha256) throw fail('Official llama.cpp runtime checksum mismatch.');
        await fs.writeFile(archive,bytes);
      }
      archives.set(backend,bytes);
    }
    await fs.mkdir(parent,{recursive:true});
    const stage = await fs.mkdtemp(path.join(parent,'.llama-runtime-stage-')), previous = stage+'.previous';
    let previousMoved = false, promoted = false;
    try {
      for (const backend of ['cpu','vulkan']) {
        const folder = path.join(stage,backend), archive = path.join(stage,pin.archives[backend].name);
        await fs.mkdir(folder);
        // Extract the validated in-memory snapshot, never a later mutation of the cache.
        await fs.writeFile(archive,archives.get(backend),{flag:'wx'});
        await extract(archive,folder);
        await fs.unlink(archive);
        for (const entry of await fs.readdir(folder,{withFileTypes:true})) {
          const filename = path.join(folder,entry.name), stat = await fs.lstat(filename);
          if (!stat.isFile() || stat.isSymbolicLink()) throw fail('Unexpected upstream runtime archive layout.');
          if (!entry.name.endsWith('.dll') && entry.name !== 'llama-server.exe' && !entry.name.startsWith('LICENSE')) await fs.unlink(filename);
        }
        if (!(await fs.stat(path.join(folder,'llama-server.exe')).catch(()=>null))?.isFile()) throw fail('The official archive is missing its server executable.');
        // Preserve the backend's official dependency and license files; replace only EXE.
        await fs.writeFile(path.join(folder,'llama-server.exe'),inputs.executable);
      }
      await fs.writeFile(path.join(stage,'LICENSE'),inputs.license,{flag:'wx'});
      await fs.mkdir(path.join(stage,'patches'));
      for (const [name,bytes] of inputs.patchBytes) await fs.writeFile(path.join(stage,'patches',name),bytes,{flag:'wx'});
      await fs.writeFile(path.join(stage,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
      const runtime = await createLlamaBundleVerifier(pin)({root:stage});
      const current = await fs.lstat(target).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
      if (current && (!current.isDirectory() || current.isSymbolicLink())) throw fail('The runtime destination changed before promotion.');
      try { await rename(target,previous); previousMoved = true; } catch(error) { if(error.code !== 'ENOENT') throw error; }
      try { await rename(stage,target); promoted = true; }
      catch(error) { if(previousMoved){await rename(previous,target);previousMoved=false;}throw error; }
      return {destination:target,files:runtime.files.length,bytes:runtime.bytes,runtime};
    } finally {
      if (!promoted) await fs.rm(stage,{recursive:true,force:true});
      if (promoted && previousMoved) await fs.rm(previous,{recursive:true,force:true});
    }
  };
}
export async function prepareLlamaRuntime(options={}) {
  const pin = validateLlamaRepairPin(LLAMA_RUNTIME_REPAIR_PIN);
  for (const backend of ['cpu','vulkan']) if (!same(pin.archives[backend],LLAMA_RUNTIME_PIN[backend])) throw fail('The production runtime must use the pinned official CPU and Vulkan archives.');
  return createPreparer(pin)(options);
}
// Synthetic pins and extractor failures are injectable only through this internal test seam.
export const llamaPreparationTest = Object.freeze({createPreparer});
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Build-only local input. This path never enters public provenance or user settings.
  console.log(await prepareLlamaRuntime({destination:path.join(source,'.build/llama.cpp'),cache:path.join(source,'.build/llama-cache'),repairBundle:process.env.BLACKICE_LLAMA_REPAIR_BUNDLE}));
}
