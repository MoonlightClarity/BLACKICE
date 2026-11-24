import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {classifyHistoricalSnapshot} from '../verification/minicpm-agent-tools-v2/historical-fixture-gate.mjs';

test('wholly absent historical snapshot alone qualifies for explicit nonexecution', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blackice-historical-gate-'));
  t.after(() => fs.rmSync(dir,{recursive:true,force:true}));
  const base = path.join(dir,'verification','minicpm-agentic-v1','harness');
  assert.equal(classifyHistoricalSnapshot(base).available,false);
  fs.mkdirSync(path.join(dir,'verification'));
  assert.equal(classifyHistoricalSnapshot(base).available,true,'An incomplete snapshot must execute and fail the original pin checks.');
  fs.writeFileSync(path.join(dir,'verification','unexpected.txt'),'not a snapshot');
  assert.equal(classifyHistoricalSnapshot(base).available,true);
});

test('historical snapshot guard rejects relative or missing fixture roots', () => {
  assert.throws(() => classifyHistoricalSnapshot('relative/frozen/harness'),TypeError);
  assert.throws(() => classifyHistoricalSnapshot(null),TypeError);
});
