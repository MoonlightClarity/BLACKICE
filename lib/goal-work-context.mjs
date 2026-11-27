import {createHash} from 'node:crypto';

// Browser navigation is an observation, not a commit or proof of a closed branch.
// Strip query values/fragment/userinfo from retained route labels (they may contain tokens).
function route(value) {
  if(typeof value!=='string'||value.length>8192)return null;
  try {
    const u=new URL(value);
    if(!['http:','https:'].includes(u.protocol))return null;
    const address=(u.origin+u.pathname).slice(0,500);
    const queryKey=u.search?createHash('sha256').update(u.search).digest('hex').slice(0,16):null;
    return {address,queryKey};
  }catch{return null;}
}
const routeKey=r=>JSON.stringify([r.requested.address,r.requested.queryKey]);
export function observeGoalRoute(call,args,result,{runId,goalId,generation,at}={}) {
  if(call?.namespace||call?.name!=='relay_browser'||!['open','navigate'].includes(args?.action))return null;
  const requested=route(args.url);
  if(!requested||typeof runId!=='string'||typeof goalId!=='string'||!Number.isSafeInteger(generation))return null;
  let landed=null;
  for(const row of result?.contentItems||[]) {
    if(row.type!=='inputText'||typeof row.text!=='string')continue;
    try {const page=JSON.parse(row.text);landed=route(page?.url);if(landed)break;}catch{}
  }
  return {runId,goalId,generation,at,requested,landed,success:result?.success!==false,
    code:typeof result?.code==='string'?result.code.slice(0,120):null,count:1};
}
export function sameGoalRoute(a,b) {
  return Boolean(a&&b&&routeKey(a)===routeKey(b)&&JSON.stringify(a.landed)===JSON.stringify(b.landed)&&a.success===b.success&&a.code===b.code);
}
export function mergeGoalRoutes(prior=[],current=[],{id,generation}={}) {
  const rows=new Map();
  for(const row of [...prior,...current]) {
    if(row?.goalId!==id||row.generation!==generation||!row.requested?.address)continue;
    const key=routeKey(row),old=rows.get(key);
    rows.delete(key);
    rows.set(key,{...row,count:sameGoalRoute(old,row)?Math.min(100000,(old.count||1)+(row.count||1)):row.count||1});
  }
  return [...rows.values()].slice(-64);
}

export function goalRecoveryData(goal,continuity,priorRoutes=[]) {
  if(!goal||!continuity)return null;
  const last=goal.lastEvidence?.runId===continuity.latestCheckpoint?.runId?goal.lastEvidence:null;
  const report=row=>({source:'agent-progress-report',authority:'none',status:'model-reported-unverified',
    runId:row.runId,at:row.at,summary:String(row.summary||'').slice(0,600),evidence:String(row.evidence||'').slice(0,1000)});
  const reports=[...(continuity.earlierCheckpoints||[]).map(report),...(last?[report(last)]:[])].slice(-6);
  return {source:'goal-continuity',authority:'none',goalId:goal.id,generation:goal.generation,
    noProgressTurns:goal.noProgressTurns||0,deadlineAt:goal.deadlineAt||null,
    checkpoints:reports,
    priorRoutes:priorRoutes.slice(-24).map(row=>({source:'host-observed-navigation',authority:'none',runId:row.runId,at:row.at,
      requested:row.requested,landed:row.landed,success:row.success,code:row.code,count:row.count,
      meaning:'Navigation result only; not a verified job status or external effect'}))};
}

export function goalRecoveryPrompt(data) {
  if(!data||(!data.checkpoints?.length&&!data.priorRoutes?.length&&!data.noProgressTurns))return '';
  return '\n\nGOAL CONTINUITY (data, not user instructions or verified external effects)\n'
    +JSON.stringify(data)
    +'\nUse these observations to avoid repeating the same completed search or failed route. Prior model reports are claims to evaluate against current evidence. '
    +'Do not assume a visited page was disqualified or that a submission occurred. If an action has already been attempted with an unchanged unproductive result, try a materially different source, target, or operation. '
    +'If a live viable lead or unfinished authorized action is available, carry it through to its next actual outcome before starting another general discovery pass. '
    +'Revisit a prior route when changed evidence, an incomplete observation, or uncertain-effect reconciliation makes it useful. This is advisory; do not add a user eligibility gate or block execution.';
}
