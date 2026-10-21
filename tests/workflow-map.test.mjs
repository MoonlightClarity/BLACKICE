import test from 'node:test';
import assert from 'node:assert/strict';
import {buildWorkflowMapModel,renderWorkflowMap,handleWorkflowMapAction,readWorkflowMapView,restoreWorkflowMapView} from '../public/workflow-map.mjs';

const task=(id,{title=id,status='pending',dependsOn=[],attempts=[],...rest}={})=>({id,title,status,dependsOn,attempts,acceptanceCriteria:['Observed evidence exists.'],maxRepairs:2,round:0,...rest});
const project=tasks=>({id:'project-fixture',name:'Build and verify a capability',objective:'Make the workflow visible.',status:'draft',tasks});
const graph=()=>({id:'workflow-fixture',name:'Parallel investigation',nodes:[{id:'input',type:'input',name:'Request'},{id:'left',type:'agent',name:'Research'},{id:'right',type:'agent',name:'Challenge'},{id:'join',type:'agent',name:'Synthesize'},{id:'output',type:'output',name:'Result'}],edges:[{source:'input',target:'left'},{source:'input',target:'right'},{source:'left',target:'join'},{source:'right',target:'join'},{source:'join',target:'output'}]});
const run=extra=>({id:'run-fixture',status:'running',workflow:graph(),nodes:{input:{status:'completed'},left:{status:'running'},right:{status:'failed',error:'Access unavailable'},join:{status:'queued',blockedBy:['left','right']},output:{status:'queued'}},events:[],...extra});
const byId=model=>new Map(model.nodes.map(node=>[node.id,node]));
const assertGeometry=model=>{
  assert.ok(Number.isFinite(model.width)&&model.width>0,'map width is finite');
  assert.ok(Number.isFinite(model.height)&&model.height>0,'map height is finite');
  for(const node of model.nodes)for(const key of ['level','x','y','width','height'])assert.ok(Number.isFinite(node[key])&&node[key]>=0,`${node.id}.${key} is finite and nonnegative`);
  for(const node of model.nodes){assert.ok(node.x+node.width<=model.width,`${node.id} fits horizontally`);assert.ok(node.y+node.height<=model.height,`${node.id} fits vertically`);}
};

test('project dependencies use stable topological positions even when the prerequisite is declared later',()=>{
  const value=project([task('deliver',{dependsOn:['inspect']}),task('inspect')]),before=structuredClone(value);
  const one=buildWorkflowMapModel({kind:'project',project:value}),two=buildWorkflowMapModel({kind:'project',project:value}),nodes=byId(one);
  assert.ok(nodes.get('inspect').level<nodes.get('deliver').level);
  assert.ok(nodes.get('inspect').x<nodes.get('deliver').x);
  assert.deepEqual(one,two,'polling unchanged data cannot reshuffle the map');
  assert.deepEqual(value,before,'deriving a map must not mutate the saved plan');
  assert.deepEqual(one.edges.map(({source,target})=>({source,target})),[{source:'inspect',target:'deliver'}]);
  assertGeometry(one);
});

test('independent branches occupy one stage and the join follows every prerequisite',()=>{
  const model=buildWorkflowMapModel({kind:'project',project:project([task('start'),task('left',{dependsOn:['start']}),task('right',{dependsOn:['start']}),task('join',{dependsOn:['left','right']})])}),nodes=byId(model);
  assert.equal(nodes.get('left').level,nodes.get('right').level);
  assert.notEqual(nodes.get('left').y,nodes.get('right').y,'parallel branches must not overlap');
  assert.ok(nodes.get('join').level>nodes.get('left').level);
  assert.equal(model.edges.filter(edge=>edge.target==='join').length,2);
  for(const edge of model.edges)assert.equal(edge.kind,'dependency');
  assertGeometry(model);
});

