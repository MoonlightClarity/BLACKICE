import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,readFile} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {discoverWorkbenchMedia,workbenchMediaSearchFolders} from '../lib/workbench-media-discovery.mjs';
import {workbenchSetupGuideMarkup} from '../public/next/workspaces/workbench-guide.mjs';

const fixture=async t=>{const dir=await mkdtemp(path.join(tmpdir(),'wb-iso-discovery-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir};

test('existing Windows ISO discovery reuses local files, checks signature via inspector and never downloads or modifies bytes',async t=>{
  const dir=await fixture(t),downloads=path.join(dir,'Downloads');
  await mkdir(downloads);
  const valid=path.join(downloads,'Windows11.iso');
  const invalid=path.join(downloads,'Win11-Incomplete.iso');
  await writeFile(valid,'fixture for inspector');await writeFile(invalid,'invalid data');
  const before=await readFile(valid);
  const seen=[];
  const result=await discoverWorkbenchMedia({directories:[downloads,downloads,path.join(dir,'not-here')],
    inspect:async file=>{seen.push(file);if(file===valid)return {size:7*1024**3};throw Error('Invalid or incomplete ISO')}});
  assert.deepEqual(result.candidates.map(x=>x.path),[valid]);
  assert.equal(result.candidates[0].source,undefined);
  assert.equal(result.source,'existing-local-media');
  assert.equal(seen.length,2,'same directory or candidate must not be checked twice');
  assert.deepEqual(await readFile(valid),before);
  assert.equal(result.candidates[0].size,7*1024**3);
});

test('existing media search visits one ordinary nested installer directory and no arbitrary directory trees',async t=>{
  const dir=await fixture(t),nested=path.join(dir,'Windows-installation');
  await mkdir(nested);const media=path.join(nested,'Win11.iso');await writeFile(media,'fixture');
  const found=await discoverWorkbenchMedia({directories:[dir],inspect:async()=>({size:6*1024**3})});
  assert.deepEqual(found.candidates.map(x=>x.path),[media]);
  const folders=workbenchMediaSearchFolders({home:dir,dataDir:dir,oneDrive:path.join(dir,'Cloud')});
  assert.ok(folders.includes(path.join(dir,'Downloads')));
  assert.ok(folders.includes(path.join(dir,'workbench-media')));
  assert.equal(new Set(folders.map(x=>x.toLowerCase())).size,folders.length);
});

test('the actual Workbench app carries a complete setup and repeated-install guide for people and LLMs',()=>{
  for(const phrase of ['Setup guide','hidden administrator helper','Take control','Cede control','official Microsoft Windows 11 download page',
    'guest bootstrap','Pair &amp; auto-repair','Re-batch saved inventory','Instructions for an LLM','Windows guest licensing'])
    assert.ok(workbenchSetupGuideMarkup.includes(phrase),'Missing in-app step: '+phrase);
});
