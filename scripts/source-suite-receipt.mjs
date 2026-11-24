// Run an explicit full inventory and bind its actual TAP output to unchanged source.
import { run } from 'node:test';
import { tap } from 'node:test/reporters';
import { promises as fs, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { appFingerprint } from './release-check.mjs';
import { releaseSourceIndex, classifySourceSkips } from './release-request.mjs';
import { parseSourceSuiteSkips } from './source-suite-skip-parser.mjs';
import {prepareSourceTestTemp} from './source-test-temp.mjs';
import {sourceSuiteIdentity} from './source-suite-provenance.mjs';
const root=process.cwd(),output=path.resolve(process.argv[2]||'source-suite-evidence');
const hash=x=>createHash('sha256').update(x).digest('hex');
const identity=sourceSuiteIdentity(root);
const startedAt=new Date().toISOString(),before=await releaseSourceIndex(root),fingerprint=await appFingerprint(root);
const files=before.records.filter(r=>/^tests\/[^/]+\.test\.mjs$/.test(r.path)).map(r=>r.path).sort();
if(process.platform!=='win32'||!files.length||new Set(files).size!==files.length)throw Error('A unique Windows source inventory is required.');
await fs.mkdir(output,{recursive:true});
const temporaryEnvironment=await prepareSourceTestTemp();
await fs.writeFile(path.join(output,'temporary-environment.json'),JSON.stringify(temporaryEnvironment,null,2));
console.log('Source fixture environment: '+JSON.stringify(temporaryEnvironment));
await fs.writeFile(path.join(output,'inventory.json'),JSON.stringify({startedAt,appFingerprint:fingerprint,...before,testFiles:files},null,2));
// Windows native compiler/process fixtures share runner resources. The matched
// affected-file run passed 136/136 serially but timed out twice at four workers.
// Keep all assertions and production deadlines; isolate file execution instead.
const stream=run({files:files.map(f=>path.join(root,f)),concurrency:1,timeout:120000});
let observedPasses=0;
const active=new Map();
stream.on('test:dequeue',event=>{if(event.nesting===0)active.set(event.name,Date.now());});
for(const type of ['test:pass','test:fail'])stream.on(type,event=>{if(event.nesting===0)active.delete(event.name);});
const heartbeatFile=createWriteStream(path.join(output,'heartbeat.ndjson'));
let heartbeatError;heartbeatFile.on('error',error=>{heartbeatError=error;});
const heartbeat=setInterval(()=>{const row={at:new Date().toISOString(),passed:observedPasses,active:[...active].map(([name,at])=>({name,seconds:Math.round((Date.now()-at)/1000)}))};heartbeatFile.write(JSON.stringify(row)+'\n');console.log('Source suite heartbeat: '+JSON.stringify(row));},30000);
heartbeat.unref();
stream.on('test:pass',()=>{if(++observedPasses%250===0)console.log('Source assertions passed so far: '+observedPasses);});
stream.on('test:fail',event=>console.log('Source failure: '+JSON.stringify({name:event.name,file:event.file,error:event.details?.error?.message})));
try { await pipeline(stream.compose(tap),createWriteStream(path.join(output,'suite.tap'))); }
finally { clearInterval(heartbeat);await new Promise(resolve=>heartbeatFile.end(resolve)); }
if(heartbeatError)throw heartbeatError;
const bytes=await fs.readFile(path.join(output,'suite.tap')),log=bytes.toString('utf8');
const counts=Object.fromEntries(['tests','pass','fail','cancelled','skipped','todo'].map(k=>{
 const found=[...log.matchAll(new RegExp('^# '+k+' (\\d+)\\r?$','gm'))];
 return [k,found.length===1?Number(found[0][1]):null];
}));
const skips=parseSourceSuiteSkips(log);
const {capability,unexpectedSkips}=classifySourceSkips(skips);
const after=await releaseSourceIndex(root),afterFingerprint=await appFingerprint(root);
const checkoutUnchanged=identity.sourceCommit===sourceSuiteIdentity(root).sourceCommit;
const sourceUnchanged=checkoutUnchanged&&before.sourceIndexSha256===after.sourceIndexSha256,fingerprintUnchanged=fingerprint===afterFingerprint;
const countsComplete=Object.values(counts).every(Number.isSafeInteger)&&counts.tests===counts.pass+counts.fail+counts.cancelled+counts.skipped+counts.todo&&counts.skipped===skips.length;
const passed=countsComplete&&counts.tests>=files.length&&counts.fail===0&&counts.cancelled===0&&counts.todo===0&&!unexpectedSkips.length&&sourceUnchanged&&fingerprintUnchanged;
const receipt={format:1,product:'BLACKICE',scope:'source-publication',...identity,checkoutUnchanged,version:JSON.parse(await fs.readFile('package.json','utf8')).version,startedAt,checkedAt:new Date().toISOString(),node:process.version,platform:process.platform,appFingerprint:fingerprint,sourceIndexSha256:before.sourceIndexSha256,sourceFilesVerified:before.records.length,testFiles:files.length,testInventorySha256:hash(JSON.stringify(files)),state:passed?'passed':'failed',passed,fullSuite:true,countsComplete,sourceUnchanged,fingerprintUnchanged,tests:{total:counts.tests,passed:counts.pass,failed:counts.fail,requiredSkipped:unexpectedSkips.length,optionalSkipped:counts.skipped-unexpectedSkips.length,cancelled:counts.cancelled,todo:counts.todo,exitCode:passed?0:1,signal:null},testLogSha256:hash(bytes),execution:{kind:'node-test-explicit-inventory',concurrency:1,uniqueCoverageVerified:countsComplete&&sourceUnchanged},optionalSkips:skips.map(s=>s.name),fileSymlinkCapabilitySkips:capability,skipDetails:skips.map(s=>({...s,assertionsRan:false})),unexpectedSkips,validationScope:'Windows source suite only. Named skipped assertions were not exercised. Live model and installed runtime require separate verification.'};
await fs.writeFile(path.join(output,'windows-'+receipt.version+'.json'),JSON.stringify(receipt,null,2)+'\n');
console.log(JSON.stringify({passed,counts,sourceIndexSha256:before.sourceIndexSha256,appFingerprint:fingerprint}));
console.log('SOURCE_TEST_RECEIPT='+JSON.stringify(receipt));
process.exitCode=passed?0:1;
