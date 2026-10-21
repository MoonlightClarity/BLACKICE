import test from 'node:test';
import assert from 'node:assert/strict';
import {repeatTaskSeed} from '../public/repeat-task-model.mjs';
import {createSwarmWorkflow} from '../public/swarm-model.mjs';
import { selectPlanningEffort } from '../public/planning-mode.mjs';

test('a finished follow-up repeats the full original swarm recipe rather than a pruned continuation',()=>{
 const workflow=createSwarmWorkflow({id:'swarm',cwd:'C:\\original',model:'provider::chosen',members:5,pattern:'delivery'});workflow.nodes.find(node=>node.id==='coordinator').effort='ultra';workflow.settings.context={preset:'900k'};
 const original={id:'root',input:'Build and check the full product.',cwd:'C:\\original',workflow,attachmentIds:['source-file']};
 const completed={id:'followup',taskId:'root',status:'completed',settled:true,input:'Polish the footer.',cwd:'C:\\other',attachmentIds:['later-file'],workflow:{nodes:workflow.nodes.filter(node=>node.id==='coordinator')},taskState:{steps:[{id:'delivery',status:'done'}]}};
 const before=structuredClone(original),seed=repeatTaskSeed(completed,original);assert.equal(seed.input,original.input);assert.equal(seed.cwd,original.cwd);assert.deepEqual(seed.attachmentIds,['source-file']);assert.equal(seed.workflow.nodes.filter(node=>node.type==='agent').length,6);assert.equal(seed.workflow.nodes.find(node=>node.id==='coordinator').effort,'ultra');assert.deepEqual(seed.workflow.settings.context,{preset:'900k'});assert.equal(seed.repeatTask,true);assert.deepEqual(original,before);
 seed.workflow.nodes[0].name='Edited copy';seed.attachmentIds.push('copy-only');assert.deepEqual(original,before,'repeat draft must not mutate admitted history');
});

test('repeat setup rejects unfinished milestones, unregistered roots and unsettled work',()=>{
 const original={id:'root',cwd:'C:\\workspace',input:'Task',workflow:{nodes:[]}},completed={id:'run',taskId:'root',status:'completed',settled:true};
 assert.throws(()=>repeatTaskSeed({...completed,status:'running'},original),/Wait for this task/);assert.throws(()=>repeatTaskSeed({...completed,settled:false},original),/Wait for this task/);
 for(const status of ['active','pending','blocked'])assert.throws(()=>repeatTaskSeed({...completed,taskState:{steps:[{status}]}},original),/remaining milestones/);
 assert.throws(()=>repeatTaskSeed(completed,{...original,id:'another-task'}),/original task is unavailable/);assert.throws(()=>repeatTaskSeed(completed,{...original,input:'  '}),/original task is unavailable/);
});

test('quick completed work needs no artificial milestone record to become repeatable',()=>{
 const original={id:'root',cwd:'C:\\workspace',input:{task:'A small recurring check.'},workflow:{nodes:[]}},completed={...original,status:'completed',settled:true};
 assert.deepEqual(repeatTaskSeed(completed,original),{input:'A small recurring check.',cwd:original.cwd,workflow:{nodes:[]},attachmentIds:[],repeatTask:true});
});

test('a repeat recipe preserves the original accepted planning mode and explicit detail hint', () => {
 const original = { id: 'root', cwd: 'C:\\workspace', input: { task: 'Check the recurring report.', planningMode: 'on', planDetail: 'balanced' }, planningMode: 'off', planDetail: 'compact', workflow: { nodes: [], settings: { planningMode: 'maximal', planDetail: 'detailed', maxParallel: 3, context: { preset: '900k' } } } };
 const completed = { id: 'followup', taskId: 'root', status: 'completed', settled: true, planningMode: 'on' };
 const before = structuredClone(original), seed = repeatTaskSeed(completed, original);
 assert.deepEqual(seed.workflow.settings, { planningMode: 'off', planDetail: 'compact', maxParallel: 3, context: { preset: '900k' } });
 assert.deepEqual(original, before, 'Project settings without rewriting the admitted task or its stored preset');
});

test('input-only planning choices survive repetition without capturing agent-derived outline depth', () => {
 const original = { id: 'root', cwd: 'C:\\workspace', input: { task: 'An adaptive recurring check.', planningMode: 'auto' }, workflow: { nodes: [], settings: { planningMode: 'on' } }, taskState: { plan: { detail: 'detailed' } } };
 const seed = repeatTaskSeed({ id: 'root', status: 'completed', settled: true }, original);
 assert.equal(seed.workflow.settings.planningMode, 'auto');
 assert.equal(Object.hasOwn(seed.workflow.settings, 'planDetail'), false, 'The next run must be free to adapt its outline to the new work');
});

test('repeat recipes restore per-agent effort intent and preserve legacy or deliberately edited choices', () => {
 const cases = [
  { id: 'app', effort: 'medium', choice: { effort: 'medium', source: 'application-default', requestedEffort: null } },
  { id: 'maximal', effort: 'xhigh', choice: { effort: 'xhigh', source: 'maximal-model-catalog', requestedEffort: null } },
  { id: 'maximal-default', effort: 'xhigh', choice: { effort: 'xhigh', source: 'maximal-model-catalog', requestedEffort: 'default' }, expected: 'default' },
  { id: 'explicit', effort: 'low', choice: { effort: 'low', source: 'request', requestedEffort: 'low' }, expected: 'low' },
  { id: 'explicit-default', effort: 'default', choice: { effort: 'default', source: 'request', requestedEffort: 'default' }, expected: 'default' },
  { id: 'legacy', effort: 'high', expected: 'high' },
  { id: 'edited', effort: 'low', choice: { effort: 'xhigh', source: 'maximal-model-catalog', requestedEffort: null }, expected: 'low' },
 ];
 const original = { id: 'root', cwd: 'C:\\workspace', input: 'Repeat the complete swarm.', planningMode: 'maximal', workflow: { nodes: cases.map(({ id, effort }) => ({ id, type: 'agent', model: 'fixture', effort })), settings: { maxParallel: 2 } }, nodes: Object.fromEntries(cases.map(({ id, choice }) => [id, { effortSelection: choice }])) };
 const before = structuredClone(original), seed = repeatTaskSeed({ id: 'root', status: 'completed', settled: true }, original);
 for (const { id, expected } of cases) {
  const node = seed.workflow.nodes.find(node => node.id === id);
  assert.equal(node.effort, expected, id);
  assert.equal(Object.hasOwn(node, 'effort'), expected !== undefined, id);
 }
 assert.deepEqual(original, before, 'Effective effort and its evidence stay intact in admitted history');
 const status = { models: [{ id: 'fixture', supportedReasoningEfforts: ['low', 'medium', 'high'] }] };
 const freshChoice = id => selectPlanningEffort({ mode: seed.workflow.settings.planningMode, status, model: 'fixture', requestedEffort: seed.workflow.nodes.find(node => node.id === id).effort, defaultEffort: 'medium' });
 assert.equal(freshChoice('maximal').effort, 'high', 'A new run recomputes automatic effort against its current model catalog');
 assert.equal(freshChoice('maximal-default').effort, 'high', 'An explicit model default still permits the bounded Maximal choice');
 assert.equal(freshChoice('explicit').effort, 'low', 'A concrete authored override remains authoritative');
});
