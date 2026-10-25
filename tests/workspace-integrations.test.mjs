import test from 'node:test';
import assert from 'node:assert/strict';
import { workspaceIntegrations } from '../public/workspace-integrations.mjs';

test('workspace entry points use the browser and never expose retired mailbox adapters', () => {
  const cards = workspaceIntegrations({browser:{available:true,contained:false},email:{configured:true,enabled:true,cli:{checked:true}}});
  assert.deepEqual(cards.map(card => card.id), ['browser','planning','swarm','schedules']);
  assert.equal(cards[0].ready,false);
  assert.ok(!JSON.stringify(cards).includes('email'));
  assert.ok(!JSON.stringify(cards).includes('Himalaya'));
  assert.ok(!JSON.stringify(cards).includes('ChatGPT'));
});

test('contained browser availability and scheduler pause/storage failures remain visible', () => {
  const cards = workspaceIntegrations({browser:{available:true,contained:true},storage:{healthy:false},projects:{healthy:false},operations:{healthy:true,paused:true}});
  assert.equal(cards[0].ready,true);
  assert.equal(cards.find(card => card.id === 'planning').ready,false);
  assert.equal(cards.find(card => card.id === 'swarm').ready,false);
  assert.equal(cards.find(card => card.id === 'schedules').ready,false);
  assert.match(cards.find(card => card.id === 'schedules').state,/Paused.*while BLACKICE is open/);
});

test('healthy project and scheduler storage does not advertise execution while dispatch is blocked', () => {
  const status={projects:{healthy:true,blockedReason:'Project execution is paused by the application.'},operations:{healthy:true,paused:false,blockedReason:'The task inbox is paused.'}},before=structuredClone(status);
  const cards=workspaceIntegrations(status),swarm=cards.find(card=>card.id==='swarm'),schedules=cards.find(card=>card.id==='schedules');
  assert.equal(swarm.ready,false);assert.match(swarm.state,/Execution paused/);assert.match(swarm.state,/plans and history available/);assert.equal(swarm.action,'projects');
  assert.equal(schedules.ready,false);assert.match(schedules.state,/Paused/);assert.match(schedules.state,/open schedules/);assert.doesNotMatch(schedules.state,/^Runs/);assert.equal(schedules.action,'operations');
  assert.deepEqual(status,before,'rendering capability cards never resumes or changes the stored pause');
  const resumed=workspaceIntegrations({projects:{...status.projects,blockedReason:null},operations:{...status.operations,blockedReason:null}});
  assert.equal(resumed.find(card=>card.id==='swarm').ready,true);assert.equal(resumed.find(card=>card.id==='schedules').ready,true);
});

test('storage failures take precedence over paused execution in workspace cards', () => {
  const cards=workspaceIntegrations({projects:{healthy:false,blockedReason:'Paused'},operations:{healthy:false,paused:true,blockedReason:'Paused'}});
  for (const id of ['swarm','schedules']) { const card=cards.find(item=>item.id===id);assert.equal(card.ready,false);assert.match(card.state,/need(?:s)? attention/);assert.doesNotMatch(card.state,/history available|open schedules/); }
});

test('the Planning card opens the shared saved editor and preserves Off semantics', () => {
  const card=workspaceIntegrations({storage:{healthy:true}}).find(item=>item.id==='planning');
  assert.equal(card.ready,true);assert.equal(card.action,'planning');
  assert.equal(card.title,'Planning');assert.match(card.description,/saved objectives, steps, branches and dependencies/);assert.match(card.description,/Off keeps existing plans and notes/);
  assert.match(card.state,/Shared plans, readiness and evidence/);assert.doesNotMatch(card.state,/each task/);
  const unavailable=workspaceIntegrations({storage:{healthy:false}}).find(item=>item.id==='planning');
  assert.equal(unavailable.ready,false);assert.match(unavailable.state,/Storage needs attention/);
});

test('retired email status never re-enables a mailbox workspace card', () => {
  for (const unhealthy of [{state:'unavailable'}, {storage:{healthy:false}}, {configured:true,enabled:true,cli:{checked:true},account:{observed:true}}]) {
    const cards=workspaceIntegrations({email:unhealthy});
    assert.equal(cards.some(card=>card.id==='email'),false);
  }
});
