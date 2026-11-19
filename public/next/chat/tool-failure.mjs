const label=(value,max)=>typeof value==='string'&&value.length<=max&&/^[a-zA-Z0-9_ .-]+$/.test(value)?value:'';
const code=value=>typeof value==='string'&&/^[A-Z][A-Z0-9_]{1,79}$/.test(value)?value:'';
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)?value:'';

/** Retain one bounded failure, no arbitrary messages, arguments or result payloads. */
export function retainChatToolFailure(latest,entry){
  const e=entry?.data;
  if(e?.type!=='tool.result'||typeof e.tool!=='string')return latest;
  const tool=label(e.tool,100)||'Tool',nodeId=label(entry.nodeId,100),key=digest(e.operationKey);
  if(e.success===false)return {tool,action:label(e.action,100),code:code(e.code),nodeId,key,followedBySuccess:false};
  if(e.success===true&&latest?.key&&nodeId&&latest.key===key&&latest.nodeId===nodeId&&latest.tool===tool&&!latest.followedBySuccess)
    return {...latest,followedBySuccess:true};
  return latest;
}

export function archivedChatToolFailure(run){
  const saved=run.chatToolFailureReceipt??(Array.isArray(run.events)?run.events:[]).reduce((latest,event)=>
    event?.runId===run.id&&event.nodeId&&Object.hasOwn(run.nodes||{},event.nodeId)?retainChatToolFailure(latest,event):latest,undefined)??run.archivedToolFailure;
  if(!saved||!label(saved.tool,100))return null;
  return {tool:saved.tool,action:label(saved.action,100),code:code(saved.code),followedBySuccess:saved.followedBySuccess===true};
}

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
  const archived=!latest;
  if(archived)latest=archivedChatToolFailure(run);
  if(!latest)return null;
  const display=[latest.tool,latest.action].filter(Boolean).join(' · ');
  const reason=latest.reason||latest.code||(archived?'Details are not kept in saved Chat.':'No reason was recorded.');
  return {label:latest.followedBySuccess?'Tool failure recorded; matching call later succeeded':'Tool failure recorded',
    detail:display+': '+reason};
}
