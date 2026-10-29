/** Three saved levels, a choice with an unused path, and separate root steps. */
export function outlineTree() {
  const step = (id, title, parentId = null, extra = {}) => ({ id, title, parentId, kind: 'action', status: 'pending', dependsOn: [], ...extra });
  return { taskId: 'outline-tree', revision: 1, goal: 'Inspect the source, save the result, and verify it.', planVersion: 1,
    plan: { origin: 'agent', layout: 'sequence', detail: 'detailed' }, steps: [
      step('prepare', 'Prepare the result', null, { kind: 'sequence' }),
      step('read', 'Read the source', 'prepare', { status: 'done' }),
      step('inspect', 'Inspect the source', 'prepare', { kind: 'sequence' }),
      step('format', 'Check the format', 'inspect', { status: 'active' }),
      step('limits', 'Check the limits', 'inspect'),
      step('route', 'Choose the source', 'prepare', { kind: 'choice', selectedChildId: 'cached' }),
      step('cached', 'Use the saved source', 'route'),
      step('fresh', 'Read a fresh source', 'route'),
      step('write', 'Save the result'),
      step('verify', 'Verify the saved result', null, { kind: 'sequence' }),
      step('readback', 'Read the saved bytes', 'verify'),
    ], artifacts: [] };
}

export const outlineNumbers = {
  prepare: '1', read: '1.1', inspect: '1.2', format: '1.2.1', limits: '1.2.2',
  route: '1.3', cached: '1.3.1', fresh: '1.3.2', write: '2', verify: '3', readback: '3.1',
};

/** Move a sibling and a root; descendant storage order need not be contiguous. */
export function reorderedOutlineTree() {
  const state = outlineTree(), saved = new Map(state.steps.map(step => [step.id, step]));
  state.revision++;
  state.steps = ['prepare', 'inspect', 'verify', 'format', 'limits', 'read', 'route', 'cached', 'fresh', 'readback', 'write'].map(id => saved.get(id));
  return state;
}

export const reorderedOutlineNumbers = {
  prepare: '1', inspect: '1.1', format: '1.1.1', limits: '1.1.2', read: '1.2',
  route: '1.3', cached: '1.3.1', fresh: '1.3.2', verify: '2', readback: '2.1', write: '3',
};
