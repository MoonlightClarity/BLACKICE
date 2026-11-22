import { browseModels, groupModels, modelIsDefaultPickerVisible, modelProvider } from '../../model-browser.mjs';
import { readyDisabledProvider } from '../../provider-availability.mjs';

const PAGE=80;
const idOf=model=>model?.value??model?.id??model?.model;
const nameOf=model=>{const name=model?.displayName||model?.name||model?.label||model?.id;return model?.shortcut==='local'&&!String(name).startsWith('Local · ')?'Local · '+name:name;};
const unavailableReason=model=>[model?.availabilityReason,model?.error].find(value=>typeof value==='string'&&value.trim())||'This model is unavailable.';
const noop=()=>({update(){},close(){},destroy(){}});

/** The native select owns the chosen value and its existing change handler. */
export function createGroupedModelPicker({select,label='Model',onEnableProvider,onSetupProvider,onBeforeSelect,onOpenAvailability,onRemoveModel}={}){
  const doc=select?.ownerDocument,owner=select?.parentElement;
  if(!select||!doc?.body||!owner)return noop();
  const create=(tag,className,value)=>{const node=doc.createElement(tag);if(className)node.className=className;if(value!==undefined)node.textContent=value;return node;};
  const button=(className,value)=>{const node=create('button',className,value);node.setAttribute('type','button');return node;};
  const wrapper=create('div','next-model-picker'),trigger=button('next-model-picker-trigger'),title=create('span','next-model-picker-title'),subtitle=create('span','next-model-picker-subtitle');
  const triggerText=create('span','next-model-picker-trigger-text'),chevron=create('span','next-model-picker-chevron','▾');chevron.setAttribute('aria-hidden','true');triggerText.append(title,subtitle);trigger.append(triggerText,chevron);wrapper.append(trigger);owner.append(wrapper);
  const panel=create('section','next-model-picker-panel'),header=create('header','next-model-picker-header'),heading=create('strong','',`Choose ${label.toLowerCase()}`),dismiss=button('next-model-picker-dismiss','Close');header.append(heading,dismiss);
  const search=create('input','next-field next-model-picker-search');search.setAttribute('type','search');search.setAttribute('maxlength','200');search.setAttribute('autocomplete','off');search.setAttribute('placeholder','Search models or providers');search.setAttribute('aria-label','Search models or providers');
  const current=create('p','next-model-picker-current'),results=create('div','next-model-picker-results'),summary=create('p','next-model-picker-summary');summary.setAttribute('role','status');summary.setAttribute('aria-live','polite');
  panel.append(header,search,current,results,summary);panel.hidden=true;panel.setAttribute('role','dialog');panel.setAttribute('aria-label',`Choose ${label.toLowerCase()}`);panel.id=`${select.id||'next-model'}-picker`;trigger.setAttribute('aria-haspopup','dialog');trigger.setAttribute('aria-expanded','false');trigger.setAttribute('aria-controls',panel.id);doc.body.append(panel);
  const wasHidden=select.hidden;select.hidden=true;
  let opened=false,destroyed=false,models=[],status={},selected=select.value,signature='',expanded=new Map(),limits=new Map(),activating=null,activationError='',openRevision=0,unavailable={};
  const providerOptions=()=>({providers:[...(status.providers||[]),...(status.subscriptionProviders||[])],defaultProviderId:'codex'});
  const hiddenProviders=()=>Array.isArray(status.runtimeSettings?.hiddenModelProviders)?status.runtimeSettings.hiddenModelProviders:[];
  const options=()=>({...providerOptions(),query:search.value,hiddenModelProviders:hiddenProviders()});
  const localReason=model=>unavailable[model?.id==='default'?status.defaultModel:model?.id];
  const available=model=>Boolean(model)&&!localReason(model)&&model.disabled!==true&&model.available!==false;
  const canEnable=model=>!localReason(model)&&!model?.historical&&typeof onEnableProvider==='function'&&Boolean(readyDisabledProvider(status,model?.id));
  const setupProviders=()=>typeof onSetupProvider==='function'?[
    ...(status.subscriptionProviders||[]).filter(provider=>provider?.id==='mistral-vibe'&&provider.type==='subscription-cli'&&!hiddenProviders().includes(provider.id)&&(provider.authenticated!==true||provider.available!==true||!provider.models?.length)),
    ...(status.localModelProfile?.available&&status.localModelProfile.offerSetup&&!hiddenProviders().includes(status.localModelProfile.providerId||'local_llamacpp')?[{id:'local',name:'MiniCPM for Local',localSetup:true}]:[]),
  ]:[];
  async function setupProvider(id){
    if(activating||!opened||destroyed||select.disabled||!setupProviders().some(provider=>provider.id===id))return;
    const revision=openRevision;activating='setup:'+id;activationError='';render();
    try{await onSetupProvider(id);if(opened&&revision===openRevision)close({restoreFocus:false});}
    catch(error){if(!destroyed&&opened&&revision===openRevision)activationError=error?.message||(id==='local'?'Local model settings could not open.':'Native account settings could not open.');}
    finally{activating=null;if(!destroyed&&opened)render();}
  }
  function setChildren(node,...children){while(node.children.length)node.children[0].remove();node.textContent='';node.append(...children);}
  function position(){
    if(!opened)return;const viewport=doc.defaultView||globalThis.window||{},width=viewport.innerWidth||1024,height=viewport.innerHeight||768,anchor=trigger.getBoundingClientRect(),margin=12,gap=8;
    const above=anchor.top-margin-gap,below=height-anchor.bottom-margin-gap;
    panel.style.width=`${Math.max(240,Math.min(520,width-margin*2))}px`;panel.style.maxHeight=`${Math.max(120,Math.min(580,height-margin*2,Math.max(above,below)))}px`;
    const bounds=panel.getBoundingClientRect();panel.style.left=`${Math.max(margin,Math.min(anchor.left,width-bounds.width-margin))}px`;panel.style.top=`${Math.max(margin,above>below?anchor.top-bounds.height-gap:Math.min(anchor.bottom+gap,height-bounds.height-margin))}px`;
  }
  function refreshTrigger(){
    const choice=models.find(model=>model.id===selected),provider=choice&&!choice.alias&&!choice.historical?modelProvider(choice,providerOptions()):null;
    title.textContent=nameOf(choice)||selected||'Choose a model';
    subtitle.textContent=provider?.label||'';
    trigger.disabled=select.disabled;trigger.setAttribute('aria-label',`${label}: ${title.textContent}${subtitle.textContent?'. '+subtitle.textContent:''}. Choose model`);
    current.textContent=`Selected: ${title.textContent}${subtitle.textContent?' · '+subtitle.textContent:''}`;
    if(opened&&select.disabled)close({restoreFocus:false});
  }
  function commit(id){
    const model=models.find(row=>row.id===id);if(!opened||destroyed||select.disabled||!available(model))return;
    if(!Array.from(select.options||select.children).some(option=>option.value===id))return;
    select.value=id;if(select.value!==id)return;selected=id;refreshTrigger();close();
    const ChangeEvent=doc.defaultView?.Event||globalThis.Event;select.dispatchEvent(new ChangeEvent('change',{bubbles:true}));
  }
  async function choose(id){
    const model=models.find(row=>row.id===id);
    if(activating||!opened||destroyed||select.disabled)return;
    if(available(model)){
      if(typeof onBeforeSelect!=='function'){commit(id);return;}
      const revision=openRevision,original=select.value;activating=id;activationError='';render();
      try{await onBeforeSelect(model);if(!destroyed&&opened&&revision===openRevision&&!select.disabled&&select.value===original)commit(id);}
      catch(error){if(!destroyed&&opened&&revision===openRevision)activationError=error?.message||'Model could not be activated.';}
      finally{activating=null;if(!destroyed&&opened)render();}
      return;
    }
    if(!canEnable(model))return;
    const revision=openRevision,original=select.value;activating=id;activationError='';render();
    try{
      const fresh=await onEnableProvider(id);
      if(!fresh||destroyed||!opened||revision!==openRevision||select.disabled||select.value!==original)return;
      if(!available(models.find(row=>row.id===id)))throw Error('This model is still unavailable. Check its connection in Settings > Models.');
      if(typeof onBeforeSelect==='function')await onBeforeSelect(models.find(row=>row.id===id));
      if(!destroyed&&opened&&revision===openRevision&&!select.disabled&&select.value===original)commit(id);
    }catch(error){if(!destroyed&&opened&&revision===openRevision)activationError=error?.message||'Connection could not be enabled. Open Settings > Models.';}
    finally{activating=null;if(!destroyed&&opened)render();}
  }
  function removable(model){
    if(typeof onRemoveModel!=='function'||model?.historical||model?.alias)return null;
    const at=model.id.indexOf('::');
    if(at<1)return null;
    const providerId=model.id.slice(0,at),id=model.id.slice(at+2);
    const locations={llamacpp:'8080',ollama:'11434',lmstudio:'1234'};
    const provider=(status.providers||[]).find(row=>row.id===providerId);
    if(!provider||!Object.hasOwn(locations,provider.preset)||provider.type!=='compatible'||
        provider.baseUrl!==`http://127.0.0.1:${locations[provider.preset]}/v1`||!provider.models?.some(item=>item.id===id))return null;
    return {providerId,model:id};
  }
  async function remove(id){
    const target=removable(models.find(model=>model.id===id));
    if(!target||activating||!opened||destroyed||select.disabled)return;
    const revision=openRevision;activating='remove:'+id;activationError='';
    // The button is re-rendered and disabled while the mutation is pending.
    search.focus({preventScroll:true});render();
    try{await onRemoveModel(target);}
    catch(error){if(!destroyed&&opened&&revision===openRevision)activationError=error?.message||'Could not remove this local model.';}
    finally{activating=null;if(!destroyed&&opened)render();}
  }
  function modelRow(model){
    const enable=!available(model)&&canEnable(model),entry=create('div','next-model-picker-entry'),row=button('next-model-picker-option');row.dataset.modelValue=model.id;row.setAttribute('aria-pressed',String(model.id===selected));row.disabled=Boolean(activating)||(!available(model)&&!enable);
    const displayName=nameOf(model),body=create('span','next-model-picker-option-body');body.append(create('strong','',displayName));
    if(enable){body.append(create('small','',activating===model.id?'Enabling connection…':'Enable connection'));row.setAttribute('aria-description','Enable this saved API connection and select this model.');}
    else if(!available(model)){
      const reason=localReason(model);
      row.setAttribute('aria-description',reason||unavailableReason(model));
      if(reason)body.append(create('small','',reason));
    }
    const checked=create('span','next-model-picker-selected',model.id===selected?'✓':'');checked.setAttribute('aria-hidden','true');row.append(body,checked);row.addEventListener('click',event=>{event.preventDefault();if(typeof onBeforeSelect==='function'&&available(model)){void choose(model.id);return;}return choose(model.id);});entry.append(row);
    if(removable(model)){
      const removeButton=button('next-model-picker-remove','Remove');
      removeButton.dataset.modelRemove=model.id;
      removeButton.disabled=Boolean(activating);
      removeButton.title='Remove from picker; keep the model file';
      removeButton.setAttribute('aria-label','Remove '+displayName+' from the model picker');
      removeButton.addEventListener('click',event=>{event.preventDefault();return remove(model.id);});
      entry.classList.add('next-model-picker-entry-removable');entry.append(removeButton);
    }
    return entry;
  }
  function render(){
    if(!opened)return;const prior=doc.activeElement,focusValue=prior?.dataset?.modelValue,focusProvider=prior?.dataset?.modelProvider,focusSetup=prior?.dataset?.modelSetupProvider,focusRemove=prior?.dataset?.modelRemove,restore=results.contains(prior);
    // Preserve the exact historical selection in the trigger, but never list
    // a retired native CLI as a new model choice, even with a stale catalog.
    const selectable=models.filter(model=>modelIsDefaultPickerVisible(model)&&!model.historical&&!/^(?:antigravity|qwen_code)::/.test(model.id));
    setChildren(results);const filter=options(),entries=browseModels(selectable.filter(model=>!model.alias),filter),allGroups=groupModels(entries,{...providerOptions(),mode:'connection'});
    // A Local shortcut keeps its concrete provider identity and all ordinary
    // visibility, availability, activation and removal checks.
    const local=entries.filter(model=>model.shortcut==='local'),groups=allGroups.map(group=>({...group,models:group.models.filter(model=>model.shortcut!=='local')})).filter(group=>group.models.length);
    const aliases=selectable.filter(model=>model.alias&&(model.id!=='codex'||!hiddenProviders().includes('codex'))&&(!search.value.trim()||`${model.label} ${model.id}`.toLowerCase().includes(search.value.trim().toLowerCase())));
    const shortcuts=[...aliases,...local];
    if(shortcuts.length){const defaults=create('div','next-model-picker-aliases');defaults.setAttribute('aria-label','Default model choices');for(const model of shortcuts)defaults.append(modelRow(model));results.append(defaults);}
    const query=search.value.trim().toLowerCase().split(/\s+/).filter(Boolean),connections=setupProviders().filter(provider=>query.every(word=>(provider.name+' '+provider.id).toLowerCase().includes(word)));
    if(connections.length){
      const section=create('div','next-model-picker-aliases');section.setAttribute('aria-label',connections.some(provider=>provider.localSetup)?'Model setup':'Native account connections');
      for(const provider of connections){
        const row=button('next-model-picker-option'),body=create('span','next-model-picker-option-body');row.dataset.modelSetupProvider=provider.id;row.disabled=Boolean(activating);
        body.append(create('strong','',`Set up ${provider.name}`),create('small','',provider.localSetup?'Verified model setup':'Native account connection'));row.append(body);
        row.setAttribute('aria-description',provider.localSetup?'Open local model settings without changing the selected model.':'Open native account settings without changing the selected model.');
        row.addEventListener('click',event=>{event.preventDefault();return setupProvider(provider.id);});section.append(row);
      }
      results.append(section);
    }
    for(const group of groups){
      const details=create('details','next-model-picker-group'),caption=create('summary','next-model-picker-group-title'),name=create('span','',group.label),count=create('span','next-model-picker-count',`${group.models.length} model${group.models.length===1?'':'s'}`),body=create('div','next-model-picker-group-models');caption.dataset.modelProvider=group.id;caption.append(name,count);details.append(caption,body);details.dataset.modelProvider=group.id;
      const populate=()=>{
        setChildren(body);if(!details.open)return;const limit=limits.get(group.id)||PAGE;
        for(const model of group.models.slice(0,limit))body.append(modelRow(model));
        if(group.models.length>limit){const more=button('next-model-picker-more',`Show more (${group.models.length-limit} remaining)`);more.dataset.modelMore=group.id;more.addEventListener('click',event=>{event.preventDefault();limits.set(group.id,limit+PAGE);populate();body.querySelector('[data-model-more]')?.focus();position();});body.append(more);}
      };
      details.open=expanded.has(group.id)?expanded.get(group.id):Boolean(search.value.trim());details.addEventListener('toggle',event=>{if(event.target!==details)return;expanded.set(group.id,details.open);populate();position();});results.append(details);populate();
    }
    summary.textContent=activationError||(activating?(activating.startsWith('remove:')?'Removing local model.':activating.startsWith('setup:')?'Opening model settings.':'Preparing the selected model.'):entries.length?`${entries.length} model${entries.length===1?'':'s'} in ${allGroups.length} provider${allGroups.length===1?'':'s'}.`:connections.length?'Set up a native account connection to load its model catalog.':'No matching models. Try another search.');
    if(restore){const target=focusValue?Array.from(results.querySelectorAll('[data-model-value]')).find(node=>node.dataset.modelValue===focusValue):focusProvider?Array.from(results.querySelectorAll('summary')).find(node=>node.dataset.modelProvider===focusProvider):focusSetup?Array.from(results.querySelectorAll('[data-model-setup-provider]')).find(node=>node.dataset.modelSetupProvider===focusSetup):focusRemove?Array.from(results.querySelectorAll('[data-model-remove]')).find(node=>node.dataset.modelRemove===focusRemove):null;(target||search).focus({preventScroll:true});}
    position();
  }
  function close({restoreFocus=true}={}){if(!opened)return;const owned=panel.contains(doc.activeElement);opened=false;openRevision++;panel.hidden=true;trigger.setAttribute('aria-expanded','false');if(restoreFocus&&owned&&!destroyed)trigger.focus({preventScroll:true});}
  async function refreshAvailability(revision){
    if(typeof onOpenAvailability!=='function')return;
    try{
      const result=await onOpenAvailability(models);
      if(destroyed||!opened||revision!==openRevision)return;
      unavailable=result||{};render();
    }catch{/* Keep the prior check; the backend will still validate a load. */}
  }
  function open(){if(destroyed||select.disabled)return;if(opened){close();return;}opened=true;openRevision++;activationError='';expanded=new Map();limits=new Map();search.value='';panel.hidden=false;trigger.setAttribute('aria-expanded','true');render();search.focus({preventScroll:true});void refreshAvailability(openRevision);}
  const onTrigger=event=>{event.preventDefault();open();};
  const onTriggerKey=event=>{if(['ArrowDown','ArrowUp'].includes(event.key)){event.preventDefault();if(!opened)open();}};
  const onFilter=()=>{expanded.clear();limits.clear();render();};
  const visibleInDetails=node=>{let child=node,parent=node.parentElement;while(parent&&parent!==results){if(parent.tagName==='DETAILS'&&!parent.open&&child.tagName!=='SUMMARY')return false;child=parent;parent=parent.parentElement;}return true;};
  const onKey=event=>{
    if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close();return;}
    if(event.isComposing||!['ArrowDown','ArrowUp'].includes(event.key))return;
    if(event.target!==search&&!results.contains(event.target))return;
    const targets=Array.from(results.querySelectorAll('summary,[data-model-value],[data-model-more],[data-model-setup-provider],[data-model-remove]')).filter(node=>!node.disabled&&visibleInDetails(node));
    if(!targets.length)return;event.preventDefault();const current=targets.indexOf(doc.activeElement),next=event.key==='ArrowDown'?(current+1)%targets.length:(current<=0?targets.length-1:current-1);targets[next].focus();
  };
  const onOutside=event=>{if(opened&&!panel.contains(event.target)&&!trigger.contains(event.target))close({restoreFocus:false});};
  const onDismiss=event=>{event.preventDefault();close();};
  const onSelect=()=>{selected=select.value;refreshTrigger();if(opened)render();};
  trigger.addEventListener('click',onTrigger);trigger.addEventListener('keydown',onTriggerKey);dismiss.addEventListener('click',onDismiss);search.addEventListener('input',onFilter);panel.addEventListener('keydown',onKey);select.addEventListener('change',onSelect);doc.addEventListener('pointerdown',onOutside,true);doc.addEventListener('focusin',onOutside,true);const viewport=doc.defaultView||globalThis.window;viewport?.addEventListener?.('resize',position);
  return{
    update({models:choices=[],status:nextStatus={},selected:nextSelected=select.value}={}){
      if(destroyed)return;status=nextStatus||{};selected=nextSelected;
      const catalog=new Map();for(const model of status.models||[]){if(model.id)catalog.set(model.id,model);if(model.model)catalog.set(model.model,model);}
      const seen=new Set();models=[];for(const choice of choices){const id=idOf(choice);if(!id||seen.has(id))continue;seen.add(id);const metadata=catalog.get(id)||{},alias=id==='default'||id==='codex';models.push({...metadata,...choice,id,alias,label:choice.label||metadata.displayName||id,available:choice.disabled===true?false:choice.available??metadata.available??(alias||catalog.has(id))});}
      if(selected&&!seen.has(selected))models.push({id:selected,label:selected,available:false,disabled:true,alias:selected==='default'||selected==='codex'});
      refreshTrigger();const next=JSON.stringify([models,status.providers||[],status.subscriptionProviders||[],status.localModelProfile||null,hiddenProviders(),selected]);if(next!==signature){signature=next;if(opened)render();}
    },close,
    destroy(){if(destroyed)return;close({restoreFocus:false});destroyed=true;select.hidden=wasHidden;wrapper.remove();panel.remove();select.removeEventListener('change',onSelect);doc.removeEventListener('pointerdown',onOutside,true);doc.removeEventListener('focusin',onOutside,true);viewport?.removeEventListener?.('resize',position);},
  };
}
