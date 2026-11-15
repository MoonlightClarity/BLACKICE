"""Attest saved BLACKICE 2.39.98 CI artifacts; never run app/tests or rewrite originals."""
import argparse, datetime, hashlib, json, re, zipfile
from pathlib import Path
S='0101d3f88cc7f3f139394a1c943b899511668a90'
C='1f9dff646eadd69730efe4209f0b78661866e58a'
B='b40e71d61d8da7b20a4c62fc41c6e1a91270a581'
I='59be2d3516059b1660e561a9a6351835bce68db88b1f7f3e731cd30c3271f61a'
F='9a7287d06dcbc1bbb0cf23cdf26d3d0d0c61839993c91ed6fb868556d3c205c6'
T='2a3a2c35408b010b8c2c924bef9abf0209ec68d52b254f4b8e195e243726b7d5'
Z={'full':('7287d8fcb66386b30edebbff0b75a3b80f9d16944f34a878d3360b73f6ecb83d',764810),'build':('dafdcf3853db7419880c4bffb1e62a017454a3547c2a102ca6012bb17c4d5ffa',179090),'installer':('d5bd5756a7c1d7fe55102ccf6757b6bb8c8fb8c8b96336607b11f6d7dee6b48a',115652656)}
SHA_TAP='63e27a8d2642d845d623a24a64f486540e33955e7b07a4bbc60eb67343eaca4f'
SHA_RECEIPT='8386944de024ca24bd4782c08815b2caa68ff55a229c0d591d65b9ef818965b7'
SHA_TERMINAL='2ee5d18ecebd398c9ec658e62c2aa123a2bae520ef201c96e26b4a8cd28cf757'
SHA_BUILD_TAP='bd23a2c803ddc7bbd07194341725e7369525e4deab3f3342f791c5a469f8b481'
SHA_BUILD_TERMINAL='8bc468a71ab7d47137f180e5a9b8152327ee988bbe32c29651bb97135663e4e2'
SHA_MANIFEST='77fb948f6abdee137c6a9e0fe0ad39e28b8404c28a6ba0265ba34652c73b73fe'
SHA_INSTALLER='32e7e56cd32a755f5edb1395892c806b2761e408e84c8cb5ebcede24ce147ce8'
SIZE_INSTALLER=115669439

def h(x): return hashlib.sha256(x).hexdigest()
def j(x): return json.dumps(x,ensure_ascii=False,separators=(',',':')).encode()
def js(z,n): return json.loads(z.read(n))
def counts(text,prefix):
    out={}
    for k in ('tests','pass','fail','cancelled','skipped','todo'):
        m=re.findall('(?m)^'+re.escape(prefix)+' '+k+r' (\d+)\r?$',text)
        if len(m)!=1: raise AssertionError(f'Non-unique {prefix} reporter {k}: {m}')
        out[k]=int(m[0])
    return out

