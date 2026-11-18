import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
test('workflow manager describes immediate and scheduled use without changing run controls',async()=>{
 const source=await readFile(new URL('../public/next/workspaces/workflow-execution.mjs',import.meta.url),'utf8');
 assert.match(source,/Run one now, or use it in a cronjob/);
 assert.match(source,/id="next-workflow-start">Run workflow/);
});
