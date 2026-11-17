import test from 'node:test';import assert from 'node:assert/strict';
import {planningDOM} from './fixture-planning-dom.mjs';
import {createBrowserFolders,browserFoldersMarkup} from '../public/next/workspaces/browser-folders.mjs';
test('host bridge publishes existing tab identities without a folder panel or duplicate nodes',async t=>{
 const {mount,document}=planningDOM(t);mount.innerHTML='<div id="tabs"></div>';const strip=mount.querySelector('#tabs'),calls=[];
 const tabs=[{tabId:'a',collectionId:'folder',owner:{taskId:'protected'}},{tabId:'b'}];let refreshes=0;
 const folders=createBrowserFolders({api:async(...args)=>calls.push(args),getTabs:()=>tabs,getSelected:()=> 'a',isBusy:()=>false,refresh:async()=>refreshes++,notice(){}});
 assert.equal(browserFoldersMarkup(),'');folders.update({collections:[{id:'folder',name:'Folder'}]});folders.groupTabs(strip);
 const model=JSON.parse(strip.getAttribute('data-blackice-tab-model'));assert.deepEqual(model.tabs,[{tabId:'a',collectionId:'folder'},{tabId:'b',collectionId:null}]);assert.equal(strip.children.length,0);
 strip.setAttribute('data-blackice-tab-request',JSON.stringify({action:'tab_collect',tabId:'a',collectionId:null}));await strip.dispatch('blackice-tab-action');await new Promise(r=>setImmediate(r));
 assert.equal(calls.length,1);assert.deepEqual(calls[0][2],{browser:'relay',action:'tab_collect',tabId:'a',collectionId:null});assert.equal(refreshes,1);
 strip.setAttribute('data-blackice-tab-request',JSON.stringify({action:'tab_collect',tabId:'unrendered',collectionId:null}));await strip.dispatch('blackice-tab-action');assert.equal(calls.length,1);
 strip.setAttribute('data-blackice-tab-request',JSON.stringify({action:'close',tabId:'a'}));await strip.dispatch('blackice-tab-action');assert.equal(calls.length,1);
 folders.destroy();assert.equal(strip.getAttribute('data-blackice-tab-model'),null);
});
test('desktop distribution includes every MV3 asset and no parallel host panel', async () => {
 const {readFile}=await import('node:fs/promises');
 const config=await readFile(new URL('../desktop/electron-builder.yml',import.meta.url),'utf8');
 assert.match(config,/asar: false/);assert.ok(config.includes('  - desktop/tab-folders/**/*'));
 const manifest=JSON.parse(await readFile(new URL('../desktop/tab-folders/manifest.json',import.meta.url),'utf8'));
 assert.equal(manifest.manifest_version,3);assert.equal(manifest.permissions,undefined);
 for(const script of manifest.content_scripts) for(const file of [...script.js,...script.css])assert.ok((await readFile(new URL('../desktop/tab-folders/'+file,import.meta.url),'utf8')).length>0);
 assert.equal(browserFoldersMarkup(),'');
});