def main():
    p=argparse.ArgumentParser()
    for x in ('full','build','installer','upstream','out'):p.add_argument('--'+x,type=Path,required=True)
    a=p.parse_args(); ok={}
    def ck(n,v):
        ok[n]=bool(v)
        if not v:raise AssertionError('Evidence mismatch: '+n)
    for k in ('full','build','installer'):
        path=getattr(a,k);digest,length=Z[k]
        ck(k+' downloaded ZIP size',path.stat().st_size==length)
        ck(k+' downloaded ZIP SHA256',h(path.read_bytes())==digest)
    u=json.loads(a.upstream.read_text('utf-8'))
    r,b=u['originalRun'],u['buildRun']
    ck('original workflow terminal failure not overwritten',r['id']==43735536388 and r['conclusion']=='failure' and r['status']=='completed' and r['run_attempt']==1 and r['head_sha']==C)
    ck('original suite succeeded and independent controller failed',u['originalSteps'].get('Run ONE explicit Windows full source suite')=='success' and u['originalSteps'].get('Verify saved TAP reporter totals match parsed source receipt, skip identities and bytes')=='failure' and u['originalSteps'].get('Capture exact after inventory, fingerprints and terminal controller')=='failure')
    ck('original GitHub artifact identity',u['artifacts']['full']['id']==14170039144 and u['artifacts']['full']['name']=='blackice-23998-fullsuite-original-evidence' and u['artifacts']['full']['workflow_run']['id']==43735536388 and not u['artifacts']['full']['expired'])
    ck('existing build workflow terminal success',b['id']==43732981837 and b['conclusion']=='success' and b['status']=='completed' and b['run_attempt']==1 and b['head_sha']==B)
    ck('original build and inspection steps success',all(u['buildSteps'].get(n)=='success' for n in ('Verify 2.39.98 docs and release/package gates (not unchanged full suite)','Build NSIS x64 candidate with package source --publish never','Verify unsigned/signed manifest, installer SHA256, size and safe static package inspection')))
    ck('build artifact associations original',u['artifacts']['build']['id']==14169485417 and u['artifacts']['build']['workflow_run']['id']==43732981837 and u['artifacts']['installer']['id']==14169143495 and u['artifacts']['installer']['workflow_run']['id']==43732981837)
    ck('source branch and main unchanged',u['candidateBranchSha']==S and u['mainSha']=='2371578ed97960a235abbdd3dbdec14da91a4703')
    with zipfile.ZipFile(a.full) as z:
        names={'controller-environment.json','inventory.json','heartbeat.ndjson','source-after.json','source-before.json','temporary-environment.json','suite.tap','terminal-controller.json','windows-2.39.98.json'}
        ck('full evidence ZIP exact named contents and CRC',len(z.namelist())==len(names) and set(z.namelist())==names and z.testzip() is None)
        e,inv,pre,post,term,rec=[js(z,n) for n in ('controller-environment.json','inventory.json','source-before.json','source-after.json','terminal-controller.json','windows-2.39.98.json')]
        ck('original source receipt and terminal exact bytes',h(z.read('windows-2.39.98.json'))==SHA_RECEIPT and h(z.read('terminal-controller.json'))==SHA_TERMINAL)
        ck('original controller and actual source Git HEAD',rec['sourceCommitOrigin']=='git-rev-parse-HEAD' and rec['sourceCommit']==pre['sourceCommit']==post['actualCommit']==S and rec['workflowControllerCommit']==e['workflowControllerCommit']==C and e['actualSourceCommit']==S)
        ck('original platform environment and run',rec['platform']=='win32' and rec['node']==e['node']=='v24.22.2' and e['runnerOS']=='Windows' and e['runnerEnvironment']=='github-hosted' and str(e['workflowRunId'])=='43735536388')
        ck('actual before/after all indexed records identical',len(inv['records'])==len(pre['records'])==len(post['records'])==1676 and inv['records']==pre['records']==post['records'])
        ck('source inventory hash recomputed and unchanged',h(j(inv['records']))==inv['sourceIndexSha256']==pre['sourceIndexSha256']==post['sourceIndexSha256']==rec['sourceIndexSha256']==I)
        ck('runtime fingerprint before/after and pinned',inv['appFingerprint']==pre['appFingerprint']==post['appFingerprint']==rec['appFingerprint']==F)
        tf=inv['testFiles']
        ck('all 780 exact test paths and inventory SHA',len(tf)==len(set(tf))==780 and tf==sorted(x['path'] for x in inv['records'] if re.fullmatch(r'tests/[^/]+\.test\.mjs',x['path'])) and h(j(tf))==rec['testInventorySha256']==T)
        ck('original passing full-suite source receipt',rec['version']=='2.39.98' and rec['fullSuite'] is True and rec['passed'] is True and rec['countsComplete'] is True and rec['checkoutUnchanged'] is True and rec['sourceUnchanged'] is True and rec['fingerprintUnchanged'] is True and rec['execution']['uniqueCoverageVerified'] is True)
        tap=z.read('suite.tap');ct=counts(tap.decode('utf-8'),'#');rt=rec['tests']
        ck('original TAP hash matches original suite receipt',h(tap)==SHA_TAP==rec['testLogSha256'])
        ck('original TAP count 8776 of 8787 and 11 skipped',ct=={'tests':8787,'pass':8776,'fail':0,'cancelled':0,'skipped':11,'todo':0})
        ck('TAP reporter and source receipt exact agreement',ct=={'tests':rt['total'],'pass':rt['passed'],'fail':rt['failed'],'cancelled':rt['cancelled'],'skipped':rt['optionalSkipped']+rt['requiredSkipped'],'todo':rt['todo']})
        ck('all required tests and skip gate',rt['exitCode']==rt['failed']==rt['requiredSkipped']==rt['cancelled']==rt['todo']==0 and rec['unexpectedSkips']==[])
        skips=re.findall(r'(?m)^ok \d+ - (.*?) # SKIP(?: (.*))?\r?$',tap.decode('utf-8'))
        details=rec['skipDetails']
        ck('all eleven optional skip names AND reasons exactly retained',len(skips)==len(details)==11 and [(x['name'],x['reason'] or '') for x in details]==[(x,y or '') for x,y in skips] and rec['optionalSkips']==[x['name'] for x in details] and all(x['assertionsRan'] is False for x in details))
        ck('original terminal immutable source identity/counts',term['actualSourceCommitAfter']==S and term['sourceUnchanged'] is True and term['receiptState']=='passed' and term['receiptSha256']==SHA_RECEIPT and term['receiptCounts']==rt and term['trackedDirtyAfter']==[])
        ck('original terminal before/after hashes and skipped details',term['sourceIndexBefore']==term['sourceIndexAfter']==I and term['appFingerprintBefore']==term['appFingerprintAfter']==F and term['skipDetails']==details)
        ck('original terminal accurately preserves controller failure',term['preflightOutcome']=='success' and term['dependencyOutcome']=='success' and term['suiteStepOutcome']=='success' and term['tapConsistencyOutcome']=='failure' and term['parserConsistencyEvidencePresent'] is False)
    with zipfile.ZipFile(a.build) as z:
        ck('build evidence ZIP CRC',z.testzip() is None)
        pkg,bt,be,bpre,bpost=[js(z,n) for n in ('package-inspection.json','terminal-controller.json','environment.json','source-before.json','source-after.json')]
        ck('build controller/source/index and fingerprints exact',pkg['sourceCommit']==be['sourceCommit']==S and pkg['workflowControllerCommit']==be['workflowControllerCommit']==B and pkg['appFingerprint']==bt['expectedAppFingerprint']==F and bt['expectedSourceIndex']==I)
        ck('build source records before/after unchanged',bpre['records']==bpost['records'] and bpre['sourceIndexSha256']==bpost['sourceIndexSha256']==I and bpre['appFingerprint']==bpost['appFingerprint']==F and bt['sourceUnchanged'] is True)
        ck('original build terminal and manifest hashes',h(z.read('terminal-controller.json'))==SHA_BUILD_TERMINAL and h(z.read('package-inspection.json'))==bt['packageInspectionSha256'])
        ck('build original installer identity bound',pkg['installerSha256']==bt['installerSha256']==SHA_INSTALLER and pkg['installerBytes']==bt['installerBytes']==SIZE_INSTALLER and pkg['manifestSha256']==SHA_MANIFEST and pkg['version']=='2.39.98')
        ck('build unsigned/nonpublishing and not installed',pkg['artifactPublished'] is False and pkg['signingClaim']=='unsigned' and pkg['authenticodeStatus']=='NotSigned' and pkg['nativeInstallerExecutionPerformed'] is False and pkg['installedRuntimeVerified'] is False and bt['actualInstallerPublishStatus']=='not-published')
        ck('original build step outcomes all success',all(bt[k]=='success' for k in ('preflightOutcome','dependenciesOutcome','targetedOutcome','packageOutcome','inspectOutcome')) and bt['fullSourceSuiteRerun'] is False)
        spec=z.read('targeted-release-tests.tap');sc=counts(spec.decode('utf-8'),'ℹ')
        ck('original targeted 69/69 and log SHA',h(spec)==bt['targetedTapSha256']==SHA_BUILD_TAP and sc=={'tests':69,'pass':69,'fail':0,'cancelled':0,'skipped':0,'todo':0})
        ck('original targeted terminal null counts preserved',all(x is None for x in bt['targetedCounts'].values()))
    with zipfile.ZipFile(a.installer) as z:
        ck('installer original candidate ZIP CRC',z.testzip() is None)
        ck('installer ZIP exact expected filenames',set(z.namelist())=={'Blackice-2.39.98-Setup.exe','blackice-public-release.json','SHA256SUMS.txt','Read me.txt'} and len(z.namelist())==4)
        with z.open('Blackice-2.39.98-Setup.exe') as fh:
            hsh=hashlib.sha256();total=0
            for block in iter(lambda:fh.read(1<<20),b''):hsh.update(block);total+=len(block)
        ck('actual installer bytes and hash',total==SIZE_INSTALLER and hsh.hexdigest()==SHA_INSTALLER)
        raw=z.read('blackice-public-release.json');manifest=json.loads(raw)
        ck('installer manifest SHA and exact source fingerprint',h(raw)==SHA_MANIFEST and manifest['appFingerprint']==F and manifest['version']=='2.39.98' and manifest['artifact']=={'name':'Blackice-2.39.98-Setup.exe','size':SIZE_INSTALLER,'sha256':SHA_INSTALLER})
        ck('installer manifest honestly unsigned/not published',manifest['published'] is False and manifest['signing']['status']=='unsigned' and manifest['signing']['publisherVerified'] is False and manifest['releasePolicy']['requireCodeSigning'] is False)
        ck('original installer checksum manifest matches bytes',set(z.read('SHA256SUMS.txt').decode().splitlines())=={SHA_INSTALLER+'  Blackice-2.39.98-Setup.exe',SHA_MANIFEST+'  blackice-public-release.json'})
    result={'format':1,'product':'BLACKICE','kind':'controller-only-attestation-of-existing-immutable-CI-evidence','atUtc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'originalFullSuiteRunId':43735536388,'originalFullSuiteWorkflowConclusion':'failure (preexisting controller PowerShell parse error, not corrected in place)','originalFullSuiteStep':'success from prior run, no new suite','originalSuiteControllerSha':C,'exactSourceSha':S,'sourceIndexSha256':I,'appFingerprint':F,'originalFullArtifactId':14170039144,'originalFullArtifactZipSha256':Z['full'][0],'previousSuiteCounts':{'total':8787,'pass':8776,'failed':0,'skippedOptional':11,'requiredSkipped':0},'skippedAssertionDetails':details,'originalBuildRunId':43732981837,'originalBuildControllerSha':B,'originalBuildEvidenceArtifactId':14169485417,'originalBuildZipSha256':Z['build'][0],'originalInstallerArtifactId':14169143495,'originalInstallerZipSha256':Z['installer'][0],'installer':{'name':'Blackice-2.39.98-Setup.exe','bytes':SIZE_INSTALLER,'sha256':SHA_INSTALLER,'signed':False,'published':False,'installed':False},'originalTargetedTests':{'pass':69,'total':69,'failed':0,'skipped':0,'reporter':'spec'},'priorSupplementalReceiptSha256':{'full40checks':'240d2a1fb21e92c8414c6278e2d0b3d2d5b3d092a6573784486bbaa4b033a174','targeted69':'2807f7078ec44fcd1e52e300d19d95b9bced4da5d9a8efe7724699f1f3bd57e9'},'newTestsExecuted':False,'newBuildPerformed':False,'sourceModified':False,'originalEvidenceOverwritten':False,'checks':ok,'checksPassed':len(ok),'checksFailed':0,'limitations':['11 optional original assertions were never exercised','real provider/model, parallel children and in-flight effects not tested','native async browser and installed startup performance not tested'],'releaseInstallDecision':'root only; this new attestation never changes the original red workflow conclusion'}
    a.out.parent.mkdir(parents=True,exist_ok=True)
    a.out.write_text(json.dumps(result,indent=2,ensure_ascii=False)+'\n',encoding='utf-8')
    print(f"PRIOR_EVIDENCE_VERIFIED checks={len(ok)} old_suite=8776/8787 skips=11 old_build=69/69 installer_sha256={SHA_INSTALLER} original_run_still_failure=true")

if __name__=='__main__':main()
