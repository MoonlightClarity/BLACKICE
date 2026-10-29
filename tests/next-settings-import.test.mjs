import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {ConnectionManager} from '../lib/mcp.mjs';
import {parseConnectionImport} from '../lib/connection-import.mjs';
import {createConnectionImportSettings} from '../public/next/workspaces/settings-import.mjs';
import {createConnectionSettings} from '../public/next/workspaces/settings-connections.mjs';
import {planningDOM} from './fixture-planning-dom.mjs';

const settle=()=>new Promise(resolve=>setImmediate(resolve));
// Persistence uses asynchronous filesystem I/O; event-loop turns are not a
// time budget for that work to finish under a concurrent Windows suite.
const until=async read=>{const deadline=performance.now()+5000;while(!read()){if(performance.now()>=deadline)throw Error('Configuration import did not settle within 5 seconds.');await new Promise(resolve=>setTimeout(resolve,5));}};
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const configuration=JSON.stringify({mcpServers:{'Local files':{command:'node',args:['synthetic-server.mjs','private-argument'],env:{TOKEN:'private-environment'}},Search:{type:'streamable-http',url:'https://fixture.invalid/mcp',headers:{Authorization:'Bearer private-header'}}}});
function domFixture(t){
  const dom=planningDOM(t),prototype=Object.getPrototypeOf(dom.mount),type=Object.getOwnPropertyDescriptor(prototype,'type');
  Object.defineProperty(prototype,'type',{get:type.get,set(value){this.setAttribute('type',value);}});
  prototype.replaceChildren=function(...children){for(const child of this.children)child.parentElement=null;this.children=[];this.rawText='';this.markup='';this.append(...children);};
  window.localStorage={setItem(){throw Error('Raw configuration must stay out of browser storage.');}};window.sessionStorage=window.localStorage;
  return dom;
}
async function fixture(t,{hook}={}){
  const dom=domFixture(t),directory=await mkdtemp(path.join(tmpdir(),'blackice-v2-import-'));let starts=0;
  const manager=await new ConnectionManager({dataDir:directory,spawnImpl:()=>{starts++;throw Error('Configuration import must never start a process.');},fetchImpl:()=>{starts++;throw Error('Configuration import must never connect.');}}).init();
  const calls=[],busy=[],state={failureAt:null,reloads:0,changes:0};
  const api=async(route,method,body,options)=>{
    assert.equal(route,'/api/connections/import');assert.equal(method,'POST');const call={route,method,body,options};calls.push(call);
    if(hook){const custom=await hook(call,manager);if(custom!==undefined)return custom;}
    const parsed=parseConnectionImport(body.configuration,{existingIds:manager.list().map(item=>item.id),maxConnections:40});
    if(!body.apply)return {preview:parsed.preview,warnings:parsed.warnings};
    const imported=[];
    for(const [index,candidate]of parsed.candidates.entries()){
      if(index===state.failureAt){state.failureAt=null;throw Object.assign(Error(`${imported.length} of ${parsed.candidates.length} servers were saved. Import stopped at ${candidate.name}. Reload the server list before importing the remaining servers.`),{status:409});}
      imported.push(await manager.save(candidate));
    }
    return {imported,warnings:parsed.warnings};
  };
  const panel=createConnectionImportSettings({mount:dom.mount,api,onChanged:()=>{state.changes++;},onReload:async()=>{state.reloads++;return true;},onBusyChange:value=>busy.push(value)});
  t.after(async()=>{panel.destroy();await manager.close();await rm(directory,{recursive:true,force:true});});panel.enter();
  return {...dom,panel,manager,calls,state,busy,get starts(){return starts;},
    async inputSource(value){await dom.input('#next-settings-import-source',value);},
    async preview(){await dom.click('#next-settings-import-read');await until(()=>!dom.$('#next-settings-import-read').disabled);},
    async idle(){await until(()=>dom.$('#next-settings-import-root').getAttribute('aria-busy')==='false');}};
}

