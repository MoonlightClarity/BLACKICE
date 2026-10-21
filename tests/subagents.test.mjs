import test from 'node:test';
import assert from 'node:assert/strict';
import { createSubagentToolHandler, SUBAGENT_TOOL, verbosityInstruction } from '../lib/subagents.mjs';

const delegate = tasks => ({ name: SUBAGENT_TOOL.name, arguments: { tasks: tasks.map(id => ({ id, prompt: 'Work only on independent part ' + id })) } });
const receipt = value => JSON.parse(value.contentItems[0].text);

test('subagents run bounded parallel work with inherited model, workspace, ephemeral history and explicit outcomes', async () => {
  let active=0, peak=0; const calls=[], events=[];
  const runtime={async runAgent(options){
    active++;peak=Math.max(active,peak);calls.push(options);
    await new Promise(resolve=>setTimeout(resolve,12));
    active--;
    return {output:'Completed assigned part: '+options.prompt.match(/YOUR ASSIGNED TASK:\n(.*)/)?.[1]};
  }};
  const handler=createSubagentToolHandler({runtime,cwd:'C:\\work',model:'codex-model',effort:'high',maxParallel:2,runInput:'Original request',verbosity:'detailed',onEvent:event=>events.push(event)});
  const result=receipt(await handler(delegate(['one','two','three','four','five'])));
  assert.equal(result.completed,5);assert.equal(result.maxParallel,2);assert.equal(result.allCompleted,true);
  assert.equal(peak,2);assert.equal(calls.length,5);
  assert.ok(calls.every(call=>call.cwd==='C:\\work' && call.model==='codex-model' && call.effort==='high' && call.codexHistory==='relay'));
  assert.ok(calls.every(call=>call.prompt.includes('Original request') && call.prompt.includes('thorough')));
  assert.ok(events.filter(event=>event.status==='completed').length===5);
  assert.ok(result.results.every(item=>item.status==='completed'&&item.output.includes(item.id)));
});

test('delegation validates tasks and enforces cumulative 12-child cap without additional calls', async () => {
  let calls=0;const handler=createSubagentToolHandler({runtime:{runAgent:async()=>{calls++;return {output:'done'};}},cwd:'C:\\work'});
  const invalid=receipt(await handler({name:SUBAGENT_TOOL.name,arguments:{tasks:[{id:'a',prompt:'one'},{id:'a',prompt:'two'}]}}));
  assert.match(invalid.error,/unique/);assert.equal(calls,0);
  const first=receipt(await handler(delegate(['a','b','c','d','e','f','g','h'])));
  assert.equal(first.completed,8);
  const second=receipt(await handler(delegate(['i','j','k','l'])));
  assert.equal(second.completed,4);assert.equal(calls,12);
  const capped=receipt(await handler(delegate(['m'])));
  assert.match(capped.error,/room for 0/);assert.equal(calls,12);
});

test('failed children are explicit while completed siblings remain available', async () => {
  const handler=createSubagentToolHandler({runtime:{runAgent:async({prompt})=>{
    if(prompt.includes('independent part broken'))throw Error('model unavailable');
    return {output:'useful result'};
  }},cwd:'C:\\work'});
  const response=receipt(await handler(delegate(['good','broken'])));
  assert.equal(response.allCompleted,false);assert.equal(response.completed,1);
  assert.equal(response.results[0].status,'completed');
  assert.equal(response.results[1].status,'failed');
  assert.match(response.results[1].error,/model unavailable/);
});

test('cancellation reaches children and queued work is never reported as complete', async () => {
  const controller=new AbortController();
  let started=0;
  const handler=createSubagentToolHandler({runtime:{runAgent:options=>new Promise((resolve,reject)=>{
    started++;
    options.signal.addEventListener('abort',()=>reject(Object.assign(Error('stopped'),{name:'AbortError'})),{once:true});
  })},cwd:'C:\\work',signal:controller.signal,maxParallel:1});
  const pending=handler(delegate(['first','second','third']));
  for(let attempts=0;attempts<30&&started===0;attempts++)await new Promise(resolve=>setTimeout(resolve,2));
  controller.abort();
  const result=receipt(await pending);
  assert.equal(started,1);
  assert.deepEqual(result.results.map(item=>item.status),['cancelled','not-started','not-started']);
  assert.equal(result.allCompleted,false);
});

