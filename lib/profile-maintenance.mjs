import {promises as fs} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createProfileBackup,verifyProfileBackup,restoreProfileBackup,recoverProfileRestore} from './profile-backup.mjs';

const fail=(message,code='MAINTENANCE_FAILED')=>Object.assign(new Error(message),{code});
const modes=new Set(['backup','restore']);
export function maintenancePaths(profileDir){
  const profile=path.resolve(profileDir),parent=path.dirname(profile),name=path.basename(profile);
  if(parent===profile||!name||name==='.'||name==='..')throw fail('Choose a Relay profile folder.','INVALID_PROFILE');
  return{profile,request:path.join(parent,`.${name}.maintenance-request.json`),receipt:path.join(parent,`.${name}.maintenance-result.json`)};
}
export function processAlive(pid){if(!Number.isSafeInteger(pid)||pid<1)return false;try{process.kill(pid,0);return true;}catch(error){return error.code==='EPERM';}}
const inside=(parent,child)=>{const relative=path.relative(parent,child);return relative===''||relative!=='..'&&!relative.startsWith(`..${path.sep}`)&&!path.isAbsolute(relative);};
function validateRequest(value,file){
  if(!value||value.version!==1||!modes.has(value.mode)||!/^[a-f0-9-]{36}$/.test(value.id||'')||typeof value.profileDir!=='string'||typeof value.backupDir!=='string'||!/^\d+\.\d+\.\d+$/.test(value.appVersion||'')||!Number.isSafeInteger(value.parentPid)||value.parentPid<1||value.helperPid!==null&&(!Number.isSafeInteger(value.helperPid)||value.helperPid<1)||typeof value.allowForeignBinding!=='boolean'||!Number.isFinite(Date.parse(value.createdAt)))throw fail('The pending maintenance request is invalid.','INVALID_MAINTENANCE_REQUEST');
  const paths=maintenancePaths(value.profileDir);
  if(paths.request!==path.resolve(file)||!path.isAbsolute(value.profileDir)||!path.isAbsolute(value.backupDir)||inside(paths.profile,value.backupDir)||inside(value.backupDir,paths.profile))throw fail('The pending maintenance paths are invalid.','INVALID_MAINTENANCE_REQUEST');
  return value;
}
async function readRequest(file){try{const raw=await fs.readFile(file,'utf8');if(raw.length>16000)throw fail('The pending maintenance request is invalid.','INVALID_MAINTENANCE_REQUEST');return validateRequest(JSON.parse(raw),file);}catch(error){if(error.code==='ENOENT')return null;throw error;}}
async function atomicJSON(file,value){const temporary=`${file}.${randomUUID()}.tmp`;let handle;try{handle=await fs.open(temporary,'wx',0o600);await handle.writeFile(JSON.stringify(value));await handle.sync();await handle.close();handle=null;await fs.rename(temporary,file);}finally{await handle?.close().catch(()=>{});await fs.rm(temporary,{force:true});}}
async function removeOwnedRequest(file,id){const current=await readRequest(file);if(current?.id===id)await fs.unlink(file);}

/** Reserve before quitting. Only the detached helper may read/copy the closed profile. */
export async function prepareProfileMaintenance({mode,profileDir,backupDir,appVersion,parentPid=process.pid,allowForeignBinding=false,assertIdle=async()=>{},verify=verifyProfileBackup}){
  if(!modes.has(mode))throw fail('Choose backup or restore.','INVALID_MAINTENANCE_REQUEST');
  const paths=maintenancePaths(profileDir),backup=path.resolve(backupDir);
  if(inside(paths.profile,backup)||inside(backup,paths.profile))throw fail('Choose a backup folder outside the Relay profile.','INVALID_BACKUP_PATH');
  await assertIdle();
  if(mode==='restore')await verify({backupDir:backup,appVersion});
  else{try{await fs.lstat(backup);throw fail('Choose a new backup folder.','BACKUP_EXISTS');}catch(error){if(error.code!=='ENOENT')throw error;}await fs.access(path.dirname(backup));}
  const request={version:1,id:randomUUID(),mode,profileDir:paths.profile,backupDir:backup,appVersion,parentPid,helperPid:null,allowForeignBinding:allowForeignBinding===true,createdAt:new Date().toISOString()};
  validateRequest(request,paths.request);let handle;const temporary=`${paths.request}.${request.id}.tmp`;
  try{handle=await fs.open(temporary,'wx',0o600);await handle.writeFile(JSON.stringify(request));await handle.sync();await handle.close();handle=null;await fs.link(temporary,paths.request);}
  catch(error){if(error.code==='EEXIST')throw fail('Relay is already preparing a backup or restore.','MAINTENANCE_BUSY');throw error;}finally{await handle?.close();await fs.rm(temporary,{force:true});}
  return{requestFile:paths.request,request};
}
export async function registerMaintenanceHelper(requestFile,id,pid){
  const request=await readRequest(requestFile);if(!request||request.id!==id)throw fail('The maintenance request changed.','MAINTENANCE_CHANGED');
  if(!Number.isSafeInteger(pid)||pid<1)throw fail('The maintenance helper could not start.','MAINTENANCE_HELPER_FAILED');
  await atomicJSON(requestFile,{...request,helperPid:pid});
}
export async function cancelPreparedMaintenance(requestFile,id){await removeOwnedRequest(requestFile,id);}

