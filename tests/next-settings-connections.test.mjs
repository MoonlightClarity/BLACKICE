import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {ConnectionManager,normalizeConnection} from '../lib/mcp.mjs';
import {connectionSettingsDraft,connectionSettingsPayload,connectionSettingsSnapshot,connectionCatalogWindow,createConnectionSettings} from '../public/next/workspaces/settings-connections.mjs';

const local={id:'local-tools',name:'Local tools',transport:'stdio',enabled:true,timeoutMs:30000,
  command:'node',args:['server.mjs'],cwd:'C:\\fixture',envKeys:[],headerNames:[]};
const http={id:'remote-tools',name:'Remote tools',transport:'http',enabled:true,timeoutMs:45000,
  url:'https://tools.example/mcp',envKeys:[],headerNames:['Authorization']};

test('local payload keeps literal arguments and agrees with the actual MCP contract',()=>{
  const fields=connectionSettingsDraft(local);
  fields.args='server.mjs\r\nC:\\folder with spaces\r\n\r\n$(literal)\r\n';
  const value=connectionSettingsPayload(fields,local);
  assert.deepEqual(value.args,['server.mjs','C:\\folder with spaces','','$(literal)']);
  assert.equal(value.timeoutMs,30000);assert.equal(value.id,'local-tools');
  assert.deepEqual(normalizeConnection(value),value);
  assert.equal(Object.hasOwn(value,'env'),false);assert.equal(Object.hasOwn(value,'headers'),false);
  const precise={...local,timeoutMs:1001};
  assert.equal(connectionSettingsPayload(connectionSettingsDraft(precise),precise).timeoutMs,1001,'Editing preserves every backend-supported timeout.');
});

test('HTTP payload omits blank secret maps, preserves saved names and clears only explicit empty objects',()=>{
  const fields=connectionSettingsDraft(http);
  const preserved=connectionSettingsPayload({...fields,env:'  ',headers:''},http);
  assert.equal(Object.hasOwn(preserved,'headers'),false);assert.equal(Object.hasOwn(preserved,'env'),false);
  assert.deepEqual(connectionSettingsPayload({...fields,headers:'{}'},http).headers,{});
  assert.deepEqual(connectionSettingsPayload({...fields,headers:'{"Authorization":"Bearer fixture"}'},http).headers,{Authorization:'Bearer fixture'});
  assert.equal(fields.headers,'','Saved secret values never appear in a new draft.');
  assert.equal(fields.url,http.url);assert.equal(fields.timeout,'45');
});

test('changed endpoints, arguments and working folders cannot silently reuse saved secret groups',()=>{
  const fields=connectionSettingsDraft(http);
  assert.throws(()=>connectionSettingsPayload({...fields,url:'https://other.example/mcp'},http),/destination changed.*HTTP headers/);
  assert.deepEqual(connectionSettingsPayload({...fields,url:'https://other.example/mcp',headers:'{}'},http).headers,{});
  const withEnv={...local,envKeys:['TOKEN']},draft=connectionSettingsDraft(withEnv);
  for(const update of [{command:'python'},{args:'other.mjs'},{cwd:'C:\\different'},
    {transport:'http',url:'https://other.example/mcp'}])
    assert.throws(()=>connectionSettingsPayload({...draft,...update},withEnv),/destination changed.*environment/);
  assert.deepEqual(connectionSettingsPayload({...draft,args:'other.mjs',env:'{"TOKEN":"new-token"}'},withEnv).env,{TOKEN:'new-token'});
  assert.doesNotThrow(()=>connectionSettingsPayload({...fields,name:'Renamed tools',timeout:'50'},http),'Names and timeouts do not change the server destination.');
});

test('invalid connection settings fail before API submission',()=>{
  const fields=connectionSettingsDraft(local);
  for(const patch of [{id:'../bad'},{name:' '},{transport:'sse'},{timeout:'0'},{timeout:'181'},{timeout:'1.0001'},
    {command:''},{args:Array(101).fill('arg').join('\n')},{cwd:'relative'},
    {env:'[]'},{env:'{"TOKEN":false}'},{headers:'{"Authorization":"one\\ntwo"}'},{headers:'{"Host":"elsewhere"}'}])
    assert.throws(()=>connectionSettingsPayload({...fields,...patch}));
  for(const url of ['ftp://tools.example/mcp','https://user:secret@tools.example/mcp','https://tools.example/mcp?token=secret','https://tools.example/mcp#section'])
    assert.throws(()=>connectionSettingsPayload({...connectionSettingsDraft(http),url},http));
  assert.throws(()=>connectionSettingsPayload({...fields,id:'renamed-id'},local),/keeps its ID/);
});

