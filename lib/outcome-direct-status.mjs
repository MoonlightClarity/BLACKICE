// Conservative, source-bound facts for a single returned machine test check.
// This neither makes a reviewer verdict nor infers that a larger task succeeded.
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const nonnegative=n=>Number.isSafeInteger(n)&&n>=0;
function parseContent(row){
  const items=row.result?.contentItems;
  if(!Array.isArray(items))return null;
  for(const item of items){
    if(item?.type!=='inputText'||typeof item.text!=='string')continue;
    try{
      const value=JSON.parse(item.text);
      if(object(value)&&nonnegative(value.exitCode))return value;
    }catch{}
  }
  return null;
}
function countOf(output,name){
  const matches=[...output.matchAll(new RegExp('^#\\s*'+name+'\\s+(\\d+)\\s*$','gm'))];
  return matches.length===1?Number(matches[0][1]):null;
}
export function directlyObservedTestStatus(snapshot){
  const records=snapshot.evidence?.records;
  if(!Array.isArray(records))return null;
  const observed=[];
  for(const row of records){
    if(row?.source!=='admitted-tool-delivery'||row.tool!=='relay_workspace'||row.action!=='run'||
       !row.id||row.callId!==row.id||row.namespace)continue; // unrelated or non-exact records supply no status
    const value=parseContent(row);
    if(!value)continue;
    const output=[value.stdout,value.output].filter(x=>typeof x==='string').join('\n');
    if(!/^TAP version \d+/m.test(output))continue;
    const total=countOf(output,'tests'),passed=countOf(output,'pass'),failed=countOf(output,'fail');
    if(!nonnegative(total)||!nonnegative(passed)||!nonnegative(failed)||passed+failed>total)continue;
    if(typeof row.arguments?.command!=='string'||row.arguments.action!=='run')continue;
    if(value.timedOut===true||value.truncated===true)continue;
    observed.push({receiptId:row.id,command:row.arguments.command,exitCode:value.exitCode,
      total,passed,failed});
  }
  if(observed.length!==1)return null;
  // A returned nonzero command may retain uncertain external side effects.
  // Its exact exit code is still observable: reporting that code does not
  // reconcile, replay, or certify the possible effect. Unrelated unknown
  // effects remain a separate incomplete obligation.
  const pending=snapshot.scope?.pendingEffects||[];
  if(pending.some(row=>row?.callId!==observed[0].receiptId))return null;
  return Object.freeze(observed[0]);
}
const hasStatusOnlyIntent=request=>{
  if(typeof request!=='string')return false;
  // The direct report is for a narrow observed status question, never a
  // request to interpret root causes, modify software, or prepare a deliverable.
  if(!/\b(?:state|report|tell(?:\s+me)?)\s+whether\b.{0,100}\b(?:tests?|checks?)\s+passed\b/i.test(request) &&
     !/\bdid\s+(?:the\s+|these\s+|those\s+|my\s+)?(?:tests?|checks?)\s+pass\b/i.test(request))return false;
  if(/\b(?:implement|modify|repair|fix|edit|submit|deploy|install|write|create|apply|change|analy[sz]e|explain|investigate|read|inspect|audit|verify|compare|evaluate|run|root cause|json|csv|schema|table|format)\b/i.test(request))return false;
  return true;
};
export function exactStatusReport(snapshot){
  if(!hasStatusOnlyIntent(snapshot.request))return null;
  const data=directlyObservedTestStatus(snapshot);
  if(!data)return null;
  const {total,passed,failed,exitCode}=data;
  const success=exitCode===0&&failed===0;
  return Object.freeze({receiptId:data.receiptId,
    output:'The recorded test command exited with code '+exitCode+
      '. Its returned TAP summary reports '+total+' tests: '+passed+' passed and '+failed+
      ' failed. '+(success?'The reported checks passed.':'Not all of the reported checks passed.')});
}
// Detect only unambiguous affirmative mechanical test claims that conflict with
// a directly observed, terminal test receipt. Omission and ambiguity are NOT a failure.
export function contradictedTestPassClaim(snapshot,report){
  const data=directlyObservedTestStatus(snapshot);
  if(!data||typeof report!=='string'||!(data.exitCode!==0||data.failed>0))return null;
  const text=report.trim();
  // Exact numeric count mismatches are factual contradictions even if the
  // model acknowledges a nonzero exit code. Attribute-aware checking avoids
  // treating a quoted earlier erroneous claim as the current reported result.
  for(const hit of text.matchAll(/\b(\d+)\s+(?:tests?\s+)?(passed|failed)\b/gi)){
    const before=text.slice(Math.max(0,hit.index-65),hit.index);
    if(/\b(?:falsely|incorrectly|claimed|previously|earlier|old|candidate)\b/i.test(before))continue;
    const expected=hit[2].toLowerCase()==='passed'?data.passed:data.failed;
    if(Number(hit[1])!==expected)return Object.freeze({receiptId:data.receiptId,exitCode:data.exitCode,
      passed:data.passed,failed:data.failed,
      reason:'The report states a pass/fail count that differs from the exact returned TAP result.'});
  }
  // An explicit attributed quotation ("the candidate incorrectly claimed the
  // tests passed") is not itself the current report's assertion of success.
  const asserted=text.match(/\b(?:all|both|the|these|two|three|\d+)\s+(?:(?:source|requested|reported|unit|integration)\s+)?(?:tests?|checks?)\s+(?:have\s+)?passed\b|\b(?:tests|checks)\s+(?:all\s+)?passed\b|\bexit(?:\s*code|Code)?\s*[:=]?\s*0\b|\b0\s+(?:tests?\s+)?failed\b/i);
  if(!asserted)return null;
  const preceding=text.slice(Math.max(0,asserted.index-65),asserted.index);
  if(/\b(?:not|falsely|incorrectly|allegedly|quoted|claimed|misreported|contradicted)\b/i.test(preceding))return null;
  return Object.freeze({receiptId:data.receiptId,exitCode:data.exitCode,
    passed:data.passed,failed:data.failed,reason:'The report claims successful tests contrary to the exact returned test status.'});
}