test('pending project tasks distinguish readiness from unfinished dependencies',()=>{
  const model=buildWorkflowMapModel({kind:'project',project:project([task('reviewed',{status:'completed'}),task('failed',{status:'blocked',error:'No evidence supplied.'}),task('ready',{dependsOn:['reviewed']}),task('waiting',{dependsOn:['reviewed','failed']})])}),nodes=byId(model);
  assert.deepEqual(nodes.get('ready').blockedBy,[]);
  assert.match(nodes.get('ready').statusLabel,/ready/i);
  assert.deepEqual(nodes.get('waiting').blockedBy,['failed']);
  assert.match(nodes.get('waiting').statusLabel,/wait|depend/i);
  assert.match(nodes.get('failed').statusLabel,/blocked|attention/i);
});

test('an implementation receipt cannot turn a reviewing task into a completed task',()=>{
  const attempts=[{number:1,implementation:{status:'completed',runId:'implementation-receipt'},verification:{status:'running',runId:'review-receipt'}}];
  const model=buildWorkflowMapModel({kind:'project',project:project([task('verify',{status:'verifying',attempts}),task('next',{dependsOn:['verify']})])}),nodes=byId(model);
  assert.notEqual(nodes.get('verify').status,'completed');
  assert.match(nodes.get('verify').statusLabel,/review|verif/i);
  assert.deepEqual(nodes.get('next').blockedBy,['verify']);
});

test('a prepared original-result review is ready, with dependencies still locked until actual review passes',()=>{
  const prepared=task('inspect',{status:'verifying',attempts:[{number:2,mode:'review_only',sourceAttempt:1,implementation:{status:'completed',runId:'original-result'},verification:{status:'prepared'}}]}),value=project([prepared,task('dependent',{dependsOn:['inspect']})]),before=structuredClone(value);
  const model=buildWorkflowMapModel({kind:'project',project:value}),nodes=byId(model),html=renderWorkflowMap({kind:'project',project:value});
  assert.equal(nodes.get('inspect').status,'ready');assert.equal(nodes.get('inspect').statusLabel,'Review prepared');assert.deepEqual(nodes.get('dependent').blockedBy,['inspect']);
  assert.match(html,/inspect: Review prepared/);assert.match(html,/<b>1<\/b> Ready/);assert.doesNotMatch(html,/<b>1<\/b> Working \/ reviewing|<b>1<\/b> Agent-reviewed/);
  assert.deepEqual(value,before);
  prepared.attempts[0].verification.status='running';const active=byId(buildWorkflowMapModel({kind:'project',project:value})).get('inspect');assert.equal(active.status,'reviewing');assert.equal(active.statusLabel,'Reviewing');
});

test('a repair remains unfinished and exposes the repair cycle',()=>{
  const value=task('repair',{round:1,error:'The output is missing its evidence.',attempts:[{number:1,implementation:{status:'completed',runId:'attempt-one'},verification:{status:'completed',verdict:{passed:false,summary:'The output is missing its evidence.',criteria:[{criterion:'Observed evidence exists.',passed:false,evidence:'No result file.'}]}}}]});
  const model=buildWorkflowMapModel({kind:'project',project:project([value,task('dependent',{dependsOn:['repair']})])}),nodes=byId(model);
  assert.notEqual(nodes.get('repair').status,'completed');
  assert.match(nodes.get('repair').detail,/repair|attempt|evidence/i);
  assert.deepEqual(nodes.get('dependent').blockedBy,['repair']);
});

test('malformed project dependencies remain inspectable without infinite layout or ghost edges',()=>{
  const model=buildWorkflowMapModel({kind:'project',project:project([task('a',{dependsOn:['b','missing']}),task('b',{dependsOn:['a']})])});
  assert.equal(model.nodes.length,2);
  assert.ok(model.warnings.length,'invalid persisted graphs must be disclosed');
  assert.ok(model.edges.every(edge=>model.nodes.some(node=>node.id===edge.source)&&model.nodes.some(node=>node.id===edge.target)));
  assertGeometry(model);
});

