import test from 'node:test';
import assert from 'node:assert/strict';
import {planningDOM} from './fixture-planning-dom.mjs';
import {createSettingsWorkspace} from '../public/next/workspaces/settings.mjs';
const settle=()=>new Promise(resolve=>setImmediate(resolve));
async function fixture(t,requests=[]){
 const d=planningDOM(t),calls=[],status={connected:true,authenticated:true,models:[],execution:{activeCount:0}};
 const api=async(route,method='GET',body)=>{calls.push({route,method,body});if(route==='/api/status')return status;if(route==='/api/runtime/settings')return {providerIdleTimeoutMs:300000,...body};if(route==='/api/owner-recovery')return {localManagement:true,requests};if(route==='/api/codex/native-write-recovery')return {status:{},uncertain:[]};throw Error('Fixture does not expose '+route);};
 const workspace=createSettingsWorkspace({mount:d.mount,api,getStatus:()=>status,events:{subscribe:()=>()=>{}}});t.after(()=>workspace.destroy());workspace.enter();await settle();await settle();return {...d,workspace,calls,requests};
}
test('everyday settings separate app connections and hide empty action review without changing saved controls',async t=>{
 const f=await fixture(t);assert.equal(f.$('#next-settings-section-recovery'),null);assert.equal(f.$('#next-review-notice').hidden,true);
 assert.equal(f.$('#next-settings-section-apps').textContent,'App connections');assert.match(f.$('#next-settings-general').textContent,/Response defaults/);assert.match(f.$('#next-settings-general').textContent,/Advanced task settings/);
 assert.equal(f.$('#next-runtime-guardrails'),null);
 assert.equal(f.$('#next-runtime-idle').closest('details').open,false);
 for(const id of ['next-runtime-effort','next-runtime-tier','next-runtime-verbosity','next-runtime-timeout','next-runtime-context'])assert.ok(f.$('#'+id),id+' remains available');
 assert.equal(f.$('#next-execution-limit'),null);assert.equal(f.$('#next-execution-legacy'),null);
 assert.equal(f.calls.some(x=>x.route==='/api/execution/settings'),false);
 assert.equal(f.calls.some(x=>x.method!=='GET'),false);
 assert.equal(f.$('#next-settings-connector').parentElement.id,'next-settings-apps');
 await f.click('#next-settings-section-apps');await settle();assert.equal(f.$('#next-settings-apps').hidden,false);assert.equal(f.$('#next-settings-general').hidden,true);assert.equal(f.$('#next-settings-section-apps').getAttribute('aria-selected'),'true');
 await f.click('#next-settings-section-general');assert.equal(f.$('#next-settings-apps').hidden,true);assert.equal(f.$('#next-settings-general').hidden,false);
});
test('action review appears only with pending reviews and never authorizes during navigation',async t=>{
 const f=await fixture(t,[{state:'pending',requestId:'fixture'}]);assert.equal(f.$('#next-review-notice').hidden,false);assert.match(f.$('#next-review-count').textContent,/1 paused/);await f.click('#next-review-open');await settle();await settle();assert.equal(f.$('#next-settings-recovery').hidden,false);assert.equal(f.$('#next-settings-section-general').tabIndex,0);assert.equal(f.$('#next-settings-general').hidden,true);
 await f.click('#next-settings-section-general');assert.equal(f.$('#next-settings-recovery').hidden,true);assert.equal(f.calls.some(x=>x.method!=='GET'),false);
});
test('interrupted result inspection is explicit and read-only',async t=>{
 const f=await fixture(t);assert.equal(f.calls.some(x=>x.route.includes('native-write-recovery')),false);const button=f.$('#next-native-recovery').querySelector('button');await button.dispatch('click');await settle();assert.equal(f.calls.filter(x=>x.route.includes('native-write-recovery')).length,1);assert.equal(f.calls.some(x=>x.method!=='GET'),false);
});

test('keyboard navigation stays within the appropriate app or primary tab row',async t=>{const f=await fixture(t);await f.$('#next-settings-section-general').dispatch('keydown',{key:'End'});await settle();assert.equal(f.document.activeElement.id,'next-settings-section-apps');await f.$('#next-settings-section-connector').dispatch('keydown',{key:'ArrowRight'});await settle();assert.equal(f.document.activeElement.id,'next-settings-section-gemini');assert.equal(f.$('#next-settings-apps').hidden,false);});

test('app setup explains shared endpoint and independent app connections',async t=>{
 const f=await fixture(t);
 assert.match(f.$('#next-settings-apps').textContent,/One BLACKICE MCP server can serve multiple apps at the same time/);
 assert.match(f.$('#next-settings-apps').textContent,/does not switch or replace another connection/);
 assert.match(f.$('#next-settings-apps').textContent,/use Tools instead/);
 assert.equal(f.calls.some(x=>x.method!=='GET'),false);
});
