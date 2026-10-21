import assert from 'node:assert/strict';

/** Read-only mailbox fixture and local draft acceptance through the real application UI. */
export async function emailReaderUIJourney({ api, evaluate, waitVisible, until, click, fill, select, menu, check, screenshot, geometry, resize, report, cwd, emailFixture, cliCalls }) {
  const evidence = { fixtureOnly: true, externalRequests: 0, modelTurns: 0, mailboxCommands: [] };
  report.recovery ||= {}; report.recovery.emailReadableReply = evidence;
  const composer = () => evaluate(() => ({ to: document.querySelector('#email-to')?.value, subject: document.querySelector('#email-subject')?.value, body: document.querySelector('#email-body')?.value }));
  const draftRows = snapshot => Array.isArray(snapshot?.drafts) ? snapshot.drafts : snapshot?.drafts?.items || [];
  const before = await api('/api/email'), beforeDrafts = draftRows(before), beforeIds = new Set(beforeDrafts.map(item => item.id)), callStart = cliCalls.length;

  await resize(1440, 900); await menu('email'); await waitVisible('#email-oauth-provider');
  const held = await composer(); assert.ok(held.body?.trim(), 'OAuth journey must leave its unsent body in the composer.');
  if (!await evaluate(() => document.querySelector('.email-setup')?.open)) await click('.email-setup > summary');
  await waitVisible('#email-reload-config'); await click('#email-reload-config');
  await until('the deliberate saved-setup reload to enable mailbox controls', () => evaluate(() => document.querySelector('#email-reload-config')?.hidden && !document.querySelector('#email-folders-load')?.disabled));
  assert.deepEqual(await composer(), held); assert.equal(cliCalls.length, callStart);
  check('Reloading saved email setup enables the connected mailbox while preserving the unsent composer without a mailbox request');

  emailFixture.allowMailboxReads = true;
  try {
    await click('#email-folders-load'); await waitVisible('#email-folder-select');
    await until('the fixture folder catalog to finish loading', () => evaluate(() => !document.querySelector('#email-folder-select')?.disabled));
    const folders = await evaluate(() => Array.from(document.querySelector('#email-folder-select')?.options || []).map(option => ({ id: option.value, name: option.textContent })));
    assert.ok(folders.some(item => item.id === 'archive-id' && item.name === 'Archive'));
    assert.ok(folders.some(item => item.id === 'inbox-id' && item.name === 'Inbox'));
    await select('#email-folder-select', 'archive-id');
    assert.equal(await evaluate(() => document.querySelector('#email-folder').value), 'archive-id');
    check('The folder picker displays Archive while selecting its exact provider folder ID');

    await click('#email-mailbox-read'); await waitVisible('#email-messages [data-email-message="42"]');
    await until('the fixture mailbox list to finish loading', () => evaluate(() => !document.querySelector('#email-messages [data-email-message="42"]')?.disabled));
    await click('#email-messages [data-email-message="42"]'); await waitVisible('#email-message-preview');
    await until('the decoded message to be displayed and its reply action enabled', () => evaluate(() => document.querySelector('.email-message-text')?.textContent.includes('A readable message about café.') && !document.querySelector('#email-reply-draft')?.disabled));
    const message = await evaluate(() => ({
      heading: document.querySelector('.email-reader-heading h4')?.textContent,
      headers: document.querySelector('.email-message-headers')?.textContent,
      body: document.querySelector('.email-message-text')?.textContent,
      attachments: document.querySelector('.email-message-attachments')?.textContent,
      activeNodes: document.querySelectorAll('#email-message-preview img, #email-message-preview script, #email-message-preview iframe, #email-message-preview object, #email-message-preview embed').length,
      sourceOpen: document.querySelector('#email-message-source')?.open,
      raw: document.querySelector('#email-message-raw')?.textContent,
    }));
    assert.equal(message.heading, 'Readable café'); assert.match(message.headers, /José/); assert.match(message.body, /A readable message about café\./); assert.match(message.attachments, /report\.txt/);
    assert.equal(message.activeNodes, 0); assert.equal(message.sourceOpen, false); assert.equal(message.raw, '');
    evidence.message = { subject: message.heading, decodedSender: message.headers.includes('José'), readableBody: true, attachment: 'report.txt', activeNodes: message.activeNodes };
    check('The real email reader shows decoded accented headers and body with attachment descriptions and creates no image, script or embedded content');

    await click('#email-message-source > summary');
    await until('the explicitly opened message source to receive raw text', () => evaluate(() => document.querySelector('#email-message-source')?.open && Boolean(document.querySelector('#email-message-raw')?.textContent)));
    const raw = await evaluate(() => document.querySelector('#email-message-raw').textContent);
    assert.match(raw, /Subject:/i); assert.match(raw, /Reply-To:/i); assert.match(raw, /MIME-Version:/i);
    assert.equal(await evaluate(() => document.querySelectorAll('#email-message-raw img, #email-message-raw script').length), 0);
    await click('#email-message-source > summary');
    evidence.lazySource = true;
    check('Message source is populated as literal raw text only after its disclosure is explicitly opened');

    let captureIndex = 51;
    for (const width of [320, 390]) {
      await resize(width, 844);
      await evaluate(() => document.querySelector('#email-message-preview')?.scrollIntoView({ block: 'start' }));
      const reader = await evaluate(() => {
        const pane = document.querySelector('#email-workspace'), preview = document.querySelector('#email-message-preview'), reply = document.querySelector('#email-reply-draft');
        const r = preview.getBoundingClientRect(), b = reply.getBoundingClientRect();
        return { width: innerWidth, paneClientWidth: pane.clientWidth, paneScrollWidth: pane.scrollWidth, preview: { left: r.left, right: r.right, clientWidth: preview.clientWidth, scrollWidth: preview.scrollWidth }, reply: { left: b.left, right: b.right, width: b.width, disabled: reply.disabled } };
      });
      assert.ok(reader.paneScrollWidth <= reader.paneClientWidth + 2 && reader.preview.left >= -1 && reader.preview.right <= width + 1 && reader.preview.scrollWidth <= reader.preview.clientWidth + 2);
      assert.ok(reader.reply.left >= -1 && reader.reply.right <= width + 1 && reader.reply.width >= 40 && !reader.reply.disabled);
      assert.ok(await geometry(`${width}px decoded email reader`));
      await screenshot(`${captureIndex++}-email-readable-message-${width}.jpg`);
      await evaluate(() => document.querySelector('#email-mailbox-form')?.scrollIntoView({ block: 'start' }));
      const controls = await evaluate(() => ['#email-folder', '#email-folders-load', '#email-folder-select', '#email-query', '#email-mailbox-read'].map(selector => {
        const node = document.querySelector(selector), rect = node.getBoundingClientRect();
        return { selector, left: rect.left, right: rect.right, width: rect.width, height: rect.height, disabled: node.disabled, visible: Boolean(node.getClientRects().length && !node.closest('[hidden]')) };
      }));
      assert.ok(controls.every(item => item.visible && !item.disabled && item.width >= 40 && item.left >= -1 && item.right <= width + 1));
      assert.ok(await geometry(`${width}px mailbox folder controls`));
      await screenshot(`${captureIndex++}-email-folder-controls-${width}.jpg`);
      evidence[`mobile${width}`] = { reader, controls };
    }
    check('Decoded email, Reply and exact-folder controls fit both 320px and 390px without horizontal overflow');
    await resize(1440, 900);

    await click('#email-reply-draft');
    await until('reply preparation to explain the occupied composer', () => evaluate(() => /current draft/.test(document.querySelector('#email-receipt')?.textContent || '') && document.querySelector('#email-receipt')?.dataset.error === 'true'));
    assert.deepEqual(await composer(), held); assert.equal(draftRows(await api('/api/email')).length, beforeDrafts.length);
    evidence.unsentComposerPreserved = true;
    check('Reply as local draft preserves every field of an existing unsent composer and does not save a new draft');

    await click('#email-draft-new'); assert.deepEqual(await composer(), { to: '', subject: '', body: '' });
    await click('#email-reply-draft');
    const reply = await composer();
    assert.equal(reply.to, 'reply@example.test'); assert.equal(reply.subject, 'Re: Readable café'); assert.match(reply.body, /> A readable message about café\./);
    assert.equal(draftRows(await api('/api/email')).length, beforeDrafts.length);
    evidence.replyPrepared = { to: reply.to, subject: reply.subject, quotedMessage: true, automaticallySaved: false };
    check('After explicit New draft, Reply fills the Reply-To address, subject and quoted plain text without automatically saving');
    await click('#email-draft-save');
    await until('the explicit local reply save to finish', () => evaluate(() => /Local draft saved/.test(document.querySelector('#email-receipt')?.textContent || '') && !document.querySelector('#email-draft-save')?.disabled));
    const after = await api('/api/email'), afterDrafts = draftRows(after), added = afterDrafts.filter(item => !beforeIds.has(item.id));
    assert.equal(afterDrafts.length, beforeDrafts.length + 1); assert.equal(added.length, 1);
    const readback = await api(`/api/email/drafts/${encodeURIComponent(added[0].id)}`), draft = readback.draft || readback;
    assert.deepEqual(draft.to, [reply.to]); assert.equal(draft.subject, reply.subject); assert.equal(draft.body, reply.body); assert.equal(draft.sent, false); assert.equal(draft.state, 'local_draft'); assert.match(draft.eml, /X-Unsent: 1/);
    assert.equal(after.capabilities.send, false);
    evidence.savedDraft = { id: draft.id, requestId: draft.requestId, state: draft.state, sent: draft.sent, exactContent: true, countBefore: beforeDrafts.length, countAfter: afterDrafts.length };
    check('Explicit Save creates exactly one durable local reply with the exact editable text, X-Unsent evidence and sent=false');

    const actualCalls = cliCalls.slice(callStart);
    assert.equal(actualCalls.length, 3); assert.ok(actualCalls.every(call => call.fixtureOnly === true));
    assert.ok(actualCalls.slice(1).every(call => call.args.includes('--mailbox=archive-id')), 'Message listing and reading must use the selected exact folder ID.');
    evidence.mailboxCommands = actualCalls.map(call => ({ args: [...call.args], fixtureOnly: call.fixtureOnly }));
    evidence.readOnlyFixtureCalls = actualCalls.length;
    report.features ||= {}; report.features.emailReadableReply = true;
    return evidence;
  } finally {
    emailFixture.allowMailboxReads = false;
  }
}
