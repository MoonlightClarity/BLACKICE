import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { evaluateRelease, collectReleaseReport, appFingerprint, receiptTemplate } from '../scripts/release-check.mjs';
import { publicSigningConfiguration, publicBuilderConfiguration, verifyPublisherSignature } from '../scripts/release-signing.mjs';

const ready = () => {
  const version='9.8.7',fingerprint='a'.repeat(64),publisher='Disposable Test Publisher';
  return{version,fingerprint,mode:'public',signing:{configured:true,publisher,method:'pfx',missing:[],errors:[]},signature:{valid:true,status:'Valid',publisher,productVersion:version},artifact:{verified:true,version,appFingerprint:fingerprint,kind:'signed-installer',sha256:'c'.repeat(64)},receipts:{format:1,product:'BLACKICE',version,appFingerprint:fingerprint,artifactSha256:'c'.repeat(64),tests:{total:22,passed:20,failed:0,requiredSkipped:0,optionalSkipped:2},installIntegrity:{passed:true,filesVerified:100,sourceInstalledMatch:true,shortcutVerified:true,publicInstallerTested:true},profileBackup:{passed:true,verified:true,restoreVerified:true},diagnostics:{passed:true,redactionVerified:true,credentialLeakScanPassed:true}}};
};

async function releaseFixture(t) {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'blackice-release-check-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  for (const name of ['lib', 'public', 'desktop']) await fs.mkdir(path.join(directory, name));
  await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: 'relay-agent-harness', version: '9.8.7' }));
  for (const name of ['server.mjs', 'desktop/main.mjs', 'desktop/icon.ico']) await fs.writeFile(path.join(directory, name), 'disposable fixture');
  return directory;
}

test('runtime fingerprints bind desktop helpers and browser compatibility assets, including packaged omissions', async t => {
  const directory = await releaseFixture(t);
  for (const name of ['startup.mjs', 'restart.mjs', 'runtime-record.mjs', 'future/worker.mjs', 'future/preload.cjs', 'browser-compatibility/manifest.json', 'browser-compatibility/main.js']) {
    const before = await appFingerprint(directory), file = path.join(directory, 'desktop', name);
    await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, 'current runtime code');
    const included = await appFingerprint(directory); assert.notEqual(included, before, `${name} must enter runtime evidence`);
    await fs.appendFile(file, ' changed'); assert.notEqual(await appFingerprint(directory), included, `${name} edits must invalidate prior receipts`);
    await fs.rm(file); assert.equal(await appFingerprint(directory), before, `${name} omission must differ from the complete source fingerprint`);
  }
  const before = await appFingerprint(directory);
  for (const name of ['build-icon.mjs', 'future/worker.test.mjs', 'old.currents-backup-fixture/worker.mjs']) {
    const file = path.join(directory, 'desktop', name); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, 'excluded fixture');
  }
  assert.equal(await appFingerprint(directory), before, 'build-only, test, and recovery files are excluded on both sides');
});

