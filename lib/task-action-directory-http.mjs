export async function handleTaskActionDirectoryHttp({req,res,pathname,engine,conversations,json,body}){
 const match=pathname.match(/^\/api\/conversations\/([A-Za-z0-9_-]+)\/action-directory$/);if(!match)return false;
 if(req.headers?.['x-blackice-remote']==='1')throw Object.assign(Error('Edit task Directory in the local Chat.'),{status:403});
 if(!['GET','POST'].includes(req.method))throw Object.assign(Error('Use GET or POST.'),{status:405});
 const params=new URL(req.url,'http://localhost').searchParams;
 if([...params.keys()].some(key=>key!=='taskId'||params.getAll(key).length!==1)||!params.get('taskId'))throw Object.assign(Error('Select the exact task.'),{status:400});
 const run=engine.runs.get(match[1])||await conversations.get(match[1]);const taskId=run.taskId||run.id;
 if(taskId!==params.get('taskId'))throw Object.assign(Error('The selected run belongs to another task.'),{status:404});
 if(run.directoryActions!=='on'&&run.chatPlanning!=='on')throw Object.assign(Error('Enable Directory or Planning for the next response first.'),{status:409});
 const ledger=await engine.actionDirectories.get(taskId,run.input.slice(0,8000));
 let state;if(req.method==='POST'){const value=await body(req,40000);if(!['plan','focus','block'].includes(value.action))throw Object.assign(Error('Use plan, focus or block to steer the outline.'),{status:400});state=await ledger.edit(value,{authority:'human'});}else state=ledger.read();
 json(res,200,{runId:run.id,taskId,state,final:ledger.finalStatus()});return true;
}
