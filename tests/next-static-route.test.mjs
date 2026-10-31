import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,stat} from 'node:fs/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
import path from 'node:path';

const base=fileURLToPath(new URL('../',import.meta.url));
const read=relative=>readFile(path.join(base,relative),'utf8');

test('the current interface starts by default without a Classic fallback control',async()=>{
  const server=await read('server.mjs');
  assert.match(server,/files\['\/'\]\s*=\s*'next\/index\.html'/);
  assert.match(server,/files\['\/next'\]\s*=\s*'next\/index\.html'/);
  assert.match(server,/files\['\/next\/'\]\s*=\s*'next\/index\.html'/);
  const next=await read('public/next/index.html');
  assert.match(next,/\/next\/app\.mjs/);
  assert.doesNotMatch(next,/<script\b[^>]*\/app\.js/);
  assert.match(next,/\/next\/guard\.js/);
  const settings=await read('public/next/workspaces/settings.mjs');
  assert.doesNotMatch(next+settings,/href=["']\/legacy\/?["']|Open classic interface|Classic interface fallback/i);
});

test('every frontend static file is declared in BLACKICE HTTP allowlist',async()=>{
  const source=await read('server.mjs');
  const snippet=source.split('const nextFiles = ')[1]?.split('for (const file of nextFiles)')[0];
  assert.ok(snippet,'New route mapping must be present.');
  const entries=[...snippet.matchAll(/'([^']+\.(?:mjs|js|css|html))'/g)].map(match=>match[1]);
  assert.ok(entries.length>=16,'Every v2 module should be exposed explicitly.');
  for(const file of entries) {
    const info=await stat(path.join(base,'public/next',file));
    assert.ok(info.isFile(),file+' is missing.');
  }
  assert.match(source,/files\['\/native-apps-ui\.mjs'\]\s*=\s*'native-apps-ui\.mjs'/);
  assert.match(source,/files\['\/native-apps\.css'\]\s*=\s*'native-apps\.css'/);
  await stat(path.join(base,'public/native-apps-ui.mjs'));
  await stat(path.join(base,'public/native-apps.css'));
});

test('import graph is self-contained and does not require legacy app startup',async()=>{
  const source=await read('server.mjs');
  const snippet=source.split('const nextFiles = ')[1].split('for (const file of nextFiles)')[0];
  const paths=[...snippet.matchAll(/'([^']+\.(?:mjs|js))'/g)].map(x=>path.join(base,'public/next',x[1]));
  for(const file of paths){
    const source=await readFile(file,'utf8');
    const imports=[...source.matchAll(/(?:from\s*|import\s*\()['"](\.[^'"]+)['"]/g)].map(x=>x[1]);
    for(const imported of imports){
      const resolved=fileURLToPath(new URL(imported,pathToFileURL(file)));
      try{const info=await stat(resolved);assert.ok(info.isFile());}
      catch(error){assert.fail(path.relative(base,file)+' imports missing '+imported+': '+error.message);}
      assert.ok(!resolved.endsWith('/public/app.js'), 'V2 imports the old monolithic frontend');
    }
  }
});

test('packaging retains the native Windows host implementation',async()=>{
  const builder=await read('desktop/electron-builder.yml');
  assert.match(builder,/desktop\/\*\*\/\*\.cs/);
  assert.match(builder,/desktop\/\*\*\/\*\.ps1/);
  const native=await read('desktop/native-app-host.mjs');
  assert.match(native,/class NativeAppHost/);
});
