import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  deliveryTarget, visibleDeliveryTarget, newOutbound, queueOutbound,
  claimOutbound, finishOutbound, markLostOutbound, validOutbound, outboundDue,
  sendWebhook, sendHttpsWebhook, buildOutboundPayload, MAX_OUTBOUND_ATTEMPTS,
} from '../lib/cron-outbound.mjs';

const target={type:'webhook',url:'https://alerts.example.com/private/incoming-token?flow=nightly'};
const local={type:'webhook',url:'http://127.0.0.1:5678/internal/cron-results?key=original'};
const at=Date.parse('2026-10-27T13:00:00Z');
const job=()=>({
  id:'job-1',deploymentId:'schedule-1',deploymentName:'Daily briefing',
  status:'completed',createdAt:new Date(at).toISOString(),finishedAt:new Date(at+1000).toISOString(),
  definition:{deliveryTarget:target},
  delivery:{state:'available',outcome:'completed',sourceRunId:'run-1',
    preview:'Three verified findings.',previewTruncated:false,error:null},
  outbound:newOutbound('job-1',target,at),
});

test('delivery is opt-in and full URLs are visible without a host-only projection',()=>{
  assert.deepEqual(deliveryTarget(undefined),{type:'local'});
  assert.deepEqual(deliveryTarget(null),{type:'local'});
  assert.deepEqual(deliveryTarget({type:'local'}),{type:'local'});
  assert.equal(deliveryTarget(target).url,target.url);
  assert.equal(deliveryTarget(local).url,local.url);
  assert.deepEqual(visibleDeliveryTarget(target),{
    type:'webhook',url:target.url,host:'alerts.example.com',configured:true
  });
  assert.deepEqual(visibleDeliveryTarget(local),{
    type:'webhook',url:local.url,host:'127.0.0.1',configured:true
  });
  assert.deepEqual(visibleDeliveryTarget({type:'local'}),{type:'local'});
  assert.equal(newOutbound('job-1',target,at).url,target.url);
  assert.equal(newOutbound('job-2',local,at).url,local.url);
  for(const url of [
    'http://localhost:9229/result','http://10.1.2.3/private',
    'https://user:password@example.com:8443/api?token=secret#local',
  ]) assert.equal(deliveryTarget({type:'webhook',url}).url,url);
  for(const url of ['file:///C:/secrets','javascript:alert(1)','ftp://example.com/output']){
    assert.throws(()=>deliveryTarget({type:'webhook',url}),/HTTP|HTTPS|webhook/i,url);
  }
  assert.throws(()=>deliveryTarget({type:'webhook',url:target.url,extra:'value'}),/one HTTP/i);
});

test('outbound receipts, including destinations, survive terminal outcomes without hidden fields',()=>{
  const value=job();
  assert.equal(value.outbound.state,'waiting_result');
  assert.equal(outboundDue(value.outbound,at),false);
  assert.equal(claimOutbound(value,at),null);
  assert.equal(queueOutbound(value,at),true);
  assert.equal(queueOutbound(value,at),false);
  const claim=claimOutbound(value,at);
  const payload=JSON.parse(claim.payload);
  assert.equal(payload.outputPreview,'Three verified findings.');
  assert.equal(payload.runId,'run-1');
  assert.equal(claim.idempotencyKey,value.id);
  assert.equal(claim.target.url,target.url);
  assert.equal(value.outbound.url,target.url);
  assert.equal(value.outbound.state,'sending');
  assert.equal(validOutbound(value.outbound,value.id),true);
  assert.equal(JSON.stringify(payload).includes(target.url),false,
    'the remote payload remains a result, not a copy of local configuration');
});

test('confirmed success and ambiguous delivery remain distinct, with no silent replay',()=>{
  const success=job();queueOutbound(success,at);claimOutbound(success,at);
  assert.equal(finishOutbound(success,{state:'delivered',httpStatus:204},at+1000),true);
  assert.equal(success.outbound.state,'delivered');
  assert.equal(success.outbound.url,target.url);
  assert.equal(outboundDue(success.outbound,at+100000),false);
  assert.equal(finishOutbound(success,{state:'delivered'},at+1000),false);
  const uncertain=job();queueOutbound(uncertain,at);claimOutbound(uncertain,at);
  finishOutbound(uncertain,{state:'unknown',reason:'Could have reached remote'},at+1000);
  assert.equal(uncertain.outbound.state,'unknown');
  assert.equal(outboundDue(uncertain.outbound,at+500000),false);
});

