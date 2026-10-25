import assert from 'node:assert/strict';

/** Runs inside the caller's disposable hidden browser and synthetic fixture. */
export async function exerciseActivityVisual({evaluate,until,fixture,counts}) {
  const click=selector=>evaluate('document.querySelector('+JSON.stringify(selector)+').click();true');
  const writes=()=>({runs:fixture.state.submittedRuns.length,workflows:fixture.state.postedWorkflows.length,deletes:fixture.state.workflowDeletes.length,tasks:fixture.state.taskLifecycleMutations.length});
  const before=writes();
  await click('[data-space="activity"]');
  await until(()=>evaluate('Boolean(document.querySelector("#next-activity-tab-workflows"))'),'Activity views ready');
  await click('#next-activity-tab-workflows');
  await evaluate('(()=>{const field=document.querySelector("#next-workflow-choice");field.value="sample-workflow";field.dispatchEvent(new Event("change",{bubbles:true}));return true})()');
  await until(()=>evaluate('document.querySelectorAll("#next-workflow-map [data-stage-id]").length===3'),'Read-only workflow map ready');
  assert.equal(await evaluate('document.querySelectorAll(".next-activity-workspace [role=tabpanel]:not([hidden])").length'),1);
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

  const originalPrompt=await evaluate('document.querySelector("#next-workflow-prompt").value');
  const draft='Unsubmitted Activity navigation draft';
  await evaluate('(()=>{document.querySelector("#next-workflow-launch").open=true;const field=document.querySelector("#next-workflow-prompt");field.value='+JSON.stringify(draft)+';field.dispatchEvent(new Event("input",{bubbles:true}));return true})()');
  const workflowReads=fixture.state.workflowIndexRequests;
  await evaluate('document.querySelector("#next-activity-tab-workflows").dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowRight",bubbles:true}));true');
  await until(()=>evaluate('document.querySelector("#next-activity-tab-tasks").getAttribute("aria-selected")==="true" && !document.querySelector("#next-activity-tasks").hidden'),'Keyboard reaches task timeline');
  assert.equal(await evaluate('document.querySelector("#next-activity-workflows").hidden'),true);
  await until(()=>evaluate('Boolean(document.querySelector("#next-activity-tasks-list.next-task-timeline"))'),'Task timeline presentation');
  await click('#next-activity-tab-apps');
  await until(()=>evaluate('!document.querySelector("#next-activity-native").hidden && document.querySelector("#next-activity-tasks").hidden'),'Applications selected alone');
  assert.equal(fixture.state.workflowIndexRequests,workflowReads,'Hidden workflows do not refresh when another Activity surface enters.');
  await click('[data-space="chat"]');await click('[data-space="activity"]');
  assert.equal(await evaluate('document.querySelector("#next-activity-tab-apps").getAttribute("aria-selected")'),'true','Activity retains its selected surface across workspace navigation.');
  await click('#next-activity-tab-workflows');
  await until(()=>evaluate('document.querySelectorAll("#next-workflow-map [data-stage-id]").length===3'),'Workflow map returns');
  assert.equal(await evaluate('document.querySelector("#next-workflow-prompt").value'),draft,'Launch draft survives panel and workspace navigation.');
  assert.deepEqual(writes(),before);

  await evaluate('document.querySelector("#next-workflow-run-lookup").open=true;document.querySelector("#next-workflow-run-id").value="sample-run-49";document.querySelector("#next-workflow-inspect").click();true');
  await until(()=>evaluate('document.querySelector("#next-workflow-focus-kind").textContent==="Selected run" && document.querySelector("#next-workflow-focus-meta").textContent.includes("sample-run-49")'),'Selected saved run becomes primary');
  assert.equal(await evaluate('document.querySelector("#next-workflow-map [data-stage-id=agent]").dataset.state'),'running','Map status comes from the actual saved run node.');
  assert.equal(await evaluate('document.querySelector("#next-workflow-stop").hidden'),false);
  assert.equal(await evaluate('Boolean(document.querySelector("#next-workflow-stage-edit"))'),false,'Saved run inspection does not offer mutation of its snapshot.');
  await evaluate('document.querySelector("#next-workflow-run-actions").open=true;true');
  await click('#next-workflow-template');
  await until(()=>evaluate('document.querySelectorAll("#next-workflow-map [data-stage-id]").length===3 && document.querySelector("#next-workflow-focus-kind").textContent==="Saved workflow"'),'Explicitly return to template');
  assert.deepEqual(writes(),before,'Inspecting saved runs and changing Activity surfaces cannot dispatch writes.');
  await evaluate('(()=>{const field=document.querySelector("#next-workflow-prompt");field.value='+JSON.stringify(originalPrompt)+';field.dispatchEvent(new Event("input",{bubbles:true}));document.querySelector("#next-workflow-launch").open=false;document.querySelector("#next-workflow-run-lookup").open=false;return true})()');
  counts.activityVisual={selectedSurfaceOnly:true,keyboardTabs:true,readOnlyMap:true,explicitEdit:true,draftPreserved:true,actualRunStatus:true,noImplicitWrites:true};
}
