import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {EventEmitter} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHarnessServer} from '../server.mjs';
import {ProviderRuntime} from '../lib/providers.mjs';
import {WindowsWorkbench} from '../lib/windows-workbench.mjs';

class NoInferenceCodex extends EventEmitter{
  status(){return {connected:true,authenticated:true,defaultModel:'gpt-6.1-sol',models:[],activeTurns:0}}
  async start(){return this.status()}async close(){}async runAgent(){throw Error('No inference in native HTTP fixtures.')}
}

test('native BMP/input HTTP requires local session, actual native bounds and agent ownership while preserving legacy bounds',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'blackice-native-http-'));
  const runtime=await new ProviderRuntime({codex:new NoInferenceCodex(),dataDir:path.join(root,'data')}).init();
  const workbench=new WindowsWorkbench({dataDir:path.join(root,'data'),probe:async()=>{throw Error('No live host operations.');},consoleController:{}});
  const width=1024,height=768,bytes=Buffer.alloc(54+width*height*4),inputs=[],wakes=[];
  bytes.write('BM');bytes.writeUInt32LE(bytes.length,2);bytes.writeUInt32LE(54,10);bytes.writeUInt32LE(40,14);bytes.writeInt32LE(width,18);bytes.writeInt32LE(-height,22);bytes.writeUInt16LE(1,26);bytes.writeUInt16LE(32,28);
  await workbench.setGuestNativeConsoleAdapter({frame:async()=>({bytes,width,height,sequence:7,contentType:'image/bmp'}),surface:async()=>({width,height}),input:async(value,assertCurrent)=>{assertCurrent();inputs.push(value);return {queued:true};},wake:async(value,assertCurrent)=>{assertCurrent();wakes.push(value);return {queued:true};}});
  let app;t.after(async()=>{try{if(app)await app.close();else await runtime.close();}finally{await rm(root,{recursive:true,force:true});}});
  app=await createHarnessServer({runtime,workbench,port:0,dataDir:path.join(root,'data'),defaultCwd:path.join(root,'workspace'),autoAttachDesktop:false,enableWorkbenchVideo:false});
  const endpoint=new URL(await app.listen());
  const request=(route,{method='GET',body,cookie}={})=>new Promise((resolve,reject)=>{
    const payload=body===undefined?null:JSON.stringify(body);
    const req=http.request({hostname:endpoint.hostname,port:endpoint.port,path:route,method,headers:{...(cookie?{Cookie:cookie}:{}),...(payload?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)}:{})}},res=>{
      const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('error',reject);res.on('end',()=>{const data=Buffer.concat(chunks);resolve({status:res.statusCode,headers:res.headers,body:String(res.headers['content-type']).includes('json')?JSON.parse(data):data});});
    });req.setTimeout(5000,()=>req.destroy(Error('Native HTTP test deadline')));req.on('error',reject);req.end(payload);
  });
  assert.equal((await request('/api/workbench/native/frame')).status,401);
  assert.equal((await request('/api/workbench/native/input',{method:'POST',body:{kind:'mouse',x:20,y:20,flags:0x0800}})).status,401);
  assert.equal((await request('/api/workbench/native/wake',{method:'POST',body:{}})).status,401);
  const home=await request('/'),cookie=home.headers['set-cookie'][0].split(';')[0];
  for(const body of [null,[],{x:1},{owner:'agent'},{controlToken:1},{controlToken:null}])
    assert.equal((await request('/api/workbench/native/wake',{method:'POST',cookie,body})).status,400);
  const agentWake=await request('/api/workbench/native/wake',{method:'POST',cookie,body:{}});
  assert.equal(agentWake.status,200);assert.deepEqual(agentWake.body,{queued:true,consoleControl:{owner:'agent',revision:0}});
  const frame=await request('/api/workbench/native/frame',{cookie});
  assert.equal(frame.status,200);assert.equal(frame.headers['content-type'],'image/bmp');assert.equal(frame.headers['x-workbench-width'],'1024');assert.equal(frame.headers['x-workbench-height'],'768');assert.equal(frame.headers['x-workbench-sequence'],'7');assert.deepEqual(frame.body,bytes);
  assert.equal((await request('/api/workbench/native/input',{method:'POST',cookie,body:{kind:'mouse',x:900,y:700,flags:0x0800}})).status,200);
  assert.equal((await request('/api/workbench/native/input',{method:'POST',cookie,body:{kind:'mouse',x:1024,y:700,flags:0x0800}})).status,400);
  assert.equal((await request('/api/workbench/native/input',{method:'POST',cookie,body:{kind:'key',scanCode:30,flags:0,hostInput:true}})).status,400);
  assert.equal((await request('/api/workbench/console/click',{method:'POST',cookie,body:{x:800,y:20,button:1}})).status,400,'The existing 800x600 legacy endpoint remains unchanged.');
  const receipt=await workbench.takeGuestConsoleControl();
  assert.equal((await request('/api/workbench/native/wake',{method:'POST',cookie,body:{}})).status,409);
  const userWake=await request('/api/workbench/native/wake',{method:'POST',cookie,body:{controlToken:receipt.controlToken}});
  assert.equal(userWake.status,200);assert.deepEqual(userWake.body,{queued:true,consoleControl:{owner:'user',revision:receipt.revision}});
  assert.equal((await request('/api/workbench/native/frame',{cookie})).status,200);
  assert.equal((await request('/api/workbench/native/input',{method:'POST',cookie,body:{kind:'key',scanCode:30,flags:0}})).status,409);
  assert.equal((await request('/api/workbench/native/input',{method:'POST',cookie,body:{kind:'key',scanCode:30,flags:0,controlToken:receipt.controlToken}})).status,400);
  await workbench.cedeGuestConsoleControl(receipt.controlToken);
  assert.equal((await request('/api/workbench/native/wake',{method:'POST',cookie,body:{controlToken:receipt.controlToken}})).status,409);
  assert.equal((await request('/api/workbench/native/input',{method:'POST',cookie,body:{kind:'key',scanCode:30,flags:0x8000}})).status,200);
  await workbench.setGuestNativeConsoleAdapter(null);
  assert.equal((await request('/api/workbench/native/frame',{cookie})).status,503);
  assert.equal((await request('/api/workbench/native/input',{method:'POST',cookie,body:{kind:'key',scanCode:30,flags:0}})).status,503);
  assert.equal((await request('/api/workbench/native/wake',{method:'POST',cookie,body:{}})).status,503);
  assert.equal(inputs.length,2);
  assert.deepEqual(wakes,[{owner:'agent'},{owner:'user'}]);
});
