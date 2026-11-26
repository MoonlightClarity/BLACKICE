import {searchRunActivity,searchTaskFailures} from './run-activity-view.mjs';
export async function handleConversationActivityHttp({req,res,pathname,conversations,json}) {
 const match=pathname.match(/^\/api\/conversations\/([a-zA-Z0-9_-]+)\/activity$/);
 if(!match)return false;
 if(req.method!=='GET'){json(res,405,{error:'Use GET for conversation activity.'});return true;}
 const params=new URL(req.url,'http://localhost').searchParams;
 const allowed=['view','q','offset','limit','revision','scope'];
 if([...params.keys()].some(key=>!allowed.includes(key)||params.getAll(key).length!==1))throw Object.assign(Error('Use each supported activity parameter once.'),{status:400,code:'ACTIVITY_QUERY'});
 const query={view:params.get('view')||'updates',q:params.get('q')||'',offset:Number(params.get('offset')||0),limit:Number(params.get('limit')||30),revision:params.get('revision')||undefined};
 const scope=params.get('scope')||'turn';
 if(!['turn','task'].includes(scope)||scope==='task'&&query.view!=='failures')throw Object.assign(Error('Task-wide search is available only for tool-failure receipts.'),{status:400,code:'ACTIVITY_QUERY'});
 if(scope==='task'){
  const family=await conversations.family(match[1]);
  if(!family.runs?.some(run=>run.id===match[1]&&(run.taskId||run.id)===(family.rootId||family.taskId)))throw Object.assign(Error('Selected turn is not in the requested conversation.'),{status:404});
  json(res,200,searchTaskFailures(family,{...query,runId:match[1]}));return true;
 }
 json(res,200,searchRunActivity(await conversations.get(match[1]),query));return true;
}
