import {applyWorkflowStageEdits,workflowSnapshot,WORKFLOW_REASONING_EFFORTS,WORKFLOW_PLANNING_MODES,WORKFLOW_PLAN_DETAILS} from './workflow-edit-model.mjs';
import {workflowStageIndex} from './workflow-overview-model.mjs';

/** V2 stage editor for existing saved workflows. Only descriptive fields are
 * editable here; all graph edges, IDs and advanced node metadata are retained.
 */
export function createWorkflowEditor({mount,api,getBusy=()=>false,onSaved=()=>{},notify=()=>{}}={}) {
  mount.innerHTML = [
    '<details id="next-workflow-edit-details" class="next-workflow-editor"><summary>Edit saved workflow and stage settings</summary>',
    '<form id="next-workflow-edit-form" class="next-stack" novalidate>',
    '<p class="next-help">Changes are saved only with Save. Stage identities, connections and untouched options stay unchanged.</p>',
    '<p id="next-workflow-edit-draft-lock" class="next-help" hidden>Save or discard the active graph draft before changing stage settings.</p>',
    '<label class="next-label">Workflow name<input id="next-workflow-edit-name" class="next-field" maxlength="160" required></label>',
    '<label class="next-label">Find stage<input id="next-workflow-edit-stage-search" class="next-field" type="search" placeholder="Search stage names or IDs"></label>',
    '<label class="next-label">Stage<select id="next-workflow-edit-node" class="next-field"></select></label>',
    '<button id="next-workflow-edit-more-stages" type="button" hidden>Show more stages</button>',
    '<label class="next-label">Stage name<input id="next-workflow-edit-node-name" class="next-field" maxlength="120" required></label>',
    '<label class="next-label">Agent instructions<textarea id="next-workflow-edit-prompt" class="next-field" rows="5" maxlength="20000" placeholder="Instructions for this agent stage"></textarea></label>',
    '<fieldset id="next-workflow-edit-assignment-group" class="next-workflow-editor-fields next-workflow-assignment"><legend>Worker assignment</legend>',
    '<p class="next-help">Describe the work, required inputs, expected result and completion criteria.</p>',
    '<button id="next-workflow-edit-assignment-create" type="button">Add worker assignment</button>',
    '<button id="next-workflow-edit-assignment-remove" type="button" hidden>Remove worker assignment</button>',
    '<div id="next-workflow-edit-assignment-fields" class="next-workflow-assignment-fields" hidden>',
    '<label class="next-label">Work scope<textarea id="next-workflow-edit-assignment-scope" class="next-field" rows="3" maxlength="3000" placeholder="What this worker should accomplish"></textarea></label>',
    '<label class="next-label">Required inputs (one per line)<textarea id="next-workflow-edit-assignment-inputs" class="next-field" rows="3" maxlength="200200" placeholder="Sources or handoffs the worker needs"></textarea></label>',
    '<label class="next-label">Expected result<textarea id="next-workflow-edit-assignment-result" class="next-field" rows="3" maxlength="1000" placeholder="A concrete deliverable or finding"></textarea></label>',
    '<label class="next-label">Done when<textarea id="next-workflow-edit-assignment-done" class="next-field" rows="3" maxlength="1000" placeholder="Observable completion criteria"></textarea></label>',
    '</div><p id="next-workflow-edit-assignment-note" class="next-help" role="status"></p></fieldset>',
    '<details id="next-workflow-edit-advanced" class="next-workflow-editor-settings">',
    '<summary>Model and workflow settings</summary>',
    '<p class="next-help">Unavailable models or speed tiers are rejected before a run. Omitted options follow application defaults.</p>',
    '<fieldset id="next-workflow-edit-agent-options" class="next-workflow-editor-fields"><legend>Selected agent</legend>',
    '<label class="next-label">Model identifier<input id="next-workflow-edit-model" class="next-field" maxlength="400" placeholder="default"></label>',
    '<label class="next-label">Reasoning effort<select id="next-workflow-edit-effort" class="next-field"><option value="inherit">Use application default</option>',
    ...WORKFLOW_REASONING_EFFORTS.map(value=>'<option value="'+value+'">'+value+'</option>'),
    '</select></label>',
    '<label class="next-label">Speed tier<select id="next-workflow-edit-tier" class="next-field"><option value="inherit">Use application default</option><option value="default">Standard</option><option value="fast">Fast</option></select></label>',
    '<label class="next-label">Context window<select id="next-workflow-edit-context" class="next-field"><option value="inherit">Use application default</option><option value="model">Model default</option><option value="extended">Extended (model’s supported maximum)</option><option value="900k">Legacy 900k request (capped by provider)</option><option value="custom">Custom window</option></select></label>',
    '<label class="next-label">Custom context tokens<input type="number" id="next-workflow-edit-context-tokens" class="next-field" min="4096" max="4000000" step="1" disabled></label>',
    '<label class="next-label next-workflow-checkbox"><input type="checkbox" id="next-workflow-edit-compact" checked disabled> Automatically compact history</label>',
    '<p class="next-help">Codex continues to manage native automatic compaction. This option controls BLACKICE’s saved-history compression and API-provider summaries.</p>',
    '</fieldset><fieldset class="next-workflow-editor-fields"><legend>Workflow execution</legend>',
    '<label class="next-label">Maximum parallel stages<input type="number" id="next-workflow-edit-parallel" class="next-field" min="1" max="1000" step="1" placeholder="Blank: no application limit"></label>',
    '<label class="next-label">Planning mode<select id="next-workflow-edit-planning" class="next-field"><option value="inherit">Use application default</option>',
    ...WORKFLOW_PLANNING_MODES.map(value=>'<option value="'+value+'">'+value+'</option>'),
    '</select></label>',
    '<label class="next-label">Planning detail<select id="next-workflow-edit-detail" class="next-field"><option value="inherit">Use application default</option>',
    ...WORKFLOW_PLAN_DETAILS.map(value=>'<option value="'+value+'">'+value+'</option>'),
    '</select></label>',
    '</fieldset></details>',
    '<div class="next-row"><button id="next-workflow-edit-save" type="submit" class="next-primary">Save workflow edits</button>',
    '<button id="next-workflow-edit-discard" type="button">Discard unsaved edits</button></div>',
    '<p id="next-workflow-edit-feedback" role="status" class="next-help"></p>',
    '</form></details>',
  ].join('');
  const $=id=>mount.querySelector('#'+id);
  const ui={details:$('next-workflow-edit-details'),form:$('next-workflow-edit-form'),
    draftLock:$('next-workflow-edit-draft-lock'),
    name:$('next-workflow-edit-name'),stage:$('next-workflow-edit-node'),
    stageSearch:$('next-workflow-edit-stage-search'),moreStages:$('next-workflow-edit-more-stages'),
    stageName:$('next-workflow-edit-node-name'),prompt:$('next-workflow-edit-prompt'),
    advanced:$('next-workflow-edit-advanced'),agentOptions:$('next-workflow-edit-agent-options'),
    model:$('next-workflow-edit-model'),effort:$('next-workflow-edit-effort'),
    tier:$('next-workflow-edit-tier'),context:$('next-workflow-edit-context'),
    contextTokens:$('next-workflow-edit-context-tokens'),compact:$('next-workflow-edit-compact'),
    parallel:$('next-workflow-edit-parallel'),planning:$('next-workflow-edit-planning'),
    detail:$('next-workflow-edit-detail'),
    assignmentGroup:$('next-workflow-edit-assignment-group'),assignmentFields:$('next-workflow-edit-assignment-fields'),
    assignmentCreate:$('next-workflow-edit-assignment-create'),assignmentRemove:$('next-workflow-edit-assignment-remove'),
    assignmentScope:$('next-workflow-edit-assignment-scope'),assignmentInputs:$('next-workflow-edit-assignment-inputs'),
    assignmentResult:$('next-workflow-edit-assignment-result'),assignmentDone:$('next-workflow-edit-assignment-done'),
    assignmentNote:$('next-workflow-edit-assignment-note'),
    save:$('next-workflow-edit-save'),discard:$('next-workflow-edit-discard'),
    feedback:$('next-workflow-edit-feedback')};
  const drafts=new Map();
  let current=null,saving=false,stageLimit=80,stageSearchTimer=null;
  const findNode=()=>current?.nodes?.find(item=>item?.id===ui.stage.value);
  const alert=(message,error=false)=>{ui.feedback.textContent=String(message||'');if(error)notify(message,true)};
  function draft(){
    if(!current)return null;
    if(!drafts.has(current.id)) drafts.set(current.id,{name:current.name||'Untitled workflow',nodes:Object.create(null),baseSnapshot:workflowSnapshot(current)});
    return drafts.get(current.id);
  }
  const modified = value => {ui.save.disabled=saving||getBusy()||!current;alert(value||'Unsaved workflow changes.');};
  function contextControls(){
    const custom=ui.context.value==='custom';
    const active=!ui.agentOptions.disabled&&ui.context.value!=='inherit';
    ui.contextTokens.disabled=!active||!custom;
    ui.compact.disabled=!active;
  }
  function paintStage(){
    const node=findNode();
    const update=node?drafts.get(current.id)?.nodes?.[node.id]:null;
    ui.stageName.disabled=!node;
    ui.stageName.value=update?.name??node?.name??node?.id??'';
    const agent=node?.type==='agent';
    ui.agentOptions.disabled=!agent;
    ui.prompt.disabled=!agent;
    ui.prompt.value=agent?(update?.prompt??node.prompt??''):'';
    ui.model.value=agent?(update?.model===null?'':update?.model??node.model??''):'';
    ui.effort.value=agent?(update?.effort??node.effort??'inherit'):'inherit';
    ui.tier.value=agent?(update?.serviceTier??node.serviceTier??'inherit'):'inherit';
    const context=agent?(update?.context===undefined?node.context:update.context):null;
    ui.context.value=context?.preset??'inherit';
    ui.contextTokens.value=context?.preset==='custom'?String(context.windowTokens??''):'';
    ui.compact.checked=context?.autoCompact!==false;
    contextControls();
    const assignment=agent?(update&&Object.hasOwn(update,'assignment')?update.assignment:node.assignment):null;
    ui.assignmentGroup.disabled=!agent;
    ui.assignmentCreate.hidden=!agent||Boolean(assignment);
    ui.assignmentRemove.hidden=!agent||!assignment;
    ui.assignmentFields.hidden=!agent||!assignment;
    ui.assignmentScope.value=assignment?.scope??'';
    ui.assignmentInputs.value=Array.isArray(assignment?.inputs)?assignment.inputs.join('\n'):'';
    ui.assignmentResult.value=assignment?.result??'';
    ui.assignmentDone.value=assignment?.doneWhen??'';
    ui.assignmentNote.textContent=!agent?'Choose an agent stage to edit its assignment.'
      :update&&Object.hasOwn(update,'assignment')?'Assignment changes are saved with Save workflow edits.':'';
  }
  function paintWorkflowSettings(){
    const currentSettings=current?.settings||{};
    const edits=drafts.get(current?.id)?.workflowSettings||{};
    const option=field=>Object.hasOwn(edits,field)?edits[field]:currentSettings[field];
    ui.parallel.value=option('maxParallel')===null||option('maxParallel')===undefined
      ?'':String(option('maxParallel'));
    ui.planning.value=option('planningMode')===undefined?'inherit':option('planningMode')==='off'?'off':'on';
    ui.detail.value=option('planDetail')??'inherit';
  }
  function populateStages(preferred=''){
    ui.stage.replaceChildren();
    if(!current){ui.stage.disabled=true;ui.moreStages.hidden=true;paintStage();return;}
    const {shown,pinned,hidden}=workflowStageIndex(current,{
      query:ui.stageSearch.value,limit:stageLimit,selected:preferred,
    });
    const visible=pinned?[pinned,...shown]:shown;
    for(const node of visible){
      const option=ui.stage.ownerDocument.createElement('option');
      option.value=node.id;
      option.textContent=drafts.get(current.id)?.nodes?.[node.id]?.name||node.name||node.id;
      ui.stage.append(option);
    }
    ui.stage.disabled=!visible.length;
    const selected=visible.some(node=>node.id===preferred)?preferred
      :visible.find(node=>node.type==='agent')?.id||visible[0]?.id||'';
    ui.stage.value=selected;
    ui.moreStages.hidden=!hidden;
    ui.moreStages.textContent=hidden?'Show '+Math.min(80,hidden)+' more stages ('+hidden+' remaining)':'';
    paintStage();
  }
  function show(workflow){
    const previous=current?.id,previousNode=ui.stage.value;
    current=workflow||null;
    ui.details.hidden=!current;
    ui.form.inert=saving||getBusy();
    ui.draftLock.hidden=!current||!getBusy();
    if(!current){
      clearTimeout(stageSearchTimer);stageSearchTimer=null;
      ui.name.value='';ui.stageSearch.value='';stageLimit=80;
      ui.stageName.value='';ui.prompt.value='';populateStages();paintWorkflowSettings();
      ui.save.disabled=true;return;
    }
    if(previous!==current.id){clearTimeout(stageSearchTimer);stageSearchTimer=null;ui.stageSearch.value='';stageLimit=80;}
    const staged=drafts.get(current.id);
    ui.name.value=staged?.name??current.name??'Untitled workflow';
    const preferred=previous===current.id?previousNode
      :(current.nodes||[]).find(node=>node?.type==='agent')?.id||current.nodes?.[0]?.id||'';
    populateStages(preferred);paintWorkflowSettings();
    ui.save.disabled=saving||getBusy()||!staged;
    if(previous!==current.id)alert(staged?'You have unsaved edits to this workflow.':'');
  }
  ui.name.addEventListener('input',()=>{
    const staged=draft();if(!staged)return;
    staged.name=ui.name.value;modified();
  });
  ui.stageSearch.addEventListener('input',()=>{
    clearTimeout(stageSearchTimer);stageLimit=80;
    stageSearchTimer=setTimeout(()=>{stageSearchTimer=null;populateStages(ui.stage.value);},95);
  });
  ui.moreStages.addEventListener('click',()=>{stageLimit+=80;populateStages(ui.stage.value);});
  ui.stage.addEventListener('change',paintStage);
  ui.stageName.addEventListener('input',()=>{
    const staged=draft(),node=findNode();if(!staged||!node)return;
    staged.nodes[node.id]??={};
    staged.nodes[node.id].name=ui.stageName.value;modified();
  });
  ui.prompt.addEventListener('input',()=>{
    const staged=draft(),node=findNode();if(!staged||node?.type!=='agent')return;
    staged.nodes[node.id]??={};
    staged.nodes[node.id].prompt=ui.prompt.value;modified();
  });
  function setAgentOption(field,value){
    const node=findNode(),staged=draft();
    if(!staged||node?.type!=='agent')return;
    staged.nodes[node.id]??={};
    staged.nodes[node.id][field]=value;
    modified();
  }
  ui.model.addEventListener('input',()=>setAgentOption('model',ui.model.value.trim()||null));
  ui.effort.addEventListener('change',()=>setAgentOption('effort',ui.effort.value==='inherit'?null:ui.effort.value));
  ui.tier.addEventListener('change',()=>setAgentOption('serviceTier',ui.tier.value==='inherit'?null:ui.tier.value));
  const changeContext=()=>{
    contextControls();
    const preset=ui.context.value;
    const value=preset==='inherit'?null:{
      preset,autoCompact:ui.compact.checked,
      ...(preset==='custom'?{windowTokens:ui.contextTokens.value===''?null:Number(ui.contextTokens.value)}:{}),
    };
    setAgentOption('context',value);
  };
  ui.context.addEventListener('change',changeContext);
  ui.contextTokens.addEventListener('input',changeContext);
  ui.compact.addEventListener('change',changeContext);
  function assignmentDraft(){
    const node=findNode(),staged=draft();
    if(node?.type!=='agent'||!staged)return null;
    staged.nodes[node.id]??={};
    if(!Object.hasOwn(staged.nodes[node.id],'assignment'))
      staged.nodes[node.id].assignment={...(node.assignment||{})};
    return staged.nodes[node.id];
  }
  for(const [field,element] of [['scope',ui.assignmentScope],['result',ui.assignmentResult],['doneWhen',ui.assignmentDone],['inputs',ui.assignmentInputs]])
    element.addEventListener('input',()=>{
      if(ui.assignmentGroup.disabled||ui.assignmentFields.hidden)return;
      const edit=assignmentDraft();if(!edit?.assignment)return;
      edit.assignment={...edit.assignment,[field]:field==='inputs'
        ?element.value.split(/\r?\n/).map(value=>value.trim()).filter(Boolean):element.value};
      ui.assignmentNote.textContent='Assignment changes are saved with Save workflow edits.';modified();
    });
  ui.assignmentCreate.addEventListener('click',()=>{
    const edit=assignmentDraft();if(!edit)return;
    edit.assignment={scope:'',inputs:[],result:'',doneWhen:''};paintStage();modified();ui.assignmentScope.focus();
  });
  ui.assignmentRemove.addEventListener('click',()=>{
    const edit=assignmentDraft();if(!edit)return;
    edit.assignment=null;paintStage();modified('Assignment removal is staged until Save workflow edits.');
  });
  function setWorkflowSetting(key,value){
    const staged=draft();
    if(!staged)return;
    staged.workflowSettings??={};
    staged.workflowSettings[key]=value;
    modified();
  }
  ui.parallel.addEventListener('input',()=>setWorkflowSetting('maxParallel',
    ui.parallel.value===''?null:Number(ui.parallel.value)));
  ui.planning.addEventListener('change',()=>setWorkflowSetting('planningMode',
    ui.planning.value==='inherit'?null:ui.planning.value));
  ui.detail.addEventListener('change',()=>setWorkflowSetting('planDetail',
    ui.detail.value==='inherit'?null:ui.detail.value));
  ui.discard.addEventListener('click',()=>{
    if(!current)return;
    drafts.delete(current.id);show(current);alert('Unsaved edits discarded.');
  });
  async function save(){
    if(!current)return alert('Select a saved workflow before saving.',true);
    if(saving)return alert('A workflow save is already in progress.',true);
    if(getBusy())return alert('Finish the graph edits or active workflow action before saving.',true);
    if(!drafts.has(current.id))return alert('Make a change before saving.');
    const target=current,selectedId=target.id,staged=drafts.get(selectedId);
    if(staged.baseSnapshot!==workflowSnapshot(target))return alert('This workflow changed since editing began. Refresh and review before saving.',true);
    let proposed;
    try{proposed=applyWorkflowStageEdits(target,drafts.get(target.id)||{});}
    catch(error){alert(error.message,true);return;}
    saving=true;ui.form.inert=true;ui.save.disabled=true;alert('Checking saved workflow before writing…');
    try{
      const fromServer=await api('/api/workflows/'+encodeURIComponent(selectedId));
      if(!fromServer || workflowSnapshot(fromServer)!==staged.baseSnapshot)
        throw Error('This workflow changed since it was opened. Refresh workflows, inspect the changes, and save again.');
      // No implicit retry: a write failure or uncertain outcome requires a
      // fresh read before the user submits another explicit save.
      const result=await api('/api/workflows','POST',proposed);
      if(!result||result.id!==selectedId||!Array.isArray(result.nodes)||!Array.isArray(result.edges))
        throw Error('Workflow save response was not verified. Refresh before another save.');
      drafts.delete(selectedId);
      onSaved(result);
      if(current?.id===selectedId){show(result);alert('Workflow saved.');}
    }catch(error){alert(error.message,true);}
    finally{saving=false;ui.form.inert=getBusy();ui.save.disabled=!current||getBusy()||!drafts.has(current.id);}
  }
  // Enter in a search or text field is not permission to write a workflow.
  // The named Save button is the only interactive submit gesture.
  ui.form.addEventListener('keydown',event=>{
    if(event.key==='Enter'&&event.target!==ui.save&&event.target?.tagName!=='TEXTAREA')event.preventDefault();
  });
  ui.form.addEventListener('submit',event=>{event.preventDefault();void save();});
  show(null);
  return {show,isSaving:()=>saving,
    hasDraft:()=>Boolean(current&&drafts.has(current.id)),
    selectedStageId:()=>findNode()?.id||'',
    selectStage(id){
      if(!current?.nodes?.some(node=>node?.id===id))return false;
      clearTimeout(stageSearchTimer);stageSearchTimer=null;stageLimit=80;
      ui.stageSearch.value='';populateStages(id);
      ui.details.open=true;return true;
    },
    destroy(){clearTimeout(stageSearchTimer);mount.replaceChildren();drafts.clear();current=null;}};
}