test('no recursive tool is supplied to children, and verbosity is a default rather than an override', async () => {
  let childTools=[];
  const handler=createSubagentToolHandler({runtime:{runAgent:async options=>{childTools=options.dynamicTools;return {output:'done'};}},cwd:'C:\\work',createTools:()=>({tools:[{name:'relay_workspace'}],onToolCall:()=>({})})});
  assert.equal(receipt(await handler(delegate(['a']))).completed,1);
  assert.deepEqual(childTools.map(tool=>tool.name),['relay_workspace']);
  assert.match(verbosityInstruction('concise'),/brief/);
  assert.match(verbosityInstruction('detailed'),/thorough/);
  assert.match(verbosityInstruction('balanced'),/specific instruction in the current user request takes precedence/);
});

test('child execution receipts retain measured usage and distinguish failed tool calls from successful ones', async () => {
  const events=[];
  const handler=createSubagentToolHandler({runtime:{runAgent:async options=>{
    options.onEvent({type:'thread',model:'actual-model'});
    options.onEvent({type:'tool.result',tool:'relay_workspace',success:false});
    options.onEvent({type:'tool.result',tool:'relay_workspace',success:true});
    return{output:'Recovered and checked the file.',threadId:'child-thread',turnId:'child-turn',usage:{inputTokens:42,outputTokens:8,totalTokens:50,cachedInputTokens:0,reasoningOutputTokens:3,total:{secret:'excluded'}}};
  }},cwd:'C:\\work',onEvent:event=>events.push(event)});
  const outcome=receipt(await handler(delegate(['checked']))).results[0];
  assert.equal(outcome.status,'completed');
  assert.equal(outcome.threadId,'child-thread');assert.equal(outcome.turnId,'child-turn');assert.equal(outcome.model,'actual-model');
  assert.deepEqual(outcome.usage,{inputTokens:42,outputTokens:8,totalTokens:50,cachedInputTokens:0,reasoningOutputTokens:3});
  assert.deepEqual(outcome.toolSummary,{completed:1,failed:1});
  assert.ok(events.some(event=>event.status==='tool-failed'&&event.success===false));
  assert.ok(events.some(event=>event.status==='tool-completed'&&event.success===true));
  assert.deepEqual(events.find(event=>event.status==='completed').usage,outcome.usage);
});

test('a child resolving during cancellation is cancelled and cannot produce a completed receipt', async () => {
  const controller=new AbortController(),events=[];
  const handler=createSubagentToolHandler({runtime:{runAgent:async options=>{
    options.onEvent({type:'thread',threadId:'observed-thread',model:'actual-model'});
    options.onEvent({type:'tool.result',tool:'relay_workspace',success:true});
    controller.abort();return{output:'Late result',threadId:'observed-thread',turnId:'late-turn',usage:{inputTokens:25,outputTokens:5,totalTokens:30}};
  }},cwd:'C:\\work',signal:controller.signal,maxParallel:1,onEvent:event=>events.push(event)});
  const result=receipt(await handler(delegate(['started','queued'])));
  assert.deepEqual(result.results.map(item=>item.status),['cancelled','not-started']);
  assert.equal(result.completed,0);assert.equal(result.allCompleted,false);
  const cancelled=result.results[0];assert.equal(cancelled.threadId,'observed-thread');assert.equal(cancelled.turnId,'late-turn');assert.equal(cancelled.model,'actual-model');assert.deepEqual(cancelled.usage,{inputTokens:25,outputTokens:5,totalTokens:30});assert.deepEqual(cancelled.toolSummary,{completed:1,failed:0});assert.equal(cancelled.output,undefined);
  assert.ok(!events.some(event=>['completed','cancelled'].includes(event.status)),'parent abort still suppresses late UI events');
  assert.deepEqual(result.results[1],{id:'queued',status:'not-started',error:'Delegation stopped before this task began.'});
});

