import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';
import {approvedWindowsPackageFile} from '../scripts/windows-release-inputs.mjs';
test('folder UI is app-owned and obsolete extension assets are not shipped or loaded',async()=>{
 for(const f of ['manifest.json','tabs.js','tabs.css','README.md'])assert.equal(approvedWindowsPackageFile('desktop/tab-folders/'+f,'2.40.5'),false);
 const builder=await readFile(new URL('../desktop/electron-builder.yml',import.meta.url),'utf8'),main=await readFile(new URL('../desktop/main.mjs',import.meta.url),'utf8');
 assert.doesNotMatch(builder,/desktop\/tab-folders/);assert.doesNotMatch(main,/loadExtension\([^\n]*tab-folders/);
 const renderer=await readFile(new URL('../public/next/workspaces/browser-folders.mjs',import.meta.url),'utf8');assert.doesNotMatch(renderer,/data-blackice-tab-model|MutationObserver|blackice-tab-action/);assert.match(renderer,/folder-tree\.mjs/);
});
