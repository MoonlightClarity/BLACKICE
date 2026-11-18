import test from 'node:test';import assert from 'node:assert/strict';import{EventEmitter}from'node:events';import{mkdtemp,rm}from'node:fs/promises';import{tmpdir}from'node:os';import path from'node:path';import{createHarnessServer}from'../server.mjs';
class Runtime extends EventEmitter{status(){return{connected:true,authenticated:true,models:[]};}async start(){return this.status();}async close(){}async runAgent(){throw Error('Model execution forbidden in static asset fixture');}}
test('production server serves Browser in-use module through authenticated shell session',async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'blackice-usage-http-'));const server=await createHarnessServer({runtime:new Runtime(),dataDir:dir,defaultCwd:dir,port:0});t.after(async()=>{await server.close();await rm(dir,{recursive:true,force:true});});const base=await server.listen();
 const shell=await fetch(base+'/');assert.equal(shell.status,200);const cookies=shell.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');
 const response=await fetch(base+'/next/workspaces/browser-usage-ui.mjs',{headers:{Cookie:cookies}});assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/javascript/);assert.match(await response.text(),/createBrowserUsageControls/);
});
