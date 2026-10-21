import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHarnessServer } from '../server.mjs';
import { recordFixturePlan } from './fixture-task-plan.mjs';

class Runtime extends EventEmitter {
  constructor({failStart = false} = {}) { super(); this.failStart = failStart; this.ready = false; this.starts = 0; this.calls = []; }
  status() { return {connected:this.ready,authenticated:this.ready,defaultModel:'reconnect-fixture',defaultModelAvailable:this.ready,models:[{id:'reconnect-fixture',model:'reconnect-fixture',available:this.ready}],activeTurns:0}; }
  async start() { this.starts++; if (this.failStart) throw Error('Owned fixture connection is unavailable.'); this.ready = true; this.emit('status', this.status()); return this.status(); }
  async runAgent(options) {
    assert.equal(this.ready, true, 'queued work must wait for a recovered connection');
    this.calls.push(options.prompt);
    await recordFixturePlan(options);
    return {output:'Owned reconnect fixture completed.',threadId:`reconnect-thread-${this.calls.length}`};
  }
  async close() { this.ready = false; }
}

const workflow = {
  id:'reconnect-fixture',name:'Reconnect fixture',
  nodes:[{id:'input',type:'input',name:'Task'},{id:'agent',type:'agent',name:'Agent',model:'reconnect-fixture',prompt:'Complete the local fixture.'},{id:'output',type:'output',name:'Result'}],
  edges:[{source:'input',target:'agent'},{source:'agent',target:'output'}],settings:{maxParallel:1},
};
const until = async (condition, label) => {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { if (await condition()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail(`Timed out waiting for ${label}`);
};

for (const paused of [false, true]) test(`successful reconnect wakes a persisted explicit queue while preserving ${paused ? 'the user pause and' : 'passive'} saved tasks`, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'blackice-reconnect-queue-'));
  const options = {port:0,dataDir:path.join(directory,'data'),defaultCwd:path.join(directory,'workspace'),autoAttachDesktop:false};
  let app, seed;
  t.after(async () => { await app?.close(); await seed?.close(); assert.equal(path.dirname(directory), path.resolve(tmpdir())); assert.match(path.basename(directory), /^blackice-reconnect-queue-/); await rm(directory,{recursive:true,force:true}); });

  seed = await createHarnessServer({...options,runtime:new Runtime()});
  await seed.learning.updateSettings({mode:'manual'});
  seed.inbox.delayMs = 60000;
  const saved = await seed.inbox.add({input:'Keep this task saved until I explicitly run it.',cwd:options.defaultCwd,workflow});
  const queued = await seed.inbox.queue({input:'Run this explicit queued conversation after recovery.',cwd:options.defaultCwd,workflow,enqueueKey:'reconnect:one-explicit-request'});
  assert.equal(seed.engine.listRuns().length, 0);
  await seed.close(); seed = null;

  const runtime = new Runtime({failStart:true});
  app = await createHarnessServer({...options,runtime});
  const url = await app.listen();
  const home = await fetch(url), cookie = home.headers.get('set-cookie').split(';',1)[0]; await home.arrayBuffer();
  const reconnect = async () => {
    const response = await fetch(url + '/api/runtime/reconnect',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:'{}'});
    return {status:response.status,data:await response.json()};
  };
  await until(() => runtime.starts === 1, 'failed startup');
  assert.equal(app.inbox.get(queued.id).status, 'queued');
  assert.equal(runtime.calls.length, 0);
  assert.equal(app.inbox.timer, null);

  const failed = await reconnect();
  assert.equal(failed.status, 400);
  assert.equal(runtime.calls.length, 0);
  assert.equal(app.inbox.timer, null, 'a failed reconnect cannot wake work');
  assert.equal(app.inbox.get(queued.id).status, 'queued');
  if (paused) await app.inbox.pause('User paused the owned queue before reconnecting.');
  runtime.failStart = false;
  const recovered = await reconnect();
  assert.equal(recovered.status, 200);
  assert.equal(recovered.data.connected, true);
  if (paused) {
    assert.equal(app.inbox.status().paused, true);
    assert.equal(app.inbox.timer, null);
    assert.equal(runtime.calls.length, 0);
    assert.equal(app.inbox.get(queued.id).status, 'queued');
    await app.inbox.resume();
  }
  await until(() => app.inbox.get(queued.id).status === 'completed', 'exactly one recovered queue execution');
  assert.equal(runtime.calls.length, 1);
  assert.equal(app.inbox.get(queued.id).attempts.length, 1);
  assert.equal(app.inbox.get(saved.id).status, 'queued');
  assert.equal(app.inbox.eligible(app.inbox.get(saved.id)), false);
  assert.equal(app.inbox.status().autoRun, false);
  assert.equal((await reconnect()).status, 200);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(runtime.calls.length, 1, 'repeated reconnect cannot duplicate the accepted request');
  assert.equal(app.inbox.get(saved.id).status, 'queued');
});
