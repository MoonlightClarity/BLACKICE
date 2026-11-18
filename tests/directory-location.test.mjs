import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,symlinkSync} from 'node:fs';
import {resolveDirectoryRoot,registerDirectoryRoot} from '../lib/directory-location.mjs';

import {listShadowdancerContext} from '../lib/shadowdancer-context.mjs';
function workspace(t){const cwd=mkdtempSync(path.join(os.tmpdir(),'directory-location-'));t.after(()=>rmSync(cwd,{recursive:true,force:true}));return cwd;}
test('storage location registration persists current layout',async t=>{
 const cwd=workspace(t),dir={root:resolveDirectoryRoot(cwd,'chat')};
 assert.equal(dir.root,path.join(cwd,'.blackice','directory','chat'));registerDirectoryRoot(cwd,'chat',dir.root);
 assert.equal(JSON.parse(readFileSync(path.join(cwd,'.blackice','directory-locations','chat.json'))).root,dir.root);
 assert.equal(resolveDirectoryRoot(cwd,'chat'),dir.root);
});
test('legacy storage location registration preserves existing history',async t=>{
 const cwd=workspace(t),root=path.join(cwd,'.shadowdancer','old');mkdirSync(root,{recursive:true});writeFileSync(path.join(root,'keep'),'legacy');
 const dir={root:resolveDirectoryRoot(cwd,'old')};
 registerDirectoryRoot(cwd,'old',dir.root);assert.equal(dir.root,root);assert.equal(readFileSync(path.join(root,'keep'),'utf8'),'legacy');
 assert.equal(resolveDirectoryRoot(cwd,'old'),root);
});
test('explicit storage location is persisted across independent resolver reads',async t=>{
 const cwd=workspace(t),root=path.join(cwd,'chosen-history');
 registerDirectoryRoot(cwd,'chat',root);mkdirSync(path.join(root,'conversation/context'),{recursive:true});writeFileSync(path.join(root,'conversation/context/summary.json'),JSON.stringify({conversationId:'chat'}));
 assert.equal(resolveDirectoryRoot(cwd,'chat'),root);await listShadowdancerContext({cwd,conversationId:'chat'});
 assert.throws(()=>registerDirectoryRoot(cwd,'chat',path.join(cwd,'other')),/different/);
});
test('location refuses workspace ancestors, metadata overlap and malformed saved records',t=>{
 const cwd=workspace(t);
 for(const root of [cwd,path.dirname(cwd),path.join(cwd,'.blackice')])assert.throws(()=>registerDirectoryRoot(cwd,'a',root));
 const file=path.join(cwd,'.blackice','directory-locations','b.json');mkdirSync(path.dirname(file),{recursive:true});writeFileSync(file,'broken');
 assert.throws(()=>resolveDirectoryRoot(cwd,'b'),/unreadable/);
});
test('legacy junction cannot be silently bypassed',t=>{
 const cwd=workspace(t),outside=workspace(t);mkdirSync(path.join(cwd,'.shadowdancer'));
 symlinkSync(outside,path.join(cwd,'.shadowdancer','chat'),'junction');
 assert.throws(()=>resolveDirectoryRoot(cwd,'chat'),/links/);
});
