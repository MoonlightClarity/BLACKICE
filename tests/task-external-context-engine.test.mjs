import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { HarnessEngine } from '../lib/engine.mjs';

const graph = { name: 'External context', nodes: [
  { id: 'i', type: 'input' }, { id: 'a', type: 'agent', name: 'Agent', model: 'fixture-model', prompt: 'Read a text file' },
  { id: 'o', type: 'output' },
], edges: [{ source: 'i', target: 'a' }, { source: 'a', target: 'o' }],
settings: { maxParallel: 1, planningMode: 'off' } };
class Runtime extends EventEmitter {
  status() { return { connected: true, authenticated: true, models: [{ id: 'fixture-model', supportsTools: true }] }; }
  async runAgent(options) { return this.execute(options); }
}
test('a Directory agent receives a short reference, pages the original source text, and preserves Directory receipts', { timeout: 40000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'external-context-engine-'));
  const filename = path.join(root, 'large-document.txt');
  const sentinel = 'LAST-VERIFIED-MARKER-1987';
  await writeFile(filename, 'begin\n' + 'alpha beta gamma '.repeat(1500) + '\n' + sentinel);
  const runtime = new Runtime();
  const engine = await new HarnessEngine({ runtime, dataDir: path.join(root, 'engine'), defaultCwd: root }).init();
  t.after(async () => { await engine.close(); await rm(root, { recursive: true, force: true }); });
  let baselineText, visibleText, recoveredText, evidenceId;
  runtime.execute = async options => {
    let number = 0;
    const call = (name, args) => options.onToolCall({ name, arguments: args, callId: 'context-fixture-' + (++number) });
    if (!options.dynamicTools.some(tool => tool.name === 'relay_directory_action')) {
      assert(options.dynamicTools.some(tool => tool.name === 'relay_context_page'));
      const raw = await call('relay_workspace', { action: 'read', path: filename });
      assert.equal(raw.success, true);
      const pointer=JSON.parse(raw.contentItems[0].text);
      assert.equal(pointer.externalContext,true,'Ordinary Chat also externalizes oversized results.');
      let offset=0;baselineText='';
      for(let n=0;n<20;n++){
        const page=await call('relay_context_page',{action:'read',reference:pointer.reference,offset,maxBytes:8192});
        assert.equal(page.success,true);
        const part=JSON.parse(page.contentItems[0].text);
        baselineText+=part.text;offset=part.nextOffset;
        if(part.complete)break;
      }
      assert(baselineText.includes(sentinel), 'Ordinary Chat recovered the complete source result.');
      return { output: 'Baseline read.' };
    }
    assert(options.dynamicTools.some(tool => tool.name === 'relay_context_page'), 'The retrieval tool is attached with Action Directory.');
    assert(options.prompt.includes('"view":"bounded-active-context"'), 'The provider receives the bounded Directory view.');
    const dir = (action, rest = {}) => call('relay_directory_action', { action, ...rest });
    assert.equal((await dir('plan', { actions: [{ id: 'inspect', objective: 'Inspect the full document and its final marker', dependsOn: [] }] })).success, true);
    assert.equal((await dir('focus', { id: 'inspect' })).success, true);
    const read = await call('relay_workspace', { action: 'read', path: filename });
    assert.equal(read.success, true);
    visibleText = read.contentItems[0].text;
    const pointer = JSON.parse(visibleText);
    assert.equal(pointer.externalContext, true);
    assert.equal(pointer.tool, 'relay_workspace');
    evidenceId = read.contentItems.at(-1).text.match(/receipt-\d+/)[0];
    assert.match(pointer.preview.tail,new RegExp(sentinel), 'Preserve the diagnostic tail even when most of the result is archived.');
    assert(visibleText.length < baselineText.length / 5,'The entire large result is not resident in the model response.');
    const search = await call('relay_context_page', { action: 'search', reference: pointer.reference, needle: sentinel });
    assert.equal(search.success, true);
    const found = JSON.parse(search.contentItems[0].text);
    assert.equal(found.matches.length, 1, 'The tail is found without paging all earlier text.');
    const selected = await call('relay_context_page', { action: 'read', reference: pointer.reference, offset: found.matches[0].offset });
    assert(JSON.parse(selected.contentItems[0].text).text.startsWith(sentinel));
    let offset = 0, reconstructed = '';
    for (let attempt = 0; attempt < 20; attempt++) {
      const page = await call('relay_context_page', { action: 'read', reference: pointer.reference, offset, maxBytes: 8192 });
      assert.equal(page.success, true, JSON.stringify(page));
      const content = JSON.parse(page.contentItems[0].text);
      assert(content.nextOffset > offset);
      reconstructed += content.text;
      offset = content.nextOffset;
      if (content.complete) break;
    }
    recoveredText = reconstructed;
    assert.equal(recoveredText, baselineText, 'Pages reproduce the unmodified, exact original tool response.');
    assert.equal((await dir('observe', { outcome: 'objective-met', id: 'inspect',
      claim: 'The document was read through to its exact final marker.', receipts: [evidenceId] })).success, true);
    assert.equal(await options.onBeforeFinal({ output: 'Verified final marker.', signal: options.signal }), undefined);
    return { output: 'Verified final marker.' };
  };
  const off = engine.startRun({ workflow: graph, input: { task: 'Read the document', directoryActions: 'off' } });
  await engine.executions.get(off.id);
  assert.equal(engine.getRun(off.id).status, 'completed', engine.getRun(off.id).error);
  const on = engine.startRun({ workflow: graph, input: { task: 'Read the document and verify its final marker', directoryActions: 'on' } });
  await engine.executions.get(on.id);
  assert.equal(engine.getRun(on.id).status, 'completed', engine.getRun(on.id).error);
  const finalState = (await engine.actionDirectories.get(on.id, 'Read the document')).read();
  assert.equal(finalState.actions[0].state, 'observed');
  assert(finalState.receipts.some(receipt => receipt.id === evidenceId && receipt.success === true));
  assert(visibleText.length < baselineText.length / 5, 'The model-facing read result is substantially shorter.');
  assert.equal(recoveredText, baselineText);
  const baseBytes=Buffer.byteLength(baselineText), viewBytes=Buffer.byteLength(visibleText);
  t.diagnostic('Fixture model-facing tool result: '+baseBytes+' -> '+viewBytes+' UTF-8 bytes ('+((1-viewBytes/baseBytes)*100).toFixed(1)+'% reduction); recovered original byte-for-byte.');
});
