import {
  CANVAS_NODE_WIDTH,CANVAS_NODE_HEIGHT,layoutWorkflowCanvas,workflowCanvasWindow,
  fitWorkflowCanvas,zoomWorkflowCanvas
} from './workflow-canvas-model.mjs';

const NS='http://www.w3.org/2000/svg';
const css=(tag,properties={},text='')=>{
  const node=document.createElementNS(NS,tag);
  for(const [key,value] of Object.entries(properties))node.setAttribute(key,String(value));
  if(text)node.textContent=text;
  return node;
};
const clamp=(n,min,max)=>Math.max(min,Math.min(max,n));
const compact=value=>String(value??'').length>26?String(value).slice(0,25)+'…':String(value??'');
const hitGroup=(target,attribute)=>target instanceof Element?target.closest('['+attribute+']'):null;

/** Pointer and keyboard graph surface. It neither posts to the server nor
 * changes source objects; all successful operations go through graph-author's
 * existing guarded draft mutation function.
 */
export function createWorkflowCanvas({
  mount,onMove=()=>{},onConnect=()=>{},onDisconnect=()=>{},
  onRemove=()=>{},onSelect=()=>{},canEdit=()=>true,notify=()=>{},
}={}){
  mount.innerHTML=[
    '<section class="next-graph-canvas-shell" aria-label="Interactive workflow graph">',
    '<header class="next-graph-canvas-toolbar">',
    '<strong>Visual graph</strong>',
    '<button type="button" id="next-canvas-fit">Fit stages</button>',
    '<button type="button" id="next-canvas-zoom-out" aria-label="Zoom out">−</button>',
    '<output id="next-canvas-zoom" aria-label="Canvas zoom">100%</output>',
    '<button type="button" id="next-canvas-zoom-in" aria-label="Zoom in">+</button>',
    '<button type="button" id="next-canvas-link" aria-pressed="false">Connect stages</button>',
    '<button type="button" id="next-canvas-unlink" disabled>Remove selected connection</button>',
    '<button type="button" id="next-canvas-remove-node" disabled>Remove selected stage</button>',
    '</header>',
    '<div class="next-graph-canvas-viewport">',
    '<svg id="next-workflow-canvas" role="group" tabindex="0" aria-label="Workflow stages and connections; drag a stage to move, drag background to pan, or use keyboard arrows on a stage">',
    '</svg></div>',
    '<p id="next-canvas-feedback" class="next-help" role="status"></p>',
    '</section>',
  ].join('');
  const $=id=>mount.querySelector('#'+id);
  const ui={svg:$('next-workflow-canvas'),fit:$('next-canvas-fit'),
    minus:$('next-canvas-zoom-out'),plus:$('next-canvas-zoom-in'),
    zoom:$('next-canvas-zoom'),link:$('next-canvas-link'),
    unlink:$('next-canvas-unlink'),remove:$('next-canvas-remove-node'),
    feedback:$('next-canvas-feedback')};
  let current=null,layout=null,selectedNode='',selectedEdge=null;
  let mode='select',linkFrom='',gesture=null,destroyed=false;
  let state={viewX:0,viewY:0,zoom:1,width:860,height:370},lastRenderedSource=null;
  let pendingPaint=null;
  const report=value=>{if(!destroyed)ui.feedback.textContent=String(value||'');};
  const stageById=id=>layout?.byId.get(id)||null;
  function updateControls(){
    ui.zoom.textContent=Math.round(state.zoom*100)+'%';
    ui.link.setAttribute('aria-pressed',String(mode==='connect'));
    ui.link.textContent=mode==='connect'?'Cancel linking':'Connect stages';
    ui.unlink.disabled=!selectedEdge||!canEdit();
    ui.remove.disabled=!selectedNode||!canEdit()||stageById(selectedNode)?.type==='input';
    ui.fit.disabled=!current;
    ui.minus.disabled=!current;ui.plus.disabled=!current;
    ui.link.disabled=!current||!canEdit();
  }
  function updateViewBox(){
    ui.svg.setAttribute('viewBox',[
      state.viewX,state.viewY,state.width/state.zoom,state.height/state.zoom
    ].join(' '));
  }
  function paint(){
    pendingPaint=null;
    if(destroyed)return;
    const keyboardNode=hitGroup(document.activeElement,'data-node')?.getAttribute('data-node');
    const keyboardEdge=hitGroup(document.activeElement,'data-edge-source');
    const keyboardEdgeTarget=keyboardEdge?hitGroup(document.activeElement,'data-edge-target')?.getAttribute('data-edge-target'):null;
    ui.svg.replaceChildren();
    updateControls();
    if(!current)return;
    const projection=workflowCanvasWindow(current,{layout,...state});
    updateViewBox();
    const defs=css('defs');
    const marker=css('marker',{id:'next-canvas-arrow',markerWidth:9,markerHeight:9,
      refX:8,refY:4,orient:'auto',markerUnits:'userSpaceOnUse'});
    marker.append(css('path',{d:'M 0 0 L 8 4 L 0 8 Z',fill:'currentColor'}));
    defs.append(marker);ui.svg.append(defs);
    const edgeLayer=css('g',{'class':'next-canvas-edges'});
    for(const {edge,d} of projection.edges){
      const group=css('g',{'data-edge-source':edge.source,'data-edge-target':edge.target,
        'class':'next-canvas-edge'+(selectedEdge?.source===edge.source&&selectedEdge?.target===edge.target?' is-selected':''),
        role:'button',tabindex:0,'aria-label':'Connection from '+edge.source+' to '+edge.target});
      const shape=css('path',{d,fill:'none','class':'next-canvas-edge-line','marker-end':'url(#next-canvas-arrow)'});
      const hit=css('path',{d,fill:'none','class':'next-canvas-edge-hit'});
      group.append(shape,hit);edgeLayer.append(group);
    }
    ui.svg.append(edgeLayer);
    const nodeLayer=css('g',{'class':'next-canvas-nodes'});
    for(const node of projection.nodes){
      const group=css('g',{
        'data-node':node.id,'data-x':node.canvasX,'data-y':node.canvasY,
        role:'button',tabindex:0,
        'aria-label':(node.name||node.id)+' ('+node.type+', '+node.id+')',
        'class':'next-canvas-stage'+(selectedNode===node.id?' is-selected':'')
          +(linkFrom===node.id?' is-link-source':''),
      });
      const rect=css('rect',{x:node.canvasX,y:node.canvasY,
        width:CANVAS_NODE_WIDTH,height:CANVAS_NODE_HEIGHT,rx:10,
        'class':'next-canvas-stage-box'});
      const heading=css('text',{x:node.canvasX+12,y:node.canvasY+23,
        'class':'next-canvas-stage-name'},compact(node.name||node.id));
      const type=css('text',{x:node.canvasX+12,y:node.canvasY+42,
        'class':'next-canvas-stage-type'},node.type);
      const id=css('text',{x:node.canvasX+12,y:node.canvasY+58,
        'class':'next-canvas-stage-id'},compact(node.id));
      group.append(rect,heading,type,id);nodeLayer.append(group);
    }
    ui.svg.append(nodeLayer);
    // Rerendering after arrow movement must not drop the keyboard user's focus.
    if(keyboardNode){
      const replacement=[...nodeLayer.children].find(node=>node.getAttribute('data-node')===keyboardNode);
      replacement?.focus({preventScroll:true});
    }else if(keyboardEdge){
      const replacement=[...edgeLayer.children].find(node=>node.getAttribute('data-edge-source')===keyboardEdge
        &&node.getAttribute('data-edge-target')===keyboardEdgeTarget);
      replacement?.focus({preventScroll:true});
    }
    if(projection.omittedVisibleNodes||projection.omittedEdges){
      report('Large graph: '+projection.visibleTotal+' stages intersect the view. Rendering is limited to '
        +projection.nodes.length+' stages and '+projection.edges.length+' connections. Zoom or pan for other stages.');
    }else if(mode==='connect'){
      report(linkFrom?'Select the destination stage for '+linkFrom+'.':'Choose a source stage, then its destination.');
    }else{
      report('Select a stage or connection. Drag stages to place them; drag empty space to pan.');
    }
  }
  function renderSoon(){
    if(pendingPaint!==null)return;
    pendingPaint=requestAnimationFrame(()=>paint());
  }
  function dimensions(){
    const rect=ui.svg.getBoundingClientRect();
    return {width:clamp(rect.width||860,100,4000),
      height:clamp(rect.height||370,100,3000)};
  }
  function resize(){
    const size=dimensions();
    if(size.width!==state.width||size.height!==state.height){
      state={...state,...size};renderSoon();
    }
  }
  function selection(id){
    selectedNode=id;
    selectedEdge=null;
    if(mode==='connect'){
      if(!linkFrom){linkFrom=id;renderSoon();return;}
      const source=linkFrom;
      mode='select';linkFrom='';
      if(source===id)report('Choose different stages to connect.');
      else if(!canEdit())report('Finish the active workflow action before editing connections.');
      else onConnect(source,id);
    }else{
      onSelect(id);
    }
    renderSoon();
  }
  function chooseEdge(source,target){
    selectedEdge={source,target};selectedNode='';
    mode='select';linkFrom='';
    report('Selected connection '+source+' → '+target+'.');
    renderSoon();
  }
  const resetLink=()=>{
    mode='select';linkFrom='';renderSoon();
  };
  function removeSelectedEdge(){
    if(selectedEdge&&canEdit()){
      const {source,target}=selectedEdge;
      selectedEdge=null;
      onDisconnect(source,target);renderSoon();
    }
  }
  function removeSelectedNode(){
    if(selectedNode&&canEdit()&&stageById(selectedNode)?.type!=='input'){
      const id=selectedNode;selectedNode='';
      onRemove(id);renderSoon();
    }
  }
  function pointerPoint(event){
    const rect=ui.svg.getBoundingClientRect();
    return {x:event.clientX-rect.left,y:event.clientY-rect.top};
  }
  ui.svg.addEventListener('pointerdown',event=>{
    if(event.button!==0||!current)return;
    const node=hitGroup(event.target,'data-node');
    const edge=hitGroup(event.target,'data-edge-source');
    if(edge){chooseEdge(edge.getAttribute('data-edge-source'),edge.getAttribute('data-edge-target'));return;}
    const point=pointerPoint(event);
    gesture={kind:node?'node':'pan',id:node?.getAttribute('data-node')||'',
      startX:point.x,startY:point.y,lastX:point.x,lastY:point.y,moved:false,
      startViewX:state.viewX,startViewY:state.viewY,
      startNodeX:node?stageById(node.getAttribute('data-node'))?.canvasX:0,
      startNodeY:node?stageById(node.getAttribute('data-node'))?.canvasY:0,
      group:node||null,pointerId:event.pointerId};
    ui.svg.setPointerCapture?.(event.pointerId);
    if(node)event.preventDefault();
  });
  ui.svg.addEventListener('pointermove',event=>{
    if(!gesture||gesture.pointerId!==event.pointerId)return;
    const point=pointerPoint(event),dx=point.x-gesture.startX,dy=point.y-gesture.startY;
    gesture.lastX=point.x;gesture.lastY=point.y;
    if(Math.abs(dx)>3||Math.abs(dy)>3)gesture.moved=true;
    if(gesture.kind==='pan'){
      state.viewX=gesture.startViewX-dx/state.zoom;
      state.viewY=gesture.startViewY-dy/state.zoom;
      updateViewBox(); // No full DOM rebuild during continuous panning.
    }else if(gesture.moved&&gesture.group&&canEdit()&&mode!=='connect'){
      gesture.group.setAttribute('transform','translate('+(dx/state.zoom)+' '+(dy/state.zoom)+')');
    }
  });
  function pointerEnd(event,cancelled=false){
    if(!gesture||gesture.pointerId!==event.pointerId)return;
    const previous=gesture;gesture=null;
    if(ui.svg.hasPointerCapture?.(event.pointerId))ui.svg.releasePointerCapture(event.pointerId);
    const point=pointerPoint(event);
    const dx=point.x-previous.startX,dy=point.y-previous.startY;
    if(!cancelled&&previous.kind==='node'&&previous.moved&&mode!=='connect'){
      if(canEdit()){
        const x=clamp(previous.startNodeX+dx/state.zoom,0,100000);
        const y=clamp(previous.startNodeY+dy/state.zoom,0,100000);
        selectedNode=previous.id;
        onMove(previous.id,Math.round(x),Math.round(y));
      }else report('Finish the current workflow action before moving a stage.');
    }else if(!cancelled&&previous.kind==='node'&&!previous.moved){
      selection(previous.id);
    }else if(!cancelled&&previous.kind==='pan'&&!previous.moved){
      selectedNode='';selectedEdge=null;
    }
    renderSoon();
  }
  ui.svg.addEventListener('pointerup',event=>pointerEnd(event));
  ui.svg.addEventListener('pointercancel',event=>pointerEnd(event,true));
  ui.svg.addEventListener('keydown',event=>{
    const node=hitGroup(event.target,'data-node');
    const edge=hitGroup(event.target,'data-edge-source');
    if(event.key==='Escape'){resetLink();return;}
    if(node){
      const id=node.getAttribute('data-node'),point=stageById(id);
      if(['Enter',' '].includes(event.key)){
        event.preventDefault();selection(id);return;
      }
      const vector={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]}[event.key];
      if(vector&&point&&canEdit()&&mode!=='connect'){
        event.preventDefault();
        const step=event.shiftKey?4:24;
        selectedNode=id;onMove(id,clamp(point.canvasX+vector[0]*step,0,100000),
          clamp(point.canvasY+vector[1]*step,0,100000));
      }
    }else if(edge&&['Enter',' '].includes(event.key)){
      event.preventDefault();chooseEdge(edge.getAttribute('data-edge-source'),edge.getAttribute('data-edge-target'));
    }else if(edge&&event.key==='Delete'&&canEdit()){
      event.preventDefault();
      selectedEdge={source:edge.getAttribute('data-edge-source'),
        target:edge.getAttribute('data-edge-target')};
      removeSelectedEdge();
    }
  });
  ui.svg.addEventListener('wheel',event=>{
    if(!event.ctrlKey||!current)return;
    event.preventDefault();
    const p=pointerPoint(event);
    state=zoomWorkflowCanvas(state,state.zoom*(event.deltaY<0?1.12:1/1.12),p.x,p.y);
    renderSoon();
  },{passive:false});
  ui.fit.addEventListener('click',()=>{
    if(!current)return;
    state={...state,...fitWorkflowCanvas(layout,state)};
    renderSoon();
  });
  ui.plus.addEventListener('click',()=>{state=zoomWorkflowCanvas(state,state.zoom*1.25);renderSoon();});
  ui.minus.addEventListener('click',()=>{state=zoomWorkflowCanvas(state,state.zoom/1.25);renderSoon();});
  ui.link.addEventListener('click',()=>{
    if(mode==='connect'){resetLink();return;}
    if(!canEdit())return report('Finish the current workflow action first.');
    mode='connect';linkFrom='';selectedEdge=null;renderSoon();
  });
  ui.unlink.addEventListener('click',removeSelectedEdge);
  ui.remove.addEventListener('click',removeSelectedNode);
  const observer=typeof ResizeObserver==='function'?new ResizeObserver(resize):null;
  observer?.observe(ui.svg);
  return {
    show(workflow){
      const switched=workflow?.id!==current?.id;
      const changed=workflow!==lastRenderedSource;
      current=workflow||null;
      if(switched){
        mode='select';linkFrom='';selectedNode='';selectedEdge=null;
        state={...state,viewX:0,viewY:0,zoom:1};
      }
      if(!current){layout=null;lastRenderedSource=null;renderSoon();return;}
      if(changed){layout=layoutWorkflowCanvas(current);lastRenderedSource=current;}
      if(switched||changed)renderSoon();
    },
    selectedNode:()=>selectedNode,
    getViewport:()=>({...state}),
    destroy(){
      destroyed=true;observer?.disconnect();
      if(pendingPaint!==null)cancelAnimationFrame(pendingPaint);
      mount.replaceChildren();current=null;layout=null;
    },
  };
}
