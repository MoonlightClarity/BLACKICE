import test from 'node:test';
import assert from 'node:assert/strict';
import {P,assets,verifySnapshot,verifyBytes,verifyEvidence,verifyContext} from './publish-2.39.94.mjs';
import {readFile} from 'node:fs/promises';
const stepNames=['Bind the explicit request to this exact source and its Windows tests','Build the locked Windows candidate','Verify candidate bytes and write exact checksums','Bind the actual source tag after candidate verification','Upload a new draft with its exact source target','Verify this installer on the fresh Windows runner','Attach the bounded installer evidence to the same draft'];
const snapshot=()=>[{id:P.release,draft:true,prerelease:false,tag_name:P.tag,target_commitish:P.commit},assets.map(([name,id,size,digest])=>({name,id,size,digest:'sha256:'+digest,state:'uploaded'})),{id:P.run,head_sha:P.commit,head_branch:'main',path:'.github/workflows/publish-windows-release.yml',status:'completed',conclusion:'success',run_attempt:1},[{name:'release',status:'completed',conclusion:'success',steps:[...stepNames.map(name=>({name,status:'completed',conclusion:'success'})),{name:'Publish only the verified requested release',conclusion:'skipped'}]}],{ref:'refs/tags/'+P.tag,object:{type:'commit',sha:P.commit}}];
test('publication trigger and event context are narrowly scoped',async()=>{
 const workflow=await readFile(new URL('../workflows/publish-2.39.94-verified-draft.yml',import.meta.url),'utf8');
 const on=workflow.split('\npermissions:')[0];
 assert.match(on,/  workflow_dispatch:\s*\n  push:\s*\n    branches: \[main\]\s*\n    paths:/);
 assert.deepEqual([...on.matchAll(/^      - (.+)$/gm)].map(m=>m[1]),['.github/workflows/publish-2.39.94-verified-draft.yml','.github/publication/publish-2.39.94.mjs','.github/publication/publish-2.39.94.test.mjs']);
 const base={GITHUB_REPOSITORY:P.repo,GITHUB_REF:'refs/heads/main',GH_TOKEN:'test'};
 for(const event of ['push','workflow_dispatch']) assert.doesNotThrow(()=>verifyContext({...base,GITHUB_EVENT_NAME:event}));
 for(const change of [{GITHUB_EVENT_NAME:'pull_request'},{GITHUB_EVENT_NAME:'schedule'},{GITHUB_REF:'refs/heads/other'},{GITHUB_REPOSITORY:'other/repo'},{GH_TOKEN:''}]) assert.throws(()=>verifyContext({...base,GITHUB_EVENT_NAME:'push',...change}));
});
test('exact observed metadata accepted; changed draft, assets, run and tag rejected',()=>{
 verifySnapshot(...snapshot());
 for(const mutate of [x=>x[0].draft=false,x=>x[0].id++,x=>x[0].target_commitish='bad',x=>x[1][0].id++,x=>x[1][0].digest='sha256:bad',x=>x[1].pop(),x=>x[1].push(x[1][0]),x=>x[2].head_sha='bad',x=>x[2].conclusion='failure',x=>x[3][0].steps[3].conclusion='failure',x=>x[4].object.sha='bad']){const x=structuredClone(snapshot());mutate(x);assert.throws(()=>verifySnapshot(...x));}
 assert.throws(()=>verifyBytes(assets[0][0],Buffer.from('wrong')));
});
test('bounded evidence requires successful receipts and exact source/run bindings',async()=>{
 const source=await readFile(new URL('../../verification/windows-2.39.94.json',import.meta.url));
 const run={sourceCommit:P.commit,githubRunId:String(P.run),githubRunAttempt:'1'};
 const bind={releaseId:P.release,tag:P.tag,tagCommit:P.commit,sourceCommit:P.commit,workflowCommit:P.commit,githubRunId:String(P.run),githubRunAttempt:'1',draftAtDownload:true,appFingerprint:P.fingerprint,artifactSha256:P.installer,sourceIndexSha256:P.index};
 const prior={...run,receiptSha256:P.receipt,appFingerprint:P.fingerprint,sourceIndexSha256:P.index,rerunInThisWorkflow:false};
 const integ={...run,passed:true,sourceFingerprint:P.fingerprint,installedFingerprint:P.fingerprint,filesVerified:2,privateFileScan:{rejectedFiles:0}};
 const install={...run,passed:true,failures:[],artifact:{sha256:P.installer},cleanup:{passed:true,forcedTerminationUsed:false}};
 const native={...run,passed:true,failures:[],startup:{passed:true},restart:{passed:true},window:{passed:true},shutdown:{passed:true,forcedTerminationUsed:false,nativeQuitVerified:true,ownedProcessesExited:true},profileBackup:{passed:true},diagnostics:{passed:true}};
 const receipt={...run,format:1,product:'BLACKICE',version:'2.39.94',appFingerprint:P.fingerprint,artifactSha256:P.installer,tests:{failed:0,requiredSkipped:0},installIntegrity:{passed:true,sourceInstalledMatch:true,publicInstallerTested:true},profileBackup:{restoreVerified:true},diagnostics:{credentialLeakScanPassed:true}};
 const ready={passed:true,publicReleaseReady:true,version:'2.39.94',appFingerprint:P.fingerprint,gates:['evidence-bound-to-build','evidence-bound-to-installer','required-tests','installed-integrity','profile-backup-and-restore','diagnostics-redaction','artifact-integrity'].map(id=>({id,required:true,status:'passed'}))};
 const manifest={version:'2.39.94',appFingerprint:P.fingerprint,artifact:{name:assets[0][0],size:assets[0][2],sha256:P.installer}};
 const data={'blackice-github-validation.json':bind,'blackice-source-test-provenance.json':prior,'blackice-runtime-integrity.json':integ,'blackice-windows-install-validation.json':install,'blackice-runtime-validation.json':native,'blackice-release-receipts.json':receipt,'blackice-public-readiness.json':ready,'blackice-public-release.json':manifest};
 const build=()=>new Map([...Object.entries(data).map(([k,v])=>[k,Buffer.from(JSON.stringify(v))]),['SHA256SUMS.txt',Buffer.from(P.installer+'  '+assets[0][0]+'\n'+assets[3][3]+'  blackice-public-release.json\n')]]);
 verifyEvidence(build(),source);
 for(const name of Object.keys(data)){const m=build();const v=JSON.parse(m.get(name));if(name==='blackice-public-readiness.json')v.gates[0].status='failed';else if(name==='blackice-github-validation.json')v.releaseId++;else if(name==='blackice-windows-install-validation.json')v.passed=false;else if(name==='blackice-public-release.json')v.artifact.sha256='bad';else v.sourceCommit='bad';m.set(name,Buffer.from(JSON.stringify(v)));assert.throws(()=>verifyEvidence(m,source),name);}
 assert.throws(()=>verifyEvidence(build(),Buffer.from('wrong')));
});
