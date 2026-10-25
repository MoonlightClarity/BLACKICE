import test from 'node:test';
import assert from 'node:assert/strict';
import { chatOptionChoices, validateChatOptions } from '../public/next/chat/options-model.mjs';
import { submitChat } from '../public/next/chat/send.mjs';
import { projectFamily } from '../public/next/chat/reader-model.mjs';

const status={
  defaultModel:'codex-reasoning',
  models:[
    {id:'codex-reasoning',providerId:'codex',available:true,
      displayName:'Codex for tests',supportedReasoningEfforts:['medium','high'],serviceTiers:['priority']},
    {id:'vendor::restricted',providerId:'vendor',available:true,supportsReasoningSelection:false},
  ],
};
test('V2 offers native model-specific reasoning and speed choices without false availability',()=>{
  const selected={model:'codex-reasoning',effort:'high',serviceTier:'fast',planningMode:'maximal'};
  const rows=chatOptionChoices(status,selected);
  assert.ok(rows.efforts.some(item=>item.id==='high'&&!item.disabled));
  assert.equal(rows.tiers.find(item=>item.id==='fast').disabled,false);
  assert.deepEqual(validateChatOptions(status,selected),selected);
  assert.throws(()=>validateChatOptions(status,{...selected,effort:'ultra'}),/does not offer|reasoning/i);
  assert.throws(()=>validateChatOptions(status,{model:'vendor::restricted',serviceTier:'fast'}),/Fast mode|Codex/i);
  assert.throws(()=>validateChatOptions(status,{model:'nonexistent'}),/available model/);
});
test('new workflow and continued thread retain the selected reasoning and fast tier',async()=>{
  const calls=[];
  const api=async(url,method,body)=>{
    calls.push({url,method,body});
    if(url==='/api/workflows')return body;
    if(url==='/api/runs')return{id:'fresh-run',taskId:'fresh-run',status:'running'};
    if(url.endsWith('/continue'))return{id:'continued-run',status:'running'};
    throw Error('Unexpected endpoint '+url);
  };
  const selected={model:'codex-reasoning',effort:'high',serviceTier:'fast',planningMode:'on'};
  const result=await submitChat({api,runs:[],task:'Analyze this case',cwd:'C:\\fixture',...selected});
  assert.equal(result.mode,'started');
  const node=calls[0].body.nodes.find(n=>n.id==='agent');
  assert.deepEqual({model:node.model,effort:node.effort,serviceTier:node.serviceTier},
    {model:'codex-reasoning',effort:'high',serviceTier:'fast'});
  const prior={id:'run-1',taskId:'run-1',status:'completed',settled:true,
    workflow:{nodes:[{id:'agent',type:'agent'}]},nodes:{agent:{status:'completed',threadId:'thread-1'}}};
  const continued=await submitChat({api,runs:[prior],task:'Compare against new evidence',...selected});
  assert.equal(continued.mode,'continued');
  const payload=calls.at(-1).body;
  assert.equal(payload.effort,'high');assert.equal(payload.serviceTier,'fast');
});
test('large execution trace is discarded while task milestones and artifact indexes remain',()=>{
  const run={id:'run-with-artifacts',taskId:'task-1',status:'completed',settled:true,
    input:'Return a report',workflow:{nodes:[{id:'agent',type:'agent',name:'Analyst'}]},
    nodes:{agent:{status:'completed',threadId:'thread-1',output:'Done'}},
    events:[{at:'2026-10-24T10:00:00Z',nodeId:'agent',data:{type:'tool.result',payload:'PRIVATE'.repeat(100000)}}],
    taskState:{taskId:'task-1',revision:3,goal:'Finish the report',
      steps:[{id:'step-a',title:'Investigate',status:'completed'}],
      artifacts:[{id:'artifact_11111111-1111-4111-8111-111111111111',title:'Report',fileName:'report.txt',size:200}],
      secretTrace:'do not copy',
    },
  };
  const result=projectFamily({runs:[run]});
  assert.equal(result.runs[0].events.length,0);
  assert.equal(result.runs[0].taskState.artifacts[0].fileName,'report.txt');
  assert.equal(result.runs[0].taskState.steps[0].title,'Investigate');
  assert.ok(JSON.stringify(result).length<4000,'UI projection should remain bounded.');
  assert.doesNotMatch(JSON.stringify(result),/PRIVATE|do not copy/);
  assert.equal(run.events.length,1,'Source is not mutated.');
});
