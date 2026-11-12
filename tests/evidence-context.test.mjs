import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createEvidenceStore,splitTextByCapacity} from '../lib/evidence-context.mjs';
import {estimateContextTokens} from '../lib/context.mjs';
import {CodexRuntime} from '../lib/codex.mjs';
import {PLANNING_RESPONSE_DISABLED_FEATURES} from '../lib/response-profile.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
async function fixture(t){const root=await mkdtemp(path.join(os.tmpdir(),'saved-evidence-context-'));t.after(()=>rm(root,{recursive:true,force:true}));return createEvidenceStore({root});}

test('capacity pages preserve all characters and account for serialized escaping without a fixed chunk cap',async()=>{
  const source=('A😀"\\\nB'.repeat(230))+'FINAL_SOURCE_VALUE';
  const fits=value=>Buffer.byteLength(JSON.stringify({source:value}),'utf8')<=91;
  const pages=await splitTextByCapacity(source,{fits});
  assert.ok(pages.length>1);assert.equal(pages.map(row=>row.text).join(''),source);
  let end=0;
  for(const page of pages){assert.equal(page.start,end);assert.equal(page.text,source.slice(page.start,page.end));assert.ok(fits(page.text));assert.doesNotMatch(page.text,/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);end=page.end;}
  assert.equal(end,source.length);
  assert.deepEqual(await splitTextByCapacity('😀',{fits:value=>value.length<=2}),[{start:0,end:2,text:'😀'}]);
  await assert.rejects(splitTextByCapacity('😀',{fits:value=>value.length<=1}),{code:'EVIDENCE_CONTEXT_CAPACITY'});
});

test('media projection preserves original bytes and separate repeated-operation identities',async t=>{
  const store=await fixture(t),imageUrl='data:image/png;base64,'+Buffer.from('opaque image fixture '.repeat(30000)).toString('base64');
  const result={success:true,contentItems:[{type:'inputText',text:'Observed receipt ACCEPT-9; image contents require inspection.'},{type:'inputImage',imageUrl}]};
  const original={records:[{id:'call-a',source:'host-dispatch-receipt',tool:'relay_browser',action:'screenshot',success:true,result},{id:'call-b',source:'host-dispatch-receipt',tool:'relay_browser',action:'screenshot',success:true,result:structuredClone(result)}]};
  const encoded=JSON.stringify(original),source=await store.save(original,{kind:'original-review'});
  const projected=await store.project(original,{sourceFile:source.file});
  assert.equal(JSON.stringify(original),encoded);assert.equal(await readFile(source.file,'utf8'),encoded);assert.equal(source.sha256,hash(encoded));
  assert.deepEqual(projected.value.records.map(row=>row.id),['call-a','call-b']);
  assert.ok(projected.value.records.every(row=>row.action==='screenshot'&&row.success));
  assert.equal(projected.mediaRefs.length,1);assert.equal(projected.duplicateRefs.length,1);
  assert.ok(JSON.stringify(projected.value).length<10000);assert.equal(JSON.stringify(projected.value).includes(imageUrl),false);
  const media=await store.handle({action:'read',ref:projected.mediaRefs[0].ref},{tokenBudget:3000});
  assert.equal(media.success,true);assert.equal(media.contentItems[1].type,'inputImage');assert.equal(media.contentItems[1].imageUrl,imageUrl);
  assert.equal(JSON.parse(media.contentItems[0].text).verified,false,'Saving media is not a claim that its pixels were verified');
  const repeated=await store.handle({action:'read',ref:projected.duplicateRefs[0].ref},{tokenBudget:Infinity});
  assert.equal(JSON.parse(JSON.parse(repeated.contentItems[0].text).text).contentItems[1].type,'savedImage');
  const rawReceipt=await store.handle({action:'read',ref:projected.duplicateRefs[0].original.ref,representation:'raw'},{tokenBudget:Infinity});
  assert.deepEqual(JSON.parse(JSON.parse(rawReceipt.contentItems[0].text).text),result);
});

test('scoped evidence reads return complete exact pages within capacity and reject unknown or changed artifacts',async t=>{
  const store=await fixture(t),source=('retained 😀 "value" \\\n'.repeat(240))+'SOURCE_TAIL',saved=await store.save(source,{kind:'source'});
  const parts=[];let offset=0;
  do{
    const response=await store.handle({action:'read',ref:saved.ref,offset},{tokenBudget:700});
    assert.equal(response.success,true);assert.ok(estimateContextTokens(response)<=700);
    const page=JSON.parse(response.contentItems[0].text);assert.equal(page.offset,offset);assert.equal(page.text,source.slice(page.offset,page.end));parts.push(page.text);offset=page.nextOffset;
  }while(offset!==null);
  assert.equal(parts.join(''),source);assert.ok(parts.length>1);
  for(const args of [{action:'read',ref:'../unobserved.json'},{action:'read',ref:saved.ref,path:'/unobserved.json'}])assert.equal((await store.handle(args)).success,false);
  await writeFile(saved.file,'"changed"');
  const changed=await store.handle({action:'read',ref:saved.ref},{tokenBudget:1000});assert.equal(changed.success,false);assert.equal(changed.code,'EVIDENCE_SOURCE_CHANGED');
});

