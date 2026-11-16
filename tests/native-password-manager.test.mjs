import test from 'node:test';
import assert from 'node:assert/strict';
import {NativePasswordManager,managerFillTarget} from '../desktop/native-password-manager.mjs';
const owner={taskId:'a',nodeId:'b'};
function fixture(){const target={id:'target',owner},tab={id:'manager',owner};const driver={tabs:new Map([['target',target],['manager',tab]]),ownerAdmission:()=>{}};const manager=new NativePasswordManager(driver,{vault:{},browser:{}});const context={targetId:'target',managerId:'manager',owner,ownerKey:JSON.stringify(['a','b'])};manager.contexts.add(context);return {driver,manager,context,target,tab};}
test('manager capability is bound to both current tab owners',()=>{const f=fixture();assert.equal(f.manager.authorize(f.context),f.target);f.tab.owner={taskId:'other'};assert.throws(()=>f.manager.authorize(f.context));f.tab.owner=owner;f.target.owner={taskId:'other'};assert.throws(()=>f.manager.authorize(f.context));});
test('closed manager and closed target invalidate capability',()=>{for(const id of ['target','manager']){const f=fixture();f.driver.tabs.delete(id);assert.throws(()=>f.manager.authorize(f.context));}});
test('owner admission is rechecked on each operation',async()=>{const f=fixture();f.driver.ownerAdmission=()=>{throw Error('stopped')};await assert.rejects(f.manager.perform(f.context,{action:'status'}),/stopped/);});
test('unknown fields never reach vault',async()=>{const f=fixture();await assert.rejects(f.manager.perform(f.context,{action:'save',origin:'https://test.example',external:'x'}),/declared/);});
const entry={origin:'https://test.example',credentialId:'saved',revision:1};
const page={url:entry.origin+'/',tabId:'target',documentId:'doc',frames:[{url:entry.origin+'/',elements:[{ref:'u',tag:'input',type:'email',name:'Email'},{ref:'p',tag:'input',type:'password',name:'Password'}]}]};
test('fill resolves current same-origin references and does not submit',()=>{const result=managerFillTarget(page,entry);assert.equal(result.usernameRef,'u');assert.equal(result.passwordRef,'p');assert.equal(result.expectedDocumentId,'doc');assert.equal(result.submitRef,undefined);});
test('ambiguous or cross-origin password forms require explicit choice',()=>{assert.throws(()=>managerFillTarget({...page,url:'https://wrong.example'},entry));assert.throws(()=>managerFillTarget({...page,frames:[...page.frames,...page.frames]},entry));assert.throws(()=>managerFillTarget({...page,frames:[]},entry));});
