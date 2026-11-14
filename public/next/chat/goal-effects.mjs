/** Inspect and record an operator's evidence; this control never replays actions. */
export function createGoalEffects({mount,api}) {
  const doc=mount.ownerDocument, section=doc.createElement('details');
  section.setAttribute('aria-label','Goal action reconciliation');
  const summary=doc.createElement('summary');summary.textContent='Review uncertain Goal actions';
  const intro=doc.createElement('p');intro.textContent='An uncertain action may already have happened. Check its destination before recording an outcome.';
  const inspect=doc.createElement('button');inspect.setAttribute('type','button');inspect.textContent='Inspect uncertain actions';
  const status=doc.createElement('p');status.setAttribute('role','status');status.setAttribute('aria-live','polite');
  const label=doc.createElement('label');label.textContent='Observed action receipt';
  const select=doc.createElement('select');select.setAttribute('aria-label','Observed action receipt');label.append(select);
  const details=doc.createElement('p');details.setAttribute('aria-label','Receipt details');
  const outcomeLabel=doc.createElement('label');outcomeLabel.textContent='Outcome after checking';
  const outcome=doc.createElement('select');outcome.setAttribute('aria-label','Outcome after checking');
  for(const [value,name] of [['','Choose outcome'],['occurred','Confirmed occurred'],['not_occurred','Confirmed not occurred'],['unknown','Still unknown']]){const option=doc.createElement('option');option.value=value;option.textContent=name;outcome.append(option);}
  outcomeLabel.append(outcome);
  const evidenceLabel=doc.createElement('label');evidenceLabel.textContent='Evidence checked';
  const evidence=doc.createElement('textarea');evidence.setAttribute('aria-label','Evidence checked');evidence.maxLength=4000;evidenceLabel.append(evidence);
  const save=doc.createElement('button');save.setAttribute('type','button');save.textContent='Record outcome';save.disabled=true;
  section.append(summary,intro,inspect,status,label,details,outcomeLabel,evidenceLabel,save);mount.append(section);
  let owner='new',epoch=0,rows=[],busy=false,alive=true,readonly=false;
  const endpoint=()=>'/api/conversations/'+encodeURIComponent(owner)+'/goal-effects';
  const selected=()=>select.value === '' ? null : rows[Number(select.value)] || null;
  function paint(){const row=selected();save.disabled=readonly||busy||!row||!outcome.value||!evidence.value.trim();
    details.textContent=row?`Tool ${row.tool||'unknown'}; action ${row.action||'unknown'}; target ${row.target||'unknown'}; run ${row.runId||'unknown'}; observed ${row.at||'unknown'}; receipt ${row.id||'legacy'}. Current outcome: ${row.resolution?.outcome||'unknown'}.`:'Select an observed receipt.';}
  async function refresh(){if(!alive||busy||owner==='new')return;const token=++epoch,target=owner;busy=true;inspect.disabled=true;save.disabled=true;
    try{const data=await api(endpoint(),'GET');if(!alive||token!==epoch||owner!==target)return;rows=(data.receipts||[]).filter(row=>!row.resolution||row.resolution.outcome==='unknown');select.replaceChildren();const empty=doc.createElement('option');empty.value='';empty.textContent='Choose a receipt';select.append(empty);rows.forEach((row,i)=>{const option=doc.createElement('option');option.value=String(i);option.textContent=`${row.tool||'Tool'} ${row.action||'action'} · ${row.target||row.runId||'unknown target'} · ${row.at||'unknown time'}`;select.append(option);});select.value='';status.textContent=rows.length?`${rows.length} action(s) need reconciliation.`:'No unresolved actions found.';}
    catch(e){if(alive&&token===epoch)status.textContent=e.message||'Could not inspect action receipts.';}
    finally{busy=false;if(alive){inspect.disabled=owner==='new';paint();}}}
  inspect.addEventListener('click',()=>void refresh());select.addEventListener('change',paint);outcome.addEventListener('change',paint);evidence.addEventListener('input',paint);
  save.addEventListener('click',async()=>{const row=selected();if(!alive||readonly||busy||!row||!outcome.value||!evidence.value.trim())return;const target=owner,token=++epoch;busy=true;inspect.disabled=true;save.disabled=true;
    const request={receiptId:row.id||null,signature:row.signature,observedAt:row.at,expectedResolutionCount:(row.resolutions||[]).length,outcome:outcome.value,evidence:evidence.value.trim()};
    try{await api(endpoint(),'POST',request);if(!alive||token!==epoch||owner!==target)return;rows=[];select.replaceChildren();outcome.value='';evidence.value='';status.textContent='Outcome recorded. No action was repeated. Inspect again for the current receipts.';}
    catch(e){if(alive&&token===epoch){rows=[];select.replaceChildren();status.textContent=(e.message||'Could not record outcome.')+' Inspect again before another attempt.';}}
    finally{busy=false;if(alive){inspect.disabled=owner==='new';paint();}}});
  return {update(id,options={}){readonly=Boolean(options.readonly);if(id!==owner){owner=id||'new';epoch++;rows=[];select.replaceChildren();outcome.value='';evidence.value='';status.textContent='';}inspect.disabled=owner==='new';paint();},destroy(){alive=false;epoch++;section.remove();}};
}
