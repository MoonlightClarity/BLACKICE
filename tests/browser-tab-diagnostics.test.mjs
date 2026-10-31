import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserTabDiagnostics, diagnosticText } from '../lib/browser-tab-diagnostics.mjs';
test('tab console evidence redacts common secrets and never retains URL paths, queries or auth headers', () => {
 const d = new BrowserTabDiagnostics({now:()=> 'fixture'});
 d.console({ level:'error', message:'TypeError failed https://user:password@example.com/private?token=secret Bearer abcdef password="hidden" sk-secretkey0123', sourceId:'https://example.com/script.js?key=private', lineNumber:7 });
 d.network('response', {id:4,url:'https://user:password@example.com/backend-api/conversation/private?token=secret',statusCode:200,resourceType:'xhr',requestHeaders:{Authorization:'private'},responseHeaders:{'set-cookie':'private'},body:'private'});
 d.network('failed', {id:4,url:'https://example.com/',error:'net::ERR_CONNECTION_RESET',resourceType:'xhr'});
 const s = d.snapshot(); assert.equal(s.events.length,3); assert.match(s.events[0].message,/TypeError/);
 assert.equal(s.events[1].route,'conversation'); assert.equal(s.events[1].status,200); assert.equal(s.events[2].error,'net::ERR_CONNECTION_RESET');
 assert.doesNotMatch(JSON.stringify(s),/hidden|secretkey|token=|private|abcdef|user:password|Authorization/);
});
test('tab diagnostics bound memory, cursors, returned copies, and reset', () => {
 const d = new BrowserTabDiagnostics({limit:2, now:()=> 'fixture'});
 for(let i=0;i<5;i++) d.lifecycle('loading-started');
 let s=d.snapshot({after:0,limit:1}); assert.equal(s.retained,2); assert.equal(s.dropped,3); assert.equal(s.cursor,4);assert.equal(s.hasMore,true);
 s.events[0].kind='mutated'; assert.equal(d.snapshot({after:3}).events[0].kind,'loading-started');
 assert.equal(d.snapshot({after:4}).events[0].sequence,5);
 assert.deepEqual(d.clear(),{clearedThrough:5}); s=d.snapshot(); assert.equal(s.retained,0);assert.equal(s.latestSequence,5);
 d.console({message:'x'.repeat(100000)}); assert.ok(d.snapshot().retainedBytes<2048);
 assert.throws(()=>d.snapshot({after:-1})); assert.throws(()=>d.snapshot({limit:257}));
});
test('unknown network errors are fixed labels and lifecycle details bounded',()=>{
 const d=new BrowserTabDiagnostics(); d.network('failed',{url:'https://example.test/private?secret=x',error:'private-secret'}); d.lifecycle('renderer-gone',{reason:'crashed',code:7});
 assert.equal(d.snapshot().events[0].error,'Network request failed'); assert.equal(d.snapshot().events[1].code,7);
 assert.equal(diagnosticText('cookie=secret-value'), '[secret omitted]');
});
