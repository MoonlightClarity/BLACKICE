// More difficult two-module coding/debugging fixture; synthetic, isolated, dependency-free.
const buggyLedger = [
 'export class EventLedger {',
 ' constructor(){this.streams=new Map();this.seen=new Map();}',
 ' version(stream){return (this.streams.get(stream)||[]).length;}',
 ' append(stream,event,expectedVersion){',
 '   if(!stream||!event?.id)throw Error("missing event identity");',
 '   const rows=this.streams.get(stream)||[];',
 '   if(expectedVersion!==undefined&&expectedVersion!==rows.length)throw Object.assign(Error("Version conflict"),{code:"VERSION_CONFLICT"});',
 '   if(this.seen.has(event.id))return this.seen.get(event.id);',
 '   const record={stream,id:event.id,sequence:rows.length+1,payload:event.payload};',
 '   rows.push(record);this.streams.set(stream,rows);this.seen.set(event.id,record);return record;',
 ' }',
 ' lookup(stream,id){return this.seen.get(id)||null;}',
 ' read(stream,{after=0,limit=100}={}){return (this.streams.get(stream)||[]).filter(e=>e.sequence>=after).slice(0,limit);}',
 '}',
 ].join('\n')+'\n';

const buggyProcessor = [
 "import {EventLedger} from './ledger.mjs';",
 'export class StreamProcessor {',
 ' constructor({ledger=new EventLedger(),apply}){this.ledger=ledger;this.apply=apply;}',
 ' async process(stream,event,{expectedVersion}={}){',
 '   const record=this.ledger.append(stream,event,expectedVersion);',
 '   await this.apply(event.payload,{stream,id:event.id,sequence:record.sequence});',
 '   return {record,duplicate:false};',
 ' }',
 '}',
 ].join('\n')+'\n';

const goldLedger = [
 'const validId=x=>typeof x==="string"&&x.trim().length>0;',
 'const fail=(code,message)=>Object.assign(Error(message),{code});',
 'const copy=x=>structuredClone(x);',
 'export class EventLedger {',
 ' constructor(){this.streams=new Map();}',
 ' validate(stream,event,expectedVersion){',
 '  if(!validId(stream)||!event||typeof event!=="object"||Array.isArray(event)||!validId(event.id)||!Object.hasOwn(event,"payload"))throw fail("EVENT_INVALID","Expected nonempty stream and event ID with a payload.");',
 '  if(expectedVersion!==undefined&&(!Number.isSafeInteger(expectedVersion)||expectedVersion<0))throw fail("VERSION_INVALID","Expected version must be nonnegative integer.");',
 ' }',
 ' rows(stream){return this.streams.get(stream)||[];}',
 ' version(stream){return this.rows(stream).length;}',
 ' lookup(stream,id){const row=this.rows(stream).find(r=>r.id===id);return row?copy(row):null;}',
 ' append(stream,event,expectedVersion){',
 '  this.validate(stream,event,expectedVersion);',
 '  const rows=this.rows(stream);',
 '  const old=rows.find(row=>row.id===event.id);',
 '  if(old)return copy(old);',
 '  if(expectedVersion!==undefined&&expectedVersion!==rows.length)throw fail("VERSION_CONFLICT","Version conflict.");',
 '  const row={stream,id:event.id,sequence:rows.length+1,payload:copy(event.payload)};',
 '  this.streams.set(stream,[...rows,row]);',
 '  return copy(row);',
 ' }',
 ' read(stream,{after=0,limit=100}={}){',
 '  if(!Number.isSafeInteger(after)||after<0||!Number.isSafeInteger(limit)||limit<1||limit>1000)throw fail("PAGINATION_INVALID","Invalid pagination.");',
 '  return copy(this.rows(stream).filter(row=>row.sequence>after).slice(0,limit));',
 ' }',
 '}',
 ].join('\n')+'\n';

