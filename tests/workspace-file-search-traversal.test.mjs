import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createFileSearch } from '../lib/workspace-file-search.mjs';
async function fixture(t) {
 const root=await fs.mkdtemp(path.join(tmpdir(),'wide-find-test-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 return {root,search:createFileSearch({cwd:root,scope:randomUUID()})};
}
async function drain(search,args) {
 const pages=[]; for(let i=0;i<1000;i++){const p=await search(args);pages.push(p);if(!p.cursor)return pages;args={cursor:p.cursor,limit:100,timeoutMs:10000};}
 assert.fail('Traversal failed to terminate');
}
test('huge first root does not starve a nested priority root, and duplicate directory aliases terminate',async t=>{
 const {root,search}=await fixture(t),nested=path.join(root,'Documents');await fs.mkdir(nested);
 for(let i=0;i<200;i++)await fs.writeFile(path.join(root,'noise-'+i),'');
 await fs.writeFile(path.join(nested,'wanted.txt'),'ok');
 const page=await search({roots:[root,nested],query:'wanted',limit:1,timeoutMs:10000});
 assert.equal(page.matches[0].path,path.join(nested,'wanted.txt'));
 assert.deepEqual(page.roots,[root,nested]);assert.equal(page.rootsAttempted,2);
 assert.ok(page.scannedEntries<20,'priority nested seed gets a turn before root drains');
 const pages=await drain(search,{cursor:page.cursor});assert.equal(pages.flatMap(p=>p.matches).length,0);
 assert.equal(pages.at(-1).searchComplete,true);
});
test('follows junctions beyond requested root, deduplicates cycles and preserves cursor replay',async t=>{
 const {root,search}=await fixture(t),a=path.join(root,'a'),b=path.join(root,'b');await fs.mkdir(a);await fs.mkdir(b);
 await fs.writeFile(path.join(b,'wanted-one.txt'),'one');await fs.writeFile(path.join(b,'wanted-two.txt'),'two');
 await fs.symlink(b,path.join(a,'outward'),process.platform==='win32'?'junction':'dir');
 await fs.symlink(a,path.join(b,'cycle'),process.platform==='win32'?'junction':'dir');
 const first=await search({path:a,query:'wanted',limit:1,timeoutMs:10000});
 const second=await search({cursor:first.cursor,limit:1,timeoutMs:10000});
 assert.deepEqual(await search({cursor:first.cursor,limit:1}),second);
 const rest=await drain(search,{cursor:second.cursor});
 assert.equal([first,second,...rest].flatMap(p=>p.matches).length,2);
 assert.equal(rest.at(-1).searchComplete,true);assert.equal(rest.at(-1).skippedCount,0);
});
test('deep directories have no arbitrary depth64 exclusion and hidden files participate',async t=>{
 const {root,search}=await fixture(t);let dir=root;for(let i=0;i<70;i++){dir=path.join(dir,'d');await fs.mkdir(dir);}
 const wanted=path.join(dir,'.wanted');await fs.writeFile(wanted,'');
 const pages=await drain(search,{path:root,query:'wanted',timeoutMs:10000});
 assert.deepEqual(pages.flatMap(p=>p.matches.map(m=>m.path)),[wanted]);assert.equal(pages.at(-1).searchComplete,true);
});
test('reports broken link and inaccessible directory while continuing readable siblings',async t=>{
 const {root,search}=await fixture(t),blocked=path.join(root,'blocked');await fs.mkdir(blocked);await fs.writeFile(path.join(root,'wanted'),'');
 await fs.symlink(path.join(root,'gone'),path.join(root,'broken'),process.platform==='win32'?'junction':'dir');
 const opendir=fs.opendir;t.mock.method(fs,'opendir',async(file,...rest)=>{if(file===blocked)throw Object.assign(Error('denied'),{code:'EACCES'});return opendir(file,...rest);});
 const pages=await drain(search,{path:root,query:'wanted',timeoutMs:10000});
 assert.equal(pages.flatMap(p=>p.matches).length,1);assert.equal(pages.at(-1).scanComplete,true);assert.equal(pages.at(-1).searchComplete,false);
 assert.ok(pages.flatMap(p=>p.errors).some(e=>e.code==='EACCES'));assert.ok(pages.flatMap(p=>p.errors).some(e=>e.code==='ENOENT'));
});
test('64 enormous active directories yield to queued nested work with bounded handles and cancellation cleanup',async t=>{
 const {root,search}=await fixture(t),virtual=path.join(root,'virtual');let open=0,peak=0,reads=0,entriesPerDir=1000000;
 const scratch=[];const mkdtemp=fs.mkdtemp;t.mock.method(fs,'mkdtemp',async(...args)=>{const dir=await mkdtemp(...args);if(String(args[0]).includes('blackice-file-search-'))scratch.push(dir);return dir;});
 const dirStat={isDirectory:()=>true,isFile:()=>false},fileStat={isDirectory:()=>false,isFile:()=>true,size:0,mtime:new Date(0)};
 const entry=(name,directory=false)=>({name,isDirectory:()=>directory,isFile:()=>!directory,isSymbolicLink:()=>false});
 const original={stat:fs.stat,realpath:fs.realpath,opendir:fs.opendir,lstat:fs.lstat};
 t.mock.method(fs,'stat',async(p,...a)=>String(p).startsWith(virtual)?(String(p).endsWith('wanted')?fileStat:dirStat):original.stat(p,...a));
 t.mock.method(fs,'lstat',async(p,...a)=>String(p).startsWith(virtual)?fileStat:original.lstat(p,...a));
 t.mock.method(fs,'realpath',async(p,...a)=>String(p).startsWith(virtual)?p:original.realpath(p,...a));
 t.mock.method(fs,'opendir',async(p,...a)=>{
  if(!String(p).startsWith(virtual))return original.opendir(p,...a);
  let index=0,closed=false;open++;peak=Math.max(peak,open);
  return {async read(){reads++;if(p===virtual)return index<65?entry('dir-'+index++,true):null;
   if(p===path.join(virtual,'dir-64'))return index++===0?entry('wanted'):null;
   return index<entriesPerDir?entry('noise-'+index++):null;
  },async close(){if(!closed){closed=true;open--;}}};
 });
 const first=await search({path:virtual,query:'wanted',limit:1,timeoutMs:10000});
 assert.equal(first.matches.length,1);assert.ok(first.matches[0].path.endsWith(path.join('dir-64','wanted')));
 assert.ok(reads<20000,'queued target found without exhausting million-entry directories');
 assert.ok(peak<=64);assert.ok(first.cursor);
 let checks=0;await assert.rejects(search({cursor:first.cursor,timeoutMs:10000},{get aborted(){return ++checks>10;}}),{name:'AbortError'});
 assert.equal(open,0,'cancellation closes every stream');
 await assert.rejects(search({cursor:first.cursor}),{code:'FILE_SEARCH_CURSOR_EXPIRED'});
 for(const dir of scratch)await assert.rejects(fs.access(dir),{code:'ENOENT'});
 entriesPerDir=135;
 const pages=await drain(search,{path:virtual,query:'noise',limit:100,timeoutMs:10000});
 const paths=pages.flatMap(p=>p.matches.map(m=>m.path));
 assert.equal(paths.length,64*135);assert.equal(new Set(paths).size,paths.length,'evicted/reopened streams have no duplicate or missing entries on an unchanged filesystem');
 assert.equal(pages.at(-1).searchComplete,true);assert.equal(open,0);
 for(const dir of scratch)await assert.rejects(fs.access(dir),{code:'ENOENT'});
});
test('supports more than eight priority roots and preserves all requested coverage',async t=>{
 const {root,search}=await fixture(t),roots=[];
 for(let i=0;i<12;i++){const dir=path.join(root,String(i));roots.push(dir);await fs.mkdir(dir);await fs.writeFile(path.join(dir,'wanted'),'');}
 const pages=await drain(search,{roots,query:'wanted',limit:3,timeoutMs:10000});
 assert.equal(pages.flatMap(p=>p.matches).length,12);assert.equal(pages.at(-1).rootsAttempted,12);assert.equal(pages.at(-1).searchComplete,true);
});


test('overlapping explicit file and directory roots return a canonical matching file once',async t=>{
 const {root,search}=await fixture(t),file=path.join(root,'wanted.txt');await fs.writeFile(file,'x');
 const pages=await drain(search,{roots:[file,root],query:'wanted',limit:1,timeoutMs:10000});
 assert.deepEqual(pages.flatMap(p=>p.matches.map(m=>m.path)),[file]);assert.equal(pages.at(-1).searchComplete,true);
});
test('expiry invalidates cursor and removes private scratch metadata without waiting ten minutes',async t=>{
 const {root,search}=await fixture(t);await fs.writeFile(path.join(root,'wanted1'),'');await fs.writeFile(path.join(root,'wanted2'),'');
 const scratch=[];const mkdtemp=fs.mkdtemp;t.mock.method(fs,'mkdtemp',async(...a)=>{const dir=await mkdtemp(...a);if(String(a[0]).includes('blackice-file-search-'))scratch.push(dir);return dir;});
 const set=globalThis.setTimeout;let expire;
 t.mock.method(globalThis,'setTimeout',(callback,ms,...a)=>{if(ms===600000){expire=callback;return {unref(){}};}return set(callback,ms,...a);});
 const first=await search({path:root,query:'wanted',limit:1});assert.ok(first.cursor);assert.equal(scratch.length,1);
 if(process.platform!=='win32')assert.equal((await fs.stat(scratch[0])).mode&0o777,0o700);
 expire();
 for(let i=0;i<100;i++){try{await fs.access(scratch[0]);}catch(e){if(e.code==='ENOENT')break;throw e;}await new Promise(resolve=>setImmediate(resolve));}
 await assert.rejects(fs.access(scratch[0]),{code:'ENOENT'});
 await assert.rejects(search({cursor:first.cursor}),{code:'FILE_SEARCH_CURSOR_EXPIRED'});
});
test('cleanup denial never masks an in-flight cancellation',async t=>{
 const {root,search}=await fixture(t);for(let i=0;i<10;i++)await fs.writeFile(path.join(root,'wanted'+i),'');
 const scratch=[];const mkdtemp=fs.mkdtemp;t.mock.method(fs,'mkdtemp',async(...a)=>{const dir=await mkdtemp(...a);if(String(a[0]).includes('blackice-file-search-'))scratch.push(dir);return dir;});
 const first=await search({path:root,query:'wanted',limit:1});
 const rm=fs.rm;const mock=t.mock.method(fs,'rm',async(p,...a)=>{if(scratch.includes(p))throw Object.assign(Error('synthetic cleanup denial'),{code:'EACCES'});return rm(p,...a);});
 let checks=0;await assert.rejects(search({cursor:first.cursor},{get aborted(){return ++checks>10;}}),{name:'AbortError'});
 mock.mock.restore();for(const dir of scratch)await rm(dir,{recursive:true,force:true});
});

