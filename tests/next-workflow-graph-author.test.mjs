import test from 'node:test';
import assert from 'node:assert/strict';
import {validateWorkflow} from '../lib/engine.mjs';
import {applyWorkflowStageEdits} from '../public/next/workspaces/workflow-edit-model.mjs';
import {createWorkflowGraphDraft,editWorkflowGraph,validateWorkflowGraphDraft,workflowGraphReadiness} from '../public/next/workspaces/workflow-graph-edit.mjs';

const fresh=()=>createWorkflowGraphDraft({id:'v2-graph-test',cwd:'C:\\fixture'});

test('new V2 workflow template has a valid, executable input-to-output path',()=>{
  const draft=fresh();
  assert.equal(draft.id,'v2-graph-test');
  assert.deepEqual(draft.nodes.map(n=>n.type),['input','output']);
  assert.deepEqual(draft.edges.map(e=>[e.source,e.target]),[['input','output']]);
  assert.equal(workflowGraphReadiness(draft).ready,true);
  assert.doesNotThrow(()=>validateWorkflow(draft));
});
test('adding, wiring and editing a stage produces a valid actual engine workflow',()=>{
  const start=fresh(),unchanged=structuredClone(start);
  const added=editWorkflowGraph(start,{type:'add-node',node:{id:'research',type:'agent',name:'Research',prompt:''}});
  assert.equal(added.nodes.length,3);
  assert.equal(workflowGraphReadiness(added).ready,false);
  assert.ok(workflowGraphReadiness(added).issues.some(message=>/instructions|connect/i.test(message)));
  const noDirect=editWorkflowGraph(added,{type:'disconnect',source:'input',target:'output'});
  const into=editWorkflowGraph(noDirect,{type:'connect',id:'edge-input-research',source:'input',target:'research'});
  const out=editWorkflowGraph(into,{type:'connect',id:'edge-research-output',source:'research',target:'output'});
  const named=applyWorkflowStageEdits(out,{nodes:{research:{prompt:'Find and cite primary evidence.',name:'Researcher'}}});
  assert.equal(workflowGraphReadiness(named).ready,true);
  const accepted=validateWorkflow(named);
  assert.equal(accepted.nodes.find(n=>n.id==='research').name,'Researcher');
  assert.deepEqual(accepted.edges.map(e=>[e.source,e.target]),
    [['input','research'],['research','output']]);
  assert.deepEqual(start,unchanged,'Graph operations must not mutate saved source data');
});
test('parallel branches preserve metadata and edges while removing a stage removes its incident edges',()=>{
  let w=fresh();
  w={...w,unknownProperty:{keep:true},settings:{maxParallel:4,privateOption:'kept'}};
  w=editWorkflowGraph(w,{type:'add-node',node:{id:'a',type:'agent',prompt:'A',name:'A'}});
  w=editWorkflowGraph(w,{type:'add-node',node:{id:'b',type:'agent',prompt:'B',name:'B'}});
  w=editWorkflowGraph(w,{type:'connect',id:'ab',source:'a',target:'b'});
  w=editWorkflowGraph(w,{type:'connect',id:'in-a',source:'input',target:'a'});
  w=editWorkflowGraph(w,{type:'connect',id:'b-out',source:'b',target:'output'});
  assert.equal(workflowGraphReadiness(w).ready,true);
  const clipped=editWorkflowGraph(w,{type:'remove-node',id:'a'});
  assert.equal(clipped.nodes.some(n=>n.id==='a'),false);
  assert.equal(clipped.edges.some(e=>e.source==='a'||e.target==='a'),false);
  assert.deepEqual(clipped.unknownProperty,{keep:true});
  assert.equal(clipped.settings.privateOption,'kept');
  assert.equal(workflowGraphReadiness(clipped).ready,false);
});
test('graph operations reject cycles, duplicate edges, illegal terminal links and invalid IDs',()=>{
  let w=fresh();
  w=editWorkflowGraph(w,{type:'add-node',node:{id:'a',type:'agent',name:'A',prompt:'A'}});
  w=editWorkflowGraph(w,{type:'add-node',node:{id:'b',type:'agent',name:'B',prompt:'B'}});
  w=editWorkflowGraph(w,{type:'connect',id:'in-a',source:'input',target:'a'});
  w=editWorkflowGraph(w,{type:'connect',id:'a-b',source:'a',target:'b'});
  assert.throws(()=>editWorkflowGraph(w,{type:'connect',id:'cycle',source:'b',target:'a'}),/cycle/i);
  assert.throws(()=>editWorkflowGraph(w,{type:'connect',id:'duplicate',source:'input',target:'a'}),/already connected/);
  assert.throws(()=>editWorkflowGraph(w,{type:'connect',id:'other',source:'output',target:'a'}),/Output/);
  assert.throws(()=>editWorkflowGraph(w,{type:'connect',id:'other',source:'a',target:'input'}),/Task input/);
  assert.throws(()=>editWorkflowGraph(w,{type:'connect',id:'other',source:'a',target:'a'}),/itself/);
  assert.throws(()=>editWorkflowGraph(w,{type:'connect',id:'other',source:'unknown',target:'a'}),/existing/);
  assert.throws(()=>editWorkflowGraph(w,{type:'add-node',node:{id:'a',type:'agent',prompt:'x'}}),/already/);
  assert.throws(()=>editWorkflowGraph(w,{type:'add-node',node:{id:'bad space',type:'agent',prompt:'x'}}),/ID/);
  assert.throws(()=>editWorkflowGraph(w,{type:'add-node',node:{id:'newinput',type:'input'}}),/agent, approval, or output/);
  assert.throws(()=>editWorkflowGraph(w,{type:'add-node',node:{id:'other',type:'agent',prompt:'x'.repeat(20001)}}),/20,000/);
  assert.throws(()=>editWorkflowGraph(w,{type:'disconnect',source:'a',target:'output'}),/not connected/);
  assert.throws(()=>editWorkflowGraph(w,{type:'remove-node',id:'input'}),/cannot be removed/);
  assert.throws(()=>editWorkflowGraph(w,{type:'remove-node',id:'output'}),/at least one output/);
  assert.throws(()=>editWorkflowGraph(w,{type:'unrecognized'}),/Unrecognized/);
});
test('extra output stage and approval stage remain supported and enforce output count',()=>{
  let w=fresh();
  w=editWorkflowGraph(w,{type:'add-node',node:{id:'approval',type:'approval',name:'Review'}});
  w=editWorkflowGraph(w,{type:'add-node',node:{id:'second-output',type:'output',name:'Summary'}});
  w=editWorkflowGraph(w,{type:'connect',id:'in-approval',source:'input',target:'approval'});
  w=editWorkflowGraph(w,{type:'connect',id:'approval-out',source:'approval',target:'second-output'});
  assert.equal(workflowGraphReadiness(w).ready,true);
  assert.doesNotThrow(()=>validateWorkflow(w));
  w=editWorkflowGraph(w,{type:'remove-node',id:'output'});
  assert.equal(w.nodes.filter(n=>n.type==='output').length,1);
  assert.equal(workflowGraphReadiness(w).ready,true);
});
test('a saved shared-planning coordinator cannot be silently removed',()=>{
  let w=fresh();
  w=editWorkflowGraph(w,{type:'add-node',node:{id:'leader',type:'agent',name:'Lead',prompt:'Coordinate'}});
  w={...w,planning:{shared:true,coordinatorNodeId:'leader'}};
  assert.throws(()=>editWorkflowGraph(w,{type:'remove-node',id:'leader'}),/Planning coordinator/);
});
test('a large graph can be inspected without changing source or allocating DOM',()=>{
  let w=fresh();
  const nodes=Array.from({length:1500},(_,i)=>({id:'node'+i,type:'agent',name:'Analyst '+i,prompt:'Read'}));
  const edges=[...w.edges,...Array.from({length:1499},(_,i)=>({source:'node'+i,target:'node'+(i+1)}))];
  w={...w,nodes:[...w.nodes,...nodes],edges};
  assert.ok(workflowGraphReadiness(w).issues.length);
  assert.equal(w.nodes.length,1502);
  assert.deepEqual(w.edges[0],{id:'edge-input-output',source:'input',target:'output'});
  assert.throws(()=>validateWorkflowGraphDraft({...w,edges:[...edges,{source:'input',target:'missing'}]}),/existing/);
});
