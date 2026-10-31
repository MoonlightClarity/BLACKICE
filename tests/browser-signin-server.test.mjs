import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHarnessServer} from '../server.mjs';

test('only an authenticated explicit POST reveals Neo; passive status and sign-in evidence never do',async t=>{
 const base=await mkdtemp(path.join(tmpdir(),'agentdesk-show-neo-'));
 let opens=0;
 class Runtime extends EventEmitter {
  async runAgent() { assert.fail('This server fixture must not execute a model.'); }
  status(){return{connected:false,authenticated:false,models:[],defaultModel:'test'};}
  async start(){return this.status();}
  async close(){}
 }
 class Desktop extends EventEmitter {
  status(){return{enabled:false,available:false};}
  async setEnabled(){return this.status();}
  async close(){}
 }
 const app=await createHarnessServer({port:0,dataDir:path.join(base,'data'),defaultCwd:path.join(base,'work'),runtime:new Runtime(),desktop:new Desktop(),autoAttachDesktop:false,showBrowserOS:async()=>{opens++;return{shown:true,focused:true,started:false}}});
 t.after(async()=>{await app.close();await rm(base,{recursive:true,force:true})});
 const root=await app.listen(),home=await fetch(root+'/');
 const cookie=home.headers.get('set-cookie')?.split(';',1)[0];
 assert.ok(cookie);
 assert.equal(opens,0);
 const status=await fetch(root+'/api/status',{headers:{cookie}});
 assert.equal(status.status,200);
 assert.equal(opens,0);
 const noCookie=await fetch(root+'/api/browseros/show',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
 assert.equal(noCookie.status,401);
 assert.equal(opens,0);
 const bad=await fetch(root+'/api/browseros/show',{method:'POST',headers:{cookie,'Content-Type':'application/json'},body:JSON.stringify({url:'https://linkedin.com'})});
 assert.equal(bad.status,400);
 assert.equal(opens,0);
 const ordinary=await fetch(root+'/api/browseros/show',{method:'GET',headers:{cookie}});
 assert.notEqual(ordinary.status,200);
 assert.equal(opens,0);
 const allowed=await fetch(root+'/api/browseros/show',{method:'POST',headers:{cookie,'Content-Type':'application/json'},body:'{}'});
 assert.equal(allowed.status,200);
 assert.equal((await allowed.json()).shown,true);
 assert.equal(opens,1);
});
