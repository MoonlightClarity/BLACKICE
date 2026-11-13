import {visualPatch} from '../../visual-edits.mjs';
import {compileVisual,visualSvgUrl,VISUAL_COMPOSITION_EXAMPLE} from '../../visual-document.mjs';

export function createVisualWorkspace({mount,api,getConversationId,notify=()=>{}}){
 const doc=mount.ownerDocument,section=doc.createElement('section');section.className='next-visuals';section.setAttribute('aria-label','Conversation visuals');mount.append(section);
 let owner=null,generation=0,cache=null,dialog=null,disposed=false;
 const el=(tag,text,parent=section)=>{const e=doc.createElement(tag);if(text!==undefined)e.textContent=text;parent.append(e);return e;};
 const button=(text,parent,action)=>{const b=el('button',text,parent);b.type='button';b.onclick=()=>Promise.resolve().then(action).catch(error=>notify(error.message));return b;};
 const endpoint=()=>`/api/conversations/${encodeURIComponent(owner)}/visuals`;
 const download=(value,type,name)=>{const url=URL.createObjectURL(new Blob([value],{type}));const a=el('a','',section);a.href=url;a.download=name;a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);};
 function image(record,parent){const url=visualSvgUrl(record.svg);if(url){const img=el('img',undefined,parent);img.src=url;img.alt=record.document.summary;img.style.cssText='display:block;max-width:100%;height:auto;background:white';}else el('p','Preview unavailable. The saved text and source remain available.',parent);}
 async function edit(artifactId,revision){
  const selectedOwner=owner,token=generation,url=endpoint();const record=artifactId?await api(url+`?artifactId=${encodeURIComponent(artifactId)}${revision?`&revision=${revision}`:''}`):{document:structuredClone(VISUAL_COMPOSITION_EXAMPLE)};
  if(disposed||token!==generation||selectedOwner!==owner)return;
  dialog?.remove();dialog=doc.createElement('dialog');dialog.style.cssText='width:min(1000px,92vw);max-height:90vh;overflow:auto';mount.append(dialog);const panel=dialog;panel.setAttribute('aria-label',artifactId?'Edit visual: '+record.document.title:'Create visual');
  el('h2',artifactId?`${record.document.title} · revision ${record.revision}`:'New visual',panel);
  button('Close',panel,()=>panel.close());panel.addEventListener('close',()=>{panel.remove();if(dialog===panel)dialog=null;});
  if(artifactId){image(record,panel);el('pre',record.text,panel).style.whiteSpace='pre-wrap';
   button('Export SVG',panel,()=>download(record.svg,'image/svg+xml',`${artifactId}-r${record.revision}.svg`));
   button('Export editable document',panel,()=>download(JSON.stringify(record.document,null,2),'application/json',`${artifactId}-r${record.revision}.json`));
   button('Export text',panel,()=>download(record.text,'text/plain',`${artifactId}-r${record.revision}.txt`));
   const history=cache?.artifacts.find(a=>a.id===artifactId)?.history||[];const label=el('label','Revision history ',panel),select=el('select',undefined,label);select.setAttribute('aria-label','Revision history');for(const r of history){const option=el('option',`${r.revision} · ${r.actor} · ${r.at}`,select);option.value=r.revision;option.selected=r.revision===record.revision;}select.onchange=()=>void edit(artifactId,Number(select.value)).catch(e=>notify(e.message));
  }
  const draft=structuredClone(record.document),fields=[],contentFields=el('div',undefined,panel);let sourceEdited=false,refreshEndpoints=()=>{};
  function field(labelText,target,key){const label=el('label',labelText,contentFields);label.style.display='block';const input=el('textarea',undefined,label);input.value=target[key]??'';input.rows=2;input.style.cssText='display:block;width:100%';input.oninput=()=>{target[key]=input.value;source.value=JSON.stringify(draft,null,2);refreshEndpoints();};fields.push(input);}
  el('h3','Edit content',panel);field('Title',draft,'title');field('Text alternative / analytical takeaway',draft,'summary');
  for(const item of draft.items||[]){field(`Item ${item.id}`,item,'label');if(item.status!==undefined)field(`Status of ${item.id}`,item,'status');}
  for(const link of draft.links||[])field(`${link.from} → ${link.to}`,link,'label');
  for(const group of draft.groups||[])field('Group',group,'label');
  for(const note of draft.notes||[])field('Note',note,'text');
  if(draft.kind==='custom')field('Static SVG source',draft,'svg');
  if(draft.grid){draft.grid.columns.forEach((_,i)=>field(`Column ${i+1}`,draft.grid.columns,i));draft.grid.rows.forEach((row,r)=>row.forEach((_,c)=>field(`Row ${r+1}, ${draft.grid.columns[c]}`,row,c)));}
  for(const region of draft.regions||[]){field('Region '+region.id,region,'label');field('Region text alternative',region,'summary');field('Region SVG source',region,'svg');}
  if(draft.kind==='composed'){
   button('Add item',panel,()=>{if(sourceEdited)throw Error('Reopen the saved document before using simple controls after source edits.');draft.version=2;const item={id:'item-'+crypto.randomUUID().slice(0,8),label:'New item'};(draft.items??=[]).push(item);field('Item '+item.id,item,'label');source.value=JSON.stringify(draft,null,2);refreshEndpoints();from.value=item.id;});
   const form=el('div',undefined,panel),fromLabel=el('label','From ',form),from=el('select',undefined,fromLabel),toLabel=el('label','To ',form),to=el('select',undefined,toLabel),linkLabel=el('label','Relationship ',form),relation=el('input',undefined,linkLabel);from.value=draft.items?.[0]?.id||'';to.value=draft.items?.[1]?.id||'';relation.value='could explain';refreshEndpoints=()=>{for(const select of [from,to]){const selected=select.value;select.replaceChildren();for(const item of draft.items||[]){const option=el('option',item.label,select);option.value=item.id;}if(draft.items?.some(i=>i.id===selected))select.value=selected;}};refreshEndpoints();
   button('Add connection',form,()=>{if(sourceEdited)throw Error('Reopen after source edits.');if(!draft.items?.some(i=>i.id===from.value)||!draft.items?.some(i=>i.id===to.value))throw Error('Choose existing item IDs shown beside their labels.');draft.version=2;const link={id:'link-'+crypto.randomUUID().slice(0,8),from:from.value,to:to.value,label:relation.value,uncertain:true};(draft.links??=[]).push(link);field(link.from+' to '+link.to,link,'label');source.value=JSON.stringify(draft,null,2);});
  }
  const advanced=el('details',undefined,panel);el('summary','Structure and source editor (JSON)',advanced);el('p','Add, remove or reposition items, connections, groups, grid cells and notes. Custom SVG uses kind “custom”, svg, title and summary. Editing source disables the simple fields until you reopen.',advanced);
  const source=el('textarea',undefined,advanced);source.setAttribute('aria-label','Editable visual document JSON');source.value=JSON.stringify(draft,null,2);source.rows=18;source.style.cssText='width:100%;font-family:monospace';source.oninput=()=>{sourceEdited=true;fields.forEach(f=>f.disabled=true);};
  if(record.svg&&draft.kind==='composed')button('Fork as custom SVG',panel,()=>{source.value=JSON.stringify({version:1,kind:'custom',title:draft.title,summary:draft.summary,svg:record.svg},null,2);sourceEdited=true;fields.forEach(f=>f.disabled=true);advanced.open=true;status.textContent='Saving will create a separate custom visual. The original composition and its history remain editable.';});
  const status=el('p','',panel);status.setAttribute('role','status');const preview=el('div',undefined,panel);
  button('Preview draft',panel,()=>{try{const result=compileVisual(JSON.parse(source.value));preview.replaceChildren();image(result,preview);el('pre',result.text,preview).style.whiteSpace='pre-wrap';status.textContent='Draft is valid. Nothing has been saved.';}catch(e){status.textContent=e.message;}});
  let pending=null;const save=button(artifactId?'Save new revision':'Create visual',panel,async()=>{
   if(owner!==selectedOwner)return;save.disabled=true;
   try{const document=JSON.parse(source.value);compileVisual(document);const signature=JSON.stringify(document),operations=artifactId?visualPatch(record.document,document):null,fork=record.document.kind==='composed'&&document.kind==='custom',revising=artifactId&&!fork;if(!pending||pending.signature!==signature)pending={signature,args:{action:revising&&operations?.length?'patch':revising?'revise':'create',requestId:crypto.randomUUID(),...(revising&&operations?.length?{operations}:{document}),...(revising?{artifactId,expectedRevision:record.revision}:{})}};
    const result=await api(url,'POST',pending.args);status.textContent=`Saved revision ${result.revision}.`;await refresh(true);if(owner===selectedOwner)await edit(result.id,result.revision);
   }catch(e){status.textContent=e.message+' Your draft remains here. If another edit was saved, copy your draft before opening the latest revision.';}finally{save.disabled=false;}
  });
  if(artifactId&&record.revision!==record.currentRevision){save.disabled=true;el('p','Historical revision. Open the latest revision to edit; exports retain this exact version.',panel);button('Open latest revision',panel,()=>edit(artifactId));}
  dialog.showModal();
 }
 async function refresh(force=false){
  if(disposed)return;const selected=getConversationId();if(selected!==owner){owner=selected;generation++;cache=null;dialog?.close();section.replaceChildren();}
  if(!owner||owner==='new'){section.hidden=true;return;}section.hidden=false;if(cache&&!force)return;
  const token=++generation,url=endpoint();try{const value=await api(url);if(disposed||token!==generation)return;cache=value;section.replaceChildren();
   el('h3','Visuals');button('Create visual',section,()=>edit());
   const label=el('label',' Allow the agent to use visuals when helpful '),checkbox=el('input',undefined,label);checkbox.type='checkbox';checkbox.checked=value.automatic;checkbox.onchange=async()=>{checkbox.disabled=true;try{await api(url,'POST',{action:'preferences',automatic:checkbox.checked,requestId:crypto.randomUUID()});}catch(e){checkbox.checked=!checkbox.checked;notify(e.message);}finally{checkbox.disabled=false;}};
   for(const artifact of value.artifacts){const card=el('article');el('h4',`${artifact.title} · revision ${artifact.revision}`,card);button('Inspect / edit / history / export',card,()=>edit(artifact.id));const record=await api(url+`?artifactId=${encodeURIComponent(artifact.id)}&revision=${artifact.revision}`);if(token!==generation)return;image(record,card);const details=el('details',undefined,card);el('summary','Text alternative',details);el('pre',record.text,details).style.whiteSpace='pre-wrap';}
  }catch(e){if(token===generation)notify(e.message);}
 }
 return {refresh,onEvent(event){if(event.type==='visual.updated'&&event.data?.conversationId===owner)void refresh(true);},cancel(){generation++;owner=null;cache=null;dialog?.close();section.replaceChildren();section.hidden=true;},destroy(){disposed=true;generation++;dialog?.remove();section.remove();}};
}
