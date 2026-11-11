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
  let emulated=false;
  try {

    await click('[data-space="chat"]');
    fixture.send({type:'conversations.updated',data:{healthy:true}});
    await evaluate('(()=>{const field=document.querySelector("#next-chat-search");field.value="Lifecycle fixture";field.dispatchEvent(new Event("input",{bubbles:true}));return true})()');
    const rows=()=>evaluate('document.querySelectorAll("#next-chat-list .next-conversation").length');
    const chatAction=(id,action)=>'#next-chat-list .next-conversation[data-conversation="'+id+'"]';
    const manage=async(id,action)=>{
      await until(()=>evaluate('Boolean(document.querySelector('+JSON.stringify(chatAction(id,action))+'))'),'Lifecycle chat row present');
      await evaluate('(()=>{const row=document.querySelector('+JSON.stringify(chatAction(id,action))+').closest(".next-conversation-row");row.querySelector("[data-chat-action='+action+']").click();return true})()');
      if(action==='delete'){
        await until(()=>evaluate('document.querySelector("#next-chat-trash-dialog").open'),'Trash confirmation shown');
        await click('#next-chat-trash-confirm');
      }
    };
    const bucket=async value=>{
      await until(()=>evaluate('!document.querySelector("#next-chat-bucket").disabled'),'Lifecycle response settled before changing bucket');
      await select('#next-chat-bucket',value);
      await until(()=>evaluate('document.querySelector("#next-chat-bucket").value==='+JSON.stringify(value)),value+' bucket');
    };
    await until(async()=>await rows()===2,'Two isolated lifecycle chats');
    const catalogCalls=fixture.calls.length;
    await manage(ids[0],'archive');await until(()=>fixture.state.taskHistoryStates[ids[0]]==='archived','Chat archived');
    await bucket('archived');await manage(ids[0],'delete');
    await until(()=>fixture.state.taskHistoryStates[ids[0]]==='deleted','Chat moved to recoverable Trash');
    await bucket('deleted');await manage(ids[0],'restore');
    await until(()=>fixture.state.taskHistoryStates[ids[0]]==='active','Chat restored from Trash');
    await bucket('active');await until(async()=>await rows()===2,'Both chats active');
    await click('#next-chat-select');await click('#next-chat-bulk-all');await click('#next-chat-bulk-archive');
    await until(()=>ids.every(id=>fixture.state.taskHistoryStates[id]==='archived'),'Both selected chats archived');
    await bucket('archived');await until(async()=>await rows()===2,'Both archived chats');
    await click('#next-chat-select');await click('#next-chat-bulk-all');await click('#next-chat-bulk-restore');
    await until(()=>ids.every(id=>fixture.state.taskHistoryStates[id]==='active'),'Bulk restoration');
    assert.equal(fixture.state.taskLifecycleMutations.length-initialWrites,7,'Every explicit lifecycle intent is submitted once per selected chat');
    assert.equal(fixture.calls.slice(catalogCalls).some(call=>call==='GET /api/runs'),false,'Lifecycle management stays metadata-only');
    counts.chatLifecycle={archive:true,trash:true,restore:true,bulk:true,metadataOnly:true};
    await bucket('active');
    await click('[data-space="cronjobs"]');await click('#next-cronjobs-manage-workflows');
    await until(()=>evaluate('Boolean(document.querySelector("#next-workflow-refresh"))'),'Workflow manager for explicit template deletion');
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


    await click('[data-space="chat"]');await bucket('active');
    await until(()=>evaluate('Boolean(document.querySelector('+JSON.stringify(chatAction(ids[0],'archive'))+'))'),'Minimum-size lifecycle row');
    await send('Emulation.setDeviceMetricsOverride',{width:780,height:560,deviceScaleFactor:1.5,mobile:false});emulated=true;
    await evaluate('document.querySelector("#next-toast").replaceChildren();true');
    await until(()=>evaluate('!document.querySelector("#next-chat-bucket").disabled'),'Chat management ready after reentry');
    await evaluate('document.querySelector('+JSON.stringify(chatAction(ids[0],'archive'))+').closest(".next-conversation-row").querySelector("details").open=true;true');
    await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    const geometry=await evaluate('(()=>{const row=document.querySelector('+JSON.stringify(chatAction(ids[0],'archive'))+').closest(".next-conversation-row");row.querySelector("details").open=true;const n=row.querySelector("[data-chat-action=archive]");n.scrollIntoView({block:"center",behavior:"instant"});const r=n.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,hit:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===n,top:r.top,bottom:r.bottom,overflow:document.documentElement.scrollWidth>innerWidth+1}})()');
    assert.ok(geometry.hit&&geometry.top>=0&&geometry.bottom<=560&&!geometry.overflow,'Chat lifecycle control reachable at minimum size');
    await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:geometry.x,y:geometry.y});
    await send('Input.dispatchMouseEvent',{type:'mousePressed',x:geometry.x,y:geometry.y,button:'left',clickCount:1});
    await send('Input.dispatchMouseEvent',{type:'mouseReleased',x:geometry.x,y:geometry.y,button:'left',clickCount:1});
    await until(()=>fixture.state.taskHistoryStates[ids[0]]==='archived','Pointer archive in Chat');
    counts.taskManagementMinimumGeometry={width:780,height:560,scale:1.5,actionHit:true,pointerArchive:true};
  } finally {
    if(emulated)await send('Emulation.clearDeviceMetricsOverride');
    fixture.state.conversations=fixture.state.conversations.filter(item=>!ids.includes(item.taskId||item.rootId||item.id));
    fixture.state.workflows=fixture.state.workflows.filter(item=>item.id!==templateId);
    for(const id of ids)delete fixture.state.taskHistoryStates[id];
    fixture.send({type:'conversations.updated',data:{healthy:true}});
    await click('[data-space="chat"]');
    await select('#next-chat-bucket','active');
    await evaluate('document.querySelector("#next-chat-search").value="";document.querySelector("#next-chat-search").dispatchEvent(new Event("input",{bubbles:true}));true');
  }
}
