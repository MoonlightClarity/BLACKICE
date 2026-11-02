import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const run=promisify(execFile),hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const write=async(file,bytes)=>{await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,bytes)};
async function fixture(t){
  const root=await fs.mkdtemp(path.join(tmpdir(),'blackice-icon-build-'));
  t.after(async()=>{assert.equal(path.dirname(path.resolve(root)).toLowerCase(),path.resolve(tmpdir()).toLowerCase());
    assert.ok(path.basename(root).startsWith('blackice-icon-build-'));await fs.rm(root,{recursive:true,force:true})});
  const files=['scripts/build-workbench-freerdp-client.ps1','desktop/workbench-icon.svg','desktop/workbench-icon.png',
    'desktop/workbench-icon.ico','desktop/workbench-icon.manifest.json','desktop/build-icon.mjs',
    'scripts/workbench-freerdp-client/workbench-icon.rc','.build/workbench-freerdp-compiler/msys64/ucrt64/bin/windres.exe'];
  for(const file of files)await write(path.join(root,file),await fs.readFile(file));
  const source=path.join(root,'scripts/workbench-freerdp-client/main.cpp'),executable=path.join(root,'.build/workbench-freerdp-client.exe');
  await write(source,'fixture source');await write(executable,'not an executable; this must never be started');
  for(const file of ['docs/workbench-freerdp-dependencies.lock.json','docs/workbench-freerdp-compiler.lock.json',
    '.build/runtime/runtime-manifest.json','.build/runtime/etc/ssl/openssl.cnf','.build/runtime/lib/ossl-modules/legacy.dll'])await write(path.join(root,file),'fixture');
  const shaFile=async file=>hash(await fs.readFile(path.join(root,file)));
  const iconResource={resourceId:101};
  for(const [key,file] of Object.entries({svgSha256:files[1],pngSha256:files[2],icoSha256:files[3],manifestSha256:files[4],
    iconBuilderSha256:files[5],rcSha256:files[6],windresSha256:files[7],buildScriptSha256:files[0]}))iconResource[key]=await shaFile(file);
  const receipt={schema:2,source,executable,runtimeDirectory:path.join(root,'.build/runtime'),sha256:hash(await fs.readFile(executable)),
    sourceSha256:hash(await fs.readFile(source)),compilerLockSha256:await shaFile('docs/workbench-freerdp-compiler.lock.json'),
    runtimeLockSha256:await shaFile('docs/workbench-freerdp-dependencies.lock.json'),runtimeManifestSha256:await shaFile('.build/runtime/runtime-manifest.json'),
    selfTest:{iconResourcePresent:true,iconResource}};
  const receiptPath=path.join(root,'.build/workbench-freerdp-client-build.json');await write(receiptPath,JSON.stringify(receipt));
  return {root,receipt,receiptPath,run:()=>run('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(root,files[0]),
    '-SelfTestOnly','-RuntimeDirectory',receipt.runtimeDirectory],{windowsHide:true,timeout:10000,maxBuffer:32768,
    env:{...process.env,PSModulePath:path.join(process.env.SystemRoot||'C:/Windows','System32/WindowsPowerShell/v1.0/Modules')}})};
}
test('SelfTestOnly refuses absent embedded-icon evidence before executing any saved helper',{skip:process.platform!=='win32'},async t=>{
  const f=await fixture(t);delete f.receipt.selfTest.iconResource;await write(f.receiptPath,JSON.stringify(f.receipt));
  await assert.rejects(f.run(),error=>/verified embedded Workbench icon build receipt/.test(error.stderr));
});
test('SelfTestOnly refuses changed RC bytes and build recipes before executing any saved helper',{skip:process.platform!=='win32'},async t=>{
  for(const file of ['scripts/workbench-freerdp-client/workbench-icon.rc','desktop/build-icon.mjs']){
    const f=await fixture(t);await fs.appendFile(path.join(f.root,file),'\nchanged');
    await assert.rejects(f.run(),error=>/embedded icon receipt no longer matches/.test(error.stderr));
  }
});
