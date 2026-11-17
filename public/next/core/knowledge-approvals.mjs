/** Owner review of model-proposed saved knowledge; nothing is applied on display. */
export function createKnowledgeApprovals({mount,api,events,notify=()=>{},pollMs=15000}) {
  const add=(parent,tag,content='',className='')=>{const el=document.createElement(tag);el.textContent=content;if(className)el.className=className;parent.append(el);return el;};
  const button=add(mount,'button','Review saved-knowledge changes','next-approval-trigger');button.type='button';button.hidden=true;
  const dialog=add(mount,'dialog','','next-approval-dialog');dialog.setAttribute('aria-labelledby','knowledge-approval-title');
  const heading=add(dialog,'h2','Review proposed memory or skill','');heading.id='knowledge-approval-title';
  add(dialog,'p','The model proposed this change. It is not saved or available for reuse until you approve it.','next-help');
  const choices=add(dialog,'nav','','next-approval-choices');choices.setAttribute('aria-label','Pending changes');
  const detail=add(dialog,'section','','next-approval-detail');
  const status=add(dialog,'p','','next-approval-status');status.setAttribute('role','status');status.setAttribute('aria-live','polite');
  const actions=add(dialog,'div','','next-row');
  const reject=add(actions,'button','Reject change'),approve=add(actions,'button','Approve this change','next-primary'),later=add(actions,'button','Not now');
  for(const el of [reject,approve,later])el.type='button';
  let pending=[],selected=null,busy=false,open=false,destroyed=false,epoch=0,refreshing=false,previousFocus=null,timer=null;
  const seen=new Set();
  const message=(value,error=false)=>{status.textContent=value;status.dataset.error=String(error);};
  const close=()=>{if(busy)return;open=false;if(dialog.close)dialog.close();else {dialog.removeAttribute('open');dialog.open=false;}previousFocus?.focus?.();};
  const controls=()=>{approve.disabled=busy||!selected;reject.disabled=busy||!selected;later.disabled=busy;for(const el of choices.querySelectorAll('button'))el.disabled=busy;};
  function renderDetail(){
    detail.replaceChildren();if(!selected){add(detail,'p','No pending change selected.');controls();return;}
    add(detail,'h3',selected.title||'Untitled change');
    add(detail,'p',(selected.kind==='skill'?'Skill':'Memory')+' · '+selected.operation+' · '+(selected.cwd||'Global: all working folders'),'next-approval-scope');
    const source=selected.provenance||{};
    add(detail,'p',[source.runId&&'Source run: '+source.runId,source.reason&&'Reason: '+source.reason].filter(Boolean).join(' · ')||'Proposed by the model.','next-help');
    const grid=add(detail,'div','','next-approval-diff');
    for(const [name,entry] of [['Before',selected.before],['Proposed',selected.after]]){
      const pane=add(grid,'section');add(pane,'h4',name);
      if(!entry){add(pane,'p',name==='Before'?'No saved entry.':'Entry will be removed.');continue;}
      // Full metadata is reviewable: approval must not hide a scope/source/type change.
      const metadata={...entry};delete metadata.content;
      add(pane,'pre',String(entry.content||''),'next-approval-content');
      const more=add(pane,'details');add(more,'summary','Entry details');add(more,'pre',JSON.stringify(metadata,null,2),'next-approval-metadata');
    }
    controls();
  }
  function renderChoices(){
    choices.replaceChildren();
    for(const proposal of pending){const el=add(choices,'button',proposal.title||'Untitled change');el.type='button';el.dataset.approvalId=proposal.id;el.setAttribute('aria-pressed',String(selected?.id===proposal.id));el.addEventListener('click',()=>{if(busy)return;selected=proposal;seen.add(proposal.id);message('');renderChoices();renderDetail();});}
    button.hidden=!pending.length;button.textContent='Review '+pending.length+' proposed '+(pending.length===1?'change':'changes');controls();
  }
  function show(){
    if(destroyed)return;previousFocus=document.activeElement;open=true;
    if(!selected)selected=pending[0]||null;
    for(const proposal of pending)seen.add(proposal.id);
    renderChoices();renderDetail();
    if(dialog.showModal&&!dialog.open)dialog.showModal();else dialog.setAttribute('open','');
    later.focus?.();
  }
  async function refresh({prompt=true}={}){
    if(destroyed||refreshing||busy)return;
    const token=++epoch;refreshing=true;
    try{
      const data=await api('/api/knowledge/approvals');
      if(destroyed||token!==epoch)return;
      pending=(Array.isArray(data)?data:data.approvals||[]).filter(item=>item.status==='pending');
      if(selected&&!pending.some(item=>item.id===selected.id)){selected=null;if(open){message('This proposal is no longer pending. Select another change to review.');renderDetail();}}
      renderChoices();
      if(prompt&&!open&&pending.some(item=>!seen.has(item.id)))show();
    }catch(error){if(!destroyed&&open)message('Could not refresh pending changes: '+error.message,true);}
    finally{refreshing=false;}
  }
  async function decide(decision){
    if(busy||!selected||destroyed)return;const proposal=selected;busy=true;epoch++;message('Saving your decision…');controls();
    try{
      const result=await api('/api/knowledge/approvals/'+encodeURIComponent(proposal.id),'POST',{decision});
      if(destroyed)return;
      const expected=decision==='approve'?'approved':'rejected';
      if(result.status!==expected)throw Error('The server did not confirm this decision.');
      pending=pending.filter(item=>item.id!==proposal.id);selected=null;
      message(expected==='approved'?'Change approved and saved.':'Change rejected. Saved knowledge is unchanged.');
      notify(expected==='approved'?'Knowledge change approved.':'Knowledge change rejected.');
      renderChoices();renderDetail();
    }catch(error){if(!destroyed)message('Decision not confirmed: '+error.message+' Refresh before retrying an uncertain action.',true);}
    finally{busy=false;if(!destroyed){controls();void refresh({prompt:false});}}
  }
  const reload=add(actions,'button','Refresh');reload.type='button';reload.addEventListener('click',()=>void refresh({prompt:false}));
  button.addEventListener('click',show);later.addEventListener('click',close);approve.addEventListener('click',()=>void decide('approve'));reject.addEventListener('click',()=>void decide('reject'));
  dialog.addEventListener('cancel',event=>{event.preventDefault();close();});
  const unsubscribe=events?.subscribe(event=>{if(['knowledge.approval','knowledge.updated'].includes(event.type))void refresh();});
  void refresh();if(pollMs>0)timer=setInterval(()=>void refresh(),pollMs);
  return {refresh,show,destroy(){destroyed=true;epoch++;clearInterval(timer);unsubscribe?.();button.remove();dialog.remove();}};
}
