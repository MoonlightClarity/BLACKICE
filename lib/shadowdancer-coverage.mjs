/** Auditable, exact requirement -> executed-test-case coverage.
 * Text similarity never establishes semantic test coverage.
 * A mapping is a reviewed declaration (potentially model-authored); the host
 * verifies referenced exact case titles, source files and tested file hashes.
 * Passing tests show behavioral evidence, not a proof of total correctness.
 */
import path from 'node:path';
import {readFile,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';

const sha=b=>createHash('sha256').update(b).digest('hex');
const now=()=>new Date().toISOString();
const relativeFile=file=>typeof file==='string' &&
  /^(?:(?:test|tests)\/[A-Za-z0-9_.\/-]+|[A-Za-z0-9_.-]+)\.(?:test|spec)\.(?:mjs|js|cjs)$/.test(file) &&
  !file.split('/').some(x=>x==='..'||x==='.');
const error=(code,message)=>Object.assign(new Error(message),{code});
export const COVERAGE_MAP_FILE='tests/requirement-coverage.json';

export async function readCoverageEvidence(repoRoot,ledger,receipt,{
 mapFile=COVERAGE_MAP_FILE,
}={}){
 const root=path.resolve(repoRoot),filename=path.resolve(root,mapFile);
 if(!filename.startsWith(root+path.sep))throw error('DIRECTORY_COVERAGE_PATH','Coverage mapping must remain inside the selected repository.');
 const base={version:1,mapFile:filename,readAt:now(),
   status:'absent',mappingSha256:null,accepted:[],rejected:[],coverageAuthority:'explicit-map-exact-test-hash',
   sourceSha256:receipt?.sourceSha256||null};
 let bytes;
 try{bytes=await readFile(filename);}
 catch(e){if(e.code==='ENOENT')return base;throw e;}
 base.mappingSha256=sha(bytes);
 if(bytes.length>30000)return {...base,status:'invalid',rejected:[{reason:'map_exceeds_30k'}]};
 let map;
 try{map=JSON.parse(bytes.toString('utf8'));}
 catch{return {...base,status:'invalid',rejected:[{reason:'malformed_json'}]};}
 if(map?.version!==1||!Array.isArray(map.mappings)||map.mappings.length>200)
   return {...base,status:'invalid',rejected:[{reason:'invalid_schema'}]};
 const requirements=new Set((ledger?.requirements||[]).map(r=>r.id));
 const passed=new Set(receipt?.passedCases||[]),failed=new Set(receipt?.failedCases||[]);
 const verifiedFiles=new Map((receipt?.testSourceFiles||[]).map(x=>[x.path,x.sha256]));
 const readCache=new Map();
 const seen=new Set();
 for(const [index,entry] of map.mappings.entries()){
   const id=entry?.requirementId;
   const testFile=entry?.testFile;
   const caseName=entry?.case;
   const key=String(id)+'|'+String(testFile)+'|'+String(caseName);
   const reject=reason=>base.rejected.push({index,requirementId:id,testFile,case:caseName,reason});
   if(!requirements.has(id)){reject('unknown_requirement_id');continue;}
   if(!relativeFile(testFile)){reject('invalid_test_file');continue;}
   if(typeof caseName!=='string'||caseName.length<3||caseName.length>350){
     reject('invalid_test_case');continue;
   }
   if(seen.has(key)){reject('duplicate_mapping');continue;}
   seen.add(key);
   if(!verifiedFiles.has(testFile)){reject('test_file_not_executed');continue;}
   let source;
   try{
     const filePath=path.resolve(root,...testFile.split('/'));
     const b=await readFile(filePath);
     if(sha(b)!==verifiedFiles.get(testFile)){reject('test_file_changed_after_execution');continue;}
     source=b.toString('utf8');
     readCache.set(testFile,source);
   }catch(e){reject('test_file_not_readable');continue;}
   // A declaration is not allowed to cite a case absent from tested source.
   if(!source.includes(caseName)){reject('case_not_in_test_source');continue;}
   if(!passed.has(caseName)&&!failed.has(caseName)){reject('case_not_in_executed_test_output');continue;}
   const outcome=failed.has(caseName)?'failed':'passed';
   base.accepted.push({requirementId:id,testFile,case:caseName,outcome,
     testFileSha256:verifiedFiles.get(testFile),
     provenance:'declared_mapping_checked_against_executed_test',
     rationale:typeof entry.rationale==='string'?entry.rationale:null});
 }
 base.status=base.rejected.length?'partially_invalid':'validated';
 base.acceptedCount=base.accepted.length;
 base.rejectedCount=base.rejected.length;
 return base;
}

/** Scope the formal mapping ledger separately from task outcome evidence.
 * Missing declared mappings do not erase direct observations, and do not
 * establish either correctness or failure of the corresponding behavior.
 */
export function requirementCoverageScope(ledger){
 return {
  authority:'explicit-map-exact-test-hash',
  status:ledger?.coverageEvidenceStatus||'absent',
  mappedPassed:ledger?.verifiedCount??0,
  mappedFailed:ledger?.failedCount??0,
  unmapped:ledger?.unknownCount??null,
  outcome:'not_assessed_by_mapping',
  interpretation:'Unmapped requirements lack an accepted explicit requirement-to-test declaration. This is not a count of failed or unobserved behaviors. Assess the user outcome using current source and observed tool/test receipts; do not require a coverage-map deliverable unless the user requested it. Missing mappings never establish completion.'
 };
}

export function applyCoverageEvidence(ledger,receipt,coverage,{changedFiles=[]}={}){
 const entries=coverage?.accepted||[];
 const revised={...ledger,updatedAt:now(),
   coverageEvidenceStatus:coverage?.status||'absent',
   coverageMapSha256:coverage?.mappingSha256||null,
   coverageMapFile:coverage?.mapFile||null,
   coverageRejectedCount:coverage?.rejected?.length||0};
 revised.requirements=(ledger?.requirements||[]).map(req=>{
   const related=entries.filter(x=>x.requirementId===req.id);
   const failed=related.filter(x=>x.outcome==='failed');
   const passed=related.filter(x=>x.outcome==='passed');
   // Conservative: one failed mapped case invalidates the requirement;
   // passing mapped cases are test evidence, never unrestricted proof.
   const state=failed.length?'failed':passed.length?'test-covered':'unknown';
   return {...req,state,coveredBy:related.map(x=>x.case),
     evidence:related.map(x=>({kind:'host-executed-test',outcome:x.outcome,
       title:x.case,file:x.testFile,sourceSha256:receipt?.sourceSha256,
       testFileSha256:x.testFileSha256,receipt:receipt?.file,coverageMapSha256:coverage?.mappingSha256})),
     changedFiles:changedFiles.filter(f=>req.statement.includes(f.split('/').at(-1)))};
 });
 revised.verifiedCount=revised.requirements.filter(x=>x.state==='test-covered').length;
 revised.failedCount=revised.requirements.filter(x=>x.state==='failed').length;
 revised.unknownCount=revised.requirements.filter(x=>x.state==='unknown').length;
 revised.status=receipt?.status==='failed'?'tests-failed':
   receipt?.status==='passed'?(revised.unknownCount===0&&revised.failedCount===0&&
     !revised.coverageRejectedCount?'test-evidence-coverage-declared':'tests-passed-requirements-not-fully-mapped'):
     'verification-unavailable';
 revised.verificationReceipt=receipt?.file||null;
 revised.sourceSha256=receipt?.sourceSha256||null;
 revised.testSuiteSha256=receipt?.testSuiteSha256||null;
 return revised;
}
