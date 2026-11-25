import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { HarnessEngine } from '../lib/engine.mjs';
import { AttachmentStore, ATTACHMENT_LIMITS, ATTACHMENT_SCHEMA_VERSION, ATTACHMENT_TOOL } from '../lib/attachments.mjs';
import { createMissionWorkflow } from '../public/mission-model.mjs';

const ids = Object.fromEntries(['text', 'image', 'pdf', 'file'].map((kind, i) => [kind, `file_${String(i + 1).repeat(32)}`]));
const fileTool = options => options.dynamicTools.find(tool => tool.name === 'relay_files');
const wait = async predicate => { const until = Date.now() + 5000; while (Date.now() < until) { const value = predicate(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 10)); } throw Error('Attachment-schema fixture did not settle.'); };
class FixtureAttachments {
  constructor() {
    this.calls = []; this.text = 'Actual <file> & text.\nSecond line.';
    this.entries = new Map(Object.entries(ids).map(([kind, id]) => [id, { id, kind, name: `fixture.${{ text: 'txt', image: 'png', pdf: 'pdf', file: 'bin' }[kind]}`, mime: { text: 'text/plain', image: 'image/png', pdf: 'application/pdf', file: 'application/octet-stream' }[kind], size: 40, sha256: 'a'.repeat(64), reader: 'MODERN_READER_DETAILS' }]));
  }
  validateIds(values) { assert.ok(values.every(id => this.entries.has(id))); return [...new Set(values)]; }
  async get(id) { this.calls.push({ action: 'get', id }); this.beforeGet?.(id); return structuredClone(this.entries.get(id)); }
  async snapshot(values) { this.calls.push({ action: 'snapshot', ids: [...values] }); return values.map(id => structuredClone(this.entries.get(id))); }
  async prompt() { this.calls.push({ action: 'prompt' }); return 'MODERN_ATTACHMENT_PROMPT: PDF pages, read_bytes and export.\n'; }
  async readChars(id, options) { this.calls.push({ action: 'readChars', id, options }); assert.equal(this.entries.get(id).kind, 'text', 'Legacy prompt must not decode a PDF or binary'); const startChar = options.startChar ?? 0; return { attachment: this.entries.get(id), text: this.text.slice(startChar, startChar + (options.charCount ?? 10000)), startChar, totalChars: this.text.length }; }
  async read(id, options) { await this.get(id); options.signal?.throwIfAborted(); this.calls.push({ action: 'read', id, options }); return { attachment: this.entries.get(id), lines: [{ line: 1, text: 'Actual file text.' }] }; }
  async search(id, options) { this.calls.push({ action: 'search', id, options }); return { attachment: this.entries.get(id), matches: [{ text: 'Actual file text.' }] }; }
  async image(id, options) { this.calls.push({ action: 'image', id, options }); return { attachment: this.entries.get(id), bytes: Buffer.from('fixture pixels'), mime: 'image/png', width: 1, height: 1 }; }
  async readBytes(id, options) { this.calls.push({ action: 'readBytes', id, options }); return { attachment: this.entries.get(id), dataBase64: 'AQID', nextOffset: null }; }
  async export(id, options) { this.calls.push({ action: 'export', id, options }); return { attachment: this.entries.get(id), path: path.join(options.cwd, 'owned-fixture-copy.bin') }; }
}
async function fixture(t, execute, { model = 'fixture', threadId = 'native-attachment-thread' } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'blackice-attachment-schema-')), cwd = path.join(directory, 'workspace'); await mkdir(cwd);
  const attachments = new FixtureAttachments();
  class Runtime extends EventEmitter {
    constructor() { super(); this.calls = []; }
    status() { return { connected: true, authenticated: true, defaultModel: model }; }
    async runAgent(options) { this.calls.push(options); options.onEvent({ type: 'thread', threadId }); return execute(options, this.calls.length, attachments, cwd); }
    async close() {}
  }
  const runtime = new Runtime(), engine = await new HarnessEngine({ runtime, attachments, dataDir: directory, defaultCwd: cwd }).init();
  t.after(async () => { await engine.close(); assert.match(path.basename(directory), /^blackice-attachment-schema-/); await rm(directory, { recursive: true, force: true }); });
  const workflow = createMissionWorkflow({ id: 'attachment-schema-fixture', task: 'Use the attached task files.', cwd, planningMode: 'off' });
  return { engine, runtime, attachments, cwd, workflow, threadId, start: () => engine.startRun({ workflow, input: { task: 'Read the actual attachment.', attachmentIds: Object.values(ids) } }), settled: id => wait(() => engine.getRun(id).settled && engine.getRun(id)) };
}
const completed = run => assert.equal(run.status, 'completed', run.nodes.agent.error || run.error);
const call = (options, args, context) => options.onToolCall({ name: 'relay_files', arguments: args }, context);

