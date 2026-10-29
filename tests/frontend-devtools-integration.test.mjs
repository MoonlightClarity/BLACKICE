import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { DirectExecutionAPI } from '../lib/direct-execution-api.mjs';
import { frontendDevtoolsTool } from '../lib/frontend-devtools-tool.mjs';
import { DIRECT_JOB_LIMITS } from '../lib/direct-execution-jobs.mjs';

const client={id:'frontend-development-grant',kind:'chatgpt',scopes:['read','commands:run']};
async function wait(api,id){
  for(let i=0;i<1000;i++){
    const value=await api.getJob(id,client,{includeImages:true});
    if(value.settled)return value;
    await pause(10);
  }
  throw Error('Frontend development job did not settle.');
}

test('native frontend tools use the existing grant and retain results without repeating actions',async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),'blackice-frontend-jobs-'));
  const cwd=path.join(directory,'workspace'),dataDir=path.join(directory,'data');
  await mkdir(cwd);
  const calls=[];
  const imageUrl='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/d/8AAAAASUVORK5CYII=';
  const frontend={async execute(args){
    calls.push(structuredClone(args));
    if(args.action==='screenshot')return{target:'frontend',width:1,height:1,imageUrl};
    if(args.expression==='throw Error("fixture")')return{target:'frontend',result:{exceptionDetails:{text:'Uncaught',exception:{description:'Error: fixture'}}}};
    return{target:args.target||'frontend',result:{result:{type:'number',value:calls.length}}};
  }};
  const create=()=>new DirectExecutionAPI({dataDir,allowedRoot:cwd,additionalTools:[frontendDevtoolsTool({frontend})]}).init();
  let api=await create();
  t.after(async()=>{await api.close().catch(()=>{});await rm(directory,{recursive:true,force:true});});
  assert.ok(api.tools(client).some(tool=>tool.name==='blackice_frontend'));
  assert.equal((await api.status(client)).localMutationApproval,false);
  const args={requestId:'evaluate-once',action:'evaluate',expression:'++window.fixtureCounter',params:{awaitPromise:true,returnByValue:true}};
  const admitted=await api.call('blackice_frontend',args,client);
  assert.equal(admitted.interaction,null);
  const completed=await wait(api,admitted.jobId);
  assert.equal(completed.status,'succeeded');
  assert.deepEqual(calls,[args]);
  assert.equal(JSON.parse(completed.result.text.text).result.result.value,1);
  const again=await api.call('blackice_frontend',args,client);
  assert.equal(again.existing,true);assert.equal(again.jobId,admitted.jobId);assert.equal(calls.length,1);

  const screenshot=await api.call('blackice_frontend',{requestId:'capture-once',action:'screenshot'},client);
  const captured=await wait(api,screenshot.jobId);
  assert.equal(captured.status,'succeeded');assert.equal(captured.result.imageCount,1);
  assert.equal(captured.result.images[0].imageUrl,imageUrl);
  const failure=await api.call('blackice_frontend',{requestId:'exception-once',action:'evaluate',expression:'throw Error("fixture")'},client);
  const failed=await wait(api,failure.jobId);
  assert.equal(failed.status,'failed');
  assert.equal(JSON.parse(failed.result.text.text).result.exceptionDetails.exception.description,'Error: fixture');

  await api.close();api=await create();
  assert.equal((await api.getJob(screenshot.jobId,client,{includeImages:true})).result.images[0].imageUrl,imageUrl);
  assert.equal((await api.call('blackice_frontend',args,client)).jobId,admitted.jobId);
  assert.equal(calls.length,3,'Reopening and recovering saved jobs must not execute the frontend again.');
});

