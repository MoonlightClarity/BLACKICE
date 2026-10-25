/** Headless, entirely synthetic UI fixture. This never opens the user's profile. */
import { createServer } from 'node:http';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { KnowledgeStore } from '../lib/knowledge.mjs';
import { createSettingsFixture } from './next-settings-fixture.mjs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const PUBLIC=fileURLToPath(new URL('../public/',import.meta.url));
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8',
  '.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.ttf':'font/ttf'};
const base=Date.parse('2026-10-24T10:00:00.000Z');
export function makeFixture({heavyHistory=false,largeCatalog=false,largeWorkflow=false,largeWorkflowCatalog=false,longTurn=false,nativeBrowser=false}={}){
  const runs=Array.from({length:50},(_,index)=>({
    id:'sample-run-'+index,taskId:'sample-run-0',parentRunId:index?'sample-run-'+(index-1):null,
    createdAt:new Date(base+index*60000).toISOString(),updatedAt:new Date(base+index*60000).toISOString(),
    input:index?'Follow-up question '+index:'Review the local workspace',
    status:index===49?'running':'completed',settled:index!==49,
    workflow:{id:'sample-workflow',name:'Example workflow',nodes:[{id:'agent',type:'agent',name:'BLACKICE agent',model:'default'}],edges:[]},
    nodes:{agent:{status:index===49?'running':'completed',threadId:'thread-'+index,output:index===49?'':'**Response '+index+'**\n\nA concise answer.'}},
    events:[{nodeId:'agent',at:new Date(base+index*60000).toISOString(),
      data:{type:'message',itemId:'reply-'+index,text:'**Response '+index+'**\n\nA concise answer.',phase:'final_answer'}}],
  }));
  if(longTurn){
    // Many assistant messages in one turn, not merely many turns in a family.
    // The Chat renderer must bound the number of DOM nodes per saved run.
    for(let i=0;i<350;i++)runs[49].events.push({
      nodeId:'agent',at:runs[49].updatedAt,
      data:{type:'message',itemId:'long-turn-'+i,text:'Extended saved message '+i},
    });
  }
  if(heavyHistory){
    // 30+ MiB of non-message tool receipts per family, representing real-world
    // archived task traces that must never be parsed on the UI thread.
    const payload='tool-output/'.repeat(350);
    for(const run of runs)for(let i=0;i<150;i++)run.events.push({
      nodeId:'agent',at:run.updatedAt,data:{type:'tool.result',receiptId:String(i),payload},
    });
  }
  runs[49].taskState={
    taskId:'sample-run-0',revision:3,goal:'Fixture deliverables',
    steps:[{id:'milestone-1',title:'Read source',status:'completed'},
      {id:'milestone-2',title:'Write summary',status:'running'}],
    artifacts:[{id:'artifact_11111111-1111-4111-8111-111111111111',
      title:'Fixture artifact',fileName:'fixture-report.txt',size:32,sha256:'fixture-sha256'}],
  };
  const visualPlan={taskId:'sample-run-0',revision:2,goal:'Review the local workspace',
    plan:{layout:'sequence'},currentStepId:'step-b',progress:{done:1,total:4,skipped:0,complete:false},
    steps:[{id:'step-a',title:'Read inputs',note:'Draft note',status:'done'},
      {id:'research',title:'Investigate in parallel',kind:'parallel',status:'active'},
      {id:'step-b',parentId:'research',title:'Trace the current behavior',status:'active',note:'Follow the saved evidence.'},
      {id:'step-c',parentId:'research',title:'Check dependencies',status:'pending',dependsOn:['step-a']},
      {id:'step-d',title:'Verify the result',status:'pending',dependsOn:['step-b','step-c']}],artifacts:[]};
  const summary={id:'sample-run-0',taskId:'sample-run-0',runId:'sample-run-49',
    latestRunId:'sample-run-49',title:'Review the local workspace',
    status:'running',updatedAt:new Date(base+50*60000).toISOString()};
  const catalog=largeCatalog?Array.from({length:12000},(_,i)=>({
    id:'catalog-'+i,taskId:'catalog-'+i,runId:'catalog-'+i,
    title:i===9012?'Deep search needle saved conversation':'Saved conversation '+i,
    originalTask:i===9012?'needle details':'Ordinary saved work',
    status:'completed',updatedAt:new Date(base-i*60000).toISOString(),
  })):[];
  const calls=[],subscribers=new Set();
  const state={
    status:{version:'fixture',connected:true,authenticated:true,cwd:'C:\\fixture',
      defaultModel:'fixture::model',defaultModelSelection:'fixture::model',defaultModelAvailable:true,
      models:[{id:'fixture::model',displayName:'Fixture model',available:true},
        {id:'codex-test',providerId:'codex',displayName:'Test Codex',available:true,
        supportedReasoningEfforts:['medium','high'],serviceTiers:['priority']}],
      execution:{activeCount:1}},
    conversations:[summary,...catalog],runs,visualPlan,jobs:[],deployments:[],attachments:[],browserActions:[],
    taskHistoryStates:{},taskLifecycleMutations:[],workflowDeletes:[],
    runtimeSettings:{defaultEffort:'medium',defaultServiceTier:'default',verbosity:'balanced',
      providerIdleTimeoutMs:300000,runTimeoutMs:null,subagentsEnabled:false,maxSubagents:3},
    executionSettings:{maxConcurrentRuns:null},
    providers:[{id:'codex',displayName:'Codex',connected:true}],
    settingsMutations:[],postedWorkflows:[],submittedRuns:[],knowledgeMutations:[],
    workflowIndexRequests:0,workflowFullListRequests:0,workflowDetailRequests:[],scheduledWrites:[],
    workflows:[{id:'sample-workflow',name:'Example workflow',nodes:[{id:'input',type:'input'},{id:'agent',type:'agent',name:'Agent',model:'default',prompt:'Review saved fixture evidence.'},{id:'output',type:'output'}],
      edges:[{source:'input',target:'agent'},{source:'agent',target:'output'}],settings:{cwd:'C:\\fixture'}}],
    tabs:[{browser:'relay',tabId:'fixture-tab',title:'Fixture page',url:'https://example.test/',documentId:'fixture-tab:1',visible:false,
      ...(nativeBrowser?{nativeSurface:true,canGoBack:true,canGoForward:true}:{})}],
    activeBrowserTab:'fixture-tab',downloads:[],browserStatusGate:null,browserActionGate:null,
  };
  const knowledgeReady=(async()=>{
    const directory=await mkdtemp(path.join(tmpdir(),'blackice-next-knowledge-fixture-'));
    const at=new Date(base).toISOString();
    const entry=(id,kind,title,content,extra={})=>({id,kind,title,summary:'Fixture saved knowledge',content,cwd:null,
      revision:1,createdAt:at,updatedAt:at,action:'create',provenance:{source:'user',at},
      ...(kind==='memory'?{memoryType:'note',sources:[],relations:[]}:{}),...extra});
    const entries=[entry('memory-fixture','memory','Saved fixture memory','Original memory content',
      {memoryType:'fact',sources:['https://example.test/evidence'],relations:[{type:'supports',targetId:'memory-related'}]}),
      entry('memory-related','memory','Related fixture note','Related evidence'),
      entry('skill-fixture','skill','Saved fixture skill','First step\nSecond step'),
      ...Array.from({length:100},(_,i)=>entry('memory-catalog-'+i,'memory','Library note '+i,
        i===99?'Deep body needle for server search':'Saved note '+i))];
    await writeFile(path.join(directory,'knowledge.json'),JSON.stringify({version:1,entries}));
    const store=await new KnowledgeStore({dataDir:directory}).init();
    return {store,directory};
  })();
  if(largeWorkflow){
    const nodes=Array.from({length:1500},(_,i)=>({
      id:'stage-'+i,name:'Stage '+i,type:i===0?'input':i===1499?'output':'agent',
      ...(i===0||i===1499?{}:{model:'default',prompt:'Investigate.'})
    }));
    const edges=Array.from({length:1499},(_,i)=>({id:'edge-'+i,source:'stage-'+i,target:'stage-'+(i+1)}));
    state.workflows.push({id:'large-fixture-graph',name:'Large performance graph',nodes,edges,settings:{cwd:'C:\\fixture'}});
    state.largeRun={...state.runs[49],id:'large-inspection-run',taskId:'large-inspection-run',
      parentRunId:null,workflow:state.workflows.at(-1),nodes:{},events:[],taskState:null,
      input:'Inspect 1,500 workflow stage statuses',status:'running',settled:false};
  }
  if(largeWorkflowCatalog){
    const catalog=Array.from({length:5000},(_,i)=>({
      id:'workflow-catalog-'+i,
      name:i===4599?'Needle saved workflow 4599':'Saved workflow '+i,
      description:'Fixture metadata',
      nodes:[{id:'input',type:'input',name:'Input'},{id:'output',type:'output',name:'Output'}],
      edges:[{source:'input',target:'output'}],settings:{cwd:'C:\\fixture'},
    }));
    state.workflows.push(...catalog);
  }
  const json=(res,value,status=200)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
  const settingsFixture=createSettingsFixture({state,json,send:event=>{for(const stream of subscribers)stream.write('data: '+JSON.stringify(event)+'\n\n');}});
  const handler=async(req,res)=>{
    const url=new URL(req.url,'http://localhost');const pathname=url.pathname;
    calls.push(req.method+' '+pathname);
    if(await settingsFixture.handle(req,res,url))return;
    if(pathname==='/api/knowledge'||pathname.startsWith('/api/knowledge/')){
      try{
        const {store}=await knowledgeReady;
        const sendChanged=()=>{for(const stream of subscribers)stream.write('data: '+JSON.stringify({type:'knowledge.updated',data:store.status()})+'\n\n');};
        const match=pathname.match(/^\/api\/knowledge\/([A-Za-z0-9_-]+)(?:\/(history|restore))?$/);
        if(req.method==='GET'){
          if(match)return json(res,match[2]==='history'?store.history(match[1]):store.get(match[1]));
          const q=url.searchParams,query={};
          for(const name of ['kind','memoryType','query','cwd'])if(q.has(name))query[name]=q.get(name);
          if(q.has('limit'))query.limit=Number(q.get('limit'));
          for(const name of ['includeDeleted','deletedOnly'])if(q.has(name))query[name]=q.get(name)==='true';
          return json(res,store.list(query));
        }
        let raw='';for await(const part of req)raw+=part;
        const value=JSON.parse(raw||'{}');let saved;
        if(req.method==='POST'&&!match)saved=await store.upsert(value,{source:'user'});
        else if(req.method==='DELETE'&&match)saved=await store.remove(match[1],{expectedRevision:value.expectedRevision});
        else if(req.method==='POST'&&match?.[2]==='restore')saved=await store.restore(match[1],value.revision,{source:'user'},{expectedRevision:value.expectedRevision});
        else return json(res,{error:'Unavailable knowledge fixture operation'},404);
        state.knowledgeMutations.push({path:pathname,method:req.method,body:value});sendChanged();return json(res,saved);
      }catch(error){return json(res,{error:error.message},error.status||400);}
    }
    if(pathname==='/api/events'){res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive'});res.write('data: '+JSON.stringify({type:'runtime.status',data:state.status})+'\n\n');subscribers.add(res);res.on('close',()=>subscribers.delete(res));return;}
    if(pathname==='/api/status')return json(res,state.status);
    if(pathname==='/api/runtime/settings'&&req.method==='GET')return json(res,state.runtimeSettings);
    if(pathname==='/api/execution/settings'&&req.method==='GET')return json(res,state.executionSettings);
    if(pathname==='/api/providers'&&req.method==='GET')return json(res,state.providers);
    if(pathname==='/api/tasks/sample-run-0/artifacts/artifact_11111111-1111-4111-8111-111111111111/preview')
      return json(res,{artifact:{id:'artifact_11111111-1111-4111-8111-111111111111',
        title:'Fixture artifact',fileName:'fixture-report.txt',size:32,sha256:'fixture-sha256'},
        previewKind:'text',content:'Fixture saved artifact body.'});
    if(pathname==='/api/attachments'&&req.method==='GET')return json(res,state.attachments);
    if(pathname==='/api/conversations/search'&&req.method==='GET'){
      const q=url.searchParams.get('q')||'',bucket=url.searchParams.get('state')||'all',offset=Number(url.searchParams.get('offset')||0),limit=Number(url.searchParams.get('limit')||40);
      const matches=state.conversations.map(item=>({...item,rootId:item.taskId||item.rootId||item.id,
        taskId:item.taskId||item.rootId||item.id,state:state.taskHistoryStates[item.taskId||item.rootId||item.id]||item.state||'active',settled:item.settled??!['queued','running','waiting'].includes(item.status)}))
        .filter(item=>(bucket==='all'?item.state!=='deleted':item.state===bucket)&&[item.title,item.originalTask].some(value=>String(value||'').toLowerCase().includes(q.toLowerCase())));
      return json(res,{query:q,state:bucket,total:matches.length,offset,limit,hasMore:offset+limit<matches.length,
        conversations:matches.slice(offset,offset+limit).map(item=>({...item,match:{kind:'title',runId:item.runId||item.id,text:item.title||''}}))});
    }
    if(pathname==='/api/conversations')return json(res,{conversations:url.searchParams.get('state')==='active'?state.conversations:[]});
    if(pathname==='/api/conversations/sample-run-49'||pathname==='/api/conversations/sample-run-0')return json(res,{runs:state.runs});
    if(pathname==='/api/conversations/large-inspection-run'&&state.largeRun)return json(res,{runs:[state.largeRun]});
    if(/^\/api\/conversations\/catalog-\d+$/.test(pathname))return json(res,{runs:[]});
    if(pathname==='/api/workflows'&&req.method==='GET'){
      if(url.searchParams.get('view')==='index'){
        state.workflowIndexRequests++;
        return json(res,state.workflows.map(item=>({
          id:item.id,name:item.name,description:String(item.description||'').slice(0,256),
          updatedAt:item.updatedAt||null,nodeCount:item.nodes?.length||0,edgeCount:item.edges?.length||0,
        })));
      }
      state.workflowFullListRequests++;
      return json(res,state.workflows);
    }
    if(/^\/api\/workflows\/[A-Za-z0-9_-]+$/.test(pathname)&&req.method==='GET'){
      const id=pathname.split('/').pop();
      state.workflowDetailRequests.push(id);
      const saved=state.workflows.find(item=>item.id===id);
      return saved?json(res,saved):json(res,{error:'Workflow not found.'},404);
    }
    if(/^\/api\/workflows\/[A-Za-z0-9_-]+$/.test(pathname)&&req.method==='DELETE'){
      let raw='';for await(const part of req)raw+=part;
      const id=pathname.split('/').pop();if(!state.workflows.some(item=>item.id===id))return json(res,{error:'Workflow not found.'},404);
      state.workflows=state.workflows.filter(item=>item.id!==id);state.workflowDeletes.push(id);return json(res,{ok:true});
    }
    if(pathname==='/api/planning')return json(res,{plans:[{taskId:'sample-run-0',runId:'sample-run-49',title:'Example plan',goal:state.visualPlan.goal,revision:state.visualPlan.revision,bucket:'active',runStatus:'running',editable:true,stepCount:state.visualPlan.steps.length,progress:state.visualPlan.progress}],total:1,hasMore:false,nextOffset:null});
    if(pathname==='/api/tasks/sample-run-0'&&req.method==='GET')return json(res,state.visualPlan);
    if(pathname==='/api/projects')return json(res,{projects:[{id:'project-a',name:'Example project',status:'ready',tasks:[]}],total:1});
    if(pathname==='/api/operations')return json(res,{status:{healthy:true,paused:false,enabled:1,running:0},deployments:state.deployments,jobs:state.jobs});
    if(pathname==='/api/browser/status'){
      const snapshot=structuredClone({available:true,browsers:{relay:{available:true}},tabs:state.tabs,downloads:state.downloads,activeTab:state.activeBrowserTab});
      // Optional fixture hooks hold a captured response without blocking newer requests.
      await state.browserStatusGate?.(snapshot);
      return json(res,snapshot);
    }
    if(pathname==='/api/runs'&&req.method==='GET')return json(res,{error:'The replacement must never bulk-load execution traces at startup.'},503);
    if(pathname==='/api/runs/new-sample-run'&&req.method==='GET')return json(res,state.runs.find(x=>x.id==='new-sample-run')||{error:'No run yet.'});
    if(req.method==='POST'||req.method==='PUT'){
      let raw='';for await(const part of req)raw+=part;
      let body={};try{body=JSON.parse(raw);}catch{}
      if(pathname==='/api/tasks/sample-run-0/plan/edit'){
        if(body.expectedRevision!==state.visualPlan.revision)return json(res,{error:'The plan changed. Reload it before saving.'},409);
        for(const op of body.operations||[]){
          if(op.type==='metadata')Object.assign(state.visualPlan,op.patch);
          if(op.type==='update')Object.assign(state.visualPlan.steps.find(step=>step.id===op.stepId)||{},op.patch);
        }
        state.visualPlan.revision++;return json(res,state.visualPlan);
      }
      const taskLifecycle=pathname.match(/^\/api\/conversations\/([A-Za-z0-9_-]+)\/(archive|delete|restore)$/);
      if(taskLifecycle){
        const [,id,action]=taskLifecycle,task=state.conversations.find(item=>(item.taskId||item.rootId||item.id)===id);
        if(!task)return json(res,{error:'Task not found.'},404);
        if(action==='delete'&&(['queued','running','waiting'].includes(task.status)||task.settled===false))return json(res,{error:'Wait for the conversation to finish stopping before moving it to Trash.'},409);
        const bucket={archive:'archived',delete:'deleted',restore:'active'}[action];state.taskHistoryStates[id]=bucket;
        state.taskLifecycleMutations.push({id,action,body});
        for(const stream of subscribers)stream.write('data: '+JSON.stringify({type:'conversations.updated',data:{healthy:true}})+'\n\n');
        return json(res,{rootId:id,state:bucket});
      }
      if(pathname==='/api/attachments/upload'){
        const attachment={id:'file_fixture_'+(state.attachments.length+1),name:body.name||'file',
          size:Math.floor(String(body.dataBase64||'').length*3/4),mime:'text/plain',sha256:'fixture'};
        state.attachments.push(attachment);return json(res,attachment,201);
      }
      if(pathname==='/api/runtime/settings'){
        Object.assign(state.runtimeSettings,body);state.settingsMutations.push({path:pathname,body});
        return json(res,state.runtimeSettings);
      }
      if(pathname==='/api/execution/settings'){
        Object.assign(state.executionSettings,body);state.settingsMutations.push({path:pathname,body});
        return json(res,state.executionSettings);
      }
      if(pathname==='/api/workflows'){state.postedWorkflows.push(body);state.workflows=state.workflows.filter(item=>item.id!==body.id);state.workflows.unshift(body);return json(res,body);}
      if(pathname==='/api/runs'){
        state.submittedRuns.push(body);
        const run={...state.runs[49],id:'new-sample-run',taskId:'new-sample-run',parentRunId:null,
          input:body.input.task,status:'running',settled:false,events:[]};
        state.conversations.unshift({id:run.id,runId:run.id,title:body.input.task,status:'running',updatedAt:new Date().toISOString()});
        state.runs.unshift(run);
        return json(res,run,201);
      }
      if(pathname.endsWith('/steer'))return json(res,{accepted:true,delivery:'delivered'});
      if(pathname.endsWith('/continue'))return json(res,{...state.runs[49],id:'continued-run',input:body.message},201);
      if(pathname.endsWith('/cancel'))return json(res,{ok:true});
      if(pathname.includes('/plan/edit'))return json(res,{taskId:'sample-run-0',revision:3,goal:'Changed goal',steps:[]});
      if(pathname==='/api/browser/action'){
        state.browserActions.push(body);
        {
          const respond=async value=>{const snapshot=structuredClone(value);await state.browserActionGate?.(body,snapshot);return json(res,snapshot);};
          if(body.action==='downloads')return respond({downloads:state.downloads});
          if(body.action==='open'){
            const tab={browser:'relay',tabId:'fixture-new-'+state.browserActions.length,title:body.url==='about:blank'?'New tab':'New website',url:body.url,documentId:'new:1',visible:false,...(nativeBrowser?{nativeSurface:true}:{}),canGoBack:body.url!=='about:blank',canGoForward:false};
            state.tabs.push(tab);state.activeBrowserTab=tab.tabId;return respond(tab);
          }
          if(body.action==='close'){
            state.tabs=state.tabs.filter(tab=>tab.tabId!==body.tabId);
            if(state.activeBrowserTab===body.tabId)state.activeBrowserTab=state.tabs[0]?.tabId||null;
            return respond({tabs:state.tabs,activeTab:state.activeBrowserTab});
          }
          const tab=state.tabs.find(tab=>tab.tabId===body.tabId);
          if(body.action==='tab_select'){state.activeBrowserTab=body.tabId;return respond({tabs:state.tabs,activeTab:state.activeBrowserTab});}
          if(body.action==='navigate'&&tab){tab.url=body.url;tab.documentId+=':next';tab.canGoBack=true;}
          if(nativeBrowser)return respond({...tab,ok:true});
        }
        const tab=state.tabs.find(tab=>tab.tabId===body.tabId)||state.tabs[0];
        const identity={tabId:tab?.tabId,url:tab?.url,documentId:tab?.documentId};
        if(body.action==='screenshot')return json(res,{...identity,
          ...(tab?.pendingInteraction?{pendingInteraction:tab.pendingInteraction}:{}),
          width:1280,height:900,
          imageUrl:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+npKcAAAAASUVORK5CYII='});
        if(body.action==='read')return json(res,{...identity,frames:[{
          title:'Fixture',url:tab?.url,text:'Fixture browser content'}]});
        if(['interaction','upload'].includes(body.action)&&tab)tab.pendingInteraction=null;
        return json(res,{...identity,ok:true});
      }
      if(pathname==='/api/operations/pause'||pathname==='/api/operations/resume')return json(res,{ok:true});
      if(pathname==='/api/operations/deployments'){state.scheduledWrites.push(body);return json(res,{ok:true},201);}
      if(pathname==='/api/models/default')return json(res,state.status);
      return json(res,{ok:true});
    }
    if(pathname.startsWith('/api/'))return json(res,{error:'Unavailable fixture endpoint'},404);
    const file=pathname==='/'||pathname==='/next'||pathname==='/next/'?'next/index.html':pathname.replace(/^\/+/,'');
    if(file.includes('..')||!/\.(html|css|js|mjs|svg|png|ttf)$/.test(file))return json(res,{error:'File unavailable'},404);
    try{const content=await readFile(path.join(PUBLIC,file));res.writeHead(200,{'Content-Type':mime[path.extname(file)]||'image/png','Cache-Control':'no-store'});res.end(content);}
    catch{return json(res,{error:'Static file unavailable'},404);}
  };
  return {server:createServer(handler),state,calls,knowledge:async()=>(await knowledgeReady).store,settings:settingsFixture.stores,
    async closeKnowledge(){const {store,directory}=await knowledgeReady;await store.writeChain;await settingsFixture.close();await rm(directory,{recursive:true,force:true});},
    send(event){for(const res of subscribers)res.write('data: '+JSON.stringify(event)+'\n\n');}};
}
