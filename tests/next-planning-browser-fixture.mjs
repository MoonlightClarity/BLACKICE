import { PLANNING_MODULE_TEMPLATES, projectPlanningRequest } from '../public/planning-browser-model.mjs';

// Current modular Planning contracts, shared with the mounted browser unit tests.
export function createPlanningBrowserFixture({state,json}) {
  const request=(id,conversationId)=>({id,conversationId,title:'Review the local workspace',
    objective:'Compare saved evidence before choosing the next action.',revision:1,
    nodes:[{id:'frame',kind:'frame',title:'Define the outcome',prompt:'Expose assumptions and alternative framing.',parentId:null,revision:1},
      {id:'child',kind:'decision',title:'Choose the next useful check',prompt:'Follow the saved evidence.',parentId:'frame',revision:1}],
    edges:[],sources:[],responses:[],assignments:[],attempts:[],history:[]});
  const documents=state.planningDocuments=new Map([
    ['request-current',request('request-current','planning-current')],
    ['request-archive',{...request('request-archive','planning-archive'),title:'Saved archived investigation'}],
  ]);
  state.planningMutations=[];
  let serial=0;
  return async(req,res,url)=>{
    const route=url.pathname;
    if(!route.startsWith('/api/planning-browser'))return false;
    const reply=(value,status=200)=>{json(res,value,status);return true;};
    if(route==='/api/planning-browser'&&req.method==='GET')return reply({
      conversations:[{id:'planning-current',title:'Current modular investigation',state:'active',status:'completed',settled:true},
        {id:'planning-archive',title:'Saved archived investigation',state:'archived',status:'completed',settled:true}],
      requests:[...documents.values()].map(({id,conversationId,title,revision})=>({id,conversationId,title,revision})),
      templates:PLANNING_MODULE_TEMPLATES});
    const parts=route.split('/'),document=documents.get(parts[4]);
    if(!document)return reply({error:'Unknown synthetic Planning request'},404);
    if(parts.length===5&&req.method==='GET')return reply(projectPlanningRequest(document));
    let raw='';for await(const chunk of req)raw+=chunk;
    const body=JSON.parse(raw||'{}'),node=document.nodes.find(row=>row.id===parts[6]);
    if(parts[5]==='nodes'&&parts.length===7&&req.method==='PATCH'){
      if(!node||body.expectedNodeRevision!==node.revision)return reply({error:'Module revision changed'},409);
      for(const key of ['title','prompt','doneWhen','skipReason'])if(body[key]!==undefined)node[key]=body[key];
      node.revision++;
    }else if(parts[5]==='nodes'&&parts.length===6&&req.method==='POST'){
      const parent=document.nodes.find(row=>row.id===body.parentId);
      if(parent&&body.expectedParentRevision!==parent.revision)return reply({error:'Parent revision changed'},409);
      document.nodes.push({id:'created-module-'+(++serial),parentId:body.parentId||null,
        kind:body.kind,title:body.title,prompt:body.prompt,revision:1});
    }else return reply({error:'Unsupported synthetic Planning mutation'},400);
    document.revision++;state.planningMutations.push({route,method:req.method,body});
    return reply(projectPlanningRequest(document));
  };
}
