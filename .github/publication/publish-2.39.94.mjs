import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const P = Object.freeze({repo:'MoonlightClarity/BLACKICE', release:445658473, tag:'v2.39.94', commit:'770f377bbf5248e7719af69ec5c727f96e4d012c', run:43651430703, attempt:1, fingerprint:'d2a1919540a97801cf544ab501e3806ef83b1de76bcc712554e23a3ba589969d', index:'9d3e4098bb108fa1fe7acc7bb3a37558872f4cd869c74bc30d2165b5c0395788', receipt:'2a3ef25edf9f5abb1399c54439751323d7e0c5c53b202c9dfc9220847c1680f6', installer:'2c863eba4f1b751f2978c375cca0a6255c8591bd1ba68c5eaf3eb6fcadaa6f19'});
export const assets = Object.freeze([
['Blackice-2.39.94-Setup.exe',749068020,115655978,P.installer],
['blackice-github-validation.json',749070266,770,'9bed4d1fc9e678b4d5d8eb41bcf73ef71bedb1d9f6a6ab3ee1e64451459ff066'],
['blackice-public-readiness.json',749070302,2359,'9df4f8ede1c36509015a94cede4667ad3f22a4d56a3f2c6cc09d845466ad740a'],
['blackice-public-release.json',749068023,564,'af150bf4ef6657317c9c1c67b5f1ede9f2414d7b8ed8ac8c25e400cf5e84033e'],
['blackice-release-receipts.json',749070303,2775,'8c5f24a3609d5ebbc3222bf8217deb81e7c8fb3ba59be64f75375ba4f83cde02'],
['blackice-runtime-integrity.json',749070262,3498,'2c72cf20029fea8e6e5f31628332220990dc676ed8dcffa7f6330dcc7e744fbd'],
['blackice-runtime-validation.json',749070258,3043,'88ec1566bbb1c63643621ed58a349a70d27d07c42eca0ca0d0e7215b232c5c02'],
['blackice-source-test-provenance.json',749070259,895,'76c6f252fc965f7867a8db10ee6d253cf145a8719a98ca5894d04178d0cb9acc'],
['blackice-windows-install-validation.json',749070265,3293,'7d959168b85eaa8096d2b6ab3353bef122ec43f251a82e19c7513889087efba2'],
['SHA256SUMS.txt',749068022,190,'3cfeb680832aa6bfee858a09f4005b6e66ea50190154fd7116d21630a25e08d6']]);
const check=(b,m)=>{if(!b)throw Error(m)};
export function verifySnapshot(release, listed, run, jobs, ref) {
  check(release.id===P.release && release.draft===true && release.prerelease===false && release.tag_name===P.tag && release.target_commitish===P.commit,'draft identity changed');
  check(run.id===P.run && run.head_sha===P.commit && run.head_branch==='main' && run.path==='.github/workflows/publish-windows-release.yml' && run.status==='completed' && run.conclusion==='success' && run.run_attempt===P.attempt,'build run mismatch');
  check(jobs.length===1 && jobs[0].name==='release' && jobs[0].status==='completed' && jobs[0].conclusion==='success','build job mismatch');
  for(const name of ['Bind the explicit request to this exact source and its Windows tests','Build the locked Windows candidate','Verify candidate bytes and write exact checksums','Bind the actual source tag after candidate verification','Upload a new draft with its exact source target','Verify this installer on the fresh Windows runner','Attach the bounded installer evidence to the same draft']) check(jobs[0].steps?.some(s=>s.name===name&&s.status==='completed'&&s.conclusion==='success'),'missing successful build step: '+name);
  check(jobs[0].steps?.some(s=>s.name==='Publish only the verified requested release' && s.conclusion==='skipped'),'publication step was not skipped');
  check(ref.ref==='refs/tags/'+P.tag && ref.object?.type==='commit' && ref.object.sha===P.commit,'tag mismatch');
  check(Array.isArray(listed)&&listed.length===assets.length,'asset inventory mismatch');
  for(const [name,id,size,digest] of assets){const matches=listed.filter(a=>a.name===name);check(matches.length===1&&matches[0].id===id&&matches[0].size===size&&matches[0].digest==='sha256:'+digest&&matches[0].state==='uploaded','asset mismatch: '+name);}
}
export function verifyBytes(name, bytes){const item=assets.find(a=>a[0]===name);check(item && bytes.length===item[2] && createHash('sha256').update(bytes).digest('hex')===item[3],'download mismatch: '+name);}
export function verifyEvidence(values,sourceReceipt) {
  const j=n=>JSON.parse(values.get(n).toString('utf8'));
  const bind=j('blackice-github-validation.json'), prior=j('blackice-source-test-provenance.json'), integ=j('blackice-runtime-integrity.json'), install=j('blackice-windows-install-validation.json'), native=j('blackice-runtime-validation.json'), receipt=j('blackice-release-receipts.json'), ready=j('blackice-public-readiness.json'), manifest=j('blackice-public-release.json');
  check(bind.releaseId===P.release&&bind.tag===P.tag&&bind.tagCommit===P.commit&&bind.sourceCommit===P.commit&&bind.workflowCommit===P.commit&&String(bind.githubRunId)===String(P.run)&&String(bind.githubRunAttempt)==='1'&&bind.draftAtDownload===true&&bind.appFingerprint===P.fingerprint&&bind.artifactSha256===P.installer&&bind.sourceIndexSha256===P.index,'binding receipt mismatch');
  for(const x of [prior,integ,install,native,receipt]) check(x.sourceCommit===P.commit&&String(x.githubRunId)===String(P.run)&&String(x.githubRunAttempt)==='1','evidence run mismatch');
  check(prior.receiptSha256===P.receipt&&prior.appFingerprint===P.fingerprint&&prior.sourceIndexSha256===P.index&&prior.rerunInThisWorkflow===false,'source evidence mismatch');
  check(createHash('sha256').update(sourceReceipt).digest('hex')===P.receipt,'source receipt bytes mismatch');
  check(integ.passed===true&&integ.sourceFingerprint===P.fingerprint&&integ.installedFingerprint===P.fingerprint&&integ.filesVerified>0&&integ.privateFileScan?.rejectedFiles===0,'installed integrity mismatch');
  check(install.passed===true&&Array.isArray(install.failures)&&install.failures.length===0&&install.artifact?.sha256===P.installer&&install.cleanup?.passed===true&&install.cleanup?.forcedTerminationUsed===false,'installer evidence mismatch');
  check(native.passed===true&&Array.isArray(native.failures)&&native.failures.length===0&&['startup','restart','window','shutdown','profileBackup','diagnostics'].every(n=>native[n]?.passed===true)&&native.shutdown.forcedTerminationUsed===false&&native.shutdown.nativeQuitVerified===true&&native.shutdown.ownedProcessesExited===true,'runtime evidence mismatch');
  check(receipt.format===1&&receipt.product==='BLACKICE'&&receipt.version==='2.39.94'&&receipt.appFingerprint===P.fingerprint&&receipt.artifactSha256===P.installer&&receipt.tests?.failed===0&&receipt.tests?.requiredSkipped===0&&receipt.installIntegrity?.passed===true&&receipt.installIntegrity?.sourceInstalledMatch===true&&receipt.installIntegrity?.publicInstallerTested===true&&receipt.profileBackup?.restoreVerified===true&&receipt.diagnostics?.credentialLeakScanPassed===true,'release receipts mismatch');
  const required=['evidence-bound-to-build','evidence-bound-to-installer','required-tests','installed-integrity','profile-backup-and-restore','diagnostics-redaction','artifact-integrity'];
  check(ready.passed===true&&ready.publicReleaseReady===true&&ready.version==='2.39.94'&&ready.appFingerprint===P.fingerprint&&Array.isArray(ready.gates)&&required.every(id=>ready.gates.filter(g=>g.id===id&&g.required===true&&g.status==='passed').length===1)&&ready.gates.every(g=>!g.required||g.status==='passed'),'readiness mismatch');
  check(manifest.version==='2.39.94'&&manifest.appFingerprint===P.fingerprint&&manifest.artifact?.name===assets[0][0]&&manifest.artifact?.size===assets[0][2]&&manifest.artifact?.sha256===P.installer,'manifest mismatch');
  const sums=values.get('SHA256SUMS.txt').toString('utf8').split(/\r?\n/);check(sums.includes(P.installer+'  '+assets[0][0])&&sums.includes(assets[3][3]+'  blackice-public-release.json'),'checksum mismatch');
}
async function main(){
  check(process.env.GITHUB_REPOSITORY===P.repo&&process.env.GITHUB_REF==='refs/heads/main'&&process.env.GITHUB_EVENT_NAME==='workflow_dispatch'&&process.env.GH_TOKEN,'workflow context mismatch');
  const source=path.resolve(process.argv[2]||'');const {verifyReleaseSource}=await import(pathToFileURL(path.join(source,'scripts/release-request.mjs')));const request=JSON.parse(await readFile(path.join(source,'.github/release-request.json'),'utf8'));check(request.publish===false,'source request changed');const verified=await verifyReleaseSource({...request,sourceCommit:P.commit},source);check(verified.appFingerprint===P.fingerprint&&verified.sourceIndexSha256===P.index&&verified.receiptSha256===P.receipt,'source verification mismatch');
  const base='https://api.github.com/repos/'+P.repo, headers={Authorization:'Bearer '+process.env.GH_TOKEN,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'BLACKICE-publication-verifier'};
  async function api(endpoint,options={}){const r=await fetch(base+endpoint,{...options,headers:{...headers,...options.headers},redirect:'error'});check(r.ok,'GitHub API failed '+endpoint+' '+r.status);return r.json();}
  async function snapshot(){const [release,listed,run,jobs,ref]=await Promise.all([api('/releases/'+P.release),api('/releases/'+P.release+'/assets?per_page=100'),api('/actions/runs/'+P.run),api('/actions/runs/'+P.run+'/attempts/1/jobs?per_page=100'),api('/git/ref/tags/'+P.tag)]);verifySnapshot(release,listed,run,jobs.jobs,ref);}
  await snapshot();const values=new Map();for(const [name,id] of assets){const r=await fetch(base+'/releases/assets/'+id,{headers:{...headers,Accept:'application/octet-stream'}});check(r.ok,'asset download failed: '+name);const bytes=Buffer.from(await r.arrayBuffer());verifyBytes(name,bytes);values.set(name,bytes);}
  verifyEvidence(values,await readFile(path.join(source,'verification/windows-2.39.94.json')));
  await snapshot();const result=await api('/releases/'+P.release,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({draft:false})});check(result.id===P.release&&result.draft===false&&result.tag_name===P.tag&&result.target_commitish===P.commit,'publication response mismatch; inspect before retry');console.log('Published verified existing release '+P.release);
}
if(process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) await main();
