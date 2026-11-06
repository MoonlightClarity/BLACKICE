// Explicit frozen catalog for historical atomic-leaf regression fixtures.
// New work-item tests import the production module directly.
import { createTaskToolHandler as currentHandler } from '../lib/task-state.mjs';
export * from '../lib/task-state.mjs';
export { TASK_TOOL_V13 as TASK_TOOL, TASK_WORKER_TOOL_V13 as TASK_WORKER_TOOL,
  TASK_INSTRUCTIONS_V13 as TASK_INSTRUCTIONS } from '../lib/task-state.mjs';
export const TASK_SCHEMA_VERSION = 13;
export function createTaskToolHandler(options) {
  return currentHandler({ ...options, schemaVersion: options.schemaVersion ?? 13 });
}
