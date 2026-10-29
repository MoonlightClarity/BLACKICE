// Synthetic public receipts for the production Chat renderer. No provider
// reasoning trace or tool payload is part of this visual fixture.
export function planningReturnRun({ composition = false } = {}) {
  const id = 'planning-return-fixture', nodeId = 'agent';
  const at = second => `2026-10-29T12:00:${String(second).padStart(2, '0')}.000Z`;
  const event = (second, data) => ({ type: 'agent.event', runId: id, nodeId, at: at(second), data });
  const initial = {
    taskId: 'quoted-total', revision: 1, updatedAt: at(1), goal: 'Check the total including the delivery fee.',
    plan: { layout: 'sequence', origin: 'agent', authoredBy: { runId: id, nodeId } },
    steps: [
      { id: 'check', kind: 'sequence', title: 'Check the quoted total', status: 'active' },
      { id: 'amounts', parentId: 'check', kind: 'sequence', title: 'Use both quoted amounts', status: 'active' },
      { id: 'calculate', parentId: 'amounts', kind: 'action', title: 'Add the $32 price and $9 delivery fee', stepType: 'reason', status: 'active', doneWhen: 'The saved total includes both amounts.' },
    ], planningReviews: [], artifacts: [],
  };
  const checked = structuredClone(initial);
  checked.revision = 2; checked.updatedAt = at(3);
  for (const step of checked.steps) step.status = 'done';
  checked.steps[2].evidence = '$32 + $9 = $41. Both quoted amounts are included.';
  const reviewed = structuredClone(checked);
  reviewed.revision = 3; reviewed.updatedAt = at(4);
  reviewed.planningReviews = [{ runId: id, nodeId, reviewedRevision: 2, at: at(4), decision: 'respond', summary: 'The recorded total includes the price and delivery fee. No saved work remains unfinished.' }];
  const answer = 'The checked total is $41: $32 for the item and $9 for delivery.';
  return {
    id, taskId: initial.taskId, input: 'What is the total for a $32 item with a $9 delivery fee?',
    status: 'completed', settled: true, createdAt: at(0), updatedAt: at(8), finishedAt: at(8),
    workflow: { nodes: [{ id: nodeId, type: 'agent', name: 'BLACKICE' }] },
    nodes: { [nodeId]: { status: 'completed', output: answer, finishedAt: at(8) } },
    output: answer, taskState: reviewed,
    events: [
      event(1, { type: 'task.state', state: initial }),
      event(2, { type: 'message', itemId: 'working-one', phase: 'commentary', text: 'I’m checking that the delivery fee is included.' }),
      event(3, { type: 'task.state', state: checked }),
      event(4, { type: 'task.state', state: reviewed }),
      composition ? event(5, { type: 'item', stage: 'started', item: { id: 'final-one', type: 'agentMessage', phase: 'final_answer', text: '' } })
        : event(5, { type: 'message', itemId: 'working-two', phase: 'commentary', text: 'The recheck is complete. I’m presenting the total with its price and fee.' }),
      event(6, { type: 'delta', itemId: 'final-one', delta: answer }),
      event(7, { type: 'message', itemId: 'final-one', phase: 'final_answer', text: answer }),
      event(8, { type: 'item', stage: 'completed', item: { id: 'final-one', type: 'agentMessage', phase: 'final_answer', text: answer } }),
    ],
  };
}
