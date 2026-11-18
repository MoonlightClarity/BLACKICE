import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
test('retired Swarm workspace assets are removed rather than hidden',()=>{
 for(const file of ['swarm.css','workspaces/swarm.mjs','workspaces/swarm-workbook.mjs'])assert.equal(existsSync(new URL('../public/next/'+file,import.meta.url)),false,file);
});
