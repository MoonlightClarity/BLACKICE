import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {crc32} from 'node:zlib';
import {parseOptions, verifyBuild, validatePreflight, OwnershipGuard, counterCrc32, decodeFrameCounter, hasIntegrityCounter, summarizeClicks, assessFixtureStartupSample,sampleFixtureStartup,waitForFixtureStartup,observeMotion, measure} from '../verification/measure-workbench-native-session.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const binaryWord=value=>Array.from({length:32},(_,bit)=>{const level=(value>>>bit)&1?245:24;return {r:level,g:level,b:level}});
const coherentCounter=value=>[...binaryWord(value),...binaryWord(counterCrc32(value))];

test('portable native measurement is inert without explicit live opt-in and rejects ambiguous arguments', async () => {
  assert.deepEqual(parseOptions(['--help']), {help: true});
  for (const args of [[], ['--live=false'], ['--live', '--live'], ['--live', '--take'], ['--live', '--run-id', '../escape'],
    ['--live', '--source-dir', 'relative'], ['--live', '--workspace'], ['--live', '--output-dir', '\0']]) {
    assert.throws(() => parseOptions(args), /live|option|path|RunId|value/);
  }
  await assert.rejects(measure({}), /opt-in/);
  const root = path.join(os.tmpdir(), 'blackice-portable-source');
  const first = parseOptions(['--live'], {sourceDirectory: root}), second = parseOptions(['--live'], {sourceDirectory: root});
  assert.notEqual(first['run-id'], second['run-id']);
  assert.equal(first['build-receipt'], path.join(root, '.build', 'workbench-freerdp-client-build.json'));
  assert.equal(first['output-dir'], path.join(root, '.build', 'native-verification', first['run-id']));
  assert.equal(first['frame-interval-ms'], 33);
  for (const interval of [8,16,33,100]) assert.equal(parseOptions(['--live', '--frame-interval-ms', String(interval)])['frame-interval-ms'], interval);
  for (const interval of ['7','101','16.5','0','NaN','-16','1e2'])
    assert.throws(() => parseOptions(['--live', '--frame-interval-ms', interval]), /interval|value/);
  await assert.rejects(measure({live:true,'frame-interval-ms':7}), /Frame interval/);
  for (const key of ['source-dir', 'app-dir', 'profile-dir', 'workspace', 'output-dir', 'build-receipt']) {
    const selected = path.join(os.tmpdir(), key);
    assert.equal(parseOptions(['--live', `--${key}`, selected])[key], selected);
  }
});

test('motion observation awaits receipts without a timer and reports actual sampling and counter skips', async () => {
  let clock=0,index=0,inFlight=false;
  const counters=[10,10,13,null],delays=[4,6,8,12],timeouts=[];
  const points=value=>value===null?[]:coherentCounter(value);
  const motion=await observeMotion({durationMs:30,now:()=>clock,sample:async timeout=>{
    assert.equal(inFlight,false);inFlight=true;timeouts.push(timeout);await Promise.resolve();
    clock+=delays[index];const value={sequence:index+1,points:points(counters[index++])};inFlight=false;return value;
  }});
  assert.equal(motion.totalSamples,4);assert.equal(motion.durationMs,30);assert.equal(motion.invalidSamples,1);
  assert.equal(motion.samplesPerSecond,4/.03);assert.equal(motion.uniqueGuestFrames,2);
  assert.equal(motion.firstCounter,10);assert.equal(motion.lastCounter,13);assert.equal(motion.counterSpan,4);
  assert.equal(motion.unobservedCounterValues,2);
  assert.equal(motion.integrity.valid,true);assert.equal(motion.integrity.wholeDesktopAtomicityProven,false);
  assert.equal(motion.metric,'checksum-valid decoded markers');
  assert.deepEqual(motion.sampleIntervals,{count:3,minMs:6,p50Ms:8,p95Ms:12,maxMs:12});
  assert.equal(motion.observer.sampleBoundReached,false);assert.equal(motion.observer.strategy,'back-to-back native sample receipts');
  assert.ok(timeouts.every(timeout=>timeout>=100&&timeout<=5000));
});

