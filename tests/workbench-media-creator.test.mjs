import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {officialWindowsMediaCreatorScript,parseOfficialWindowsMediaCreatorReceipt,
  WORKBENCH_MICROSOFT_MEDIA_TOOL_URL,WORKBENCH_MICROSOFT_MEDIA_TOOL_NAME}
  from '../lib/workbench-media-creator.mjs';
import {WindowsWorkbench} from '../lib/windows-workbench.mjs';
import {discoverWorkbenchMedia} from '../lib/workbench-media-discovery.mjs';

const folder=String.raw`C:\Users\Example\AppData\Roaming\Relay\workbench-media`;
const pathToTool=path.win32.join(folder,WORKBENCH_MICROSOFT_MEDIA_TOOL_NAME);
const receipt=overrides=>JSON.stringify({
  verified:true,cached:true,path:pathToTool,bytes:21591048,
  sha256:'e887dfff70baf09a8c1debfe8c304dd9f2d9652fae8b7c83b3c24554a79bbd7f',
  signer:'CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, C=US',
  launched:true,processId:7654,...overrides});

test('official Microsoft wizard is downloaded, signature-checked and reused without a host Windows upgrade',()=>{
  const script=officialWindowsMediaCreatorScript({mediaDirectory:folder});
  assert.ok(script.includes(WORKBENCH_MICROSOFT_MEDIA_TOOL_URL));
  assert.match(script,/Get-AuthenticodeSignature/);
  assert.match(script,/Microsoft Corporation/);
  assert.match(script,/if\(-not \$cached\)/);
  assert.match(script,/\.partial/);
  assert.match(script,/Move-Item/);
  assert.match(script,/Start-Process -FilePath \$dest/);
  assert.doesNotMatch(script,/(?:setup\.exe|\/auto upgrade|\/Eula Accept)/i);
  assert.ok(!script.includes(folder),'Local Windows path is encoded rather than embedded as executable PowerShell syntax');
  assert.ok(script.includes('ConvertTo-Json'));
});

test('receipt rejects wrong tool, invalid Microsoft signer, unverified launch and malformed output',()=>{
  const expected={mediaDirectory:folder,launch:true};
  assert.deepEqual(parseOfficialWindowsMediaCreatorReceipt(receipt(),expected),{
    verified:true,cached:true,bytes:21591048,path:pathToTool,
    sha256:'e887dfff70baf09a8c1debfe8c304dd9f2d9652fae8b7c83b3c24554a79bbd7f',
    signer:'CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, C=US',
    launched:true,processId:7654
  });
  for(const row of [{path:'C:\\bad.exe'},{signer:'Other Company'},
    {verified:false},{launched:false},{bytes:2},{sha256:'bad'}])
    assert.throws(()=>parseOfficialWindowsMediaCreatorReceipt(receipt(row),expected),
      {code:'WORKBENCH_MEDIA_TOOL_INVALID'});
  assert.throws(()=>parseOfficialWindowsMediaCreatorReceipt('failed',expected),
    {code:'WORKBENCH_MEDIA_TOOL_INVALID'});
});

test('Workbench never opens the signed but interactive Microsoft wizard on the host desktop',async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'workbench-media-focus-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  let shellCalls=0;
  const wb=new WindowsWorkbench({dataDir:dir,sharedRoot:path.join(dir,'workspace'),
    command:async()=>{shellCalls++}});
  await assert.rejects(wb.launchMicrosoftMediaCreator(),{
    code:'WORKBENCH_HOST_FOCUS_PROTECTED',status:503
  });
  assert.equal(shellCalls,0);
});

test('Media Creation Tool default Windows.iso and direct-download Win11 names are discoverable, not generic Linux images',async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'workbench-media-names-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const fs=await import('node:fs/promises');
  for(const name of ['Windows.iso','Win11_25H2_English_x64.iso','linux.iso'])
    await fs.writeFile(path.join(dir,name),'fixture');
  const result=await discoverWorkbenchMedia({directories:[dir],
    inspect:async()=>({size:6*1024**3})});
  assert.deepEqual(result.candidates.map(x=>path.basename(x.path)).sort(),
    ['Win11_25H2_English_x64.iso','Windows.iso'].sort());
});
