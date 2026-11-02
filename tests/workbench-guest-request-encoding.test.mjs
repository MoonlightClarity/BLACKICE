import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
test('Windows PowerShell guest request reader preserves exact BOM-less Unicode and rejects malformed UTF-8',{skip:process.platform!=='win32'},async t=>{
  const root=await fs.mkdtemp(path.join(tmpdir(),'blackice-guest-encoding-'));
  t.after(async()=>{assert.equal(path.dirname(path.resolve(root)).toLowerCase(),path.resolve(tmpdir()).toLowerCase());
    assert.ok(path.basename(root).startsWith('blackice-guest-encoding-'));await fs.rm(root,{recursive:true,force:true})});
  const fixture=path.join(root,'request.json'),text='BLACKICE 🧊\n你好 — δ\r\nC:\\code\\clipboard.txt\t🙂';
  const bytes=Buffer.from(JSON.stringify({args:{text}}),'utf8');assert.notDeepEqual([...bytes.subarray(0,3)],[0xef,0xbb,0xbf]);await fs.writeFile(fixture,bytes);
  const args=['-NoProfile','-NonInteractive','-Sta','-ExecutionPolicy','Bypass','-File',path.resolve('tests/fixtures/workbench-guest-request-encoding.ps1'),
    '-AgentPath',path.resolve('scripts/workbench-guest-agent.ps1'),'-FixturePath',fixture];
  const options={windowsHide:true,timeout:15000,maxBuffer:32768,env:{...process.env,PSModulePath:path.join(process.env.SystemRoot||'C:/Windows','System32/WindowsPowerShell/v1.0/Modules')}};
  const run=promisify(execFile),reply=JSON.parse((await run('powershell.exe',args,options)).stdout.trim());
  assert.equal(reply.characters,text.length);assert.equal(reply.sha256,createHash('sha256').update(text,'utf8').digest('hex'));assert.equal(reply.clipboardAccessed,false);
  await fs.writeFile(fixture,Buffer.from([0x7b,0x22,0x61,0x22,0x3a,0x22,0xc3,0x28,0x22,0x7d]));
  const invalid=JSON.parse((await run('powershell.exe',[...args,'-Invalid'],options)).stdout.trim());
  assert.equal(invalid.invalidUtf8Rejected,true);assert.equal(invalid.clipboardAccessed,false);
});
