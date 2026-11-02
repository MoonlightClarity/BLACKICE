import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PlanningBrowserStore } from '../lib/planning-browser.mjs';
import { planningProgramXml, parsePlanningProgramXml } from '../public/planning-program-xml.mjs';

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'blackice-xml-canonical-'));
  const store = new PlanningBrowserStore({ dataDir: dir });
  await store.init();
  t.after(async () => { await store.close(); await fs.rm(dir, { recursive: true, force: true }); });
  let doc = await store.create({ conversationId: 'xml-conversation', title: 'XML planning test',
    objective: 'Decide which evidence matters and perform one bounded check.', cwd: dir });
  doc = await store.addNode(doc.id, { id: 'frame', kind: 'frame', title: 'Initial framing',
    prompt: 'Ask a bounded question.' });
  doc = await store.addNode(doc.id, { id: 'observation', parentId: 'frame', kind: 'inquiry',
    title: 'Inspect evidence', prompt: 'Read one relevant observation.' },
    { expectedParentRevision: doc.nodes.find(node => node.id === 'frame').revision });
  return { store, dir, doc };
}
const extra = (id = 'verification') => '<module id="' + id + '" number="1.2" kind="action" state="pending">' +
  '<title>Verify effect</title><prompt>Read the recorded output and check one condition.</prompt>' +
  '<done-when>One concrete verification result is recorded.</done-when>' +
  '<skip-reason></skip-reason></module>';

test('the saved XML is a canonical versioned definition that roundtrips with the operational JSON ledger', async t => {
  const { store, doc } = await fixture(t);
  assert.match(doc.programXml, /<planning-program version="1" request-id="/);
  const parsed = parsePlanningProgramXml(doc.programXml);
  assert.equal(parsed.expectedRevision, doc.revision);
  assert.equal(parsed.nodes.length, 2);
  assert.deepEqual(parsed.nodes.map(node => [node.id,node.parentId]), [['frame',null],['observation','frame']]);
  const disk = JSON.parse(await fs.readFile(store.file(doc.id), 'utf8'));
  assert.equal(disk.programXml, doc.programXml);
  const reopened = await store.get(doc.id);
  assert.equal(reopened.programXml, doc.programXml);
  assert.equal(planningProgramXml(reopened), doc.programXml);
});

test('one revisioned XML edit updates a nested graph atomically and preserves outside audit records', async t => {
  const { store, doc } = await fixture(t);
  const source = doc.programXml
    .replace('<title>Initial framing</title>', '<title>Reframed outcome</title>')
    .replace(/(<module id="observation"[\s\S]*?<skip-reason>)<\/skip-reason>/, '$1Not needed for this outcome.</skip-reason>')
    .replace('</module>\n  </outline>', extra() + '</module>\n  </outline>');
  const result = await store.updateProgram(doc.id, { expectedRevision: doc.revision, xml: source }, { actor: {type:'human',id:'test-person'} });
  assert.equal(result.revision, doc.revision + 1);
  assert.deepEqual(result.nodes.map(node => node.id), ['frame','observation','verification']);
  assert.equal(result.nodes.find(node => node.id === 'frame').title, 'Reframed outcome');
  assert.equal(result.nodes.find(node => node.id === 'observation').skipReason, 'Not needed for this outcome.');
  assert.equal(result.nodes.find(node => node.id === 'verification').doneWhen, 'One concrete verification result is recorded.');
  assert.equal(result.nodes.find(node => node.id === 'verification').parentId,'frame');
  assert.match(result.programXml,/number="1\.2"/);
  assert.equal(result.history.at(-1).action, 'updateProgram');
  assert.equal(result.responses.length, 0);
  assert.equal(result.attempts.length, 0);
  const disk = JSON.parse(await fs.readFile(store.file(doc.id), 'utf8'));
  assert.equal(disk.programXml, result.programXml);
});

test('XML persistence rejects stale revisions and destructive or unauthorized program changes without partial writes', async t => {
  const { store, doc } = await fixture(t);
  const original=await fs.readFile(store.file(doc.id),'utf8');
  const bad = [
    doc.programXml.replace('id="observation"', 'id="frame"'),
    doc.programXml.replace(/<module id="observation"[\s\S]*?<\/module>/,''),
    doc.programXml.replace('<title>Initial framing</title>', '<title>&external;</title>'),
    doc.programXml.replace('<title>Initial framing</title>', '<!DOCTYPE x><title>Initial framing</title>'),
    doc.programXml.replace('kind="inquiry"','kind="cycle"'),
    doc.programXml.replace('<title>Initial framing</title>', '<state>verified</state><title>Initial framing</title>')
  ];
  for(const xml of bad)await assert.rejects(async()=>store.updateProgram(doc.id,{expectedRevision:doc.revision,xml}));
  assert.equal(await fs.readFile(store.file(doc.id),'utf8'),original);
  const first=await store.updateProgram(doc.id,{expectedRevision:doc.revision,xml:doc.programXml});
  await assert.rejects(store.updateProgram(doc.id,{expectedRevision:doc.revision,xml:doc.programXml}),{code:'PLANNING_BROWSER_CONFLICT'});
  assert.equal((await store.get(doc.id)).revision,first.revision);
});

test('the XML editor may change nesting and sibling order but never forge a completion state',async t=>{
  const {store,doc}=await fixture(t);
  const after=doc.programXml.replace('state="empty"','state="ready"');
  const result=await store.updateProgram(doc.id,{expectedRevision:doc.revision,xml:after});
  assert.equal(result.nodes.find(node=>node.id==='frame').readiness.state,'empty');
  assert.ok(!result.programXml.includes('kind="frame" state="ready"'));
  const staleXml=result.programXml.replace('number="1.1"','number="100.7"');
  const save=await store.updateProgram(doc.id,{expectedRevision:result.revision,xml:staleXml});
  assert.match(save.programXml,/number="1\.1"/);
});
