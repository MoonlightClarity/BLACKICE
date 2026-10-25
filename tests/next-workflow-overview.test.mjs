import test from 'node:test';
import assert from 'node:assert/strict';
import {workflowOverview,workflowStageIndex,workflowCatalogWindow} from '../public/next/workspaces/workflow-overview-model.mjs';

test('large workflow projections bound initial DOM while keeping all source graph metadata',()=>{
  const original={
    id:'deep-graph',
    nodes:Array.from({length:6000},(_,i)=>({id:'stage-'+i,name:'Stage '+i,type:i===0?'input':'agent',metadata:{original:i}})),
    edges:Array.from({length:5999},(_,i)=>({id:'edge-'+i,source:'stage-'+i,target:'stage-'+(i+1)})),
    settings:{maxParallel:4},
  };
  const before=JSON.stringify(original);
  const first=workflowOverview(original);
  assert.equal(first.totalStages,6000);
  assert.equal(first.totalConnections,5999);
  assert.equal(first.stages.length,80);
  assert.equal(first.connections.length,120);
  assert.equal(first.hiddenStages,5920);
  assert.equal(first.hiddenConnections,5879);
  assert.equal(first.connections[0].sourceName,'Stage 0');
  assert.equal(first.connections.at(-1).targetName,'Stage 120');
  const expanded=workflowOverview(original,{nodeLimit:160,edgeLimit:240});
  assert.equal(expanded.stages.length,160);
  assert.equal(expanded.connections.length,240);
  assert.equal(expanded.hiddenStages,5840);
  assert.equal(JSON.stringify(original),before,'Projection must never rewrite source nodes, edges or metadata.');
});

test('partial, malformed and dangling connection data are represented without throwing',()=>{
  assert.deepEqual(workflowOverview(null).stages,[]);
  assert.equal(workflowOverview({nodes:[],edges:[]}).hiddenConnections,0);
  const result=workflowOverview({
    nodes:[{id:'input',type:'input',name:'Evidence'}],
    edges:[{id:'missing',source:'input',target:'removed'},null],
  });
  assert.equal(result.connections.length,2);
  assert.equal(result.connections[0].broken,true);
  assert.equal(result.connections[0].sourceName,'Evidence');
  assert.equal(result.connections[0].targetName,'removed');
  assert.equal(result.connections[1].broken,true);
  assert.equal(result.connections[1].sourceName,'Unknown stage');
});

test('saved workflow catalog windows 20,000 records and searches unseen workflow names',()=>{
  const items=Array.from({length:20000},(_,index)=>({
    id:'stored-'+index,name:index===19001?'Needle deep workflow':'Workflow '+index,
    description:'Saved executable or draft workflow',
    nodes:[{id:'input',type:'input'},{id:'output',type:'output'}],
    edges:[],
  }));
  const first=workflowCatalogWindow(items);
  assert.equal(first.shown.length,80);
  assert.equal(first.hidden,19920);
  assert.equal(first.total,20000);
  assert.equal(first.pinned,null);
  const found=workflowCatalogWindow(items,{query:'needle'});
  assert.deepEqual(found.shown.map(x=>x.id),['stored-19001']);
  assert.equal(found.hidden,0);
  const deep=workflowCatalogWindow(items,{selected:'stored-19001'});
  assert.equal(deep.shown.length,80);
  assert.equal(deep.pinned.id,'stored-19001');
  assert.equal(deep.shown.some(x=>x.id==='stored-19001'),false);
  assert.equal(workflowCatalogWindow(items,{limit:160}).shown.length,160);
  assert.equal(workflowCatalogWindow(items,{query:'absent'}).shown.length,0);
  assert.equal(items[19001].name,'Needle deep workflow','Indexing cannot mutate stored metadata');
});

test('stage selection is searchable and paged without mounting thousands of option nodes',()=>{
  const workflow={nodes:Array.from({length:6000},(_,i)=>({id:'stage-'+i,name:'Stage '+i,type:i===5998?'agent':'step'}))};
  const first=workflowStageIndex(workflow);
  assert.equal(first.shown.length,80);
  assert.equal(first.hidden,5920);
  assert.equal(first.pinned,null);
  const pinned=workflowStageIndex(workflow,{selected:'stage-5998'});
  assert.equal(pinned.shown.length,80);
  assert.equal(pinned.pinned.id,'stage-5998','Keep a selected deep stage reachable.');
  assert.equal(pinned.shown.some(item=>item.id==='stage-5998'),false);
  const filtered=workflowStageIndex(workflow,{query:'Stage 5998'});
  assert.equal(filtered.total,1);
  assert.equal(filtered.shown[0].id,'stage-5998');
  assert.equal(filtered.hidden,0);
  assert.equal(workflowStageIndex(workflow,{query:'nonexistent'}).shown.length,0);
  assert.equal(workflowStageIndex(workflow,{limit:160}).shown.length,160);
  assert.equal(workflow.nodes.length,6000,'Indexing must not alter canonical workflow data.');
});

test('render limits are applied to read-only UI projection without cutting backend data',()=>{
  const graph={nodes:[{id:'a',name:'A'},{id:'b',name:'B'}],edges:[{source:'a',target:'b'}]};
  const result=workflowOverview(graph,{nodeLimit:1,edgeLimit:1});
  assert.equal(result.stages.length,1);
  assert.equal(result.hiddenStages,1);
  assert.equal(result.connections.length,1);
  assert.equal(result.connections[0].broken,false);
  assert.equal(graph.nodes.length,2);
});