const goldProcessor = [
 "import {EventLedger} from './ledger.mjs';",
 'const fail=(code,message)=>Object.assign(Error(message),{code});',
 'export class StreamProcessor {',
 ' constructor({ledger=new EventLedger(),apply}={}){',
 '  if(!ledger||typeof ledger.lookup!=="function"||typeof ledger.append!=="function"||typeof apply!=="function")throw fail("PROCESSOR_INVALID","Expected ledger and apply callback.");',
 '  this.ledger=ledger;this.apply=apply;this.queues=new Map();',
 ' }',
 ' process(stream,event,{expectedVersion}={}){',
 '  const previous=this.queues.get(stream)||Promise.resolve();',
 '  const work=previous.catch(()=>{}).then(async()=>{',
 '   if(typeof stream!=="string"||!stream.trim()||!event||typeof event!=="object"||Array.isArray(event)||typeof event.id!=="string"||!event.id.trim()||!Object.hasOwn(event,"payload"))throw fail("EVENT_INVALID","Invalid event.");',
 '   if(expectedVersion!==undefined&&(!Number.isSafeInteger(expectedVersion)||expectedVersion<0))throw fail("VERSION_INVALID","Invalid expected version.");',
 '   const old=this.ledger.lookup(stream,event.id);',
 '   if(old)return{record:old,duplicate:true};',
 '   const current=this.ledger.version(stream);',
 '   if(expectedVersion!==undefined&&expectedVersion!==current)throw fail("VERSION_CONFLICT","Version conflict.");',
 '   await this.apply(structuredClone(event.payload),{stream,id:event.id,sequence:current+1});',
 '   return{record:this.ledger.append(stream,event,expectedVersion),duplicate:false};',
 '  });',
 '  this.queues.set(stream,work.catch(()=>{}));',
 '  return work;',
 ' }',
 '}',
 ].join('\n')+'\n';

const publicTests = [
 "import test from 'node:test';import assert from 'node:assert/strict';",
 "import {EventLedger} from '../src/ledger.mjs';",
 "import {StreamProcessor} from '../src/processor.mjs';",
 "test('append increments per-stream sequence',()=>{const j=new EventLedger();assert.equal(j.append('A',{id:'x',payload:{v:1}}).sequence,1);assert.equal(j.append('A',{id:'y',payload:{v:2}}).sequence,2);});",
 "test('duplicate event ID does not append twice',()=>{const j=new EventLedger();j.append('A',{id:'x',payload:5});j.append('A',{id:'x',payload:5});assert.equal(j.version('A'),1);});",
 "test('process returns a committed record',async()=>{const j=new EventLedger();const p=new StreamProcessor({ledger:j,apply:async()=>{}});const result=await p.process('A',{id:'x',payload:1});assert.equal(result.record.sequence,1);});",
 "test('readSince uses exclusive after cursor',()=>{const j=new EventLedger();j.append('A',{id:'a',payload:1});j.append('A',{id:'b',payload:2});assert.deepEqual(j.read('A',{after:1}).map(r=>r.id),['b']);});",
 ].join('\n')+'\n';

