import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {invalidProjectIdentity} from '../scripts/check-git-author-attribution.mjs';

const checker=fileURLToPath(new URL('../scripts/check-git-author-attribution.mjs',import.meta.url));
const ownerEmail='325637566+MoonlightClarity@users.noreply.github.com';
const wrongEmail='blackice@users.noreply.github.com';

test('rejects exact false attribution for both author and committer roles',()=>{
  assert.equal(invalidProjectIdentity('BLACKICE',wrongEmail),true);
  assert.equal(invalidProjectIdentity('Unrelated Name',wrongEmail),true);
  assert.equal(invalidProjectIdentity('BLACKICE','1234+OtherAccount@users.noreply.github.com'),true);
});

test('allows the owner and legitimate independent contributors',()=>{
  assert.equal(invalidProjectIdentity('MoonlightClarity',ownerEmail),false);
  assert.equal(invalidProjectIdentity('BLACKICE',ownerEmail),false);
  assert.equal(invalidProjectIdentity('Someone Else','someone@users.noreply.github.com'),false);
  assert.equal(invalidProjectIdentity('Codex','codex@localhost'),false);
});

test('checks new commits while excluding the known historical bad ancestor',()=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),'git-attr-fixture-'));
  const git=(...args)=>execFileSync('git',args,{cwd:dir,encoding:'utf8'}).trim();
  const commit=(name,email)=>{
    git('config','user.name',name);
    git('config','user.email',email);
    git('commit','--allow-empty','-m','fixture');
    return git('rev-parse','HEAD');
  };
  try{
    git('init','-q');
    const first=commit('BLACKICE',wrongEmail);
    const second=commit('MoonlightClarity',ownerEmail);
    const allowed=spawnSync(process.execPath,[checker,first,second],{cwd:dir,encoding:'utf8'});
    assert.equal(allowed.status,0);
    assert.match(allowed.stdout,/1 new commits/);
    const third=commit('BLACKICE',wrongEmail);
    const blocked=spawnSync(process.execPath,[checker,second,third],{cwd:dir,encoding:'utf8'});
    assert.equal(blocked.status,1);
    assert.match(blocked.stderr,/Invalid author/);
    assert.match(blocked.stderr,/Invalid committer/);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