test('failed children retain observed runtime IDs, usage and tool outcomes in both result and terminal event', async () => {
  const events=[];
  const handler=createSubagentToolHandler({runtime:{runAgent:async options=>{
    options.onEvent({type:'thread',threadId:'failed-thread',model:'actual-failed-model'});
    options.onEvent({type:'turn',threadId:'failed-thread',turnId:'failed-turn',status:'inProgress'});
    options.onEvent({type:'usage',usage:{inputTokens:100,outputTokens:23,totalTokens:123,cachedInputTokens:0,total:{private:'excluded'}}});
    options.onEvent({type:'tool.result',tool:'relay_workspace',success:true});
    options.onEvent({type:'tool.result',tool:'relay_workspace',success:false});
    options.onEvent({type:'thread',threadId:'invalid/thread',turnId:'invalid/turn',model:'',usage:{inputTokens:-1,totalTokens:'not-a-count'}});
    throw Error('Connection failed after measured execution.');
  }},cwd:'C:\\work',onEvent:event=>events.push(event)});
  const returned=await handler(delegate(['failed'])),result=receipt(returned),child=result.results[0],terminal=events.find(event=>event.status==='failed');
  assert.equal(returned.success,false);assert.equal(result.completed,0);assert.equal(result.allCompleted,false);assert.equal(child.status,'failed');assert.equal(child.output,undefined);assert.match(child.error,/Connection failed/);
  const execution={threadId:'failed-thread',turnId:'failed-turn',model:'actual-failed-model',usage:{inputTokens:100,outputTokens:23,totalTokens:123,cachedInputTokens:0},toolSummary:{completed:1,failed:1}};
  for(const [key,value] of Object.entries(execution)){assert.deepEqual(child[key],value);assert.deepEqual(terminal[key],value);}
  assert.equal(terminal.message,child.error);assert.equal(terminal.durationMs,child.durationMs);assert.ok(Number.isSafeInteger(child.durationMs)&&child.durationMs>=0);assert.ok(!events.some(event=>event.status==='completed'));assert.ok(!JSON.stringify(result).includes('private'));
});

test('tool-call cancellation records the child evidence while leaving queued children unstarted', async () => {
  const controller=new AbortController(),events=[];
  const handler=createSubagentToolHandler({runtime:{runAgent:async options=>{
    options.onEvent({type:'thread',threadId:'cancelled-thread',turnId:'cancelled-turn',model:'actual-model'});
    options.onEvent({type:'usage',usage:{inputTokens:12,outputTokens:3,totalTokens:15}});
    options.onEvent({type:'tool.result',tool:'relay_workspace',success:false});
    controller.abort();throw Object.assign(Error('The delegate call was stopped.'),{code:'ABORT_ERR'});
  }},cwd:'C:\\work',maxParallel:1,onEvent:event=>events.push(event)});
  const returned=await handler(delegate(['started','queued']),{signal:controller.signal}),result=receipt(returned),child=result.results[0],terminal=events.find(event=>event.status==='cancelled');
  assert.equal(returned.success,false);assert.deepEqual(result.results.map(value=>value.status),['cancelled','not-started']);assert.equal(child.output,undefined);assert.equal(result.completed,0);
  assert.equal(child.threadId,'cancelled-thread');assert.equal(child.turnId,'cancelled-turn');assert.deepEqual(child.usage,{inputTokens:12,outputTokens:3,totalTokens:15});assert.deepEqual(child.toolSummary,{completed:0,failed:1});
  assert.equal(terminal.threadId,child.threadId);assert.equal(terminal.turnId,child.turnId);assert.deepEqual(terminal.usage,child.usage);assert.deepEqual(terminal.toolSummary,child.toolSummary);assert.equal(terminal.durationMs,child.durationMs);assert.ok(!events.some(event=>event.status==='completed'));
  assert.deepEqual(result.results[1],{id:'queued',status:'not-started',error:'Delegation stopped before this task began.'});
});