const hiddenTests = [
 "import test from 'node:test';import assert from 'node:assert/strict';",
 "import {EventLedger} from '../src/ledger.mjs';",
 "import {StreamProcessor} from '../src/processor.mjs';",
 "const event=(id,payload={id})=>({id,payload});",
 "test('version starts at zero per stream',()=>{const j=new EventLedger();assert.equal(j.version('A'),0);assert.equal(j.version('B'),0);});",
 "test('different streams can use the same event ID',()=>{const j=new EventLedger();assert.equal(j.append('A',event('same')).sequence,1);assert.equal(j.append('B',event('same')).sequence,1);assert.equal(j.version('A'),1);assert.equal(j.version('B'),1);});",
 "test('duplicate returns original despite a conflicting expectedVersion',()=>{const j=new EventLedger();const x=j.append('A',event('id',{v:1}));const y=j.append('A',event('id',{v:999}),0);assert.deepEqual(y,x);assert.equal(j.version('A'),1);});",
 "test('optimistic version conflict rejects without side effects',()=>{const j=new EventLedger();j.append('A',event('one'),0);assert.throws(()=>j.append('A',event('two'),0),e=>e.code==='VERSION_CONFLICT');assert.equal(j.version('A'),1);});",
 "test('payload is cloned into journal and results are cloned back to caller',()=>{const j=new EventLedger();const payload={nested:{value:2}};const item=j.append('A',event('one',payload));payload.nested.value=99;item.payload.nested.value=500;assert.equal(j.lookup('A','one').payload.nested.value,2);const rows=j.read('A');rows[0].payload.nested.value=999;assert.equal(j.read('A')[0].payload.nested.value,2);});",
 "test('read cursor is exclusive and limit is enforced',()=>{const j=new EventLedger();for(let i=0;i<5;i++)j.append('A',event('e'+i));assert.deepEqual(j.read('A',{after:2,limit:2}).map(x=>x.sequence),[3,4]);});",
 "test('append validates IDs, payload presence and expected version',()=>{const j=new EventLedger();assert.throws(()=>j.append('',event('one')));assert.throws(()=>j.append('A',{id:'one'}));assert.throws(()=>j.append('A',event('one'),-1));assert.equal(j.version('A'),0);});",
 "test('read rejects invalid cursors instead of truncating silently',()=>{const j=new EventLedger();assert.throws(()=>j.read('A',{after:-1}));assert.throws(()=>j.read('A',{limit:0}));});",
 "test('separate streams do not block one another during async apply',async()=>{let release,started=[];const j=new EventLedger(),p=new StreamProcessor({ledger:j,apply:async(_v,m)=>{started.push(m.stream);if(m.stream==='A')await new Promise(resolve=>release=resolve);}});const first=p.process('A',event('a'));await new Promise(r=>setImmediate(r));const next=p.process('B',event('b'));await next;assert.deepEqual(started,['A','B']);release();await first;});",
 "test('same-stream writes are strictly serialized',async()=>{let release;const seq=[];const p=new StreamProcessor({ledger:new EventLedger(),apply:async(_v,m)=>{seq.push('start-'+m.id);if(m.id==='a')await new Promise(r=>release=r);seq.push('end-'+m.id);}});const a=p.process('A',event('a'));const b=p.process('A',event('b'));await new Promise(r=>setImmediate(r));assert.deepEqual(seq,['start-a']);release();await Promise.all([a,b]);assert.deepEqual(seq,['start-a','end-a','start-b','end-b']);});",
 "test('concurrent duplicate calls share the commit and apply once',async()=>{let release,calls=0;const j=new EventLedger(),p=new StreamProcessor({ledger:j,apply:async()=>{calls++;await new Promise(r=>release=r);}});const first=p.process('A',event('x'));const second=p.process('A',event('x'));await new Promise(r=>setImmediate(r));release();const [a,b]=await Promise.all([first,second]);assert.equal(calls,1);assert.equal(a.duplicate,false);assert.equal(b.duplicate,true);assert.equal(j.version('A'),1);});",
 "test('failed apply leaves no committed event and a later retry succeeds',async()=>{let calls=0;const j=new EventLedger(),p=new StreamProcessor({ledger:j,apply:async()=>{if(++calls===1)throw Error('transient');}});await assert.rejects(p.process('A',event('x')),/transient/);assert.equal(j.version('A'),0);await p.process('A',event('x'));assert.equal(j.version('A'),1);});",
 "test('failure in one queued event does not strand the next',async()=>{const j=new EventLedger(),p=new StreamProcessor({ledger:j,apply:async(_v,m)=>{if(m.id==='a')throw Error('failed');}});const first=p.process('A',event('a'));const next=p.process('A',event('b'));await assert.rejects(first,/failed/);await next;assert.deepEqual(j.read('A').map(x=>x.id),['b']);});",
 "test('duplicate committed event does not invoke apply again',async()=>{let count=0;const p=new StreamProcessor({ledger:new EventLedger(),apply:async()=>{count++;}});await p.process('A',event('x'));const copy=await p.process('A',event('x',{different:true}));assert.equal(copy.duplicate,true);assert.equal(count,1);});",
 "test('processor version conflict is checked before invoking apply',async()=>{let called=0;const j=new EventLedger();j.append('A',event('previous'));const p=new StreamProcessor({ledger:j,apply:async()=>{called++;}});await assert.rejects(p.process('A',event('next'),{expectedVersion:0}),e=>e.code==='VERSION_CONFLICT');assert.equal(called,0);});",
 "test('processor sees original input even when callback mutates its copy',async()=>{const j=new EventLedger(),p=new StreamProcessor({ledger:j,apply:async(payload)=>{payload.value=500;}});const payload={value:2};await p.process('A',event('x',payload));assert.equal(j.read('A')[0].payload.value,2);assert.equal(payload.value,2);});",
 "test('invalid events never call apply',async()=>{let calls=0;const j=new EventLedger(),p=new StreamProcessor({ledger:j,apply:async()=>{calls++;}});await assert.rejects(p.process('A',{id:'x'}));await assert.rejects(p.process('A',event('x'),{expectedVersion:-5}));assert.equal(calls,0);});",
].join('\n')+'\n';