test('native protected dispatch admits the saved-evidence reader and rejects unattached operations',async t=>{
  const store=await fixture(t),source='Exact native receipt NATIVE-EVIDENCE-17 😀',saved=await store.save(source,{kind:'source'});
  const cwd=process.cwd(),requests=[],replies=[],events=[],calls=[];
  const client=new CodexRuntime({command:process.execPath,cwd,nativeModelMetadata:false,runTimeoutMs:2000,
    spawnImpl(){throw Error('No native process may start during this adapter regression.');}});
  const child={};client.child=child;
  Object.assign(client.info,{connected:true,authenticated:true,defaultModel:'evidence-model',models:[{id:'evidence-model',model:'evidence-model'}]});
  client.start=async()=>client.status();client._send=message=>replies.push(structuredClone(message));
  let dispatchError;
  client._request=async(method,params={})=>{
    requests.push({method,params:structuredClone(params)});
    if(method==='config/read')return {config:{skills:{config:[]},plugins:{},mcp_servers:{},apps:{}}};
    if(method==='skills/list')return {data:[{cwd,skills:[],errors:[]}]};
    if(method==='experimentalFeature/list')return {data:PLANNING_RESPONSE_DISABLED_FEATURES.map(name=>({name,stage:'stable',enabled:!params.threadId})),nextCursor:null};
    if(method==='thread/start')return {thread:{id:'saved-evidence-thread',ephemeral:true},model:params.model,sandbox:{type:'readOnly',networkAccess:false},approvalPolicy:'never'};
    if(['thread/unsubscribe','turn/interrupt'].includes(method))return {};
    if(method==='turn/start'){
      setImmediate(async()=>{
        try{
          for(const [id,tool,args]of [
            ['unattached-operation','relay_browser',{action:'click'}],
            ['saved-evidence-read',store.tool.name,{action:'read',ref:saved.ref}],
          ])await client._serverRequest({id,method:'item/tool/call',params:{threadId:params.threadId,turnId:'saved-evidence-turn',callId:id,tool,arguments:args}});
        }catch(error){dispatchError=error;}
        client._notification('turn/completed',{threadId:params.threadId,turn:{id:'saved-evidence-turn',status:'completed',items:[
          {type:'agentMessage',id:'saved-evidence-answer',phase:'final_answer',text:'Native saved-source inspection finished.'},
        ]}});
      });
      return {turn:{id:'saved-evidence-turn',status:'inProgress'}};
    }
    throw Error('Unexpected synthetic native request '+method);
  };
  t.after(()=>{client.closing=true;client._connectionFailed(Object.assign(Error('Adapter fixture closed'),{code:'CODEX_CLOSED'}),child);});
  const result=await client.runAgent({cwd,model:'evidence-model',prompt:'Inspect the exact saved source.',hostOnlyTools:true,responseOnly:false,sandbox:'read-only',
    dynamicTools:[store.tool],onEvent:event=>events.push(event),onToolCall:async call=>{calls.push(call);return store.handle(call.arguments,{tokenBudget:2000});}});
  assert.equal(dispatchError,undefined);assert.equal(result.output,'Native saved-source inspection finished.');
  assert.deepEqual(requests.find(row=>row.method==='thread/start').params.dynamicTools,[store.tool]);
  assert.equal(calls.length,1,'Only the attached reader reaches the host dispatcher');assert.equal(calls[0].name,store.tool.name);
  const denied=replies.find(row=>row.id==='unattached-operation').result;assert.equal(denied.success,false);assert.match(denied.contentItems[0].text,/not attached/);
  const delivered=replies.find(row=>row.id==='saved-evidence-read').result;assert.equal(delivered.success,true);
  const page=JSON.parse(delivered.contentItems[0].text);assert.equal(page.text,source);assert.equal(page.sha256,saved.sha256);assert.equal(page.complete,true);
  assert.ok(events.some(event=>event.type==='tool.result'&&event.callId==='saved-evidence-read'&&event.success===true));
  assert.equal(hash(await readFile(saved.file)),saved.sha256,'The native read preserves the exact saved source');
});
