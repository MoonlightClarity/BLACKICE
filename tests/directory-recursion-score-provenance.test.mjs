import test from 'node:test';
import assert from 'node:assert/strict';
import {recursionBenchmarkProvenanceMismatches} from '../lib/directory-recursion-benchmark-provenance.mjs';

const source={root:'C:/frozen-control',digests:{directory:'sha-directory',engine:'sha-engine',workspace:'sha-workspace'}};
const expected={driver:'sha-driver',workflow:'sha-workflow',codeFixture:'sha-code-fixture',longEvidenceFixture:'sha-long-evidence'};
const report={
  sourceRoot:source.root,
  directoryImplementationSha256:source.digests.directory,
  harnessEngineSha256:source.digests.engine,
  workspaceToolSha256:source.digests.workspace,
  benchmarkDriverSha256:expected.driver,
  benchmarkWorkflowSha256:expected.workflow,
  benchmarkFixtureSha256:expected.codeFixture,
  longEvidenceFixtureSha256:expected.longEvidenceFixture,
};

test('recursive comparison accepts an exactly matching frozen source and long-evidence fixture',()=>{
  assert.deepEqual(recursionBenchmarkProvenanceMismatches(report,source,expected),[]);
});

test('every benchmark provenance field is independently enforced, including long evidence',()=>{
  for(const field of Object.keys(report)){
    const tampered={...report,[field]:'a different source'};
    assert.deepEqual(recursionBenchmarkProvenanceMismatches(tampered,source,expected),[field],field);
    const missing={...report};
    delete missing[field];
    assert.deepEqual(recursionBenchmarkProvenanceMismatches(missing,source,expected),[field],field+' missing');
  }
});

test('missing or misspelled expected evidence digest invalidates a score',()=>{
  const {longEvidenceFixture,...misspelled}=expected;
  assert.deepEqual(recursionBenchmarkProvenanceMismatches(report,source,misspelled),['longEvidenceFixtureSha256']);
  assert.deepEqual(recursionBenchmarkProvenanceMismatches(report,{...source,digests:{...source.digests,engine:null}},expected),['harnessEngineSha256']);
});