/** Startup waits rather than opening databases while a backup/restore owns them. */
export async function awaitProfileMaintenance({profileDir,alive=processAlive,sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)),timeoutMs=120000,recover=recoverProfileRestore}){
  const paths=maintenancePaths(profileDir),started=Date.now();
  while(true){
    const request=await readRequest(paths.request);if(!request)return;
    if(!alive(request.parentPid)&&!alive(request.helperPid)){
      await recover({profileDir:paths.profile});
      await atomicJSON(paths.receipt,{version:1,id:request.id,mode:request.mode,status:'failed',code:'MAINTENANCE_INTERRUPTED',finishedAt:new Date().toISOString()});
      await removeOwnedRequest(paths.request,request.id);return;
    }
    if(Date.now()-started>=timeoutMs)throw fail('Relay is still finishing a backup or restore. It will reopen when that work finishes.','MAINTENANCE_BUSY');
    await sleep(200);
  }
}

/** Wait for real process exit so Chromium/SQLite/storage handles are closed. */
export async function runProfileMaintenance({requestFile,alive=processAlive,sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)),timeoutMs=90000,create=createProfileBackup,restore=restoreProfileBackup,recover=recoverProfileRestore}){
  const request=await readRequest(requestFile);if(!request)throw fail('The maintenance request is missing.','MAINTENANCE_MISSING');
  const paths=maintenancePaths(request.profileDir),started=Date.now();let result,receipt;
  try{
    while(alive(request.parentPid)){if(Date.now()-started>=timeoutMs)throw fail('Relay has not finished closing. No profile was changed.','PROFILE_STILL_RUNNING');await sleep(100);}
    const current=await readRequest(requestFile);if(!current||current.id!==request.id||current.helperPid!==process.pid)return{version:1,id:request.id,mode:request.mode,status:'cancelled'};
    await recover({profileDir:paths.profile});
    result=request.mode==='backup'?await create({profileDir:paths.profile,backupDir:request.backupDir,appVersion:request.appVersion}):await restore({profileDir:paths.profile,backupDir:request.backupDir,appVersion:request.appVersion,allowForeignBinding:request.allowForeignBinding});
    const summary=Object.fromEntries(['backupDir','previousProfileDir','files','directories','bytes','manifestSha256','requiresReauthentication','bindingCompatible','restored'].filter(key=>result?.[key]!==undefined).map(key=>[key,result[key]]));
    receipt={version:1,id:request.id,mode:request.mode,status:'completed',finishedAt:new Date().toISOString(),result:summary};
  }catch(error){
    try{if(!alive(request.parentPid))await recover({profileDir:paths.profile});}catch{}
    receipt={version:1,id:request.id,mode:request.mode,status:'failed',code:/^[A-Z_]{1,64}$/.test(error.code||'')?error.code:'MAINTENANCE_FAILED',finishedAt:new Date().toISOString()};
  }
  await atomicJSON(paths.receipt,receipt);await removeOwnedRequest(requestFile,request.id);return receipt;
}
export async function readMaintenanceReceipt(profileDir){try{const value=JSON.parse(await fs.readFile(maintenancePaths(profileDir).receipt,'utf8'));return value?.version===1&&['completed','failed'].includes(value.status)?value:null;}catch{return null;}}
