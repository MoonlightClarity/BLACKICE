/** Compact projection of observed tool receipts, independent of turn delivery. */
export function chatToolFailure(run={}){
  let latest;
  for(const entry of Array.isArray(run.events)?run.events:[]){
    const event=entry?.data;
    if(event?.type!=='tool.result'||typeof event.tool!=='string')continue;
    if(event.success===false){
      latest={node:entry.nodeId,tool:event.tool.slice(0,100),action:typeof event.action==='string'?event.action.slice(0,100):'',
        key:event.operationKey,reason:typeof event.message==='string'?event.message.slice(0,300):'',code:typeof event.code==='string'?event.code.slice(0,80):'',followedBySuccess:false};
    } else if(event.success===true&&latest?.key&&latest.key===event.operationKey&&latest.node===entry.nodeId&&latest.tool===event.tool){
      latest.followedBySuccess=true;
    }
  }
  if(!latest)return null;
  const display=[latest.tool,latest.action].filter(Boolean).join(' · ');
  const reason=latest.reason||latest.code||'No reason was recorded.';
  return {label:latest.followedBySuccess?'Tool failure recorded; matching call later succeeded':'Tool failure recorded',
    detail:display+': '+reason};
}
