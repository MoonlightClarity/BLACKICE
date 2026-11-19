import {projectDirectoryDiagnostics} from './directory-diagnostics.mjs';
export async function handleDirectoryDiagnosticsHttp({req,res,pathname,conversations,json}){
 const match=pathname.match(/^\/api\/conversations\/([A-Za-z0-9_-]+)\/directory$/);if(!match)return false;
 if(req.headers?.['x-blackice-remote']==='1'){json(res,403,{error:'Open Directory diagnostics in BLACKICE on this computer.'});return true;}
 if(req.method!=='GET'){json(res,405,{error:'Use GET for Directory diagnostics.'});return true;}
 const q=new URL(req.url,'http://localhost').searchParams;
 if([...q.keys()].some(key=>!['taskId','offset','limit','revision','view','q'].includes(key)||q.getAll(key).length!==1)||!q.get('taskId'))throw Object.assign(Error('Select a task and a bounded Directory page.'),{status:400});
 const run=await conversations.get(match[1]);
 if((run.taskId||run.id)!==q.get('taskId'))throw Object.assign(Error('Run does not belong to the selected task.'),{status:404});
 json(res,200,projectDirectoryDiagnostics(run,{offset:Number(q.get('offset')||0),limit:Number(q.get('limit')||30),revision:q.get('revision')||undefined,view:q.get('view')||'context',q:q.get('q')||''}));return true;
}
