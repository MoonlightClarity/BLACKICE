/** Mode controls are separate from the legacy Goal endpoint. */
export async function handleConversationAutonomyHttp({req,res,pathname,autonomy,body,json,mutations=new Set()}){
  const match=pathname.match(/^\/api\/conversations\/([a-zA-Z0-9_-]+)\/autonomy$/);
  if(!match)return false;
  try{
    if(req.method==='GET')json(res,200,{autonomy:await autonomy.get(match[1])});
    else if(req.method==='POST'){
      const value=await body(req,Infinity);
      if(!value||typeof value!=='object'||Array.isArray(value))
        throw Object.assign(Error('Provide an autonomy control.'),{status:400,code:'AUTONOMY_INVALID'});
      const pending=autonomy.control(match[1],value);
      mutations.add(pending);
      try{json(res,200,await pending);}finally{mutations.delete(pending);}
    }else{
      res.setHeader?.('Allow','GET, POST');
      json(res,405,{error:'Use GET to read autonomy or POST to change it.',code:'AUTONOMY_METHOD'});
    }
  }catch(error){
    json(res,error.status||400,{error:error.message,code:error.code||'AUTONOMY_ERROR'});
  }
  return true;
}