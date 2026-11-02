import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const require=createRequire(import.meta.url),{crc32Counter}=require('../verification/probe-workbench-presentation-motion.cjs');
const execute=promisify(execFile),quote=value=>"'"+value.replaceAll("'","''")+"'";
test('independent GDI collector compiles and decodes CRC/black samples without calling window or capture APIs',{skip:process.platform!=='win32'},async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'blackice-gdi-analyzer-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const width=960,height=540,pixels=Buffer.alloc(width*height*4);pixels.fill(Buffer.from([232,220,208,255]));
  const counter=4668;
  for(const [y,value]of [[16,counter],[40,crc32Counter(counter)]])for(let bit=0;bit<32;bit++){
    const rgb=(value>>>bit)&1?[240,196,72]:[96,160,216];
    for(let yy=y;yy<y+16;yy++)for(let x=16+bit*8;x<24+bit*8;x++){
      const at=(yy*width+x)*4;pixels[at]=rgb[2];pixels[at+1]=rgb[1];pixels[at+2]=rgb[0];
    }
  }
  const input=path.join(root,'pixels.bin'),script=path.join(root,'verify.ps1');await writeFile(input,pixels);
  const collector=fileURLToPath(new URL('../verification/workbench-presentation-gdi-readback.ps1',import.meta.url));
  await writeFile(script,`$ErrorActionPreference='Stop'
$text=Get-Content -LiteralPath ${quote(collector)} -Raw
$code=[regex]::Match($text,"(?s)Add-Type -TypeDefinition @'\\r?\\n(.*?)\\r?\\n'@").Groups[1].Value
Add-Type -TypeDefinition $code
$pixels=[IO.File]::ReadAllBytes(${quote(input)})
$good=[BLACKICEPresentationReadback]::Analyze($pixels,960,540,0)
$black=[BLACKICEPresentationReadback]::Analyze([byte[]]::new($pixels.Length),960,540,1)
[ordered]@{counter=$good.counter;counterValid=$good.counterValid;goodBlack=$good.black;goodFlat=$good.flat;black=$black.black;flat=$black.flat;captureInvoked=$false;windowApiInvoked=$false}|ConvertTo-Json -Compress
`);
  const {stdout}=await execute('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-WindowStyle','Hidden','-ExecutionPolicy','Bypass','-File',script],{windowsHide:true,shell:false,timeout:15000,maxBuffer:16000});
  assert.deepEqual(JSON.parse(stdout.trim()),{counter,counterValid:true,goodBlack:false,goodFlat:false,black:true,flat:true,captureInvoked:false,windowApiInvoked:false});
});
