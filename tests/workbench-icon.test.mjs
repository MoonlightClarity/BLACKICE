import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const run=promisify(execFile);
test('Workbench icon has distinct self-contained BLACKICE vector geometry and seven exact native raster sizes',async()=>{
  const [svg,png,ico,manifest,mainIco]=await Promise.all(['desktop/workbench-icon.svg','desktop/workbench-icon.png','desktop/workbench-icon.ico','desktop/workbench-icon.manifest.json','desktop/icon.ico'].map(file=>readFile(file)));
  const metadata=JSON.parse(manifest);
  assert.equal(metadata.source,'workbench-icon.svg');assert.equal(metadata.sourceSha256,hash(svg));assert.equal(metadata.pngSha256,hash(png));assert.equal(metadata.icoSha256,hash(ico));
  assert.notEqual(hash(ico),hash(mainIco));assert.doesNotMatch(svg.toString(),/<image\b|<script\b|<foreignObject\b|\bhref\s*=|@import|data:/i);
  assert.equal(png.readUInt32BE(16),512);assert.equal(png.readUInt32BE(20),512);
  assert.equal(ico.readUInt16LE(0),0);assert.equal(ico.readUInt16LE(2),1);assert.equal(ico.readUInt16LE(4),7);
  const sizes=[];
  for(let index=0;index<7;index++){
    const at=6+index*16,size=ico[at]||256,bytes=ico.readUInt32LE(at+8),offset=ico.readUInt32LE(at+12);
    assert.equal(ico[at+1]||256,size);assert.equal(ico.readUInt16LE(at+6),32);assert.ok(offset>=118&&offset+bytes<=ico.length);
    const image=ico.subarray(offset,offset+bytes);assert.deepEqual(image.subarray(0,8),Buffer.from([137,80,78,71,13,10,26,10]));
    assert.equal(image.readUInt32BE(16),size);assert.equal(image.readUInt32BE(20),size);sizes.push(size);
  }
  assert.deepEqual(sizes,[16,24,32,48,64,128,256]);assert.deepEqual(metadata.sizes,sizes);
});
test('pinned hidden Electron exactly reproduces Workbench and original brand icon assets',{skip:process.platform!=='win32',timeout:35000},async()=>{
  const electron=path.resolve('node_modules/electron/dist/electron.exe'),builder=path.resolve('desktop/build-icon.mjs');
  const results=await Promise.all([['--workbench','--check'],['--check']].map(flags=>run(electron,[builder,...flags],{windowsHide:true,timeout:30000,maxBuffer:32768})));
  for(const {stdout} of results)assert.equal(JSON.parse(stdout.trim()).ok,true);
});