test('motion observation bounds stalled clocks and propagates lost ownership without additional samples', async () => {
  const points=coherentCounter(0);let calls=0;
  const bounded=await observeMotion({maxSamples:3,now:()=>0,sample:async()=>{calls++;return {sequence:calls,points}}});
  assert.equal(calls,3);assert.equal(bounded.observer.sampleBoundReached,true);assert.equal(bounded.uniqueGuestFrames,1);
  let assertions=0;
  await assert.rejects(observeMotion({now:()=>0,assertCurrent:()=>{if(++assertions===2)throw Error('ownership lost')},
    sample:async()=>{calls++;return {sequence:calls,points}}}),/ownership lost/);
  assert.equal(calls,4);
  await assert.rejects(observeMotion({sample:async()=>({points}),maxSamples:100001}),/bounded/);
});

test('CRC32 counter integrity agrees with independent zlib and rejects valid-colour torn or stale rows',()=>{
  assert.equal(crc32(Buffer.from('123456789')),0xcbf43926);
  for(const [value,expected]of [[0,0x2144df1c],[1,0x99f8b879],[0x34333231,0x9be3e0a3],[0x80000000,0xccfc5c3c],[0xffffffff,0xffffffff]]){
    const bytes=Buffer.alloc(4);bytes.writeUInt32LE(value);
    assert.equal(counterCrc32(value),expected);assert.equal(counterCrc32(value),crc32(bytes));
    assert.equal(decodeFrameCounter(coherentCounter(value),{requireChecksum:true}),value);
  }
  const staleChecksum=[...binaryWord(11),...binaryWord(counterCrc32(10))];
  assert.equal(staleChecksum.length,64);assert.equal(decodeFrameCounter(staleChecksum),null);
  const torn=coherentCounter(10);torn[0]=binaryWord(11)[0];
  assert.equal(decodeFrameCounter(torn,{requireChecksum:true}),null);
  assert.equal(decodeFrameCounter(binaryWord(10),{requireChecksum:true}),null);
  assert.equal(decodeFrameCounter(binaryWord(10)),10,'legacy decoder remains explicit-compatible');
});

