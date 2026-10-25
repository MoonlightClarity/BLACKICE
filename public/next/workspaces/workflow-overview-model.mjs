/** Catalog presentation is bounded independently of the saved workflow array.
 * Search always covers the complete in-memory catalog, and deep selections stay
 * visible even when they fall outside the current batch.
 */
export function workflowCatalogWindow(workflows,{query='',limit=80,selected=''}={}){
  const entries=Array.isArray(workflows)?workflows:[];
  const needle=String(query||'').trim().toLocaleLowerCase();
  const matches=needle?entries.filter(item=>(
    String(item?.name||'')+' '+String(item?.description||'')+' '+String(item?.id||'')
  ).toLocaleLowerCase().includes(needle)):entries;
  const count=Number.isFinite(limit)?Math.max(1,Math.floor(limit)):80;
  const shown=matches.slice(0,count);
  const pinned=selected&&!shown.some(item=>item?.id===selected)
    ?entries.find(item=>item?.id===selected)||null:null;
  return {shown,pinned,hidden:Math.max(0,matches.length-shown.length),total:matches.length};
}

/** Search every saved stage while exposing only a bounded set of option nodes.
 * The selected deep stage stays reachable even when it is outside the batch.
 */
export function workflowStageIndex(workflow,{query='',limit=80,selected=''}={}){
  const nodes=(Array.isArray(workflow?.nodes)?workflow.nodes:[])
    .filter(node=>node&&typeof node.id==='string');
  const needle=String(query||'').trim().toLocaleLowerCase();
  const matches=needle?nodes.filter(node=>
    (String(node.name||'')+' '+node.id+' '+String(node.type||'')).toLocaleLowerCase().includes(needle)):nodes;
  const count=Number.isFinite(limit)?Math.max(1,Math.floor(limit)):80;
  const shown=matches.slice(0,count);
  const pinned=selected&&!shown.some(node=>node.id===selected)
    ?matches.slice(shown.length).find(node=>node.id===selected)||null:null;
  return {shown,pinned,hidden:matches.length-shown.length,total:matches.length};
}

/** Read-only, bounded projection of a saved workflow graph.
 * The backend source remains canonical; projection never edits node or edge IDs.
 */
export function workflowOverview(workflow, {nodeLimit=80,edgeLimit=120}={}) {
  const nodes=Array.isArray(workflow?.nodes)?workflow.nodes:[];
  const edges=Array.isArray(workflow?.edges)?workflow.edges:[];
  const windowSize=(value,fallback)=>Number.isFinite(value)?Math.min(nodes.length+edges.length+1,Math.max(1,Math.floor(value))):fallback;
  const shownNodes=nodes.slice(0,windowSize(nodeLimit,80));
  const shownEdges=edges.slice(0,windowSize(edgeLimit,120));
  const byId=new Map(nodes.filter(node=>node&&typeof node.id==='string').map(node=>[node.id,node]));
  const nameOf=id=>{
    const node=byId.get(id);
    return String(node?.name||node?.id||id||'Unknown stage');
  };
  const connections=shownEdges.map((edge,index)=>({
    key:typeof edge?.id==='string'?edge.id:'connection-'+index,
    sourceId:edge?.source||'',
    targetId:edge?.target||'',
    sourceName:nameOf(edge?.source),
    targetName:nameOf(edge?.target),
    broken:!byId.has(edge?.source)||!byId.has(edge?.target),
  }));
  return {
    stages:shownNodes,totalStages:nodes.length,hiddenStages:nodes.length-shownNodes.length,
    connections,totalConnections:edges.length,hiddenConnections:edges.length-shownEdges.length,
  };
}
