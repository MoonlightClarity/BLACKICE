import { MODEL_SORTS, browseModels, groupModels, modelProvider, modelIsFree } from '../../model-browser.mjs';
import { modelLimitDetails, modelLimitReferences, modelLimitLookupSummary } from '../../provider-catalog.mjs';

const PAGE=80;
const idOf=model=>model?.value??model?.id??model?.model;
const noop=()=>({update(){},close(){},destroy(){}});

/** The native select owns the chosen value and its existing change handler. */
export function createGroupedModelPicker({select,label='Model'}={}){
  const doc=select?.ownerDocument,owner=select?.parentElement;
  if(!select||!doc?.body||!owner)return noop();
  const create=(tag,className,value)=>{const node=doc.createElement(tag);if(className)node.className=className;if(value!==undefined)node.textContent=value;return node;};
  const button=(className,value)=>{const node=create('button',className,value);node.setAttribute('type','button');return node;};
  const wrapper=create('div','next-model-picker'),trigger=button('next-model-picker-trigger'),title=create('span','next-model-picker-title'),subtitle=create('span','next-model-picker-subtitle');
  const triggerText=create('span','next-model-picker-trigger-text'),chevron=create('span','next-model-picker-chevron','▾');chevron.setAttribute('aria-hidden','true');triggerText.append(title,subtitle);trigger.append(triggerText,chevron);wrapper.append(trigger);owner.append(wrapper);
  const panel=create('section','next-model-picker-panel'),header=create('header','next-model-picker-header'),heading=create('strong','',`Choose ${label.toLowerCase()}`),dismiss=button('next-model-picker-dismiss','Close');header.append(heading,dismiss);
  const search=create('input','next-field next-model-picker-search');search.setAttribute('type','search');search.setAttribute('maxlength','200');search.setAttribute('autocomplete','off');search.setAttribute('placeholder','Search models or providers');search.setAttribute('aria-label','Search models or providers');
  const controls=create('div','next-model-picker-filters'),sortLabel=create('label','next-model-picker-sort','Order'),sort=create('select','next-field');sort.setAttribute('aria-label','Model order');
  for(const choice of MODEL_SORTS){const option=create('option','',choice.label);option.setAttribute('value',choice.id);sort.append(option);}sort.value='name';sortLabel.append(sort);controls.append(sortLabel);
  const checks={};for(const [key,text]of [['freeOnly','Free only'],['toolsOnly','Tools'],['visionOnly','Vision']]){const row=create('label','next-model-picker-check'),input=create('input');input.setAttribute('type','checkbox');input.setAttribute('aria-label',text);input.dataset.modelFilter=key;row.append(input,create('span','',text));controls.append(row);checks[key]=input;}
  const current=create('p','next-model-picker-current'),results=create('div','next-model-picker-results'),summary=create('p','next-model-picker-summary');summary.setAttribute('role','status');summary.setAttribute('aria-live','polite');
  panel.append(header,search,controls,current,results,summary);panel.hidden=true;panel.setAttribute('role','dialog');panel.setAttribute('aria-label',`Choose ${label.toLowerCase()}`);panel.id=`${select.id||'next-model'}-picker`;trigger.setAttribute('aria-haspopup','dialog');trigger.setAttribute('aria-expanded','false');trigger.setAttribute('aria-controls',panel.id);doc.body.append(panel);
  const wasHidden=select.hidden;select.hidden=true;
  let opened=false,destroyed=false,models=[],status={},selected=select.value,signature='',expanded=new Map(),limits=new Map();
  const providerOptions=()=>({providers:status.providers||[],defaultProviderId:'codex'});
  const hiddenProviders=()=>Array.isArray(status.runtimeSettings?.hiddenModelProviders)?status.runtimeSettings.hiddenModelProviders:[];
  const options=()=>({...providerOptions(),query:search.value,sort:sort.value,freeOnly:checks.freeOnly.checked,toolsOnly:checks.toolsOnly.checked,visionOnly:checks.visionOnly.checked,hiddenModelProviders:hiddenProviders()});
  const filtered=()=>Boolean(search.value.trim()||Object.values(checks).some(check=>check.checked));
  const available=model=>Boolean(model)&&model.disabled!==true&&model.available!==false;
  function setChildren(node,...children){while(node.children.length)node.children[0].remove();node.textContent='';node.append(...children);}
  function position(){
    if(!opened)return;const viewport=doc.defaultView||globalThis.window||{},width=viewport.innerWidth||1024,height=viewport.innerHeight||768,anchor=trigger.getBoundingClientRect(),margin=12,gap=8;
    const above=anchor.top-margin-gap,below=height-anchor.bottom-margin-gap;
    panel.style.width=`${Math.max(240,Math.min(520,width-margin*2))}px`;panel.style.maxHeight=`${Math.max(120,Math.min(580,height-margin*2,Math.max(above,below)))}px`;
    const bounds=panel.getBoundingClientRect();panel.style.left=`${Math.max(margin,Math.min(anchor.left,width-bounds.width-margin))}px`;panel.style.top=`${Math.max(margin,above>below?anchor.top-bounds.height-gap:Math.min(anchor.bottom+gap,height-bounds.height-margin))}px`;
  }
  function refreshTrigger(){
    const choice=models.find(model=>model.id===selected),provider=choice&&!choice.alias?modelProvider(choice,providerOptions()):null;
    const hidden=provider&&hiddenProviders().includes(provider.id),unavailable=choice&&!available(choice);
    title.textContent=choice?.label||choice?.displayName||selected||'Choose a model';
    subtitle.textContent=[provider?.label,hidden?'Hidden provider':null,unavailable?'Unavailable':null].filter(Boolean).join(' · ');
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
  function modelRow(model){
    const entry=create('div','next-model-picker-entry'),row=button('next-model-picker-option');row.dataset.modelValue=model.id;row.setAttribute('aria-pressed',String(model.id===selected));row.disabled=!available(model);
    const body=create('span','next-model-picker-option-body'),name=create('strong','',model.label||model.displayName||model.id);body.append(name);
    if(!model.alias){body.append(create('small','next-model-picker-id',model.id));for(const [key,value]of modelLimitDetails(model))body.append(create('small','',`${key}: ${value}`));}
    const lookup=!model.alias&&modelLimitLookupSummary(model);if(lookup)body.append(create('small','next-model-picker-lookup',lookup));
    const flags=[model.alias?null:modelIsFree(model)?'Free':null,model.supportsTools===true?'Tools':null,model.hidden===true?'Hidden by Codex':null,!available(model)?'Unavailable':null].filter(Boolean);
    if(flags.length)body.append(create('small','next-model-picker-flags',flags.join(' · ')));
    const checked=create('span','next-model-picker-selected',model.id===selected?'✓':'');checked.setAttribute('aria-hidden','true');row.append(body,checked);row.addEventListener('click',event=>{event.preventDefault();commit(model.id);});entry.append(row);
    if(!model.alias){const references=modelLimitReferences(model);if(references.length){const sources=create('div','next-model-picker-sources');for(const [index,reference]of references.entries()){
      const source=create('small');source.append(create('span','','Source: '));
      if(reference.url){const link=create('a','',reference.label);link.setAttribute('href',reference.url);link.setAttribute('target','_blank');link.setAttribute('rel','noopener noreferrer');link.dataset.modelSource=model.id+':'+index;source.append(link);}
      else source.append(create('span','',reference.label+' · '+reference.path));sources.append(source);
    }entry.append(sources);}}
    return entry;
  }
  function render(){
    if(!opened)return;const prior=doc.activeElement,focusValue=prior?.dataset?.modelValue,focusProvider=prior?.dataset?.modelProvider,focusSource=prior?.dataset?.modelSource,restore=results.contains(prior);
    setChildren(results);const filter=options(),entries=browseModels(models.filter(model=>!model.alias),filter),groups=groupModels(entries,{...providerOptions(),mode:'connection'});
    const aliases=Object.values(checks).some(check=>check.checked)?[]:models.filter(model=>model.alias&&(model.id!=='codex'||!hiddenProviders().includes('codex'))&&(!search.value.trim()||`${model.label} ${model.id}`.toLowerCase().includes(search.value.trim().toLowerCase())));
    if(aliases.length){const defaults=create('div','next-model-picker-aliases');defaults.setAttribute('aria-label','Default model choices');for(const model of aliases)defaults.append(modelRow(model));results.append(defaults);}
    for(const group of groups){
      const details=create('details','next-model-picker-group'),caption=create('summary','next-model-picker-group-title'),name=create('span','',group.label),count=create('span','next-model-picker-count',`${group.models.length} model${group.models.length===1?'':'s'}`),body=create('div','next-model-picker-group-models');caption.dataset.modelProvider=group.id;caption.append(name,count);details.append(caption,body);details.dataset.modelProvider=group.id;
      const populate=()=>{
        setChildren(body);if(!details.open)return;const limit=limits.get(group.id)||PAGE;
        for(const model of group.models.slice(0,limit))body.append(modelRow(model));
        if(group.models.length>limit){const more=button('next-model-picker-more',`Show more (${group.models.length-limit} remaining)`);more.dataset.modelMore=group.id;more.addEventListener('click',event=>{event.preventDefault();limits.set(group.id,limit+PAGE);populate();body.querySelector('[data-model-more]')?.focus();position();});body.append(more);}
      };
      details.open=expanded.has(group.id)?expanded.get(group.id):filtered();details.addEventListener('toggle',()=>{expanded.set(group.id,details.open);populate();position();});results.append(details);populate();
    }
    summary.textContent=entries.length?`${entries.length} model${entries.length===1?'':'s'} in ${groups.length} provider${groups.length===1?'':'s'}.`:'No matching models. Try another search or filter.';
    if(restore){const target=focusValue?Array.from(results.querySelectorAll('[data-model-value]')).find(node=>node.dataset.modelValue===focusValue):focusProvider?Array.from(results.querySelectorAll('summary')).find(node=>node.dataset.modelProvider===focusProvider):focusSource?Array.from(results.querySelectorAll('[data-model-source]')).find(node=>node.dataset.modelSource===focusSource):null;(target||search).focus({preventScroll:true});}
    position();
  }
  function close({restoreFocus=true}={}){if(!opened)return;const owned=panel.contains(doc.activeElement);opened=false;panel.hidden=true;trigger.setAttribute('aria-expanded','false');if(restoreFocus&&owned&&!destroyed)trigger.focus({preventScroll:true});}
  function open(){if(destroyed||select.disabled)return;if(opened){close();return;}opened=true;expanded=new Map();limits=new Map();search.value='';sort.value='name';for(const check of Object.values(checks))check.checked=false;panel.hidden=false;trigger.setAttribute('aria-expanded','true');render();search.focus({preventScroll:true});}
  const onTrigger=event=>{event.preventDefault();open();};
  const onTriggerKey=event=>{if(['ArrowDown','ArrowUp'].includes(event.key)){event.preventDefault();if(!opened)open();}};
  const onFilter=()=>{expanded.clear();limits.clear();render();};
  const onSort=()=>{limits.clear();render();};
  const onKey=event=>{
    if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close();return;}
    if(event.isComposing||!['ArrowDown','ArrowUp'].includes(event.key))return;
    if(event.target!==search&&!results.contains(event.target))return;
    const targets=Array.from(results.querySelectorAll('summary,[data-model-value],[data-model-more],[data-model-source]')).filter(node=>!node.disabled&&(!node.closest('details')||node.tagName==='SUMMARY'||node.closest('details').open));
    if(!targets.length)return;event.preventDefault();const current=targets.indexOf(doc.activeElement),next=event.key==='ArrowDown'?(current+1)%targets.length:(current<=0?targets.length-1:current-1);targets[next].focus();
  };
  const onOutside=event=>{if(opened&&!panel.contains(event.target)&&!trigger.contains(event.target))close({restoreFocus:false});};
  const onDismiss=event=>{event.preventDefault();close();};
  const onSelect=()=>{selected=select.value;refreshTrigger();if(opened)render();};
  trigger.addEventListener('click',onTrigger);trigger.addEventListener('keydown',onTriggerKey);dismiss.addEventListener('click',onDismiss);search.addEventListener('input',onFilter);sort.addEventListener('change',onSort);for(const check of Object.values(checks))check.addEventListener('change',onFilter);panel.addEventListener('keydown',onKey);select.addEventListener('change',onSelect);doc.addEventListener('pointerdown',onOutside,true);doc.addEventListener('focusin',onOutside,true);const viewport=doc.defaultView||globalThis.window;viewport?.addEventListener?.('resize',position);
  return{
    update({models:choices=[],status:nextStatus={},selected:nextSelected=select.value}={}){
      if(destroyed)return;status=nextStatus||{};selected=nextSelected;
      const catalog=new Map();for(const model of status.models||[]){if(model.id)catalog.set(model.id,model);if(model.model)catalog.set(model.model,model);}
      const seen=new Set();models=[];for(const choice of choices){const id=idOf(choice);if(!id||seen.has(id))continue;seen.add(id);const metadata=catalog.get(id)||{},alias=id==='default'||id==='codex';models.push({...metadata,...choice,id,alias,label:choice.label||metadata.displayName||id,available:choice.disabled===true?false:choice.available??metadata.available??(alias||catalog.has(id))});}
      if(selected&&!seen.has(selected))models.push({id:selected,label:selected,available:false,disabled:true,alias:selected==='default'||selected==='codex'});
      refreshTrigger();const next=JSON.stringify([models,status.providers||[],hiddenProviders(),selected]);if(next!==signature){signature=next;if(opened)render();}
    },close,
    destroy(){if(destroyed)return;close({restoreFocus:false});destroyed=true;select.hidden=wasHidden;wrapper.remove();panel.remove();select.removeEventListener('change',onSelect);doc.removeEventListener('pointerdown',onOutside,true);doc.removeEventListener('focusin',onOutside,true);viewport?.removeEventListener?.('resize',position);},
  };
}
