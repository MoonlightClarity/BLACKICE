import assert from 'node:assert/strict';

/** Runs inside the caller's existing headless session and disposable stores. */
export async function exerciseIdentitySettings({evaluate,send,until,fixture,counts}) {
  const {identity}=await fixture.settings();
  const initialSoul=await identity.read('soul'),initialUser=await identity.read('user');
  const requests=()=>fixture.state.settingsPanelRequests;
  const reads=path=>requests().filter(value=>value==='GET '+path).length;
  const writes=()=>fixture.state.settingsPanelMutations.filter(value=>value.path.startsWith('/api/identity/'));
  const beforeWrites=writes().length,beforeUserReads=reads('/api/identity/user');
  const beforeHistoryReads=reads('/api/identity/soul/versions');
  const click=selector=>evaluate('document.querySelector('+JSON.stringify(selector)+').click();true');
  const value=()=>evaluate('document.querySelector("#next-identity-content").value');
  const input=content=>evaluate('(()=>{const field=document.querySelector("#next-identity-content");field.value='+JSON.stringify(content)+';field.dispatchEvent(new Event("input",{bubbles:true}));return true})()');
  const selected=name=>evaluate('document.querySelector("#next-settings-section-'+name+'").getAttribute("aria-selected")==="true"');
  const ready=expected=>until(()=>evaluate('document.querySelector("#next-identity-content")?.disabled===false && document.querySelector("#next-identity-content").value==='+JSON.stringify(expected)),'Identity file ready');
  const saved=async(content,label)=>until(async()=>{
    const actual=await identity.read('soul');return actual.content===content?actual:null;
  },label);

  // Opening, editing and navigating remain reads until an explicit Save.
  await click('#next-settings-section-identity');await ready(initialSoul.content);
  assert.equal(reads('/api/identity/user'),beforeUserReads,'User profile must load only after its tab opens.');
  assert.equal(reads('/api/identity/soul/versions'),beforeHistoryReads,'Version history must stay lazy.');
  assert.match(await evaluate('document.querySelector(".next-identity-settings").textContent'),/next agent turn/);
  await input('Soul draft kept through settings navigation.');
  await evaluate('(()=>{const field=document.querySelector("#next-identity-content");field.focus();field.setSelectionRange(field.value.length,field.value.length);return true})()');
  await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r'});
  await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
  const soulDraft=await value();assert.match(soulDraft,/^Soul draft kept through settings navigation\.\n$/);
  await click('#next-identity-user');await ready(initialUser.content);
  const userDraft='User profile draft kept without saving.';await input(userDraft);
  await click('#next-settings-section-models');
  await until(()=>evaluate('Boolean(document.querySelector("#next-provider-root"))'),'Models section constructed on demand');
  await click('#next-settings-section-general');await until(()=>selected('general'),'General settings selected');
  await click('#next-settings-section-identity');await ready(userDraft);
  await click('#next-identity-soul');await ready(soulDraft);
  await click('.next-tab[data-space=chat]');
  await until(()=>evaluate('document.querySelector(".next-tab[data-space=chat]").getAttribute("aria-selected")==="true"'),'Leave Identity workspace');
  await click('.next-tab[data-space=settings]');await ready(soulDraft);
  assert.equal(writes().length,beforeWrites,'Typing, Enter, section switches and workspace switches must never save.');
  assert.equal((await identity.read('soul')).revision,initialSoul.revision);
  assert.equal((await identity.read('user')).content,initialUser.content);
  counts.identityDrafts={lazyFiles:true,lazyHistory:true,enterDoesNotSave:true,sectionDrafts:true,workspaceDrafts:true};

  // Real file revisions reject a stale write and keep the user's local text.
  await until(()=>evaluate('document.querySelector("#next-identity-save").disabled===false'),'Identity Save ready');
  await click('#next-identity-save');const firstSaved=await saved(soulDraft,'Soul saved to actual identity store');
  await until(()=>evaluate('document.querySelector("#next-identity-notice").textContent.includes("saved · revision '+firstSaved.revision+'")'),'Identity save receipt');
  assert.equal(firstSaved.provenance.source,'user');assert.equal(writes().length,beforeWrites+1);
  const conflictingDraft='Keep this identity draft after a real file conflict.';await input(conflictingDraft);
  await until(()=>evaluate('document.querySelector("#next-identity-save").disabled===false'),'Identity draft ready before independent file edit');
  const external=await identity.update({kind:'soul',content:'Independent file edit for the identity acceptance fixture.',
    expectedRevision:firstSaved.revision,expectedHash:firstSaved.diskHash,provenance:{source:'user'}});
  // Omit an event here to exercise the genuine HTTP409 path before refresh.
  await click('#next-identity-save');
  await until(()=>evaluate('document.querySelector("#next-identity-conflict").hidden===false && document.querySelector("#next-identity-notice").dataset.error==="true"'),'Stale identity write rejected');
  assert.equal(await value(),conflictingDraft);assert.equal((await identity.read('soul')).revision,external.revision);
  assert.equal(writes().length,beforeWrites+2,'A rejected save must not be automatically replayed.');
  await click('#next-identity-keep-draft');
  await until(()=>evaluate('document.querySelector("#next-identity-save").disabled===false'),'Kept identity draft can be explicitly saved');
  await click('#next-identity-save');const conflictSaved=await saved(conflictingDraft,'Kept draft saved against current file revision');
  await until(()=>evaluate('document.querySelector("#next-identity-state").textContent.includes("Saved · revision '+conflictSaved.revision+'")'),'Conflict resolution receipt settled');
  const conflictWrite=writes().at(-1);
  assert.equal(conflictWrite.body.expectedRevision,external.revision);assert.equal(conflictWrite.body.expectedHash,external.diskHash);
  assert.equal(reads('/api/identity/soul/versions'),beforeHistoryReads);
  counts.identitySaveConflict={durableSave:true,realConflict:true,draftKept:true,noReplay:true};

  // History reads metadata; Restore writes a new current guarded revision.
  await click('#next-identity-history');
  await until(()=>evaluate('Boolean(document.querySelector("[data-identity-revision=\\"'+initialSoul.revision+'\\"]"))'),'Identity version history loaded on demand');
  assert.equal(reads('/api/identity/soul/versions'),beforeHistoryReads+1);
  const history=await evaluate('(()=>{const rows=document.querySelector("#next-identity-versions");return {count:rows.children.length,text:rows.textContent,current:document.querySelector("[data-identity-revision=\\"'+conflictSaved.revision+'\\"]").disabled}})()');
  assert.ok(history.count<=10,'History mounts one bounded group of revision rows.');assert.equal(history.current,true);
  assert.equal(history.text.includes(conflictingDraft),false,'History must not mount full file content.');
  await until(()=>evaluate('document.querySelector("[data-identity-revision=\\"'+initialSoul.revision+'\\"]").disabled===false'),'Retained identity revision can be restored');
  await click('[data-identity-revision="'+initialSoul.revision+'"]');
  const restored=await saved(initialSoul.content,'Original identity revision restored in actual store');
  await ready(initialSoul.content);
  assert.ok(restored.revision>conflictSaved.revision);assert.equal(restored.provenance.restoredFrom,initialSoul.revision);
  const restoreWrite=writes().filter(item=>item.path.endsWith('/restore')).at(-1);
  assert.equal(restoreWrite.body.revision,initialSoul.revision);assert.equal(restoreWrite.body.expectedRevision,conflictSaved.revision);
  await until(()=>evaluate('document.querySelector("#next-identity-notice").textContent.includes("Restored revision '+initialSoul.revision+' as revision '+restored.revision+'")'),'Identity restore receipt shown');
  assert.equal((await identity.read('user')).content,initialUser.content,'An unsaved profile draft must stay unsaved.');
  counts.identityHistoryRestore={lazyMetadata:true,boundedRows:true,currentRevision:true,durableRestore:true};

  // Chromium input and hit testing at the desktop minimum; no OS input claim.
  let emulated=false;
  try{
    await send('Emulation.setDeviceMetricsOverride',{width:780,height:560,deviceScaleFactor:1.5,mobile:false});emulated=true;
    await evaluate('document.querySelector("#next-toast").replaceChildren();true');
    const geometry=async selector=>evaluate('(()=>{const field=document.querySelector('+JSON.stringify(selector)+');field.scrollIntoView({block:"center"});const r=field.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,width:r.width,height:r.height,top:r.top,bottom:r.bottom,hit:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===field,dpr:devicePixelRatio}})()');
    const field=await geometry('#next-identity-content');assert.equal(field.dpr,1.5);assert.ok(field.width>300&&field.height>150);
    assert.ok(field.top>=0&&field.bottom<=560);assert.equal(field.hit,true,'Identity editor must receive input after scrolling.');
    await send('Input.dispatchMouseEvent',{type:'mousePressed',x:field.x,y:field.y,button:'left',clickCount:1});
    await send('Input.dispatchMouseEvent',{type:'mouseReleased',x:field.x,y:field.y,button:'left',clickCount:1});
    assert.equal(await evaluate('document.activeElement===document.querySelector("#next-identity-content")'),true);
    const minimumDraft='Identity saved from the minimum desktop window.';await input(minimumDraft);
    await until(()=>evaluate('document.querySelector("#next-identity-save").disabled===false'),'Minimum-window Identity Save ready');
    const button=await geometry('#next-identity-save');assert.equal(button.hit,true,'Identity Save must remain hittable.');
    assert.ok(button.top>=0&&button.bottom<=560);
    assert.equal(await evaluate('document.querySelector(".next-identity-settings").scrollWidth<=document.querySelector(".next-identity-settings").clientWidth+1 && document.documentElement.scrollWidth<=innerWidth+1'),true,'Identity must fit the desktop minimum width.');
    await send('Input.dispatchMouseEvent',{type:'mousePressed',x:button.x,y:button.y,button:'left',clickCount:1});
    await send('Input.dispatchMouseEvent',{type:'mouseReleased',x:button.x,y:button.y,button:'left',clickCount:1});
    const minimumSaved=await saved(minimumDraft,'Minimum-window pointer Save persisted');
    await until(()=>evaluate('document.querySelector("#next-identity-state").textContent.includes("Saved · revision '+minimumSaved.revision+'")'),'Minimum-window Save receipt settled');
    counts.identityMinimumGeometry={width:780,height:560,scale:1.5,editorHit:true,saveHit:true,pointerSave:true};
  }finally{if(emulated)await send('Emulation.clearDeviceMetricsOverride');}
  await click('#next-settings-section-general');await until(()=>selected('general'),'Return to General after Identity acceptance');
}
