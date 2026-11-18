import {promises as fs} from 'node:fs';
import path from 'node:path';
const failure=(message,status=400,code='TODO_INVALID')=>Object.assign(Error(message),{status,code});
const clip=(value,max)=>typeof value==='string'?value.slice(0,max):'';
export async function legacyTodoAvailable(dataDir){try{await fs.stat(path.join(dataDir,'swarm-board.json'));return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}}
export async function readLegacyTodoRecords(dataDir){
 const file=path.join(dataDir,'swarm-board.json');let handle;
 try{handle=await fs.open(file,'r');if((await handle.stat()).size>16*1024*1024)throw failure('Previous records exceed the read-only preview limit; original file is preserved.',413);const value=JSON.parse(await handle.readFile('utf8'));
 if(!Array.isArray(value.projects))throw failure('Previous records cannot be previewed; original file is preserved.',500);
 let truncated=value.projects.length>100,remaining=1000;
 const projects=value.projects.slice(0,100).map(project=>{const items=Array.isArray(project.items)?project.items:[];const count=Math.min(items.length,remaining);remaining-=count;if(items.length>count)truncated=true;return{id:clip(project.id,100),name:clip(project.name,160),objective:clip(project.objective,6000),items:items.slice(0,count).map(item=>({id:clip(item.id,100),title:clip(item.title,1000),phase:clip(item.phase,80)}))};});
 return{readOnly:true,projects,truncated};
 }catch(error){if(error.code==='ENOENT')return{readOnly:true,projects:[],truncated:false};throw error;}finally{await handle?.close();}
}
export async function handleUserTodoHttp({req,res,pathname,body,json,todos,dataDir,mutations=new Set(),sendEvent}){
 if(pathname!=='/api/todos'&&pathname!=='/api/todos/legacy')return false;
 try{
 if(pathname==='/api/todos/legacy'&&req.method==='GET'){json(res,200,await readLegacyTodoRecords(dataDir));return true;}
 if(pathname==='/api/todos'&&req.method==='GET'){json(res,200,{...await todos.snapshot(),legacyAvailable:await legacyTodoAvailable(dataDir)});return true;}
 if(pathname==='/api/todos'&&req.method==='POST'){
  if(req.headers['x-blackice-remote']==='1')throw failure('Edit the to-do outline in BLACKICE on this computer.',403,'TODO_HUMAN_REQUIRED');
  const value=await body(req);const pending=todos.apply(value,{source:'human'});mutations.add(pending);
  try{const snapshot=await pending;sendEvent?.({type:'todos.updated',data:{revision:snapshot.revision}});json(res,200,{...snapshot,legacyAvailable:await legacyTodoAvailable(dataDir)});}finally{mutations.delete(pending);}return true;
 }
 throw failure('Use GET to read or POST to edit the outline.',405);
 }catch(error){json(res,error.status||400,{error:error.message,code:error.code||'TODO_INVALID',...(Number.isSafeInteger(error.currentRevision)?{currentRevision:error.currentRevision}:{})});return true;}
}
