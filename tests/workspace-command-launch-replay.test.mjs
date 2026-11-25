import {readSavedDirectJobBytes} from './fixtures/read-direct-sqlite.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';
import {FIND_FILES_TOOL,validateFileSearchCall} from '../lib/file-search-contract.mjs';
import { PDF_LIMITS } from '../lib/pdf-documents.mjs';
import { XLSX_ROWS, XLSX_COLUMNS } from '../lib/spreadsheet-documents.mjs';
import {managedContextPaths} from '../lib/managed-context-paths.mjs';
import {createFileSearch} from '../lib/workspace-file-search.mjs';
import {homedir} from 'node:os';
import {describeHostOperation,normalizeHostOperationResult} from '../lib/operation-descriptors.mjs';
import * as ledger from '../lib/direct-execution-jobs.mjs';

// Actual frozen ledger/API and candidate workspace implementation. Only their
// unrelated adapters and the process launcher are substituted. Storage is real
// in a disposable test directory. No shell, browser, HTTP, or provider runs.
const sources = Object.fromEntries(await Promise.all(['workspace-tools', 'direct-execution-api'].map(async name =>
  [name, await fs.readFile(new URL(`../lib/${name}.mjs`, import.meta.url), 'utf8')])));
const forbidden = () => { throw Error('Unexpected external adapter in inert replay test'); };
function evaluate(name, globals, exports) {
  const sandbox = { FIND_FILES_TOOL, validateFileSearchCall, PDF_LIMITS, XLSX_ROWS, XLSX_COLUMNS, managedContextPaths, createFileSearch, homedir, describeHostOperation, normalizeHostOperationResult, fs, path, createHash, randomUUID, StringDecoder, Buffer, TextDecoder,
    structuredClone, setTimeout, clearTimeout, queueMicrotask, AbortController, AbortSignal,
    process: { pid: process.pid, platform: 'linux', env: {}, kill: forbidden }, ...globals };
  // Strip complete ESM re-exports before declaration keywords; imported contracts are injected above.
  vm.runInNewContext(sources[name].replace(/^import .*;\n/gm, '').replace(/^export \{[^\r\n]*\} from [^\r\n]*;\r?\n/gm, '').replace(/^export /gm, '') +
    `\nthis.exports = { ${exports.join(',')} };`, sandbox, { filename: name + '.mjs' });
  return sandbox.exports;
}
async function fixture(t, observed, {hangAfterSpawn=false}={}) {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'blackice-launch-replay-'));
  let launches = 0, preparedExecutions = 0;
  const spawn = (command) => {
    launches++;
    if (hangAfterSpawn && command === 'taskkill.exe') {
      const killer = new EventEmitter(); killer.kill=()=>true;
      queueMicrotask(() => killer.emit('close',0));
      return killer;
    }
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.kill=()=>true; child.stdout.destroy=()=>{}; child.stderr.destroy=()=>{};
    if (observed || hangAfterSpawn) child.pid = 321;
    queueMicrotask(() => {
      if (observed || hangAfterSpawn) child.emit('spawn');
      if (!hangAfterSpawn) {
        child.emit('error', Object.assign(new Error('fixture launch refused'), { code: 'EPERM' }));
        child.emit('close', null, null);
      }
    });
    return child;
  };
  const workspace = evaluate('workspace-tools', { spawn, DESKTOP_RESTART_ORIGIN_ENV: 'BLACKICE_RESTART_ORIGIN',
    ...(hangAfterSpawn?{process:{pid:process.pid,platform:'win32',env:{},kill:forbidden}}:{}) },
    ['createWorkspaceToolHandler', 'WORKSPACE_PDF_READ_FIELDS', 'WORKSPACE_XLSX_READ_FIELDS']);
  // Use the real imported ledger and its pack dependencies; only process
  // dispatch and unrelated API adapters are inert substitutes.
  const apiModule = evaluate('direct-execution-api', { ...ledger,
    WORKSPACE_PDF_READ_FIELDS: workspace.WORKSPACE_PDF_READ_FIELDS,
    WORKSPACE_XLSX_READ_FIELDS: workspace.WORKSPACE_XLSX_READ_FIELDS,
    createWorkspaceToolHandler: options => {
      const handler = workspace.createWorkspaceToolHandler(options);
      return async (...args) => { preparedExecutions++; return handler(...args); };
    },
    createDirectTaskContractTools: () => [], createDirectTaskContextTools: () => [],
    supportsTaskContext: () => false, withTaskContext: forbidden, BROWSER_CLEANUP_PROTOCOL: '',
    DesktopRestartOrigins: class { finish() {} }, directResourceKeys: () => [],
    createBrowserToolHandler: forbidden, agentBrowserRequest: forbidden, connectorBrowserOwner: forbidden,
    containedBrowserAvailable: () => false,
  }, ['DirectExecutionAPI']);
  const make = () => new apiModule.DirectExecutionAPI({ dataDir: directory, allowedRoot: directory,
    authorizeClient: async () => true, taskRuntime: { close: async () => {} } });
  const instances = [];
  const open = () => { const api = make(); instances.push(api); return api; };
  t.after(async () => { for (const api of instances) await api.close(); await fs.rm(directory, { recursive: true, force: true }); });
  return { open, directory, counts: () => ({ launches, preparedExecutions }) };
}
const client = { id: 'fixture-command-grant', kind: 'chatgpt', scopes: ['read', 'commands:run'] };
const args = { requestId: 'fixture-denied-command', command: 'fixture-only-never-executed', timeoutMs: 1000 };
async function settle(api, id) {
  for (let n = 0; n < 200; n++) {
    const job = await api.call('blackice_get_job', { jobId: id }, client);
    if (job.settled && api.active.size === 0) return job;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('Inert direct job did not settle');
}
for (const observed of [false, true]) test(`durable denied launch replay preserves bytes and does not dispatch again (spawn observed=${observed})`, async t => {
  const f = await fixture(t, observed), api = f.open();
  const admitted = await api.call('blackice_run_command', args, client);
  const first = await settle(api, admitted.jobId);
  assert.equal(first.status, 'failed'); assert.equal(first.result.success, false);
  const launch = JSON.parse(first.result.text.text).launch;
  assert.equal(launch.processStartObserved, observed); assert.equal(launch.executionOutcome, 'unknown');
  assert.equal(launch.securityBlockConfirmed, false); assert.equal(launch.securityBlockPossible, true);
  assert.equal(first.effects.possible, true); assert.equal(first.effects.confirmed, false);
  assert.deepEqual(f.counts(), { launches: 1, preparedExecutions: 1 });
  const readReceipt = () => readSavedDirectJobBytes(api.jobs.databaseFile,admitted.jobId);
  const bytes = readReceipt();
  const replays = await Promise.all(Array.from({ length: 8 }, () => api.call('blackice_run_command', { ...args }, client)));
  for (const replay of replays) { assert.equal(replay.existing, true); assert.equal(replay.jobId, first.jobId); assert.equal(replay.status, 'failed'); }
  assert.equal((await settle(api, first.jobId)).result.text.text, first.result.text.text);
  assert.deepEqual(readReceipt(), bytes);
  await assert.rejects(api.call('blackice_run_command', { ...args, command: 'different-fixture' }, client), { code: 'DIRECT_REQUEST_CONFLICT' });
  // Read/status/list/cancel and an invalid interaction cannot reopen a failed action.
  await api.call('blackice_direct_status', {}, client); await api.call('blackice_list_jobs', {}, client);
  await api.call('blackice_cancel_job', { jobId: first.jobId }, client);
  await assert.rejects(api.resolveInteraction(first.jobId, 'nonexistent'), { code: 'DIRECT_INTERACTION_CHANGED' });
  assert.deepEqual(readReceipt(), bytes); assert.deepEqual(f.counts(), { launches: 1, preparedExecutions: 1 });
  await api.close();
  const reopened = f.open();
  const replay = await reopened.call('blackice_run_command', { ...args }, client);
  assert.equal(replay.existing, true); assert.equal(replay.status, 'failed');
  assert.equal((await settle(reopened, first.jobId)).result.text.text, first.result.text.text);
  assert.deepEqual(readReceipt(), bytes); assert.deepEqual(f.counts(), { launches: 1, preparedExecutions: 1 });
});


function hangingCommandFixture() {
  const child=new EventEmitter();child.pid=98765;
  child.stdout=new EventEmitter();child.stderr=new EventEmitter();
  child.stdout.destroy=()=>{};child.stderr.destroy=()=>{};
  child.kill=()=>true;
  let terminators=0;
  const spawn=(executable)=>{
    if(executable==='taskkill.exe'){
      terminators++;
      const killer=new EventEmitter();killer.kill=()=>true;
      queueMicrotask(()=>killer.emit('close',0));
      return killer;
    }
    queueMicrotask(()=>child.emit('spawn'));
    return child;
  };
  const mod=evaluate('workspace-tools',{spawn,DESKTOP_RESTART_ORIGIN_ENV:'BLACKICE_RESTART_ORIGIN',
    process:{pid:process.pid,platform:'win32',env:{},kill:forbidden}},['processRun']);
  return {run:mod.processRun,terminations:()=>terminators,child};
}
test('cancelled command settles after bounded termination even if child close never arrives',async()=>{
  const f=hangingCommandFixture(),controller=new AbortController();
  const pending=f.run('mock-command',[],{cwd:process.cwd(),signal:controller.signal,timeoutMs:3000});
  setTimeout(()=>controller.abort(),10);
  const started=Date.now();
  await assert.rejects(pending,error=>error.name==='AbortError'&&error.code==='ABORT_ERR');
  assert.equal(f.terminations(),1);
  assert(Date.now()-started<2200,'cancellation must not depend indefinitely on child close');
});
test('a timed-out command without close reports unknown effects, not successful completion',async()=>{
  const f=hangingCommandFixture(),started=Date.now();
  await assert.rejects(f.run('mock-command',[],{cwd:process.cwd(),timeoutMs:15}),
    error=>error.code==='WORKSPACE_COMMAND_TERMINATION_UNCONFIRMED'&&/possible effects are unknown/i.test(error.message));
  assert.equal(f.terminations(),1);
  assert(Date.now()-started<2200,'time budget must not become a lifetime restart blocker');
});
test('normal command close retains completion semantics without termination',async()=>{
  const child=new EventEmitter();child.pid=2468;
  child.stdout=new EventEmitter();child.stderr=new EventEmitter();
  const spawn=()=>{queueMicrotask(()=>{child.emit('spawn');child.emit('close',0,null);});return child;};
  const mod=evaluate('workspace-tools',{spawn,DESKTOP_RESTART_ORIGIN_ENV:'BLACKICE_RESTART_ORIGIN'},['processRun']);
  const result=await mod.processRun('mock-command',[],{cwd:process.cwd(),timeoutMs:1000});
  assert.equal(result.exitCode,0);assert.equal(result.timedOut,false);
});


test('timed-out command with inherited-open pipes settles durably without success or confirmed effects',async t=>{
  const f=await fixture(t,true,{hangAfterSpawn:true}),api=f.open();
  const call=await api.call('blackice_run_command',{requestId:'fixture-stalled-no-close',command:'fixture-no-op-never-dispatched-in-host',timeoutMs:100},client);
  const done=await settle(api,call.jobId);
  assert.equal(done.status,'failed');
  assert.equal(done.effects.possible,true); assert.equal(done.effects.confirmed,false);
  assert.equal(done.settled,true);
  const info=JSON.parse(done.result.text.text);
  assert.match(JSON.stringify(info),/WORKSPACE_COMMAND_TERMINATION_UNCONFIRMED|possible effects are unknown/i);
  const current=readSavedDirectJobBytes(api.jobs.databaseFile,call.jobId);
  await api.close();
  const reopen=f.open(),again=await reopen.call('blackice_get_job',{jobId:call.jobId},client);
  assert.equal(again.status,'failed');assert.equal(again.effects.confirmed,false);
  assert.deepEqual(readSavedDirectJobBytes(reopen.jobs.databaseFile,call.jobId),current);
});
test('cancellation of a command that never closes yields durable cancellation with unknown effects',async t=>{
  const f=await fixture(t,true,{hangAfterSpawn:true}),api=f.open();
  const call=await api.call('blackice_run_command',{requestId:'fixture-stalled-command-cancel',command:'fixture-inert-no-host-execution',timeoutMs:30000},client);
  for(let i=0;i<80;i++){
    const state=await api.call('blackice_get_job',{jobId:call.jobId},client);
    if(state.status==='running')break;
    await new Promise(resolve=>setTimeout(resolve,5));
  }
  await api.call('blackice_cancel_job',{jobId:call.jobId},client);
  const done=await settle(api,call.jobId);
  assert.equal(done.status,'cancelled');
  assert.equal(done.effects.possible,true);assert.equal(done.effects.confirmed,false);
  assert.equal(api.active.size,0);
});


test('failed taskkill startup and already-exited PID do not leave cancellation pending',async()=>{
  const child=new EventEmitter();child.pid=24680;child.stdout=new EventEmitter();child.stderr=new EventEmitter();
  child.stdout.destroy=()=>{};child.stderr.destroy=()=>{};
  child.kill=()=>{throw Object.assign(new Error('already exited'),{code:'ESRCH'});};
  const spawn=(executable)=>{
    if(executable==='taskkill.exe'){
      const killer=new EventEmitter();killer.kill=()=>{throw Error('taskkill already closed');};
      queueMicrotask(()=>killer.emit('error',Object.assign(new Error('not found'),{code:'ENOENT'})));
      return killer;
    }
    queueMicrotask(()=>child.emit('spawn'));return child;
  };
  const mod=evaluate('workspace-tools',{spawn,DESKTOP_RESTART_ORIGIN_ENV:'BLACKICE_RESTART_ORIGIN',
    process:{pid:process.pid,platform:'win32',env:{},kill:forbidden}},['processRun']);
  const controller=new AbortController();
  const running=mod.processRun('mock-command',[],{cwd:process.cwd(),signal:controller.signal,timeoutMs:2000});
  setTimeout(()=>controller.abort(),10);
  await assert.rejects(running,error=>error.code==='ABORT_ERR');
});
