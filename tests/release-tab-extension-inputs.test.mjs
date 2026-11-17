import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appFingerprint } from '../scripts/release-check.mjs';
import { desktopRuntimeModules } from '../scripts/distribution-manifest.mjs';
import { approvedWindowsPackageFile } from '../scripts/windows-release-inputs.mjs';

const assets = ['manifest.json','tabs.js','tabs.css','README.md'].map(name=>'desktop/tab-folders/'+name);

test('Windows package admits the exact bundled tab extension assets, not neighboring files', async () => {
  for (const file of assets) assert.equal(approvedWindowsPackageFile(file,'2.40.1'),true,file);
  for (const file of ['desktop/tab-folders/extra.js','desktop/tab-folders/sub/tabs.js','desktop/tab-folders/tabs.js.currents-backup-x','desktop/tab-folders/../tabs.js','desktop/tab-folders/data/state.json','desktop/tab-folders/tests/test.js','desktop/tab-folders/.env','desktop/tab-folders-backup/tabs.js'])
    assert.equal(approvedWindowsPackageFile(file,'2.40.1'),false,file);
  const manifest = JSON.parse(await fs.readFile(new URL('../desktop/tab-folders/manifest.json',import.meta.url),'utf8'));
  for (const entry of manifest.content_scripts) for (const file of [...entry.js,...entry.css])
    assert.ok(assets.includes('desktop/tab-folders/'+file),file);
  const packaged = await fs.readFile(new URL('../desktop/electron-builder.yml',import.meta.url),'utf8');
  assert.match(packaged,/^  - desktop\/tab-folders\/\*\*\/\*$/m);
});

test('extension manifest, script, style, documentation and added assets participate in application fingerprints', async t => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'blackice-extension-integrity-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  for(const dir of ['lib','public','desktop/tab-folders'])await fs.mkdir(path.join(root,dir),{recursive:true});
  await fs.writeFile(path.join(root,'package.json'),JSON.stringify({name:'fixture',version:'2.40.1'}));
  for(const file of ['server.mjs','desktop/icon.ico'])await fs.writeFile(path.join(root,file),'fixture');
  const baseline=await appFingerprint(root);
  for(const file of [...assets,'desktop/tab-folders/extra.js']) {
    await fs.writeFile(path.join(root,file),'asset');
    assert.ok((await desktopRuntimeModules(root)).includes(file),file);
    const added=await appFingerprint(root);assert.notEqual(added,baseline,file+' addition');
    await fs.appendFile(path.join(root,file),' changed');
    assert.notEqual(await appFingerprint(root),added,file+' mutation');
    await fs.unlink(path.join(root,file));assert.equal(await appFingerprint(root),baseline,file+' removal');
  }
  for(const file of ['desktop/tab-folders/tabs.js.currents-backup-fixture','desktop/tab-folders/old.ownership-backup','desktop/tab-folders/fixture.test.mjs'])
    await fs.writeFile(path.join(root,file),'not packaged');
  assert.equal(await appFingerprint(root),baseline);
});
