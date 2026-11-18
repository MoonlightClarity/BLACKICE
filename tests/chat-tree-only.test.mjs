import test from 'node:test';
import assert from 'node:assert/strict';
import {planningDOM} from './fixture-planning-dom.mjs';
import {createConversationFolderUI} from '../public/next/chat/folders.mjs';
function fixture(t,api){const dom=planningDOM(t),view=new Proxy({}, {get(o,k){return o[k]??=dom.element(k.includes('Dialog')?'dialog':'div');}});const ui=createConversationFolderUI({view,api,getItems:()=>[],getBucket:()=>'active',getSelectedRoot:()=>null});t.after(()=>ui.destroy());return{ui,view};}
test('explicit child draft pins parent and revision; stale response preserves draft without retry',async t=>{
 const calls=[];const{ui,view}=fixture(t,async(...a)=>{calls.push(a);throw Object.assign(Error('Folder changed'),{status:409});});
 ui.accept({healthy:true,revision:1,folders:[{id:'a',name:'A'},{id:'b',name:'B'}]});ui.createFolder('a');view.folderName.value='Child';
 ui.accept({healthy:true,revision:2,folders:[{id:'a',name:'A'},{id:'b',name:'B'}]});ui.createFolder('b');
 await view.folderForm.dispatch('submit');assert.equal(calls.length,1);assert.equal(calls[0][2].expectedRevision,1);assert.deepEqual(calls[0][2].operations,[{type:'create_folder',name:'Child',parentId:'a'}]);assert.equal(ui.draft.parentId,'a');assert.equal(view.folderName.value,'Child');assert.equal(view.folderForm.hidden,false);
 await view.folderCancel.dispatch('click');assert.equal(ui.draft,null);assert.equal(view.folderForm.hidden,true);
});
test('rename does not change root creation destination, and new folder success clears draft',async t=>{
 const calls=[];const{ui,view}=fixture(t,async(...a)=>{calls.push(a);return{folderOrganization:{healthy:true,revision:2,folders:[{id:'a',name:'A'},{id:'new',name:'Root',parentId:null}]}};});
 ui.accept({healthy:true,revision:1,folders:[{id:'a',name:'A'}]});ui.beginRename('a');await view.folderNew.dispatch('click');view.folderName.value='Root';await view.folderForm.dispatch('submit');
 assert.equal(calls.length,1);assert.equal(calls[0][2].operations[0].parentId,null);assert.equal(ui.draft,null);assert.equal(view.folderForm.hidden,true);
});

