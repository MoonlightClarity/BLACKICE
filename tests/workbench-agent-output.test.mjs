import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import fs from 'node:fs/promises';
import os from 'node:os';
import {WorkbenchAgentJobs,createWorkbenchAgentToolHandler} from '../lib/workbench-agent-tools.mjs';

const meta={jobId:'a'.repeat(32),scopeHash:'b'.repeat(64),scriptSha256:'c'.repeat(64),agentId:'d'.repeat(32),guestSessionId:2,guestName:'BLACKICE-GUEST-FIXTURE'};
const receipt=extra=>({version:1,...meta,status:'completed',exitCode:0,stdout:'{"ok":true}',stderr:'',childrenStopped:true,finishedAt:new Date().toISOString(),...extra});

test('execution completion preserves explicit output completeness without guessing legacy receipts',()=>{
 const jobs=new WorkbenchAgentJobs({workbench:{}});
 assert.equal(jobs.validateResult(meta,receipt({stdoutTruncated:false,stderrTruncated:false,outputDrained:true})).outputComplete,true);
 const incomplete=jobs.validateResult(meta,receipt({stdoutTruncated:true,stderrTruncated:false}));
 assert.equal(incomplete.status,'completed');assert.equal(incomplete.outputComplete,false);assert.match(incomplete.outputNotice,/not complete evidence/);
 assert.equal(Object.hasOwn(jobs.validateResult(meta,receipt({})),'outputComplete'),false);
 assert.equal(Object.hasOwn(jobs.validateResult(meta,receipt({stdoutTruncated:false,stderrTruncated:false})),'outputComplete'),false);
 assert.equal(jobs.validateResult(meta,receipt({stdoutTruncated:false,stderrTruncated:false,outputDrained:false})).outputComplete,false);
 assert.throws(()=>jobs.validateResult(meta,receipt({stdoutTruncated:'false'})),error=>error.code==='WORKBENCH_AGENT_RECEIPT');
});

test('truncated output cannot mint an effect receipt even when its retained prefix is valid passing JSON',async()=>{
 let recorded=false;
 const jobs={inspect:async()=>({...receipt({stdoutTruncated:true,stderrTruncated:false}),outputComplete:false})};
 const handler=createWorkbenchAgentToolHandler({workbench:{},scope:'output-test',jobs,
  getVerificationBinding:()=>({status:'declared'}),recordVerifiedEffects:async()=>{recorded=true;return {}}});
 const result=await handler({name:'relay_workbench',arguments:{action:'guest_job',jobId:meta.jobId}});
 const value=JSON.parse(result.contentItems[0].text);
 assert.equal(result.success,false);assert.equal(value.executionStatus,'completed');assert.equal(value.verification.code,'WORKBENCH_VERIFICATION_OUTPUT_TRUNCATED');assert.equal(recorded,false);
});

test('actual Windows stream drain detects byte/character truncation and drains all output without creating a process',{skip:process.platform!=='win32'},()=>{
 const shell=path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');
 const checker=fileURLToPath(new URL('./fixtures/workbench-output-check.ps1',import.meta.url));
 const result=spawnSync(shell,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',checker,'-Source',fileURLToPath(new URL('../scripts/workbench-agent-job.ps1',import.meta.url))],{encoding:'utf8',windowsHide:true,timeout:30000,maxBuffer:1024*1024});
 assert.equal(result.status,0,result.stderr||result.stdout);const value=JSON.parse(result.stdout.trim());assert.equal(value.checks,6);assert.equal(value.jobConstructed,false);assert.equal(value.childStarted,false);
});

test('structured writer removes actual PowerShell provider metadata and rejects oversized/non-data observations before stdout',{skip:process.platform!=='win32'},async t=>{
 const scratch=await fs.mkdtemp(path.join(os.tmpdir(),'blackice-observation-'));
 t.after(async()=>{assert.ok(path.resolve(scratch).startsWith(path.resolve(os.tmpdir())+path.sep));assert.match(path.basename(scratch),/^blackice-observation-/);await fs.rm(scratch,{recursive:true,force:true})});
 const result=spawnSync(path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',fileURLToPath(new URL('./fixtures/workbench-observation-check.ps1',import.meta.url)),'-Source',fileURLToPath(new URL('../scripts/workbench-agent-job.ps1',import.meta.url)),'-Scratch',scratch],{encoding:'utf8',windowsHide:true,timeout:30000,maxBuffer:1024*1024});
 assert.equal(result.status,0,result.stderr||result.stdout);const value=JSON.parse(result.stdout.trim());assert.equal(value.providerMetadataRemoved,true);assert.equal(value.typedValuesPreserved,true);assert.equal(value.exactByteLimitPreserved,true);assert.equal(value.rejectedWithoutPartialJson,7);assert.equal(value.guestOperations,0);
});

test('ordinary JSON defaults prevent actual WinPS provider expansion while preserving native data and parameters',{skip:process.platform!=='win32'},async t=>{
 const scratch=await fs.mkdtemp(path.join(os.tmpdir(),'blackice-json-compat-'));
 t.after(async()=>{assert.ok(path.resolve(scratch).startsWith(path.resolve(os.tmpdir())+path.sep));assert.match(path.basename(scratch),/^blackice-json-compat-/);await fs.rm(scratch,{recursive:true,force:true})});
 const result=spawnSync(path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',fileURLToPath(new URL('./fixtures/workbench-json-compat-check.ps1',import.meta.url)),'-Source',fileURLToPath(new URL('../scripts/workbench-agent-job.ps1',import.meta.url)),'-Scratch',scratch],{encoding:'utf8',windowsHide:true,timeout:30000,maxBuffer:1024*1024});
 assert.equal(result.status,0,result.stderr||result.stdout);const value=JSON.parse(result.stdout.trim());assert.ok(value.checks>=30);assert.ok(value.nativeExpandedCharacters>16384);assert.ok(value.normalizedCharacters<256);assert.equal(value.providerNotesRestored,true);assert.equal(value.qualifiedNativeAvailable,true);assert.equal(value.guestOperations,0);
});