test('startup rejects checksum-valid white pixels and requires bounded fixture counter plus both amber panels',()=>{
  const white=Array.from({length:66},()=>({r:245,g:245,b:245}));
  assert.equal(decodeFrameCounter(white.slice(0,64),{requireChecksum:true}),0xffffffff,'Uniform white is a real CRC32 fixed point');
  assert.deepEqual(assessFixtureStartupSample({sequence:17,counterSequence:17,markerSequence:17,points:white},{frameIntervalMs:16}),{ready:false,reason:'counter-out-of-fixture-range',maximumCounter:1876});
  const amber={r:255,g:176,b:0},candidate={sequence:17,counterSequence:17,markerSequence:17,points:[...coherentCounter(42),amber,amber]};
  assert.deepEqual(assessFixtureStartupSample(candidate,{frameIntervalMs:16}),{ready:true,counter:42,maximumCounter:1876,nativeSequence:17});
  assert.equal(assessFixtureStartupSample({...candidate,points:[...coherentCounter(1877),amber,amber]},{frameIntervalMs:16}).ready,false);
  assert.equal(assessFixtureStartupSample({...candidate,points:[...coherentCounter(42),amber,{r:16,g:216,b:255}]},{frameIntervalMs:16}).reason,'fixture-marker-colors');
  const torn=[...coherentCounter(42),amber,amber];torn[32]=binaryWord(counterCrc32(43))[0];
  assert.equal(assessFixtureStartupSample({...candidate,points:torn},{frameIntervalMs:16}).reason,'counter-integrity');
});
test('bounded startup warmup discards pre-fixture frames without weakening subsequent motion regressions',async()=>{
  const white=Array.from({length:66},()=>({r:245,g:245,b:245})),amber={r:255,g:176,b:0};let time=0,calls=0;
  const ready=await waitForFixtureStartup({frameIntervalMs:16,now:()=>time,sample:async()=>{time+=10;calls++;return {sequence:calls,counterSequence:calls,markerSequence:calls,points:calls<3?white:[...coherentCounter(3),amber,amber]};}});
  assert.equal(ready.ready,true);assert.equal(ready.counter,3);assert.equal(ready.samples,3);assert.equal(ready.durationMs,30);
  assert.deepEqual(ready.rejections,{'counter-out-of-fixture-range':2});
  let index=0;const counters=[4,5,4];time=0;
  const motion=await observeMotion({durationMs:3,now:()=>time,sample:async()=>{time++;return {points:coherentCounter(counters[index++])};}});
  assert.equal(motion.integrity.valid,false);assert.equal(motion.counterRegressions,1,'Real motion regression still invalidates evidence');
  const bounded=await waitForFixtureStartup({frameIntervalMs:16,maxSamples:2,now:()=>0,sample:async()=>({points:white})});
  assert.equal(bounded.ready,false);assert.equal(bounded.samples,2);assert.equal(bounded.sampleBoundReached,true);
  let assertions=0,samples=0;await assert.rejects(waitForFixtureStartup({frameIntervalMs:16,now:()=>0,assertCurrent:()=>{if(++assertions===2)throw Error('ownership changed');},sample:async()=>{samples++;return {points:white};}}),/ownership changed/);
  assert.equal(samples,1);
});
test('startup respects native64-point limit and rejects drift between marker and CRC receipts',async()=>{
  const points=Array.from({length:64},(_,x)=>({x,y:0})),markerPoints=[{x:10,y:10},{x:20,y:10}],amber={r:255,g:176,b:0};
  const sequences=[3,4,5,5],calls=[];let time=0;
  const sample=async selected=>{assert.ok(selected.length<=64,'Real native sampler rejects more than64 points');calls.push(selected.length);time++;
    return {sequence:sequences.shift(),points:selected.length===2?[amber,amber]:coherentCounter(7)};};
  const ready=await waitForFixtureStartup({frameIntervalMs:16,now:()=>time,sample:timeoutMs=>sampleFixtureStartup({sample,points,markerPoints,timeoutMs})});
  assert.equal(ready.ready,true);assert.equal(ready.nativeSequence,5);assert.equal(ready.samples,2);assert.deepEqual(calls,[2,64,2,64]);
  assert.deepEqual(ready.rejections,{'native-frame-changed':1});
});

test('live measurement requires complete integrity metadata and treats coherent regressions as invalid',async()=>{
  const metadata={binaryFrameCounter:{bits:32,bitOrder:'least-significant-first',valueType:'uint32',
    checksum:{algorithm:'crc32-ieee',inputEncoding:'uint32-little-endian',bits:32,pointOffset:32,polynomial:'0xEDB88320',initial:'0xFFFFFFFF',xorOut:'0xFFFFFFFF',bitOrder:'least-significant-first'},
    samplePoints:Array.from({length:64},(_,index)=>({role:index<32?'counter':'checksum',bit:index%32,screenPoint:{x:index%32,y:index<32?0:1}}))}};
  assert.equal(hasIntegrityCounter(metadata),true);
  for(const modify of [value=>value.binaryFrameCounter.samplePoints.pop(),value=>{value.binaryFrameCounter.checksum.algorithm='none'},
    value=>{value.binaryFrameCounter.samplePoints[32].role='counter'},value=>{value.binaryFrameCounter.checksum.inputEncoding='uint32-big-endian'}]){
    const changed=structuredClone(metadata);modify(changed);assert.equal(hasIntegrityCounter(changed),false);
  }
  const samples=[coherentCounter(1),[...binaryWord(2),...binaryWord(counterCrc32(1))],coherentCounter(0),coherentCounter(3)];let time=0,index=0;
  const result=await observeMotion({durationMs:4,now:()=>time,sample:async()=>{time++;return {sequence:time,points:samples[index++]}}});
  assert.equal(result.uniqueGuestFrames,2);assert.equal(result.invalidSamples,2);assert.equal(result.counterRegressions,1);
  assert.equal(result.integrity.valid,false);
  assert.deepEqual(result.observations.map(value=>value.frame),[1,3]);
  assert.equal(result.observer.integrity,'crc32-ieee-uint32-le');
});

