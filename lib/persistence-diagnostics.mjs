import os from 'node:os';
const OPERATIONS=new Set(['browser-settings-init','browser-settings-save','atomic-snapshot','planning-state','run-history','unspecified']);
const PHASES=new Set(['prepare','write','sync','close','rename','cleanup','complete']);
const ROLES=new Set(['temporary','live','backup','temporary-directory','live-directory','none']);
const CODES=new Set(['EPERM','EACCES','EBUSY','ENOENT','EEXIST','ENOTEMPTY','ENOSPC','EROFS','EMFILE','ENFILE','EIO','EINVAL','EXDEV']);
const SYSCALLS=new Set(['open','write','fsync','close','rename','unlink','rmdir','mkdir','read','link','stat']);
const OUTCOMES=new Set(['started','succeeded','failed','retry']);
const COMMITS=new Set(['unknown','rename-reported-success','not-attempted']);
const version=value=>typeof value==='string'&&/^\d+(?:\.\d+){1,3}$/.test(value)&&value.length<40?value:'unknown';
const integer=(n,max=86400000)=>Number.isSafeInteger(n)&&n>=0&&n<=max?n:0;
export function sanitizePersistenceDiagnostic(value){
 if(!value||!PHASES.has(value.phase)||!OUTCOMES.has(value.outcome))return null;
 return {operation:OPERATIONS.has(value.operation)?value.operation:'unspecified',phase:value.phase,outcome:value.outcome,
 sourceRole:ROLES.has(value.sourceRole)?value.sourceRole:'none',destinationRole:ROLES.has(value.destinationRole)?value.destinationRole:'none',
 durationMs:integer(value.durationMs),elapsedMs:integer(value.elapsedMs),attempt:integer(value.attempt,100),sequence:integer(value.sequence,2147483647),
 commitOutcome:COMMITS.has(value.commitOutcome)?value.commitOutcome:'unknown',
 code:CODES.has(value.code)?value.code:value.outcome==='failed'?'UNKNOWN_ERROR':'OK',
 errno:Number.isSafeInteger(value.errno)&&Math.abs(value.errno)<=2147483647?value.errno:null,
 syscall:SYSCALLS.has(value.syscall)?value.syscall:'unknown',
 errorSource:value.outcome==='failed'?'node-system-error':'none',nativeWin32Error:null,
 nodeVersion:version(value.nodeVersion),uvVersion:version(value.uvVersion),osRelease:version(value.osRelease),
 platform:['win32','linux','darwin','freebsd','openbsd','aix','sunos','android'].includes(value.platform)?value.platform:'unknown'};
}
let sequence=0;
const noop=()=>{};
/** Opt-in metadata only. No messages, stacks, user values or filesystem paths. */
export function createPersistenceTrace(record,operation,{now=()=>performance.now()}={}){
 if(typeof record!=='function')return {emit:noop,run:(_phase,action)=>action()};
 const clock=()=>{try{const value=now();return Number.isFinite(value)?value:0;}catch{return 0;}};
 const started=clock(),id=sequence=sequence>=2147483647?1:sequence+1;let count=0;
 let versions={};try{versions={nodeVersion:process.versions.node,uvVersion:process.versions.uv,osRelease:os.release().match(/^\d+(?:\.\d+){1,3}/)?.[0],platform:process.platform};}catch{}
 const emit=details=>{try{if(count++>=64)return;const event=sanitizePersistenceDiagnostic({...details,...versions,operation,sequence:id,elapsedMs:Math.round(clock()-started)});
 if(event)Promise.resolve(record({component:'storage',event:'persistence_operation',level:details.outcome==='failed'?'warning':'info',...event})).catch(noop);}catch{}};
 const run=async(phase,action,details={})=>{const start=clock();emit({...details,phase,outcome:'started'});
 try{const result=await action();emit({...details,phase,outcome:'succeeded',durationMs:Math.round(clock()-start)});return result;}
 catch(error){try{emit({...details,phase,outcome:'failed',durationMs:Math.round(clock()-start),code:error?.code,errno:error?.errno,syscall:error?.syscall});}catch{}throw error;}};
 return {emit,run};
}
