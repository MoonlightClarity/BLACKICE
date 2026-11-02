import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {EventEmitter} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHarnessServer} from '../server.mjs';
import {ProviderRuntime} from '../lib/providers.mjs';
import {WorkbenchConsoleControl} from '../lib/workbench-console-control.mjs';

class NoInferenceCodex extends EventEmitter{
  status(){return {connected:true,authenticated:true,defaultModel:'gpt-6.1-sol',models:[],activeTurns:0}}
  async start(){return this.status()}
  async close(){}
  async runAgent(){throw Error('No actual inference in Workbench HTTP fixtures')}
}
test('guest-only console HTTP verifies local session, input and MIME without touching real Hyper-V',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'blackice-broker-http-'));
  const runtime=await new ProviderRuntime({codex:new NoInferenceCodex(),dataDir:path.join(root,'data')}).init();
  const calls=[],control=new WorkbenchConsoleControl();
  const frame=Buffer.from([255,216,1,2,3,4,255,217]);
  const workbench={
    status:async()=>({backend:'hyper-v',vmName:'BLACKICE-Workbench',canReadGuestConsole:true,canSendGuestConsoleKeys:true,
      canTypeGuestConsoleText:true,canClickGuestConsole:true,consoleControl:control.status()}),
    takeGuestConsoleControl:()=>control.take(),
    cedeGuestConsoleControl:token=>control.cede(token),
    guestConsoleFrame:async()=>{calls.push('frame');return {bytes:frame,contentType:'image/jpeg'}},
    guestConsoleKey:(key,token)=>control.run(async()=>{
      calls.push('key:'+key);return {guest:'BLACKICE-Workbench',key,delivered:true};
    },token),
    guestConsoleType:(text,token)=>control.run(async()=>{
      calls.push('type:'+text.length);return {guest:'BLACKICE-Workbench',typed:true,characters:text.length};
    },token),
    guestConsoleClick:(x,y,button,token)=>control.run(async()=>{
      calls.push('click:'+x+':'+y+':'+button);return {guest:'BLACKICE-Workbench',clicked:true,x,y,button};
    },token)
  };
  let app;
  t.after(async()=>{try{if(app)await app.close();else await runtime.close()}finally{await rm(root,{force:true,recursive:true})}});
  app=await createHarnessServer({runtime,workbench,port:0,dataDir:path.join(root,'data'),defaultCwd:path.join(root,'workspace'),autoAttachDesktop:false});
  const endpoint=new URL(await app.listen());
  const request=(route,{method='GET',body,cookie}={})=>new Promise((resolve,reject)=>{
    const payload=body===undefined?null:JSON.stringify(body);
    const req=http.request({hostname:endpoint.hostname,port:endpoint.port,path:route,method,headers:{
      ...(cookie?{Cookie:cookie}:{}),
      ...(payload?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)}:{})
    }},res=>{
      const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('error',reject);res.on('end',()=>{
        const b=Buffer.concat(chunks);const json=String(res.headers['content-type']).includes('json');
        resolve({status:res.statusCode,headers:res.headers,body:json?JSON.parse(b.toString('utf8')):b});
      });
    });
    req.setTimeout(5000,()=>req.destroy(Error('Test HTTP request deadline')));
    req.on('error',reject);
    req.end(payload);
  });
  const home=await request('/');
  const cookie=home.headers['set-cookie']?.[0]?.split(';')[0];
  assert.ok(cookie);
  const unauthorized=await request('/api/workbench/console/key',{method:'POST',body:{key:'ENTER'}});
  assert.equal(unauthorized.status,401);
  assert.equal(calls.length,0);
  const wrong=await request('/api/workbench/console/key',{method:'POST',cookie,body:{key:'HOST_ALT_TAB'}});
  assert.equal(wrong.status,400);
  assert.equal(calls.length,0);
  const invalid=await request('/api/workbench/console/key',{method:'POST',cookie,body:{key:'ENTER',hostWindow:true}});
  assert.equal(invalid.status,400);
  assert.equal(calls.length,0);
  const accepted=await request('/api/workbench/console/key',{method:'POST',cookie,body:{key:'ENTER'}});
  assert.equal(accepted.status,200);
  assert.equal(accepted.body.delivered,true);
  const captured=await request('/api/workbench/console/frame',{cookie});
  assert.equal(captured.status,200);
  assert.equal(captured.headers['content-type'],'image/jpeg');
  assert.deepEqual(captured.body,frame);
  const unauthType=await request('/api/workbench/console/type',{method:'POST',body:{text:'guest'}});
  assert.equal(unauthType.status,401);
  const invalidText=await request('/api/workbench/console/type',{method:'POST',cookie,body:{text:'host\nnewline'}});
  assert.equal(invalidText.status,400);
  const outside=await request('/api/workbench/console/click',{method:'POST',cookie,body:{x:800,y:10,button:1}});
  assert.equal(outside.status,400);
  const extra=await request('/api/workbench/console/click',{method:'POST',cookie,body:{x:10,y:20,button:1,hostFocus:true}});
  assert.equal(extra.status,400);
  assert.deepEqual(calls,['key:ENTER','frame']);
  const typed=await request('/api/workbench/console/type',{method:'POST',cookie,body:{text:'guest only'}});
  assert.equal(typed.status,200);
  assert.equal(typed.body.characters,10);
  const clicked=await request('/api/workbench/console/click',{method:'POST',cookie,body:{x:799,y:599,button:1}});
  assert.equal(clicked.status,200);
  assert.equal(clicked.body.clicked,true);
  assert.deepEqual(calls,['key:ENTER','frame','type:10','click:799:599:1']);

  const noCookie=await request('/api/workbench/console/control',{method:'POST',body:{action:'take'}});
  assert.equal(noCookie.status,401);
  const invalidTransfer=await request('/api/workbench/console/control',{method:'POST',cookie,body:{action:'cede'}});
  assert.equal(invalidTransfer.status,400);
  const takeover=await request('/api/workbench/console/control',{method:'POST',cookie,body:{action:'take'}});
  assert.equal(takeover.status,200);
  assert.equal(takeover.body.owner,'user');
  assert.match(takeover.body.controlToken,/^[a-f0-9-]{36}$/);
  const inspect=await request('/api/workbench/console/frame',{cookie});
  assert.equal(inspect.status,200,'Inspection remains available during user control');
  assert.deepEqual(inspect.body,frame);
  const agentBlocked=await request('/api/workbench/console/key',{method:'POST',cookie,body:{key:'TAB'}});
  assert.equal(agentBlocked.status,409,'Agent input is paused while the user holds control');
  const userInput=await request('/api/workbench/console/key',{method:'POST',cookie,body:{key:'TAB',controlToken:takeover.body.controlToken}});
  assert.equal(userInput.status,200);
  assert.equal(userInput.body.delivered,true);
  const stale=await request('/api/workbench/console/click',{method:'POST',cookie,
    body:{x:30,y:20,button:1,controlToken:'00000000-0000-4000-8000-000000000001'}});
  assert.equal(stale.status,409);
  const yieldBack=await request('/api/workbench/console/control',{method:'POST',cookie,
    body:{action:'cede',controlToken:takeover.body.controlToken}});
  assert.equal(yieldBack.status,200);
  assert.equal(yieldBack.body.owner,'agent');
  assert.equal(Object.hasOwn(yieldBack.body,'controlToken'),false);
  const resumed=await request('/api/workbench/console/key',{method:'POST',cookie,body:{key:'TAB'}});
  assert.equal(resumed.status,200);
  assert.deepEqual(calls,['key:ENTER','frame','type:10','click:799:599:1','frame','key:TAB','key:TAB']);
});
