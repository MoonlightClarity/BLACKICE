import { createApi } from '../core/api.mjs';

/** On-demand artifact preview. Saved bytes are verified by the existing task
 * endpoint; only a selected artifact is fetched. The dialog owns each read.
 */
export function createArtifactViewer({mount,api,notify=()=>{}}={}){
  const doc=mount.ownerDocument;
  const dialog=doc.createElement('dialog');
  dialog.className='next-artifact-dialog';
  dialog.setAttribute('aria-label','Saved file preview');
  const heading=doc.createElement('h2');heading.textContent='Saved file';
  const subtitle=doc.createElement('p');subtitle.className='next-help';
  const content=doc.createElement('section');content.className='next-artifact-content';
  const actions=doc.createElement('div');actions.className='next-row';
  const closeButton=doc.createElement('button');closeButton.type='button';closeButton.textContent='Close';
  actions.append(closeButton);
  const wrapper=doc.createElement('div');wrapper.className='next-artifact-wrapper';
  wrapper.append(heading,subtitle,content,actions);dialog.append(wrapper);mount.append(dialog);
  let controller=null,generation=0;
  const cancel=()=>{
    generation++;controller?.abort();controller=null;
    if(dialog.open)dialog.close();
  };
  closeButton.addEventListener('click',cancel);
  dialog.addEventListener('cancel',event=>{event.preventDefault();cancel();});
  const line=(value,tag='p')=>{const child=doc.createElement(tag);child.textContent=String(value||'');content.append(child);return child;};
  async function open({taskId,artifactId}={}){
    if(!/^[A-Za-z0-9_-]{1,150}$/.test(taskId||'') ||
        !/^artifact_[0-9a-f-]{36}$/.test(artifactId||''))throw Error('Choose a saved task file.');
    cancel();
    const token=++generation;
    controller=new AbortController();
    heading.textContent='Opening saved file…';subtitle.textContent='Verifying saved bytes';content.replaceChildren();
    actions.querySelectorAll('a').forEach(node=>node.remove());
    if(!dialog.open)dialog.showModal();
    closeButton.focus({preventScroll:true});
    const base='/api/tasks/'+encodeURIComponent(taskId)+'/artifacts/'+encodeURIComponent(artifactId);
    try{
      const data=await api(base+'/preview','GET',undefined,{signal:controller.signal,deadlineMs:30000});
      if(token!==generation||!dialog.open)return;
      const file=data?.artifact;
      if(!file || typeof file.fileName!=='string')throw Error('The saved file preview was invalid.');
      heading.textContent=file.title||file.fileName;
      subtitle.textContent=file.fileName+' · '+Number(file.size||0).toLocaleString()+' bytes';
      content.replaceChildren();
      const dataImage=data.previewKind==='image'&&typeof data.imageUrl==='string'&&data.imageUrl.length<14*1024*1024&&
        /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/.test(data.imageUrl);
      if(dataImage){
        const img=doc.createElement('img');img.src=data.imageUrl;img.alt=file.title||file.fileName;
        img.className='next-artifact-image';content.append(img);
      }else if(data.previewKind==='text'){
        line(data.content??data.text??'','pre').className='next-artifact-pre';
      }else line(data.message||'This file is available for download or opening in its native application.');
      if(file.sha256)line('SHA-256: '+file.sha256).className='next-help';
      const download=doc.createElement('a');
      download.href=base+'/content';download.download=file.fileName;download.textContent='Download file';
      download.className='next-primary next-artifact-download';actions.prepend(download);
    }catch(error){
      if(token!==generation||controller?.signal.aborted)return;
      heading.textContent='Unable to preview saved file';subtitle.textContent='';
      content.replaceChildren();line(error.message||'Unable to load this artifact.');
      const retry=doc.createElement('button');retry.type='button';retry.textContent='Try again';
      retry.addEventListener('click',()=>void open({taskId,artifactId}).catch(notify));
      content.append(retry);
    }
  }
  return {open,cancel,destroy(){cancel();dialog.remove();}};
}

/** Conversation-scoped Directory context. Other conversations are discovered as
 * metadata; their files are read only after the user selects that conversation.
 */
