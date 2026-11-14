import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {releaseSourceIndex} from '../scripts/release-request.mjs';

test('Autonomy runtime skill is included in installer and bound to source evidence',async()=>{
  const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
  const config=await readFile(path.join(root,'desktop/electron-builder.yml'),'utf8');
  assert.match(config,/^\s+- skills\/autonomy\/\*\*\/\*\s*$/m);
  const index=await releaseSourceIndex(root);
  assert.ok(index.records.some(row=>row.path==='skills/autonomy/SKILL.md'));
});
