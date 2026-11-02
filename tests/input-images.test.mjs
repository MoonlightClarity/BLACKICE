import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {crc32} from 'node:zlib';
import {normalizeInputImages,assertInputImagesSupported,redactInputImageData} from '../lib/input-images.mjs';
import {ProviderRuntime} from '../lib/providers.mjs';
import {workbenchFramePng} from '../lib/workbench-agent-tools.mjs';

function png(){const b=Buffer.alloc(58);b.write('BM');b.writeUInt32LE(58,2);b.writeUInt32LE(54,10);b.writeUInt32LE(40,14);b.writeInt32LE(1,18);b.writeInt32LE(-1,22);b.writeUInt16LE(1,26);b.writeUInt16LE(32,28);b[54]=91;b[55]=43;b[56]=17;return workbenchFramePng({bytes:b,width:1,height:1,contentType:'image/bmp'});}
const imageUrl='data:image/png;base64,'+png().toString('base64');
function paddedUrl(size){const payload=Buffer.alloc(size,71),chunk=Buffer.alloc(payload.length+12);chunk.writeUInt32BE(payload.length);chunk.write('tEXt',4);payload.copy(chunk,8);chunk.writeUInt32BE(crc32(chunk.subarray(4,-4)),chunk.length-4);const original=png();return 'data:image/png;base64,'+Buffer.concat([original.subarray(0,-12),chunk,original.subarray(-12)]).toString('base64');}
const schema={type:'object',additionalProperties:false,properties:{answer:{type:'string'}},required:['answer']};
const answer='{"answer":"synthetic transport observation"}';

