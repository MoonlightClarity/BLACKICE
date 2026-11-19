import {createMissionWorkflow} from '../public/mission-model.mjs';

const id=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(value);
const invalid=()=>Object.assign(Error('Supply a new task, a request ID, and only the supported fresh Chat options.'),{status:400,code:'FRESH_CHAT_TASK_INVALID'});
const fields=new Set(['task','requestId','model','effort','serviceTier','cwd','attachmentIds']);

/** No previous run enters the admitted job object. The host attaches display
 * membership separately, after resolving an actual saved source task. */
export function freshChatTaskRequest(value,{defaultCwd}={}){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!fields.has(key))||
    !id(value.requestId)||!/^chat_/.test(value.requestId)||typeof value.task!=='string'||!value.task.trim()||value.task.length>50000||
    (value.cwd!==undefined&&(typeof value.cwd!=='string'||!value.cwd.trim()||value.cwd.length>2000))||
    (value.model!==undefined&&(typeof value.model!=='string'||!value.model.trim()||value.model.length>400))||
    (value.attachmentIds!==undefined&&(!Array.isArray(value.attachmentIds)||value.attachmentIds.length>10||!value.attachmentIds.every(id))))throw invalid();
  const {requestId,task,model,effort,serviceTier,cwd=defaultCwd,attachmentIds=[]}=value;
  const workflow=createMissionWorkflow({task,model,effort,serviceTier,cwd,id:'mission_'+requestId,planningMode:'off'});
  return {workflow,input:{task,cwd,attachmentIds,planningMode:'off',directoryMode:'off',pastChats:'off'},requestId};
}
