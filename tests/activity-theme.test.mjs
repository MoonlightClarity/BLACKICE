import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
test('retained Activity uses an opaque shared workspace surface and current control tokens',async()=>{
 const source=await readFile(new URL('../public/next/chat/activity-inspector.mjs',import.meta.url),'utf8');
 const brand=await readFile(new URL('../public/next/brand.css',import.meta.url),'utf8');
 const css=source.match(/style\.textContent=\x60([\s\S]*?)\x60;/)[1];
 assert.match(css,/background:var\(--next-workspace-background\)/);
 assert.doesNotMatch(css,/var\(--bg\)/);
 for(const token of ['--next-workspace-background','--next-control-background','--text','--muted','--line']){
  assert.ok(css.includes('var('+token+')'),token+' used');
  assert.ok(brand.includes(token+':'),token+' owned by shared theme');
 }
 assert.match(css,/width:min\(850px,94vw\)/);
 assert.match(css,/max-height:88vh/);
});
