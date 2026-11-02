import test from 'node:test';
import assert from 'node:assert/strict';
import {
 normalizeInstalledAppName,classifyUnmatchedHostName,parseWingetSearchResults,
 resolveWingetCandidate,mergeWingetManifest
} from '../lib/workbench-app-recovery.mjs';

const result=(name,id,version='1.2.3')=>({name,id,version,source:'winget'});
test('common host installer names normalize to correct Windows catalog identity',()=>{
  assert.equal(normalizeInstalledAppName('Mozilla Firefox (x64 en-US)'), 'mozilla firefox');
  assert.equal(normalizeInstalledAppName('Mozilla Firefox (en-US)'), 'mozilla firefox');
  assert.equal(normalizeInstalledAppName('calibre 64bit'), 'calibre');
  assert.equal(normalizeInstalledAppName('Microsoft 365 - en-us'), 'microsoft 365');
});
test('hardware drivers and companion services are not considered ordinary Windows applications to clone',()=>{
  for(const name of ['NVIDIA Graphics Driver 595.95','Microsoft Windows Application Compatibility Fix Database','HP System Information'])
    assert.equal(classifyUnmatchedHostName(name).searchable,false);
  for(const name of ['Mozilla Maintenance Service','Riot Vanguard'])
    assert.equal(classifyUnmatchedHostName(name).searchable,false);
  assert.equal(classifyUnmatchedHostName('Mozilla Firefox (x64 en-US)').searchable,true);
});
test('table parser extracts real winget source IDs without misreading truncated output',()=>{
  const output='Name                        Id                       Version\n'+
    '------------------------------------------------------------\n'+
    'Mozilla Firefox (en-US)     Mozilla.Firefox          157.0.1\n'+
    'Mozilla Firefox ESR (en-US) Mozilla.Firefox.ESR      153.4.0\n'+
    'Mozilla Firefox ESR (MSIX)  Mozilla.Firefox.ESR.MSIX 153.6.0\n'+
    '<additional entries truncated due to result limit>\n';
  const rows=parseWingetSearchResults(output);
  assert.equal(rows.length,3);
  assert.deepEqual(rows[0],result('Mozilla Firefox (en-US)','Mozilla.Firefox','157.0.1'));
  const match=resolveWingetCandidate('Mozilla Firefox (x64 en-US)',rows);
  assert.equal(match.status,'resolved_exact');
  assert.equal(match.selected.id,'Mozilla.Firefox');
});
test('ambiguous editions remain visible instead of silently installing a license-mismatched program',()=>{
  const names=[result('Microsoft 365 Apps for enterprise','Microsoft.Office'),
    result('Microsoft 365 Copilot','Microsoft.365Copilot')];
  const resultValue=resolveWingetCandidate('Microsoft 365 - en-us',names);
  assert.equal(resultValue.status,'ambiguous');
  assert.equal(resultValue.selected,undefined);
  const noMatch=resolveWingetCandidate('Unknown Fancy App',[]);
  assert.equal(noMatch.status,'not_found');
});
test('portable, ESR and preview builds never displace one stable edition',()=>{
  const matches=[
    result('calibre','calibre.calibre'),
    result('calibre portable','calibre.calibre.portable'),
  ];
  assert.equal(resolveWingetCandidate('calibre 64bit',matches).selected.id,'calibre.calibre');
  const onlyVariant=resolveWingetCandidate('Mozilla Firefox (x64 en-US)',[
    result('Mozilla Firefox ESR (en-US)','Mozilla.Firefox.ESR')
  ]);
  assert.equal(onlyVariant.status,'ambiguous');
});
test('augmented guest import preserves original host manifest and records high-confidence package provenance',()=>{
  const original={Sources:[{SourceDetails:{Name:'winget',Type:'Microsoft.PreIndexed.Package'},
    Packages:[{PackageIdentifier:'Microsoft.VisualStudioCode'}]}]};
  const resolved=[
    resolveWingetCandidate('Mozilla Firefox (x64 en-US)',[
      result('Mozilla Firefox (en-US)','Mozilla.Firefox')]),
    resolveWingetCandidate('Microsoft 365 - en-us',[
      result('Microsoft 365 Apps for enterprise','Microsoft.Office')])
  ];
  const {manifest,added}=mergeWingetManifest(original,resolved);
  assert.equal(original.Sources[0].Packages.length,1);
  assert.equal(manifest.Sources[0].Packages.length,2);
  assert.deepEqual(added.map(x=>x.id),['Mozilla.Firefox']);
  assert.deepEqual(mergeWingetManifest(manifest,resolved).added,[]);
});
