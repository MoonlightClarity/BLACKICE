const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const states = {pending:'Waiting for your review',approved:'Approved; waiting for admission',consumed:'Continuation reserved',cancelled:'Cancelled',expired:'Expired',stale:'Changed; approval invalid'};
const validRevision = value => Number.isSafeInteger(value) && value >= 0;
const safeText = value => typeof value === 'string' ? value : '';
const fields = (object, names) => Object.fromEntries(names.map(key => [key, safeText(object?.[key])]));
const riskText = 'An earlier command has unknown effects. Continuing could overlap or repeat an unrecorded effect. The old UNKNOWN history is preserved; it is not marked successful or absent.';
const description = value => { try { return JSON.stringify(value, null, 2); } catch { return 'Details unavailable'; } };

/** Host-composed metadata only. UI never supplies an action, actor or approval flag. */
export function ownerRecoveryView(value = {}) {
  return {
    localManagement: value.localManagement === true,
    nativeConfirmationAvailable: value.nativeConfirmationAvailable === true,
    requests: (Array.isArray(value.requests) ? value.requests : []).map(row => ({
      ...fields(row, ['requestId','taskId','runId','nodeId','createdAt','expiresAt','risk']),
      revision: row.revision,
      state: Object.hasOwn(states, row.state) ? row.state : 'unavailable',
      oneUse: row.oneUse === true,
      candidate: row.candidate && typeof row.candidate === 'object' && !Array.isArray(row.candidate) ? structuredClone(row.candidate) : {},
      claims: (Array.isArray(row.claims) ? row.claims : []).map(claim => fields(claim, ['operationId','taskId','effectState','summary','rowDigest','journalDigest']))
    }))
  };
}
function actionable(row, now) {
  return row.state === 'pending' && row.oneUse && row.requestId && validRevision(row.revision)
    && Number.isFinite(Date.parse(row.expiresAt)) && Date.parse(row.expiresAt) > now;
}
export function renderOwnerRecovery(value = {}, {busy = '',error = '',receipt = '',uncertain = '',nativeAvailable = false,now = Date.now()} = {}) {
  const view = ownerRecoveryView(value);
  const button = (action,label,row,disabled=false) => '<button type="button" data-owner-recovery="'+action+'"'+(row?' data-request-id="'+escape(row.requestId)+'"':'')+(disabled?' disabled':'')+'>'+label+'</button>';
  const header = '<header><h2>Review blocked actions</h2><p>No automatic exception is enabled. Only an exact, currently paused action can be reviewed here.</p></header>';
  if (!view.localManagement) return '<section class="owner-recovery" aria-label="Review blocked actions">'+header+'<p>Open Settings in BLACKICE on the host computer to review actions. No continuation has been authorized here.</p></section>';
  const canNative = nativeAvailable && view.nativeConfirmationAvailable;
  return '<section class="owner-recovery" aria-label="Review blocked actions">'+header+
    '<p class="owner-recovery-risk">'+escape(riskText)+'</p>'+
    '<p>Approval applies once to the displayed action only. Other uncertainty and duplicate checks still apply. Shell commands are not eligible. Restart, cancellation, changed preconditions or expiry invalidate the pending review.</p>'+
    (!canNative?'<p class="owner-recovery-warning">Native owner confirmation is unavailable. Review and cancellation controls are disabled; nothing will be authorized from this page.</p>':'')+
    '<div class="owner-recovery-toolbar">'+button('refresh','Check status',null,Boolean(busy))+'</div>'+
    (error?'<p role="alert" class="owner-recovery-warning">'+escape(error)+'</p>':'')+
    (receipt?'<p role="status" aria-live="polite">'+escape(receipt)+'</p>':'')+
    '<div class="owner-recovery-list">'+(view.requests.length?view.requests.map(row=>{
      const ready = canNative && actionable(row,now) && !busy && !error && uncertain !== row.requestId;
      const status = states[row.state] || 'Unavailable; cannot authorize';
      return '<article class="owner-recovery-request" data-owner-request="'+escape(row.requestId)+'"><h3>'+escape(row.candidate.summary||'Paused native action')+'</h3><p class="owner-recovery-state">'+escape(status)+'</p>'+
        '<dl><dt>Action</dt><dd>'+escape(row.candidate.tool+' / '+row.candidate.action)+'</dd><dt>Exact target</dt><dd>'+escape(row.candidate.target)+'</dd><dt>Task / run / worker</dt><dd>'+escape([row.taskId,row.runId,row.nodeId].join(' / '))+'</dd><dt>Expires</dt><dd>'+escape(row.expiresAt)+'</dd></dl>'+
        '<details><summary>Exact action and preconditions</summary><pre>'+escape(description(row.candidate))+'</pre></details>'+
        '<details><summary>Retained uncertainties ('+row.claims.length+')</summary>'+row.claims.map(claim=>'<div class="owner-recovery-claim"><p>'+escape(claim.summary||'Historical command with unknown effects')+'</p><dl><dt>Recorded state</dt><dd>'+escape(claim.effectState)+'</dd><dt>Task / operation</dt><dd>'+escape(claim.taskId+' / '+claim.operationId)+'</dd><dt>Record fingerprint</dt><dd>'+escape(claim.rowDigest)+'</dd><dt>Journal fingerprint</dt><dd>'+escape(claim.journalDigest)+'</dd></dl></div>').join('')+'</details>'+
        (row.risk?'<p class="owner-recovery-risk">'+escape(row.risk)+'</p>':'')+
        (row.state==='consumed'?'<p>The new action was reserved with an UNKNOWN receipt before dispatch. Check its task result; this is not proof that it succeeded.</p>':'')+
        (row.state==='approved'?'<p>Approval is not completion. Current preconditions and all remaining checks must still pass.</p>':'')+
        (row.state==='pending'?'<div class="owner-recovery-actions">'+button('review','Review once in native dialog',row,!ready)+button('cancel','Cancel pending action',row,!ready)+'</div>':'')+
        (uncertain===row.requestId?'<p role="status">The previous request outcome is uncertain. Check status; it will not be resent automatically.</p>':'')+
        '</article>';
    }).join(''):'<p class="owner-recovery-empty">No pending reviews. No historical command will be repeated by opening this panel.</p>')+'</div></section>';
}

