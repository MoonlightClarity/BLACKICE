import {EventEmitter} from 'node:events';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {TOKEN_USAGE_FIELDS} from '../public/token-usage.mjs';
import {createHash,randomUUID} from 'node:crypto';
import {renameWithRetry} from './coalescing-persistence.mjs';
import {validatePlanningReadableFindings} from '../public/task-viability-model.mjs';
import {planningExecutionModeOf} from '../public/response-cycle-model.mjs';
import {
  PLANNING_BROWSER_VERSION,PLANNING_BROWSER_LIMITS,PLANNING_LINK_KINDS,
  planningBrowserError,planningModuleTemplate,parseModuleResponse,
  projectPlanningRequest,planningRequestSources,planningNodeSources,planningResponseBody,planningCycleStageContext
} from '../public/planning-browser-model.mjs';

const fail=planningBrowserError;
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const copy=value=>structuredClone(value);
const own=(value,key)=>Object.hasOwn(value,key);
const keys=(value,allowed,label)=>{if(!object(value)||Object.keys(value).some(key=>!allowed.includes(key)))throw fail(label+' contains unsupported fields.');};
const id=(value,label='ID')=>{if(typeof value!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(value))throw fail(label+' must be a stable identifier.');return value;};
const text=(value,label,max,required=false)=>{if(typeof value!=='string'||value.includes('\0')||value.length>max||required&&!value.trim())throw fail(label+' must be '+(required?'nonempty ':'')+'text of at most '+max+' characters.');return value.trim();};
const canonical=value=>JSON.stringify(value,(_key,item)=>object(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
const hash=value=>createHash('sha256').update(typeof value==='string'?value:canonical(value)).digest('hex');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const latest=(request,nodeId)=>request.responses.filter(item=>item.nodeId===nodeId).sort((a,b)=>b.revision-a.revision)[0]||null;
const author=value=>typeof value==='string'?text(value,'Actor',240,true):value===undefined?'user':object(value)?text(String(value.id||value.source||value.kind||'user'),'Actor',240,true):(()=>{throw fail('Invalid author.');})();
async function atomic(file,value){
  const temporary=file+'.'+randomUUID()+'.tmp';
  try{const handle=await fs.open(temporary,'wx',0o600);try{await handle.writeFile(value);await handle.sync();}finally{await handle.close();}await renameWithRetry(temporary,file);}
  finally{await fs.rm(temporary,{force:true}).catch(()=>{});}
}
function metadata(value={},required=false){
  keys(value,['runId','executionNodeId','threadId','turnId','itemId','model','provider','usage','capabilities','errorCode'],'Runtime metadata');
  const result={};
  for(const key of ['runId','executionNodeId','threadId','turnId','itemId','model','provider'])
    if(value[key]!==undefined&&value[key]!==null)result[key]=text(value[key],key,500,required&&['runId','executionNodeId'].includes(key));
  if(required&&(!result.runId||!result.executionNodeId))throw fail('Runtime responses need actual run and execution-node identifiers.','PLANNING_RUNTIME_PROVENANCE');
  if(value.errorCode!==undefined){
    if(typeof value.errorCode!=='string'||!/^[a-zA-Z0-9_.:-]{1,100}$/.test(value.errorCode))throw fail('Invalid runtime error code.');
    result.errorCode=value.errorCode;
  }
  if(value.capabilities!==undefined){
    const capability=value.capabilities;keys(capability,['profile','native','attachedTools','ambientGmail','ambientPlugins','ambientMcp','ambientSkills','structuredOutput','structuredOutputReason','structuredOutputTransport','hostValidationRequired'],'Response capabilities');
    if(capability.profile!=='planning-response')throw fail('Unknown response capability profile.');
    for(const key of ['native','ambientGmail','ambientPlugins','ambientMcp','ambientSkills','hostValidationRequired'])if(capability[key]!==undefined&&typeof capability[key]!=='boolean')throw fail('Invalid response capability flag.');
    if(capability.attachedTools!==undefined&&(!Number.isSafeInteger(capability.attachedTools)||capability.attachedTools<0||capability.attachedTools>100))throw fail('Invalid attached tool count.');
    for(const key of ['structuredOutput','structuredOutputReason','structuredOutputTransport'])if(capability[key]!==undefined)text(capability[key],key,800);
    result.capabilities=copy(capability);
  }
  if(value.usage!==undefined){
    const sanitize=(item,depth=0,scope='')=>{
      if(depth>4)throw fail('Usage metadata is too deeply nested.');
      if(item===null)return null;
      if(typeof item==='number'&&Number.isFinite(item)&&item>=0)return item;
      if(object(item))return Object.fromEntries(Object.entries(item).map(([key,entry])=>{
        if(!/^[A-Za-z0-9_-]{1,80}$/.test(key))throw fail('Invalid usage field.');
        const measurement=depth===0||depth===1&&['total','last'].includes(scope);
        if(measurement&&key==='availability'){
          keys(entry,TOKEN_USAGE_FIELDS,'Usage availability');
          if(Object.values(entry).some(value=>!['reported','partial','unavailable'].includes(value)))throw fail('Invalid usage availability.');
          return [key,copy(entry)];
        }
        if(measurement&&key==='samples'&&(!Number.isSafeInteger(entry)||entry<0))throw fail('Invalid usage sample count.');
        return [key,sanitize(entry,depth+1,key)];
      }));
      throw fail('Usage metadata contains unsupported values.');
    };    result.usage=sanitize(value.usage);
    if(JSON.stringify(result.usage).length>6000)throw fail('Usage metadata exceeds its bound.');
  }
  return result;
}
function externalReceipt(value){
  keys(value,['jobId','connectionId','requestId','tool'],'External response receipt');
  return Object.fromEntries(['jobId','connectionId','requestId','tool'].map(key=>[key,text(value[key],key,300,true)]));
}
function evidenceSources(values=[]){
  if(!Array.isArray(values)||values.length>100)throw fail('Use at most 100 actual evidence records.');
  const seen=new Set();
  return values.map(value=>{
    keys(value,['id','kind','label','title','contentHash','text','url'],'Runtime evidence');
    const sourceId=text(value.id,'Evidence ID',300,true);
    if(seen.has(sourceId))throw fail('Evidence IDs must be unique.');seen.add(sourceId);
    if(!['tool_receipt','artifact','user_input','source'].includes(value.kind))throw fail('Unknown runtime evidence kind.');
    if(value.contentHash!==undefined&&!/^[a-f0-9]{64}$/.test(value.contentHash))throw fail('Invalid evidence hash.');
    const body=value.text===undefined?'':text(value.text,'Evidence public text',PLANNING_BROWSER_LIMITS.sourceChars);
    return {id:sourceId,kind:value.kind,title:text(value.label||value.title||sourceId,'Evidence title',240,true),text:body,
      ...(value.url===undefined?{}:{url:text(value.url,'Evidence URL',2000)}),
      contentHash:value.contentHash||hash(body),provenance:{kind:'runtime_evidence'},verified:false};
  });
}

/** Durable public response graphs. Runtime writes require an in-process capability. */
export class PlanningBrowserStore extends EventEmitter {
  #runtimeToken=Object.freeze({});
  #externalToken=Object.freeze({});
  constructor({dataDir,knowledge=null,clock=()=>Date.now()}={}){
    super();if(typeof dataDir!=='string'||!path.isAbsolute(dataDir))throw fail('Use an absolute planning data directory.');
    this.directory=path.join(dataDir,'planning-browser');this.requestDirectory=path.join(this.directory,'requests');this.lockDirectory=path.join(this.directory,'locks');
    this.knowledge=knowledge;this.clock=clock;this.queues=new Map();this.ready=null;this.closed=false;
  }
  init(){return this.ready||=(async()=>{await fs.mkdir(this.requestDirectory,{recursive:true});await fs.mkdir(this.lockDirectory,{recursive:true});return this;})();}
  stamp(){const value=this.clock(),date=new Date(value);if(!Number.isFinite(date.getTime()))throw fail('Invalid planning clock.');return date.toISOString();}
  file(requestId){return path.join(this.requestDirectory,id(requestId,'Request ID')+'.json');}
  async _lock(key,work){
    const file=path.join(this.lockDirectory,key+'.lock'),token=randomUUID(),deadline=Date.now()+3000;
    for(;;){
      try{const handle=await fs.open(file,'wx',0o600);try{await handle.writeFile(JSON.stringify({pid:process.pid,token}));}finally{await handle.close();}break;}
      catch(error){
        if(error.code!=='EEXIST')throw error;
        try{
          const raw=await fs.readFile(file,'utf8'),owner=JSON.parse(raw);let alive=true;
          if(Number.isSafeInteger(owner.pid)&&owner.pid>0){try{process.kill(owner.pid,0);}catch(cause){alive=cause.code==='EPERM';}}
          if(!alive&&await fs.readFile(file,'utf8')===raw){await fs.unlink(file);continue;}
        }catch{}
        if(Date.now()>=deadline)throw fail('Planning data is being changed elsewhere. Retry with current revisions.','PLANNING_BROWSER_BUSY',409);
        await delay(20);
      }
    }
    try{return await work();}
    finally{try{const owner=JSON.parse(await fs.readFile(file,'utf8'));if(owner.token===token)await fs.unlink(file);}catch{}}
  }
  _enqueue(key,work){
    if(this.closed)return Promise.reject(fail('Planning browser is closed.','PLANNING_BROWSER_CLOSED',503));
    const previous=this.queues.get(key)||Promise.resolve();
    const pending=previous.catch(()=>{}).then(()=>this._lock(key,work));
    this.queues.set(key,pending);pending.finally(()=>{if(this.queues.get(key)===pending)this.queues.delete(key);}).catch(()=>{});
    return pending;
  }
  async _load(requestId){
    await this.init();let data;
    try{const file=this.file(requestId),info=await fs.stat(file);if(info.size>PLANNING_BROWSER_LIMITS.bytes)throw fail('Planning request exceeds its storage bound.');data=JSON.parse(await fs.readFile(file,'utf8'));}
    catch(error){if(error.code==='ENOENT')throw fail('Planning request not found.','PLANNING_REQUEST_NOT_FOUND',404);if(error.code?.startsWith('PLANNING'))throw error;throw fail('Planning request data is unreadable. Its saved bytes were preserved.','PLANNING_BROWSER_DAMAGED',500);}
    try{this._validate(data,requestId);}catch(error){throw Object.assign(fail('Planning request data is invalid. Its saved bytes were preserved.','PLANNING_BROWSER_DAMAGED',500),{causeCode:error.code});}return data;
  }
  _validate(request,requestId=request.id){
    if(!object(request)||request.version!==PLANNING_BROWSER_VERSION||request.id!==requestId||!Number.isSafeInteger(request.revision)||request.revision<1)throw fail('Invalid saved planning request.','PLANNING_BROWSER_DAMAGED',500);
    id(request.id);id(request.conversationId,'Conversation ID');
    if(request.provenance!==undefined){keys(request.provenance,['kind','author','at'],'Request provenance');if(!['human','external_agent','unrecorded'].includes(request.provenance.kind))throw fail('Invalid saved request authorship.');text(request.provenance.author,'Request author',240,true);if(!Number.isFinite(Date.parse(request.provenance.at)))throw fail('Invalid saved request authorship date.');}
    for(const field of ['nodes','edges','responses','assignments','attempts','sources','history'])if(!Array.isArray(request[field]))throw fail('Invalid saved '+field+'.','PLANNING_BROWSER_DAMAGED',500);
    const nodeIds=new Set();
    for(const node of request.nodes){id(node.id);if(nodeIds.has(node.id)||!Number.isSafeInteger(node.revision)||node.revision<1)throw fail('Invalid module identity or revision.');nodeIds.add(node.id);planningModuleTemplate(node.kind);if(own(node,'status')||own(node,'done')||own(node,'response')||own(node,'provenance'))throw fail('Module completion and provenance are derived, not writable.');}
    for(const node of request.nodes){
      let cursor=node,depth=0;const visited=new Set();
      while(cursor){if(visited.has(cursor.id))throw fail('Module containment cannot cycle.','PLANNING_CONTAINMENT_CYCLE');visited.add(cursor.id);if(++depth>PLANNING_BROWSER_LIMITS.depth)throw fail('Module containment exceeds its depth bound.');if(cursor.parentId&&!nodeIds.has(cursor.parentId))throw fail('A parent module is missing.');cursor=cursor.parentId?request.nodes.find(item=>item.id===cursor.parentId):null;}
    }
    const edgeIds=new Set();
    for(const edge of request.edges){
      id(edge.id,'Edge ID');if(edgeIds.has(edge.id))throw fail('Duplicate edge ID.');edgeIds.add(edge.id);
      if(!PLANNING_LINK_KINDS.includes(edge.kind)||!nodeIds.has(edge.from)||edge.kind!=='knowledge'&&!nodeIds.has(edge.to))throw fail('A graph relationship has an invalid endpoint.');
      if(edge.from===edge.to&&edge.kind!=='knowledge')throw fail('A module cannot link to itself.');
    }
    // Branch readiness requires its own response and descendant branches. A
    // consumes edge waits only for a response; a dependency waits for a branch.
    const waits=new Map();
    for(const node of request.nodes){waits.set('response:'+node.id,[]);waits.set('branch:'+node.id,['response:'+node.id]);}
    for(const node of request.nodes)if(node.parentId)waits.get('branch:'+node.parentId).push('branch:'+node.id);
    for(const edge of request.edges){
      if(edge.kind==='depends_on')waits.get('response:'+edge.from).push('branch:'+edge.to);
      if(edge.kind==='consumes'&&edge.freshness!=='pinned')waits.get('response:'+edge.from).push('response:'+edge.to);
    }
    const done=new Set(),active=new Set();
    const visit=key=>{if(active.has(key))throw fail('Containment and execution dependencies cannot form a waiting cycle.','PLANNING_DEPENDENCY_CYCLE');if(done.has(key))return;active.add(key);for(const other of waits.get(key)||[])visit(other);active.delete(key);done.add(key);};
    for(const key of waits.keys())visit(key);
    // Pinned history removes a wait, not the declared dependency's direction.
    const dependencyEdges=new Map(request.nodes.map(node=>[node.id,[]]));
    for(const edge of request.edges)if(['depends_on','consumes'].includes(edge.kind))dependencyEdges.get(edge.from).push(edge.to);
    const checked=new Set(),checking=new Set();
    const checkDependency=nodeId=>{if(checking.has(nodeId))throw fail('Declared dependencies must remain acyclic.','PLANNING_DEPENDENCY_CYCLE');if(checked.has(nodeId))return;checking.add(nodeId);for(const target of dependencyEdges.get(nodeId))checkDependency(target);checking.delete(nodeId);checked.add(nodeId);};
    for(const node of request.nodes)checkDependency(node.id);
    const responseIds=new Set(),responseRevisions=new Set();
    for(const response of request.responses){
      id(response.id,'Response ID');
      if(responseIds.has(response.id)||!nodeIds.has(response.nodeId)||!Number.isSafeInteger(response.revision)||response.revision<1||!Number.isSafeInteger(response.nodeRevision)||response.nodeRevision<1||responseRevisions.has(response.nodeId+':'+response.revision))throw fail('Invalid saved response identity.');
      responseIds.add(response.id);responseRevisions.add(response.nodeId+':'+response.revision);
      parseModuleResponse(planningResponseBody(response),response.kind);
      if(!Array.isArray(response.inputs)||!Array.isArray(response.sources)||response.verifiedAction!==false||!object(response.provenance)||!['human','external_agent','supervising_model','runtime'].includes(response.provenance.kind)||!/^[a-f0-9]{64}$/.test(response.provenance.contentHash||''))throw fail('Invalid saved response provenance.');
      if(response.provenance.kind==='supervising_model'&&(response.provenance.origin!=='engine-control'||typeof response.provenance.author!=='string'||!response.provenance.author))throw fail('Supervising edits need their actual host actor.');
      if(response.provenance.kind==='runtime'){
        const attempt=request.attempts.find(item=>item.id===response.provenance.attemptId);
        if(!attempt||attempt.status!=='completed'||attempt.responseId!==response.id||attempt.nodeId!==response.nodeId||attempt.outputHash!==response.provenance.contentHash||hash(attempt.output)!==attempt.outputHash)throw fail('Runtime response is not backed by its saved public output.');
        metadata(attempt.metadata,true);
      }
      if(response.provenance.kind==='external_agent')externalReceipt(response.provenance.receipt);
    }
    const attemptIds=new Set();
    for(const attempt of request.attempts){
      id(attempt.id,'Attempt ID');id(attempt.ownerId,'Owner ID');
      if(attemptIds.has(attempt.id)||attempt.requestId!==request.id||!nodeIds.has(attempt.nodeId)||!['running','completed','failed','cancelled'].includes(attempt.status)||!Number.isSafeInteger(attempt.nodeRevision)||attempt.nodeRevision<1||!Array.isArray(attempt.inputs)||!Array.isArray(attempt.sources))throw fail('Invalid saved response attempt.');
      attemptIds.add(attempt.id);
      if(attempt.status==='completed'&&!responseIds.has(attempt.responseId))throw fail('A completed attempt lacks an actual response record.');
    }
    for(const assignment of request.assignments)if(!nodeIds.has(assignment.nodeId)||!['node','subtree'].includes(assignment.scope))throw fail('Invalid saved module assignment.');
    for(const [field,limit]of [['nodes',PLANNING_BROWSER_LIMITS.nodes],['edges',PLANNING_BROWSER_LIMITS.edges],['responses',PLANNING_BROWSER_LIMITS.responses],['attempts',PLANNING_BROWSER_LIMITS.attempts],['sources',PLANNING_BROWSER_LIMITS.sources]])if(request[field].length>limit)throw fail('Planning '+field+' exceed the storage bound.','PLANNING_BROWSER_CAPACITY',507);
  }
  _public(request){const raw=copy(request);delete raw.idempotency;delete raw.createFingerprint;return projectPlanningRequest(raw);}
  async _save(previous,next,action,options={}){
    next.revision=previous?previous.revision+1:1;next.updatedAt=this.stamp();
    next.history=[...(previous?.history||[]),{revision:next.revision,at:next.updatedAt,action,actor:author(options.actor),...(options.nodeId?{nodeId:options.nodeId}:{})}].slice(-PLANNING_BROWSER_LIMITS.history);
    this._validate(next);const encoded=JSON.stringify(next);
    if(Buffer.byteLength(encoded)>PLANNING_BROWSER_LIMITS.bytes)throw fail('Planning request storage is full. Existing records were preserved.','PLANNING_BROWSER_CAPACITY',507);
    if(previous)await atomic(this.file(next.id)+'.bak',JSON.stringify(previous));
    await atomic(this.file(next.id),encoded);const view=this._public(next);this.emit('updated',copy(view));return view;
  }
  _node(request,nodeId){const node=request.nodes.find(item=>item.id===id(nodeId,'Module ID'));if(!node)throw fail('Module not found.','PLANNING_NODE_NOT_FOUND',404);return node;}
  _cas(node,expected){if(!Number.isSafeInteger(expected)||expected!==node.revision)throw Object.assign(fail('Module changed. Read its current revision before writing.','PLANNING_NODE_CONFLICT',409),{currentRevision:node.revision,nodeId:node.id});}
  _within(request,nodeId,rootId){let current=this._node(request,nodeId),seen=new Set();while(current&&!seen.has(current.id)){if(current.id===rootId)return true;seen.add(current.id);current=current.parentId?this._node(request,current.parentId):null;}return false;}
  _assignment(request,nodeId){let current=this._node(request,nodeId),first=true;while(current){const found=request.assignments.find(item=>item.nodeId===current.id&&(first||item.scope==='subtree'));if(found)return found;first=false;current=current.parentId?this._node(request,current.parentId):null;}return null;}
  _owner(request,nodeId,options={}){
    const assignment=this._assignment(request,nodeId);
    if(options.ownerId&&!assignment&&!options.allowUnassigned)throw fail('This worker has no ownership of the module.','PLANNING_NODE_OWNERSHIP',403);
    if(options.ownerId&&assignment&&assignment.ownerId!==options.ownerId)throw fail('This module belongs to another owner.','PLANNING_NODE_OWNERSHIP',403);
    for(const attempt of request.attempts.filter(item=>item.status==='running')){
      const assigned=request.assignments.find(item=>item.nodeId===attempt.nodeId);
      const overlaps=attempt.nodeId===nodeId||assigned?.scope==='subtree'&&this._within(request,nodeId,attempt.nodeId);
      if(overlaps&&attempt.ownerId!==options.ownerId)throw fail('An active worker owns this module. Cancel or wait for its actual response before editing.','PLANNING_NODE_OWNERSHIP',409);
    }
  }
  _key(options,action,payload){
    if(options.clientRequestId===undefined)return null;
    return {id:text(options.clientRequestId,'Client request ID',160,true),action,fingerprint:hash(payload)};
  }
  async _mutate(requestId,action,payload,options,change){
    await this.init();
    return this._enqueue(id(requestId),async()=>{
      const previous=await this._load(requestId),key=this._key(options,action,payload);
      const old=key&&previous.idempotency?.find(item=>item.id===key.id);
      if(old){if(old.action!==key.action||old.fingerprint!==key.fingerprint)throw fail('This client request ID was used for different work.','PLANNING_IDEMPOTENCY_CONFLICT',409);return this._public(previous);}
      const next=copy(previous);await change(next);
      if(key)next.idempotency=[...(next.idempotency||[]),key].slice(-300);
      return this._save(previous,next,action,options);
    });
  }
  async create(value,options={}){
    keys(value,['id','conversationId','title','objective','cwd','clientRequestId'],'Planning request');
    const planningExecutionMode=planningExecutionModeOf(options.planningExecutionMode);
    const proposed={...copy(value),...(planningExecutionMode?{planningExecutionMode}:{})},requestId=value.id===undefined?randomUUID():id(value.id,'Request ID');
    id(value.conversationId,'Conversation ID');text(value.title,'Request title',240,true);text(value.objective,'Requested outcome',12000,true);
    if(value.cwd!==undefined&&(typeof value.cwd!=='string'||!path.isAbsolute(value.cwd)))throw fail('Working folder must be absolute.');
    await this.init();
    return this._enqueue('_catalog',async()=>{
      const files=(await fs.readdir(this.requestDirectory)).filter(file=>file.endsWith('.json'));
      if(value.clientRequestId!==undefined){
        text(value.clientRequestId,'Client request ID',160,true);
        for(const file of files){const current=await this._load(file.slice(0,-5));if(current.clientRequestId===value.clientRequestId){if(current.createFingerprint!==hash(proposed))throw fail('This client request ID already created different work.','PLANNING_IDEMPOTENCY_CONFLICT',409);return this._public(current);}}
      }
      if(files.length>=PLANNING_BROWSER_LIMITS.requests)throw fail('Planning request capacity reached.','PLANNING_BROWSER_CAPACITY',507);
      try{await fs.stat(this.file(requestId));throw fail('Planning request already exists.','PLANNING_REQUEST_EXISTS',409);}catch(error){if(error.code!=='ENOENT')throw error;}
      const at=this.stamp(),origin=options.actor?.type==='external-agent'?'external_agent':options.actor?.type==='human'?'human':'unrecorded';
      const request={version:PLANNING_BROWSER_VERSION,id:requestId,conversationId:value.conversationId,title:value.title.trim(),objective:value.objective.trim(),provenance:{kind:origin,author:author(options.actor),at},cwd:value.cwd?path.resolve(value.cwd):null,revision:1,createdAt:at,updatedAt:at,nodes:[],edges:[],responses:[],assignments:[],attempts:[],sources:[],history:[],idempotency:[],
        ...(value.clientRequestId?{clientRequestId:value.clientRequestId,createFingerprint:hash(proposed)}:{})};
      return this._save(null,request,'create',options);
    });
  }
  async list({conversationId}={}){
    await this.init();if(conversationId!==undefined)id(conversationId,'Conversation ID');const requests=[],errors=[];
    for(const file of (await fs.readdir(this.requestDirectory)).filter(file=>file.endsWith('.json'))){
      try{const value=await this.get(file.slice(0,-5));if(!conversationId||value.conversationId===conversationId)requests.push({id:value.id,conversationId:value.conversationId,title:value.title,objective:value.objective,revision:value.revision,createdAt:value.createdAt,updatedAt:value.updatedAt,summary:value.summary});}
      catch(error){errors.push({id:file.slice(0,-5),code:error.code||'PLANNING_BROWSER_DAMAGED',message:error.message});}
    }
    requests.sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)||a.id.localeCompare(b.id));
    return {requests,errors};
  }
  async get(requestId){return this._public(await this._load(id(requestId)));}
  getRequest(requestId){return this.get(requestId);}
  async getNode(requestId,nodeId){const request=await this.get(requestId);return copy(this._node(request,nodeId));}
  addNode(requestId,value,options={}){
    keys(value,['id','parentId','kind','title','prompt'],'Module');
    const nodeId=value.id===undefined?randomUUID():id(value.id,'Module ID');planningModuleTemplate(value.kind);
    const parentId=value.parentId==null?null:id(value.parentId,'Parent ID'),title=text(value.title,'Module title',240,true),prompt=text(value.prompt??'','Module prompt',12000);
    return this._mutate(requestId,'addNode',value,options,request=>{
      if(request.nodes.some(node=>node.id===nodeId))throw fail('Module already exists.','PLANNING_NODE_EXISTS',409);
      if(options.ownerId&&!parentId)throw fail('A worker may add modules only inside its assigned subtree.','PLANNING_NODE_OWNERSHIP',403);
      if(parentId){const parent=this._node(request,parentId);this._cas(parent,options.expectedParentRevision);this._owner(request,parentId,options);if(options.ownerId&&this._assignment(request,parentId)?.scope!=='subtree')throw fail('Adding a child requires subtree ownership.','PLANNING_NODE_OWNERSHIP',403);parent.revision++;parent.updatedAt=this.stamp();}
      request.nodes.push({id:nodeId,parentId,kind:value.kind,title,prompt,revision:1,createdAt:this.stamp(),updatedAt:this.stamp()});
    });
  }
  updateNode(requestId,nodeId,patch,options={}){
    keys(patch,['title','prompt','kind','parentId'],'Module patch');
    if(!Object.keys(patch).length)throw fail('Supply a module change.');
    return this._mutate(requestId,'updateNode',{nodeId,patch},{...options,nodeId},request=>{
      const node=this._node(request,nodeId);this._cas(node,options.expectedNodeRevision);this._owner(request,nodeId,options);
      if(own(patch,'kind'))planningModuleTemplate(patch.kind);
      if(own(patch,'title'))node.title=text(patch.title,'Module title',240,true);
      if(own(patch,'prompt'))node.prompt=text(patch.prompt,'Module prompt',12000);
      if(own(patch,'kind'))node.kind=patch.kind;
      if(own(patch,'parentId')){
        const parentId=patch.parentId==null?null:id(patch.parentId,'Parent ID');
        if(parentId!==node.parentId){
          if(request.attempts.some(attempt=>attempt.status==='running'&&this._within(request,attempt.nodeId,node.id)))throw fail('Wait for active branch responses before moving containment.','PLANNING_NODE_BUSY',409);
          for(const parent of new Set([node.parentId,parentId].filter(Boolean))){const target=this._node(request,parent);this._owner(request,parent,options);target.revision++;target.updatedAt=this.stamp();}
          node.parentId=parentId;
        }
      }
      node.revision++;node.updatedAt=this.stamp();
    });
  }
  link(requestId,value,options={}){
    keys(value,['id','kind','from','to','sourceResponseId','sourceResponseRevision','sourceField','freshness'],'Graph relationship');
    if(!PLANNING_LINK_KINDS.includes(value.kind))throw fail('Choose a declared relationship kind.');
    const edgeId=value.id===undefined?randomUUID():id(value.id,'Edge ID');
    return this._mutate(requestId,'link',value,{...options,nodeId:value.from},async request=>{
      const node=this._node(request,value.from);this._cas(node,options.expectedNodeRevision);this._owner(request,node.id,options);
      const edge={id:edgeId,kind:value.kind,from:node.id,to:id(value.to,'Target ID')};
      const old=request.edges.find(item=>item.id===edgeId);
      if(old&&old.from!==node.id)throw fail('A relationship cannot move to another owner.','PLANNING_NODE_OWNERSHIP',403);
      if(value.kind==='knowledge'){
        if(!this.knowledge?.get)throw fail('The knowledge store is unavailable.','PLANNING_KNOWLEDGE_UNAVAILABLE',503);
        const entry=await this.knowledge.get(value.to);
        if(entry.kind!=='memory')throw fail('Link a saved memory entry.');
        if(entry.cwd!==null&&(!request.cwd||path.resolve(entry.cwd).toLowerCase()!==path.resolve(request.cwd).toLowerCase()))throw fail('Knowledge links must stay in this working folder or global scope.','PLANNING_KNOWLEDGE_SCOPE',403);
        edge.knowledge={id:entry.id,revision:entry.revision,title:entry.title,content:entry.content,provenance:copy(entry.provenance),cwd:entry.cwd};
      }else this._node(request,value.to);
      if(value.kind==='consumes'){
        const response=value.sourceResponseId?request.responses.find(item=>item.id===value.sourceResponseId):latest(request,value.to);
        if(!response||response.nodeId!==value.to||value.sourceResponseRevision!==undefined&&response.revision!==value.sourceResponseRevision)throw fail('Choose an actual recorded producer response.','PLANNING_RESPONSE_NOT_FOUND',409);
        if(value.sourceField!==undefined&&!own(response.values,value.sourceField))throw fail('The producer response has no such field.','PLANNING_RESPONSE_FIELD_MISSING',409);
        if(value.freshness!==undefined&&!['latest','pinned'].includes(value.freshness))throw fail('Input freshness is latest or pinned.');
        Object.assign(edge,{sourceResponseId:response.id,sourceResponseRevision:response.revision,freshness:value.freshness||'latest',...(value.sourceField?{sourceField:value.sourceField}:{})});
      }else if(['sourceResponseId','sourceResponseRevision','sourceField','freshness'].some(key=>own(value,key)))throw fail('Only consumes relationships pin response fields.');
      request.edges=request.edges.filter(item=>item.id!==edgeId);request.edges.push(edge);node.revision++;node.updatedAt=this.stamp();
    });
  }
  assign(requestId,nodeId,value,options={}){
    keys(value,['ownerId','label','scope'],'Assignment');const ownerId=id(value.ownerId,'Owner ID');
    if(!['node','subtree'].includes(value.scope))throw fail('Assignment scope is node or subtree.');
    return this._mutate(requestId,'assign',{nodeId,value},{...options,nodeId},request=>{
      const node=this._node(request,nodeId);this._cas(node,options.expectedNodeRevision);this._owner(request,nodeId,options);
      for(const attempt of request.attempts.filter(item=>item.status==='running'))if(attempt.nodeId===nodeId||value.scope==='subtree'&&this._within(request,attempt.nodeId,nodeId))throw fail('Wait for the active response before changing its ownership.','PLANNING_NODE_BUSY',409);
      request.assignments=request.assignments.filter(item=>item.nodeId!==nodeId);
      request.assignments.push({nodeId,ownerId,scope:value.scope,label:text(value.label||ownerId,'Owner label',240,true),assignedAt:this.stamp(),revision:node.revision+1});
      node.revision++;node.updatedAt=this.stamp();
    });
  }
  addSource(requestId,value,options={}){
    keys(value,['title','text','url'],'User-provided source');
    const title=text(value.title,'Source title',240,true),body=text(value.text,'Source text',PLANNING_BROWSER_LIMITS.sourceChars,true);
    const url=value.url===undefined?undefined:text(value.url,'Source URL',2000);
    return this._mutate(requestId,'addSource',value,options,request=>{
      request.sources.push({id:'source:'+randomUUID(),kind:options.actor?.type==='external-agent'?'external_provided':'user_provided',title,text:body,...(url?{url}:{}),contentHash:hash(body),createdAt:this.stamp(),provenance:{kind:options.actor?.type==='external-agent'?'external_agent':'human',author:author(options.actor),at:this.stamp()},verified:false});
    });
  }
  _inputSnapshot(request,nodeId){
    return request.edges.filter(edge=>edge.from===nodeId&&['depends_on','consumes'].includes(edge.kind)).map(edge=>{
      const response=edge.kind==='consumes'?request.responses.find(item=>item.id===edge.sourceResponseId&&item.revision===edge.sourceResponseRevision):latest(request,edge.to);
      if(!response)throw fail('A declared input has no recorded response.','PLANNING_INPUT_MISSING',409);
      const subtree=edge.kind==='depends_on'?request.nodes.filter(node=>node.id!==edge.to&&this._within(request,node.id,edge.to)).map(node=>{
        const child=latest(request,node.id);if(!child)throw fail('A prerequisite branch still has an unanswered module.','PLANNING_INPUT_MISSING',409);
        return {nodeId:node.id,responseId:child.id,responseRevision:child.revision,values:copy(child.values)};
      }):undefined;
      return {edgeId:edge.id,nodeId:edge.to,responseId:response.id,responseRevision:response.revision,...(edge.sourceField?{field:edge.sourceField}:{}),freshness:edge.freshness||'latest',values:edge.sourceField?{[edge.sourceField]:response.values[edge.sourceField]}:copy(response.values),...(subtree?{subtree}:{})};
    });
  }
  recordHumanResponse(requestId,nodeId,value,options={}){
    return this._mutate(requestId,'recordHumanResponse',{nodeId,value},{...options,nodeId},request=>{
      const node=this._node(request,nodeId);this._cas(node,options.expectedNodeRevision);this._owner(request,nodeId,options);
      const body=parseModuleResponse(value,node.kind),sources=planningNodeSources(request,nodeId);
      node.revision++;node.updatedAt=this.stamp();
      request.responses.push(this._response(request,node,body,{kind:'human',author:author(options.actor),at:this.stamp(),contentHash:hash(value)},this._inputSnapshot(request,nodeId),sources));
    });
  }
  _response(request,node,body,provenance,inputs,sources){
    validatePlanningReadableFindings(body,sources);
    for(const response of body.challengeResponses)if(!request.edges.some(edge=>edge.id===response.edgeId&&edge.kind==='challenges'&&edge.to===node.id))throw fail('A challenge response must name an actual challenge of this module.');
    return {id:randomUUID(),nodeId:node.id,kind:node.kind,revision:(latest(request,node.id)?.revision||0)+1,nodeRevision:node.revision,...planningResponseBody(body),inputs:copy(inputs),sources:copy(sources),provenance,verifiedAction:false};
  }
  externalWriter(){
    const token=this.#externalToken;
    return Object.freeze({recordResponse:(requestId,nodeId,value,options)=>this.recordExternalResponse(requestId,nodeId,value,options,token)});
  }
  recordExternalResponse(requestId,nodeId,value,options={},token){
    if(token!==this.#externalToken)throw fail('External response receipts can only be recorded by the trusted connection adapter.','PLANNING_EXTERNAL_WRITE_FORBIDDEN',403);
    keys(options.actor,['type','id'],'External response actor');
    if(options.actor.type!=='external-agent')throw fail('An external response needs the actual connected caller.');
    const actor=author(options.actor),receipt=externalReceipt(options.receipt);
    return this._mutate(requestId,'recordExternalResponse',{nodeId,value,actor,receipt},{...options,nodeId},request=>{
      const node=this._node(request,nodeId);this._cas(node,options.expectedNodeRevision);this._owner(request,nodeId,options);
      const body=parseModuleResponse(value,node.kind),sources=planningNodeSources(request,nodeId),inputs=this._inputSnapshot(request,nodeId);
      node.revision++;node.updatedAt=this.stamp();
      request.responses.push(this._response(request,node,body,{kind:'external_agent',author:actor,at:this.stamp(),receipt,contentHash:hash(value)},inputs,sources));
    });
  }
  runtimeWriter(){
    const token=this.#runtimeToken;
    return Object.freeze({
      beginAttempt:(requestId,nodeId,options)=>this.beginAttempt(requestId,nodeId,options,token),
      beginRepairAttempt:(requestId,attemptId)=>this.beginRepairAttempt(requestId,attemptId,token),
      recordResponse:(requestId,attemptId,value)=>this.recordResponse(requestId,attemptId,value,token),
      fail:(requestId,attemptId,value)=>this._settleAttempt(requestId,attemptId,'failed',value,token),
      cancel:(requestId,attemptId,value)=>this._settleAttempt(requestId,attemptId,'cancelled',value,token),
      getAttempt:(requestId,attemptId)=>this.getAttempt(requestId,attemptId),
      configureViability:(requestId,value)=>this.configureViability(requestId,value,token),
      configureResponseCycle:(requestId,value)=>this.configureResponseCycle(requestId,value,token),
      recordSupervisedResponse:(requestId,nodeId,value,options)=>this.recordSupervisedResponse(requestId,nodeId,value,options,token),
      withViabilityRequest:(requestId,work)=>{this._trusted(token);return this._enqueue(id(requestId),async()=>work(this._public(await this._load(requestId))));}
    });
  }
  recordSupervisedResponse(requestId,nodeId,value,options={},token){
    this._trusted(token);keys(options.actor,['type','id'],'Supervising model actor');if(options.actor.type!=='agent')throw fail('A supervising edit needs the actual engine actor.','PLANNING_RUNTIME_PROVENANCE');
    return this._mutate(requestId,'recordSupervisedResponse',{nodeId,value,actor:options.actor},{...options,nodeId},request=>{
      const node=this._node(request,nodeId);this._cas(node,options.expectedNodeRevision);this._owner(request,nodeId,options);
      const body=parseModuleResponse(value,node.kind),sources=planningNodeSources(request,nodeId),inputs=this._inputSnapshot(request,nodeId);node.revision++;node.updatedAt=this.stamp();
      request.responses.push(this._response(request,node,body,{kind:'supervising_model',origin:'engine-control',author:author(options.actor),at:this.stamp(),contentHash:hash(value)},inputs,sources));
    });
  }
  async configureResponseCycle(requestId,value,token){
    this._trusted(token);keys(value,['expectedRevision','clientRequestId','createCycle','cyclePatch','rootPatch','links','removeLinks','sources','replaceSourcePrefix','requestTitle'],'Response cycle context');
    const sources=value.sources?evidenceSources(value.sources):[];
    return this._mutate(requestId,'responseCycleContext',value,{actor:'response-cycle',...(value.clientRequestId?{clientRequestId:value.clientRequestId}:{})},request=>{
      if(value.expectedRevision!==undefined&&request.revision!==value.expectedRevision)throw fail('The response cycle changed. Read its current revision before continuing.','RESPONSE_CYCLE_CONFLICT',409);
      request.responseCycle??={version:1,cycles:[],limits:{maxDepth:4,maxCycles:24,maxPassesPerStage:3,maxProviderTurns:160}};
      if(value.requestTitle)request.title=text(value.requestTitle,'Request title',240,true);
      if(value.rootPatch){keys(value.rootPatch,['rootCycleId','linkedRunId','executionProfile','providerTurns','stageAttempts','lastAction','lastActionKey','actionReceipts','limits'],'Response cycle host fields');Object.assign(request.responseCycle,copy(value.rootPatch));}
      if(value.createCycle){
        const cycle=copy(value.createCycle);id(cycle.id,'Cycle ID');text(cycle.title,'Cycle title',240,true);text(cycle.objective,'Cycle objective',12000,true);
        if(request.responseCycle.cycles.some(item=>item.id===cycle.id))throw fail('This response cycle already exists.','RESPONSE_CYCLE_EXISTS',409);
        if(!['automatic','plan_only'].includes(cycle.planningExecutionMode)||!Number.isSafeInteger(cycle.depth)||cycle.depth<0)throw fail('Invalid response cycle policy.');
        const order=[['feasibility','viability'],['inference','inference'],['plan','plan'],['think','think'],['respond','respond']];
        const at=this.stamp();
        if(cycle.parentStageId){const parent=this._node(request,cycle.parentStageId);parent.revision++;parent.updatedAt=at;}
        request.nodes.push({id:cycle.id,parentId:cycle.parentStageId||null,kind:'cycle',title:cycle.title,prompt:cycle.objective,cycleId:cycle.id,revision:1,createdAt:at,updatedAt:at});
        for(const [stage,kind]of order){
          const nodeId=id(cycle.stageNodeIds?.[stage],'Stage ID');let node=request.nodes.find(item=>item.id===nodeId);
          if(node){if(stage!=='feasibility'||node.kind!=='viability'||node.cycleId)throw fail('A stage identity is already used by different work.');node.parentId=cycle.id;node.cycleId=cycle.id;node.cycleStage=stage;node.revision++;node.updatedAt=at;}
          else request.nodes.push({id:nodeId,parentId:cycle.id,kind,title:planningModuleTemplate(kind).label+' · '+cycle.title,prompt:cycle.objective,cycleId:cycle.id,cycleStage:stage,revision:1,createdAt:at,updatedAt:at});
        }
        request.responseCycle.cycles.push(cycle);
      }
      if(value.cyclePatch){
        const {id:cycleId,...patch}=value.cyclePatch,cycle=request.responseCycle.cycles.find(item=>item.id===cycleId);
        if(!cycle)throw fail('Response cycle not found.','RESPONSE_CYCLE_NOT_FOUND',404);
        keys(patch,['state','planningExecutionMode','summary','execution','executionProfile','effectReceipts','linkedRunId','planRef','continuedPlanRef','failure','lastAction','lastActionKey','passes','pendingIntent','acceptanceCriteria'],'Cycle update');
        if(patch.planningExecutionMode&&!['automatic','plan_only'].includes(patch.planningExecutionMode))throw fail('Invalid response cycle mode.');
        if(patch.executionProfile){
          keys(patch.executionProfile,['model','effort','serviceTier'],'Cycle execution profile');text(patch.executionProfile.model,'Cycle model',500,true);
          if(!['default','none','minimal','low','medium','high','xhigh','max','ultra'].includes(patch.executionProfile.effort)||!['default','fast'].includes(patch.executionProfile.serviceTier))throw fail('Invalid cycle execution profile.');
          if(cycle.executionProfile&&canonical(cycle.executionProfile)!==canonical(patch.executionProfile))throw fail('The cycle execution profile is already bound. Create a new cycle to choose another.','RESPONSE_CYCLE_PROFILE_LOCKED',409);
        }
        Object.assign(cycle,copy(patch));cycle.updatedAt=this.stamp();
      }
      for(const edgeId of value.removeLinks||[]){const edge=request.edges.find(item=>item.id===edgeId);if(!edge)continue;const node=this._node(request,edge.from);if(!node.cycleId)throw fail('Only cycle-owned dependencies can be removed here.');request.edges=request.edges.filter(item=>item.id!==edgeId);node.revision++;node.updatedAt=this.stamp();}
      for(const link of value.links||[]){
        keys(link,['id','from','to','kind'],'Cycle dependency');if(!['consumes','depends_on'].includes(link.kind))throw fail('Invalid cycle dependency.');
        const node=this._node(request,link.from);this._node(request,link.to);const edge={id:id(link.id,'Dependency ID'),kind:link.kind,from:link.from,to:link.to};
        if(link.kind==='consumes'){const response=latest(request,link.to);if(!response)throw fail('The previous stage has no recorded findings.','PLANNING_INPUT_MISSING',409);Object.assign(edge,{sourceResponseId:response.id,sourceResponseRevision:response.revision,freshness:'latest'});}
        const previous=request.edges.find(item=>item.id===edge.id);if(previous&&canonical(previous)===canonical(edge))continue;
        if(previous&&previous.from!==node.id)throw fail('A cycle dependency cannot change its owner.');
        request.edges=request.edges.filter(item=>item.id!==edge.id);request.edges.push(edge);node.revision++;node.updatedAt=this.stamp();
      }
      if(value.replaceSourcePrefix){text(value.replaceSourcePrefix,'Cycle evidence prefix',240,true);if(!value.replaceSourcePrefix.startsWith('cycle:'))throw fail('Only cycle-owned evidence can be replaced.');request.sources=request.sources.filter(source=>!source.id.startsWith(value.replaceSourcePrefix));}
      for(const source of sources){if(!source.id.startsWith('cycle:'))throw fail('Cycle evidence needs its own identity.');const index=request.sources.findIndex(item=>item.id===source.id);if(index<0)request.sources.push(source);else request.sources[index]=source;}
    });
  }
  async configureViability(requestId,value,token){
    this._trusted(token);keys(value,['viability','sources','replaceBaseSources','expectedRevision','completeIntentId'],'Readiness context');
    if(value.viability&&!object(value.viability))throw fail('Invalid host readiness binding.','TASK_VIABILITY_INVALID');
    const sources=value.sources?evidenceSources(value.sources):[];
    return this._mutate(requestId,'readinessContext',value,{actor:'task-readiness'},request=>{
      if(value.expectedRevision!==undefined&&value.expectedRevision!==request.revision)throw fail('Readiness context changed. Read the current graph before answering.','TASK_VIABILITY_ANSWER_CONFLICT',409);
      if(value.completeIntentId!==undefined&&request.viability?.pendingIntent?.id!==value.completeIntentId)return;
      if(value.viability){
        const binding={...request.viability,...copy(value.viability)};
        if(!['request','deployment'].includes(binding.scope)||!/^[a-f0-9]{64}$/.test(binding.fingerprint||'')||binding.nodeId!=='viability')throw fail('Invalid host readiness binding.','TASK_VIABILITY_INVALID');
        request.viability=binding;
      }
      if(value.replaceBaseSources===true)request.sources=request.sources.filter(source=>!source.id.startsWith('viability:')||source.id.startsWith('viability:answer:'));
      for(const source of sources){const index=request.sources.findIndex(item=>item.id===source.id);if(index<0)request.sources.push(source);else request.sources[index]=source;}
    });
  }
  _trusted(token){if(token!==this.#runtimeToken)throw fail('Runtime response provenance can only be recorded by the host response service.','PLANNING_RUNTIME_WRITE_FORBIDDEN',403);}
  _attemptSources(graph,nodeId,inputs){
    const node=this._node(graph,nodeId),allSources=planningNodeSources(graph,nodeId),needed=new Set(['request:'+graph.id,...graph.sources.map(source=>source.id),...inputs.flatMap(input=>[input,...(input.subtree||[])]).map(input=>'response:'+input.responseId)]);
    for(const sourceId of graph.responseCycle?.cycles?.find(cycle=>cycle.id===node.cycleId)?.sourceIds||[])needed.add(sourceId);
    for(const edge of graph.edges.filter(edge=>edge.from===nodeId&&edge.kind==='knowledge'))needed.add('knowledge:'+edge.knowledge.id+':'+edge.knowledge.revision);
    for(const edge of graph.edges.filter(edge=>edge.to===nodeId&&edge.kind==='challenges')){const response=latest(graph,edge.from);if(response)needed.add('response:'+response.id);}
    return allSources.filter(source=>needed.has(source.id));
  }
  _cycleProfile(graph,node){
    let cycle=graph.responseCycle?.cycles?.find(item=>item.id===node.cycleId),seen=new Set();
    while(cycle&&!seen.has(cycle.id)){seen.add(cycle.id);if(cycle.executionProfile)return copy(cycle.executionProfile);cycle=graph.responseCycle.cycles.find(item=>item.id===cycle.parentCycleId);}
    return null;
  }
  _attemptBudget(graph,node){
    if(!node.cycleId)return;
    const maximum=graph.responseCycle?.limits?.maxProviderTurns??160,used=graph.attempts.filter(attempt=>attempt.node?.cycleId).length;
    if(!Number.isSafeInteger(maximum)||maximum<1||used>=maximum)throw fail('The response reached its bounded model-work limit. Its saved results remain available.','RESPONSE_CYCLE_BUDGET',409);
  }
  async beginAttempt(requestId,nodeId,options={},token){
    this._trusted(token);id(options.ownerId,'Owner ID');let attemptId;
    const request=await this._mutate(requestId,'beginAttempt',{nodeId,expectedNodeRevision:options.expectedNodeRevision,ownerId:options.ownerId,model:options.model||null,effort:options.effort||null},{...options,actor:'runtime',nodeId},graph=>{
      const node=this._node(graph,nodeId);this._cas(node,options.expectedNodeRevision);this._owner(graph,nodeId,{...options,allowUnassigned:true});this._attemptBudget(graph,node);
      if(graph.attempts.some(item=>item.nodeId===nodeId&&item.status==='running'))throw fail('This module already has an active response attempt.','PLANNING_NODE_BUSY',409);
      const effective=this._assignment(graph,nodeId);
      if(effective&&effective.ownerId!==options.ownerId)throw fail('The response worker does not own this module.','PLANNING_NODE_OWNERSHIP',403);
      if(!effective)graph.assignments.push({nodeId,ownerId:options.ownerId,scope:'node',label:(node.title+' response worker').slice(0,240),assignedAt:this.stamp(),revision:node.revision});
      const projected=projectPlanningRequest(graph);
      for(const edge of graph.edges.filter(item=>item.from===nodeId&&item.kind==='depends_on'))if(!projected.nodes.find(item=>item.id===edge.to)?.readiness.subtreeReady)throw fail('A declared prerequisite branch is not ready.','PLANNING_INPUT_MISSING',409);
      for(const edge of graph.edges.filter(item=>item.from===nodeId&&['depends_on','consumes'].includes(item.kind))){
        let response=edge.kind==='consumes'&&edge.freshness==='pinned'?graph.responses.find(item=>item.id===edge.sourceResponseId&&item.revision===edge.sourceResponseRevision):latest(graph,edge.to);
        if(!response)throw fail('A required producer has no public response yet.','PLANNING_INPUT_MISSING',409);
        if(edge.sourceField&&!own(response.values,edge.sourceField))throw fail('The current producer response lacks the requested field.','PLANNING_RESPONSE_FIELD_MISSING',409);
        if(edge.kind==='consumes'&&edge.freshness!=='pinned'&&(edge.sourceResponseId!==response.id||edge.sourceResponseRevision!==response.revision)){
          edge.sourceResponseId=response.id;edge.sourceResponseRevision=response.revision;node.revision++;node.updatedAt=this.stamp();
        }
      }
      const inputs=this._inputSnapshot(graph,nodeId);
      const challenges=graph.edges.filter(edge=>edge.to===nodeId&&edge.kind==='challenges').map(edge=>{const response=latest(graph,edge.from);return {edgeId:edge.id,nodeId:edge.from,responseId:response?.id||null,responseRevision:response?.revision||null,values:copy(response?.values||{})};});
      const sources=this._attemptSources(graph,nodeId,inputs);
      attemptId=randomUUID();
      graph.attempts.push({id:attemptId,requestId,nodeId,nodeRevision:node.revision,ownerId:options.ownerId,status:'running',startedAt:this.stamp(),node:copy(node),template:copy(planningModuleTemplate(node.kind)),inputs,sources,challenges,workflowNodeIds:copy(graph.viability?.workflowNodeIds||[]),...(latest(graph,nodeId)?{previousResponse:{...planningResponseBody(latest(graph,nodeId)),provenance:copy(latest(graph,nodeId).provenance)}}:{}),...(node.cycleId?{cycleContext:planningCycleStageContext(graph,nodeId),cycleExecutionProfile:this._cycleProfile(graph,node)}:{}),
        ...(options.model?{model:text(options.model,'Model',500,true)}:{}),...(options.effort?{effort:text(options.effort,'Effort',80,true)}:{}),
        ...(options.clientRequestId?{clientRequestId:options.clientRequestId}:{})});
    });
    const created=Boolean(attemptId);
    if(!attemptId)attemptId=request.attempts.find(item=>item.nodeId===nodeId&&item.clientRequestId===options.clientRequestId)?.id;
    const attempt=request.attempts.find(item=>item.id===attemptId);if(!attempt)throw fail('The saved attempt could not be recovered.','PLANNING_ATTEMPT_NOT_FOUND',500);
    return {request,attempt:copy(attempt),created};
  }
  async beginRepairAttempt(requestId,attemptId,token){
    this._trusted(token);
    return this._enqueue(id(requestId),async()=>{
      const previous=await this._load(requestId),next=copy(previous),original=next.attempts.find(item=>item.id===id(attemptId,'Attempt ID'));
      if(!original)throw fail('Response attempt not found.','PLANNING_ATTEMPT_NOT_FOUND',404);
      if(original.repairAttemptId){const existing=next.attempts.find(item=>item.id===original.repairAttemptId);if(!existing)throw fail('The saved format-repair receipt is incomplete.','PLANNING_REPAIR_RECEIPT',409);return {request:this._public(previous),attempt:copy(existing),created:false};}
      if(original.status!=='failed'||!original.validation||original.repairOf||!original.partialOutput?.trim())throw fail('Only one failed structured response may receive one bounded format repair.','PLANNING_REPAIR_INELIGIBLE',409);
      const node=this._node(next,original.nodeId),owner=this._assignment(next,node.id);
      if(node.revision!==original.nodeRevision||owner?.ownerId!==original.ownerId||next.attempts.some(item=>item.nodeId===node.id&&item.status==='running'))throw fail('The module changed or another worker owns it. Its failed response is preserved.','PLANNING_REPAIR_STALE',409);
      const inputs=this._inputSnapshot(next,node.id),sourceSnapshot=sources=>canonical(sources.slice().sort((a,b)=>a.id.localeCompare(b.id)));
      if(sourceSnapshot(this._attemptSources(next,node.id,inputs))!==sourceSnapshot(original.sources)||canonical(inputs)!==canonical(original.inputs)||canonical(next.viability?.workflowNodeIds||[])!==canonical(original.workflowNodeIds||[]))throw fail('The captured evidence or dependency inputs changed. Run a new check of the current graph.','PLANNING_REPAIR_STALE',409);
      if(canonical(node.cycleId?planningCycleStageContext(next,node.id):null)!==canonical(original.cycleContext||null)||canonical(this._cycleProfile(next,node))!==canonical(original.cycleExecutionProfile||null))throw fail('The cycle criteria, execution context or pinned model profile changed. Run a new check of the current graph.','PLANNING_REPAIR_STALE',409);
      const challenges=next.edges.filter(edge=>edge.to===node.id&&edge.kind==='challenges').map(edge=>{const response=latest(next,edge.from);return {edgeId:edge.id,nodeId:edge.from,responseId:response?.id||null,responseRevision:response?.revision||null,values:copy(response?.values||{})};});
      if(canonical(challenges)!==canonical(original.challenges||[]))throw fail('The captured challenges changed. Run a new check of the current graph.','PLANNING_REPAIR_STALE',409);
      const captured=['requestId','nodeId','nodeRevision','ownerId','node','template','inputs','sources','challenges','workflowNodeIds','previousResponse','cycleContext','cycleExecutionProfile','model','effort'];
      this._attemptBudget(next,node);
      const repair={...Object.fromEntries(captured.filter(key=>Object.hasOwn(original,key)).map(key=>[key,copy(original[key])])),id:randomUUID(),status:'running',startedAt:this.stamp(),clientRequestId:'format-repair-'+hash(original.id).slice(0,64),repairOf:original.id,repairIndex:1,formatRepair:{previousAttemptId:original.id,diagnostic:copy(original.validation),previousOutput:original.partialOutput}};
      original.repairAttemptId=repair.id;next.attempts.push(repair);
      const request=await this._save(previous,next,'beginFormatRepair',{actor:'runtime',nodeId:node.id});
      return {request,attempt:copy(repair),created:true};
    });
  }
  async getAttempt(requestId,attemptId){const request=await this._load(requestId),attempt=request.attempts.find(item=>item.id===id(attemptId,'Attempt ID'));if(!attempt)throw fail('Response attempt not found.','PLANNING_ATTEMPT_NOT_FOUND',404);return copy(attempt);}
  async recordResponse(requestId,attemptId,value,token){
    this._trusted(token);keys(value,['output','metadata','evidence'],'Runtime response');
    text(value.output,'Public runtime output',PLANNING_BROWSER_LIMITS.responseChars,true);
    const output=value.output,stamp=metadata(value.metadata,true),actualEvidence=evidenceSources(value.evidence);
    await this.init();
    return this._enqueue(id(requestId),async()=>{
      const previous=await this._load(requestId),next=copy(previous),attempt=next.attempts.find(item=>item.id===id(attemptId,'Attempt ID'));
      if(!attempt)throw fail('Response attempt not found.','PLANNING_ATTEMPT_NOT_FOUND',404);
      if(attempt.status!=='running'){
        if(attempt.status==='completed'&&attempt.outputHash===hash(output))return this._public(previous);
        throw fail('The response attempt has already settled.','PLANNING_ATTEMPT_SETTLED',409);
      }
      const node=this._node(next,attempt.nodeId),effective=this._assignment(next,node.id);
      if(effective?.ownerId!==attempt.ownerId)throw fail('The response attempt lost its ownership.','PLANNING_NODE_OWNERSHIP',409);
      const body=parseModuleResponse(output,attempt.node.kind);
      if(actualEvidence.some(item=>attempt.sources.some(source=>source.id===item.id)))throw fail('Runtime evidence must not replace an existing source identity.','PLANNING_SOURCE_COLLISION',409);
      const sources=[...attempt.sources,...actualEvidence];
      const responseNode=copy(attempt.node),unchanged=node.revision===attempt.nodeRevision;
      node.revision++;node.updatedAt=this.stamp();if(unchanged)responseNode.revision=node.revision;
      const response=this._response(next,responseNode,body,{kind:'runtime',attemptId:attempt.id,at:this.stamp(),contentHash:hash(output),...stamp},attempt.inputs,sources);
      next.responses.push(response);
      Object.assign(attempt,{status:'completed',finishedAt:this.stamp(),output,outputHash:hash(output),responseId:response.id,metadata:stamp,evidence:actualEvidence});
      return this._save(previous,next,'recordResponse',{actor:'runtime',nodeId:node.id});
    });
  }
  async _settleAttempt(requestId,attemptId,status,value={},token){
    this._trusted(token);keys(value,['message','reason','partialOutput','metadata','validation'],'Incomplete attempt evidence');
    if(value.validation!==undefined){
      keys(value.validation,['code','message','issues'],'Structured response diagnostic');text(value.validation.code,'Validation code',100,true);text(value.validation.message,'Validation message',2000,true);
      if(!Array.isArray(value.validation.issues)||value.validation.issues.length>12)throw fail('Use a bounded validation diagnostic.');
      for(const issue of value.validation.issues){keys(issue,['path','message'],'Validation issue');text(issue.path,'Validation path',240,true);text(issue.message,'Validation detail',1200,true);}
    }
    return this._enqueue(id(requestId),async()=>{
      const previous=await this._load(requestId),next=copy(previous),attempt=next.attempts.find(item=>item.id===id(attemptId,'Attempt ID'));
      if(!attempt)throw fail('Response attempt not found.','PLANNING_ATTEMPT_NOT_FOUND',404);
      if(attempt.status!=='running')return this._public(previous);
      Object.assign(attempt,{status,finishedAt:this.stamp(),message:text(value.message||value.reason||'Response '+status+'.','Attempt message',2000,true),
        ...(value.partialOutput!==undefined?{partialOutput:(text(value.partialOutput,'Partial public output',PLANNING_BROWSER_LIMITS.responseChars),value.partialOutput)}:{}),
        ...(value.metadata!==undefined?{metadata:metadata(value.metadata)}:{}),...(value.validation?{validation:copy(value.validation)}:{})});
      return this._save(previous,next,status,{actor:'runtime',nodeId:attempt.nodeId});
    });
  }
  async close(){this.closed=true;await Promise.allSettled([...this.queues.values()]);}
}
