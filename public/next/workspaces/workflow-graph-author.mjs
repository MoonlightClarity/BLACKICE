import {stableId} from '../core/dom.mjs';
import {workflowSnapshot} from './workflow-edit-model.mjs';
import {createWorkflowCanvas} from './workflow-canvas.mjs';
import {createWorkflowGraphDraft,editWorkflowGraph,validateWorkflowGraphDraft,workflowGraphReadiness} from './workflow-graph-edit.mjs';

/** Explicit workflow graph authoring. All modifications stay in a disposable
 * UI draft until Save, and backend graph validation remains authoritative.
 * The editor cannot assume a read-before-write check is atomic.
 */
export function createWorkflowGraphAuthor({
  mount,api,getBusy=()=>false,getSelectedStageId=()=>'',onSelectStage=()=>{},getCwd=()=>'',notify=()=>{},
  onCreated=()=>{},onDiscardNew=()=>{},onSaved=()=>{},onPreview=()=>{},
}={}){
  mount.innerHTML=[
    '<details id="next-workflow-graph-author" class="next-workflow-editor">',
    '<summary>Build stages and connections</summary>',
    '<p class="next-help">Changes remain local until you choose Save graph. Incomplete graphs can be saved, but not run.</p>',
    '<section id="next-graph-canvas-host" aria-label="Visual graph editor"></section>',
    '<div class="next-workflow-graph-section">',
    '<h3>Add a stage</h3><div class="next-row">',
    '<label class="next-label">Stage type<select id="next-graph-add-type" class="next-field"><option value="agent">Agent</option><option value="approval">Approval</option><option value="output">Output</option></select></label>',
    '<label class="next-label">Stage name<input id="next-graph-add-name" class="next-field" maxlength="120" placeholder="New agent"></label></div>',
    '<label class="next-label">Agent instructions<textarea id="next-graph-add-prompt" class="next-field" rows="3" maxlength="20000" placeholder="What should this agent do?"></textarea></label>',
    '<button id="next-graph-add" type="button">Add stage to draft</button></div>',
    '<div class="next-workflow-graph-section">',
    '<h3>Edit connections</h3><p class="next-help">Use stage IDs shown in the stage list, or select a stage above and insert it into either field.</p>',
    '<div class="next-row"><label class="next-label">Source stage ID<input id="next-graph-source" class="next-field" maxlength="100"></label>',
    '<label class="next-label">Destination stage ID<input id="next-graph-target" class="next-field" maxlength="100"></label></div>',
    '<div class="next-row"><button type="button" id="next-graph-from-selected">Use selected as source</button>',
    '<button type="button" id="next-graph-to-selected">Use selected as destination</button>',
    '<button type="button" id="next-graph-connect">Connect</button>',
    '<button type="button" id="next-graph-disconnect">Disconnect</button></div></div>',
    '<div class="next-workflow-graph-section"><h3>Remove a stage</h3>',
    '<label class="next-label">Stage ID<input id="next-graph-remove-id" class="next-field" maxlength="100"></label>',
    '<div class="next-row"><button id="next-graph-fill-remove" type="button">Use selected stage</button>',
    '<button id="next-graph-remove" type="button">Remove stage and its connections</button></div></div>',
    '<p id="next-graph-readiness" role="status" class="next-help"></p>',
    '<div class="next-row"><button id="next-graph-save" type="button" class="next-primary">Save graph</button>',
    '<button id="next-graph-discard" type="button">Discard graph edits</button></div>',
    '<p id="next-graph-feedback" role="status" class="next-help"></p>',
    '</details>',
  ].join('');
  const $=id=>mount.querySelector('#'+id);
  const ui={details:$('next-workflow-graph-author'),type:$('next-graph-add-type'),
    name:$('next-graph-add-name'),prompt:$('next-graph-add-prompt'),add:$('next-graph-add'),
    source:$('next-graph-source'),target:$('next-graph-target'),
    fromSelected:$('next-graph-from-selected'),toSelected:$('next-graph-to-selected'),
    connect:$('next-graph-connect'),disconnect:$('next-graph-disconnect'),
    removeId:$('next-graph-remove-id'),fillRemove:$('next-graph-fill-remove'),
    remove:$('next-graph-remove'),readiness:$('next-graph-readiness'),
    save:$('next-graph-save'),discard:$('next-graph-discard'),feedback:$('next-graph-feedback')};
  const drafts=new Map();
  let current=null,saving=false,destroyed=false,canvas=null;
  const report=(message,error=false)=>{if(destroyed)return;ui.feedback.textContent=String(message||'');if(error)notify(message,true);};
  const currentEntry=()=>current?drafts.get(current.id)||null:null;
  const preview=()=>currentEntry()?.working||current;
  const hasDraft=()=>Boolean(currentEntry());
  const validForSave=()=>Boolean(current)&&hasDraft()&&!saving&&!getBusy();
  function paint(){
    const draft=currentEntry(),workflow=draft?.working||current;
    ui.details.hidden=!workflow;
    if(!workflow){ui.readiness.textContent='';ui.save.disabled=true;return;}
    const info=workflowGraphReadiness(workflow);
    ui.readiness.textContent=info.ready?'All stages are connected. Graph structure is ready to run.'
      :'Graph not ready to run: '+info.issues.join(' ');
    ui.readiness.dataset.ready=String(info.ready);
    ui.save.disabled=!validForSave();
    ui.type.disabled=saving;
    ui.prompt.disabled=saving||ui.type.value!=='agent';
    canvas?.show(workflow);
  }
  function show(workflow){
    const oldId=current?.id;
    current=workflow||null;
    if(oldId!==current?.id){ui.source.value='';ui.target.value='';ui.removeId.value='';ui.name.value='';ui.prompt.value='';ui.type.value='agent';}
    paint();
    if(oldId!==current?.id)report(hasDraft()?'Unsaved graph edits are still in this workspace.':'');
  }
  function beginNew(){
    if(saving||getBusy())return report('Finish or save other workflow edits before creating a graph.',true);
    const value=createWorkflowGraphDraft({id:stableId('workflow'),name:'New workflow',cwd:getCwd()});
    drafts.set(value.id,{base:null,working:value,isNew:true});
    onCreated(value);
    show(value);
    ui.details.open=true;
    ui.name.focus();
    report('New workflow draft. Add or connect stages, then explicitly Save graph.');
    onPreview(value);
  }
  function mutate(operation){
    if(!current||saving||getBusy())return report('Choose a workflow and finish other edits first.',true);
    const entry=currentEntry()||{base:structuredClone(current),working:structuredClone(current),isNew:false};
    try{
      const next=editWorkflowGraph(entry.working,operation);
      // A structural edit must not retain a disconnected or deleted UI node.
      validateWorkflowGraphDraft(next);
      entry.working=next;
      drafts.set(current.id,entry);
      paint();onPreview(next);
      return true;
      report('Graph changed in this workspace only. Review the connections and choose Save graph.');
    }catch(error){report(error.message,true);return false;}
  }
  ui.type.addEventListener('change',()=>{ui.prompt.disabled=ui.type.value!=='agent';});
  ui.add.addEventListener('click',()=>{
    const type=ui.type.value;
    mutate({type:'add-node',node:{id:stableId(type),type,name:ui.name.value.trim()||undefined,prompt:type==='agent'?ui.prompt.value:undefined}});
    // Preserve inputs on invalid edits so the user can correct them.
  });
  ui.fromSelected.addEventListener('click',()=>{const id=getSelectedStageId();if(id)ui.source.value=id;else report('Select a stage in the editor above.',true);});
  ui.toSelected.addEventListener('click',()=>{const id=getSelectedStageId();if(id)ui.target.value=id;else report('Select a stage in the editor above.',true);});
  ui.connect.addEventListener('click',()=>mutate({type:'connect',id:stableId('edge'),source:ui.source.value.trim(),target:ui.target.value.trim()}));
  ui.disconnect.addEventListener('click',()=>mutate({type:'disconnect',source:ui.source.value.trim(),target:ui.target.value.trim()}));
  ui.fillRemove.addEventListener('click',()=>{const id=getSelectedStageId();if(id)ui.removeId.value=id;else report('Select a stage in the editor above.',true);});
  ui.remove.addEventListener('click',()=>mutate({type:'remove-node',id:ui.removeId.value.trim()}));
  ui.discard.addEventListener('click',()=>{
    const entry=currentEntry();
    if(!entry||saving)return;
    const id=current.id;drafts.delete(id);
    if(entry.isNew){current=null;onDiscardNew(id);report('Unsent new workflow discarded.');return;}
    paint();onPreview(current);report('Unsaved graph edits discarded.');
  });
  async function save(){
    const entry=currentEntry();
    if(!entry||saving||getBusy())return report('Finish other workflow edits before saving the graph.',true);
    let proposed;
    try{proposed=validateWorkflowGraphDraft(entry.working);}
    catch(error){report(error.message,true);return;}
    saving=true;ui.details.inert=true;ui.save.disabled=true;
    report('Checking the saved workflow before writing…');
    const id=proposed.id;
    try{
      let original=null;
      try{original=await api('/api/workflows/'+encodeURIComponent(id));}
      catch(error){if(!(entry.isNew&&error.status===404))throw error;}
      if(entry.isNew ? Boolean(original) : !original||workflowSnapshot(original)!==workflowSnapshot(entry.base))
        throw Error('This workflow changed since editing began. Refresh and review it before another save.');
      // The HTTP backend currently has no atomic If-Match graph write.
      // Detect known conflicts; never retry an uncertain POST automatically.
      const saved=await api('/api/workflows','POST',proposed);
      if(saved?.id!==id||!Array.isArray(saved.nodes)||!Array.isArray(saved.edges))
        throw Error('Workflow save result was not verified. Refresh before saving again.');
      drafts.delete(id);
      if(current?.id===id)current=saved;
      onSaved(saved);
      if(current?.id===id){show(saved);report('Workflow graph saved.');}
    }catch(error){report(error.message,true);}
    finally{saving=false;ui.details.inert=false;paint();}
  }
  ui.save.addEventListener('click',()=>void save());
  canvas=createWorkflowCanvas({
    mount:$('next-graph-canvas-host'),
    canEdit:()=>!saving&&!getBusy(),
    onMove:(id,x,y)=>mutate({type:'move-node',id,x,y}),
    onConnect:(source,target)=>mutate({type:'connect',id:stableId('edge'),source,target}),
    onDisconnect:(source,target)=>mutate({type:'disconnect',source,target}),
    onRemove:id=>mutate({type:'remove-node',id}),
    onSelect:onSelectStage,
    notify,
  });
  show(null);
  return {
    show,beginNew,preview,hasDraft,isSaving:()=>saving,
    pendingNew:()=>[...drafts.values()].filter(entry=>entry.isNew).map(entry=>entry.working),
    destroy(){destroyed=true;canvas?.destroy();drafts.clear();mount.replaceChildren();current=null;}
  };
}