test('fresh native attachment schema is recorded and survives continuation and Retry', async t => {
  const f = await fixture(t, async (options, number, store, cwd) => {
    assert.deepEqual(fileTool(options), ATTACHMENT_TOOL);
    assert.match(options.prompt, /MODERN_ATTACHMENT_PROMPT/);
    if (number === 1) {
      await call(options, { action: 'read', attachmentId: ids.pdf, startPage: 2, pageCount: 1 });
      await call(options, { action: 'read_bytes', attachmentId: ids.file, offset: 0, byteCount: 3 });
      await call(options, { action: 'export', attachmentId: ids.file });
      assert.equal(store.calls.find(item => item.action === 'export').options.cwd, cwd);
    }
    if (number === 2) throw Error('Fixture response lost after a native thread was established.');
    return { output: 'File result.', threadId: 'native-attachment-thread' };
  });
  const first = await f.settled(f.start().id); completed(first); assert.equal(first.nodes.agent.attachmentSchemaVersion, ATTACHMENT_SCHEMA_VERSION);
  const failed = await f.settled(f.engine.continueRun(first.id, { nodeId: 'agent', message: 'Continue with the current file gateway.' }).id); assert.equal(failed.status, 'failed');
  assert.equal(failed.nodes.agent.resumeAttachmentSchemaVersion, ATTACHMENT_SCHEMA_VERSION);
  const retry = await f.settled(f.engine.retryRun(failed.id).id); completed(retry); assert.equal(retry.nodes.agent.attachmentSchemaVersion, ATTACHMENT_SCHEMA_VERSION);
  assert.equal(f.runtime.calls[2].threadId, f.threadId);
});

test('unversioned native attachment sessions reject Continue and Retry without changing saved state', async t => {
  const f=await fixture(t,async()=>({output:'Saved attachment result.',threadId:'native-attachment-thread'}));
  const first=await f.settled(f.start().id);completed(first);
  const saved=f.engine.runs.get(first.id);delete saved.nodes.agent.attachmentSchemaVersion;
  const before=structuredClone(saved),count=f.engine.runs.size,calls=structuredClone(f.attachments.calls);
  for(const retry of [false,true])assert.throws(()=>retry?f.engine.retryRun(first.id):f.engine.continueRun(first.id,{nodeId:'agent',message:'Continue'}),{code:'NATIVE_CATALOG_UNSUPPORTED'});
  assert.deepEqual(saved,before);assert.equal(f.engine.runs.size,count);assert.equal(f.runtime.calls.length,1);assert.deepEqual(f.attachments.calls,calls);
});

test('current native attachment continuation retains text/image scope and cancellation', async t => {
  const f=await fixture(t,async(options,number,store)=>{
    assert.deepEqual(fileTool(options),ATTACHMENT_TOOL);
    if(number===2){
      assert.equal((await call(options,{action:'list'})).success,true);
      assert.equal((await call(options,{action:'read',attachmentId:ids.text})).success,true);
      assert.equal((await call(options,{action:'read',attachmentId:ids.text,startChar:0,charCount:5})).success,true);
      assert.equal((await call(options,{action:'search',attachmentId:ids.text,query:'Actual'})).success,true);
      assert.equal((await call(options,{action:'image',attachmentId:ids.image})).contentItems[1].type,'inputImage');
      const before=store.calls.length;
      await assert.rejects(call(options,{action:'read',attachmentId:'file_'+'f'.repeat(32)}),{status:403});
      assert.equal(store.calls.length,before,'Foreign metadata must not be read');
      const abort=new AbortController();store.beforeGet=()=>abort.abort();
      await assert.rejects(call(options,{action:'read',attachmentId:ids.text},{signal:abort.signal}),{name:'AbortError'});
      store.beforeGet=null;assert.equal(store.calls.at(-1).action,'get','Metadata cancellation precedes reading');
    }
    return {output:'Observed current files.',threadId:'native-attachment-thread'};
  });
  const first=await f.settled(f.start().id);completed(first);
  const next=await f.settled(f.engine.continueRun(first.id,{nodeId:'agent',message:'Read current files.'}).id);completed(next);
  assert.equal(f.runtime.calls.length,2);assert.equal(f.runtime.calls[1].threadId,f.threadId);
});