test('release collection rejects inconsistent installer names, publisher identities, and signing policies', async t => {
  const directory = await releaseFixture(t), fingerprint = await appFingerprint(directory), distribution = path.join(directory, 'candidate'); await fs.mkdir(distribution);
  const bytes = Buffer.from('disposable fixture; never executed'), sha256 = createHash('sha256').update(bytes).digest('hex');
  const receipts = ready().receipts; receipts.appFingerprint = fingerprint; receipts.artifactSha256 = sha256;
  const receiptsFile = path.join(directory, 'receipts.json'); await fs.writeFile(receiptsFile, JSON.stringify(receipts));
  const baseline = { format: 1, product: 'BLACKICE', version: '9.8.7', appFingerprint: fingerprint, publisher: null, signing: { status: 'unsigned', publisher: null, publisherVerified: false }, releasePolicy: { requireCodeSigning: false }, artifact: { name: 'Blackice-9.8.7-Setup.exe', size: bytes.length, sha256 } };
  let verifications = 0;
  const check = async (manifest, environment = {}) => {
    await fs.writeFile(path.join(distribution, manifest.artifact.name), bytes); await fs.writeFile(path.join(distribution, 'blackice-public-release.json'), JSON.stringify(manifest));
    return collectReleaseReport({ directory, distribution, receiptsFile, environment, verifySignature: async () => { verifications++; return ready().signature; } });
  };
  assert.equal((await check(baseline)).publicReleaseReady, true, 'explicit unsigned releases remain supported');
  for (const [name, mutate] of [
    ['wrong filename version', value => { value.artifact.name = 'Blackice-9.8.6-Setup.exe'; }],
    ['wrong declared version', value => { value.version = '9.8.6'; }],
    ['string policy', value => { value.releasePolicy.requireCodeSigning = 'true'; }],
    ['missing policy boolean', value => { value.releasePolicy = {}; }],
    ['null policy', value => { value.releasePolicy = null; }],
    ['unknown policy field', value => { value.releasePolicy.requiredSigning = true; }],
  ]) {
    const manifest = structuredClone(baseline); mutate(manifest); const report = await check(manifest);
    assert.equal(report.publicReleaseReady, false, name); assert.equal(report.gates.find(gate => gate.id === 'artifact-integrity').status, 'failed', name);
  }
  const signed = { ...baseline, publisher: 'Different Publisher', signing: { status: 'signed', publisher: 'Different Publisher', publisherVerified: true } };
  const environment = { RELAY_SIGNING_PUBLISHER: ready().signing.publisher, WIN_CSC_LINK: 'fixture' };
  assert.equal((await check(signed, environment)).publicReleaseReady, false, 'manifest and observed publisher must agree');
  assert.equal(verifications, 0, 'invalid metadata fails before trusting a signature result');
  signed.publisher = environment.RELAY_SIGNING_PUBLISHER; signed.signing.publisher = signed.publisher;
  assert.equal((await check(signed, environment)).publicReleaseReady, true); assert.equal(verifications, 1);
});

test('public readiness requires every gate and never claims publication',()=>{
  const report=evaluateRelease(ready());assert.equal(report.passed,true);assert.equal(report.publicReleaseReady,true);assert.equal(report.classification,'ready-for-public-release');assert.equal(report.published,false);assert.ok(report.gates.every(gate=>gate.status==='passed'));
});
for(const [name,mutate] of [
  ['missing evidence',value=>{value.receipts=null;}],
  ['stale version',value=>{value.receipts.version='9.8.6';}],
  ['different runtime bytes',value=>{value.receipts.appFingerprint='b'.repeat(64);}],
  ['different signed installer bytes',value=>{value.receipts.artifactSha256='d'.repeat(64);}],
  ['failed test',value=>{value.receipts.tests.failed=1;}],
  ['skipped required tests',value=>{value.receipts.tests.requiredSkipped=1;}],
  ['fabricated test totals',value=>{value.receipts.tests.total=999;}],
  ['missing installed hashes',value=>{value.receipts.installIntegrity.sourceInstalledMatch=false;}],
  ['unexercised public installer',value=>{value.receipts.installIntegrity.publicInstallerTested=false;}],
  ['unrestored backup',value=>{value.receipts.profileBackup.restoreVerified=false;}],
  ['unscanned diagnostics',value=>{value.receipts.diagnostics.credentialLeakScanPassed=false;}],
  ['unsigned artifact',value=>{value.signature.valid=false;value.signature.status='NotSigned';}],
  ['another publisher',value=>{value.signature.publisher='Another Publisher';}],
  ['old signed installer',value=>{value.signature.productVersion='9.8.6';}],
  ['missing signing input',value=>{value.signing={configured:false,missing:['RELAY_SIGNING_PUBLISHER']};}],
  ['portable folder presented as public',value=>{value.artifact.kind='local-distribution';}],
])test(`public release fails closed for ${name}`,()=>{const value=ready();mutate(value);const report=evaluateRelease(value);assert.equal(report.passed,false);assert.equal(report.publicReleaseReady,false);assert.equal(report.classification,'public-release-blocked');});

