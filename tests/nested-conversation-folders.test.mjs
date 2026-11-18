import test from 'node:test';
import assert from 'node:assert/strict';
import {planningDOM} from './fixture-planning-dom.mjs';
import {paintIndex,createChatFrame} from '../public/next/chat/render.mjs';
function fixture(t){const d=planningDOM(t);Object.defineProperties(Object.getPrototypeOf(d.mount),{type:{configurable:true,get(){return this.getAttribute('type')||''},set(v){this.setAttribute('type',v)}},childNodes:{get(){return this.children}},lastChild:{get(){return this.children.at(-1)}}});return d;}
test('chat folder containers nest rows and retain collapse, focus and selection across refresh',t=>{
 const d=fixture(t),list=d.element('div');d.mount.append(list);
 const items=[{rootId:'a',title:'Alpha',folderId:'work'},{rootId:'b',title:'Beta',folderId:'work'},{rootId:'c',title:'Unfiled'}];
 const opts={groupFolders:true,folderNames:new Map([['work','Work'],['empty','Empty']])};
 const paint=()=>paintIndex({list},items,'a',()=>{},opts);
 assert.equal(paint().length,3);
 const group=list.querySelector('[data-chat-folder="work"]'),row=list.querySelector('[data-conversation="a"]');
 assert(group.contains(row));assert.equal(group.querySelectorAll('.next-conversation-row').length,2);
 row.focus();paint();assert.equal(list.querySelector('[data-conversation="a"]'),row);assert.equal(document.activeElement,row);
 group.open=false;assert.deepEqual(paint().map(x=>x.rootId),['c']);assert.equal(group.open,false);
 group.open=true;assert.equal(paint().length,3);
 items[0]={...items[0],folderId:''};paint();assert(list.querySelector('[data-chat-folder=""]').contains(row));
 assert.equal(group.querySelectorAll('.next-conversation-row').length,1);
 assert.equal(list.querySelector('[data-chat-folder="empty"]').textContent.includes('No chats in this folder.'),true);
 paintIndex({list},items,'a',()=>{},{...opts,showEmptyFolders:false});assert.equal(list.querySelector('[data-chat-folder="empty"]'),null);
});
test('bounded windows retain selected chat nested in its folder',t=>{
 const d=fixture(t),list=d.element('div');d.mount.append(list);
 const items=Array.from({length:240},(_,i)=>({rootId:'x'+i,title:'Chat '+i,folderId:i>200?'later':'first'}));
 const visible=paintIndex({list},items,'x239',()=>{},{limit:20,groupFolders:true,folderNames:new Map([['first','First'],['later','Later']])});
 assert(visible.some(x=>x.rootId==='x239'));assert(list.querySelector('[data-chat-folder="later"]').contains(list.querySelector('[data-conversation="x239"]')));
 assert(list.querySelectorAll('.next-conversation-row').length<=21);
});
test('folder management is named and matching searches expose collapsed rows',t=>{
 const d=fixture(t),list=d.element('div');d.mount.append(list);
 const items=[{rootId:'a',title:'Alpha',folderId:'work'}];
 const options={groupFolders:true,folderNames:new Map([['work','Work']]),onFolderDelete:()=>{}};
 paintIndex({list},items,null,()=>{},options);
 const group=list.querySelector('[data-chat-folder="work"]');
 assert.equal(group.querySelector('.next-chat-folder-remove').getAttribute('aria-label'),'Move Work folder and its chats to Trash');
 group.open=false;
 assert.equal(paintIndex({list},items,null,()=>{},options).length,0);
 assert.equal(paintIndex({list},items,null,()=>{},{...options,expandFolders:true}).length,1);
 assert.equal(group.open,true);
 paintIndex({list},items,null,()=>{},options);assert.equal(group.open,false);
});


test('real hierarchy preserves nested rows, collapses ancestors, moves with contents and keeps editor identity',t=>{
 const d=fixture(t),list=d.element('div');d.mount.append(list);const folders=[{id:'a',name:'A'},{id:'b',name:'B',parentId:'a'},{id:'c',name:'C',parentId:'b'}],items=[{rootId:'r',title:'Nested',folderId:'c'}];const opts={folders,folderNames:new Map(folders.map(f=>[f.id,f.name])),groupFolders:true,onFolderRename:()=>async()=>true};
 const paint=chosen=>paintIndex({list},items,chosen,()=>{},opts);paint(null);const a=list.querySelector('[data-chat-folder="a"]'),b=list.querySelector('[data-chat-folder="b"]'),c=list.querySelector('[data-chat-folder="c"]');assert(a.contains(b));assert(b.contains(c));a.open=false;assert.equal(paint(null).length,0);assert.equal(paint('r').length,1);assert.equal(a.open,true);
 folders[1].parentId=null;paint('r');assert.equal(a.contains(b),false);assert(b.contains(c));assert(c.contains(list.querySelector('[data-conversation="r"]')));
});
