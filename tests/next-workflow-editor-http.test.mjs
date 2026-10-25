import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHarnessServer} from '../server.mjs';
import {applyWorkflowStageEdits,workflowSnapshot} from '../public/next/workspaces/workflow-edit-model.mjs';

class QuietRuntime extends EventEmitter {
  status(){return {connected:true,authenticated:true,models:[{model:'fixture-model'}],defaultModel:'fixture-model'};}
  async start(){return this.status();}
  async close(){}
  async runAgent(){throw Error('Editing workflow drafts must never start an agent.');}
}

test('V2 workflow edit preserves native saved graph and metadata through the actual BLACKICE HTTP API',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'blackice-v2-workflow-edit-http-'));
  const cwd=path.join(root,'workspace');
  await mkdir(cwd);
  const app=await createHarnessServer({
    port:0,dataDir:path.join(root,'data'),defaultCwd:cwd,
    runtime:new QuietRuntime(),autoAttachDesktop:false,
  });
  t.after(async()=>{await app.close();await rm(root,{recursive:true,force:true});});
  const origin=await app.listen();
  const launch=await fetch(origin+'/');
  assert.equal(launch.status,200);
  const cookie=launch.headers.get('set-cookie')?.split(';',1)[0];
  assert.ok(cookie);
  let writes=0;
  async function request(route,{method='GET',body}={}){
    if(method==='POST')writes++;
    const response=await fetch(origin+route,{
      method,headers:{Cookie:cookie,...(body===undefined?{}:{'Content-Type':'application/json'})},
      body:body===undefined?undefined:JSON.stringify(body),
      signal:AbortSignal.timeout(15000),
    });
    return {status:response.status,body:await response.json()};
  }
  const source={
    id:'v2-editor-verified',name:'Original assessment',description:'Keep the workflow editable',
    nodes:[
      {id:'input',type:'input',name:'Evidence'},
      {id:'first',type:'agent',name:'Researcher',prompt:'Find primary sources.',model:'default',settings:{sample:true}},
      {id:'second',type:'agent',name:'Reviewer',prompt:'Compare independent evidence.',model:'default',tools:['audit']},
      {id:'output',type:'output',name:'Report'},
    ],
    edges:[
      {id:'edge-a',source:'input',target:'first'},
      {id:'edge-b',source:'input',target:'second'},
      {id:'edge-c',source:'first',target:'output'},
      {id:'edge-d',source:'second',target:'output'},
    ],
    settings:{cwd,maxParallel:2,planningMode:'auto'},
    unknownMetadata:{keep:'even after editing'},
  };
  const firstSave=await request('/api/workflows',{method:'POST',body:source});
  assert.equal(firstSave.status,200);
  assert.equal(firstSave.body.id,source.id);
  const list=await request('/api/workflows');
  assert.equal(list.status,200);
  const original=list.body.find(row=>row.id===source.id);
  assert.ok(original);
  const edited=applyWorkflowStageEdits(original,{name:'Revised assessment',nodes:{
    first:{name:'Lead investigator',prompt:'Find sources and cite the evidence.',
      model:'fixture-model',effort:'medium',serviceTier:'default',
      context:{preset:'custom',windowTokens:131072,autoCompact:false}},
    second:{name:'Independent reviewer',prompt:'Challenge the lead findings.'}
  },workflowSettings:{maxParallel:3,planningMode:'on',planDetail:'detailed'}});
  assert.equal(writes,1,'Constructing or previewing a workflow edit cannot issue an HTTP write.');
  const posted=await request('/api/workflows',{method:'POST',body:edited});
  assert.equal(posted.status,200);
  assert.equal(posted.body.name,'Revised assessment');
  const read=await request('/api/workflows/'+source.id);
  assert.equal(read.status,200);
  assert.equal(read.body.name,'Revised assessment');
  assert.deepEqual(read.body.nodes.map(row=>row.id),source.nodes.map(row=>row.id));
  assert.deepEqual(read.body.edges,source.edges);
  assert.deepEqual(read.body.settings,{...source.settings,maxParallel:3,planningMode:'on',planDetail:'detailed'});
  assert.deepEqual(read.body.unknownMetadata,source.unknownMetadata);
  assert.equal(read.body.nodes[1].prompt,'Find sources and cite the evidence.');
  assert.equal(read.body.nodes[1].model,'fixture-model');
  assert.equal(read.body.nodes[1].effort,'medium');
  assert.equal(read.body.nodes[1].serviceTier,'default');
  assert.deepEqual(read.body.nodes[1].context,{preset:'custom',windowTokens:131072,autoCompact:false});
  assert.equal(read.body.nodes[1].settings.sample,true);
  assert.deepEqual(read.body.nodes[2].tools,['audit']);
  assert.equal(writes,2,'Exactly one save is submitted for the explicit user edit.');
  const unlisted=await fetch(origin+'/next/workspaces/missing-edit-source.mjs');
  assert.equal(unlisted.status,404);
  for(const route of ['/next/workspaces/workflow-editor.mjs','/next/workspaces/workflow-edit-model.mjs']){
    const asset=await fetch(origin+route);
    assert.equal(asset.status,200);
    assert.match(asset.headers.get('content-type')||'',/javascript/);
  }
  // A second writer changes the stored graph while the first editor has a
  // previous snapshot. The UI must see a different snapshot and refuse to POST.
  const outside={...read.body,edges:[...read.body.edges,{id:'external-edge',source:'input',target:'output'}]};
  assert.equal((await request('/api/workflows',{method:'POST',body:outside})).status,200);
  const newer=(await request('/api/workflows')).body.find(row=>row.id===source.id);
  assert.notEqual(workflowSnapshot(read.body),workflowSnapshot(newer));
  assert.deepEqual(newer.edges,outside.edges);
  assert.equal(writes,3,'Only explicit fixture writers persisted changes.');
});
