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
test('SVG folder controls remove only the chosen folder through the existing keep-tabs action',async t=>{
 const f=fixture(t),remove=f.$('[data-folder-control="remove:c"]');
 assert.equal(remove.getAttribute('aria-label'),'Remove folder Projects / Research');assert.equal(remove.title,'Remove folder, keep tabs');
 assert.ok(remove.querySelector('svg'));assert.ok(f.$('[data-folder-control="toggle:c"] svg'));assert.ok(f.$('[data-collection-id="c"] .next-browser-folder-icon svg'));
 assert.equal(f.$('[data-collection-id=""] .next-browser-folder-remove'),null);
 await remove.dispatch('click');assert.deepEqual(f.calls,[{browser:'relay',action:'collection_remove',collectionId:'c'}]);assert.equal(f.data.tabs.length,2);assert.equal(f.$('.next-browser-folder-editor'),null);
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

test('moving selected tab between identically named paths expands new folder IDs only',async t=>{
 const f=fixture(t);
 f.data.collections.push({id:'p2',name:'Projects',parentId:null},{id:'c2',name:'Research',parentId:'p2'});f.render();
 await f.click('[data-folder-control="toggle:c2"]');await f.click('[data-folder-control="toggle:p2"]');
 assert.equal(f.$('[data-collection-id="p2"] .next-browser-folder-children').hidden,true);
 f.data.tabs[0].collectionId='c2';f.render();
 assert.equal(f.$('[data-collection-id="p2"] .next-browser-folder-children').hidden,false);
 assert.equal(f.$('[data-collection-id="c2"] .next-browser-folder-children').hidden,false);
 assert.equal(f.$('[data-tab-id="a"]').closest('[data-collection-id]').dataset.collectionId,'c2');
 await f.click('[data-folder-control="toggle:p2"]');f.render();
 assert.equal(f.$('[data-collection-id="p2"] .next-browser-folder-children').hidden,true);
});

test('leaving hides the folder editor and explicit resume preserves its unsaved inputs',async t=>{
 const f=fixture(t);await f.click('.next-browser-folder-add');
 const form=f.$('.next-browser-folder-editor'),name=form.querySelector('input');name.value='Unsent folder';
 f.folders.leave();assert.equal(form.hidden,true);f.render();assert.equal(form.hidden,true);
 assert.equal(f.calls.length,0);assert.ok(f.$('.next-browser-folder-resume'));
 await f.click('.next-browser-folder-resume');assert.equal(form.hidden,false);assert.equal(name.value,'Unsent folder');assert.equal(f.calls.length,0);
});

test('folder name opens rename while its disclosure alone changes expansion',async t=>{
 const f=fixture(t);const toggle=f.$('[data-folder-control="toggle:p"]');
 assert.equal(toggle.getAttribute('aria-label'),'Collapse Projects');assert.equal(toggle.dataset.browserIcon,'caretDown');assert.equal(toggle.getAttribute('aria-expanded'),'true');
 await f.click('[data-folder-control="edit:p"]');
 assert.equal(f.$('.next-browser-folder-rename').value,'Projects');
 assert.equal(f.$('[data-collection-id="p"] .next-browser-folder-children').hidden,false);
 f.$('.next-browser-folder-rename').value='Renamed';
 await f.key(f.$('.next-browser-folder-rename'),'Enter');
 assert.deepEqual(f.calls,[{browser:'relay',action:'collection_rename',collectionId:'p',name:'Renamed',expectedName:'Projects'}]);
 await f.click('[data-folder-control="toggle:p"]');assert.equal(f.$('[data-collection-id="p"] .next-browser-folder-children').hidden,true);
});

test('Ctrl Enter indents and Ctrl Shift Enter outdents through persistent folder actions',async t=>{
 const f=fixture(t);f.data.collections.push({id:'second',name:'Second'});f.render();
 await f.$('[data-collection-id="second"] .next-browser-folder-heading').dispatch('keydown',{key:'Enter',ctrlKey:true});
 assert.deepEqual(f.calls.at(-1),{browser:'relay',action:'collection_move',collectionId:'second',parentCollectionId:'p'});
 f.data.collections.find(x=>x.id==='second').parentId='p';f.render();
 await f.$('[data-collection-id="second"] .next-browser-folder-heading').dispatch('keydown',{key:'Enter',ctrlKey:true,shiftKey:true});
 assert.deepEqual(f.calls.at(-1),{browser:'relay',action:'collection_move',collectionId:'second',parentCollectionId:null});
});
test('inline rename draft survives refresh; Escape discards and leave does not save',async t=>{
 const f=fixture(t);await f.click('[data-folder-control="edit:p"]');const input=f.$('.next-browser-folder-rename');input.value='Unsent rename';f.render();assert.equal(f.$('.next-browser-folder-rename'),input);
 await f.key(input,'Escape');assert.equal(f.$('.next-browser-folder-rename'),null);await f.click('[data-folder-control="edit:p"]');assert.equal(f.$('.next-browser-folder-rename').value,'Projects');
 f.folders.leave();assert.equal(f.$('.next-browser-folder-rename'),null);assert.equal(f.calls.length,0);
});
test('folder drag rejects cycles and moves observed folders only',async t=>{
 const f=fixture(t);const dt=id=>({types:['application/x-blackice-folder'],getData:type=>type==='application/x-blackice-folder'?id:'',setData(){}});
 await f.$('[data-collection-id="c"] .next-browser-folder-heading').dispatch('drop',{dataTransfer:dt('p')});assert.equal(f.calls.length,0);
 await f.$('.next-browser-folder-toolbar').dispatch('drop',{dataTransfer:dt('c')});assert.deepEqual(f.calls,[{browser:'relay',action:'collection_move',collectionId:'c',parentCollectionId:null}]);
});

test('Move opens a named dialog as a genuine modal, retains choice through refresh and Escape cancels',async t=>{
 const f=fixture(t);await f.click('.next-browser-tab-move');const form=f.$('.next-browser-folder-editor');
 assert.equal(form.parentElement.tagName,'DIALOG');assert.equal(form.getAttribute('aria-label'),'Move tab to folder');
 assert.equal(form.parentElement.open,true);const target=form.querySelector('select');target.value='p';f.render();
 assert.equal(form.querySelector('select').value,'p');assert.equal(form.parentElement.open,true);
 await f.key(form,'Escape');assert.equal(f.$('.next-browser-folder-editor'),null);assert.equal(f.calls.length,0);
});