function oversizedPng() {
  const crc32 = bytes => {
    let crc = 0xffffffff;
    for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
    return (crc ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const name = Buffer.from(type), head = Buffer.alloc(4), tail = Buffer.alloc(4);
    head.writeUInt32BE(data.length); tail.writeUInt32BE(crc32(Buffer.concat([name, data])));
    return Buffer.concat([head, name, data, tail]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 6;
  // A valid one-pixel PNG with a large ancillary text chunk. Preservation, not
  // image complexity or lossy recompression, is what this regression exercises.
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', ihdr),
    chunk('tEXt', Buffer.concat([Buffer.from('probe\0'), Buffer.alloc(3200000, 65)])),
    chunk('IDAT', deflateSync(Buffer.from([0,255,0,0,255]))), chunk('IEND', Buffer.alloc(0))]);
}

test('oversized profile and PNG survive durable replay and reopen without repeating native commands', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'blackice-frontend-large-jobs-'));
  const cwd = path.join(directory, 'workspace'), dataDir = path.join(directory, 'data'), artifactDirectory = path.join(directory, 'artifacts');
  await mkdir(cwd);
  const profile = { nodes: [{ id: 1, callFrame: { functionName: 'profileFixture', url: 'fixture', lineNumber: 0, columnNumber: 0 } }],
    samples: Array(750000).fill(1), timeDeltas: Array(750000).fill(1000) };
  const png = oversizedPng(), imageUrl = 'data:image/png;base64,' + png.toString('base64');
  const nativeProfile = { target: 'main', processId: 123, method: 'Profiler.stop', result: { profile } };
  let calls = 0;
  const frontend = { async execute(args) {
    calls++;
    return args.action === 'screenshot' ? { target: 'frontend', width: 1, height: 1, imageUrl } : nativeProfile;
  } };
  const create = () => new DirectExecutionAPI({ dataDir, allowedRoot: cwd,
    additionalTools: [frontendDevtoolsTool({ frontend, artifactDirectory })] }).init();
  let api = await create();
  t.after(async () => { await api.close().catch(() => {}); await rm(directory, { recursive: true, force: true }); });
  const profileArgs = { requestId: 'large-profile-once', action: 'cdp', target: 'main', method: 'Profiler.stop' };
  const imageArgs = { requestId: 'large-png-once', action: 'screenshot' };
  const profileJob = await api.call('blackice_frontend', profileArgs, client);
  const profileDone = await wait(api, profileJob.jobId);
  assert.equal(profileDone.status, 'succeeded');
  const profileReceipt = JSON.parse(profileDone.result.text.text);
  assert.equal(profileReceipt.artifact.complete, true); assert.equal(profileReceipt.method, 'Profiler.stop');
  const originalProfile = JSON.stringify({ success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(nativeProfile) }] });
  const profileBytes = await readFile(profileReceipt.artifact.path);
  assert.ok(profileBytes.length > DIRECT_JOB_LIMITS.resultBytes);
  assert.equal(profileBytes.toString(), originalProfile);
  assert.equal(profileReceipt.artifact.sha256, createHash('sha256').update(profileBytes).digest('hex'));
  assert.equal(profileReceipt.artifact.bytes, profileBytes.length);
  const imageJob = await api.call('blackice_frontend', imageArgs, client), imageDone = await wait(api, imageJob.jobId);
  assert.equal(imageDone.status, 'succeeded');
  const imageReceipt = JSON.parse(imageDone.result.text.text);
  const imageBytes = await readFile(imageReceipt.artifact.path), savedImage = JSON.parse(imageBytes);
  assert.ok(imageBytes.length > DIRECT_JOB_LIMITS.resultBytes);
  assert.equal(savedImage.contentItems[1].imageUrl, imageUrl);
  assert.equal(imageReceipt.artifact.bytes, imageBytes.length);
  assert.equal(imageReceipt.artifact.sha256, createHash('sha256').update(imageBytes).digest('hex'));
  assert.equal(imageReceipt.imageArtifacts.length, 1);
  const pngBytes = await readFile(imageReceipt.imageArtifacts[0].path);
  assert.ok(pngBytes.equals(png));
  assert.equal(imageReceipt.imageArtifacts[0].sha256, createHash('sha256').update(png).digest('hex'));
  assert.equal(calls, 2);
  assert.equal((await api.call('blackice_frontend', profileArgs, client)).jobId, profileJob.jobId);
  assert.equal((await api.call('blackice_frontend', imageArgs, client)).jobId, imageJob.jobId);
  await api.close(); api = await create();
  assert.equal((await api.call('blackice_frontend', profileArgs, client)).jobId, profileJob.jobId);
  assert.equal((await api.call('blackice_frontend', imageArgs, client)).jobId, imageJob.jobId);
  assert.equal(calls, 2);
  assert.deepEqual(JSON.parse((await api.getJob(profileJob.jobId, client)).result.text.text), profileReceipt);
  assert.deepEqual(JSON.parse((await api.getJob(imageJob.jobId, client)).result.text.text), imageReceipt);
  assert.equal((await readFile(profileReceipt.artifact.path)).toString(), originalProfile);
  assert.ok((await readFile(imageReceipt.imageArtifacts[0].path)).equals(png));
  assert.equal((await readdir(artifactDirectory)).filter(name => name.endsWith('.tmp')).length, 0);
});