let directoryInspectorSequence=0;
export function createDirectoryInspector({frame,getRunId,getConversationId=()=>null,api=createApi()}) {
  const doc=frame.ownerDocument;
  const make=(tag,cls,text='')=>{const el=doc.createElement(tag);if(cls)el.className=cls;if(text)el.textContent=text;return el;};
  const button=(cls,text,action)=>{const el=make('button',cls,text);el.setAttribute('type','button');if(action)el.addEventListener('click',action);return el;};
  const actions=frame.querySelector('.next-chat-head-actions')||frame.querySelector('.pb-header-actions');
  const launch=button('next-directory-open','Directory Context',()=>open());
  launch.hidden=true;launch.title='View, edit, delete and import conversation context';
  actions?.insertBefore(launch,actions.querySelector('#next-chat-stop'));
  const dialog=make('dialog','next-directory-inspector');
  const head=make('header','next-directory-head');
  const title=make('h2','', 'Directory context');title.id='next-directory-title-'+(++directoryInspectorSequence);
  dialog.setAttribute('aria-labelledby',title.id);
  const close=button('next-directory-close','Close',()=>dialog.close());head.append(title,close);
  const scope=make('section','next-directory-scope');
  const conversationLabel=make('label','next-directory-conversation-label','Conversation');
  const conversationSelect=make('select','next-directory-conversation');conversationSelect.setAttribute('aria-label','Context conversation');
  conversationLabel.append(conversationSelect);
  const scopeInfo=make('div','next-directory-scope-info');
  const scopeBadge=make('strong','next-directory-scope-badge','Current conversation');
  const scopeHelp=make('p','next-directory-scope-help','Directory uses the context of this conversation.');
  const returnButton=button('next-directory-return','Back to current conversation',()=>loadConversation(originId));returnButton.hidden=true;
  scopeInfo.append(scopeBadge,scopeHelp,returnButton);scope.append(conversationLabel,scopeInfo);
  const status=make('p','next-directory-status','Select a saved conversation.');status.setAttribute('role','status');status.setAttribute('aria-live','polite');
  const tabs=make('nav','next-directory-tabs');tabs.setAttribute('aria-label','Context views');
  const tabButtons=new Map();
  for(const [id,label] of [['overview','Overview'],['files','Context files'],['turns','Model turns'],['history','Changes']]){
    const b=button('',label,()=>selectTab(id));b.dataset.contextTab=id;b.setAttribute('aria-pressed',String(id==='overview'));tabs.append(b);tabButtons.set(id,b);
  }
  const split=make('div','next-directory-split');
  const rail=make('aside','next-directory-rail');
  const groupTitle=make('strong','next-directory-group-title','Current conversation');
  const filter=make('input','next-directory-filter');filter.setAttribute('type','search');filter.placeholder='Filter this conversation';filter.setAttribute('aria-label','Filter saved context records');
  const records=make('div','next-directory-records');
  const historyMore=button('next-directory-history-more','Load older changes',()=>loadHistory(true));historyMore.hidden=true;rail.append(groupTitle,filter,records,historyMore);
  const viewer=make('section','next-directory-viewer');viewer.setAttribute('aria-label','Selected context record');
  const fileLabel=make('strong','next-directory-file-label','Overview');
  const fileNote=make('p','next-directory-file-note');
  const contents=make('textarea','next-directory-contents');contents.readOnly=true;contents.spellcheck=false;contents.setAttribute('aria-label','Saved context JSON');
  const generated=make('details','next-directory-generated');generated.hidden=true;
  generated.append(make('summary','','Latest generated record'));
  const generatedContents=make('textarea','next-directory-contents next-directory-generated-contents');generatedContents.readOnly=true;generatedContents.spellcheck=false;generatedContents.setAttribute('aria-label','Generated context JSON');generated.append(generatedContents);
  const recordActions=make('div','next-directory-record-actions');
  const editButton=button('next-directory-edit','Edit context',()=>beginEdit('fields'));
  const editJSONButton=button('next-directory-edit-json','Edit full JSON',()=>beginEdit('json'));
  const deleteButton=button('next-directory-delete','Delete context',()=>removeSelected());
  const importButton=button('next-directory-import','Import into current conversation',()=>importSelected());
  recordActions.append(editButton,editJSONButton,deleteButton,importButton);recordActions.hidden=true;
  const editPanel=make('section','next-directory-edit-panel');editPanel.hidden=true;
  const editHint=make('p','next-directory-edit-hint');
  const editFields=make('div','next-directory-edit-fields');
  const reasonLabel=make('label','next-directory-reason-label','Note (optional)');
  const reason=make('input','next-directory-reason');reason.setAttribute('type','text');reason.setAttribute('aria-label','Context change note');reason.maxLength=500;reasonLabel.append(reason);
  const editActions=make('div','next-directory-edit-actions');
  const saveButton=button('next-directory-save','Save changes',()=>saveEdit());
  const cancelButton=button('next-directory-cancel','Cancel edit',()=>cancelEdit());editActions.append(saveButton,cancelButton);
  editPanel.append(editHint,editFields,reasonLabel,editActions);
  viewer.append(fileLabel,fileNote,contents,recordActions,editPanel,generated);split.append(rail,viewer);
  dialog.append(head,scope,status,tabs,split);frame.append(dialog);
  const style=make('style','');
  style.textContent=`
    .next-directory-inspector{color:var(--text);background:var(--next-workspace-background);border:1px solid var(--line);border-radius:14px;padding:0;width:min(1120px,94vw);max-width:94vw;max-height:92vh;overflow:auto;box-shadow:0 25px 90px #0008}
    .next-directory-inspector::backdrop{background:#000b}
    .next-directory-inspector [hidden]{display:none!important}
    .next-directory-head{display:flex;align-items:center;justify-content:space-between;padding:15px 20px;border-bottom:1px solid var(--line)}
    .next-directory-head h2{font-size:17px;margin:0}
    .next-directory-inspector button{color:var(--next-button-foreground);background:var(--next-button-background);border:1px solid var(--next-button-border);border-radius:7px;padding:7px 11px;cursor:pointer}
    .next-directory-inspector button:hover:enabled{background:var(--next-button-hover-background);border-color:var(--next-button-hover-border)}
    .next-directory-inspector button:disabled{opacity:.55;cursor:default}
    .next-directory-inspector button:focus-visible,.next-directory-inspector select:focus-visible,.next-directory-inspector input:focus-visible,.next-directory-inspector textarea:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
    .next-directory-scope{display:grid;grid-template-columns:minmax(180px,40%) minmax(0,1fr);gap:18px;padding:16px 20px 8px}
    .next-directory-conversation-label,.next-directory-reason-label,.next-directory-field-label{display:flex;flex-direction:column;gap:6px;min-width:0;font-size:12px;color:var(--text)}
    .next-directory-conversation,.next-directory-filter,.next-directory-reason{box-sizing:border-box;width:100%;padding:9px;background:var(--next-control-background);color:var(--text);border:1px solid var(--line);border-radius:7px;min-width:0}
    .next-directory-scope-badge{font-size:13px;color:var(--text)}
    .next-directory-scope-help,.next-directory-file-note,.next-directory-edit-hint{margin:5px 0;font-size:12px;line-height:1.5;color:var(--muted);overflow-wrap:anywhere}
    .next-directory-return{font-size:12px;margin-top:3px}
    .next-directory-status{margin:8px 20px 12px;font-size:13px;color:var(--muted);white-space:pre-wrap;overflow-wrap:anywhere}
    .next-directory-tabs{display:flex;gap:8px;flex-wrap:wrap;padding:0 20px 12px}
    .next-directory-tabs button[aria-pressed=true]{background:var(--next-selection-background);border-color:var(--next-selection-border);color:var(--text)}
    .next-directory-split{display:grid;grid-template-columns:minmax(200px,34%) minmax(0,1fr);gap:16px;padding:0 20px 20px;min-height:300px}
    .next-directory-rail{display:flex;flex-direction:column;gap:8px;min-width:0}
    .next-directory-group-title{font-size:13px;overflow-wrap:anywhere}
    .next-directory-records{display:flex;flex-direction:column;gap:5px;overflow:auto;max-height:53vh}
    .next-directory-records button{text-align:left;overflow-wrap:anywhere;font-size:12px}
    .next-directory-records button[aria-current=true]{background:var(--next-selection-background);border-color:var(--next-selection-border);color:var(--text)}
    .next-directory-record-group{margin:10px 0 3px;font-size:11px;color:var(--muted);overflow-wrap:anywhere}
    .next-directory-viewer{display:flex;flex-direction:column;gap:8px;min-width:0}
    .next-directory-file-label{font-size:12px;overflow-wrap:anywhere}
    .next-directory-contents,.next-directory-field{box-sizing:border-box;width:100%;resize:vertical;background:var(--next-control-background);color:var(--next-control-foreground);border:1px solid var(--line);border-radius:7px;padding:12px;font:12px/1.5 ui-monospace,Consolas,monospace}
    .next-directory-contents{min-height:220px;height:42vh}
    .next-directory-field{min-height:100px;max-height:40vh}
    .next-directory-contents:not([readonly]),.next-directory-field{border-color:var(--accent)}
    .next-directory-record-actions,.next-directory-edit-actions{display:flex;gap:8px;flex-wrap:wrap}
    .next-directory-inspector .next-directory-delete{color:var(--danger,#e88b8b);border-color:var(--danger,#e88b8b)}
    .next-directory-inspector .next-directory-save,.next-directory-inspector .next-directory-import{background:var(--next-primary-background);border-color:var(--next-primary-border);color:var(--next-primary-foreground)}
    .next-directory-edit-panel,.next-directory-edit-fields{display:flex;flex-direction:column;gap:12px}
    .next-directory-generated{font-size:12px;color:var(--muted);margin-top:4px}
    .next-directory-generated summary{cursor:pointer;padding:6px 0}
    .next-directory-generated-contents{height:26vh;margin-top:6px}
    @media(max-width:700px){.next-directory-scope,.next-directory-split{grid-template-columns:1fr}.next-directory-scope{gap:10px}.next-directory-records{max-height:180px}.next-directory-contents{height:33vh}.next-directory-tabs,.next-directory-split,.next-directory-scope{padding-left:12px;padding-right:12px}}

    .next-directory-inspector .next-directory-save:hover:enabled,.next-directory-inspector .next-directory-import:hover:enabled{background:var(--next-primary-hover-background);border-color:var(--next-primary-hover-border)}
    @media(forced-colors:active){.next-directory-inspector{box-shadow:none}.next-directory-tabs button[aria-pressed=true],.next-directory-records button[aria-current=true]{background:Highlight;color:HighlightText;forced-color-adjust:none}.next-directory-inspector .next-directory-delete{color:ButtonText;border-color:ButtonText}}
  `;
  frame.append(style);
  let originId='',originScope='',originConversationId='',currentId='',currentConversationId='',currentTab='overview';
  let files=[],turns=[],summary={},contextSummary={},catalog=[],history=null,selected=null,editing=null,fieldEditors=[];
  let generation=0,fileGeneration=0,catalogGeneration=0,busy=false,destroyed=false,historyLoading=false,historyTotal=0,historyNextOffset=null;
  let refreshTimer=null,refreshController=null,refreshing=false,loading=false,listingVersion='';
  const versionOf=listing=>JSON.stringify([listing.files,listing.summary,listing.managedSummary,listing.managedSummaryEditMode]);
  const stopRefresh=()=>{clearTimeout(refreshTimer);refreshTimer=null;refreshController?.abort();refreshController=null;};
  function scheduleRefresh(){
    clearTimeout(refreshTimer);
    if(destroyed||!dialog.open)return;
    refreshTimer=setTimeout(async()=>{refreshTimer=null;try{await refreshOpen();}finally{scheduleRefresh();}},2000);
    refreshTimer?.unref?.();
  }
  const modelLabels=new Set(['decompose','context-page','work','repair','integration','extract-page','page-extract','repository-review']);
  const requestURL=(suffix,runId,file)=>'/api/shadowdancer/context'+suffix+'?runId='+encodeURIComponent(runId)+(file?'&file='+encodeURIComponent(file):'');
  const belongsToCurrent=()=>currentId===originId||Boolean(currentConversationId&&currentConversationId===originConversationId);
  const conversationTitle=id=>catalog.find(row=>row.runId===id||row.conversationId===id||(id===originId&&row.current))?.title||'Conversation '+id;
  const stillHere=(token,id)=>!destroyed&&dialog.open&&token===generation&&id===currentId;
  const object=value=>Boolean(value&&typeof value==='object'&&!Array.isArray(value));
  const effectiveValue=(canonical,managed,mode)=>mode==='fields'&&object(canonical)&&object(managed)?{...canonical,...managed}:managed;
  function setBusy(value){busy=value;conversationSelect.disabled=value;returnButton.disabled=value;for(const control of [editButton,editJSONButton,deleteButton,importButton,saveButton,cancelButton])control.disabled=value;historyMore.disabled=value||historyLoading;}
  function updateScope(){
    const current=belongsToCurrent();
    conversationSelect.value=currentId;
    scopeBadge.textContent=current?'Current conversation':'Viewing another conversation';
    scopeHelp.textContent=current?'Directory uses the context of this conversation. You can edit or delete individual records.':'Choose a record to inspect or import into your current conversation.';
    returnButton.hidden=current;
    groupTitle.textContent=conversationTitle(currentId);
  }
  function drawConversations(){
    const currentGroup=make('optgroup','');currentGroup.setAttribute('label','Current conversation');
    const original=catalog.find(row=>row.current||row.conversationId===originConversationId||row.runId===originId);
    const first=make('option','',original?.title||'Current conversation');first.value=originId;currentGroup.append(first);
    const others=make('optgroup','');others.setAttribute('label','Other conversations');
    for(const row of catalog){
      if(row===original||row.conversationId===originConversationId||row.runId===originId)continue;
      const option=make('option','',(row.title||'Conversation')+(row.state==='archived'?' · archived':''));option.value=row.runId;others.append(option);
    }
    conversationSelect.replaceChildren(currentGroup,...(others.children.length?[others]:[]));conversationSelect.value=currentId;
    updateScope();
  }
  function cancelEdit(){
    editing=null;fieldEditors=[];editPanel.hidden=true;editFields.replaceChildren();reason.value='';contents.hidden=false;contents.readOnly=true;
    if(selected)contents.value=JSON.stringify(selected.value,null,2);
    updateRecordActions();
  }
  function updateRecordActions(){
    const fields=selected?.editableFields||[];
    editButton.hidden=!selected?.editable;
    editJSONButton.hidden=!selected?.replaceable||!fields.length||!object(selected.value);
    deleteButton.hidden=!selected?.deletable;
    importButton.hidden=!selected?.importable||belongsToCurrent();
    recordActions.hidden=!selected||Boolean(editing)||[editButton,editJSONButton,deleteButton,importButton].every(control=>control.hidden);
  }
  function display(name,value,note=''){
    selected=null;cancelEdit();generated.hidden=true;generated.open=false;generatedContents.value='';fileLabel.textContent=name;fileNote.textContent=note;contents.value=typeof value==='string'?value:JSON.stringify(value,null,2);contents.scrollTop=0;
  }
  function selectRecord(file){for(const row of records.querySelectorAll('button[data-context-file]'))row.setAttribute('aria-current',String(row.dataset.contextFile===file));}
  async function readFile(file,{preserve=false}={}){
    if(busy||preserve&&editing)return;
    const id=currentId,token=generation,read=++fileGeneration;
    if(!preserve)display(file,'Loading context…');selectRecord(file);
    try{
      const data=await api(requestURL('/file',id,file),'GET',undefined,preserve?{signal:refreshController?.signal}:{});if(!stillHere(token,id)||read!==fileGeneration||preserve&&(editing||busy))return;
      const scroll=contents.scrollTop,start=contents.selectionStart,end=contents.selectionEnd,generatedScroll=generatedContents.scrollTop,expanded=generated.open;
      const managed=Object.hasOwn(data,'managedValue');
      selected={...data,file:data.file||file,value:managed?effectiveValue(data.value,data.managedValue,data.editMode):data.value};contents.value=JSON.stringify(selected.value,null,2);fileLabel.textContent=selected.file;
      generated.hidden=!managed;generated.open=false;generatedContents.value=managed?JSON.stringify(data.value,null,2):'';
      const provenance=data.importedFrom||data.value?.importedFrom||data.value?.provenance;
      fileNote.textContent=[managed?'Your saved context changes are applied to this record.':'',provenance?'Imported context · '+(provenance.title||provenance.conversationId||provenance.sourceConversationId||'another conversation'):
        data.editable?'Edits and deletions change the context used by future Directory work. Saved results may need to be refreshed.':'Saved context record'].filter(Boolean).join(' ');
      updateRecordActions();
      if(preserve){contents.setSelectionRange(start,end);contents.scrollTop=scroll;generatedContents.scrollTop=generatedScroll;generated.open=expanded;}
      return true;
    }catch(error){if(stillHere(token,id)&&read===fileGeneration){if(preserve){listingVersion='';status.textContent='Context refresh failed: '+error.message;}else display(file,'Read failed: '+error.message);}}
  }
  function beginEdit(mode){
    if(!selected?.editable||busy)return;
    fileGeneration++;
    const fields=selected.editableFields||[];
    editing=mode==='json'||!fields.length||!object(selected.value)?'json':'fields';fieldEditors=[];editFields.replaceChildren();reason.value='';
    contents.hidden=editing==='fields';contents.readOnly=editing!=='json';editPanel.hidden=false;
    editHint.textContent=editing==='json'?Object.hasOwn(selected,'managedValue')?'Edit your saved JSON. The latest generated record is available below.':'Edit the saved JSON, then save your changes.':'Edit the context fields below, then save your changes.';
    if(editing==='fields'){
      const labels={userSummary:'Conversation notes',pinnedConstraints:'Pinned constraints',content:'Content',summary:'Summary',items:'Items',objective:'Objective',doneWhen:'Done when',finding:'Finding',candidate_answer:'Candidate answer',uncertainty:'Uncertainty'};
      for(const field of fields){
        const value=selected.value?.[field],json=['pinnedConstraints','items'].includes(field)||typeof value!=='string'&&value!==undefined;
        const label=make('label','next-directory-field-label',(labels[field]||field)+(json?' (JSON)':''));
        const input=make('textarea','next-directory-field');input.dataset.contextField=field;input.spellcheck=false;input.setAttribute('aria-label',labels[field]||field);
        input.value=json?JSON.stringify(value??[],null,2):value??'';label.append(input);editFields.append(label);fieldEditors.push({field,input,json,original:input.value});
      }
      fieldEditors[0]?.input.focus({preventScroll:true});
    }else{contents.hidden=false;contents.value=JSON.stringify(Object.hasOwn(selected,'managedValue')?selected.managedValue:selected.value,null,2);contents.focus({preventScroll:true});}
    updateRecordActions();
  }
  async function saveEdit(){
    if(!selected||!editing||busy)return;
    const id=currentId,token=generation,file=selected.file,payload={runId:id,file,expectedHash:selected.hash,expectedManagedEditId:selected.managedEditId??null,reason:reason.value.trim()||'Edited in Context'};
    try{
      if(editing==='json')payload.value=JSON.parse(contents.value);
      else{
        payload.changes=Object.fromEntries(fieldEditors.flatMap(({field,input,json,original})=>{
          const value=json?JSON.parse(input.value):input.value;
          return (json?JSON.stringify(value)===JSON.stringify(JSON.parse(original)):value===original)?[]:[[field,value]];
        }));
        if(!Object.keys(payload.changes).length){cancelEdit();status.textContent='No changes to save.';return;}
      }
    }catch(error){status.textContent='Changes were not saved: enter valid JSON. '+error.message;return;}
    setBusy(true);status.textContent='Saving context…';
    try{
      const result=await api('/api/shadowdancer/context/edit','POST',payload);
      if(!stillHere(token,id))return;
      cancelEdit();setBusy(false);await loadConversation(id,{tab:currentTab,notice:result.unchanged?'No changes to save.':'Context saved. Derived results are marked for refresh.'});await readFile(file);
    }catch(error){if(stillHere(token,id))status.textContent=error.status?'Changes were not saved: '+error.message:'Save could not be confirmed: '+error.message+' Reopen the record to inspect its current value.';}
    finally{setBusy(false);}
  }
  async function removeSelected(){
    if(!selected?.deletable||busy)return;
    const id=currentId,token=generation,file=selected.file,hash=selected.hash,expectedManagedEditId=selected.managedEditId??null;
    setBusy(true);status.textContent='Deleting context…';
    try{
      await api('/api/shadowdancer/context/delete','POST',{runId:id,file,expectedHash:hash,expectedManagedEditId,reason:'Deleted in Context'});
      if(!stillHere(token,id))return;
      setBusy(false);await loadConversation(id,{tab:currentTab,notice:'Context deleted. It will not be used by future Directory work.'});
    }catch(error){if(stillHere(token,id))status.textContent=error.status?'Context was not deleted: '+error.message:'Delete could not be confirmed: '+error.message+' Refresh this conversation to inspect its context.';}
    finally{setBusy(false);}
  }
  async function importSelected(){
    if(!selected?.importable||belongsToCurrent()||busy)return;
    const id=currentId,token=generation,sourceFile=selected.file,expectedSourceHash=selected.hash,expectedSourceManagedEditId=selected.managedEditId??null,destination=originId;
    setBusy(true);status.textContent='Importing selected context…';
    try{
      const result=await api('/api/shadowdancer/context/import','POST',{runId:destination,sourceRunId:id,sourceFile,expectedSourceHash,expectedSourceManagedEditId,reason:'Imported into current conversation in Context'});
      if(!stillHere(token,id)||originId!==destination)return;
      setBusy(false);await loadConversation(destination,{tab:'files',notice:result.alreadyImported?'This context snapshot is already imported into the current conversation.':'Selected context imported into the current conversation.'});
      if(result.file)await readFile(result.file);
    }catch(error){if(stillHere(token,id))status.textContent=error.status?'Context was not imported: '+error.message:'Import could not be confirmed: '+error.message+' Inspect the current conversation before retrying.';}
    finally{setBusy(false);}
  }
  async function selectTab(id){
    if(busy)return;
    fileGeneration++;currentTab=id;
    for(const [name,control] of tabButtons)control.setAttribute('aria-pressed',String(name===id));
    filter.value='';filter.hidden=id==='overview';drawRows();
    if(id==='history'&&history===null)await loadHistory();
  }
  async function loadHistory(more=false){
    if(busy||historyLoading||!currentId||more&&historyNextOffset===null)return;
    const runId=currentId,token=generation,offset=more?historyNextOffset:0;
    historyLoading=true;historyMore.disabled=true;
    try{
      const result=await api(requestURL('/audit',runId)+(more?'&offset='+offset:''));if(!stillHere(token,runId))return;
      const items=Array.isArray(result.items)?result.items:[];
      history=more?[...(history||[]),...items]:items;
      historyTotal=Number.isSafeInteger(result.total)?result.total:history.length;
      historyNextOffset=Number.isSafeInteger(result.nextOffset)?result.nextOffset:null;
      if(currentTab==='history')drawRows();
    }catch(error){if(stillHere(token,runId)&&currentTab==='history')display('Changes','Changes could not be loaded: '+error.message);}
    finally{if(stillHere(token,runId)){historyLoading=false;historyMore.disabled=busy;}}
  }
  function drawRows({preserve=false}={}){
    const scroll=records.scrollTop,focused=records.contains(doc.activeElement)?doc.activeElement?.dataset?.contextFile:null;
    records.replaceChildren();historyMore.hidden=currentTab!=='history'||historyNextOffset===null;
    if(currentTab==='overview'){
      const modelCalls=turns.filter(row=>modelLabels.has(row.label)).length;
      display('Conversation context',{
        conversation:conversationTitle(currentId),conversationId:currentConversationId,selectedRunId:currentId,
        latestRunId:summary.currentRun??null,status:summary.directoryStatus??'Not recorded',failure:summary.failure??null,
        auditRecords:turns.length,modelPhases:modelCalls,contextFiles:files.length,
        selectedRunModelPhases:turns.filter(row=>row.runId===currentId&&modelLabels.has(row.label)).length,
        plannedWorkItems:summary.plannedWorkItems??'Not recorded',request:summary.request??null,
        notes:contextSummary?.userSummary??'',pinnedConstraints:contextSummary?.pinnedConstraints??[]
      },'Context is grouped by conversation. Select a file to edit, delete or import it.');return;
    }
    const q=filter.value.trim().toLowerCase();
    const fileSet=new Set(files.map(row=>row.file));
    const rows=currentTab==='turns'?turns.map((row,index)=>{
      const file='runs/'+row.runId+'/turns/'+row.id+'.json';
      return{label:(index+1)+'. '+row.label+' · '+row.module,group:row.runId||'',file:fileSet.has(file)?file:null,search:row.label+' '+row.module+' '+row.excerpt,
        act:()=>fileSet.has(file)?readFile(file):display(row.label+' · '+row.module,row)};
    }):currentTab==='history'?(history||[]).map(row=>({label:(row.action||row.kind||'Edit')+' · '+row.file,group:String(row.at||'').slice(0,10),search:JSON.stringify(row),act:()=>display('Context change',row)})):
      files.map(row=>({label:row.file+' · '+Number(row.bytes||0).toLocaleString()+' B',group:row.file.startsWith('runs/')?row.file.split('/')[1]:'Conversation context',file:row.file,search:row.file,act:()=>readFile(row.file)}));
    let shown=0,lastGroup=null;
    for(const row of rows){
      if(q&&!row.search.toLowerCase().includes(q))continue;
      if(row.group!==lastGroup){records.append(make('h3','next-directory-record-group',row.group==='Conversation context'?row.group:currentTab==='history'?row.group:'Run '+row.group));lastGroup=row.group;}
      const control=button('',row.label,row.act);if(row.file)control.dataset.contextFile=row.file;records.append(control);shown++;
    }
    if(!shown)records.append(make('p','',q?'No matching records.':currentTab==='history'&&history===null?'Loading changes…':'No saved records.'));
    if(preserve){records.scrollTop=scroll;selectRecord(selected?.file);if(focused)for(const row of records.querySelectorAll('button[data-context-file]'))if(row.dataset.contextFile===focused)row.focus({preventScroll:true});return;}
    display(currentTab==='turns'?'Model turns':currentTab==='history'?'Changes':'Context files',shown+(currentTab==='history'&&historyTotal>shown?' of '+historyTotal:'')+' records in this conversation. Select one to view its contents.');
  }
  // The inspector is a live view, not an open-time snapshot. Poll only while
  // visible, never overlap reads, and never replace an edit draft.
  async function refreshOpen(){
    if(refreshing||loading||busy||editing||destroyed||!dialog.open||doc.visibilityState==='hidden'||!currentId)return;
    const id=currentId,token=generation,controller=new AbortController();
    refreshing=true;refreshController=controller;
    const here=()=>stillHere(token,id)&&!controller.signal.aborted;
    const read=url=>api(url,'GET',undefined,{signal:controller.signal});
    try{
      const listing=await read(requestURL('',id));if(!here())return;
      const version=versionOf(listing);
      if(version===listingVersion&&currentTab!=='history'){
        if(status.textContent.startsWith('Context refresh failed:'))status.textContent='Context is up to date.';
        return;
      }
      const nextFiles=Array.isArray(listing.files)?listing.files:[];
      let nextTurns=[];
      if(nextFiles.some(row=>row.file==='conversation/context/turns.json')){
        const result=await read(requestURL('/file',id,'conversation/context/turns.json'));if(!here())return;
        nextTurns=Array.isArray(result.value)?result.value:[];
      }
      let audit=null;
      if(currentTab==='history'&&!historyLoading){
        audit=await read(requestURL('/audit',id));if(!here())return;
      }
      // A user may start editing, saving or navigating while reads are pending.
      if(busy||editing||loading)return;
      listingVersion=version;files=nextFiles;turns=nextTurns;summary=listing.summary||{};
      contextSummary=Object.hasOwn(listing,'managedSummary')?effectiveValue(summary,listing.managedSummary,listing.managedSummaryEditMode):summary;
      currentConversationId=listing.conversationId||currentConversationId;
      if(audit&&currentTab==='history'&&!historyLoading){
        const incoming=Array.isArray(audit.items)?audit.items:[],seen=new Set(incoming.map(row=>row.id||JSON.stringify(row)));
        const previous=history||[],total=Number.isSafeInteger(audit.total)?audit.total:incoming.length;
        const overlaps=previous.some(row=>seen.has(row.id||JSON.stringify(row)));
        const contiguous=overlaps||total-historyTotal===incoming.length;
        // More than one page may arrive between polls. Do not skip the unseen
        // middle when retaining cached older pages: reset to a contiguous prefix.
        history=contiguous?[...incoming,...previous.filter(row=>!seen.has(row.id||JSON.stringify(row)))]:incoming;
        // Retain older pages already inspected; new records shift their offsets.
        historyTotal=total;historyNextOffset=Number.isSafeInteger(audit.nextOffset)&&history.length<total?history.length:null;
      }
      const file=selected?.file;
      status.textContent=turns.length+' audit records · '+turns.filter(row=>modelLabels.has(row.label)).length+' model phases · '+files.length+' context files'+(summary.directoryStatus?' · latest run '+summary.directoryStatus:'');
      const scroll=contents.scrollTop,start=contents.selectionStart,end=contents.selectionEnd;
      updateScope();drawRows({preserve:true});
      contents.setSelectionRange(start,end);contents.scrollTop=scroll;
      if(file&&selected?.file===file){
        if(files.some(row=>row.file===file)){const complete=await readFile(file,{preserve:true});if(here()&&!complete)listingVersion='';}
        else display(file,'This context record is no longer present.');
      }
    }catch(error){if(here()&&!busy&&!editing)status.textContent='Context refresh failed: '+error.message+'; retrying automatically.';}
    finally{if(refreshController===controller)refreshController=null;refreshing=false;}
  }
  filter.addEventListener('input',()=>{if(!busy){fileGeneration++;drawRows();}});
  conversationSelect.addEventListener('change',()=>loadConversation(conversationSelect.value));
  async function loadConversation(runId,{tab='overview',notice=''}={}){
    if(!runId||busy)return;
    stopRefresh();loading=true;listingVersion='';const token=++generation;fileGeneration++;currentId=runId;currentConversationId=catalog.find(row=>row.runId===runId)?.conversationId||'';files=[];turns=[];summary={};contextSummary={};history=null;historyTotal=0;historyNextOffset=null;historyLoading=false;
    updateScope();status.textContent='Loading conversation context…';await selectTab(tab);
    try{
      const listing=await api(requestURL('',runId));if(!stillHere(token,runId))return;
      listingVersion=versionOf(listing);files=Array.isArray(listing.files)?listing.files:[];summary=listing.summary||{};contextSummary=Object.hasOwn(listing,'managedSummary')?effectiveValue(summary,listing.managedSummary,listing.managedSummaryEditMode):summary;currentConversationId=listing.conversationId||currentConversationId;
      if(runId===originId)originConversationId=currentConversationId;
      if(files.some(row=>row.file==='conversation/context/turns.json')){
        const result=await api(requestURL('/file',runId,'conversation/context/turns.json'));if(!stillHere(token,runId))return;
        turns=Array.isArray(result.value)?result.value:[];
      }
      const calls=turns.filter(row=>modelLabels.has(row.label)).length;
      status.textContent=notice||turns.length+' audit records · '+calls+' model phases · '+files.length+' context files'+(summary.directoryStatus?' · latest run '+summary.directoryStatus:'');
      updateScope();drawRows();
    }catch(error){if(stillHere(token,runId)){
      listingVersion='';const empty=error.code==='SHADOWDANCER_CONTEXT_NOT_FOUND';
      status.textContent=notice|| (empty?'This conversation has no saved Directory context.':'Context could not be loaded: '+error.message);
      display(empty?'No saved context':'Context unavailable',empty?'Choose another conversation above to import a context record.':error.message);
    }}finally{if(stillHere(token,runId)){loading=false;scheduleRefresh();}}
  }
  async function open({file,tab='overview'}={}){
    const runId=getRunId();if(!runId||destroyed)return;
    originId=runId;originScope=getConversationId()||runId;originConversationId='';catalog=[];currentId=runId;currentConversationId='';setBusy(false);drawConversations();
    if(!dialog.open)dialog.showModal();close.focus({preventScroll:true});
    const reading=loadConversation(runId,{tab}),catalogToken=++catalogGeneration;
    const catalogReading=api(requestURL('/conversations',runId)).then(value=>{
      if(destroyed||!dialog.open||originId!==runId||catalogToken!==catalogGeneration)return;
      catalog=Array.isArray(value.conversations)?value.conversations:[];originConversationId=value.currentConversationId||originConversationId;drawConversations();
    }).catch(error=>{if(!destroyed&&dialog.open&&originId===runId&&catalogToken===catalogGeneration)scopeHelp.textContent='Current conversation context is available. Conversation list could not be loaded: '+error.message;});
    await Promise.all([reading,catalogReading]);
    if(file&&!destroyed&&dialog.open&&originId===runId&&currentId===runId&&files.some(row=>row.file===file))await readFile(file);
  }
  dialog.addEventListener('close',()=>{stopRefresh();generation++;fileGeneration++;catalogGeneration++;loading=false;});
  return {
    open,
    refresh(runId){launch.hidden=!runId;if(dialog.open&&originScope&&(getConversationId()||runId)!==originScope)dialog.close();},
    destroy(){destroyed=true;stopRefresh();generation++;fileGeneration++;dialog.close();launch.remove();dialog.remove();style.remove();}
  };
}
