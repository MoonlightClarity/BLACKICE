import test from 'node:test';
import assert from 'node:assert/strict';
import { sortedCredentials, credentialPage, browserCredentialsView } from '../public/browser-credentials-ui.mjs';
import { createPasswordSettings } from '../public/next/workspaces/settings-passwords.mjs';
import { planningDOM } from './fixture-planning-dom.mjs';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const entries=Array.from({length:45},(_,i)=>({credentialId:'login-'+(45-i),revision:1,origin:'https://site'+(45-i)+'.test',username:'user',label:'Saved login '+(45-i)}));
test('complete metadata dataset sorts naturally by site before paging without mutating input',()=>{
 const before=structuredClone(entries), sorted=sortedCredentials(entries);
 assert.deepEqual(sorted.map(x=>x.credentialId),Array.from({length:45},(_,i)=>'login-'+(i+1)));
 assert.deepEqual(entries,before);
 assert.deepEqual(credentialPage(sorted,0).items.map(x=>x.credentialId),Array.from({length:20},(_,i)=>'login-'+(i+1)));
 assert.equal(credentialPage(sorted,1).items[0].credentialId,'login-21');
 assert.equal(credentialPage(sorted,2).items[4].credentialId,'login-45');
 assert.deepEqual(sortedCredentials(),[]);
});
test('site sorting ignores scheme/www/case and ties by username then label and stable ID',()=>{
 const values=[
 {credentialId:'z',origin:'https://www.Beta.test',username:'z'},
 {credentialId:'b',origin:'https://alpha.test',username:'b'},
 {credentialId:'a2',origin:'https://www.alpha.test',username:'A',label:'two'},
 {credentialId:'a1',origin:'https://alpha.test',username:'a',label:'one'},
 {credentialId:'empty',origin:'',label:'Zulu'},
 ];
 assert.deepEqual(sortedCredentials(values).map(x=>x.credentialId),['a1','a2','b','z','empty']);
 assert.deepEqual(sortedCredentials([{credentialId:'b',origin:'https://same.test'},{credentialId:'a',origin:'https://same.test'}]).map(x=>x.credentialId),['a','b']);
});
test('sorting only touches metadata; secret fields are excluded before UI state',()=>{
 const raw={vault:{entries:[{...entries[0],password:'synthetic-secret-only',secret:'synthetic-secret-only'}]}};
 const projected=browserCredentialsView(raw).vault.entries;
 assert.equal(JSON.stringify(sortedCredentials(projected)).includes('synthetic-secret-only'),false);
 const guarded={...entries[0],get password(){throw Error('password accessed');}};
 assert.equal(sortedCredentials([guarded,entries[1]]).length,2);
});
test('actual mounted Config password list paginates sorted sites and keeps selections across refresh',async t=>{
 const d=planningDOM(t),calls=[];
 const status={localManagement:true,vault:{available:true,healthy:true,revision:1,capabilities:{save:true,delete:true},entries},mirror:{available:false,healthy:true,entries:[],batches:[]},destinations:[]};
 const ui=createPasswordSettings({mount:d.mount,api:async(route,method='GET')=>{calls.push({route,method});assert.equal(route,'/api/browser-credentials');return structuredClone(status);}});
 t.after(()=>ui.destroy());ui.enter();await tick();await tick();
 const ids=()=>d.mount.querySelectorAll('[data-credentials-entry]').map(x=>x.dataset.credentialsEntry);
 assert.equal(ids()[0],'login-1');assert.equal(ids().at(-1),'login-20');
 const selected=d.$('[data-credentials-select="login-1"]');selected.checked=true;await selected.dispatch('change',{},true);
 await d.click('[data-credentials-action="page-next"]');assert.equal(ids()[0],'login-21');
 await d.click('[data-credentials-action="page-next"]');assert.equal(ids()[0],'login-41');assert.equal(ids().length,5);
 assert.equal(d.$('[data-credentials-action="page-next"]').disabled,true);
 await d.click('[data-credentials-action="page-previous"]');await d.click('[data-credentials-action="page-previous"]');
 assert.equal(d.$('[data-credentials-select="login-1"]').checked,true);
 ui.leave();status.vault.entries=[...entries].reverse();ui.enter();await tick();await tick();
 assert.equal(ids()[0],'login-1');assert.equal(d.$('[data-credentials-select="login-1"]').checked,true);
 assert(calls.every(x=>x.method==='GET'));assert.match(d.mount.textContent,/Sorted by site/);
});
