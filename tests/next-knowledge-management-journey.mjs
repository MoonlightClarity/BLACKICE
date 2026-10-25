import assert from 'node:assert/strict';

/** Existing KnowledgeStore lifecycle only: recoverable Trash and revision
 * restoration. Knowledge has no archive state or archive API. */
export async function exerciseKnowledgeManagement({evaluate,send,until,fixture,counts}){
  const store=await fixture.knowledge(),id='knowledge-management-fixture';
  const original=await store.upsert({id,kind:'memory',title:'Management recovery fixture',summary:'Recoverable knowledge',content:'Keep this complete memory content.',cwd:null,memoryType:'decision',sources:['literal recovery evidence <text>'],relations:[]});
  const click=selector=>evaluate(`document.querySelector(${JSON.stringify(selector)}).click();true`);
  await click('.next-tab[data-space=knowledge]');await until(()=>evaluate('Boolean(document.querySelector("#next-knowledge-state"))'),'Knowledge management controls');
  await evaluate('(()=>{for(const [id,value,event]of [["kind","memory","change"],["state","active","change"],["query","Management recovery fixture","input"]]){const node=document.querySelector("#next-knowledge-"+id);node.value=value;node.dispatchEvent(new Event(event,{bubbles:true}));}return true})()');
  await until(()=>evaluate('Boolean(document.querySelector("[data-knowledge-id=knowledge-management-fixture]"))'),'Recoverable Knowledge metadata');
  await click('[data-knowledge-id=knowledge-management-fixture]');await until(()=>evaluate('document.querySelector("#next-knowledge-content").value==="Keep this complete memory content."'),'Knowledge recovery full entry');
  assert.equal(await evaluate('document.querySelector("#next-knowledge-delete").textContent'),'Move to Trash');
  await click('#next-knowledge-delete');await until(()=>store.history(id).deleted,'Knowledge moved to Trash');
  await until(()=>evaluate('!document.querySelector("#next-knowledge-recover").hidden && !document.querySelector("#next-knowledge-recover").disabled'),'Direct Knowledge restore control');
  assert.equal(await evaluate('document.querySelector("#next-knowledge-content").readOnly'),true);
  const viewport=await evaluate('({width:innerWidth,height:innerHeight,deviceScaleFactor:devicePixelRatio})');
  try{
    await send('Emulation.setDeviceMetricsOverride',{width:780,height:560,deviceScaleFactor:1.5,mobile:false});
    const box=await evaluate('(async()=>{const node=document.querySelector("#next-knowledge-recover");node.scrollIntoView({block:"center",inline:"nearest"});await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));const r=node.getBoundingClientRect(),hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return {visible:r.width>0&&r.height>0&&r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight,reachable:hit===node||node.contains(hit)}})()');
    assert.equal(box.visible,true);assert.equal(box.reachable,true);
  }finally{await send('Emulation.setDeviceMetricsOverride',{...viewport,mobile:false});}
  const restores=()=>fixture.state.knowledgeMutations.filter(call=>call.path==='/api/knowledge/'+id+'/restore');
  const before=restores().length;await click('#next-knowledge-recover');await click('#next-knowledge-recover');
  await until(()=>!store.history(id).deleted,'Direct Knowledge recovery completed');await until(()=>evaluate('document.querySelector("#next-knowledge-recover").hidden'),'Recovered Knowledge editor');
  assert.equal(restores().length,before+1);assert.deepEqual(restores().at(-1).body,{revision:1,expectedRevision:2});
  const restored=store.get(id);for(const key of ['id','kind','title','summary','content','cwd','memoryType','sources','relations'])assert.deepEqual(restored[key],original[key]);
  assert.equal(restored.revision,3);assert.equal(await evaluate('document.querySelector("#next-knowledge-state").value'),'active');
  counts.knowledgeManagement={trash:true,directRecovery:true,revisionGuard:true,metadataPreserved:true,noReplay:true,compactReachable:true};
}