/** Shared by both Settings surfaces. Confirmation happens only in the native host. */
export function mountOwnerRecovery({mount,api,desktop=globalThis.relayDesktop,presence,intervalMs=3000,autoStart=true} = {}) {
  if (!mount || typeof api !== 'function') throw Error('Owner recovery requires a Settings mount and local API.');
  const doc=mount.ownerDocument||globalThis.document;
  if(doc?.head&&!doc.getElementById('owner-recovery-css')){
    const link=doc.createElement('link');link.id='owner-recovery-css';link.rel='stylesheet';link.href=new URL('./owner-recovery.css',import.meta.url).href;doc.head.append(link);
  }
  let view={localManagement:presence?.localManagement!==false,nativeConfirmationAvailable:false,requests:[]};
  let active=false,destroyed=false,busy='',error='',receipt='',uncertain='',sequence=0,loading=null,timer;
  const nativeAvailable=()=>typeof desktop?.reviewRetainedEffect==='function'&&typeof desktop?.cancelRetainedEffect==='function';
  function render(){
    if(destroyed)return;
    const focused=doc?.activeElement,action=mount.contains(focused)?focused?.dataset?.ownerRecovery:null,id=focused?.dataset?.requestId;
    mount.innerHTML=renderOwnerRecovery(view,{busy,error,receipt,uncertain,nativeAvailable:nativeAvailable()});
    if(action){const target=[...mount.querySelectorAll('[data-owner-recovery]')].find(el=>el.dataset.ownerRecovery===action&&el.dataset.requestId===id);if(target&&!target.disabled)target.focus({preventScroll:true});}
  }
  async function refresh(){
    if(destroyed||!active||presence?.localManagement===false)return;
    if(loading)return loading;
    const token=++sequence;
    const job=(async()=>{
      try{
        const data=await api('/api/owner-recovery');
        if(destroyed||!active||token!==sequence)return;
        view=ownerRecoveryView(data);
        const row=view.requests.find(item=>item.requestId===uncertain);
        if(row&&row.state!=='pending')uncertain='';
        error='';
      }catch{if(!destroyed&&active&&token===sequence)error='Could not read the current recovery state. No permission is inferred; check status again.';}
      finally{if(!destroyed&&active&&token===sequence)render();}
    })();
    loading=job;try{await job;}finally{if(loading===job)loading=null;}
  }
  async function click(event){
    const button=event.target.closest?.('[data-owner-recovery]');
    if(!button||!mount.contains(button)||button.disabled||busy)return;
    const action=button.dataset.ownerRecovery;
    if(action==='refresh'){await refresh();return;}
    const row=view.requests.find(item=>item.requestId===button.dataset.requestId);
    if(!view.localManagement||!view.nativeConfirmationAvailable||!nativeAvailable()||!row||!actionable(row,Date.now())||uncertain===row.requestId)return;
    if(!['review','cancel'].includes(action))return;
    busy=row.requestId;error='';receipt='';render();
    try{
      const result=await desktop[action==='review'?'reviewRetainedEffect':'cancelRetainedEffect']({requestId:row.requestId,revision:row.revision});
      if(destroyed)return;
      if(result?.cancelled===true)receipt='Native review cancelled. No continuation was approved by this review.';
      else if(['cancelled','expired','stale'].includes(result?.state))receipt=states[result.state]+'. No continuation is authorized by this receipt.';
      else if(['approved','consumed'].includes(result?.state))receipt='Native decision recorded. Check the task result; approval is not proof of success.';
      else {uncertain=row.requestId;error='The native request outcome was not confirmed. Check status before doing anything else.';}
    }catch{
      if(!destroyed){uncertain=row.requestId;error='The native request outcome was not confirmed. It will not be resent. Check status.';}
    }finally{
      if(!destroyed){busy='';render();await refresh();}
    }
  }
  mount.addEventListener('click',click);render();
  const controller={
    refresh,
    enter(){if(destroyed||active)return;active=true;void refresh();timer=setInterval(()=>{if(active&&mount.isConnected&&!busy)void refresh();},intervalMs);timer.unref?.();},
    leave(){active=false;sequence++;clearInterval(timer);},
    update(value){presence=value;if(value?.localManagement===false){controller.leave();view={localManagement:false,requests:[]};render();}},
    destroy(){controller.leave();destroyed=true;mount.removeEventListener('click',click);mount.innerHTML='';},
  };
  if(autoStart)controller.enter();
  return controller;
}