test('stale snapshots ignore live connection activity but detect saved settings or credential-name changes',()=>{
  const original=connectionSettingsSnapshot(http);
  assert.equal(connectionSettingsSnapshot({...http,connected:true,toolCount:200,busy:1,error:'Temporary error'}),original);
  for(const patch of [{name:'Other name'},{enabled:false},{timeoutMs:10000},{url:'https://other.example/mcp'},{headerNames:['Authorization','Token']}])
    assert.notEqual(connectionSettingsSnapshot({...http,...patch}),original);
  assert.equal(connectionSettingsSnapshot({...http,envKeys:['A','B']}),connectionSettingsSnapshot({...http,envKeys:['B','A']}));
  assert.equal(connectionSettingsSnapshot(null),null);
});

test('tool catalog bounds visible schemas and retains the server truncation signal',()=>{
  const tools=Array.from({length:1000},(_,index)=>({name:'tool-'+index,inputSchema:{type:'object'}}));
  const catalog={tools,total:5000,matches:3000,truncated:true};
  const first=connectionCatalogWindow(catalog);
  assert.equal(first.shown.length,20);assert.equal(first.hidden,20);assert.equal(first.matches,3000);assert.equal(first.truncated,true);
  assert.equal(connectionCatalogWindow(catalog,10000).shown.length,40);
  assert.equal(connectionCatalogWindow({},NaN).shown.length,0);
  assert.equal(tools.length,1000,'Viewport projection cannot discard saved catalog data.');
});

test('real connection storage preserves and clears maps without starting a server',async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),'blackice-next-connections-'));
  let launched=0;
  const manager=await new ConnectionManager({dataDir:directory,spawnImpl:()=>{launched++;throw Error('Configuration must not connect.');}}).init();
  t.after(async()=>{await manager.close();await rm(directory,{recursive:true,force:true});});
  let saved=await manager.save({id:'saved-tools',name:'Saved tools',transport:'stdio',command:'node',args:['server.mjs'],enabled:true,env:{TOKEN:'fixture-secret'},headers:{}});
  const fields=connectionSettingsDraft(saved);
  saved=await manager.save(connectionSettingsPayload({...fields,name:'Renamed tools'},saved));
  assert.deepEqual(saved.envKeys,['TOKEN']);assert.equal(launched,0);
  assert.throws(()=>connectionSettingsPayload({...connectionSettingsDraft(saved),command:'python'},saved),/destination changed/);
  saved=await manager.save(connectionSettingsPayload({...connectionSettingsDraft(saved),command:'python',env:'{}'},saved));
  assert.deepEqual(saved.envKeys,[]);assert.equal(saved.command,'python');assert.equal(saved.connected,false);assert.equal(launched,0);
  assert.deepEqual(await manager.remove(saved.id),{removed:true});assert.equal(manager.list().length,0);
});

