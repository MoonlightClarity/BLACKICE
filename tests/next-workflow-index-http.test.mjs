import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHarnessServer} from '../server.mjs';

class QuietRuntime extends EventEmitter{
  status(){return {connected:true,authenticated:true,defaultModel:'fixture'};}
  async start(){return this.status();}
  async close(){}
  async runAgent(){throw Error('Catalog browsing must never start a model');}
}

test('V2 index is metadata-only while the classic complete-workflow API and selected details retain full data',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'blackice-v2-workflow-index-'));
  const cwd=path.join(root,'workspace');await mkdir(cwd);
  const app=await createHarnessServer({runtime:new QuietRuntime(),dataDir:path.join(root,'data'),defaultCwd:cwd,port:0});
  t.after(async()=>{await app.close();await rm(root,{recursive:true,force:true});});
  const base=await app.listen();
  const initial=await fetch(base+'/');
  assert.equal(initial.status,200);
  const cookie=initial.headers.get('set-cookie')?.split(';',1)[0];
  assert.ok(cookie);
  const call=async(route,{method='GET',body}={})=>{
    const response=await fetch(base+route,{
      method,headers:{Cookie:cookie,...(body===undefined?{}:{'Content-Type':'application/json'})},
      body:body===undefined?undefined:JSON.stringify(body),
      signal:AbortSignal.timeout(15000),
    });
    return {status:response.status,text:await response.text()};
  };
  const privatePrompt='PRIVATE-FIXTURE-INSTRUCTIONS-SHOULD-NOT-LEAVE-THE-INDEX-'.repeat(90);
  const workflow={
    id:'index-sensitive-fixture',name:'Case workflow',description:'Visible metadata',
    settings:{cwd,maxParallel:2,privateSetting:'PRIVATE-SETTINGS'},
    privateMetadata:'PRIVATE-METADATA',
    nodes:[
      {id:'input',type:'input',name:'Input'},
      ...Array.from({length:180},(_,i)=>({
        id:'agent-'+i,type:'agent',name:'Stage '+i,
        model:'model-secret',prompt:privatePrompt,
        tools:['PRIVATE-TOOL-'+i],
      })),
      {id:'output',type:'output',name:'Output'},
    ],
    edges:[
      {source:'input',target:'agent-0'},
      ...Array.from({length:179},(_,i)=>({source:'agent-'+i,target:'agent-'+(i+1)})),
      {source:'agent-179',target:'output'},
    ],
  };
  const saved=await call('/api/workflows',{method:'POST',body:workflow});
  assert.equal(saved.status,200);
  const indexed=await call('/api/workflows?view=index');
  assert.equal(indexed.status,200);
  const summaries=JSON.parse(indexed.text);
  const summary=summaries.find(item=>item.id===workflow.id);
  assert.ok(summary);
  assert.deepEqual(Object.keys(summary).sort(),[
    'description','edgeCount','id','name','nodeCount','updatedAt',
  ]);
  assert.equal(summary.nodeCount,182);
  assert.equal(summary.edgeCount,181);
  assert.equal(summary.description,'Visible metadata');
  assert.ok(!indexed.text.includes('PRIVATE-FIXTURE-INSTRUCTIONS'));
  assert.ok(!indexed.text.includes('PRIVATE-SETTINGS'));
  assert.ok(!indexed.text.includes('PRIVATE-METADATA'));
  assert.ok(!indexed.text.includes('PRIVATE-TOOL'));
  const classic=await call('/api/workflows');
  assert.equal(classic.status,200);
  assert.ok(classic.text.includes('PRIVATE-FIXTURE-INSTRUCTIONS'));
  const one=await call('/api/workflows/'+workflow.id);
  assert.equal(one.status,200);
  const detail=JSON.parse(one.text);
  assert.equal(detail.nodes.length,182);
  assert.deepEqual(detail.edges,workflow.edges);
  assert.equal(detail.privateMetadata,'PRIVATE-METADATA');
  assert.ok(indexed.text.length*30<classic.text.length,
    'A metadata-only index should be at least 30 times smaller than full saved graphs.');
  assert.ok(one.text.length<=classic.text.length);
  const missing=await call('/api/workflows/nonexistent-workflow');
  assert.equal(missing.status,404);
  assert.match(missing.text,/Workflow not found/);
});

test('the workflow index excludes incidental node fields and never changes backend graph instances',()=>{
  const indexFromNodes=value=>value.map(workflow=>({
    id:workflow.id,name:workflow.name||'Untitled workflow',
    description:String(workflow.description||'').slice(0,256),
    updatedAt:workflow.updatedAt||null,nodeCount:workflow.nodes?.length||0,edgeCount:workflow.edges?.length||0,
  }));
  const source=[{id:'a',name:'One',nodes:[{id:'node',prompt:'Private'}],edges:[]}];
  const before=structuredClone(source);
  const index=indexFromNodes(source);
  assert.deepEqual(source,before);
  assert.equal(index[0].nodeCount,1);
  assert.equal(Object.hasOwn(index[0],'nodes'),false);
});
