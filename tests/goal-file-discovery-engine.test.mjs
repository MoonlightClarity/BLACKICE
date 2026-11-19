import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {promises as fs} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {HarnessEngine} from '../lib/engine.mjs';
import {ConversationArchive} from '../lib/conversations.mjs';
import {ConversationGoals} from '../lib/conversation-goals.mjs';

const graph = {
  id: 'goal-file-discovery-engine-test', name: 'Goal file discovery engine test',
  nodes: [{id:'input',type:'input',name:'Input'}, {id:'agent',type:'agent',name:'Agent',model:'offline-fixture',prompt:'Find the synthetic target.'}, {id:'output',type:'output',name:'Output'}],
  edges: [{id:'in',source:'input',target:'agent'}, {id:'out',source:'agent',target:'output'}],
  settings: {planningMode:'off',maxParallel:1},
};

test('an automatic Goal turn follows a real empty filename-search page without exceeding its turn budget', {timeout:20000}, async t => {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'blackice-goal-discovery-engine-'));
  let engine, conversations, goals;
  t.after(async () => {
    try { await goals?.close(); }
    finally {
      try { await engine?.close(); }
      finally {
        try { await conversations?.close(); }
        finally { await fs.rm(dir, {recursive:true,force:true}); }
      }
    }
  });
  const cwd = path.join(dir,'workspace'), dataDir = path.join(dir,'data');
  const overrideCwd = path.join(dir,'outside'), searchRoot = path.join(overrideCwd,'nested');
  await fs.mkdir(cwd); await fs.mkdir(searchRoot, {recursive:true});
  const query = 'synthetic-resume-target.txt', target = path.join(searchRoot,query);
  await fs.writeFile(target,'Synthetic file; search is filename-only.');
  const pages = [];

  class Runtime extends EventEmitter {
    calls = []; defaultModel = 'offline-fixture';
    status() { return {connected:true,authenticated:true,defaultModel:this.defaultModel}; }
    async savedThreadModel() { return this.defaultModel; }
    async runAgent(options) {
      const run = [...engine.runs.values()].find(run => run.status === 'running');
      this.calls.push({id:run.id,automatic:run.goal.automatic});
      const n = this.calls.length;
      const find = args => options.onToolCall({name:'relay_find_files',arguments:args});
      let result;
      if (n === 1) {
        // Advance the clock only after opening the real directory, before reading its first entry.
        const now = Date.now, opendir = fs.opendir;
        let offset = 0;
        Date.now = () => now() + offset;
        fs.opendir = async (...args) => {
          const stream = await opendir(...args);
          if (args[0] === searchRoot) offset = 500;
          return stream;
        };
        try { result = await find({query,cwd:overrideCwd,path:searchRoot,timeoutMs:100}); }
        finally { Date.now = now; fs.opendir = opendir; }
      } else {
        assert.equal(n,2,'unexpected runtime admission after the Goal budget');
        assert.doesNotMatch(run.input,/execute a DIFFERENT feasible action/);
        const continuation = JSON.parse(run.input.match(/\(JSON\): ([^\r\n]+)/)[1]);
        assert.deepEqual(continuation,{query,cursor:pages[0].cursor,cwd:overrideCwd});
        result = await find({...continuation,timeoutMs:10000});
      }
      assert.equal(result.success,true,JSON.stringify(result));
      const page = JSON.parse(result.contentItems[0].text);
      pages.push(page);
      return {output:'Recorded a search observation, not a Goal completion claim.',threadId:'synthetic-goal-discovery-thread'};
    }
  }

  const runtime = new Runtime();
  engine = await new HarnessEngine({runtime,dataDir,defaultCwd:cwd}).init();
  conversations = await new ConversationArchive({dataDir,engine}).init();
  goals = await new ConversationGoals({engine,conversations,continuationDelayMs:10,retryDelayMs:10}).init();
  const task = 'Locate the synthetic filename and independently verify it before completing.';
  const first = engine.startRun({workflow:graph,input:{task,planningMode:'off',directoryMode:'off',goal:{objective:task,maxTurns:2}}});
  const deadline = Date.now() + 10000;
  let goal;
  do {
    goal = await goals.get(first.id);
    if (goal?.status === 'budget_exhausted' || goal?.status === 'blocked') break;
    await delay(10);
  } while (Date.now() < deadline);

  const family = await conversations.family(first.id);
  assert.equal(goal?.status,'budget_exhausted',JSON.stringify({goal,runs:family.runs.map(({status,error})=>({status,error}))}));
  assert.equal(goal.turns,2);
  assert.equal(goal.completionEvidence,null);
  assert.equal(goal.lastProgressBasis,'host_observed_search_coverage');
  assert.equal(goal.noProgressTurns,0);
  assert.deepEqual(family.runs.map(run=>[run.taskId,run.status,run.settled]),[[first.id,'completed',true],[first.id,'completed',true]]);
  assert.deepEqual(runtime.calls.map(call=>call.automatic),[false,true]);
  assert.equal(pages[0].stopReason,'time_budget');
  assert.equal(pages[0].searchComplete,false);
  assert.equal(pages[0].matches.length,0);
  assert.ok(pages[0].cursor);
  assert.deepEqual(pages[1].matches.map(match=>match.path),[target]);
  assert.ok(pages[1].scannedEntries > pages[0].scannedEntries);
  // Allow any erroneous queued successor time to reach the fake provider.
  await delay(75);
  assert.equal(runtime.calls.length,2);
  assert.equal(engine.executionStatus().activeRunCount,0);
});
