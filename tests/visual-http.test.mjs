import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHarnessServer} from '../server.mjs';
import {VISUAL_EXAMPLE} from '../public/visual-document.mjs';

test('authenticated server exposes visuals, static renderer and persisted edits without launching another model',async t=>{
 const directory=await mkdtemp(path.join(tmpdir(),'visual-http-'));let calls=0;
 class Runtime extends EventEmitter{status(){return {connected:true,authenticated:true,defaultModel:'fixture'};}async start(){return this.status();}async close(){}async runAgent(){calls++;return {output:'Fixture response',threadId:'fixture'};}}
 const app=await createHarnessServer({runtime:new Runtime(),port:0,dataDir:path.join(directory,'data'),defaultCwd:path.join(directory,'work'),remoteAccess:false});t.after(async()=>{await app.close();await rm(directory,{recursive:true,force:true});});
 const url=await app.listen(),home=await fetch(url),cookie=home.headers.get('set-cookie').split(';')[0];
 const request=async(route,body,auth=true)=>{const r=await fetch(url+route,{method:body?'POST':'GET',headers:{...(auth?{Cookie:cookie}:{}),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,data:await r.json()};};
 const run=app.engine.startRun({workflow:{id:'visual-http',name:'Fixture',nodes:[{id:'input',type:'input'},{id:'agent',type:'agent',model:'fixture',prompt:'Respond'},{id:'output',type:'output'}],edges:[{source:'input',target:'agent'},{source:'agent',target:'output'}],settings:{planningMode:'off'}},input:'Fixture',planningMode:'off'});await app.engine.executions.get(run.id);
 const route=`/api/conversations/${run.taskId||run.id}/visuals`,before=calls;assert.notEqual((await request(route,undefined,false)).status,200);
 const created=await request(route,{action:'create',requestId:'http-create',document:VISUAL_EXAMPLE});assert.equal(created.status,200,JSON.stringify(created.data));
 const read=await request(route+'?artifactId='+created.data.id);assert.equal(read.data.revision,1);assert.equal(calls,before);assert.equal((await request(route,{action:'revise',requestId:'stale',artifactId:created.data.id,expectedRevision:0,document:VISUAL_EXAMPLE})).status,409);
 for(const file of ['/visual-document.mjs','/visual-paint.mjs','/visual-layout.mjs','/visual-label-layout.mjs','/visual-edits.mjs','/svg-preview.mjs','/next/chat/visuals.mjs']){const r=await fetch(url+file,{headers:{Cookie:cookie}});assert.equal(r.status,200,file);assert.match(await r.text(),/export/);}
 const css=await fetch(url+'/next/visuals.css',{headers:{Cookie:cookie}});assert.equal(css.status,200);assert.match(await css.text(),/visual-editor/);
 assert.equal(calls,before);
});
