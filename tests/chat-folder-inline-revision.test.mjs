import test from 'node:test';
import assert from 'node:assert/strict';
import {planningDOM} from './fixture-planning-dom.mjs';
import {createConversationFolderUI} from '../public/next/chat/folders.mjs';
test('inline rename binds its original revision and never replays a rejected edit',async t=>{
 const dom=planningDOM(t),view=new Proxy({}, {get(o,k){return o[k]??=dom.element(k.includes('Dialog')?'dialog':k.includes('Filter')?'select':'div');}});
 const calls=[];const snapshot=(revision,name)=>({healthy:true,revision,generation:revision,autoEnabled:false,folders:[{id:'f',name}]});
 const ui=createConversationFolderUI({view,getItems:()=>[],getBucket:()=>'active',getSelectedRoot:()=>null,api:async(...args)=>{calls.push(args);throw Object.assign(Error('Changed externally'),{status:409});}});
 t.after(()=>ui.destroy());ui.accept(snapshot(1,'Original'));const stale=ui.beginRename('f');ui.accept(snapshot(2,'External'));
 assert.equal(await stale('Draft'),false);assert.equal(calls.length,0);assert.match(view.folderStatus.textContent,/changed while editing/);
 const current=ui.beginRename('f');assert.equal(await current('Draft'),false);assert.equal(calls.length,1);assert.equal(calls[0][2].expectedRevision,2);assert.equal(calls[0][2].operations[0].name,'Draft');
 assert.equal(ui.organization.folders[0].name,'External');
});
