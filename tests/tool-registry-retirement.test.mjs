import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as io} from 'node:fs';
import {EventEmitter} from 'node:events';
import {mkdtemp,rm,mkdir,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {ConnectionManager} from '../lib/mcp.mjs';
import {chromeAutoConnectConnection} from '../lib/chrome-browser.mjs';
import {createHarnessServer} from '../server.mjs';
const generic={id:'generic',name:'Generic',transport:'stdio',command:'node',args:['must-not-launch.mjs'],enabled:true};
async function directory(t){const root=await mkdtemp(path.join(tmpdir(),'blackice-browser-registry-'));t.after(()=>rm(root,{recursive:true,force:true}));return root;}
test('browser-only extraction preserves old bytes and never reloads generic registry',async t=>{
 const dataDir=await directory(t),old=path.join(dataDir,'connections.json');
 const browser=chromeAutoConnectConnection(),before=JSON.stringify({version:1,connections:[generic,browser]});await writeFile(old,before);
 const manager=new ConnectionManager({dataDir,spawnImpl:()=>assert.fail('Extraction must not launch a server')});await manager.init();t.after(()=>manager.close());
 assert.deepEqual(manager.list().map(x=>x.id),['chrome-live']);assert.equal(await readFile(old,'utf8'),before);
 await assert.rejects(manager.save(generic),{code:'BROWSER_CONNECTION_REQUIRED'});assert.equal(await readFile(old,'utf8'),before);
 await manager.save({...browser,name:'Saved browser'});await manager.close();
 await writeFile(old,'deliberately unreadable archived data');const restored=new ConnectionManager({dataDir});await restored.init();t.after(()=>restored.close());
 assert.equal(restored.list()[0].name,'Saved browser');assert.equal(await readFile(old,'utf8'),'deliberately unreadable archived data');
});
test('concurrent initializers publish one complete browser-only store',async t=>{
 const dataDir=await directory(t);await writeFile(path.join(dataDir,'connections.json'),JSON.stringify({version:1,connections:[generic,chromeAutoConnectConnection()]}));
 const managers=[new ConnectionManager({dataDir}),new ConnectionManager({dataDir})];t.after(()=>Promise.all(managers.map(x=>x.close())));await Promise.all(managers.map(x=>x.init()));
 assert.ok(managers.every(x=>x.list().length===1));assert.equal(JSON.parse(await readFile(path.join(dataDir,'browser-connections', 'settings.json'),'utf8')).connections[0].id,'chrome-live');
});
class Runtime extends EventEmitter{calls=[];status(){return {connected:true,authenticated:true,defaultModel:'fixture'};}async start(){return this.status();}async close(){}async runAgent(o){this.calls.push(o);assert.ok(!o.dynamicTools.some(t=>t.name==='relay_connections'));return {output:'Current host tools remain',threadId:'current-fixture'};}}
test('generic HTTP registry is absent; browser and model APIs remain independent',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'blackice-browser-registry-http-')),dataDir=path.join(root,'data');await mkdir(dataDir);const old=path.join(dataDir,'connections.json'),before=JSON.stringify({version:1,connections:[generic]});await writeFile(old,before);
 const app=await createHarnessServer({runtime:new Runtime(),dataDir,defaultCwd:root,port:0});t.after(async()=>{await app.close();await rm(root,{recursive:true,force:true});});const url=await app.listen();
 const home=await fetch(url),cookie=home.headers.get('set-cookie').split(';')[0];await home.text();
 for(const [route,method] of [['/api/tool-registry','GET'],['/api/connections','GET'],['/api/connections','POST'],['/api/connections/import','POST'],['/api/connections/generic/connect','POST'],['/api/connections/generic/tools','GET'],['/api/connections/generic','DELETE']]){
 const response=await fetch(url+route,{method,headers:{Cookie:cookie,'Content-Type':'application/json'},...(method!=='GET'?{body:'{}'}:{})});assert.equal(response.status,404,route);await response.text();}
 assert.equal((await fetch(url+'/api/browser/status',{headers:{Cookie:cookie}})).status,200);
 assert.equal((await fetch(url+'/api/local-models/config',{headers:{Cookie:cookie}})).status,200);
 assert.equal(await readFile(old,'utf8'),before);assert.equal(app.connections.list().length,0);
 const run=app.engine.startRun({workflow:{id:'registry-retirement',settings:{planningMode:'off',maxParallel:1},name:'Registry retirement',nodes:[{id:'in',type:'input'},{id:'agent',type:'agent',model:'fixture',prompt:'Say hello'},{id:'out',type:'output'}],edges:[{source:'in',target:'agent'},{source:'agent',target:'out'}]},input:'Hello'});
 await app.engine.executions.get(run.id);assert.equal(app.engine.getRun(run.id).status,'completed');
 const saved=app.engine.runs.get(run.id);saved.nodes.agent.toolNames.push('relay_connections');
 const continued=app.engine.continueRun(run.id,{nodeId:'agent',message:'Continue without retired connections'});
 await app.engine.executions.get(continued.id);
 assert.equal(app.engine.getRun(continued.id).status,'completed');
 assert.equal(continued.modelHandoff.reason,'retired-tool-catalog');
 assert.equal(app.engine.runtime.calls.at(-1).threadId,undefined);
 assert.match(app.engine.runtime.calls.at(-1).prompt,/Current host tools remain/);
 assert.ok(!app.engine.runtime.calls.at(-1).dynamicTools.some(t=>t.name==='relay_connections'));
 const normal=app.engine.continueRun(continued.id,{nodeId:'agent',message:'Continue current catalog'});await app.engine.executions.get(normal.id);
 assert.equal(normal.modelHandoff?.reason,undefined);
 assert.equal(app.engine.runtime.calls.at(-1).threadId,'current-fixture');
});

test('browser persistence retries only transient rename and preserves prior bytes on permanent failure',async t=>{
 const dataDir=await directory(t),manager=new ConnectionManager({dataDir});await manager.init();
 const browser=chromeAutoConnectConnection();await manager.save(browser);
 const rename=io.rename;let attempts=0;io.rename=async(...args)=>{attempts++;if(attempts===1)throw Object.assign(Error('sharing lock'),{code:'EPERM'});return rename(...args);};
 try { await manager.save({...browser,name:'After sharing lock'});assert.equal(attempts,2); }
 finally {io.rename=rename;}
 const file=path.join(dataDir,'browser-connections', 'settings.json'),before=await readFile(file,'utf8');assert.equal(JSON.parse(before).connections[0].name,'After sharing lock');
 io.rename=async()=>{throw Object.assign(Error('disk failure'),{code:'EIO'});};
 try {await assert.rejects(manager.save({...browser,name:'Must not persist'}),{code:'EIO'});assert.equal(await readFile(file,'utf8'),before);}
 finally {io.rename=rename;await manager.close().catch(e=>assert.equal(e.code,'EIO'));}
});
