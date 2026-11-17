/** Local operator control for inspecting and explicitly retiring a stalled connection. */
export function createNativeWriteRecovery({mount,api}) {
  const doc=mount.ownerDocument, section=doc.createElement('section');
  const title=doc.createElement('h3');title.textContent='Codex connection recovery';
  const message=doc.createElement('p');message.setAttribute('role','status');message.setAttribute('aria-live','polite');
  message.textContent='Status has not been checked. Inspect the Codex connection if a task stopped receiving tool results.';
  const inspect=doc.createElement('button');inspect.setAttribute('type','button');inspect.textContent='Check connection status';
  const recover=doc.createElement('button');recover.setAttribute('type','button');recover.textContent='Disconnect stalled model session';recover.disabled=true;
  const note=doc.createElement('p');note.textContent='Recovery does not replay a tool or start a new model turn. Check the destination before repeating an action.';
  const receiptHeading=doc.createElement('h4');receiptHeading.textContent='Unconfirmed result-delivery records';
  const receiptSummary=doc.createElement('p');receiptSummary.textContent='Check connection status to inspect any retained delivery records.';
  const receipts=doc.createElement('ul');receipts.setAttribute('aria-label','Uncertain native deliveries');
  const older=doc.createElement('button');older.setAttribute('type','button');older.textContent='Older receipts';older.disabled=true;
  const newer=doc.createElement('button');newer.setAttribute('type','button');newer.textContent='Newer receipts';newer.disabled=true;
  section.append(title,message,inspect,recover,note,receiptHeading,receiptSummary,receipts,older,newer);mount.append(section);
  let observed=null,busy=false,alive=true,epoch=0;
  let allReceipts=[],receiptEnd=0;
  function renderReceipts(){
    const start=Math.max(0,receiptEnd-64),shown=allReceipts.slice(start,receiptEnd);receipts.replaceChildren();
    receiptSummary.textContent=allReceipts.length?`Showing ${start+1}–${receiptEnd} of ${allReceipts.length} unconfirmed tool results, newest last. Check the task and destination before repeating an action.`:'No uncertain delivery receipts are available.';
    older.disabled=start===0;newer.disabled=receiptEnd>=allReceipts.length;
    const field=value=>typeof value==='string'&&value?value.slice(0,120):'unknown';
    for(const row of shown){const item=doc.createElement('li');
      item.textContent=`Write ${Number.isSafeInteger(row?.writeId)?row.writeId:'unknown'}; tool ${field(row?.tool)}; kind ${field(row?.kind)}; thread ${field(row?.threadId)}; call ${field(row?.callId)}; reason ${field(row?.reason)}. Result receipt unknown; action effects may already exist.`;
      receipts.append(item);
    }
  }
  function showReceipts(value){allReceipts=Array.isArray(value)?value:[];receiptEnd=allReceipts.length;renderReceipts();}
  older.addEventListener('click',()=>{receiptEnd=Math.max(1,receiptEnd-64);renderReceipts();});
  newer.addEventListener('click',()=>{receiptEnd=Math.min(allReceipts.length,receiptEnd+64);renderReceipts();});
  inspect.addEventListener('click',async()=>{
    if(busy||!alive)return;busy=true;inspect.disabled=true;recover.disabled=true;observed=null;const current=++epoch;
    try {const data=await api('/api/codex/native-write-recovery');if(!alive||current!==epoch)return;
      const s=data.status||{},id=s.oldestWriteId??s.recovery?.expectedWriteId,pid=s.pid;showReceipts(data.uncertain);
      if(s.recoveryRequired&&Number.isSafeInteger(id)&&id>0&&Number.isSafeInteger(pid)&&pid>0){
        observed={expectedWriteId:id,expectedPid:pid};recover.disabled=false;
        message.textContent=`Recovery required: write ${id}, process ${pid}. ${s.uncertainCount||0} result(s) have uncertain delivery.`;
      } else message.textContent=(s.uncertainCount||0)>0?`No current Codex connection stall is identified. ${s.uncertainCount} retained result(s) have unconfirmed delivery; these records do not mean the connection is currently stalled.`:'No current Codex connection stall or unconfirmed result delivery is identified.';
    }catch(error){if(alive&&current===epoch)message.textContent=error.message||'Could not inspect native writes.';}
    finally{busy=false;if(alive)inspect.disabled=false;}
  });
  recover.addEventListener('click',async()=>{
    if(busy||!alive||!observed)return;const identity=observed;observed=null;recover.disabled=true;inspect.disabled=true;busy=true;
    try{const data=await api('/api/codex/native-write-recovery','POST',identity);if(alive)message.textContent=data.result?.status==='retired'?'Old connection retired. Check connection status again for the latest uncertain receipts; check the destination before any repeat.':'Recovery completed; inspect status before further action.';}
    catch(error){if(alive)message.textContent=(error.message||'Recovery failed.')+' Inspect again before another recovery attempt; do not repeat the tool action.';}
    finally{busy=false;if(alive)inspect.disabled=false;}
  });
  return {destroy(){alive=false;epoch++;section.remove();}};
}
