import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHarnessServer} from '../server.mjs';
import {HarnessEngine} from '../lib/engine.mjs';
const graph={nodes:[{id:'input',type:'input'},{id:'agent',type:'agent',model:'fixture',prompt:'Inspect available tools.'},{id:'output',type:'output'}],edges:[{source:'input',target:'agent'},{source:'agent',target:'output'}],settings:{planningMode:'off'}};
class Runtime extends EventEmitter{calls=[];status(){return{connected:true,authenticated:true,defaultModel:'fixture',activeTurns:0};}async start(){return this.status();}async close(){}async runAgent(options){this.calls.push(options);assert.ok(options.dynamicTools.every(t=>!t.name.startsWith('relay_swarm')));return{output:'Ordinary chat remains available.'};}}
test('retired Swarm HTTP and connector surfaces cannot read or mutate original records',async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'swarm-retired-')),runtime=new Runtime(),file=path.join(dir,'swarm-board.json');
 const bytes=JSON.stringify({version:1,revision:9,projects:[{id:'legacy',name:'Original',items:[]}]});await writeFile(file,bytes);
 const app=await createHarnessServer({runtime,port:0,dataDir:dir,defaultCwd:dir,remoteAccess:null});t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true});});
 const base=await app.listen({waitForRemote:false}),home=await fetch(base),cookie=home.headers.get('set-cookie').split(';')[0];await home.arrayBuffer();
 const request=(route,method='GET',auth=true)=>fetch(base+route,{method,headers:{...(auth?{Cookie:cookie}:{}),...(method==='POST'?{'Content-Type':'application/json'}:{})},...(method==='POST'?{body:'{}'}:{})});
 assert.equal((await request('/api/swarm','GET',false)).status,401);
 for(const [route,method]of [['/api/swarm','GET'],['/api/swarm/projects/legacy','GET'],['/api/swarm/actions','POST']]){const r=await request(route,method);assert.equal(r.status,410);await r.arrayBuffer();}
 assert.equal(app.directExecution.tools().some(t=>/swarm/.test(t.name)),false);assert.equal(app.engine.nativeSwarmTools,undefined);
 const run=app.engine.startRun({workflow:graph,input:'Inspect tools'});await app.engine.executions.get(run.id);assert.equal(app.engine.getRun(run.id).status,'completed');assert.equal(runtime.calls.length,1);
 assert.equal(await readFile(file,'utf8'),bytes);
});
test('passing a retired native Swarm provider cannot reinstall tools or dispatch it through a fresh engine',async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'swarm-engine-retired-'));let touched=0;const runtime=new Runtime();
 const provider={get catalog(){touched++;return[{name:'relay_swarm_write'}];},createHandler(){touched++;throw Error('Retired dispatcher entered');}};
 const engine=await new HarnessEngine({runtime,dataDir:dir,defaultCwd:dir,nativeSwarmTools:provider}).init();t.after(async()=>{await engine.close();await rm(dir,{recursive:true,force:true});});
 const run=engine.startRun({workflow:graph,input:'Use ordinary tools only'});await engine.executions.get(run.id);assert.equal(engine.getRun(run.id).status,'completed');assert.equal(touched,0);assert.equal(runtime.calls.length,1);
});