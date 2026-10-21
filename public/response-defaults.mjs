import {REASONING_LEVELS,reasoningChoices,reasoningLabel} from './reasoning-model.mjs';
const escape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const clone=value=>structuredClone(value);
export function responseDefaults(settings={}){return{defaultEffort:['default',...REASONING_LEVELS].includes(settings.defaultEffort)?settings.defaultEffort:'default',defaultContext:clone(settings.defaultContext||{preset:'model',windowTokens:null,autoCompact:true}),verbosity:['concise','balanced','detailed'].includes(settings.verbosity)?settings.verbosity:'balanced',subagentsEnabled:settings.subagentsEnabled===true,maxSubagents:Number.isSafeInteger(settings.maxSubagents)&&settings.maxSubagents>=1&&settings.maxSubagents<=8?settings.maxSubagents:3};}
export function renderResponseDefaults(status={},state={}) {
 const values={...responseDefaults(status.runtimeSettings),...(state.draft||{})};
 const context=values.defaultContext||{},busy=state.loading||state.saving,disabled=busy?' disabled':'';
 const window=context.preset==='900k'?'900k':context.preset==='custom'?Number(context.windowTokens||0).toLocaleString()+' tokens':'Model default';
 return `<details class="configure-disclosure response-defaults" data-configure-section="response-defaults"${state.open?' open':''}>
   <summary>Agent preferences<span>${escape(values.verbosity)} · ${values.subagentsEnabled?values.maxSubagents+' parallel agents':'one agent'}</span></summary>
   <form id="configure-response-defaults">
     <p class="response-pref-intro">Set how BLACKICE works by default. You can still give different instructions in any conversation.</p>
     <div class="response-default-grid">
       <label for="configure-default-effort">Reasoning
         <select id="configure-default-effort" data-response-default="defaultEffort"${disabled}>${reasoningChoices(status,'default',values.defaultEffort).map(item=>`<option value="${escape(item.value)}"${item.value===values.defaultEffort?' selected':''}>${escape(item.label)}${item.available?'':' · unavailable for this model'}</option>`).join('')}</select>
       </label>
       <label for="configure-verbosity">Response length
         <select id="configure-verbosity" data-response-default="verbosity"${disabled}>${[['concise','Concise'],['balanced','Balanced'],['detailed','Detailed']].map(([value,label])=>`<option value="${value}"${values.verbosity===value?' selected':''}>${label}</option>`).join('')}</select>
       </label>
       <label for="configure-max-subagents">Parallel workers
         <select id="configure-max-subagents" data-response-default="maxSubagents"${disabled||!values.subagentsEnabled?' disabled':''}>${Array.from({length:8},(_,index)=>index+1).map(value=>`<option value="${value}"${values.maxSubagents===value?' selected':''}>${value}</option>`).join('')}</select>
       </label>
     </div>
     <label class="configure-checkbox response-workers-toggle"><input type="checkbox" data-response-default="subagentsEnabled"${values.subagentsEnabled?' checked':''}${disabled}><span><strong>Allow on-demand subagents</strong><small>BLACKICE can delegate independent work. Each worker uses additional model credits.</small></span></label>
     <details class="response-context-advanced"><summary>Advanced context capacity <span>${escape(window)}</span></summary>
       <div class="response-default-grid">
         <label for="configure-default-context">Window budget
           <select id="configure-default-context" data-response-default="preset"${disabled}>${[['model','Model default'],['900k','900k requested'],['custom','Custom window']].map(([value,label])=>`<option value="${value}"${context.preset===value?' selected':''}>${label}</option>`).join('')}</select>
         </label>
         ${context.preset==='custom'?`<label for="configure-default-window">Context tokens<input id="configure-default-window" type="number" min="4096" max="4000000" step="1" data-response-default="windowTokens" value="${escape(context.windowTokens)}"${disabled}></label>`:''}
       </div>
       <p class="configure-runtime-note">BLACKICE handles routine context compaction automatically. Changing a budget doesn't increase a model's supported capacity.</p>
     </details>
     <div class="configure-runtime-save"><span class="configure-runtime-note">New responses use saved defaults. Original conversation history remains available.</span><button type="submit" class="configure-button"${busy||!state.dirty?' disabled':''}>${state.saving?'Saving…':'Save preferences'}</button></div>
     ${state.error?`<p role="alert" class="configure-runtime-error">${escape(state.error)}</p><button type="button" data-configure="defaults-reload" class="configure-button subtle"${disabled}>Reload preferences</button>`:state.receipt?`<p role="status" class="configure-runtime-receipt">${escape(state.receipt)}</p>`:state.loading?'<p role="status">Loading…</p>':''}
   </form>
 </details>`;
}
export function createResponseDefaults({getSettings,api,onChange=()=>{},onSaved=()=>{}}){
 const state={open:false,draft:null,dirty:false,loading:false,saving:false,error:'',receipt:''},keys=new Set(),contextKeys=new Set();let generation=0,revision=0,closed=false;
 const ensure=()=>state.draft||=(responseDefaults(getSettings()));
 const changed=()=>{if(!closed)onChange();};
 async function load(){if(closed||state.loading||state.saving||state.dirty)return;const owner=++generation,version=revision;state.loading=true;state.error='';changed();try{const value=await api('/api/runtime/settings');if(closed||owner!==generation||version!==revision)return;state.draft=responseDefaults(value);keys.clear();contextKeys.clear();state.dirty=false;}catch(error){if(!closed&&owner===generation)state.error=error.message;}finally{if(!closed&&owner===generation){state.loading=false;changed();}}}
 function input(target){const key=target?.dataset?.responseDefault;if(!key)return false;if(closed||state.loading||state.saving)return true;const draft=ensure();state.receipt='';state.error='';
  if(key==='defaultEffort'){if(!['default',...REASONING_LEVELS].includes(target.value)){state.error='Choose a valid reasoning level.';changed();return true;}draft.defaultEffort=target.value;keys.add('defaultEffort');}
  else if(key==='verbosity'){if(!['concise','balanced','detailed'].includes(target.value)){state.error='Choose a verbosity level.';changed();return true;}draft.verbosity=target.value;keys.add('verbosity');}
  else if(key==='subagentsEnabled'){draft.subagentsEnabled=Boolean(target.checked);keys.add('subagentsEnabled');}
  else if(key==='maxSubagents'){const limit=Number(target.value);if(!Number.isSafeInteger(limit)||limit<1||limit>8){state.error='Choose 1 to 8 parallel subagents.';changed();return true;}draft.maxSubagents=limit;keys.add('maxSubagents');}
  else if(['preset','windowTokens','autoCompact'].includes(key)){const context=draft.defaultContext;if(key==='preset'){if(!['model','900k','custom'].includes(target.value))return true;context.preset=target.value;context.windowTokens=target.value==='model'?null:target.value==='900k'?900000:context.windowTokens||900000;contextKeys.add('preset');contextKeys.add('windowTokens');}else if(key==='windowTokens'){context.windowTokens=target.value;contextKeys.add('windowTokens');contextKeys.add('preset');}else{context.autoCompact=Boolean(target.checked);contextKeys.add('autoCompact');}keys.add('defaultContext');}else return false;
  revision++;state.dirty=true;changed();return true;
 }
 async function save(){if(closed||state.loading||state.saving||!state.dirty)return;const patch={};for(const key of keys)patch[key]=key==='defaultContext'?Object.fromEntries([...contextKeys].map(field=>[field,clone(ensure().defaultContext[field])])):clone(ensure()[key]);if(patch.defaultContext){const context=patch.defaultContext;if(context.preset==='custom'){const tokens=Number(context.windowTokens);if(!Number.isSafeInteger(tokens)||tokens<4096||tokens>4000000){state.error='Enter a context window from 4,096 to 4,000,000 tokens.';changed();return;}context.windowTokens=tokens;}}
  const owner=++generation,version=revision;state.saving=true;state.error='';state.receipt='';changed();try{const value=await api('/api/runtime/settings','POST',patch);if(closed||owner!==generation||version!==revision)return;state.draft=responseDefaults(value);state.dirty=false;keys.clear();contextKeys.clear();state.receipt='Defaults saved.';try{await onSaved(value);}catch(error){if(!closed&&owner===generation)state.error=`Saved, but status could not refresh: ${error.message}`;}}catch(error){if(!closed&&owner===generation)state.error=error.message;}finally{if(!closed&&owner===generation){state.saving=false;changed();}}
 }
 return{state,input,save,load,setOpen(value){const opening=Boolean(value)&&!state.open;state.open=Boolean(value);if(opening)return load();},reload(){if(state.saving)return;revision++;state.dirty=false;keys.clear();contextKeys.clear();state.draft=null;return load();},close(){closed=true;generation++;}};
}
