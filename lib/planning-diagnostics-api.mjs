const captureFields=['sourceRequestId','sourceCycleId','expectedSourceRevision','limits','profile'];
const fail=(message,status=400)=>Object.assign(new Error(message),{code:'PLANNING_DIAGNOSTIC_ARGUMENT',status});
const fields=(value,allowed)=>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!allowed.includes(key)))throw fail('Use only declared diagnostic fields.');};
export async function handlePlanningDiagnosticsHttp({req,res,pathname,service,body,json,fileMutations}){
  const prefix='/api/planning-diagnostics';if(pathname!==prefix&&!pathname.startsWith(prefix+'/'))return false;
  if(!service)throw fail('Planning diagnostics are unavailable.',503);
  const parts=pathname.slice(prefix.length).split('/').filter(Boolean);
  if(req.method==='GET'&&parts.length===1){json(res,200,await service.read(parts[0]));return true;}
  if(req.method!=='POST')throw fail('Use a supported diagnostic route.',404);
  const value=await body(req);let operation,status=200;
  if(parts.length===1&&parts[0]==='capture'){fields(value,[...captureFields,'clientRequestId']);operation=service.capture(value);status=201;}
  else if(parts.length===2&&parts[1]==='run'){fields(value,['expectedRevision','captureHash','clientRequestId']);operation=service.run(parts[0],value);}
  else if(parts.length===2&&parts[1]==='cancel'){fields(value,[]);operation=service.cancel(parts[0]);}
  else throw fail('Use a supported diagnostic route.',404);
  fileMutations?.add(operation);try{json(res,status,await operation);}finally{fileMutations?.delete(operation);}return true;
}