export async function makeEventReplayTask(write,taskRoot) {
 await write('src/ledger.mjs',buggyLedger);
 await write('src/processor.mjs',buggyProcessor);
 await write('test/public.test.mjs',publicTests);
 await write('README.md',[
 '# EVENT-REPLAY: repair concurrent durable event handling',
 'This is a multi-module production-like debugging task, more difficult than the cache and scheduler fixtures.',
 'Fix src/ledger.mjs and src/processor.mjs; preserve the public exported classes EventLedger and StreamProcessor.',
 '',
 'EventLedger APIs: version(stream), append(stream, {id,payload}, expectedVersion?), lookup(stream,id), read(stream,{after=0,limit=100}={}).',
 'Each stream has an independent one-based sequence and version starting at zero. Event identity is scoped per stream.',
 'Duplicated event IDs are idempotent (same original entry) and must be recognized BEFORE a stale expectedVersion is checked.',
 'A new event with stale expectedVersion rejects without mutating the ledger.',
 'Keep JSON-like payloads immutable across callers: copy upon commit, lookup and read.',
 'Read after cursor is exclusive, ordered, with bounded limit; reject invalid parameters and event IDs/payloads.',
 '',
 'StreamProcessor APIs: new StreamProcessor({ledger,apply}); process(stream,{id,payload},{expectedVersion}={}) returns {record,duplicate}.',
 'Process calls for the SAME stream must be serialized in order, including async apply.',
 'Different streams can execute concurrently. Concurrent duplicate event IDs apply exactly once per stream.',
 'A failed apply must not commit a record or poison the stream queue; a later retry should succeed.',
 'Existing committed duplicates should not call apply again. Check optimistic version before calling apply.',
 'Pass a copy to apply so it cannot mutate the stored event.',
 '',
 'Run node --test to verify. Do not edit tests. The incident log mixes repeated observations, stale hypotheses and the relevant failure at its tail.',
 'Inspect tool results carefully, fix both modules, and report verified outcomes, not just intentions.',
 ].join('\n')+'\n');
 const log=['2026-11-23T01:00:00Z EVENT-REPLAY INCIDENT / cross-stream race'];
 for(let i=0;i<600;i++)log.push('2026-11-23T01:'+String(Math.floor(i/60)%60).padStart(2,'0')+':'+String(i%60).padStart(2,'0')+
  'Z stream='+['alpha','beta','gamma'][i%3]+' id=e'+i+' run='+Math.floor(i/4)+' observedVersion='+((i*7)%91)+
  ' note=retry; earlier model diagnosis was inconclusive. trace='+('normal-event-'.repeat(3)));
 log.push('2026-11-23T05:49:59Z DECISIVE DIAGNOSIS: duplicate id handled globally, append-before-apply commits failures, independent stream calls share no ordering; read cursor is inclusive and returned payloads are mutable.');
 await write('incident.log',log.join('\n')+'\n');
 return hiddenTests;
}

export async function applyEventReplayGold(write) {
 await write('src/ledger.mjs',goldLedger);
 await write('src/processor.mjs',goldProcessor);
}

export const EVENT_REPLAY_HIDDEN_COUNT=17;
