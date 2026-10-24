import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {promises as fs} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {FilePatchStore,patchText} from '../lib/file-patches.mjs';
import {createWorkspaceToolHandler} from '../lib/workspace-tools.mjs';

async function fixture(t,io=fs){const root=await mkdtemp(path.join(tmpdir(),'relay-patches-')),cwd=path.join(root,'project'),dataDir=path.join(root,'data');await mkdir(cwd);const store=new FilePatchStore({dataDir,io});t.after(async()=>{await store.close();assert.match(path.basename(root),/^relay-patches-/);await rm(root,{recursive:true,force:true});});return{root,cwd,dataDir,store};}
const parsed=value=>JSON.parse(value.contentItems[0].text);

test('a literal patch changes one span, keeps Unicode/BOM and surrounding Windows line endings',()=>{
  assert.equal(patchText('\uFEFFhead\r\nold\r\nline\r\ntail\r\n','old\nline','new\n✓'),'\uFEFFhead\r\nnew\r\n✓\r\ntail\r\n');
  assert.equal(patchText('alpha β omega','β','✓'),'alpha ✓ omega');
  assert.equal(patchText('keep remove end','remove ',''),'keep end');
  assert.throws(()=>patchText('same same','same','new'),/more than once/);
  assert.throws(()=>patchText('original','missing','new'),/no longer matches/);
  assert.throws(()=>patchText('original','','new'),/non-empty/);
  assert.throws(()=>patchText('original','original','original'),/would not change/);
});

test('real file patches are immediate and retain exact before/after and source receipts across restart',async t=>{
  const{cwd,dataDir,store}=await fixture(t),file=path.join(cwd,'example.txt');await writeFile(file,'A\r\nold\r\nZ\r\n');
  const applied=await store.patch({cwd,path:'example.txt',oldText:'old',newText:'new',runId:'run-a',nodeId:'agent-a'});
  assert.equal(applied.status,'applied');assert.equal(await readFile(file,'utf8'),'A\r\nnew\r\nZ\r\n');assert.equal('before' in applied,false);
  const reopened=new FilePatchStore({dataDir}),receipt=await reopened.get(applied.id);assert.equal(receipt.before,'A\r\nold\r\nZ\r\n');assert.equal(receipt.after,'A\r\nnew\r\nZ\r\n');assert.equal(receipt.runId,'run-a');assert.equal(receipt.nodeId,'agent-a');
  const history=await reopened.list({cwd,runId:'run-a'});assert.equal(history.patches.length,1);assert.equal('after' in history.patches[0],false);assert.equal((await reopened.list({cwd,runId:'different'})).total,0);
  const undone=await reopened.undo(applied.id);assert.equal(await readFile(file,'utf8'),receipt.before);assert.equal(undone.undoOf,applied.id);assert.equal(undone.source,'user');await reopened.close();
});

test('undo preserves newer user edits and succeeds only after the newest owned patch is reversed',async t=>{
  const{cwd,store}=await fixture(t),file=path.join(cwd,'file.txt');await writeFile(file,'alpha beta');
  const first=await store.patch({cwd,path:file,oldText:'alpha',newText:'A'}),second=await store.patch({cwd,path:file,oldText:'beta',newText:'B'});
  await assert.rejects(store.undo(first.id),/newer changes/);await store.undo(second.id);await store.undo(first.id);assert.equal(await readFile(file,'utf8'),'alpha beta');
  const third=await store.patch({cwd,path:file,oldText:'alpha',newText:'A'});await writeFile(file,'Manual editor work');await assert.rejects(store.undo(third.id),/newer changes/);assert.equal(await readFile(file,'utf8'),'Manual editor work');
});

