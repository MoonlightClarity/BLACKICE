/**
 * R: native local Chat trial runner. Root alone invokes live commands.
 * CLI: preflight|start|inspect|collect --profile PATH --executable PATH --model ID
 *      --effort LEVEL --out PATH [--jobs 1|2] [--profile-condition fresh|existing|unknown]
 *      [--provider-account reused|separate|unknown] [--app-dir PATH] [--cwd PATH] [--case-file PATH]
 * No app launch, profile editing, task coaching, Goal, or application-success oracle.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { connectBrowserCLI } from '../../lib/browser-cli.mjs';
import { createMissionWorkflow } from '../../public/mission-model.mjs';
import { captureExpression, cleanText, sanitize } from './capture.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const COMMANDS = ['preflight', 'start', 'inspect', 'collect'];
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const JOB = /^direct_[a-f0-9]{64}$/;
export const PROMPTS = Object.freeze({
  1: 'Find one suitable job using my existing résumé and preferences. Apply through the employer’s site and verify that the application was received.',
  2: 'Find two suitable jobs using my existing résumé and preferences. Apply through the employers’ sites and verify that both applications were received.',
});
export const sha256 = value => createHash('sha256').update(value).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const fail = (code, message) => Object.assign(Error(message), { code });
const exists = async file => { try { await fs.access(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
const now = () => new Date().toISOString();
const within = (parent, child) => { const relative = path.relative(parent, child); return !relative || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); };
const errorReceipt = error => ({ at: now(), code: error.code || 'RUNNER_ERROR', message: cleanText(String(error.message || error)).slice(0,2000) });


const CASE_SCHEMA = 'blackice.calibration.case.v1';
const ARTIFACT_LIMITS = Object.freeze({maxFiles:16,maxFileBytes:262144,maxTotalBytes:4194304});
async function boundedBytes(file, maximum) {
  const handle = await fs.open(file,'r');
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw fail('NOT_FILE','Expected a regular file.');
    if (before.size > maximum) throw Object.assign(fail('FILE_LIMIT','File exceeds observation limit.'),{bytes:before.size});
    const buffer = Buffer.alloc(Math.min(maximum + 1,before.size + 1)); let length = 0;
    while (length < buffer.length) {
      const read = await handle.read(buffer,length,buffer.length-length,length);
      if (!read.bytesRead) break; length += read.bytesRead;
    }
    const after = await handle.stat();
    if (length > maximum || after.size > maximum) throw Object.assign(fail('FILE_LIMIT','File exceeds observation limit.'),{bytes:after.size});
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || length !== after.size)
      throw fail('FILE_CHANGED','File changed during observation.');
    return buffer.subarray(0,length);
  } finally { await handle.close(); }
}
function decodeCase(bytes) {
  let value;
  try { value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)); } catch { throw fail('CASE_INVALID','Case must be valid UTF-8 JSON.'); }
  if (bytes.length > 65536 || !value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some(key=>!['schema','id','task','artifacts'].includes(key))
      || value.schema !== CASE_SCHEMA || typeof value.id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,79}$/.test(value.id)
      || typeof value.task !== 'string' || !value.task.trim() || Buffer.byteLength(value.task)>16384)
    throw fail('CASE_INVALID','Invalid immutable ordinary-task case.');
  const artifacts=value.artifacts ?? [];
  if (!Array.isArray(artifacts) || artifacts.length>ARTIFACT_LIMITS.maxFiles
      || artifacts.some(file=>typeof file !== 'string' || !file || file.length>1024 || /[\\:\x00-\x1f\x7f]/.test(file)
        || file.startsWith('/') || file.split('/').some(part=>!part || part==='.' || part==='..'))
      || new Set(artifacts.map(file=>file.toLowerCase())).size!==artifacts.length)
    throw fail('CASE_INVALID','Artifacts must be distinct canonical relative file paths.');
  return {schema:CASE_SCHEMA,id:value.id,task:value.task,artifacts};
}
function savedCase(record) {
  if (!record || typeof record.base64!=='string' || record.base64.length>87388)
    throw fail('CASE_INVALID','Saved immutable case is unavailable.');
  const bytes=Buffer.from(record.base64,'base64'), spec=decodeCase(bytes);
  if (bytes.length!==record.bytes || sha256(bytes)!==record.sha256 || spec.id!==record.id)
    throw fail('CASE_INVALID','Saved case bytes or identity changed.');
  return spec;
}
async function observeArtifacts(spec, binding) {
  const files=[]; let total=0;
  const root=await fs.realpath(binding.cwd).catch(()=>null);
  for (const relative of spec.artifacts) {
    const row={path:relative};
    try {
      if (!root) throw fail('WORKSPACE_UNAVAILABLE','Task working directory is unavailable.');
      const file=path.join(binding.cwd,...relative.split('/')), stat=await fs.lstat(file);
      if (!stat.isFile()) { files.push({...row,state:'not-file'}); continue; }
      const real=await fs.realpath(file);
      if (!within(root,real)) throw fail('ARTIFACT_OUTSIDE_WORKSPACE','Artifact resolves outside the task working directory.');
      const bytes=await boundedBytes(real,Math.min(ARTIFACT_LIMITS.maxFileBytes,ARTIFACT_LIMITS.maxTotalBytes-total)); total+=bytes.length;
      Object.assign(row,{state:'file',bytes:bytes.length,sha256:sha256(bytes)});
      try {
        const original=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes); let text=cleanText(original);
        let parsed, structured=false;
        try { parsed=JSON.parse(original.replace(/^\uFEFF/,'')); structured=true; }
        catch { /* Only non-JSON files use the ordinary-text fallback. */ }
        if (structured) {
          try {
            const cleaned=sanitize(parsed); let unchanged=false;
            try { unchanged=JSON.stringify(parsed)===JSON.stringify(cleaned); } catch { /* Deep originals still use bounded sanitized output. */ }
            if (!unchanged) text=JSON.stringify(cleaned,null,2);
          } catch { text=undefined; row.textOmitted='sanitization-failed'; }
        }
        Object.assign(row,{encoding:'utf-8',...(text===undefined?{redacted:true}:{text,redacted:text!==original})});
      } catch { Object.assign(row,{encoding:'binary',textOmitted:'binary'}); }
      files.push(row);
    } catch (error) {
      files.push({...row,state:error.code==='ENOENT'?'missing':error.code==='FILE_LIMIT'?'limit':'error',
        ...(error.code==='FILE_LIMIT'?{bytes:error.bytes,limit:ARTIFACT_LIMITS.maxFileBytes}:error.code==='ENOENT'?{}:{code:error.code || 'READ_FAILED'})});
    }
  }
  return {schema:'blackice.calibration.artifacts.v1',...binding,observedAtUTC:now(),limits:ARTIFACT_LIMITS,files};
}

