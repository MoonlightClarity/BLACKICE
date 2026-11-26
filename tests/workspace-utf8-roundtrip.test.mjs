import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {promises as fs} from 'node:fs';
import {createWorkspaceToolHandler} from '../lib/workspace-tools.mjs';

test('Windows agent shell preserves Unicode ledger bytes through 24 read-modify-write cycles', {skip:process.platform!=='win32',timeout:20000},async t=>{
  const cwd=await fs.mkdtemp(path.join(tmpdir(),'blackice-utf8-ledger-'));t.after(()=>fs.rm(cwd,{recursive:true,force:true}));
  const file=path.join(cwd,'applications.json');
  const original={entries:[{employer:'Example \u2014 caf\u00e9',state:'confirmed',evidence:'\u201cApplication submitted\u201d \uD83D\uDE00 \u6F22\u5B57'}]};
  const raw=JSON.stringify(original);
  await fs.writeFile(file,raw,'utf8');
  const handler=createWorkspaceToolHandler({cwd});
  const command="$p=Join-Path (Get-Location) 'applications.json'; for($i=0;$i -lt 24;$i++){ $v=Get-Content -LiteralPath $p -Raw | ConvertFrom-Json; [IO.File]::WriteAllText($p,($v|ConvertTo-Json -Depth 12 -Compress),[Text.UTF8Encoding]::new($false)) }; Get-Item -LiteralPath $p | Select-Object -ExpandProperty Length";
  const response=await handler({name:'relay_workspace',arguments:{action:'run',command,timeoutMs:10000}});
  assert.equal(response.success,true,JSON.stringify(response));
  assert.deepEqual(JSON.parse(await fs.readFile(file,'utf8')),original);
  assert.ok((await fs.stat(file)).size<Buffer.byteLength(raw,'utf8')+50);
});
