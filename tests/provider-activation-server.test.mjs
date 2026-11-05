import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {Readable,Writable} from 'node:stream';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHarnessServer} from '../server.mjs';

class Runtime extends EventEmitter{
  constructor(){super();this.calls=[];}
  status(){return{connected:false,authenticated:false,activeTurns:0,models:[],defaultModel:'saved-native-model'};}
  async start(){return this.status();}
  async close(){}
  async runAgent(){assert.fail('Enabling a connection must not start a model.');}
  async enableProvider(id,options){this.calls.push({id,options});return{id,enabled:true,configured:true};}
}
class ResponseCapture extends Writable{
  constructor(){super();this.headers={};this.parts=[];this.statusCode=200;}
  setHeader(name,value){this.headers[name.toLowerCase()]=value;}
  writeHead(status,headers={}){this.statusCode=status;for(const [name,value]of Object.entries(headers))this.setHeader(name,value);this.headersSent=true;}
  _write(part,_encoding,done){this.parts.push(Buffer.from(part));done();}
}
async function fixture(t){
  const directory=await mkdtemp(path.join(tmpdir(),'blackice-enable-provider-api-')),runtime=new Runtime();
  const desktop=new EventEmitter();desktop.status=()=>({available:false,enabled:false});desktop.setEnabled=async()=>desktop.status();
  const app=await createHarnessServer({port:0,runtime,desktop,dataDir:path.join(directory,'data'),defaultCwd:path.join(directory,'workspace'),remoteAccess:false,autoAttachDesktop:false,emailExecutableHint:null});
  t.after(async()=>{app.endRestart();app.endMaintenance();await app.close();await rm(directory,{recursive:true,force:true});});
  const handler=app.server.listeners('request')[0];let cookie;
  const request=async(url,{body,headers={},authenticated=true,method=body===undefined?'GET':'POST'}={})=>{
    const raw=body===undefined?undefined:JSON.stringify(body),req=Readable.from(raw===undefined?[]:[Buffer.from(raw)]);
    req.url=url;req.method=method;req.headers={host:'127.0.0.1:0',...(authenticated&&cookie?{cookie}:{}),...(raw===undefined?{}:{'content-type':'application/json','content-length':String(Buffer.byteLength(raw))}),...headers};
    const res=new ResponseCapture();await handler(req,res);const text=Buffer.concat(res.parts).toString();
    return{status:res.statusCode,data:res.headers['content-type']?.includes('application/json')?JSON.parse(text):text,headers:res.headers};
  };
  const home=await request('/');cookie=home.headers['set-cookie'].split(';')[0];
  return{runtime,request,app};
}

test('enable-only route uses the normal authenticated owner session and origin checks',async t=>{
  const {runtime,request}=await fixture(t),url='/api/providers/optional_router/enable',body={expectedUpdatedAt:'2026-10-01T00:00:00.000Z'};
  assert.equal((await request(url,{body,authenticated:false})).status,401);
  assert.equal((await request(url,{body,headers:{origin:'https://untrusted.invalid'}})).status,403);
  assert.deepEqual(runtime.calls,[]);
  const result=await request(url,{body});assert.equal(result.status,200);assert.equal(result.data.enabled,true);
  assert.deepEqual(runtime.calls,[{id:'optional_router',options:body}]);
  assert.equal(runtime.status().defaultModel,'saved-native-model');
});

test('enable-only route rejects missing revisions and unrelated settings instead of saving them',async t=>{
  const {runtime,request}=await fixture(t),url='/api/providers/optional_router/enable';
  for(const body of [{},{expectedUpdatedAt:null},{expectedUpdatedAt:''},{expectedUpdatedAt:'2026-10-01T00:00:00.000Z',apiKey:'fixture-not-accepted'},{expectedUpdatedAt:'2026-10-01T00:00:00.000Z',enabled:false}]){
    assert.equal((await request(url,{body})).status,400);
  }
  assert.deepEqual(runtime.calls,[]);
});

test('Settings and chat module dependency graphs are served over real HTTP, including optional API activation',async t=>{
  const {app}=await fixture(t),base=await app.listen();
  const pending=['/next/workspaces/settings.mjs','/next/chat/chat.mjs','/next/core/model-picker.mjs'],seen=new Set();
  while(pending.length){
    const route=pending.shift();if(seen.has(route))continue;seen.add(route);
    assert.ok(seen.size<160,'The frontend module graph is bounded.');
    const response=await fetch(new URL(route,base));
    assert.equal(response.status,200,route+' must be served, not only present on disk.');
    assert.match(response.headers.get('content-type')||'',/javascript/,route+' must have a JavaScript MIME type.');
    const source=await response.text();
    const imports=[...source.matchAll(/\b(?:import|export)\s+(?:[^'";]*?\s+from\s*)?['"]([^'"]+)['"]/g),...source.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)];
    for(const match of imports){
      const specifier=match[1];
      if(!/^(?:\.{1,2}\/|\/)/.test(specifier))continue;
      const dependency=new URL(specifier,new URL(route,base));
      assert.equal(dependency.origin,new URL(base).origin);
      if(/\.(?:mjs|js)$/.test(dependency.pathname))pending.push(dependency.pathname);
    }
  }
  assert.ok(seen.has('/provider-availability.mjs'),'The real Settings/chat imports reach the new activation helper.');
  assert.ok(seen.has('/next/workspaces/settings-providers.mjs'));
  const head=await fetch(new URL('/provider-availability.mjs',base),{method:'HEAD'});
  assert.equal(head.status,200);assert.equal(await head.text(),'');
  assert.equal((await fetch(new URL('/server.mjs',base))).status,404,'Internal source stays outside the static allowlist.');
});
