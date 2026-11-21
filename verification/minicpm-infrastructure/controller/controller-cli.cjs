'use strict';
const fs=require('node:fs'),path=require('node:path');
const core=require('./controller.cjs'),api=require('./native-api.cjs'),{projectEvidence}=require('./evidence.cjs');
function args(values){const out={};for(let i=0;i<values.length;i+=2){if(!/^--[a-z-]+$/.test(values[i]||'')||values[i+1]===undefined)throw Error('Expected named option/value pairs');out[values[i]]=values[i+1];}return out;}
function read(file){if(!file)throw Error('Required file argument missing');const bytes=fs.readFileSync(file);return{value:JSON.parse(bytes.toString('utf8')),evidence:{path:path.resolve(file),sha256:api.sha(bytes),bytes:bytes.length}};}
function exclusive(file,value){if(!file)throw Error('New evidence output path required');const bytes=Buffer.from(JSON.stringify(value,null,2)+'\n');fs.writeFileSync(file,bytes,{flag:'wx'});if(!fs.readFileSync(file).equals(bytes))throw Error('Evidence readback differs');return{path:path.resolve(file),sha256:api.sha(bytes),bytes:bytes.length};}
function jobOf(value){return value?.structuredContent||value;}
function nativeValue(job,options,state){
  if(job.result?.success===false)throw Error('Direct operation returned failure');
  let text=job.result?.text?.text;
  if(options['--full-result-text']){
    const file=fs.readFileSync(options['--full-result-text'],'utf8');
    if(job.result?.text?.offset!==0||!file.startsWith(text||'')||file.length!==job.result?.text?.totalCharacters)throw Error('Reassembled direct result text fails length/prefix proof');
    text=file;
  }else if(job.result?.text?.nextOffset!=null||job.result?.text?.offset!==0)throw Error('Direct result is paged: save all text slices in order and pass --full-result-text; do not repeat the operation');
  let value=JSON.parse(text);
  if(options['--artifact']){
    const expected=state.pending?.artifactRequired||value?.artifact;
    if(!expected?.complete)throw Error('No recorded complete frontend artifact to retrieve');
    const bytes=fs.readFileSync(options['--artifact']);if(api.sha(bytes)!==expected.sha256||bytes.length!==expected.bytes)throw Error('Frontend artifact hash/byte count mismatch');
    const full=JSON.parse(bytes.toString('utf8'));if(full.success!==true)throw Error('Complete frontend artifact reports failure');
    value=JSON.parse(full.contentItems?.find(x=>x.type==='inputText')?.text||'null');
  }
  return api.unwrapFrontend(value);
}
function main(argv){
  const [command,...rest]=argv,options=args(rest),journal=options['--journal'];
  if(command==='init')throw Error('Fresh benchmark campaigns require campaign-controller.cjs createCampaign/planNext/commitOperation with a frozen manifest and fresh condition evidence. This copied legacy CLI supports only existing-work recovery and cleanup.');
  const {value:state}=read(journal);let next=state,result;
  if(command==='next'){
    result=core.planNext(state,new Date().toISOString(),options['--connection']);
    if(result.type==='submit'&&result.operation.kind==='start')throw Error('New benchmark starts require campaign-controller.cjs and matching frozen conditions. No start was committed; existing pending work can still be recovered and cleaned up.');
    if(result.type==='submit')next=core.commitOperation(state,result);
  }else if(command==='record-submission'){
    const {value}=read(options['--admission']),job=jobOf(value);
    next=core.recordSubmission(state,{jobId:job.jobId,requestId:job.requestId,connectionId:options['--connection']});result={type:'submission-recorded',jobId:job.jobId};
  }else if(command==='accept'){
    const raw=read(options['--result']),job=jobOf(raw.value);
    if(!job.settled||!['succeeded','failed','cancelled','interrupted'].includes(job.status))return{ok:false,type:'job-not-settled',jobId:job.jobId,status:job.status,settled:job.settled};
    let value;
    if(job.status==='succeeded')value=nativeValue(job,options,state);
    next=core.acceptResponse(state,{jobId:job.jobId,connectionId:options['--connection'],jobStatus:job.status,jobSettled:job.settled,value,evidence:raw.evidence});result={type:'response-accepted',phase:next.phase,blockers:next.blockers};
  }else if(command==='attach-projection'){
    const provider=read(options['--provider-thread']);const provenance=[...state.history.map(x=>x.evidence),provider.evidence];
    const projection=projectEvidence({config:state.config,bundle:state.evidence,providerThread:provider.value,provenance});
    const execution=exclusive(options['--out'],projection.receipt),proof=options['--proof-out']?exclusive(options['--proof-out'],projection.directoryProof):null;
    next=core.attachProjection(state,provider.evidence,projection);result={type:'projection',validation:projection.validation,execution,proof,phase:next.phase};
  }else throw Error('Commands: init, next, record-submission, accept, attach-projection');
  const saved=next===state?null:core.saveJournal(journal,next,{expectedRevision:state.revision});
  return{ok:next.phase!=='blocked',...result,...(saved?{journal:saved}:{})};
}
module.exports={main,nativeValue};
if(require.main===module){try{process.stdout.write(JSON.stringify(main(process.argv.slice(2)))+'\n');}catch(e){process.stdout.write(JSON.stringify({ok:false,error:e.message})+'\n');process.exitCode=1;}}