test('tampered native attachment catalog fails its fingerprint before provider dispatch', async t=>{
  const f=await fixture(t,async()=>({output:'Saved file result.',threadId:'native-attachment-thread'}));
  const first=await f.settled(f.start().id);completed(first);
  const saved=f.engine.runs.get(first.id);saved.nodes.agent.toolNames=saved.nodes.agent.toolNames.filter(name=>name!=='relay_files');
  const before=structuredClone(saved);
  const next=await f.settled(f.engine.continueRun(first.id,{nodeId:'agent',message:'Continue'}).id);
  assert.equal(next.status,'failed');assert.match(next.error,/different execution contract or tool catalog/);
  assert.deepEqual(saved,before);assert.equal(f.runtime.calls.length,1);
});

test('API continuations receive current attachment tools even when an earlier schema version is absent', async t => {
  const threadId = 'provider_attachment-fixture';
  const f = await fixture(t, async options => { assert.deepEqual(fileTool(options), ATTACHMENT_TOOL); return { output: 'API tool catalog refreshed.', threadId }; }, { model: 'fixture-api::model', threadId });
  const first = await f.settled(f.start().id); completed(first); delete f.engine.runs.get(first.id).nodes.agent.attachmentSchemaVersion;
  const next = await f.settled(f.engine.continueRun(first.id, { nodeId: 'agent', message: 'Continue through the API provider.' }).id); completed(next); assert.equal(next.nodes.agent.attachmentSchemaVersion, ATTACHMENT_SCHEMA_VERSION); assert.equal(f.runtime.calls[1].threadId, threadId);
});

test('unchanged native continuation and fresh chat retain current attachment capabilities',async t=>{
  const f=await fixture(t,async options=>{assert.deepEqual(fileTool(options),ATTACHMENT_TOOL);return {output:'Current result.',threadId:'native-attachment-thread'};});
  const first=await f.settled(f.start().id);completed(first);
  const next=await f.settled(f.engine.continueRun(first.id,{nodeId:'agent',message:'Continue current history'}).id);completed(next);
  assert.equal(next.nodes.agent.attachmentSchemaVersion,ATTACHMENT_SCHEMA_VERSION);assert.equal(f.runtime.calls[1].threadId,f.threadId);
  const fresh=await f.settled(f.start().id);completed(fresh);assert.equal(f.runtime.calls[2].threadId,undefined);
});

