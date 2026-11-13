// Model selects presentation; only host-owned values become published assertions.
export const repositoryReportSections=['changes','tests','mapping','references'];
export function parseRepositoryReportSelection(parsed,requiredRefs){
 let ids;
 try{ids=JSON.parse(parsed?.answer);}catch{}
 if(!Array.isArray(ids)||!ids.length||ids.some(id=>!repositoryReportSections.includes(id))||
   new Set(ids).size!==ids.length||!Array.isArray(parsed?.used_refs)||
   requiredRefs.some(ref=>!parsed.used_refs.includes(ref))||
   parsed.used_refs.some(ref=>!requiredRefs.includes(ref))){
  const error=new Error('Repository response revision must select known host report sections and exact evidence references.');
  error.code='DIRECTORY_REPORT_REVISION_INVALID';throw error;
 }
 return ids;
}
export function renderRepositoryReportSelection(ids,{changedFiles=[],verification={},mapping={},references=[]}={}){
 return ids.map(id=>{
  switch(id){
   case 'changes':return 'Observed source inventory changes: '+JSON.stringify(changedFiles)+'. File changes do not establish correct behavior.';
   case 'tests':return 'Observed test receipt: '+JSON.stringify({status:verification.status??'unavailable',passed:verification.passed??null,failed:verification.failed??null,tests:verification.tests??null,file:verification.file??null,sourceSha256:verification.sourceSha256??null,testSuiteSha256:verification.testSuiteSha256??null})+'. Only the recorded tests are covered; currentness and integrity warnings above still apply.';
   case 'mapping':return 'Declared requirement mapping scope: '+JSON.stringify(mapping)+'. This scope is not a task-outcome certification.';
   case 'references':return 'Host-indexed evidence references: '+JSON.stringify(references.map(x=>({ref:x.ref,path:x.path})))+'. Index presence is not proof of receipt contents or task completion.';
   default:throw new Error('Unknown repository report section');
  }
 }).join('\n\n');
}
