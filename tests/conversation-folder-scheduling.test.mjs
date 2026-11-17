import test from 'node:test';
import assert from 'node:assert/strict';
import {planningDOM} from './fixture-planning-dom.mjs';
import {createConversationFolderUI} from '../public/next/chat/folders.mjs';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function setup(t){const dom=planningDOM(t),view=new Proxy({}, {get(o,k){return o[k]??=(dom.element(k.includes('Dialog')?'dialog':k.includes('Filter')?'select':'div'))}});
let selected='selected',generation=0,accept=true;const calls=[],items=[
{rootId:'selected',title:'Phoenix selected',status:'completed',settled:true},
{rootId:'busy',title:'Phoenix busy',status:'running',settled:false},
{rootId:'free',title:'Phoenix free',status:'completed',settled:true},
{rootId:'manual',folderSource:'manual',folderId:null,status:'completed',settled:true},
{rootId:'assigned',folderSource:'automatic',folderId:'fld_existing',status:'completed',settled:true}];
const snapshot=()=>({healthy:true,revision:generation,generation,autoEnabled:true,folders:[]});
const ui=createConversationFolderUI({view,getItems:()=>items,getBucket:()=> 'active',getSelectedRoot:()=>selected,
api:async(route,method,body)=>{calls.push(body.rootIds);return{folderOrganization:{...snapshot(),acceptedRootIds:accept?body.rootIds:[],updated:[]}};}});
t.after(()=>ui.destroy());return{ui,items,calls,snapshot,setSelected:v=>selected=v,bump:()=>generation++,reject:()=>accept=false,allow:()=>accept=true};}
test('selected and running chats remain eligible later; manual and assigned placements stay put',async t=>{
const f=setup(t);f.ui.onListLoaded(f.items,f.snapshot());await sleep(240);assert.deepEqual(f.calls,[['free']]);
f.items[1].status='completed';f.items[1].settled=true;f.setSelected('none');f.ui.onListLoaded(f.items,f.snapshot());await sleep(240);
assert.deepEqual(f.calls[1],['selected','busy']);f.ui.onListLoaded(f.items,f.snapshot());await sleep(240);assert.equal(f.calls.length,2);
});
test('catalog generation changes reconsider Ungrouped once, without manual/assigned churn',async t=>{
const f=setup(t);f.ui.onListLoaded(f.items,f.snapshot());await sleep(240);f.bump();f.ui.onListLoaded(f.items,f.snapshot());await sleep(240);assert.deepEqual(f.calls,[['free'],['free']]);f.ui.onListLoaded(f.items,f.snapshot());await sleep(240);assert.equal(f.calls.length,2);
});
test('server-excluded race is not marked considered and retries only after foreground reload',async t=>{
const f=setup(t);f.reject();f.ui.onListLoaded(f.items,f.snapshot());await sleep(500);assert.equal(f.calls.length,1);f.allow();f.ui.onListLoaded(f.items,f.snapshot());await sleep(240);assert.equal(f.calls.length,2);f.ui.onListLoaded(f.items,f.snapshot());await sleep(240);assert.equal(f.calls.length,2);
});
test('backend scan receipt identifies accepted roots and exposes catalog generation',async t=>{
 const {ConversationFolders}=await import('../lib/conversation-folders.mjs');
 const {mkdtemp,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const dir=await mkdtemp(join(tmpdir(),'folder-scheduler-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const store=await new ConversationFolders({dataDir:dir}).init();
 const result=await store.autoStep({rootIds:['free','busy','selected'],excludeRootId:'selected',resolve:id=>({rootId:id,title:'Phoenix topic',busy:id==='busy',state:'active'})});
 assert.deepEqual(result.acceptedRootIds,['free']);assert.equal(result.generation,0);
 const changed=await store.edit({expectedRevision:store.snapshot().revision,operations:[{type:'create_folder',name:'Phoenix'}]});
 assert.equal(changed.generation,1);
});
