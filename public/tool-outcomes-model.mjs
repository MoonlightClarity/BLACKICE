const escape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const labels={relay_browser:'Browser',relay_connections:'Connected tool',relay_workspace:'Workspace',relay_desktop:'Windows',relay_task:'Milestones',relay_control:'Workflow',relay_memory:'Memory',relay_skills:'Skills',relay_prompts:'Outlines'};
export function modelToolCapability(status={},selection='default'){
 const id=selection==='default'?status.defaultModel:selection,model=(status.models||[]).find(item=>(item.id||item.model)===id||item.model===id);
 return model?.supportsTools===false?{available:false,model:id,message:`${model.displayName||id} does not support tools. It can answer in chat, but cannot browse, edit files or publish posts.`}:{available:true,verified:model?.supportsTools===true};
}
export function reduceToolOutcome(previous,event){
 const next={failed:Number(previous?.failed)||0,completed:Number(previous?.completed)||0,omittedUnresolved:Number(previous?.omittedUnresolved)||0,issues:(previous?.issues||[]).map(item=>({...item})),lastReceipt:previous?.lastReceipt};
 if(event?.type!=='tool.result'||typeof event.tool!=='string')return previous||next;
 const key=event.operationKey||[event.tool,event.action||'call',event.connectionId||'',event.integration||''].join(':'),receipt=event.callId?`${event.callId}:${event.status}`:null;if(receipt&&receipt===next.lastReceipt)return previous;
 if(event.success===false){next.failed++;next.issues.push({key,tool:event.tool,action:event.action||'call',...(event.code==='TASK_STATE_CONFLICT'&&event.recoveryKey?{recoveryKey:event.recoveryKey}:{}),...(event.integration?{integration:event.integration}:{}),...(event.connectionId?{connectionId:event.connectionId}:{}),message:String(event.message||'The tool did not complete.').slice(0,1200),code:event.code||'TOOL_FAILED',resolved:false});if(next.issues.length>50){next.omittedUnresolved+=next.issues.slice(0,-50).filter(issue=>!issue.resolved).length;next.issues=next.issues.slice(-50);}}else{next.completed++;for(const issue of next.issues)if(event.operationKey&&issue.key===event.operationKey||issue.code==='TASK_STATE_CONFLICT'&&issue.tool===event.tool&&issue.recoveryKey&&issue.recoveryKey===event.recoveryKey)issue.resolved=true;}
 next.lastReceipt=receipt;return next;
}
export function toolOutcomeSummary(run={}){
 const summaries=Object.values(run.nodes||{}).map(node=>node.toolSummary).filter(Boolean);if(summaries.length)return{failed:summaries.reduce((sum,state)=>sum+state.failed,0),completed:summaries.reduce((sum,state)=>sum+state.completed,0),omittedUnresolved:summaries.reduce((sum,state)=>sum+(state.omittedUnresolved||0),0),issues:summaries.flatMap(state=>state.issues||[])};
 let state;for(const event of run.events||[])if(event.data?.type==='tool.result')state=reduceToolOutcome(state,event.data);return state||{failed:0,completed:0,issues:[]};
}
export function renderToolIssues(run={}){
 const summary=toolOutcomeSummary(run),issues=summary.issues||[],capability=Object.values(run.nodes||{}).find(node=>node.toolCapability?.available===false)?.toolCapability;
 const capabilityIssues=Object.values(run.nodes||{}).flatMap(node=>node.capabilityIssues||[]);
 if(!summary.failed&&!capability&&!capabilityIssues.length)return'';
 const unresolved=issues.filter(item=>!item.resolved),unresolvedCount=unresolved.length+(summary.omittedUnresolved||0),title=capability?'Tools unavailable':capabilityIssues.length?'Browser unavailable':unresolvedCount?`${unresolvedCount} tool ${unresolvedCount===1?'issue':'issues'}`:'Tool errors recovered',last=unresolved.at(-1)||issues.at(-1);
 return`<aside class="conversation-tool-issues${unresolvedCount||capability||capabilityIssues.length?' attention':''}" aria-label="Tool status"><strong>${escape(title)}</strong>${capability?`<p>${escape(capability.message)}</p>`:capabilityIssues.length?`<p>${escape(capabilityIssues.at(-1).message)}</p>`:!unresolved.length&&summary.omittedUnresolved?`<p>${summary.omittedUnresolved} earlier failed calls have no retained resolution receipt.</p>`:last?`<p>${escape(labels[last.tool]||last.tool)} · ${escape(last.message)}</p>`:''}${summary.failed?`<details><summary>${summary.failed} failed ${summary.failed===1?'call':'calls'} · inspect</summary><ul>${issues.map(issue=>`<li><span>${escape(labels[issue.tool]||issue.tool)} · ${escape([issue.connectionId,issue.integration||issue.action].filter(Boolean).join(' · '))}${issue.resolved?' · recovered':''}</span><p>${escape(issue.message)}</p></li>`).join('')}</ul><small>Tool failures are recorded separately from the agent’s answer.${summary.failed>issues.length?' The latest 50 issue receipts are shown.':''}</small></details>`:''}</aside>`;
}
