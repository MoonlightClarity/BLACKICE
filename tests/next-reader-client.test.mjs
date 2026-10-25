import test from 'node:test';
import assert from 'node:assert/strict';
import {createConversationReader} from '../public/next/chat/reader-client.mjs';

class ReaderWorker {
  constructor(){this.events={};this.messages=[];this.terminated=false;ReaderWorker.last=this;}
  addEventListener(type,handler){this.events[type]=handler;}
  postMessage(packet){
    this.messages.push(packet);
    if(packet.type==='load')queueMicrotask(()=>{
      this.events.message({data:{id:packet.id,ok:true,family:{
        rootId:packet.runId,runs:[{id:packet.runId,events:[],precomputedMessages:[{text:'Ready'}]}],
      }}});
    });
  }
  terminate(){this.terminated=true;}
}
test('real conversations are fetched and parsed only by the background worker',async()=>{
  let mainThreadRequests=0;
  const reader=createConversationReader({api:async()=>{mainThreadRequests++;throw Error('Main-thread API not allowed.');},
    WorkerClass:ReaderWorker});
  const result=await reader.load('saved-123');
  assert.equal(result.runs[0].id,'saved-123');
  assert.equal(reader.usingWorker,true);
  assert.equal(mainThreadRequests,0);
  assert.equal(ReaderWorker.last.messages[0].runId,'saved-123');
  reader.close();
  assert.equal(ReaderWorker.last.terminated,true);
});
test('history reader fails visibly instead of performing an unsafe giant JSON parse when no worker exists',async()=>{
  let mainThreadRequests=0;
  const reader=createConversationReader({api:async()=>{mainThreadRequests++;},WorkerClass:null});
  await assert.rejects(reader.load('saved-123'),/background conversation reader is unavailable/);
  assert.equal(mainThreadRequests,0);
  reader.close();
});
test('cancelled navigation cannot resurrect a stale conversation',async()=>{
  class Deferred {
    constructor(){this.events={};this.messages=[];this.terminated=false;}
    addEventListener(type,handler){this.events[type]=handler;}
    postMessage(value){this.messages.push(value);}
    terminate(){this.terminated=true;}
  }
  const reader=createConversationReader({WorkerClass:Deferred,timeoutMs:2000});
  const controller=new AbortController();
  const promise=reader.load('saved-123',{signal:controller.signal});
  controller.abort();
  await assert.rejects(promise,error=>error.name==='AbortError');
  reader.close();
});
test('invalid saved run identifiers are rejected without invoking a worker or API',async()=>{
  const reader=createConversationReader({WorkerClass:ReaderWorker});
  await assert.rejects(reader.load('../../sensitive'),/Invalid saved conversation/);
  assert.equal(ReaderWorker.last.messages.length,0);
  reader.close();
});