test('concurrent writers serialize the same canonical file without losing disjoint changes',async t=>{
  const{cwd,store}=await fixture(t),file=path.join(cwd,'file.txt');await writeFile(file,'alpha beta');
  const results=await Promise.all([store.patch({cwd,path:file,oldText:'alpha',newText:'A'}),store.patch({cwd,path:'file.txt',oldText:'beta',newText:'B'})]);
  assert.equal(await readFile(file,'utf8'),'A B');assert.equal(results.length,2);assert.equal((await store.list({cwd})).total,2);
});

test('stale hashes, ambiguous patches, binary files and cancellation never change files',async t=>{
  const{cwd,store}=await fixture(t),file=path.join(cwd,'file.txt');await writeFile(file,'same same');
  await assert.rejects(store.patch({cwd,path:file,oldText:'same',newText:'new'}),/more than once/);
  await assert.rejects(store.patch({cwd,path:file,oldText:'same same',newText:'new',expectedHash:'0'.repeat(64)}),/hash changed/);
  const controller=new AbortController();controller.abort();await assert.rejects(store.patch({cwd,path:file,oldText:'same same',newText:'new',signal:controller.signal}),{name:'AbortError'});assert.equal(await readFile(file,'utf8'),'same same');
  await writeFile(file,Buffer.from([1,0,2]));await assert.rejects(store.patch({cwd,path:file,oldText:'x',newText:'y'}),/binary/);assert.deepEqual(await readFile(file),Buffer.from([1,0,2]));
});

test('a failed destination rename keeps original bytes and a truthful not-applied receipt',async t=>{
  let destination;const io={...fs,rename:async(from,to)=>{if(to===destination)throw Object.assign(Error('Injected rename failure'),{code:'EACCES'});return fs.rename(from,to);}};
  const{cwd,store}=await fixture(t,io);destination=path.join(cwd,'file.txt');await writeFile(destination,'original');await assert.rejects(store.patch({cwd,path:destination,oldText:'original',newText:'changed'}),/Injected/);assert.equal(await readFile(destination,'utf8'),'original');const history=await store.list({cwd});assert.equal(history.patches[0].status,'not_applied');assert.deepEqual(await readdir(cwd),['file.txt']);
});

test('a lost destination rename acknowledgement recovers applied bytes and a durable undo receipt',async t=>{
  let destination,promotions=0;const io={...fs,rename:async(from,to)=>{await fs.rename(from,to);if(to===destination){promotions++;throw Error('Rename acknowledgement lost');}}};
  const{cwd,store}=await fixture(t,io);destination=path.join(cwd,'file.txt');await writeFile(destination,'before');
  const receipt=await store.patch({cwd,path:destination,oldText:'before',newText:'after'});
  assert.equal(receipt.status,'applied');assert.equal(receipt.auditReceiptPending,undefined);assert.equal(await readFile(destination,'utf8'),'after');assert.equal((await store.get(receipt.id)).status,'applied');assert.equal(promotions,1);
  const undone=await store.undo(receipt.id);assert.equal(undone.status,'applied');assert.equal(undone.undoOf,receipt.id);assert.equal(await readFile(destination,'utf8'),'before');assert.equal(promotions,2);assert.deepEqual(await readdir(cwd),['file.txt']);
});

test('an uncertain destination after rename retains a prepared receipt instead of falsely reporting no change',async t=>{
  let destination;const io={...fs,rename:async(from,to)=>{await fs.rename(from,to);if(to===destination){await writeFile(to,'Later editor change');throw Error('Rename acknowledgement lost');}}};
  const{cwd,store}=await fixture(t,io);destination=path.join(cwd,'file.txt');await writeFile(destination,'before');
  await assert.rejects(store.patch({cwd,path:destination,oldText:'before',newText:'after'}),/acknowledgement lost/);
  assert.equal(await readFile(destination,'utf8'),'Later editor change');const history=await store.list({cwd});assert.equal(history.total,1);assert.equal(history.patches[0].status,'prepared');const saved=await store.get(history.patches[0].id);assert.equal(saved.before,'before');assert.equal(saved.after,'after');await assert.rejects(store.undo(saved.id),/newer changes/);assert.deepEqual(await readdir(cwd),['file.txt']);
});

