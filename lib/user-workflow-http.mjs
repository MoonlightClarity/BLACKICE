import {createMissionWorkflow} from '../public/mission-model.mjs';
const fail=(message,status=400)=>Object.assign(Error(message),{status});
export async function handleUserWorkflowHttp({req,res,pathname,body,json,workflows,engine,defaultCwd,recoverClientRequest,sendEvent}) {
 if(pathname!=='/api/user-workflows'&&!pathname.startsWith('/api/user-workflows/'))return false;
 if(req.method!=='GET'&&req.headers['x-blackice-remote']==='1')throw fail('Author and approve workflows in BLACKICE on this computer.',403);
 const match=pathname.match(/^\/api\/user-workflows\/([a-zA-Z0-9_-]+)(?:\/(execute))?$/);
 if(pathname==='/api/user-workflows'&&req.method==='GET'){json(res,200,{workflows:await workflows.list()});return true;}
 if(pathname==='/api/user-workflows'&&req.method==='POST'){
  const saved=await workflows.save(await body(req),{source:'human'});sendEvent?.({type:'user-workflows.updated'});json(res,200,saved);return true;
 }
 if(match&&req.method==='GET'&&!match[2]){json(res,200,await workflows.read(match[1]));return true;}
 if(match&&req.method==='POST'&&match[2]==='execute'){
  const value=await body(req);
  if(!value||Object.keys(value).some(key=>!['expectedRevision','requestId','input'].includes(key))||!Number.isSafeInteger(value.expectedRevision)||value.expectedRevision<1||typeof value.requestId!=='string'||!/^[-a-zA-Z0-9_]{8,100}$/.test(value.requestId)||value.input!==undefined&&(typeof value.input!=='string'||value.input.length>16000))throw fail('Use the selected revision, a request ID and optional task input.');
  const selection=JSON.stringify({kind:'user-workflow',id:match[1],revision:value.expectedRevision,input:value.input||''});
  await recoverClientRequest?.(value);
  const existingId=engine.clientRequestRunId?.(value.requestId);
  if(existingId){const existing=engine.getRun(existingId);if(existing.workflow?.description!==selection)throw fail('This request ID belongs to a different workflow selection or input.',409);json(res,201,existing);return true;}
  const selected=await workflows.execute(match[1],{expectedRevision:value.expectedRevision});
  const definition=selected.workflow;
  if(!definition)throw fail('Workflow execution did not return its selected definition.',500);
  const task='Run this explicitly selected user workflow. Current instructions and permissions still apply.\n'+JSON.stringify({id:definition.id,revision:definition.revision,name:definition.name,instructions:definition.instructions})+(value.input?'\nTask input:\n'+value.input:'');
  const request={requestId:value.requestId,workflow:createMissionWorkflow({task,cwd:defaultCwd,planningMode:'off'}),input:{task,cwd:defaultCwd,planningMode:'off'}};
  request.workflow.description=selection;
  const run=engine.startRun(request);json(res,201,run);return true;
 }
 throw fail('Workflow endpoint not found.',404);
}
