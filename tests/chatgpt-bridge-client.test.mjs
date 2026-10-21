import test from 'node:test';
import assert from 'node:assert/strict';
import {BlackiceBridgeClient} from '../lib/chatgpt-bridge-client.mjs';

const localURL='http://127.0.0.1:4317';
const response=(value,{status=200,headers={}}={})=>({ok:status>=200&&status<300,status,headers:new Headers(headers),body:(async function*(){yield Buffer.from(typeof value==='string'?value:JSON.stringify(value));})()});
const connected=(fetchImpl,timeoutMs=15)=>{const client=new BlackiceBridgeClient({url:localURL,fetchImpl,timeoutMs});client.cookie='fixture-session';return client;};
const stalledBody=()=>({ok:true,status:200,body:(async function*(){yield Buffer.from('{');await new Promise(()=>{});})()});

for(const stage of ['headers','body'])test(`a local ${stage} deadline produces an actionable connector timeout without retrying`,async()=>{
  let calls=0,signal;
  const client=connected(async(_url,options)=>{calls++;signal=options.signal;return stage==='headers'?new Promise(()=>{}):stalledBody();});
  await assert.rejects(client.request('/api/chatgpt-bridge'),error=>{
    assert.equal(error.code,'CHATGPT_BRIDGE_TIMEOUT');assert.equal(error.status,504);assert.equal(error.timedOut,true);assert.equal(error.uncertain,false);
    assert.match(error.message,/^Connector timed out while waiting for BLACKICE/);assert.match(error.message,/saved status/);return true;
  });
  assert.equal(calls,1);assert.equal(signal.aborted,true);
});

test('a timeout after completion was saved leaves the result unknown and requires an explicit read',async()=>{
  const record={id:'fixture-request',status:'pending',revision:1},calls=[];let releaseBody;
  const client=connected(async(url,options)=>{
    calls.push({path:url.pathname,method:options.method});
    if(options.method==='POST'){
      Object.assign(record,{status:'completed',revision:2,answer:'Saved exactly once.'});
      return {ok:true,status:200,body:(async function*(){await new Promise(resolve=>{releaseBody=resolve;});yield Buffer.from(JSON.stringify(record));})()};
    }
    return response(record);
  });
  await assert.rejects(client.request('/api/chatgpt-bridge/requests/fixture-request/complete',{method:'POST',body:{revision:1,answer:'Saved exactly once.'}}),error=>{
    assert.equal(error.code,'CHATGPT_BRIDGE_TIMEOUT');assert.equal(error.uncertain,true);assert.match(error.message,/may have been saved/);assert.match(error.message,/do not repeat the task automatically/);return true;
  });
  assert.equal(calls.length,1,'the client does not replay the completion');
  const saved=await client.request('/api/chatgpt-bridge/requests/fixture-request');
  assert.equal(saved.status,'completed');assert.equal(saved.answer,'Saved exactly once.');assert.equal(saved.revision,2);
  releaseBody();await Promise.resolve();
  assert.deepEqual(calls.map(call=>call.method),['POST','GET'],'a late response cannot trigger another write');
});

test('a local session deadline does not claim that an undispatched mutation may have completed',async()=>{
  const paths=[],client=new BlackiceBridgeClient({url:localURL,timeoutMs:15,fetchImpl:async url=>{paths.push(url.pathname);return new Promise(()=>{});}});
  await assert.rejects(client.request('/api/chatgpt-bridge/requests',{method:'POST',body:{requestId:'fixture',prompt:'Pending task'}}),error=>error.code==='CHATGPT_BRIDGE_TIMEOUT'&&error.uncertain===false);
  assert.deepEqual(paths,['/health']);assert.equal(client.cookie,null);assert.equal(client.connecting,null);
});

test('non-deadline interruptions and connection failures are distinct from a connector timeout',async()=>{
  for(const [cause,code]of [[Object.assign(new Error('Interrupted'),{name:'AbortError'}),'CHATGPT_BRIDGE_INTERRUPTED'],[new TypeError('Connection refused'),'CHATGPT_BRIDGE_UNREACHABLE']]){
    let calls=0;const client=connected(async()=>{calls++;throw cause;});
    await assert.rejects(client.request('/api/chatgpt-bridge/requests',{method:'POST',body:{requestId:'fixture',prompt:'Pending task'}}),error=>{
      assert.equal(error.code,code);assert.equal(error.timedOut,false);assert.equal(error.uncertain,true);assert.equal(error.status,503);assert.doesNotMatch(error.message,/timed out/);return true;
    });
    assert.equal(calls,1);
  }
  const client=connected(async()=>response({error:'Request already completed.'},{status:409}));
  await assert.rejects(client.request('/api/chatgpt-bridge/requests/fixture/complete',{method:'POST',body:{revision:1,answer:'Other answer'}}),error=>error.status===409&&!error.timedOut&&!error.uncertain&&error.message==='Request already completed.');
});

test('successful transfers clear their deadline without later aborting the response',async()=>{
  let signal;const client=connected(async(_url,options)=>{signal=options.signal;return response({healthy:true});});
  assert.deepEqual(await client.request('/api/chatgpt-bridge'),{healthy:true});
  await new Promise(resolve=>setTimeout(resolve,30));assert.equal(signal.aborted,false);
});

test('only an explicit unauthorized response renews the local session before one retry',async()=>{
  const paths=[];let writes=0;
  const client=connected(async(url,options)=>{
    paths.push(url.pathname);
    if(url.pathname==='/health')return response({app:'relay-agent-harness',ok:true});
    if(url.pathname==='/')return response('<!doctype html>',{headers:{'set-cookie':`relay_session_4317=${'a'.repeat(64)}; HttpOnly; SameSite=Strict; Path=/`}});
    if(options.headers.Cookie==='fixture-session')return response({error:'Session expired.'},{status:401});
    writes++;return response({id:'fixture-request',status:'pending',revision:1});
  });
  const saved=await client.request('/api/chatgpt-bridge/requests',{method:'POST',body:{requestId:'fixture',prompt:'Pending task'}});
  assert.equal(saved.status,'pending');assert.equal(writes,1);
  assert.deepEqual(paths,['/api/chatgpt-bridge/requests','/health','/','/api/chatgpt-bridge/requests']);
});
