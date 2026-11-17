import test from 'node:test';
import assert from 'node:assert/strict';
import { validateTaskViewArguments } from '../lib/task-tool-view.mjs';

test('a speculative nonzero Planning offset is rejected with an actionable first-page recovery', () => {
  assert.throws(
    () => validateTaskViewArguments({ action: 'read', view: 'full', offset: 150187, expectedRevision: 316 }),
    error => error?.code === 'INVALID_TASK_VIEW' &&
      /exact nextRead/.test(error.message) &&
      /restart the first page/.test(error.message) &&
      /focused stepId/.test(error.message)
  );
  assert.doesNotThrow(() => validateTaskViewArguments({ action: 'read', view: 'full' }));
  assert.doesNotThrow(() => validateTaskViewArguments({ action: 'read', stepId: 'r22_4fd' }));
  assert.doesNotThrow(() => validateTaskViewArguments({
    action: 'read', view: 'full', offset: 4000, expectedRevision: 316, viewHash: 'a'.repeat(64)
  }));
});
