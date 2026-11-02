import test from 'node:test';
import assert from 'node:assert/strict';
import {deflateSync} from 'node:zlib';
import {CodexRuntime} from '../lib/codex.mjs';
import {PLANNING_RESPONSE_DISABLED_FEATURES} from '../lib/response-profile.mjs';

function image(){
 const crc=bytes=>{let c=0xffffffff;for(const b of bytes){c^=b;for(let bit=0;bit<8;bit++)c=(c>>>1)^((c&1)?0xedb88320:0)}return(c^0xffffffff)>>>0};
 const chunk=(name,data)=>{const type=Buffer.from(name),size=Buffer.alloc(4),check=Buffer.alloc(4);size.writeUInt32BE(data.length);check.writeUInt32BE(crc(Buffer.concat([type,data])));return Buffer.concat([size,type,data,check])};
 const h=Buffer.alloc(13);h.writeUInt32BE(3,0);h.writeUInt32BE(2,4);h[8]=8;h[9]=2;
 const bytes=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',h),chunk('IDAT',deflateSync(Buffer.from([0,25,50,75,100,125,150,175,200,225,0,250,225,200,175,150,125,100,75,50]))),chunk('IEND',Buffer.alloc(0))]);
 return {imageUrl:'data:image/png;base64,'+bytes.toString('base64')};
}
function fixture(t,{modalities=['text','image'],echo=false}={}){
 const cwd=process.cwd(),requests=[],events=[];
 const client=new CodexRuntime({command:process.execPath,cwd,nativeModelMetadata:false,runTimeoutMs:2000,spawnImpl(){throw Error('No native process in source checks')}});
 client.child={};Object.assign(client.info,{connected:true,authenticated:true,defaultModel:'image-model',models:[{id:'image-model',model:'image-model',...(modalities?{inputModalities:modalities}:{})}]});
 client.start=async()=>client.status();
 client._request=async(method,params={})=>{
  requests.push({method,params:structuredClone(params)});
  if(method==='config/read')return {config:{skills:{config:[]},plugins:{},mcp_servers:{},apps:{}}};
  if(method==='skills/list')return {data:[{cwd,skills:[],errors:[]}]};
  if(method==='experimentalFeature/list')return {data:PLANNING_RESPONSE_DISABLED_FEATURES.map(name=>({name,stage:'stable',enabled:!params.threadId})),nextCursor:null};
  if(method==='thread/start')return {thread:{id:'image-thread',ephemeral:true},model:params.model,sandbox:{type:'readOnly',networkAccess:false},approvalPolicy:'never'};
  if(method==='turn/start'){
   setImmediate(()=>{
    if(echo)for(const stage of ['started','completed'])client._notification('item/'+stage,{threadId:params.threadId,turnId:'image-turn',item:{type:'userMessage',id:'image-input',content:[...params.input,{type:'localImage',path:'C:/private/not-a-log.png'}]}});
    const url=params.input.find(x=>x.type==='image')?.url;
    const text=echo?'Inspected '+(echo==='raw'?url.split(',')[1]:url):'Inspected the supplied evidence.';
    if(echo){
     const cut=text.indexOf('base64')+4;
     for(const delta of [text.slice(0,cut),text.slice(cut)]){
      client._notification('item/agentMessage/delta',{threadId:params.threadId,turnId:'image-turn',itemId:'image-answer',delta});
      client._notification('item/commandExecution/outputDelta',{threadId:params.threadId,turnId:'image-turn',itemId:'image-command',delta});
     }
    }
    client._notification('item/completed',{threadId:params.threadId,turnId:'image-turn',item:{type:'agentMessage',id:'image-answer',phase:'final_answer',text}});
    client._notification('turn/completed',{threadId:params.threadId,turn:{id:'image-turn',status:'completed',items:[]}});
   });return {turn:{id:'image-turn',status:'inProgress'}};
  }
  if(['thread/unsubscribe','turn/interrupt'].includes(method))return {};
  throw Error('Unexpected request '+method);
 };
 t.after(()=>{client.closing=true;client._connectionFailed(Object.assign(Error('Source fixture closed'),{code:'CODEX_CLOSED'}),client.child)});
 return {client,requests,events,run:overrides=>client.runAgent({cwd,prompt:'Assess this retained image.',model:'image-model',responseOnly:true,dynamicTools:[],onEvent:e=>events.push(e),...overrides})};
}

