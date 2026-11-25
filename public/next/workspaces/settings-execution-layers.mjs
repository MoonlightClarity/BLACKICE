const make=(doc,tag,text='',className='')=>{
  const node=doc.createElement(tag);node.textContent=text;
  if(className)node.className=className;return node;
};

/** Source-indexed execution guidance; edits affect future model requests, not saved receipts. */
export function createExecutionLayerSettings({mount,api,notify=()=>{}}){
  const doc=mount.ownerDocument;
  const heading=make(doc,'h3','Execution layers');
  const help=make(doc,'p','Inspect and edit every observed planning, routing and runtime instruction layer. Built-in layers can be replaced, disabled and restored; custom layers can be added or deleted. Tool schemas and host-enforced checks are not editable here. Saved execution audits never change.','next-help');
  const actions=make(doc,'div','','next-instruction-controls');
  const select=make(doc,'select','','next-field');select.id='next-execution-layer-select';select.setAttribute('aria-label','Execution layer');
  const reload=make(doc,'button','Reload layers');reload.type='button';
  actions.append(select,reload);
  const captured=make(doc,'div','','next-instruction-controls');
  const run=make(doc,'input','','next-field');run.id='next-execution-layer-run-id';run.placeholder='Saved turn ID (optional)';
  run.setAttribute('aria-label','Inspect layers from a saved execution');
  const inspect=make(doc,'button','Inspect saved turn');inspect.type='button';
  captured.append(run,inspect);
  const form=make(doc,'form','','next-stack');form.id='next-execution-layer-form';
  const meta=make(doc,'p','','next-help');meta.id='next-execution-layer-source';
  const label=make(doc,'label','Model-facing text','next-label');
  const editor=make(doc,'textarea','','next-field next-identity-content');editor.id='next-execution-layer-text';editor.rows=10;
  editor.maxLength=24000;editor.spellcheck=false;
  label.append(editor);
  const defaultInfo=make(doc,'details','','next-compatibility');
  defaultInfo.append(make(doc,'summary','View observed/default source text'));
  const builtIn=make(doc,'pre','','next-instruction-content');builtIn.style.whiteSpace='pre-wrap';defaultInfo.append(builtIn);
  const buttons=make(doc,'div','','next-instruction-controls');
  const save=make(doc,'button','Save replacement','next-primary');save.type='submit';save.id='next-execution-layer-save';
  const disable=make(doc,'button','Disable / delete');disable.type='button';disable.id='next-execution-layer-disable';
  const restore=make(doc,'button','Restore built-in');restore.type='button';restore.id='next-execution-layer-restore';
  buttons.append(save,disable,restore);
  const addBox=make(doc,'details','','next-compatibility');
  addBox.id='next-execution-layer-add';
  addBox.append(make(doc,'summary','Add execution layer'));
  const addForm=make(doc,'form','','next-stack');addForm.id='next-execution-layer-add-form';
  const title=make(doc,'input','','next-field');title.id='next-execution-layer-add-title';title.placeholder='Layer title';title.maxLength=120;
  const role=make(doc,'select','','next-field');role.id='next-execution-layer-add-role';role.setAttribute('aria-label','Instruction layer role');
  for(const optionValue of ['developer','prompt']){const opt=make(doc,'option',optionValue);opt.value=optionValue;role.append(opt);}
  const contents=make(doc,'textarea','','next-field next-identity-content');contents.id='next-execution-layer-add-text';contents.rows=6;contents.maxLength=24000;
  contents.setAttribute('aria-label','New layer text');
  const add=make(doc,'button','Add layer','next-primary');add.type='submit';add.id='next-execution-layer-add-save';
  addForm.append(title,role,contents,add);addBox.append(addForm);
  const status=make(doc,'p','','next-help');status.id='next-execution-layer-status';status.setAttribute('role','status');
  form.append(meta,label,defaultInfo,buttons);
  mount.replaceChildren(heading,help,actions,captured,form,addBox,status);

  let active=false,destroyed=false,busy=false,loading=false,readId=0,controller=null,revision=0,layers=[],selected='',capturedRun='';
  const drafts=new Map();
  const current=()=>layers.find(layer=>layer.id===selected);
  const describe=layer=>[layer.role.toUpperCase(),layer.source,
    layer.custom?'Owner-added':layer.mode==='disabled'?'Disabled':layer.mode==='replacement'?'Replaced':'Built-in',
    'Revision '+revision].join(' · ');
  function paint(){
    const layer=current();
    select.disabled=loading||busy||!layers.length;
    reload.disabled=loading||busy;
    editor.disabled=loading||busy||!layer||!layer.enabled;
    save.disabled=loading||busy||!layer||!editor.value.trim()||editor.value===layer.text;
    disable.disabled=loading||busy||!layer||!layer.enabled;
    restore.disabled=loading||busy||!layer||layer.custom||layer.mode==='default';
    meta.textContent=layer?describe(layer):'No runtime guidance was discovered.';
    builtIn.textContent=layer?.defaultText??(layer?.custom?'Owner-added layer; no built-in default.':'This layer was observed in an execution but its source is not currently available.');
  }
  const saveDraft=()=>{if(current())drafts.set(current().id,editor.value);};
  function choose(id){
    selected=id;
    const layer=current();
    select.value=id;
    editor.value=drafts.has(id)?drafts.get(id):(layer?.text||'');
    paint();
  }
  async function load(){
    if(!active||destroyed||busy)return;
    const token=++readId;controller?.abort();controller=new AbortController();loading=true;
    status.textContent='Reading execution layers…';paint();
    try{
      const url='/api/execution-layers'+(capturedRun?'?runId='+encodeURIComponent(capturedRun):'');
      const data=await api(url,'GET',undefined,{signal:controller.signal});
      if(token!==readId||!active||destroyed)return;
      if(data?.version!==1||!Number.isSafeInteger(data.revision)||!Array.isArray(data.layers))
        throw Error('BLACKICE returned invalid execution-layer metadata.');
      revision=data.revision;layers=data.layers;
      if(!layers.some(layer=>layer.id===selected))selected=layers[0]?.id||'';
      select.replaceChildren();
      for(const layer of layers){
        const opt=make(doc,'option',layer.title+' ['+layer.id+']'+(layer.enabled?'':' · disabled'));
        opt.value=layer.id;select.append(opt);
      }
      choose(selected);
      status.textContent=layers.length+' source-indexed layers · revision '+revision+'.';
    }catch(error){
      if(token===readId&&active&&!destroyed&&error.name!=='AbortError')
        status.textContent=error.message||'Could not load execution layers.';
    }finally{if(token===readId){loading=false;controller=null;paint();}}
  }
  async function mutate(value){
    if(busy||loading)return;
    busy=true;status.textContent='Saving execution-layer change…';paint();
    try{
      const data=await api('/api/execution-layers'+(capturedRun?'?runId='+encodeURIComponent(capturedRun):''),
        'PUT',{...value,expectedRevision:revision});
      if(destroyed)return;
      if(data?.version!==1||!Array.isArray(data.layers))throw Error('The layer update was not confirmed.');
      revision=data.revision;layers=data.layers;drafts.delete(value.id);
      select.replaceChildren();
      for(const layer of layers){const opt=make(doc,'option',layer.title+' ['+layer.id+']'+(layer.enabled?'':' · disabled'));opt.value=layer.id;select.append(opt);}
      const nextId=data.affected&&layers.some(layer=>layer.id===data.affected)?data.affected:layers.some(layer=>layer.id===selected)?selected:layers[0]?.id||'';
      choose(nextId);
      status.textContent='Saved execution-layer revision '+revision+'. Future model turns will use it.';
      notify('Execution layer updated.');
    }catch(error){
      if(!destroyed)status.textContent=error.status===409?
        'Another edit changed the revision. Your draft remains; reload before retrying.':
        error.message||'Could not save execution-layer change.';
    }finally{busy=false;if(!destroyed)paint();}
  }
  select.addEventListener('change',()=>{saveDraft();choose(select.value);});
  editor.addEventListener('input',()=>{saveDraft();status.textContent='Unsaved changes.';paint();});
  form.addEventListener('submit',event=>{event.preventDefault();if(current())void mutate({action:'replace',id:selected,text:editor.value});});
  disable.addEventListener('click',()=>{
    const layer=current();if(!layer)return;
    void mutate({action:layer.custom?'delete':'disable',id:layer.id});
  });
  restore.addEventListener('click',()=>{if(current())void mutate({action:'reset',id:selected});});
  addForm.addEventListener('submit',event=>{event.preventDefault();if(!title.value.trim()||!contents.value.trim())return;
    void mutate({action:'add',title:title.value,role:role.value,text:contents.value});});
  reload.addEventListener('click',()=>void load());
  inspect.addEventListener('click',()=>{capturedRun=run.value.trim();void load();});
  return{
    enter(){if(active||destroyed)return;active=true;void load();},
    leave(){active=false;readId++;controller?.abort();controller=null;loading=false;},
    destroy(){this.leave();destroyed=true;mount.replaceChildren();}
  };
}
