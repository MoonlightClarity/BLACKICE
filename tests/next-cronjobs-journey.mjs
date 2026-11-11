import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';

async function capture(send,name){
  if(!process.env.BLACKICE_NEXT_CRONJOBS_SCREENSHOT_DIR)return;
  const image=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
  await writeFile(join(process.env.BLACKICE_NEXT_CRONJOBS_SCREENSHOT_DIR,name+'.png'),Buffer.from(image.data,'base64'));
}

/** Runs inside the caller's disposable hidden browser and synthetic fixture. */
export async function exerciseWorkflowManager({evaluate,send,until,fixture,counts}) {
  const click=selector=>evaluate('document.querySelector('+JSON.stringify(selector)+').click();true');
  const writes=()=>({runs:fixture.state.submittedRuns.length,workflows:fixture.state.postedWorkflows.length,deletes:fixture.state.workflowDeletes.length,tasks:fixture.state.taskLifecycleMutations.length});
  const before=writes();
  await until(()=>evaluate('Boolean(document.querySelector("#next-workflow-choice option[value=sample-workflow]"))'),'Workflow catalog loaded after lazy selection');
  await evaluate('(()=>{const field=document.querySelector("#next-workflow-choice");field.value="sample-workflow";field.dispatchEvent(new Event("change",{bubbles:true}));return true})()');
  await until(()=>evaluate('document.querySelectorAll("#next-workflow-map [data-stage-id]").length===3'),'Read-only workflow map ready');

  await evaluate('document.querySelector("#next-workflow-launch").open=false;document.querySelector("#next-workflow-edit-details").open=false;document.querySelector("#next-workflow-graph-author").open=false;true');
  await evaluate('document.querySelector("#next-workflow-map [data-stage-id=agent]").dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true}));true');
  assert.equal(await evaluate('document.querySelector("#next-workflow-map [data-stage-id=agent]").getAttribute("aria-pressed")'),'true');
  assert.equal(await evaluate('[...document.querySelectorAll("#next-workflow-map [data-stage-id]")].filter(node=>node.tabIndex===0).length'),1,'Map has one keyboard entry point.');
  await evaluate('document.querySelector("#next-workflow-map [data-stage-id=agent]").dispatchEvent(new KeyboardEvent("keydown",{key:"End",bubbles:true}));true');
  assert.equal(await evaluate('document.activeElement?.dataset.stageId'),'output');
  await evaluate('document.querySelector("#next-workflow-map [data-stage-id=output]").dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowLeft",bubbles:true}));true');
  assert.equal(await evaluate('document.activeElement?.dataset.stageId'),'agent');
  assert.match(await evaluate('document.querySelector("#next-workflow-stage-inspector").textContent'),/Review saved fixture evidence/);
  assert.equal(await evaluate('document.querySelector("#next-workflow-edit-details").open'),false,'Inspecting a stage cannot open the editor.');
  assert.equal(await evaluate('document.querySelector("#next-workflow-graph-author").open'),false);
  assert.deepEqual(writes(),before,'Selecting the map cannot create, edit, start or delete work.');
  await click('#next-workflow-stage-edit');
  assert.equal(await evaluate('document.querySelector("#next-workflow-edit-details").open'),true);
  assert.equal(await evaluate('document.querySelector("#next-workflow-edit-node").value'),'agent');
  await evaluate('document.querySelector("#next-workflow-edit-details").open=false;true');
  assert.deepEqual(writes(),before,'Opening the explicit editor cannot save changes.');

  await capture(send,'cronjobs-workflow-manager-desktop');
  for(const width of [780,390]){
    await send('Emulation.setDeviceMetricsOverride',{width,height:560,deviceScaleFactor:1.5,mobile:false});
    try{
      await evaluate('document.querySelector("#next-toast").replaceChildren();true');
      for(const selector of ['#next-workflows-back','#next-workflow-choice','#next-workflow-new']){
        const geometry=await evaluate('(()=>{const n=document.querySelector('+JSON.stringify(selector)+');n.scrollIntoView({block:"center"});const r=n.getBoundingClientRect();return {hit:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===n,top:r.top,bottom:r.bottom,overflow:document.documentElement.scrollWidth>innerWidth+1}})()');
        assert.ok(geometry.hit&&geometry.top>=0&&geometry.bottom<=560&&!geometry.overflow,selector+' reachable at '+width+'px');
      }
      if(width===390)await capture(send,'cronjobs-workflow-manager-narrow');
    }finally{await send('Emulation.clearDeviceMetricsOverride');}
  }
  const originalPrompt=await evaluate('document.querySelector("#next-workflow-prompt").value');
  const draft='Unsubmitted workflow manager navigation draft';
  await evaluate('(()=>{document.querySelector("#next-workflow-launch").open=true;const field=document.querySelector("#next-workflow-prompt");field.value='+JSON.stringify(draft)+';field.dispatchEvent(new Event("input",{bubbles:true}));return true})()');
  await click("#next-workflows-back");
  await until(()=>evaluate('!document.querySelector("[data-workspace=cronjobs]").hidden'),"Back to Cronjobs");
  await click("#next-cronjobs-manage-workflows");
  await until(()=>evaluate('document.querySelectorAll("#next-workflow-map [data-stage-id]").length===3'),'Workflow map returns');
  assert.equal(await evaluate('document.querySelector("#next-workflow-prompt").value'),draft,'Launch draft survives panel and workspace navigation.');
  assert.deepEqual(writes(),before);

  await evaluate('document.querySelector("#next-workflow-run-lookup").open=true;document.querySelector("#next-workflow-run-id").value="sample-run-49";document.querySelector("#next-workflow-inspect").click();true');
  await until(()=>evaluate('document.querySelector("#next-workflow-focus-kind").textContent==="Selected run" && document.querySelector("#next-workflow-focus-meta").textContent.includes("sample-run-49")'),'Selected saved run becomes primary');
  assert.equal(await evaluate('document.querySelector("#next-workflow-map [data-stage-id=agent]").dataset.state'),'running','Map status comes from the actual saved run node.');
  assert.equal(await evaluate('document.querySelector("#next-workflow-stop").hidden'),false);
  assert.equal(await evaluate('Boolean(document.querySelector("#next-workflow-stage-edit"))'),false,'Saved run inspection does not offer mutation of its snapshot.');
  await evaluate('document.querySelector("#next-workflow-run-actions").open=true;true');
  const stopsBefore=fixture.calls.filter(call=>call==='POST /api/runs/sample-run-49/cancel').length;
  await click('#next-workflow-stop');
  await until(()=>fixture.calls.filter(call=>call==='POST /api/runs/sample-run-49/cancel').length===stopsBefore+1,'Explicit Stop targets the selected saved run once');
  await until(()=>evaluate('!document.querySelector("#next-workflow-template").disabled'),'Run action response settled');
  counts.workflowStopRequested=true;
  await click('#next-workflow-template');
  await until(()=>evaluate('document.querySelectorAll("#next-workflow-map [data-stage-id]").length===3 && document.querySelector("#next-workflow-focus-kind").textContent==="Saved workflow"'),'Explicitly return to template');
  assert.deepEqual(writes(),before,'Inspecting saved runs and changing workflow manager surfaces must not create, edit, run, or delete workflows or tasks.');
  await evaluate('(()=>{const field=document.querySelector("#next-workflow-prompt");field.value='+JSON.stringify(originalPrompt)+';field.dispatchEvent(new Event("input",{bubbles:true}));document.querySelector("#next-workflow-launch").open=false;document.querySelector("#next-workflow-run-lookup").open=false;return true})()');
  counts.workflowManagerVisual={readOnlyMap:true,explicitEdit:true,draftPreserved:true,actualRunStatus:true,noImplicitWrites:true};
}

