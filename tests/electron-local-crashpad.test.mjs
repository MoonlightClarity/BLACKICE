import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initializeLocalCrashReporting } from '../desktop/local-crash-reporting.mjs';

test('native crash dumps remain on the same local BLACKICE profile with upload explicitly disabled', async t => {
  const profile=await mkdtemp(path.join(tmpdir(),'blackice-local-crashpad-'));
  t.after(()=>rm(profile,{recursive:true,force:true}));
  const sequence=[];
  const app={
    getPath:name=>{assert.equal(name,'userData');return profile;},
    setPath:(name,value)=>{sequence.push({step:'setPath',name,value});},
  };
  const crashReporter={
    start:options=>{sequence.push({step:'start',options});},
    getUploadToServer:()=>false,
  };
  const receipt=await initializeLocalCrashReporting({app,crashReporter});
  assert.deepEqual({enabled:receipt.enabled,localOnly:receipt.localOnly},{enabled:true,localOnly:true});
  assert.equal(receipt.directory,path.join(profile,'Crashpad'));
  assert.ok((await stat(receipt.directory)).isDirectory());
  assert.equal(sequence[0].step,'setPath');
  assert.equal(sequence[0].name,'crashDumps');
  assert.equal(sequence[0].value,receipt.directory);
  assert.equal(sequence[1].step,'start');
  assert.equal(sequence[1].options.uploadToServer,false);
  assert.equal(sequence[1].options.submitURL,undefined);
  assert.equal(sequence[1].options.productName,'BLACKICE');
  assert.deepEqual(Object.keys(sequence[1].options).sort(),['globalExtra','productName','uploadToServer']);
});

test('non-local crash-reporter consent is not silently accepted', async t=>{
  const profile=await mkdtemp(path.join(tmpdir(),'blackice-local-crashpad-'));
  t.after(()=>rm(profile,{recursive:true,force:true}));
  const app={getPath:()=>profile,setPath:()=>{}};
  const crashReporter={start:()=>{},getUploadToServer:()=>true};
  await assert.rejects(initializeLocalCrashReporting({app,crashReporter}),/not confirmed local-only/);
});

test('reporter initializes before creating an Electron renderer and does not block startup if unavailable',async()=>{
  const main=await readFile(new URL('../desktop/main.mjs',import.meta.url),'utf8');
  const setup=main.indexOf('await initializeLocalCrashReporting({ app, crashReporter })');
  const ready=main.indexOf('app.whenReady()');
  assert.ok(setup>0 && ready>setup);
  assert.match(main,/catch \{ console\.warn\('BLACKICE local-only crash reporting could not initialize\.'\); \}/);
  assert.match(main,/uploadToServer: false/);
});
