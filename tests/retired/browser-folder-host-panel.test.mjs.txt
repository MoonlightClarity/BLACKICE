import test from 'node:test';
import assert from 'node:assert/strict';
import {planningDOM} from './fixture-planning-dom.mjs';
import {createBrowserFolders,browserFoldersMarkup} from '../public/next/workspaces/browser-folders.mjs';

test('one tab strip groups tabs by nested folder without a duplicate management list', async t=>{
 const dom=planningDOM(t),{mount,document}=dom;
 const proto=Object.getPrototypeOf(mount);
 proto.replaceChildren=function(...nodes){for(const n of this.children)n.parentElement=null;this.children=[];this.rawText='';this.markup='';this.append(...nodes);};
 mount.innerHTML=browserFoldersMarkup()+'<div id="tabs"></div>';
 const tabs=[{tabId:'a',title:'A',collectionId:'child'},{tabId:'b',title:'B',collectionId:'root'},{tabId:'c',title:'C',collectionId:'missing'}];
 const folders=createBrowserFolders({mount,api:async()=>{},getTabs:()=>tabs,getSelected:()=> 'a',isBusy:()=>false,select(){},refresh:async()=>{},notice(){}});
 const strip=mount.querySelector('#tabs');
 for(const tab of tabs){const group=document.createElement('div');group.className='next-browser-tab-group';const btn=document.createElement('button');btn.className='next-browser-tab';btn.dataset.tabId=tab.tabId;btn.textContent=tab.title;group.append(btn);strip.append(group);}
 folders.update({collections:[{id:'root',name:'Research'},{id:'child',name:'Companies',parentId:'root'}]});
 folders.groupTabs(strip);
 assert.equal(strip.querySelectorAll('.next-browser-tab').length,3);
 assert.equal(mount.querySelectorAll('.next-browser-folder-tab').length,0);
 assert.equal(strip.querySelectorAll('.next-browser-tab-collection').length,3);
 assert.match(strip.textContent,/Research \/ Companies/);
 assert.match(strip.textContent,/Unfiled/);
 const first=strip.querySelector('.next-browser-collection-toggle');await first.dispatch('click');
 assert.equal(strip.querySelector('.next-browser-collection-tabs').hidden,true);
 folders.groupTabs(strip);
 assert.equal(strip.querySelectorAll('.next-browser-tab').length,3,'repainting must not duplicate tabs');
 assert.equal(strip.querySelector('.next-browser-collection-tabs').hidden,true,'collapse survives repaint');
 await strip.querySelector('.next-browser-collection-toggle').dispatch('click');
 assert.equal(strip.querySelector('.next-browser-collection-tabs').hidden,false);
 folders.destroy();
});