test('portable launch forwards the validated guest cadence and preserves final guest paint evidence', async () => {
  const source=await fs.readFile(new URL('../verification/measure-workbench-native-session.mjs',import.meta.url),'utf8');
  assert.match(source,/'-FrameIntervalMilliseconds', String\(frameIntervalMs\)/);
  assert.match(source,/initial\.cadence\?\.requestedIntervalMs !== frameIntervalMs/);
  assert.match(source,/guestPaintFramesPerSecond = final\.cadence\?\.actualUniquePaintFramesPerSecond/);
  assert.match(source,/report\.motion\?\.integrity\?\.valid === true/);
  assert.doesNotMatch(source,/await pause\(3\)/);
});

test('build binding verifies current source, helper, both locks and runtime manifest before live work', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blackice-native-measure-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const source = path.join(root, 'scripts', 'workbench-freerdp-client', 'main.cpp');
  const executable = path.join(root, '.build', 'native.exe'), runtimeDirectory = path.join(root, '.build', 'runtime');
  const records = [[source, 'source'], [executable, 'executable'], [path.join(root, 'docs', 'workbench-freerdp-compiler.lock.json'), 'compiler lock'],
    [path.join(root, 'docs', 'workbench-freerdp-dependencies.lock.json'), 'runtime lock'], [path.join(runtimeDirectory, 'runtime-manifest.json'), 'manifest']];
  for (const [file, bytes] of records) { await fs.mkdir(path.dirname(file), {recursive: true}); await fs.writeFile(file, bytes); }
  const [sourceSha256, sha256, compilerLockSha256, runtimeLockSha256, runtimeManifestSha256] = records.map(([, bytes]) => digest(bytes));
  const receipt = {schema: 2, source, executable, runtimeDirectory, sourceSha256, sha256, compilerLockSha256, runtimeLockSha256, runtimeManifestSha256,
    selfTest: {selfTest: true, networkStarted: false, digestReady: true, foregroundUnchanged: true, vmConnectProtocolVerified: true}};
  const receiptPath = path.join(root, '.build', 'receipt.json'); await fs.writeFile(receiptPath, JSON.stringify(receipt));
  const options = {'source-dir': root, 'build-receipt': receiptPath};
  const verified = await verifyBuild(options);
  assert.equal(verified.hashes.helperSha256, sha256); assert.equal(verified.hashes.runtimeManifestSha256, runtimeManifestSha256);
  assert.match(verified.hashes.buildReceiptSha256, /^[a-f0-9]{64}$/);
  for (const [file, bytes] of records) {
    await fs.writeFile(file, bytes + ' stale');
    await assert.rejects(verifyBuild(options), /binding changed/);
    await fs.writeFile(file, bytes);
  }
  receipt.selfTest.networkStarted = true; await fs.writeFile(receiptPath, JSON.stringify(receipt));
  await assert.rejects(verifyBuild(options), /self-test/);
});

