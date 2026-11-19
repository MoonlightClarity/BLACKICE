import {projectDirectoryDiagnostics} from './directory-diagnostics.mjs';
import {projectTurnMachineTrace} from './turn-machine-trace.mjs';
export async function handleDirectoryDiagnosticsHttp({req,res,pathname,conversations,json}){
 const match=pathname.match(/^\/api\/conversations\/([A-Za-z0-9_-]+)\/directory$/);if(!match)return false;
 if(req.headers?.['x-blackice-remote']==='1'){json(res,403,{error:'Open Turn receipts in BLACKICE on this computer.'});return true;}
 if(req.method!=='GET'){json(res,405,{error:'Use GET for Turn receipts.'});return true;}
 const q=new URL(req.url,'http://localhost').searchParams;
 if([...q.keys()].some(key=>!['taskId','offset','limit','revision','view','q'].includes(key)||q.getAll(key).length!==1)||!q.get('taskId'))throw Object.assign(Error('Select a task and a bounded Directory page.'),{status:400});
 const machine=q.get('view')==='machine';
 if(machine&&[...q.keys()].some(key=>!['taskId','view'].includes(key)))throw Object.assign(Error('Select only the task and machine trace view.'),{status:400});
 const run=machine?await conversations.get(match[1],{includeMachineTrace:true}):await conversations.get(match[1]);
 if((run.taskId||run.id)!==q.get('taskId'))throw Object.assign(Error('Run does not belong to the selected task.'),{status:404});
 if(machine){if(run.directoryDiagnostics!=='maximal')throw Object.assign(Error('Maximal receipts were not selected for this turn.'),{status:409,code:'MACHINE_TRACE_NOT_ENABLED'});json(res,200,projectTurnMachineTrace(run));return true;}
 json(res,200,projectDirectoryDiagnostics(run,{offset:Number(q.get('offset')||0),limit:Number(q.get('limit')||30),revision:q.get('revision')||undefined,view:q.get('view')||'context',q:q.get('q')||''}));return true;
}
