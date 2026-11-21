'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const assert = require('node:assert/strict');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function main(root) {
  assert(path.isAbsolute(root), 'Absolute owned trace root required');
  const executable = path.join(root, 'build', 'bin', 'llama-server.exe');
  assert(!fs.existsSync(path.join(path.dirname(executable), 'blackice-trace.json')), 'Do not run fixtures over an installed experimental sidecar');
  const directory = path.join(root, 'fixtures', `native-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`);
  fs.mkdirSync(directory, {recursive:true});
  const commands = [];
  function run(name, args, configFile, expectedExit = 0) {
    const env = {...process.env};
    delete env.BLACKICE_TRACE_CONFIG;
    if (configFile) env.BLACKICE_TRACE_CONFIG = configFile;
    const result = childProcess.spawnSync(executable, args, {cwd:path.dirname(executable), env, encoding:'utf8', timeout:30000, maxBuffer:16*1024*1024, windowsHide:true});
    const receipt = {name,at:new Date().toISOString(),pid:result.pid,args,configFile:configFile ?? null,exitCode:result.status,signal:result.signal,
      error:result.error ? {code:result.error.code,message:result.error.message} : null,stdout:result.stdout,stderr:result.stderr,modelStarted:false};
    fs.writeFileSync(path.join(directory,`${name}.command.json`),JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});
    commands.push(receipt);
    assert.equal(result.error,undefined,`${name}: command failed`);
    assert.equal(result.status,expectedExit,`${name}: unexpected exit; ${result.stderr}`);
    return receipt;
  }
  function config(name, enabled, activationCaptureEnabled, extra = {}) {
    const outputDirectory = path.join(directory,`${name}-output-é`);
    const value = {schema:'blackice.minicpm.trace-config.v1',enabled,activationCaptureEnabled,outputDirectory,
      tensorSelection:['attn_norm','attn_post_norm','ffn_out','l_out'],maxBytes:268435456,logitVectorSteps:8,...extra};
    const configFile = path.join(directory,`${name}.config.json`);
    const bytes = Buffer.from(JSON.stringify(value,null,2).replaceAll('\n','\r\n')+'\r\n');
    fs.writeFileSync(configFile,bytes,{flag:'wx'});
    return {outputDirectory,configFile,bytes,value};
  }
  function inspectVersion(receipt, cfg) {
    assert.match(receipt.stderr + receipt.stdout,/build 12359, commit b1b770d90/);
    assert.match(receipt.stderr + receipt.stdout,/GNU 16\.2\.0/);
    const files = fs.readdirSync(cfg.outputDirectory);
    assert.equal(files.length,1,'--version must not create a model context or inference trace');
    assert.match(files[0],/\.process\.jsonl$/);
    const raw = fs.readFileSync(path.join(cfg.outputDirectory,files[0]),'utf8');
    assert(raw.endsWith('\n'),'Process receipt needs a complete final line');
    const events = raw.trimEnd().split('\n').map(JSON.parse);
    assert.deepEqual(events.map(e=>e.event),['process_start','process_exit_without_main_return']);
    assert.deepEqual(events.map(e=>e.fileSequence),[1,2]);
    assert.equal(events[0].pid,receipt.pid);
    assert.equal(events[0].data.configSource,'explicit-environment-override');
    assert.equal(events[0].data.configPath,cfg.configFile);
    assert.equal(events[0].data.configBytesUtf8,cfg.bytes.toString('utf8'));
    assert.equal(events[0].data.configSha256,sha(cfg.bytes));
    assert.equal(events[0].data.effectiveConfig.activationCaptureEnabled,cfg.value.activationCaptureEnabled);
    assert.equal(events[1].data.complete,false,'Upstream exit() must not fabricate a main-return status');
    assert.equal(events[1].data.exitCode,null);
    assert.match(events[1].data.reason,/host exit observation is required/);
    assert.equal(receipt.exitCode,0,'The independent parent receipt observes the actual CLI exit');
    assert.equal(events[1].data.openContexts,0);
    assert.equal(events[1].data.openHttpRequests,0);
    assert.equal(events[1].data.droppedEvents,0);
    return {path:path.join(cfg.outputDirectory,files[0]),sha256:sha(Buffer.from(raw)),events:events.length,pid:receipt.pid};
  }
  const before = fs.readdirSync(path.dirname(executable)).sort();
  run('absent-sidecar',['--version']);
  assert.deepEqual(fs.readdirSync(path.dirname(executable)).sort(),before,'Absent sidecar must not create recorder artifacts');
  const selfDirectory = path.join(directory,'cpp-self-test');
  run('cpp-self-test',['--blackice-trace-self-test',selfDirectory]);
  const self = JSON.parse(fs.readFileSync(path.join(selfDirectory,'result.json'),'utf8'));
  assert.equal(self.passed,19);
  assert.equal(self.complete,true);
  assert.equal(self.modelStarted,false);
  const overflowFiles = fs.readdirSync(selfDirectory).filter(n=>n.endsWith('.invalid.json'));
  assert.equal(overflowFiles.length,1);
  const overflow = JSON.parse(fs.readFileSync(path.join(selfDirectory,overflowFiles[0]),'utf8'));
  assert.equal(overflow.complete,false);
  assert.match(overflow.reason,/budget exceeded/i);
  const metadata = config('metadata-only',true,false);
  const metadataReceipt = inspectVersion(run('metadata-only',['--version'],metadata.configFile),metadata);
  const capture = config('activation-enabled',true,true);
  const captureReceipt = inspectVersion(run('activation-enabled',['--version'],capture.configFile),capture);
  const disabled = config('disabled',false,false);
  run('disabled',['--version'],disabled.configFile);
  assert.equal(fs.existsSync(disabled.outputDirectory),false);
  const malformed = config('unknown-field',true,false,{silentFallback:false});
  const rejected = run('unknown-field',['--version'],malformed.configFile,2);
  assert.match(rejected.stderr,/Unknown trace configuration field/);
  assert.equal(fs.existsSync(malformed.outputDirectory),false);
  const receipt = {schema:'blackice.minicpm.instrumentation-fixtures.v1',at:new Date().toISOString(),directory,
    binary:{path:executable,sha256:sha(fs.readFileSync(executable)),bytes:fs.statSync(executable).size},
    nativeSelfTests:self.passed,cliCases:6,metadataReceipt,captureReceipt,commands:commands.map(c=>({name:c.name,pid:c.pid,exitCode:c.exitCode})),
    configSnapshotVerified:true,unicodePathVerified:true,overflowInvalidationVerified:true,complete:true,modelStarted:false,parityVerified:false};
  const output = path.join(root,'receipts','instrumentation-fixtures.json');
  const bytes = Buffer.from(JSON.stringify(receipt,null,2)+'\n');
  const temporary = output+`.tmp-${process.pid}`;
  fs.writeFileSync(temporary,bytes,{flag:'wx'});const fd=fs.openSync(temporary,'r+');fs.fsyncSync(fd);fs.closeSync(fd);fs.renameSync(temporary,output);
  assert.equal(sha(fs.readFileSync(output)),sha(bytes));
  console.log(JSON.stringify({...receipt,receipt:output}));
}
if (require.main === module) { try { main(process.argv[2]); } catch(error) { console.error(error.stack);process.exitCode=1; } }
module.exports={main};
