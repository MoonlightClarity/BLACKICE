import assert from 'node:assert/strict';

/** Real UI acceptance against the caller's disposable application/profile. No model or external service is used. */
export async function knowledgeUIJourney({ api, evaluate, waitVisible, until, click, fill, select, menu, check, screenshot, geometry, resize, report, cwd }) {
  const suffix = Date.now().toString(36), factTitle = `QA measured result ${suffix}`, decisionTitle = `QA documented choice ${suffix}`;
  const source = 'qa-source.txt, measured fixture result';
  const original = { content: 'Use the measured result as the basis for this local decision.', source: 'qa-decision.md, section 2' };
  const evidence = { fixtureOnly: true, externalRequests: 0, modelTurns: 0, records: [] };
  report.recovery ||= {}; report.recovery.typedKnowledge = evidence;
  const savedRecord = async title => {
    const query = new URLSearchParams({ kind: 'memory', query: title, limit: '300', cwd });
    const rows = await api(`/api/knowledge?${query}`), found = (Array.isArray(rows) ? rows : rows.entries || []).find(item => item.title === title);
    return found ? await api(`/api/knowledge/${encodeURIComponent(found.id)}`) : null;
  };
  const saveEditor = async title => {
    await click('#knowledge-editor button[type="submit"]');
    await until(`typed memory ${title} saved through its editor`, () => evaluate(title => !document.querySelector('#knowledge-editor') && document.querySelector('.knowledge-entry h2')?.textContent === title, title));
    return until(`persisted typed memory ${title}`, () => savedRecord(title));
  };
  const newMemory = async () => {
    await click('[data-knowledge-action="new"]'); await waitVisible('#knowledge-editor');
    await select('#knowledge-kind', 'memory'); await select('#knowledge-edit-scope', 'workspace');
  };

  await resize(1440, 900); await menu('knowledge'); await waitVisible('#knowledge-search');
  await click('[data-knowledge-action="kind"][data-kind="memory"]');
  await until('the memory list to finish loading', () => evaluate(() => !/Loading your library/.test(document.querySelector('#knowledge-results')?.textContent || '')));
  await newMemory();
  await fill('#knowledge-title', factTitle); await fill('#knowledge-summary', 'A sourced observation used by another memory.');
  await fill('#knowledge-content', 'The owned local fixture produced the expected measurable result.');
  await select('#knowledge-memory-type', 'fact'); await fill('#knowledge-sources', source);
  const fact = await saveEditor(factTitle);
  assert.equal(fact.memoryType, 'fact'); assert.deepEqual(fact.sources, [source]); assert.equal(fact.cwd, cwd);
  evidence.records.push({ id: fact.id, memoryType: fact.memoryType, revision: fact.revision });
  check('The real memory editor saves a typed fact and its literal source reference in the current working folder', fact.revision === 1);

  await click('[data-knowledge-action="back"]'); await waitVisible('#knowledge-search');
  await until('the saved fact to finish loading in the memory list', () => evaluate(id => Boolean(document.querySelector(`#knowledge-results [data-id="${id}"]`)) && !/Loading your library/.test(document.querySelector('#knowledge-results')?.textContent || ''), fact.id));
  await newMemory();
  await fill('#knowledge-title', decisionTitle); await fill('#knowledge-summary', 'A decision with a directed relationship to the measured result.');
  await fill('#knowledge-content', original.content); await select('#knowledge-memory-type', 'decision'); await fill('#knowledge-sources', original.source);
  await until('the actual saved fact to appear in related-memory choices', () => evaluate(id => Array.from(document.querySelector('#knowledge-relation-target')?.options || []).some(option => option.value === id), fact.id));
  await select('#knowledge-relation-type', 'supports'); await select('#knowledge-relation-target', fact.id);
  await click('[data-knowledge-action="add-relation"]');
  await until('the selected relationship to appear in the editor', () => evaluate(title => document.querySelector('#knowledge-relation-list')?.textContent.includes(title), factTitle));
  const decision = await saveEditor(decisionTitle);
  assert.equal(decision.memoryType, 'decision'); assert.deepEqual(decision.sources, [original.source]); assert.deepEqual(decision.relations, [{ type: 'supports', targetId: fact.id }]);
  evidence.records.push({ id: decision.id, memoryType: decision.memoryType, revision: decision.revision });
  check('The actual relationship picker and Add action save a directed link that appears in the memory reader', await evaluate(title => /Supports/.test(document.querySelector('.knowledge-memory-details')?.textContent || '') && document.querySelector('.knowledge-memory-details')?.textContent.includes(title), factTitle));

  await click('[data-knowledge-action="back"]'); await waitVisible('#knowledge-memory-filter');
  await select('#knowledge-memory-filter', 'decision');
  await until('the memory type filter to settle on the saved decision', () => evaluate(({ decisionId, factId }) => Boolean(document.querySelector(`#knowledge-results [data-id="${decisionId}"]`)) && !document.querySelector(`#knowledge-results [data-id="${factId}"]`) && !/Loading your library/.test(document.querySelector('#knowledge-results')?.textContent || ''), { decisionId: decision.id, factId: fact.id }));
  const filtered = await api(`/api/knowledge?${new URLSearchParams({ kind: 'memory', memoryType: 'decision', cwd })}`);
  assert.ok(filtered.some(item => item.id === decision.id)); assert.ok(!filtered.some(item => item.id === fact.id));
  check('Memory type filtering in the real library and server returns the decision without the fact');
  await select('#knowledge-memory-filter', '');
  await until('both saved memories to return after clearing the filter', () => evaluate(({ decisionId, factId }) => Boolean(document.querySelector(`#knowledge-results [data-id="${decisionId}"]`) && document.querySelector(`#knowledge-results [data-id="${factId}"]`)), { decisionId: decision.id, factId: fact.id }));
  await click(`#knowledge-results [data-id="${decision.id}"]`); await waitVisible('.knowledge-entry');

  await click('[data-knowledge-action="edit"]'); await waitVisible('#knowledge-editor');
  await select('#knowledge-memory-type', 'assumption'); await fill('#knowledge-content', 'An edited premise awaiting another observation.');
  await fill('#knowledge-sources', `${original.source}\nqa-review.md, pending follow-up`);
  const edited = await saveEditor(decisionTitle);
  assert.equal(edited.memoryType, 'assumption'); assert.equal(edited.revision, decision.revision + 1); assert.equal(edited.sources.length, 2); assert.deepEqual(edited.relations, decision.relations);
  await click('[data-knowledge-action="history"]'); await waitVisible('.knowledge-revision-grid');
  check('Real before-and-after history includes the changed memory type, sources and retained relationship', await evaluate(() => /Decision/.test(document.querySelector('.knowledge-revision-grid')?.textContent || '') && /Assumption/.test(document.querySelector('.knowledge-revision-grid')?.textContent || '') && /qa-review\.md/.test(document.querySelector('.knowledge-revision-grid')?.textContent || '')));
  await click('[data-knowledge-action="undo"]');
  const restored = await until('the edited memory metadata to be restored by Undo', async () => { const record = await api(`/api/knowledge/${encodeURIComponent(decision.id)}`); return record.revision === edited.revision + 1 ? record : null; });
  assert.equal(restored.memoryType, decision.memoryType); assert.equal(restored.content, original.content); assert.deepEqual(restored.sources, decision.sources); assert.deepEqual(restored.relations, decision.relations);
  await until('the restored audit view to finish loading', () => evaluate(revision => !document.querySelector('[data-knowledge-action="undo"]')?.disabled && document.querySelector('.knowledge-audit-source')?.textContent.includes(`Revision ${revision}`), restored.revision));
  evidence.undo = { beforeRevision: decision.revision, editedRevision: edited.revision, restoredRevision: restored.revision, exactMetadata: true };
  check('Undo from the real memory history restores the exact type, sources, content and relationship in a new durable revision');
  await screenshot('48-typed-knowledge-history-desktop.jpg');
  await click('[data-knowledge-action="back-entry"]'); await waitVisible('.knowledge-entry');

  await resize(320, 812);
  await evaluate(() => { const entry = document.querySelector('.knowledge-entry'); if (entry) entry.scrollTop = 0; });
  assert.ok(await geometry('320px typed memory reader'));
  const reader = await evaluate(() => {
    const node = document.querySelector('.knowledge-entry'), details = document.querySelector('.knowledge-memory-details');
    return { width: innerWidth, clientWidth: node?.clientWidth, scrollWidth: node?.scrollWidth, hasSources: details?.textContent.includes('qa-decision.md'), hasRelationship: details?.textContent.includes('Supports') };
  });
  assert.ok(reader.hasSources && reader.hasRelationship && reader.scrollWidth <= reader.clientWidth + 2);
  evidence.mobile320 = reader; await screenshot('49-typed-knowledge-reader-320.jpg');
  await click('[data-knowledge-action="edit"]'); await waitVisible('#knowledge-editor');
  await resize(390, 844);
  await evaluate(() => document.querySelector('#knowledge-memory-fields')?.scrollIntoView({ block: 'start' }));
  const editor = await evaluate(() => {
    const selectors = ['#knowledge-memory-type', '#knowledge-sources', '#knowledge-relation-type', '#knowledge-relation-target', '[data-knowledge-action="add-relation"]'];
    const fields = selectors.map(selector => { const node = document.querySelector(selector), rect = node?.getBoundingClientRect(); return { selector, present: Boolean(node), left: rect?.left, right: rect?.right, width: rect?.width, height: rect?.height, disabled: node?.disabled }; });
    return { width: innerWidth, memoryType: document.querySelector('#knowledge-memory-type')?.value, sources: document.querySelector('#knowledge-sources')?.value, relationship: document.querySelector('#knowledge-relation-list')?.textContent, fields };
  });
  assert.equal(editor.memoryType, 'decision'); assert.equal(editor.sources, original.source); assert.ok(editor.relationship.includes(factTitle));
  assert.ok(editor.fields.every(field => field.present && field.width >= 80 && field.left >= -1 && field.right <= editor.width + 1 && !field.disabled));
  assert.ok(await geometry('390px typed memory editor')); evidence.mobile390 = editor;
  await screenshot('50-typed-knowledge-editor-390.jpg');
  check('At 320px the typed memory reader and at 390px its source and relationship controls fit the viewport while retaining restored metadata');

  await click('#knowledge-editor [data-knowledge-action="cancel-edit"]'); await waitVisible('.knowledge-entry');
  await resize(1440, 900); await click('#modal-root .modal-close[data-action="close-modal"]');
  await until('the typed knowledge dialog to close', () => evaluate(() => !document.querySelector('#knowledge-view')));
  report.features ||= {}; report.features.typedKnowledge = true;
  return evidence;
}
