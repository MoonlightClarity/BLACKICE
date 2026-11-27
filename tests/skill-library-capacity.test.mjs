import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createSkillLibrary} from '../lib/skill-library.mjs';
import {InstalledSkillLibrary} from '../lib/installed-skill-library.mjs';

const entry=(number,extra={})=>({
 id:'library-capacity-'+String(number).padStart(5,'0'),
 title:'Capacity method '+number,
 description:'A bounded native procedure for inspecting assumptions and checking an explicit result.',
 tags:['capacity'],aliases:['native capacity'],
 source:{kind:'first-party',revision:'capacity-fixture'},
 bodyFile:'capacity-'+number+'.md',...extra,
});
async function fixture(t,entries){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'blackice-library-capacity-'));
 const root=path.join(directory,'source');
 await fs.mkdir(root);
 const file=path.join(root,'index.json');
 const write=()=>fs.writeFile(file,JSON.stringify({version:1,entries}));
 await write();
 const installed=new InstalledSkillLibrary({dataDir:path.join(directory,'data')});
 t.after(async()=>{await installed.close();await fs.rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:50});});
 return {root,file,write,installed};
}

test('native metadata beyond ten thousand entries and eight MiB remains selectively installable',async t=>{
 const rich={
  description:'Inspect assumptions and verify the resulting calculation. '+ 'x'.repeat(200),
  tags:Array.from({length:12},(_,i)=>'capacity-tag-'+String(i).padStart(2,'0')+'-'+'x'.repeat(14)),
  aliases:Array.from({length:8},(_,i)=>'capacity phrase '+i+' '+'x'.repeat(28)),
 };
 const entries=Array.from({length:10017},(_,i)=>entry(i,rich));
 const {root,file,write,installed}=await fixture(t,entries);
 assert.ok((await fs.stat(file)).size>8*1024*1024,'fixture exceeds the old aggregate byte limit');
 const target=entries.at(-1),body='# Selected deep method\n\nKeep this exact native procedure.\n';
 await fs.writeFile(path.join(root,target.bodyFile),body);
 const library=createSkillLibrary({root});
 const metadata=await library.list();
 assert.equal(metadata.length,10017);
 assert.ok(metadata.every(row=>!Object.hasOwn(row,'content')&&!Object.hasOwn(row,'bodyFile')));
 const selected=await library.metadata(target.id);
 assert.equal(selected.title,target.title);
 assert.deepEqual(selected.tags,target.tags);
 assert.deepEqual(selected.aliases,target.aliases);
 assert.equal((await library.read(target.id)).content,body);
 assert.deepEqual((await fs.readdir(root)).sort(),['index.json',target.bodyFile].sort(),'unselected bodies are not required for metadata or selected import');
 const receipt=await installed.install({root,ids:[target.id],expectedVersion:0});
 assert.equal(receipt.installed,1);
 assert.equal(receipt.version,1);
 assert.equal((await installed.list()).length,1);
 const saved=await installed.read(target.id);
 assert.equal(saved.content,body);
 assert.deepEqual(saved.tags,target.tags);
 assert.deepEqual(saved.aliases,target.aliases);

 // Validation still reaches metadata beyond the former entry boundary.
 target.title='x'.repeat(101);
 await write();
 await assert.rejects(createSkillLibrary({root}).list(),/Invalid or duplicate packaged skill library entry/);
 await assert.rejects(installed.install({root,ids:[target.id],expectedVersion:1}),/Invalid or duplicate packaged skill library entry/);
 assert.equal(await installed.getVersion(),1);
 assert.equal((await installed.read(target.id)).content,body,'invalid metadata cannot replace an installed document');
});

test('removing aggregate manifest limits preserves individual body validation and failed-import atomicity',async t=>{
 const row=entry(1),{root,installed}=await fixture(t,[row]);
 const file=path.join(root,row.bodyFile),original='# Preserved body\n\nA valid native method.\n';
 await fs.writeFile(file,original);
 await installed.install({root,expectedVersion:0});
 for(const [name,body] of [
  ['empty',''],
  ['NUL','# Invalid\n\nA\0B'],
  ['character limit','# Invalid\n\n'+'x'.repeat(200000)],
  ['byte limit',Buffer.alloc(800001,120)],
  ['invalid UTF-8',Buffer.from([0xc3,0x28])],
 ]){
  await fs.writeFile(file,body);
  await assert.rejects(createSkillLibrary({root}).read(row.id),/Invalid packaged skill body|body is unavailable/,name);
  await assert.rejects(installed.install({root,expectedVersion:1}),/Invalid packaged skill body|body is unavailable/,name);
  assert.equal(await installed.getVersion(),1,name+' must not advance the generation');
  assert.equal((await installed.read(row.id)).content,original,name+' must preserve the installed body');
 }
});
