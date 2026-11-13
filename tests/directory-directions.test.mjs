import test from 'node:test';
import assert from 'node:assert/strict';
import {createDirectoryDirections} from '../lib/directory-directions.mjs';
test('queued before phase IDs, delivered only on acknowledgement and never twice',async()=>{
 const rows=[{text:'preserve work'}],calls=[];let release;
 const gate=new Promise(r=>release=r);
 const router=createDirectoryDirections({rows:()=>rows,runtime:{steerAgent:async(...args)=>{calls.push(args);await gate;return{accepted:true};}}});
 assert.equal((await router.steer(rows[0])).delivery,'queued');
 router.phase({directoryTurnId:'one',threadId:'private'});assert.equal(calls.length,0);
 router.phase({directoryTurnId:'one',turnId:'turn'});
 router.phase({directoryTurnId:'one',turnId:'turn'});
 await Promise.resolve();assert.equal(calls.length,1);assert.equal(rows[0].delivery.targets[0].status,'attempting');
 release();await router.close();assert.equal(rows[0].delivery.status,'delivered');
});
test('runtime queue is not delivery; failed request remains uncertain and is not replayed',async()=>{
 for(const result of ['queued','failure']){
  const row={text:'change'},rows=[row];let calls=0;
  const router=createDirectoryDirections({rows:()=>[],runtime:{steerAgent:async()=>{calls++;if(result==='failure')throw Error('lost acknowledgement');return{accepted:true,queued:true};}}});
  router.phase({directoryTurnId:'x',threadId:'private',turnId:'turn'});
  const receipt=await router.steer(row);
  assert.equal(receipt.queued,result==='queued');assert.notEqual(receipt.delivery,'delivered');
  assert.equal(row.delivery.status,result==='failure'?'uncertain':'queued');
  router.phase({directoryTurnId:'x',threadId:'private',turnId:'turn'});
  await router.steer(row);assert.equal(calls,1);await router.close();
 }
});
test('finished and aborted phases cannot receive directions',async()=>{
 let calls=0;const abort=new AbortController();
 const router=createDirectoryDirections({rows:()=>[],signal:abort.signal,runtime:{steerAgent:async()=>{calls++;return{accepted:true};}}});
 router.phase({directoryTurnId:'old',threadId:'old',turnId:'old'});
 router.phase({directoryTurnId:'old',finished:true});
 assert.equal((await router.steer({text:'new'})).queued,true);assert.equal(calls,0);
 router.phase({directoryTurnId:'new',threadId:'new',turnId:'new'});abort.abort();
 await assert.rejects(router.steer({text:'new'}),{code:'TURN_NOT_ACTIVE'});assert.equal(calls,0);await router.close();
});
test('all concurrent owned phases must acknowledge before delivered',async()=>{
 const row={text:'change'},calls=[];
 const router=createDirectoryDirections({rows:()=>[],runtime:{steerAgent:async id=>{calls.push(id);return{accepted:true,...(id==='b'?{queued:true}:{})};}}});
 router.phase({directoryTurnId:'a',threadId:'a',turnId:'1'});router.phase({directoryTurnId:'b',threadId:'b',turnId:'2'});
 const receipt=await router.steer(row);assert.deepEqual(calls,['a','b']);assert.equal(receipt.queued,true);await router.close();
});

