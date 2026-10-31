import { replyTarget, running, runText } from '../chat/model.mjs';

const record=value=>value&&typeof value==='object'&&!Array.isArray(value)?value:{};
const positive=value=>Number.isSafeInteger(value)&&value>0?value:null;
const tokens=value=>positive(value)?.toLocaleString('en-US')||'Unknown';
const compactTokens=value=>positive(value)?value%1000===0?(value/1000).toLocaleString('en-US')+'k':tokens(value):'unknown';
const presets=new Set(['model','extended','custom','900k']);
const bounds={outputReserveTokens:[256,128000],headroomTokens:[128,256000],compactAtTokens:[256,4000000],keepRecentTokens:[256,256000]};
const fieldLabels={outputReserveTokens:'Output reserve',headroomTokens:'Safety headroom',compactAtTokens:'Compression trigger',keepRecentTokens:'Recent context to keep'};

/** The catalog describes capacity; a recorded context snapshot describes one turn. */
export function contextModelInfo(status={},selection='default'){
  const selected=selection==='default'?status.defaultModel:selection==='codex'?(status.codex?.defaultModel||status.codex?.models?.find(model=>model.isDefault)?.model||status.models?.find(model=>model.isDefault&&!String(model.id||model.model).includes('::'))?.model):selection;
  const id=typeof selected==='string'?selected:'';
  const model=[...(status.models||[]),...(status.codex?.models||[])].find(item=>(item.id||item.model)===id)||{};
  const native=id?!id.includes('::'):!String(selection).includes('::');
  const defaultWindow=model.contextWindowSource==='user-configured'&&positive(model.contextWindowTokens)?model.contextWindowTokens:positive(model.runtimeDefaultContextWindowTokens)||positive(model.contextWindowTokens);
  const maxWindow=native?positive(model.maxContextWindowTokens):defaultWindow;
  const percent=Number(model.effectiveContextWindowPercent);
  const provider=(status.providers||[]).find(item=>item.id===id.split('::')[0]);
  return {id,native,defaultWindow,maxWindow,percent:native&&percent>0&&percent<=100?percent:null,
    outputLimit:Math.min(positive(model.maxOutputTokens)||8192,positive(provider?.maxTokens)||8192,8192),
    source:model.contextWindowSource||(native&&defaultWindow?'runtime-reported':'unknown'),name:model.displayName||id||'Selected model'};
}

export function contextOptions(value={}){
  const input=record(value),preset=presets.has(input.preset)?input.preset:'model';
  const result={preset,windowTokens:preset==='900k'?900000:preset==='custom'?input.windowTokens??null:null,autoCompact:input.autoCompact!==false};
  for(const key of Object.keys(bounds))if(input[key]!==undefined&&input[key]!==null&&input[key]!=='')result[key]=input[key];
  return result;
}

export function validateContextOptions(value={},info={}){
  const result=contextOptions(value);
  const check=(name,input,min,max)=>{
    if(!Number.isSafeInteger(input)||input<min||input>max)throw Error(name+' must be a whole token count from '+tokens(min)+' to '+tokens(max)+'.');
  };
  if(result.preset==='custom')check('Custom context',result.windowTokens,4096,4000000);
  for(const [key,[min,max]]of Object.entries(bounds))if(result[key]!==undefined)check(fieldLabels[key],result[key],min,max);
  if(result.preset==='extended'&&!info.maxWindow&&!info.defaultWindow)throw Error('Extended context needs a known model capacity. Choose Model default or resolve this model’s limits in Settings.');
  if(result.windowTokens&&(result.outputReserveTokens||0)+(result.headroomTokens||0)>=result.windowTokens)throw Error('Output reserve and safety headroom must leave room for input. Adjust them in Advanced budgets.');
  const inputBudget=contextInputBudget(result,info);
  if(inputBudget!==null&&inputBudget<256)throw Error('Output reserve and safety headroom leave fewer than 256 input tokens. Adjust them in Advanced budgets or choose a larger context budget.');
  if(inputBudget!==null&&result.compactAtTokens>inputBudget)throw Error('The compression trigger exceeds this budget’s estimated usable input allowance of '+tokens(inputBudget)+' tokens. Lower the trigger or choose a larger context budget.');
  return result;
}