test('local verification permits unsigned development artifacts but cannot report public readiness',()=>{
  const value=ready();value.mode='local';value.artifact.kind='local-distribution';value.signature=null;value.signing={configured:false,missing:['No certificate supplied']};value.receipts.installIntegrity.publicInstallerTested=false;const report=evaluateRelease(value);assert.equal(report.passed,true);assert.equal(report.publicReleaseReady,false);assert.equal(report.classification,'local-verification-passed');assert.equal(report.published,false);
});

test('signing configuration names missing inputs and never returns certificate values or passwords',async()=>{
  const missing=await publicSigningConfiguration({});assert.equal(missing.configured,false);assert.ok(missing.missing.includes('RELAY_SIGNING_PUBLISHER'));assert.equal(missing.builder,null);
  const configured=await publicSigningConfiguration({RELAY_SIGNING_PUBLISHER:'Provided Publisher',WIN_CSC_LINK:'SECRET_BASE64_CERTIFICATE',WIN_CSC_KEY_PASSWORD:'SECRET_PASSWORD'});assert.equal(configured.configured,true);assert.equal(configured.method,'pfx');assert.equal(configured.builder.forceCodeSigning,true);assert.equal(configured.builder.win.signExecutable,true);assert.equal(configured.builder.win.signtoolOptions.publisherName,'Provided Publisher');assert.doesNotMatch(JSON.stringify(configured),/SECRET/);
  const store=await publicSigningConfiguration({RELAY_SIGNING_PUBLISHER:'Provided Publisher',RELAY_SIGNING_CERT_SHA1:'ab'.repeat(20)});assert.equal(store.method,'certificate-store');assert.equal(store.builder.win.signtoolOptions.certificateSha1,'ab'.repeat(20));
  assert.equal((await publicSigningConfiguration({RELAY_SIGNING_PUBLISHER:'Provided Publisher',RELAY_SIGNING_CERT_SHA1:'invalid'})).configured,false);
});

test('Azure signing configuration uses the installed builder field names and rejects missing or mismatched identities',async()=>{
  const config={publisherName:'Provided Publisher',endpoint:'https://example.invalid',certificateProfileName:'provided-profile',codeSigningAccountName:'provided-account',password:'SECRET'};
  const signing=await publicSigningConfiguration({RELAY_SIGNING_PUBLISHER:'Provided Publisher',RELAY_AZURE_SIGNING_CONFIG:'fixture.json'},{readFile:async()=>JSON.stringify(config)});assert.equal(signing.configured,true);assert.equal(signing.method,'azure');assert.equal(signing.builder.win.azureSignOptions.certificateProfileName,'provided-profile');assert.equal(signing.builder.win.signtoolOptions,undefined);assert.doesNotMatch(JSON.stringify(signing),/SECRET|password/);
  assert.equal((await publicSigningConfiguration({RELAY_SIGNING_PUBLISHER:'Different Publisher',RELAY_AZURE_SIGNING_CONFIG:'fixture.json'},{readFile:async()=>JSON.stringify(config)})).configured,false);
});

test('the public signing/NSIS configuration is accepted by the installed electron-builder schema',async()=>{
  const {validateConfiguration}=await import('../node_modules/app-builder-lib/out/util/config/config.js');
  const signing=await publicSigningConfiguration({RELAY_SIGNING_PUBLISHER:'Provided Publisher',RELAY_SIGNING_CERT_SHA1:'ab'.repeat(20)}),config=publicBuilderConfiguration(signing,{source:path.resolve('.'),output:path.resolve('.build/disposable-schema-check')});
  await validateConfiguration(config,{isEnabled:false});assert.equal(config.forceCodeSigning,true);assert.equal(config.win.signExecutable,true);assert.equal(config.win.target[0].target,'nsis');assert.equal(config.nsis.deleteAppDataOnUninstall,false);assert.equal(config.artifactName,'Blackice-${version}-Setup.${ext}');assert.equal(config.nsis.shortcutName,'BLACKICE');assert.throws(()=>publicBuilderConfiguration({configured:false},{source:'.',output:'.',requireCodeSigning:true}),/explicit publisher/);
});

