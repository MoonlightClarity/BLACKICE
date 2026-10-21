import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,mkdir,rm,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {createHarnessServer} from '../server.mjs';

class Runtime extends EventEmitter {
  status(){return{connected:false,authenticated:false,models:[]};}
  async start(){return this.status();}
  async close(){}
  async runAgent(){throw Error('Retired bridge routes must not invoke a model.');}
}
class Desktop extends EventEmitter {
  status(){return{available:false,enabled:false};}
  async setEnabled(){return this.status();}
}
async function fixture(t,{seed}={}){
  const root=await mkdtemp(path.join(tmpdir(),'blackice-retired-bridge-'));
  const dataDir=path.join(root,'data');await mkdir(dataDir);
  await seed?.(dataDir);
  const app=await createHarnessServer({port:0,dataDir,defaultCwd:path.join(root,'workspace'),runtime:new Runtime(),desktop:new Desktop(),autoAttachDesktop:false});
  await app.learning.updateSettings({mode:'manual'});
  const url=await app.listen(),page=await fetch(url),cookie=page.headers.get('set-cookie').split(';')[0];
  await page.text();
  t.after(async()=>{await app.close();assert.match(path.basename(root),/^blackice-retired-bridge-/);await rm(root,{recursive:true,force:true});});
  const request=(route,{method='GET',body}={})=>fetch(url+route,{method,headers:{Cookie:cookie,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  return{app,url,dataDir,request};
}

test('retired bridge routes reject reads, writes, setup and MCP without offering tools or starting work',async t=>{
  const context=await fixture(t);
  for(const [route,method] of [
    ['/api/chatgpt-bridge','GET'],['/api/chatgpt-bridge/config','GET'],['/api/chatgpt-bridge/config','PUT'],
    ['/api/chatgpt-bridge/config/token','POST'],['/api/chatgpt-bridge/requests','GET'],['/api/chatgpt-bridge/requests','POST'],
    ['/api/chatgpt-bridge/requests/legacy-one','GET'],['/api/chatgpt-bridge/requests/legacy-one/complete','POST'],
    ['/api/chatgpt-bridge/mcp','POST'],
  ]){
    const response=await context.request(route,{method,...(method==='GET'?{}:{body:{}})});
    assert.equal(response.status,410,route);const value=await response.json();assert.equal(value.code,'FEATURE_NOT_OFFERED');
  }
  const status=await(await context.request('/api/status')).json();
  assert.equal(Object.hasOwn(status,'chatgptBridge'),false);
  assert.equal(context.app.engine.chatgptBridge,undefined);
  assert.equal(context.app.engine.listRuns().length,0);
  for(const asset of ['/chatgpt-bridge-ui.mjs','/chatgpt-bridge.css'])assert.equal((await fetch(context.url+asset)).status,404);
});

test('retired routes still require the local session and reject cross-origin access',async t=>{
  const context=await fixture(t);
  assert.equal((await fetch(context.url+'/api/chatgpt-bridge')).status,401);
  assert.equal((await fetch(context.url+'/api/chatgpt-bridge/config',{method:'PUT',headers:{'Content-Type':'application/json'},body:'{}'})).status,401);
  assert.equal((await fetch(context.url+'/api/chatgpt-bridge',{headers:{Origin:'https://unrelated.example'}})).status,403);
});

test('startup leaves historical bridge data untouched and never restores a saved listener',async t=>{
  const listener=net.createServer();await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));const port=listener.address().port;await new Promise(resolve=>listener.close(resolve));
  const oldSettings=JSON.stringify({version:1,revision:1,enabled:true,mode:'mcp',port,connectorName:'Old connector'});
  const oldHistory='{"version":1,"items":[{"id":"retained-history"}]}\n';
  const context=await fixture(t,{seed:async dir=>{await writeFile(path.join(dir,'chatgpt-bridge-settings.json'),oldSettings);await writeFile(path.join(dir,'chatgpt-bridge.json'),oldHistory);}});
  assert.equal(await readFile(path.join(context.dataDir,'chatgpt-bridge-settings.json'),'utf8'),oldSettings);
  assert.equal(await readFile(path.join(context.dataDir,'chatgpt-bridge.json'),'utf8'),oldHistory);
  const probe=net.createServer();await new Promise((resolve,reject)=>{probe.once('error',reject);probe.listen(port,'127.0.0.1',resolve);});await new Promise(resolve=>probe.close(resolve));
  await context.app.beginMaintenance();context.app.endMaintenance();
  assert.equal(await readFile(path.join(context.dataDir,'chatgpt-bridge.json'),'utf8'),oldHistory);
});