export function contextBudgetPreview(options={},info={}){
  const value=contextOptions(options),requested=value.preset==='extended'?info.maxWindow||info.defaultWindow:value.preset==='model'?info.defaultWindow:positive(Number(value.windowTokens));
  const cap=info.native?info.maxWindow||info.defaultWindow:info.defaultWindow||info.maxWindow;
  const window=positive(requested)?Math.min(requested,cap||Infinity):null;
  return {window,requested:positive(requested),usable:window&&info.percent?Math.floor(window*info.percent/100):window,
    estimated:!!(window&&info.percent),capped:!!(window&&requested>window)};
}

function contextInputBudget(options,info){
  const usable=contextBudgetPreview(options,info).usable;
  if(!usable)return null;
  const output=options.outputReserveTokens??Math.max(256,Math.min(info.outputLimit||8192,8192,Math.floor(usable*.2)));
  const headroom=options.headroomTokens??Math.max(128,Math.min(8192,Math.floor(usable*.05)));
  return usable-output-headroom;
}

/** Only bounded statistics cross the worker boundary, never checkpoint text. */
export function contextStatistics(value){
  if(!value||typeof value!=='object'||Array.isArray(value))return undefined;
  const result={};
  for(const key of ['preset','windowSource','nativeWindowBasis','estimateMethod'])if(typeof value[key]==='string')result[key]=value[key].slice(0,300);
  for(const key of ['requestedWindowTokens','modelWindowTokens','configuredModelWindowTokens','effectiveWindowTokens','estimatedInputTokens','actualInputTokens','actualOutputTokens','outputReserveTokens','headroomTokens','inputBudgetTokens','compactAtTokens','keepRecentTokens','remainingTokens','compactionCount','nativeConfiguredWindowTokens','nativeDefaultContextWindowTokens','nativeMaxContextWindowTokens','nativeEffectiveContextWindowPercent','nativeObservedWindowTokens'])if(Number.isFinite(value[key]))result[key]=value[key];
  for(const key of ['remainingIsEstimate','autoCompact'])if(typeof value[key]==='boolean')result[key]=value[key];
  if(Array.isArray(value.warnings))result.warnings=value.warnings.filter(item=>typeof item==='string').slice(0,8).map(item=>item.slice(0,600));
  if(value.lastCompaction)result.lastCompaction=compactionStatistics(value.lastCompaction);
  return result;
}

export function compactionStatistics(value){
  if(!value||typeof value!=='object'||Array.isArray(value))return undefined;
  const result={};
  for(const key of ['at','method','reason','id','summaryModel'])if(typeof value[key]==='string')result[key]=value[key].slice(0,500);
  if(typeof value.compacted==='boolean')result.compacted=value.compacted;
  for(const key of ['beforeTokens','afterTokens','sourceMessageCount','retainedMessageCount','chunks'])if(Number.isFinite(value[key]))result[key]=value[key];
  if(value.checkpoint)result.checkpoint=compactionStatistics({...value.checkpoint,checkpoint:undefined});
  return result;
}

export function conversationContext(runs=[],defaults={}){
  const latest=runs.at(-1),reply=replyTarget(runs),definition=latest?.workflow?.nodes?.find(node=>node.id===reply.nodeId)||[...(latest?.workflow?.nodes||[])].reverse().find(node=>node.type==='agent');
  const state=latest?.nodes?.[definition?.id]||{},model=state.resolvedModel||state.model||definition?.model||'default';
  const savedOptions=definition?.context??latest?.workflow?.settings?.context;
  const contextStatus=state.contextStatus||state.context;
  const recovered=contextStatus&&presets.has(contextStatus.preset)&&(contextStatus.preset!=='custom'||positive(contextStatus.requestedWindowTokens))
    ?{preset:contextStatus.preset,windowTokens:contextStatus.requestedWindowTokens,autoCompact:contextStatus.autoCompact}:null;
  const context=savedOptions??recovered??(latest?{}:defaults);
  const contextOrigin=savedOptions?'saved':recovered?'recorded':latest?'legacy':'default';
  const native=!String(model).includes('::');
  const hasSavedHistory=native&&runs.some(run=>runText(run).trim()
    ||typeof run.output==='string'&&run.output.trim()
    ||Object.values(run.nodes||{}).some(node=>typeof node?.output==='string'&&node.output.trim())
    ||(Array.isArray(run.precomputedMessages)?run.precomputedMessages:[]).some(message=>['user','assistant'].includes(message.role)&&typeof message.text==='string'&&message.text.trim()));
  let reason='Send a message to create a saved conversation first.';
  if(latest){
    if(runs.some(running)||latest.settled!==true)reason='Wait for this conversation to finish before compressing it.';
    else if(!definition||!state.threadId&&!hasSavedHistory)reason=native?'This conversation has no saved messages to restore for compression.':'This conversation has no saved model thread to compress.';
    else reason='';
  }
  return {context:contextOptions(context),contextStatus,contextOrigin,lastCompaction:state.lastCompaction,
    target:latest&&definition?{key:latest.id+':'+definition.id,runId:latest.id,nodeId:definition.id,model,reason}:null,reason};
}

