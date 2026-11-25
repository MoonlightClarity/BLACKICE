const make=(doc,tag,value='',className='')=>{
  const element=doc.createElement(tag);element.textContent=value;
  if(className)element.className=className;
  return element;
};

/** Editable model-facing tool descriptions. The host owns names and schemas. */
export function createToolDescriptionSettings({mount,api,notify=()=>{}}){
  const doc=mount.ownerDocument;
  const heading=make(doc,'h3','Tool descriptions');
  const help=make(doc,'p',
    'Edit the descriptions BLACKICE sends to models on new turns. Names, argument schemas, permissions and tool behavior are unchanged. Each saved description can be restored to its built-in default.',
    'next-help');
  const controls=make(doc,'div','','next-instruction-controls');
  const choose=make(doc,'select','','next-field'),reload=make(doc,'button','Reload tools');
  choose.id='next-tool-description-select';choose.setAttribute('aria-label','Tool to edit');
  reload.id='next-tool-description-reload';reload.type='button';
  controls.append(choose,reload);
  const form=make(doc,'form','','next-stack');
  form.id='next-tool-description-form';
  const label=make(doc,'label','Model-visible description','next-label');
  label.setAttribute('for','next-tool-description-content');
  const editor=make(doc,'textarea','','next-field next-identity-content');
  editor.id='next-tool-description-content';editor.rows=12;
  editor.maxLength=12000;editor.spellcheck=false;
  const reference=make(doc,'details','','next-compatibility');
  const summary=make(doc,'summary','View built-in description');
  const builtIn=make(doc,'pre','','next-instruction-content');
  builtIn.id='next-tool-description-default';builtIn.style.whiteSpace='pre-wrap';
  reference.append(summary,builtIn);
  const actions=make(doc,'div','','next-row');
  const save=make(doc,'button','Save description','next-primary');
  save.type='submit';save.id='next-tool-description-save';
  const restore=make(doc,'button','Restore default');
  restore.type='button';restore.id='next-tool-description-reset';
  const status=make(doc,'p','','next-help');
  status.id='next-tool-description-status';status.setAttribute('role','status');
  actions.append(save,restore);
  form.append(label,editor,reference,actions,status);
  mount.replaceChildren(heading,help,controls,form);
  let active=false,destroyed=false,reading=0,loading=false,saving=false,revision=0,rows=[],selected='',controller=null;
  const drafts=new Map();
  const current=()=>rows.find(row=>row.name===selected);
  const message=(value)=>{status.textContent=value;};
  const valid=payload=>payload?.version===1&&Number.isSafeInteger(payload.revision)
    &&payload.revision>=0&&Array.isArray(payload.tools)
    &&payload.tools.every(row=>typeof row.name==='string'&&typeof row.description==='string'
      &&typeof row.defaultDescription==='string'&&typeof row.overridden==='boolean');
  function paint(){
    const row=current();
    choose.disabled=loading||saving||!rows.length;
    reload.disabled=loading||saving;
    editor.disabled=loading||saving||!row;
    builtIn.textContent=row?.defaultDescription||'';
    if(row){
      const value=drafts.has(row.name)?drafts.get(row.name):row.description;
      if(editor.value!==value)editor.value=value;
    }else editor.value='';
    const dirty=row&&editor.value!==row.description;
    save.disabled=loading||saving||!row||!dirty||!editor.value.trim();
    restore.disabled=loading||saving||!row||!row.overridden;
  }
  const remember=()=>{const row=current();if(row)drafts.set(row.name,editor.value);};
  async function load(){
    if(destroyed||!active||saving)return;
    const token=++reading;controller?.abort();controller=new AbortController();
    loading=true;message('Loading tool descriptions…');paint();
    try{
      const response=await api('/api/tool-descriptions','GET',undefined,{signal:controller.signal});
      if(token!==reading||!active||destroyed)return;
      if(!valid(response))throw Error('BLACKICE returned invalid tool descriptions.');
      rows=response.tools;revision=response.revision;
      if(!rows.some(row=>row.name===selected))selected=rows[0]?.name||'';
      choose.replaceChildren();
      for(const row of rows){
        const option=make(doc,'option',row.name+(row.overridden?' · edited':''));
        option.value=row.name;choose.append(option);
      }
      choose.value=selected;
      message(rows.length+' tool definitions available · revision '+revision+'.');
    }catch(error){
      if(token===reading&&active&&!destroyed&&error.name!=='AbortError')message(error.message||'Could not load tool descriptions.');
    }finally{if(token===reading){loading=false;controller=null;paint();}}
  }
  async function update(description){
    const row=current();if(!row||saving||loading)return;
    const toolName=row.name,oldRevision=revision,oldDraft=editor.value;
    saving=true;message('Saving '+toolName+'…');paint();
    try{
      const result=await api('/api/tool-descriptions','PUT',{name:toolName,description,expectedRevision:oldRevision});
      if(destroyed)return;
      if(!valid(result))throw Error('BLACKICE did not confirm the saved tool catalog.');
      rows=result.tools;revision=result.revision;
      drafts.delete(toolName);
      const selectedRow=current();
      if(selected===toolName&&selectedRow&&editor.value===oldDraft)editor.value=selectedRow.description;
      message((description===null?'Default restored for ':'Saved description for ')+toolName+' · revision '+revision+'.');
      notify('Tool description saved for '+toolName+'.');
    }catch(error){
      if(!destroyed)message(error.status===409?
        'Another change was saved. Your draft is retained; reload tool descriptions before saving.':
        error.message||'Could not save the tool description.');
    }finally{saving=false;if(!destroyed)paint();}
  }
  choose.addEventListener('change',()=>{remember();selected=choose.value;message('');paint();});
  editor.addEventListener('input',()=>{remember();message('Unsaved changes.');paint();});
  form.addEventListener('submit',event=>{event.preventDefault();void update(editor.value);});
  restore.addEventListener('click',()=>void update(null));
  reload.addEventListener('click',()=>void load());
  return {
    enter(){if(active||destroyed)return;active=true;void load();},
    leave(){active=false;reading++;controller?.abort();controller=null;loading=false;paint();},
    destroy(){this.leave();destroyed=true;mount.replaceChildren();}
  };
}