test('preflight requires current local VMMS provenance, exact VM identity and a valid independent pin', () => {
  const now = Date.UTC(2026, 10, 1), certificateSha256 = 'b'.repeat(64);
  const value = {version: 1, readyForBoundedProbe: true, vmName: 'Fixture-VM', vmState: 'Running', host: '127.0.0.1', port: 2179,
    listenerOwnedByVmms: true, vmId: '12345678-abcd-1234-abcd-123456789012', certificateSha256,
    certificates: [{sha256: certificateSha256, source: 'local-vmms-service-certificate-store', notAfter: '2027-01-01T00:00:00Z'}]};
  assert.equal(validatePreflight(value, 'Fixture-VM', now).certificateSha256, certificateSha256);
  for (const changed of [{listenerOwnedByVmms: false}, {vmName: 'Other-VM'}, {vmState: 'Off'}, {host: 'example.test'},
    {certificateSha256: 'c'.repeat(64)}, {certificates: [{...value.certificates[0], source: 'network-handshake'}]},
    {certificates: [{...value.certificates[0], notAfter: '2025-01-01T00:00:00Z'}]}])
    assert.throws(() => validatePreflight({...value, ...changed}, 'Fixture-VM', now), /could not be verified/);
});

test('standalone ownership guard never takes control and remains cancelled after Take then Cede', async () => {
  let control = {owner: 'agent', revision: 4}, lost = 0; const routes = [];
  const guard = new OwnershipGuard(async route => { routes.push(route); return {consoleControl: control}; }, async () => { lost++; });
  await guard.check(); assert.equal(guard.revision, 4);
  control = {owner: 'user', revision: 5}; await assert.rejects(guard.check(), /stopped/);
  control = {owner: 'agent', revision: 6}; await assert.rejects(guard.check(), /stopped/);
  assert.throws(() => guard.assert(), /stopped/); assert.equal(lost, 1);
  assert.deepEqual(routes, ['/api/workbench', '/api/workbench']);
  const changed = new OwnershipGuard(async () => ({consoleControl: {owner: 'agent', revision: 2}}));
  changed.revision = 1; await assert.rejects(changed.check(), /stopped/);
  const unavailable = new OwnershipGuard(async () => { throw new Error('offline'); });
  await assert.rejects(unavailable.check(), /stopped/);
});

test('ownership monitor stops the native test path even when no new input is being submitted', async t => {
  let reads = 0, cancelled;
  const observed = new Promise(resolve => { cancelled = resolve; });
  const guard = new OwnershipGuard(async () => ({consoleControl: ++reads === 1 ? {owner: 'agent', revision: 8} : {owner: 'user', revision: 9}}), cancelled, 1);
  t.after(() => guard.stop());
  await guard.start();
  await Promise.race([observed, new Promise((_, reject) => setTimeout(() => reject(new Error('No cancellation')), 1000))]);
  await guard.stop(); assert.ok(guard.lost); assert.equal(reads, 2);
});

test('measurement counts unsigned guest binary paints and labels decoded-surface latency', () => {
  const pixel = value => ({r: value, g: value, b: value});
  const zero = Array.from({length: 32}, () => pixel(24));
  assert.equal(decodeFrameCounter(zero), 0);
  assert.equal(decodeFrameCounter(zero.map((p, i) => i === 31 ? pixel(245) : p)), 2 ** 31);
  assert.equal(decodeFrameCounter(zero.map(() => pixel(245))), 2 ** 32 - 1);
  assert.equal(decodeFrameCounter(zero.map((p, i) => i === 2 ? {r: 245, g: 24, b: 245} : p)), null);
  assert.equal(decodeFrameCounter([]), null);
  const summary = summarizeClicks(Array.from({length: 30}, (_, i) => ({observed: true, latencyMs: 30 - i})));
  assert.equal(summary.p50Ms, 15); assert.equal(summary.p95Ms, 29); assert.equal(summary.verified, 30);
  assert.equal(summary.timing, 'host submission to changed pixel in decoded RDP surface');
  assert.equal(summary.timingBasis, 'decoded-surface'); assert.equal(summary.physicalInputToPhoton, false);
  assert.equal(summarizeClicks([]).p50Ms, null);
});