test('execution map keeps actual branch statuses and ordered handoffs',()=>{
  const value=run(),model=buildWorkflowMapModel({kind:'run',run:value}),nodes=byId(model);
  assert.equal(nodes.get('left').status,'running');
  assert.equal(nodes.get('right').status,'failed');
  assert.notEqual(nodes.get('join').status,'completed');
  assert.match(nodes.get('right').detail,/Access unavailable/);
  assert.ok(nodes.get('join').level>nodes.get('left').level);
  assert.equal(model.edges.filter(edge=>edge.target==='join').length,2);
  assertGeometry(model);
});

test('execution failures preserve human-readable error messages from structured receipts',()=>{
  const value=run();value.nodes.right.error={message:'Permission denied while opening the actual source.',code:'ACCESS_DENIED'};
  const model=buildWorkflowMapModel({kind:'run',run:value});
  assert.match(byId(model).get('right').detail,/Permission denied/);
  assert.doesNotMatch(byId(model).get('right').detail,/\[object Object\]/);
});

test('delegated children retain terminal receipts when later tool events arrive',()=>{
  const value=run({events:[
    {type:'agent.event',nodeId:'left',at:'2026-10-17T12:00:00Z',data:{type:'subagent',id:'inspect',status:'running',label:'Inspect the actual workspace.'}},
    {type:'agent.event',nodeId:'left',at:'2026-10-17T12:00:01Z',data:{type:'subagent',id:'inspect',status:'completed',durationMs:1000,threadId:'child-thread-123',toolSummary:{completed:2,failed:0}}},
    {type:'agent.event',nodeId:'left',at:'2026-10-17T12:00:02Z',data:{type:'subagent',id:'inspect',status:'tool-completed',tool:'relay_workspace'}},
  ]}),model=buildWorkflowMapModel({kind:'run',run:value}),child=model.nodes.find(node=>node.parentId==='left');
  assert.ok(child,'on-demand delegation must be visible beyond the event log');
  assert.equal(child.status,'completed');
  assert.equal(child.threadId,'child-thread-123');
  assert.match(child.label,/inspect/i);
  assert.deepEqual(child.blockedBy,[],'delegation does not mean a child waits for its parent to finish');
  assert.ok(model.edges.some(edge=>edge.kind==='delegation'&&edge.source==='left'&&edge.target===child.id));
  assertGeometry(model);
});

test('same child label under different parent agents never merges their outcomes',()=>{
  const model=buildWorkflowMapModel({kind:'run',run:run({events:[
    {type:'agent.event',nodeId:'left',data:{type:'subagent',id:'check',status:'running',label:'Check sources.'}},
    {type:'agent.event',nodeId:'left',data:{type:'subagent',id:'check',status:'failed',message:'Source unavailable.'}},
    {type:'agent.event',nodeId:'right',data:{type:'subagent',id:'check',status:'running',label:'Check assumptions.'}},
    {type:'agent.event',nodeId:'right',data:{type:'subagent',id:'check',status:'cancelled',message:'Cancelled by user.'}},
  ]})}),children=model.nodes.filter(node=>node.parentId);
  assert.equal(children.length,2);
  assert.equal(new Set(children.map(child=>child.id)).size,2);
  assert.equal(children.find(child=>child.parentId==='left').status,'failed');
  assert.match(children.find(child=>child.parentId==='left').detail,/Source unavailable/);
  assert.equal(children.find(child=>child.parentId==='right').status,'cancelled');
  assert.match(children.find(child=>child.parentId==='right').detail,/Cancelled by user/);
});

test('a later explicit delegation with a reused child ID does not inherit its earlier thread receipt',()=>{
  const model=buildWorkflowMapModel({kind:'run',run:run({events:[
    {type:'agent.event',nodeId:'left',data:{type:'subagent',id:'inspect',status:'running',label:'Inspect the first result.'}},
    {type:'agent.event',nodeId:'left',data:{type:'subagent',id:'inspect',status:'completed',threadId:'old-child-thread'}},
    {type:'agent.event',nodeId:'left',data:{type:'subagent',id:'inspect',status:'running',label:'Inspect the next result.'}},
  ]})}),active=model.nodes.filter(node=>node.parentId==='left'&&node.status==='running');
  assert.equal(active.length,1,'the latest explicit invocation is active');
  assert.ok(!active[0].threadId,'an old execution receipt must not be attributed to a new child');
});