test('a concurrently edited file is preserved between journal preparation and file promotion',async t=>{
  let destination,changed=false;const io={...fs,writeFile:async(file,...args)=>{const result=await fs.writeFile(file,...args);if(!changed&&String(file).includes('.relay-patch-')){changed=true;await fs.writeFile(destination,'Editor changed it');}return result;}};
  const{cwd,store}=await fixture(t,io);destination=path.join(cwd,'file.txt');await writeFile(destination,'original');await assert.rejects(store.patch({cwd,path:destination,oldText:'original',newText:'changed'}),/file changed/);assert.equal(await readFile(destination,'utf8'),'Editor changed it');
});

test('the real workspace tool exposes hashes, exact patch receipts, history and undo with no approval callback',async t=>{
  const{cwd,store}=await fixture(t);await writeFile(path.join(cwd,'file.txt'),'before');const events=[],handler=createWorkspaceToolHandler({cwd,patchStore:store,runId:'task-one',nodeId:'agent',onEvent:e=>events.push(e)}),call=arguments_=>handler({name:'relay_workspace',arguments:arguments_});
  const read=parsed(await call({action:'read',path:'file.txt'}));assert.match(read.sha256,/^[a-f0-9]{64}$/);
  const patch=await call({action:'patch',path:'file.txt',oldText:'before',newText:'after',expectedHash:read.sha256});assert.equal(patch.success,true);const receipt=parsed(patch);assert.equal(receipt.runId,'task-one');
  assert.equal(parsed(await call({action:'patch_history',patchId:receipt.id})).before,'before');assert.equal(parsed(await call({action:'patch_history'})).total,1);
  assert.equal((await call({action:'undo_patch',patchId:receipt.id})).success,true);assert.equal(await readFile(path.join(cwd,'file.txt'),'utf8'),'before');assert.ok(events.some(e=>e.type==='workspace.patch'&&e.patchId===receipt.id));
});

test('journal admission failure prevents edits while a failed final receipt retains recoverable before/after',async t=>{
  let failAdmission=true,renameCount=0;
  const io={...fs,open:async(file,...args)=>{if(failAdmission&&String(file).includes('file-patches'))throw Object.assign(Error('Disk full'),{code:'ENOSPC'});return fs.open(file,...args);},rename:async(from,to)=>{if(String(to).endsWith('.json')&&++renameCount===2)throw Error('Final receipt write failed');return fs.rename(from,to);}};
  const{cwd,store}=await fixture(t,io),file=path.join(cwd,'file.txt');await writeFile(file,'before');
  await assert.rejects(store.patch({cwd,path:file,oldText:'before',newText:'after'}),/Disk full/);assert.equal(await readFile(file,'utf8'),'before');
  failAdmission=false;const receipt=await store.patch({cwd,path:file,oldText:'before',newText:'after'});assert.equal(receipt.auditReceiptPending,true);assert.equal(await readFile(file,'utf8'),'after');const saved=await store.get(receipt.id);assert.equal(saved.status,'prepared');assert.equal(saved.before,'before');assert.equal(saved.after,'after');await store.undo(receipt.id);assert.equal(await readFile(file,'utf8'),'before');
});

test('corrupt or missing history is reported without changing the target file',async t=>{
  const{cwd,store}=await fixture(t),file=path.join(cwd,'file.txt');await writeFile(file,'before');const receipt=await store.patch({cwd,path:file,oldText:'before',newText:'after'}),record=await store.get(receipt.id);record.before='Tampered';await writeFile(store.file(receipt.id),JSON.stringify(record));await assert.rejects(store.undo(receipt.id),/damaged/);assert.equal(await readFile(file,'utf8'),'after');assert.equal((await store.list()).damaged,1);await assert.rejects(store.get('missing'),error=>error.status===404);
});