test('publisher verification requires Windows trust, the exact publisher and a valid result',async()=>{
  const run=value=>verifyPublisherSignature('C:/fixture/Setup.exe','Provided Publisher',{platform:'win32',execute:async()=>({stdout:JSON.stringify(value)})});
  assert.equal((await run({valid:true,status:'Valid',publisher:'Provided Publisher',productVersion:'9.8.7'})).valid,true);assert.equal((await run({valid:true,status:'Valid',publisher:'Other Publisher'})).valid,false);assert.equal((await run({valid:true,status:'HashMismatch',publisher:'Provided Publisher'})).valid,false);
  assert.equal((await verifyPublisherSignature('ignored','Provided Publisher',{platform:'linux'})).valid,false);assert.equal((await verifyPublisherSignature('ignored','',{platform:'win32'})).status,'MissingPublisher');
});

test('receipt templates are deliberately incomplete and cannot accidentally pass a release gate',()=>{const value=ready();value.receipts=receiptTemplate(value.version,value.fingerprint);assert.equal(evaluateRelease(value).passed,false);});

test('release collection verifies installer bytes before trusting any supplied signature receipt',async t=>{
  const directory=await fs.mkdtemp(path.join(tmpdir(),'relay-release-check-'));t.after(async()=>{assert.match(path.basename(directory),/^relay-release-check-/);await fs.rm(directory,{recursive:true,force:true});});
  for(const name of ['lib','public','desktop'])await fs.mkdir(path.join(directory,name));
  await fs.writeFile(path.join(directory,'package.json'),JSON.stringify({name:'relay-agent-harness',version:'9.8.7'}));
  for(const name of ['server.mjs','desktop/main.mjs','desktop/maintenance-helper.mjs','desktop/preload.cjs','desktop/browser-driver.mjs','desktop/browser-capture.mjs','desktop/browser-router.mjs','desktop/firefox-driver.mjs','desktop/firefox-lazy.mjs','desktop/icon.ico'])await fs.writeFile(path.join(directory,name),'disposable fixture');
  const fingerprint=await appFingerprint(directory),distribution=path.join(directory,'candidate');await fs.mkdir(distribution);const file=path.join(distribution,'Blackice-9.8.7-Setup.exe'),bytes=Buffer.from('disposable unsigned fixture, never executed');await fs.writeFile(file,bytes);
  const manifest={format:1,product:'BLACKICE',version:'9.8.7',appFingerprint:fingerprint,publisher:'Disposable Test Publisher',signing:{status:'signed',publisher:'Disposable Test Publisher',publisherVerified:true},artifact:{name:path.basename(file),size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}};await fs.writeFile(path.join(distribution,'blackice-public-release.json'),JSON.stringify(manifest));
  const receipts=ready().receipts;receipts.appFingerprint=fingerprint;receipts.artifactSha256=createHash('sha256').update(bytes).digest('hex');const receiptsFile=path.join(directory,'receipts.json');await fs.writeFile(receiptsFile,JSON.stringify(receipts));let verifications=0;
  const options={directory,distribution,receiptsFile,environment:{RELAY_SIGNING_PUBLISHER:'Disposable Test Publisher',WIN_CSC_LINK:'fixture'},verifySignature:async()=>{verifications++;return ready().signature;}};
  assert.equal((await collectReleaseReport(options)).publicReleaseReady,true);assert.equal(verifications,1);
  await fs.writeFile(path.join(distribution,'blackice-public-release.json'),JSON.stringify({...manifest,publisher:null,signing:{status:'unsigned',publisher:null,publisherVerified:false},releasePolicy:{requireCodeSigning:false}}));const unsigned=await collectReleaseReport({...options,environment:{}});assert.equal(unsigned.publicReleaseReady,true);assert.equal(unsigned.classification,'ready-for-public-release-unsigned');assert.equal(unsigned.signing.publisher,null);assert.equal(unsigned.signing.publisherVerified,false);assert.equal(verifications,1,'an explicitly unsigned build does not pretend to verify a publisher');
  const mandatory=await collectReleaseReport({...options,environment:{},requireCodeSigning:true});assert.equal(mandatory.publicReleaseReady,false);assert.equal(mandatory.releasePolicy.requireCodeSigning,true);assert.equal(verifications,2);
  await fs.appendFile(file,'tampered');const changed=await collectReleaseReport(options);assert.equal(changed.publicReleaseReady,false);assert.equal(verifications,2,'a tampered artifact must fail before publisher verification');assert.match(changed.gates.find(gate=>gate.id==='artifact-integrity').detail,/checksum|size/);
  const packageFile=path.join(directory,'package.json');await fs.writeFile(packageFile,JSON.stringify({name:'relay-agent-harness',version:'9.8.7',scripts:{build:'development only'},devDependencies:{electron:'44.7.2'}}));assert.equal(await appFingerprint(directory),fingerprint,'builder-stripped metadata must not make the packaged app differ from source');
  await fs.writeFile(path.join(directory,'lib/example.mjs.currents-backup-1234-fixture'),'historical recovery bytes');assert.equal(await appFingerprint(directory),fingerprint,'excluded connector backups must not enter runtime evidence');
  await fs.mkdir(path.join(directory,'scripts'));await fs.writeFile(path.join(directory,'scripts/chatgpt-bridge.mjs'),'current bridge entry point');const withBridge=await appFingerprint(directory);assert.notEqual(withBridge,fingerprint,'the packaged connector CLI must enter runtime evidence');await fs.appendFile(path.join(directory,'scripts/chatgpt-bridge.mjs'),' changed');assert.notEqual(await appFingerprint(directory),withBridge,'connector CLI changes must invalidate old receipts');
  await fs.writeFile(path.join(directory,'lib/changed.mjs'),'runtime change');assert.notEqual(await appFingerprint(directory),fingerprint);
});