test('bounded retries apply only when the request definitely was not sent',()=>{
  const value=job();queueOutbound(value,at);
  for(let i=0;i<MAX_OUTBOUND_ATTEMPTS;i++){
    const clock=at+(i===0?0:i===1?10000:70000),claim=claimOutbound(value,clock);
    assert.equal(claim.idempotencyKey,'job-1');
    finishOutbound(value,{state:'retryable',reason:'DNS unavailable'},clock);
  }
  assert.equal(value.outbound.state,'failed');
  assert.equal(value.outbound.attempts.length,MAX_OUTBOUND_ATTEMPTS);
  assert.equal(outboundDue(value.outbound,at+999999),false);
  const lost=job();queueOutbound(lost,at);claimOutbound(lost,at);
  assert.equal(markLostOutbound(lost,at+1000),true);
  assert.equal(lost.outbound.state,'unknown');
  assert.match(lost.outbound.error,/will not be replayed/);
  assert.equal(markLostOutbound(lost,at+2000),false);
  assert.equal(validOutbound(lost.outbound,lost.id),true);
});

function mockRequest(states,log){
  return (url,opts,callback)=>{
    const state=states.shift()||{status:202};
    const req=new EventEmitter();
    req.end=body=>{
      log.push({url:String(url),options:opts,body});
      if(state.error){
        const error=Object.assign(Error('Mock connection'),{code:state.error});
        queueMicrotask(()=>req.emit('error',error));
        return;
      }
      const response=new EventEmitter();
      response.statusCode=state.status;
      response.resume=()=>{};
      queueMicrotask(()=>{callback(response);queueMicrotask(()=>response.emit('end'));});
    };
    req.destroy=()=>{};
    return req;
  };
}

test('HTTP localhost and HTTPS destinations are sent to their exact original URLs',async()=>{
  const httpLog=[],httpsLog=[];
  const httpRequest=mockRequest([{status:202},{status:302}],httpLog);
  const httpsRequest=mockRequest([{status:204}],httpsLog);
  const input={payload:JSON.stringify({report:'test'}),idempotencyKey:'job-1'};
  const accepted=await sendWebhook({...input,target:local},{httpRequest,httpsRequest});
  assert.equal(accepted.state,'delivered');
  assert.equal(httpLog[0].url,local.url);
  assert.equal(httpLog[0].options.headers['Idempotency-Key'],'job-1');
  const redirected=await sendWebhook({...input,target:local},{httpRequest,httpsRequest});
  assert.equal(redirected.state,'rejected');
  assert.equal(redirected.httpStatus,302);
  const encrypted=await sendHttpsWebhook({...input,target},{httpRequest,httpsRequest});
  assert.equal(encrypted.state,'delivered');
  assert.equal(httpsLog[0].url,target.url);
});

test('pre-send errors can retry; an ambiguous status or socket outcome does not',async()=>{
  const sent=[];
  const input={target:local,payload:'{}',idempotencyKey:'job-1'};
  const httpRequest=mockRequest([{error:'ENOTFOUND'},{error:'ECONNRESET'},{status:503}],sent);
  const options={httpRequest};
  const unsent=await sendWebhook(input,options);
  assert.equal(unsent.state,'retryable');
  const ambiguous=await sendWebhook(input,options);
  assert.equal(ambiguous.state,'unknown');
  const possiblyProcessed=await sendWebhook(input,options);
  assert.equal(possiblyProcessed.state,'unknown');
  assert.equal(possiblyProcessed.httpStatus,503);
  assert.equal(sent.length,3);
});

test('cancellation before the request returns retryable and starts no transmission',async()=>{
  const controller=new AbortController();controller.abort();
  const calls=[];
  const result=await sendWebhook({target:local,payload:'{}',idempotencyKey:'job-1',signal:controller.signal},{
    httpRequest:()=>{calls.push('request');throw Error('must not send');},
  });
  assert.equal(result.state,'retryable');
  assert.equal(calls.length,0);
});

test('legacy saved outbound receipts without a URL are still readable',()=>{
  const receipt=newOutbound('job-1',target,at);
  delete receipt.url;
  assert.equal(validOutbound(receipt,'job-1'),true);
});