function receiptText(receipt){
  if(receipt.compacted===false)return receipt.reason||'There are no older complete exchanges to compress.';
  const checkpoint=receipt.checkpoint||receipt;
  const before=positive(checkpoint.beforeTokens),after=positive(checkpoint.afterTokens);
  return 'Context compressed'+(before&&after?' · estimated '+tokens(before)+' → '+tokens(after)+' tokens':receipt.method==='codex-native'?' by Codex':'')+'.';
}

/** Requests/results stay scoped to the saved node even while another chat opens. */
export function createContextCompaction({api,onChange=()=>{},onComplete=()=>{}}){
  const operations=new Map();let destroyed=false;
  return {
    state(key){return operations.get(key)||null;},
    async start(target){
      if(destroyed||!target?.runId||!target.nodeId||target.reason)return;
      if(operations.get(target.key)?.pending)return;
      const operation={pending:true,message:'Compressing saved conversation…',error:false,target:{...target}};operations.set(target.key,operation);onChange(target);
      try{
        const result=await api('/api/runs/'+encodeURIComponent(target.runId)+'/compact','POST',{nodeId:target.nodeId});
        if(typeof result?.compacted!=='boolean')throw Error('The runtime did not confirm compression completed. Refresh the conversation to check its status.');
        Object.assign(operation,{pending:false,message:receiptText(result),error:false,result,at:new Date().toISOString()});
        if(!destroyed)onComplete(target,result);
      }catch(error){Object.assign(operation,{pending:false,message:String(error?.message||error),error:true});}
      finally{if(!destroyed)onChange(target);}
    },
    async stop(key){
      const operation=operations.get(key);
      if(destroyed||!operation?.pending||operation.cancelPending||operation.cancelRequested)return;
      const target=operation.target;operation.cancelPending=true;operation.message='Requesting compression stop…';operation.error=false;onChange(target);
      try{
        await api('/api/runs/'+encodeURIComponent(target.runId)+'/cancel','POST',{});
        operation.cancelRequested=true;
        if(operation.pending)operation.message='Stop requested. Waiting for compression to settle…';
      }catch(error){if(operation.pending){operation.message='Could not request stop: '+String(error?.message||error);operation.error=true;}}
      finally{operation.cancelPending=false;if(!destroyed)onChange(target);}
    },
    destroy(){destroyed=true;},
  };
}