test('persisted attempt precedes dispatch and provider rejection/mismatched turn are not delivery',async()=>{
 for(const expected of ['rejected','uncertain']){
  const row={text:'change'},events=[];
  const router=createDirectoryDirections({rows:()=>[],onDelivery:async row=>events.push(row.delivery.targets[0].status),
   runtime:{steerAgent:async()=>{assert.equal(events[0],'attempting');return expected==='rejected'?{accepted:false}:{accepted:true,turnId:'different'};}}});
  router.phase({directoryTurnId:'one',threadId:'private',turnId:'expected'});
  assert.equal((await router.steer(row)).delivery,expected);assert.equal(row.delivery.status,expected);await router.close();
 }
});
test('failed receipt persistence never dispatches and does not retry automatically',async()=>{
 const row={text:'change'};let calls=0;
 const router=createDirectoryDirections({rows:()=>[row],onDelivery:async()=>{throw Error('storage failed');},runtime:{steerAgent:async()=>{calls++;return{accepted:true};}}});
 router.phase({directoryTurnId:'one',threadId:'private',turnId:'expected'});
 await router.close();assert.equal(calls,0);assert.equal(row.delivery.targets[0].status,'attempting');
});

test('abort or finish during persistence does not send a stale direction',async()=>{
 for(const reason of ['abort','finish']){
  const row={text:'stop'},abort=new AbortController();let calls=0,router;
  router=createDirectoryDirections({signal:abort.signal,rows:()=>[],onDelivery:async()=>{
   if(reason==='abort')abort.abort();else router.phase({directoryTurnId:'a',finished:true});
  },runtime:{steerAgent:async()=>{calls++;return{accepted:true};}}});
  router.phase({directoryTurnId:'a',threadId:'a',turnId:'a'});await router.steer(row);
  assert.equal(calls,0);assert.equal(row.delivery.targets[0].status,'expired');await router.close();
 }
});
test('staggered phase IDs cannot produce premature delivered acknowledgement',async()=>{
 const row={text:'change'},rows=[row],calls=[];
 const router=createDirectoryDirections({rows:()=>rows,runtime:{steerAgent:async id=>{calls.push(id);return{accepted:true};}}});
 router.phase({directoryTurnId:'a'});router.phase({directoryTurnId:'b'});
 router.phase({directoryTurnId:'a',threadId:'a',turnId:'1'});
 // Wait for the first target to settle, with the second still awaiting IDs.
 await new Promise(r=>setImmediate(r));
 assert.equal(row.delivery.status,'queued');assert.deepEqual(calls,['a']);
 router.phase({directoryTurnId:'b',threadId:'b',turnId:'2'});
 await new Promise(r=>setImmediate(r));
 assert.equal(row.delivery.status,'delivered');assert.deepEqual(calls,['a','b']);await router.close();
});
test('Vibe queued acknowledgement without accepted is queued, never rejected or delivered',async()=>{
 const router=createDirectoryDirections({rows:()=>[],runtime:{steerAgent:async()=>({threadId:'vibe',queued:true})}});
 router.phase({directoryTurnId:'one',threadId:'vibe',turnId:'turn'});
 const row={text:'change'},result=await router.steer(row);
 assert.equal(result.delivery,'queued');assert.equal(row.delivery.targets[0].status,'queued');await router.close();
});

test('serialized in-flight claim is uncertain and recreated router never replays it',async()=>{
 const row={text:'preserve work'};let saved,release,calls=0;
 const gate=new Promise(r=>release=r);
 const router=createDirectoryDirections({rows:()=>[row],onDelivery:async row=>{saved=JSON.parse(JSON.stringify(row));},
  runtime:{steerAgent:async()=>{calls++;await gate;return{accepted:true};}}});
 router.phase({directoryTurnId:'a',threadId:'private',turnId:'turn'});
 await new Promise(r=>setImmediate(r));
 assert.equal(saved.delivery.status,'uncertain');assert.equal(saved.delivery.targets[0].status,'attempting');assert.equal(calls,1);
 let replay=0;const recovered=createDirectoryDirections({rows:()=>[saved],runtime:{steerAgent:async()=>{replay++;return{accepted:true};}}});
 recovered.phase({directoryTurnId:'a',threadId:'private',turnId:'turn'});
 const receipt=await recovered.steer(saved);assert.equal(receipt.delivery,'uncertain');assert.equal(receipt.queued,false);assert.equal(replay,0);
 await recovered.close();release();await router.close();
});