test('an ended parent run cannot leave a child visually working without a terminal child receipt',()=>{
  const model=buildWorkflowMapModel({kind:'run',run:run({status:'cancelled',events:[{type:'agent.event',nodeId:'left',data:{type:'subagent',id:'inspect',status:'running',label:'Inspect before interruption.'}}]})}),child=model.nodes.find(node=>node.parentId==='left');
  assert.ok(child);
  assert.equal(child.status,'interrupted');
  assert.match(child.statusLabel,/interrupt/i);
  assert.match(child.detail,/parent|receipt|ended/i);
});

test('maps render labels as text and never inject markup through names, IDs or descriptions',()=>{
  const dangerous='<img src=x onerror=alert(1)>',id='evil\" autofocus onfocus=alert(1) x=\"';
  const value=project([task(id,{title:dangerous,error:'<script>alert(2)</script>',status:'blocked'})]);value.name='Unsafe <svg onload=alert(3)>';
  const html=renderWorkflowMap({kind:'project',project:value,selectedId:id,instanceId:'unsafe\" onload=alert(4) x=\"'});
  assert.doesNotMatch(html,/<(?:img|script)\b|<svg\s+onload=/i);
  assert.match(html,/&lt;img/);
  const rawAttributes=[...html.matchAll(/<[a-z][^>]*>/gi)].map(([tag])=>tag.replace(/"[^"]*"|'[^']*'/g,'""')).join('\n');
  assert.doesNotMatch(rawAttributes,/\s(?:autofocus|onfocus|onerror|onload)(?:\s*=|\s|>)/i);
  assert.match(html,/<button\b[^>]*type="button"/);
  assert.match(html,/aria-(?:label|labelledby)=/);
});

test('empty project and run maps are bounded and explain the missing workflow',()=>{
  for(const value of [{kind:'project',project:project([])},{kind:'run',run:{id:'empty',status:'queued',workflow:{nodes:[],edges:[]},nodes:{},events:[]}}]){
    const model=buildWorkflowMapModel(value);assert.equal(model.nodes.length,0);assertGeometry(model);
    const html=renderWorkflowMap(value);assert.match(html,/no |empty|start|workflow|task/i);
  }
});

function fitFixture({width=908,height=460,clientWidth=1000,clientHeight=370}={}){
  const canvas={dataset:{width:String(width),height:String(height),zoom:'1'},style:{}},size={style:{}},viewport={clientWidth,clientHeight,scrollLeft:80,scrollTop:90};
  const map={dataset:{workflowMap:'fit-fixture'},querySelector:selector=>({'[data-workflow-canvas]':canvas,'[data-workflow-size]':size,'[data-workflow-scroll]':viewport})[selector]};
  const target={dataset:{workflowAction:'fit'},closest:()=>map};
  const root={querySelectorAll:()=>[map]};
  return{canvas,size,viewport,map,root,fit:()=>handleWorkflowMapAction(target),zoom:direction=>handleWorkflowMapAction({...target,dataset:{workflowAction:'zoom-'+direction}})};
}

test('Fit keeps a tall delegation graph inside both dimensions and remains stable on repeated use',()=>{
  const f=fitFixture();assert.equal(f.fit(),true);
  const zoom=Number(f.canvas.dataset.zoom);assert.ok(zoom<1,'height must constrain a graph that already fits horizontally');
  assert.ok(parseFloat(f.size.style.width)<=f.viewport.clientWidth);
  assert.ok(parseFloat(f.size.style.height)<=f.viewport.clientHeight);
  assert.equal(f.viewport.scrollLeft,0);assert.equal(f.viewport.scrollTop,0);
  // The viewport follows its scaled content until its CSS minimum height is reached.
  f.viewport.clientHeight=parseFloat(f.size.style.height);f.fit();assert.equal(Number(f.canvas.dataset.zoom),zoom,'repeated Fit must not shrink the auto-height viewport');
});

test('Fit still respects narrow widths and works when a host fixture has no measured height',()=>{
  for(const clientHeight of [undefined,0,370]){
    const f=fitFixture({width:908,height:460,clientWidth:390,clientHeight});if(clientHeight===undefined)delete f.viewport.clientHeight;f.fit();
    const zoom=Number(f.canvas.dataset.zoom);assert.ok(Number.isFinite(zoom));assert.ok(parseFloat(f.size.style.width)<=390);
    if(clientHeight)assert.ok(parseFloat(f.size.style.height)<=clientHeight);
  }
});

test('a new map fits its first measured viewport without requiring a Fit click',()=>{
  const f=fitFixture({clientWidth:570});restoreWorkflowMapView(f.root,null);
  assert.ok(parseFloat(f.size.style.width)<=f.viewport.clientWidth,'the final task must be visible when a narrow project opens');
  assert.ok(parseFloat(f.size.style.height)<=f.viewport.clientHeight);
  assert.equal(f.viewport.scrollLeft,0);assert.equal(f.viewport.scrollTop,0);
  assert.equal(f.canvas.dataset.viewMode,'fit');
  const [view]=readWorkflowMapView(f.root);assert.equal(view.mode,'fit');assert.equal(view.zoom,Number(f.canvas.dataset.zoom));
});

test('Fit can show an entire supported 100-task plan instead of clipping at a minimum scale',()=>{
  const tasks=Array.from({length:100},(_,index)=>task('step-'+index,{dependsOn:index?['step-'+(index-1)]:[]})),model=buildWorkflowMapModel({kind:'project',project:project(tasks)}),f=fitFixture({width:model.width,height:model.height,clientWidth:570});
  f.fit();assert.ok(parseFloat(f.size.style.width)<=f.viewport.clientWidth);assert.ok(parseFloat(f.size.style.height)<=f.viewport.clientHeight);assert.ok(Number(f.canvas.dataset.zoom)>0);
  const fitted=Number(f.canvas.dataset.zoom);f.zoom('in');assert.equal(Number(f.canvas.dataset.zoom),fitted*1.2,'zooming into a large overview should advance gradually');
});

test('automatic fitting follows a resized viewport while explicit zoom and pan survive polling',()=>{
  const original=fitFixture({clientWidth:570});restoreWorkflowMapView(original.root,null);const fitted=readWorkflowMapView(original.root);
  const wider=fitFixture({clientWidth:1000});restoreWorkflowMapView(wider.root,fitted);assert.ok(Number(wider.canvas.dataset.zoom)>fitted[0].zoom,'Fit mode should use the newly available space');
  original.zoom('in');original.viewport.scrollLeft=91;original.viewport.scrollTop=23;const manual=readWorkflowMapView(original.root),refreshed=fitFixture({clientWidth:850,height:730});restoreWorkflowMapView(refreshed.root,manual);
  assert.equal(Number(refreshed.canvas.dataset.zoom),manual[0].zoom,'new evidence cannot override the user-selected scale');
  assert.equal(refreshed.canvas.dataset.viewMode,'manual');assert.equal(refreshed.viewport.scrollLeft,91);assert.equal(refreshed.viewport.scrollTop,23);
  refreshed.fit();assert.equal(refreshed.canvas.dataset.viewMode,'fit');assert.equal(refreshed.viewport.scrollLeft,0);assert.equal(refreshed.viewport.scrollTop,0);
});

test('a hidden viewport defers fitting and a legacy saved scale remains a manual choice',()=>{
  const hidden=fitFixture({clientWidth:0});restoreWorkflowMapView(hidden.root,null);assert.equal(hidden.canvas.dataset.zoom,'1');assert.equal(hidden.canvas.style.transform,undefined);
  hidden.viewport.clientWidth=570;restoreWorkflowMapView(hidden.root,null);assert.ok(Number(hidden.canvas.dataset.zoom)<1);
  restoreWorkflowMapView(hidden.root,[{id:'fit-fixture',zoom:1.4,left:60,top:8}]);assert.equal(hidden.canvas.dataset.zoom,'1.4');assert.equal(hidden.canvas.dataset.viewMode,'manual');assert.equal(hidden.viewport.scrollLeft,60);
});

const renderedAttributes=(html,attribute)=>new Map([...html.matchAll(new RegExp(`<[^>]+${attribute}="([^"]+)"[^>]*>`,'g'))].map(([tag,id])=>[id,Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map(([,name,value])=>[name,value]))]));

