import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../public/next/chat/artifacts.mjs',import.meta.url),'utf8');
const css=source.match(/style\.textContent=\x60([\s\S]*?)\x60;/)[1];
const brand=await readFile(new URL('../public/next/brand.css',import.meta.url),'utf8');
test('Directory Context uses shared surfaces rather than a late private navy palette',()=>{
  for(const color of ['#161c27','#243247','#101723','#0b1220','#304e75','#3c526f','#b2ceff'])assert.ok(!css.includes(color),color);
  for(const token of ['--next-workspace-background','--next-button-background','--next-button-hover-background','--next-primary-background','--next-primary-hover-background','--next-primary-foreground','--next-selection-background','--next-selection-border','--next-control-background','--next-control-foreground','--text','--muted','--line','--accent']){
    assert.ok(css.includes('var('+token+')'),token+' used');assert.ok(brand.includes(token+':'),token+' owned by brand');
  }
  assert.match(css,/:focus-visible[^{]*\{outline:2px solid var\(--accent\)/);
  assert.match(css,/@media\(forced-colors:active\)/);
  assert.match(css,/color:HighlightText/);
});
