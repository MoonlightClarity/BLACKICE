import assert from 'node:assert/strict';

/** Existing integration fixtures exercise specific tool behavior. Give each
 * current-schema fixture its real task outline before that behavior, through
 * the same attached gateway as an agent. Keep legacy catalogs unchanged. */
export async function recordFixturePlan(options, { title = 'Exercise the requested tool behavior', doneWhen = 'The fixture observes the requested tool result and its actual effects.' } = {}) {
  const tool = options.dynamicTools?.find(item => item.name === 'relay_task');
  if (!tool?.inputSchema?.properties?.plan) return null;
  const call = async arguments_ => {
    const response = await options.onToolCall({ name: 'relay_task', arguments: arguments_ });
    assert.equal(response.success, true, response.contentItems?.[0]?.text);
    return JSON.parse(response.contentItems.find(item => item.type === 'inputText').text);
  };
  const current = await call({ action: 'read' });
  const plan = Object.fromEntries(['layout', 'detail', 'taskType', 'focusStepId', 'selectedChildId'].filter(key => current.plan?.[key] !== undefined).map(key => [key, current.plan[key]]));
  if (current.plan?.method) plan.method = { id: current.plan.method.id, revision: current.plan.method.revision };
  const method = 'Call the operation specified by this fixture, inspect its returned receipt and saved effects, and compare them with the fixture assertions.';
  const result = 'The observed tool result and its effects for the requested fixture behavior.';
  const steps = current.steps.map(step => (step.kind || 'action') === 'action' && !['done', 'skipped'].includes(step.status)
    ? { ...step, result: step.result || result, note: step.note || method } : step);
  if (!steps.some(step => (step.kind || 'action') === 'action' && !['done', 'skipped'].includes(step.status))) {
    let id = 'fixture-action'; while (steps.some(step => step.id === id)) id += '-next';
    steps.push({ id, title, kind: 'action', status: 'active', doneWhen, result, note: method });
  }
  return call({ action: 'plan', expectedRevision: current.revision, plan, steps });
}