test('selection highlights actual upstream and downstream paths across branches and joins',()=>{
  const value=project([task('start'),task('left',{dependsOn:['start']}),task('right',{dependsOn:['start']}),task('join',{dependsOn:['left','right']}),task('result',{dependsOn:['join']}),task('separate')]);
  const html=renderWorkflowMap({kind:'project',project:value,selectedId:'left'}),nodes=renderedAttributes(html,'data-workflow-node'),edges=renderedAttributes(html,'data-workflow-edge');
  assert.equal(nodes.get('left')['data-relation'],'selected');assert.equal(nodes.get('left')['aria-pressed'],'true');assert.equal(nodes.get('start')['data-relation'],'upstream');assert.equal(nodes.get('join')['data-relation'],'downstream');assert.equal(nodes.get('result')['data-relation'],'downstream');assert.equal(nodes.get('right')['data-relation'],'unrelated');assert.equal(nodes.get('separate')['data-relation'],'unrelated');
  assert.equal(edges.get('start:left')['data-relation'],'upstream');assert.equal(edges.get('left:join')['data-relation'],'downstream');assert.equal(edges.get('join:result')['data-relation'],'downstream');assert.equal(edges.get('right:join')['data-relation'],'unrelated');
  assert.match(html,/1 upstream · 2 downstream/);assert.match(nodes.get('start')['aria-label'],/Upstream of selected step/);
  const cleared=renderWorkflowMap({kind:'project',project:value,selectedId:'removed-task'});assert.doesNotMatch(cleared,/class="workflow-map-focus"/);assert.ok([...renderedAttributes(cleared,'data-workflow-node').values()].every(node=>node['data-relation']==='none'));
});

