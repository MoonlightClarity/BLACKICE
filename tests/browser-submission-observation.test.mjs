import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { BrowserSubmissionObservations, urlencodedFormPayloadDigest, validNativeSubmissionObservation } from '../desktop/browser-submission-observation.mjs';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const data = 'participantId=p1&workshopId=w1&email=a%40example.test';
const commit = extra => ({ method:'POST', enctype:'application/x-www-form-urlencoded', target:'_self',
  documentKey:'document:source:1', destinationKey:'destination:https://portal.test/a/enroll',
  effectKey:hash('effect'), payloadDigest:hash('controls'), requestPayloadDigest:urlencodedFormPayloadDigest(data), ...extra });
const arm = (tracker, extra = {}) => tracker.arm({ operationId:'op1', commit:commit(), sourceFrameId:'frame', sourceLoaderId:'before', sourceDocumentId:'source:1', ...extra });
const request = extra => ({ requestId:'r1', loaderId:'after', frameId:'frame', type:'Document',
  request:{method:'POST',url:'https://portal.test/a/enroll',postData:data,headers:{'Content-Type':'application/x-www-form-urlencoded'}}, ...extra });
const response = extra => ({ requestId:'r1',loaderId:'after',type:'Document',response:{url:'https://portal.test/a/enroll',status:200}, ...extra });
const current = extra => ({ frameId:'frame',loaderId:'after',documentId:'actual:2',url:'https://portal.test/a/enroll', ...extra });
function complete(tracker, req=request(), res=response()) {
  tracker.observe('Network.requestWillBeSent',req); tracker.observe('Network.responseReceived',res);
  tracker.observe('Network.loadingFinished',{requestId:req.requestId});
}
test('native form correlation requires actual matching request, response, completed body and new loader',()=>{
  const tracker=new BrowserSubmissionObservations(); assert.equal(arm(tracker),true);
  assert.deepEqual(tracker.current(current()),[]);
  tracker.observe('Network.requestWillBeSent',request()); assert.deepEqual(tracker.current(current()),[]);
  tracker.observe('Network.responseReceived',response()); assert.deepEqual(tracker.current(current()),[]);
  tracker.observe('Network.loadingFinished',{requestId:'r1'});
  assert.deepEqual(tracker.current(current({loaderId:'wrong'})),[]);
  const proof=tracker.current(current()); assert.equal(proof.length,1);
  assert.equal(validNativeSubmissionObservation(proof[0]),true);
  assert.equal(proof[0].operationId,'op1'); assert.equal(proof[0].requestPayloadDigest,commit().requestPayloadDigest);
  assert.equal(JSON.stringify(proof).includes('a@example.test'),false,'Only hashes and actual protocol identity are retained.');
  const restored=new BrowserSubmissionObservations(tracker.saved());
  assert.deepEqual(restored.current(current()),proof);
  assert.deepEqual(restored.current(current({documentId:'reloaded:9'})),[]);
});
test('fetch/XHR, wrong tenant, wrong payload, wrong frame and wrong content type cannot mimic native form navigation',()=>{
  const variants=[
    request({type:'Fetch'}), request({type:'XHR'}), request({frameId:'other-frame'}),
    request({request:{...request().request,url:'https://portal.test/b/enroll'}}),
    request({request:{...request().request,postData:data+'&extra=changed'}}),
    request({request:{...request().request,headers:{'Content-Type':'application/json'}}}),
    request({request:{...request().request,method:'GET'}}),
  ];
  for(const value of variants){const tracker=new BrowserSubmissionObservations();arm(tracker);complete(tracker,value);assert.deepEqual(tracker.current(current()),[]);}
});
test('ambiguous matching admissions and repeated native requests remain unverified',()=>{
  for(const mode of ['two-admissions','two-requests']){
    const tracker=new BrowserSubmissionObservations();arm(tracker);
    if(mode==='two-admissions')arm(tracker,{operationId:'op2'});
    complete(tracker);
    if(mode==='two-requests')complete(tracker,request({requestId:'r2'}),response({requestId:'r2'}));
    assert.deepEqual(tracker.current(current()),[]);
  }
});
test('loading failure and mismatched response do not confirm a partially received page',()=>{
  for(const mode of ['failed','loader','url']){
    const tracker=new BrowserSubmissionObservations();arm(tracker);
    complete(tracker,request(),response(mode==='loader'?{loaderId:'other'}:mode==='url'?{response:{url:'https://portal.test/unrelated',status:200}}:{}));
    if(mode==='failed')tracker.observe('Network.loadingFailed',{requestId:'r1'});
    assert.deepEqual(tracker.current(current()),[]);
  }
});
test('a real redirect chain retains the original POST identity and its final actual loader response',()=>{
  const tracker=new BrowserSubmissionObservations();arm(tracker);
  tracker.observe('Network.requestWillBeSent',request());
  tracker.observe('Network.requestWillBeSent',request({redirectResponse:{status:303},request:{method:'GET',url:'https://portal.test/a/thanks',headers:{}}}));
  tracker.observe('Network.responseReceived',response({response:{url:'https://portal.test/a/thanks',status:200}}));
  tracker.observe('Network.loadingFinished',{requestId:'r1'});
  const proof=tracker.current(current({url:'https://portal.test/a/thanks'}))[0];
  assert.equal(proof.destinationKey,'destination:https://portal.test/a/enroll');
  assert.equal(proof.responseUrl,'https://portal.test/a/thanks');
  assert.deepEqual(proof.redirects,[{url:'https://portal.test/a/thanks',method:'GET',status:303}]);
});
test('unsupported form transport and missing authoritative dispatch fields cannot arm a correlation',()=>{
  for(const extra of [{operationId:undefined},{commit:commit({method:'GET'})},{commit:commit({enctype:'multipart/form-data'})},
    {commit:commit({target:'_blank'})},{commit:commit({requestPayloadDigest:undefined})},{commit:commit({documentKey:'document:different'})}])
    assert.equal(arm(new BrowserSubmissionObservations(),extra),false);
});
test('urlencoded payload identity preserves duplicates, Unicode, exact field order and encoded values',()=>{
  assert.equal(urlencodedFormPayloadDigest('a=x+y&a=%E2%9C%93'),hash([['a','x y'],['a','✓']]));
  assert.notEqual(urlencodedFormPayloadDigest('a=1&b=2'),urlencodedFormPayloadDigest('b=2&a=1'));
  assert.notEqual(urlencodedFormPayloadDigest('text=a%0Ab'),urlencodedFormPayloadDigest('text=a%0D%0Ab'));
  assert.equal(urlencodedFormPayloadDigest('a=%E0%A4'),null);
});
test('restored correlation records remain bounded and never reuse the source document as a fresh response',()=>{
  const tracker=new BrowserSubmissionObservations();arm(tracker);complete(tracker);
  const value=tracker.current(current())[0];
  assert.equal(validNativeSubmissionObservation({...value,documentId:value.sourceDocumentId}),false);
  assert.equal(validNativeSubmissionObservation({...value,responseComplete:false}),false);
  assert.equal(validNativeSubmissionObservation({...value,redirects:Array.from({length:11},()=>({url:value.responseUrl,method:'GET',status:302}))}),false);
  assert.equal(new BrowserSubmissionObservations([{...value,effectKey:'invented'}]).saved().length,0);
});
