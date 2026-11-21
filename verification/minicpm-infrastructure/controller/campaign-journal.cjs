'use strict';
// Whole guarded-campaign persistence. No tool, provider, or network calls.
// A lost writer leaves a visible lock; recovery proves its process is gone first.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const campaign=require('./campaign-controller.cjs'),api=require('./native-api.cjs');
function fail(code,message){const e=Error(message);e.code=code;throw e;}
const digest=b=>crypto.createHash('sha256').update(b).digest('hex');
const isHash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
function validateCampaign(state){
 if(state?.schema!==campaign.SCHEMA||!Number.isSafeInteger(state.revision)||state.revision<0)fail('JOURNAL_SCHEMA','A complete guarded campaign envelope is required');
 campaign.planNext(state,{now:new Date().toISOString(),connectionId:state.binding?.connectionId});
 return state;
}
function receipt(file,bytes,state){return {path:path.resolve(file),sha256:digest(bytes),bytes:bytes.length,revision:state.revision};}
function expectedMatches(actual,expected){
 return expected&&Number.isSafeInteger(expected.revision)&&isHash(expected.sha256)&&actual.revision===expected.revision&&actual.sha256===expected.sha256;
}
function requireExpected(found,expected){
 if(expected===null){if(found)fail('JOURNAL_CONFLICT','Journal already exists');}
 else if(!found||!expectedMatches(found.receipt,expected))fail('JOURNAL_CONFLICT','Journal revision/content hash differs from the expected snapshot');
}
function writeDurable(file,bytes){
 const fd=fs.openSync(file,'wx');try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
 if(!fs.readFileSync(file).equals(bytes))fail('JOURNAL_READBACK','Saved bytes differ from write');
}
function removeOwned(file,bytes){
 const currentBytes=fs.readFileSync(file);
 if(!currentBytes.equals(bytes))fail('JOURNAL_LOCK_CHANGED','Writer lock changed; refusing to remove it');
 fs.unlinkSync(file);
}
function withLock(file,callback){
 const lock=file+'.lock',recovery=file+'.recover.lock';
 if(fs.existsSync(recovery))fail('JOURNAL_LOCKED','Journal recovery is in progress: '+recovery);
 const bytes=Buffer.from(JSON.stringify({schema:'blackice.minicpm.campaign-lock.v1',pid:process.pid,token:crypto.randomUUID(),createdAt:new Date().toISOString(),journal:file})+'\n');
 try{writeDurable(lock,bytes);}catch(e){if(e.code==='EEXIST')fail('JOURNAL_LOCKED','Another or interrupted writer owns '+lock);throw e;}
 let failure,result;
 try{
  if(fs.existsSync(recovery))fail('JOURNAL_LOCKED','Journal recovery is in progress: '+recovery);
  result=callback();
 }catch(e){failure=e;}
 try{removeOwned(lock,bytes);}catch(e){if(failure)throw new AggregateError([failure,e],'Journal operation and lock cleanup failed');throw e;}
 if(failure)throw failure;
 return result;
}
function saveEvidence(directory,kind,value){
 if(typeof kind!=='string'||!/^[a-z][a-z0-9-]{0,63}$/.test(kind))fail('EVIDENCE_KIND','An explicit safe evidence kind is required');
 const bytes=Buffer.isBuffer(value)?value:Buffer.from(typeof value==='string'?value:JSON.stringify(value,null,2)+'\n');
 const hash=digest(bytes),file=path.resolve(directory,kind+'-'+hash+'.json');
 fs.mkdirSync(path.dirname(file),{recursive:true});
 try{writeDurable(file,bytes);}catch(e){if(e.code!=='EEXIST')throw e;if(!fs.readFileSync(file).equals(bytes))fail('EVIDENCE_CONFLICT','Content-addressed evidence differs');}
 const saved=fs.readFileSync(file);
 if(!saved.equals(bytes))fail('EVIDENCE_READBACK','Evidence readback differs');
 return {path:file,sha256:hash,bytes:bytes.length};
}
function ownerStatus(pid){
 if(!Number.isSafeInteger(pid)||pid<=0)fail('JOURNAL_LOCK_INVALID','Lock owner PID is invalid');
 try{process.kill(pid,0);return 'alive';}catch(e){if(e.code==='ESRCH')return 'gone';if(e.code==='EPERM')return 'unknown';throw e;}
}
function inspectLock(file){
 const absolute=path.resolve(file),lock=absolute+'.lock',bytes=fs.readFileSync(lock),owner=JSON.parse(bytes.toString('utf8'));
 if(owner.schema!=='blackice.minicpm.campaign-lock.v1'||owner.journal!==absolute||typeof owner.token!=='string')fail('JOURNAL_LOCK_INVALID','Lock identity is invalid');
 return {path:lock,sha256:digest(bytes),bytes:bytes.length,owner,status:ownerStatus(owner.pid)};
}


