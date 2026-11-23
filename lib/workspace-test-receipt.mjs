// Host-confirmed command status for targeted, read-only Directory completion guidance.
// This is never authorization to repeat a command or claim full task correctness.
const TEST_COMMAND=/(?:^|[;&]\s*)(?:node(?:\.exe)?\s+--test\b|npm(?:\.cmd)?\s+(?:test|run\s+test)\b|pnpm(?:\.cmd)?\s+(?:test|run\s+test)\b|yarn(?:\.cmd)?\s+test\b|pytest\b|python(?:3|\.exe)?\s+-m\s+pytest\b|cargo\s+test\b|go\s+test\b)/i;
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const argumentsOf=call=>{
  try{
    const value=typeof call?.arguments==='string'?JSON.parse(call.arguments):call?.arguments;
    return object(value)?value:null;
  }catch{return null;}
};
/** Only a returned successful native workspace test command qualifies, never its prose. */
export function verifiedWorkspaceTestReceipt(call,result){
  if(call?.namespace||call?.name!=='relay_workspace'||result?.success!==true)return null;
  const args=argumentsOf(call);
  if(args?.action!=='run'||typeof args.command!=='string'||args.command.length<1||args.command.length>1000||!TEST_COMMAND.test(args.command))return null;
  const item=result.contentItems?.find(row=>row?.type==='inputText'&&typeof row.text==='string');
  let body;try{body=JSON.parse(item?.text||'null');}catch{return null;}
  if(!object(body)||body.command!==args.command||body.exitCode!==0||body.timedOut!==false||body.truncated!==false||
    body.signal!==null||!['powershell','sh'].includes(body.shell)||typeof body.cwd!=='string'||!body.cwd)return null;
  return{command:args.command,cwd:body.cwd,exitCode:0};
}
