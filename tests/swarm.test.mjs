import test from'node:test';import assert from'node:assert/strict';import{mkdtemp,rm}from'node:fs/promises';import path from'node:path';import{tmpdir}from'node:os';import{HarnessEngine,validateWorkflow}from'../lib/engine.mjs';import{createSwarmWorkflow}from'../public/swarm-model.mjs';
// Keep every runtime call active until all requested specialists have entered.
// A deadline detects real under-admission without using elapsed time as proof of overlap.
function specialistBarrier(t, expected) {
 let entered=0,timer,release,reject;
 const ready=new Promise((resolve,fail)=>{release=resolve;reject=fail;});
 t.after(()=>{clearTimeout(timer);release();});
 return ()=>{
  entered++;
  if(entered===expected){clearTimeout(timer);release();}
  else if(entered===1)timer=setTimeout(()=>reject(new Error(`Only ${entered} of ${expected} specialists entered before any handoff.`)),10000);
  return ready;
 };
}
async function runSwarm(t, members, input) {
 const directory=await mkdtemp(path.join(tmpdir(),'relay-swarm-'));
 const graph=validateWorkflow(createSwarmWorkflow({id:'swarm-'+members,cwd:directory,members}));
 const coordinator=graph.nodes.find(node=>node.id===graph.planning.coordinatorNodeId);
 const expected=new Set(graph.nodes.filter(node=>node.type==='agent'&&node!==coordinator).map(node=>node.name));
 assert.equal(expected.size,members);
 const waitForSpecialists=specialistBarrier(t,members),started=new Set(),finished=new Set();
 let active=0,peak=0,coordinators=0;
 const handoff=name=>'Verified specialist result for '+name+'.';
 const runtime={status:()=>({connected:true,authenticated:true}),runAgent:async options=>{
  assert.notEqual(options.responseOnly,true,'No unrequested review or planning turn.');
  // Host authority now precedes the agent brief. Do not classify a coordinator as a specialist.
  const name=options.prompt.match(/^You are ([^\n]+)\.\n\nAGENT INSTRUCTIONS\n/m)?.[1];
  if(name===coordinator.name){
   coordinators++;
   assert.deepEqual(finished,expected,'Every specialist must return before synthesis starts.');
   for(const specialist of expected)assert.ok(options.prompt.includes(handoff(specialist)),specialist+' handoff was absent');
   return{output:'Verified synthesis',threadId:crypto.randomUUID()};
  }
  assert.ok(expected.has(name),'Unexpected specialist: '+name);
  assert.ok(!started.has(name),'Duplicate specialist: '+name);
  started.add(name);active++;peak=Math.max(active,peak);
  await waitForSpecialists();active--;finished.add(name);
  return{output:handoff(name),threadId:crypto.randomUUID()};
 }};
 const engine=await new HarnessEngine({runtime,dataDir:path.join(directory,'data'),defaultCwd:directory}).init();
 t.after(async()=>{await engine.close();assert.match(path.basename(directory),/^relay-swarm-/);await rm(directory,{recursive:true,force:true});});
 const run=engine.startRun({workflow:graph,input,planningMode:'off'});
 await engine.executions.get(run.id);
 const settled=engine.getRun(run.id);
 assert.equal(settled.status,'completed',settled.error);
 assert.equal(peak,members);
 assert.deepEqual(finished,expected);
 assert.equal(coordinators,1);
 assert.equal(settled.nodes.coordinator.status,'completed');
 return graph;
}

test('swarm engine runs independent specialists together and waits for every handoff before synthesis',async t=>{
 await runSwarm(t,3,'Inspect a harmless test task.');
});

test('user-sized swarms run more than four ready specialists and do not silently clamp invalid choices',async t=>{
 const graph=await runSwarm(t,48,'Check independent specialist handoffs.');
 assert.equal(graph.settings.maxParallel,48);
 assert.equal(graph.nodes.filter(node=>node.type==='agent').length,49);
 for(const members of [0,-1,2.5,NaN,Infinity])assert.throws(()=>createSwarmWorkflow({members}),/positive whole/);
 assert.equal(createSwarmWorkflow({members:1}).settings.maxParallel,1);
});
