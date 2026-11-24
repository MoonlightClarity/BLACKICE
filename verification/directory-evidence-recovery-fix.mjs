// Source-anchored isolated recovery patch. Every replacement must match once.
import {readFileSync,writeFileSync} from 'node:fs';
const filename='lib/task-action-directory.mjs';
let src=readFileSync(filename,'utf8');
function change(from,to,label) {
 const at=src.indexOf(from);
 if(at<0||src.indexOf(from,at+from.length)!==-1)throw Error('Missing or duplicate '+label);
 src=src.slice(0,at)+to+src.slice(at+from.length);
 console.log('CHANGED '+label);
}
change(
 "const linkableRead=(r,actionId,runId,nodeId)=>r?.actionId===null&&r.canLinkRead===true&&(!r.linkedByActionId||r.linkedByActionId===actionId)&&r.success===true&&id(runId)&&r.runId===runId&&id(nodeId)&&r.nodeId===nodeId;",
 `const linkableRead=(r,actionId,runId,nodeId)=>r?.actionId===null&&r.canLinkRead===true&&(!r.linkedByActionId||r.linkedByActionId===actionId)&&r.success===true&&id(runId)&&r.runId===runId&&id(nodeId)&&r.nodeId===nodeId;
// Reconcile a successful effect recorded under an earlier, now-closed focus.
// Preserve the original actionId, host receipt and effects. A second action may
// explicitly reference that effect only once, within the same run/node, and
// only when the original action did not already use the receipt as evidence.
// No external operation is retried or automatically marked successful.
const linkableCompletedEffect=(r,actionId,runId,nodeId,actions)=>{
 if(r?.state!=='returned'||r.success!==true||r.observationOnly===true||
   !r.actionId||r.actionId===actionId||r.linkedByActionId||
   r.runId!==runId||r.nodeId!==nodeId||!id(runId)||!id(nodeId))return false;
 const origin=actions.find(action=>action.id===r.actionId);
 if(!origin||!['observed','blocked'].includes(origin.state))return false;
 if(origin.observation?.receipts?.includes(r.id))return false;
 if(origin.notes?.some(note=>note.receipts?.includes(r.id)))return false;
 return true;
};`, 'completed-effect-provenance');
change(
 "r.linkedByActionId!==undefined&&(r.actionId!==null||r.canLinkRead!==true||r.state!=='returned'||r.success!==true||!snapshot.actions.some(a=>a.id===r.linkedByActionId))",
 "r.linkedByActionId!==undefined&&(r.state!=='returned'||r.success!==true||!snapshot.actions.some(a=>a.id===r.linkedByActionId)||!(r.actionId===null&&r.canLinkRead===true||r.actionId!==null&&r.actionId!==r.linkedByActionId&&r.observationOnly!==true&&snapshot.actions.some(a=>a.id===r.actionId&&['observed','blocked'].includes(a.state))))",
 'snapshot-linked-effect-validation');
change(
 "const linkable=r=>linkableRead(r,a.id,runId,nodeId);\n   const eligible=r=>r?.state==='returned'&&(r.actionId===a.id||linkable(r));",
 "const linkable=r=>linkableRead(r,a.id,runId,nodeId)||linkableCompletedEffect(r,a.id,runId,nodeId,s.actions);\n    const eligible=r=>r?.state==='returned'&&(r.actionId===a.id||linkable(r));",
 'observe-completed-effect-eligibility');
change(
 "if(input.blocker==='prerequisite-unavailable'&&!cited.length)throw fail('DIRECTORY_BLOCKER','Cite the tool result that shows the input is unavailable. A successful check that found the needed input belongs under observe, not block.');",
 `if(input.blocker==='no-viable-route'&&!cited.some(r=>r.success===false))
       throw fail('DIRECTORY_BLOCKER','No returned failed attempt establishes that this whole route is unavailable. Do not infer a read-only workspace from uncertainty or skip an authorized write. Continue the actual work, try a useful alternative, or cite an exact failed tool receipt. This block was not recorded.');
      if(input.blocker==='prerequisite-unavailable'&&!cited.length)throw fail('DIRECTORY_BLOCKER','Cite the tool result that shows the input is unavailable. A successful check that found the needed input belongs under observe, not block.');`,
 'unsupported-route-block');
writeFileSync(filename,src);
