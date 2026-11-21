'use strict';
// CPU-only projection of immutable saved evidence. Never alters a journal,
// contacts BLACKICE, invokes the model, or executes generated source.
const fs=require('node:fs'),path=require('node:path'),api=require('./native-api.cjs');
const {projectEvidence}=require('./evidence.cjs');
function read(file){const absolute=path.resolve(file),bytes=fs.readFileSync(absolute);return {value:JSON.parse(bytes),record:{path:absolute,bytes:bytes.length,sha256:api.sha(bytes)}};}
function save(file,value){const bytes=Buffer.from(JSON.stringify(value,null,2)+'\n');fs.writeFileSync(file,bytes,{flag:'wx'});if(!fs.readFileSync(file).equals(bytes))throw Error('Output readback differs');return {path:file,bytes:bytes.length,sha256:api.sha(bytes)};}
function reproject({journalPath,providerThreadPath,outPrefix}){
  if(!journalPath||!providerThreadPath||!outPrefix)throw Error('Journal, provider thread and fresh output prefix are required');
  const journal=read(journalPath),provider=read(providerThreadPath),state=journal.value;
  if(state.schema!=='blackice.minicpm.directory-controller.v2'||api.sha(state.config)!==state.configSha256||state.pending!==null)throw Error('Uncertain or invalid source journal');
  const prefix=path.resolve(outPrefix),names={execution:prefix+'.execution.json',proof:prefix+'.directory-proof.json',projection:prefix+'.projection.json'};
  for(const file of Object.values(names))if(fs.existsSync(file))throw Error('Projection output already exists: '+file);
  const provenance=[...state.history.map(x=>x.evidence),journal.record,provider.record];
  const projection=projectEvidence({config:state.config,bundle:state.evidence,providerThread:provider.value,provenance});
  fs.mkdirSync(path.dirname(prefix),{recursive:true});
  const execution=save(names.execution,projection.receipt),proof=save(names.proof,projection.directoryProof);
  const code=readCode('evidence.cjs'),helper=readCode('reproject.cjs');
  for(const input of [journal.record,provider.record])if(api.sha(fs.readFileSync(input.path))!==input.sha256)throw Error('Input changed during projection: '+input.path);
  const a=projection.receipt.actions,summary={run:projection.receipt.run,validation:projection.validation,actionsSettled:a.settled,activeCount:a.activeCount,pendingWriteCount:a.pendingWriteCount,commandReturns:a.commands.length,unexecutedCommandAttempts:a.unexecutedCommandAttempts.length,toolFailures:a.failures.length,agentCompleted:projection.receipt.completion.agentCompleted,methodDeliveryProven:projection.receipt.evidence.methodDelivery.proven,taskDeliveryProven:projection.receipt.evidence.taskDelivery.proven};
  const record={schema:'blackice.minicpm.saved-evidence-reprojection.v1',createdAt:new Date().toISOString(),inputs:{journal:journal.record,providerThread:provider.record},implementation:{evidence:code,helper},historicalJournal:{phase:state.phase,revision:state.revision,blockers:state.blockers,priorProjectionSha256:state.projection?api.sha(state.projection):null},outputs:{execution,proof},summary,inputsUnchanged:true,nativeCalls:0,modelInference:false};
  return {projection:save(names.projection,record),execution,proof,summary};
}
function readCode(name){const file=path.join(__dirname,name),bytes=fs.readFileSync(file);return {path:file,bytes:bytes.length,sha256:api.sha(bytes)};}
if(require.main===module){const args={};for(let i=2;i<process.argv.length;i+=2)args[process.argv[i]]=process.argv[i+1];try{const result=reproject({journalPath:args['--journal'],providerThreadPath:args['--provider-thread'],outPrefix:args['--out-prefix']});console.log(JSON.stringify(result,null,2));if(!result.summary.validation.valid)process.exitCode=2;}catch(error){console.error(error.stack);process.exitCode=1;}}
module.exports={reproject};
