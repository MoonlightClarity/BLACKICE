import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {makeLongEvidence} from '../scripts/benchmark-fixture-long-evidence.mjs';
import {makeEventReplayTask,applyEventReplayGold} from '../scripts/benchmark-fixture-event-replay.mjs';

test('long evidence fixture is reproducible, multi-shard, and has a passing independent coding solution',{timeout:40000},async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'blackice-long-evidence-fixture-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const write=async(name,contents)=>{
  const filename=path.join(root,name);
  await mkdir(path.dirname(filename),{recursive:true});
  await writeFile(filename,contents,'utf8');
 };
 const hidden=await makeEventReplayTask(write,root);
 const manifest=await makeLongEvidence(write,root);
 assert.equal(manifest.files.length,8);
 assert(manifest.bytes>256*1024,'Long evidence must exceed the 96-KiB adaptive budget by a large margin.');
 const clues=new Set();
 for(const file of manifest.files){
  const content=await readFile(path.join(root,file),'utf8');
  const lines=content.trim().split('\n');
  assert(lines.length>250);
  assert(Buffer.byteLength(content)>32*1024,'Each shard should need multiple observations, or programmatic processing.');
  assert.match(content,/DISCARDED HYPOTHESIS/);
  const diagnosis=lines.at(-1);
  assert.match(diagnosis,/CONCLUSIVE/);
  clues.add(diagnosis);
 }
 assert.equal(clues.size,8);
 const readme=await readFile(path.join(root,'README.md'),'utf8');
 for(const file of manifest.files)assert(readme.includes(file));
 await applyEventReplayGold(write);
 await write('test/hidden-acceptance.test.mjs',hidden);
 const childEnv={...process.env};delete childEnv.NODE_TEST_CONTEXT;
 const accepted=spawnSync(process.execPath,['--test','--test-reporter=tap','test/public.test.mjs','test/hidden-acceptance.test.mjs'],{cwd:root,encoding:'utf8',timeout:30000,env:childEnv});
 assert.equal(accepted.status,0,(accepted.stdout||'').slice(-3200)+'\n'+(accepted.stderr||'').slice(-700));
 assert.match(accepted.stdout,/# pass 21/);
 t.diagnostic('Long evidence corpus: '+manifest.bytes+' UTF-8 bytes across 8 independent diagnostic shards; gold solution 21/21.');
});
