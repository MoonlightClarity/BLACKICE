import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
test('Knowledge gives folders their own responsive surface, with management initially collapsed',async()=>{
 const source=await readFile(new URL('../public/next/workspaces/knowledge.mjs',import.meta.url),'utf8');
 const css=await readFile(new URL('../public/next/knowledge.css',import.meta.url),'utf8');
 assert.match(source,/<aside class="next-knowledge-folders-panel" aria-label="Folder navigation"><h2>Folders<\/h2>/);
 assert.match(source,/<details class="next-knowledge-folder-actions"><summary>Manage folders<\/summary>/);
 assert.match(source,/<aside class="next-knowledge-entries-panel" aria-label="Saved memories">/);
 assert.match(css,/flex-direction:column;flex-wrap:nowrap/);
 assert.match(css,/\.next-knowledge-root\.next-panel\{background:var\(--next-workspace-background\)\}/);
});
