import assert from 'node:assert/strict';

/** Real current modular Planning UI over the synthetic revisioned HTTP fixture. */
export async function exerciseVisualPlanning({evaluate,send,until,fixture,counts}){
  const click=selector=>evaluate('document.querySelector('+JSON.stringify(selector)+').click();true');
  const field=()=>evaluate('document.querySelector(\'[data-field-key="child:prompt"]\')?.value');
  const writes=()=>fixture.state.planningMutations.length;
  await until(()=>evaluate('Boolean(document.querySelector("button[data-page=steps]"))'),'Current Planning request overview');
  assert.ok(fixture.calls.includes('GET /api/planning-browser/requests/request-current'));
  await click('button[data-page=steps]');
  await until(()=>evaluate('document.querySelectorAll("[data-node-id]").length===2'),'Saved modular outline');
  await click('[data-node-id=child]');
  await until(()=>field().then(value=>value==='Follow the saved evidence.'),'Selected module uses saved original ID');
  assert.equal(await evaluate('document.querySelectorAll(".pb-inspector").length'),1);
  await click('[data-view=graph]');
  await until(()=>evaluate('document.querySelectorAll(".pb-graph-node").length===2'),'Current modular graph');
  assert.equal(await evaluate('document.querySelector("[data-node-id=child]").getAttribute("aria-selected")'),'true');
  await send('Emulation.setDeviceMetricsOverride',{width:780,height:560,deviceScaleFactor:1.5,mobile:false});
  try{
    const geometry=await evaluate('(()=>{const v=document.querySelector(".pb-graph");v.scrollIntoView({block:"center"});return {overflow:document.documentElement.scrollWidth>innerWidth+1,width:v.getBoundingClientRect().width,scrolls:v.scrollWidth>v.clientWidth}})()');
    assert.equal(geometry.overflow,false,'Graph must not overflow the desktop viewport.');
    assert.ok(geometry.width>100&&geometry.width<780&&geometry.scrolls,'Module graph scrolls inside its bounded canvas.');
  }finally{await send('Emulation.clearDeviceMetricsOverride');}
  await click('[data-view=outline]');
  assert.equal(await evaluate('document.querySelector("[data-node-id=child]").getAttribute("aria-selected")'),'true');
  assert.equal(writes(),0,'Inspecting outline and graph must be read-only.');
  await evaluate('(()=>{document.querySelector("[data-disclosure-key=definition-editor]").open=true;const f=document.querySelector(\'[data-field-key="child:prompt"]\');f.value="Visual inspector prompt";f.dispatchEvent(new Event("input",{bubbles:true}));return true})()');
  await click('.next-tab[data-space=chat]');
  await click('.next-tab[data-space=planning]');
  await until(()=>field().then(value=>value==='Visual inspector prompt'),'Unsaved Planning draft survives workspace navigation');
  assert.equal(writes(),0,'Draft navigation must not save.');
  await evaluate('document.querySelector("[data-disclosure-key=definition-editor] form").requestSubmit();true');
  await until(()=>writes()===1,'Explicit module prompt save');
  const saved=fixture.state.planningDocuments.get('request-current').nodes.find(node=>node.id==='child');
  assert.equal(saved.prompt,'Visual inspector prompt');
  assert.equal(saved.revision,2);
  assert.equal(fixture.state.planningMutations[0].body.expectedNodeRevision,1);
  assert.deepEqual(fixture.state.planningDocuments.get('request-current').responses,[],'Saving a prompt cannot fabricate a response or complete work.');
  await until(()=>evaluate('!document.querySelector("[data-disclosure-key=definition-editor] button[type=submit]")?.disabled'),'Saved module is settled');
  await evaluate('[...document.querySelectorAll(".pb-inspector button")].find(button=>button.textContent==="+ Expand into a child module").click();true');
  await until(()=>evaluate('Boolean(document.querySelector("#pb-node-title"))'),'Create current child module form');
  await evaluate('(()=>{for(const [id,value]of [["pb-node-title","Check a further consequence"],["pb-node-prompt","What evidence would reverse this choice?"]]){const f=document.getElementById(id);f.value=value;f.dispatchEvent(new Event("input",{bubbles:true}));}return true})()');
  assert.equal(writes(),1,'New child remains a draft before explicit Add module.');
  await evaluate('document.querySelector("[data-action=create-node]").closest("form").requestSubmit();true');
  await until(()=>writes()===2,'Explicit current module creation');
  const created=fixture.state.planningDocuments.get('request-current').nodes.at(-1);
  assert.equal(created.parentId,'child');
  assert.equal(created.title,'Check a further consequence');
  assert.equal(fixture.state.planningMutations[1].body.expectedParentRevision,2);
  await evaluate('(()=>{const view=document.querySelector("#pb-conversation-view");view.value="archived";view.dispatchEvent(new Event("change",{bubbles:true}));return true})()');
  await until(()=>evaluate('Boolean(document.querySelector("[data-conversation-id=planning-archive]"))'),'Archived conversation filter');
  await click('[data-conversation-id=planning-archive]');
  await until(()=>evaluate('document.querySelector(".pb-request-picker select")?.value==="request-archive" && Boolean(document.querySelector("button[data-page=steps]"))'),'Archived original request selected');
  await click('button[data-page=steps]');
  await until(()=>evaluate('Boolean(document.querySelector("[data-node-id=child]"))'),'Archived modules available for inspection');
  await click('[data-node-id=child]');
  await until(()=>field().then(value=>value==='Follow the saved evidence.'),'Archived module reads original saved prompt');
  assert.equal(writes(),2,'Archived inspection must not mutate a request.');
  assert.equal(fixture.calls.some(call=>call.endsWith('/run')&&call.includes('planning-browser')),false,'No provider dispatch is needed for browser acceptance.');
  counts.planning=true;
  counts.visualPlanning={lazySavedTree:true,originalModuleIds:true,oneModuleInspector:true,
    inspectionReadOnly:true,explicitRevisionSave:true,containedGraphAt780:true,draftNavigation:true,
    explicitChildCreation:true,archivedInspection:true};
}
