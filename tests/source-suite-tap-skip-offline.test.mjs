import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import path from 'node:path';

const fixturePath=new URL('./fixtures/skills-tabs-suite-43741804376-skips.json',import.meta.url);
const workflowPath=new URL('../.github/workflows/verify-blackice-skills-tabs-23998-fullsuite.yml',import.meta.url);
const hash=data=>createHash('sha256').update(data).digest('hex');
const archive=JSON.parse(await readFile(fixturePath,'utf8'));

// The Windows workflow uses [regex]::Matches with this same pattern and
// reads Groups[1] and Groups[2]. The original red controller did not capture
// either group; it failed even though the TAP/receipt bytes agreed.
const CORRECTED_PATTERN='(?m)^ok \\d+ - (.*?) # SKIP(?: (.*))?\\r?$';
const skipRegex=/^ok \d+ - (.*?) # SKIP(?: (.*))?\r?$/gm;
const oldRegex=/^ok \d+ - .* # SKIP(?: .*)?\r?$/gm;
const found=tap=>[...tap.matchAll(skipRegex)].map(hit=>({name:hit[1],reason:hit[2]??null,assertionsRan:false}));
function assertMatches(tap,receipt){
  const hits=found(tap);
  assert.equal(hits.length,receipt.length,'Every archived skip must be accounted for.');
  for(let i=0;i<hits.length;i++){
    assert.equal(hits[i].name,receipt[i].name,'Exact skip name at position '+i);
    assert.equal(hits[i].reason,receipt[i].reason,'Exact skip reason at position '+i);
    assert.equal(receipt[i].assertionsRan,false,'A skipped assertion was not executed.');
  }
}
const sample=archive.originalRawTapSkipLines.join('\n')+'\n';

test('reviewed controller uses two real TAP capture groups; no old noncapture expression remains',async()=>{
  const workflow=await readFile(workflowPath,'utf8');
  const statements=[...workflow.matchAll(/\$namedSkips=@\(\[regex\]::Matches\(\$tap,'([^']+)'\)\)/g)];
  assert.equal(statements.length,1,'The workflow has exactly one skip extraction expression.');
  assert.equal(statements[0][1],CORRECTED_PATTERN);
  assert.match(workflow,/\$observed\.Groups\[1\]\.Value/);
  assert.match(workflow,/\$observed\.Groups\[2\]\.Value/);
  const broken=[...sample.matchAll(oldRegex)];
  assert.equal(broken.length,11);
  assert.equal(broken[0][1],undefined,'The original matcher did not capture the name.');
  assert.equal(broken[0][2],undefined,'The original matcher did not capture the reason.');
});

test('frozen failed-run TAP skips exactly match its archived source receipt and historical digest',()=>{
  assert.equal(archive.sourceCommit,'36996a7782163c65822c1b25cdc0aa0b5880fdc4');
  assert.equal(archive.controllerCommit,'f73afde3b8edf0652ab22addfdd2477163e0d41f');
  assert.equal(archive.originalSourceReceiptSkipDetails.length,11);
  assert.equal(archive.originalRawTapSkipLines.length,11);
  assert.equal(hash(JSON.stringify(archive.originalSourceReceiptSkipDetails)),archive.originalSkipDetailsCanonicalSha256);
  assertMatches(sample,archive.originalSourceReceiptSkipDetails);
  assert.equal(archive.originalCounts.skipped,11);
  assert.equal(archive.originalCounts.fail,3,'This is evidence from the failed source run, not a passing source suite.');
});

test('mutating one archived skip reason or name is rejected, including the first position',()=>{
  const expected=archive.originalSourceReceiptSkipDetails;
  assert.throws(()=>assertMatches(sample.replace('disposable hidden Electron browsers.','different text.'),expected));
  assert.throws(()=>assertMatches(sample.replace('Relay-owned sign-in','Unrelated sign-in'),expected));
  assert.throws(()=>assertMatches(sample.replace('rendered Chat Directory controls','wrongly renamed controls'),expected));
});

test('missing or duplicated skips fail count validation, while null reasons are legitimate',()=>{
  const expected=archive.originalSourceReceiptSkipDetails;
  assert.throws(()=>assertMatches(archive.originalRawTapSkipLines.slice(1).join('\n')+'\n',expected));
  assert.throws(()=>assertMatches(sample+archive.originalRawTapSkipLines[0]+'\n',expected));
  assert.equal(found(sample).filter(row=>row.reason===null).length,3);
  assert.equal(expected.filter(row=>row.reason===null).length,3);
  assertMatches(sample,expected);
});

// Set BLACKICE_ARCHIVED_EVIDENCE_DIR to the *unmodified* extracted original
// GitHub Actions artifact, not a fixture generated from the fixed controller.
// This additional full-byte check never reruns tests.
if(process.env.BLACKICE_ARCHIVED_EVIDENCE_DIR){
  test('original 43741804376 full TAP bytes, totals, source receipt, and all skips match',async()=>{
    const root=process.env.BLACKICE_ARCHIVED_EVIDENCE_DIR;
    const tapBytes=await readFile(path.join(root,'suite.tap'));
    const receiptBytes=await readFile(path.join(root,'windows-2.39.98.json'));
    assert.equal(hash(tapBytes),archive.originalTapSha256);
    assert.equal(hash(receiptBytes),archive.originalReceiptSha256);
    const tap=tapBytes.toString('utf8'),receipt=JSON.parse(receiptBytes);
    const counts=Object.fromEntries(Object.keys(archive.originalCounts).map(key=>{
      const hits=[...tap.matchAll(new RegExp('^# '+key+' (\\d+)\\r?$','gm'))];
      assert.equal(hits.length,1,'One complete TAP summary count for '+key);
      return [key,Number(hits[0][1])];
    }));
    assert.deepEqual(counts,archive.originalCounts);
    assert.deepEqual(receipt.skipDetails,archive.originalSourceReceiptSkipDetails);
    assert.equal(receipt.sourceCommit,archive.sourceCommit);
    assert.equal(receipt.workflowControllerCommit,archive.controllerCommit);
    assert.equal(receipt.tests.exitCode,1);
    assert.equal(receipt.state,'failed');
    assertMatches(tap,receipt.skipDetails);
  });
}
