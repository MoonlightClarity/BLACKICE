import {searchRunActivity} from './run-activity-view.mjs';
export async function handleConversationActivityHttp({req,res,pathname,conversations,json}) {
 const match=pathname.match(/^\/api\/conversations\/([a-zA-Z0-9_-]+)\/activity$/);
 if(!match)return false;
 if(req.method!=='GET'){json(res,405,{error:'Use GET for conversation activity.'});return true;}
 const params=new URL(req.url,'http://localhost').searchParams;
 const allowed=['view','q','offset','limit','revision'];
 if([...params.keys()].some(key=>!allowed.includes(key)||params.getAll(key).length!==1))throw Object.assign(Error('Use each supported activity parameter once.'),{status:400,code:'ACTIVITY_QUERY'});
 const query={view:params.get('view')||'updates',q:params.get('q')||'',offset:Number(params.get('offset')||0),limit:Number(params.get('limit')||30),revision:params.get('revision')||undefined};
 json(res,200,searchRunActivity(await conversations.get(match[1]),query));return true;
}
