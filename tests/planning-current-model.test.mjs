import test from 'node:test';
import assert from 'node:assert/strict';
import { planningConversationId, planningConversationRunId, planningConversationActivity,
  planningCurrentConversations, planningDirectoryRecord, planningDirectoryPhases,
  planningDirectorySummary, planningDirectoryWorkItems } from '../public/next/workspaces/planning-current-model.mjs';

const conversation = { id: 'run-latest', rootId: 'conversation-root', taskId: 'conversation-root', runId: 'run-latest',
  latestRunId: 'run-latest', title: 'Current work', state: 'active', status: 'completed', settled: true,
  goal: { status: 'completed', currentRunId: 'run-latest', running: false, runStatus: null, turns: 3 } };
const turn = (id, label, runId = 'run-latest') => ({ id, runId, label, module: 'modules/1', at: '2026-11-13T12:00:00Z', sourceFiles: ['observed.json'] });
const moduleFile = 'runs/run-latest/modules/1/1.1/module.json';
const resultFile = moduleFile.replace('module.json', 'result.json');

test('modern conversations are visible without any graph request and preserve root versus latest-run identity', () => {
  const rows = planningCurrentConversations({ conversations: [conversation] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'conversation-root');
  assert.equal(rows[0].runId, 'run-latest');
  assert.equal(planningConversationId(conversation), 'conversation-root');
  assert.equal(planningConversationRunId(conversation), 'run-latest');
  assert.equal(rows[0].activity.label, 'Finished');
});

test('only observed executing work is Running; saved active goals and queued work do not inflate the filter', () => {
  const saved = { ...conversation, goal: { status: 'active', running: false, runStatus: null } };
  const running = { ...conversation, rootId: 'running', status: 'running', settled: false, goal: undefined };
  const queued = { ...running, rootId: 'queued', status: 'queued' };
  assert.equal(planningConversationActivity(saved).running, false);
  assert.equal(planningConversationActivity(queued).label, 'Queued');
  assert.equal(planningConversationActivity(queued).pending, true);
  assert.deepEqual(planningCurrentConversations([saved, running, queued], { view: 'running' }).map(row => row.id), ['running']);
  assert.equal(planningConversationActivity({ status: 'running', settled: true }).running, false);
});

test('live goal observations can describe a newly admitted run before catalog history catches up', () => {
  const live = planningConversationActivity(conversation, { status: 'active', running: true, runStatus: 'running', currentRunId: 'new-run' });
  assert.equal(live.running, true);
  assert.equal(planningConversationActivity({ status: 'running', settled: false }, { running: false, runStatus: 'waiting' }).label, 'Waiting');
  assert.equal(planningConversationActivity({ status: 'running', settled: false }, { running: false, runStatus: null }).state, 'unknown');
});

test('historical failure remains a factual result instead of a current attention demand', () => {
  assert.deepEqual(planningConversationActivity({ status: 'failed', settled: true }), { state: 'failed', label: 'Failed', running: false, pending: false });
  assert.equal(planningConversationActivity({ state: 'active' }).label, 'Saved');
});

test('catalog tolerates malformed list shapes, deduplicates roots, filters archive and excludes trash', () => {
  for (const value of [null, {}, { conversations: null }, { conversations: {} }]) assert.deepEqual(planningCurrentConversations(value), []);
  const older = { ...conversation, id: 'old-run', latestRunId: 'old-run', updatedAt: '2026-11-12T00:00:00Z' };
  const newest = { ...conversation, updatedAt: '2026-11-13T00:00:00Z' };
  const archived = { ...conversation, rootId: 'archived', state: 'archived' };
  const deleted = { ...conversation, rootId: 'deleted', state: 'deleted' };
  const rows = planningCurrentConversations({ conversations: [null, {}, older, newest, archived, deleted] }, { view: 'all' });
  assert.deepEqual(rows.map(row => row.id), ['conversation-root', 'archived']);
  assert.equal(rows[0].runId, 'run-latest');
  assert.equal(planningCurrentConversations(rows, { view: 'archived' })[0].id, 'archived');
  assert.equal(planningCurrentConversations(rows, { query: 'CURRENT' }).length, 1);
});

test('empty Directory state remains empty and never invents work or verification', () => {
  const result = planningDirectorySummary({ conversation, turns: [] });
  assert.equal(result.available, false);
  assert.equal(result.plannedWorkItems, null);
  assert.equal(result.modelPhases, 0);
  assert.equal(result.outcome, null);
  assert.deepEqual(result.workItemFiles, []);
  assert.equal(result.status, 'not_recorded');
});

test('saved Directory work and model phases are independent of legacy graphs and host audit events', () => {
  const turns = [turn('t-1', 'decompose'), turn('t-2', 'tool-result'), turn('t-3', 'work'), turn('t-4', 'work-checkpoint'), turn('t-old', 'integration', 'older-run')];
  const listing = { summary: { currentRun: 'run-latest', request: 'Implement the change', directoryStatus: 'completed', plannedWorkItems: 2,
    planningCalls: 1, modelCalls: 2, outcomeAssessment: { decision: 'respond', reason: 'Observed result is ready' } },
    files: [{ file: moduleFile }, { file: resultFile }, { file: 'conversation/context/turns.json' }] };
  const result = planningDirectorySummary({ conversation, listing, turns });
  assert.equal(result.available, true);
  assert.equal(result.modelPhases, 2);
  assert.equal(result.auditRecords, 4);
  assert.equal(result.totalAuditRecords, 5);
  assert.equal(result.contextFiles, 3);
  assert.equal(result.plannedWorkItems, 2);
  assert.equal(result.outcome.label, 'Response reviewed');
  assert.equal(result.workItemFiles.length, 1);
  assert.deepEqual(planningDirectoryPhases(turns, { runId: 'run-latest' }).map(row => row.label), ['decompose', 'work']);
});

test('previous-run summaries cannot become the current request or its completion claim', () => {
  const result = planningDirectorySummary({ conversation: { ...conversation, input: 'New request' }, listing: {
    summary: { currentRun: 'older-run', request: 'Old request', directoryStatus: 'completed', plannedWorkItems: 9, outcomeAssessment: { decision: 'respond' } }, files: [] } });
  assert.equal(result.belongsToSelectedRun, false);
  assert.equal(result.recordedRunId, 'older-run');
  assert.equal(result.request, 'New request');
  assert.equal(result.plannedWorkItems, null);
  assert.equal(result.outcome, null);
  assert.equal(result.status, 'not_recorded');
});

test('a newer live goal selects its actual run and cannot inherit the previous run outcome', () => {
  const goal = { currentRunId: 'new-live-run', status: 'active', running: true, runStatus: 'running', objective: 'Keep working' };
  assert.equal(planningConversationRunId({ ...conversation, goal }), 'new-live-run');
  assert.equal(planningCurrentConversations([{ ...conversation, goal }])[0].runId, 'new-live-run');
  const result = planningDirectorySummary({ conversation, goal, listing: {
    summary: { currentRun: 'run-latest', request: 'Previous request', directoryStatus: 'completed', outcomeAssessment: { decision: 'respond' } },
    files: [{ file: moduleFile }, { file: 'runs/new-live-run/modules/1/module.json' }] } });
  assert.equal(result.runId, 'new-live-run');
  assert.equal(result.belongsToSelectedRun, false);
  assert.equal(result.outcome, null);
  assert.equal(result.workItemFiles.length, 1);
  assert.equal(result.workItemFiles[0].file, 'runs/new-live-run/modules/1/module.json');
  assert.equal(planningConversationRunId({ ...conversation, goal: { ...goal, running: false, runStatus: null } }), 'run-latest', 'An idle saved goal does not supersede actual latest-run metadata.');
});

test('managed field edits and full replacements are shown; deleted records never return', () => {
  assert.deepEqual(planningDirectoryRecord({ value: { finding: 'Old', uncertainty: 'Check' }, managedValue: { finding: 'Corrected' }, editMode: 'fields' }), { finding: 'Corrected', uncertainty: 'Check' });
  assert.deepEqual(planningDirectoryRecord({ value: { finding: 'Old' }, managedValue: { finding: 'Replacement' }, editMode: 'replace' }), { finding: 'Replacement' });
  assert.equal(planningDirectoryRecord({ value: { finding: 'Old' }, managedDeleted: true }), null);
  const result = planningDirectorySummary({ listing: { summary: { userSummary: 'Old', pinnedConstraints: ['A'] },
    managedSummary: { userSummary: 'Corrected' }, managedSummaryEditMode: 'fields' } });
  assert.equal(result.notes, 'Corrected');
  assert.deepEqual(result.pinnedConstraints, ['A']);
});

test('context edits keep prior review as historical rather than a current completion assessment', () => {
  const result = planningDirectorySummary({ conversation, listing: {
    summary: { currentRun: 'run-latest', directoryStatus: 'completed', outcomeAssessment: { decision: 'respond', summary: 'Earlier answer' } },
    invalidation: { staleRuns: { 'run-latest': { state: 'stale', reason: 'Context changed after synthesis.' } } }, files: [] } });
  assert.equal(result.stale, true);
  assert.equal(result.statusLabel, 'Context changed');
  assert.equal(result.outcome.label, 'Earlier review');
  assert.equal(result.outcome.stale, true);
  assert.equal(result.outcome.summary, 'Earlier answer');
  assert.equal(result.reviewStaleReason, 'Context changed after synthesis.');
});

test('work reports retain completion checks, dependencies and uncertainty without becoming verified outcomes', () => {
  const records = [{ file: moduleFile, value: { id: '1.1', objective: 'Make the change', doneWhen: 'Observed check', status: 'worked_unverified', dependsOn: ['1.0'] } },
    { file: resultFile, value: { finding: 'Changed', candidate_answer: 'Observed output', uncertainty: 'Review remains', workStatus: 'complete', verified: false, status: 'worked_unverified' } }];
  const [item] = planningDirectoryWorkItems(records, { runId: 'run-latest' });
  assert.equal(item.label, 'Reported complete');
  assert.equal(item.verified, false);
  assert.equal(item.uncertainty, 'Review remains');
  assert.deepEqual(item.dependsOn, ['1.0']);
  assert.equal(item.doneWhen, 'Observed check');
  assert.deepEqual(planningDirectoryWorkItems(records, { runId: 'different' }), []);
});

test('user corrections do not manufacture verification and superseded work remains historical', () => {
  const module = { file: moduleFile, value: { id: '1.1', objective: 'Work', status: 'worked_unverified' } };
  const result = { file: resultFile, value: { verified: true, finding: 'Generated' }, managedValue: { finding: 'Correction' }, editMode: 'fields' };
  assert.equal(planningDirectoryWorkItems([module, result])[0].verified, false);
  assert.equal(planningDirectoryWorkItems([module, result])[0].finding, 'Correction');
  assert.equal(planningDirectoryWorkItems([module, { file: resultFile, value: { verified: false, status: 'superseded_by_review' } }])[0].label, 'Superseded');
  assert.deepEqual(planningDirectoryWorkItems([{ ...module, managedDeleted: true }, result]), []);
});

test('malformed phase and work records are ignored without losing well-formed rows', () => {
  const phases = planningDirectoryPhases({ value: [null, 1, {}, turn('t-1', 'work'), turn('t-2', 'decomposition-policy')] });
  assert.equal(phases.length, 1);
  assert.equal(phases[0].file, 'runs/run-latest/turns/t-1.json');
  assert.deepEqual(planningDirectoryPhases({ value: {} }), []);
  assert.deepEqual(planningDirectoryWorkItems([null, {}, { file: moduleFile, value: 'bad' }]), []);
});
