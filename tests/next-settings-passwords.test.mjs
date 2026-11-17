import test from 'node:test';
import assert from 'node:assert/strict';
import {planningDOM} from './fixture-planning-dom.mjs';
import {createSettingsWorkspace} from '../public/next/workspaces/settings.mjs';
import {createPasswordSettings} from '../public/next/workspaces/settings-passwords.mjs';
import {readFile} from 'node:fs/promises';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const metadata={localManagement:true,vault:{available:true,healthy:true,revision:1,capabilities:{save:true,delete:true},entries:[{credentialId:'fixture',revision:1,origin:'https://example.test',username:'fixture@example.test',label:'Synthetic login'}]},mirror:{available:false,healthy:true,revision:1,settings:{enabled:false},capabilities:{},entries:[],batches:[]},destinations:[]};
async function fixture(t){
 const d=planningDOM(t),calls=[],status={connected:true,models:[],execution:{activeCount:0}};
 const api=async(route,method='GET',body)=>{calls.push({route,method,body});if(route==='/api/browser-credentials')return structuredClone(metadata);if(route==='/api/status')return status;if(route==='/api/runtime/settings')return {providerIdleTimeoutMs:300000};if(route==='/api/execution/settings')return {};if(route==='/api/owner-recovery')return {requests:[]};throw Error('Unexpected fixture route '+route);};
 const workspace=createSettingsWorkspace({mount:d.mount,api,getStatus:()=>status,events:{subscribe:()=>()=>{}}});t.after(()=>workspace.destroy());workspace.enter();await tick();await tick();
 return {...d,calls,workspace,api};
}
test('Password manager is discoverable in Settings and navigation only reads metadata',async t=>{
 const f=await fixture(t);assert.equal(f.$('#next-settings-section-passwords').textContent,'Passwords');assert.equal(f.calls.some(x=>x.route==='/api/browser-credentials'),false);
 await f.workspace.openSection('passwords');await tick();
 assert.equal(f.$('#next-settings-passwords').hidden,false);
 assert.match(f.$('#credentials-list').textContent,/fixture@example.test/);
 assert.equal(f.calls.filter(x=>x.route==='/api/browser-credentials').length,1);
 assert.equal(f.$('.next-password-copy').open,false);
 assert.match(f.$('.browser-credentials').textContent,/Manage logins saved for BLACKICE agents/);
 assert.equal(f.calls.some(x=>x.method!=='GET'),false);
});
test('switching Settings sections preserves vault draft nodes and pauses detached panel',async t=>{
 const f=await fixture(t);await f.workspace.openSection('passwords');await tick();
 const password=f.$('#credentials-password');password.value='synthetic-draft-only';
 const panel=password.closest('.next-password-settings');assert.equal(panel.isConnected,true);
 await f.workspace.openSection('general');assert.equal(panel.isConnected,false);
 await f.workspace.openSection('passwords');await tick();
 assert.equal(f.$('#credentials-password'),password);assert.equal(password.value,'synthetic-draft-only');
 assert.equal(f.calls.some(x=>x.method!=='GET'),false);
 f.workspace.leave();assert.equal(panel.isConnected,false);
 f.workspace.enter();await tick();assert.equal(panel.isConnected,true);
});
test('password panel is lazy, destruction clears draft and cannot restart',async t=>{
 const d=planningDOM(t),calls=[];
 const ui=createPasswordSettings({mount:d.mount,api:async route=>{calls.push(route);return metadata;}});
 assert.equal(calls.length,0);ui.enter();await tick();const field=d.$('#credentials-password');field.value='synthetic';
 ui.destroy();assert.equal(field.value,'');assert.equal(d.mount.textContent,'');ui.enter();assert.equal(calls.length,1);
});
test('both browser renderers route Passwords to same existing Settings manager',async()=>{
 for(const path of ['browser.mjs','browser-native.mjs']){
  const source=await readFile(new URL('../public/next/workspaces/'+path,import.meta.url),'utf8');
  assert.match(source,/id="next-browser-passwords">Passwords/);
  assert.match(source,/onNavigate\?\.\('settings',\{settingsSection:'passwords'\}\)/);
 }
 const shell=await readFile(new URL('../public/next/index.html',import.meta.url),'utf8');
 assert.match(shell,/browser-credentials.css/);assert.match(shell,/next\/settings-passwords.css/);
});
