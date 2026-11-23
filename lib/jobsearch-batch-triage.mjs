import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { applicationTarget } from './application-history.mjs';

const MAX_FILES = 1000;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_CANDIDATES = 200;
const MAX_ROWS = 100000;
const normalize = value => String(value ?? '').trim().toLowerCase();
const confirmed = /\b(?:confirmed|submitted.confirmed|confirmed.submitted|application.received|successfully.submitted)\b/i;
const notSent = /^(?:not.?submitted|not.?sent|held|draft|blocked|excluded|rejected|withdrawn.before.submit)$/i;
const uncertain = /^(?:uncertain|unknown|pending|claimed|attempted|dispatch.unknown|submit.unknown|submitted.unverified)$/i;
const submitted = /^(?:submitted|applied|sent|application.sent)$/i;
const safeFile = file => /\.(?:json|jsonl)$/i.test(file) && !file.endsWith('.bak');
const invalid = message => Object.assign(new Error(message), { code: 'JOBSEARCH_TRIAGE_INVALID' });
const safeShort = (value,limit=200) => typeof value === 'string' ? value.slice(0,limit) : null;

function kindForStatus(value, confirmation){
  const status = normalize(value).replaceAll('_','-');
  if (notSent.test(status)) {
    if (/limit applicants|applications? across all roles|already applied|application limit|duplicate application/i.test(String(confirmation||'')))
      return 'blocked_site_limit';
    return 'not_sent';
  }
  if (uncertain.test(status)) return 'unknown';
  if (confirmed.test(status) && !/\bnot\b/.test(status)) return 'confirmed_record';
  if (submitted.test(status)) return 'submitted_unverified';
  if (typeof confirmation === 'string' && /your application was successfully submitted|application submitted!/i.test(confirmation))
    return 'confirmed_record';
  return 'reference_only';
}
function chooseStatus(node){
  const candidates=[node.status,node.submissionStatus,node.applicationStatus,node.disposition,node.result?.status,node.record?.status]
    .filter(value => typeof value === 'string' && value.trim());
  return candidates[0] || '';
}
function confirmationText(node){
  const items=[node.confirmationText,node.confirmation,node.evidence,node.record?.confirmationText,node.record?.confirmation]
    .filter(value => typeof value === 'string');
  return items.find(value => /application.{0,25}submitted|success|received|limit applicants|applications? across all roles|already applied|application limit|duplicate application/i.test(value))||'';
}
function candidateKeys(node) {
  const urls = [node.applicationUrl,node.postingUrl,node.url,node.jobUrl,node.link,node.record?.postingUrl,node.record?.applicationUrl,node.record?.url]
    .filter(value => typeof value === 'string');
  return [...new Map(urls.map(value => applicationTarget(value)).filter(Boolean).map(x=>[x.key,x])).values()];
}
function collectHistory(parsed,source,output){
  const stack=[{value:parsed,depth:0}],seen=new Set();
  while(stack.length){
    const {value,depth}=stack.pop();
    if(!value || typeof value!=='object' || seen.has(value))continue;
    if(depth>28)throw invalid('Application history nesting exceeds the supported limit.');
    seen.add(value);
    if(!Array.isArray(value)){
      const urls=candidateKeys(value);
      if(urls.length){
        const status=chooseStatus(value),confirmation=confirmationText(value),state=kindForStatus(status,confirmation);
        for(const target of urls){
          if(output.length>=MAX_ROWS)throw invalid('Application history contains too many entries.');
          output.push({key:target.key,source,status:safeShort(status,100)||'',state,
            employer:safeShort(value.employer||value.company||value.record?.employer,140),
            role:safeShort(value.role||value.title||value.record?.role,160),
            confirmationObserved:Boolean(confirmation)});
        }
      }
      // Child application records carry their own explicit URL and status.
      // Avoid inheriting the parent status across a distinct requisition.
    }
    for(const child of Object.values(value))if(child&&typeof child==='object')stack.push({value:child,depth:depth+1});
  }
}
async function listFiles(directory){
  const entries=await fs.readdir(directory,{withFileTypes:true});
  return entries.filter(e=>e.isFile()&&safeFile(e.name)).sort((a,b)=>a.name.localeCompare(b.name));
}
async function readOne(directory,name){
  const file=path.join(directory,name);
  const stat=await fs.lstat(file);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>MAX_FILE_BYTES)throw invalid('Unsupported or oversized source: '+name);
  const bytes=await fs.readFile(file);
  if(bytes.length!==stat.size)throw invalid('Source changed while being read: '+name);
  const after=await fs.lstat(file);
  if(after.size!==stat.size||after.mtimeMs!==stat.mtimeMs||after.ino!==stat.ino)throw invalid('Source changed while being read: '+name);
  return {text:bytes.toString('utf8').replace(/^\uFEFF/,''),size:bytes.length,stamp:[name,stat.size,stat.mtimeMs,stat.ino].join(':')};
}
export async function loadJobSearchHistory(directory){
  if(typeof directory!=='string'||!path.isAbsolute(directory))throw invalid('Pass an absolute application-history folder.');
  const entries=await listFiles(directory);
  if(entries.length>MAX_FILES)throw invalid('Too many application-history sources.');
  const rows=[],sources=[],errors=[],sha=createHash('sha256');
  let bytes=0;
  for(const entry of entries){
    try{
      const item=await readOne(directory,entry.name);bytes+=item.size;
      if(bytes>MAX_TOTAL_BYTES)throw invalid('Total history size exceeds supported bounds.');
      let parsed;
      if(entry.name.toLowerCase().endsWith('.jsonl'))parsed=item.text.split(/\r?\n/).filter(Boolean).map(x=>JSON.parse(x));
      else parsed=JSON.parse(item.text);
      const before=rows.length;
      collectHistory(parsed,entry.name,rows);
      sources.push({name:entry.name,entries:rows.length-before});
      sha.update(item.stamp+'\n');
    }catch(error){errors.push({source:entry.name,reason:String(error?.message||error).slice(0,150)});}
  }
  const dedup=new Map();
  for(const row of rows){
    const key=JSON.stringify([row.key,row.source,row.status,row.state]);
    if(!dedup.has(key)||(!dedup.get(key).confirmationObserved&&row.confirmationObserved))dedup.set(key,row);
  }
  const byKey=new Map();
  for(const row of dedup.values()){
    const list=byKey.get(row.key)||[];list.push(row);byKey.set(row.key,list);
  }
  return {byKey,sources,errors,manifest:sha.digest('hex'),files:entries.length,parsedRows:rows.length,coverageComplete:errors.length===0};
}
function hardConstraints(candidate){
  const reasons=[],verification=[];
  const arrangement=normalize(candidate.workArrangement??candidate.remoteMode);
  const employment=normalize(candidate.employmentType);
  if(/\b(contract|freelance|1099|part.time|gig|independent contractor)\b/.test(employment))reasons.push('non_W2_or_non_fulltime');
  if(/\b(on.site|onsite|in.office|hybrid)\b/.test(arrangement)&&candidate.remote!==true)reasons.push('office_required');
  if(candidate.remote===false)reasons.push('not_remote');
  if(candidate.requiredTravel===true || Number(candidate.travelPercent)>0)reasons.push('travel_required');
  if(Array.isArray(candidate.allowedStates) && candidate.allowedStates.length
    && !candidate.allowedStates.some(s=>['FL','FLORIDA','ALL','US','USA'].includes(String(s).toUpperCase())))
    reasons.push('florida_excluded');
  if(Array.isArray(candidate.excludedStates) && candidate.excludedStates.some(s=>['FL','FLORIDA'].includes(String(s).toUpperCase())))
    reasons.push('florida_excluded');
  if(Number.isFinite(candidate.baseSalaryMax) && candidate.baseSalaryMax<80000)reasons.push('base_below_floor');
  if(!candidate.employmentType || employment==='unknown')verification.push('confirm_W2_fulltime');
  if(!candidate.workArrangement && candidate.remote!==true)verification.push('confirm_remote');
  if(!Array.isArray(candidate.allowedStates) && !Array.isArray(candidate.excludedStates))verification.push('confirm_florida_eligibility');
  if(!Number.isFinite(candidate.baseSalaryMax))verification.push('confirm_base_compensation');
  if(Number.isFinite(candidate.baseSalaryMin)&&candidate.baseSalaryMin<80000&&Number(candidate.baseSalaryMax)>=80000)
    verification.push('base_band_crosses_floor');
  if(!Number.isFinite(candidate.travelPercent) && candidate.requiredTravel===undefined)verification.push('confirm_no_required_travel');
  if(arrangement==='hybrid'&&candidate.remote===true)verification.push('resolve_remote_hybrid_conflict');
  return {reasons,verification};
}
export function triageJobSearchCandidates(history,candidates){
  if(!history?.byKey || !(history.byKey instanceof Map))throw invalid('Load a checked history index first.');
  if(!Array.isArray(candidates)||candidates.length>MAX_CANDIDATES)throw invalid('Provide at most 200 candidate objects.');
  const result=[];
  for(let i=0;i<candidates.length;i++){
    const c=candidates[i];
    if(!c||typeof c!=='object'||Array.isArray(c)||typeof c.url!=='string')throw invalid('Each candidate must have a URL.');
    const id=applicationTarget(c.url),observed=id?history.byKey.get(id.key)||[]:[];
    const constraints=hardConstraints(c);
    const states=[...new Set(observed.map(x=>x.state))];
    let disposition='candidate';
    // Missing exact history, an older draft, or an unsupported ATS URL must not
    // turn a viable application into an expensive reconciliation project.
    // Only an already known effect for this exact requisition is worth skipping.
    if(constraints.verification.length)disposition='verify_constraints';
    if(constraints.reasons.length)disposition='not_eligible';
    if(states.includes('submitted_unverified'))disposition='hold_reconcile';
    if(states.includes('blocked_site_limit'))disposition='hold_site_limit';
    if(states.includes('confirmed_record'))disposition='do_not_reapply';
    if(states.includes('unknown'))disposition='hold_reconcile';
    // A malformed *unrelated* history file is advisory, not proof of a prior
    // submission and not a reason to defer an independently eligible role.
    const reasons=[...constraints.reasons,...constraints.verification];
    if(!id)reasons.push('unrecognized_exact_ats_identity');
    if(!history.coverageComplete)reasons.push('history_source_errors');
    if(states.includes('not_sent'))reasons.push('prior_draft_not_submitted');
    if(states.includes('reference_only'))reasons.push('prior_reference_only');
    if(states.includes('unknown'))reasons.push('uncertain_same_requisition');
    if(states.includes('confirmed_record'))reasons.push('previous_confirmed_record');
    if(states.includes('submitted_unverified'))reasons.push('previous_unverified_submit');
    if(states.includes('blocked_site_limit'))reasons.push('previous_site_application_limit');
    // Ordinary skill/tenure requirements are not automatic hard rejections.
    const softGaps=Array.isArray(c.skillGaps)?c.skillGaps.filter(x=>typeof x==='string').slice(0,12):[];
    result.push({position:i,url:c.url,requisitionKey:id?.key??null,disposition,
      reasons:[...new Set(reasons)],softGaps,
      prior:observed.map(({source,status,state,confirmationObserved})=>({source,status,state,confirmationObserved})).slice(0,20),
      fitScore:Number.isFinite(c.fitScore)?Math.max(0,Math.min(100,c.fitScore)):null});
  }
  // Prior same-requisition receipts sort last; they never stall the independent
  // candidates at the front of the batch. A site-wide limit stays role-scoped
  // here because different requisitions at one company are not duplicates.
  const weight={candidate:0,verify_constraints:1,not_eligible:2,do_not_reapply:3,hold_site_limit:4,hold_reconcile:5};
  result.sort((a,b)=>(weight[a.disposition]??7)-(weight[b.disposition]??7)
    ||(b.fitScore??0)-(a.fitScore??0)||a.position-b.position);
  return {coverage:{files:history.files,parsedRows:history.parsedRows,sources:history.sources.length,
      complete:history.coverageComplete,errors:history.errors,manifest:history.manifest},
    coverageScope:'Recognized ATS URL identities in supplied Application History JSON/JSONL files only; not an exhaustive check of emails, other folders or employers',
    candidates:result};
}