function panelFixture(api){
  const nodes=new Map(),listeners=new Set();
  const document={createElement:tag=>new Element(tag)};
  class Element{
    constructor(tag='div'){this.tagName=tag.toUpperCase();this.ownerDocument=document;this.children=[];this.listeners=new Map();this.dataset={};this.value='';this.checked=false;this.disabled=false;this.hidden=false;this.textContent='';}
    append(...items){this.children.push(...items);}
    replaceChildren(...items){this.children=[...items];}
    setAttribute(name,value){this[name]=value;}
    addEventListener(name,listener){this.listeners.set(name,listener);}
    querySelectorAll(selector){return this.children.flatMap(child=>[...(selector==='button'&&child.tagName==='BUTTON'?[child]:[]),...child.querySelectorAll(selector)]);}
    emit(name,extra={}){return this.listeners.get(name)?.({target:this,key:'',preventDefault(){},...extra});}
    set innerHTML(source){for(const match of source.matchAll(/<([a-z][a-z0-9]*)\b[^>]*\bid="([^"]+)"[^>]*>/g))nodes.set(match[2],new Element(match[1]));}
    querySelector(selector){return nodes.get(selector.slice(1))||null;}
  }
  const mount=new Element(),calls=[];
  const panel=createConnectionSettings({mount,api:async(...args)=>{calls.push(args);return api(...args);},events:{subscribe:listener=>{listeners.add(listener);return()=>listeners.delete(listener);}}});
  const get=id=>nodes.get('next-connections-'+id);
  return {panel,calls,get,input(id,value){const node=get(id);if(id==='enabled')node.checked=value;else node.value=value;node.emit(['enabled','transport'].includes(id)?'change':'input');},
    event:type=>{for(const listener of listeners)listener({type});}};
}
const settled=()=>new Promise(resolve=>setImmediate(resolve));
async function until(check){for(let i=0;i<100;i++){if(check())return;await settled();}assert.fail('Connection panel did not settle.');}

test('enter and status reads retain unsaved settings and never connect implicitly',async()=>{
  let entries=[structuredClone(local)];
  const f=panelFixture(async(route,method='GET')=>{assert.equal(route,'/api/connections');assert.equal(method,'GET');return structuredClone(entries);});
  f.panel.enter();await until(()=>f.get('list').children[0]?.tagName==='BUTTON');
  f.get('list').children[0].emit('click');f.input('name','Unsaved local draft');
  f.panel.leave();entries[0].name='Changed by another editor';f.panel.enter();await settled();await settled();
  assert.equal(f.get('name').value,'Unsaved local draft');assert.equal(f.get('stale').hidden,false);
  const before=f.calls.length;let prevented=false;
  f.get('form').emit('keydown',{target:f.get('name'),key:'Enter',preventDefault(){prevented=true;}});
  assert.equal(prevented,true);assert.equal(f.calls.length,before);
  assert.ok(f.calls.every(call=>call.length===1),'Entry and reentry cannot save or connect.');f.panel.destroy();
});

test('one explicit save survives workspace leave while duplicate saves stay blocked',async()=>{
  let entries=[],release;const pending=new Promise(resolve=>{release=resolve;});
  const f=panelFixture(async(route,method='GET',body)=>{
    assert.equal(route,'/api/connections');
    if(method==='POST'){await pending;const result={...body,envKeys:[],headerNames:[],connected:false};entries=[result];return result;}
    return structuredClone(entries);
  });
  f.panel.enter();await settled();f.input('name','New local server');f.input('command','node');
  f.get('form').emit('submit');f.get('form').emit('submit');
  await until(()=>f.calls.some(call=>call[1]==='POST'));
  f.panel.leave();f.panel.enter();f.get('form').emit('submit');
  assert.equal(f.calls.filter(call=>call[1]==='POST').length,1);
  release();await until(()=>f.get('feedback').textContent.includes('settings saved'));
  assert.equal(f.get('env').value,'');assert.equal(f.get('headers').value,'');
  assert.ok(f.calls.every(call=>call[0]==='/api/connections'),'Saving must never connect a server.');f.panel.destroy();
});

test('catalog reads are explicit, bounded and never invoke tools',async()=>{
  const entry={...http,headerNames:[],connected:false};
  const f=panelFixture(async(route,method='GET')=>{
    assert.equal(method,'GET');
    if(route==='/api/connections')return [entry];
    assert.equal(route,'/api/connections/remote-tools/tools?query=search');
    return {connectionId:entry.id,matches:500,total:500,truncated:true,tools:Array.from({length:40},(_,i)=>({name:'search-'+i,inputSchema:{type:'object'}}))};
  });
  f.panel.enter();await until(()=>f.get('list').children[0]?.tagName==='BUTTON');f.get('list').children[0].emit('click');
  assert.equal(f.calls.length,1);f.get('query').value='search';f.get('catalog-read').emit('click');
  await until(()=>f.get('catalog').children.length===20);
  assert.match(f.get('catalog-note').textContent,/Narrow your search/);f.get('catalog-more').emit('click');
  assert.equal(f.get('catalog').children.length,40);assert.ok(f.calls.every(call=>!call[1]));f.panel.destroy();
});

test('a newer saved configuration blocks stale draft writes without discarding the draft',async()=>{
  let entries=[structuredClone(local)];
  const f=panelFixture(async(route,method='GET')=>{
    assert.equal(route,'/api/connections');assert.equal(method,'GET','A stale save must never reach POST.');return structuredClone(entries);
  });
  f.panel.enter();await until(()=>f.get('list').children[0]?.tagName==='BUTTON');f.get('list').children[0].emit('click');
  f.input('name','My unsaved draft');entries=[{...local,command:'python'}];f.get('form').emit('submit');
  await until(()=>f.get('feedback').textContent.includes('changed since editing'));
  assert.equal(f.get('name').value,'My unsaved draft');assert.equal(f.get('command').value,'node');
  assert.equal(f.get('stale').hidden,false);assert.equal(f.calls.length,3);f.panel.destroy();
});

test('failed explicit connect remains separate from saved state and is never replayed on reentry',async()=>{
  let attempts=0;const entry={...local,connected:false,error:'Fixture connection failed'};
  const f=panelFixture(async(route,method='GET')=>{
    if(method==='GET'){assert.equal(route,'/api/connections');return [entry];}
    assert.equal(route,'/api/connections/local-tools/connect');assert.equal(method,'POST');attempts++;throw Error('Fixture process unavailable');
  });
  f.panel.enter();await until(()=>f.get('list').children[0]?.tagName==='BUTTON');f.get('list').children[0].emit('click');f.get('connect').emit('click');
  await until(()=>f.get('feedback').textContent.includes('Connection failed.'));
  assert.match(f.get('status').textContent,/Disconnected.*Connection error/);assert.equal(attempts,1);
  f.panel.leave();f.panel.enter();await settled();await settled();assert.equal(attempts,1);
  assert.equal(f.get('name').value,local.name);f.panel.destroy();
});