export function createContextControls({mount,id='next-context',scope='chat',api,onChange=()=>{},onOperationChange=()=>{},onComplete=()=>{},onClose=()=>{}}){
  const defaults=scope==='defaults';
  mount.classList.add('next-context-controls');
  mount.dataset.scope=scope;
  mount.innerHTML=[
    '<div class="next-context-heading" id="'+id+'-heading"><button type="button" id="'+id+'-toggle" aria-expanded="false" aria-controls="'+id+'-body">'+(defaults?'Context settings':'Close context settings')+'</button>',
    '<span id="'+id+'-summary" class="next-help"></span>',
    '</div><div id="'+id+'-body" class="next-context-body" hidden>',
    '<p class="next-help">'+(defaults?'Default context for new conversations. Existing conversations keep their saved context settings.':'These settings apply to your next response. /compress uses this conversation’s saved settings.')+'</p>',
    '<div class="next-settings-grid"><label class="next-label">Context budget<select class="next-field" id="'+id+'-preset"><option value="model">Model default</option><option value="extended">Extended</option><option value="custom">Custom</option><option value="900k" hidden>Legacy 900k request</option></select></label>',
    '<label class="next-label" id="'+id+'-window-label" hidden>Custom budget (tokens)<input class="next-field" type="number" min="4096" max="4000000" step="1" id="'+id+'-window"></label></div>',
    '<p id="'+id+'-capacity" class="next-help"></p><p id="'+id+'-budget-note" class="next-help"></p>',
    '<label class="next-row"><input type="checkbox" id="'+id+'-auto"><span id="'+id+'-auto-label"></span></label>',
    '<p id="'+id+'-auto-help" class="next-help"></p>',
    '<div id="'+id+'-api-options" class="next-settings-grid"><label class="next-label"><span id="'+id+'-trigger-label">Compression trigger (tokens)</span><input class="next-field" type="number" min="256" max="4000000" step="1" placeholder="Automatic" id="'+id+'-trigger"></label>',
    '<label class="next-label" id="'+id+'-recent-label">Recent context to keep (tokens)<input class="next-field" type="number" min="256" max="256000" step="1" placeholder="Automatic" id="'+id+'-recent"></label></div>',
    '<p id="'+id+'-trigger-help" class="next-help"></p>',
    '<details id="'+id+'-advanced"><summary>Advanced budgets</summary><p class="next-help">Reserve room for the answer and safety margin. Blank uses the runtime’s calculated default.</p>',
    '<div class="next-settings-grid"><label class="next-label">Output reserve (tokens)<input class="next-field" type="number" min="256" max="128000" step="1" placeholder="Automatic" id="'+id+'-reserve"></label>',
    '<label class="next-label">Safety headroom (tokens)<input class="next-field" type="number" min="128" max="256000" step="1" placeholder="Automatic" id="'+id+'-headroom"></label></div></details>',
    '<p id="'+id+'-saved" class="next-help"></p><p id="'+id+'-warnings" class="next-help"></p>',
    '</div><div id="'+id+'-result" class="next-context-result" hidden><p id="'+id+'-feedback" class="next-context-feedback next-help" role="status" aria-live="polite"></p>',
    defaults?'':'<button type="button" id="'+id+'-stop" hidden>Stop compression</button>',
    '</div>',
  ].join('');
  const $=suffix=>mount.querySelector('#'+id+'-'+suffix);
  const f={heading:$('heading'),toggle:$('toggle'),body:$('body'),summary:$('summary'),stop:$('stop'),preset:$('preset'),window:$('window'),windowLabel:$('window-label'),capacity:$('capacity'),budgetNote:$('budget-note'),auto:$('auto'),autoLabel:$('auto-label'),autoHelp:$('auto-help'),triggerLabel:$('trigger-label'),triggerHelp:$('trigger-help'),recentLabel:$('recent-label'),trigger:$('trigger'),recent:$('recent'),advanced:$('advanced'),reserve:$('reserve'),headroom:$('headroom'),saved:$('saved'),warnings:$('warnings'),feedback:$('feedback'),result:$('result')};
  let base=contextOptions(),info=contextModelInfo(),snapshot={},dirty=false,revision=0,owner=null,destroyed=false,expanded=false;
  const drafts=new Map();
  const compaction=api&&!defaults?createContextCompaction({api,onChange:target=>{draw();onOperationChange(target);},onComplete}):null;
  const draft=()=>{
    const value={...base,preset:f.preset.value,windowTokens:f.preset.value==='custom'?(f.window.value.trim()?Number(f.window.value):null):null,autoCompact:f.auto.checked};
    for(const [element,key]of [[f.trigger,'compactAtTokens'],[f.recent,'keepRecentTokens'],[f.reserve,'outputReserveTokens'],[f.headroom,'headroomTokens']]){if(element.value.trim())value[key]=Number(element.value);else delete value[key];}
    return contextOptions(value);
  };
  function draw(){
    if(destroyed)return;
    const value=draft(),preview=contextBudgetPreview(value,info),target=snapshot.target,operation=compaction?.state(target?.key),busy=snapshot.busy===true||snapshot.loading===true;
    for(const option of f.preset.children){
      if(option.value==='model')option.textContent='Model default'+(info.defaultWindow?' — '+tokens(info.defaultWindow)+' tokens':'');
      if(option.value==='extended'){option.textContent='Extended'+(info.maxWindow?' — '+tokens(info.maxWindow)+' tokens':' — maximum unavailable');option.disabled=!info.maxWindow;}
      if(option.value==='900k')option.hidden=value.preset!=='900k';
    }
    f.windowLabel.hidden=value.preset!=='custom';
    f.summary.textContent=(value.preset==='extended'?'Extended':value.preset==='custom'?'Custom':value.preset==='900k'?'Legacy 900k':'Model default')+' · '+compactTokens(preview.window)+' tokens'+(dirty?(defaults?' · unsaved default':' · next response'):'');
    f.capacity.textContent=info.name+' · Default capacity: '+tokens(info.defaultWindow)+' tokens · Maximum: '+tokens(info.maxWindow)+' tokens'+(info.source==='model-reference'?' · published model reference':info.source==='user-configured'?' · user configured':'');
    const notes=[];
    if(preview.capped)notes.push('Requested '+tokens(preview.requested)+' tokens; this route caps the budget at '+tokens(preview.window)+'.');
    if(value.preset==='extended'&&!info.maxWindow)notes.push(info.defaultWindow?'The maximum is unavailable. This route will use its known default capacity.':'Resolve this model’s capacity before choosing Extended.');
    if(preview.estimated)notes.push('Estimated usable context: '+tokens(preview.usable)+' tokens after the runtime’s '+info.percent+'% allowance. Actual runtime usage can report a different window.');
    if(value.preset==='900k')notes.push('900k is a saved budget request for the same model, capped by this route’s capacity. Extended follows each model’s own maximum.');
    if(snapshot.contextOrigin==='legacy')notes.push('This older conversation did not record its context settings. Model default is selected for the next response.');
    if(snapshot.contextOrigin==='recorded')notes.push('The budget choice was recovered from this conversation’s recorded runtime context.');
    const inputBudget=contextInputBudget(value,info);
    if(inputBudget!==null&&inputBudget<256)notes.push('Output reserve and safety headroom leave too little input space. Adjust them in Advanced budgets.');
    else if(inputBudget!==null&&value.compactAtTokens>inputBudget)notes.push('The saved trigger exceeds the estimated input allowance of '+tokens(inputBudget)+' tokens. Lower it before using this budget.');
    f.budgetNote.textContent=notes.join(' ');
    f.autoLabel.textContent=defaults?'Automatically compress saved history when needed':info.native?'Compress imported saved history automatically':'Automatically compress conversation context';
    f.autoHelp.textContent=defaults?'For API models, this also enables automatic summaries. Codex continues to manage its own automatic compaction.':info.native?'Codex manages automatic compaction during native turns. This option controls BLACKICE’s compression when saved history is restored.':'BLACKICE summarizes older exchanges near the input budget and keeps recent context. Compression uses the selected model; saved messages remain available.';
    f.triggerLabel.textContent=info.native?'Requested Codex compaction trigger (tokens)':'BLACKICE summary trigger (tokens)';
    f.triggerHelp.textContent=info.native?'Blank uses the runtime’s calculated default for the selected budget. Codex may compact earlier.':'Blank uses BLACKICE’s calculated summary threshold for this input budget.';
    f.recentLabel.hidden=info.native;
    for(const input of [f.preset,f.window,f.auto,f.trigger,f.recent,f.reserve,f.headroom])input.disabled=busy||snapshot.readonly===true;
    const current=snapshot.contextStatus||{},parts=[];
    if(!defaults){
      if(positive(current.nativeConfiguredWindowTokens))parts.push('Saved configured window: '+tokens(current.nativeConfiguredWindowTokens));
      if(positive(current.nativeObservedWindowTokens))parts.push('Runtime-reported usable window: '+tokens(current.nativeObservedWindowTokens));
      if(positive(current.effectiveWindowTokens)&&current.effectiveWindowTokens!==current.nativeObservedWindowTokens)parts.push((current.nativeWindowBasis==='metadata-percent'?'Estimated usable window':'Active context budget')+': '+tokens(current.effectiveWindowTokens));
      if(positive(current.actualInputTokens))parts.push('Last reported input: '+tokens(current.actualInputTokens));
      if(positive(current.estimatedInputTokens))parts.push('Estimated current input: '+tokens(current.estimatedInputTokens));
      if(positive(current.compactionCount))parts.push('Compressions: '+current.compactionCount);
      const savedLast=snapshot.lastCompaction||current.lastCompaction;
      const localLast=operation?.result?.compacted?{...operation.result,at:operation.at}:null;
      const last=localLast&&(!savedLast||Date.parse(localLast.at)>=(Date.parse(savedLast.at)||0))?localLast:savedLast;
      if(last){parts.push(receiptText({...last,compacted:last.compacted!==false}));if(typeof last.at==='string')parts.push('Last compression: '+last.at.replace('T',' ').replace('Z',' UTC'));}
      f.saved.textContent=parts.join(' · ')||(target?'No context usage has been reported for this saved conversation.':'Usage appears after the first response.');
    }
    f.warnings.textContent=(current.warnings||[]).filter(item=>typeof item==='string').slice(0,8).join(' ');
    if(f.stop){
      f.stop.hidden=!operation?.pending;f.stop.disabled=Boolean(operation?.cancelPending||operation?.cancelRequested);f.stop.textContent=operation?.cancelRequested?'Stopping…':'Stop compression';
      f.feedback.textContent=operation?.message||'';f.feedback.dataset.error=String(operation?.error===true);
    }
    f.result.hidden=!operation?.message;
    f.heading.hidden=!defaults&&!expanded;f.body.hidden=!expanded;
    f.toggle.setAttribute('aria-expanded',String(expanded));
    mount.dataset.expanded=String(expanded);mount.hidden=!defaults&&!expanded&&!operation?.message;
  }
  function load(value){base=contextOptions(value);f.preset.value=base.preset;f.window.value=base.preset==='custom'?String(base.windowTokens??''):'';f.auto.checked=base.autoCompact;f.trigger.value=String(base.compactAtTokens??'');f.recent.value=String(base.keepRecentTokens??'');f.reserve.value=String(base.outputReserveTokens??'');f.headroom.value=String(base.headroomTokens??'');f.advanced.open=base.outputReserveTokens!==undefined||base.headroomTokens!==undefined;dirty=false;revision++;draw();}
  function changed(){dirty=true;revision++;draw();onChange(draft(),revision);}
  function setExpanded(value,{focus=false}={}){expanded=Boolean(value);draw();if(focus&&expanded)f.preset.focus();if(!expanded&&!defaults)onClose();}
  f.toggle.addEventListener('click',()=>setExpanded(!expanded));
  for(const input of [f.preset,f.auto])input.addEventListener('change',changed);
  for(const input of [f.window,f.trigger,f.recent,f.reserve,f.headroom])input.addEventListener('input',changed);
  mount.addEventListener('keydown',event=>{if(event.key==='Escape'&&!defaults){event.preventDefault();event.stopPropagation();setExpanded(false);}else if(event.key==='Enter'&&event.target?.tagName!=='BUTTON'){event.preventDefault();event.stopPropagation();}});
  f.stop?.addEventListener('click',()=>{if(!f.stop.hidden&&!f.stop.disabled)void compaction?.stop(snapshot.target?.key);});
  load({});
  return {
    load,
    select(key,value){
      if(key===owner){if(!dirty)load(value);return;}
      if(owner!==null){
        if(dirty)drafts.set(owner,{base:{...base},preset:f.preset.value,window:f.window.value,auto:f.auto.checked,trigger:f.trigger.value,recent:f.recent.value,reserve:f.reserve.value,headroom:f.headroom.value,advanced:f.advanced.open,revision});
        else drafts.delete(owner);
      }
      owner=key;const remembered=drafts.get(key);
      if(!remembered){load(value);return;}
      base={...remembered.base};f.preset.value=remembered.preset;f.window.value=remembered.window;f.auto.checked=remembered.auto;f.trigger.value=remembered.trigger;f.recent.value=remembered.recent;f.reserve.value=remembered.reserve;f.headroom.value=remembered.headroom;f.advanced.open=remembered.advanced;dirty=true;revision++;draw();
    },
    commit(key,value,expectedRevision){
      if(key===owner){if(expectedRevision!==undefined&&revision!==expectedRevision)return false;drafts.delete(key);load(value);return true;}
      const remembered=drafts.get(key);if(expectedRevision!==undefined&&remembered&&remembered.revision!==expectedRevision)return false;
      drafts.delete(key);return true;
    },
    reconcile(value){if(!dirty)load(value);},
    update(value={}){snapshot={...snapshot,...value};info=contextModelInfo(snapshot.status||{},snapshot.model||'default');draw();},
    open(){setExpanded(true,{focus:true});},
    close(){setExpanded(false);},
    compress(){
      if(destroyed||!compaction)return{accepted:false,reason:'Context compression is unavailable.'};
      if(compaction.state(snapshot.target?.key)?.pending)return{accepted:true,pending:true};
      const reason=snapshot.loading?'Loading saved conversation…':snapshot.busy?'Wait for the current action to finish.':snapshot.readonly?'Restore this conversation before compressing it.':snapshot.target?.reason||snapshot.reason||(!snapshot.target?'Send a message to create a saved conversation first.':'');
      if(reason)return{accepted:false,reason};
      void compaction.start({...snapshot.target});return{accepted:true};
    },
    stop(){return compaction?.stop(snapshot.target?.key);},
    read(){return validateContextOptions(draft(),info);},
    get dirty(){return dirty;},get revision(){return revision;},
    isCompacting(){return compaction?.state(snapshot.target?.key)?.pending===true;},
    operation(key){return compaction?.state(key);},
    destroy(){destroyed=true;drafts.clear();compaction?.destroy();mount.innerHTML='';},
  };
}
