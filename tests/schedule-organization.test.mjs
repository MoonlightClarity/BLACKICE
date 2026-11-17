import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { OperationsStore } from '../lib/operations.mjs';
import { changeScheduleOrganization as change, scheduleOrganization } from '../lib/schedule-organization.mjs';
test('old schedules need no migration and organization is cloned', () => {
  const value=scheduleOrganization(); assert.deepEqual(value,{revision:0,folders:[],assignments:{}});
  const copy=scheduleOrganization(value); copy.folders.push({id:'x'}); assert.equal(value.folders.length,0);
});
test('nested create, rename, move, cycle checks and non-destructive removal', () => {
  let value=change(null,{action:'create',name:'Research',expectedRevision:0},{id:'a'});
  value=change(value,{action:'create',name:'Daily',parentId:'a',expectedRevision:1},{id:'b'});
  value=change(value,{action:'assign',deploymentId:'job',folderId:'a',expectedRevision:2},{deploymentIds:['job']});
  assert.throws(()=>change(value,{action:'update',id:'a',name:'Research',parentId:'b',expectedRevision:3}),/inside itself/);
  assert.throws(()=>change(value,{action:'remove',id:'a',expectedRevision:1}),error=>error.status===409);
  value=change(value,{action:'update',id:'b',name:'Weekly',parentId:'a',expectedRevision:3});
  value=change(value,{action:'remove',id:'a',expectedRevision:4});
  assert.deepEqual(value.folders,[{id:'b',name:'Weekly',parentId:null}]); assert.deepEqual(value.assignments,{});
  assert.throws(()=>change(value,{action:'assign',deploymentId:'missing',expectedRevision:5}),/Schedule not found/);
});
test('folder persistence uses serialized store mutations without schedule or execution changes',async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'blackice-cron-folders-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const engine={listRuns:()=>[],on(){},off(){}},inbox={runNow(){throw Error('must not run')},getByEnqueueKey:()=>null,status:()=>({paused:false}),on(){},off(){}};
  const store=new OperationsStore({dataDir:dir,engine,inbox});
  await store.init(); store.kick=()=>{};
  t.after(()=>store.close());
  store.schedule=()=>{};
  const workflow={id:'cron-fixture',name:'Fixture',nodes:[{id:'input',type:'input'},{id:'agent',type:'agent',name:'Worker',prompt:'Synthetic only.',model:'fixture'},{id:'output',type:'output'}],edges:[{source:'input',target:'agent'},{source:'agent',target:'output'}],settings:{maxParallel:1}};
  const deployment=await store.create({name:'Retained schedule',input:'Synthetic fixture',cwd:dir,workflow,enabled:true,trigger:{type:'interval',everySeconds:3600}});
  await store.trigger(deployment.id,{idempotencyKey:'organization-fixture'});
  const original=structuredClone(store.state);
  assert.equal(original.jobs.length,1);
  let value=await store.organizeSchedules({action:'create',name:'Top',expectedRevision:0});
  const id=value.folders[0].id;
  const results=await Promise.allSettled([
    store.organizeSchedules({action:'create',name:'Child',parentId:id,expectedRevision:1}),
    store.organizeSchedules({action:'create',name:'Concurrent',expectedRevision:1})
  ]);
  assert.equal(results.filter(item=>item.status==='fulfilled').length,1);
  assert.equal(results.find(item=>item.status==='rejected').reason.status,409);
  const saved=JSON.parse(await readFile(path.join(dir,'operations.json'),'utf8'));
  assert.equal(saved.organization.folders.length,2);
  assert.deepEqual(saved.deployments,original.deployments); assert.deepEqual(saved.jobs,original.jobs); assert.deepEqual(saved.settings,original.settings);
  assert.deepEqual(store.snapshot().organization,saved.organization);
  await store.organizeSchedules({action:'assign',deploymentId:deployment.id,folderId:id,expectedRevision:2});
  assert.deepEqual(store.state.deployments,original.deployments);assert.deepEqual(store.state.jobs,original.jobs);
});
