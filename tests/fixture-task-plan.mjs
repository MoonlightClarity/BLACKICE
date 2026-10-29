import assert from 'node:assert/strict';

/** Tool integration fixtures model the complete Planning On protocol through
 * the real gateway: prepare, save one concrete call, execute, record its actual
 * response, then plan the next call. Planning-specific tests use their own
 * explicit tool sequences instead. No guard, store lock or handler is bypassed.
 * Legacy catalogs and Planning Off retain their original fixture behavior. */
export async function recordFixturePlan(options, { title = 'Exercise the requested tool behavior', doneWhen = 'The fixture observes the requested tool result and its actual effects.' } = {}) {
  const tool = options.dynamicTools?.find(item => item.name === 'relay_task');
  if (!tool?.inputSchema?.properties?.plan) return null;
  const gateway = options.onToolCall;
  const call = async arguments_ => {
    const response = await gateway({ name: 'relay_task', arguments: arguments_ });
    assert.equal(response.success, true, response.contentItems?.[0]?.text);
    return JSON.parse(response.contentItems.find(item => item.type === 'inputText').text);
  };
  const current = await call({ action: 'read' });
  const plan = Object.fromEntries(['layout', 'detail', 'taskType', 'focusStepId', 'selectedChildId'].filter(key => current.plan?.[key] !== undefined).map(key => [key, current.plan[key]]));
  if (current.plan?.method) plan.method = { id: current.plan.method.id, revision: current.plan.method.revision };
  const method = 'Call the operation specified by this fixture, inspect its returned receipt and saved effects, and compare them with the fixture assertions.';
  const result = 'The observed tool result and its effects for the requested fixture behavior.';
  const sequential = Boolean(tool.inputSchema.properties.steps?.items?.properties?.operation)
    && !/TASK PLANNING MODE: OFF/.test(options.developerInstructions || '');
  // These are independent tool-contract assertions. Their dispatch remains
  // chronological, while one expected failure does not make every later
  // assertion a dependent task that can no longer run.
  if (sequential) plan.layout = 'parallel';
  const steps = current.steps.map(step => (step.kind || 'action') === 'action' && !['done', 'skipped'].includes(step.status)
    ? { ...step, result: step.result || result, note: step.note || method,
      ...(sequential && !step.operation ? { operation: { kind: 'reasoning', target: `${title}: supplied fixture expectation` } } : {}) } : step);
  if (!steps.some(step => (step.kind || 'action') === 'action' && !['done', 'skipped'].includes(step.status)
    && (!sequential || step.operation?.kind === 'reasoning'))) {
    let id = 'fixture-action'; while (steps.some(step => step.id === id)) id += '-next';
    steps.push({ id, title, kind: 'action', status: 'active', doneWhen, result, note: method,
      ...(sequential ? { operation: { kind: 'reasoning', target: `${title}: supplied fixture expectation` } } : {}) });
  }
  if (!sequential) return call({ action: 'plan', expectedRevision: current.revision, plan, steps });

  // This initial reasoning leaf concerns the supplied test contract. It does
  // not assert that a later tool or its intended external effect succeeded.
  const preparation = steps.find(step => step.status === 'active' && (step.kind || 'action') === 'action')
    || steps.find(step => (step.kind || 'action') === 'action' && !['done', 'skipped'].includes(step.status));
  assert.ok(preparation, 'The fixture needs a prospective preparation leaf.');
  Object.assign(preparation, { status: 'active', operation: { kind: 'reasoning', target: `${title}: supplied fixture expectation` },
    result: 'The supplied fixture assertion and attached gateway capability are identified.',
    note: `Inspect the attached tool schema and supplied assertion for this fixture: ${title}.`,
    doneWhen: `The fixture identifies its requested check before dispatch: ${doneWhen}` });
  const prepared = await call({ action: 'plan', expectedRevision: current.revision, plan, steps });
  let pending = Promise.resolve(), index = 0;
  options.onToolCall = (request, context) => {
    if (request.name === 'relay_task' || options.signal?.aborted || context?.signal?.aborted) return gateway(request, context);
    const perform = async () => {
      let state = await call({ action: 'read' });
      const active = state.steps.find(step => step.status === 'active' && (step.kind || 'action') === 'action');
      // An explicit fixture-authored plan remains in charge of its own calls.
      if (active && active.id !== preparation.id) return gateway(request, context);
      if (active) state = await call({ action: 'step', expectedRevision: state.revision, stepId: preparation.id, status: 'done',
        evidence: `The fixture inspected its attached schemas and identified this supplied check: ${doneWhen}` });
      let args; try { args = typeof request.arguments === 'string' ? JSON.parse(request.arguments) : request.arguments || {}; } catch { args = {}; }
      let id; do { id = `fixture-tool-${++index}`; } while (state.steps.some(step => step.id === id));
      const action = typeof args.action === 'string' ? args.action : undefined;
      const target = String(args.path || args.attachmentId || args.sessionId || args.documentId || args.origin || args.url || args.id || `${title}, fixture call ${index}`).slice(0, 500);
      const leaf = { id, kind: 'action', parentId: preparation.parentId || null, status: 'active', title: `Observe ${request.name}${action ? ' ' + action : ''} response`,
        operation: { kind: 'tool', tool: request.name, ...(action ? { action } : {}), target },
        result: `The actual gateway response for ${request.name}${action ? ' ' + action : ''} on ${target}.`,
        note: `Dispatch exactly this fixture call to ${request.name}${action ? ' with action ' + action : ''} for ${target}.`,
        doneWhen: 'The actual gateway has returned an explicit response status for this call; this criterion does not assert that its intended external effect succeeded.' };
      state = await call({ action: 'edit', expectedRevision: state.revision, operations: [{ type: 'add', step: leaf }] });
      // The fixture models the model attaching its newly saved ownership scope
      // to one delegated assignment, as required by the actual gateway.
      const actual = request.name === 'relay_delegate' && args.tasks?.length === 1 && !args.tasks[0].stepId
        ? { ...request, arguments: { ...args, tasks: [{ ...args.tasks[0], stepId: id }] } } : request;
      let response, thrown;
      try { response = await gateway(actual, context); } catch (error) { thrown = error; }
      if (!options.signal?.aborted && !context?.signal?.aborted) {
        state = await call({ action: 'read' });
        const saved = state.steps.find(step => step.id === id);
        if (saved?.kind === 'action' && !['done', 'skipped'].includes(saved.status)) {
          const confirmedResponse = response?.success === true;
          await call({ action: 'step', expectedRevision: state.revision, stepId: id,
            ...(confirmedResponse ? { status: 'done', evidence: `The actual ${request.name} gateway returned success:true. The fixture's separate assertions inspect the response and any required saved effect.` }
              : { status: 'blocked', blockedReason: `The actual ${request.name} gateway ${thrown ? 'threw ' + (thrown.code || thrown.name) : response?.success === false ? 'returned success:false' + (response.code ? ' (' + response.code + ')' : '') : 'returned no confirmed result'}. Its intended effect is not reported as successful.` }) });
        }
      }
      if (thrown) throw thrown;
      return response;
    };
    const result = pending.then(perform); pending = result.catch(() => {}); return result;
  };
  return prepared;
}

/** Explicit terminal reassessment for a fixture that has already performed and
 * recorded its actual work. Call sites supply the finding and disposition; this
 * helper neither completes active leaves nor fabricates an outcome. It is not
 * invoked by the runtime or by recordFixturePlan. */
export async function finishFixturePlan(options, { state, decision = 'respond', summary } = {}) {
  const tool = options.dynamicTools?.find(item => item.name === 'relay_task');
  if (!tool?.inputSchema?.properties?.action?.enum.includes('review')
    || /TASK PLANNING MODE: OFF/.test(options.developerInstructions || '')) return state || null;
  assert.equal(typeof summary, 'string', 'A final fixture review needs its actual findings and remaining-work assessment.');
  assert.ok(summary.trim());
  const call = async arguments_ => {
    const response = await options.onToolCall({ name: 'relay_task', arguments: arguments_ });
    assert.equal(response.success, true, response.contentItems?.[0]?.text);
    return JSON.parse(response.contentItems.find(item => item.type === 'inputText').text);
  };
  state ||= await call({ action: 'read' });
  return call({ action: 'review', expectedRevision: state.revision, review: { decision, summary } });
}
