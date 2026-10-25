import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHarnessServer} from '../server.mjs';
import {validateWorkflow} from '../lib/engine.mjs';
import {createWorkflowGraphDraft,editWorkflowGraph,validateWorkflowGraphDraft,workflowGraphReadiness} from '../public/next/workspaces/workflow-graph-edit.mjs';

class QuietRuntime extends EventEmitter {
  status(){return {connected:true,authenticated:true,models:[{model:'fixture-model'}],defaultModel:'fixture-model'};}
  async start(){return this.status();}
  async close(){}
  async runAgent(){throw Error('Graph authoring must not launch an agent in a test.');}
}

test('native V2 graph authoring persists new complete DAGs through the real BLACKICE local API',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'blackice-v2-graph-author-http-'));
  const cwd=path.join(root,'workspace');await mkdir(cwd);
  const app=await createHarnessServer({port:0,dataDir:path.join(root,'data'),defaultCwd:cwd,
    runtime:new QuietRuntime(),autoAttachDesktop:false});
  t.after(async()=>{await app.close();await rm(root,{recursive:true,force:true});});
  const origin=await app.listen();
  const first=await fetch(origin+'/');
  assert.equal(first.status,200);
  const cookie=first.headers.get('set-cookie')?.split(';',1)[0];
  assert.ok(cookie);
  let writes=0;
  const request=async(route,{method='GET',body}={})=>{
    if(method==='POST')writes++;
    const response=await fetch(origin+route,{method,headers:{Cookie:cookie,...(body===undefined?{}:{'Content-Type':'application/json'})},
      body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
    return {status:response.status,body:await response.json()};
  };
  const empty=await request('/api/workflows');
  assert.equal(empty.status,200);
  const original=createWorkflowGraphDraft({id:'native-author-test',cwd});
  assert.equal(original.nodes.length,2);
  let updated=editWorkflowGraph(original,{type:'add-node',node:{id:'research',type:'agent',name:'Research',prompt:'Find cited evidence.'}});
  assert.equal(workflowGraphReadiness(updated).ready,false,'An unconnected agent cannot run.');
  assert.throws(()=>validateWorkflow(updated),/Connect every node|Every node must lead/);
  assert.equal(writes,0,'Graph editing must not issue HTTP writes.');
  const draft=await request('/api/workflows',{method:'POST',body:updated});
  assert.equal(draft.status,200,'The real engine must allow a saved incomplete draft.');
  assert.equal(writes,1);
  assert.equal(draft.body.nodes.length,3);
  updated=editWorkflowGraph(draft.body,{type:'disconnect',source:'input',target:'output'});
  updated=editWorkflowGraph(updated,{type:'connect',id:'in-research',source:'input',target:'research'});
  updated=editWorkflowGraph(updated,{type:'connect',id:'research-out',source:'research',target:'output'});
  assert.equal(workflowGraphReadiness(updated).ready,true);
  assert.doesNotThrow(()=>validateWorkflow(updated));
  const persisted=await request('/api/workflows',{method:'POST',body:validateWorkflowGraphDraft(updated)});
  assert.equal(persisted.status,200);
  assert.equal(writes,2);
  const retrieved=await request('/api/workflows/native-author-test');
  assert.equal(retrieved.status,200);
  assert.deepEqual(retrieved.body.nodes.map(n=>n.id),['input','output','research']);
  assert.deepEqual(retrieved.body.edges.map(e=>[e.source,e.target]),[['input','research'],['research','output']]);
  assert.equal(retrieved.body.nodes[2].prompt,'Find cited evidence.');
  assert.deepEqual(retrieved.body.settings,{cwd,maxParallel:2});
  assert.equal(workflowGraphReadiness(retrieved.body).ready,true);
  // Edits operate on clones; the author cannot replay or modify a running run.
  const changed=editWorkflowGraph(retrieved.body,{type:'remove-node',id:'research'});
  assert.equal(changed.nodes.length,2);
  assert.equal(changed.edges.length,0);
  assert.equal(retrieved.body.nodes.length,3);
  assert.equal((await request('/api/workflows/native-author-test')).body.nodes.length,3);
  assert.equal(writes,2);
});
