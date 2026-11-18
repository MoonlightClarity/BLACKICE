import test from 'node:test';import assert from 'node:assert/strict';import{EventEmitter}from'node:events';import{mkdtemp,rm}from'node:fs/promises';import{tmpdir}from'node:os';import path from'node:path';import{createHarnessServer}from'../server.mjs';
class Runtime extends EventEmitter{status(){return{connected:true,authenticated:true,models:[]};}async start(){return this.status();}async close(){}async runAgent(){throw Error('Human edit must not start a model.');}}
test('authenticated local human skill edit persists through HTTP restart; remote, stale and unauthenticated writes rejected',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'skill-edit-http-'));let app,base,cookie;
 const open=async()=>{app=await createHarnessServer({runtime:new Runtime(),dataDir:root,defaultCwd:root,port:0,remoteAccess:false});base=await app.listen();cookie=(await fetch(base)).headers.get('set-cookie').split(';')[0];};await open();t.after(async()=>{await app.close();await rm(root,{recursive:true,force:true});});
 const request=(method,payload,headers={Cookie:cookie})=>fetch(new URL('/api/skills/builtin-browser',base),{method,headers:{...headers,'Content-Type':'application/json'},...(payload?{body:JSON.stringify(payload)}:{})});
 const original=await(await request('GET')).json();assert.equal(original.userEditable,true);
 const edit={expectedRevision:original.revision,title:'Human edited browser',summary:'A human summary',appliesWhen:'Browsing',scope:'Browser',content:'# Custom browser\nHuman content\n'};
 assert.equal((await request('POST',edit,{})).status,401);
 assert.equal((await request('POST',edit,{Cookie:cookie,'x-blackice-remote':'1'})).status,403);
 const response=await request('POST',edit);assert.equal(response.status,200);const saved=await response.json();assert.equal(saved.content,edit.content);assert.equal(saved.source,'user');
 assert.equal((await request('POST',edit)).status,409);
 assert.equal((await request('POST',{...edit,expectedRevision:saved.revision,content:''})).status,400);
 await app.close();await open();assert.deepEqual(await(await request('GET')).json(),saved);
});
