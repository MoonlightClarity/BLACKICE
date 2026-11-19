import {promises as fs} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {renameWithRetry} from './coalescing-persistence.mjs';
import {TaskActionDirectory} from './task-action-directory.mjs';
export function actionDirectoryMode(value){if(value===undefined)return undefined;if(!['on','off'].includes(value))throw Object.assign(Error('Choose action Directory On or Off.'),{status:400,code:'DIRECTORY_ACTION_MODE'});return value;}
/** One registry per engine owner. Task identity, never display folder/group, selects storage. */
export class TaskActionDirectoryStore {
 constructor(dataDir){this.root=path.join(dataDir,'task-action-directory');this.entries=new Map();}
 get(taskId,objective){
  if(typeof taskId!=='string'||!/^[A-Za-z0-9_-]{1,80}$/.test(taskId))throw Error('Invalid action Directory task identity.');
  if(!this.entries.has(taskId)){const pending=this.open(taskId,objective);this.entries.set(taskId,pending);pending.catch(()=>{if(this.entries.get(taskId)===pending)this.entries.delete(taskId);});}return this.entries.get(taskId);
 }
 async open(taskId,objective){const file=path.join(this.root,taskId+'.json');let snapshot;try{snapshot=JSON.parse(await fs.readFile(file,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
  return new TaskActionDirectory({taskId,objective:snapshot?.objective||objective,snapshot,admitRecovery:call=>call.name==='relay_find_files',persist:async value=>{await fs.mkdir(this.root,{recursive:true});const temporary=file+'.'+randomUUID()+'.tmp';try{const handle=await fs.open(temporary,'wx');try{await handle.writeFile(JSON.stringify(value));await handle.sync();}finally{await handle.close();}await renameWithRetry(temporary,file);}catch(error){await fs.rm(temporary,{force:true}).catch(()=>{});throw error;}}});
 }
 async close(){await Promise.all([...this.entries.values()].map(async entry=>(await entry).queue));}
}
