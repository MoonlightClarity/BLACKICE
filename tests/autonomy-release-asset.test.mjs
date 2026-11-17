import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,access} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {releaseSourceIndex} from '../scripts/release-request.mjs';
import {approvedWindowsPackageFile} from '../scripts/windows-release-inputs.mjs';
test('built-in skills are absent from source, installer configuration and release inventory',async()=>{
 const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
 assert.doesNotMatch(await readFile(path.join(root,'desktop/electron-builder.yml'),'utf8'),/^\s+- skills\//m);
 assert.equal((await releaseSourceIndex(root)).records.some(row=>row.path.startsWith('skills/')),false);
 for(const relative of ['skills/autonomy/SKILL.md','skills/planning/SKILL.md','skills/planning/CONTRACT-V2.md','skills/planning/references/evidence-preserving-execution.md','skills/browser/SKILL.md','skills/job-search/SKILL.md']){
  await assert.rejects(access(path.join(root,relative)),{code:'ENOENT'});
  assert.equal(approvedWindowsPackageFile(relative,'2.40.3'),false,relative);
 }
});