test('real configuration preview is bounded metadata; explicit apply persists both transports without connecting or exposing credentials',async t=>{
  const f=await fixture(t);await f.manager.save({id:'local-files',name:'Existing server',transport:'stdio',command:'old-command',args:[]});
  await f.inputSource(configuration);assert.equal(f.calls.length,0);await f.preview();assert.equal(f.manager.list().length,1,'Preview never saves.');
  assert.equal(f.$('#next-settings-import-preview').querySelectorAll('article').length,2);
  const preview=f.$('#next-settings-import-preview').textContent;
  for(const secret of ['private-environment','Bearer private-header','private-argument'])assert.equal(preview.includes(secret),false);
  assert.match(preview,/local-files-2/);assert.equal(f.starts,0);
  await f.click('#next-settings-import-apply');await f.click('#next-settings-import-apply');await f.idle();
  assert.equal(f.calls.filter(call=>call.body.apply).length,1);assert.equal(f.manager.list().length,3);assert.equal(f.manager.list()[0].name,'Existing server');
  assert.deepEqual(f.manager.secrets.get('local-files-2'),{env:{TOKEN:'private-environment'},headers:{}});
  assert.deepEqual(f.manager.secrets.get('search'),{env:{},headers:{Authorization:'Bearer private-header'}});
  assert.equal(f.manager.list().every(entry=>entry.connected===false),true);assert.equal(f.starts,0);assert.deepEqual(f.busy,[true,false]);
  assert.equal(f.$('#next-settings-import-source').value,'');assert.match(f.$('#next-settings-import-status').textContent,/2 tool servers imported/);assert.equal(f.state.changes,1);
});

test('partial409 keeps the source, disables stale apply and requires saved-state refresh plus a new preview for only remaining servers',async t=>{
  const f=await fixture(t);await f.inputSource(configuration);await f.preview();f.state.failureAt=1;await f.click('#next-settings-import-apply');await f.idle();
  assert.equal(f.manager.list().length,1);assert.equal(f.$('#next-settings-import-source').value,configuration);assert.match(f.$('#next-settings-import-error').textContent,/1 of 2/);
  assert.equal(f.$('#next-settings-import-apply').disabled,true);assert.equal(f.$('#next-settings-import-read').disabled,true);assert.equal(f.$('#next-settings-import-preview').querySelectorAll('article').length,0);
  await f.click('#next-settings-import-apply');await f.click('#next-settings-import-read');assert.equal(f.calls.length,2,'A partial import must not be replayed.');
  f.panel.leave();f.panel.enter();assert.equal(f.$('#next-settings-import-source').value,configuration);assert.equal(f.$('#next-settings-import-apply').disabled,true);
  await f.click('#next-settings-import-reload');await f.idle();assert.equal(f.state.reloads,1);
  await f.inputSource(JSON.stringify({mcpServers:{Search:JSON.parse(configuration).mcpServers.Search}}));await f.preview();await f.click('#next-settings-import-apply');await f.idle();
  assert.deepEqual(f.manager.list().map(entry=>entry.id),['local-files','search']);assert.equal(f.starts,0);
});

test('source changes invalidate an old preview, abort stale reads, and navigation never replays an import',async t=>{
  const gate=deferred();let held=true;
  const f=await fixture(t,{hook:(call)=>{if(!call.body.apply&&held){held=false;return gate.promise;}}});await f.inputSource(configuration);await f.click('#next-settings-import-read');
  const old=f.calls[0];await f.inputSource('{"connections":[{"name":"Replacement","command":"node","args":[]}]}');
  assert.equal(old.options.signal.aborted,true);gate.resolve({preview:[{id:'stale',name:'Stale',command:'node',transport:'stdio'}]});await settle();await settle();
  assert.equal(f.$('#next-settings-import-preview').textContent.includes('Stale'),false);assert.equal(f.$('#next-settings-import-apply').disabled,true);
  f.panel.leave();const before=f.calls.length;f.panel.enter();assert.equal(f.calls.length,before);
  await f.preview();assert.match(f.$('#next-settings-import-preview').textContent,/Replacement/);
  const event=await f.$('#next-settings-import-form').dispatch('submit');assert.equal(event.defaultPrevented,true);assert.equal(f.calls.filter(call=>call.body.apply).length,0);
});

