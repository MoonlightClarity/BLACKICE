import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { CodexRuntime } from '../lib/codex.mjs';

function harness(t, failures = []) {
  let spawns=0; const requests=[], children=[];
  const runtime=new CodexRuntime({command:'fixture',nativeModelMetadata:false,requestTimeoutMs:1000,
    spawnImpl(){
      const attempt=spawns++, child=new EventEmitter();
      child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();child.killed=false;
      child.kill=()=>{child.killed=true;queueMicrotask(()=>child.emit('exit',0,null));};
      let input='';
      child.stdin.on('data',data=>{
        input+=data; let end;
        while((end=input.indexOf('\n'))>=0){
          const row=JSON.parse(input.slice(0,end));input=input.slice(end+1);requests.push(row.method);
          if(!row.id)continue;
          let result;
          if(row.method==='initialize')result={userAgent:'codex/1.0.0'};
          else if(row.method==='account/read')result={account:{type:'chatgpt',planType:'test'}};
          else if(row.method==='model/list'){
            if(failures[attempt]){child.stdout.write(JSON.stringify({id:row.id,error:failures[attempt]})+'\n');continue;}
            result={data:[{id:'fixture',model:'fixture',isDefault:true}],nextCursor:null};
          }else throw Error('Unexpected request '+row.method);
          child.stdout.write(JSON.stringify({id:row.id,result})+'\n');
        }
      });
      children.push(child);return child;
    }});
  t.after(()=>runtime.close());
  return{runtime,requests,children,get spawns(){return spawns;}};
}
const transient={code:-32603,message:'workspace routing discovery failed'};
test('transient discovery retries one handshake and concurrent callers share it; no turn starts',async t=>{
 const h=harness(t,[transient]); const states=[];h.runtime.on('status',s=>states.push(s));
 const results=await Promise.all([h.runtime.start(),h.runtime.start()]);
 assert.equal(h.spawns,2);assert.ok(results.every(s=>s.connected&&s.authenticated));
 assert.equal(h.children[0].killed,true);assert.ok(states.some(s=>s.connection.recovery?.attempt===2));
 assert.equal(h.requests.filter(x=>x==='initialize').length,2);
 assert.ok(!h.requests.some(x=>/^(thread|turn)\//.test(x)));
 assert.equal(h.runtime.status().lastError,null);
});
test('persistent transient startup stops after three attempts and leaves exact failure visible',async t=>{
 const h=harness(t,[transient,transient,transient,transient]);
 await assert.rejects(h.runtime.start(),/workspace routing discovery failed/);
 assert.equal(h.spawns,3);assert.equal(h.runtime.status().connected,false);
 assert.equal(h.runtime.status().lastError,transient.message);assert.equal(h.runtime.startPromise,null);
});
for(const failure of [
 {code:'CODEX_UNAUTHENTICATED',message:'Sign in required'},
 {code:-32603,message:'workspace routing discovery failed: permission denied'},
 {code:-32603,message:'invalid account token'},
 {code:-32602,message:'Unsupported model/list'},
 {code:-32603,message:'arbitrary internal failure'},
])test('does not retry nontransient failure '+failure.message,async t=>{
 const h=harness(t,[failure]);await assert.rejects(h.runtime.start(),new RegExp(failure.message));
 assert.equal(h.spawns,1);
});
test('close during recovery backoff prevents another child and settles shared callers',async t=>{
 const h=harness(t,[transient]);const work=h.runtime.start();work.catch(()=>{});
 await new Promise(resolve=>h.runtime.on('status',s=>{if(s.connection.recovery)resolve();}));
 await h.runtime.close();await assert.rejects(work,e=>e.code==='CODEX_CLOSED');
 assert.equal(h.spawns,1);assert.equal(h.runtime.startRecoveryController,null);
});
test('healthy connection refresh failure does not reconnect or replay active work',async t=>{
 const h=harness(t);await h.runtime.start();h.runtime._catalog=async()=>{throw Object.assign(Error(transient.message),{code:-32603});};
 await assert.rejects(h.runtime.start({refresh:true}),/workspace routing discovery failed/);
 assert.equal(h.spawns,1);
});
test('uncertain active/opening work forbids retry after a failed handshake',async t=>{
 const h=harness(t,[transient]);h.runtime.openingThreads.add('uncertain');
 await assert.rejects(h.runtime.start(),/workspace routing discovery failed/);assert.equal(h.spawns,1);
});
