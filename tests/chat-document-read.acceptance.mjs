import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {promises as fs} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {HarnessEngine} from '../lib/engine.mjs';
import {scoreDocument} from './fixtures/document-skill-acceptance.mjs';

function syntheticPdf(marker) {
  const stream = 'BT /F1 12 Tf 40 740 Td (' + marker + ') Tj ET\n';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Length ' + stream.length + ' >>\nstream\n' + stream + 'endstream'];
  let result = '%PDF-1.7\n';
  const offsets = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(result.length);
    result += (index + 1) + ' 0 obj\n' + object + '\nendobj\n';
  }
  const xref = result.length;
  return Buffer.from(result + 'xref\n0 6\n0000000000 65535 f \n' +
    offsets.map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('') +
    'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n');
}

for (const rejected of [false,true]) test(rejected
  ? 'scripted Chat can distinguish a found file from an unreadable PDF and report the real blocker'
  : 'scripted Chat runs real nested filename search and direct PDF read, then uses returned text', {timeout:15000}, async t => {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'blackice-chat-find-read-'));
  let engine;
  t.after(async () => {
    try { await engine?.close(); }
    finally { await fs.rm(dir, {recursive:true,force:true}); }
  });
  const cwd = path.join(dir, 'workspace'), searchRoot = path.join(dir,'outside'), nested = path.join(searchRoot,'nested');
  await fs.mkdir(cwd); await fs.mkdir(nested,{recursive:true});
  const target = path.join(nested,'Synthetic analyst resume.pdf');
  const marker = 'Marker-' + randomUUID();
  const bytes = rejected ? Buffer.from('invalid synthetic PDF\n') : syntheticPdf(marker);
  await fs.writeFile(target,bytes);
  const events = [];

  class Runtime extends EventEmitter {
    defaultModel = 'offline-fixture';
    status() { return {connected:true,authenticated:true,defaultModel:this.defaultModel}; }
    async savedThreadModel() { return this.defaultModel; }
    async runAgent({onToolCall}) {
      const found = await onToolCall({name:'relay_find_files',arguments:{query:'Synthetic analyst resume',path:searchRoot}});
      const matches = JSON.parse(found.contentItems[0].text).matches?.map(item => item.path);
      events.push({op:'files.find',success:found.success,matches});
      assert.deepEqual(matches,[target]);
      const read = await onToolCall({name:'relay_workspace',arguments:{action:'read',path:matches[0]}});
      if (rejected) {
        assert.equal(read.success,false);
        const error=read.contentItems[0].text;
        assert.match(error,/no PDF header/i);
        assert.match(error,/damaged or use another format/i);
        assert.doesNotMatch(error,new RegExp(marker));
        events.push({op:'workspace.read',success:false,target:matches[0],error});
        return {output:'File found but not read. '+error+' Export a fresh PDF or supply a DOCX.',threadId:'synthetic-chat-document-thread'};
      }
      const page = JSON.parse(read.contentItems[0].text);
      const text = page.pages?.[0]?.text;
      events.push({op:'workspace.read',success:read.success,target:matches[0],text});
      return {output:text || '',threadId:'synthetic-chat-document-thread'};
    }
  }
  engine = await new HarnessEngine({runtime:new Runtime(),dataDir:path.join(dir,'data'),defaultCwd:cwd}).init();
  const graph = {
    id:'synthetic-chat-find-read',name:'Synthetic Chat file discovery',
    nodes:[{id:'input',type:'input',name:'Input'},{id:'agent',type:'agent',name:'Agent',model:'offline-fixture',prompt:'Read the local synthetic document.'},{id:'output',type:'output',name:'Output'}],
    edges:[{id:'in',source:'input',target:'agent'},{id:'out',source:'agent',target:'output'}],
    settings:{planningMode:'off',maxParallel:1},
  };
  const admission = engine.startRun({workflow:graph,input:{task:'Find the synthetic analyst resume and report its marker.',planningMode:'off',directoryMode:'off'}});
  const deadline = Date.now() + 10000;
  let run;
  do {
    run = engine.runs.get(admission.id);
    if (run?.settled) break;
    await delay(10);
  } while (Date.now() < deadline);
  assert.equal(run?.status,'completed',run?.error);
  assert.equal(run?.goal ?? null,null,'Chat fixture must not admit an automatic Goal');
  const result = scoreDocument({events,target,marker,output:JSON.stringify(run.output),settled:run.settled});
  if (rejected) {
    assert.equal(result.passed,false,'A found but unreadable file is not a successful read');
    assert.equal(result.callsThroughUsable,null);
    assert.equal(result.foundBeforeRead,true);
    assert.equal(result.noShell,true);
    assert.deepEqual(events.map(e=>[e.op,e.success]),[['files.find',true],['workspace.read',false]]);
    assert.match(JSON.stringify(run.output),/File found but not read.*no PDF header.*damaged or use another format/i);
    assert.match(JSON.stringify(run.output),/Export a fresh PDF or supply a DOCX/);
    assert.doesNotMatch(JSON.stringify(run.output),new RegExp(marker));
  } else {
    assert.equal(result.passed,true,JSON.stringify(result));
    assert.equal(result.callsThroughUsable,2);
  }
  assert.deepEqual(await fs.readdir(nested),[path.basename(target)]);
  assert.deepEqual(await fs.readdir(cwd),[]);
  assert.deepEqual(await fs.readFile(target),bytes);
});
