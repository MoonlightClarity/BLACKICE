import test from 'node:test';import assert from 'node:assert/strict';
import {planningDOM} from './fixture-planning-dom.mjs';
import {createBrowserFolders} from '../public/next/workspaces/browser-folders.mjs';
function fixture(t){const f=planningDOM(t);f.mount.innerHTML='<div id="tabs"></div>';const strip=f.$('#tabs'),calls=[];let data={collections:[{id:'p',name:'Projects',parentId:null},{id:'c',name:'Research',parentId:'p'}],tabs:[{tabId:'a',title:'A',collectionId:'c'},{tabId:'b',title:'B'}]},busy=false,refreshes=0;
 const api=async(_p,_m,args)=>{calls.push(args);};
 const folders=createBrowserFolders({api,getTabs:()=>data.tabs,getSelected:()=> 'a',isBusy:()=>busy,refresh:async()=>refreshes++,notice(){}});
 function render(){strip.replaceChildren();for(const tab of data.tabs){const row=f.document.createElement('div');row.className='next-browser-tab-group';const b=f.document.createElement('button');b.dataset.tabId=tab.tabId;b.textContent=tab.title;row.append(b);strip.append(row);}folders.update(data);folders.groupTabs(strip);}
 render();return {...f,strip,folders,calls,data,render,setBusy:v=>busy=v,get refreshes(){return refreshes;}};}
test('app tree nests existing tab rows without extension; collapse and editor drafts survive refresh',async t=>{
 const f=fixture(t);assert.equal(f.strip.getAttribute('data-blackice-tab-model'),null);
 const child=f.$('[data-collection-id="c"]');assert.equal(child.parentElement.closest('[data-collection-id]').dataset.collectionId,'p');assert.equal(f.$('[data-tab-id="a"]').closest('[data-collection-id]').dataset.collectionId,'c');
 await f.click('[data-folder-control="toggle:p"]');f.render();assert.equal(f.$('[data-collection-id="p"] .next-browser-folder-children').hidden,true);
 await f.click('.next-browser-folder-add');const name=f.$('.next-browser-folder-editor input');name.value='Draft';f.render();assert.equal(f.$('.next-browser-folder-editor input'),name);assert.equal(name.value,'Draft');
 await f.key(name.closest('form'),'Escape');assert.equal(f.$('.next-browser-folder-editor'),null);assert.equal(f.calls.length,0);
});
test('explicit move uses observed tab and existing host action; busy and destroyed controls cannot mutate',async t=>{
 const f=fixture(t);await f.click('[data-tab-id="a"]');await f.click('.next-browser-tab-move');const form=f.$('.next-browser-folder-editor');f.$('[aria-label="Folder"]').value='p';await form.dispatch('submit');
 assert.deepEqual(f.calls,[{browser:'relay',action:'tab_collect',tabId:'a',collectionId:'p'}]);assert.equal(f.refreshes,1);
 f.setBusy(true);await f.click('.next-browser-folder-add');assert.equal(f.$('.next-browser-folder-editor'),null);
 f.setBusy(false);f.folders.destroy();await f.click('.next-browser-folder-add');assert.equal(f.calls.length,1);
});
test('folder edits exclude descendants, preserve tabs, and never transfer ownership',async t=>{
 const f=fixture(t);await f.click('[data-folder-control="edit:p"]');const select=f.$('.next-browser-folder-editor select');assert.equal(select.children.length,1);
 const remove=[...f.$('.next-browser-folder-editor').querySelectorAll('button')].find(n=>n.textContent==='Remove folder, keep tabs');await remove.dispatch('click');
 assert.deepEqual(f.calls,[{browser:'relay',action:'collection_remove',collectionId:'p'}]);assert.equal(f.data.tabs.length,2);
});


test('native pagination, pending opening row and empty state survive folder renders',async t=>{
 const f=fixture(t);const more=f.document.createElement('button');more.className='next-native-more-tabs';let clicked=0;more.addEventListener('click',()=>clicked++);
 const opening=f.document.createElement('div');opening.className='next-browser-tab-group';const label=f.document.createElement('button');label.dataset.tabId='';label.textContent='New Personal tab';opening.append(label);
 const empty=f.document.createElement('span');empty.className='next-browser-tabs-empty';empty.textContent='No tabs';
 f.strip.append(more,opening,empty);f.folders.groupTabs(f.strip);f.folders.render();
 assert.equal(f.$('.next-native-more-tabs'),more);assert.equal(f.$('.next-browser-tabs-empty'),empty);assert.ok(f.strip.contains(opening));await more.dispatch('click');assert.equal(clicked,1);
});
test('moving selected tab into collapsed folder reveals its new ancestors without expanding on every refresh',async t=>{
 const f=fixture(t);await f.click('[data-folder-control="toggle:p"]');assert.equal(f.$('[data-collection-id="p"] .next-browser-folder-children').hidden,true);
 f.data.tabs[0].collectionId=null;f.render();f.data.tabs[0].collectionId='c';f.render();assert.equal(f.$('[data-collection-id="p"] .next-browser-folder-children').hidden,false);
 await f.click('[data-folder-control="toggle:p"]');f.render();assert.equal(f.$('[data-collection-id="p"] .next-browser-folder-children').hidden,true);
});
