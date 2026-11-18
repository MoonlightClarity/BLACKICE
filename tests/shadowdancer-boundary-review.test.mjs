import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,readdir,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

import {planShadowdancerRebuild} from '../lib/shadowdancer-rebuild.mjs';
import {TaskStateStore} from '../lib/task-state.mjs';

async function fixture(t){
  const root=await mkdtemp(path.join(tmpdir(),'blackice-directory-boundary-'));
  const cwd=path.join(root,'workspace');
  await mkdir(cwd);
  const stores=[];
  t.after(async()=>{for(const store of stores)await store.close();await rm(root,{recursive:true,force:true});});
  return {root,cwd,async store(){const store=await new TaskStateStore({dataDir:path.join(root,'data')}).init();stores.push(store);return store;}};
}

test('Directory rebuild refuses linked source families before reading another family evidence',async t=>{
  const f=await fixture(t),outside=path.join(f.root,'outside-family');
  await mkdir(path.join(outside,'runs','source-run','integration'),{recursive:true});
  await writeFile(path.join(outside,'runs','source-run','integration','final.json'),'{"answer":"private"}');
  await mkdir(path.join(f.cwd,'.blackice','directory'),{recursive:true});
  try{await symlink(outside,path.join(f.cwd,'.blackice','directory','family-one'),process.platform==='win32'?'junction':'dir');}
  catch(error){if(['EPERM','EACCES','ENOSYS'].includes(error.code)){t.skip('This host cannot create the disposable link fixture.');return;}throw error;}
  await assert.rejects(planShadowdancerRebuild({cwd:f.cwd,conversationId:'family-one',sourceRunId:'source-run'}),
    error=>/symbolic|junction|saved location|unsafe.*path|path.*unsafe/i.test(error.message));
});