/** A store is bound to one code-owned schema/validator; no CLI-selectable validator. */
function createJournalStore({schema,validateState,identityOf}={}){
 if(typeof schema!=='string'||!schema.trim()||typeof validateState!=='function'||typeof identityOf!=='function')fail('JOURNAL_STORE_CONTRACT','A fixed schema, validator and immutable identity function are required');
 function validate(state){
  if(state?.schema!==schema||!Number.isSafeInteger(state.revision)||state.revision<0)fail('JOURNAL_SCHEMA','The journal belongs to a different schema or is incomplete');
  validateState(state);if(!isHash(identityOf(state)))fail('JOURNAL_IDENTITY','The typed validator must produce a fixed immutable identity digest');
  return state;
 }
function load(file){
 const absolute=path.resolve(file),bytes=fs.readFileSync(absolute);
 const state=validate(JSON.parse(bytes.toString('utf8')));
 return {state,receipt:receipt(absolute,bytes,state)};
}
function current(file){try{return load(file);}catch(e){if(e.code==='ENOENT')return null;throw e;}}
function save(file,state,{expected}={}){
 validate(state);
 if(expected===undefined)fail('JOURNAL_EXPECTED_REQUIRED','Supply expected:null for creation or the last revision and SHA-256 for replacement');
 const absolute=path.resolve(file);fs.mkdirSync(path.dirname(absolute),{recursive:true});
 return withLock(absolute,()=>{
  const old=current(absolute);requireExpected(old,expected);
  if(old&&identityOf(state)!==identityOf(old.state))fail('JOURNAL_IDENTITY','A journal cannot be replaced by another campaign, manifest, or scaffold');
  if(old&&state.revision<=old.state.revision)fail('JOURNAL_REVISION','A replacement must advance the whole campaign revision');
  if(!old&&state.revision!==0)fail('JOURNAL_REVISION','A new campaign must begin at revision zero');
  const bytes=Buffer.from(JSON.stringify(state,null,2)+'\n'),temp=absolute+'.'+process.pid+'.'+crypto.randomUUID()+'.tmp';
  writeDurable(temp,bytes);
  // Recheck immediately before replacement while holding the writer lock.
  requireExpected(current(absolute),expected);
  fs.renameSync(temp,absolute);
  const read=fs.readFileSync(absolute);
  if(!read.equals(bytes))fail('JOURNAL_READBACK','Atomic journal replacement readback differs');
  return receipt(absolute,read,state);
 });
}
function create(file,state){return save(file,state,{expected:null});}
function recoverLock(file,{lockSha256,expected}={}){
 if(!isHash(lockSha256)||expected===undefined)fail('JOURNAL_RECOVERY_EXPECTED','Exact lock hash and journal snapshot are required for recovery');
 const absolute=path.resolve(file),recovery=absolute+'.recover.lock';
 const recoveryBytes=Buffer.from(JSON.stringify({pid:process.pid,token:crypto.randomUUID(),journal:absolute})+'\n');
 try{writeDurable(recovery,recoveryBytes);}catch(e){if(e.code==='EEXIST')fail('JOURNAL_LOCKED','Another or interrupted recovery owns '+recovery);throw e;}
 let failure,result;
 try{
  const lock=inspectLock(absolute);
  if(lock.sha256!==lockSha256)fail('JOURNAL_CONFLICT','Interrupted lock bytes changed');
  if(lock.status!=='gone')fail('JOURNAL_OWNER_UNSETTLED','The previous writer is alive or cannot be proved gone');
  requireExpected(current(absolute),expected);
  const bytes=fs.readFileSync(lock.path);
  if(digest(bytes)!==lockSha256)fail('JOURNAL_CONFLICT','Interrupted lock changed before recovery');
  const archive=lock.path+'.recovered.'+lock.owner.token;
  if(fs.existsSync(archive))fail('JOURNAL_CONFLICT','Recovery archive already exists');
  fs.renameSync(lock.path,archive);
  const read=fs.readFileSync(archive);
  if(!read.equals(bytes))fail('JOURNAL_READBACK','Recovered lock archive differs');
  result={recovered:true,previousOwner:lock.owner,archive:{path:archive,sha256:digest(read),bytes:read.length},journal:current(absolute)?.receipt||null,stagingFilesPreserved:true};
 }catch(e){failure=e;}
 try{removeOwned(recovery,recoveryBytes);}catch(e){if(failure)throw new AggregateError([failure,e],'Recovery and lock cleanup failed');throw e;}
 if(failure)throw failure;
 return result;
}

 return Object.freeze({schema,validate,load,create,save,saveEvidence,inspectLock,recoverLock});
}
const guarded=createJournalStore({
 schema:campaign.SCHEMA,validateState:validateCampaign,
 identityOf:state=>digest(JSON.stringify([state.schema,state.createdAt,state.manifestSha256,state.bindingSha256,state.scaffoldReceiptText,state.controller.configSha256]))
});
module.exports={...guarded,createJournalStore};
