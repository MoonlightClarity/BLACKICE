'use strict';
// Pure observation of one unscored managed generation route. The caller preserves
// native bytes and independent host observations; this module performs no I/O.
// Sparse host snapshots are observations, not proof of continuous global absence.
const path=require('node:path');
const {record,text,integer,positive,hash,sha,time,canonical,digest,without,issues}=require('./policy-contract.cjs');
const {normalizeRuntimeObservation}=require('./runtime-observation.cjs');
const SCHEMA='blackice.minicpm.managed-route-observation.v1',CAPTURE_SCHEMA='blackice.minicpm.provider-capture.v1';
const GENERATION='/v1/chat/completions',COUNTING='/v1/chat/completions/input_tokens';
const SOURCE_PINS=Object.freeze({
 'lib/context.mjs':'ea3cc177988cea021b879e421a892dae52e03a254085e01946ad852906b3bccf',
 'server.mjs':'a43ffce743443febbab59b348bdfd9f8dbf8820805e854c5eb7b1d3e50b2e0dd',
 'desktop/main.mjs':'7cd2ca0c35e3f10fa9b01603a2c564bedfb3553925eaea0e9f71fce4f03b0fae',
 'lib/engine.mjs':'b21774d804c1763151967bbeaa4b58dbafd142f3bef58233b3183402a35fd99f',
 'lib/providers.mjs':'c8d703b85f7d3f3cd03830e7ce0afd20d28601b865703b44d8a91843dde51fd7',
});
const terminal=s=>['completed','failed','cancelled'].includes(s);
const absolute=s=>typeof s==='string'&&/^[A-Za-z]:[\\/]/.test(s)&&path.win32.isAbsolute(s);
const key=s=>absolute(s)?path.win32.normalize(s).toLowerCase():null;
const samePath=(a,b)=>key(a)!==null&&key(a)===key(b);
const raw=v=>Buffer.isBuffer(v)||v instanceof Uint8Array?Buffer.from(v):null;
const procKey=e=>e.pid+':'+e.processId;
const finite=v=>typeof v==='number'&&Number.isFinite(v);
function normalizeManagedRouteObservation(input={},runtimeBytes={}){
 input=record(input)?input:{};
 const i=issues(),b=input.runBinding||{},run=input.nativeRun||{},thread=input.providerThread||{};
 const result={schema:SCHEMA,complete:false,bindingTier:'exclusive-route',providerExchangeBinding:'unbound',
  scorable:false,traceComparable:false,activityScope:'Observed host snapshots plus complete native generation-route inventory; not continuous global host absence.',
  capture:null,payload:null,runtime:null,providerBudgets:null,generationRequests:[],countingRequests:[],otherRequests:[],
  taskSpans:[],artifacts:[],provenance:{},missing:i.missing,conflicts:i.conflicts};
 const add=(field,code,observed,expected)=>i.add(field,code,observed,expected,true);
 const fresh=(field,at)=>{const t=time(at),now=time(input.now);if(t===null||now===null||!positive(input.maxEvidenceAgeMs)||t>now||now-t>input.maxEvidenceAgeMs){i.add(field,'fresh-observation-required',at,input.now);return false;}return true;};
 const historical=(field,at)=>{if(time(at)===null||time(input.now)===null||time(at)>time(input.now)){i.add(field,'historical-observation-time-invalid',at);return false;}return true;};
 const json=(value,field)=>{const bytes=raw(value);if(!bytes){i.add(field,'exact-observed-bytes-required',null);return null;}try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{i.add(field,'invalid-json-or-utf8',null);return null;}};
 const one=(rows,field)=>{if(rows.length!==1){i.add(field,'unique-observation-required',rows.length,1);return null;}return rows[0];};
 const ref=e=>e?{path:e.evidence.path,line:e.evidence.line,pid:e.pid,processId:e.processId,processSequence:e.processSequence,event:e.event,at:e.at}:null;
 try{
  fresh('clock',input.now);
  if(!['runId','nodeId','threadId','turnId','requestId','model'].every(k=>text(b[k]))||b.nodeId!=='agent'||b.model.includes('::'))i.add('runBinding','complete-owned-binding-required',null);
  const node=run.nodes?.agent,audit=node?.instructionAudit,agent=run.workflow?.nodes?.find(n=>n?.id==='agent'&&n?.type==='agent');
  for(const[f,a,c]of [['run.id',run.id,b.runId],['run.taskId',run.taskId,b.runId],['run.request',run.metadata?.clientRequestId,b.requestId],
   ['run.threadId',node?.threadId,b.threadId],['run.turnId',node?.turnId,b.turnId],['run.model',node?.resolvedModel,'local_llamacpp::'+b.model],
   ['workflow.model',agent?.model,'local_llamacpp::'+b.model],['thread.id',thread.id,b.threadId],['thread.model',thread.model,b.model],
   ['thread.providerId',thread.providerId,'local_llamacpp'],['thread.providerType',thread.providerType,'compatible']])i.equal(f,a,c);
  if(!terminal(run.status)||run.settled!==true||run.parentRunId||run.retryOf)i.add('run','fresh-settled-native-run-required',run.status);
  if(!Array.isArray(thread.compactions)||thread.compactions.length||thread.messages?.[0]?.role!=='user'||typeof thread.messages[0].content!=='string'||typeof thread.developerInstructions!=='string')i.add('thread','uncompacted-initial-thread-required',null);
  if(audit?.version!==1||audit.captureStage!=='adapter-prepared'||audit.adapter!=='compatible'||audit.delivery!=='accepted'||audit.tools?.status!=='accepted'||time(audit.acceptedAt)===null)i.add('audit','observed-accepted-audit-required',null);

  const source=input.sourceObservation;
  fresh('sourceObservation.at',source?.at);
  const si=source?.sourceIdentity;
  if(!record(si)||!text(si.appVersion)||!record(si.files)||!hash(si.sha256))i.add('sourceIdentity','complete-source-identity-required',null);
  else{
   i.equal('sourceIdentity.sha256',si.sha256,digest({appVersion:si.appVersion,files:si.files}));
   for(const[file,expected]of Object.entries(SOURCE_PINS))i.equal('sourceIdentity.'+file,si.files[file],expected);
  }
  const activity=input.hostActivity||{},snapshots=[];
  function snapshot(value,label){
   if(!record(value)){i.add(label,'host-run-list-snapshot-required',null);return null;}
   historical(label+'.startedAt',value.startedAt);historical(label+'.finishedAt',value.finishedAt);
   if(time(value.startedAt)>time(value.finishedAt)||value.status!==200||value.method!=='GET'||value.path!=='/api/runs')i.add(label,'successful-exact-run-list-required',null);
   const rows=json(value.bytes,label+'.bytes');
   if(!Array.isArray(rows)){i.add(label,'complete-unpaginated-run-list-required',null);return null;}
   const ids=new Set();for(const r of rows){if(!record(r)||!text(r.id)||ids.has(r.id)||typeof r.status!=='string'){i.add(label,'invalid-or-duplicate-run-row',r?.id);continue;}ids.add(r.id);
    if((!terminal(r.status)||r.settled!==true)&&r.id!==b.runId)add(label,'other-active-or-unsettled-host-run',r.id);}
   const owned=rows.filter(r=>r.id===b.runId);
   if(owned.length>1)i.add(label,'duplicate-owned-run',owned.length);
   const out={label,startedAt:value.startedAt,finishedAt:value.finishedAt,bodySha256:sha(raw(value.bytes)),bodyBytes:raw(value.bytes).length,runIds:rows.map(r=>r.id),activeRunIds:rows.filter(r=>!terminal(r.status)||r.settled!==true).map(r=>r.id),owned:owned[0]||null};
   snapshots.push(out);return out;
  }
  const before=snapshot(activity.before,'host.before'),active=Array.isArray(activity.active)?activity.active.map((s,n)=>snapshot(s,'host.active['+n+']')).filter(Boolean):[],after=snapshot(activity.after,'host.after');
  if(!active.length)i.add('host.active','owned-active-snapshot-required',null);
  const created=time(run.createdAt);
  if(created===null||!before||time(before.finishedAt)>created||before.owned)i.add('host.before','snapshot-before-fresh-admission-required',null);
  for(const s of active)if(!s.owned||!['queued','running','waiting'].includes(s.owned.status)||time(s.startedAt)<created||after&&time(s.finishedAt)>time(after.finishedAt))i.add(s.label,'owned-active-run-window-required',null);
  if(!after?.owned||!terminal(after.owned.status)||after.owned.settled!==true)i.add('host.after','settled-owned-snapshot-required',null);
  if(after)fresh('host.after.finishedAt',after.finishedAt);
  for(const s of snapshots.filter(s=>s.owned)){
   for(const[f,a,c]of [['requestId',s.owned.metadata?.clientRequestId,b.requestId],['model',s.owned.workflow?.nodes?.find(n=>n.id==='agent')?.model,'local_llamacpp::'+b.model]])i.equal(s.label+'.'+f,a,c);
  }
  result.provenance.hostActivity=snapshots;
  const from=before?.startedAt,to=after?.finishedAt;

  const tr=input.trace||{},fileMap=new Map(),events=[],groups=new Map(),invalid=[];
  if(!absolute(tr.root))i.add('trace.root','absolute-trace-root-required',tr.root);
  fresh('trace.finishedAt',tr.finishedAt);historical('trace.startedAt',tr.startedAt);
  if(time(tr.startedAt)>time(tr.finishedAt)||after&&time(tr.startedAt)<time(after.finishedAt))i.add('trace.window','capture-must-follow-settled-host-window',null);
  function inventory(value,label){
   if(!record(value)||!Array.isArray(value.files)||!historical(label+'.at',value.at)){i.add(label,'independent-directory-inventory-required',null);return [];}
   const seen=new Set(),out=[];
   for(const f of value.files){const k=key(f?.path),rel=k&&key(tr.root)?path.win32.relative(key(tr.root),k):null;
    if(!k||rel===null||!rel||path.win32.isAbsolute(rel)||rel==='..'||rel.startsWith('..\\')||seen.has(k)||!integer(f.size)||!record(f.identity)||
     !['dev','ino','birthtimeNs'].every(n=>typeof f.identity[n]==='string'&&/^\d+$/.test(f.identity[n]))||f.identity.ino==='0')i.add(label,'invalid-file-identity-or-scope',f?.path);
    else{seen.add(k);out.push({path:k,size:f.size,identity:f.identity});}}
   return out.sort((a,b)=>a.path.localeCompare(b.path));
  }
  const invBefore=inventory(tr.inventoryBefore,'trace.inventoryBefore'),invAfter=inventory(tr.inventoryAfter,'trace.inventoryAfter');
  if(!invBefore.length||canonical(invBefore)!==canonical(invAfter))i.add('trace.inventory','changed-or-incomplete-bounded-snapshot',null);
  if(time(tr.inventoryBefore?.at)<time(tr.startedAt)||time(tr.inventoryAfter?.at)>time(tr.finishedAt)||time(tr.inventoryBefore?.at)>time(tr.inventoryAfter?.at))i.add('trace.inventory','inventory-bracket-times-invalid',null);
  if(!Array.isArray(tr.artifacts))i.add('trace.artifacts','exact-artifacts-required',null);
  for(const a of tr.artifacts||[]){
   const k=key(a?.path),bytes=raw(a?.bytes),reread=raw(a?.rereadBytes),inv=invBefore.find(f=>f.path===k);
   if(!k||fileMap.has(k)||!inv||!bytes||!reread||bytes.length!==inv.size||!bytes.equals(reread)){i.add('trace.artifact','missing-changed-or-unread-artifact',a?.path);continue;}
   const f={path:a.path,bytes:bytes.length,sha256:sha(bytes),identity:inv.identity};fileMap.set(k,{...f,raw:bytes});result.artifacts.push(f);
   if(a.path.endsWith('.invalid.json')){invalid.push({file:f,value:json(bytes,'trace.invalid')});continue;}
   if(!a.path.endsWith('.jsonl'))continue;
   let textBytes;try{textBytes=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{i.add('trace.jsonl','invalid-utf8',a.path);continue;}
   if(!textBytes.endsWith('\n'))i.add('trace.jsonl','torn-jsonl-tail',a.path);
   let previous=0,lineNo=0,start=0;
   while(start<textBytes.length){const end=textBytes.indexOf('\n',start);if(end<0)break;const line=textBytes.slice(start,end);start=end+1;lineNo++;
    if(!line){i.add('trace.jsonl','empty-record',a.path);continue;}
    let e;try{e=JSON.parse(line);}catch{i.add('trace.jsonl','invalid-json-record',{path:a.path,line:lineNo});continue;}
    if(e.schema!=='blackice.minicpm.live-trace.v1'||!positive(e.pid)||!text(e.processId)||time(e.processStartedAt)===null||time(e.at)===null||!text(e.event)||!record(e.data)||!positive(e.processSequence)||e.fileSequence!==previous+1){i.add('trace.event','invalid-identity-or-file-sequence',{path:a.path,line:lineNo});}
    previous=e.fileSequence;
    const expectedPrefix=e.pid+'-'+e.processId+'.';
    if(!path.win32.basename(a.path).startsWith(expectedPrefix))i.add('trace.event','file-process-identity-mismatch',a.path);
    if(time(e.at)>time(tr.finishedAt)||time(e.at)<time(e.processStartedAt))i.add('trace.event','event-time-outside-process',e.at);
    e.evidence={path:a.path,line:lineNo};events.push(e);
    const k=procKey(e);if(!groups.has(k))groups.set(k,[]);groups.get(k).push(e);
   }
  }
  if(fileMap.size!==invBefore.length)i.add('trace.inventory','omitted-observed-artifacts',fileMap.size,invBefore.length);
  for(const[k,rows]of groups){rows.sort((a,b)=>a.processSequence-b.processSequence);
   if(rows.some((e,n)=>e.processSequence!==n+1))i.add('trace.processSequence','incomplete-cross-file-process-sequence',k);
   if(new Set(rows.map(e=>e.processStartedAt)).size!==1)i.add('trace.process','inconsistent-process-birth',k);
  }
  function artifact(reference,field){
   const f=fileMap.get(key(reference?.path));if(!f||f.bytes!==reference.bytes||f.sha256!==reference.sha256){i.add(field,'referenced-artifact-mismatch',reference);return null;}return f;
  }
  for(const e of events){
   if(e.event==='http_request'&&e.data.bodyObserved===true)artifact(e.data.body,'http.body');
   if(e.event==='runtime_startup')artifact(e.data.receipt,'runtime.startup');
   if(e.event==='sample_logits'&&e.data.rawFloat32Vector)artifact(e.data.rawFloat32Vector,'sample.vector');
  }

  const runtime=normalizeRuntimeObservation({...input.runtimeInput,now:input.now,maxEvidenceAgeMs:input.maxEvidenceAgeMs},runtimeBytes);result.runtime=runtime;
  if(!runtime.complete)i.add('runtime','independent-runtime-observation-incomplete',{missing:runtime.missing,conflicts:runtime.conflicts});
  const ri=input.runtimeInput||{},childPid=ri.processIdentity?.pid,props=ri.propsResponse?.json?.blackice_runtime,os=input.osObservation;
  fresh('osObservation.at',os?.at);
  if(!Array.isArray(os?.processes))i.add('osObservation','independent-process-chain-required',null);
  const processRows=Array.isArray(os?.processes)?os.processes:[],childOS=one(processRows.filter(p=>p.pid===childPid),'os.child');
  if(childOS){i.equal('os.child.startedAt',childOS.startedAt,ri.processIdentity?.startedAt);if(!samePath(childOS.executablePath,ri.processIdentity?.executablePath))i.add('os.child','executable-path-mismatch',null);}
  const startup=one(events.filter(e=>e.pid===childPid&&e.event==='runtime_startup'&&e.data.startupId===props?.startupId),'native.startup');
  if(startup){
   const f=artifact(startup.data.receipt,'native.startup'),saved=f?json(f.raw,'native.startup.bytes'):null;
   i.equal('native.startup.file',saved,startup.data.runtime);i.equal('native.startup.props',startup.data.runtime,props);
   i.equal('native.startup.enrichment',without(ri.startupReceipt,['modelSha256','binarySha256','observedAt']),startup.data.runtime);
   i.equal('native.startup.pid',startup.pid,childPid);i.equal('native.startup.birth',startup.processStartedAt,ri.processIdentity?.startedAt);
   const context=one(events.filter(e=>procKey(e)===procKey(startup)&&e.event==='context_start'&&e.data.startupId===props?.startupId),'native.context');
   if(context)i.equal('native.context.birth',context.processStartedAt,startup.processStartedAt);
  }
  const requests=events.filter(e=>e.event==='http_request'),generation=requests.filter(e=>e.data.method==='POST'&&e.data.path===GENERATION),counting=requests.filter(e=>e.data.method==='POST'&&e.data.path===COUNTING);
  const inWindow=e=>time(e.at)!==null&&time(from)!==null&&time(to)!==null&&time(e.at)>=time(from)&&time(e.at)<=time(to);
  const overlaps=e=>{
   if(time(e.at)===null||time(from)===null||time(to)===null||time(e.at)>time(to))return false;
   const ends=events.filter(x=>procKey(x)===procKey(e)&&x.event==='http_generator_end'&&x.data.serverRequestId===e.data.serverRequestId);
   if(ends.length!==1)return true;
   if(time(ends[0].at)<time(e.at))i.add('http.window','terminal-precedes-request',ref(e));
   return time(ends[0].at)>=time(from);
  };
  const relevant=generation.filter(overlaps),requestBodies=new Map();
  for(const e of requests)if(e.data.method==='POST'&&![GENERATION,COUNTING].includes(e.data.path)&&overlaps(e))i.add('route.inventory','unaccounted-overlapping-post-traffic',ref(e));
  for(const e of requests){
   const d=e.data,f=d.bodyObserved===true?artifact(d.body,'http.request.body'):null;
   if(f){i.equal('http.body.sha256',f.sha256,d.bodySha256);i.equal('http.body.bytes',f.bytes,d.bodyBytes);if(d.method==='POST'&&[GENERATION,COUNTING].includes(d.path))requestBodies.set(e,json(f.raw,'http.request.json'));if(text(d.hostRequestSha256)&&d.hostRequestSha256!==f.sha256)i.add('http.hostRequestSha256','supplied-host-body-sha-conflict',d.hostRequestSha256,f.sha256);}
   const item={...ref(e),serverRequestId:d.serverRequestId??null,parentServerRequestId:d.parentServerRequestId??null,method:d.method,path:d.path,body:f?without(f,['raw']):null,inWindow:inWindow(e),overlapsWindow:overlaps(e)};
   if(d.method==='POST'&&d.path===GENERATION)result.generationRequests.push(item);
   else if(d.method==='POST'&&d.path===COUNTING)result.countingRequests.push(item);
   else result.otherRequests.push(item);
  }
  const children=relevant.filter(e=>e.pid===childPid&&text(e.data.parentServerRequestId));
  const initial=[];
  for(const e of children){const p=requestBodies.get(e);if(p?.messages?.length===2&&p.messages[0]?.role==='system'&&p.messages[1]?.role==='user'&&p.messages[0].content===thread.developerInstructions&&p.messages[1].content===thread.messages?.[0]?.content&&p.model===b.model)initial.push(e);}
  const first=one(initial,'route.initialGeneration');
  if(first&&children.some(e=>time(e.at)<time(first.at)))i.add('route.initialGeneration','initial-payload-not-first-generation',ref(first));
  const selectedKeys=new Set(startup?[procKey(startup)]:[]),pairs=[];
  for(const child of children){
   const d=child.data,p=requestBodies.get(child);
   if(time(child.at)<created)i.add('route.generation','generation-before-owned-admission',ref(child));
   if(p?.model!==b.model||p.messages?.[0]?.role!=='system'||p.messages[0]?.content!==thread.developerInstructions||p.messages?.[1]?.role!=='user'||p.messages[1]?.content!==thread.messages?.[0]?.content)i.add('route.generation','unbound-generation-traffic',ref(child));
   const parent=one(relevant.filter(e=>e.data.serverRequestId===d.parentServerRequestId&&e.pid!==child.pid),'route.routerParent');
   if(!parent)continue;selectedKeys.add(procKey(parent));pairs.push({parent,child});
   const a=fileMap.get(key(parent.data.body?.path)),z=fileMap.get(key(d.body?.path));
   if(!a||!z||!a.raw.equals(z.raw)||parent.data.bodySha256!==d.bodySha256||parent.data.bodyBytes!==d.bodyBytes||parent.data.method!==d.method||parent.data.path!==d.path)i.add('route.routerChild','router-child-bytes-or-path-differ',null);
   const parentOS=one(processRows.filter(p=>p.pid===parent.pid),'os.router');
   if(parentOS){i.equal('os.router.startedAt',parentOS.startedAt,parent.processStartedAt);let current=childOS,seen=new Set(),found=false;
    while(current&&!seen.has(current.pid)){seen.add(current.pid);if(current.pid===parent.pid){found=true;break;}current=processRows.find(p=>p.pid===current.parentPid);}
    if(!found)i.add('os.ancestry','router-not-in-observed-child-ancestry',null);
   }
   i.equal('child.process.birth',child.processStartedAt,ri.processIdentity?.startedAt);
   if(time(child.at)<time(child.processStartedAt)||time(parent.at)>time(child.at))i.add('route.time','invalid-router-child-request-order',null);
  }
  if(relevant.length!==pairs.length*2||!pairs.length)i.add('route.inventory','unpaired-or-foreign-generation-traffic',relevant.length,pairs.length*2);
  for(const marker of invalid)if(selectedKeys.has(marker.value?.pid+':'+marker.value?.processId)||[...selectedKeys].some(k=>path.win32.basename(marker.file.path).startsWith(k.replace(':','-')+'.')))i.add('trace.invalid','selected-process-invalid-marker',marker.file.path);
  for(const k of selectedKeys){
   const start=one((groups.get(k)||[]).filter(e=>e.event==='process_start'),'native.process_start');
   if(start){if(start.data.effectiveConfig?.enabled!==true||!samePath(start.data.effectiveConfig.outputDirectory,tr.root)||typeof start.data.configBytesUtf8!=='string'||sha(start.data.configBytesUtf8)!==start.data.configSha256)i.add('native.config','observed-enabled-recorder-config-required',ref(start));}
  }
  const requestTerminal=(e)=>{
   const own=x=>procKey(x)===procKey(e)&&x.data.serverRequestId===e.data.serverRequestId;
   const response=one(events.filter(x=>x.event==='http_response_observed'&&own(x)),'http.response'),end=one(events.filter(x=>x.event==='http_generator_end'&&own(x)),'http.generator');
   if(response?.data.status!==200||end?.data.status!==200||end?.data.complete!==true||typeof end?.data.streaming!=='boolean'||(end.data.streaming?(end.data.transportProviderSuccess!==true||end.data.producerExhausted!==true||end.data.sinkDoneCalled!==true||end.data.chunkWriteFailed!==false):(end.data.transportProviderSuccess!==null||end.data.producerExhausted!==null||end.data.sinkDoneCalled!==null||end.data.chunkWriteFailed!==null)))i.add('http.terminal','successful-complete-http-terminal-required',ref(e));
   if(end&&time(end.at)>time(tr.startedAt))i.add('http.terminal','terminal-after-capture-cutoff',ref(end));
   return {response:ref(response),generator:ref(end)};
  };
  const boundTaskKeys=new Set(),taskKey=e=>procKey(e)+':'+e.data.startupId+':'+e.data.taskId;
  for(const pair of pairs){
   const child=pair.child,cp=procKey(child),d=child.data,registration=one(events.filter(e=>procKey(e)===cp&&e.event==='task_registered'&&e.data.serverRequestId===d.serverRequestId),'task.registration');
   const terminals={router:requestTerminal(pair.parent),child:requestTerminal(child)};
   if(!registration)continue;
   boundTaskKeys.add(taskKey(registration));
   const task=registration.data,owns=e=>procKey(e)===cp&&e.data.startupId===task.startupId&&e.data.taskId===task.taskId;
   if(!integer(task.taskId)||task.startupId!==props?.startupId||!text(task.completionId)||!Array.isArray(task.promptTokenIds)||!task.promptTokenIds.length||task.promptTokenIds.some(t=>!integer(t))||task.allPromptPositionsAreText!==true||task.nPromptPositions!==task.promptTokenIds.length||typeof task.renderedPrompt!=='string')i.add('task','exact-chat-task-registration-required',ref(registration));
   const assigned=one(events.filter(e=>e.event==='task_slot_assigned'&&owns(e)),'task.slot'),ended=one(events.filter(e=>e.event==='task_terminal'&&owns(e)),'task.terminal'),released=one(events.filter(e=>e.event==='slot_release'&&owns(e)),'task.release');
   const accepted=events.filter(e=>e.event==='accepted_token'&&owns(e)).sort((a,b)=>a.processSequence-b.processSequence),samples=events.filter(e=>e.event==='sample_logits'&&owns(e)).sort((a,b)=>a.processSequence-b.processSequence);
   if(!accepted.length||accepted.some((e,n)=>e.data.ordinal!==n+1||!integer(e.data.tokenId)||e.data.slotId!==assigned?.data.slotId)||!samples.length||samples.some(e=>!positive(e.data.sampleId)||!integer(e.data.sampledTokenId)||!hash(e.data.rawFloat32Sha256)||e.data.slotId!==assigned?.data.slotId)||canonical(accepted.map(e=>e.data.tokenId))!==canonical(samples.map(e=>e.data.sampledTokenId)))i.add('task.tokens','complete-matching-sampled-and-accepted-tokens-required',ref(registration));
   if(ended?.data.outcome!=='completed'||ended.data.traceComplete!==true||ended.data.droppedEvents!==0||ended.data.completionId!==task.completionId||ended.data.acceptedTokenEvents!==accepted.length||ended.data.sampleLogitEvents!==samples.length||!['nDecoded','nPromptPositions','nPromptCached'].every(k=>integer(ended.data[k]))||!Number.isSafeInteger(ended.data.stopType)||typeof ended.data.truncated!=='boolean')i.add('task.terminal','unique-complete-counted-task-terminal-required',ref(ended));
   if(!integer(assigned?.data.slotId)||!integer(assigned?.data.samplerSeed)||assigned.data.samplerSeed>4294967295||!text(assigned.data.samplerChain)||!Number.isSafeInteger(assigned.data.nPredictMax)||assigned.data.nPredictMax< -1)i.add('task.slot','actual-sampler-and-slot-required',ref(assigned));
   if(released?.data.hadTaskTerminal!==true||released?.data.slotId!==assigned?.data.slotId||ended?.data.slotId!==assigned?.data.slotId)i.add('task.release','matching-slot-release-required',ref(released));
   const params=task.generationParams,payload=requestBodies.get(child),sampling=runtime.conditions.sampling;
   if(!record(params)||!Number.isSafeInteger(params.n_predict)||params.n_predict< -1||params.max_tokens!==params.n_predict||params.stream!==payload?.stream||!Array.isArray(params.samplers)||!params.samplers.every(text))i.add('task.generationParams','actual-task-generation-parameters-required',params??null);
   if(record(params)){
    i.equal('task.outputBudget',params.n_predict,payload?.max_tokens);
    for(const[name,requestName,key,asFloat]of [['seed','seed','seed',false],['temperature','temperature','temperature',true],['top_k','top_k','topK',false],['top_p','top_p','topP',true],['min_p','min_p','minP',true]]){
     const expected=Object.hasOwn(payload||{},requestName)?payload[requestName]:sampling[key],actual=params[name];
     if(!finite(actual)||!finite(expected)||(asFloat?Math.fround(actual)!==Math.fround(expected):actual!==expected))i.add('task.generationParams.'+name,'effective-task-parameter-differs',actual,expected);
    }
    if(integer(params.seed)&&params.seed<4294967295)i.equal('task.samplerSeed',assigned?.data.samplerSeed,params.seed);
   }
   result.taskSpans.push({pid:child.pid,processId:child.processId,startupId:task.startupId,taskId:task.taskId,completionId:task.completionId,
    childRequest:ref(child),routerRequest:ref(pair.parent),registration:ref(registration),slot:ref(assigned),terminal:ref(ended),release:ref(released),http:terminals,
    generationParams:params??null,samplerSeed:assigned?.data.samplerSeed??null,samplerChain:assigned?.data.samplerChain??null,nPredictMax:assigned?.data.nPredictMax??null,truncated:ended?.data.truncated??null,
    nativeCounts:ended?{nDecoded:ended.data.nDecoded,nPromptPositions:ended.data.nPromptPositions,nPromptCached:ended.data.nPromptCached,stopType:ended.data.stopType}:null,acceptedTokenIds:accepted.map(e=>e.data.tokenId),sampledTokenIds:samples.map(e=>e.data.sampledTokenId)});
  }
  for(const registration of events.filter(e=>e.event==='task_registered')){
   const ends=events.filter(e=>e.event==='task_terminal'&&taskKey(e)===taskKey(registration));
   const overlap=time(registration.at)<=time(to)&&(ends.length!==1||time(ends[0].at)>=time(from));
   if(overlap&&!boundTaskKeys.has(taskKey(registration)))i.add('route.inventory','unaccounted-overlapping-native-task',ref(registration));
  }
  const options=thread.contextOptions,status=thread.contextStatus;
  if(!record(options)||!record(status)||options.autoCompact!==false||!positive(options.windowTokens)||!positive(options.outputReserveTokens)||!integer(options.headroomTokens))i.add('provider.context','observed-provider-context-options-and-status-required',null);
  if(record(options)){
   const expected=agent?.context||run.workflow?.settings?.context;
   for(const name of ['windowTokens','autoCompact','outputReserveTokens','headroomTokens'])i.equal('provider.context.'+name,options[name],expected?.[name]);
   if(positive(runtime.conditions.runtime.ctxSize)&&options.windowTokens!==runtime.conditions.runtime.ctxSize)i.add('provider.context','requested-and-native-context-differ',options.windowTokens,runtime.conditions.runtime.ctxSize);
  }
  if(record(status)&&record(options)){
   for(const[f,a,c]of [['requestedWindowTokens',status.requestedWindowTokens,options.windowTokens],['effectiveWindowTokens',status.effectiveWindowTokens,runtime.conditions.runtime.ctxSize],
    ['outputReserveTokens',status.outputReserveTokens,options.outputReserveTokens],['headroomTokens',status.headroomTokens,options.headroomTokens],['autoCompact',status.autoCompact,false],['compactionCount',status.compactionCount,0],
    ['inputBudgetTokens',status.inputBudgetTokens,options.windowTokens-options.outputReserveTokens-options.headroomTokens]])i.equal('provider.contextStatus.'+f,a,c);
  }
  result.providerBudgets={contextOptions:options??null,contextStatus:status??null,requestMaxTokens:result.taskSpans.map(t=>({taskId:t.taskId,value:t.generationParams?.n_predict??null})),
   scope:'Observed provider context and per-task effective generation parameters; no host step limit is inferred from a missing field.'};
  if(first){
   const body=artifact(first.data.body,'initial.payload'),payload=requestBodies.get(first),span=result.taskSpans.find(t=>t.childRequest.processSequence===first.processSequence&&t.pid===first.pid);
   i.equal('initial.audit.systemSha256',sha(payload?.messages?.[0]?.content||''),audit?.developer?.sha256);
   i.equal('initial.audit.toolsSha256',sha(JSON.stringify(payload?.tools??null)),audit?.tools?.sha256);
   if(time(first.at)<created||time(first.at)>time(audit?.acceptedAt))i.add('initial.request','initial-request-time-not-bound-to-accepted-audit',first.at);
   if(body)result.payload=without(body,['raw']);
   result.provenance.selected={childRequest:ref(first),routerRequest:pairs.find(p=>p.child===first)?ref(pairs.find(p=>p.child===first).parent):null,startup:ref(startup),sourceIdentity:si,traceSnapshot:{startedAt:tr.startedAt,finishedAt:tr.finishedAt,inventorySha256:digest(invBefore)},runtimeObservationSha256:digest(runtime)};
   if(!i.missing.length&&!i.conflicts.length&&body&&span){
    result.capture={schema:CAPTURE_SCHEMA,kind:'exclusive-route',complete:true,droppedEvents:0,request:{at:first.at,method:'POST',path:GENERATION,bodySha256:body.sha256,bodyBytes:body.bytes},
     response:{status:200,id:span.completionId},binding:structuredClone(b),runtime:{pid:childPid,processStartedAt:ri.processIdentity.startedAt,binarySha256:runtime.conditions.runtime.binarySha256,modelPath:runtime.conditions.model.path,modelSha256:runtime.conditions.model.sha256},
     exclusiveRoute:{from,to,activeRunIds:[b.runId],matchingFirstRequestCount:initial.length}};
   }
  }
 }catch(error){i.add('observation','invalid-observation-shape',String(error?.message||error));}
 result.complete=!i.missing.length&&!i.conflicts.length&&result.capture!==null;
 return result;
}
module.exports={SCHEMA,SOURCE_PINS,normalizeManagedRouteObservation};