test('delegation paths remain visibly distinct from dependency handoffs and cyclic data remains bounded',()=>{
  const actual=run({events:[{type:'agent.event',nodeId:'left',data:{type:'subagent',id:'inspect',status:'completed',label:'Inspect receipt'}}]}),child=buildWorkflowMapModel({run:actual}).nodes.find(node=>node.type==='subagent');
  const html=renderWorkflowMap({run:actual,selectedId:child.id}),nodes=renderedAttributes(html,'data-workflow-node'),edges=renderedAttributes(html,'data-workflow-edge');
  assert.equal(nodes.get('left')['data-relation'],'upstream');assert.match(html,/<i class="delegated"[^>]*><\/i>Delegation/);assert.ok([...edges.values()].some(edge=>edge.class.includes('delegated')&&edge['data-relation']==='upstream'));
  const cyclic=renderWorkflowMap({kind:'project',project:project([task('a',{dependsOn:['b']}),task('b',{dependsOn:['a']})]),selectedId:'a'});assert.match(cyclic,/contain a cycle/);assert.equal(renderedAttributes(cyclic,'data-workflow-node').size,2);
});

test('status legend counts only recorded states and never suggests unfinished work is complete',()=>{
  const value=project([task('reviewed',{status:'completed'}),task('reviewing',{status:'verifying'}),task('blocked',{status:'blocked'}),task('waiting',{dependsOn:['blocked']}),task('ready')]),html=renderWorkflowMap({kind:'project',project:value});
  const legend=/<footer class="workflow-map-legend"[^>]*>([\s\S]*?)<\/footer>/.exec(html)[1];
  assert.match(legend,/<b>1<\/b> Agent-reviewed/);assert.match(legend,/<b>1<\/b> Working \/ reviewing/);assert.match(legend,/<b>1<\/b> Needs attention/);assert.match(legend,/<b>1<\/b> Waiting/);assert.match(legend,/<b>1<\/b> Ready/);assert.doesNotMatch(legend,/Not started|Stopped/);
});