// A user may explicitly demand the numeric command status and pass/fail
// counts, not just the word "failed". A model error-code label cannot stand in
// for the observed integer exit code. No missing-value inference is performed.
export function missingRequestedTestNumbers(snapshot,report){
  const data=directlyObservedTestStatus(snapshot);
  const request=snapshot.request;
  if(!data||typeof request!=='string'||typeof report!=='string')return null;
  const wantsExit=/\b(?:exact|numeric|actual)\s+(?:command\s+)?exit\s*code\b/i.test(request);
  const wantsCounts=/\bpass\s*\/\s*fail\s+counts?\b|\bexact\s+(?:test\s+)?counts?\b/i.test(request);
  if(!wantsExit&&!wantsCounts)return null;
  const hasExit=new RegExp('\\b(?:exit(?:ed)?(?:\\s+with)?\\s*code|exitCode|code)\\s*[:=#-]?\\s*'+data.exitCode+'\\b','i').test(report);
  const hasPass=new RegExp('\\b'+data.passed+'\\s+(?:tests?\\s+)?passed\\b|\\bpass(?:ed)?\\s*[:=]\\s*'+data.passed+'\\b','i').test(report);
  const hasFail=new RegExp('\\b'+data.failed+'\\s+(?:tests?\\s+)?failed\\b|\\bfail(?:ed)?\\s*[:=]\\s*'+data.failed+'\\b','i').test(report);
  if(wantsExit&&!hasExit||wantsCounts&&(!hasPass||!hasFail))
    return Object.freeze({receiptId:data.receiptId,exitCode:data.exitCode,
      passed:data.passed,failed:data.failed,
      reason:'The requested exact numeric test status is missing from the current report.'});
  return null;
}