export async function exerciseCronjobs({evaluate,send,until,fixture,counts}) {
  const click=selector=>evaluate('document.querySelector('+JSON.stringify(selector)+').click();true');
  const field=(selector,value)=>evaluate('(()=>{const f=document.querySelector('+JSON.stringify(selector)+');f.value='+JSON.stringify(value)+';f.dispatchEvent(new Event("input",{bubbles:true}));return true})()');
  const selected=tab=>until(()=>evaluate('document.querySelector("#next-tasks-tab-'+tab+'")?.getAttribute("aria-selected")==="true"'),'Cronjobs '+tab);
  const id=fixture.state.deployments[0].id;
  await until(()=>evaluate('Boolean(document.querySelector("[data-schedule-inspect]"))'),'Saved cronjob visible');
  assert.equal(await evaluate('document.querySelector(".next-tab[data-space=cronjobs]").textContent.trim()'),'Cronjobs');
  assert.equal(await evaluate('document.querySelectorAll(".next-tab[data-space=tasks],.next-tab[data-space=activity]").length'),0);
  await field('#next-tasks-form [name=input]','Unsubmitted cronjob draft');
  const writes=fixture.state.scheduledWrites.length;
  await click('#next-tasks-preview');
  await until(()=>evaluate('document.querySelector("#next-tasks-preview-output").textContent.includes("2026-11-12 09:00 UTC")'),'Actual preview occurrence shown');
  for(const hash of ['tasks','activity','tasks']){
    await evaluate('location.hash='+JSON.stringify(hash)+';true');
    await until(()=>evaluate('location.hash==="#cronjobs"'),'Legacy hash normalized');
    assert.equal(await evaluate('document.querySelector("#next-tasks-form [name=input]").value'),'Unsubmitted cronjob draft');
  }
  await click('#next-tasks-close-create');await click('#next-tasks-new-schedule');
  assert.equal(await evaluate('document.querySelector("#next-tasks-form [name=input]").value'),'Unsubmitted cronjob draft');
  await click('[data-space="settings"]');await click('[data-space="cronjobs"]');
  await until(()=>evaluate('!document.querySelector("[data-workspace=cronjobs]").hidden'),'Cronjobs reentry');
  assert.equal(await evaluate('document.querySelector("#next-tasks-form [name=input]").value'),'Unsubmitted cronjob draft');
  assert.equal(fixture.state.scheduledWrites.length,writes);
  await click('[data-schedule-inspect="'+id+'"]');await click('[data-schedule-edit-open="'+id+'"]');
  const edit='[data-schedule-edit="'+id+'"]';
  await field(edit+' [name=name]','Unsaved cronjob edit');
  await click('[data-space="chat"]');await click('[data-space="cronjobs"]');
  assert.equal(await evaluate('document.querySelector('+JSON.stringify(edit+' [name=name]')+').value'),'Unsaved cronjob edit','Schedule draft survives workspace navigation');
  await click('[data-schedule-cancel="'+id+'"]');
  assert.equal(fixture.state.deployments[0].name,'Fixture scheduled review','Cancel must discard edits without persistence');
  await click('[data-schedule-edit-open="'+id+'"]');
  await field(edit+' [name=name]','Revised scheduled review');
  await field(edit+' [name=input]','Revised saved evidence instructions');
  await evaluate('document.querySelector('+JSON.stringify(edit)+').requestSubmit();document.querySelector('+JSON.stringify(edit)+').requestSubmit();true');
  await until(()=>fixture.state.scheduleMutations.length===1,'Explicit schedule edit saved once');
  assert.equal(fixture.state.deployments[0].name,'Revised scheduled review');
  assert.equal(fixture.state.deployments[0].input,'Revised saved evidence instructions');
  assert.equal(fixture.state.scheduleMutations[0].body.expectedRevision,1);
  await until(()=>evaluate('document.querySelector('+JSON.stringify('[data-schedule-toggle="'+id+'"]')+')?.disabled===false'),'Enable available');
  await click('[data-schedule-toggle="'+id+'"]');
  await until(()=>fixture.state.deployments[0].enabled,'Cronjob enabled');
  await until(()=>evaluate('!document.querySelector("#next-tasks-pause").disabled'),'Pause available');
  await click('#next-tasks-pause');await until(()=>fixture.state.operationsPaused,'Scheduler paused');
  await until(()=>evaluate('document.querySelector("#next-tasks-info").textContent.includes("Schedules paused")'),'Pause receipt visible');
  await click('#next-tasks-resume');await until(()=>!fixture.state.operationsPaused,'Scheduler resumed');
  await until(()=>evaluate('document.querySelector("#next-tasks-info").textContent.includes("Schedules ready")'),'Resume receipt visible');
  fixture.state.jobs.push(...Array.from({length:40},(_,i)=>({id:'cronjob-result-'+i,deploymentId:id,deploymentName:'Revised scheduled review',
    deploymentRevision:2,status:'completed',source:'schedule',createdAt:'2026-11-11T12:00:00Z',
    runId:'sample-run-49',attempts:[{number:1,runId:'sample-run-49',status:'completed'}],
    ...(i===0?{delivery:{state:'available',revision:1,sourceRunId:'sample-run-49',outcome:'completed',availableAt:'2026-11-11T12:01:00Z',preview:'Verified synthetic cronjob result'}}:{})})));
  await click('#next-tasks-refresh');
  await evaluate('document.querySelector("#next-tasks-tab-schedules").dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowRight",bubbles:true}));true');
  await selected('results');
  await until(()=>evaluate('document.querySelector("#next-tasks-results").textContent.includes("Verified synthetic cronjob result")'),'Local Results receipt');
  assert.equal(await evaluate('document.querySelectorAll(".next-task-panel:not([hidden])").length'),1);
  await click('[data-result-acknowledge="cronjob-result-0"]');
  await until(()=>fixture.state.resultAcknowledgements.length===1,'Result explicitly acknowledged once');
  await until(()=>evaluate('document.querySelector("#next-tasks-results").textContent.includes("Reviewed")'),'Reviewed receipt visible');
  await evaluate('document.querySelector("#next-tasks-tab-results").dispatchEvent(new KeyboardEvent("keydown",{key:"End",bubbles:true}));true');
  await selected('jobs');
  await until(()=>evaluate('document.querySelectorAll("#next-tasks-jobs [data-job-id]").length===35'),'Bounded job history');
  await click('#next-tasks-jobs-more');
  assert.equal(await evaluate('document.querySelectorAll("#next-tasks-jobs [data-job-id]").length'),40);
  await evaluate('document.querySelector("[data-job-inspect]").open=true;true');
  assert.match(await evaluate('document.querySelector("[data-job-inspect]").textContent'),/Schedule revision.*2/);
  await click('[data-job-run-id="sample-run-49"]');
  await until(()=>evaluate('document.querySelector(".next-tab[data-space=chat]").getAttribute("aria-selected")==="true"'),'History opens saved run in Chat');
  await click('[data-space="cronjobs"]');await selected('jobs');
  await evaluate('document.querySelector("#next-tasks-tab-jobs").dispatchEvent(new KeyboardEvent("keydown",{key:"Home",bubbles:true}));true');await selected('schedules');
  await click('#next-tasks-close-create');
  await capture(send,'cronjobs-desktop');
  for(const width of [780,390]){
  await send('Emulation.setDeviceMetricsOverride',{width,height:560,deviceScaleFactor:1.5,mobile:false});
  try{
    await evaluate('document.querySelector("#next-toast").replaceChildren();true');
    for(const selector of ['#next-cronjobs-manage-workflows','#next-tasks-new-schedule','#next-tasks-tab-results']){
      const geometry=await evaluate('(()=>{const n=document.querySelector('+JSON.stringify(selector)+');n.scrollIntoView({block:"center"});const r=n.getBoundingClientRect();return {hit:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===n,top:r.top,bottom:r.bottom,overflow:document.documentElement.scrollWidth>innerWidth+1}})()');
      assert.ok(geometry.hit&&geometry.top>=0&&geometry.bottom<=560&&!geometry.overflow,selector+' is reachable at minimum size');
    }
    if(width===390)await capture(send,'cronjobs-narrow');
  }finally{await send('Emulation.clearDeviceMetricsOverride');}
  }
  assert.equal(fixture.state.scheduledWrites.length,writes,'Navigation and inspection never create additional cronjobs');
  counts.cronjobsLifecycle={legacyHashes:true,draftPreserved:true,edit:true,cancel:true,enable:true,pauseResume:true,results:true,acknowledgeOnce:true,historyPagination:true,keyboard:true,narrow:true};
}
