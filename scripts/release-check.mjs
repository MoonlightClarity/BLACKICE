import { promises as fs, createReadStream } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { publicSigningConfiguration, verifyPublisherSignature } from './release-signing.mjs';
import { verifyDistribution, desktopRuntimeModules } from './distribution-manifest.mjs';

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hashFile = async file => { const digest = createHash('sha256'); for await (const chunk of createReadStream(file)) digest.update(chunk); return digest.digest('hex'); };
export async function appFingerprint(directory = source) {
  const records = [];
  async function visit(relative) {
    // Connector edit backups are recovery artifacts, never executable inputs.
    // Match the installer exclusion while leaving those source backups intact.
    if (path.basename(relative).includes('.currents-backup-')) return;
    const file = path.join(directory, relative), info = await fs.lstat(file);
    if (info.isSymbolicLink()) throw Error('Application inputs cannot contain links.');
    if (info.isDirectory()) { for (const entry of (await fs.readdir(file)).sort()) await visit(path.posix.join(relative, entry)); }
    else if (info.isFile() && !relative.endsWith('.test.mjs')) {
      if (relative === 'package.json') {
        const metadata=JSON.parse(await fs.readFile(file,'utf8'));
        // electron-builder removes development-only metadata from the packaged
        // main package. Normalize precisely those fields on both sides.
        const removed=new Set(['dist','gitHead','build','jspm','ava','xo','nyc','eslintConfig','contributors','bundleDependencies','tags','scripts','devDependencies','keywords']);
        for(const key of Object.keys(metadata))if(key.startsWith('_')||removed.has(key)||key==='babel'&&metadata.dependencies&&!Object.keys(metadata.dependencies).some(name=>name.startsWith('babel')))delete metadata[key];
        const canonical=JSON.stringify(Object.fromEntries(Object.entries(metadata).sort(([a],[b])=>a.localeCompare(b,'en'))));
        records.push({path:relative,size:Buffer.byteLength(canonical),sha256:createHash('sha256').update(canonical).digest('hex')});
      } else records.push({ path: relative, size: info.size, sha256: await hashFile(file) });
    }
  }
  for (const relative of ['package.json', 'server.mjs', 'lib', 'public', 'desktop/icon.ico']) await visit(relative);
  // Match the packaged desktop code inventory, including future runtime helpers.
  // Adding, changing, or omitting a module must invalidate prior build evidence.
  for (const relative of await desktopRuntimeModules(directory)) await visit(relative);
  try { await fs.lstat(path.join(directory, 'scripts/remote-access-cli.mjs')); await visit('scripts/remote-access-cli.mjs'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  // Older builds predate the connector CLI; include it whenever present so a
  // candidate cannot silently omit or change the installed bridge entry point.
  try { await fs.lstat(path.join(directory,'scripts/chatgpt-bridge.mjs')); await visit('scripts/chatgpt-bridge.mjs'); } catch(error) { if(error.code!=='ENOENT')throw error; }
  // Managed mail invokes this installed helper through Electron's Node mode.
  // Older inspected releases do not contain it; whenever present it is bound.
  try { await fs.lstat(path.join(directory, 'scripts/email-oauth-token.mjs')); await visit('scripts/email-oauth-token.mjs'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  records.sort((a,b)=>a.path.localeCompare(b.path, 'en'));
  return createHash('sha256').update(JSON.stringify(records)).digest('hex');
}

export function evaluateRelease({ version, fingerprint, receipts, artifact, signing, signature, mode = 'public', requireCodeSigning = false, at = new Date().toISOString() }) {
  const gates = [], required = mode === 'public', add = (id, passed, detail, mandatory = true) => gates.push({ id, required: mandatory, status: passed ? 'passed' : 'failed', detail });
  const signingPolicyRequired = requireCodeSigning || artifact?.requireCodeSigning === true;
  const signatureRequired = required && (signingPolicyRequired || signing?.configured === true || signing?.requested === true || artifact?.kind === 'signed-installer');
  const bound = receipts?.format === 1 && receipts.product === 'BLACKICE' && receipts.version === version && receipts.appFingerprint === fingerprint;
  add('evidence-bound-to-build', bound, bound ? 'Receipts identify this exact application build.' : 'Supply BLACKICE format-1 receipts with the current version and application fingerprint.');
  add('evidence-bound-to-installer', !required || /^[a-f\d]{64}$/.test(receipts?.artifactSha256 || '') && receipts.artifactSha256 === artifact?.sha256, 'Public installation evidence must identify this exact Setup.exe by SHA-256.', required);
  const tests = receipts?.tests || {}, testCounts = ['total','passed','failed','requiredSkipped','optionalSkipped'].every(key => Number.isSafeInteger(tests[key]) && tests[key] >= 0);
  add('required-tests', bound && testCounts && tests.passed > 0 && tests.failed === 0 && tests.requiredSkipped === 0 && tests.total === tests.passed + tests.failed + tests.requiredSkipped + tests.optionalSkipped, 'All required checks must pass; skipped optional integrations must be counted separately.');
  const install = receipts?.installIntegrity;
  add('installed-integrity', bound && install?.passed === true && install.sourceInstalledMatch === true && install.shortcutVerified === true && Number.isSafeInteger(install.filesVerified) && install.filesVerified > 0 && (!required || install.publicInstallerTested === true), required ? 'Verify the actual public installer, installed runtime hashes, and Desktop shortcut.' : 'Verify installed runtime hashes and the Desktop shortcut.');
  const backup = receipts?.profileBackup;
  add('profile-backup-and-restore', bound && backup?.passed === true && backup.verified === true && backup.restoreVerified === true, 'A profile backup must pass integrity verification and a disposable restore test.');
  const diagnostics = receipts?.diagnostics;
  add('diagnostics-redaction', bound && diagnostics?.passed === true && diagnostics.redactionVerified === true && diagnostics.credentialLeakScanPassed === true, 'A diagnostics export must pass redaction and credential-leak checks.');
  add('artifact-integrity', artifact?.verified === true && artifact.version === version && artifact.appFingerprint === fingerprint && (!required || ['signed-installer','unsigned-installer'].includes(artifact.kind)), artifact?.error || (required ? 'The public candidate must be the verified complete Setup.exe.' : 'The local distribution must match its hashes and version.'));
  add('signing-inputs', signing?.configured === true, signing?.configured ? 'An explicit publisher and signing method are configured.' : signatureRequired ? [...(signing?.missing || ['Signing configuration missing.']), ...(signing?.errors || [])].join(' ') : 'Signing is optional. No publisher identity or signing service is required for this unsigned release.', signatureRequired);
  const publisherVerified = signature?.valid === true && signature.publisher === signing?.publisher && new RegExp(`^${String(version).replaceAll('.', '\\.')}(?:\\.0)?(?:\\+[^\\s]+)?$`).test(signature.productVersion || '');
  add('publisher-signature', publisherVerified, publisherVerified ? 'Windows trust and the configured publisher were verified.' : signatureRequired ? signature?.error || `Publisher verification failed: ${signature?.status || 'no signed installer supplied'}.` : 'Unsigned installer. Windows has not verified an BLACKICE publisher identity.', signatureRequired);
  for (const gate of gates) if (!gate.required && ['signing-inputs','publisher-signature'].includes(gate.id) && gate.status !== 'passed') gate.status = 'informational';
  const passed = gates.filter(gate => gate.required).every(gate => gate.status === 'passed');
  return { format: 1, product: 'BLACKICE', version, appFingerprint: fingerprint, checkedAt: at, mode, passed, publicReleaseReady: required && passed, classification: required ? passed ? publisherVerified ? 'ready-for-public-release' : 'ready-for-public-release-unsigned' : 'public-release-blocked' : passed ? 'local-verification-passed' : 'local-verification-incomplete', published: false, releasePolicy:{requireCodeSigning:signingPolicyRequired}, signing: { status:publisherVerified?'signed':artifact?.kind==='unsigned-installer'?'unsigned':'unverified', publisherVerified, configured: signing?.configured === true, publisher: signing?.publisher || null, method: signing?.method || null, missing: signatureRequired ? signing?.missing || [] : [], errors: signing?.errors || [] }, gates };
}

export async function collectReleaseReport({ directory = source, distribution, receiptsFile, mode = 'public', requireCodeSigning = false, environment = process.env, verifySignature = verifyPublisherSignature } = {}) {
  const version = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8')).version, fingerprint = await appFingerprint(directory), signing = await publicSigningConfiguration(environment);
  let receipts = null, artifact = { verified: false, error: 'Supply a distribution folder.' }, signature = null;
  try { if (receiptsFile) receipts = JSON.parse(await fs.readFile(receiptsFile, 'utf8')); } catch { /* A missing or invalid receipt becomes a failed gate. */ }
  if (distribution) try {
    if (mode === 'local') { const manifest = await verifyDistribution(distribution); artifact = { verified: true, kind: 'local-distribution', version: manifest.version, appFingerprint: await appFingerprint(path.join(distribution, 'resources/app')) }; }
    else {
      const manifest = JSON.parse(await fs.readFile(path.join(distribution, 'blackice-public-release.json'), 'utf8'));
      if (manifest.format !== 1 || manifest.product !== 'BLACKICE' || manifest.version !== version || !/^Blackice-\d+\.\d+\.\d+-Setup\.exe$/.test(manifest.artifact?.name || '') || manifest.artifact.name !== `Blackice-${version}-Setup.exe` || !/^[a-f\d]{64}$/.test(manifest.artifact?.sha256 || '') || !Number.isSafeInteger(manifest.artifact?.size) || manifest.artifact.size <= 0) throw Error('The public installer manifest must identify this exact release version and artifact.');
      if (manifest.releasePolicy !== undefined && (!manifest.releasePolicy || typeof manifest.releasePolicy !== 'object' || Array.isArray(manifest.releasePolicy) || typeof manifest.releasePolicy.requireCodeSigning !== 'boolean' || Object.keys(manifest.releasePolicy).some(key => key !== 'requireCodeSigning'))) throw Error('The installer signing policy must explicitly set requireCodeSigning to true or false.');
      if (!['signed','unsigned'].includes(manifest.signing?.status) || manifest.signing.status==='unsigned' && (manifest.publisher!==null || manifest.signing.publisher!==null || manifest.signing.publisherVerified!==false) || manifest.signing.status==='signed' && (!manifest.publisher || manifest.signing.publisher!==manifest.publisher || manifest.signing.publisherVerified!==true)) throw Error('The installer manifest must accurately declare signed or unsigned publisher status.');
      if (manifest.signing.status === 'signed' && manifest.publisher !== signing.publisher) throw Error('The signed installer manifest publisher does not match the configured publisher to verify.');
      const file = path.join(distribution, manifest.artifact.name), info = await fs.lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.size !== manifest.artifact.size || await hashFile(file) !== manifest.artifact.sha256) throw Error('The public installer failed its size or checksum verification.');
      artifact = { verified: true, kind: `${manifest.signing.status}-installer`, version: manifest.version, appFingerprint: manifest.appFingerprint, sha256:manifest.artifact.sha256, requireCodeSigning:manifest.releasePolicy?.requireCodeSigning===true };
      if (requireCodeSigning || artifact.requireCodeSigning || manifest.signing.status==='signed' || signing.requested) signature = await verifySignature(file, signing.publisher);
    }
  } catch (error) { artifact = { verified: false, error: error.message }; }
  return evaluateRelease({ version, fingerprint, receipts, artifact, signing, signature, mode, requireCodeSigning });
}

export function receiptTemplate(version, fingerprint) {
  return { format: 1, product: 'BLACKICE', version, appFingerprint: fingerprint, artifactSha256:null, tests: { total: null, passed: null, failed: null, requiredSkipped: null, optionalSkipped: null }, installIntegrity: { passed: false, filesVerified: null, sourceInstalledMatch: false, shortcutVerified: false, publicInstallerTested: false }, profileBackup: { passed: false, verified: false, restoreVerified: false }, diagnostics: { passed: false, redactionVerified: false, credentialLeakScanPassed: false } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), value = name => { const index=args.indexOf(name); return index < 0 ? undefined : args[index+1]; };
  if (args.includes('--template') || args.includes('--fingerprint')) { const version = JSON.parse(await fs.readFile(path.join(source,'package.json'),'utf8')).version, fingerprint = await appFingerprint(source); console.log(JSON.stringify(args.includes('--template') ? receiptTemplate(version,fingerprint) : {version,appFingerprint:fingerprint},null,2)); }
  else {
    const mode = args.includes('--local') ? 'local' : 'public';
    const report = await collectReleaseReport({ distribution: value('--distribution'), receiptsFile: value('--receipts'), mode, requireCodeSigning:args.includes('--require-signing') });
    const reportPath = value('--report'); if (reportPath) { await fs.mkdir(path.dirname(path.resolve(reportPath)), {recursive:true}); await fs.writeFile(reportPath,JSON.stringify(report,null,2)+'\n'); }
    console.log(JSON.stringify(report,null,2)); if (!report.passed) process.exitCode=1;
  }
}
