/**
 * Stage a disposable BLACKICE Electron copy for native, headless QA.
 * Runtime files are copied rather than hardlinked, so the disposable test
 * directory remains removable while the installed BLACKICE app is running.
 * App sources and test profiles are completely separate.
 * The install and default user profile are NEVER modified or restarted.
 *
 * Usage (Windows only):
 *   node scripts/stage-disposable-electron.mjs
 *   $env:BLACKICE_DISPOSABLE_STAGE='<printed stage directory>'
 *   node tests/electron-disposable-smoke.mjs
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promises as fs } from 'node:fs';

if (process.platform !== 'win32') throw Error('Disposable Electron staging requires Windows.');
const root=fileURLToPath(new URL('../',import.meta.url));
const base=process.env.LOCALAPPDATA;
if(!base)throw Error('LOCALAPPDATA is unavailable.');
const installed=process.env.BLACKICE_INSTALLED_DIR ||
  path.join(base,'Programs','Agent Desk');
const stage=process.env.BLACKICE_DISPOSABLE_STAGE ||
  path.join(root,'.build','electron-breakpoint-generated');
const sourceApp=path.join(installed,'resources','app');
const targetApp=path.join(stage,'resources','app');
const allowedRoot=path.resolve(path.join(root,'.build'))+path.sep;
if(!path.resolve(stage).startsWith(allowedRoot))
  throw Error('Disposable stage must remain under the repository build directory.');
try{await fs.access(stage);throw Error('The selected disposable stage already exists; choose a new stage path.');}
catch(error){if(error.code!=='ENOENT')throw error;}
const exists=async value=>{try{await fs.access(value);return true;}catch{return false;}};
if(!await exists(path.join(installed,'BLACKICE.exe')) ||
    !await exists(path.join(sourceApp,'desktop','main.mjs')))
  throw Error('The installed BLACKICE Electron runtime is unavailable.');
let completed=false;
try {
  await fs.mkdir(stage,{recursive:true});
  // Copies must be independently removable, including while the installed
  // executable is mapped by Windows (deleting a hardlink can be denied).
  for(const file of await fs.readdir(installed,{withFileTypes:true})){
    if(!file.isFile()||file.name.startsWith('Uninstall '))continue;
    await fs.copyFile(path.join(installed,file.name),path.join(stage,file.name));
  }
  await fs.cp(path.join(installed,'locales'),path.join(stage,'locales'),{recursive:true});
  await fs.mkdir(path.join(stage,'resources'),{recursive:true});
  const ignores=new Set(['data','workspace','node_modules','.env']);
  await fs.cp(sourceApp,targetApp,{recursive:true,
    filter:src=>{
      const relative=path.relative(sourceApp,src);
      return !relative || !ignores.has(relative.split(path.sep)[0]);
    },
  });
  for(const folder of ['desktop','lib','public'])
    await fs.cp(path.join(root,folder),path.join(targetApp,folder),{recursive:true,force:true});
  for(const file of ['server.mjs','package.json'])
    await fs.copyFile(path.join(root,file),path.join(targetApp,file));
  const main=path.join(targetApp,'desktop','main.mjs');
  const source=await fs.readFile(main,'utf8');
  const needle='    harness = local.instance;\n';
  if(!source.includes(needle))throw Error('Disposable hook anchor changed; do not run an unverified test.');
  const hook=await fs.readFile(new URL('../tests/fixtures/disposable-native-cleanup-hook.inc',import.meta.url),'utf8');
  if(!hook.includes("process.env.BLACKICE_NATIVE_EVENT_TEST === '1'") ||
      !hook.includes('launch.headless && launch.profileDir'))
    throw Error('The isolated native test hook lacks its profile/visibility guards.');
  const hiddenRendererHook=await fs.readFile(new URL('../tests/fixtures/disposable-hidden-renderer-hook.inc',import.meta.url),'utf8');
  if(!hiddenRendererHook.includes("process.env.BLACKICE_NATIVE_EVENT_TEST === '1'") ||
      !hiddenRendererHook.includes('launch.headless && launch.profileDir') ||
      !hiddenRendererHook.includes('show: false, focusable: false'))
    throw Error('The hidden Electron renderer hook lacks isolation/visibility guards.');
  await fs.writeFile(main,source.replace(needle,needle+hook+hiddenRendererHook));
  await fs.writeFile(path.join(stage,'disposable-smoke-marker.json'),JSON.stringify({
    generated:true,profile:'isolated-required',
    sourceVersion:JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8')).version,
  }));
  completed=true;
  console.log('STAGED_DISPOSABLE_ELECTRON '+stage);
  console.log('NO_USER_PROFILE_OR_PRODUCTION_APP_MODIFIED');
} finally {
  if(!completed)await fs.rm(stage,{recursive:true,force:true,maxRetries:3,retryDelay:300}).catch(()=>{});
}