test('unsigned public releases need no signing service and expose signature gates as truthful information',()=>{
  const value=ready();value.artifact.kind='unsigned-installer';value.signature=null;value.signing={configured:false,requested:false,publisher:'',missing:['No identity supplied'],errors:[]};const report=evaluateRelease(value);assert.equal(report.passed,true);assert.equal(report.publicReleaseReady,true);assert.equal(report.classification,'ready-for-public-release-unsigned');assert.equal(report.signing.status,'unsigned');assert.equal(report.signing.publisher,null);assert.equal(report.signing.publisherVerified,false);assert.equal(report.releasePolicy.requireCodeSigning,false);assert.ok(report.gates.filter(gate=>['signing-inputs','publisher-signature'].includes(gate.id)).every(gate=>!gate.required&&gate.status==='informational'));
  value.requireCodeSigning=true;assert.equal(evaluateRelease(value).publicReleaseReady,false);delete value.requireCodeSigning;value.signing.requested=true;assert.equal(evaluateRelease(value).publicReleaseReady,false,'explicit but incomplete signing inputs cannot silently fall back to unsigned');
});

test('the normal unsigned installer configuration is schema-valid while partial signing inputs fail',async()=>{
  const {validateConfiguration}=await import('../node_modules/app-builder-lib/out/util/config/config.js'),signing=await publicSigningConfiguration({});assert.equal(signing.requested,false);
  const config=publicBuilderConfiguration(signing,{source:path.resolve('.'),output:path.resolve('.build/disposable-unsigned-schema-check')});await validateConfiguration(config,{isEnabled:false});assert.equal(config.forceCodeSigning,false);assert.equal(config.win.signExecutable,false);assert.equal(config.win.signAndEditExecutable,true);assert.equal(config.win.signtoolOptions,undefined);assert.equal(config.win.target[0].target,'nsis');
  for(const environment of [{RELAY_SIGNING_PUBLISHER:'Provided Publisher'},{WIN_CSC_LINK:'fixture'},{RELAY_SIGNING_CERT_SHA1:'invalid'},{CSC_KEY_PASSWORD:'SECRET_PASSWORD'}]){const incomplete=await publicSigningConfiguration(environment);assert.equal(incomplete.requested,true);assert.throws(()=>publicBuilderConfiguration(incomplete,{source:'.',output:'.'}),/incomplete or invalid/);}
});
