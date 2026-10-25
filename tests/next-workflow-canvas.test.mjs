import test from 'node:test';
import assert from 'node:assert/strict';
import {layoutWorkflowCanvas,workflowCanvasWindow,fitWorkflowCanvas,
  zoomWorkflowCanvas,canvasEdgePath,CANVAS_NODE_WIDTH,CANVAS_NODE_HEIGHT
} from '../public/next/workspaces/workflow-canvas-model.mjs';
import {editWorkflowGraph,workflowGraphReadiness} from '../public/next/workspaces/workflow-graph-edit.mjs';

const fixture=()=>({
  id:'canvas-graph',name:'Graph canvas',settings:{maxParallel:2,unknownSetting:true},
  nodes:[
    {id:'input',type:'input',name:'Evidence',x:20,y:35},
    {id:'analyst',type:'agent',name:'Source analyst',prompt:'Research and cite.',x:300,y:100,other:{keep:true}},
    {id:'reviewer',type:'agent',name:'Reviewer',prompt:'Cross-check.',x:300,y:100},
    {id:'output',type:'output',name:'Report',x:640,y:100},
  ],
  edges:[
    {id:'a',source:'input',target:'analyst'},
    {id:'b',source:'analyst',target:'reviewer'},
    {id:'c',source:'reviewer',target:'output'},
  ],
  unknownData:{persist:'yes'},
});

test('canvas collision handling is deterministic, source coordinates and metadata are never mutated',()=>{
  const original=fixture(),before=structuredClone(original);
  const one=layoutWorkflowCanvas(original),two=layoutWorkflowCanvas(original);
  assert.deepEqual(one.nodes.map(n=>[n.id,n.canvasX,n.canvasY]),two.nodes.map(n=>[n.id,n.canvasX,n.canvasY]));
  assert.deepEqual([one.byId.get('input').canvasX,one.byId.get('input').canvasY],[20,35]);
  assert.deepEqual([one.byId.get('analyst').canvasX,one.byId.get('analyst').canvasY],[300,100]);
  assert.notDeepEqual([one.byId.get('reviewer').canvasX,one.byId.get('reviewer').canvasY],[300,100],
    'Colliding saved node positions must not visually overlap.');
  assert.ok(one.bounds.maxX>one.bounds.minX);
  assert.ok(one.bounds.maxY>one.bounds.minY);
  assert.deepEqual(original,before);
  assert.equal(one.byId.get('analyst').other.keep,true);
});

test('visible canvas projection is bounded and responds to pan and zoom on 1,500-stage workflows',()=>{
  const nodes=Array.from({length:1500},(_,i)=>({
    id:'stage-'+i,name:'Stage '+i,type:i===0?'input':i===1499?'output':'agent',
    prompt:'Read',x:0,y:0,
  }));
  const edges=Array.from({length:1499},(_,i)=>({source:'stage-'+i,target:'stage-'+(i+1)}));
  const graph={id:'large',nodes,edges};
  const layout=layoutWorkflowCanvas(graph);
  assert.equal(layout.nodes.length,1500);
  assert.ok(layout.bounds.height>2000,'Overlapping legacy coordinates must be distributed across the canvas.');
  const first=workflowCanvasWindow(graph,{layout,width:780,height:365,zoom:1});
  assert.ok(first.nodes.length<=120);
  assert.ok(first.edges.length<=220);
  assert.ok(first.visibleTotal>0);
  assert.equal(first.totalNodes,1500);
  assert.equal(first.totalEdges,1499);
  const last=layout.byId.get('stage-1499');
  const deep=workflowCanvasWindow(graph,{layout,viewX:last.canvasX-25,viewY:last.canvasY-25,width:780,height:365,zoom:1});
  assert.ok(deep.nodes.some(node=>node.id==='stage-1499'),
    'Panning must reach nodes not rendered in the initial viewport.');
  assert.ok(deep.nodes.length<=120);
  const all=workflowCanvasWindow(graph,{layout,viewX:0,viewY:0,width:780,height:365,zoom:.008});
  assert.ok(all.nodes.length<=120,'Even fitting an entire huge graph cannot mount all nodes.');
  assert.ok(all.edges.length<=220);
  const after=layout.byId.get('stage-1499');
  assert.deepEqual(after,last);
  assert.equal(nodes[1499].x,0);
});

test('connection paths and viewport zoom transformations use finite positions',()=>{
  const layout=layoutWorkflowCanvas(fixture());
  const source=layout.byId.get('input'),target=layout.byId.get('analyst');
  const path=canvasEdgePath(source,target);
  assert.match(path,/^M \d+ \d+ C /);
  assert.ok(!path.includes('NaN'));
  assert.equal(CANVAS_NODE_WIDTH,176);
  assert.equal(CANVAS_NODE_HEIGHT,70);
  const frame=fitWorkflowCanvas(layout,{width:860,height:365});
  assert.ok(frame.zoom>0);
  const baseline={viewX:20,viewY:30,width:860,height:365,zoom:1};
  const next=zoomWorkflowCanvas(baseline,1.5,100,120);
  assert.equal(next.zoom,1.5);
  assert.equal(next.viewX+100/next.zoom,baseline.viewX+100/baseline.zoom);
  assert.equal(next.viewY+120/next.zoom,baseline.viewY+120/baseline.zoom);
  const min=zoomWorkflowCanvas(baseline,-20,100,120);
  assert.ok(min.zoom>=.008);
  const max=zoomWorkflowCanvas(baseline,200,100,120);
  assert.equal(max.zoom,4);
});

test('stage drag operations are immutable, precise and preserve all graph identities',()=>{
  const original=fixture(),snapshot=structuredClone(original);
  const moved=editWorkflowGraph(original,{type:'move-node',id:'analyst',x:492.6,y:212.3});
  assert.deepEqual([moved.nodes[1].x,moved.nodes[1].y],[493,212]);
  assert.deepEqual(moved.edges,original.edges);
  assert.deepEqual(moved.settings,original.settings);
  assert.deepEqual(moved.unknownData,original.unknownData);
  assert.deepEqual(moved.nodes[1].other,{keep:true});
  assert.deepEqual(original,snapshot);
  assert.equal(workflowGraphReadiness(moved).ready,true);
  for(const action of [{id:'missing',x:3,y:4},{id:'analyst',x:Infinity,y:5},
    {id:'analyst',x:NaN,y:10},{id:'analyst',x:-1,y:0},{id:'analyst',x:1e12,y:0}]){
    assert.throws(()=>editWorkflowGraph(original,{type:'move-node',...action}));
  }
});

test('empty and malformed saved graphs do not crash the bounded canvas',()=>{
  const empty=layoutWorkflowCanvas(null);
  assert.equal(empty.nodes.length,0);
  assert.equal(workflowCanvasWindow(null,{layout:empty}).nodes.length,0);
  const malformed=layoutWorkflowCanvas({nodes:[
    {id:'bad',name:'Bad',x:Infinity,y:NaN},{id:'good',x:0,y:0},
  ]});
  assert.ok(Number.isFinite(malformed.byId.get('bad').canvasX));
  assert.ok(Number.isFinite(malformed.byId.get('good').canvasY));
});
