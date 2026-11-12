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

/** Read-only inspector for the exact saved Directory evidence of a Chat run. */
export function createDirectoryInspector({frame,getRunId}) {
  const doc=frame.ownerDocument;
  const make=(tag,cls,text='')=>{const el=doc.createElement(tag);if(cls)el.className=cls;if(text)el.textContent=text;return el;};
  const actions=frame.querySelector('.next-chat-head-actions')||frame.querySelector('.pb-header-actions');
  const launch=make('button','next-directory-open','Directory Context');
  launch.type='button';launch.hidden=true;launch.title='Inspect Directory model calls, saved turns and exact context files';
  actions?.insertBefore(launch,actions.querySelector('#next-chat-stop'));
  const dialog=make('dialog','next-directory-inspector');
  dialog.setAttribute('aria-labelledby','next-directory-title');
  const head=make('header','next-directory-head');
  const title=make('h2','', 'Directory Context · audit');
  title.id='next-directory-title';
  const close=make('button','next-directory-close','Close');close.type='button';
  close.addEventListener('click',()=>dialog.close());head.append(title,close);
  const status=make('p','next-directory-status','Select a saved Directory run.');
  status.setAttribute('role','status');
  const tabs=make('nav','next-directory-tabs');tabs.setAttribute('role','tablist');
  const tabButtons=new Map();
  for(const [id,label] of [['overview','Overview'],['turns','Model turns'],['files','Context files']]){
    const b=make('button','',label);b.type='button';b.setAttribute('role','tab');
    b.addEventListener('click',()=>selectTab(id));tabs.append(b);tabButtons.set(id,b);
  }
  const split=make('div','next-directory-split');
  const rail=make('aside','next-directory-rail');
  const filter=make('input','next-directory-filter');filter.type='search';filter.placeholder='Filter saved records';filter.setAttribute('aria-label','Filter saved Directory records');
  const records=make('div','next-directory-records');rail.append(filter,records);
  const viewer=make('section','next-directory-viewer');
  const fileLabel=make('strong','next-directory-file-label','Overview');
  const contents=make('textarea','next-directory-contents');
  contents.readOnly=true;contents.spellcheck=false;contents.setAttribute('aria-label','Read-only saved Directory evidence');
  viewer.append(fileLabel,contents);split.append(rail,viewer);
  dialog.append(head,status,tabs,split);frame.append(dialog);
  const style=make('style','');
  style.textContent=`
    .next-directory-inspector{color:#e8edf5;background:#161c27;border:1px solid #465166;border-radius:14px;padding:0;width:min(1080px,94vw);max-width:94vw;max-height:90vh;box-shadow:0 25px 90px #0008}
    .next-directory-inspector::backdrop{background:#000b}
    .next-directory-head{display:flex;align-items:center;justify-content:space-between;padding:15px 20px;border-bottom:1px solid #344054}
    .next-directory-head h2{font-size:17px;margin:0}
    .next-directory-inspector button{color:inherit;background:#243247;border:1px solid #40526c;border-radius:7px;padding:7px 11px;cursor:pointer}
    .next-directory-inspector button:hover{background:#30435e}
    .next-directory-status{margin:10px 20px;font-size:13px;color:#bec9d8;white-space:pre-wrap}
    .next-directory-tabs{display:flex;gap:8px;padding:0 20px 10px}
    .next-directory-tabs button[aria-selected=true]{background:#3c526f;border-color:#8098b6}
    .next-directory-split{display:grid;grid-template-columns:minmax(200px,35%) minmax(0,1fr);gap:12px;padding:0 20px 20px;min-height:300px}
    .next-directory-rail{display:flex;flex-direction:column;gap:8px;min-width:0}
    .next-directory-filter{padding:9px;background:#101723;color:inherit;border:1px solid #445166;border-radius:7px}
    .next-directory-records{display:flex;flex-direction:column;gap:5px;overflow:auto;max-height:55vh}
    .next-directory-records button{text-align:left;overflow-wrap:anywhere;font-size:12px}
    .next-directory-viewer{display:flex;flex-direction:column;gap:8px;min-width:0}
    .next-directory-file-label{font-size:12px;overflow-wrap:anywhere}
    .next-directory-contents{box-sizing:border-box;width:100%;min-height:300px;height:55vh;resize:vertical;background:#0b1220;color:#dce5f3;border:1px solid #42516a;border-radius:7px;padding:12px;font:12px/1.5 ui-monospace,Consolas,monospace}
    @media(max-width:700px){.next-directory-split{grid-template-columns:1fr}.next-directory-records{max-height:180px}.next-directory-contents{height:35vh}}
  `;
  frame.append(style);
  let currentId='', currentTab='overview', files=[],turns=[],summary={};
  const modelLabels=new Set(['decompose','context-page','work','repair','integration','extract-page','page-extract','repository-review']);
  const requestURL=(suffix,runId,file)=>'/api/shadowdancer/context'+suffix+'?runId='+encodeURIComponent(runId)+(file?'&file='+encodeURIComponent(file):'');
  const getJSON=async url=>{const response=await fetch(url,{credentials:'same-origin'});const value=await response.json();if(!response.ok)throw Error(value.error||'Directory context could not be inspected.');return value;};
  const display=(name,value)=>{fileLabel.textContent=name;contents.value=typeof value==='string'?value:JSON.stringify(value,null,2);contents.scrollTop=0;};
  async function readFile(file){
    const id=currentId;display(file,'Loading recorded file…');
    try{const value=await getJSON(requestURL('/file',id,file));if(id===currentId)display(file,value.value);}
    catch(error){if(id===currentId)display(file,'Read failed: '+error.message);}
  }
  function selectTab(id){
    currentTab=id;
    for(const [name,button] of tabButtons)button.setAttribute('aria-selected',String(name===id));
    filter.value='';filter.hidden=id==='overview';drawRows();
  }
  function drawRows(){
    records.replaceChildren();
    if(currentTab==='overview'){
      const modelCalls=turns.filter(row=>modelLabels.has(row.label)).length;
      const stale=Number(summary.totalTurns)!==turns.length;
      display('Recorded context summary',{
        selectedRunId:currentId,
        latestSummaryRunId:summary.currentRun??null,
        directoryStatusOfLatestRun:summary.directoryStatus??'Not recorded in saved summary',
        failure:summary.failure??null,
        auditedTurnsConversation:turns.length,
        auditedTurnsSelectedRun:turns.filter(row=>row.runId===currentId).length,
        modelPhasesConversation:modelCalls,
        modelPhasesSelectedRun:turns.filter(row=>row.runId===currentId&&modelLabels.has(row.label)).length,
        decompositionPhasesSelectedRun:turns.filter(row=>row.runId===currentId&&row.label==='decompose').length,
        savedFiles:files.length,
        plannedWorkItemsLatestRun:summary.plannedWorkItems??'Not recorded',
        summaryReportedTurns:summary.totalTurns??null,
        summaryStale:stale,
        requestOfLatestRun:summary.request??null,
        note:'Model phases are counted from persisted Directory turn labels. Planning graph requests are a separate counter; a click or model response is not proof of an operational outcome.'
      });return;
    }
    const q=filter.value.trim().toLowerCase();
    const rows=currentTab==='turns'?turns.map((row,index)=>({
      label:(index+1)+'. '+row.label+' · '+row.module,
      search:row.label+' '+row.module+' '+row.excerpt,
      act:()=>display(row.label+' · '+row.module,row)
    })):files.map(row=>({
      label:row.file+' · '+row.bytes+' B',search:row.file,
      act:()=>void readFile(row.file)
    }));
    let shown=0;
    for(const row of rows){
      if(q&&!row.search.toLowerCase().includes(q))continue;
      const control=make('button','',row.label);control.type='button';
      control.addEventListener('click',row.act);records.append(control);shown++;
    }
    if(!shown)records.append(make('p','',q?'No matching records.':'No saved records.'));
    display(currentTab==='turns'?'Model turns':'Context files',shown+' recorded entries. Select one to inspect its saved contents.');
  }
  filter.addEventListener('input',drawRows);
  async function open(){
    const runId=getRunId();if(!runId)return;
    currentId=runId;files=[];turns=[];summary={};
    if(!dialog.open)dialog.showModal();
    status.textContent='Loading saved Directory evidence for '+runId+'…';
    selectTab('overview');
    try{
      const listing=await getJSON(requestURL('',runId));
      if(currentId!==runId)return;
      files=Array.isArray(listing.files)?listing.files:[];
      summary=listing.summary||{};
      if(files.some(file=>file.file==='conversation/context/turns.json')){
        const turnFile=await getJSON(requestURL('/file',runId,'conversation/context/turns.json'));
        if(currentId!==runId)return;
        turns=Array.isArray(turnFile.value)?turnFile.value:[];
      }
      const calls=turns.filter(row=>modelLabels.has(row.label)).length;
      status.textContent=files.length?
        'Conversation: '+turns.length+' audit turns · '+calls+' model phases · '+files.length+' context files'+
        ' | Selected run: '+turns.filter(row=>row.runId===runId&&modelLabels.has(row.label)).length+' model phases'+
        (summary.directoryStatus?' · latest run '+summary.directoryStatus:'')+
        (Number(summary.totalTurns)!==turns.length?' · saved summary is stale':''):
        'No Directory evidence is saved for this conversation.';
      selectTab('overview');
    }catch(error){if(currentId===runId){status.textContent='Context inspection failed: '+error.message;display('Unavailable',error.message);}}
  }
  launch.addEventListener('click',()=>void open());
  return {
    open,
    refresh(runId){launch.hidden=!runId;if(dialog.open&&currentId&&runId!==currentId)dialog.close();},
    destroy(){dialog.close();launch.remove();dialog.remove();style.remove();}
  };
}
