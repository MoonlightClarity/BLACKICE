import test from 'node:test';
import assert from 'node:assert/strict';
import {parseRepositoryReportSelection} from '../lib/repository-report-revision.mjs';

test('fabricated prose, hidden-grade claims, unknown IDs and evidence substitutions are rejected',()=>{
 for(const p of [
  {answer:'All tests passed',used_refs:['v']},
  {answer:'["private-grader-success"]',used_refs:['v']},
  {answer:'["tests"]',used_refs:['fabricated']},
  {answer:'["tests"]',used_refs:['v','fabricated']},
  {answer:'["tests","tests"]',used_refs:['v']}
 ])assert.throws(()=>parseRepositoryReportSelection(p,['v']),{code:'DIRECTORY_REPORT_REVISION_INVALID'});
});
