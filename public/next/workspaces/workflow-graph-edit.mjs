/** Immutable V2 workflow topology edits. All original node metadata is retained.
 * Drafts may be structurally incomplete; execution still uses the engine's
 * canonical validateWorkflow before starting any agent.
 */
const NODE_ID=/^[A-Za-z0-9_-]{1,100}$/;
const TYPES=new Set(['input','agent','approval','output']);
const ADDABLE=new Set(['agent','approval','output']);
const has=(array,id)=>array.some(node=>node?.id===id);

function requireGraph(workflow){
  if(!workflow||typeof workflow!=='object'||Array.isArray(workflow)
    ||!Array.isArray(workflow.nodes)||!Array.isArray(workflow.edges))throw Error('Choose a workflow to edit its graph.');
  return workflow;
}
function nameOf(value, fallback){
  const text=String(value??fallback).trim();
  if(!text||text.length>120)throw Error('Stage names must contain 1–120 characters.');
  return text;
}
function idOf(value,label='Stage'){
  if(typeof value!=='string'||!NODE_ID.test(value))throw Error(label+' ID must be 1–100 letters, numbers, dashes or underscores.');
  return value;
}
function adjacency(workflow){
  const outgoing=new Map(workflow.nodes.map(node=>[node.id,[]]));
  for(const edge of workflow.edges)if(outgoing.has(edge?.source)&&outgoing.has(edge?.target))outgoing.get(edge.source).push(edge.target);
  return outgoing;
}
function pathExists(workflow,start,target){
  const neighbors=adjacency(workflow),visited=new Set([start]),pending=[start];
  for(let i=0;i<pending.length;i++){
    const id=pending[i];
    if(id===target)return true;
    for(const next of neighbors.get(id)||[])if(!visited.has(next)){visited.add(next);pending.push(next);}
  }
  return false;
}

export function createWorkflowGraphDraft({id,name='New workflow',cwd=''}={}){
  idOf(id,'Workflow');
  return {id,name:String(name).slice(0,160),
    nodes:[{id:'input',type:'input',name:'Task input',x:60,y:80},
      {id:'output',type:'output',name:'Result',x:700,y:80}],
    edges:[{id:'edge-input-output',source:'input',target:'output'}],
    settings:{cwd:String(cwd),maxParallel:2},
  };
}

export function editWorkflowGraph(value,action){
  const workflow=requireGraph(value);
  if(!action||typeof action!=='object'||Array.isArray(action))throw Error('Choose a graph operation.');
  const nodes=workflow.nodes,edges=workflow.edges;
  const byId=new Map(nodes.map(node=>[node?.id,node]));
  if(byId.size!==nodes.length)throw Error('Duplicate stage IDs must be repaired in the classic workflow canvas.');
  const type=action.type;
  if(type==='add-node'){
    const node=action.node||{};
    const id=idOf(node.id);
    if(byId.has(id))throw Error('The stage ID is already in this workflow.');
    if(!ADDABLE.has(node.type))throw Error('Add an agent, approval, or output stage.');
    const name=nameOf(node.name,node.type==='agent'?'New agent':node.type==='approval'?'Approval':'Output');
    if(node.type==='agent'&&typeof node.prompt!=='string')throw Error('Agent instructions must be text.');
    if(node.type==='agent'&&node.prompt.length>20000)throw Error('Agent instructions exceed 20,000 characters.');
    const next={id,type:node.type,name,
      ...(node.type==='agent'?{model:'default',prompt:node.prompt}:{}),
      x:60+(nodes.length%4)*280,y:80+Math.floor(nodes.length/4)*180};
    return {...workflow,nodes:[...nodes,next],edges:[...edges]};
  }
  if(type==='move-node'){
    const id=idOf(action.id);
    if(!byId.has(id))throw Error('The selected stage no longer exists.');
    const {x,y}=action;
    if(!Number.isFinite(x)||!Number.isFinite(y)||x<0||y<0||x>100000||y>100000)
      throw Error('Stage placement must use finite coordinates inside the workflow canvas.');
    return {...workflow,nodes:nodes.map(node=>node.id===id
      ?{...node,x:Math.round(x),y:Math.round(y)}:node),edges:[...edges]};
  }
  if(type==='remove-node'){
    const id=idOf(action.id);
    const node=byId.get(id);
    if(!node)throw Error('The selected stage no longer exists.');
    if(node.type==='input')throw Error('The task input cannot be removed.');
    if(node.type==='output'&&nodes.filter(item=>item.type==='output').length<=1)throw Error('Keep at least one output stage.');
    if(workflow.planning?.coordinatorNodeId===id)throw Error('Change the shared Planning coordinator before removing that stage.');
    return {...workflow,nodes:nodes.filter(item=>item.id!==id),
      edges:edges.filter(edge=>edge.source!==id&&edge.target!==id)};
  }
  if(type==='connect'){
    const source=idOf(action.source,'Source stage'),target=idOf(action.target,'Destination stage');
    if(!byId.has(source)||!byId.has(target))throw Error('Choose existing source and destination stage IDs.');
    if(source===target)throw Error('A stage cannot connect to itself.');
    if(byId.get(source).type==='output')throw Error('Output stages cannot have outgoing connections.');
    if(byId.get(target).type==='input')throw Error('Task input cannot have incoming connections.');
    if(edges.some(edge=>edge.source===source&&edge.target===target))throw Error('The stages are already connected.');
    if(pathExists(workflow,target,source))throw Error('That connection would create a cycle.');
    const id=idOf(action.id,'Connection');
    if(edges.some(edge=>edge.id===id))throw Error('The connection ID already exists.');
    return {...workflow,nodes:[...nodes],edges:[...edges,{id,source,target}]};
  }
  if(type==='disconnect'){
    const source=idOf(action.source,'Source stage'),target=idOf(action.target,'Destination stage');
    if(!edges.some(edge=>edge.source===source&&edge.target===target))throw Error('Those stages are not connected.');
    return {...workflow,nodes:[...nodes],edges:edges.filter(edge=>!(edge.source===source&&edge.target===target))};
  }
  throw Error('Unrecognized workflow graph operation.');
}

