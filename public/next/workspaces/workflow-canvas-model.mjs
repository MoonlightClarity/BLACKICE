/** Deterministic read-only canvas geometry for BLACKICE workflows.
 * Large DAGs are laid out in memory, but only viewport-visible elements are
 * passed to the SVG renderer. Saving a viewport never rewrites stored nodes.
 */
export const CANVAS_NODE_WIDTH=176;
export const CANVAS_NODE_HEIGHT=70;
const COL_STEP=228,ROW_STEP=118;
const finite=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=100000;
const safeNumber=(value,fallback)=>Number.isFinite(value)?value:fallback;
const numberWithin=(value,defaultValue,min,max)=>Math.min(max,Math.max(min,safeNumber(value,defaultValue)));

export function layoutWorkflowCanvas(workflow){
  const source=Array.isArray(workflow?.nodes)?workflow.nodes:[];
  const occupied=new Map(),resolved=new Map();
  const bucket=(x,y)=>[Math.floor(x/COL_STEP),Math.floor(y/ROW_STEP)];
  const conflicts=(x,y)=>{
    const [bx,by]=bucket(x,y);
    for(let yy=by-1;yy<=by+1;yy++)for(let xx=bx-1;xx<=bx+1;xx++){
      for(const item of occupied.get(xx+':'+yy)||[]){
        if(Math.abs(item.x-x)<CANVAS_NODE_WIDTH+10&&Math.abs(item.y-y)<CANVAS_NODE_HEIGHT+8)return true;
      }
    }
    return false;
  };
  const reserve=(x,y,id)=>{
    const [bx,by]=bucket(x,y),key=bx+':'+by;
    if(!occupied.has(key))occupied.set(key,[]);
    occupied.get(key).push({x,y,id});
    resolved.set(id,{x,y});
  };
  // Reserve all useful saved placements first. The remaining nodes are given
  // stable display-only positions without mutating their persisted x/y.
  for(const node of source){
    if(!node||typeof node.id!=='string'||resolved.has(node.id))continue;
    if(finite(node.x)&&finite(node.y)&&!conflicts(node.x,node.y))
      reserve(node.x,node.y,node.id);
  }
  for(let i=0;i<source.length;i++){
    const node=source[i];
    if(!node||typeof node.id!=='string'||resolved.has(node.id))continue;
    let slot=i;
    while(slot<i+source.length+16){
      const x=48+slot%4*COL_STEP,y=70+Math.floor(slot/4)*ROW_STEP;
      if(!conflicts(x,y)){reserve(x,y,node.id);break;}
      slot++;
    }
    if(!resolved.has(node.id))reserve(48+i%4*COL_STEP,70+Math.floor(i/4)*ROW_STEP,node.id);
  }
  const nodes=source.filter(node=>node&&typeof node.id==='string').map(node=>{
    const point=resolved.get(node.id);
    return {...node,canvasX:point.x,canvasY:point.y};
  });
  const byId=new Map(nodes.map(node=>[node.id,node]));
  const minX=nodes.length?Math.min(...nodes.map(node=>node.canvasX)):0;
  const minY=nodes.length?Math.min(...nodes.map(node=>node.canvasY)):0;
  const maxX=nodes.length?Math.max(...nodes.map(node=>node.canvasX+CANVAS_NODE_WIDTH)):CANVAS_NODE_WIDTH;
  const maxY=nodes.length?Math.max(...nodes.map(node=>node.canvasY+CANVAS_NODE_HEIGHT)):CANVAS_NODE_HEIGHT;
  return {nodes,byId,bounds:{minX,minY,maxX,maxY,width:maxX-minX,height:maxY-minY}};
}

export function canvasEdgePath(source,target){
  const x1=source.canvasX+CANVAS_NODE_WIDTH,y1=source.canvasY+CANVAS_NODE_HEIGHT/2;
  const x2=target.canvasX,y2=target.canvasY+CANVAS_NODE_HEIGHT/2;
  const curve=Math.max(35,Math.abs(x2-x1)*0.42);
  return 'M '+x1+' '+y1+' C '+(x1+curve)+' '+y1+', '+(x2-curve)+' '+y2+', '+x2+' '+y2;
}

export function workflowCanvasWindow(workflow,{
  viewX=0,viewY=0,width=860,height=390,zoom=1,nodeLimit=120,edgeLimit=220,layout,
}={}){
  const stage=layout||layoutWorkflowCanvas(workflow);
  const scale=numberWithin(zoom,1,0.008,4);
  const worldW=numberWithin(width,860,100,4000)/scale;
  const worldH=numberWithin(height,390,100,3000)/scale;
  const x=safeNumber(viewX,0),y=safeNumber(viewY,0),margin=20;
  const visible=stage.nodes.filter(node=>
    node.canvasX+CANVAS_NODE_WIDTH>=x-margin&&node.canvasX<=x+worldW+margin
    &&node.canvasY+CANVAS_NODE_HEIGHT>=y-margin&&node.canvasY<=y+worldH+margin);
  const nodes=visible.slice(0,numberWithin(nodeLimit,120,1,200));
  const visibleIds=new Set(nodes.map(node=>node.id));
  const allEdges=Array.isArray(workflow?.edges)?workflow.edges:[];
  const candidates=allEdges.filter(edge=>edge&&stage.byId.has(edge.source)&&stage.byId.has(edge.target)
    &&(visibleIds.has(edge.source)||visibleIds.has(edge.target)));
  const edges=candidates.slice(0,numberWithin(edgeLimit,220,1,300)).map((edge,index)=>{
    const src=stage.byId.get(edge.source),dest=stage.byId.get(edge.target);
    return {edge,source:src,target:dest,key:edge.id||edge.source+':'+edge.target+':'+index,
      d:canvasEdgePath(src,dest)};
  });
  return {nodes,edges,visibleTotal:visible.length,totalNodes:stage.nodes.length,
    totalEdges:allEdges.length,omittedVisibleNodes:visible.length-nodes.length,
    omittedEdges:candidates.length-edges.length,world:{x,y,width:worldW,height:worldH},
    layout:stage};
}

export function fitWorkflowCanvas(layout,{width=860,height=390,padding=34}={}){
  const {minX,minY,maxX,maxY}=layout?.bounds||{minX:0,minY:0,maxX:CANVAS_NODE_WIDTH,maxY:CANVAS_NODE_HEIGHT};
  const w=Math.max(100,width),h=Math.max(100,height);
  const zoom=Math.min(2.5,Math.max(.008,Math.min(
    (w-padding*2)/Math.max(1,maxX-minX),(h-padding*2)/Math.max(1,maxY-minY))));
  return {zoom,viewX:(minX+maxX)/2-w/(zoom*2),viewY:(minY+maxY)/2-h/(zoom*2)};
}

export function zoomWorkflowCanvas(state,nextZoom,anchorX,anchorY){
  const previous=numberWithin(state.zoom,1,.008,4);
  const zoom=numberWithin(nextZoom,previous,.008,4);
  const x=safeNumber(anchorX,state.width/2),y=safeNumber(anchorY,state.height/2);
  return {...state,zoom,
    viewX:state.viewX+x/previous-x/zoom,
    viewY:state.viewY+y/previous-y/zoom};
}