export function normalizeConfig(value) {
  const config = { profile: value.profile, executable: value.executable, model: value.model, effort: value.effort, out: value.out,
    jobs: Number(value.jobs ?? 1), profileCondition: value.profileCondition || 'unknown', providerAccount: value.providerAccount || 'unknown',
    appDir: value.appDir || (value.executable ? path.join(path.dirname(value.executable), 'resources', 'app') : '') };
  for (const key of ['profile', 'executable', 'out', 'appDir']) {
    if (typeof config[key] !== 'string' || !path.isAbsolute(config[key])) throw fail('CONFIG_INVALID', key + ' must be an explicit absolute path.');
    config[key] = path.resolve(config[key]);
  }
  if (value.cwd !== undefined) {
    if (typeof value.cwd !== 'string' || !path.isAbsolute(value.cwd)) throw fail('CONFIG_INVALID', 'cwd must be an explicit absolute directory.');
    config.cwd = path.resolve(value.cwd);
  }
  if (value.caseFile !== undefined) {
    if (value.jobs !== undefined) throw fail('CONFIG_INVALID','Choose either a fixed job case or --case-file.');
    if (typeof value.caseFile !== 'string' || !path.isAbsolute(value.caseFile)) throw fail('CONFIG_INVALID','case-file must be an explicit absolute path.');
    delete config.jobs; config.caseFile=path.resolve(value.caseFile);
  }
  if (within(config.profile, config.out)) throw fail('CONFIG_INVALID', 'Write trial evidence outside the native profile.');
  if (typeof config.model !== 'string' || !config.model.trim() || config.model === 'default') throw fail('CONFIG_INVALID', 'Choose an explicit model ID.');
  if (!['low','medium','high','xhigh','max'].includes(config.effort) || (!config.caseFile && ![1,2].includes(config.jobs))
      || !['fresh','existing','unknown'].includes(config.profileCondition) || !['reused','separate','unknown'].includes(config.providerAccount))
    throw fail('CONFIG_INVALID', 'Invalid effort, job count, or declared profile/provider condition.');
  return config;
}
export function parseCLI(args) {
  const command = args[0], values = {}, names = { profile:'profile', executable:'executable', model:'model', effort:'effort', out:'out',
    jobs:'jobs', 'profile-condition':'profileCondition', 'provider-account':'providerAccount', 'app-dir':'appDir', cwd:'cwd', 'case-file':'caseFile' };
  if (!COMMANDS.includes(command)) throw fail('CONFIG_INVALID', 'Use preflight, start, inspect, or collect.');
  for (let i = 1; i < args.length; i += 2) {
    const key = names[args[i]?.replace(/^--/,'')];
    if (!args[i]?.startsWith('--') || !key || Object.hasOwn(values,key) || !args[i+1] || args[i+1].startsWith('--'))
      throw fail('CONFIG_INVALID', 'Use distinct supported --name value options.');
    values[key] = args[i+1];
  }
  return { command, config: normalizeConfig(values) };
}
async function save(file, value, exclusive = false) {
  const bytes = json(value), temporary = exclusive ? file : file + '.' + randomUUID() + '.tmp';
  const handle = await fs.open(temporary, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  if (!exclusive) await fs.rename(temporary, file);
  return { file, sha256: sha256(bytes), bytes: Buffer.byteLength(bytes) };
}
async function archiveCapture(file, value) {
  const bytes = json(value);
  try { return await save(file, value, true); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const existing = await fs.readFile(file);
    if (!existing.equals(Buffer.from(bytes))) throw fail('ARCHIVE_CHANGED','Existing capture differs from the exact saved stop receipt.');
    return { file, sha256:sha256(existing), bytes:existing.length, reusedIdentical:true };
  }
}
export function admissionRequest(manifest, cwd) {
  const task = manifest.prompt, requestId = 'jobsearch_' + manifest.attemptId, id = 'mission_chat_' + manifest.attemptId;
  return { requestId, workflow: createMissionWorkflow({ id, task, cwd, model: manifest.config.model, effort: manifest.config.effort, planningMode:'off' }),
    input: { task, cwd, planningMode:'off', directoryMode:'off', chatPlanning:'off', directoryActions:'off' } };
}
export function projectRun(run) {
  if (!run) return null;
  const agent = run.workflow?.nodes?.find(node => node.type === 'agent');
  return { id:run.id, status:run.status, settled:run.settled, createdAt:run.createdAt, startedAt:run.startedAt, finishedAt:run.finishedAt,
    clientRequestId:run.metadata?.clientRequestId, workflowId:run.workflowId, cwd:run.cwd, task:run.input?.task ?? run.input,
    model:agent?.model, effort:agent?.effort, planningMode:run.planningMode, chatPlanning:run.chatPlanning,
    directoryActions:run.directoryActions, directoryMode:run.executionModes?.directoryMode, executionModes:run.executionModes, attachmentCount:run.attachmentIds?.length ?? 0,
    goalEnabled:Boolean(run.goal || run.goalRequest), errorCode:run.error?.code || null };
}
function observerReadinessInRenderer() {
  const observer = window.__blackiceJobSearchEvidence;
  return observer ? { active:observer.active, readiness:observer.readiness, openedAtUTC:observer.openedAtUTC,
    runId:observer.runId, errors:observer.errors, dropped:observer.dropped, limitationEvents:observer.limitationEvents } : null;
}
async function inspectInRenderer(runId, requestId, project) {
  const response = await fetch(runId ? '/api/runs/' + runId : '/api/runs');
  if (!response.ok) throw Error('Native run inspection failed: ' + response.status);
  const body = await response.json();
  const matches = runId ? [body] : body.filter(run => run.metadata?.clientRequestId === requestId);
  if (matches.length > 1) throw Error('More than one run matches the exact admission request.');
  const run = matches[0];
  let audit = null;
  if (run) {
    const reply = await fetch('/api/runs/' + run.id + '/instructions');
    if (!reply.ok) throw Error('Native instruction audit could not be read.');
    audit = await reply.json();
  }
  const observer = window.__blackiceJobSearchEvidence;
  return { run: project(run), instructionAudit: audit,
    observer: observer?.runId ? observer.summary() : null };
}
export async function decodeFrontendResult(result, readArtifact = file => fs.readFile(file), profile) {
  if (result?.success !== true) throw fail('FRONTEND_FAILED', 'The saved frontend action failed; its job remains authoritative.');
  const items = result.contentItems?.filter(item => item.type === 'inputText');
  if (items?.length !== 1) throw fail('FRONTEND_INVALID', 'Expected one structured frontend receipt.');
  let envelope = JSON.parse(items[0].text);
  if (envelope.inline === false) {
    const artifact = envelope.artifact;
    if (!artifact?.complete || !path.isAbsolute(artifact.path || '') || !within(profile, artifact.path)
        || !/^[a-f0-9]{64}$/.test(artifact.sha256 || '') || !Number.isSafeInteger(artifact.bytes) || artifact.bytes > 64*1024*1024)
      throw fail('ARTIFACT_INVALID', 'Invalid bounded profile-owned frontend artifact.');
    const bytes = await readArtifact(artifact.path);
    if (bytes.length !== artifact.bytes || sha256(bytes) !== artifact.sha256) throw fail('ARTIFACT_CHANGED', 'Frontend artifact hash or byte count differs.');
    result = JSON.parse(bytes.toString('utf8'));
    if (result.success !== true || result.contentItems?.length !== 1) throw fail('FRONTEND_FAILED', 'The archived frontend action failed.');
    envelope = JSON.parse(result.contentItems[0].text);
  }
  if (envelope.result?.exceptionDetails || envelope.exceptionDetails || !Object.hasOwn(envelope.result?.result || {}, 'value'))
    throw fail('FRONTEND_INVALID', 'Frontend evaluation has no successful by-value result.');
  return envelope.result.result.value;
}
export async function readNativeFrontendResult(profile, jobId, requestId) {
  if (!JOB.test(jobId)) throw fail('JOB_INVALID', 'Exact frontend job ID required.');
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(profile, 'data', 'direct-execution.sqlite'), { readOnly:true });
  let record;
  try {
    const row = db.prepare('SELECT p.body FROM jobs j JOIN payloads p ON p.id=j.id WHERE j.id=?').get(jobId);
    if (!row?.body) throw fail('JOB_MISSING', 'The exact saved frontend job is absent.');
    record = JSON.parse(row.body);
  } finally { db.close(); }
  if (record.id !== jobId || record.requestId !== requestId || record.tool !== 'blackice_frontend'
      || record.arguments?.action !== 'evaluate' || record.arguments?.target !== 'frontend' || record.status !== 'succeeded')
    throw fail('JOB_MISMATCH', 'Saved result is not this completed frontend evaluation.');
  // Only the selected public evaluation value leaves this function; never owner/client/arguments.
  return decodeFrontendResult(record.result, undefined, profile);
}
export function productFileEvidence(file, candidateBytes, installedBytes) {
  const evidence = { candidate:sha256(candidateBytes), installed:sha256(installedBytes) };
  if (evidence.candidate === evidence.installed) return evidence;
  if (file === 'package.json') {
    try {
      const expected = JSON.parse(candidateBytes.toString('utf8')), installed = JSON.parse(installedBytes.toString('utf8'));
      if (!expected || !installed || typeof expected !== 'object' || typeof installed !== 'object' || Array.isArray(expected) || Array.isArray(installed)) throw Error('Invalid manifest.');
      // Same electron-builder main-package transform as scripts/release-check.mjs appFingerprint.
      // Transform only the candidate: unexpected installed fields are never ignored.
      const removed = new Set(['dist','gitHead','build','jspm','ava','xo','nyc','eslintConfig','contributors','bundleDependencies','tags','scripts','devDependencies','keywords']);
      const removedCandidateFields = [];
      for (const key of Object.keys(expected)) if (key.startsWith('_') || removed.has(key)
          || key === 'babel' && expected.dependencies && !Object.keys(expected.dependencies).some(name => name.startsWith('babel'))) {
        removedCandidateFields.push(key); delete expected[key];
      }
      const canonical = value => JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a],[b]) => a.localeCompare(b,'en'))));
      const expectedPackageSha256 = sha256(canonical(expected)), installedPackageSha256 = sha256(canonical(installed));
      if (expectedPackageSha256 === installedPackageSha256) return { ...evidence, comparison:'electron-builder-main-package',
        normalization:'scripts/release-check.mjs#appFingerprint', removedCandidateFields, expectedPackageSha256, installedPackageSha256 };
    } catch { /* Malformed or unexplained metadata remains a source mismatch. */ }
  }
  throw fail('SOURCE_MISMATCH', 'Candidate and installed file differ: ' + file);
}
export async function sourceEvidence(config) {
  const product = ['package.json','desktop/main.mjs','lib/browser-cli.mjs','lib/browser.mjs','lib/application-history.mjs',
    'public/mission-model.mjs','lib/harness-identity.mjs','lib/instruction-store.mjs','lib/identity.mjs',
    'lib/release-skills.mjs','lib/skill-library/what-makes-done.md','lib/skill-library/job-search.md','public/chat-turn-defaults.mjs',
    'lib/conversation-execution-modes.mjs','lib/engine.mjs','lib/chat-execution-review.mjs'];
  const files = {};
  for (const file of product) {
    const candidate = await fs.readFile(path.join(ROOT,file));
    let installed;
    try { installed = await fs.readFile(path.join(config.appDir,file)); }
    catch (error) {
      if (error.code === 'ENOENT') throw fail('SOURCE_MISMATCH','Installed file is missing: ' + file);
      throw error;
    }
    files[file] = productFileEvidence(file,candidate,installed);
  }
  for (const file of ['verification/jobsearch-repro/capture.mjs','verification/jobsearch-repro/runner.mjs'])
    files[file] = { candidate:sha256(await fs.readFile(path.join(ROOT,file))) };
  return { commit:execFileSync('git',['-C',ROOT,'rev-parse','HEAD'],{encoding:'utf8'}).trim(), files, fingerprint:sha256(JSON.stringify(files)) };
}
export class TrialRunner {
  constructor(config, dependencies = {}) {
    this.config = normalizeConfig(config);
    this.connect = dependencies.connect || (() => connectBrowserCLI({ 'profile-dir':this.config.profile }, { expectedExecutable:this.config.executable }));
    this.sources = dependencies.sources || (() => sourceEvidence(this.config));
    this.readResult = dependencies.readResult || ((id, request) => readNativeFrontendResult(this.config.profile,id,request));
    this.pause = dependencies.pause || (ms => new Promise(resolve => setTimeout(resolve,ms)));
  }
  file(name) { return path.join(this.config.out,name); }
  async load(create = false) {
    if (!await exists(this.file('manifest.json'))) {
      if (!create) throw fail('ATTEMPT_MISSING', 'Run preflight with a new output directory first.');
      let snapshot;
      if (this.config.caseFile) {
        let bytes; try { bytes=await boundedBytes(this.config.caseFile,65536); } catch { throw fail('CASE_INVALID','Case file must be an existing bounded regular file.'); }
        const spec=decodeCase(bytes); snapshot={id:spec.id,sha256:sha256(bytes),bytes:bytes.length,base64:bytes.toString('base64')};
      }
      const prompt=snapshot ? savedCase(snapshot).task : PROMPTS[this.config.jobs];
      await fs.mkdir(path.dirname(this.config.out),{recursive:true});
      await fs.mkdir(this.config.out);
      this.manifest = { schema:'blackice.jobsearch.native-trial.v1', entryPoint:'native-local-chat-api', attemptId:randomUUID(), createdAt:now(),
        config:this.config, configSha256:sha256(JSON.stringify(this.config)), prompt, promptSha256:sha256(prompt),
        ...(snapshot?{case:snapshot}:{}), modes:{planning:'off',directory:'off',goal:false,attachments:0},
        scoring:'Manual evidence review required; no automatic application-success verdict.' };
      await save(this.file('manifest.json'),this.manifest,true);
      this.journal = { state:'initialized', operations:{}, history:[], errors:[] }; await this.persist();
    } else {
      this.manifest = JSON.parse(await fs.readFile(this.file('manifest.json'),'utf8'));
      this.journal = JSON.parse(await fs.readFile(this.file('journal.json'),'utf8'));
    }
    this.caseSpec=this.config.caseFile ? savedCase(this.manifest.case) : null;
    if (this.manifest.schema !== 'blackice.jobsearch.native-trial.v1' || this.manifest.entryPoint !== 'native-local-chat-api' || !UUID.test(this.manifest.attemptId || '')
        || this.manifest.configSha256 !== sha256(JSON.stringify(this.config)) || this.manifest.configSha256 !== sha256(JSON.stringify(this.manifest.config))
        || Boolean(this.manifest.case)!==Boolean(this.config.caseFile)
        || this.manifest.prompt !== (this.caseSpec?.task ?? PROMPTS[this.config.jobs])
        || this.manifest.promptSha256 !== sha256(this.manifest.prompt)) throw fail('CONFIG_MISMATCH','Existing attempt configuration or prompt differs.');
  }
  async assertCaseSource() {
    if (!this.caseSpec) return;
    let bytes; try { bytes=await boundedBytes(this.config.caseFile,65536); } catch { throw fail('CASE_CHANGED','Frozen case source is unavailable or changed before admission.'); }
    if (sha256(bytes)!==this.manifest.case.sha256) throw fail('CASE_CHANGED','Frozen case source bytes changed before admission.');
  }
  async recordArtifacts(phase) {
    if (!this.caseSpec) return null;
    const file=this.file('artifacts-'+phase+'.json'), binding={caseId:this.caseSpec.id,caseSha256:this.manifest.case.sha256,
      phase,runId:phase==='before'?null:this.journal.runId,cwd:this.journal.preflight.cwd};
    if (phase==='after') {
      const before=this.journal.artifacts?.before;
      if (!before || before.file!==this.file('artifacts-before.json')
          || sha256(await boundedBytes(before.file,32*1024*1024))!==before.sha256)
        throw fail('ARCHIVE_CHANGED','Original before-artifact observation is unavailable or changed.');
    }
    const prior=this.journal.artifacts?.[phase]; let receipt;
    if (await exists(file)) {
      const bytes=await boundedBytes(file,32*1024*1024), snapshot=JSON.parse(bytes.toString('utf8'));
      if (prior && (prior.file!==file || prior.sha256!==sha256(bytes))) throw fail('ARCHIVE_CHANGED','Saved artifact observation changed.');
      if (snapshot.schema!=='blackice.calibration.artifacts.v1' || Object.entries(binding).some(([key,value])=>snapshot[key]!==value)
          || JSON.stringify(snapshot.files?.map(row=>row.path))!==JSON.stringify(this.caseSpec.artifacts))
        throw fail('ARCHIVE_CHANGED','Artifact observation does not match this exact case/run.');
      if (phase==='before') {
        const current=await observeArtifacts(this.caseSpec,binding);
        if (JSON.stringify(current.files)!==JSON.stringify(snapshot.files)) throw fail('ARTIFACT_BASELINE_CHANGED','Declared task files changed after the saved pre-admission observation.');
      }
      if (prior) return prior;
      receipt={file,sha256:sha256(bytes),bytes:bytes.length,reusedIdentical:true};
    } else {
      if (prior) throw fail('ARCHIVE_CHANGED','Saved artifact observation is missing.');
      const snapshot=await observeArtifacts(this.caseSpec,binding);
      try { receipt=await save(file,snapshot,true); }
      catch(error) { if(error.code==='EEXIST')return this.recordArtifacts(phase);throw error; }
    }
    this.journal.artifacts={...this.journal.artifacts,[phase]:receipt};await this.persist('artifacts-'+phase);
    return receipt;
  }
  async persist(event) {
    if (event) this.journal.history.push({at:now(),event,state:this.journal.state});
    await save(this.file('journal.json'),this.journal);
  }
  async session() {
    const session = await this.connect();
    const before = this.journal.preflight?.runtime;
    if (before && (before.pid !== session.runtime.pid || before.startedAt !== session.runtime.startedAt || before.url !== session.runtime.url))
      throw fail('RUNTIME_CHANGED','The native process changed; the original in-memory capture cannot be assumed available.');
    return session;
  }
  async evidence(session) {
    const [status, identity, instructions, catalog, source] = await Promise.all([
      session.request('/api/status'),session.request('/api/identity'),session.request('/api/instructions'),session.request('/api/skills'),this.sources()
    ]);
    if (!path.isAbsolute(status.cwd || '') || status.app !== 'relay-agent-harness' || !status.desktopApp)
      throw fail('NATIVE_UNAVAILABLE','Selected native Chat workspace is unavailable.');
    const cwd = this.config.cwd ?? status.cwd;
    if (this.config.cwd !== undefined) {
      const directory = await fs.stat(cwd).catch(() => null);
      if (!directory?.isDirectory()) throw fail('CONFIG_INVALID', 'cwd must be an existing directory.');
    }
    const skills = [];
    for (const row of catalog.entries || []) {
      const value = await session.request('/api/skills/' + encodeURIComponent(row.id));
      skills.push({id:row.id,source:value.source,revision:value.revision,sha256:sha256(JSON.stringify(value))});
    }
    const account = status.codex?.account ?? status.account;
    const effective = { identitySha256:sha256(JSON.stringify(identity)), coreRevision:instructions.core?.revision,
      coreSha256:sha256(JSON.stringify(instructions.core)), skills, catalogSha256:sha256(JSON.stringify(catalog.entries || [])),
      runtimeSettingsSha256:sha256(JSON.stringify(status.runtimeSettings || {})) };
    return { at:now(),runtime:{pid:session.runtime.pid,startedAt:session.runtime.startedAt,url:session.runtime.url,version:session.runtime.version,profileMode:session.runtime.profileMode},
      cwd, startupCwd:status.cwd, cwdSource:this.config.cwd === undefined ? 'native-status' : 'explicit',
      source, effective, freezeSha256:sha256(JSON.stringify({source:source.fingerprint,effective,cwd})),
      provider:{declaredAccount:this.config.providerAccount,connected:Boolean(status.codex?.connected ?? status.connected),
        authenticated:Boolean(status.codex?.authenticated ?? status.authenticated),accountObserved:account != null,accountFingerprint:account == null ? null : sha256(JSON.stringify(account))},
      profile:{declaredCondition:this.config.profileCondition,savedConversationCount:status.conversations?.conversations ?? null,
        activeRunCount:status.execution?.activeCount ?? null,filesystemCondition:'Shared local account and original filesystem; this runner copies no applicant or profile data.',cookieCondition:'Not inferred from a fresh chat; review first application state and declared profile provenance.'} };
  }
  async frontend(session, key, expression) {
    const digest = sha256(expression), requestId = this.manifest.attemptId + '.' + key;
    let op = this.journal.operations[key];
    if (op && op.expressionSha256 !== digest) throw fail('OPERATION_CHANGED','Saved observer operation differs.');
    if (!op) { op = this.journal.operations[key] = {requestId,expressionSha256:digest,jobId:null}; await this.persist(); }
    if (!op.jobId) {
      const accepted = await session.request('/api/development/frontend',{requestId,action:'evaluate',target:'frontend',expression});
      if (!JOB.test(accepted.jobId || '')) throw fail('JOB_INVALID','Native frontend did not return a durable job.');
      op.jobId = accepted.jobId; await this.persist();
    }
    for (let i = 0; i < 60; i++) {
      const receipt = await session.request('/api/development/frontend/jobs/' + op.jobId + '?limit=1&includeImages=false');
      if (receipt.settled) {
        if (receipt.status !== 'succeeded' || receipt.result?.success !== true) throw fail('FRONTEND_FAILED','Frontend action failed: ' + op.jobId);
        return this.readResult(op.jobId,requestId);
      }
      if (receipt.status === 'awaiting_input') throw fail('FRONTEND_BLOCKED','Observer action requires an interaction; no model was admitted by this action.');
      await this.pause(500);
    }
    throw fail('FRONTEND_PENDING','Observer action is still pending; recover its saved job.');
  }
  async preflight() {
    await this.load(true);
    if (await exists(this.file('admission.json'))) return this.inspectLoaded();
    await this.assertCaseSource();
    const session = await this.session(), evidence = await this.evidence(session);
    if (this.journal.preflight && evidence.freezeSha256 !== this.journal.preflight.freezeSha256) throw fail('PREFLIGHT_CHANGED','Preflight source/instruction/configuration identities changed.');
    this.journal.preflight = evidence; this.journal.state = 'prepared'; await this.persist('preflight');
    await save(this.file('preflight.json'),evidence);
    return {state:this.journal.state,out:this.config.out,entryPoint:this.manifest.entryPoint,provider:evidence.provider,profile:evidence.profile};
  }
  async start() {
    await this.load();
    if (await exists(this.file('admission.json'))) return this.inspectLoaded();
    if (this.journal.state !== 'prepared') throw fail('PREFLIGHT_REQUIRED','A successful preflight is required.');
    await this.assertCaseSource();
    const session = await this.session(), current = await this.evidence(session);
    if (current.freezeSha256 !== this.journal.preflight.freezeSha256) throw fail('PREFLIGHT_CHANGED','Source/instruction/configuration identities changed before admission.');
    const ready = await this.frontend(session,'install',captureExpression());
    if (ready.readiness !== 'ready' || !Number.isFinite(Date.parse(ready.openedAtUTC)) || ready.alreadyActive)
      throw fail('OBSERVER_NOT_READY','A newly installed observer with an explicit stream-open receipt is required.');
    const liveReady = await this.frontend(session,'readycheck-' + Object.keys(this.journal.operations).length,'(' + observerReadinessInRenderer.toString() + ')()');
    if (!liveReady?.active || liveReady.readiness !== 'ready' || liveReady.openedAtUTC !== ready.openedAtUTC || liveReady.runId
        || liveReady.errors !== 0 || liveReady.dropped !== 0 || liveReady.limitationEvents !== 0)
      throw fail('OBSERVER_NOT_READY','The live observer is absent, stopped, bound, or unhealthy; cached readiness cannot admit a run.');
    await this.recordArtifacts('before');
    const payload = admissionRequest(this.manifest,current.cwd), attemptedAt = now();
    if (Date.parse(ready.openedAtUTC) > Date.parse(attemptedAt)) throw fail('OBSERVER_NOT_READY','Stream-open receipt follows attempted admission.');
    await save(this.file('admission.json'),{requestId:payload.requestId,payloadSha256:sha256(JSON.stringify(payload)),attemptedAt,readiness:ready},true);
    this.journal.state = 'admitting'; this.journal.readiness = ready; await this.persist('admission-intent');
    let run;
    try { run = await session.request('/api/runs',payload); }
    catch (error) { this.journal.state='admission_unknown'; this.journal.errors.push(errorReceipt(error)); await this.persist('admission-unknown'); throw fail('ADMISSION_UNKNOWN','Admission response is uncertain. Inspect this attempt; do not submit another request.'); }
    if (!UUID.test(run?.id || '')) { this.journal.state='admission_unknown'; await this.persist('invalid-admission-response'); throw fail('ADMISSION_UNKNOWN','Admission returned no exact run UUID. Inspect this attempt.'); }
    this.journal.runId=run.id; this.journal.state='admitted'; await this.persist('admitted');
    await this.bind(session);
    return {state:this.journal.state,runId:run.id,out:this.config.out,readiness:ready};
  }
  async bind(session) {
    const receipt = await this.frontend(session,'bind','window.__blackiceJobSearchEvidence.bind(' + JSON.stringify(this.journal.runId) + ')');
    if (receipt.boundRunId !== this.journal.runId) throw fail('BIND_MISMATCH','Observer binding does not match the exact admitted run.');
  }
  async inspectLoaded() {
    const session = await this.session(), requestId='jobsearch_' + this.manifest.attemptId;
    const expression='(' + inspectInRenderer.toString() + ')(' + JSON.stringify(this.journal.runId || null) + ',' + JSON.stringify(requestId) + ',' + projectRun.toString() + ')';
    const key='inspect-' + Object.keys(this.journal.operations).length;
    const inspection=await this.frontend(session,key,expression), run=inspection.run;
    if (run) {
      if (!UUID.test(run.id || '') || run.clientRequestId !== requestId || run.task !== this.manifest.prompt
          || run.workflowId !== 'mission_chat_' + this.manifest.attemptId || run.model !== this.config.model || run.effort !== this.config.effort
          || run.cwd !== this.journal.preflight?.cwd
          || run.planningMode !== 'off' || run.chatPlanning !== 'off' || run.directoryActions !== 'off' || run.directoryMode !== 'off'
          || run.attachmentCount !== 0 || run.goalEnabled) throw fail('RUN_MISMATCH','Inspected run does not match this exact attempt.');
      if (this.journal.runId && this.journal.runId !== run.id) throw fail('RUN_MISMATCH','Exact admitted run changed.');
      this.journal.runId=run.id;
      await this.bind(session);
      this.journal.state=run.settled ? 'run-settled' : 'admitted';
    } else if (await exists(this.file('admission.json'))) this.journal.state='admission_unknown';
    const evidence={at:now(),run,instructionAuditSha256:sha256(JSON.stringify(inspection.instructionAudit)),observer:inspection.observer};
    const archive=await save(this.file(key+'.json'),evidence,true);
    this.journal.lastInspection={file:archive.file,sha256:archive.sha256,run,observer:inspection.observer ? {
      active:inspection.observer.active,captureHealthy:inspection.observer.captureHealthy,rawEventCount:inspection.observer.rawEventCount } : null};
    await this.persist('inspect');
    return {state:this.journal.state,runId:run?.id || null,status:run?.status || null,settled:run?.settled || false,
      evidence:archive,warning:run ? null : 'No exact run located; absence is not proof of non-admission.'};
  }
  async inspect() { await this.load(); return this.inspectLoaded(); }
  async collect() {
    await this.load();
    if (this.journal.capture) {
      const bytes=await fs.readFile(this.journal.capture.file);
      if (sha256(bytes)!==this.journal.capture.sha256) throw fail('ARCHIVE_CHANGED','Saved public capture changed.');
      await this.recordArtifacts('after');
      return {state:'collected',runId:this.journal.runId,capture:this.journal.capture,...(this.caseSpec?{artifacts:this.journal.artifacts}:{})};
    }
    const inspection=await this.inspectLoaded();
    if (!inspection.runId || !inspection.settled) throw fail('RUN_NOT_SETTLED','Keep observing; this run is not settled and capture has not been stopped.');
    const session=await this.session();
    const capture=await this.frontend(session,'stop','window.__blackiceJobSearchEvidence.stop()');
    if (capture.runId!==this.journal.runId || !Array.isArray(capture.events) || capture.openedAtUTC!==this.journal.readiness?.openedAtUTC)
      throw fail('CAPTURE_MISMATCH','Stopped capture does not match the admitted run and readiness receipt.');
    const archive=await archiveCapture(this.file('capture.json'),capture);
    this.journal.capture={...archive,jobId:this.journal.operations.stop.jobId,captureHealthy:capture.captureHealthy,captureComplete:capture.captureComplete};
    await this.recordArtifacts('after');
    this.journal.state='collected'; await this.persist('collect');
    return {state:'collected',runId:this.journal.runId,capture:this.journal.capture,...(this.caseSpec?{artifacts:this.journal.artifacts}:{}),scoring:this.manifest.scoring};
  }
}
export async function main(args) {
  const {command,config}=parseCLI(args), runner=new TrialRunner(config);
  try { return await runner[command](); }
  catch(error) {
    if(runner.journal) { runner.journal.errors.push(errorReceipt(error)); await runner.persist('command-error'); }
    throw error;
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(result=>console.log(JSON.stringify(result))).catch(error=>{
    console.error(JSON.stringify(errorReceipt(error))); process.exitCode=1;
  });
}
