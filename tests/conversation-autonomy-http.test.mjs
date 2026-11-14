import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHarnessServer} from '../server.mjs';

const graph={
  id:'autonomy-http-test',name:'Autonomy HTTP test',
  nodes:[{id:'input',type:'input',name:'Input'},{id:'agent',type:'agent',name:'Agent',model:'test-model',prompt:'Do the task.'},{id:'output',type:'output',name:'Output'}],
  edges:[{id:'a',source:'input',target:'agent'},{id:'b',source:'agent',target:'output'}],
  settings:{maxParallel:1,planningMode:'off'},
};
const until=async(check,label)=>{
  const deadline=Date.now()+7000;
  while(Date.now()<deadline){const result=await check();if(result)return result;await new Promise(resolve=>setTimeout(resolve,10));}
  assert.fail('Timed out: '+label);
};
class MockRuntime extends EventEmitter{
  constructor(){super();this.calls=[];}
  status(){return {connected:true,authenticated:true,defaultModel:'test-model',models:[
    {id:'test-model',model:'test-model',available:true},
    {id:'alternate-model',model:'alternate-model',available:true},
    {id:'premium-model',model:'premium-model',available:true},
  ]};}
  async start(){return this.status();}
  async savedThreadModel(){return 'test-model';}
  async runAgent(options){
    this.calls.push(options);
    if(this.calls.length>1){
      const idle=await options.onToolCall({name:'relay_autonomy',arguments:{
        action:'idle',summary:'The mocked operation is finished and no further work is warranted.'
      }});
      assert.equal(idle.success,true);
    }
    return {output:'Mocked output',threadId:'mock-http-thread-'+this.calls.length};
  }
  async close(){}
}
test('authenticated autonomy API persists separate calibration and begins bounded continuation without a Goal',async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'blackice-autonomy-http-'));
  const cwd=path.join(dir,'workspace');await mkdir(cwd);
  const runtime=new MockRuntime();
  const app=await createHarnessServer({runtime,port:0,dataDir:path.join(dir,'data'),defaultCwd:cwd,remoteAccess:false});
  const url=await app.listen();
  await app.learning.updateSettings({mode:'manual'});
  t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true});});
  const welcome=await fetch(url);
  const cookie=welcome.headers.get('set-cookie').split(';')[0];
  const request=async(route,payload,authenticated=true,method=payload===undefined?'GET':'POST')=>{
    const response=await fetch(url+route,{method,headers:{
      ...(authenticated?{Cookie:cookie}:{}),...(payload!==undefined?{'Content-Type':'application/json'}:{})
    },...(payload!==undefined?{body:JSON.stringify(payload)}:{})});
    const text=await response.text();let data=text;try{data=JSON.parse(text);}catch{}
    return {status:response.status,data};
  };
  const created=await request('/api/runs',{workflow:graph,input:{task:'One mocked question.',planningMode:'off'}});
  assert.equal(created.status,201,JSON.stringify(created.data));
  await until(()=>runtime.calls.length===1,'first manual provider call');
  await until(async()=>(await request('/api/runs/'+created.data.id)).data?.settled===true,'first turn settled');
  const autonomyRoute='/api/conversations/'+created.data.id+'/autonomy';
  const goalRoute='/api/conversations/'+created.data.id+'/goal';
  assert.equal((await request(autonomyRoute,undefined,false)).status,401);
  assert.equal((await request(autonomyRoute)).data.autonomy,null);
  assert.equal((await request(goalRoute)).data.goal,null);
  const enabled=await request(autonomyRoute,{action:'enable',modelAllowlist:['test-model','alternate-model'],calibration:'Use fewer costly model calls.'});
  assert.equal(enabled.status,200,JSON.stringify(enabled.data));
  assert.equal(enabled.data.autonomy.enabled,true);
  assert.deepEqual(enabled.data.autonomy.modelAllowlist,['test-model','alternate-model']);
  await until(async()=>(await request(autonomyRoute)).data?.autonomy?.status==='idle','autonomous provider turn yielded');
  assert.equal(runtime.calls.length,2);
  assert.equal((await request(goalRoute)).data.goal,null,'no synthetic Goal was created');
  const current=(await request(autonomyRoute)).data.autonomy;
  const stale=await request(autonomyRoute,{action:'calibrate',expectedRevision:current.revision-1,calibration:'stale edit'});
  assert.equal(stale.status,409);
  const disabled=await request(autonomyRoute,{action:'disable',expectedRevision:current.revision});
  assert.equal(disabled.status,200,JSON.stringify(disabled.data));
  assert.equal(disabled.data.autonomy.enabled,false);
  assert.deepEqual(disabled.data.autonomy.modelAllowlist,['test-model','alternate-model']);
  assert.equal(runtime.calls.length,2);
});
