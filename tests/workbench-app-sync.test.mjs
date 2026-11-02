import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {WorkbenchAppSync,parseWinGetManifest} from '../lib/workbench-app-sync.mjs';

const exportManifest=(additional=[])=>({
  '$schema':'https://aka.ms/winget-packages.schema.2.0.json',
  Sources:[{SourceDetails:{Name:'winget',Type:'Microsoft.PreIndexed.Package'},
    Packages:[
      {PackageIdentifier:'Microsoft.VisualStudioCode'},
      {PackageIdentifier:'Mozilla.Firefox'},
      ...additional.map(id=>({PackageIdentifier:id}))
    ]}]
});
const fixture=async t=>{
  const dir=await fs.mkdtemp(path.join(tmpdir(),'wb-batch-host-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  let additions=[],exports=0,fail=false;
  const app=new WorkbenchAppSync({sharedRoot:dir,
    exporter:async(file,args,opts)=>{
      assert.equal(file,'winget.exe');
      assert.deepEqual(args.slice(0,2),['export','--output']);
      assert.equal(opts.windowsHide,true);
      assert.ok(args.includes('--disable-interactivity'));
      exports++;
      if(fail)throw Error('winget missing');
      await fs.writeFile(args[2],JSON.stringify(exportManifest(additions)));
      return {stdout:'Host apps without matching packages were reported by winget.\nInstalled package is not available from any source: Mozilla Firefox (x64 en-US)\nInstalled package is not available from any source: Microsoft 365 - en-us',stderr:''};
    }
  });
  return {app,dir,setAdditions:v=>additions=v,setFailure:v=>{fail=v},calls:()=>exports};
};

test('package export parser preserves source ID and rejects command injection, duplicates and oversized manifests',()=>{
  const items=parseWinGetManifest(exportManifest());
  assert.deepEqual(items,[{id:'Microsoft.VisualStudioCode',source:'winget'},{id:'Mozilla.Firefox',source:'winget'}]);
  assert.equal(parseWinGetManifest(exportManifest(['Microsoft.VisualStudioCode'])).length,2);
  assert.throws(()=>parseWinGetManifest({Sources:[{SourceDetails:{Name:'winget'},Packages:[{PackageIdentifier:'X & evil.exe'}]}]}),{code:'WORKBENCH_APP_SYNC_MANIFEST'});
  assert.throws(()=>parseWinGetManifest({Sources:[{SourceDetails:{Name:'evil;curl'},Packages:[]}]}),{code:'WORKBENCH_APP_SYNC_MANIFEST'});
});

test('host app inventory can be freshly exported and rebatch snapshots remain independent and hash verified',async t=>{
  const f=await fixture(t);
  assert.equal((await f.app.list()).currentSnapshot,null);
  const first=await f.app.exportHost();
  assert.equal(first.packageCount,2);
  assert.equal(first.unmatchedCount,2);
  assert.ok(first.unmatchedHostApps.includes('Microsoft 365 - en-us'));
  assert.match(first.sha256,/^[a-f0-9]{64}$/);
  assert.match(first.warning,/Host apps/);
  assert.equal((await f.app.snapshot(first.snapshotId)).packages.length,2);
  const reserved=await f.app.reserve({});
  assert.equal(reserved.snapshotId,first.snapshotId);
  assert.equal(reserved.totalPackages,2);
  assert.equal((await f.app.list()).runs[0].status,'requested');
  await assert.rejects(f.app.reserve({}),{code:'WORKBENCH_APP_SYNC_BUSY'});
  const queued=await f.app.markDispatch(reserved.runId,{
    status:'completed',result:{scheduled:true,workerPid:1234}});
  assert.equal(queued.status,'queued');
  assert.equal((await f.app.list()).runs[0].status,'queued');
  const saved={...queued,status:'completed',counts:{alreadyPresent:2,installed:0,missing:0},
    packages:first.packages.map(pkg=>({...pkg,status:'already_present'})),
    finishedAt:new Date().toISOString()};
  await fs.writeFile(path.join(f.app.runs,reserved.runId+'.json'),JSON.stringify(saved));
  // A fresh later inventory changes without altering the old snapshot.
  f.setAdditions(['7zip.7zip']);
  const second=await f.app.exportHost();
  assert.notEqual(second.snapshotId,first.snapshotId);
  assert.equal(second.packageCount,3);
  assert.equal((await f.app.snapshot(first.snapshotId)).packages.length,2);
  const rebatch=await f.app.reserve({});
  assert.equal(rebatch.snapshotId,second.snapshotId);
  assert.equal(rebatch.totalPackages,3);
  assert.equal(f.calls(),2);
  assert.equal((await f.app.run(reserved.runId)).status,'completed');
  await assert.rejects(f.app.run('bad-id'),{code:'WORKBENCH_APP_SYNC_RUN_ID'});
  const tampered=path.join(f.app.manifests,second.snapshotId+'.json');
  await fs.appendFile(tampered,' ');
  await assert.rejects(f.app.snapshot(second.snapshotId),{code:'WORKBENCH_APP_SYNC_SNAPSHOT_CHANGED'});
});

test('a failed refresh does not replace the previous saved app inventory',async t=>{
  const f=await fixture(t);
  const good=await f.app.exportHost();
  f.setFailure(true);
  await assert.rejects(f.app.exportHost(),{code:'WORKBENCH_APP_SYNC_EXPORT'});
  assert.equal((await f.app.current()).snapshotId,good.snapshotId);
  assert.equal(f.calls(),2);
});


test('installer source recovery extends future guest imports without altering original host export',async t=>{
  const dir=await fs.mkdtemp(path.join(tmpdir(),'wb-recovery-augmented-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  let queries=0;
  const service=new WorkbenchAppSync({sharedRoot:dir,
    exporter:async(_file,args)=>{
      const original=exportManifest();
      original.Sources[0].Packages=original.Sources[0].Packages.filter(p=>p.PackageIdentifier!=='Mozilla.Firefox');
      await fs.writeFile(args[2],JSON.stringify(original));
      return {stdout:[
        'Installed package is not available from any source: Mozilla Firefox (x64 en-US)',
        'Installed package is not available from any source: Microsoft 365 - en-us',
        'Installed package is not available from any source: NVIDIA Graphics Driver 595.95'
      ].join('\n'),stderr:''};
    },
    registryReader:async()=>[{name:'Mozilla Firefox (x64 en-US)',publisher:'Mozilla Foundation'},
      {name:'Microsoft 365 - en-us',publisher:'Microsoft Corporation'}],
    searcher:async(_file,args)=>{
      if(args[0]==='show')return {stdout:'Found Firefox [Mozilla.Firefox]\nPublisher: Mozilla Corporation\n',stderr:''};
      queries++;
      const name=args[args.indexOf('--name')+1];
      const entries=name==='Mozilla Firefox'?
        [['Mozilla Firefox (en-US)','Mozilla.Firefox','159.0'],
          ['Mozilla Firefox ESR (en-US)','Mozilla.Firefox.ESR','153.0']]:
        [['Microsoft 365 Apps for enterprise','Microsoft.Office','16.0'],
          ['Microsoft 365 Copilot','Microsoft.365Copilot','1.0']];
      const header='Name                                Id                         Version\n';
      const rows=entries.map(([n,id,v])=>n.padEnd(36)+id.padEnd(27)+v).join('\n');
      return {stdout:header+'-----------------------------------------------------------------------\n'+rows+'\n',stderr:''};
    }
  });
  const original=await service.exportHost();
  const untouched=await fs.readFile(path.join(service.manifests,original.snapshotId+'.json'));
  const recovery=await service.discover({snapshotId:original.snapshotId});
  assert.equal(recovery.status,'completed');
  assert.equal(recovery.total,3);
  assert.equal(recovery.queryCount,2,'The device driver is classified instead of reinstalled.');
  assert.equal(recovery.counts.resolved_exact,1);
  assert.equal(recovery.counts.ambiguous,1);
  assert.equal(recovery.counts.not_applicable,1);
  assert.deepEqual(recovery.added.map(x=>x.id),['Mozilla.Firefox']);
  assert.equal(recovery.importVariant,'augmented');
  assert.equal(recovery.importCount,2);
  assert.equal(queries,2);
  const stored=await service.snapshot(original.snapshotId);
  assert.equal(stored.recovery.resolvedCount,1);
  assert.equal((await service.list()).currentSnapshot.recovery.resolvedCount,1);
  assert.deepEqual(await fs.readFile(path.join(service.manifests,original.snapshotId+'.json')),untouched);
  const run=await service.reserve({snapshotId:original.snapshotId});
  assert.equal(run.totalPackages,2);
  assert.equal(run.sourceSnapshotSha256,original.sha256);
  assert.equal(run.manifestSha256,recovery.importSha256);
  assert.equal(run.importVariant,'augmented');
  assert.equal(run.autoResolved.length,1);
  await service.discover({snapshotId:original.snapshotId});
  assert.equal(queries,2,'The resolved snapshot is cached; a later new snapshot can search again.');
  await fs.appendFile(path.join(service.manifests,original.snapshotId+'.augmented-'+recovery.importSha256.slice(0,16)+'.json'),' ');
  await assert.rejects(service.snapshot(original.snapshotId),{code:'WORKBENCH_APP_RECOVERY_CHANGED'});
});
test('ambiguous alternative installer source never silently changes future app manifest',async t=>{
  const dir=await fs.mkdtemp(path.join(tmpdir(),'wb-recovery-ambiguous-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const service=new WorkbenchAppSync({sharedRoot:dir,
    exporter:async(_cmd,args)=>{
      await fs.writeFile(args[2],JSON.stringify(exportManifest()));
      return {stdout:'Installed package is not available from any source: Microsoft 365 - en-us',stderr:''};
    },
    searcher:async()=>({stdout:'Name                    Id                    Version\n'+
      '-----------------------------------------------------\n'+
      'Microsoft 365 Copilot   Microsoft.365Copilot  1.0\n',stderr:''})
  });
  const exported=await service.exportHost();
  const r=await service.discover({snapshotId:exported.snapshotId});
  assert.equal(r.counts.ambiguous,1);
  assert.equal(r.importVariant,'original');
  assert.equal(r.importSha256,exported.sha256);
  const batch=await service.reserve({snapshotId:exported.snapshotId});
  assert.equal(batch.importVariant,'original');
  assert.equal(batch.totalPackages,2);
});



test('a same-name catalog package from a different publisher is never added to guest inventory',async t=>{
  const dir=await fs.mkdtemp(path.join(tmpdir(),'wb-recovery-publisher-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const orig=exportManifest();
  const service=new WorkbenchAppSync({sharedRoot:dir,
    registryReader:async()=>[
      {name:'Reveal',publisher:'Lobby Reveal',version:'1.4.9'},
      {name:'Mozilla Firefox (x64 en-US)',publisher:'Mozilla',version:'159.0'}
    ],
    exporter:async(_cmd,args)=>{
      await fs.writeFile(args[2],JSON.stringify(orig));
      return {stdout:'Installed package is not available from any source: Reveal\n'+
        'Installed package is not available from any source: Mozilla Firefox (x64 en-US)',stderr:''};
    },
    searcher:async(_cmd,args)=>{
      if(args[0]==='show'){
        const pkg=args[args.indexOf('--id')+1];
        return {stdout:pkg==='AGTEK.Reveal'?
          'Found Reveal [AGTEK.Reveal]\nPublisher: Hexagon, Agtek Inc\n':
          'Found Mozilla Firefox [Mozilla.Firefox]\nPublisher: Mozilla Corporation\n',stderr:''};
      }
      const name=args[args.indexOf('--name')+1];
      const row=name==='Reveal'?'Reveal                   AGTEK.Reveal             1.3.0.4':
        'Mozilla Firefox (en-US)    Mozilla.Firefox          159.0';
      return {stdout:'Name                     Id                       Version\n'+
        '-------------------------------------------------------------\n'+row+'\n',stderr:''};
    }
  });
  const source=await service.exportHost();
  const result=await service.discover({snapshotId:source.snapshotId});
  const reveal=result.decisions.find(x=>x.name==='Reveal');
  assert.equal(reveal.status,'ambiguous');
  assert.equal(reveal.installedPublisher,'Lobby Reveal');
  assert.equal(reveal.catalogPublisher,'Hexagon, Agtek Inc');
  assert.equal(reveal.selected,undefined);
  assert.ok(!result.added.some(x=>x.id==='AGTEK.Reveal'));
  assert.ok(result.added.every(x=>x.id!=='AGTEK.Reveal'));
  assert.equal(result.matcherVersion,2);
});

test('a previous exact-name-only catalog match is treated as unverified and never installed',async t=>{
  const f=await fixture(t);
  const snapshot=await f.app.exportHost();
  const prior={version:1,status:'completed',snapshotId:snapshot.snapshotId,
    sourceSha256:snapshot.sha256,importVariant:'augmented',
    importSha256:'b'.repeat(64),importCount:5,counts:{resolved_exact:1},
    added:[{name:'Reveal',id:'AGTEK.Reveal',source:'winget'}],
    decisions:[{name:'Reveal',status:'resolved_exact',
      selected:{id:'AGTEK.Reveal',source:'winget'}}]};
  await fs.writeFile(path.join(f.app.recoveries,snapshot.snapshotId+'.json'),JSON.stringify(prior));
  const result=await f.app.recovery(snapshot.snapshotId,snapshot.sha256);
  assert.equal(result.status,'needs_recheck');
  assert.equal(result.importVariant,'original');
  assert.deepEqual(result.added,[]);
  const batch=await f.app.reserve({snapshotId:snapshot.snapshotId});
  assert.equal(batch.manifestSha256,snapshot.sha256);
  assert.equal(batch.importVariant,'original');
  assert.equal(batch.totalPackages,snapshot.packageCount);
});

test('guest batch worker compares real before/after inventory and never force-upgrades or recreates a VM',async()=>{
  const script=await fs.readFile(new URL('../scripts/workbench-guest-app-batch.ps1',import.meta.url),'utf8');
  for(const term of ["Get-GuestPackages 'before'","Get-GuestPackages 'after'",
    "'--no-upgrade'","'--ignore-unavailable'","'--disable-interactivity'",
    "'already_present'","'installed'","'missing'","'uncertain'"])
    assert.ok(script.includes(term),term);
  for(const term of ['Remove-VM','New-VM','-TurnOff','Restart-Computer','--force','uninstall --id'])
    assert.ok(!script.includes(term),term);
});

test('missing guest dispatch produces an honest recoverable receipt without claiming any install',async t=>{
  const f=await fixture(t);
  const manifest=await f.app.exportHost();
  const r=await f.app.reserve({snapshotId:manifest.snapshotId});
  const marked=await f.app.markDispatch(r.runId,{status:'failed',message:'Guest never acknowledged the batch.'});
  assert.equal(marked.status,'dispatch_uncertain');
  assert.equal(marked.counts.installed,undefined);
  assert.equal((await f.app.reserve({})).totalPackages,2,'A manually initiated new batch can retry after an unknown dispatch, without deleting earlier records.');
});
