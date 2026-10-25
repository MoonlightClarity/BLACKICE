import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {IdentityStore} from '../lib/identity.mjs';
import {ProviderStore} from '../lib/provider-store.mjs';
import {ConnectionManager} from '../lib/mcp.mjs';
import {parseConnectionImport} from '../lib/connection-import.mjs';

/** Real storage and MCP protocol in disposable state, never an external service. */
export function createSettingsFixture({state,json,send}){
  let ready;
  state.settingsPanelMutations=[];state.settingsPanelRequests=[];state.settingsProtocolCalls=[];
  const stores=()=>ready||=(async()=>{
    const directory=await mkdtemp(path.join(tmpdir(),'blackice-next-settings-fixture-'));
    const identity=await new IdentityStore({dataDir:directory}).init();
    const providers=new ProviderStore({dataDir:directory});await providers.init();
    await providers.save({id:'fixture',name:'Fixture model connection',preset:'compatible',type:'compatible',baseUrl:'http://fixture.invalid/v1',
      models:[{id:'model',displayName:'Fixture model',contextWindowTokens:100000,contextWindowSource:'user-configured',supportsTools:true}],enabled:true,maxTokens:8192,maxSteps:40});
    const connections=await new ConnectionManager({dataDir:directory,fetchImpl:async(_url,options)=>{
      if(options.method==='DELETE')return new Response(null,{status:204});
      const packet=JSON.parse(options.body);state.settingsProtocolCalls.push(packet.method);
      if(packet.id===undefined)return new Response(null,{status:202});
      let result;
      if(packet.method==='initialize')result={protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'Synthetic fixture server',version:'1'}};
      else if(packet.method==='tools/list')result={tools:Array.from({length:120},(_,i)=>({name:'fixture_tool_'+String(i).padStart(3,'0'),description:'Fixture tool '+i,inputSchema:{type:'object',properties:{}}}))};
      else throw Error('This settings fixture must never invoke a tool.');
      return new Response(JSON.stringify({jsonrpc:'2.0',id:packet.id,result}),{headers:{'Content-Type':'application/json'}});
    }}).init();
    return {directory,identity,providers,connections};
  })();
  function syncModels(providers){
    state.providers=providers.list();
    state.status.models=[...state.status.models.filter(model=>!String(model.id).includes('::')&&model.source!=='custom'),
      ...providers.listCodexModels().map(id=>({id,model:id,displayName:id,source:'custom',available:true})),
      ...state.providers.flatMap(provider=>provider.models.map(model=>({...model,id:provider.id+'::'+model.id,available:provider.configured&&provider.enabled})))];
    state.status.defaultModelSelection=providers.defaultModel||'default';
  }
  const codexCatalog=providers=>({connected:true,authenticated:true,models:[
    {id:'codex-test',model:'codex-test',displayName:'Test Codex',source:'advertised'},
    ...providers.listCodexModels().map(id=>({id,model:id,displayName:id,source:'custom'}))],customModels:providers.listCodexModels(),candidates:[]});
  return {
    stores,
    async handle(req,res,url){
      const route=url.pathname;
      if(!/^\/api\/(?:identity(?:\/|$)|providers(?:\/|$)|connections(?:\/|$)|codex\/models(?:\/|$)|models\/default$)/.test(route))return false;
      try{
        const {identity,providers,connections}=await stores();
        state.settingsPanelRequests.push(req.method+' '+route);
        let body={};if(req.method!=='GET'){let raw='';for await(const part of req)raw+=part;body=JSON.parse(raw||'{}');}
        if(req.method!=='GET')state.settingsPanelMutations.push({path:route,method:req.method,body:structuredClone(body)});
        const identityMatch=route.match(/^\/api\/identity\/(soul|user)(?:\/(versions|restore))?$/);
        if(route==='/api/identity'&&req.method==='GET'){json(res,await identity.readAll());return true;}
        if(identityMatch){
          const [,kind,action]=identityMatch;let result;
          if(req.method==='GET')result=action==='versions'?await identity.versions(kind):await identity.read(kind);
          else if(req.method==='PUT'&&!action)result=await identity.update({...body,kind,provenance:{source:'user'}});
          else if(req.method==='POST'&&action==='restore')result=await identity.restore({...body,kind,provenance:{source:'user'}});
          else throw Error('Unavailable identity fixture route.');
          if(req.method!=='GET')send({type:'identity.updated',data:identity.status()});
          json(res,result);return true;
        }
        if(route==='/api/models/default'&&req.method==='POST'){
          await providers.setDefaultModel(body.model);syncModels(providers);state.settingsMutations.push({path:route,body});json(res,state.status);return true;
        }
        if(route.startsWith('/api/codex/models')){
          if(req.method!=='GET'){
            if(route.endsWith('/check')){json(res,{...codexCatalog(providers),result:{model:body.model,status:'accepted',scope:'current-connection',checkedAt:new Date().toISOString()}});return true;}
            if(req.method==='POST')await providers.addCodexModel(body.model);else await providers.removeCodexModel(body.model);
            syncModels(providers);send({type:'runtime.status',data:state.status});
          }
          json(res,codexCatalog(providers));return true;
        }
        const providerMatch=route.match(/^\/api\/providers\/([^/]+)(?:\/(models|test))?$/);
        if(route==='/api/providers'){
          let result;if(req.method==='GET')result=providers.list();else result=await providers.save(body);
          syncModels(providers);json(res,result);return true;
        }
        if(providerMatch){
          const [,id,action]=providerMatch;
          if(req.method==='DELETE'){await providers.remove(id);syncModels(providers);json(res,{removed:true,id});return true;}
          if(action==='test'){json(res,{providerId:id,ok:true,credentialVerified:true,modelAccessVerified:false,modelCount:121,verification:'Synthetic catalog read'});return true;}
          const catalog=[{id:'model',displayName:'Fixture model',supportsTools:true},...Array.from({length:120},(_,i)=>({id:'catalog-model-'+i,displayName:'Catalog model '+i,supportsTools:true,contextWindowTokens:128000,contextWindowSource:'provider-reported'}))];
          const matching=catalog.filter(model=>!body.query||(model.id+' '+model.displayName).toLowerCase().includes(body.query.toLowerCase()));
          const offset=body.offset||0,limit=body.limit||80,models=matching.slice(offset,offset+limit);
          json(res,{providerId:id,models,total:matching.length,totalModels:catalog.length,offset,returned:models.length,hasMore:offset+models.length<matching.length,truncated:offset+models.length<matching.length});return true;
        }
        const connectionMatch=route.match(/^\/api\/connections\/([^/]+)(?:\/(connect|disconnect|tools))?$/);
        if(route==='/api/connections/import'&&req.method==='POST'){
          const parsed=parseConnectionImport(body.configuration,{existingIds:connections.list().map(item=>item.id),maxConnections:40});
          const imported=[];
          if(body.apply===true)for(const [index,config] of parsed.candidates.entries()){
            if(state.settingsImportFailureAt===index){
              state.settingsImportFailureAt=null;
              json(res,{error:imported.length+' of '+parsed.candidates.length+' servers were saved. Import stopped. Reload the server list before importing the remaining servers.',imported},409);return true;
            }
            imported.push(await connections.save(config));
          }
          await state.settingsImportGate?.(body,{imported,preview:parsed.preview});
          if(body.apply===true)send({type:'connections.updated',data:connections.status()});
          json(res,body.apply===true?{imported,warnings:parsed.warnings}:{preview:parsed.preview,warnings:parsed.warnings},body.apply===true?201:200);return true;
        }
        if(route==='/api/connections'){
          const result=req.method==='GET'?connections.list():await connections.save(body);
          if(req.method!=='GET')send({type:'connections.updated',data:connections.status()});json(res,result);return true;
        }
        if(connectionMatch){
          const [,id,action]=connectionMatch;let result;
          if(req.method==='DELETE')result=await connections.remove(id);
          else if(action==='tools')result=await connections.tools(id,{query:url.searchParams.get('query')||''});
          else if(action==='disconnect')result=await connections.disconnect(id);
          else if(action==='connect'){await connections.connect(id,body);result=connections.list().find(entry=>entry.id===id);}
          else throw Error('Unavailable connection fixture route.');
          send({type:'connections.updated',data:connections.status()});json(res,result);return true;
        }
        throw Error('Unavailable settings fixture route.');
      }catch(error){json(res,{error:error.message,code:error.code},error.status||400);return true;}
    },
    async close(){if(!ready)return;const {directory,identity,providers,connections}=await ready;await connections.close();await identity.close();await providers.writes;await rm(directory,{recursive:true,force:true});},
  };
}
