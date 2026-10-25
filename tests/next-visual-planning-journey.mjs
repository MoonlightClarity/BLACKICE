import assert from 'node:assert/strict';

/** Real browser interactions over metadata-only list summaries and a lazy saved tree. */
export async function exerciseVisualPlanning({evaluate,send,until,fixture,counts}){
  await until(()=>evaluate('document.querySelectorAll("#next-planning-map [data-plan-map-node]").length===5'),'Metadata-only plan hydrated into original saved nodes');
  assert.ok(fixture.calls.includes('GET /api/tasks/sample-run-0'));
  const writes=()=>fixture.calls.filter(call=>call.startsWith('POST /api/tasks/')).length;
  const before=writes();
  await evaluate('document.querySelector("[data-plan-map-node=step-b]").dispatchEvent(new MouseEvent("click",{bubbles:true}));true');
  await until(()=>evaluate('document.querySelector("textarea[data-step-id=step-b]")?.value==="Follow the saved evidence."'),'Selected step inspector uses exact saved ID');
  assert.equal(await evaluate('document.querySelectorAll("#next-planning-edit textarea[data-step-id]").length'),1,'Only the selected step gets an editor.');
  await evaluate('document.querySelector("#next-plan-zoom-in").click();document.querySelector("#next-plan-fit").click();document.querySelector("#next-plan-outline-view").click();true');
  await until(()=>evaluate('Boolean(document.querySelector(".next-plan-outline"))'),'Accessible outline alternative');
  await evaluate('document.querySelector("#next-plan-map-view").click();true');
  await until(()=>evaluate('Boolean(document.querySelector('+JSON.stringify('#next-planning-map [data-plan-map-node][tabindex="0"]')+'))'),'Map has a keyboard entry point');
  assert.equal(writes(),before,'Inspecting, fitting, zooming and changing views cannot edit execution state.');
  await evaluate('document.querySelector("[data-plan-map-node=step-b]").dispatchEvent(new MouseEvent("click",{bubbles:true}));true');
  await evaluate('(()=>{const field=document.querySelector("textarea[data-step-id=step-b]");field.value="Visual inspector note";field.dispatchEvent(new Event("input",{bubbles:true}));document.querySelector("#next-planning-edit").requestSubmit();return true})()');
  await until(()=>fixture.state.visualPlan.steps.find(step=>step.id==='step-b').note==='Visual inspector note','Explicit inspector Save persisted to the original plan');
  assert.equal(writes(),before+1);
  assert.equal(fixture.state.visualPlan.steps.find(step=>step.id==='step-b').status,'active','Saving a note cannot complete a step.');
  await evaluate('for(let i=0;i<3;i++)document.querySelector("#next-plan-zoom-in").click();true');
  await send('Emulation.setDeviceMetricsOverride',{width:780,height:560,deviceScaleFactor:1.5,mobile:false});
  try{
    const geometry=await evaluate('(()=>{const viewport=document.querySelector(".next-plan-map-viewport");viewport.scrollIntoView({block:"center"});const r=viewport.getBoundingClientRect();return {width:r.width,overflow:document.documentElement.scrollWidth>innerWidth+1,scrolls:viewport.scrollWidth>viewport.clientWidth,svgWidth:viewport.querySelector("svg").getBoundingClientRect().width}})()');
    assert.equal(geometry.overflow,false,'Large plans scroll inside their canvas, never the whole page.');
    assert.ok(geometry.width>400&&geometry.width<780);
    assert.ok(geometry.scrolls&&geometry.svgWidth>geometry.width,'Map labels retain readable scale in the compact window.');
    counts.visualPlanning={lazySavedTree:true,originalStepIds:true,oneStepInspector:true,inspectionReadOnly:true,explicitRevisionSave:true,containedMapAt780:true};
  }finally{await send('Emulation.clearDeviceMetricsOverride');}
}