test('input images require exact bounded PNG data objects and return independent clones',()=>{
  assert.deepEqual(normalizeInputImages(undefined),[]);assert.deepEqual(normalizeInputImages([]),[]);
  const supplied=[{imageUrl}],result=normalizeInputImages(supplied);assert.deepEqual(result,supplied);assert.notEqual(result,supplied);assert.notEqual(result[0],supplied[0]);
  for(const bad of [null,{},new Array(1),[imageUrl],[{imageUrl,path:'C:/private.png'}],[{imageUrl:'https://example.com/image.png'}],[{imageUrl:'file:///image.png'}],[{imageUrl:imageUrl.replace('image/png','image/jpeg')}],[{imageUrl:imageUrl+' '}],[{imageUrl:'data:image/png;base64,AAAA'}],Array.from({length:3},()=>({imageUrl}))])assert.throws(()=>normalizeInputImages(bad),{code:'INVALID_INPUT_IMAGES'});
});
test('PNG checksum corruption, truncation, noncanonical base64 and aggregate overflow are rejected',()=>{
  const bytes=png();bytes[42]^=1;assert.throws(()=>normalizeInputImages([{imageUrl:'data:image/png;base64,'+bytes.toString('base64')}]),{code:'INVALID_INPUT_IMAGES'});
  assert.throws(()=>normalizeInputImages([{imageUrl:imageUrl.slice(0,-4)}]),{code:'INVALID_INPUT_IMAGES'});
  assert.throws(()=>normalizeInputImages([{imageUrl:'data:image/png;base64,'+'A'.repeat(17*1024*1024)}]),{code:'INVALID_INPUT_IMAGES'});
  const payload=Buffer.alloc(6*1024*1024),chunk=Buffer.alloc(payload.length+12);chunk.writeUInt32BE(payload.length);chunk.write('tEXt',4);payload.copy(chunk,8);chunk.writeUInt32BE(crc32(chunk.subarray(4,-4)),chunk.length-4);
  const original=png(),largeUrl='data:image/png;base64,'+Buffer.concat([original.subarray(0,-12),chunk,original.subarray(-12)]).toString('base64');
  assert.equal(normalizeInputImages([{imageUrl:largeUrl}]).length,1);assert.throws(()=>normalizeInputImages([{imageUrl:largeUrl},{imageUrl:largeUrl}]),{code:'INVALID_INPUT_IMAGES'});
});
test('explicit model exclusions fail while unknown modality remains unknown',()=>{
  for(const metadata of [{vision:false},{supportsVision:false},{inputModalities:['text']}])assert.throws(()=>assertInputImagesSupported([{imageUrl}],metadata),{code:'INPUT_IMAGES_UNSUPPORTED'});
  assert.doesNotThrow(()=>assertInputImagesSupported([{imageUrl}],{}));assert.doesNotThrow(()=>assertInputImagesSupported([{imageUrl}],{inputModalities:['text','image']}));assert.doesNotThrow(()=>assertInputImagesSupported([],{vision:false}));
});
test('image echo redaction removes typed raw base64 and inline data URLs',()=>{
  const result=redactInputImageData({content:[{type:'image',source:{type:'base64',media_type:'image/png',data:'private-raw'}},{type:'input_image',image_url:imageUrl}],text:'echo '+imageUrl});
  assert.equal(JSON.stringify(result).includes('private-raw'),false);assert.equal(JSON.stringify(result).includes(imageUrl),false);assert.match(result.text,/image data omitted/);
});
class Native extends EventEmitter{status(){return {connected:true,authenticated:true,defaultModel:'native',models:[{id:'native'}]};}async close(){}async runAgent(){throw Error('No native model calls in API fixtures');}}
async function fixture(t,type,{modalities,echo=false,rawEcho=false,stream=false,fail=false,failureMessage,responseText}={}){
  const directory=await mkdtemp(path.join(os.tmpdir(),'blackice-input-images-')),requests=[],events=[];
  const runtime=await new ProviderRuntime({codex:new Native(),dataDir:directory,modelLimitResolver:{enrich:async(_config,models)=>models},fetchImpl:async(url,options)=>{
    if(options.method==='GET')return new Response(JSON.stringify({data:[{id:'vision-model',...(modalities?{input_modalities:modalities}:{})}]}),{headers:{'content-type':'application/json'}});
    const body=JSON.parse(options.body);requests.push(body);const text=responseText??(echo?'echo '+(rawEcho?imageUrl.split(',')[1]:imageUrl):answer);
    if(fail)return new Response(JSON.stringify({error:{message:failureMessage||'rejected '+imageUrl}}),{status:400,headers:{'content-type':'application/json'}});
    if(stream){const pieces=[text.slice(0,13),text.slice(13,31),text.slice(31)];const frames=pieces.map(content=>({choices:[{delta:{content}}]}));frames.push({choices:[{delta:{},finish_reason:'stop'}]});return new Response(frames.map(e=>'data: '+JSON.stringify(e)+'\n\n').join('')+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});}
    const result=type==='openai'?{status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text}]}]}:type==='anthropic'?{content:[{type:'text',text}],stop_reason:'end_turn',usage:{input_tokens:2,output_tokens:3}}:{choices:[{message:{role:'assistant',content:text},finish_reason:'stop'}]};
    return new Response(JSON.stringify(result),{headers:{'content-type':'application/json'}});
  }}).init();
  await runtime.saveProvider({id:'fixture',type,baseUrl:'http://127.0.0.1:1/v1',apiKey:'synthetic-test-key',models:[{id:'vision-model',...(modalities?{inputModalities:modalities}:{})}]});
  t.after(async()=>{await runtime.close();await rm(directory,{recursive:true,force:true});});
  const options={cwd:directory,prompt:'Assess this actual image.',model:'fixture::vision-model',responseOnly:true,dynamicTools:[],outputSchema:schema,onEvent:e=>events.push(e)};
  return {runtime,directory,requests,events,options};
}
for(const type of ['openai','anthropic','compatible'])test(type+' transports original PNG bytes only on the wire and excludes them from history and text estimates',async t=>{
  const f=await fixture(t,type),plain=await f.runtime.runAgent(f.options);f.events.length=0;
  const result=await f.runtime.runAgent({...f.options,inputImages:[{imageUrl}]}),wire=f.requests.at(-1),message=(wire.input||wire.messages).find(m=>m.role==='user');
  assert.equal(result.output,answer);assert.equal(message.content[0].text,f.options.prompt);
  const image=message.content[1];assert.equal(type==='openai'?image.image_url:type==='anthropic'?'data:'+image.source.media_type+';base64,'+image.source.data:image.image_url.url,imageUrl);
  assert.equal(result.context.textEstimatedInputTokens??result.context.estimatedInputTokens,plain.context.estimatedInputTokens,'base64 never enters text context estimation');
  const before=f.events.find(e=>e.type==='context');assert.equal(before.context.estimatedInputTokens,null);assert.equal(before.context.remainingTokens,null);assert.match(before.context.estimateMethod,/not text tokens/);
  const persisted=await readFile(f.runtime.threadFile(result.threadId),'utf8'),record=JSON.parse(persisted);
  assert.equal(record.messages[0].content,f.options.prompt);assert.equal(record.transcript[0].content,f.options.prompt);assert.equal(persisted.includes(imageUrl),false);assert.equal(JSON.stringify(f.events).includes(imageUrl),false);
  if(type==='openai'){assert.deepEqual(wire.tools,[]);assert.equal(wire.tool_choice,'none');assert.deepEqual(wire.text.format.schema,schema);}
});
test('known text-only API models reject before generation, and invalid images reject before native dispatch',async t=>{
  const f=await fixture(t,'compatible',{modalities:['text']});await assert.rejects(f.runtime.runAgent({...f.options,inputImages:[{imageUrl}]}),{code:'INPUT_IMAGES_UNSUPPORTED'});assert.equal(f.requests.length,0);
  await assert.rejects(f.runtime.runAgent({...f.options,model:'native',inputImages:[{imageUrl:'https://example.com/private.png'}]}),{code:'INVALID_INPUT_IMAGES'});
});
test('fragmented streaming echoes are sanitized before any event, output, or durable transcript',async t=>{
  const f=await fixture(t,'compatible',{echo:true,stream:true}),result=await f.runtime.runAgent({...f.options,inputImages:[{imageUrl}]});
  assert.equal(result.output,'echo [image data omitted]');assert.equal(JSON.stringify(f.events).includes(imageUrl.split(',')[1]),false);
  assert.equal((await readFile(f.runtime.threadFile(result.threadId),'utf8')).includes(imageUrl.split(',')[1]),false);
  assert.deepEqual(f.events.filter(e=>e.type==='delta').map(e=>e.delta),['echo [image data omitted]']);
});
test('upstream image rejection remains an error and never leaks an echoed data payload',async t=>{
  const f=await fixture(t,'openai',{fail:true});await assert.rejects(f.runtime.runAgent({...f.options,inputImages:[{imageUrl}]}),failure=>{assert.equal(failure.message.includes(imageUrl),false);assert.match(failure.message,/image data omitted/);return true;});assert.equal(f.requests.length,1);
});
test('explicit upstream model vision rejection is reported truthfully without a text-only retry',async t=>{
  const f=await fixture(t,'compatible',{fail:true,failureMessage:'This model does not support image inputs.'});await assert.rejects(f.runtime.runAgent({...f.options,inputImages:[{imageUrl}]}),{code:'INPUT_IMAGES_UNSUPPORTED'});assert.equal(f.requests.length,1);
});
test('exact known raw base64 echoes are removed from complete output, streaming events, history and failure status',async t=>{
  const raw=imageUrl.split(',')[1],f=await fixture(t,'compatible',{echo:true,rawEcho:true,stream:true});
  const result=await f.runtime.runAgent({...f.options,inputImages:[{imageUrl}]});assert.equal(result.output,'echo [image data omitted]');assert.equal(JSON.stringify(f.events).includes(raw),false);assert.equal((await readFile(f.runtime.threadFile(result.threadId),'utf8')).includes(raw),false);
  const denied=await fixture(t,'openai',{fail:true,failureMessage:'Invalid PNG source bytes '+raw});await assert.rejects(denied.runtime.runAgent({...denied.options,inputImages:[{imageUrl}]}),e=>{assert.equal(e.message.includes(raw),false);return true;});assert.equal(JSON.stringify(denied.runtime.status()).includes(raw),false);
});
test('long and upstream-truncated known raw image echoes are redacted before bounded diagnostic storage',async t=>{
  const url=paddedUrl(5000),raw=url.split(',')[1],images=[{imageUrl:url}];
  for(const echoed of [raw,raw.slice(0,2100),raw.slice(200,2400)]){
    const f=await fixture(t,'openai',{fail:true,failureMessage:'PNG source '+echoed});
    await assert.rejects(f.runtime.runAgent({...f.options,inputImages:images}),failure=>{assert.equal(failure.message.includes(echoed.slice(0,100)),false);assert.match(failure.message,/image data omitted/);return true;});assert.equal(JSON.stringify(f.runtime.status()).includes(echoed.slice(0,100)),false);
  }
  const unrelated='abcdefghijklmnopqrstuvwxyz0123456789UNRELATED';assert.equal(redactInputImageData(unrelated,images),unrelated,'unrelated base64-like identifiers are preserved');
});
