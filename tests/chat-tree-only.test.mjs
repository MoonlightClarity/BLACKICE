import test from 'node:test';
import assert from 'node:assert/strict';
import {planningDOM} from './fixture-planning-dom.mjs';
import {createConversationFolderUI} from '../public/next/chat/folders.mjs';
function fixture(t,api){const dom=planningDOM(t),view=new Proxy({}, {get(o,k){return o[k]??=dom.element(k.includes('Dialog')?'dialog':'div');}});view.folderDeleteDialog.showModal=()=>{view.folderDeleteDialog.open=true;};view.folderDeleteDialog.close=()=>{view.folderDeleteDialog.open=false;};const ui=createConversationFolderUI({view,api,getItems:()=>[],getBucket:()=>'active',getSelectedRoot:()=>null});t.after(()=>ui.destroy());return{ui,view};}
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


test('folder lifecycle confirmation captures both revisions, cancel writes nothing and rejection never replays',async t=>{
 const calls=[];const{ui,view}=fixture(t,async(...a)=>{calls.push(a);throw Object.assign(Error('Changed externally'),{status:409});});
 ui.accept({healthy:true,revision:3,lifecycleRevision:7,folders:[{id:'a',name:'A',state:'active'}]});ui.folderAction('a','archive');
 assert.match(view.folderDeleteLabel.textContent,/every nested folder and chat/);await view.folderDeleteCancel.dispatch('click');assert.equal(calls.length,0);
 ui.folderAction('a','delete');ui.accept({healthy:true,revision:4,lifecycleRevision:8,folders:[{id:'a',name:'A',state:'active'}]});await view.folderDeleteConfirm.dispatch('click');
 assert.equal(calls.length,1);assert.equal(calls[0][0],'/api/conversation-folders/a/delete');assert.deepEqual(calls[0][2],{expectedRevision:3,expectedMetadataRevision:7});
 assert.equal(view.folderDeleteError.hidden,false);assert.match(view.folderDeleteError.textContent,/Changed externally/);
});
test('folder lifecycle does not discard an open creation draft',async t=>{
 const{ui,view}=fixture(t,async()=>{throw Error('No write expected');});
 ui.accept({healthy:true,revision:1,lifecycleRevision:0,folders:[{id:'a',name:'A'}]});ui.createFolder('a');view.folderName.value='Keep me';ui.folderAction('a','delete');
 assert.equal(view.folderName.value,'Keep me');assert.equal(ui.draft.parentId,'a');assert.match(view.folderStatus.textContent,/Save or cancel/);
});
test('folder tree exposes only current lifecycle state and safely roots an orphaned branch',t=>{
 const dom=planningDOM(t),view=new Proxy({}, {get(o,k){return o[k]??=dom.element(k.includes('Dialog')?'dialog':'div');}});
 let bucket='archived';const ui=createConversationFolderUI({view,api:async()=>{},getItems:()=>[],getBucket:()=>bucket,getSelectedRoot:()=>null});t.after(()=>ui.destroy());
 ui.accept({healthy:true,revision:1,lifecycleRevision:2,folders:[{id:'parent',name:'Parent',state:'active'},{id:'child',parentId:'parent',name:'Child',state:'archived'},{id:'trash',name:'Trash',state:'deleted'}]});
 assert.deepEqual(ui.folders.map(f=>[f.id,f.parentId]),[['child',null]]);assert.deepEqual([...ui.folderNames()],[['child','Child']]);
 bucket='deleted';assert.deepEqual(ui.folders.map(f=>f.id),['trash']);
});

test('draft keeps original parent label and text through external removal and workspace stop',async t=>{
 const{ui,view}=fixture(t,async()=>{throw Error('No request');});ui.accept({healthy:true,revision:1,folders:[{id:'a',name:'Original'}]});
 ui.createFolder('a');view.folderName.value='Unsent';ui.accept({healthy:true,revision:2,folders:[]});ui.stop();
 assert.equal(ui.draft.parentId,'a');assert.equal(view.folderName.value,'Unsent');assert.match(view.folderDraftContext.textContent,/Original.*original destination unavailable/);
 await view.folderCancel.dispatch('click');assert.equal(ui.draft,null);
});
