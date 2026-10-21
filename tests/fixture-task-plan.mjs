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
  return call({ action: 'plan', expectedRevision: current.revision, plan, steps: current.steps.length ? current.steps : [{ id: 'fixture-action', title, kind: 'action', status: 'active', doneWhen }] });
}
