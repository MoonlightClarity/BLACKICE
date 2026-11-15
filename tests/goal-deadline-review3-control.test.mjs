import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {ConversationGoals} from '../lib/conversation-goals.mjs';

const deadline='2026-11-15T11:00:00.000Z', at=value=>Date.parse(value);
const signature='a'.repeat(64);
function fixture({deadlineAt=null,now=at('2026-11-15T10:59:59Z')}={}) {
  const clock={now,mono:0},controller=new AbortController(),cancelled=[];
  const saved={id:'fixture-goal',generation:1,revision:1,status:'active',objective:'Inspect an isolated fixture.',
    deadlineAt,deadlineTimeZone:deadlineAt?'EST':null,deadlineSource:deadlineAt?'explicit':null,
    deadlineExpiredAt:null,maxTurns:null,maxMinutes:null,turns:1,totalTurns:1,
    createdAt:'2026-11-15T10:00:00.000Z',activatedAt:'2026-11-15T10:00:00.000Z',
    currentRunId:'fixture-run',lastSettledRunId:null,dispatch:null};
  const run={id:'fixture-run',taskId:'fixture-root',status:'running',settled:false,goal:{id:saved.id,generation:1},goalEvidence:[]};
  const states={'fixture-root':{goal:saved,goalControlReceipts:[],
    goalUnresolvedEffects:[{id:'historical-unknown',signature,kind:'uncertain_external_effect',resolution:null}]}};
  const conversations={states,entries:new Map([['fixture-root',{}]]),
    changeState:async(id,patch)=>{Object.assign(states[id],patch);},
    family:async()=>({rootId:'fixture-root',state:'active',runs:[run]})};
  const engine=new EventEmitter();engine.runs=new Map([[run.id,run]]);engine.closed=false;
  engine.conversationBusy=()=>true; // The admitted current run is still active.
  engine.cancelRun=id=>{cancelled.push(id);controller.abort();run.status='cancelled';return run;};
  const goals=new ConversationGoals({engine,conversations,now:()=>clock.now,monotonicNow:()=>clock.mono,deadlinePollMs:50,continuationDelayMs:10});
  goals.listener=()=>{}; // no init side effects in this synthetic fixture
  return {clock,controller,run,states,engine,goals,cancelled};
}
const toolsAfterControl=async h=>{
  let dispatched=0;
  h.goals.assertProviderAdmission(h.run,{signal:h.controller.signal});
  const handler=h.goals.wrapTools(h.run,'agent',async()=>{dispatched++;return {success:true,contentItems:[{type:'inputText',text:'isolated in-memory result'}]};});
  const result=await handler({name:'fixture_read_only',arguments:{action:'read'}},{signal:h.controller.signal});
  assert.equal(result.success,true,JSON.stringify(result));
  assert.equal(dispatched,1);
};
const until=async(check,label)=>{
  const end=Date.now()+3000;
  while(Date.now()<end){if(check())return;await new Promise(done=>setTimeout(done,10));}
  assert.fail('No observed '+label);
};
test('pause_after_turn preserves admitted provider and subsequent tools without a deadline',async()=>{
  const h=fixture(),old=h.run.goal.generation;
  try{
    const paused=await h.goals.control('fixture-root',{action:'pause_after_turn',requestId:'finish-existing-turn'});
    assert.equal(paused.goal.status,'paused');
    assert.equal(paused.goal.generation,old+1);
    assert.equal(paused.goal.finishCurrentRunId,h.run.id);
    assert.equal(paused.goal.pauseRequest?.runId,undefined);
    await toolsAfterControl(h);
    assert.deepEqual(h.cancelled,[]);
    assert.equal(h.states['fixture-root'].goalUnresolvedEffects.length,1);
    h.run.status='completed';h.run.settled=true;
    await h.goals.settled('fixture-root',h.run);
    assert.equal(h.states['fixture-root'].goal.status,'paused');
    assert.equal(h.states['fixture-root'].goal.finishCurrentRunId,null);
    assert.equal(h.states['fixture-root'].goal.lastSettledRunId,h.run.id);
  }finally{await h.goals.close();}
});
test('ordinary objective update changes NEXT-turn generation, not the running provider or tools',async()=>{
  const h=fixture();
  try{
    const updated=await h.goals.control('fixture-root',{action:'update',objective:'Revised instructions for the next turn.',requestId:'edit-next-turn'});
    assert.equal(updated.goal.status,'active');
    assert.equal(updated.goal.generation,h.run.goal.generation+1);
    assert.equal(updated.goal.objective,'Revised instructions for the next turn.');
    await toolsAfterControl(h);
    assert.deepEqual(h.cancelled,[]);
    assert.equal(h.run.status,'running');
  }finally{await h.goals.close();}
});
test('active pause_after_turn remains subject to absolute deadline and cancels without replay',async()=>{
  const h=fixture({deadlineAt:deadline});
  try{
    const paused=await h.goals.control('fixture-root',{action:'pause_after_turn',requestId:'finish-until-deadline'});
    assert.equal(paused.goal.finishCurrentRunId,h.run.id);
    await toolsAfterControl(h); // work legitimately dispatched before cutoff
    h.clock.now=at(deadline);h.clock.mono+=1000;
    await until(()=>h.states['fixture-root'].goal.deadlineExpiredAt && h.cancelled.length===1,'deadline cancellation of the finishing turn');
    assert.equal(h.states['fixture-root'].goal.status,'paused');
    assert.equal(h.states['fixture-root'].goal.finishCurrentRunId,null);
    assert.equal(h.states['fixture-root'].goal.pauseRequest.mode,'deadline-interrupt-and-preserve');
    assert.equal(h.controller.signal.aborted,true);
    assert.throws(()=>h.goals.assertProviderAdmission(h.run,{signal:h.controller.signal}),e=>e.code==='ABORT_ERR');
    assert.equal(h.states['fixture-root'].goalUnresolvedEffects.length,1);
    assert.deepEqual(h.cancelled,[h.run.id]);
  }finally{await h.goals.close();}
});
test('next-turn objective edit still enforces the saved deadline on the original running turn',async()=>{
  const h=fixture({deadlineAt:deadline});
  try{
    const change=await h.goals.control('fixture-root',{action:'update',objective:'New objective for next turn.',requestId:'edit-before-cutoff'});
    assert.equal(change.goal.generation,2);
    await toolsAfterControl(h);
    h.clock.now=at(deadline);h.clock.mono+=1000;
    assert.throws(()=>h.goals.assertProviderAdmission(h.run,{signal:h.controller.signal}),e=>e.code==='GOAL_DEADLINE_EXPIRED');
    await until(()=>h.cancelled.length===1,'expired active run cancellation');
    assert.equal(h.states['fixture-root'].goal.status,'paused');
    assert.equal(h.states['fixture-root'].goalUnresolvedEffects.length,1);
  }finally{await h.goals.close();}
});
test('explicit interrupt-and-preserve is not mistaken for pause_after_turn',async()=>{
  const h=fixture();
  try{
    const paused=await h.goals.control('fixture-root',{action:'pause',requestId:'explicit-interrupt',pauseRunId:h.run.id});
    assert.equal(paused.goal.pauseRequest.runId,h.run.id);
    assert.equal(paused.goal.finishCurrentRunId,null);
    assert.deepEqual(h.cancelled,[h.run.id]);
    assert.throws(()=>h.goals.assertProviderAdmission(h.run,{signal:h.controller.signal}),e=>e.code==='ABORT_ERR');
    // Exact pending Pause receipt also denies if cancellation transport is delayed.
    h.run.status='running';h.controller.signal.onabort=null;
    assert.throws(()=>h.goals.assertProviderAdmission(h.run,{}),e=>e.code==='GOAL_PAUSE_PENDING');
  }finally{await h.goals.close();}
});
test('clear of a saved Goal leaves a previously admitted turn able to finish',async()=>{
  const h=fixture();
  try{
    await h.goals.control('fixture-root',{action:'clear',requestId:'clear-standing-goal'});
    assert.equal(h.states['fixture-root'].goal,null);
    await toolsAfterControl(h);
    assert.deepEqual(h.cancelled,[]);
  }finally{await h.goals.close();}
});