/** Frontend draft bounds and structural checks; run-time readiness is separate. */
export function validateWorkflowGraphDraft(value){
  const workflow=requireGraph(value);
  if(typeof workflow.id!=='string'||!NODE_ID.test(workflow.id))throw Error('Workflow ID is not valid.');
  if(typeof workflow.name!=='string'||!workflow.name.trim()||workflow.name.length>160)throw Error('Workflow names must contain 1–160 characters.');
  if(workflow.nodes.length>10000||workflow.edges.length>50000)throw Error('The graph exceeds the frontend editing limits.');
  const ids=new Set(),byId=new Map();
  for(const node of workflow.nodes){
    idOf(node?.id);
    if(ids.has(node.id))throw Error('Duplicate stage IDs are not allowed.');
    ids.add(node.id);byId.set(node.id,node);
    if(!TYPES.has(node.type))throw Error('The workflow contains an unknown stage type.');
    nameOf(node.name,node.type);
    if(node.type==='agent'&&(typeof node.prompt!=='string'||node.prompt.length>20000))
      throw Error('Agent instructions must be text of at most 20,000 characters.');
  }
  const links=new Set();
  for(const edge of workflow.edges){
    if(!edge||!ids.has(edge.source)||!ids.has(edge.target))throw Error('Every connection must refer to existing stages.');
    const key=edge.source+':'+edge.target;
    if(links.has(key))throw Error('Duplicate connections are not allowed.');
    links.add(key);
    if(edge.source===edge.target)throw Error('A stage cannot connect to itself.');
    if(byId.get(edge.source).type==='output')throw Error('Output stages cannot have outgoing connections.');
    if(byId.get(edge.target).type==='input')throw Error('Task input cannot have incoming connections.');
  }
  return workflow;
}

export function workflowGraphReadiness(value){
  const errors=[];
  let graph;
  try{graph=validateWorkflowGraphDraft(value);}catch(error){return {ready:false,issues:[error.message]};}
  const nodes=graph.nodes,edges=graph.edges;
  if(nodes.length<2)errors.push('Use at least two stages.');
  const inputs=nodes.filter(node=>node.type==='input'),outputs=nodes.filter(node=>node.type==='output');
  if(inputs.length!==1)errors.push('Use exactly one task input.');
  if(!outputs.length)errors.push('Add an output stage.');
  if(nodes.some(node=>node.type==='agent'&&!node.prompt.trim()))errors.push('Give every agent stage instructions.');
  const incoming=new Map(nodes.map(node=>[node.id,[]]));
  const outgoing=adjacency(graph);
  for(const edge of edges)incoming.get(edge.target).push(edge.source);
  const degrees=new Map([...incoming].map(([id,sources])=>[id,sources.length]));
  const ready=[...degrees].filter(([,degree])=>degree===0).map(([id])=>id);
  let visited=0;
  for(let i=0;i<ready.length;i++){
    const id=ready[i];visited++;
    for(const target of outgoing.get(id)||[]){
      degrees.set(target,degrees.get(target)-1);
      if(degrees.get(target)===0)ready.push(target);
    }
  }
  if(visited!==nodes.length)errors.push('Remove cycles from the workflow.');
  if(inputs.length===1){
    const fromInput=new Set([inputs[0].id]),pending=[inputs[0].id];
    for(let i=0;i<pending.length;i++){
      const id=pending[i];
      for(const next of outgoing.get(id)||[])if(!fromInput.has(next)){
        fromInput.add(next);pending.push(next);
      }
    }
    if(fromInput.size!==nodes.length)errors.push('Connect every stage to the task input.');
  }
  if(outputs.length){
    const toOutput=new Set(outputs.map(node=>node.id)),pending=[...toOutput];
    for(let i=0;i<pending.length;i++){
      const id=pending[i];
      for(const next of incoming.get(id)||[])if(!toOutput.has(next)){
        toOutput.add(next);pending.push(next);
      }
    }
    if(toOutput.size!==nodes.length)errors.push('Connect every stage to an output.');
  }
  return {ready:errors.length===0,issues:errors.slice(0,5)};
}
