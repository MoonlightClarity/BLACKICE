import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,symlinkSync} from 'node:fs';
import {resolveDirectoryRoot,registerDirectoryRoot} from '../lib/directory-location.mjs';
import {ShadowdancerDirectory} from '../lib/shadowdancer-directory.mjs';
import {listShadowdancerContext} from '../lib/shadowdancer-context.mjs';
function workspace(t){const cwd=mkdtempSync(path.join(os.tmpdir(),'directory-location-'));t.after(()=>rmSync(cwd,{recursive:true,force:true}));return cwd;}
test('new conversation persists current layout before writing',async t=>{
 const cwd=workspace(t),dir=new ShadowdancerDirectory({cwd,conversationId:'chat',runId:'first',runtime:{runAgent(){}}});
 assert.equal(dir.root,path.join(cwd,'.blackice','directory','chat'));await dir.open();
 assert.equal(JSON.parse(readFileSync(path.join(cwd,'.blackice','directory-locations','chat.json'))).root,dir.root);
 assert.equal(resolveDirectoryRoot(cwd,'chat'),dir.root);
});
test('legacy history remains in place and subsequent writer adopts it',async t=>{
 const cwd=workspace(t),root=path.join(cwd,'.shadowdancer','old');mkdirSync(root,{recursive:true});writeFileSync(path.join(root,'keep'),'legacy');
 const dir=new ShadowdancerDirectory({cwd,conversationId:'old',runId:'next',runtime:{runAgent(){}}});
 await dir.open();assert.equal(dir.root,root);assert.equal(readFileSync(path.join(root,'keep'),'utf8'),'legacy');
 assert.equal(resolveDirectoryRoot(cwd,'old'),root);
});
test('explicit location is persisted across writer, reader and continuation',async t=>{
 const cwd=workspace(t),root=path.join(cwd,'chosen-history');
 const first=new ShadowdancerDirectory({cwd,directoryRoot:root,conversationId:'chat',runId:'one',runtime:{runAgent(){}}});
 await first.open();const next=new ShadowdancerDirectory({cwd,conversationId:'chat',runId:'two',runtime:{runAgent(){}}});
 assert.equal(next.root,root);await next.open();await next.label('test');await listShadowdancerContext({cwd,conversationId:'chat'});
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