test('native tool-less review sends actual bounded PNG as an initial protocol image, preserving text and private boundary',async t=>{
 const f=fixture(t),png=image(),result=await f.run({inputImages:[png]});
 const turn=f.requests.find(x=>x.method==='turn/start').params;
 assert.deepEqual(turn.input,[{type:'text',text:'Assess this retained image.'},{type:'image',url:png.imageUrl}]);
 assert.equal(turn.sandboxPolicy.type,'readOnly');assert.equal(f.requests.find(x=>x.method==='thread/start').params.ephemeral,true);
 assert.equal(result.output,'Inspected the supplied evidence.');
 const initial=f.events.find(e=>e.type==='context').context;assert.equal(initial.estimatedInputTokens,null);assert.match(initial.estimateMethod,/image.*cost/);
 assert.doesNotMatch(JSON.stringify(f.events),/data:image|base64,/);
});

test('native image echoes are removed from initial input notifications, answer events and final output',async t=>{
 const f=fixture(t,{echo:true}),png=image(),result=await f.run({inputImages:[png]});
 const serialized=JSON.stringify({result,events:f.events,contexts:[...f.client.contexts.values()]});
 assert.doesNotMatch(serialized,/data:image|base64,|private\/not-a-log/);
 assert.match(result.output,/image data omitted/);
 assert.equal(f.events.some(e=>e.type==='delta'||e.type==='toolOutput'),false,'Arbitrary split image echoes wait for a complete sanitized item.');
 const user=f.events.find(e=>e.item?.type==='userMessage').item;
 assert.deepEqual(user.content.slice(1),[{type:'text',text:'[Image supplied to the agent]'},{type:'text',text:'[Image supplied to the agent]'}]);
});

test('native explicit text-only models reject images before opening a session, without poisoning model access',async t=>{
 const f=fixture(t,{modalities:['text']}),prior={state:'accepted',lastSuccessAt:'2026-11-01T00:00:00Z'};
 f.client.modelAccess.set('image-model',prior);
 await assert.rejects(f.run({inputImages:[image()]}),{code:'INPUT_IMAGES_UNSUPPORTED'});
 assert.deepEqual(f.requests,[]);assert.deepEqual(f.client.modelAccess.get('image-model'),prior);
});

test('native rejects unbounded or external image inputs before any session work',async t=>{
 const f=fixture(t);
 for(const inputImages of [[{imageUrl:'https://example.invalid/image.png'}],[{path:'C:/private/image.png'}],[image(),image(),image()]])await assert.rejects(f.run({inputImages}),{code:'INVALID_INPUT_IMAGES'});
 assert.deepEqual(f.requests,[]);
});

test('native initial image evidence cannot enter a generic persistent or operational session',async t=>{
 const f=fixture(t);
 await assert.rejects(f.run({responseOnly:false,inputImages:[image()]}),{code:'INVALID_INPUT_IMAGES'});
 assert.deepEqual(f.requests,[]);assert.equal(f.client.threads.size,0);
});

test('native text-only callers retain the exact initial text request',async t=>{
 const f=fixture(t);await f.run();assert.deepEqual(f.requests.find(x=>x.method==='turn/start').params.input,[{type:'text',text:'Assess this retained image.'}]);
});

test('native protocol error echoes cannot persist image data',()=>{
 const client=new CodexRuntime({command:process.execPath,nativeModelMetadata:false}),png=image();let failure;
 client.pending.set(1,{timer:setTimeout(()=>{},1000),reject:error=>{failure=error}});
 client._receive({id:1,error:{code:-32602,message:'Rejected '+png.imageUrl}});
 assert.equal(failure.code,-32602);assert.match(failure.message,/image data omitted/);assert.doesNotMatch(failure.message,/data:image|base64,/);
});

test('native run-bound redaction covers bare encoded image echoes in output and events',async t=>{
 const f=fixture(t,{echo:'raw'}),png=image(),result=await f.run({inputImages:[png]});
 assert.equal(JSON.stringify({result,events:f.events}).includes(png.imageUrl.split(',')[1]),false);
 assert.match(result.output,/image data omitted/);
});

test('native pending initial turn binds raw and truncated image error redaction before session acknowledgement',async()=>{
 const client=new CodexRuntime({command:process.execPath,nativeModelMetadata:false}),png=image(),raw=png.imageUrl.split(',')[1];
 for(const echoed of [raw,raw.slice(0,60),raw.slice(20,75)]){
  client._send=message=>queueMicrotask(()=>client._receive({id:message.id,error:{code:-32602,message:'Rejected source '+echoed}}));
  await assert.rejects(client._request('turn/start',{input:[{type:'image',url:png.imageUrl}]}),error=>error.code===-32602&&!error.message.includes(echoed)&&/image data omitted/.test(error.message));
 }
 assert.equal(client.pending.size,0);
});
