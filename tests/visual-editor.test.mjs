import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {planningDOM} from './fixture-planning-dom.mjs';
import {createVisualWorkspace} from '../public/next/chat/visuals.mjs';
import {VisualArtifacts} from '../lib/visual-artifacts.mjs';
import {VISUAL_EXAMPLE} from '../public/visual-document.mjs';

test('editor preserves conflict drafts, reads pinned history and clears on conversation change',async t=>{
 const {mount,document}=planningDOM(t),proto=Object.getPrototypeOf(document.createElement('button'));
 Object.defineProperty(proto,'type',{get(){return this.getAttribute('type')||this.tagName.toLowerCase();},set(value){this.setAttribute('type',value);},configurable:true});
 const directory=await mkdtemp(path.join(tmpdir(),'visual-editor-'));t.after(()=>rm(directory,{recursive:true,force:true}));const store=new VisualArtifacts({dataDir:directory}),saved=await store.execute({action:'create',conversationId:'first',requestId:'seed',document:VISUAL_EXAMPLE});let conversation='first';const notices=[];
 const api=async(url,method='GET',body)=>{const u=new URL(url,'http://test'),conversationId=u.pathname.split('/')[3];if(method==='POST')return store.execute({...body,conversationId});return store.execute({conversationId,action:u.searchParams.has('artifactId')?'read':'list',...(u.searchParams.has('artifactId')?{artifactId:u.searchParams.get('artifactId')}:{}) ,...(u.searchParams.has('revision')?{revision:Number(u.searchParams.get('revision'))}:{})});};
 const ui=createVisualWorkspace({mount,api,getConversationId:()=>conversation,notify:m=>notices.push(m)});t.after(()=>ui.destroy());await ui.refresh();assert.ok(mount.querySelector('img'));const click=async text=>{const button=mount.querySelectorAll('button').find(b=>b.textContent===text);assert.ok(button,text);await button.onclick();};
 await click('Inspect / edit / history / export');let dialog=mount.querySelector('dialog');assert.ok(dialog.open);const title=dialog.querySelector('textarea');title.value='My unsaved draft';title.oninput();
 await store.execute({action:'revise',conversationId:'first',artifactId:saved.id,expectedRevision:1,requestId:'other',document:VISUAL_EXAMPLE});await click('Save new revision');assert.equal(title.value,'My unsaved draft');assert.match(dialog.querySelector('[role="status"]').textContent,/changed/);
 await click('Close');await ui.refresh(true);await click('Inspect / edit / history / export');dialog=mount.querySelector('dialog');const history=dialog.querySelector('select');history.value='1';history.onchange();await new Promise(resolve=>setTimeout(resolve,20));assert.match(mount.querySelector('dialog h2')?.textContent||mount.querySelector('dialog').querySelector('h2').textContent,/revision 1/);assert.equal(mount.querySelectorAll('button').find(b=>b.textContent==='Save new revision').disabled,true);
 conversation='second';await ui.refresh();assert.equal(mount.querySelector('dialog'),null);assert.equal(mount.querySelector('img'),null);assert.deepEqual(notices,[]);
});
