import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {prepareSourceTestTemp} from '../scripts/source-test-temp.mjs';
test('source fixtures use a canonical isolated directory without altering the supplied parent',async t=>{
 const parent=await fs.mkdtemp(path.join(os.tmpdir(),'source-temp-test-'));
 t.after(()=>fs.rm(parent,{recursive:true,force:true}));const env={TEMP:'old',TMP:'old'};
 const result=await prepareSourceTestTemp({parent,env});
 assert.equal(result.canonical,await fs.realpath(parent));assert.equal(path.dirname(result.directory),result.canonical);
 assert.equal(env.TEMP,result.directory);assert.equal(env.TMP,result.directory);assert.equal(env.TMPDIR,result.directory);
 assert.ok((await fs.lstat(parent)).isDirectory());
});
test('a linked ancestor is rejected before changing worker environment or creating fixtures',async()=>{
 const env={TEMP:'original'},parent=path.resolve('synthetic-parent');let made=false;
 const io={realpath:async p=>p,lstat:async()=>({isDirectory:()=>true,isSymbolicLink:()=>true}),mkdtemp:async()=>{made=true;}};
 await assert.rejects(prepareSourceTestTemp({parent,io,env}),/ordinary directories/);
 assert.deepEqual(env,{TEMP:'original'});assert.equal(made,false);
});
