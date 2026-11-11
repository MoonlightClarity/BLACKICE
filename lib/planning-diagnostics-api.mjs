import {legacyPlanningError} from '../public/planning-browser-model.mjs';
const captureFields=['sourceRequestId','sourceCycleId','expectedSourceRevision','limits','profile'];
const fail=(message,status=400)=>Object.assign(new Error(message),{code:'PLANNING_DIAGNOSTIC_ARGUMENT',status});
const fields=(value,allowed)=>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!allowed.includes(key)))throw fail('Use only declared diagnostic fields.');};
export async function handlePlanningDiagnosticsHttp({req,res,pathname,service,body,json,fileMutations}){
  const prefix='/api/planning-diagnostics';if(pathname!==prefix&&!pathname.startsWith(prefix+'/'))return false;
  if(!service)throw fail('Planning diagnostics are unavailable.',503);
  const parts=pathname.slice(prefix.length).split('/').filter(Boolean);
  if(req.method==='GET'&&parts.length===1){json(res,200,await service.read(parts[0]));return true;}
  if(req.method!=='POST')throw fail('Use a supported diagnostic route.',404);
  if (parts[0] === 'capture' || parts[1] === 'run') throw legacyPlanningError();
  const value=await body(req);
  if(parts.length!==2||parts[1]!=='cancel')throw fail('Use a supported diagnostic route.',404);
  fields(value,[]);const operation=service.cancel(parts[0]);
  fileMutations?.add(operation);try{json(res,200,await operation);}finally{fileMutations?.delete(operation);}return true;
}