test('current attachment context stays bounded with ten heavily escaped text excerpts',async t=>{
  let expected;
  const f=await fixture(t,async options=>{
    assert.ok(expected.length<=ATTACHMENT_LIMITS.promptChars);assert.ok(options.prompt.includes(expected));
    assert.doesNotMatch(expected,/<&>/);assert.match(expected,/excerptTruncated":true/);
    const metadata=JSON.parse(expected.slice(expected.indexOf('\n[')+1));assert.equal(metadata.length,10);
    assert.ok(metadata.every(entry=>entry.excerptTruncated===true));
    return {output:'Bounded context retained.',threadId:'native-attachment-thread'};
  });
  const attachmentIds=Array.from({length:10},(_,i)=>'file_'+i.toString(16).repeat(32));
  f.attachments.entries=new Map(attachmentIds.map(id=>[id,{...f.attachments.entries.get(ids.text),id,name:'<&>'.repeat(80)}]));
  f.attachments.text='<&>'.repeat(30000);
  f.attachments.prompt=async(values,options)=>AttachmentStore.prototype.prompt.call({snapshot:(ids)=>f.attachments.snapshot(ids),text:async()=>({text:f.attachments.text})},values,options);
  expected=await f.attachments.prompt(attachmentIds);
  const first=await f.settled(f.engine.startRun({workflow:f.workflow,input:{task:'Read bounded attachments',attachmentIds}}).id);completed(first);
  const next=await f.settled(f.engine.continueRun(first.id,{nodeId:'agent',message:'Continue bounded files'}).id);completed(next);
});

test('API/local tools omit the attachment reader until the current task has an attached file', async t=>{
  const threadId='provider_attachment-fixture';
  const f=await fixture(t,async(options,number)=>{
    if(number===1){
      assert.equal(fileTool(options),undefined);
      assert.ok(options.dynamicTools.some(tool=>tool.name==='relay_find_files'));
      assert.ok(options.dynamicTools.some(tool=>tool.name==='relay_workspace'));
    }else assert.deepEqual(fileTool(options),ATTACHMENT_TOOL);
    return {output:'Task result.',threadId};
  },{model:'local_llamacpp::fixture',threadId});
  const first=await f.settled(f.engine.startRun({workflow:f.workflow,input:{task:'Read a file from disk.'}}).id);completed(first);
  const next=await f.settled(f.engine.continueRun(first.id,{nodeId:'agent',message:'Read this attached file instead.',attachmentIds:[ids.text]}).id);completed(next);
  assert.equal(next.taskId,first.taskId);
  assert.equal(next.modelHandoff.reason,'attachment-tool-scope');
  assert.equal(f.runtime.calls[1].threadId,undefined);
  assert.equal(f.runtime.calls.length,2);
});

test('explicit same-conversation original text follow-up bypasses the model and earlier summary even without newly attached IDs',async t=>{
 const threadId='provider_exact-source-fixture';
 const f=await fixture(t,async()=>({output:'A selected summary, not the original document.',threadId}),{model:'local_llamacpp::fixture',threadId});
 f.workflow.id='mission_chat_exact-source-fixture';
 const entry={...f.attachments.entries.get(ids.pdf),name:'Candidate_Resume.pdf',pageCount:2};
 f.attachments.entries.set(ids.pdf,entry);
 const originals=['Original first page.\nConcrete source detail.','Original second page with qualifications.'];
 f.attachments.read=async(id,options)=>{
  assert.equal(id,ids.pdf);
  return {attachment:entry,totalPages:2,pages:originals.map((text,i)=>({page:i+1,startChar:0,text,totalChars:text.length,nextChar:null,textAvailable:true})),nextPage:null,nextChar:null};
 };
 const first=await f.settled(f.engine.startRun({workflow:f.workflow,input:{task:'Use the attached resume for context.',attachmentIds:[ids.pdf]}}).id);completed(first);
 const next=await f.settled(f.engine.continueRun(first.id,{nodeId:'agent',message:'send me the text of the resume',attachmentIds:[]}).id);completed(next);
 assert.equal(f.runtime.calls.length,1,'Extraction must not call a model');
 assert.equal(next.nodes.agent.documentExtraction.complete,true);
 assert.equal(next.nodes.agent.documentExtraction.sourceRunId,first.id);
 assert.equal(next.nodes.agent.documentExtraction.attachmentId,ids.pdf);
 assert.ok(originals.every(text=>next.output.includes(text)));
 assert.doesNotMatch(next.output,/selected summary/);
});

test('effective staged source skill executes neutral reconstruction and challenge in separate read-only provider sessions',async t=>{
 const threadId='provider_reconstruction_fixture',calls=[];
 const f=await fixture(t,async(options,number)=>{
  assert.equal(options.responseOnly,true);assert.equal(options.hostOnlyTools,true);assert.equal(options.sandbox,'read-only');assert.deepEqual(options.dynamicTools,[]);assert.equal(options.threadId,undefined);
  options.onPromptAccepted(options.prompt);calls.push(options);
  const row=(id,parent,summary,fn)=>({id,parent,summary,function:fn});
  const claim=(claim,basis,refs,reasoning)=>({claim,basis,refs,reasoning,assumptions:'Only source statements, no independent corroboration.'});
  let value;
  if(number===1){
    assert.match(options.prompt,/RECONSTRUCTION ONLY/);assert.doesNotMatch(options.prompt,/CURRENT USER QUESTION/);
    value={outline:[row(1,0,'Project heading','Section'),row(2,1,'An observed design decision','Subsection'),row(3,2,'The source provides a repository URL','Evidence'),row(4,0,'Limitations heading','Section'),row(5,4,'No adoption data are reported','Qualification')]};
  }else if(number===2){
    assert.match(options.prompt,/NEUTRAL SUMMARY ONLY/);assert.match(options.prompt,/RECONSTRUCTED OUTLINE/);assert.doesNotMatch(options.prompt,/CURRENT USER QUESTION/);
    value={summary:[{text:'The report describes a project and its repository, and limits its adoption claims.',refs:[1,2,3,4,5]}],corrections:[]};
  }else if(number===3){
    assert.match(options.prompt,/INITIAL ASSESSMENT/);assert.match(options.prompt,/Analyze the attached report/);
    value={claims:[claim('No evidence of any repository','not-established',[],'Provisional mistaken reading')]};
  }else if(number===4){
    assert.match(options.prompt,/ORIGINAL SOURCE UNITS IN REVERSE ORDER/);assert.match(options.prompt,/No evidence of any repository/);
    value={review:[{id:1,challenge:'The explicit URL contradicts this assumption.',counterRefs:[3],disposition:'revise',revised:claim('The report lists a repository but no adoption data.','source-assertion',[3,5],'Do not confuse an available repository with independently proven adoption.')}],additional:[]};
  }else assert.fail('Unexpected ordinary provider execution');
  return {output:JSON.stringify(value),threadId:'provider_phase_'+number,usage:{totalTokens:10}};
 },{model:'local_llamacpp::fixture',threadId});
 f.workflow.id='mission_chat_staged_source_fixture';
 const entry={...f.attachments.entries.get(ids.pdf),name:'project-report.pdf',pageCount:2};
 f.attachments.entries.set(ids.pdf,entry);
 const pages=['PROJECT\nDesign decision\n\u2022 Repository: https://example.test/project','LIMITATIONS\nNo adoption data supplied.'];
 f.attachments.read=async()=>({attachment:entry,format:'pdf',totalPages:2,pages:pages.map((text,i)=>({page:i+1,startChar:0,text,totalChars:text.length,nextChar:null,textAvailable:true})),nextPage:null,nextChar:null});
 const {createSkillsCatalog}=await import('../lib/skills-catalog.mjs');
 const catalog=createSkillsCatalog({dataDir:f.engine.dataDir});
 let skill;try{skill=await catalog.create({value:{content:'---\nactivation: [substantive-analysis]\nanalysis_protocol: source-reconstruction-v1\n---\n# Source First\n\nReconstruct the source before judging.'}});}finally{await catalog.close();}
 const run=await f.settled(f.engine.startRun({workflow:f.workflow,input:{task:'Analyze the attached report.',attachmentIds:[ids.pdf],planningMode:'off',chatPlanning:'off',directoryActions:'off'}}).id);
 completed(run);
 assert.equal(calls.length,4);assert.equal(run.nodes.agent.sourceReconstruction.status,'stages-returned');
 assert.equal(run.nodes.agent.sourceReconstruction.semanticVerification,'not-established');
 assert.ok(run.skillLoadReceipts.some(r=>r.skillId===skill.id&&r.type==='skill_context_submitted'));
 assert.ok(run.nodes.agent.instructionAudit.preparations.every(p=>p.audit.delivery==='accepted'));
 assert.match(run.output,/\n    - \*\*U3/);
 assert.match(run.output,/Repository: https:\/\/example.test\/project/);
 assert.match(run.output,/The report lists a repository but no adoption data/);
 assert.doesNotMatch(run.output.split('## Revised assessment').at(-1),/No evidence of any repository/);
 assert.equal(run.nodes.agent.usage.totalTokens,40);
});
