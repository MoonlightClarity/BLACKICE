import { text, stableId } from '../core/dom.mjs';
import { createConversationReader } from '../chat/reader-client.mjs';
import { createWorkflowEditor } from './workflow-editor.mjs';
import { workflowOverview,workflowCatalogWindow } from './workflow-overview-model.mjs';
import { createWorkflowGraphAuthor } from './workflow-graph-author.mjs';
import { workflowGraphReadiness } from './workflow-graph-edit.mjs';
import { workflowSnapshot } from './workflow-edit-model.mjs';
import { layoutWorkflowCanvas,canvasEdgePath,CANVAS_NODE_WIDTH,CANVAS_NODE_HEIGHT } from './workflow-canvas-model.mjs';

/** Workflow inspection and explicit execution. This never loads /api/runs,
 * and saved histories are decoded in the same worker used by Chat.
 */
export function createWorkflowActivityUI({mount,api,events,notify=()=>{},getStatus,onNavigate}={}){
  mount.innerHTML=[
    '<div class="next-workflow-catalog">',
    '<label class="next-label">Find workflow<input type="search" class="next-field next-workflow-search" id="next-workflow-search" placeholder="Search saved workflows"></label>',
    '<label class="next-label">Workflow<select class="next-field next-workflow-select" id="next-workflow-choice"></select></label>',
    '<div class="next-workflow-catalog-actions"><button type="button" id="next-workflow-new">New workflow</button><button type="button" id="next-workflow-refresh">Refresh workflows</button></div>',
    '<button type="button" id="next-workflow-more" hidden>Show more workflows</button></div>',
    '<section class="next-workflow-focus" aria-labelledby="next-workflow-focus-heading">',
    '<header class="next-workflow-focus-header"><div><p id="next-workflow-focus-kind" class="next-plan-eyebrow">Saved workflow</p><h3 id="next-workflow-focus-heading">Select a workflow</h3><p id="next-workflow-focus-meta" class="next-help"></p></div>',
    '<div class="next-row next-workflow-run-controls"><span id="next-workflow-focus-status" class="next-status-pill" hidden></span><button type="button" id="next-workflow-stop" hidden>Stop selected run</button>',
    '<button type="button" id="next-workflow-open-chat" hidden>Open in Chat</button><details id="next-workflow-run-actions" class="next-workflow-run-actions" hidden><summary>Run actions</summary><div class="next-row">',
    '<button type="button" id="next-workflow-template" hidden>View template</button><button type="button" id="next-workflow-refresh-run" hidden>Refresh run</button><button type="button" id="next-workflow-retry" hidden>Retry failed run</button></div></details></div></header>',
    '<div class="next-workflow-map-toolbar next-row"><button type="button" id="next-workflow-map-fit" aria-pressed="true">Fit width</button><button type="button" id="next-workflow-map-actual" aria-pressed="false">Actual size</button><span id="next-workflow-map-count" class="next-help"></span><button id="next-workflow-map-more" type="button" hidden>Show more stages</button></div>',
    '<div class="next-workflow-visual"><div class="next-workflow-map-viewport"><svg id="next-workflow-map" preserveAspectRatio="xMinYMin meet" role="group" aria-label="Read-only workflow map"></svg></div>',
    '<aside id="next-workflow-stage-inspector" class="next-workflow-stage-inspector" aria-label="Selected stage" tabindex="0"></aside></div>',
    '<p class="next-help next-workflow-map-hint">Select a stage to see its instructions and recorded status. Selecting never starts or changes work.</p>',
    '<section id="next-workflow-run-details" class="next-workflow-run-details" aria-label="Selected run"></section></section>',
    '<p class="next-help" role="status" id="next-workflow-feedback"></p>',
    '<details id="next-workflow-launch" class="next-workflow-disclosure"><summary>Run this workflow</summary>',
    '<form id="next-workflow-form" class="next-stack">',
    '<label class="next-label">Task instructions<textarea class="next-field" id="next-workflow-prompt" rows="3" maxlength="20000" required placeholder="What should the workflow accomplish?"></textarea></label>',
    '<label class="next-label">Working folder<input class="next-field" id="next-workflow-cwd" required placeholder="Working folder"></label>',
    '<div class="next-row"><button class="next-primary" type="submit" id="next-workflow-start">Run workflow</button></div></form></details>',
    '<details id="next-workflow-run-lookup" class="next-workflow-disclosure"><summary>Inspect a saved run</summary>',
    '<label class="next-label">Saved run ID<input class="next-field" id="next-workflow-run-id" placeholder="Saved run ID"></label><button type="button" id="next-workflow-inspect">Inspect run</button></details>',
    '<details id="next-workflow-structure" class="next-workflow-disclosure"><summary>Stage and connection list</summary>',
    '<div id="next-workflow-outline" class="next-workflow-nodes" role="list"></div>',
    '<button id="next-workflow-more-stages" type="button" class="next-workflow-more" hidden>Show more stages</button>',
    '<section id="next-workflow-connections" class="next-workflow-connections" aria-label="Workflow connections"></section>',
    '<button id="next-workflow-more-connections" type="button" class="next-workflow-more" hidden>Show more connections</button></details>',
    '<section id="next-workflow-editor-host" aria-label="Edit selected workflow"></section>',
    '<section id="next-workflow-graph-host" aria-label="Edit workflow connections"></section>',
    '<details class="next-workflow-disclosure" id="next-workflow-remove"><summary>Delete selected workflow</summary>',
    '<p>Deletes this saved template permanently. Saved runs and schedules keep their own copies. Save or discard your workflow edits first.</p><button type="button" id="next-workflow-delete">Delete workflow permanently</button></details>',
    '<button id="next-workflow-run-more" type="button" hidden>Show more run stages</button>',
  ].join('');
  const $=id=>mount.querySelector('#'+id);
  const ui={choice:$('next-workflow-choice'),search:$('next-workflow-search'),more:$('next-workflow-more'),
    runMore:$('next-workflow-run-more'),outline:$('next-workflow-outline'),
    connections:$('next-workflow-connections'),moreStages:$('next-workflow-more-stages'),moreConnections:$('next-workflow-more-connections'),
    prompt:$('next-workflow-prompt'),cwd:$('next-workflow-cwd'),
    start:$('next-workflow-start'),inspect:$('next-workflow-inspect'),
    stop:$('next-workflow-stop'),retry:$('next-workflow-retry'),
    openChat:$('next-workflow-open-chat'),runId:$('next-workflow-run-id'),
    feedback:$('next-workflow-feedback'),details:$('next-workflow-run-details'),
    refresh:$('next-workflow-refresh'),createNew:$('next-workflow-new'),form:$('next-workflow-form'),remove:$('next-workflow-remove'),delete:$('next-workflow-delete')};
  const reader=createConversationReader({api});
  let active=false,busy=false,workflows=[],run=null,revision=0,readController=null,unsubscribe=null,timer=null;
  let catalogEpoch=0,deletionController=null,focusStageId='',focusGraphId='',fitMap=true,mapBounds=null;
  const mapUI={svg:$('next-workflow-map'),inspector:$('next-workflow-stage-inspector'),heading:$('next-workflow-focus-heading'),kind:$('next-workflow-focus-kind'),meta:$('next-workflow-focus-meta'),status:$('next-workflow-focus-status'),count:$('next-workflow-map-count')};
  const loadingFull=new Map();
  let overviewId='',visibleStages=80,visibleConnections=120;
  let catalogLimit=80,catalogQuery='',catalogTimer=null,runDisplayId='',visibleRunStages=80;
  const selected=()=>workflows.find(item=>item.id===ui.choice.value);
  let graphAuthor=null;
  const editor=createWorkflowEditor({mount:$('next-workflow-editor-host'),api,
    getBusy:()=>busy||Boolean(graphAuthor?.hasDraft()),notify,
    onSaved:updated=>{
      workflows=workflows.map(item=>item.id===updated.id?updated:item);
      const option=[...ui.choice.options].find(row=>row.value===updated.id);
      if(option)option.textContent=updated.name||updated.id;
      paintWorkflow();
    }});
  function paintChoices(preferred=ui.choice.value){
    if(ui.search.value!==catalogQuery){
      catalogQuery=ui.search.value;catalogLimit=80;
      if(catalogQuery.trim())preferred='';
    }
    const {shown,pinned,hidden}=workflowCatalogWindow(workflows,{
      query:catalogQuery,limit:catalogLimit,selected:preferred,
    });
    ui.choice.replaceChildren();
    const items=pinned?[pinned,...shown]:shown;
    for(const workflow of items){
      const option=ui.choice.ownerDocument.createElement('option');
      option.value=workflow.id;option.textContent=workflow.name||workflow.id;
      ui.choice.append(option);
    }
    if(!items.length){
      const option=ui.choice.ownerDocument.createElement('option');
      option.value='';option.textContent='No matching workflows';ui.choice.append(option);
    }
    ui.choice.value=items.some(item=>item.id===preferred)?preferred:items[0]?.id||'';
    ui.more.hidden=!hidden;
    ui.more.textContent=hidden?'Show '+Math.min(80,hidden)+' more workflows ('+hidden+' remaining)':'';
  }
  const updateChoice=workflow=>paintChoices(workflow.id);
  function ensureFullWorkflow(id){
    if(!active||!id||loadingFull.has(id))return;
    const epoch=catalogEpoch,controller=new AbortController();
    loadingFull.set(id,controller);
    void api('/api/workflows/'+encodeURIComponent(id),'GET',undefined,{signal:controller.signal})
      .then(full=>{
        if(!active||epoch!==catalogEpoch||!Array.isArray(full?.nodes)||!Array.isArray(full?.edges))return;
        const index=workflows.findIndex(item=>item.id===id);
        if(index<0)return;
        workflows[index]=full;
        if(ui.choice.value===id)paintWorkflow();
      })
      .catch(error=>{
        if(!controller.signal.aborted&&active&&epoch===catalogEpoch&&ui.choice.value===id)
          report('Could not load the selected workflow: '+error.message,true);
      })
      .finally(()=>{if(loadingFull.get(id)===controller)loadingFull.delete(id);});
  }
  graphAuthor=createWorkflowGraphAuthor({
    mount:$('next-workflow-graph-host'),api,notify,
    getBusy:()=>busy||editor.isSaving()||editor.hasDraft(),
    getCwd:()=>ui.cwd.value||getStatus?.()?.cwd||'',
    getSelectedStageId:()=>editor.selectedStageId(),
    onSelectStage:id=>editor.selectStage(id),
    onCreated:workflow=>{
      workflows.unshift(workflow);updateChoice(workflow);
      run=null;paintWorkflow();paintRun();
    },
    onDiscardNew:id=>{
      workflows=workflows.filter(item=>item.id!==id);
      paintChoices(workflows[0]?.id||'');
      paintWorkflow();
    },
    onSaved:workflow=>{
      const at=workflows.findIndex(item=>item.id===workflow.id);
      if(at<0)workflows.unshift(workflow);else workflows[at]=workflow;
      updateChoice(workflow);paintWorkflow();
    },
    onPreview:()=>paintWorkflow(),
  });
  const report=(message,err=false)=>{ui.feedback.textContent=String(message||'');if(err)notify(message,true);};
  const svgNode=(tag,attributes={},value='')=>{
    const node=mount.ownerDocument.createElementNS('http://www.w3.org/2000/svg',tag);
    for(const [key,item] of Object.entries(attributes))node.setAttribute(key,String(item));
    if(value)node.textContent=value;
    return node;
  };
  const compactLabel=value=>String(value||'').length>25?String(value).slice(0,24)+'…':String(value||'');
  function sizeMap(){
    if(!mapBounds)return;
    const width=mapBounds.width+60,height=mapBounds.height+70;
    const availableWidth=mapUI.svg.parentElement.clientWidth||700;
    // Large maps stay readable and scroll inside the viewport. Fit width never
    // turns a bounded 80-stage map into tiny, unselectable text.
    const scale=fitMap?Math.max(.9,Math.min(1,availableWidth/width)):1;
    mapUI.svg.setAttribute('width',String(Math.max(220,width*scale)));
    mapUI.svg.setAttribute('height',String(Math.max(100,height*scale)));
  }
  const mapObserver=typeof ResizeObserver==='function'?new ResizeObserver(sizeMap):null;
  mapObserver?.observe(mapUI.svg.parentElement);
  function paintFocus(){
    const graph=run?run.workflow:graphAuthor?.preview()||selected();
    const owner=run?'run:'+run.id:'workflow:'+(graph?.id||'');
    if(owner!==focusGraphId){focusGraphId=owner;focusStageId='';}
    const stages=Array.isArray(graph?.nodes)?graph.nodes:[],edges=Array.isArray(graph?.edges)?graph.edges:[];
    const limit=run?visibleRunStages:visibleStages,shown=stages.slice(0,limit);
    if(!stages.some(node=>node?.id===focusStageId))focusStageId=shown.find(node=>node?.id)?.id||'';
    mapUI.heading.textContent=graph?.name||(run?'Workflow run':selected()?.name)||'Select a workflow';
    mapUI.kind.textContent=run?'Selected run':'Saved workflow';
    mapUI.meta.textContent=run?'Run '+run.id:graph?.description||'';mapUI.meta.hidden=!mapUI.meta.textContent;
    mapUI.status.hidden=!run;mapUI.status.textContent=run?.status||'Not recorded';mapUI.status.dataset.state=run?.status||'';
    $('next-workflow-template').hidden=!run;$('next-workflow-refresh-run').hidden=!run;$('next-workflow-run-actions').hidden=!run;
    const hidden=Math.max(0,stages.length-shown.length),more=$('next-workflow-map-more');
    more.hidden=!hidden;more.textContent='Show '+Math.min(80,hidden)+' more stages ('+hidden+' remaining)';
    mapUI.count.textContent=stages.length?shown.length+' of '+stages.length+' stages · '+edges.length+' saved connections':'';
    const focused=mapUI.svg.contains(mount.ownerDocument.activeElement)?mount.ownerDocument.activeElement?.dataset?.stageId:null;
    mapUI.svg.replaceChildren();
    const layout=layoutWorkflowCanvas({nodes:shown}),ids=new Set(layout.nodes.map(node=>node.id));
    const {minX,minY,width,height}=layout.bounds;
    mapUI.svg.setAttribute('viewBox',[minX-30,minY-35,width+60,height+70].join(' '));
    mapBounds=layout.bounds;sizeMap();
    mapUI.svg.dataset.fit=String(fitMap);
    const defs=svgNode('defs'),marker=svgNode('marker',{id:'next-workflow-map-arrow',markerWidth:9,markerHeight:9,refX:8,refY:4,orient:'auto',markerUnits:'userSpaceOnUse'});
    marker.append(svgNode('path',{d:'M 0 0 L 8 4 L 0 8 Z',fill:'currentColor'}));defs.append(marker);mapUI.svg.append(defs);
    let drawn=0;
    for(const edge of edges){
      if(!edge||!ids.has(edge.source)||!ids.has(edge.target)||drawn>=120)continue;
      mapUI.svg.append(svgNode('path',{d:canvasEdgePath(layout.byId.get(edge.source),layout.byId.get(edge.target)),class:'next-workflow-map-edge',fill:'none','marker-end':'url(#next-workflow-map-arrow)'}));drawn++;
    }
    for(const stage of layout.nodes){
      const recorded=run?.nodes?.[stage.id],state=run?recorded?.status||'Not recorded':stage.type||'stage';
      const group=svgNode('g',{class:'next-workflow-map-stage'+(stage.id===focusStageId?' is-selected':''),'data-stage-id':stage.id,'data-state':state,role:'button',tabindex:stage.id===focusStageId?0:-1,'aria-pressed':String(stage.id===focusStageId),'aria-label':(stage.name||stage.id)+', '+state});
      group.append(svgNode('title',{},(stage.name||stage.id)+' · '+state));
      group.append(svgNode('rect',{x:stage.canvasX,y:stage.canvasY,width:CANVAS_NODE_WIDTH,height:CANVAS_NODE_HEIGHT,rx:8,class:'next-workflow-map-box'}));
      group.append(svgNode('text',{x:stage.canvasX+12,y:stage.canvasY+28,class:'next-workflow-map-name'},compactLabel(stage.name||stage.id)));
      group.append(svgNode('text',{x:stage.canvasX+12,y:stage.canvasY+50,class:'next-workflow-map-meta'},compactLabel(state)));
      const select=(id=stage.id,focus=false)=>{
        focusStageId=id;paintFocus();
        if(focus){const target=[...mapUI.svg.querySelectorAll('[data-stage-id]')].find(node=>node.dataset.stageId===id);target?.focus({preventScroll:true});
          if(target){
            const viewport=mapUI.svg.parentElement,bounds=viewport.getBoundingClientRect(),box=target.getBoundingClientRect();
            if(box.left<bounds.left+8)viewport.scrollLeft-=bounds.left+8-box.left;
            else if(box.right>bounds.right-8)viewport.scrollLeft+=box.right-(bounds.right-8);
            if(box.top<bounds.top+8)viewport.scrollTop-=bounds.top+8-box.top;
            else if(box.bottom>bounds.bottom-8)viewport.scrollTop+=box.bottom-(bounds.bottom-8);
          }}
      };
      group.addEventListener('click',()=>select());
      group.addEventListener('keydown',event=>{
        if(event.key==='Enter'||event.key===' '){event.preventDefault();select(stage.id,true);return;}
        const index=layout.nodes.findIndex(node=>node.id===stage.id);
        const next=event.key==='Home'?0:event.key==='End'?layout.nodes.length-1:['ArrowRight','ArrowDown'].includes(event.key)?Math.min(layout.nodes.length-1,index+1):['ArrowLeft','ArrowUp'].includes(event.key)?Math.max(0,index-1):-1;
        if(next<0)return;event.preventDefault();select(layout.nodes[next].id,true);
      });
      mapUI.svg.append(group);
    }
    if(focused)[...mapUI.svg.querySelectorAll('[data-stage-id]')].find(node=>node.dataset.stageId===focused)?.focus({preventScroll:true});
    mapUI.inspector.replaceChildren();
    const stage=stages.find(node=>node?.id===focusStageId);
    if(!stage){text(mapUI.inspector,selected()?'Loading the selected workflow…':'Choose a saved workflow or create one.','p','next-help');return;}
    text(mapUI.inspector,stage.name||stage.id,'h4');
    text(mapUI.inspector,run?run.nodes?.[stage.id]?.status||'No status recorded':stage.type||'stage','span','next-status-pill');
    const field=(heading,value)=>{if(value===undefined||value===null||value==='')return;const block=text(mapUI.inspector,'','div','next-workflow-inspector-field');text(block,heading,'h5');text(block,String(value),'p');};
    field('Instructions',stage.prompt);
    field('Work scope',stage.assignment?.scope);field('Expected result',stage.assignment?.result);field('Done when',stage.assignment?.doneWhen);
    const error=run?.nodes?.[stage.id]?.error;if(error)field('Recorded error',error.message||error);
    const incoming=edges.filter(edge=>edge?.target===stage.id).length,outgoing=edges.filter(edge=>edge?.source===stage.id).length;
    field('Connections',incoming+' incoming · '+outgoing+' outgoing');
    const identity=text(mapUI.inspector,'','details','next-workflow-stage-identity');text(identity,'Stage identifier','summary');text(identity,stage.id,'code');
    if(!run){const edit=text(mapUI.inspector,'Edit this stage','button');edit.id='next-workflow-stage-edit';edit.type='button';edit.disabled=busy;edit.addEventListener('click',()=>{editor.selectStage(stage.id);$('next-workflow-edit-details').scrollIntoView({block:'nearest'});});}
  }
  $('next-workflow-map-fit').addEventListener('click',()=>{fitMap=true;$('next-workflow-map-fit').setAttribute('aria-pressed','true');$('next-workflow-map-actual').setAttribute('aria-pressed','false');paintFocus();});
  $('next-workflow-map-actual').addEventListener('click',()=>{fitMap=false;$('next-workflow-map-fit').setAttribute('aria-pressed','false');$('next-workflow-map-actual').setAttribute('aria-pressed','true');paintFocus();});
  $('next-workflow-map-more').addEventListener('click',()=>{if(run){visibleRunStages+=80;paintRun();}else{visibleStages+=80;paintWorkflow();}});
  $('next-workflow-template').addEventListener('click',()=>{cancelRunRead();run=null;paintRun();});
  $('next-workflow-refresh-run').addEventListener('click',()=>{if(run?.id)void inspect(run.id);});
  // Saved graph objects are immutable in this workspace. Avoid revalidating a
  // large DAG on every keystroke in the task instructions field.
  const runnableGraphCache=new WeakMap();
  function graphReady(workflow){
    if(!runnableGraphCache.has(workflow))runnableGraphCache.set(workflow,workflowGraphReadiness(workflow).ready);
    return runnableGraphCache.get(workflow);
  }
  const available=()=>{
    const workflow=selected();
    return Boolean(workflow&&Array.isArray(workflow.nodes)&&Array.isArray(workflow.edges)
      &&!busy&&!editor.isSaving()&&!editor.hasDraft()
      &&!graphAuthor.hasDraft()&&graphReady(workflow)
      &&ui.prompt.value.trim()&&ui.cwd.value.trim());
  };
  function paintWorkflow(){
    const workflow=selected();
    const full=Boolean(workflow&&Array.isArray(workflow.nodes)&&Array.isArray(workflow.edges));
    ui.remove.hidden=!workflow;
    ui.delete.disabled=!full||busy||editor.isSaving()||editor.hasDraft()||graphAuthor.isSaving()||graphAuthor.hasDraft();
    graphAuthor.show(full?workflow:null);
    if((workflow?.id||'')!==overviewId){
      overviewId=workflow?.id||'';visibleStages=80;visibleConnections=120;
    }
    ui.outline.replaceChildren();
    ui.connections.replaceChildren();
    ui.moreStages.hidden=true;
    ui.moreConnections.hidden=true;
    if(!full){
      editor.show(null);ui.start.disabled=true;
      text(ui.outline,workflow?'Loading selected workflow stages…':'Select a workflow to inspect its stages.','p','next-help');
      if(workflow)ensureFullWorkflow(workflow.id);
      paintFocus();return;
    }
    const draftGraph=graphAuthor.preview()||workflow;
    const graph=workflowOverview(draftGraph,{nodeLimit:visibleStages,edgeLimit:visibleConnections});
    for(const node of graph.stages){
      if(!node)continue;
      const card=text(ui.outline,'','div','next-workflow-node');
      card.setAttribute('role','listitem');
      text(card,node.name||node.id||'Unnamed stage','strong');
      text(card,node.type||'stage','span','next-help');
      text(card,node.id||'','code','next-workflow-stage-id');
    }
    if(graph.hiddenStages){
      ui.moreStages.hidden=false;
      ui.moreStages.textContent='Show '+Math.min(80,graph.hiddenStages)+' more stages ('+graph.hiddenStages+' remaining)';
    }
    text(ui.connections,'Connections ('+graph.totalConnections+')','h3','next-workflow-connection-heading');
    if(!graph.totalConnections){
      text(ui.connections,'No connections yet. Use Build stages and connections below before running this workflow.','p','next-help');
    }else{
      const list=text(ui.connections,'','ol','next-workflow-links');
      for(const link of graph.connections){
        const row=text(list,'','li','next-workflow-link');
        if(link.broken)row.dataset.state='broken';
        text(row,link.sourceName,'span');
        text(row,'→','span','next-workflow-arrow');
        text(row,link.targetName,'span');
        text(row,link.sourceId+' → '+link.targetId,'code','next-workflow-connection-ids');
        if(link.broken)text(row,'Missing stage','small','next-help');
      }
      if(graph.hiddenConnections){
        ui.moreConnections.hidden=false;
        ui.moreConnections.textContent='Show '+Math.min(120,graph.hiddenConnections)+' more connections ('+graph.hiddenConnections+' remaining)';
      }
    }
    if(!ui.cwd.dataset.edited)
      ui.cwd.value=workflow.settings?.cwd||getStatus?.()?.cwd||ui.cwd.value||'';
    if(!ui.prompt.value.trim())ui.prompt.value=workflow.description||'';
    editor.show(draftGraph);
    ui.start.disabled=!available();paintFocus();
  }
  function paintRun(){
    if((run?.id||'')!==runDisplayId){runDisplayId=run?.id||'';visibleRunStages=80;}
    ui.details.replaceChildren();ui.runMore.hidden=true;
    ui.stop.hidden=!run||!['queued','running','waiting'].includes(run.status);
    ui.retry.hidden=!run||!['failed','cancelled'].includes(run.status)||run.settled!==true;
    ui.openChat.hidden=!run?.id;
    paintFocus();
    if(!run)return;
    const recorded=text(ui.details,'','details','next-workflow-disclosure');
    text(recorded,'Recorded stage statuses','summary');
    text(recorded,'Run ID: '+run.id,'p','next-help');
    const list=text(recorded,'','ul','next-workflow-nodes next-run-path');
    const displayed=workflowOverview(run.workflow,{nodeLimit:visibleRunStages,edgeLimit:1});
    for(const step of displayed.stages){
      const item=text(list,'','li','next-workflow-node');
      text(item,step.name||step.id,'strong');
      const status=run.nodes?.[step.id]?.status||'Not recorded';
      const pill=text(item,status,'span','next-status-pill');pill.dataset.state=status;
      if(run.nodes?.[step.id]?.error)text(item,String(run.nodes[step.id].error?.message||run.nodes[step.id].error).slice(0,180),'p','next-help');
    }
    if(displayed.hiddenStages){
      ui.runMore.hidden=false;
      ui.runMore.textContent='Show '+Math.min(80,displayed.hiddenStages)+' more run stages ('+displayed.hiddenStages+' remaining)';
    }
    if(run.taskState?.steps?.length){
      const plan=text(ui.details,'','details','next-chat-task-summary');
      const complete=run.taskState.steps.filter(x=>['done','completed'].includes(x.status)).length;
      text(plan,'Milestones '+complete+'/'+run.taskState.steps.length,'summary');
      for(const step of run.taskState.steps.slice(0,100)){
        const row=text(plan,'','div','next-row');
        text(row,step.title||step.id,'span');
        text(row,step.status||'pending','span','next-status-pill');
      }
    }
  }
  async function loadWorkflows(){
    if(!active)return;
    const token=++catalogEpoch;
    for(const controller of loadingFull.values())controller.abort();
    loadingFull.clear();
    try{
      // Only catalog metadata is loaded on Activity startup; selected graphs
      // are fetched separately, so 5,000 workflows do not parse full DAGs.
      const result=await api('/api/workflows?view=index');
      if(!active||token!==catalogEpoch)return;
      const stored=Array.isArray(result)?result:result?.workflows||[];
      // Retain only the selected graph while refreshing metadata. Replacing it
      // with a summary and then re-fetching it could clear a user's active form
      // mid-keystroke, and caching every visited graph grows without limit.
      const selectedId=ui.choice.value;
      const selectedBefore=workflows.find(item=>item.id===selectedId
        &&Array.isArray(item.nodes)&&Array.isArray(item.edges));
      let recheckSelection=false;
      const indexed=stored.map(item=>{
        if(item.id!==selectedId||!selectedBefore)return item;
        const stamp=item.updatedAt||null,previousStamp=selectedBefore.updatedAt||null;
        if(stamp!==previousStamp)return item;
        recheckSelection=!stamp; // Older saved workflows may have no revision timestamp.
        return selectedBefore;
      });
      const pending=graphAuthor.pendingNew();
      workflows=[...pending,...indexed.filter(item=>!pending.some(draft=>draft.id===item.id))];
      paintChoices(selectedId);
      paintWorkflow();
      if(recheckSelection&&ui.choice.value===selectedId)ensureFullWorkflow(selectedId);
    }catch(error){if(active&&token===catalogEpoch)report(error.message,true);}
  }
  function cancelRunRead(){readController?.abort();readController=null;revision++;clearTimeout(timer);}
  async function inspect(id){
    if(!active||!id)return;
    if(!/^[A-Za-z0-9_-]{1,160}$/.test(id)){report('Enter a saved run ID.',true);return;}
    readController?.abort();
    const controller=new AbortController();readController=controller;
    const token=++revision;
    try{
      const family=await reader.load(id,{signal:controller.signal});
      if(!active||controller.signal.aborted||readController!==controller||token!==revision)return;
      run=family.runs.find(r=>r.id===id)||family.runs.at(-1)||null;
      paintRun();
      if(run)report('Loaded '+run.status+' workflow run.');
    }catch(error){if(active&&!controller.signal.aborted)report(error.message,true);}
  }
  async function mutate(path,payload,status){
    if(!active||busy)return;
    const selectedId=ui.choice.value;cancelRunRead();const viewToken=revision;
    busy=true;ui.start.disabled=true;
    report(status);
    try{
      const reply=await api(path,'POST',payload);
      report('Action accepted. Reopen the saved run for updated status.');
      const result=reply?.run||reply;
      if(result?.id&&ui.choice.value===selectedId&&viewToken===revision){
        run={...result,workflow:result.workflow||selected(),nodes:result.nodes||{}};
        ui.runId.value=result.id;paintRun();
        if(active)setTimeout(()=>{if(active&&viewToken===revision&&run?.id===result.id)void inspect(result.id);},350);
      }
    }catch(error){report(error.message,true);}
    finally{busy=false;ui.start.disabled=!available();}
  }
  ui.createNew.addEventListener('click',()=>graphAuthor.beginNew());
  ui.delete.addEventListener('click',async()=>{
    const workflow=selected();
    if(!active||busy||!workflow||editor.isSaving()||editor.hasDraft()||graphAuthor.isSaving()||graphAuthor.hasDraft())
      return report('Save or discard workflow edits before deleting the template.',true);
    const id=workflow.id,epoch=catalogEpoch,controller=new AbortController();
    deletionController=controller;busy=true;ui.delete.disabled=true;ui.start.disabled=true;
    ui.form.inert=true;$('next-workflow-editor-host').inert=true;$('next-workflow-graph-host').inert=true;
    try{
      const latest=await api('/api/workflows/'+encodeURIComponent(id),'GET',undefined,{signal:controller.signal});
      if(!active||controller.signal.aborted||epoch!==catalogEpoch||ui.choice.value!==id)
        throw Error('Workflow deletion was cancelled before any saved work changed.');
      if(editor.isSaving()||editor.hasDraft()||graphAuthor.isSaving()||graphAuthor.hasDraft())
        throw Error('Save or discard workflow edits before deleting the template.');
      if(workflowSnapshot(latest)!==workflowSnapshot(workflow))
        throw Error('This workflow changed. Refresh and review it before deleting.');
      // The backend has no conditional DELETE or template archive. Never retry
      // an uncertain deletion or describe it as recoverable task Trash.
      deletionController=null;await api('/api/workflows/'+encodeURIComponent(id),'DELETE',{});
      catalogEpoch++;for(const controller of loadingFull.values())controller.abort();loadingFull.clear();
      workflows=workflows.filter(item=>item.id!==id);ui.remove.open=false;
      if(active)paintChoices(ui.choice.value===id?'':ui.choice.value);
      report('Workflow template deleted. Saved runs and schedules are preserved.');
    }catch(error){report(error.message,true);}
    finally{
      if(deletionController===controller)deletionController=null;
      busy=false;ui.form.inert=false;$('next-workflow-editor-host').inert=false;$('next-workflow-graph-host').inert=false;
      if(active)paintWorkflow();
    }
  });
  ui.search.addEventListener('input',()=>{
    clearTimeout(catalogTimer);catalogTimer=setTimeout(()=>{
      catalogTimer=null;const before=ui.choice.value;paintChoices();
      if(before!==ui.choice.value){cancelRunRead();run=null;paintRun();}
      paintWorkflow();
    },95);
  });
  ui.more.addEventListener('click',()=>{catalogLimit+=80;paintChoices();paintWorkflow();});
  ui.runMore.addEventListener('click',()=>{visibleRunStages+=80;paintRun();});
  ui.moreStages.addEventListener('click',()=>{visibleStages+=80;paintWorkflow();});
  ui.moreConnections.addEventListener('click',()=>{visibleConnections+=120;paintWorkflow();});
  ui.choice.addEventListener('change',()=>{cancelRunRead();run=null;paintWorkflow();paintRun();});
  ui.prompt.addEventListener('input',()=>{ui.start.disabled=!available();});
  ui.cwd.addEventListener('input',()=>{ui.cwd.dataset.edited='true';ui.start.disabled=!available();});
  ui.form.addEventListener('submit',event=>{
    event.preventDefault();
    const workflow=selected(),task=ui.prompt.value.trim(),cwd=ui.cwd.value.trim();
    if(!workflow||!task||!cwd)return report('Choose a workflow, task and working folder.',true);
    if(!available())return report('Save any graph and stage edits, and connect the workflow completely before running.',true);
    void mutate('/api/runs',{workflow,input:{task,cwd},requestId:stableId('workflow')},'Starting saved workflow…');
  });
  ui.refresh.addEventListener('click',()=>void loadWorkflows());
  ui.inspect.addEventListener('click',()=>void inspect(ui.runId.value.trim()||run?.id));
  ui.stop.addEventListener('click',()=>{if(run?.id)void mutate('/api/runs/'+encodeURIComponent(run.id)+'/cancel',{},'Requesting Stop…');});
  ui.retry.addEventListener('click',()=>{if(run?.id)void mutate('/api/runs/'+encodeURIComponent(run.id)+'/retry',{},'Requesting one retry…');});
  ui.openChat.addEventListener('click',()=>{if(run?.id)onNavigate?.('chat',{conversationId:run.taskId||run.id});});
  const onEvent=event=>{
    if(!active||!run?.id||event.runId!==run.id||!['run.updated','node.updated'].includes(event.type))return;
    clearTimeout(timer);
    timer=setTimeout(()=>{if(active&&run?.id)void inspect(run.id);},650);
  };
  return {
    enter(){if(active)return;active=true;unsubscribe=events.subscribe(onEvent);void loadWorkflows();paintRun();},
    leave(){active=false;revision++;catalogEpoch++;clearTimeout(catalogTimer);catalogTimer=null;readController?.abort();deletionController?.abort();
      for(const controller of loadingFull.values())controller.abort();loadingFull.clear();
      unsubscribe?.();unsubscribe=null;clearTimeout(timer);},
    updateStatus(status){if(active&&!ui.cwd.dataset.edited&&status?.cwd)ui.cwd.value=status.cwd;},
    destroy(){this.leave();clearTimeout(catalogTimer);reader.close();mapObserver?.disconnect();editor.destroy();graphAuthor.destroy();mount.innerHTML='';},
  };
}
