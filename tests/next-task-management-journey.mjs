import assert from 'node:assert/strict';

/** Uses the caller's existing headless session and synthetic API fixture. */
export async function exerciseTaskManagement({evaluate,send,until,fixture,counts}) {
  const ids=['lifecycle-fixture-a','lifecycle-fixture-b'];
  const initialWrites=fixture.state.taskLifecycleMutations.length;
  const templateId='lifecycle-disposable-template',initialDeletes=fixture.state.workflowDeletes.length;
  fixture.state.workflows.unshift({...structuredClone(fixture.state.workflows.find(item=>item.id==='sample-workflow')),id:templateId,name:'Disposable lifecycle template'});
  fixture.state.conversations.push(...ids.map((id,index)=>({id,rootId:id,taskId:id,runId:id,title:'Lifecycle fixture '+(index?'Beta':'Alpha'),status:'completed',settled:true,updatedAt:'2026-10-25T12:00:00Z'})));
  const click=selector=>evaluate('document.querySelector('+JSON.stringify(selector)+').click();true');
  const select=async(selector,value)=>evaluate('(()=>{const field=document.querySelector('+JSON.stringify(selector)+');field.value='+JSON.stringify(value)+';field.dispatchEvent(new Event("change",{bubbles:true}));return true})()');
  const query=async(prefix)=>{
    await evaluate('(()=>{const field=document.querySelector('+JSON.stringify('#'+prefix+'-query')+');field.value="Lifecycle fixture";field.dispatchEvent(new Event("input",{bubbles:true}));return true})()');
    await until(()=>evaluate('document.querySelector('+JSON.stringify('#'+prefix+'-list')+').querySelectorAll("[data-task-id]").length===2'),'Two isolated lifecycle tasks visible');
  };
  const row=(prefix,id)=>'#'+prefix+'-list [data-task-id="'+id+'"]';
  const action=(prefix,id,value)=>row(prefix,id)+' [data-task-action="'+value+'"]';
  const ready=async(prefix,state)=>{
    await select('#'+prefix+'-state',state);
    await until(()=>evaluate('document.querySelector('+JSON.stringify('#'+prefix+'-state')+').value==='+JSON.stringify(state)),state+' filter selected');
  };
  let emulated=false;
  try {
    await click('[data-space="tasks"]');
    await click('#next-tasks-tab-board');
    await until(()=>evaluate('Boolean(document.querySelector("#next-tasks-history-query"))'),'Tasks management catalog');
    const prefix='next-tasks-history';await query(prefix);
    const catalogCalls=fixture.calls.length;
    await click(action(prefix,ids[0],'archive'));
    await until(()=>fixture.state.taskHistoryStates[ids[0]]==='archived'&&evaluate('!document.querySelector('+JSON.stringify(row(prefix,ids[0]))+')'),'Task archived from Tasks');
    await ready(prefix,'archived');await until(()=>evaluate('Boolean(document.querySelector('+JSON.stringify(action(prefix,ids[0],'delete'))+'))'),'Archived task actions');
    await click(action(prefix,ids[0],'delete'));await until(()=>fixture.state.taskHistoryStates[ids[0]]==='deleted','Task moved to recoverable Trash');
    await ready(prefix,'deleted');await until(()=>evaluate('Boolean(document.querySelector('+JSON.stringify(action(prefix,ids[0],'restore'))+'))'),'Trash Restore action');
    await click(action(prefix,ids[0],'restore'));await until(()=>fixture.state.taskHistoryStates[ids[0]]==='active','Task restored from Trash');
    await ready(prefix,'active');await until(()=>evaluate('document.querySelector("#next-tasks-history-list").querySelectorAll("[data-task-id]").length===2'),'Both active tasks restored');
    await evaluate('(()=>{const button=[...document.querySelector("#next-tasks-history-bulk").querySelectorAll("button")].find(node=>node.textContent==="Select visible tasks");button.click();return true})()');
    await click('#next-tasks-history-bulk [data-task-bulk-action="archive"]');
    await until(()=>ids.every(id=>fixture.state.taskHistoryStates[id]==='archived'),'Both selected tasks archived exactly once');
    await ready(prefix,'archived');await until(()=>evaluate('document.querySelector("#next-tasks-history-list").querySelectorAll("[data-task-id]").length===2'),'Bulk archived catalog');
    await evaluate('(()=>{const button=[...document.querySelector("#next-tasks-history-bulk").querySelectorAll("button")].find(node=>node.textContent==="Select visible tasks");button.click();return true})()');
    await click('#next-tasks-history-bulk [data-task-bulk-action="restore"]');await until(()=>ids.every(id=>fixture.state.taskHistoryStates[id]==='active'),'Selected tasks restored');
    assert.equal(fixture.state.taskLifecycleMutations.length-initialWrites,7,'Every explicit bulk intent dispatches once per selected task.');
    assert.equal(fixture.calls.slice(catalogCalls).some(call=>call==='GET /api/runs'),false,'Task management cannot bulk-load execution traces.');
    counts.tasksLifecycle={archive:true,trash:true,restore:true,bulk:true,metadataOnly:true};

    await click('[data-space="activity"]');await until(()=>evaluate('Boolean(document.querySelector("#next-activity-tasks-query"))'),'Activity task management catalog');
    await click('#next-activity-tab-tasks');
    const activity='next-activity-tasks';await query(activity);
    await click(action(activity,ids[1],'delete'));await until(()=>fixture.state.taskHistoryStates[ids[1]]==='deleted','Activity moved a settled task to Trash');
    await ready(activity,'deleted');await until(()=>evaluate('Boolean(document.querySelector('+JSON.stringify(action(activity,ids[1],'restore'))+'))'),'Activity exposes Trash restoration');
    await click(action(activity,ids[1],'restore'));await until(()=>fixture.state.taskHistoryStates[ids[1]]==='active','Activity restored task');
    counts.activityLifecycle={sharedState:true,trash:true,restore:true};

    await click('#next-activity-tab-workflows');
    await click('#next-workflow-refresh');
    await until(()=>evaluate('Boolean(document.querySelector('+JSON.stringify('#next-workflow-choice option[value="'+templateId+'"]')+'))'),'Disposable workflow appears in bounded catalog');
    await select('#next-workflow-choice',templateId);
    await until(()=>evaluate('document.querySelector("#next-workflow-edit-name")?.value==="Disposable lifecycle template" && document.querySelector("#next-workflow-delete")?.disabled===false'),'Disposable workflow fully loaded for deletion');
    await evaluate('(()=>{const name=document.querySelector("#next-workflow-edit-name");name.value="Unsaved disposable draft";name.dispatchEvent(new Event("input",{bubbles:true}));document.querySelector("#next-workflow-remove").open=true;return true})()');
    await click('#next-workflow-delete');
    await until(()=>evaluate('document.querySelector("#next-workflow-feedback").textContent.includes("Save or discard workflow edits")'),'Delete preserves unsaved workflow draft');
    assert.equal(fixture.state.workflowDeletes.length,initialDeletes);assert.equal(await evaluate('document.querySelector("#next-workflow-edit-name").value'),'Unsaved disposable draft');
    await click('#next-workflow-edit-discard');await click('#next-workflow-delete');
    await until(()=>fixture.state.workflowDeletes.length===initialDeletes+1&&!fixture.state.workflows.some(item=>item.id===templateId),'Explicit workflow template Delete persisted once');
    await until(()=>evaluate('!document.querySelector('+JSON.stringify('#next-workflow-choice option[value="'+templateId+'"]')+')'),'Deleted workflow removed from selector');
    assert.equal(fixture.state.workflowDeletes.at(-1),templateId);
    await select('#next-workflow-choice','sample-workflow');
    await until(()=>evaluate('document.querySelector("#next-workflow-choice").value==="sample-workflow" && document.querySelector("#next-workflow-edit-node option[value=agent]") && !document.querySelector("#next-workflow-edit-form").inert && !document.querySelector("#next-workflow-editor-host").inert'),'Original sample workflow selection restored and interactive');
    counts.workflowTemplateDeletion={explicitDelete:true,draftPreserved:true,once:true,originalSelectionRestored:true};

    await click('#next-activity-tab-tasks');
    await ready(activity,'active');await until(()=>evaluate('Boolean(document.querySelector('+JSON.stringify(action(activity,ids[0],'archive'))+'))'),'Minimum-size lifecycle action ready');
    await send('Emulation.setDeviceMetricsOverride',{width:780,height:560,deviceScaleFactor:1.5,mobile:false});emulated=true;
    await evaluate('document.querySelector("#next-toast").replaceChildren();true');
    const selector=action(activity,ids[0],'archive');
    await evaluate('document.querySelector('+JSON.stringify(selector)+').closest("details").open=true;true');
    const geometry=await evaluate('(()=>{const node=document.querySelector('+JSON.stringify(selector)+');node.scrollIntoView({block:"center"});const rect=node.getBoundingClientRect();return {x:rect.x+rect.width/2,y:rect.y+rect.height/2,top:rect.top,bottom:rect.bottom,hit:document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2)===node,dpr:devicePixelRatio,overflow:document.documentElement.scrollWidth>innerWidth+1}})()');
    assert.equal(geometry.dpr,1.5);assert.equal(geometry.hit,true);assert.ok(geometry.top>=0&&geometry.bottom<=560);assert.equal(geometry.overflow,false);
    await send('Input.dispatchMouseEvent',{type:'mousePressed',x:geometry.x,y:geometry.y,button:'left',clickCount:1});
    await send('Input.dispatchMouseEvent',{type:'mouseReleased',x:geometry.x,y:geometry.y,button:'left',clickCount:1});
    await until(()=>fixture.state.taskHistoryStates[ids[0]]==='archived','Minimum-window pointer Archive succeeded');
    counts.taskManagementMinimumGeometry={width:780,height:560,scale:1.5,actionHit:true,pointerArchive:true};
  } finally {
    if(emulated)await send('Emulation.clearDeviceMetricsOverride');
    fixture.state.conversations=fixture.state.conversations.filter(item=>!ids.includes(item.taskId||item.rootId||item.id));
    fixture.state.workflows=fixture.state.workflows.filter(item=>item.id!==templateId);
    for(const id of ids)delete fixture.state.taskHistoryStates[id];
    fixture.send({type:'conversations.updated',data:{healthy:true}});
    await click('[data-space="chat"]');
  }
}
