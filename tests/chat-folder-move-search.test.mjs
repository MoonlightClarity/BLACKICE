import test from 'node:test';
import assert from 'node:assert/strict';
import {planningDOM} from './fixture-planning-dom.mjs';
import {createChatFrame} from '../public/next/chat/render.mjs';
import {createConversationFolderUI} from '../public/next/chat/folders.mjs';

function fixture(t){
 const dom=planningDOM(t),view=createChatFrame(dom.mount);
 view.folderMoveDialog.showModal=()=>{view.folderMoveDialog.open=true;};
 view.folderMoveDialog.close=()=>{view.folderMoveDialog.open=false;};
 const items=[{rootId:'root-test',id:'root-test',title:'Example conversation',folderId:'top',folderSource:'manual'}];
 let organization={healthy:true,revision:4,folders:[
  {id:'z',name:'Zebra',parentId:null,state:'active'},
  {id:'deep',name:'Delta',parentId:'z',state:'active'},
  {id:'top',name:'Alpha',parentId:null,state:'active'},
  {id:'child',name:'Bravo',parentId:'top',state:'active'},
 ]};
 const calls=[];let reject=false;
 const api=async(route,method,body)=>{
  if(method==='POST'){
   calls.push({route,method,body:structuredClone(body)});
   if(reject||body.expectedRevision!==organization.revision)throw Object.assign(Error('Folder revision changed'),{status:409});
   items[0].folderId=body.operations[0].folderId;
   organization={...organization,revision:organization.revision+1};
   return {folderOrganization:organization};
  }
  return {folderOrganization:organization};
 };
 const ui=createConversationFolderUI({view,api,getItems:()=>items,getBucket:()=> 'active'});
 t.after(()=>ui.destroy());ui.onListLoaded(items,organization);
 return {...dom,view,ui,items,calls,state:()=>organization,change(next){organization=next;ui.accept(next);},reject(){reject=true;}};
}
test('Chat Move keeps current selection, searches alphabetized complete paths, and writes only on submit',async t=>{
 const f=fixture(t),{view}=f;
 f.ui.onRowAction(f.items[0],'move_folder');
 assert.equal(view.folderMoveDialog.open,true);
 assert.equal(f.document.activeElement,view.folderMoveSearch);
 assert.deepEqual([...view.folderMoveTarget.querySelectorAll('option')].map(n=>n.textContent),[
  'Unfiled','Alpha','Alpha / Bravo','Zebra','Zebra / Delta',
 ]);
 assert.equal(view.folderMoveTarget.value,'top');
 view.folderMoveSearch.value='delta';await view.folderMoveSearch.dispatch('input');
 assert.deepEqual([...view.folderMoveTarget.querySelectorAll('option')].map(n=>n.textContent),[
  'Alpha (selected)','Zebra / Delta',
 ]);
 assert.equal(view.folderMoveTarget.value,'top','search does not silently change selected folder');
 assert.equal(f.calls.length,0);
 view.folderMoveTarget.value='deep';await view.folderMoveTarget.dispatch('change');
 await view.folderMoveForm.dispatch('submit');
 assert.equal(view.folderMoveDialog.open,false);
 assert.equal(f.calls.length,1);
 assert.deepEqual(f.calls[0].body,{expectedRevision:4,operations:[{type:'assign',rootId:'root-test',folderId:'deep'}]});
 assert.equal(f.items[0].folderId,'deep');
});
test('Chat Move cancellation, deletion of a destination and stale revisions cannot silently relocate',async t=>{
 const f=fixture(t),{view}=f;
 f.ui.onRowAction(f.items[0],'move_folder');
 view.folderMoveSearch.value='zeb';await view.folderMoveSearch.dispatch('input');
 await view.folderMoveCancel.dispatch('click');
 assert.equal(view.folderMoveDialog.open,false);assert.equal(f.calls.length,0);
 f.ui.onRowAction(f.items[0],'move_folder');
 f.change({...f.state(),revision:5,folders:f.state().folders.filter(row=>row.id!=='top')});
 assert.equal(view.folderMoveTarget.value,'top');
 assert.equal(view.folderMoveSave.disabled,true);
 assert.match(view.folderMoveTarget.textContent,/Unavailable/);
 await view.folderMoveForm.dispatch('submit');
 assert.equal(f.calls.length,0);
 view.folderMoveSearch.value='';await view.folderMoveSearch.dispatch('input');
 view.folderMoveTarget.value='z';await view.folderMoveTarget.dispatch('change');
 assert.equal(view.folderMoveSave.disabled,false);
 f.reject();
 await view.folderMoveForm.dispatch('submit');
 await new Promise(r=>setImmediate(r));
 assert.equal(f.calls.length,1);
 assert.equal(f.calls[0].body.expectedRevision,4,'dialog pins opening revision despite newer folder state');
 assert.equal(f.items[0].folderId,'top','conflict never replays the move');
});