test('an import started explicitly completes across leave/reentry once; failures redact source credential values',async t=>{
  const gate=deferred();let applying=false;
  const f=await fixture(t,{hook:async call=>{if(call.body.apply){applying=true;await gate.promise;throw Error('Refused private-environment and Bearer private-header');}}});
  await f.inputSource(configuration);await f.preview();await f.click('#next-settings-import-apply');await until(()=>applying);f.panel.leave();f.panel.enter();await f.click('#next-settings-import-apply');
  assert.equal(f.calls.filter(call=>call.body.apply).length,1);gate.resolve();await f.idle();
  assert.equal(f.$('#next-settings-import-source').value,configuration);assert.match(f.$('#next-settings-import-error').textContent,/\[redacted\]/);assert.equal(f.$('#next-settings-import-error').textContent.includes('private-header'),false);
  assert.equal(f.$('#next-settings-import-apply').disabled,true);
});

test('JSON file reads respect bounds, preserve newer edits and support choosing the same file again',async t=>{
  const f=await fixture(t),file=f.$('#next-settings-import-file'),gate=deferred();await f.inputSource(configuration);
  file.files=[{size:100,text:()=>gate.promise}];await file.dispatch('change');await f.inputSource('{"connections":[]}');gate.resolve(configuration);await settle();await settle();
  assert.equal(f.$('#next-settings-import-source').value,'{"connections":[]}');assert.equal(f.calls.length,0);
  file.files=[{size:configuration.length,text:async()=>configuration}];await file.dispatch('change');await f.idle();assert.equal(file.value,'');assert.equal(f.calls.length,1);assert.equal(f.$('#next-settings-import-apply').disabled,false);
  file.files=[{size:3*1024*1024,text:async()=>{throw Error('Oversize file must not be loaded');}}];await file.dispatch('change');await f.idle();assert.match(f.$('#next-settings-import-error').textContent,/512,000/);assert.equal(f.$('#next-settings-import-source').value,configuration);
});

test('choosing another JSON file immediately revokes the old preview while the file is loading',async t=>{
  const f=await fixture(t),gate=deferred();await f.inputSource(configuration);await f.preview();const file=f.$('#next-settings-import-file');
  file.files=[{size:100,text:()=>gate.promise}];file.value='previous-file.json';await file.dispatch('change');
  assert.equal(file.value,'');assert.equal(f.$('#next-settings-import-apply').disabled,true);await f.click('#next-settings-import-apply');assert.equal(f.calls.filter(call=>call.body.apply).length,0);
  f.panel.leave();f.panel.enter();gate.resolve(configuration);await settle();assert.equal(f.$('#next-settings-import-apply').disabled,true);assert.match(f.$('#next-settings-import-status').textContent,/paused/);
});

test('backend format and capacity errors retain the source without creating connections',async t=>{
  const f=await fixture(t);
  for(const source of ['not json','{"mcpServers":{"Old":{"type":"sse","url":"https://fixture.invalid/sse"}}}',JSON.stringify({connections:Array.from({length:41},(_,i)=>({name:'Server '+i,command:'node'}))})]){
    await f.inputSource(source);await f.preview();assert.equal(f.$('#next-settings-import-source').value,source);assert.equal(f.$('#next-settings-import-apply').disabled,true);assert.equal(f.manager.list().length,0);
  }
  assert.equal(f.starts,0);
});

test('tool form mutations share the import lock and partial errors do not discard an unrelated connection draft',async t=>{
  const dom=domFixture(t),gate=deferred(),calls=[];let applying=false;
  const panel=createConnectionSettings({mount:dom.mount,events:{subscribe:()=>()=>{}},api:async(route,method='GET',body)=>{
    calls.push({route,method,body});if(route==='/api/connections')return [];
    if(route==='/api/connections/import'&&!body.apply)return {preview:[{id:'imported',name:'Imported',transport:'stdio',command:'node'}],warnings:[]};
    applying=true;await gate.promise;throw Object.assign(Error('1 of 2 servers were saved.'),{status:409});
  }});t.after(()=>panel.destroy());panel.enter();await settle();await dom.input('#next-connections-name','Unrelated draft');
  await dom.input('#next-settings-import-source',configuration);await dom.click('#next-settings-import-read');await until(()=>!dom.$('#next-settings-import-read').disabled);
  await dom.click('#next-settings-import-apply');await until(()=>applying);assert.equal(dom.$('#next-connections-save').disabled,true);await dom.$('#next-connections-form').dispatch('submit');
  assert.equal(calls.filter(call=>call.route==='/api/connections'&&call.method==='POST').length,0);
  gate.resolve();await until(()=>dom.$('#next-settings-import-root').getAttribute('aria-busy')==='false');assert.equal(dom.$('#next-connections-name').value,'Unrelated draft');
});
