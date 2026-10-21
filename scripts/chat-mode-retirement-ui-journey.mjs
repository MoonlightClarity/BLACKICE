import assert from 'node:assert/strict';

export function measuredChatModeRetirement(value) {
  return Boolean(value?.fixtureOnly === true && value.route === 'chatgpt::chat-mode'
    && value.catalogAbsent === true && value.setupActionsAbsent === true
    && value.endpointReceipts?.length === 4 && value.endpointReceipts.every(receipt => receipt.status === 410 && receipt.code === 'CHAT_MODE_RETIRED')
    && value.savedSelection === value.route && value.selectionAfterReload === value.route
    && value.draftPreserved === true && value.retiredVisible === true
    && value.historicalRoute === value.route && value.routeAfterNextReplyChange === value.route
    && value.nextReplyModel === 'fixture-model' && value.connectionPresent === true
    && value.mobile?.width === 320 && value.mobile.fits === true && value.mobile.reverseActions === 0
    && Number.isSafeInteger(value.turnsBefore) && value.turnsAfter === value.turnsBefore
    && value.historyRecordsAdded === 1 && value.externalRequestCount === 0);
}

/** Exercise retirement against the real UI without visiting or driving ChatGPT. */
export async function chatModeRetirementUIJourney({ api, app, runtime, cdp, session, origin, report, sourceRun, evaluate, until, waitVisible, click, fill, frames, key, openChat, composer, resize, screenshot, geometry, check }) {
  const evidence = report.recovery.chatModeRetirement = { fixtureOnly: true, route: 'chatgpt::chat-mode', turnsBefore: runtime.calls.length };
  const networkStart = cdp.networkUrls.length, runsBefore = app.engine.listRuns().length;
  await resize(1440, 900); await click('#workspace-modes [data-mode="view"]'); await waitVisible('#mission-task');
  const retained = await composer(), status = await api('/api/status');
  evidence.catalogAbsent = !(status.models || []).some(model => (model.id || model.model) === evidence.route);
  evidence.connectionPresent = Boolean(status.chatGPTConnector);
  evidence.endpointReceipts = await evaluate(async () => {
    const paths = ['/api/chat-mode', '/api/chat-mode/setup', '/api/chat-mode/refresh', '/api/chat-mode/acknowledge'];
    const results = [];
    for (const path of paths) {
      const response = await fetch(path, path.endsWith('chat-mode') ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      results.push({ status: response.status, code: (await response.json()).code });
    }
    return results;
  });
  assert.ok(evidence.catalogAbsent); assert.ok(evidence.endpointReceipts.every(receipt => receipt.status === 410 && receipt.code === 'CHAT_MODE_RETIRED'));
  const historical = structuredClone(sourceRun), id = 'qa-retired-chat-mode-history', now = new Date().toISOString();
  const text = 'Historical route fixture. No ChatGPT response was generated.';
  Object.assign(historical, { id, taskId: id, input: 'Retired route history fixture', workflowName: 'Saved retired conversation', createdAt: now, updatedAt: now, status: 'completed', settled: true, output: text, planningMode: 'off', events: [], attachmentIds: [] });
  for (const name of ['parentRunId', 'taskState', 'clientRequest', 'error', 'errorCode']) delete historical[name];
  if (historical.metadata) for (const name of ['clientRequestId', 'clientRequestHash']) delete historical.metadata[name];
  historical.workflow = structuredClone(sourceRun.workflow); historical.workflow.name = 'Saved retired conversation';
  for (const node of historical.workflow.nodes.filter(node => node.type === 'agent')) {
    node.model = evidence.route;
    historical.nodes[node.id] = { status: 'completed', output: text, resolvedModel: evidence.route, threadId: 'provider_chatmode_00000000-0000-0000-0000-000000000000', resolvedEffort: 'default', planning: { mode: 'off', status: 'disabled' } };
  }
  const saved = app.engine.restoreArchivedRun(historical); await app.engine.persist(); app.engine.notify('run.updated', app.engine.runs.get(id), undefined, saved);
  await until('saved retired route history', () => evaluate(id => Boolean(document.querySelector(`#conversation-sidebar [data-mission-action="open-run"][data-id="${id}"]`)), id));
  await openChat(id); await waitVisible('.conversation-response-route');
  const draft = 'Keep this unsent draft while choosing a supported model.'; await fill('#mission-task', draft);
  evidence.savedSelection = await evaluate(() => document.querySelector('#mission-model').value);
  evidence.historicalRoute = await evaluate(() => document.querySelector('.conversation-response-route').dataset.responseRoute);
  evidence.retiredVisible = await evaluate(() => /Retired/.test(document.querySelector('.conversation-response-route').textContent));
  assert.equal(await evaluate(() => document.querySelector('#mission-start-button').dataset.missionAction), 'connections');
  await cdp.call('Page.navigate', { url: origin }, session); await waitVisible('#mission-task');
  await until('retired choice and draft survive reload', () => evaluate((id, draft) => Boolean(document.querySelector(`.conversation-turn[data-run-id="${id}"]`)) && document.querySelector('#mission-model').value === 'chatgpt::chat-mode' && document.querySelector('#mission-task').value === draft, id, draft));
  evidence.selectionAfterReload = await evaluate(() => document.querySelector('#mission-model').value);
  evidence.draftPreserved = (await composer()).draft === draft;
  await click('.conversation-model-choice .model-picker-button'); await fill('#mission-model-picker .model-picker-search', 'ChatGPT');
  evidence.setupActionsAbsent = await evaluate(() => document.querySelectorAll('.model-picker-route-setup,.model-picker-route-refresh,.model-picker-route-acknowledge').length === 0);
  await resize(320, 780); await frames();
  evidence.mobile = await evaluate(() => {
    const panel = document.querySelector('#mission-model-picker'), box = panel.getBoundingClientRect();
    return { width: innerWidth, fits: box.left >= -1 && box.right <= innerWidth + 1 && box.top >= -1 && box.bottom <= innerHeight + 1 && document.documentElement.scrollWidth <= innerWidth + 1, reverseActions: panel.querySelectorAll('.model-picker-route-setup,.model-picker-route-refresh,.model-picker-route-acknowledge').length };
  });
  assert.ok(evidence.mobile.fits && await geometry('320px retired model picker'));
  await screenshot('48-retired-chat-mode-picker-320.jpg'); await key('Escape', 'Escape', 27); await resize(1440, 900);
  await click('.conversation-model-choice .model-picker-button'); await fill('#mission-model-picker .model-picker-search', 'fixture-model'); await click('#mission-model-picker [data-model-value="fixture-model"]');
  await until('supported choice preserves retired response history', () => evaluate(() => document.querySelector('#mission-model').value === 'fixture-model' && document.querySelector('.conversation-response-route')?.dataset.responseRoute === 'chatgpt::chat-mode'));
  evidence.nextReplyModel = await evaluate(() => document.querySelector('#mission-model').value);
  evidence.routeAfterNextReplyChange = await evaluate(() => document.querySelector('.conversation-response-route').dataset.responseRoute);
  evidence.draftPreserved &&= (await composer()).draft === draft;
  await screenshot('49-retired-chat-mode-history.jpg');
  await openChat(sourceRun.id); assert.equal((await composer()).draft, retained.draft);
  evidence.turnsAfter = runtime.calls.length; evidence.historyRecordsAdded = app.engine.listRuns().length - runsBefore;
  evidence.externalRequestCount = cdp.networkUrls.slice(networkStart).filter(url => /^https?:/.test(url) && new URL(url).origin !== origin).length;
  check('retired Chat Mode cannot run; saved draft and response history survive a supported-model choice', measuredChatModeRetirement(evidence));
  report.features.chatModeRetirement = true;
}
